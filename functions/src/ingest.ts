import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { FieldPath, FieldValue, type DocumentSnapshot, type Firestore } from 'firebase-admin/firestore';
import { analyze, ANALYSIS_V, themeName, type AnalysisOut, type AnalyzeInput } from './analyze';
import { extractBody, httpGet, isPrtimesUrl } from './page';
import { addUsage, type Usage } from './usage';
import { withLease } from './lease';

/**
 * 読了にした記事（Watcher の handoff）を Knowledge Base に取り込む。
 * - 読むだけ：handoff・saved・companies（Watcher・台帳のもの）
 * - 書く：kbArticles/{記事ID}（整理した記事）、kbBodies/{記事ID}（本文。大きいので分ける）、kbThemes/{テーマ名}（ネタ帳のテーマ）、kbMeta/ingest（進み具合）
 * handoff を updatedAt の順に読み、読み終えた位置を kbMeta/ingest に残す（メモや★を直すと updatedAt が変わり、もう一度読む）。
 */

export interface Handoff {
  id: string;
  article?: { id?: string; url?: string; title?: string; company?: string; publishedAt?: string; lead?: string };
  readAt?: string | null;
  memo?: string;
  myTags?: string[];
  stars?: number;
  draft?: { summary?: string; points?: { label: string; value: string }[]; angles?: string[]; fits?: { service: string; reason: string }[]; industry?: string; memo?: string } | null;
  updatedAt?: string;
}

const ID_RE = /^\d+\.\d+$/;
const MAX_TRIES = 3;
const PER_RUN = 40;

export const companyIdOf = (id: string) => String(parseInt(id.split('.')[1], 10));

/** 整理し直すかどうかを決める指紋（★・読んだ日時・Watcher の下書きが変わっただけでは整理し直さない） */
export function inputHash(h: Handoff): string {
  const a = h.article ?? {};
  return createHash('sha256')
    .update(JSON.stringify([ANALYSIS_V, a.title ?? '', a.url ?? '', h.memo ?? '', [...(h.myTags ?? [])].sort()]))
    .digest('hex')
    .slice(0, 16);
}

/** 台帳の会社の情報を、AI に渡す1行にする（中身はログに出さない） */
export function companyLine(c: Record<string, unknown> | undefined): string {
  if (!c) return '';
  const p = (c.profile ?? {}) as Record<string, string | undefined>;
  const g = (c.gbiz ?? {}) as Record<string, string | number | undefined>;
  const parts = [
    p.industry && `業種: ${p.industry}`,
    p.listed && `上場: ${p.listed}`,
    (p.capital || g.capital) && `資本金: ${p.capital ?? `${g.capital}円`}`,
    g.employees !== undefined && `従業員数: ${g.employees}人`,
    (p.established || g.established) && `設立: ${p.established ?? g.established}`,
    g.summary && `事業概要: ${String(g.summary).slice(0, 200)}`,
  ].filter(Boolean);
  return parts.join('、');
}

/** 本人のメモなど、Watcher から写す項目（整理し直さなくても毎回写す） */
function copied(h: Handoff) {
  const a = h.article ?? {};
  return {
    v: 1,
    id: h.id,
    companyId: companyIdOf(h.id),
    source: 'handoff',
    title: a.title ?? '',
    company: a.company ?? '',
    url: a.url ?? '',
    publishedAt: a.publishedAt ?? '',
    readAt: h.readAt ?? null,
    memo: h.memo ?? '',
    myTags: h.myTags ?? [],
    stars: h.stars ?? 0,
    draft: h.draft ?? null,
    handoffAt: h.updatedAt ?? null,
    updatedAt: new Date().toISOString(),
  };
}

export interface IngestDeps {
  db: Firestore;
  client: () => Anthropic;
  get?: (url: string) => Promise<string>;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  budgetMs?: number;
}

type Outcome = 'analyzed' | 'synced' | 'removed' | 'failed' | 'skipped';

async function loadThemes(db: Firestore): Promise<Map<string, number>> {
  const snap = await db.collection('kbThemes').get();
  return new Map(snap.docs.map((d) => [String(d.get('name') ?? d.id), Number(d.get('count') ?? 0)]));
}

