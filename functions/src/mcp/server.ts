import { FieldValue } from 'firebase-admin/firestore';
import {
  authorize,
  authServerMetadata,
  checkBearer,
  continueAuth,
  OAuthError,
  protectedResourceMetadata,
  rateOk,
  register,
  tokenEndpoint,
} from './oauth';
import { callTool, TOOLS, type ToolDeps } from './tools';

/**
 * 窓口（MCP）の入口。Streamable HTTP（状態を持たず、JSON で返す）。
 * 住所は関数の住所（https://kbmcp-…a.run.app）。Hosting を通すと60秒で切れるので直接置く
 */

export const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const SERVER_VERSION = '1.0.0';

export interface Req {
  method: string;
  path: string;
  host: string;
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  /** JSON なら読んだもの、フォームなら項目 */
  body: unknown;
}
export interface Res {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Res => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  body,
});
const oauthError = (e: OAuthError) => json(e.status, { error: e.code, error_description: e.description });

/** 自分の住所（Cloud Run の住所だけを信じる。テストでは localhost） */
export function baseOf(host: string): string | null {
  const h = host.toLowerCase();
  if (/^kbmcp-[a-z0-9-]+\.a\.run\.app$/.test(h)) return `https://${h}`;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h)) return `http://${h}`;
  return null;
}

const INSTRUCTIONS = `Knowledge Base（営業向けに PR TIMES のプレスリリースを整理したもの）を読む道具です。すべて読むだけです。
- 調べものは search_articles（意味で探す）→ get_article（記事の中身・本人のメモ）、会社は find_companies → get_company。
- 事例は list_cases、営業ネタは list_themes → get_theme、毎朝・毎週のまとめは get_report。
- まとまった根拠つきの答えがほしいときだけ ask（時間と費用がかかる）。
答えるときは、根拠にした記事のタイトル・会社・日付・URL を示してください。本人のメモは本人の考えとして扱ってください。`;

async function rpc(deps: ToolDeps, m: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const id = m.id;
  const isRequest = id !== undefined && id !== null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const err = (code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return isRequest ? err(-32600, 'Invalid Request') : null;
  const params = (m.params ?? {}) as Record<string, unknown>;
  switch (m.method) {
    case 'initialize': {
      const asked = String(params.protocolVersion ?? '');
      return ok({
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'knowledge-base', title: 'Knowledge Base', version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return isRequest ? ok({}) : null;
    case 'tools/list':
      return ok({ tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } })) });
    case 'tools/call': {
      const name = String(params.name ?? '');
      const r = await callTool(deps, name, (params.arguments ?? {}) as Record<string, unknown>);
      // 記録は道具の名前と回数だけ（質問の中身は残さない）
      await deps.db
        .collection('kbMeta')
        .doc('mcp')
        .set({ lastUsedAt: new Date().toISOString(), calls: { [name.replace(/[^a-z_]/g, '') || 'unknown']: FieldValue.increment(1) } }, { merge: true })
        .catch(() => {});
      return ok({ content: [{ type: 'text', text: r.text }], isError: r.isError });
    }
    default:
      if (String(m.method).startsWith('notifications/')) return null;
      return isRequest ? err(-32601, `Method not found: ${m.method}`) : null;
  }
}

export async function handle(deps: ToolDeps, req: Req): Promise<Res> {
  const base = baseOf(req.host);
  if (!base) return json(400, { error: 'unknown host' });
  const { db } = deps;
  const p = req.path.replace(/\/+$/, '') || '/';
  try {
    // ---- 見つけてもらうための案内 ----
    if (req.method === 'GET' && (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp')) return json(200, protectedResourceMetadata(base));
    if (req.method === 'GET' && (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration')) return json(200, authServerMetadata(base));

    // ---- ログインと合鍵 ----
    if (p === '/register' && req.method === 'POST') {
      if (!(await rateOk(db))) return json(429, { error: 'too_many_requests' });
      return json(201, await register(db, (req.body ?? {}) as Record<string, unknown>));
    }
    if (p === '/authorize' && req.method === 'GET') {
      return { status: 302, headers: { Location: await authorize(db, base, req.query), 'Cache-Control': 'no-store' } };
    }
    if (p === '/oauth/continue' && req.method === 'GET') {
      const rid = String(req.query.rid ?? '');
      if (!/^[0-9a-f]{32}$/.test(rid)) throw new OAuthError('invalid_request', 'ログインの依頼が見つかりません');
      return { status: 302, headers: { Location: await continueAuth(db, rid, req.query.deny === '1'), 'Cache-Control': 'no-store' } };
    }
    if (p === '/token' && req.method === 'POST') {
      if (!(await rateOk(db))) return json(429, { error: 'too_many_requests' });
      const f = (req.body ?? {}) as Record<string, string | undefined>;
      return json(200, await tokenEndpoint(db, f), { Pragma: 'no-cache' });
    }

    // ---- 窓口 ----
    if (p === '/mcp') {
      // 合鍵がなければ、どの呼び方でも「ログインが要る」と案内する（Claude は最初に GET などで確かめることがある）
      const auth = req.headers.authorization;
      if (!(await checkBearer(db, auth)))
        return json(401, { error: 'unauthorized' }, {
          'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="kb.read"${auth ? ', error="invalid_token"' : ''}`,
        });
      if (req.method !== 'POST') return { status: 405, headers: { Allow: 'POST' } };
      if (!(await rateOk(db))) return json(429, { jsonrpc: '2.0', id: null, error: { code: -32000, message: '使いすぎです。少し待ってください' } });
      const body = req.body;
      const msgs = Array.isArray(body) ? body : [body];
      if (!msgs.length || msgs.some((m) => !m || typeof m !== 'object')) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      const out: Record<string, unknown>[] = [];
      for (const m of msgs) {
        const r = await rpc(deps, m as Record<string, unknown>);
        if (r) out.push(r);
      }
      if (!out.length) return { status: 202 };
      return json(200, Array.isArray(body) ? out : out[0]);
    }
    if (p === '/' && req.method === 'GET') return { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Knowledge Base MCP（本人専用）' };
    return json(404, { error: 'not_found' });
  } catch (e) {
    if (e instanceof OAuthError) return oauthError(e);
    return json(500, { error: 'server_error' });
  }
}
