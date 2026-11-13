import { useEffect, useMemo, useState } from 'react';
import { addDoc, collection, doc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { fmtDate, fmtTime, n } from '../lib/format';
import { linkProps } from '../lib/router';
import type { KbData } from '../data/useKb';

/**
 * デイリー（毎朝9時）とウィークリー（日曜21時）のレポート（kbReports。functions/src/reports.ts が作る）。
 * 「今すぐ作る」は kbJobs（type: report）に依頼する
 */

interface Art {
  id: string;
  title: string;
  company: string;
  companyId: string;
  url: string;
  publishedAt: string;
  tracked?: string;
}
interface Report {
  id: string;
  kind: 'daily' | 'weekly';
  date: string;
  from?: string;
  at?: string;
  note?: string;
  picks?: (Art & { reason: string; service: string })[];
  netas?: (Art & { talk: string; to: string })[];
  summary?: string;
  counts?: { articles?: number; byType?: Record<string, number>; reads?: number; themeGrowth?: Record<string, number> };
  best?: (Art & { why: string })[];
  companies?: (Art & { reason: string; service: string; action: string })[];
  cost?: { usdJpy: number; week: { kb: number; watcher: number }; month: { kb: number; watcher: number } };
  emailedAt?: string;
  emailError?: string | null;
}

/** メールで届けたか（届かなかったときは理由） */
function MailLine({ r }: { r: Report }) {
  if (r.emailError) return <small className="err">メールを送れませんでした：{r.emailError}</small>;
  if (r.emailedAt) return <small className="ver">{fmtTime(r.emailedAt)} にメールで送りました（本人あて）</small>;
  return null;
}

function ArtLine({ a, data }: { a: Art; data: KbData }) {
  return (
    <div className="byline">
      <a className="co" {...linkProps(`/c/${a.companyId}`)}>
        {data.names[a.companyId] ?? a.company}
      </a>
      <span className="date">{fmtDate(a.publishedAt)}</span>
      {a.tracked && <span className="badge stage">追っている会社（{a.tracked}）</span>}
    </div>
  );
}

const yen = (usd: number, rate: number) => `約${Math.round(usd * rate).toLocaleString('ja-JP')}円（$${usd.toFixed(2)}）`;

function Daily({ r, data }: { r: Report; data: KbData }) {
  return (
    <>
      <header className="themehead">
        <h2>デイリー：{r.date} の注目記事と今日の営業ネタ</h2>
        <small className="sub">
          昨日の記事 {n(r.counts?.articles ?? 0)} 件から · {fmtTime(r.at)} に作成
        </small>
        <MailLine r={r} />
      </header>
      {r.note && <p className="note">{r.note}</p>}
      {(r.netas ?? []).length > 0 && (
        <section className="card">
          <h3>今日の営業ネタ</h3>
          <div className="neta-list">
            {r.netas!.map((x, i) => (
              <div key={i} className="block talkbox">
                <p className="talkline">{x.talk}</p>
                <small className="sub">話す相手：{x.to}</small>
                <small className="sub">
                  根拠：
                  <a href={x.url} target="_blank" rel="noreferrer">
                    {x.title}
                  </a>
                </small>
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="card">
        <h3>昨日の注目記事（{r.picks?.length ?? 0}件）</h3>
        <ol className="sources">
          {(r.picks ?? []).map((p, i) => (
            <li key={p.id} className="used">
              <span className="srcn">{i + 1}</span>
              <div>
                <a href={p.url} target="_blank" rel="noreferrer">
                  {p.title}
                </a>
                <ArtLine a={p} data={data} />
                <p className="line">
                  <span className="badge ind">{p.service}</span> {p.reason}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function Weekly({ r, data }: { r: Report; data: KbData }) {
  const types = Object.entries(r.counts?.byType ?? {}).sort((a, b) => b[1] - a[1]);
  const themes = Object.entries(r.counts?.themeGrowth ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const c = r.cost;
  return (
    <>
      <header className="themehead">
        <h2>
          ウィークリー：{r.from} 〜 {r.date}
        </h2>
        <small className="sub">{fmtTime(r.at)} に作成</small>
        <MailLine r={r} />
      </header>
      <section className="card">
        <h3>今週のふりかえり</h3>
        {r.summary && <p className="sum">{r.summary}</p>}
        <div className="stats">
          <div>
            <span>読んだ記事</span>
            <b>{n(r.counts?.reads ?? 0)}</b>
          </div>
          <div>
            <span>今週の全記事（知識に入れない記事を除く）</span>
            <b>{n(r.counts?.articles ?? 0)}</b>
          </div>
        </div>
        {types.length > 0 && (
          <>
            <b className="lbl">記事の種類</b>
            <div className="facts">
              {types.map(([t, k]) => (
                <span key={t}>
                  <b>{t}</b>
                  {n(k)}
                </span>
              ))}
            </div>
          </>
        )}
        {themes.length > 0 && (
          <>
            <b className="lbl">読んだ記事で増えたテーマ</b>
            <div className="chips">
              {themes.map(([t, k]) => (
                <a key={t} className="chip" {...linkProps(`/themes/${t}`)}>
                  # {t}（+{k}）
                </a>
              ))}
            </div>
          </>
        )}
      </section>
      <section className="card">
        <h3>今週の事例ベスト</h3>
        <ol className="sources">
          {(r.best ?? []).map((b, i) => (
            <li key={b.id} className="used">
              <span className="srcn">{i + 1}</span>
              <div>
                <a href={b.url} target="_blank" rel="noreferrer">
                  {b.title}
                </a>
                <ArtLine a={b} data={data} />
                <p className="line">{b.why}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      <section className="card">
        <h3>来週動くとよい会社</h3>
        <ol className="sources">
          {(r.companies ?? []).map((x, i) => (
            <li key={x.id} className="used">
              <span className="srcn">{i + 1}</span>
              <div>
                <a className="co" {...linkProps(`/c/${x.companyId}`)}>
                  {data.names[x.companyId] ?? x.company}
                </a>
                {x.tracked && <span className="badge stage"> 追っている会社（{x.tracked}）</span>}
                <p className="line">
                  <span className="badge ind">{x.service}</span> {x.reason}
                </p>
                <p className="line">
                  <b>来週やること</b> {x.action}
                </p>
                <small className="sub">
                  根拠：
                  <a href={x.url} target="_blank" rel="noreferrer">
                    {x.title}
                  </a>
                </small>
              </div>
            </li>
          ))}
        </ol>
      </section>
      {c && (
        <section className="card">
          <h3>AI の費用</h3>
          <dl className="info">
            <div>
              <dt>今週（Knowledge Base）</dt>
              <dd>{yen(c.week.kb, c.usdJpy)}</dd>
            </div>
            <div>
              <dt>今週（Watcher・台帳）</dt>
              <dd>{yen(c.week.watcher, c.usdJpy)}</dd>
            </div>
            <div>
              <dt>今月の合計</dt>
              <dd>
                <b>{yen(c.month.kb + c.month.watcher, c.usdJpy)}</b>（Knowledge Base {yen(c.month.kb, c.usdJpy)}・Watcher・台帳 {yen(c.month.watcher, c.usdJpy)}）
              </dd>
            </div>
          </dl>
          <small className="ver">1ドル={c.usdJpy}円で計算した見積もりです（Anthropic の請求とは少し違うことがあります）</small>
        </section>
      )}
    </>
  );
}

export function ReportsPage({ data }: { data: KbData }) {
  const [reports, setReports] = useState<Report[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [job, setJob] = useState<{ id: string; kind: string; state?: string; error?: string } | null>(null);

  useEffect(
    () =>
      onSnapshot(
        collection(db, 'kbReports'),
        (s) => setReports(s.docs.map((d) => ({ ...(d.data() as Omit<Report, 'id'>), id: d.id })).sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))),
        () => setReports([]),
      ),
    [],
  );
  useEffect(() => {
    if (!job?.id) return;
    return onSnapshot(doc(db, 'kbJobs', job.id), (s) => setJob((j) => (j ? { ...j, state: s.get('state'), error: s.get('error') } : j)));
  }, [job?.id]);

  const shown = useMemo(() => reports.find((r) => r.id === sel) ?? reports[0], [reports, sel]);
  const make = async (kind: 'daily' | 'weekly') => {
    const r = await addDoc(collection(db, 'kbJobs'), { type: 'report', kind, state: 'ready', at: serverTimestamp() });
    setJob({ id: r.id, kind });
  };
  const busy = job && job.state !== 'done' && job.state !== 'failed';

  return (
    <div className="cases">
      <aside className="filters open">
        <b className="lbl">レポート</b>
        <p className="note">デイリーは毎朝9時、ウィークリーは日曜21時にできます。</p>
        <button type="button" className="ghost" disabled={Boolean(busy)} onClick={() => void make('daily')}>
          デイリーを今すぐ作る
        </button>
        <button type="button" className="ghost" disabled={Boolean(busy)} onClick={() => void make('weekly')}>
          ウィークリーを今すぐ作る
        </button>
        {busy && <p className="note">作っています…（1〜3分。1回 数十円。できたらメールでも送ります）</p>}
        {job?.state === 'failed' && <p className="err">作れませんでした：{job.error}</p>}
        {reports.length === 0 && <p className="note">まだレポートがありません。</p>}
        {reports.map((r) => (
          <button key={r.id} type="button" className="fopt" aria-pressed={shown?.id === r.id} onClick={() => setSel(r.id)}>
            <span>{r.kind === 'daily' ? `デイリー ${r.date}` : `ウィークリー 〜${r.date}`}</span>
          </button>
        ))}
      </aside>
      <section className="results">{shown ? shown.kind === 'daily' ? <Daily r={shown} data={data} /> : <Weekly r={shown} data={data} /> : null}</section>
    </div>
  );
}
