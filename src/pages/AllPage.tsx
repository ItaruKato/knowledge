import { useEffect, useState } from 'react';
import { addDoc, collection, doc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { fmtDate, fmtTime, n } from '../lib/format';
import { linkProps } from '../lib/router';
import { ARTICLE_TYPES_SHOWN } from '../lib/kb';
import type { KbData } from '../data/useKb';

/**
 * 全記事（2026-09-01 以降）を意味で探す。上の検索窓に入れて Enter（または「探す」）。
 * 依頼は kbJobs（type: search）に書き、関数が結果を同じドキュメントに書く。
 * 「詳しく整理」は押した記事だけ（type: analyze。本文＋Opus、1件20円ほど）
 */

type Period = 'week' | 'month' | 'quarter' | 'all';
interface Filters {
  period: Period;
  types: string[];
  casesOnly: boolean;
}
interface Hit {
  id: string;
  score: number;
  title: string;
  company: string;
  companyId: string;
  url: string;
  publishedAt: string;
  type?: string;
  industry?: string;
  isCase?: boolean;
  read: boolean;
  analyzed: boolean;
  caseTitle?: string;
}
interface JobDoc {
  state?: 'ready' | 'working' | 'done' | 'failed';
  error?: string;
  result?: { hits?: Hit[] } | string;
}
interface IndexMeta {
  lastRunAt?: string;
  lastError?: string | null;
  stats?: { total?: number; done?: number; excluded?: number; waitingEmb?: number };
  last?: { pending?: number };
}

const PERIODS: [Period, string][] = [
  ['week', '1週間'],
  ['month', '1か月'],
  ['quarter', '3か月'],
  ['all', '全部（9月から）'],
];

/** 依頼を書き、結果のドキュメントを見張る */
function useJob(id: string | null): JobDoc | null {
  const [j, setJ] = useState<JobDoc | null>(null);
  useEffect(() => {
    setJ(null);
    if (!id) return;
    return onSnapshot(doc(db, 'kbJobs', id), (s) => setJ((s.data() as JobDoc | undefined) ?? null));
  }, [id]);
  return j;
}

function AnalyzeButton({ hit }: { hit: Hit }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);
  if (hit.analyzed || job?.result === 'done' || job?.result === 'exists')
    return (
      <a className="ghost" {...linkProps('/cases')}>
        整理済み（先行事例へ）
      </a>
    );
  if (job?.result === 'excluded') return <span className="note">セミナー・告知などのため知識に入れませんでした</span>;
  if (job?.state === 'failed') return <span className="err">整理できませんでした：{job.error}</span>;
  const busy = Boolean(jobId) && job?.state !== 'done';
  return (
    <button
      type="button"
      className="ghost"
      disabled={busy}
      title="本文を読んで、読んだ記事と同じ詳しさで整理します（1件20円ほど）"
      onClick={async () => {
        const r = await addDoc(collection(db, 'kbJobs'), { type: 'analyze', id: hit.id, state: 'ready', at: serverTimestamp() });
        setJobId(r.id);
      }}
    >
      {busy ? '整理しています…（1〜2分）' : '詳しく整理'}
    </button>
  );
}

