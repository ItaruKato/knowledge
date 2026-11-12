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
