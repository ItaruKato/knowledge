import { useMemo, useState } from 'react';
import { ArticleCard } from '../components/ArticleCard';
import { applyFilters, byStarsThenDate, emptyFilters, facetCounts, FACETS, matrix, type Facet, type Filters } from '../lib/kb';
import { n } from '../lib/format';
import type { KbData } from '../data/useKb';

/** 先行事例：カード＋4つの切り口の絞り込み と 業界×テーマの件数表 */
export function CasesPage({ data }: { data: KbData }) {
  const [f, setF] = useState<Filters>(emptyFilters);
  const [view, setView] = useState<'cards' | 'table'>('cards');
  const [open, setOpen] = useState(false);
  const items = useMemo(() => applyFilters(data.articles, f).sort(byStarsThenDate), [data.articles, f]);
  const toggle = (key: Facet, v: string) =>
    setF((p) => ({ ...p, [key]: p[key].includes(v) ? p[key].filter((x) => x !== v) : [...p[key], v] }));
  const active = FACETS.reduce((s, { key }) => s + f[key].length, 0) + (f.q ? 1 : 0);
  const m = useMemo(() => matrix(applyFilters(data.articles, { ...emptyFilters(), casesOnly: f.casesOnly })), [data.articles, f.casesOnly]);

  return (
    <div className="cases">
      <aside className={`filters ${open ? 'open' : ''}`}>
        <input className="search" type="search" placeholder="言葉で探す（会社・見出し・メモ…）" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <label className="check">
          <input type="checkbox" checked={!f.casesOnly} onChange={(e) => setF({ ...f, casesOnly: !e.target.checked })} />
          事例以外の記事も含める
        </label>
        {FACETS.map(({ key, label }) => {
          const counts = facetCounts(data.articles, f, key);
          return (
            <div key={key} className="facet">
              <b>{label}</b>
              {counts.length === 0 && <small className="sub">なし</small>}
              {counts.map(({ value, count }) => (
                <button key={value} type="button" className="fopt" aria-pressed={f[key].includes(value)} onClick={() => toggle(key, value)}>
                  <span>{value}</span>
                  <span className="n">{count}</span>
                </button>
              ))}
            </div>
          );
        })}
        {active > 0 && (
          <button type="button" className="ghost" onClick={() => setF({ ...emptyFilters(), casesOnly: f.casesOnly })}>
            絞り込みを消す
          </button>
        )}
      </aside>
      <section className="results">
        <div className="toolbar">
          <span className="meta">{n(items.length)} 件</span>
          <button type="button" className="ghost onlysp" onClick={() => setOpen(!open)}>
            絞り込み{active ? `（${active}）` : ''}
          </button>
          <div className="seg">
            <button type="button" aria-pressed={view === 'cards'} onClick={() => setView('cards')}>
              カード
            </button>
            <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
              業界×テーマ
            </button>
          </div>
        </div>
        {view === 'cards' ? (
          items.length ? (
            items.map((a) => <ArticleCard key={a.id} a={a} name={data.names[a.companyId]} />)
          ) : (
            <p className="note">当てはまる事例はありません。</p>
          )
        ) : (
          <div className="tablewrap">
            <table className="matrix">
              <thead>
                <tr>
                  <th>業界</th>
                  {m.cols.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                  <th>合計</th>
                </tr>
              </thead>
              <tbody>
                {m.rows.map((r) => (
                  <tr key={r.industry}>
                    <th>{r.industry}</th>
                    {m.cols.map((c) => {
                      const v = r.cells.get(c) ?? 0;
                      return (
                        <td key={c}>
                          {v > 0 && c !== m.other ? (
                            <button
                              type="button"
                              onClick={() => {
                                setF({ ...emptyFilters(), casesOnly: f.casesOnly, industry: r.industry === '不明' ? [] : [r.industry], theme: [c] });
                                setView('cards');
                              }}
                            >
                              {v}
                            </button>
                          ) : v > 0 ? (
                            v
                          ) : (
                            ''
                          )}
                        </td>
                      );
                    })}
                    <td>
                      <button
                        type="button"
                        onClick={() => {
                          setF({ ...emptyFilters(), casesOnly: f.casesOnly, industry: r.industry === '不明' ? [] : [r.industry] });
                          setView('cards');
                        }}
                      >
                        {r.total}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="note">数字を押すと、その事例のカードを出します。列は件数の多いテーマから10個まで。</p>
          </div>
        )}
      </section>
    </div>
  );
}
