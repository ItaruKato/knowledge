import { useEffect, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { collection, getCountFromServer, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import { auth, db } from './firebase';
import { Login } from './components/Login';
import { isOwner } from './lib/owner';
import type { KbArticle } from './types';

const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) : '');

function ArticleCard({ a }: { a: KbArticle }) {
  const k = a.kb;
  return (
    <article className="card kbcard">
      <div className="badges">
        {k?.isCase && <span className="badge case">事例</span>}
        {k?.industry && <span className="badge">{k.industry}</span>}
        {k?.stage && k.stage !== '不明' && <span className="badge">{k.stage}</span>}
        {a.stars > 0 && <span className="stars">{'★'.repeat(a.stars)}</span>}
        {!k && <span className="badge wait">{a.state === 'failed' ? '整理をやり直し中' : '整理待ち'}</span>}
      </div>
      <a className="ttl" href={a.url} target="_blank" rel="noreferrer">
        {k?.caseTitle || a.title}
      </a>
      <small className="sub">
        {a.company} · {fmtDate(a.publishedAt)}
        {k?.caseTitle ? ` · ${a.title}` : ''}
      </small>
      {(k?.caseSummary || a.draft?.summary) && <p className="sum">{k?.caseSummary || a.draft?.summary}</p>}
      {k && k.challenges.length > 0 && (
        <p className="line">
          <b>課題・狙い</b> {k.challenges.join('・')}
          {k.challengeNote ? `：${k.challengeNote}` : ''}
        </p>
      )}
      {k && k.talk.length > 0 && (
        <ul className="talk">
          {k.talk.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      )}
      {a.memo && <p className="memo">{a.memo}</p>}
      {a.themes && a.themes.length > 0 && (
        <div className="chips">
          {a.themes.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

function Home({ user }: { user: User }) {
  const [counts, setCounts] = useState<{ handoff: number; kb: number; themes: number } | null>(null);
  const [items, setItems] = useState<KbArticle[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const [h, k, t, snap] = await Promise.all([
          getCountFromServer(collection(db, 'handoff')),
          getCountFromServer(query(collection(db, 'kbArticles'), where('state', '==', 'done'))),
          getCountFromServer(collection(db, 'kbThemes')),
          getDocs(query(collection(db, 'kbArticles'), orderBy('readAt', 'desc'), limit(50))),
        ]);
        setCounts({ handoff: h.data().count, kb: k.data().count, themes: t.data().count });
        setItems(snap.docs.map((d) => ({ ...(d.data() as KbArticle), id: d.id })));
      } catch (e) {
        setErr(String(e));
      }
    })();
  }, []);
  const n = (x: number) => x.toLocaleString('ja-JP');
  return (
    <div className="page">
      <header className="pagehead">
        <b>Knowledge Base</b>
        <span className="meta">読んだ記事</span>
        <button className="ghost" type="button" onClick={() => signOut(auth)}>
          ログアウト
        </button>
      </header>
      {err && <p className="err">読み込めませんでした：{err}</p>}
      {counts && (
        <section className="stats">
          <div>
            <span>受け取った記事</span>
            <b>{n(counts.handoff)}</b>
          </div>
          <div>
            <span>整理した記事</span>
            <b>{n(counts.kb)}</b>
          </div>
          <div>
            <span>テーマ</span>
            <b>{n(counts.themes)}</b>
          </div>
        </section>
      )}
      {counts && counts.handoff > counts.kb && (
        <p className="note">Watcher で読了にした記事は、10分以内にここへ取り込まれ、AI が整理します。</p>
      )}
      {items.map((a) => (
        <ArticleCard key={a.id} a={a} />
      ))}
      <footer className="foot">{user.email}</footer>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => onAuthStateChanged(auth, setUser), []);
  if (user === undefined) return <div className="login">読み込み中…</div>;
  if (!user || !isOwner(user)) return <Login auth={auth} wrongUser={user} />;
  return <Home user={user} />;
}
