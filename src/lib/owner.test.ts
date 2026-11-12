import { describe, expect, it } from 'vitest';
import { isOwner, OWNER_EMAIL } from './owner';

describe('isOwner', () => {
  it('本人（メール確認済み）だけ true', () => {
    expect(isOwner({ email: OWNER_EMAIL, emailVerified: true })).toBe(true);
    expect(isOwner({ email: OWNER_EMAIL, emailVerified: false })).toBe(false);
    expect(isOwner({ email: 'someone@example.com', emailVerified: true })).toBe(false);
    expect(isOwner(null)).toBe(false);
  });
});
