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
  ].filter(Boolean);
  return parts.join('、');
}

