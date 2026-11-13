import { describe, expect, it } from 'vitest';
import { safeBack } from './mcp';

describe('窓口のログインの戻り先', () => {
  it('窓口の住所の /oauth/continue だけ', () => {
    expect(safeBack('https://kbmcp-abc-an.a.run.app/oauth/continue')).toBe('https://kbmcp-abc-an.a.run.app/oauth/continue');
    for (const bad of ['https://evil.example/oauth/continue', 'http://kbmcp-abc-an.a.run.app/oauth/continue', 'https://kbmcp-abc-an.a.run.app/other', 'https://kbmcp-abc-an.a.run.app/oauth/continue?x=1', 'javascript:alert(1)', null])
      expect(safeBack(bad)).toBeNull();
  });
});
