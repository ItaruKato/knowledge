import type Anthropic from '@anthropic-ai/sdk';
import type { Firestore } from 'firebase-admin/firestore';
import { analyze, ANALYSIS_V, EXCLUDED_TYPES, themeName, type AnalyzeInput } from './analyze';
import { applyThemes, companyIdOf, loadThemes } from './ingest';
import { companyLine } from './ledger';
import { extractBody, httpGet, isPrtimesUrl } from './page';
import { addUsage } from './usage';
import { addJob } from './jobs';
import type { Embed } from './vertex';

/**
 * 全記事の検索（kbJobs の search）と、検索結果の「詳しく整理」（kbJobs の analyze）。
 * 画面は依頼を kbJobs に書き、書かれた瞬間に動く関数（kbJobRun）が結果を依頼のドキュメントに書く。
 */

export const PERIODS = { week: 7, month: 31, quarter: 92, all: 0 } as const;
export type Period = keyof typeof PERIODS;
export interface SearchFilters {
  period?: Period;
  types?: string[];
  casesOnly?: boolean;
}
export interface SearchHit {
  id: string;
  score: number;
  title: string;
  company: string;
  companyId: string;
  url: string;
  publishedAt: string;
  type?: string;
  industry?: string;
  isCase?: boolean;
  /** 読んだ記事（Watcher で読了） */
  read: boolean;
  /** 詳しく整理済み（kbArticles にある） */
  analyzed: boolean;
  caseTitle?: string;
}

const MAX_HITS = 50;
/** 近い順にこれだけ取ってから、期間・種類などで絞る */
const NEAREST = 400;

/** 期間・種類・事例らしさで絞る（目録にまだ分類のない記事は、種類の絞り込みがないときだけ出す） */
export function passes(d: Record<string, unknown>, f: SearchFilters, now: number): boolean {
  if (d.state === 'excluded') return false;
  const days = PERIODS[f.period ?? 'all'] ?? 0;
  if (days && new Date(String(d.publishedAt ?? 0)).getTime() < now - days * 86400e3) return false;
  if (f.types?.length && !f.types.includes(String(d.type ?? ''))) return false;
  if (f.casesOnly && d.isCase !== true) return false;
  return true;
}

export async function searchIndex(db: Firestore, embed: Embed, q: string, f: SearchFilters, now = Date.now()): Promise<SearchHit[]> {
  const text = q.normalize('NFKC').trim().slice(0, 300);
  if (!text) return [];
  const [vec] = await embed([text], 'RETRIEVAL_QUERY');
  const snap = await db
    .collection('kbIndex')
    .findNearest({ vectorField: 'emb', queryVector: vec, limit: NEAREST, distanceMeasure: 'COSINE', distanceResultField: '_dist' })
    .get();
  const docs = snap.docs.filter((d) => passes(d.data(), f, now)).slice(0, MAX_HITS);
  const arts = docs.length ? await db.getAll(...docs.map((d) => db.collection('kbArticles').doc(d.id))) : [];
  return docs.map((d, i) => {
    const x = d.data();
    const a = arts[i];
    const analyzed = a.exists && a.get('state') === 'done';
    return {
      id: d.id,
      score: Math.round((1 - Number(x._dist ?? 1)) * 1000) / 1000,
      title: String(x.title ?? ''),
      company: String(x.company ?? ''),
      companyId: String(x.companyId ?? ''),
      url: String(x.url ?? ''),
      publishedAt: String(x.publishedAt ?? ''),
      type: x.type as string | undefined,
      industry: x.industry as string | undefined,
      isCase: x.isCase as boolean | undefined,
      read: a.exists && a.get('source') === 'handoff',
      analyzed,
      ...(analyzed && a.get('kb.caseTitle') ? { caseTitle: String(a.get('kb.caseTitle')) } : {}),
    };
  });
}

/** 検索結果の記事を、読んだ記事と同じ詳しさで整理する（本文＋Opus）。ボタンを押した記事だけ */
export async function analyzeIndexed(
  deps: { db: Firestore; client: () => Anthropic; get?: (url: string) => Promise<string> },
  id: string,
): Promise<'done' | 'exists' | 'excluded' | 'notfound'> {
  const { db } = deps;
  const [ix, existing] = await db.getAll(db.collection('kbIndex').doc(id), db.collection('kbArticles').doc(id));
  if (existing.exists && existing.get('state') === 'done') return 'exists';
  if (!ix.exists) return 'notfound';
  const x = ix.data()!;
  let body = '';
  let bodyFrom = 'lead';
  if (isPrtimesUrl(x.url)) {
    try {
      body = extractBody(await (deps.get ?? httpGet)(x.url));
      if (body) bodyFrom = 'page';
    } catch {
      /* 冒頭で整理する */
    }
  }
  if (!body) body = String(x.lead ?? '');
  const themes = await loadThemes(db);
  const company = (await db.collection('companies').doc(companyIdOf(id)).get()).data();
  const input: AnalyzeInput = {
    title: String(x.title ?? ''),
    company: String(x.company ?? ''),
    publishedAt: String(x.publishedAt ?? ''),
    body,
    companyInfo: companyLine(company),
    memo: '',
    myTags: [],
    draftSummary: '',
    themes: [...themes].map(([name, count]) => ({ name, count })).filter((t) => t.count > 0).sort((p, q) => q.count - p.count),
  };
  const { out, model, usage } = await analyze(deps.client(), input);
  await addUsage(db, usage, 'analyze');
  if (EXCLUDED_TYPES.includes(out.articleType)) {
    await ix.ref.update({ state: 'excluded', type: out.articleType, excludedBy: 'ai' });
    return 'excluded';
  }
  out.themes = out.themes.map((t) => ({ ...t, name: [...themes.keys()].find((k) => themeName(k) === t.name) ?? t.name }));
  await applyThemes(db, themes, [], out.themes);
  const now = new Date().toISOString();
  await db.collection('kbBodies').doc(id).set({ body, from: bodyFrom, at: now });
  await db.collection('kbArticles').doc(id).set({
    v: 1,
    id,
    companyId: companyIdOf(id),
    // 読んだ記事ではない（全記事の検索から詳しく整理した記事）
    source: 'search',
    title: String(x.title ?? ''),
    company: String(x.company ?? ''),
    url: String(x.url ?? ''),
    publishedAt: String(x.publishedAt ?? ''),
    readAt: null,
    memo: '',
    myTags: [],
    stars: 0,
    draft: null,
    bodyFrom,
    kb: out,
    themes: out.themes.map((t) => t.name),
    model,
    analyzedAt: now,
    analysisV: ANALYSIS_V,
    inputHash: `search-${ANALYSIS_V}`,
    state: 'done',
    updatedAt: now,
  });
  await addJob(db, { type: 'company', id: companyIdOf(id), by: 'analyze' });
  return 'done';
}
