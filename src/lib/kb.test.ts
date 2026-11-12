import { describe, expect, it } from 'vitest';
import { applyFilters, emptyFilters, facetCounts, matrix, themesByService } from './kb';
import type { KbArticle } from '../types';

const art = (id: string, industry: string, themes: string[], stage: string, challenges: string[], isCase = true, extra: Partial<KbArticle> = {}): KbArticle => ({
  id,
  companyId: '1',
  title: `記事${id}`,
  company: `会社${id}`,
  url: '',
  publishedAt: `2026-11-0${id}T10:00:00+09:00`,
  readAt: null,
  memo: '',
  myTags: [],
  stars: 0,
  draft: null,
  state: 'done',
  themes,
  kb: { industry, stage, stageReason: '', challenges, challengeNote: '', isCase, caseTitle: `見出し${id}`, caseSummary: '', facts: [], talk: [] },
  ...extra,
});

const items = [
  art('1', 'SaaS', ['大型調達', '採用'], '成長期（シリーズB以降）', ['資金確保', '採用強化']),
  art('2', 'SaaS', ['大型調達'], 'スタートアップ（シード〜シリーズA）', ['資金確保']),
  art('3', '製造', ['地方DX'], '中小企業', ['DX・効率化'], true, { memo: '工場の見える化' }),
  art('4', '製造', ['地方DX'], '中小企業', ['DX・効率化'], false),
];

describe('先行事例の絞り込み', () => {
  it('事例だけ。切り口の中は「どれか」、切り口どうしは「すべて」', () => {
    expect(applyFilters(items, emptyFilters()).map((a) => a.id)).toEqual(['1', '2', '3']);
    expect(applyFilters(items, { ...emptyFilters(), casesOnly: false }).map((a) => a.id)).toEqual(['1', '2', '3', '4']);
    expect(applyFilters(items, { ...emptyFilters(), industry: ['SaaS', '製造'], challenge: ['採用強化'] }).map((a) => a.id)).toEqual(['1']);
  });
  it('言葉で探す（メモも対象。全角・半角をそろえる）', () => {
    expect(applyFilters(items, { ...emptyFilters(), q: '見える化' }).map((a) => a.id)).toEqual(['3']);
    expect(applyFilters(items, { ...emptyFilters(), q: 'ｓａａｓ 見出し2' }).map((a) => a.id)).toEqual(['2']);
  });
  it('件数は、ほかの切り口の絞り込みを効かせて数える', () => {
    const f = { ...emptyFilters(), industry: ['SaaS'] };
    expect(facetCounts(items, f, 'industry')).toEqual([
      { value: 'SaaS', count: 2 },
      { value: '製造', count: 1 },
    ]);
    expect(facetCounts(items, f, 'stage').map((x) => x.value)).toEqual(['スタートアップ（シード〜シリーズA）', '成長期（シリーズB以降）']);
  });
});

describe('業界×テーマの表', () => {
  it('列は多いテーマから。あふれた分は「その他のテーマ」', () => {
    const m = matrix(items.slice(0, 3), 1);
    expect(m.cols).toEqual(['大型調達', 'その他のテーマ']);
    expect(m.rows[0]).toMatchObject({ industry: 'SaaS', total: 2 });
    expect(m.rows[0].cells.get('大型調達')).toBe(2);
    expect(m.rows[0].cells.get('その他のテーマ')).toBe(1);
  });
});

describe('ネタ帳', () => {
  it('テーマをサービスごとに、件数の多い順に', () => {
    const g = themesByService([
      { name: 'a', count: 1, service: '資金調達・M&A支援' },
      { name: 'b', count: 3, service: '資金調達・M&A支援' },
      { name: 'c', count: 2, service: '謎' },
      { name: 'd', count: 0, service: '人材・組織支援' },
    ]);
    expect(g.map((x) => [x.service, x.themes.map((t) => t.name)])).toEqual([
      ['資金調達・M&A支援', ['b', 'a']],
      ['その他', ['c']],
    ]);
  });
});
