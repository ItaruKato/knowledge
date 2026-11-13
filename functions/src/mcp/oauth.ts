import { createHash, randomBytes } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';

/**
 * Claude のチャットから Knowledge Base を読むための窓口（MCP）の、ログインと合鍵（OAuth 2.1）。本人の決定（2026-11-13）：
 * - 窓口はネットから届くが、ログインできるのは本人（i-kato@、メール確認済み）だけ。ログインは Knowledge Base の画面（Google）で行い、
 *   画面が kbJobs（type: mcp_approve）に「許可」を書く（Firestore のルールで本人しか書けない）→ 関数が合鍵を出す
 * - 合鍵の受け取り先は Claude の住所（https://claude.ai/api/mcp/auth_callback）と、Claude Code のパソコンの中（localhost / 127.0.0.1 の /callback）だけ
 * - PKCE（S256）を必ず使う。合鍵は1時間、更新の鍵は30日で、使うたびに作り直す（同じ更新の鍵が2回使われたら、その系統を全部消す）
 * - 鍵そのものは保存せず、ハッシュだけを kbMcpTokens に。コードは5分・1回だけ
 */

export const SCOPE = 'kb.read';
export const ACCESS_TTL = 3600e3;
export const REFRESH_TTL = 30 * 86400e3;
const CODE_TTL = 5 * 60e3;
const REQUEST_TTL = 10 * 60e3;
export const APP_URL = 'https://prtimes-knowledge.web.app';

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;
const b64url = (buf: Buffer) => buf.toString('base64url');

/** PKCE（S256）：code_verifier の SHA-256 を base64url にしたものが code_challenge と同じか */
export function pkceOk(verifier: string | undefined, challenge: string): boolean {
  if (!verifier || verifier.length < 43 || verifier.length > 128 || !/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;
  return b64url(createHash('sha256').update(verifier).digest()) === challenge;
}

/** 合鍵の受け取り先として許す住所（Claude の住所と、Claude Code のパソコンの中の /callback。ポートは問わない） */
export function redirectAllowed(uri: string): boolean {
  if (uri === 'https://claude.ai/api/mcp/auth_callback') return true;
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.pathname === '/callback' && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/** 登録した住所と同じか（パソコンの中の住所はポートを問わない） */
export function redirectMatches(registered: string[], uri: string): boolean {
  if (!redirectAllowed(uri)) return false;
  if (registered.includes(uri)) return true;
  const strip = (s: string) => {
    try {
      const u = new URL(s);
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1' ? `${u.protocol}//${u.hostname}${u.pathname}` : s;
    } catch {
      return s;
    }
  };
  return registered.some((r) => strip(r) === strip(uri));
}

export function protectedResourceMetadata(base: string) {
  return { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'Knowledge Base' };
}

export function authServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  };
}

export class OAuthError extends Error {
  constructor(
    public code: string,
    public description: string,
    public status = 400,
  ) {
    super(description);
  }
}

/** クライアントの登録（Dynamic Client Registration）。受け取り先は決まった住所だけ */
export async function register(db: Firestore, body: Record<string, unknown>) {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 5 || !uris.every(redirectAllowed)) throw new OAuthError('invalid_redirect_uri', 'この住所には合鍵を渡せません');
  const clientId = `kbc_${randomBytes(16).toString('hex')}`;
  const name = String(body.client_name ?? 'Claude').slice(0, 80);
  await db.collection('kbMcpClients').doc(clientId).set({ redirectUris: uris, name, at: new Date().toISOString() });
  return {
    client_id: clientId,
    client_name: name,
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
}

