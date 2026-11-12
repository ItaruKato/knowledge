import type Anthropic from '@anthropic-ai/sdk';
import { FieldValue, Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { summarizeCompany } from './company';
import { analyzeIndexed, searchIndex, type SearchFilters } from './search';
import type { Embed } from './vertex';

/**
 * 画面からの依頼（kbJobs/{自動ID}）。画面から関数を直接呼ばない（外から呼べる入口を作らない）ため、依頼は Firestore に書いてもらう。
 * 依頼が書かれた瞬間に動く関数（Firestore のトリガー）が処理し、届かなかった分は10分ごとの取り込みのついでに拾う。1日たった依頼は消す。
 * - company: 会社ページの AI のまとめ（id: 会社ID、redo: 材料が同じでも作り直す）
 * - search: 全記事を意味で探す（q: 言葉、filters: 期間・種類・事例だけ）。結果は result.hits
 * - analyze: 全記事の検索結果の記事を詳しく整理する（id: 記事ID）。本人がボタンを押したときだけ
 */
export interface KbJob {
  type: 'company' | 'search' | 'analyze';
  id?: string;
  redo?: boolean;
  q?: string;
  filters?: SearchFilters;
  state: 'ready' | 'working' | 'done' | 'failed';
  at?: Timestamp;
}

const CID_RE = /^\d{1,12}$/;
const AID_RE = /^\d+\.\d+$/;
type JobDeps = { db: Firestore; client: () => Anthropic; embed?: Embed; log?: (msg: string, data?: Record<string, unknown>) => void };
const KEEP_MS = 24 * 3600e3;

/** 依頼を引き受ける（同じ依頼が2回届いても1回だけ処理する） */
async function claim(db: Firestore, ref: DocumentReference): Promise<KbJob | null> {
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const j = s.data() as KbJob | undefined;
    if (!j || j.state !== 'ready') return null;
    tx.update(ref, { state: 'working', startedAt: FieldValue.serverTimestamp() });
    return j;
  });
}

export async function runJob(deps: JobDeps, ref: DocumentReference): Promise<string> {
  const job = await claim(deps.db, ref);
  if (!job) return 'skipped';
  try {
    if (job.type === 'company') {
      if (!CID_RE.test(job.id ?? '')) throw new Error('会社IDが正しくありません');
      const r = await summarizeCompany(deps.db, deps.client, job.id!, Boolean(job.redo));
      await ref.update({ state: 'done', result: r, doneAt: FieldValue.serverTimestamp() });
      return r;
    }
    if (job.type === 'search') {
      if (!deps.embed) throw new Error('検索の準備ができていません');
      const hits = await searchIndex(deps.db, deps.embed, String(job.q ?? ''), job.filters ?? {});
      await ref.update({ state: 'done', result: { hits }, doneAt: FieldValue.serverTimestamp() });
      return 'searched';
    }
    if (job.type === 'analyze') {
      if (!AID_RE.test(job.id ?? '')) throw new Error('記事IDが正しくありません');
      const r = await analyzeIndexed(deps, job.id!);
      await ref.update({ state: 'done', result: r, doneAt: FieldValue.serverTimestamp() });
      return r;
    }
    throw new Error(`知らない依頼です: ${String(job.type)}`);
  } catch (e) {
    deps.log?.('kb job failed', { type: job.type, error: String(e).slice(0, 200) });
    await ref.update({ state: 'failed', error: String(e).slice(0, 300) });
    return 'failed';
  }
}

/** 予備：届かなかった依頼（2分以上 ready のまま）を処理し、1日たった依頼を消す */
export async function jobSweep(deps: JobDeps, until: number) {
  const { db } = deps;
  const ready = await db.collection('kbJobs').where('state', '==', 'ready').limit(20).get();
  let ran = 0;
  for (const d of ready.docs) {
    if (Date.now() >= until) break;
    const at = d.get('at') as Timestamp | undefined;
    if (at && Date.now() - at.toMillis() < 120_000) continue;
    await runJob(deps, d.ref);
    ran++;
  }
  const old = await db.collection('kbJobs').where('at', '<', Timestamp.fromMillis(Date.now() - KEEP_MS)).limit(200).get();
  if (!old.empty) {
    const b = db.batch();
    for (const o of old.docs) b.delete(o.ref);
    await b.commit();
  }
  return { ran, cleaned: old.size };
}

/** 関数から依頼を足す（取り込みで記事を整理したら、その会社のまとめを作り直す） */
export async function addJob(db: Firestore, job: Omit<KbJob, 'state' | 'at'> & { by?: string }) {
  await db.collection('kbJobs').add({ ...job, state: 'ready', at: FieldValue.serverTimestamp() });
}
