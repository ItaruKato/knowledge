import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { MODEL, SERVICES } from './analyze';
import { companyLine } from './ledger';
import { addUsage, usageOf, type Usage } from './usage';

/**
 * 会社ページの AI のまとめ（kbCompanies/{会社ID}）。
 * 読むだけ：companies・companyArticles（台帳）、longlist（Long List。あれば）。書く：kbCompanies。
 * 材料：台帳の会社の情報、PR TIMES の記事のタイトルと日付（2025-11 以降）、本人が読んだ記事の整理とメモ。
 */

/** まとめ方を変えたら上げる（上げると、まとめのある会社を一度ずつまとめ直す。v2：ビジネスと資本関係を足した） */
export const COMPANY_V = 2;
/** 資本関係（この会社から見た向き） */
export const CAPITAL_RELATIONS = ['出資を受けた', '出資した', '買収した', '買収された', '子会社化した', '子会社になった', '資本業務提携', '合併', '事業を譲り受けた', '事業を譲渡した', '親会社', '子会社・グループ会社'] as const;
export const EVENT_TYPES = ['資金調達', 'M&A', '資本業務提携・提携', '上場', '新規事業・新商品', '組織・人事', 'その他'] as const;

export const CompanyOut = z.object({
  summary: z.string(),
  recent: z.array(z.string()),
  events: z.array(
    z.object({ date: z.string(), type: z.enum(EVENT_TYPES), title: z.string(), amount: z.string(), counterpart: z.string(), articleId: z.string() }),
  ),
  angles: z.array(z.string()),
  fits: z.array(z.object({ service: z.enum(SERVICES), reason: z.string() })),
  businesses: z.array(z.string()),
  capital: z.array(z.object({ counterpart: z.string(), relation: z.enum(CAPITAL_RELATIONS), date: z.string(), articleId: z.string() })),
});
export type CompanyAi = z.infer<typeof CompanyOut>;

export const COMPANY_SYSTEM = `あなたは、経営・事業支援／資金調達・M&A支援／マーケ・営業支援／人材・組織支援を提供する会社の営業担当者のために、営業先の会社を1ページにまとめる係です。
材料は、会社の基本情報、PR TIMES に出したプレスリリースのタイトルと日付の一覧、担当者が読んだ記事の整理とメモです。材料に書かれていないことは書きません。推測を含むときは「〜の可能性」と書きます。日本語で答えます。

summary: どんな会社かを2〜3文（事業・顧客・強み・規模）。
recent: 最近の動きを新しい順に3〜5個、1つ1文。日付（年月）を頭に付ける。
events: 資金調達・M&A・提携・上場・新規事業などの出来事を、記事一覧から拾って古い順に並べる。date は記事の日付（YYYY-MM-DD）。title は出来事の短い説明。amount は金額が分かれば（例: 10億円）、なければ空文字。counterpart は相手先（引受先・買収先・提携先）が分かれば、なければ空文字。articleId は根拠にした記事のIDをそのまま書く（一覧にあるIDだけ）。宣伝・イベント告知・キャンペーンだけの記事は入れない。
angles: この会社への営業の切り口を2〜3個、1つ1文（なぜ今話すとよいか、何を提案するか）。担当者のメモがあれば優先して踏まえる。
fits: 担当者のサービスのうち、この会社に必要になりそうなものと理由（1文）。当てはまらなければ空の配列。
businesses: この会社のビジネス（事業）を1〜3個。似たビジネスの会社どうしをつなぐのに使う。「いまあるビジネス」に合うものがあれば、その名前を一字一句そのまま使う。合うものがないときだけ新しく作る。
  名前は、何を誰にどう売っているかが分かる短い名詞句（6〜16字。例: 「SNSマーケティング支援」「中小企業向け会計SaaS」「成層圏の観測プラットフォーム」「物流倉庫のロボット化」）。会社名・商品名は入れない。業界名だけ（「IT」「製造」）のような広すぎる名前は避ける。
capital: この会社の資本関係を、記事一覧から拾う。出資・資金調達の引受先、買収・被買収、子会社化、資本業務提携、合併、事業譲渡、親会社・子会社。資本の動きのない業務提携・販売提携は入れない。
  counterpart は相手の会社・ファンドの名前（記事に書かれたまま。複数なら1社ずつ別に）。relation はこの会社から見た関係。date は記事の日付（YYYY-MM-DD）。articleId は根拠にした記事のID（一覧にあるIDだけ）。相手が分からないものは入れない。`;

