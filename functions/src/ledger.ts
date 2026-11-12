/** 台帳（prtimes-inbox の companies）を読むときの助け。台帳は読むだけ */

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
    (c.gbizInsured as { total?: number } | undefined)?.total !== undefined && `厚生年金の被保険者数: ${(c.gbizInsured as { total: number }).total}人`,
    (c.gbizFinance as { sales?: { raw?: string; unit?: string } } | undefined)?.sales?.raw &&
      `売上高（有価証券報告書）: ${(c.gbizFinance as { sales: { raw: string; unit?: string } }).sales.raw}${(c.gbizFinance as { sales: { unit?: string } }).sales.unit ?? ''}`,
    g.summary && `事業概要: ${String(g.summary).slice(0, 200)}`,
    ...webLines(c.web as WebInfo | undefined),
  ].filter(Boolean);
  return parts.join('、');
}


/** 台帳の companies.web（会社 HP から拾った項目。prtimes-inbox の functions/src/web.ts） */
export interface WebItem {
  value: string;
  asOf: string;
  source: string;
}
export interface WebInfo {
  state?: 'done' | 'nosite' | 'blocked' | 'failed';
  url?: string;
  officialName?: WebItem | null;
  address?: WebItem | null;
  employees?: WebItem | null;
  capital?: WebItem | null;
  sales?: WebItem | null;
}

function webLines(w: WebInfo | undefined): string[] {
  if (!w || w.state !== 'done') return [];
  const one = (label: string, i?: WebItem | null) => (i?.value ? `${label}（HP）: ${i.value}${i.asOf ? `（${i.asOf}）` : ''}` : '');
  return [one('正式名', w.officialName), one('従業員数', w.employees), one('資本金', w.capital), one('売上高', w.sales)].filter(Boolean);
}
