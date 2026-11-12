import { useEffect, useState } from 'react';
import { collection, doc, getCountFromServer, getDoc, getDocs, query } from 'firebase/firestore';
import { db } from '../firebase';
import type { IngestStatus, KbArticle, KbTheme } from '../types';
import { toIso } from '../lib/time';

export interface KbData {
  articles: KbArticle[];
  themes: KbTheme[];
  handoffCount: number;
  status: IngestStatus;
}

/**
 * Knowledge Base のデータをまとめて読む（いまは読んだ記事だけなので一度に読む。本文は kbBodies にあり、ここでは読まない）。
 * 全記事に広げるときは、絞り込みを Firestore の問い合わせに移す。
 */
export function useKb(): { data: KbData | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<KbData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [a, t, h, st] = await Promise.all([
          getDocs(query(collection(db, 'kbArticles'))),
          getDocs(collection(db, 'kbThemes')),
          getCountFromServer(collection(db, 'handoff')),
          getDoc(doc(db, 'kbMeta', 'ingest')),
        ]);
        if (!alive) return;
        setData({
          articles: a.docs
            .map((d) => {
              const v = d.data();
              // 日時は Firestore の Timestamp で入っていることがあるので、文字にそろえる
              return { ...(v as KbArticle), id: d.id, readAt: toIso(v.readAt), publishedAt: toIso(v.publishedAt) ?? '', analyzedAt: toIso(v.analyzedAt) ?? undefined };
            })
            .sort((x, y) => (y.readAt ?? '').localeCompare(x.readAt ?? '')),
          themes: t.docs.map((d) => ({ ...(d.data() as KbTheme), name: String(d.get('name') ?? d.id) })),
          handoffCount: h.data().count,
          status: (st.data() as IngestStatus | undefined) ?? {},
        });
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [tick]);
  return { data, error, reload: () => setTick((x) => x + 1) };
}
