import type { KbArticle, KbTheme } from '../types';

/** functions/src/analyze.ts と同じ選択肢（本人の決定） */
export const SERVICES = ['経営・事業支援', '資金調達・M&A支援', 'マーケ・営業支援', '人材・組織支援'] as const;
export const STAGES = ['スタートアップ（シード〜シリーズA）', '成長期（シリーズB以降）', '中小企業', '中堅・大企業', '上場企業', '不明'] as const;
export const CHALLENGES = [
  '売上拡大',
  '新規顧客の開拓',
  '新規事業・新商品',
  '採用強化',
  '人材育成・組織づくり',
  '資金確保',
  'M&A・事業承継',
  '上場準備',
  '海外展開',
  'DX・効率化',
  'ブランド・認知向上',
  '提携・協業',
  'その他',
] as const;

/** 先行事例の4つの切り口 */
export type Facet = 'industry' | 'theme' | 'stage' | 'challenge';
export const FACETS: { key: Facet; label: string }[] = [
  { key: 'industry', label: '業界' },
  { key: 'theme', label: 'テーマ' },
  { key: 'stage', label: '規模・段階' },
  { key: 'challenge', label: '課題・狙い' },
];

export type Filters = Record<Facet, string[]> & { q: string; casesOnly: boolean };
export const emptyFilters = (): Filters => ({ industry: [], theme: [], stage: [], challenge: [], q: '', casesOnly: true });

/** 記事がその切り口で持っている値 */
export function valuesOf(a: KbArticle, f: Facet): string[] {
  const k = a.kb;
  if (!k) return [];
  if (f === 'industry') return k.industry ? [k.industry] : [];
  if (f === 'theme') return a.themes ?? [];
  if (f === 'stage') return k.stage ? [k.stage] : [];
  return k.challenges ?? [];
}

const norm = (s: string) => s.normalize('NFKC').toLowerCase();

/** 言葉で探す（タイトル・会社・事例の見出し・要約・課題・トーク例・メモ・テーマ） */
export function matchesText(a: KbArticle, q: string, extra = ''): boolean {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const k = a.kb;
  const hay = norm(
    [extra, a.title, a.company, a.memo, ...(a.myTags ?? []), ...(a.themes ?? []), k?.caseTitle, k?.caseSummary, k?.challengeNote, k?.industry, ...(k?.talk ?? []), ...(k?.facts ?? []).map((x) => `${x.label} ${x.value}`)]
      .filter(Boolean)
      .join('\n'),
  );
  return words.every((w) => hay.includes(w));
}

/** 切り口の中は「どれか」、切り口どうしは「すべて」 */
export function applyFilters(items: KbArticle[], f: Filters, except?: Facet, names: Record<string, string> = {}): KbArticle[] {
  return items.filter((a) => {
    if (!a.kb) return false;
    if (f.casesOnly && !a.kb.isCase) return false;
    for (const { key } of FACETS) {
      if (key === except || !f[key].length) continue;
      const v = valuesOf(a, key);
      if (!f[key].some((x) => v.includes(x))) return false;
    }
    return matchesText(a, f.q, names[a.companyId]);
  });
}

/** 切り口ごとの件数（ほかの切り口の絞り込みを効かせたうえで数える） */
export function facetCounts(items: KbArticle[], f: Filters, facet: Facet, names: Record<string, string> = {}): { value: string; count: number }[] {
  const m = new Map<string, number>();
  for (const a of applyFilters(items, f, facet, names)) for (const v of valuesOf(a, facet)) m.set(v, (m.get(v) ?? 0) + 1);
  const order = facet === 'stage' ? [...STAGES] : facet === 'challenge' ? [...CHALLENGES] : null;
  return [...m]
    .map(([value, count]) => ({ value, count }))
    .sort((x, y) => (order ? order.indexOf(x.value as never) - order.indexOf(y.value as never) : y.count - x.count || x.value.localeCompare(y.value, 'ja')));
}

/** 業界×テーマの件数表。列は件数の多いテーマから maxCols 個（残りは「その他のテーマ」） */
export function matrix(items: KbArticle[], maxCols = 10) {
  const themeCount = new Map<string, number>();
  for (const a of items) for (const t of a.themes ?? []) themeCount.set(t, (themeCount.get(t) ?? 0) + 1);
  const cols = [...themeCount].sort((x, y) => y[1] - x[1]).slice(0, maxCols).map(([t]) => t);
  const OTHER = 'その他のテーマ';
  const hasOther = themeCount.size > cols.length;
  const rows = new Map<string, Map<string, number>>();
  for (const a of items) {
    const ind = a.kb?.industry || '不明';
    const row = rows.get(ind) ?? new Map<string, number>();
    rows.set(ind, row);
    const ts = new Set((a.themes ?? []).map((t) => (cols.includes(t) ? t : OTHER)));
    for (const t of ts) row.set(t, (row.get(t) ?? 0) + 1);
    row.set('', (row.get('') ?? 0) + 1); // 行の合計（記事の数）
  }
  return {
    cols: hasOther ? [...cols, OTHER] : cols,
    other: OTHER,
    rows: [...rows].map(([industry, m]) => ({ industry, total: m.get('') ?? 0, cells: m })).sort((x, y) => y.total - x.total || x.industry.localeCompare(y.industry, 'ja')),
  };
}

/** ネタ帳：テーマをサービスごとにまとめる（件数の多い順） */
export function themesByService(themes: KbTheme[]): { service: string; themes: KbTheme[] }[] {
  const groups = [...SERVICES, 'その他'].map((service) => ({
    service,
    themes: themes.filter((t) => (t.count ?? 0) > 0 && (SERVICES.includes(t.service as never) ? t.service === service : service === 'その他')),
  }));
  for (const g of groups) g.themes.sort((x, y) => (y.count ?? 0) - (x.count ?? 0) || x.name.localeCompare(y.name, 'ja'));
  return groups.filter((g) => g.themes.length);
}

/** 並べ方：★が多い順 → 配信日の新しい順 */
export const byStarsThenDate = (x: KbArticle, y: KbArticle) => (y.stars ?? 0) - (x.stars ?? 0) || (y.publishedAt ?? '').localeCompare(x.publishedAt ?? '');
