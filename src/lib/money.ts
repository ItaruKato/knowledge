/** 円の金額を「12億3,400万円」のように */
export function yen(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '';
  if (v >= 1e8) {
    const oku = Math.floor(v / 1e8);
    const man = Math.round((v % 1e8) / 1e4);
    return `${oku.toLocaleString('ja-JP')}億${man ? `${man.toLocaleString('ja-JP')}万` : ''}円`;
  }
  if (v >= 1e4) return `${Math.round(v / 1e4).toLocaleString('ja-JP')}万円`;
  return `${v.toLocaleString('ja-JP')}円`;
}

export const articleUrl = (id: string) => `https://prtimes.jp/main/html/rd/p/${id}.html`;
export const companyPrtimesUrl = (cid: string) => `https://prtimes.jp/main/html/searchrlp/company_id/${cid}`;
