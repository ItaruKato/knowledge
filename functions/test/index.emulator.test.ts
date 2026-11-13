/**
 * 全記事の目録と検索の結合テスト（Firestore エミュレーター。ないときは飛ばす）。npm run test:emulator で動く
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type Anthropic from '@anthropic-ai/sdk';
import { indexSweep } from '../src/allindex';
import { searchIndex } from '../src/search';
import type { Embed } from '../src/vertex';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'prtimes-inbox';
let db: Firestore;

/** 言葉ごとに決まった数値を返す代わり（「調達」を含むものどうしが近くなる） */
const embed: Embed = async (texts) =>
  texts.map((t) => {
    const v = new Array(768).fill(0);
    v[0] = t.includes('調達') ? 1 : 0.01;
    v[1] = t.includes('物流') ? 1 : 0.01;
    v[2] = 0.05;
    return v;
  });

/** まとめて処理する仕組みの代わり。出された頼みを覚え、次の回に「終わった」として決まった答えを返す */
function fakeBatches(answer: (ids: string[]) => { id: string; type: string; industry: string; isCase: boolean }[]) {
  const store = new Map<string, { custom_id: string; ids: string[] }[]>();
  let n = 0;
  return () =>
    ({
      messages: {
        batches: {
          create: async (body: { requests: { custom_id: string; params: { messages: { content: string }[] } }[] }) => {
            const id = `msgbatch_${++n}`;
            store.set(
              id,
              body.requests.map((r) => ({ custom_id: r.custom_id, ids: r.params.messages[0].content.split('\n').map((l) => l.split('｜')[0]) })),
            );
            return { id };
          },
          retrieve: async () => ({ processing_status: 'ended' }),
          results: async (id: string) =>
            (async function* () {
              for (const r of store.get(id) ?? [])
                yield {
                  custom_id: r.custom_id,
                  result: {
                    type: 'succeeded',
                    message: { model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'text', text: JSON.stringify({ items: answer(r.ids) }) }] },
                  },
                };
            })(),
        },
      },
    }) as unknown as Anthropic;
}

describe.skipIf(!HOST)('全記事の目録と検索（エミュレーター）', () => {
  beforeAll(() => {
    if (!getApps().length) initializeApp({ projectId: PROJECT });
    db = getFirestore();
  });
  beforeEach(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  });

  it('buckets を読み、セミナーは外し、数値にして、まとめて分類する（台帳の業界タグがあればそれを使う）', async () => {
    const item = (id: string, title: string) => ({ id, url: `https://prtimes.jp/main/html/rd/p/${id}.html`, title, company: '会社', publishedAt: '2026-11-10T10:00:00+09:00', lead: '冒頭' });
    await db.doc('buckets/2026111010').set({
      items: {
        '1.100': item('1.100', 'シリーズAで5億円を資金調達'),
        '2.200': item('2.200', '物流倉庫の新サービスを提供開始'),
        '3.300': item('3.300', '【無料ウェビナー】営業の基本'),
        '4.400': item('4.400', '春の新生活キャンペーン実施中！'),
      },
    });
    await db.doc('buckets/2026083110').set({ items: { '9.900': item('9.900', '9月より前の記事') } });
    await db.doc('meta/industryTags').set({ tags: [{ code: 'saas', label: 'SaaS・業務ソフト' }] });
    await db.doc('companies/100').set({ industryTags: { main: 'saas' } });
    const client = fakeBatches((ids) =>
      ids.map((id) => ({ id, type: id === '2.200' ? '新規事業・新商品・新サービス' : '資金調達', industry: '物流', isCase: true })),
    );
    const now = () => Date.UTC(2026, 10, 12);
    const r1 = await indexSweep({ db, client, embed, now });
    expect(r1).toMatchObject({ added: 2, ruleExcluded: 2, embedded: 2, submitted: 2, pending: 1 });
    expect((await db.doc('kbIndex/9.900').get()).exists).toBe(false);
    expect((await db.doc('kbIndex/3.300').get()).data()).toMatchObject({ state: 'excluded', excludedBy: 'rule' });

    const r2 = await indexSweep({ db, client, embed, now });
    expect(r2).toMatchObject({ applied: 2, pending: 0 });
    expect((await db.doc('kbIndex/1.100').get()).data()).toMatchObject({ state: 'done', type: '資金調達', industry: 'SaaS・業務ソフト', industryFrom: 'ledger', isCase: true });
    expect((await db.doc('kbIndex/2.200').get()).data()).toMatchObject({ industry: '物流', industryFrom: 'ai' });
    expect((await db.doc('kbMeta/index').get()).get('stats')).toMatchObject({ total: 4, done: 2, excluded: 2 });

    // 意味で探す：「調達」に近い記事が先に出る。種類で絞れる
    const hits = await searchIndex(db, embed, '資金調達の事例', {});
    expect(hits[0]).toMatchObject({ id: '1.100', read: false, analyzed: false });
    expect(hits.map((h) => h.id)).not.toContain('3.300');
    expect((await searchIndex(db, embed, '資金調達', { types: ['新規事業・新商品・新サービス'] })).map((h) => h.id)).toEqual(['2.200']);
  });
});

import { askQuestion } from '../src/ask';

