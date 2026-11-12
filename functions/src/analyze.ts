import type Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { usageOf, type Usage } from './usage';

/** 精度優先（本人の決定）。Watcher の下書きと同じモデル */
export const MODEL = 'claude-opus-5-5';
/** 整理のしかたを変えたら上げる（上げると全記事を整理し直す） */
export const ANALYSIS_V = 1;

export const SERVICES = ['経営・事業支援', '資金調達・M&A支援', 'マーケ・営業支援', '人材・組織支援'] as const;
/** 先行事例の規模・段階（本人の決定） */
export const STAGES = ['スタートアップ（シード〜シリーズA）', '成長期（シリーズB以降）', '中小企業', '中堅・大企業', '上場企業', '不明'] as const;
/** 先行事例の課題・狙い（本人の決定：選択肢＋AIの一言） */
export const CHALLENGES = [
  '売上拡大',
  '新規顧客の開拓',
  '新規事業・新商品',
  '採用強化',
  '人材育成・組織づくり',
  '資金確保',
  'M&A・事業承継',
  '上場準備',
  '海外展開',
  'DX・効率化',
  'ブランド・認知向上',
  '提携・協業',
  'その他',
] as const;

export const Analysis = z.object({
  industry: z.string(),
  themes: z.array(z.object({ name: z.string(), service: z.enum([...SERVICES, 'その他']), description: z.string() })),
  stage: z.enum(STAGES),
  stageReason: z.string(),
  challenges: z.array(z.enum(CHALLENGES)),
  challengeNote: z.string(),
  isCase: z.boolean(),
  caseTitle: z.string(),
  caseSummary: z.string(),
  facts: z.array(z.object({ label: z.string(), value: z.string() })),
  talk: z.array(z.string()),
});
export type AnalysisOut = z.infer<typeof Analysis>;

export const SYSTEM = `あなたは、経営・事業支援／資金調達・M&A支援／マーケ・営業支援／人材・組織支援を提供する会社の営業担当者のために、読んだプレスリリースを「営業の知識」として整理する係です。
整理した結果は、テーマ別のネタ帳、先行事例の検索（業界・テーマ・規模/段階・課題/狙いで絞り込む）、会社ページに使います。
記事に書かれていないことは推測で書かず、推測を含むときは「〜の可能性」と書きます。日本語で答えます。

industry: この会社の業界を、営業で使う短い言葉で1つ（例: SaaS、物流、不動産テック、D2C、医療・ヘルスケア、製造、人材、飲食、金融、教育）。
themes: この記事が入るネタ帳のテーマを1〜3個。「いまあるテーマ」に合うものがあれば、その名前を一字一句そのまま使う。合うものがないときだけ新しいテーマを作る。
  新しいテーマの名前は、営業で話題にできる切り口の短い名詞句（6〜16字。例: 「地方企業のDX投資」「シリーズAの大型調達」「事業承継型のM&A」「人的資本の開示」）。会社名・商品名は入れない。広すぎる名前（「ニュース」「ビジネス」）や、1社にしか当てはまらない狭すぎる名前は避ける。
  service はそのテーマがいちばん関係するサービス。description はテーマの説明を1文（新しいテーマのときに使う）。
stage: 会社の規模・段階。調達のラウンド、上場の有無、従業員数・資本金（「会社の情報」）から判断する。判断できなければ「不明」。stageReason に根拠を1文。
challenges: この会社の取り組みから読み取れる課題・狙いを1〜3個、選択肢から選ぶ。challengeNote に、具体的に何をしようとしているかを1文。
isCase: ほかの会社に「先行事例」として紹介できる取り組み（資金調達、M&A、提携、新規事業、採用・組織の施策、DX、海外展開、マーケ施策など）なら true。単なるイベント告知・キャンペーン・人事異動だけなら false。
caseTitle: 事例として紹介するときの見出し（25字程度。「どんな会社が・何をして・どうなった」）。isCase が false なら空文字。
caseSummary: 事例の要約を2〜3文（背景・打ち手・結果や狙い）。isCase が false なら空文字。
facts: 事例の判断に役立つ事実を label と value の組で最大8個（例: 調達額 / 10億円、ラウンド / シリーズA、引受先、提携先、対象顧客、開始日、従業員数）。
talk: 営業でそのまま使える一言（トーク例）を2〜3個。他社に事例として話すとき、またはこの会社に話しかけるきっかけ。1つ60字程度。`;

