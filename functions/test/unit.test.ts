import { describe, expect, it } from 'vitest';
import { extractBody, isPrtimesUrl } from '../src/page';
import { themeName, tidy, userContent, type AnalysisOut } from '../src/analyze';
import { companyLine, inputHash } from '../src/ingest';
import { costUsd, jstDay } from '../src/usage';

describe('page', () => {
  it('PR TIMES の記事ページだけを読む', () => {
    expect(isPrtimesUrl('https://prtimes.jp/main/html/rd/p/000000012.000034567.html')).toBe(true);
    expect(isPrtimesUrl('https://example.com/main/html/rd/p/1.2.html')).toBe(false);
    expect(isPrtimesUrl(undefined)).toBe(false);
  });
  it('本文の div だけを取り出す（入れ子も数える）', () => {
    const html = '<div>前</div><div id="press-release-body" class="x"><p>一行目</p><div><b>二</b>行目</div>&amp;</div><div>後ろ</div>';
    expect(extractBody(html)).toBe('一行目\n二行目&');
    expect(extractBody('<div>なし</div>')).toBe('');
  });
});

describe('analyze', () => {
  const base: AnalysisOut = {
    industry: 'SaaS',
    themes: [
      { name: ' シリーズAの大型調達 ', service: '資金調達・M&A支援', description: 'x' },
      { name: 'シリーズAの大型調達', service: '資金調達・M&A支援', description: 'y' },
      { name: 'ａ/ｂ', service: 'その他', description: '' },
      { name: '4つ目', service: 'その他', description: '' },
    ],
    stage: 'スタートアップ（シード〜シリーズA）',
    stageReason: 'r',
    challenges: ['資金確保', '資金確保', '採用強化'],
    challengeNote: 'n',
    isCase: false,
    caseTitle: '出さない',
    caseSummary: '出さない',
    facts: [],
    talk: ['1', '2', '3', '4'],
  };
  it('テーマ名をそろえ、重なりを除き、3つまでにする', () => {
    const t = tidy(base);
    expect(t.themes.map((x) => x.name)).toEqual(['シリーズAの大型調達', 'ab', '4つ目']);
    expect(t.challenges).toEqual(['資金確保', '採用強化']);
    expect(t.talk).toHaveLength(3);
    expect(t.caseTitle).toBe('');
    expect(themeName('「地方 DX」')).toBe('地方DX');
  });
  it('いまあるテーマとメモを AI に渡す', () => {
    const c = userContent({
      title: 'T', company: 'C', publishedAt: 'P', body: 'B', companyInfo: '', memo: 'M', myTags: ['x'], draftSummary: '', themes: [{ name: '地方DX', count: 3 }],
    });
    expect(c).toContain('- 地方DX（3件）');
    expect(c).toContain('担当者のメモ（優先して考慮する）: M');
  });
});

describe('ingest', () => {
  it('★や読んだ日時が変わっても整理し直さない。メモが変わったら整理し直す', () => {
    const h = { id: '1.2', article: { title: 'T', url: 'u' }, memo: 'a', myTags: ['b', 'a'], stars: 1, readAt: 'x' };
    expect(inputHash({ ...h, stars: 3, readAt: 'y', myTags: ['a', 'b'] })).toBe(inputHash(h));
    expect(inputHash({ ...h, memo: 'changed' })).not.toBe(inputHash(h));
  });
  it('台帳の会社の情報を1行にする', () => {
    expect(companyLine({ profile: { industry: '情報通信', listed: '未上場' }, gbiz: { employees: 25, capital: 1000000 } })).toBe(
      '業種: 情報通信、上場: 未上場、資本金: 1000000円、従業員数: 25人',
    );
    expect(companyLine(undefined)).toBe('');
    expect(
      companyLine({ web: { state: 'done', employees: { value: '120名', asOf: '2025年4月', source: 'u' }, sales: { value: '32億円', asOf: '2025年3月期', source: 'u' }, capital: null } }),
    ).toBe('従業員数（HP）: 120名（2025年4月）、売上高（HP）: 32億円（2025年3月期）');
  });
});

describe('usage', () => {
  it('費用をドルで見積もる', () => {
    expect(costUsd({ model: 'claude-opus-5-5', input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(6);
    expect(jstDay(Date.UTC(2026, 10, 12, 15, 30))).toBe('20261113');
  });
});

import { companyContent, tidyCompany } from '../src/company';

describe('company', () => {
  it('根拠の記事IDが一覧にない出来事は外し、古い順に並べる', () => {
    const t = tidyCompany(
      {
        summary: 's',
        recent: [],
        angles: [],
        fits: [],
        events: [
          { date: '2026-10-01', type: '資金調達', title: 'b', amount: '', counterpart: '', articleId: '2.9' },
          { date: '2026-01-01', type: 'M&A', title: 'a', amount: '', counterpart: '', articleId: '1.9' },
          { date: '2026-05-01', type: 'その他', title: 'x', amount: '', counterpart: '', articleId: 'nope' },
        ],
      },
      new Set(['1.9', '2.9']),
    );
    expect(t.events.map((e) => e.title)).toEqual(['a', 'b']);
  });
  it('材料に記事ID・日付・タイトルとメモを入れる', () => {
    const c = companyContent({ name: 'A社', info: '', articles: [{ id: '1.9', t: 'タイトル', p: '2026-11-01T10:00:00+09:00' }], reads: [{ id: '1.9', title: 't', caseTitle: '', summary: '要約', memo: 'メモ', facts: '' }], longlist: '' });
    expect(c).toContain('1.9｜2026-11-01｜タイトル');
    expect(c).toContain('メモ: メモ');
  });
});
