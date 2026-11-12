import { useEffect, useState } from 'react';
import { collection, doc, documentId, getCountFromServer, getDoc, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import type { IngestStatus, KbArticle, KbCompanyInfo, KbTheme } from '../types';
import { toIso } from '../lib/time';
import { officialName } from '../lib/names';

export interface KbData {
  articles: KbArticle[];
  themes: KbTheme[];
  handoffCount: number;
  status: IngestStatus;
  /** 会社ID → 画面に出す会社名（正式名が分かれば正式名。src/lib/names.ts） */
  names: Record<string, string>;
  /** 会社ID → 会社の AI のまとめのビジネスと資本関係（つながりの図で使う） */
  companies: Record<string, KbCompanyInfo>;
}

/** 会社IDごとの正式名を、台帳（companies）から30社ずつ読む */
async function loadNames(arts: KbArticle[]): Promise<Record<string, string>> {
  const pr = new Map(arts.map((a) => [a.companyId, a.company]));
  const ids = [...pr.keys()].filter(Boolean);
  const out: Record<string, string> = {};
  for (let i = 0; i < ids.length; i += 30) {
    const snap = await getDocs(query(collection(db, 'companies'), where(documentId(), 'in', ids.slice(i, i + 30))));
    for (const d of snap.docs) {
      const n = officialName(pr.get(d.id) ?? '', d.data());
      if (n) out[d.id] = n;
    }
  }
  return out;
}

/** 画面に出す会社名 */
export const nameOf = (data: Pick<KbData, 'names'>, cid: string, fallback: string) => data.names[cid] ?? fallback;

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
        const [a, t, h, st, kc] = await Promise.all([
          getDocs(query(collection(db, 'kbArticles'))),
          getDocs(collection(db, 'kbThemes')),
          getCountFromServer(collection(db, 'handoff')),
          getDoc(doc(db, 'kbMeta', 'ingest')),
          getDocs(collection(db, 'kbCompanies')),
        ]);
        if (!alive) return;
        const articles = a.docs
            .map((d) => {
              const v = d.data();
              // 日時は Firestore の Timestamp で入っていることがあるので、文字にそろえる
              return { ...(v as KbArticle), id: d.id, readAt: toIso(v.readAt), publishedAt: toIso(v.publishedAt) ?? '', analyzedAt: toIso(v.analyzedAt) ?? undefined };
            })
            .sort((x, y) => (y.readAt ?? '').localeCompare(x.readAt ?? ''));
        const names = await loadNames(articles).catch(() => ({}));
        if (!alive) return;
        setData({
          articles,
          names,
          companies: Object.fromEntries(
            kc.docs.map((d) => [d.id, { businesses: (d.get('ai.businesses') as string[] | undefined) ?? [], capital: (d.get('ai.capital') as KbCompanyInfo['capital']) ?? [] }]),
          ),
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