describe.skipIf(!HOST)('アプリ内の質問（エミュレーター）', () => {
  beforeEach(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  });

  it('近い記事と読んだ記事のメモ・本文を根拠に、番号つきで答える', async () => {
    const { FieldValue } = await import('firebase-admin/firestore');
    const [v1] = await embed(['資金調達'], 'RETRIEVAL_DOCUMENT');
    const [v2] = await embed(['物流'], 'RETRIEVAL_DOCUMENT');
    await db.doc('kbIndex/1.100').set({ id: '1.100', title: 'シリーズAで資金調達', company: 'A社', companyId: '100', url: '', publishedAt: '2026-11-01T10:00:00+09:00', lead: '冒頭', state: 'done', emb: FieldValue.vector(v1) });
    await db.doc('kbIndex/2.200').set({ id: '2.200', title: '物流の新サービス', company: 'B社', companyId: '200', url: '', publishedAt: '2026-11-02T10:00:00+09:00', state: 'done', emb: FieldValue.vector(v2) });
    await db.doc('kbIndex/3.300').set({ id: '3.300', title: 'セミナー', state: 'excluded', emb: FieldValue.vector(v1) });
    await db.doc('kbArticles/1.100').set({ state: 'done', source: 'handoff', memo: '次回提案', kb: { caseSummary: '5億円を調達', facts: [{ label: '調達額', value: '5億円' }], talk: [] } });
    await db.doc('kbBodies/1.100').set({ body: '本文です' });
    const seen: string[] = [];
    const client = () =>
      ({
        beta: {
          messages: {
            parse: async (req: { messages: { content: string }[] }) => {
              seen.push(req.messages[0].content);
              return {
                model: 'claude-opus-5-5',
                stop_reason: 'end_turn',
                usage: { input_tokens: 100, output_tokens: 50 },
                parsed_output: {
                  conclusion: 'A社が調達',
                  points: [{ text: 'A社はシリーズAで5億円', cites: [1] }],
                  memoQuotes: [{ n: 1, quote: '次回提案' }],
                  general: '',
                  insufficient: false,
                  followups: [],
                },
              };
            },
          },
        },
      }) as unknown as Anthropic;
    const r = await askQuestion({ db, client, embed }, '資金調達の事例は？');
    expect(seen[0]).toContain('[1] 2026-11-01｜A社｜シリーズAで資金調達｜担当者が読んだ記事');
    expect(seen[0]).toContain('担当者のメモ: 次回提案');
    expect(seen[0]).toContain('本文（抜粋）: 本文です');
    expect(seen[0]).not.toContain('セミナー');
    expect(r.sources[0]).toMatchObject({ n: 1, id: '1.100', read: true, analyzed: true });
    expect(r.answer.points[0].cites).toEqual([1]);
  });
});

import { costBetween, dailyReport } from '../src/reports';

describe.skipIf(!HOST)('レポート（エミュレーター）', () => {
  beforeEach(async () => {
    await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  });

  it('デイリー：昨日の記事から注目記事と営業ネタを選ぶ。追っている会社に印、知識に入れない記事は渡さない', async () => {
    const put = (id: string, title: string, at: string, extra: Record<string, unknown> = {}) =>
      db.doc(`kbIndex/${id}`).set({ id, title, company: `会社${id}`, companyId: id.split('.')[1], url: '', publishedAt: at, state: 'done', type: '資金調達', isCase: true, ...extra });
    await put('1.100', '資金調達A', '2026-11-12T10:00:00+09:00');
    await put('2.200', '新サービスB', '2026-11-12T23:59:00+09:00');
    await put('3.300', 'セミナー', '2026-11-12T11:00:00+09:00', { state: 'excluded' });
    await put('4.400', '前の日', '2026-11-11T23:00:00+09:00');
    await db.doc('longlist/200').set({ temperature: 'A', progress: '商談' });
    const seen: string[] = [];
    const client = () =>
      ({
        beta: {
          messages: {
            parse: async (req: { messages: { content: string }[] }) => {
              seen.push(req.messages[0].content);
              return {
                model: 'claude-opus-5-5',
                stop_reason: 'end_turn',
                usage: { input_tokens: 100, output_tokens: 50 },
                parsed_output: {
                  picks: [
                    { n: 1, reason: '追っている会社の新サービス', service: 'マーケ・営業支援' },
                    { n: 1, reason: '重なり', service: 'その他' },
                    { n: 99, reason: '存在しない', service: 'その他' },
                  ],
                  netas: [{ talk: 'トーク', to: '経営者', n: 2 }],
                },
              };
            },
          },
        },
      }) as unknown as Anthropic;
    const r = await dailyReport({ db, client }, Date.UTC(2026, 10, 13, 0, 0));
    expect(r).toMatchObject({ picks: 1, netas: 1 });
    expect(seen[0]).toContain('昨日（2026-11-12）の記事 2 件');
    expect(seen[0]).toContain('[1] 会社2.200｜新サービスB｜資金調達｜追っている会社（温度感A・商談）');
    expect(seen[0]).not.toContain('セミナー');
    expect(seen[0]).not.toContain('前の日');
    const rep = (await db.doc('kbReports/daily_20261112').get()).data()!;
    expect(rep.picks).toMatchObject([{ id: '2.200', tracked: '温度感A・商談', service: 'マーケ・営業支援' }]);
    expect(rep.netas).toMatchObject([{ id: '1.100', talk: 'トーク' }]);
  });

  it('AI の費用：Knowledge Base と Watcher・台帳の分を足す', async () => {
    await db.doc('kbMeta/usage_20261110').set({ usd: 1.5 });
    await db.doc('kbMeta/usage_20261201').set({ usd: 9 });
    await db.doc('aiUsage/20261111').set({ 'claude-opus-5-5': { input: 1_000_000, output: 100_000, cacheRead: 0 } });
    const c = await costBetween(db, '2026-11-01', '2026-11-30');
    expect(c.kb).toBeCloseTo(1.5);
    expect(c.watcher).toBeCloseTo(6);
  });
});
