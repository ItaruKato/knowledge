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
  state?: 'done' | 'failed';
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
