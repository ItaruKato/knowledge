import { useEffect, useMemo, useRef, useState } from 'react';
import { addDoc, collection, doc, onSnapshot, query, serverTimestamp, where, limit, type Timestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { fmtDate, fmtTime } from '../lib/format';
import { linkProps } from '../lib/router';
import type { KbData } from '../data/useKb';
import { McpBox } from '../components/McpBox';

/**
 * アプリ内の質問。質問を kbJobs（type: ask）に書くと、関数が全記事と読んだ記事を根拠に答える（functions/src/ask.ts）。
 * 答えは「結論 → 根拠の記事＋自分のメモの引用」。記事にない一般的な知識は分けて出す。履歴は残す
 */

interface Source {
  n: number;
  id: string;
  title: string;
  company: string;
  companyId: string;
  url: string;
  publishedAt: string;
  read: boolean;
  analyzed: boolean;
  memo?: string;
}
interface Answer {
  conclusion: string;
  points: { text: string; cites: number[] }[];
  memoQuotes: { n: number; quote: string }[];
  general: string;
  insufficient: boolean;
  followups: string[];
}
interface AskJob {
  id: string;
  q?: string;
  state?: 'ready' | 'working' | 'done' | 'failed';
  error?: string;
  at?: Timestamp;
  result?: { answer?: Answer; sources?: Source[] };
}

const atIso = (t?: Timestamp) => (t && typeof t.toDate === 'function' ? t.toDate().toISOString() : '');

function Cite({ n, onJump }: { n: number; onJump: (n: number) => void }) {
  return (
    <button type="button" className="cite" onClick={() => onJump(n)} title="根拠の記事へ">
      {n}
    </button>
  );
}

export function AnswerView({ job, data, onAsk }: { job: AskJob; data: KbData; onAsk: (q: string) => void }) {
  const a = job.result?.answer;
  const sources = useMemo(() => job.result?.sources ?? [], [job.result]);
  const byN = useMemo(() => new Map(sources.map((s) => [s.n, s])), [sources]);
  const used = useMemo(() => new Set([...(a?.points ?? []).flatMap((p) => p.cites), ...(a?.memoQuotes ?? []).map((m) => m.n)]), [a]);
  const jump = (n: number) => document.getElementById(`src-${job.id}-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return (
    <article className="card answer">
      <h2 className="askq">{job.q}</h2>
      {job.at && <small className="ver">{fmtTime(atIso(job.at))} に質問</small>}
      {(job.state === 'ready' || job.state === 'working') && <p className="note">記事を探して、考えています…（30秒〜1分半ほど）</p>}
      {job.state === 'failed' && <p className="err">答えられませんでした：{job.error}</p>}
      {a && (
        <>
          <div className="block conclusion">
            <b className="lbl">結論</b>
            <p>{a.conclusion}</p>
            {a.insufficient && <p className="note">※ 記事だけでは十分に答えられない質問でした。分かる範囲で答えています。</p>}
          </div>
          {a.points.length > 0 && (
            <div className="block">
              <b className="lbl">根拠のある要点</b>
              <ul className="plainlist">
                {a.points.map((p, i) => (
                  <li key={i}>
                    {p.text}{' '}
                    {p.cites.map((c) => (
                      <Cite key={c} n={c} onJump={jump} />
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {a.memoQuotes.length > 0 && (
            <div className="block memo">
              <b className="lbl">自分のメモから</b>
              {a.memoQuotes.map((m, i) => (
                <p key={i}>
                  「{m.quote}」 <Cite n={m.n} onJump={jump} />
                  <small className="sub"> {byN.get(m.n)?.company}</small>
                </p>
              ))}
            </div>
          )}
          {a.general && (
            <div className="block general">
              <b className="lbl">記事に基づかない一般的な知識（参考）</b>
              <p>{a.general}</p>
            </div>
          )}
          {a.followups.length > 0 && (
            <div className="block">
              <b className="lbl">次に聞くとよいこと</b>
              <div className="chips">
                {a.followups.map((f) => (
                  <button key={f} type="button" className="chip" onClick={() => onAsk(f)}>
                    {f}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="block">
            <b className="lbl">根拠の記事（答えに使った記事が先・残りは意味の近い順）</b>
            <ol className="sources">
              {sources.map((s) => (
                <li key={s.n} id={`src-${job.id}-${s.n}`} className={used.has(s.n) ? 'used' : ''}>
                  <span className="srcn">{s.n}</span>
                  <div>
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {s.title}
                    </a>
                    <div className="byline">
                      <a className="co" {...linkProps(`/c/${s.companyId}`)}>
                        {data.names[s.companyId] ?? s.company}
                      </a>
                      <span className="date">{fmtDate(s.publishedAt)}</span>
                      {s.read && <span className="badge stage">読んだ記事</span>}
                      {s.analyzed && !s.read && <span className="badge">整理済み</span>}
                    </div>
                    {s.memo && <p className="srcmemo">メモ：{s.memo}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </>
      )}
    </article>
  );
}

export function AskPage({ data }: { data: KbData }) {
  const [text, setText] = useState('');
  const [history, setHistory] = useState<AskJob[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // 質問の履歴（新しい順）
  useEffect(
    () =>
      onSnapshot(
        query(collection(db, 'kbJobs'), where('type', '==', 'ask'), limit(100)),
        (s) => setHistory(s.docs.map((d) => ({ ...(d.data() as Omit<AskJob, 'id'>), id: d.id })).sort((x, y) => atIso(y.at).localeCompare(atIso(x.at)) || (x.at ? 1 : -1))),
        () => setHistory([]),
      ),
    [],
  );
  const [live, setLive] = useState<AskJob | null>(null);
  useEffect(() => {
    if (!current) return setLive(null);
    return onSnapshot(doc(db, 'kbJobs', current), (s) => setLive(s.exists() ? { ...(s.data() as Omit<AskJob, 'id'>), id: s.id } : null));
  }, [current]);
  const shown = live ?? history[0] ?? null;

  const ask = async (q: string) => {
    const t = q.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      const r = await addDoc(collection(db, 'kbJobs'), { type: 'ask', q: t.slice(0, 600), state: 'ready', at: serverTimestamp() });
      setCurrent(r.id);
      setText('');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="cases">
      <aside className="filters open">
        <McpBox />
        <b className="lbl">これまでの質問</b>
        {history.length === 0 && <p className="note">まだ質問していません。</p>}
        {history.map((h) => (
          <button key={h.id} type="button" className="fopt hist" aria-pressed={shown?.id === h.id} onClick={() => setCurrent(h.id)}>
            <span>{h.q}</span>
            <span className="n">{h.state === 'done' ? fmtDate(atIso(h.at)) : h.state === 'failed' ? '失敗' : '考え中'}</span>
          </button>
        ))}
      </aside>
      <section className="results">
        <div className="card askbox">
          <textarea
            ref={boxRef}
            rows={3}
            placeholder="例：地方の製造業で DX に投資している会社の事例は？／シリーズA の会社が採用で困っていそうな兆しは？"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void ask(text);
              }
            }}
          />
          <div className="askacts">
            <small className="note">全記事（9月から）と読んだ記事・メモを根拠に答えます。1回20円ほど。Ctrl（⌘）＋Enter でも送れます。</small>
            <button type="button" className="btn primary" disabled={!text.trim() || sending} onClick={() => void ask(text)}>
              質問する
            </button>
          </div>
        </div>
        {shown && (
          <AnswerView
            job={shown}
            data={data}
            onAsk={(q) => {
              setText(q);
              boxRef.current?.focus();
            }}
          />
        )}
      </section>
    </div>
  );
}
