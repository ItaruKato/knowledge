import { useEffect, useMemo, useState } from 'react';
import { addDoc, collection, doc, getDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { fmtDate, fmtTime, n } from '../lib/format';
import { articleUrl, companyPrtimesUrl, yen } from '../lib/money';
import { linkProps } from '../lib/router';
import type { KbData } from '../data/useKb';

/* 台帳（prtimes-inbox の companies・companyArticles）は読むだけ。形は prtimes-inbox の functions/src/company.ts・gbiz.ts */
interface Ledger {
  name?: string;
  corporateNumber?: string;
  profile?: Record<string, string | undefined>;
  gbiz?: { name?: string; representative?: string; capital?: number; employees?: number; established?: string; foundingYear?: number; url?: string; summary?: string; location?: string; status?: string; closeDate?: string };
  gbizInsured?: { total?: number; updated?: string };
  gbizFinance?: { year?: string; sales?: { raw: string; unit?: string; yen?: number }; ordinaryIncome?: { raw: string; unit?: string; yen?: number }; netIncome?: { raw: string; unit?: string; yen?: number } };
}
interface KbCompany {
  state?: 'working' | 'done' | 'failed';
  at?: string;
  error?: string;
  ai?: {
    summary: string;
    recent: string[];
    events: { date: string; type: string; title: string; amount: string; counterpart: string; articleId: string }[];
    angles: string[];
    fits: { service: string; reason: string }[];
  };
}

const money = (m?: { raw: string; unit?: string; yen?: number }) => (m ? (m.yen !== undefined ? yen(m.yen) : `${m.raw}${m.unit ?? ''}`) : '');

/** 会社ページ（/c/{会社ID}）。Long List からのリンク先にもなる */
export function CompanyPage({ data, cid }: { data: KbData; cid: string }) {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [timeline, setTimeline] = useState<{ id: string; t: string; p: string }[]>([]);
  const [kbc, setKbc] = useState<KbCompany | null>(null);
  const [ll, setLl] = useState<Record<string, unknown> | null | 'none'>(null);
  const [asked, setAsked] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLedger(null);
    setTimeline([]);
    setAsked(false);
    (async () => {
      try {
        const [c, ca] = await Promise.all([getDoc(doc(db, 'companies', cid)), getDoc(doc(db, 'companyArticles', cid))]);
        setLedger((c.data() as Ledger | undefined) ?? { name: (ca.get('name') as string | undefined) ?? '' });
        const a = (ca.get('a') ?? {}) as Record<string, { t?: string; p?: string }>;
        setTimeline(Object.entries(a).map(([id, v]) => ({ id, t: String(v.t ?? ''), p: String(v.p ?? '') })).sort((x, y) => y.p.localeCompare(x.p)));
      } catch (e) {
        setErr(String(e));
      }
      // Long List（まだないとき・読めないときは出さない）
      try {
        const l = await getDoc(doc(db, 'longlist', cid));
        setLl(l.exists() ? (l.data() as Record<string, unknown>) : 'none');
      } catch {
        setLl('none');
      }
    })();
    return onSnapshot(
      doc(db, 'kbCompanies', cid),
      (s) => setKbc((s.data() as KbCompany | undefined) ?? {}),
      () => setKbc({}),
    );
  }, [cid]);

  const reads = useMemo(() => data.articles.filter((a) => a.companyId === cid), [data.articles, cid]);
  const readIds = new Set(reads.map((a) => a.id));
  const p = ledger?.profile ?? {};
  const g = ledger?.gbiz ?? {};
  const name = ledger?.name || reads[0]?.company || `会社 ${cid}`;
  const industry = reads.find((a) => a.kb?.industry)?.kb?.industry;
  const stage = reads.find((a) => a.kb?.stage && a.kb.stage !== '不明')?.kb?.stage;

  const ask = async () => {
    setAsked(true);
    await addDoc(collection(db, 'kbJobs'), { type: 'company', id: cid, redo: true, state: 'ready', at: serverTimestamp() });
  };

  const rows: [string, string | undefined][] = [
    ['代表者', p.representative || g.representative],
    ['所在地', p.address || g.location],
    ['設立', p.established || g.established],
    ['資本金', p.capital || yen(g.capital)],
    ['従業員数', g.employees !== undefined ? `${n(g.employees)}人` : undefined],
    ['厚生年金の被保険者数', ledger?.gbizInsured?.total !== undefined ? `${n(ledger.gbizInsured.total)}人${ledger.gbizInsured.updated ? `（${ledger.gbizInsured.updated}）` : ''}` : undefined],
    ['売上高', money(ledger?.gbizFinance?.sales) ? `${money(ledger?.gbizFinance?.sales)}${ledger?.gbizFinance?.year ? `（${ledger.gbizFinance.year}）` : ''}` : undefined],
    ['経常利益', money(ledger?.gbizFinance?.ordinaryIncome)],
    ['上場', p.listed],
    ['業種（PR TIMES）', p.industry],
    ['代表電話', p.phone],
    ['法人番号', ledger?.corporateNumber],
    ['事業概要', g.summary],
  ];
  const ai = kbc?.ai;
  const working = kbc?.state === 'working' || (asked && kbc?.state !== 'done' && kbc?.state !== 'failed');

  return (
    <div className="company">
      <header className="themehead">
        <a className="ghost" {...linkProps('/companies')}>
          ← 会社
        </a>
        <h2>{name}</h2>
        <div className="badges">
          {industry && <span className="badge">{industry}</span>}
          {stage && <span className="badge">{stage}</span>}
          {p.listed && <span className="badge">{p.listed}</span>}
          {g.closeDate && <span className="badge wait">閉鎖 {g.closeDate}</span>}
        </div>
        <small className="sub">
          {(p.url || g.url) && (
            <>
              <a href={p.url || g.url} target="_blank" rel="noreferrer">
                会社のサイト
              </a>
              {' · '}
            </>
          )}
          <a href={companyPrtimesUrl(cid)} target="_blank" rel="noreferrer">
            PR TIMES の企業ページ
          </a>
        </small>
      </header>
      {err && <p className="err">読み込めませんでした：{err}</p>}

      <div className="cgrid">
        <div className="col">
          <section className="card">
            <div className="sechead">
              <h3>AI のまとめ</h3>
              <button type="button" className="ghost" disabled={working} onClick={ask}>
                {working ? 'まとめています…' : ai ? 'まとめ直す' : 'AI でまとめる'}
              </button>
            </div>
            {kbc?.state === 'failed' && <p className="err">まとめられませんでした：{kbc.error}</p>}
            {!ai && !working && <p className="note">読んだ記事を整理すると自動でまとめます。いますぐ作るときは「AI でまとめる」を押してください。</p>}
            {ai && (
              <>
                <p className="sum">{ai.summary}</p>
                {ai.angles.length > 0 && (
                  <>
                    <b className="lbl">営業の切り口</b>
                    <ul className="talk">
                      {ai.angles.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  </>
                )}
                {ai.fits.length > 0 && (
                  <>
                    <b className="lbl">相性のよいサービス</b>
                    <ul className="plainlist">
                      {ai.fits.map((f, i) => (
                        <li key={i}>
                          <b>{f.service}</b>：{f.reason}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {ai.recent.length > 0 && (
                  <>
                    <b className="lbl">最近の動き</b>
                    <ul className="plainlist">
                      {ai.recent.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  </>
                )}
                <small className="ver">AIのまとめ · {fmtTime(kbc?.at)} · PR TIMES の記事と読んだ記事をもとに作成</small>
              </>
            )}
          </section>

          <section className="card">
            <h3>調達・M&A などの履歴</h3>
            {!ai?.events.length ? (
              <p className="note">{ai ? '記事から拾える出来事はありませんでした。' : 'AI のまとめを作ると、記事から拾って並べます。'}</p>
            ) : (
              <ol className="events">
                {ai.events.map((e, i) => (
                  <li key={i}>
                    <span className="date">{e.date}</span>
                    <span className="badge">{e.type}</span>
                    <span>
                      <a href={articleUrl(e.articleId)} target="_blank" rel="noreferrer">
                        {e.title}
                      </a>
                      {e.amount && <b> {e.amount}</b>}
                      {e.counterpart && <small className="sub">（{e.counterpart}）</small>}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="card">
            <h3>自分のメモと接点</h3>
            {ll && ll !== 'none' && (
              <p className="line">
                <b>Long List</b> 温度感 {String(ll.temperature ?? '—')} · 進捗 {String(ll.progress ?? '—')}
              </p>
            )}
            {reads.length === 0 ? (
              <p className="note">この会社の記事はまだ読了にしていません。</p>
            ) : (
              <ul className="plainlist">
                {reads.map((a) => (
                  <li key={a.id}>
                    <small className="sub">
                      {fmtDate(a.readAt)} に読了{a.stars ? ` · ${'★'.repeat(a.stars)}` : ''}
                    </small>
                    <a href={a.url} target="_blank" rel="noreferrer">
                      {a.kb?.caseTitle || a.title}
                    </a>
                    {a.memo && <p className="memo">{a.memo}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="col">
          <section className="card">
            <h3>基本情報</h3>
            {!ledger ? (
              <p className="note">読み込み中…</p>
            ) : (
              <dl className="info">
                {rows
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
              </dl>
            )}
            <small className="ver">
              出典：PR TIMES の企業情報{ledger?.gbiz ? '、「Gビズインフォ」（経済産業省）（https://info.gbiz.go.jp/）をもとに作成' : ''}
            </small>
          </section>

          <section className="card">
            <h3>PR TIMES の記事（{n(timeline.length)}件）</h3>
            <ul className="timeline">
              {timeline.map((t) => (
                <li key={t.id} className={readIds.has(t.id) ? 'read' : ''}>
                  <span className="date">{t.p.slice(0, 10)}</span>
                  <a href={articleUrl(t.id)} target="_blank" rel="noreferrer">
                    {t.t}
                  </a>
                  {readIds.has(t.id) && <span className="badge">読了</span>}
                </li>
              ))}
            </ul>
            <small className="ver">2025年11月以降の記事</small>
          </section>
        </div>
      </div>
    </div>
  );
}
