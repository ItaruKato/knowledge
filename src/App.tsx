import { useEffect, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { auth } from './firebase';
import { Login } from './components/Login';
import { isOwner } from './lib/owner';
import { fmtTime } from './lib/format';
import { linkProps, useRoute } from './lib/router';
import { useKb } from './data/useKb';
import { ArticlesPage } from './pages/ArticlesPage';
import { CasesPage } from './pages/CasesPage';
import { ThemesPage } from './pages/ThemesPage';

const TABS = [
  { path: '/', label: '読んだ記事' },
  { path: '/cases', label: '先行事例' },
  { path: '/themes', label: 'ネタ帳' },
];

function Home({ user }: { user: User }) {
  const path = useRoute();
  const { data, error } = useKb();
  const tab = path.startsWith('/cases') ? '/cases' : path.startsWith('/themes') ? '/themes' : '/';
  const theme = path.startsWith('/themes/') ? path.slice('/themes/'.length) || null : null;
  return (
    <div className={`page ${tab === '/' ? '' : 'wide'}`}>
      <header className="pagehead">
        <b>Knowledge Base</b>
        <span className="meta" title={__COMMIT__ ? `コミット ${__COMMIT__}` : undefined}>
          v{__APP_VERSION__} · 最終更新 {fmtTime(__BUILD_TIME__)}
        </span>
        <button className="ghost" type="button" onClick={() => signOut(auth)}>
          ログアウト
        </button>
      </header>
      <nav className="tabs">
        {TABS.map((t) => (
          <a key={t.path} aria-current={tab === t.path ? 'page' : undefined} {...linkProps(t.path)}>
            {t.label}
          </a>
        ))}
      </nav>
      {error && <p className="err">読み込めませんでした：{error}</p>}
      {!data && !error && <p className="note">読み込み中…</p>}
      {data && tab === '/' && <ArticlesPage data={data} />}
      {data && tab === '/cases' && <CasesPage data={data} />}
      {data && tab === '/themes' && <ThemesPage data={data} theme={theme} />}
      <footer className="foot">
        Knowledge Base v{__APP_VERSION__}
        {__COMMIT__ ? `（${__COMMIT__}）` : ''} · 最終更新 {fmtTime(__BUILD_TIME__)} · {user.email}
      </footer>
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
