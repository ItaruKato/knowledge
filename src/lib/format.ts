export const fmtTime = (s?: string | null) =>
  s ? new Date(s).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
export const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' }) : '');
export const n = (x: number) => x.toLocaleString('ja-JP');
