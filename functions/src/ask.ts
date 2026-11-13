import type Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { MODEL } from './analyze';
import { extractBody, httpGet, isPrtimesUrl } from './page';
import { addUsage, usageOf } from './usage';
import type { Embed } from './vertex';

/**
 * アプリ内の質問（kbJobs の ask）。本人の決定：
 * - 答えは「結論 → 根拠の記事（タイトル・会社・日付・リンク）＋自分のメモの引用」
 * - 一般知識も使ってよいが、記事の内容とは分けて書く
 * - 履歴は残す（ask の依頼は1日たっても消さない）
 * 根拠の集め方：質問を数値にして全記事の目録（kbIndex）から近い記事を探し、整理済みの記事は要約・数字・メモを、
 * 上位の記事は本文も読んで、Claude（Opus）に渡す
 */

/** 近い順に取る数・AI に渡す数・本文まで読む数 */
const NEAREST = 200;
const SOURCES = 24;
const WITH_BODY = 6;
const BODY_CHARS = 3500;

export const AskOut = z.object({
  conclusion: z.string(),
  points: z.array(z.object({ text: z.string(), cites: z.array(z.number()) })),
  memoQuotes: z.array(z.object({ n: z.number(), quote: z.string() })),
  general: z.string(),
  insufficient: z.boolean(),
  followups: z.array(z.string()),
});
export type AskAnswer = z.infer<typeof AskOut>;

export const ASK_SYSTEM = `あなたは、経営・事業支援／資金調達・M&A支援／マーケ・営業支援／人材・組織支援を提供する会社の営業担当者のアシスタントです。
担当者の質問に、渡された記事（PR TIMES のプレスリリース。[番号] つき）と、担当者自身のメモを根拠に答えます。日本語で、営業の現場でそのまま使えるように具体的に書きます。

conclusion: 質問への結論を2〜4文。記事から言えることだけで書く。
points: 結論を支える要点を3〜8個。text は1〜2文で、会社名・数字・時期を具体的に。cites はその要点の根拠にした記事の [番号]（1つ以上）。記事に書いていないことは points に書かない。
memoQuotes: 担当者のメモ（「担当者のメモ」とある記事）のうち、質問に関係するものを n（記事の番号）と quote（メモの文をそのまま、または短く抜き出したもの）で。なければ空の配列。
general: 記事には書いていないが、営業の判断に役立つ一般的な知識・考え方があれば、2〜4文で（記事の内容とは分けるため、ここにだけ書く。記事の会社について推測で書かない）。なければ空文字。
insufficient: 渡された記事だけでは質問に十分に答えられないなら true（そのときも分かる範囲で答える）。
followups: 担当者が次に聞くとよい質問を2〜3個（短く）。

注意：記事の番号は渡されたものだけを使う。記事にない数字や会社名を作らない。似た記事が複数あれば、新しいものと担当者が読んだ記事を優先する。`;

export interface AskSource {
  n: number;
  id: string;
  title: string;
  company: string;
  companyId: string;
  url: string;
  publishedAt: string;
  read: boolean;
  analyzed: boolean;
  memo?: string;
  score: number;
}