/** テーマの件数を直す（新しいテーマは作る） */
async function applyThemes(db: Firestore, themes: Map<string, number>, before: string[], after: AnalysisOut['themes']) {
  const b = new Set(before);
  const batch = db.batch();
  const now = new Date().toISOString();
  for (const t of after) {
    if (b.has(t.name)) continue;
    const ref = db.collection('kbThemes').doc(t.name);
    const isNew = !themes.has(t.name);
    batch.set(
      ref,
      {
        name: t.name,
        count: FieldValue.increment(1),
        updatedAt: now,
        ...(isNew ? { service: t.service, description: t.description, createdAt: now, by: 'ai' } : {}),
      },
      { merge: true },
    );
    themes.set(t.name, (themes.get(t.name) ?? 0) + 1);
  }
  const a = new Set(after.map((t) => t.name));
  for (const name of before) {
    if (a.has(name)) continue;
    batch.set(db.collection('kbThemes').doc(name), { count: FieldValue.increment(-1), updatedAt: now }, { merge: true });
    themes.set(name, Math.max(0, (themes.get(name) ?? 1) - 1));
  }
  await batch.commit();
}

async function ingestOne(deps: IngestDeps, h: Handoff, themes: Map<string, number>): Promise<Outcome> {
  const { db } = deps;
  if (!ID_RE.test(h.id)) return 'skipped';
  const ref = db.collection('kbArticles').doc(h.id);
  const bodyRef = db.collection('kbBodies').doc(h.id);
  const [saved, existing, bodyDoc] = await db.getAll(db.collection('saved').doc(h.id), ref, bodyRef);
  const prevThemes = (existing.get('themes') as string[] | undefined) ?? [];

  // 読了を取り消した記事は Knowledge Base から外す
  if (saved.get('decision.status') !== 'done') {
    if (existing.exists) {
      if (prevThemes.length) await applyThemes(db, themes, prevThemes, []);
      await ref.delete();
      await bodyRef.delete();
      return 'removed';
    }
    return 'skipped';
  }

  const hash = inputHash(h);
  if (existing.get('state') === 'done' && existing.get('inputHash') === hash) {
    await ref.set(copied(h), { merge: true });
    return 'synced';
  }
  if (existing.get('state') === 'failed' && existing.get('inputHash') === hash && Number(existing.get('tries') ?? 0) >= MAX_TRIES) {
    await ref.set(copied(h), { merge: true });
    return 'skipped';
  }

  // 本文（一度取れたら取っておく）
  let body = (bodyDoc.get('body') as string | undefined) ?? (existing.get('body') as string | undefined) ?? '';
  let bodyFrom = (bodyDoc.get('from') as string | undefined) ?? (existing.get('bodyFrom') as string | undefined) ?? '';
  if (!body || bodyFrom !== 'page') {
    const url = h.article?.url;
    if (isPrtimesUrl(url)) {
      try {
        const text = extractBody(await (deps.get ?? httpGet)(url));
        if (text) {
          body = text;
          bodyFrom = 'page';
        }
      } catch (e) {
        deps.log?.('kb ingest: page fetch failed', { error: String(e).slice(0, 100) });
      }
    }
    if (!body) {
      body = h.article?.lead ?? '';
      bodyFrom = 'lead';
    }
  }

  const company = (await db.collection('companies').doc(companyIdOf(h.id)).get()).data();
  const input: AnalyzeInput = {
    title: h.article?.title ?? '',
    company: h.article?.company ?? '',
    publishedAt: h.article?.publishedAt ?? '',
    body,
    companyInfo: companyLine(company),
    memo: h.memo ?? '',
    myTags: h.myTags ?? [],
    draftSummary: h.draft?.summary ?? '',
    themes: [...themes].map(([name, count]) => ({ name, count })).filter((t) => t.count > 0).sort((x, y) => y.count - x.count),
  };
  try {
    const { out, model, usage } = await analyze(deps.client(), input);
    await addUsage(db, usage, 'ingest');
    // テーマ名は、いまあるテーマと表記ゆれだけの違いならそちらに寄せる
    out.themes = out.themes.map((t) => ({ ...t, name: [...themes.keys()].find((k) => themeName(k) === t.name) ?? t.name }));
    await applyThemes(db, themes, prevThemes, out.themes);
    await bodyRef.set({ body, from: bodyFrom, at: new Date().toISOString() });
    await ref.set({
      ...copied(h),
      bodyFrom,
      kb: out,
      themes: out.themes.map((t) => t.name),
      model,
      analyzedAt: new Date().toISOString(),
      analysisV: ANALYSIS_V,
      inputHash: hash,
      state: 'done',
    });
    return 'analyzed';
  } catch (e) {
    const usage = (e as { usage?: Usage }).usage;
    if (usage) await addUsage(db, usage, 'ingest');
    const sameInput = existing.get('inputHash') === hash;
    await bodyRef.set({ body, from: bodyFrom, at: new Date().toISOString() });
    await ref.set(
      {
        ...copied(h),
        body: FieldValue.delete(),
        bodyFrom,
        inputHash: hash,
        // 前の整理（kb）は残したまま、やり直し待ちにする
        state: 'failed',
        error: String(e).slice(0, 300),
        tries: sameInput ? FieldValue.increment(1) : 1,
      },
      { merge: true },
    );
    deps.log?.('kb ingest: analyze failed', { error: String(e).slice(0, 200) });
    return 'failed';
  }
}