export interface AnalyzeInput {
  title: string;
  company: string;
  publishedAt: string;
  body: string;
  /** 会社の台帳の情報（業種・上場・資本金・従業員数など） */
  companyInfo: string;
  /** 本人のメモ・自分用タグ（優先して考慮する） */
  memo: string;
  myTags: string[];
  /** Watcher の AI の要約（参考） */
  draftSummary: string;
  /** いまあるテーマ（名前と件数） */
  themes: { name: string; count: number }[];
}

export function userContent(a: AnalyzeInput): string {
  const themes = a.themes.length
    ? a.themes
        .slice(0, 300)
        .map((t) => `- ${t.name}（${t.count}件）`)
        .join('\n')
    : '（まだありません）';
  return [
    `いまあるテーマ:\n${themes}`,
    `タイトル: ${a.title}`,
    `会社: ${a.company}`,
    `配信日時: ${a.publishedAt}`,
    `会社の情報: ${a.companyInfo || '（なし）'}`,
    `担当者のメモ（優先して考慮する）: ${a.memo || '（なし）'}`,
    `担当者のタグ: ${a.myTags.join('、') || '（なし）'}`,
    `AIの要約（参考）: ${a.draftSummary || '（なし）'}`,
    `本文:\n${a.body || '（本文を取得できませんでした。タイトルから分かる範囲で）'}`,
  ].join('\n\n');
}

/** 長すぎる値を切り、件数をそろえる */
export function tidy(o: AnalysisOut): AnalysisOut {
  const cut = (s: string, n: number) => s.trim().slice(0, n);
  const seen = new Set<string>();
  return {
    industry: cut(o.industry, 30),
    themes: o.themes
      .map((t) => ({ name: themeName(t.name), service: t.service, description: cut(t.description, 120) }))
      .filter((t) => t.name && !seen.has(t.name) && seen.add(t.name))
      .slice(0, 3),
    stage: o.stage,
    stageReason: cut(o.stageReason, 160),
    challenges: [...new Set(o.challenges)].slice(0, 3),
    challengeNote: cut(o.challengeNote, 160),
    isCase: o.isCase,
    caseTitle: o.isCase ? cut(o.caseTitle, 60) : '',
    caseSummary: o.isCase ? cut(o.caseSummary, 400) : '',
    facts: o.facts.slice(0, 8).map((f) => ({ label: cut(f.label, 30), value: cut(f.value, 120) })),
    talk: o.talk.slice(0, 3).map((s) => cut(s, 120)),
  };
}

/** テーマ名をそろえる（全角・半角、前後の空白、記号「/」）。ドキュメントIDにも使う */
export function themeName(s: string): string {
  return s.normalize('NFKC').replace(/[\s/]+/g, '').replace(/^[「『]|[」』]$/g, '').slice(0, 24);
}

export async function analyze(client: Anthropic, input: AnalyzeInput): Promise<{ out: AnalysisOut; model: string; usage: Usage }> {
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: betaZodOutputFormat(Analysis) },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent(input) }],
  });
  const model = response.model ?? MODEL;
  const usage = usageOf(model, response.usage);
  const o = response.parsed_output;
  if (response.stop_reason === 'refusal' || !o) {
    const err = new Error(`整理できませんでした（${response.stop_reason}）`) as Error & { usage?: Usage };
    err.usage = usage;
    throw err;
  }
  return { out: tidy(o), model, usage };
}
