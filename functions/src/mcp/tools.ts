import type Anthropic from '@anthropic-ai/sdk';
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { askQuestion } from '../ask';
import { searchIndex, type SearchFilters } from '../search';
import { extractBody, httpGet, isPrtimesUrl } from '../page';
import type { Embed } from '../vertex';

/**
 * 窓口（MCP）の道具。すべて読むだけ（本人の決定：自分のメモと Long List の温度感・進捗も含める。ask は窓口の中で Opus が答える）。
 * 答えは Claude が読みやすい短い文字にする（1回 10 万字まで）
 */

export interface ToolDeps {
  db: Firestore;
  client: () => Anthropic;
  embed: Embed;
  get?: (url: string) => Promise<string>;
}

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (deps: ToolDeps, args: Record<string, unknown>) => Promise<string>;
}

const MAX_CHARS = 100_000;
const PERIODS = ['week', 'month', 'quarter', 'all'];
const str = (v: unknown, n = 300) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const ymd = (s: unknown) => String(s ?? '').slice(0, 10);
const aid = (v: unknown) => {
  const s = str(v, 40);
  if (!/^\d+\.\d+$/.test(s)) throw new Error('記事IDの形が違います（例: 000000012.000034567）');
  return s;
};
const cid = (v: unknown) => {
  const s = str(v, 20);
  if (!/^\d{1,12}$/.test(s)) throw new Error('会社IDの形が違います（数字だけ）');
  return s;
};
const url = (id: string) => `https://prtimes.jp/main/html/rd/p/${id}.html`;

async function longlistLine(db: Firestore, companyId: string): Promise<string> {
  try {
    const s = await db.collection('longlist').doc(companyId).get();
    if (!s.exists) return '';
    const x = s.data()!;
    return [
      x.temperature ? `温度感 ${x.temperature}` : '',
      x.progress ? `進捗 ${x.progress}` : '',
      x.nextText ? `次にやること ${x.nextText}${x.nextDate ? `（${x.nextDate}）` : ''}` : '',
      x.memo ? `Long List のメモ: ${String(x.memo).slice(0, 400)}` : '',
    ]
      .filter(Boolean)
      .join('｜');
  } catch {
    return '';
  }
}

