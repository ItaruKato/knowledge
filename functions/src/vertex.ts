import { GoogleAuth } from 'google-auth-library';

/**
 * 記事・質問を数値（768 次元のベクトル）にする。Google Cloud の Vertex AI（text-multilingual-embedding-002。日本語に対応）。
 * 同じ Google Cloud プロジェクトの中で済み、新しいキーは要らない（関数を動かすアカウントに Vertex AI の利用の権限が要る）。
 */
export const EMBED_MODEL = 'text-multilingual-embedding-002';
export const EMBED_DIM = 768;
const PROJECT = 'prtimes-inbox';
/** 東京で使えなければアメリカ（us-central1）を使う */
const REGIONS = ['asia-northeast1', 'us-central1'];
/** 1回に送る数（このモデルの上限より少なめ） */
export const EMBED_BATCH = 50;

export type EmbedTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
export type Embed = (texts: string[], task: EmbedTask) => Promise<number[][]>;

let auth: GoogleAuth | null = null;

export const vertexEmbed: Embed = async (texts, task) => {
  if (!texts.length) return [];
  auth ??= new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  const token = (await (await auth.getClient()).getAccessToken()).token;
  let last = '';
  for (const region of REGIONS) {
    const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${region}/publishers/google/models/${EMBED_MODEL}:predict`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: texts.map((content) => ({ content: content.slice(0, 2000), task_type: task })),
        parameters: { outputDimensionality: EMBED_DIM, autoTruncate: true },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) {
      last = `${region}: 404`;
      continue;
    }
    if (!res.ok) {
      // 理由を1行にする（画面の「止まりました」に全部出るように）
      const raw = await res.text();
      let why = raw;
      try {
        const e = (JSON.parse(raw) as { error?: { status?: string; message?: string } }).error;
        if (e) why = `${e.status ?? ''} ${e.message ?? ''}`;
      } catch {
        /* JSON でなければそのまま */
      }
      throw new Error(`Vertex AI ${res.status}（${region}）: ${why.replace(/\s+/g, ' ').trim().slice(0, 240)}`);
    }
    const j = (await res.json()) as { predictions?: { embeddings?: { values?: number[] } }[] };
    const out = (j.predictions ?? []).map((p) => p.embeddings?.values ?? []);
    if (out.length !== texts.length || out.some((v) => v.length !== EMBED_DIM)) throw new Error('Vertex AI の答えの形が違います');
    return out;
  }
  throw new Error(`Vertex AI のモデルが見つかりません（${last}）`);
};

/** 記事を数値にするときの文（会社・タイトル・冒頭・キーワード） */
export function docText(a: { title?: string; company?: string; lead?: string; keywords?: string[] }): string {
  return [a.company, a.title, a.lead, (a.keywords ?? []).join('、')].filter(Boolean).join('\n');
}
