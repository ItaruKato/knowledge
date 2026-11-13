/**
 * 窓口（MCP）のログインと道具の結合テスト（Firestore エミュレーター。ないときは飛ばす）
 */
import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore';
import type Anthropic from '@anthropic-ai/sdk';
import { handle, type Req } from '../src/mcp/server';
import { approve, revokeAll } from '../src/mcp/oauth';
import type { Embed } from '../src/vertex';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'prtimes-inbox';
const ME = 'kbmcp-test-an.a.run.app';
let db: Firestore;
const embed: Embed = async (texts) => texts.map(() => [1, ...new Array(767).fill(0.01)]);
const client = () => ({}) as Anthropic;
const call = (r: Partial<Req>) => handle({ db, client, embed }, { method: 'GET', path: '/', host: ME, headers: {}, query: {}, body: undefined, ...r });

describe.skipIf(!HOST)('Claude の窓口（エミュレーター）', () => {
  beforeAll(() => {
    if (!getApps().length) initializeApp({ projectId: PROJECT });
    db = getFirestore();
  });
  beforeEach(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  });

  it('ログイン（本人の許可）→ 合鍵 → 道具 → 更新 → 使い回しの検知 → 全部切る', async () => {
    // 合鍵なしでは 401 と案内
    const r0 = await call({ method: 'POST', path: '/mcp', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(r0.status).toBe(401);
    expect(r0.headers?.['WWW-Authenticate']).toContain(`resource_metadata="https://${ME}/.well-known/oauth-protected-resource"`);
    expect((await call({ path: '/.well-known/oauth-protected-resource' })).body).toMatchObject({ resource: `https://${ME}/mcp`, authorization_servers: [`https://${ME}`] });
    expect((await call({ path: '/.well-known/oauth-authorization-server' })).body).toMatchObject({ code_challenge_methods_supported: ['S256'] });

    // 変な受け取り先は登録できない
    expect((await call({ method: 'POST', path: '/register', body: { redirect_uris: ['https://evil.example/cb'] } })).status).toBe(400);
    const reg = await call({ method: 'POST', path: '/register', body: { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' } });
    const clientId = (reg.body as { client_id: string }).client_id;

    const verifier = 'v'.repeat(60);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const auth = await call({
      path: '/authorize',
      query: { response_type: 'code', client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', state: 'st', code_challenge: challenge, code_challenge_method: 'S256', resource: `https://${ME}/mcp` },
    });
    expect(auth.status).toBe(302);
    const login = new URL(auth.headers!.Location);
    expect(login.origin + login.pathname).toBe('https://prtimes-knowledge.web.app/mcp-login');
    const rid = login.searchParams.get('rid')!;

    // 許可の前に戻ってきたら、合鍵は出さない
    const denied = await call({ path: '/oauth/continue', query: { rid } });
    expect(new URL(denied.headers!.Location).searchParams.get('error')).toBe('access_denied');

    // もう一度：本人が許可（画面 → kbJobs の mcp_approve）してから戻る
    const auth2 = await call({ path: '/authorize', query: { response_type: 'code', client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', state: 'st2', code_challenge: challenge, code_challenge_method: 'S256' } });
    const rid2 = new URL(auth2.headers!.Location).searchParams.get('rid')!;
    expect(await approve(db, rid2)).toBe('approved');
    const back = new URL((await call({ path: '/oauth/continue', query: { rid: rid2 } })).headers!.Location);
    expect(back.origin + back.pathname).toBe('https://claude.ai/api/mcp/auth_callback');
    expect(back.searchParams.get('state')).toBe('st2');
    const code = back.searchParams.get('code')!;

    // PKCE が違うと合鍵は出ない。コードは1回だけ
    expect((await call({ method: 'POST', path: '/token', body: { grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(60), client_id: clientId } })).status).toBe(400);
    const auth3 = await call({ path: '/authorize', query: { response_type: 'code', client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, code_challenge_method: 'S256' } });
    const rid3 = new URL(auth3.headers!.Location).searchParams.get('rid')!;
    await approve(db, rid3);
    const code3 = new URL((await call({ path: '/oauth/continue', query: { rid: rid3 } })).headers!.Location).searchParams.get('code')!;
    const tok = await call({ method: 'POST', path: '/token', body: { grant_type: 'authorization_code', code: code3, code_verifier: verifier, client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' } });
    expect(tok.status).toBe(200);
    const { access_token, refresh_token } = tok.body as { access_token: string; refresh_token: string };
    expect((await call({ method: 'POST', path: '/token', body: { grant_type: 'authorization_code', code: code3, code_verifier: verifier } })).status).toBe(400);

    // 道具
    const H = { authorization: `Bearer ${access_token}` };
    const init = await call({ method: 'POST', path: '/mcp', headers: H, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } } });
    expect(init.body).toMatchObject({ result: { protocolVersion: '2025-06-18', serverInfo: { name: 'knowledge-base' } } });
    expect((await call({ method: 'POST', path: '/mcp', headers: H, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status).toBe(202);
    const list = await call({ method: 'POST', path: '/mcp', headers: H, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    expect((list.body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)).toContain('search_articles');
    await db.doc('kbIndex/1.100').set({ id: '1.100', title: 'シリーズAで調達', company: 'A社', companyId: '100', url: '', publishedAt: '2026-11-01T10:00:00+09:00', state: 'done', emb: FieldValue.vector([1, ...new Array(767).fill(0.01)]) });
    await db.doc('kbArticles/1.100').set({ state: 'done', source: 'handoff', memo: '次回提案', companyId: '100', publishedAt: '2026-11-01T10:00:00+09:00', title: 'シリーズAで調達', kb: { caseTitle: '事例', talk: ['トーク'] } });
    await db.doc('longlist/100').set({ temperature: 'A', progress: '商談' });
    await db.doc('companies/100').set({ name: 'A社' });
    const s = await call({ method: 'POST', path: '/mcp', headers: H, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_articles', arguments: { query: '調達' } } } });
    expect(JSON.stringify(s.body)).toContain('[1.100]');
    const a = await call({ method: 'POST', path: '/mcp', headers: H, body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_article', arguments: { id: '1.100' } } } });
    expect(JSON.stringify(a.body)).toContain('本人のメモ: 次回提案');
    const c = await call({ method: 'POST', path: '/mcp', headers: H, body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_company', arguments: { company_id: '100' } } } });
    expect(JSON.stringify(c.body)).toContain('温度感 A｜進捗 商談');
    const bad = await call({ method: 'POST', path: '/mcp', headers: H, body: { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_article', arguments: { id: '../x' } } } });
    expect(bad.body).toMatchObject({ result: { isError: true } });

    // 更新：新しい合鍵。古い更新の鍵をもう一度使うと、その系統は全部消える
    const ref1 = await call({ method: 'POST', path: '/token', body: { grant_type: 'refresh_token', refresh_token, client_id: clientId } });
    expect(ref1.status).toBe(200);
    const newAccess = (ref1.body as { access_token: string }).access_token;
    expect((await call({ method: 'POST', path: '/token', body: { grant_type: 'refresh_token', refresh_token } })).status).toBe(400);
    expect((await call({ method: 'POST', path: '/mcp', headers: { authorization: `Bearer ${newAccess}` }, body: { jsonrpc: '2.0', id: 7, method: 'ping' } })).status).toBe(401);

    // 全部切る
    await revokeAll(db);
    expect((await call({ method: 'POST', path: '/mcp', headers: H, body: { jsonrpc: '2.0', id: 8, method: 'ping' } })).status).toBe(401);
    // 自分の住所でない名前で来たら答えない
    expect((await handle({ db, client, embed }, { method: 'GET', path: '/.well-known/oauth-protected-resource', host: 'evil.example', headers: {}, query: {}, body: undefined })).status).toBe(400);
  });
});