export const TOOLS: ToolDef[] = [
  {
    name: 'search_articles',
    title: '全記事を意味で探す',
    description:
      'PR TIMES のプレスリリース（2026-09-01 以降の全記事と、本人が読んだ記事）を、言葉の意味で探す。セミナー・告知などの記事は入っていない。結果は近い順で、記事ID・日付・会社（会社ID）・タイトル・種類・業界・事例らしさ・本人が読んだか。詳しくは get_article、会社は get_company で。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '探したいこと（例: 地方の製造業の DX 投資）' },
        period: { type: 'string', enum: PERIODS, description: '期間（week=1週間、month=1か月、quarter=3か月、all=全部）。既定は all' },
        types: { type: 'array', items: { type: 'string' }, description: '記事の種類で絞る（例: 資金調達、M&A・資本提携、新規事業・新商品・新サービス、業務提携・協業、上場・IPO）' },
        cases_only: { type: 'boolean', description: '事例らしい記事だけ' },
        limit: { type: 'number', description: '何件まで（最大 30、既定 15）' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    run: async (deps, a) => {
      const q = str(a.query);
      if (!q) throw new Error('query が空です');
      const f: SearchFilters = {
        period: (PERIODS.includes(String(a.period)) ? a.period : 'all') as SearchFilters['period'],
        types: Array.isArray(a.types) ? a.types.map((t) => str(t, 40)).filter(Boolean) : undefined,
        casesOnly: a.cases_only === true,
      };
      const hits = (await searchIndex(deps.db, deps.embed, q, f)).slice(0, Math.min(30, Math.max(1, Number(a.limit) || 15)));
      if (!hits.length) return '当てはまる記事はありませんでした。';
      return hits
        .map(
          (h, i) =>
            `${i + 1}. [${h.id}] ${ymd(h.publishedAt)}｜${h.company}（会社ID ${h.companyId}）｜${h.caseTitle || h.title}${h.type ? `｜${h.type}` : ''}${h.industry ? `｜${h.industry}` : ''}${h.isCase ? '｜事例らしい' : ''}${h.read ? '｜本人が読んだ記事' : ''}${h.analyzed ? '｜整理済み' : ''}\n   ${h.url}`,
        )
        .join('\n');
    },
  },
  {
    name: 'get_article',
    title: '記事を読む',
    description: '記事IDから、記事の中身（本文の抜粋）、AI の整理（事例の見出し・要約・数字・課題/狙い・トーク例・テーマ）、本人のメモを返す。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '記事ID（例: 000000012.000034567）' } }, required: ['id'], additionalProperties: false },
    run: async (deps, a) => {
      const id = aid(a.id);
      const { db } = deps;
      const [ix, art, body] = await db.getAll(db.collection('kbIndex').doc(id), db.collection('kbArticles').doc(id), db.collection('kbBodies').doc(id));
      if ((!ix.exists && !art.exists) || ix.get('state') === 'excluded' || art.get('state') === 'excluded') return 'この記事は Knowledge Base にありません（セミナー・告知などで知識に入れていない記事かもしれません）。';
      const x = { ...(ix.data() ?? {}), ...(art.data() ?? {}) } as Record<string, unknown>;
      const kb = (art.get('kb') ?? {}) as Record<string, unknown>;
      let text = String(body.get('body') ?? '');
      const link = String(x.url || url(id));
      if (!text && isPrtimesUrl(link)) {
        try {
          text = extractBody(await (deps.get ?? httpGet)(link), 8000);
        } catch {
          text = String(x.lead ?? '');
        }
      }
      const facts = ((kb.facts as { label: string; value: string }[]) ?? []).map((f) => `${f.label}: ${f.value}`).join('、');
      return [
        `記事ID ${id}｜${ymd(x.publishedAt)}｜${x.company}（会社ID ${x.companyId}）`,
        `タイトル: ${x.title}`,
        link,
        art.get('source') === 'handoff' ? `本人が読んだ記事（${ymd(x.readAt)} 読了${Number(x.stars) ? `・★${x.stars}` : ''}）` : '',
        kb.caseTitle ? `事例の見出し: ${kb.caseTitle}` : '',
        kb.caseSummary ? `要約: ${kb.caseSummary}` : '',
        facts ? `数字・事実: ${facts}` : '',
        kb.industry || x.industry ? `業界: ${kb.industry || x.industry}` : '',
        kb.stage ? `規模・段階: ${kb.stage}` : '',
        Array.isArray(kb.challenges) && kb.challenges.length ? `課題・狙い: ${(kb.challenges as string[]).join('・')}${kb.challengeNote ? `（${kb.challengeNote}）` : ''}` : '',
        Array.isArray(kb.talk) && kb.talk.length ? `トーク例:\n${(kb.talk as string[]).map((t) => `- ${t}`).join('\n')}` : '',
        Array.isArray(x.themes) && (x.themes as string[]).length ? `テーマ: ${(x.themes as string[]).join('、')}` : '',
        x.memo ? `本人のメモ: ${x.memo}` : '',
        text ? `本文（抜粋）:\n${text.slice(0, 8000)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  {
    name: 'find_companies',
    title: '会社を探す',
    description: '会社名や事業の言葉から会社を探し、会社ID・名前・記事の件数を返す。会社の詳しい情報は get_company で。',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: '会社名や、事業を表す言葉' } }, required: ['name'], additionalProperties: false },
    run: async (deps, a) => {
      const q = str(a.name, 100);
      if (!q) throw new Error('name が空です');
      const exact = await deps.db.collection('companies').where('name', '==', q).limit(5).get();
      const hits = await searchIndex(deps.db, deps.embed, q, {});
      const m = new Map<string, { name: string; n: number }>();
      for (const d of exact.docs) m.set(d.id, { name: String(d.get('name') ?? q), n: 0 });
      for (const h of hits) {
        const c = m.get(h.companyId) ?? { name: h.company, n: 0 };
        c.n++;
        m.set(h.companyId, c);
      }
      if (!m.size) return '見つかりませんでした。';
      return [...m]
        .slice(0, 20)
        .map(([id, c]) => `- 会社ID ${id}｜${c.name}${c.n ? `（関係する記事 ${c.n} 件）` : ''}`)
        .join('\n');
    },
  },
  {
    name: 'get_company',
    title: '会社を調べる',
    description:
      '会社IDから、会社ページの中身を返す：基本情報（PR TIMES の企業情報・gBizINFO・会社 HP）、AI のまとめ（事業・営業の切り口・相性のよいサービス・ビジネス・資本関係・出来事）、Long List の温度感・進捗・次にやること、本人が読んだ記事とメモ、PR TIMES の記事の一覧（新しい順に 50 件）。',
    inputSchema: { type: 'object', properties: { company_id: { type: 'string', description: '会社ID（PR TIMES の会社ID。数字）' } }, required: ['company_id'], additionalProperties: false },
    run: async (deps, a) => {
      const id = cid(a.company_id);
      const { db } = deps;
      const [c, kc, ca] = await db.getAll(db.collection('companies').doc(id), db.collection('kbCompanies').doc(id), db.collection('companyArticles').doc(id));
      if (!c.exists && !ca.exists) return 'この会社は台帳にありません。';
      const p = (c.get('profile') ?? {}) as Record<string, string>;
      const g = (c.get('gbiz') ?? {}) as Record<string, unknown>;
      const w = (c.get('web') ?? {}) as Record<string, { value?: string; asOf?: string } | string | undefined>;
      const wv = (k: string) => {
        const v = w[k] as { value?: string; asOf?: string } | undefined;
        return v?.value ? `${v.value}${v.asOf ? `（${v.asOf}）` : ''}` : '';
      };
      const ai = (kc.get('ai') ?? {}) as Record<string, unknown>;
      const reads = await db.collection('kbArticles').where('companyId', '==', id).get();
      const arts = Object.entries((ca.get('a') ?? {}) as Record<string, { t?: string; p?: string }>)
        .sort((x, y) => String(y[1].p).localeCompare(String(x[1].p)))
        .slice(0, 50);
      const ll = await longlistLine(db, id);
      const lines = [
        `会社ID ${id}｜${wv('officialName') || g.name || c.get('name') || ca.get('name')}`,
        `会社ページ: https://prtimes-knowledge.web.app/c/${id}`,
        [
          p.industry && `業種: ${p.industry}`,
          c.get('industryTags.main') && `業界タグ: ${c.get('industryTags.main')}`,
          (p.address || g.location) && `所在地: ${p.address || g.location}`,
          (p.representative || g.representative) && `代表者: ${p.representative || g.representative}`,
          (p.established || g.established) && `設立: ${p.established || g.established}`,
          (p.capital || g.capital) && `資本金: ${p.capital || g.capital}`,
          g.employees !== undefined && `従業員数: ${g.employees}人`,
          wv('employees') && `従業員数（HP）: ${wv('employees')}`,
          wv('sales') && `売上高（HP）: ${wv('sales')}`,
          p.listed && `上場: ${p.listed}`,
          (p.url || g.url) && `HP: ${p.url || g.url}`,
        ]
          .filter(Boolean)
          .join('｜'),
        g.summary ? `事業概要（gBizINFO）: ${g.summary}` : '',
        ll ? `Long List: ${ll}` : '',
        ai.summary ? `AI のまとめ: ${ai.summary}` : '',
        Array.isArray(ai.businesses) && ai.businesses.length ? `ビジネス: ${(ai.businesses as string[]).join('、')}` : '',
        Array.isArray(ai.angles) && ai.angles.length ? `営業の切り口:\n${(ai.angles as string[]).map((x) => `- ${x}`).join('\n')}` : '',
        Array.isArray(ai.fits) && ai.fits.length ? `相性のよいサービス:\n${(ai.fits as { service: string; reason: string }[]).map((f) => `- ${f.service}: ${f.reason}`).join('\n')}` : '',
        Array.isArray(ai.capital) && ai.capital.length
          ? `資本関係:\n${(ai.capital as { counterpart: string; relation: string; date: string; articleId: string }[]).map((x) => `- ${x.date} ${x.relation} ${x.counterpart}（根拠 ${x.articleId}）`).join('\n')}`
          : '',
        Array.isArray(ai.events) && ai.events.length
          ? `出来事:\n${(ai.events as { date: string; type: string; title: string; amount?: string; counterpart?: string; articleId: string }[])
              .map((e) => `- ${e.date} ${e.type} ${e.title}${e.amount ? ` ${e.amount}` : ''}${e.counterpart ? `（${e.counterpart}）` : ''}（根拠 ${e.articleId}）`)
              .join('\n')}`
          : '',
        reads.size
          ? `本人が読んだ・整理した記事:\n${reads.docs
              .filter((d) => d.get('state') !== 'excluded')
              .map((d) => `- [${d.id}] ${ymd(d.get('publishedAt'))} ${d.get('kb.caseTitle') || d.get('title')}${d.get('memo') ? `｜メモ: ${String(d.get('memo')).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`)
              .join('\n')}`
          : '',
        arts.length ? `PR TIMES の記事（新しい順）:\n${arts.map(([aidv, v]) => `- [${aidv}] ${ymd(v.p)} ${v.t}`).join('\n')}` : '',
      ];
      return lines.filter(Boolean).join('\n');
    },
  },
  {
    name: 'list_themes',
    title: 'ネタ帳のテーマの一覧',
    description: 'ネタ帳のテーマ（AI が作った営業の切り口のまとまり）を、件数の多い順に返す。中身は get_theme で。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (deps) => {
      const snap = await deps.db.collection('kbThemes').get();
      const list = snap.docs
        .map((d) => ({ name: String(d.get('name') ?? d.id), n: Number(d.get('count') ?? 0), service: String(d.get('service') ?? '') }))
        .filter((t) => t.n > 0)
        .sort((x, y) => y.n - x.n);
      return list.length ? list.map((t) => `- ${t.name}（${t.n}件・${t.service}）`).join('\n') : 'まだテーマがありません。';
    },
  },
  {
    name: 'get_theme',
    title: 'ネタ帳のテーマを開く',
    description: 'テーマ名から、そのテーマのネタ（トーク例・事例の見出し・数字・会社・本人のメモ）を返す。',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'テーマ名（list_themes の名前そのまま）' } }, required: ['name'], additionalProperties: false },
    run: async (deps, a) => {
      const name = str(a.name, 40);
      const snap = await deps.db.collection('kbArticles').where('themes', 'array-contains', name).get();
      const docs = snap.docs.filter((d) => d.get('state') === 'done');
      if (!docs.length) return 'このテーマのネタはありません。';
      return docs
        .map((d) => {
          const kb = (d.get('kb') ?? {}) as { caseTitle?: string; talk?: string[]; facts?: { label: string; value: string }[] };
          return [
            `- [${d.id}] ${ymd(d.get('publishedAt'))}｜${d.get('company')}（会社ID ${d.get('companyId')}）｜${kb.caseTitle || d.get('title')}`,
            ...(kb.talk ?? []).map((t) => `  トーク例: ${t}`),
            (kb.facts ?? []).length ? `  数字: ${kb.facts!.map((f) => `${f.label} ${f.value}`).join('、')}` : '',
            d.get('memo') ? `  メモ: ${String(d.get('memo')).replace(/\s+/g, ' ').slice(0, 300)}` : '',
          ]
            .filter(Boolean)
            .join('\n');
        })
        .join('\n');
    },
  },
  {
    name: 'list_cases',
    title: '先行事例を絞り込む',
    description: '整理済みの先行事例を、業界・テーマ・規模/段階・課題/狙いで絞り込んで返す（新しい順）。言葉で探すときは search_articles を使う。',
    inputSchema: {
      type: 'object',
      properties: {
        industry: { type: 'string', description: '業界（部分一致）' },
        theme: { type: 'string', description: 'テーマ名（そのまま）' },
        stage: { type: 'string', description: '規模・段階（例: スタートアップ（シード〜シリーズA）、成長期（シリーズB以降）、中小企業、中堅・大企業、上場企業）' },
        challenge: { type: 'string', description: '課題・狙い（例: 資金確保、採用強化、DX・効率化、新規事業・新商品、M&A・事業承継）' },
        limit: { type: 'number', description: '何件まで（最大 50、既定 20）' },
      },
      additionalProperties: false,
    },
    run: async (deps, a) => {
      const snap = await deps.db.collection('kbArticles').where('state', '==', 'done').get();
      const ind = str(a.industry, 40);
      const theme = str(a.theme, 40);
      const stage = str(a.stage, 40);
      const ch = str(a.challenge, 40);
      const list = snap.docs
        .filter((d) => {
          const kb = (d.get('kb') ?? {}) as { isCase?: boolean; industry?: string; stage?: string; challenges?: string[] };
          if (!kb.isCase) return false;
          if (ind && !String(kb.industry ?? '').includes(ind)) return false;
          if (theme && !((d.get('themes') as string[]) ?? []).includes(theme)) return false;
          if (stage && kb.stage !== stage) return false;
          if (ch && !(kb.challenges ?? []).includes(ch)) return false;
          return true;
        })
        .sort((x, y) => String(y.get('publishedAt')).localeCompare(String(x.get('publishedAt'))))
        .slice(0, Math.min(50, Math.max(1, Number(a.limit) || 20)));
      if (!list.length) return '当てはまる事例はありませんでした。';
      return list
        .map((d) => {
          const kb = (d.get('kb') ?? {}) as { caseTitle?: string; caseSummary?: string; industry?: string; stage?: string; challenges?: string[] };
          return `- [${d.id}] ${ymd(d.get('publishedAt'))}｜${d.get('company')}（会社ID ${d.get('companyId')}）｜${kb.caseTitle || d.get('title')}｜${kb.industry ?? ''}｜${kb.stage ?? ''}｜${(kb.challenges ?? []).join('・')}\n  ${kb.caseSummary ?? ''}`;
        })
        .join('\n');
    },
  },
  {
    name: 'get_report',
    title: 'レポートを読む',
    description: '最新のデイリー（昨日の注目記事・今日の営業ネタ）またはウィークリー（ふりかえり・事例ベスト・来週動くとよい会社・AI の費用）を返す。date（YYYY-MM-DD）でその日のものも読める。',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['daily', 'weekly'] }, date: { type: 'string', description: 'YYYY-MM-DD（省略すると最新）' } },
      required: ['kind'],
      additionalProperties: false,
    },
    run: async (deps, a) => {
      const kind = a.kind === 'weekly' ? 'weekly' : 'daily';
      const date = str(a.date, 10);
      let doc;
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) doc = await deps.db.collection('kbReports').doc(`${kind}_${date.replace(/-/g, '')}`).get();
      else {
        const snap = await deps.db
          .collection('kbReports')
          .where(FieldPath.documentId(), '>=', `${kind}_`)
          .where(FieldPath.documentId(), '<', `${kind}_~`)
          .orderBy(FieldPath.documentId(), 'desc')
          .limit(1)
          .get();
        doc = snap.docs[0];
      }
      if (!doc?.exists) return 'まだレポートがありません。';
      const r = doc.data()!;
      const art = (x: Record<string, unknown>) => `${x.company}（会社ID ${x.companyId}）｜${x.title}｜${x.url}`;
      if (kind === 'daily')
        return [
          `デイリー ${r.date}`,
          '今日の営業ネタ:',
          ...((r.netas ?? []) as Record<string, unknown>[]).map((x) => `- ${x.talk}（話す相手: ${x.to}／根拠: ${art(x)}）`),
          '昨日の注目記事:',
          ...((r.picks ?? []) as Record<string, unknown>[]).map((x, i) => `${i + 1}. ${art(x)}${x.tracked ? `｜追っている会社（${x.tracked}）` : ''}\n   ${x.service}: ${x.reason}`),
        ].join('\n');
      return [
        `ウィークリー ${r.from}〜${r.date}`,
        r.summary ? `ふりかえり: ${r.summary}` : '',
        '事例ベスト:',
        ...((r.best ?? []) as Record<string, unknown>[]).map((x, i) => `${i + 1}. ${art(x)}\n   ${x.why}`),
        '来週動くとよい会社:',
        ...((r.companies ?? []) as Record<string, unknown>[]).map((x, i) => `${i + 1}. ${art(x)}\n   ${x.service}: ${x.reason}\n   来週やること: ${x.action}`),
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  {
    name: 'ask',
    title: '根拠つきで答える',
    description:
      'Knowledge Base の「質問」と同じ答えを返す：全記事と本人が読んだ記事・メモを根拠に、別の AI（Opus）が 結論・根拠の番号つきの要点・メモの引用・記事に基づかない一般的な知識（分けて）を作る。30秒〜1分半かかり、1回20円ほどの費用がかかる。まとまった答えがほしいときだけ使い、調べものは search_articles と get_article で。',
    inputSchema: { type: 'object', properties: { question: { type: 'string', description: '質問' } }, required: ['question'], additionalProperties: false },
    run: async (deps, a) => {
      const q = str(a.question, 600);
      if (!q) throw new Error('question が空です');
      // 履歴に残す（アプリの「質問」の履歴にも出る）
      const ref = await deps.db.collection('kbJobs').add({ type: 'ask', q, state: 'working', by: 'mcp', at: new Date() });
      try {
        const { answer, sources } = await askQuestion(deps, q);
        await ref.update({ state: 'done', result: { answer, sources } });
        const byN = new Map(sources.map((s) => [s.n, s]));
        return [
          `結論: ${answer.conclusion}`,
          answer.insufficient ? '（記事だけでは十分に答えられない質問でした）' : '',
          '根拠のある要点:',
          ...answer.points.map((p) => `- ${p.text} ${p.cites.map((c) => `[${c}]`).join('')}`),
          answer.memoQuotes.length ? '本人のメモから:' : '',
          ...answer.memoQuotes.map((m) => `- 「${m.quote}」[${m.n}]`),
          answer.general ? `記事に基づかない一般的な知識（参考）: ${answer.general}` : '',
          '根拠の記事:',
          ...[...new Set(answer.points.flatMap((p) => p.cites).concat(answer.memoQuotes.map((m) => m.n)))]
            .sort((x, y) => x - y)
            .map((n) => byN.get(n))
            .filter(Boolean)
            .map((s) => `[${s!.n}] ${ymd(s!.publishedAt)}｜${s!.company}（会社ID ${s!.companyId}）｜${s!.title}｜${s!.url}`),
        ]
          .filter(Boolean)
          .join('\n');
      } catch (e) {
        await ref.update({ state: 'failed', error: String(e).slice(0, 300) });
        throw e;
      }
    },
  },
];

export async function callTool(deps: ToolDeps, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { text: `知らない道具です: ${name}`, isError: true };
  try {
    const text = await t.run(deps, args ?? {});
    return { text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…（長いので途中まで）` : text, isError: false };
  } catch (e) {
    return { text: `うまくいきませんでした：${String((e as Error).message ?? e).slice(0, 300)}`, isError: true };
  }
}
