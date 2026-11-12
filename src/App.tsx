import { lazy, Suspense, useEffect, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { auth } from './firebase';
import { Login } from './components/Login';
import { isOwner } from './lib/owner';
import { fmtTime } from './lib/format';
import { linkProps, useRoute } from './lib/router';
import { useKb } from './data/useKb';
import { SearchBox } from './components/SearchBox';

// 3D の部品は大きいので、「つながり」を開いたときだけ読み込む
const GraphPage = lazy(() => import('./pages/GraphPage'));
import { ArticlesPage } from './pages/ArticlesPage';
import { CasesPage } from './pages/CasesPage';
import { ThemesPage } from './pages/ThemesPage';
import { CompaniesPage } from './pages/CompaniesPage';
import { CompanyPage } from './pages/CompanyPage';

const TABS = [
  { path: '/', label: '読んだ記事' },
  { path: '/cases', label: '先行事例' },
  { path: '/themes', label: 'ネタ帳' },
  { path: '/companies', label: '会社' },
  { path: '/graph', label: 'つながり' },
];

const PLACEHOLDER: Record<string, string> = {
  '/': '読んだ記事を探す（会社・見出し・メモ・トーク例…）',
  '/cases': '事例を探す（会社・見出し・メモ・トーク例…）',
  '/themes': 'テーマ・ネタを探す',
  '/companies': '会社を探す（会社名・業界）',
  '/graph': 'つながりの中で探す（当てはまる丸を光らせる）',
};

function Home({ user }: { user: User }) {
  const path = useRoute();
  const { data, error } = useKb();
  // 検索した言葉（タブを切り替えても残す。× で一度に消せる）
  const [q, setQ] = useState('');
  const tab = path.startsWith('/cases')
    ? '/cases'
    : path.startsWith('/themes')
      ? '/themes'
      : path.startsWith('/companies') || path.startsWith('/c/')
        ? '/companies'
        : path.startsWith('/graph')
          ? '/graph'
          : '/';
  const cid = /^\/c\/(\d{1,12})$/.exec(path)?.[1] ?? null;
  const theme = path.startsWith('/themes/') ? path.slice('/themes/'.length) || null : null;
  return (
    <div className={`page ${tab === '/' ? '' : 'wide'} ${tab === '/graph' ? 'full' : ''}`}>
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
      <SearchBox value={q} onChange={setQ} placeholder={PLACEHOLDER[tab]} />
      {error && <p className="err">読み込めませんでした：{error}</p>}
      {!data && !error && <p className="note">読み込み中…</p>}
      {data && tab === '/' && <ArticlesPage data={data} q={q} />}
      {data && tab === '/cases' && <CasesPage data={data} q={q} />}
      {data && tab === '/themes' && <ThemesPage data={data} theme={theme} q={q} />}
      {data && tab === '/graph' && (
        <Suspense fallback={<p className="note">つながりの図を読み込み中…</p>}>
          <GraphPage data={data} q={q} />
        </Suspense>
      )}
      {data && tab === '/companies' && (cid ? <CompanyPage data={data} cid={cid} q={q} /> : <CompaniesPage data={data} q={q} />)}
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
