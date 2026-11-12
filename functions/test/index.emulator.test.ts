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
