import { describe, expect, it } from 'vitest';
import { around, buildGraph, matchingNodes, neighbors, similarOf, similarity, aggregate } from './graph';
import type { KbArticle } from '../types';

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
  art('2', 'B', 'SaaS', ['大型調達'], ['資金確保']),
  art('3', 'C', '製造', ['地方DX'], ['DX・効率化'], '上場企業'),
  art('4', 'D', '製造', [], ['その他'], '上場企業'),
];

describe('知識のつながり', () => {
  it('共通点の点数と理由（テーマ3・業界2・課題1・段階1。「その他」は数えない）', () => {
    const m = aggregate(items, {});
    expect(similarity(m.get('A')!, m.get('B')!)).toEqual({
      score: 7,
      reasons: ['同じテーマ「大型調達」', '同じ業界「SaaS」', '同じ課題・狙い「資金確保」', '同じ規模・段階「中小企業」'],
    });
    expect(similarity(m.get('C')!, m.get('D')!).score).toBe(3);
    expect(similarity(m.get('A')!, m.get('C')!).score).toBe(0);
  });
  it('会社・テーマ・業界の丸と、似ている会社の線（正式名で表示）', () => {
    const g = buildGraph(items, { A: '株式会社A' }, [{ name: '大型調達', count: 2, service: '資金調達・M&A支援' }]);
    expect(g.nodes.find((n) => n.id === 'c:A')?.label).toBe('株式会社A');
    expect(g.nodes.find((n) => n.id === 't:大型調達')).toMatchObject({ kind: 'theme', service: '資金調達・M&A支援', count: 2 });
    expect(g.links.filter((l) => l.kind === 'similar').map((l) => [l.source, l.target].sort().join('-')).sort()).toEqual(['c:A-c:B', 'c:C-c:D']);
    expect(buildGraph(items, {}, [], { similar: false, industries: false }).links.every((l) => l.kind === 'theme')).toBe(true);
  });
  it('押した丸の周り・2歩先まで・似ている会社・検索', () => {
    const g = buildGraph(items, {}, []);
    expect([...neighbors(g, 'c:A')].sort()).toEqual(['c:A', 'c:B', 'i:SaaS', 't:大型調達']);
    expect(around(g, 'c:C', 1).nodes.map((n) => n.id).sort()).toEqual(['c:C', 'c:D', 'i:製造', 't:地方DX']);
    expect(similarOf(g, 'c:A')).toMatchObject([{ id: 'c:B', score: 7 }]);
    expect([...(matchingNodes(g, 'dx', items, {}) ?? [])].sort()).toEqual(['c:C', 't:地方DX']);
    expect(matchingNodes(g, ' ', items, {})).toBeNull();
  });
});
