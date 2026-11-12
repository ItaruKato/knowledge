/**
 * Firestore エミュレーターでの結合テスト（エミュレーターがないときは飛ばす）。
 * 実行: functions で npm run test:emulator
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type Anthropic from '@anthropic-ai/sdk';
import { ingestSweep } from '../src/ingest';
import { runJob } from '../src/jobs';
import type { CompanyAi } from '../src/company';
import type { AnalysisOut } from '../src/analyze';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'prtimes-inbox';
let db: Firestore;

const ID = '000000001.000012345';
const URL = `https://prtimes.jp/main/html/rd/p/${ID}.html`;
const PAGE = '<div id="press-release-body"><p>本文です。シリーズAで5億円を調達。</p></div>';

function out(themes: string[]): AnalysisOut {
  return {
    industry: 'SaaS',
    themes: themes.map((name) => ({ name, service: '資金調達・M&A支援', description: '説明' })),
    stage: 'スタートアップ（シード〜シリーズA）',
    stageReason: 'シリーズA',
    challenges: ['資金確保'],
    challengeNote: '採用と開発',
    isCase: true,
    caseTitle: '見出し',
    caseSummary: '要約',
    facts: [{ label: '調達額', value: '5億円' }],
    talk: ['トーク'],
  };
}

/** 決まった答えを返す Claude の代わり。受け取った内容を記録する */
function fakeClient(answers: (AnalysisOut | Error)[], seen: string[] = []) {
  return () =>
    ({
      beta: {
        messages: {
          parse: async (req: { messages: { content: string }[] }) => {
            seen.push(req.messages[0].content);
            const a = answers.shift();
            if (!a) throw new Error('no more answers');
            if (a instanceof Error) throw a;
            return { parsed_output: a, stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 200 } };
          },
        },
      },
    }) as unknown as Anthropic;
}

async function putHandoff(patch: Record<string, unknown> = {}, status = 'done') {
  await db.doc(`saved/${ID}`).set({ decision: { status, at: '2026-11-12T00:00:00Z' } });
  await db.doc(`handoff/${ID}`).set({
    v: 1,
    id: ID,
    article: { id: ID, url: URL, title: 'テスト社がシリーズAで調達', company: 'テスト株式会社', publishedAt: '2026-11-10T10:00:00+09:00', lead: '冒頭' },
    readAt: Timestamp.fromMillis(Date.UTC(2026, 10, 12)),
    memo: 'メモ',
    myTags: [],
    stars: 1,
    draft: null,
    updatedAt: new Date().toISOString(),
    ...patch,
  });
}