/** AI に渡す材料（1記事ぶん） */
export function sourceBlock(
  s: AskSource,
  x: { lead?: string; caseTitle?: string; caseSummary?: string; facts?: string; talk?: string; body?: string; type?: string },
): string {
  return [
    `[${s.n}] ${s.publishedAt.slice(0, 10)}｜${s.company}｜${s.title}${x.type ? `｜種類: ${x.type}` : ''}${s.read ? '｜担当者が読んだ記事' : ''}`,
    x.caseTitle ? `事例: ${x.caseTitle}` : '',
    x.caseSummary ? `要約: ${x.caseSummary}` : '',
    x.facts ? `数字・事実: ${x.facts}` : '',
    x.talk ? `トーク例: ${x.talk}` : '',
    s.memo ? `担当者のメモ: ${s.memo}` : '',
    x.body ? `本文（抜粋）: ${x.body}` : x.lead ? `冒頭: ${x.lead}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 根拠の番号が渡した記事にないもの・空の要点を捨てる */
export function tidyAnswer(o: AskAnswer, ns: Set<number>): AskAnswer {
  const cut = (s: string, n: number) => s.trim().slice(0, n);
  return {
    conclusion: cut(o.conclusion, 800),
    points: o.points
      .map((p) => ({ text: cut(p.text, 300), cites: [...new Set(p.cites.filter((c) => ns.has(c)))] }))
      .filter((p) => p.text && p.cites.length)
      .slice(0, 8),
    memoQuotes: o.memoQuotes.filter((m) => ns.has(m.n) && m.quote.trim()).map((m) => ({ n: m.n, quote: cut(m.quote, 300) })).slice(0, 6),
    general: cut(o.general, 800),
    insufficient: o.insufficient,
    followups: o.followups.map((f) => cut(f, 80)).filter(Boolean).slice(0, 3),
  };
}

export async function askQuestion(
  deps: { db: Firestore; client: () => Anthropic; embed: Embed; get?: (url: string) => Promise<string> },
  question: string,
): Promise<{ answer: AskAnswer; sources: AskSource[]; model: string }> {
  const { db } = deps;
  const q = question.normalize('NFKC').trim().slice(0, 600);
  if (!q) throw new Error('質問が空です');

  // 1. 近い記事を探す（知識に入れない記事は除く）
  const [vec] = await deps.embed([q], 'RETRIEVAL_QUERY');
  const near = await db
    .collection('kbIndex')
    .findNearest({ vectorField: 'emb', queryVector: vec, limit: NEAREST, distanceMeasure: 'COSINE', distanceResultField: '_dist' })
    .get();
  const docs = near.docs.filter((d) => d.get('state') !== 'excluded').slice(0, SOURCES);
  if (!docs.length) throw new Error('記事がまだ検索できる状態になっていません（全記事の目録を作っているところです）');

  // 2. 整理済みの記事（読んだ記事・詳しく整理した記事）は、要約・数字・トーク例・メモも使う
  const arts = await db.getAll(...docs.map((d) => db.collection('kbArticles').doc(d.id)));
  const sources: AskSource[] = docs.map((d, i) => {
    const a = arts[i];
    const analyzed = a.exists && a.get('state') === 'done';
    return {
      n: i + 1,
      id: d.id,
      title: String(d.get('title') ?? ''),
      company: String(d.get('company') ?? ''),
      companyId: String(d.get('companyId') ?? ''),
      url: String(d.get('url') ?? ''),
      publishedAt: String(d.get('publishedAt') ?? ''),
      read: a.exists && a.get('source') === 'handoff',
      analyzed,
      ...(a.exists && a.get('memo') ? { memo: String(a.get('memo')).slice(0, 600) } : {}),
      score: Math.round((1 - Number(d.get('_dist') ?? 1)) * 1000) / 1000,
    };
  });

  // 3. 上位の記事は本文も読む（取ってある本文があればそれ、なければ記事ページ）
  const bodies = await db.getAll(...docs.slice(0, WITH_BODY).map((d) => db.collection('kbBodies').doc(d.id)));
  const bodyOf = new Map<string, string>();
  for (const [i, b] of bodies.entries()) {
    let text = (b.get('body') as string | undefined) ?? '';
    const url = sources[i].url;
    if (!text && isPrtimesUrl(url)) {
      try {
        text = extractBody(await (deps.get ?? httpGet)(url));
      } catch {
        /* 冒頭で答える */
      }
    }
    if (text) bodyOf.set(sources[i].id, text.slice(0, BODY_CHARS));
  }

  const blocks = sources.map((s, i) => {
    const kb = arts[i].exists ? ((arts[i].get('kb') ?? {}) as { caseTitle?: string; caseSummary?: string; facts?: { label: string; value: string }[]; talk?: string[] }) : {};
    return sourceBlock(s, {
      lead: String(docs[i].get('lead') ?? ''),
      type: docs[i].get('type') as string | undefined,
      caseTitle: kb.caseTitle,
      caseSummary: kb.caseSummary,
      facts: (kb.facts ?? []).map((f) => `${f.label} ${f.value}`).join('、'),
      talk: (kb.talk ?? []).join(' / '),
      body: bodyOf.get(s.id),
    });
  });

  // 4. Claude（Opus）に答えてもらう
  const r = await deps.client().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: betaZodOutputFormat(AskOut) },
    system: [{ type: 'text', text: ASK_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `質問: ${q}\n\n記事:\n\n${blocks.join('\n\n')}` }],
  });
  const model = r.model ?? MODEL;
  await addUsage(db, usageOf(model, r.usage), 'ask');
  const o = r.parsed_output;
  if (r.stop_reason === 'refusal' || !o) throw new Error(`答えられませんでした（${r.stop_reason}）`);
  const answer = tidyAnswer(o, new Set(sources.map((s) => s.n)));
  // 答えに使った記事を先に、残りは近い順に（画面の「根拠の記事」）
  const used = new Set([...answer.points.flatMap((p) => p.cites), ...answer.memoQuotes.map((m) => m.n)]);
  const sorted = [...sources.filter((s) => used.has(s.n)), ...sources.filter((s) => !used.has(s.n))];
  return { answer, sources: sorted, model };
}
