import type Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { MODEL, SERVICES } from './analyze';
import { addUsage, PRICES, usageOf } from './usage';
import { dailyMail, weeklyMail, type SendMail } from './mail';

/**
 * デイリー（毎朝9時）とウィークリー（日曜21時）のレポート（kbReports/{daily_YYYYMMDD | weekly_YYYYMMDD}）。本人の決定：
 * - デイリー：昨日の注目記事（5〜10件、理由つき）と、今日の営業ネタ3つ
 * - ウィークリー：今週のふりかえり、今週の事例ベスト、来週動くとよい会社、AI の費用
 * - 追っている会社（Long List の温度感 A・B と、進捗がアプローチ中・商談の会社）は、注目記事と「来週動くとよい会社」で優先する
 * - アプリの「レポート」タブで読み、メールでも届ける（Resend。送れなくてもレポートは残し、emailError に理由を書く）
 */

type ReportDeps = { db: Firestore; client: () => Anthropic; send?: SendMail };

/** メールを送り、結果をレポートに書く（送れなくても止めない） */
async function mailOut(ref: FirebaseFirestore.DocumentReference, send: SendMail | undefined, make: () => ReturnType<typeof dailyMail>) {
  if (!send) return;
  try {
    await send(make());
    await ref.set({ emailedAt: new Date().toISOString(), emailError: null }, { merge: true });
  } catch (e) {
    await ref.set({ emailError: String(e).slice(0, 300) }, { merge: true });
  }
}

export const USD_JPY = 150;
const JST = 9 * 3600e3;
const DAY = 86400e3;
const p2 = (n: number) => String(n).padStart(2, '0');
/** JST の日付（YYYY-MM-DD）と、その日 0:00 のミリ秒 */
export function jstDate(ms: number): string {
  const d = new Date(ms + JST);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}
export const jstDayStart = (ms: number) => new Date(`${jstDate(ms)}T00:00:00+09:00`).getTime();
const iso9 = (ms: number) => `${jstDate(ms)}T${p2(new Date(ms + JST).getUTCHours())}:00:00+09:00`;

/** 追っている会社（Long List。読むだけ） */
export async function trackedCompanies(db: Firestore): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const snap = await db.collection('longlist').get();
    for (const d of snap.docs) {
      const t = d.get('temperature') as string | undefined;
      const p = d.get('progress') as string | undefined;
      const why = [t === 'A' || t === 'B' ? `温度感${t}` : '', p === 'アプローチ中' || p === '商談' ? p : ''].filter(Boolean).join('・');
      if (why) out.set(d.id, why);
    }
  } catch {
    /* Long List がまだないとき */
  }
  return out;
}

interface Cand {
  n: number;
  id: string;
  title: string;
  company: string;
  companyId: string;
  url: string;
  publishedAt: string;
  lead: string;
  type?: string;
  isCase?: boolean;
  tracked?: string;
}

/** その期間の全記事（知識に入れない記事は除く）。配信日時の文字の順で探す */
async function articlesBetween(db: Firestore, from: number, to: number): Promise<Cand[]> {
  const snap = await db.collection('kbIndex').where('publishedAt', '>=', iso9(from)).where('publishedAt', '<', iso9(to)).get();
  return snap.docs
    .filter((d) => d.get('state') !== 'excluded')
    .map((d, i) => ({
      n: i + 1,
      id: d.id,
      title: String(d.get('title') ?? ''),
      company: String(d.get('company') ?? ''),
      companyId: String(d.get('companyId') ?? ''),
      url: String(d.get('url') ?? ''),
      publishedAt: String(d.get('publishedAt') ?? ''),
      lead: String(d.get('lead') ?? ''),
      type: d.get('type') as string | undefined,
      isCase: d.get('isCase') as boolean | undefined,
    }));
}

/** ★を付けた記事の傾向（AI に「担当者の好み」として渡す） */
async function starExamples(db: Firestore): Promise<string[]> {
  const snap = await db.collection('kbArticles').where('stars', '>=', 2).limit(30).get();
  return snap.docs.map((d) => `★${d.get('stars')} ${String(d.get('kb.caseTitle') || d.get('title') || '').slice(0, 60)}`);
}

