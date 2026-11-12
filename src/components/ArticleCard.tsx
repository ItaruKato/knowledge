import type { KbArticle } from '../types';
import { fmtDate, fmtTime } from '../lib/format';
import { linkProps } from '../lib/router';

/** 記事1件のカード（記事の一覧・先行事例で使う） */
export function ArticleCard({ a }: { a: KbArticle }) {
  const k = a.kb;
  return (
    <article className="card kbcard">
      <div className="badges">
        {k?.isCase && <span className="badge case">事例</span>}
        {k?.industry && <span className="badge">{k.industry}</span>}
        {k?.stage && k.stage !== '不明' && <span className="badge">{k.stage}</span>}
        {a.stars > 0 && <span className="stars">{'★'.repeat(a.stars)}</span>}
        {!k && <span className="badge wait">{a.state === 'failed' ? '整理をやり直し中' : '整理待ち'}</span>}
      </div>
      <a className="ttl" href={a.url} target="_blank" rel="noreferrer">
        {k?.caseTitle || a.title}
      </a>
      <small className="sub">
        <a className="co" {...linkProps(`/c/${a.companyId}`)}>
          {a.company}
        </a>{' '}
        · {fmtDate(a.publishedAt)}
        {k?.caseTitle ? ` · ${a.title}` : ''}
      </small>
      {(k?.caseSummary || a.draft?.summary) && <p className="sum">{k?.caseSummary || a.draft?.summary}</p>}
      {k && k.facts.length > 0 && (
        <div className="facts">
          {k.facts.map((f, i) => (
            <span key={i}>
              <b>{f.label}</b> {f.value}
            </span>
          ))}
        </div>
      )}
      {k && k.challenges.length > 0 && (
        <p className="line">
          <b>課題・狙い</b> {k.challenges.join('・')}
          {k.challengeNote ? `：${k.challengeNote}` : ''}
        </p>
      )}
      {k && k.talk.length > 0 && (
        <ul className="talk">
          {k.talk.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      )}
      {a.memo && <p className="memo">{a.memo}</p>}
      {a.themes && a.themes.length > 0 && (
        <div className="chips">
          {a.themes.map((t) => (
            <a key={t} className="chip" {...linkProps(`/themes/${t}`)}>
              {t}
            </a>
          ))}
        </div>
      )}
      {a.analyzedAt && (
        <small className="ver">
          AIの整理 v{a.analysisV ?? 1} · {fmtTime(a.analyzedAt)}
        </small>
      )}
    </article>
  );
}
