import { useEffect, useState } from 'react';
import { addDoc, collection, doc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { safeBack } from '../lib/mcp';

/**
 * Claude のチャットの窓口（MCP）のログインの確認（/mcp-login?rid=…&client=…&back=…）。
 * 本人が「許可する」を押すと kbJobs（type: mcp_approve）に書き（ルールで本人しか書けない）、関数が許可を記録したら窓口へ戻る
 */

export function McpLoginPage() {
  const p = new URLSearchParams(location.search);
  const rid = p.get('rid') ?? '';
  const client = (p.get('client') ?? 'Claude').slice(0, 60);
  const back = safeBack(p.get('back'));
  const [jobId, setJobId] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'working' | 'expired' | 'error'>('idle');

  useEffect(() => {
    if (!jobId) return;
    return onSnapshot(doc(db, 'kbJobs', jobId), (s) => {
      const st = s.get('state');
      if (st === 'done') {
        if (s.get('result') === 'approved' && back) location.href = `${back}?rid=${encodeURIComponent(rid)}`;
        else setState('expired');
      } else if (st === 'failed') setState('error');
    });
  }, [jobId, back, rid]);

  if (!/^[0-9a-f]{32}$/.test(rid) || !back) return <div className="page"><p className="err">ログインの依頼が正しくありません。Claude からもう一度つないでください。</p></div>;

  return (
    <div className="login">
      <div className="logincard">
        <b>Claude に Knowledge Base を読ませますか？</b>
        <p>
          「{client}」が、Knowledge Base（記事・事例・ネタ帳・会社ページ・自分のメモ・Long List の温度感と進捗・レポート）を<b>読む</b>ことを求めています。書き換えはできません。
        </p>
        <p className="note">※ いま Claude でコネクタを追加した（つなぎ直した）ところでなければ、「許可しない」を押してください。</p>
        {state === 'expired' && <p className="err">期限が切れました（10分）。Claude からもう一度つないでください。</p>}
        {state === 'error' && <p className="err">うまくいきませんでした。Claude からもう一度つないでください。</p>}
        <button
          className="btn primary"
          type="button"
          disabled={state === 'working'}
          onClick={async () => {
            setState('working');
            const r = await addDoc(collection(db, 'kbJobs'), { type: 'mcp_approve', rid, state: 'ready', at: serverTimestamp() });
            setJobId(r.id);
          }}
        >
          {state === 'working' ? '許可しています…' : '許可する'}
        </button>
        <button className="btn" type="button" onClick={() => (location.href = `${back}?rid=${encodeURIComponent(rid)}&deny=1`)}>
          許可しない
        </button>
      </div>
    </div>
  );
}
