/** Claude のチャットの窓口（MCP）の住所（Knowledge Base の関数 kbMcp の Cloud Run の住所 + /mcp） */
export const MCP_URL = 'https://kbmcp-fzjfxl5xca-an.a.run.app/mcp';

/** 戻り先は窓口の住所（https://kbmcp-…a.run.app/oauth/continue）だけ。ほかの住所へは飛ばさない */
export function safeBack(back: string | null): string | null {
  if (!back) return null;
  try {
    const u = new URL(back);
    return u.protocol === 'https:' && /^kbmcp-[a-z0-9-]+\.a\.run\.app$/.test(u.hostname) && u.pathname === '/oauth/continue' && !u.search ? u.toString() : null;
  } catch {
    return null;
  }
}