/** ログインの依頼を受け、本人の確認画面（Knowledge Base の画面）へ送る住所を返す */
export async function authorize(db: Firestore, base: string, q: Record<string, string | undefined>): Promise<string> {
  const client = q.client_id ? await db.collection('kbMcpClients').doc(q.client_id).get() : null;
  if (!client?.exists) throw new OAuthError('invalid_client', '登録されていないクライアントです');
  const uri = q.redirect_uri ?? '';
  if (!redirectMatches((client.get('redirectUris') as string[]) ?? [], uri)) throw new OAuthError('invalid_request', '受け取り先の住所が違います');
  if (q.response_type !== 'code') throw new OAuthError('unsupported_response_type', 'code だけ使えます');
  if (q.code_challenge_method !== 'S256' || !q.code_challenge || q.code_challenge.length < 43) throw new OAuthError('invalid_request', 'PKCE（S256）が要ります');
  if (q.resource && q.resource !== `${base}/mcp`) throw new OAuthError('invalid_target', '窓口の住所が違います');
  const rid = randomBytes(16).toString('hex');
  await db.collection('kbMcpRequests').doc(rid).set({
    clientId: q.client_id,
    clientName: client.get('name') ?? 'Claude',
    redirectUri: uri,
    state: q.state ?? null,
    challenge: q.code_challenge,
    scope: SCOPE,
    exp: Date.now() + REQUEST_TTL,
    approved: false,
    at: new Date().toISOString(),
  });
  const back = `${base}/oauth/continue`;
  return `${APP_URL}/mcp-login?rid=${rid}&client=${encodeURIComponent(String(client.get('name') ?? 'Claude'))}&back=${encodeURIComponent(back)}`;
}

/** 画面で本人が「許可」した（kbJobs の mcp_approve。ルールで本人しか書けない） */
export async function approve(db: Firestore, rid: string): Promise<'approved' | 'expired'> {
  const ref = db.collection('kbMcpRequests').doc(rid);
  const s = await ref.get();
  if (!s.exists || Number(s.get('exp')) < Date.now()) return 'expired';
  await ref.update({ approved: true, approvedAt: new Date().toISOString() });
  return 'approved';
}

const withParams = (uri: string, p: Record<string, string | null | undefined>) => {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(p)) if (v) u.searchParams.set(k, v);
  return u.toString();
};

/** 確認画面から戻ってきた：許可されていればコードを付けて Claude へ戻す */
export async function continueAuth(db: Firestore, rid: string, deny: boolean): Promise<string> {
  const ref = db.collection('kbMcpRequests').doc(rid);
  const s = await ref.get();
  if (!s.exists || Number(s.get('exp')) < Date.now()) throw new OAuthError('invalid_request', 'ログインの期限が切れました。Claude からもう一度つないでください');
  const r = s.data()!;
  await ref.delete();
  if (deny || !r.approved) return withParams(r.redirectUri, { error: 'access_denied', state: r.state });
  const code = token('kbcode');
  await db.collection('kbMcpCodes').doc(sha(code)).set({ clientId: r.clientId, redirectUri: r.redirectUri, challenge: r.challenge, scope: r.scope, exp: Date.now() + CODE_TTL });
  return withParams(r.redirectUri, { code, state: r.state });
}

async function issue(db: Firestore, clientId: string, scope: string, family?: string) {
  const access = token('kbat');
  const refresh = token('kbrt');
  const fam = family ?? randomBytes(8).toString('hex');
  const now = Date.now();
  const b = db.batch();
  b.set(db.collection('kbMcpTokens').doc(sha(access)), { kind: 'access', clientId, scope, family: fam, exp: now + ACCESS_TTL, at: new Date(now).toISOString() });
  b.set(db.collection('kbMcpTokens').doc(sha(refresh)), { kind: 'refresh', clientId, scope, family: fam, exp: now + REFRESH_TTL, at: new Date(now).toISOString() });
  await b.commit();
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope };
}

async function revokeFamily(db: Firestore, family: string) {
  const snap = await db.collection('kbMcpTokens').where('family', '==', family).get();
  const b = db.batch();
  for (const d of snap.docs) b.delete(d.ref);
  await b.commit();
}

