import { FieldValue, type Firestore } from 'firebase-admin/firestore';

export interface Usage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 1M トークンあたりのドル（https://platform.claude.com/docs/en/about-claude/pricing、2026-11 時点） */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  // 拒否されたときの代わりのモデル（Opus 相当で数える）
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

export function usageOf(
  model: string,
  u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null },
): Usage {
  return { model, input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
}

/** ドルでの見積もり（知らないモデルは Opus 5.5 の値段で数える） */
export function costUsd(u: Usage): number {
  const p = PRICES[u.model] ?? PRICES['claude-opus-5-5'];
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6;
}

/** JST の YYYYMMDD */
export const jstDay = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');

/** 使った量を kbMeta/usage_{YYYYMMDD} に足す（ウィークリーで報告する） */
export async function addUsage(db: Firestore, u: Usage, purpose: string): Promise<void> {
  const key = u.model.replace(/[^a-z0-9-]/gi, '_');
  await db
    .collection('kbMeta')
    .doc(`usage_${jstDay()}`)
    .set(
      {
        [key]: {
          input: FieldValue.increment(u.input),
          output: FieldValue.increment(u.output),
          cacheRead: FieldValue.increment(u.cacheRead),
          cacheWrite: FieldValue.increment(u.cacheWrite),
          requests: FieldValue.increment(1),
        },
        usd: FieldValue.increment(costUsd(u)),
        by: { [purpose]: FieldValue.increment(1) },
      },
      { merge: true },
    );
}