const line = (c: Cand, lead = 70) =>
  `[${c.n}] ${c.company}｜${c.title.slice(0, 100)}${c.type ? `｜${c.type}` : ''}${c.tracked ? `｜追っている会社（${c.tracked}）` : ''}${lead && c.lead ? `｜${c.lead.replace(/\s+/g, ' ').slice(0, lead)}` : ''}`;

// ---- デイリー ----

export const DailyOut = z.object({
  picks: z.array(z.object({ n: z.number(), reason: z.string(), service: z.enum([...SERVICES, 'その他']) })),
  netas: z.array(z.object({ talk: z.string(), to: z.string(), n: z.number() })),
});

export const DAILY_SYSTEM = `あなたは、経営・事業支援／資金調達・M&A支援／マーケ・営業支援／人材・組織支援を提供する会社の営業担当者のために、毎朝のレポートを作る係です。
渡されるのは、昨日配信されたプレスリリースの一覧（[番号] 会社｜タイトル｜種類｜冒頭）と、担当者が★を付けた記事の例（担当者の好み）です。

picks: 営業の目で「昨日の注目記事」を5〜10件選ぶ。担当者のサービスにつながる会社の動き（資金調達、M&A・資本提携、新規事業、上場準備、組織の拡大、拠点の新設など）を優先し、「追っている会社」の記事があれば必ず入れる。★の例に近い記事も優先する。
  n は記事の番号、reason はなぜ注目かを1文（何が起きたか＋営業としての意味）、service は一番つながるサービス。
netas: 今日の営業ネタを3つ。talk はそのまま話せる一言（60〜90字。他社に事例として紹介する、またはこの会社に話しかけるきっかけ）、to は誰に話すとよいか（例：シリーズA前後の SaaS 企業の経営者）、n は根拠の記事の番号。
記事にないことは書かない。番号は渡されたものだけを使う。`;

export async function dailyReport(deps: ReportDeps, now = Date.now()) {
  const { db } = deps;
  const today = jstDayStart(now);
  const from = today - DAY;
  const date = jstDate(from);
  const tracked = await trackedCompanies(db);
  const all = await articlesBetween(db, from, today);
  for (const c of all) c.tracked = tracked.get(c.companyId);
  // 多すぎるときは、事例らしい・事業の動き・追っている会社を先に（最大 900 件）
  const rank = (c: Cand) => (c.tracked ? 0 : c.isCase ? 1 : c.type && c.type !== 'その他' ? 2 : 3);
  const cands = [...all].sort((a, b) => rank(a) - rank(b)).slice(0, 900);
  cands.forEach((c, i) => (c.n = i + 1));
  const ref = db.collection('kbReports').doc(`daily_${date.replace(/-/g, '')}`);
  if (!cands.length) {
    await ref.set({ kind: 'daily', date, picks: [], netas: [], counts: { articles: 0 }, at: new Date().toISOString(), note: '昨日の記事がまだ目録にありません' });
    return { picks: 0 };
  }
  const stars = await starExamples(db);
  const r = await deps.client().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: betaZodOutputFormat(DailyOut) },
    system: [{ type: 'text', text: DAILY_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `★を付けた記事の例（担当者の好み）:\n${stars.join('\n') || '（まだありません）'}\n\n昨日（${date}）の記事 ${cands.length} 件:\n${cands.map((c) => line(c)).join('\n')}`,
      },
    ],
  });
  await addUsage(db, usageOf(r.model ?? MODEL, r.usage), 'daily');
  const o = r.parsed_output;
  if (r.stop_reason === 'refusal' || !o) throw new Error(`デイリーを作れませんでした（${r.stop_reason}）`);
  const byN = new Map(cands.map((c) => [c.n, c]));
  const art = (c: Cand) => ({ id: c.id, title: c.title, company: c.company, companyId: c.companyId, url: c.url, publishedAt: c.publishedAt, ...(c.tracked ? { tracked: c.tracked } : {}) });
  const seen = new Set<number>();
  const picks = o.picks
    .filter((p) => byN.has(p.n) && !seen.has(p.n) && seen.add(p.n))
    .slice(0, 10)
    .map((p) => ({ ...art(byN.get(p.n)!), reason: p.reason.slice(0, 200), service: p.service }));
  const netas = o.netas
    .filter((x) => byN.has(x.n))
    .slice(0, 3)
    .map((x) => ({ talk: x.talk.slice(0, 200), to: x.to.slice(0, 80), ...art(byN.get(x.n)!) }));
  const report = { kind: 'daily', date, picks, netas, counts: { articles: all.length }, model: r.model ?? MODEL, at: new Date().toISOString() };
  await ref.set(report);
  await mailOut(ref, deps.send, () => dailyMail(report));
  return { picks: picks.length, netas: netas.length };
}