export interface CompanyMaterial {
  name: string;
  info: string;
  articles: { id: string; t: string; p: string }[];
  reads: { id: string; title: string; caseTitle: string; summary: string; memo: string; facts: string }[];
  longlist: string;
  /** いまあるビジネスの名前（ほかの会社のまとめから。表記をそろえるため） */
  businesses?: string[];
}

/** 材料を集める（記事は新しい順に 300 件まで） */
export async function companyMaterial(db: Firestore, cid: string): Promise<CompanyMaterial | null> {
  const [c, ca, ll] = await db.getAll(db.collection('companies').doc(cid), db.collection('companyArticles').doc(cid), db.collection('longlist').doc(cid));
  const reads = await db.collection('kbArticles').where('companyId', '==', cid).get();
  const name = String(c.get('name') ?? ca.get('name') ?? reads.docs[0]?.get('company') ?? '');
  if (!name) return null;
  const a = (ca.get('a') ?? {}) as Record<string, { t?: string; p?: string }>;
  const articles = Object.entries(a)
    .map(([id, v]) => ({ id, t: String(v.t ?? ''), p: String(v.p ?? '') }))
    .sort((x, y) => y.p.localeCompare(x.p))
    .slice(0, 300);
  const llData = ll.data();
  return {
    name,
    info: companyLine(c.data()),
    articles,
    // 知識に入れない記事（セミナー・告知など）はまとめの材料にしない
    reads: reads.docs.filter((d) => d.get('state') !== 'excluded').map((d) => {
      const k = (d.get('kb') ?? {}) as { caseTitle?: string; caseSummary?: string; facts?: { label: string; value: string }[] };
      return {
        id: d.id,
        title: String(d.get('title') ?? ''),
        caseTitle: k.caseTitle ?? '',
        summary: k.caseSummary || String(d.get('draft.summary') ?? ''),
        memo: String(d.get('memo') ?? ''),
        facts: (k.facts ?? []).map((f) => `${f.label}: ${f.value}`).join('、'),
      };
    }),
    longlist: llData ? JSON.stringify(llData).slice(0, 600) : '',
    businesses: await knownBusinesses(db),
  };
}

/** ほかの会社のまとめにあるビジネスの名前（多い順に 300 まで） */
export async function knownBusinesses(db: Firestore): Promise<string[]> {
  const snap = await db.collection('kbCompanies').select('ai.businesses').get();
  const count = new Map<string, number>();
  for (const d of snap.docs) for (const b of (d.get('ai.businesses') as string[] | undefined) ?? []) count.set(b, (count.get(b) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1]).slice(0, 300).map(([b]) => b);
}

/** 材料が変わったときだけまとめ直すための指紋 */
export function materialHash(m: CompanyMaterial): string {
  return createHash('sha256')
    .update(JSON.stringify([COMPANY_V, m.info, m.articles.map((a) => a.id), m.reads.map((r) => [r.id, r.memo, r.caseTitle]), m.longlist]))
    .digest('hex')
    .slice(0, 16);
}

