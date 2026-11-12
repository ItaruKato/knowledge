/** kbArticles/{記事ID}（Knowledge Base の関数が書く。functions/src/ingest.ts と同じ形） */
export interface KbArticle {
  id: string;
  companyId: string;
  title: string;
  company: string;
  url: string;
  publishedAt: string;
  readAt: string | null;
  memo: string;
  myTags: string[];
  stars: number;
  draft: { summary?: string; angles?: string[]; industry?: string } | null;
  /** excluded：知識に入れない記事（画面には出さない） */
  state?: 'done' | 'failed' | 'excluded';
  /** AI で整理した日時と、整理のしかたの版（functions/src/analyze.ts の ANALYSIS_V） */
  analyzedAt?: string;
  analysisV?: number;
  themes?: string[];
  kb?: {
    industry: string;
    stage: string;
    stageReason: string;
    challenges: string[];
    challengeNote: string;
    isCase: boolean;
    caseTitle: string;
    caseSummary: string;
    facts: { label: string; value: string }[];
    talk: string[];
  };
}

/** kbThemes/{テーマ名}（ネタ帳のテーマ。AI が作る） */
export interface KbTheme {
  name: string;
  count: number;
  service?: string;
  description?: string;
}

/** kbMeta/ingest（取り込みの様子） */
export interface IngestStatus {
  startedAt?: string;
  lastRunAt?: string;
  lastError?: string | null;
  lastErrorAt?: string;
  last?: Record<string, number>;
}

/** kbCompanies/{会社ID} の、つながりの図で使う部分（会社の AI のまとめ。functions/src/company.ts） */
export interface KbCompanyInfo {
  businesses?: string[];
  capital?: { counterpart: string; relation: string; date: string; articleId: string }[];
}