describe.skipIf(!HOST)('Firestore エミュレーター', () => {
  beforeAll(() => {
    if (!getApps().length) initializeApp({ projectId: PROJECT });
    db = getFirestore();
  });
  beforeEach(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  });

  it('読了の記事を取り込み、本文・台帳の情報・テーマを使って整理する', async () => {
    await db.doc('companies/12345').set({ name: 'テスト株式会社', profile: { listed: '未上場' }, gbiz: { employees: 30 } });
    await putHandoff();
    const seen: string[] = [];
    const r = await ingestSweep({ db, client: fakeClient([out(['シリーズAの大型調達'])], seen), get: async () => PAGE });
    expect(r).toMatchObject({ analyzed: 1, total: 1 });
    expect(seen[0]).toContain('本文です。');
    expect(seen[0]).toContain('従業員数: 30人');
    const a = (await db.doc(`kbArticles/${ID}`).get()).data()!;
    expect(a).toMatchObject({ state: 'done', bodyFrom: 'page', themes: ['シリーズAの大型調達'], companyId: '12345', memo: 'メモ' });
    expect(a.body).toBeUndefined();
    expect(a.readAt).toBe('2026-11-12T00:00:00.000Z');
    expect((await db.doc(`kbBodies/${ID}`).get()).data()).toMatchObject({ body: '本文です。シリーズAで5億円を調達。', from: 'page' });
    expect((await db.doc('kbThemes/シリーズAの大型調達').get()).data()).toMatchObject({ count: 1, by: 'ai' });
    // HP をまだ読んでいない会社は、台帳の HP 読み込みに依頼する
    expect((await db.doc('webQueue/12345').get()).get('by')).toBe('knowledge');
    expect((await db.collection('kbMeta').get()).docs.map((d) => d.id).some((k) => k.startsWith('usage_'))).toBe(true);

    // ★だけ変えた → 整理し直さずに写すだけ
    await putHandoff({ stars: 3 });
    const r2 = await ingestSweep({ db, client: fakeClient([]), get: async () => PAGE });
    expect(r2).toMatchObject({ synced: 1, analyzed: 0 });
    expect((await db.doc(`kbArticles/${ID}`).get()).get('stars')).toBe(3);

    // メモを変えた → 整理し直す。テーマが変わったら件数を直す
    await putHandoff({ memo: '別のメモ' });
    const r3 = await ingestSweep({ db, client: fakeClient([out(['地方企業のDX投資'])]), get: async () => PAGE });
    expect(r3).toMatchObject({ analyzed: 1 });
    expect((await db.doc('kbThemes/シリーズAの大型調達').get()).get('count')).toBe(0);
    expect((await db.doc('kbThemes/地方企業のDX投資').get()).get('count')).toBe(1);
  });

  it('読了を取り消した記事は外す', async () => {
    await putHandoff();
    await ingestSweep({ db, client: fakeClient([out(['テーマ'])]), get: async () => PAGE });
    await putHandoff({}, 'keep');
    const r = await ingestSweep({ db, client: fakeClient([]), get: async () => PAGE });
    expect(r).toMatchObject({ removed: 1, total: 0 });
    expect((await db.doc('kbThemes/テーマ').get()).get('count')).toBe(0);
  });

  it('AI が失敗したら、次の回にやり直す（3回まで）', async () => {
    await putHandoff();
    const r = await ingestSweep({ db, client: fakeClient([new Error('overloaded')]), get: async () => { throw new Error('down'); } });
    expect(r).toMatchObject({ failed: 1 });
    expect((await db.doc(`kbArticles/${ID}`).get()).data()).toMatchObject({ state: 'failed', tries: 1, bodyFrom: 'lead' });
    const r2 = await ingestSweep({ db, client: fakeClient([out(['テーマ'])]), get: async () => PAGE });
    expect(r2).toMatchObject({ analyzed: 1 });
    expect((await db.doc(`kbArticles/${ID}`).get()).data()).toMatchObject({ state: 'done', bodyFrom: 'page' });
  });

  it('本文を kbArticles に入れていた記事は、kbBodies へ移す', async () => {
    await putHandoff();
    await db.doc(`kbArticles/${ID}`).set({ id: ID, body: '古い本文', bodyFrom: 'page', state: 'done', inputHash: 'x' });
    await ingestSweep({ db, client: fakeClient([out(['テーマ'])]), get: async () => PAGE });
    expect((await db.doc(`kbArticles/${ID}`).get()).get('body')).toBeUndefined();
    expect((await db.doc(`kbBodies/${ID}`).get()).get('body')).toBe('古い本文');
  });

  it('記事を整理したら会社のまとめの依頼を足し、依頼を1回だけ処理する。材料が同じならまとめ直さない', async () => {
    await db.doc('companies/12345').set({ name: 'テスト株式会社' });
    await db.doc('companyArticles/12345').set({ name: 'テスト株式会社', a: { [ID]: { t: 'シリーズAで調達', p: '2026-11-10T10:00:00+09:00' } } });
    await putHandoff();
    await ingestSweep({ db, client: fakeClient([out(['テーマ'])]), get: async () => PAGE });
    const jobs = await db.collection('kbJobs').get();
    expect(jobs.docs.map((d) => d.data())).toMatchObject([{ type: 'company', id: '12345', state: 'ready' }]);

    const ai: CompanyAi = {
      summary: '要約',
      recent: ['2026-11 調達'],
      events: [{ date: '2026-11-10', type: '資金調達', title: 'シリーズA', amount: '5億円', counterpart: '', articleId: ID }],
      angles: ['切り口'],
      fits: [],
    };
    const seen: string[] = [];
    const client = fakeClient([ai as unknown as AnalysisOut], seen);
    const ref = jobs.docs[0].ref;
    const [r1, r2] = await Promise.all([runJob({ db, client }, ref), runJob({ db, client }, ref)]);
    expect([r1, r2].sort()).toEqual(['made', 'skipped']);
    expect(seen[0]).toContain(`${ID}｜2026-11-10｜シリーズAで調達`);
    expect((await db.doc('kbCompanies/12345').get()).data()).toMatchObject({ state: 'done', name: 'テスト株式会社', ai: { events: [{ articleId: ID }] } });
    expect((await ref.get()).get('state')).toBe('done');

    const again = await db.collection('kbJobs').add({ type: 'company', id: '12345', state: 'ready' });
    expect(await runJob({ db, client: fakeClient([]) }, again)).toBe('same');
    const bad = await db.collection('kbJobs').add({ type: 'company', id: '../x', state: 'ready' });
    expect(await runJob({ db, client: fakeClient([]) }, bad)).toBe('failed');
  });

  it('前から読んでいた会社の HP の読み込みを一度だけ依頼する（読んだ会社は依頼しない）', async () => {
    await db.doc('companies/1').set({ name: 'A社' });
    await db.doc('companies/2').set({ name: 'B社', webAt: '2026-11-01T00:00:00Z' });
    await db.doc('kbArticles/1.1').set({ companyId: '1', state: 'done' });
    await db.doc('kbArticles/2.2').set({ companyId: '2', state: 'done' });
    await ingestSweep({ db, client: fakeClient([]), get: async () => PAGE });
    expect((await db.doc('webQueue/1').get()).exists).toBe(true);
    expect((await db.doc('webQueue/2').get()).exists).toBe(false);
    await db.doc('webQueue/1').delete();
    await ingestSweep({ db, client: fakeClient([]), get: async () => PAGE });
    expect((await db.doc('webQueue/1').get()).exists).toBe(false);
  });

  it('同時に2回動いても1回分だけ', async () => {
    await putHandoff();
    const slow = async () => {
      await new Promise((res) => setTimeout(res, 3000));
      return PAGE;
    };
    const [a, b] = await Promise.all([
      ingestSweep({ db, client: fakeClient([out(['テーマ'])]), get: slow }),
      ingestSweep({ db, client: fakeClient([out(['テーマ'])]), get: slow }),
    ]);
    expect([a, b].filter((x) => 'skipped' in x && x.skipped)).toHaveLength(1);
  }, 20_000);
});
