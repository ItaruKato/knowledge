import { useEffect, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { collection, getCountFromServer, getDocs, limit, orderBy, query } from 'firebase/firestore';
import { auth, db } from './firebase';
import { Login } from './components/Login';
import { isOwner } from './lib/owner';

interface Handoff {
  id: string;
  article?: { title?: string; company?: string; url?: string; publishedAt?: string };
  readAt?: string | null;
}

/** 最初の画面：Watcher から受け取った（読了にした）記事が見えるかの確認 */
function Home({ user }: { user: User }) {
  const [count, setCount] = useState<number | null>(null);
  const [recent, setRecent] = useState<Handoff[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const col = collection(db, 'handoff');
        setCount((await getCountFromServer(col)).data().count);
        const snap = await getDocs(query(col, orderBy('updatedAt', 'desc'), limit(10)));
        setRecent(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Handoff, 'id'>) })));
      } catch (e) {
        setErr(String(e));
      }
    })();
  }, []);
  return (
    <div className="page">
      <header className="pagehead">
        <b>Knowledge Base</b>
        <span className="meta">準備中</span>
        <button className="ghost" type="button" onClick={() => signOut(auth)}>
          ログアウト（{user.email}）
        </button>
      </header>
      <section className="card">
        <h2>Watcher から受け取った記事</h2>
        {err ? <p className="err">読み込めませんでした：{err}</p> : <p className="big">{count === null ? '…' : `${count.toLocaleString('ja-JP')} 件`}</p>}
        <ul className="plain">
          {recent.map((h) => (
            <li key={h.id}>
              <a href={h.article?.url} target="_blank" rel="noreferrer">
                {h.article?.title ?? h.id}
              </a>
              <small>{h.article?.company}</small>
            </li>
          ))}
        </ul>
      </section>
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
