import { describe, expect, it } from 'vitest';
import { extractBody, isPrtimesUrl } from '../src/page';
import { ruleExcluded, themeName, tidy, userContent, type AnalysisOut } from '../src/analyze';
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
    articleType: '資金調達',
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

describe('知識に入れない記事（タイトルで見分ける）', () => {
  it('セミナー・告知・調査・キャンペーン・受賞は外す。事業の動きの言葉があれば AI に任せる', () => {
    expect(ruleExcluded('【無料ウェビナー】営業DXの始め方を解説')).toBe('セミナー・勉強会・学習コンテンツ');
    expect(ruleExcluded('お役立ち資料「採用の教科書」を無料公開')).toBe('セミナー・勉強会・学習コンテンツ');
    expect(ruleExcluded('「Japan IT Week」に出展します')).toBe('展示会・イベントの告知');
    expect(ruleExcluded('20代の転職に関する意識調査を実施')).toBe('調査レポート・アンケート');
    expect(ruleExcluded('Amazonギフト券が当たるキャンペーン開始')).toBe('キャンペーン・プレゼント');
    expect(ruleExcluded('新CFOに山田氏が就任')).toBe('受賞・認定・人事');
    expect(ruleExcluded('シリーズAで5億円の資金調達を実施、セミナー事業も強化')).toBeNull();
    expect(ruleExcluded('新サービス提供開始を記念したキャンペーン')).toBeNull();
    expect(ruleExcluded('A社を子会社化')).toBeNull();
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
        businesses: ['「SNS マーケティング支援」', 'SNSマーケティング支援', 'x'],
        capital: [
          { counterpart: 'みずほ銀行', relation: '出資を受けた', date: '2026-11-01', articleId: '2.9' },
          { counterpart: 'どこか', relation: '買収した', date: '2026-01-01', articleId: 'nope' },
          { counterpart: ' ', relation: '合併', date: '2026-01-01', articleId: '1.9' },
        ],
        events: [
          { date: '2026-10-01', type: '資金調達', title: 'b', amount: '', counterpart: '', articleId: '2.9' },
          { date: '2026-01-01', type: 'M&A', title: 'a', amount: '', counterpart: '', articleId: '1.9' },
          { date: '2026-05-01', type: 'その他', title: 'x', amount: '', counterpart: '', articleId: 'nope' },
        ],
      },
      new Set(['1.9', '2.9']),
    );
    expect(t.events.map((e) => e.title)).toEqual(['a', 'b']);
    // ビジネス名はそろえて重なりを除き、2文字未満は捨てる。資本関係は根拠の記事と相手があるものだけ
    expect(t.businesses).toEqual(['SNSマーケティング支援']);
    expect(t.capital).toEqual([{ counterpart: 'みずほ銀行', relation: '出資を受けた', date: '2026-11-01', articleId: '2.9' }]);
  });
  it('材料に記事ID・日付・タイトルとメモを入れる', () => {
    const c = companyContent({ name: 'A社', info: '', businesses: ['会計SaaS'], articles: [{ id: '1.9', t: 'タイトル', p: '2026-11-01T10:00:00+09:00' }], reads: [{ id: '1.9', title: 't', caseTitle: '', summary: '要約', memo: 'メモ', facts: '' }], longlist: '' });
    expect(c).toContain('1.9｜2026-11-01｜タイトル');
    expect(c).toContain('メモ: メモ');
    expect(c).toContain('いまあるビジネス:\n- 会計SaaS');
  });
});

import { clsContent, jstHourKey } from '../src/allindex';
import { passes } from '../src/search';
import { docText } from '../src/vertex';

describe('全記事の目録と検索', () => {
  it('分類に渡す1行（区切りの記号・改行はそろえる）', () => {
    expect(clsContent([{ id: '1.2', company: 'A社', title: 'タイトル｜改行\nあり', lead: '冒頭' }])).toBe('1.2｜A社｜タイトル 改行 あり｜冒頭');
    expect(docText({ company: 'A社', title: 'T', lead: 'L', keywords: ['k1', 'k2'] })).toBe('A社\nT\nL\nk1、k2');
    expect(jstHourKey(Date.UTC(2026, 8, 30, 16))).toBe('2026100101');
  });
  it('期間・種類・事例だけで絞る。外した記事は出さない', () => {
    const now = Date.UTC(2026, 10, 12);
    const d = { state: 'done', publishedAt: '2026-11-10T10:00:00+09:00', type: '資金調達', isCase: true };
    expect(passes(d, {}, now)).toBe(true);
    expect(passes({ ...d, state: 'excluded' }, {}, now)).toBe(false);
    expect(passes({ ...d, publishedAt: '2026-10-01T00:00:00+09:00' }, { period: 'week' }, now)).toBe(false);
    expect(passes(d, { types: ['M&A・資本提携'] }, now)).toBe(false);
    expect(passes({ ...d, isCase: false }, { casesOnly: true }, now)).toBe(false);
    expect(passes({ state: 'new', publishedAt: d.publishedAt }, {}, now)).toBe(true);
  });
});

import { sourceBlock, tidyAnswer } from '../src/ask';

describe('アプリ内の質問', () => {
  it('根拠の番号が渡した記事にない要点は捨てる。メモの引用も同じ', () => {
    const a = tidyAnswer(
      {
        conclusion: ' 結論 ',
        points: [
          { text: '根拠あり', cites: [1, 1, 9] },
          { text: '根拠なし', cites: [9] },
        ],
        memoQuotes: [
          { n: 2, quote: 'メモ' },
          { n: 7, quote: '存在しない' },
        ],
        general: '一般的には…',
        insufficient: false,
        followups: ['次の質問'],
      },
      new Set([1, 2]),
    );
    expect(a.conclusion).toBe('結論');
    expect(a.points).toEqual([{ text: '根拠あり', cites: [1] }]);
    expect(a.memoQuotes).toEqual([{ n: 2, quote: 'メモ' }]);
  });
  it('記事の材料には番号・日付・会社・読んだ印・メモ・本文を入れる', () => {
    const b = sourceBlock(
      { n: 3, id: '1.2', title: 'T', company: 'A社', companyId: '2', url: '', publishedAt: '2026-11-01T10:00:00+09:00', read: true, analyzed: true, memo: 'M', score: 0.8 },
      { caseSummary: '要約', body: '本文' },
    );
    expect(b).toBe('[3] 2026-11-01｜A社｜T｜担当者が読んだ記事\n要約: 要約\n担当者のメモ: M\n本文（抜粋）: 本文');
  });
});

import { jstDate, jstDayStart } from '../src/reports';

describe('レポートの日付', () => {
  it('JST の日付とその日の 0:00', () => {
    expect(jstDate(Date.UTC(2026, 10, 12, 15, 30))).toBe('2026-11-13');
    expect(new Date(jstDayStart(Date.UTC(2026, 10, 12, 15, 30))).toISOString()).toBe('2026-11-12T15:00:00.000Z');
  });
});
