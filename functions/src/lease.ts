import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * 同じ処理が重なって動かないようにする（スケジューラーは同じ回を2度起動することがある）。
 * kbMeta/lock_{name} に期限つきの印を付け、期限内なら後から来た方は何もしない。
 * Watcher の locks とは別の場所（Knowledge Base は kb で始まるコレクションにだけ書く）。
 */
export async function withLease<T>(
  db: Firestore,
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const ref = db.collection('kbMeta').doc(`lock_${name}`);
  const token = randomUUID();
  const ok = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const until = s.get('until') as number | undefined;
    if (s.exists && typeof until === 'number' && until > Date.now()) return false;
    tx.set(ref, { token, until: Date.now() + ttlMs, startedAt: new Date().toISOString() });
    return true;
  });
  if (!ok) return { ran: false };
  try {
    return { ran: true, value: await fn() };
  } finally {
    await db
      .runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (s.get('token') === token) tx.delete(ref);
      })
      .catch(() => {});
  }
}