/** handoff を前回の続きから読んで取り込む（10分ごと）。失敗した記事は次の回にもう一度（3回まで） */
export async function ingestSweep(deps: IngestDeps) {
  const { db } = deps;
  const metaRef = db.collection('kbMeta').doc('ingest');
  const r = await withLease(db, 'ingest', 540_000, async () => {
    const until = Date.now() + (deps.budgetMs ?? 400_000);
    const meta = (await metaRef.get()).data() ?? {};
    // 画面に「取り込み中」と出すため（中身は件数・時刻・エラーの種類だけ）
    await metaRef.set({ startedAt: new Date().toISOString() }, { merge: true });
    let cursor = (meta.cursor as { at: string; id: string } | undefined) ?? null;
    const themes = await loadThemes(db);
    const counts: Record<Outcome, number> = { analyzed: 0, synced: 0, removed: 0, failed: 0, skipped: 0 };

    // 0. 本文を kbArticles に入れていたころ（v0.3 まで）の記事は、本文を kbBodies へ移す
    const withBody = await db.collection('kbArticles').orderBy('body').limit(50).get();
    for (const d of withBody.docs) {
      const b = db.batch();
      b.set(db.collection('kbBodies').doc(d.id), { body: d.get('body'), from: d.get('bodyFrom') ?? 'page', at: new Date().toISOString() });
      b.update(d.ref, { body: FieldValue.delete() });
      await b.commit();
    }

    // 1. 失敗した記事をやり直す
    const retry = await db.collection('kbArticles').where('state', '==', 'failed').limit(10).get();
    for (const d of retry.docs) {
      if (Date.now() >= until) break;
      if (Number(d.get('tries') ?? 0) >= MAX_TRIES) continue;
      const h = await db.collection('handoff').doc(d.id).get();
      if (h.exists) counts[await ingestOne(deps, { ...(h.data() as Handoff), id: h.id }, themes)]++;
    }

    // 2. 新しく来た・変わった handoff
    let more = true;
    while (more && Date.now() < until) {
      let q = db.collection('handoff').orderBy('updatedAt').orderBy(FieldPath.documentId()).limit(PER_RUN);
      if (cursor) q = q.startAfter(cursor.at, cursor.id);
      const snap = await q.get();
      more = snap.size === PER_RUN;
      for (const d of snap.docs as DocumentSnapshot[]) {
        if (Date.now() >= until) {
          more = false;
          break;
        }
        const h = { ...(d.data() as Handoff), id: d.id };
        if (typeof h.updatedAt !== 'string') continue;
        counts[await ingestOne(deps, h, themes)]++;
        cursor = { at: h.updatedAt, id: d.id };
      }
    }
    const total = (await db.collection('kbArticles').count().get()).data().count;
    const result = { ...counts, total };
    await metaRef.set({ cursor, lastRunAt: new Date().toISOString(), last: counts, total, lastError: null }, { merge: true });
    return result;
  }).catch(async (e) => {
    // 途中で止まったときは、画面で分かるように残してから知らせる
    await metaRef.set({ lastErrorAt: new Date().toISOString(), lastError: String(e).slice(0, 300) }, { merge: true }).catch(() => {});
    throw e;
  });
  if (!r.ran) return { skipped: true };
  const v = r.value;
  if (v.analyzed || v.removed || v.failed) deps.log?.('kb ingest', v);
  return v;
}
