import { useMemo } from 'react';
import { byStarsThenDate, matchesText, themesByService } from '../lib/kb';
import { fmtDate, n } from '../lib/format';
import { linkProps } from '../lib/router';
import type { KbData } from '../data/useKb';

/** テーマ別のネタ帳：左にテーマ（サービスごと）、右にそのテーマのネタ（トーク例＋根拠の記事＋数字） */
export function ThemesPage({ data, theme, q }: { data: KbData; theme: string | null; q: string }) {
  const w = q.normalize('NFKC').toLowerCase().trim();
  // 検索中は、名前・説明に言葉を含むテーマと、言葉に当てはまるネタがあるテーマだけを並べる
  const groups = useMemo(() => {
    if (!w) return themesByService(data.themes);
    const hit = new Set(data.articles.filter((a) => matchesText(a, q, data.names[a.companyId])).flatMap((a) => a.themes ?? []));
    return themesByService(data.themes.filter((t) => hit.has(t.name) || `${t.name} ${t.description ?? ''}`.normalize('NFKC').toLowerCase().includes(w)));
  }, [data.themes, data.articles, data.names, q, w]);
  const current = theme ? data.themes.find((t) => t.name === theme) : null;
  const items = useMemo(
    () =>
      theme
        ? data.articles
            .filter((a) => a.kb && (a.themes ?? []).includes(theme))
            .filter((a) => !w || matchesText(a, q, data.names[a.companyId]) || theme.normalize('NFKC').toLowerCase().includes(w))
            .sort(byStarsThenDate)
        : [],
    [data.articles, data.names, theme, q, w],
  );
  return (
    <div className="cases">
      <aside className={`filters ${theme ? 'hidesp' : ''}`}>
        {groups.length === 0 && (
          <p className="note">{w ? '当てはまるテーマはありません。' : 'まだテーマがありません。Watcher で記事を読了にすると、AI がテーマを作ります。'}</p>
        )}
        {groups.map((g) => (
          <div key={g.service} className="facet">
            <b>{g.service}</b>
            {g.themes.map((t) => (
              <a key={t.name} className="fopt" aria-pressed={t.name === theme} {...linkProps(`/themes/${t.name}`)}>
                <span>{t.name}</span>
                <span className="n">{t.count}</span>
              </a>
            ))}
          </div>
        ))}
      </aside>
      <section className="results">
        {!theme ? (
          <p className="note onlypc">左からテーマを選んでください。</p>
        ) : (
          <>
            <div className="toolbar">
              <a className="ghost onlysp" {...linkProps('/themes')}>
                ← テーマ一覧
              </a>
            </div>
            <header className="themehead">
              <h2>{theme}</h2>
              {current?.description && <p className="sum">{current.description}</p>}
              <small className="sub">
                {current?.service ?? ''} · {n(items.length)} 件
              </small>
            </header>
            {items.map((a) => (
              <article key={a.id} className="card neta">
                {(a.kb?.talk ?? []).length > 0 && (
                  <div className="block talkbox">
                    <b className="lbl">トーク例</b>
                    <ul className="talk big">
                      {a.kb!.talk.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="ground">
                  <span className="badge src">根拠の記事</span>
                  <a className="ttl small" href={a.url} target="_blank" rel="noreferrer">
                    {a.kb?.caseTitle || a.title}
                  </a>
                  <div className="byline">
                    <a className="co" {...linkProps(`/c/${a.companyId}`)}>
                      {data.names[a.companyId] ?? a.company}
                    </a>
                    <span className="date">{fmtDate(a.publishedAt)}</span>
                    {a.stars > 0 && <span className="stars">{'★'.repeat(a.stars)}</span>}
                  </div>
                </div>
                {(a.kb?.facts ?? []).length > 0 && (
                  <div className="facts">
                    {a.kb!.facts.map((f, i) => (
                      <span key={i}>
                        <b>{f.label}</b>
                        {f.value}
                      </span>
                    ))}
                  </div>
                )}
                {a.memo && (
                  <div className="block memo">
                    <b className="lbl">自分のメモ</b>
                    <p>{a.memo}</p>
                  </div>
                )}
              </article>
            ))}
          </>
        )}
      </section>
    </div>
  );
}
