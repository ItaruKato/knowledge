/**
 * Firestore エミュレーターでの結合テスト（エミュレーターがないときは飛ばす）。
 * 実行: functions で npm run test:emulator
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type Anthropic from '@anthropic-ai/sdk';
import { ingestSweep } from '../src/ingest';
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
    readAt: '2026-11-12T00:00:00Z',
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
    expect((await db.doc('kbThemes/シリーズAの大型調達').get()).data()).toMatchObject({ count: 1, by: 'ai' });
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