// ---- ウィークリー ----

export const WeeklyOut = z.object({
  best: z.array(z.object({ n: z.number(), why: z.string() })),
  companies: z.array(z.object({ n: z.number(), reason: z.string(), service: z.enum([...SERVICES, 'その他']), action: z.string() })),
  summary: z.string(),
});

export const WEEKLY_SYSTEM = `あなたは、経営・事業支援／資金調達・M&A支援／マーケ・営業支援／人材・組織支援を提供する会社の営業担当者のために、週のふりかえりレポートを作る係です。
渡されるのは、今週の事業の動きの記事（[番号] 会社｜タイトル｜種類｜冒頭）と、担当者が今週読んだ記事のメモです。

summary: 今週の動きを営業の目で3〜4文（どんな種類の動きが多かったか、目立った流れ）。
best: 他社に事例として紹介したい「今週の事例ベスト」を5件。n は記事の番号、why は紹介したい理由と使い方を1〜2文。
companies: 「来週動くとよい会社」を5社。今週の動きから、担当者のサービスが必要になりそうな会社を選ぶ。「追っている会社」は優先して入れる。担当者のメモがある会社も優先。
  n はその会社の根拠の記事の番号、reason は今声をかけるとよい理由（1文）、service は提案するサービス、action は来週やること（1文。例：資金調達の記事を話題に経営者へ連絡し、採用計画を聞く）。
記事にないことは書かない。番号は渡されたものだけを使う。`;

/** AI の費用（ドル）：Knowledge Base（kbMeta/usage_日）と Watcher・台帳（aiUsage/日） */
export async function costBetween(db: Firestore, fromDay: string, toDay: string): Promise<{ kb: number; watcher: number }> {
  const key = (d: string) => d.replace(/-/g, '');
  const kbSnap = await db
    .collection('kbMeta')
    .where(FieldPath.documentId(), '>=', `usage_${key(fromDay)}`)
    .where(FieldPath.documentId(), '<=', `usage_${key(toDay)}`)
    .get();
  const kb = kbSnap.docs.reduce((s, d) => s + Number(d.get('usd') ?? 0), 0);
  const wSnap = await db.collection('aiUsage').where(FieldPath.documentId(), '>=', key(fromDay)).where(FieldPath.documentId(), '<=', key(toDay)).get();
  let watcher = 0;
  for (const d of wSnap.docs)
    for (const [model, u] of Object.entries(d.data() as Record<string, { input?: number; output?: number; cacheRead?: number }>)) {
      if (!u || typeof u !== 'object') continue;
      const p = PRICES[model] ?? { input: 5, output: 25, cacheRead: 0.5 };
      watcher += ((u.input ?? 0) * p.input + (u.output ?? 0) * p.output + (u.cacheRead ?? 0) * p.cacheRead) / 1e6;
    }
  return { kb, watcher };
}

