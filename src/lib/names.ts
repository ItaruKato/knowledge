/**
 * 画面に出す会社名。正式な会社名（「株式会社」などの法人格を含む）が分かれば、PR TIMES の会社名の代わりに使う。
 * 1. 会社 HP から拾った正式名（companies.web.officialName。法人格を含み、PR TIMES の会社名と同じ会社と分かるときだけ）
 * 2. gBizINFO の正式名（companies.gbiz.name。法人番号で結びついた会社）
 * 3. なければ PR TIMES の会社名のまま
 * 台帳の name は書き換えない（台帳は読むだけ。Long List も同じ考え方で表示できる）
 */
const LEGAL = /株式会社|有限会社|合同会社|合名会社|合資会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|特定非営利活動法人|学校法人|医療法人|社会福祉法人|協同組合/;
const LEGAL_ALL = new RegExp(LEGAL.source + '|npo法人|\\(株\\)|\\(有\\)', 'gi');

/** 比べるための名前（全角・半角、空白、記号、法人格をそろえる） */
export function coreName(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(LEGAL_ALL, '')
    .replace(/[\s・･.,，、。'’"”\-‐―]/g, '')
    .toLowerCase();
}

interface CompanyLike {
  name?: string;
  gbiz?: { name?: string };
  web?: { state?: string; officialName?: { value?: string } | null };
}

export function officialName(prName: string, c: CompanyLike | undefined): string | null {
  if (!c) return null;
  const core = coreName(prName || c.name || '');
  const same = (n: string) => {
    const x = coreName(n);
    return core.length >= 2 && x.length >= 2 && (x.includes(core) || core.includes(x));
  };
  const web = c.web?.state === 'done' ? c.web.officialName?.value?.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
  if (web && LEGAL.test(web) && same(web)) return web.replace(/[（(][^）)]*[）)]$/, '').trim();
  const g = c.gbiz?.name?.trim();
  if (g && LEGAL.test(g)) return g;
  return null;
}
