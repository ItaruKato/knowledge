import { describe, expect, it } from 'vitest';
import { aggregate, around, buildGraph, capitalOf, matchingNodes, neighbors, similarity } from './graph';
import type { KbArticle, KbCompanyInfo } from '../types';

const art = (id: string, cid: string, industry: string, themes: string[], challenges: string[], stage = '中小企業'): KbArticle => ({
  id,
  companyId: cid,
  title: `記事${id}`,
  company: `会社${cid}`,
  url: '',
  publishedAt: '',
  readAt: null,
  memo: '',
  myTags: [],
  stars: 0,
  draft: null,
  state: 'done',
  themes,
  kb: { industry, stage, stageReason: '', challenges, challengeNote: '', isCase: true, caseTitle: '', caseSummary: '', facts: [], talk: [] },
});

const items = [
  art('1', 'A', 'SaaS', ['大型調達'], ['資金確保']),
  art('2', 'B', 'SaaS', [], ['資金確保']),
  art('3', 'C', '製造', ['地方DX'], ['DX・効率化'], '上場企業'),
];
const companies: Record<string, KbCompanyInfo> = {
  A: { businesses: ['会計SaaS'], capital: [{ counterpart: '株式会社会社C', relation: '出資を受けた', date: '2026-10-01', articleId: '1' }, { counterpart: 'テストVC', relation: '出資を受けた', date: '2026-09-01', articleId: '1' }] },
  B: { businesses: ['会計SaaS'] },
};

describe('知識のつながり', () => {
  it('会社と会社を直接結ぶのは資本関係だけ（相手先が読んだ会社ならその丸、いなければ相手先の丸）', () => {
    const g = buildGraph(items, {}, [], companies);
    const direct = g.links.filter((l) => /^[cx]:/.test(l.source) && /^[cx]:/.test(l.target));
    expect(direct.every((l) => l.kind === 'capital')).toBe(true);
    // 「出資を受けた」は 出資した側 → 受けた側 の向きにそろえる
    const cap = g.links.filter((l) => l.kind === 'capital').map((l) => `${l.source}>${l.target}:${l.relation}`).sort();
    expect(cap).toEqual(['c:C>c:A:出資', 'x:テストvc>c:A:出資']);
    expect(g.nodes.find((n) => n.id === 'x:テストvc')).toMatchObject({ external: true, label: 'テストVC' });
    // どちらの会社から見ても正しい言い方
    expect(capitalOf(g, 'c:A').map((c) => c.relation)).toEqual(['出資を受けた', '出資を受けた']);
    expect(capitalOf(g, 'c:C')).toMatchObject([{ other: 'c:A', relation: '出資した' }]);
  });
  it('同じ資本関係が両方の会社のまとめに出てきても1本にする', () => {
    const both = { ...companies, C: { capital: [{ counterpart: '会社A', relation: '出資した', date: '2026-10-01', articleId: '3' }] } };
    expect(buildGraph(items, {}, [], both).links.filter((l) => l.kind === 'capital' && l.target === 'c:A' && l.source === 'c:C')).toHaveLength(1);
  });
  it('ビジネスが似ている会社は 会社─ビジネス─会社 でつながる', () => {
    const g = buildGraph(items, {}, [], companies);
    expect(g.nodes.find((n) => n.id === 'b:会計SaaS')).toMatchObject({ kind: 'business', count: 2 });
    expect([...neighbors(g, 'b:会計SaaS')].sort()).toEqual(['b:会計SaaS', 'c:A', 'c:B']);
    expect(around(g, 'c:B', 2).nodes.map((n) => n.id)).toContain('c:A');
  });
  it('似ている会社は線にせず、点数と理由で出す（ビジネス3・テーマ3・業界2・課題1・段階1）', () => {
    const m = aggregate(items, {}, companies);
    expect(similarity(m.get('A')!, m.get('B')!)).toEqual({
      score: 7,
      reasons: ['同じビジネス「会計SaaS」', '同じ業界「SaaS」', '同じ課題・狙い「資金確保」', '同じ規模・段階「中小企業」'],
    });
    const g = buildGraph(items, {}, [], companies);
    expect(g.similar.get('c:A')).toMatchObject([{ id: 'c:B', score: 7 }]);
  });
  it('丸の表示の切り替えと検索', () => {
    const g = buildGraph(items, {}, [], companies, { themes: false, industries: false, capital: false });
    expect(new Set(g.links.map((l) => l.kind))).toEqual(new Set(['business']));
    expect([...(matchingNodes(buildGraph(items, {}, [], companies), '会計', items, {}) ?? [])]).toEqual(['b:会計SaaS']);
  });
});
