import { describe, expect, it } from 'vitest';
import { yen } from './money';

describe('yen', () => {
  it('億・万で読みやすく', () => {
    expect(yen(1_234_000_000)).toBe('12億3,400万円');
    expect(yen(500_000_000)).toBe('5億円');
    expect(yen(30_000_000)).toBe('3,000万円');
    expect(yen(undefined)).toBe('');
  });
});
