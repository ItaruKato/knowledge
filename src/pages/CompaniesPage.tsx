import { useMemo, useState } from 'react';
import { linkProps } from '../lib/router';
import { fmtDate } from '../lib/format';
import type { KbData } from '../data/useKb';

/** 読んだ記事のある会社（全社の一覧と絞り込みは Long List で） */
export function CompaniesPage({ data }: { data: KbData }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const m = new Map<string, { cid: string; name: string; pr: string; count: number; last: string; industry?: string; stars: number }>();
    for (const a of data.articles) {
      const c = m.get(a.companyId) ?? { cid: a.companyId, name: data.names[a.companyId] ?? a.company, pr: a.company, count: 0, last: '', industry: a.kb?.industry, stars: 0 };
      c.count++;
      c.stars = Math.max(c.stars, a.stars ?? 0);
      if ((a.publishedAt ?? '') > c.last) c.last = a.publishedAt;
      c.industry ??= a.kb?.industry;
      m.set(a.companyId, c);
    }
    const w = q.normalize('NFKC').toLowerCase().trim();
    return [...m.values()]
      .filter((c) => !w || `${c.name} ${c.pr} ${c.industry ?? ''}`.normalize('NFKC').toLowerCase().includes(w))
      .sort((x, y) => y.last.localeCompare(x.last));
  }, [data.articles, data.names, q]);
  return (
    <div className="results">
      <input className="search" type="search" placeholder="会社名・業界で探す" value={q} onChange={(e) => setQ(e.target.value)} />
      <p className="note">読んだ記事のある会社です（全社の一覧は Long List で）。</p>
      {list.map((c) => (
        <a key={c.cid} className="card crow" {...linkProps(`/c/${c.cid}`)}>
          <b>{c.name}</b>
          <small className="sub">
            {c.industry ?? ''} · 読んだ記事 {c.count}件 · 最新 {fmtDate(c.last)}
            {c.stars ? ` · ${'★'.repeat(c.stars)}` : ''}
          </small>
        </a>
      ))}
    </div>
  );
}
