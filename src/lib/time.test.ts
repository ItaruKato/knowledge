import { describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase/firestore';
import { toIso } from './time';

describe('toIso', () => {
  it('Timestamp・文字・Date・空を ISO の文字に', () => {
    expect(toIso(Timestamp.fromMillis(Date.UTC(2026, 10, 12)))).toBe('2026-11-12T00:00:00.000Z');
    expect(toIso('2026-11-12T00:00:00Z')).toBe('2026-11-12T00:00:00Z');
    expect(toIso(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-01-01T00:00:00.000Z');
    expect(toIso({ seconds: 0 })).toBe('1970-01-01T00:00:00.000Z');
    expect(toIso(null)).toBe(null);
  });
});
