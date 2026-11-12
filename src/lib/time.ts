/** Firestore の日時（Timestamp）・文字・Date のどれでも ISO の文字にする。読めなければ null */
export function toIso(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as { toDate?: () => Date; seconds?: number; _seconds?: number };
    if (typeof o.toDate === 'function') return o.toDate().toISOString();
    const sec = o.seconds ?? o._seconds;
    if (typeof sec === 'number') return new Date(sec * 1000).toISOString();
  }
  return null;
}
