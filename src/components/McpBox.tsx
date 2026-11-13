import { useEffect, useState } from 'react';
import { addDoc, collection, doc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { fmtTime } from '../lib/format';
import { MCP_URL } from '../lib/mcp';

/** Claude のチャットとつなぐ：窓口の住所と、全部の接続を切るボタン */
export function McpBox() {
  const [meta, setMeta] = useState<{ lastUsedAt?: string } | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [done, setDone] = useState<string>('');
  useEffect(() => onSnapshot(doc(db, 'kbMeta', 'mcp'), (s) => setMeta((s.data() as { lastUsedAt?: string } | undefined) ?? {}), () => setMeta({})), []);
  useEffect(() => {
    if (!job) return;
    return onSnapshot(doc(db, 'kbJobs', job), (s) => s.get('state') === 'done' && setDone('全部の接続を切りました。Claude でまた使うときは、つなぎ直してください。'));
  }, [job]);
  return (
    <div className="facet mcpbox">
      <b>Claude のチャットとつなぐ</b>
      <small className="sub">claude.ai の「設定 → コネクタ → カスタムコネクタを追加」に、この住所を入れます（ログインは本人だけ。読むだけ）。</small>
      <code className="mcpurl">{MCP_URL}</code>
      {meta?.lastUsedAt && <small className="ver">最後に使われた時刻：{fmtTime(meta.lastUsedAt)}</small>}
      <button
        type="button"
        className="ghost"
        onClick={async () => {
          if (!confirm('Claude との接続を全部切りますか？（つなぎ直せば、また使えます）')) return;
          const r = await addDoc(collection(db, 'kbJobs'), { type: 'mcp_revoke', state: 'ready', at: serverTimestamp() });
          setJob(r.id);
        }}
      >
        全部の接続を切る
      </button>
      {done && <small className="note">{done}</small>}
    </div>
  );
}