/** 合鍵を出す（コードと引き換え・更新の鍵と引き換え） */
export async function tokenEndpoint(db: Firestore, f: Record<string, string | undefined>) {
  if (f.grant_type === 'authorization_code') {
    if (!f.code) throw new OAuthError('invalid_request', 'code がありません');
    const ref = db.collection('kbMcpCodes').doc(sha(f.code));
    const c = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (s.exists) tx.delete(ref);
      return s.exists ? s.data()! : null;
    });
    if (!c || Number(c.exp) < Date.now()) throw new OAuthError('invalid_grant', 'コードが無効か、期限切れです');
    if (f.client_id && f.client_id !== c.clientId) throw new OAuthError('invalid_grant', 'クライアントが違います');
    if (f.redirect_uri && f.redirect_uri !== c.redirectUri) throw new OAuthError('invalid_grant', '受け取り先の住所が違います');
    if (!pkceOk(f.code_verifier, c.challenge)) throw new OAuthError('invalid_grant', 'PKCE の確認に失敗しました');
    return issue(db, c.clientId, c.scope);
  }
  if (f.grant_type === 'refresh_token') {
    if (!f.refresh_token) throw new OAuthError('invalid_request', 'refresh_token がありません');
    const ref = db.collection('kbMcpTokens').doc(sha(f.refresh_token));
    const r = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists || s.get('kind') !== 'refresh') return null;
      const d = s.data()!;
      if (d.used) return { ...d, reused: true };
      tx.update(ref, { used: true, usedAt: new Date().toISOString() });
      return d;
    });
    if (!r) throw new OAuthError('invalid_grant', '更新の鍵が無効です');
    // 使い終わった更新の鍵がもう一度使われた：盗まれた可能性があるので、その系統を全部消す
    if ((r as { reused?: boolean }).reused) {
      await revokeFamily(db, r.family);
      throw new OAuthError('invalid_grant', '更新の鍵が無効です');
    }
    if (Number(r.exp) < Date.now()) throw new OAuthError('invalid_grant', '更新の鍵の期限が切れました');
    if (f.client_id && f.client_id !== r.clientId) throw new OAuthError('invalid_grant', 'クライアントが違います');
    return issue(db, r.clientId, r.scope, r.family);
  }
  throw new OAuthError('unsupported_grant_type', 'authorization_code と refresh_token だけ使えます');
}

/** 窓口に来た合鍵を確かめる */
export async function checkBearer(db: Firestore, header: string | undefined): Promise<boolean> {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!m) return false;
  const s = await db.collection('kbMcpTokens').doc(sha(m[1])).get();
  return s.exists && s.get('kind') === 'access' && Number(s.get('exp')) > Date.now();
}

/** 全部の接続を切る（画面のボタン → kbJobs の mcp_revoke）。期限切れの印も片づける */
export async function revokeAll(db: Firestore): Promise<number> {
  let n = 0;
  for (const col of ['kbMcpTokens', 'kbMcpCodes', 'kbMcpRequests']) {
    const snap = await db.collection(col).get();
    for (let i = 0; i < snap.docs.length; i += 400) {
      const b = db.batch();
      for (const d of snap.docs.slice(i, i + 400)) b.delete(d.ref);
      await b.commit();
    }
    n += snap.size;
  }
  return n;
}

/** 期限切れの鍵・コード・依頼を消す（1日1回など） */
export async function cleanupExpired(db: Firestore): Promise<number> {
  let n = 0;
  // kbMeta は回数の上限の印（mcp_rate_…。exp があるものだけ）
  for (const col of ['kbMcpTokens', 'kbMcpCodes', 'kbMcpRequests', 'kbMeta']) {
    const snap = await db.collection(col).where('exp', '<', Date.now()).limit(400).get();
    if (snap.empty) continue;
    const b = db.batch();
    for (const d of snap.docs) b.delete(d.ref);
    await b.commit();
    n += snap.size;
  }
  return n;
}

/** 回数の上限（窓口全体で1分に120回まで） */
export async function rateOk(db: Firestore, limitPerMin = 120): Promise<boolean> {
  const key = `mcp_rate_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  const ref = db.collection('kbMeta').doc(key);
  const n = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const v = Number(s.get('n') ?? 0) + 1;
    tx.set(ref, { n: v, exp: Date.now() + 120e3 });
    return v;
  });
  return n <= limitPerMin;
}

export { FieldValue };
