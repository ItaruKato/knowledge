import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { FieldPath, FieldValue, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { ARTICLE_TYPES, EXCLUDED_TYPES, MODEL, ruleExcluded } from './analyze';
import { docText, EMBED_BATCH, type Embed } from './vertex';
import { addUsage, usageOf } from './usage';
import { withLease } from './lease';

/**
 * 全記事の目録（kbIndex/{記事ID}）。本人の決定（2026-11-12）：
 * - 対象は Watcher が集めた 2026-09-01 以降の全記事（buckets）。読むだけ
 * - タイトルで明らかにセミナー・告知・調査・キャンペーン・受賞/人事の記事は、AI を使わずに外す（state: excluded）
 * - 残りは Vertex AI で数値にし（意味で探すため）、Claude（Opus）で記事の種類・業界・事例らしさを軽く分類する。
 *   分類はまとめて処理する仕組み（Message Batches。費用は半額、結果は数時間以内）で頼む
 * - 詳しい整理（本文＋Opus）は、全記事の検索結果の「詳しく整理」ボタンを押した記事だけ（jobs.ts の analyze）
 */

export const INDEX_FROM = '2026090100';
const BUCKETS_PER_RUN = 30;
/** 新しい記事があとから入ることがあるので、この時間分は毎回読み直す */
const LATE_HOURS = 3;
const EMBED_PER_RUN = 1500;
/** 1つの頼みに入れる記事の数と、1回に出す頼みの数 */
const CLS_PER_REQUEST = 50;
const CLS_REQUESTS_PER_BATCH = 40;
const MAX_PENDING_BATCHES = 3;

export interface BucketItem {
  id: string;
  url?: string;
  title?: string;
  company?: string;
  companyId?: string;
  publishedAt?: string;
  lead?: string;
  keywords?: string[];
}

const p2 = (n: number) => String(n).padStart(2, '0');
/** JST の YYYYMMDDHH（buckets のドキュメントIDと同じ） */
export function jstHourKey(ms: number): string {
  const d = new Date(ms + 9 * 3600e3);
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}`;
}

// ---- 分類（Claude） ----

export const ClsOut = z.object({
  items: z.array(z.object({ id: z.string(), type: z.enum(ARTICLE_TYPES), industry: z.string(), isCase: z.boolean() })),
});

export const CLS_SYSTEM = `あなたは、経営・事業支援／資金調達・M&A支援／マーケ・営業支援／人材・組織支援を提供する会社の営業担当者のために、プレスリリースを仕分ける係です。
渡された記事（ID｜会社｜タイトル｜冒頭）それぞれについて、次の3つを答えます。渡された記事は全部、同じ ID で答えます。

type: 記事の種類を1つ。会社の事業の動き（新規事業・新商品・新サービス、資金調達、M&A・資本提携、業務提携・協業、上場・IPO、経営・組織、海外展開、業績・決算）が中心ならその種類。
  セミナー・ウェビナー・勉強会・お役立ち資料の公開は「セミナー・勉強会・学習コンテンツ」、展示会への出展・イベントの告知は「展示会・イベントの告知」、調査結果・アンケートは「調査レポート・アンケート」、販促キャンペーン・プレゼントは「キャンペーン・プレゼント」、受賞・認定・役員の就任は「受賞・認定・人事」。事業の動きと告知の両方があるときは事業の動きを選ぶ。
industry: その会社の業界を、営業で使う短い言葉で1つ（例: SaaS、物流、不動産テック、D2C、医療・ヘルスケア、製造、人材、飲食、金融）。
isCase: ほかの会社に「先行事例」として紹介できる取り組み（資金調達、M&A、提携、新規事業、採用・組織の施策、DX、海外展開、マーケ施策など）なら true。`;

export function clsContent(items: { id: string; company?: string; title?: string; lead?: string }[]): string {
  const one = (s: string | undefined, n: number) => (s ?? '').replace(/[\s｜]+/g, ' ').trim().slice(0, n);
  return items.map((a) => `${a.id}｜${one(a.company, 40)}｜${one(a.title, 120)}｜${one(a.lead, 150)}`).join('\n');
}

/** 頼みの中身（まとめて処理する仕組みでは fallbacks は使えない） */
export function clsParams(items: { id: string; company?: string; title?: string; lead?: string }[]) {
  return {
    model: MODEL,
    max_tokens: 16000,
    output_config: { format: zodOutputFormat(ClsOut) },
    system: [{ type: 'text' as const, text: CLS_SYSTEM, cache_control: { type: 'ephemeral' as const } }],
    messages: [{ role: 'user' as const, content: clsContent(items) }],
  };
}

export interface IndexDeps {
  db: Firestore;
  client: () => Anthropic;
  embed: Embed;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  now?: () => number;
  budgetMs?: number;
}

/** 1. buckets を前回の続きから読み、新しい記事を目録に入れる */
async function readBuckets(deps: IndexDeps, meta: Record<string, unknown>) {
  const { db } = deps;
  const now = (deps.now ?? Date.now)();
  const lateKey = jstHourKey(now - LATE_HOURS * 3600e3);
  const from = (meta.bucketCursor as string | undefined) ?? INDEX_FROM;
  const snap = await db
    .collection('buckets')
    .where(FieldPath.documentId(), '>=', from < INDEX_FROM ? INDEX_FROM : from)
    .orderBy(FieldPath.documentId())
    .limit(BUCKETS_PER_RUN)
    .get();
  const items = new Map<string, BucketItem>();
  for (const d of snap.docs) for (const [id, a] of Object.entries((d.get('items') ?? {}) as Record<string, BucketItem>)) items.set(id, { ...a, id });
  const ids = [...items.keys()];
  const have = new Set<string>();
  for (let i = 0; i < ids.length; i += 300) {
    const snaps = await db.getAll(...ids.slice(i, i + 300).map((id) => db.collection('kbIndex').doc(id)));
    for (const s of snaps) if (s.exists) have.add(s.id);
  }
  let added = 0;
  let excluded = 0;
  let batch = db.batch();
  let n = 0;
  for (const a of items.values()) {
    if (have.has(a.id) || !/^\d+\.\d+$/.test(a.id)) continue;
    const base = {
      id: a.id,
      title: (a.title ?? '').slice(0, 200),
      company: (a.company ?? '').slice(0, 100),
      companyId: a.companyId ?? String(parseInt(a.id.split('.')[1], 10)),
      url: a.url ?? '',
      publishedAt: a.publishedAt ?? '',
      at: new Date(now).toISOString(),
    };
    const rule = ruleExcluded(a.title ?? '');
    if (rule) {
      // 知識に入れない記事は、印だけ（数値にも分類にもしない）
      batch.set(db.collection('kbIndex').doc(a.id), { ...base, state: 'excluded', type: rule, excludedBy: 'rule' });
      excluded++;
    } else {
      batch.set(db.collection('kbIndex').doc(a.id), {
        ...base,
        lead: (a.lead ?? '').slice(0, 200),
        keywords: (a.keywords ?? []).slice(0, 8),
        state: 'new',
        needsEmb: true,
        needsCls: true,
      });
      added++;
    }
    if (++n >= 400) {
      await batch.commit();
      batch = db.batch();
      n = 0;
    }
  }
  if (n) await batch.commit();
  // 読み終えた位置。最近の数時間分は毎回読み直す
  const last = snap.docs.at(-1)?.id.slice(0, 10);
  let cursor = from;
  if (snap.size === BUCKETS_PER_RUN && last) cursor = last;
  else cursor = lateKey;
  if (cursor > lateKey) cursor = lateKey;
  return { buckets: snap.size, added, excluded, cursor };
}

/** 2. 数値（ベクトル）にする */
async function embedNew(deps: IndexDeps, until: number) {
  const { db } = deps;
  const snap = await db.collection('kbIndex').where('needsEmb', '==', true).limit(EMBED_PER_RUN).get();
  let done = 0;
  for (let i = 0; i < snap.docs.length && Date.now() < until; i += EMBED_BATCH) {
    const docs = snap.docs.slice(i, i + EMBED_BATCH);
    const vecs = await deps.embed(
      docs.map((d) => docText(d.data())),
      'RETRIEVAL_DOCUMENT',
    );
    const b = db.batch();
    docs.forEach((d, k) => b.update(d.ref, { emb: FieldValue.vector(vecs[k]), needsEmb: FieldValue.delete(), embAt: new Date().toISOString() }));
    await b.commit();
    done += docs.length;
  }
  return done;
}

/** 業界：台帳の業界タグ（Long List のチャットが companies.industryTags に付ける）があればそれ、なければ AI の答え */
async function industryLabels(db: Firestore, cids: string[]): Promise<Map<string, string>> {
  const meta = await db.collection('meta').doc('industryTags').get();
  const label = new Map(((meta.get('tags') ?? []) as { code: string; label: string }[]).map((t) => [t.code, t.label]));
  const out = new Map<string, string>();
  const uniq = [...new Set(cids)].filter(Boolean);
  for (let i = 0; i < uniq.length; i += 300) {
    const snaps = await db.getAll(...uniq.slice(i, i + 300).map((c) => db.collection('companies').doc(c)));
    for (const s of snaps) {
      const code = s.get('industryTags.main') as string | undefined;
      if (code && label.get(code)) out.set(s.id, label.get(code)!);
    }
  }
  return out;
}

/** 3. 分類：終わった頼みの結果を書き、新しい頼みを出す */
async function classify(deps: IndexDeps) {
  const { db } = deps;
  const client = deps.client();
  const metaRef = db.collection('kbMeta').doc('indexBatches');
  const pending = (((await metaRef.get()).get('pending') ?? []) as string[]).slice();
  let applied = 0;
  let excluded = 0;
  let retried = 0;
  for (const batchId of pending.slice()) {
    const info = await client.messages.batches.retrieve(batchId);
    if (info.processing_status !== 'ended') continue;
    const mapRef = db.collection('kbMeta').doc(`batch_${batchId}`);
    const map = ((await mapRef.get()).get('map') ?? {}) as Record<string, string[]>;
    const results: { ids: string[]; out?: z.infer<typeof ClsOut> }[] = [];
    for await (const r of await client.messages.batches.results(batchId)) {
      const ids = map[r.custom_id] ?? [];
      if (r.result.type !== 'succeeded') {
        results.push({ ids });
        continue;
      }
      const m = r.result.message;
      await addUsage(db, { ...usageOf(m.model ?? MODEL, m.usage), input: Math.round(m.usage.input_tokens / 2), output: Math.round(m.usage.output_tokens / 2) }, 'index');
      const text = m.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('');
      try {
        const parsed = ClsOut.safeParse(JSON.parse(text));
        results.push({ ids, out: parsed.success ? parsed.data : undefined });
      } catch {
        results.push({ ids });
      }
    }
    const all = results.flatMap((r) => r.ids);
    const ind = await industryLabels(db, all.map((id) => String(parseInt(id.split('.')[1], 10))));
    let b = db.batch();
    let n = 0;
    for (const r of results) {
      const got = new Map((r.out?.items ?? []).map((x) => [x.id, x]));
      for (const id of r.ids) {
        const ref = db.collection('kbIndex').doc(id);
        const x = got.get(id);
        if (!x) {
          // 答えがなかった記事は、次の頼みにもう一度入れる
          b.update(ref, { needsCls: true, clsBatch: FieldValue.delete() });
          retried++;
        } else if (EXCLUDED_TYPES.includes(x.type)) {
          b.update(ref, { state: 'excluded', type: x.type, excludedBy: 'ai', emb: FieldValue.delete(), clsBatch: FieldValue.delete(), clsAt: new Date().toISOString() });
          excluded++;
        } else {
          const cid = String(parseInt(id.split('.')[1], 10));
          b.update(ref, {
            state: 'done',
            type: x.type,
            industry: ind.get(cid) ?? x.industry.slice(0, 30),
            industryFrom: ind.has(cid) ? 'ledger' : 'ai',
            isCase: x.isCase,
            clsBatch: FieldValue.delete(),
            clsAt: new Date().toISOString(),
          });
          applied++;
        }
        if (++n >= 400) {
          await b.commit();
          b = db.batch();
          n = 0;
        }
      }
    }
    if (n) await b.commit();
    pending.splice(pending.indexOf(batchId), 1);
    await mapRef.delete();
  }

  // 新しい頼みを出す（出しっぱなしの頼みが多いときは待つ）
  let submitted = 0;
  if (pending.length < MAX_PENDING_BATCHES) {
    const snap = await db.collection('kbIndex').where('needsCls', '==', true).limit(CLS_PER_REQUEST * CLS_REQUESTS_PER_BATCH).get();
    if (!snap.empty) {
      const docs = snap.docs.map((d) => ({ ...(d.data() as BucketItem), id: d.id }));
      const map: Record<string, string[]> = {};
      const requests = [];
      for (let i = 0; i < docs.length; i += CLS_PER_REQUEST) {
        const chunk = docs.slice(i, i + CLS_PER_REQUEST);
        const cid = `c${i / CLS_PER_REQUEST}`;
        map[cid] = chunk.map((d) => d.id);
        requests.push({ custom_id: cid, params: clsParams(chunk) });
      }
      const created = await client.messages.batches.create({ requests } as Parameters<typeof client.messages.batches.create>[0]);
      await db.collection('kbMeta').doc(`batch_${created.id}`).set({ map, at: new Date().toISOString(), count: docs.length });
      let b = db.batch();
      let n = 0;
      for (const d of snap.docs) {
        b.update(d.ref, { needsCls: FieldValue.delete(), clsBatch: created.id });
        if (++n >= 400) {
          await b.commit();
          b = db.batch();
          n = 0;
        }
      }
      if (n) await b.commit();
      pending.push(created.id);
      submitted = docs.length;
    }
  }
  await metaRef.set({ pending, updatedAt: new Date().toISOString() });
  return { applied, excluded, retried, submitted, pending: pending.length };
}

/** 全記事の目録づくり（10分ごと）。読む → 数値にする → 分類 */
export async function indexSweep(deps: IndexDeps) {
  const { db } = deps;
  const metaRef = db.collection('kbMeta').doc('index');
  const r = await withLease(db, 'index', 540_000, async () => {
    const until = Date.now() + (deps.budgetMs ?? 400_000);
    const meta = (await metaRef.get()).data() ?? {};
    const read = await readBuckets(deps, meta);
    // 数値にする段階で止まっても（Vertex AI の権限がまだないなど）、分類は進める
    let embedded = 0;
    let embedError: string | null = null;
    try {
      embedded = await embedNew(deps, until);
    } catch (e) {
      embedError = String(e).slice(0, 300);
      deps.log?.('kb index: embed failed', { error: embedError });
    }
    const cls = await classify(deps);
    const count = async (q: FirebaseFirestore.Query) => (await q.count().get()).data().count;
    const col = db.collection('kbIndex');
    const stats = {
      total: await count(col),
      done: await count(col.where('state', '==', 'done')),
      excluded: await count(col.where('state', '==', 'excluded')),
      waitingEmb: await count(col.where('needsEmb', '==', true)),
    };
    const result = { buckets: read.buckets, added: read.added, ruleExcluded: read.excluded, embedded, ...cls };
    await metaRef.set({ bucketCursor: read.cursor, lastRunAt: new Date().toISOString(), last: result, stats, lastError: embedError }, { merge: true });
    return result;
  }).catch(async (e) => {
    await metaRef.set({ lastErrorAt: new Date().toISOString(), lastError: String(e).slice(0, 300) }, { merge: true }).catch(() => {});
    throw e;
  });
  if (!r.ran) return { skipped: true };
  if (r.value.added || r.value.embedded || r.value.applied || r.value.submitted) deps.log?.('kb index', r.value);
  return r.value;
}