export async function weeklyReport(deps: ReportDeps, now = Date.now()) {
  const { db } = deps;
  // 今週＝月曜 0:00 から今まで（JST）
  const today = jstDayStart(now);
  const dow = (new Date(today + JST).getUTCDay() + 6) % 7; // 月曜=0
  const from = today - dow * DAY;
  const to = now;
  const fromDay = jstDate(from);
  const toDay = jstDate(now);
  const tracked = await trackedCompanies(db);

  // ふりかえり（件数）
  const all = await articlesBetween(db, from, to + DAY);
  const byType: Record<string, number> = {};
  for (const c of all) if (c.type) byType[c.type] = (byType[c.type] ?? 0) + 1;
  const reads = (await db.collection('kbArticles').where('source', '==', 'handoff').get()).docs.filter((d) => {
    const t = new Date(String(d.get('readAt') ?? '')).getTime();
    return t >= from && t <= to;
  });
  const themeGrowth: Record<string, number> = {};
  for (const d of reads) for (const t of (d.get('themes') as string[] | undefined) ?? []) themeGrowth[t] = (themeGrowth[t] ?? 0) + 1;

  // AI に渡す：事業の動きの記事（事例らしい・追っている会社を先に、最大 700 件）と、読んだ記事のメモ
  for (const c of all) c.tracked = tracked.get(c.companyId);
  const moves = all
    .filter((c) => c.tracked || c.isCase || (c.type && !['その他', '業績・決算'].includes(c.type)))
    .sort((a, b) => Number(!a.tracked) - Number(!b.tracked) || Number(!a.isCase) - Number(!b.isCase))
    .slice(0, 700);
  moves.forEach((c, i) => (c.n = i + 1));
  const memos = reads
    .filter((d) => d.get('memo'))
    .slice(0, 40)
    .map((d) => `${d.get('company')}｜${String(d.get('kb.caseTitle') || d.get('title') || '').slice(0, 60)}｜メモ: ${String(d.get('memo')).replace(/\s+/g, ' ').slice(0, 160)}`);

  let best: unknown[] = [];
  let companies: unknown[] = [];
  let summary = '';
  let model: string | undefined;
  if (moves.length) {
    const r = await deps.client().beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: betaZodOutputFormat(WeeklyOut) },
      system: [{ type: 'text', text: WEEKLY_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: `担当者が今週読んだ記事のメモ:\n${memos.join('\n') || '（なし）'}\n\n今週（${fromDay}〜${toDay}）の事業の動きの記事 ${moves.length} 件:\n${moves.map((c) => line(c, 60)).join('\n')}`,
        },
      ],
    });
    model = r.model ?? MODEL;
    await addUsage(db, usageOf(model, r.usage), 'weekly');
    const o = r.parsed_output;
    if (r.stop_reason === 'refusal' || !o) throw new Error(`ウィークリーを作れませんでした（${r.stop_reason}）`);
    const byN = new Map(moves.map((c) => [c.n, c]));
    const art = (c: Cand) => ({ id: c.id, title: c.title, company: c.company, companyId: c.companyId, url: c.url, publishedAt: c.publishedAt, ...(c.tracked ? { tracked: c.tracked } : {}) });
    best = o.best.filter((b) => byN.has(b.n)).slice(0, 5).map((b) => ({ ...art(byN.get(b.n)!), why: b.why.slice(0, 300) }));
    const seenCo = new Set<string>();
    companies = o.companies
      .filter((c) => byN.has(c.n) && !seenCo.has(byN.get(c.n)!.companyId) && seenCo.add(byN.get(c.n)!.companyId))
      .slice(0, 5)
      .map((c) => ({ ...art(byN.get(c.n)!), reason: c.reason.slice(0, 200), service: c.service, action: c.action.slice(0, 200) }));
    summary = o.summary.slice(0, 600);
  }

  // AI の費用（今週・今月）
  const week = await costBetween(db, fromDay, toDay);
  const month = await costBetween(db, `${toDay.slice(0, 8)}01`, toDay);
  const ref = db.collection('kbReports').doc(`weekly_${toDay.replace(/-/g, '')}`);
  const report = {
    kind: 'weekly',
    date: toDay,
    from: fromDay,
    summary,
    counts: { articles: all.length, byType, reads: reads.length, themeGrowth },
    best,
    companies,
    cost: { usdJpy: USD_JPY, week, month },
    ...(model ? { model } : {}),
    at: new Date().toISOString(),
  };
  await ref.set(report);
  await mailOut(ref, deps.send, () => weeklyMail(report as Parameters<typeof weeklyMail>[0]));
  return { best: best.length, companies: companies.length };
}

export { PRICES };