export function companyContent(m: CompanyMaterial): string {
  return [
    `いまあるビジネス:\n${(m.businesses ?? []).map((b) => `- ${b}`).join('\n') || '（まだありません）'}`,
    `会社: ${m.name}`,
    `会社の情報: ${m.info || '（なし）'}`,
    m.longlist ? `Long List での状況: ${m.longlist}` : '',
    `担当者が読んだ記事（優先して踏まえる）:\n${
      m.reads.map((r) => `- [${r.id}] ${r.caseTitle || r.title}｜${r.summary}${r.facts ? `｜${r.facts}` : ''}${r.memo ? `｜メモ: ${r.memo}` : ''}`).join('\n') || '（なし）'
    }`,
    `PR TIMES の記事（ID｜日付｜タイトル。新しい順）:\n${m.articles.map((a) => `${a.id}｜${a.p.slice(0, 10)}｜${a.t}`).join('\n') || '（なし）'}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** 長さをそろえ、根拠の記事IDが一覧にないものは外す */
export function tidyCompany(o: CompanyAi, ids: Set<string>): CompanyAi {
  const cut = (s: string, n: number) => s.trim().slice(0, n);
  return {
    summary: cut(o.summary, 400),
    recent: o.recent.slice(0, 5).map((s) => cut(s, 160)),
    events: o.events
      .filter((e) => ids.has(e.articleId))
      .slice(0, 40)
      .map((e) => ({ date: cut(e.date, 10), type: e.type, title: cut(e.title, 80), amount: cut(e.amount, 40), counterpart: cut(e.counterpart, 80), articleId: e.articleId }))
      .sort((x, y) => x.date.localeCompare(y.date)),
    angles: o.angles.slice(0, 3).map((s) => cut(s, 160)),
    fits: o.fits.slice(0, 4).map((f) => ({ service: f.service, reason: cut(f.reason, 160) })),
    businesses: [...new Set(o.businesses.map(businessName).filter((b) => b.length >= 2))].slice(0, 3),
    capital: o.capital
      .filter((c) => c.counterpart.trim() && ids.has(c.articleId))
      .slice(0, 30)
      .map((c) => ({ counterpart: cut(c.counterpart, 80), relation: c.relation, date: cut(c.date, 10), articleId: c.articleId }))
      .sort((x, y) => x.date.localeCompare(y.date)),
  };
}

/** ビジネス名をそろえる（全角・半角、前後の空白・かぎかっこ） */
export function businessName(s: string): string {
  return s.normalize('NFKC').replace(/^[「『\s]+|[」』\s]+$/g, '').replace(/\s+/g, '').slice(0, 24);
}

/** 会社のまとめを作る。材料が変わっていなければ何もしない（redo なら作り直す） */
export async function summarizeCompany(db: Firestore, client: () => Anthropic, cid: string, redo = false): Promise<'made' | 'same' | 'none'> {
  const m = await companyMaterial(db, cid);
  if (!m) return 'none';
  const ref = db.collection('kbCompanies').doc(cid);
  const hash = materialHash(m);
  const prev = await ref.get();
  if (!redo && prev.get('state') === 'done' && prev.get('inputHash') === hash) return 'same';
  await ref.set({ state: 'working', startedAt: new Date().toISOString() }, { merge: true });
  let usage: Usage | undefined;
  try {
    const response = await client().beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: betaZodOutputFormat(CompanyOut) },
      system: [{ type: 'text', text: COMPANY_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: companyContent(m) }],
    });
    const model = response.model ?? MODEL;
    usage = usageOf(model, response.usage);
    const o = response.parsed_output;
    if (response.stop_reason === 'refusal' || !o) throw new Error(`まとめられませんでした（${response.stop_reason}）`);
    await ref.set({
      v: COMPANY_V,
      id: cid,
      name: m.name,
      ai: ((t) => ({ ...t, businesses: t.businesses.map((b) => (m.businesses ?? []).find((k) => businessName(k) === b) ?? b) }))(tidyCompany(o, new Set(m.articles.map((a) => a.id)))),
      model,
      at: new Date().toISOString(),
      inputHash: hash,
      articleCount: m.articles.length,
      readCount: m.reads.length,
      state: 'done',
    });
    return 'made';
  } catch (e) {
    await ref.set({ state: 'failed', error: String(e).slice(0, 300), failedAt: new Date().toISOString() }, { merge: true });
    throw e;
  } finally {
    if (usage) await addUsage(db, usage, 'company');
  }
}
