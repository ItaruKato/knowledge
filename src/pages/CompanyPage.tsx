import { useEffect, useMemo, useState } from 'react';
import { addDoc, collection, doc, getDoc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { fmtDate, fmtTime, n } from '../lib/format';
import { articleUrl, companyPrtimesUrl, yen } from '../lib/money';
import { linkProps } from '../lib/router';
import type { KbData } from '../data/useKb';
import { officialName } from '../lib/names';

/* 台帳（prtimes-inbox の companies・companyArticles）は読むだけ。形は prtimes-inbox の functions/src/company.ts・gbiz.ts */
interface Ledger {
  name?: string;
  corporateNumber?: string;
  profile?: Record<string, string | undefined>;
  gbiz?: { name?: string; representative?: string; capital?: number; employees?: number; established?: string; foundingYear?: number; url?: string; summary?: string; location?: string; status?: string; closeDate?: string };
  gbizInsured?: { total?: number; updated?: string };
  /** 会社 HP から拾った項目（prtimes-inbox の functions/src/web.ts） */
  web?: WebInfo;
  webAt?: string;
  gbizFinance?: { year?: string; sales?: { raw: string; unit?: string; yen?: number }; ordinaryIncome?: { raw: string; unit?: string; yen?: number }; netIncome?: { raw: string; unit?: string; yen?: number } };
}
interface WebItem {
  value: string;
  asOf: string;
  source: string;
}
interface WebInfo {
  state?: 'done' | 'nosite' | 'blocked' | 'failed';
  url?: string;
  urlFrom?: 'profile' | 'gbiz' | 'search';
  at?: string;
  error?: string;
  officialName?: WebItem | null;
  address?: WebItem | null;
  employees?: WebItem | null;
  capital?: WebItem | null;
  sales?: WebItem | null;
}
const URL_FROM: Record<string, string> = { profile: 'PR TIMES の企業情報', gbiz: 'gBizINFO', search: 'AI の Web 検索で見つけた' };

/** 会社 HP から拾った項目（出どころのページと時点つき）と、読み込みの依頼 */
function WebSection({ cid, web, queued }: { cid: string; web?: WebInfo; queued: boolean }) {
  const [asked, setAsked] = useState(false);
  const ask = async () => {
    setAsked(true);
    // webQueue は台帳の HP 読み込みの依頼口（prtimes-inbox の docs/plan.md）。5分ごとに処理される
    // HP の読み込み・Web 検索は費用がかかるので、ボタンを押したときだけ（manual: true の依頼だけ台帳が処理する）
    await setDoc(doc(db, 'webQueue', cid), { at: serverTimestamp(), by: 'knowledge', redo: true, manual: true }, { merge: true });
  };
  const waiting = queued || asked;
  const items: [string, WebItem | null | undefined][] = [
    ['正式な会社名', web?.officialName],
    ['所在地', web?.address],
    ['従業員数', web?.employees],
    ['資本金', web?.capital],
    ['売上高', web?.sales],
  ];
  return (
    <section className="card">
      <div className="sechead">
        <h3>HP の情報</h3>
        <button type="button" className="ghost" disabled={waiting} onClick={ask}>
          {waiting ? '読み込み待ち…' : web?.state ? 'HP を読み直す' : 'HP から肉付け'}
        </button>
      </div>
      {waiting && <p className="note">HP の読み込みを頼みました。5分ごとに順番に読み、1社1〜2分かかります（このページを開いたままで出てきます）。</p>}
      {!web?.state && !waiting && (
        <p className="note">まだ HP を読んでいません。読むときは「HP から肉付け」を押してください（費用がかかるので、押したときだけ HP を読み・Web で探します。1社15〜30円ほど）。</p>
      )}
      {web?.state === 'nosite' && <p className="note">公式サイトが見つかりませんでした。</p>}
      {web?.state === 'blocked' && <p className="note">この会社の HP は自動での読み込みを断っている（robots.txt）ため、読んでいません。</p>}
      {web?.state === 'failed' && <p className="err">読めませんでした：{web.error}</p>}
      {web?.state === 'done' && (
        <>
          <dl className="info">
            {items.map(([k, i]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>
                  {i?.value ? (
                    <>
                      {i.value}
                      {i.asOf && <small className="sub">（{i.asOf}）</small>}{' '}
                      <a className="src" href={i.source} target="_blank" rel="noreferrer">
                        出どころ
                      </a>
                    </>
                  ) : (
                    <span className="sub">HP に書いてありません</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <small className="ver">
            <a href={web.url} target="_blank" rel="noreferrer">
              {web.url}
            </a>
            （{URL_FROM[web.urlFrom ?? ''] ?? ''}）· {fmtTime(web.at)} に読んだ · AI が HP から書き写したもの
          </small>
        </>
      )}
    </section>
  );
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
    /** v2 から：ビジネス（事業）と資本関係 */
    businesses?: string[];
    capital?: { counterpart: string; relation: string; date: string; articleId: string }[];
  };
}

const money = (m?: { raw: string; unit?: string; yen?: number }) => (m ? (m.yen !== undefined ? yen(m.yen) : `${m.raw}${m.unit ?? ''}`) : '');

/** 会社ページ（/c/{会社ID}）。Long List からのリンク先にもなる */
export function CompanyPage({ data, cid, q }: { data: KbData; cid: string; q: string }) {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [timeline, setTimeline] = useState<{ id: string; t: string; p: string }[]>([]);
  const [kbc, setKbc] = useState<KbCompany | null>(null);
  const [ll, setLl] = useState<Record<string, unknown> | null | 'none'>(null);
  const [queued, setQueued] = useState(false);
  const [asked, setAsked] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLedger(null);
    setTimeline([]);
    setAsked(false);
    (async () => {
      try {
        const ca = await getDoc(doc(db, 'companyArticles', cid));
        setLedger((prev) => prev ?? { name: (ca.get('name') as string | undefined) ?? '' });
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
    // 台帳・AI のまとめ・HP の依頼は、変わったらすぐ画面に出す
    const offs = [
      onSnapshot(
        doc(db, 'companies', cid),
        (s) => s.exists() && setLedger(s.data() as Ledger),
        (e) => setErr(String(e)),
      ),
      onSnapshot(
        doc(db, 'kbCompanies', cid),
        (s) => setKbc((s.data() as KbCompany | undefined) ?? {}),
        () => setKbc({}),
      ),
      onSnapshot(
        doc(db, 'webQueue', cid),
        (s) => setQueued(s.exists()),
        () => setQueued(false),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [cid]);

  const reads = useMemo(() => data.articles.filter((a) => a.companyId === cid), [data.articles, cid]);
  // 上の検索窓の言葉で、PR TIMES の記事のタイトルを絞る
  const shownTimeline = useMemo(() => {
    const words = q.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? timeline.filter((t) => words.every((w) => t.t.normalize('NFKC').toLowerCase().includes(w))) : timeline;
  }, [timeline, q]);
  const readIds = new Set(reads.map((a) => a.id));
  const p = ledger?.profile ?? {};
  const g = ledger?.gbiz ?? {};
  const prName = ledger?.name || reads[0]?.company || '';
  // 正式な会社名（HP・gBizINFO）が分かれば、それを見出しにする。PR TIMES の名前は小さく添える
  const official = officialName(prName, ledger ?? undefined);
  const name = official || prName || `会社 ${cid}`;
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
        {official && official !== prName && <small className="sub">PR TIMES での名前：{prName}</small>}
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
                {(ai.businesses ?? []).length > 0 && (
                  <div className="chips">
                    {ai.businesses!.map((b) => (
                      <a key={b} className="chip biz" {...linkProps('/graph')} title="つながりの図で、同じビジネスの会社を見る">
                        {b}
                      </a>
                    ))}
                  </div>
                )}
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

          {(ai?.capital ?? []).length > 0 && (
            <section className="card">
              <h3>資本関係</h3>
              <ol className="events">
                {ai!.capital!.map((c, i) => (
                  <li key={i}>
                    <span className="date">{c.date}</span>
                    <span className="badge cap">{c.relation}</span>
                    <span>
                      <b>{c.counterpart}</b>{' '}
                      <a className="src" href={articleUrl(c.articleId)} target="_blank" rel="noreferrer">
                        根拠の記事
                      </a>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}

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
          <WebSection cid={cid} web={ledger?.web} queued={queued} />

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
            {q.trim() && <p className="hits">「{q.trim()}」を含む記事：{n(shownTimeline.length)} 件</p>}
            <ul className="timeline">
              {shownTimeline.map((t) => (
                <li key={t.id} className={readIds.has(t.id) ? 'read' : ''}>
                  <span className="date">{t.p.slice(0, 10)}</span>
                  <a href={articleUrl(t.id)} target="_blank" rel="noreferrer">
                    {t.t}
                  </a>
                  {readIds.has(t.id) && <span className="badge">読了</span>}
                </li>
              ))}
            </ul>
            <small className="ver">2025年1月以降の記事（台帳がさかのぼった分）</small>
          </section>
        </div>
      </div>
    </div>
  );
}