export function AllPage({ data, q, submitSeq }: { data: KbData; q: string; submitSeq: number }) {
  const [f, setF] = useState<Filters>({ period: 'all', types: [], casesOnly: false });
  const [jobId, setJobId] = useState<string | null>(null);
  const [asked, setAsked] = useState('');
  const [meta, setMeta] = useState<IndexMeta | null>(null);
  const job = useJob(jobId);

  useEffect(() => onSnapshot(doc(db, 'kbMeta', 'index'), (s) => setMeta((s.data() as IndexMeta | undefined) ?? {}), () => setMeta({})), []);

  const search = async (filters: Filters) => {
    const text = q.trim();
    if (!text) return;
    setAsked(text);
    const r = await addDoc(collection(db, 'kbJobs'), { type: 'search', q: text, filters, state: 'ready', at: serverTimestamp() });
    setJobId(r.id);
  };
  // 上の検索窓で Enter を押したとき
  useEffect(() => {
    if (submitSeq) void search(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitSeq]);
  const change = (next: Filters) => {
    setF(next);
    if (asked && q.trim()) void search(next);
  };

  const hits = job?.state === 'done' && typeof job.result === 'object' ? (job.result.hits ?? []) : null;
  const st = meta?.stats ?? {};

  return (
    <div className="cases">
      <aside className="filters open">
        <button type="button" className="btn primary" disabled={!q.trim()} onClick={() => void search(f)}>
          全記事から探す
        </button>
        <p className="note">上の検索窓に、探したいこと（例：「地方の製造業の DX 投資」「シリーズAで採用を強化」）を入れて Enter。言い回しが違っても、意味の近い記事が出ます。</p>
        <div className="facet">
          <b>期間</b>
          {PERIODS.map(([k, label]) => (
            <button key={k} type="button" className="fopt" aria-pressed={f.period === k} onClick={() => change({ ...f, period: k })}>
              <span>{label}</span>
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={f.casesOnly} onChange={(e) => change({ ...f, casesOnly: e.target.checked })} />
          事例らしい記事だけ
        </label>
        <div className="facet">
          <b>記事の種類</b>
          {ARTICLE_TYPES_SHOWN.map((t) => (
            <button
              key={t}
              type="button"
              className="fopt"
              aria-pressed={f.types.includes(t)}
              onClick={() => change({ ...f, types: f.types.includes(t) ? f.types.filter((x) => x !== t) : [...f.types, t] })}
            >
              <span>{t}</span>
            </button>
          ))}
        </div>
        <div className="facet">
          <b>目録の様子</b>
          <small className="sub">
            {st.total !== undefined
              ? `目録 ${n(st.total)} 件（分類済み ${n(st.done ?? 0)}・知識に入れない ${n(st.excluded ?? 0)}・数値にする待ち ${n(st.waitingEmb ?? 0)}・分類待ちの頼み ${n(meta?.last?.pending ?? 0)}）`
              : 'まだ目録を作り始めていません（10分ごとに少しずつ作ります）'}
          </small>
          {meta?.lastRunAt && <small className="ver">最後に動いた時刻：{fmtTime(meta.lastRunAt)}</small>}
          {meta?.lastError && <small className="err">止まりました：{meta.lastError}</small>}
        </div>
      </aside>
      <section className="results">
        {!jobId && <p className="note">まだ探していません。</p>}
        {jobId && !hits && job?.state !== 'failed' && <p className="note">「{asked}」を探しています…</p>}
        {job?.state === 'failed' && <p className="err">探せませんでした：{job.error}</p>}
        {hits && (
          <p className="hits">
            「{asked}」に意味の近い記事：{n(hits.length)} 件（近い順）
          </p>
        )}
        {hits?.map((h) => (
          <article key={h.id} className="card kbcard">
            <div className="badges">
              {h.isCase && <span className="badge case">事例らしい</span>}
              {h.type && <span className="badge">{h.type}</span>}
              {h.industry && <span className="badge ind">{h.industry}</span>}
              {h.read && <span className="badge stage">読んだ記事</span>}
              <span className="score">近さ {Math.round(h.score * 100)}</span>
            </div>
            <a className="ttl" href={h.url} target="_blank" rel="noreferrer">
              {h.caseTitle || h.title}
            </a>
            <div className="byline">
              <a className="co" {...linkProps(`/c/${h.companyId}`)}>
                {data.names[h.companyId] ?? h.company}
              </a>
              <span className="date">{fmtDate(h.publishedAt)}</span>
            </div>
            {h.caseTitle && <p className="orig">{h.title}</p>}
            <div className="panelacts">
              <AnalyzeButton hit={h} />
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
