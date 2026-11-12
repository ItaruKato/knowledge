import { useState } from 'react';
import { GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut, type Auth, type User } from 'firebase/auth';
import { OWNER_EMAIL } from '../lib/owner';

export function Login({ auth, wrongUser }: { auth: Auth; wrongUser: User | null }) {
  const [err, setErr] = useState<string | null>(null);
  const login = async () => {
    setErr(null);
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ login_hint: OWNER_EMAIL, prompt: 'select_account' });
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      // ホーム画面アプリなどでポップアップが使えないときはページ移動でログイン
      if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
        await signInWithRedirect(auth, provider);
        return;
      }
      if (code === 'auth/unauthorized-domain') setErr('このサイトはまだログインの許可（承認済みドメイン）に入っていません。');
      else if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') setErr('ログインできませんでした。もう一度お試しください。');
    }
  };
  return (
    <div className="login">
      <div className="logincard">
        <b>Knowledge Base</b>
        {wrongUser ? (
          <>
            <p>
              {wrongUser.email} では使えません。
              <br />
              {OWNER_EMAIL} でログインしてください。
            </p>
            <button className="btn" type="button" onClick={() => signOut(auth)}>別のアカウントでログイン</button>
          </>
        ) : (
          <>
            <p>自分専用のアプリです。Googleアカウントでログインしてください。</p>
            <button className="btn primary" type="button" onClick={login}>Googleでログイン</button>
          </>
        )}
        {err && <p className="err">{err}</p>}
      </div>
    </div>
  );
}
