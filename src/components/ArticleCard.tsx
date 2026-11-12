import type { KbArticle } from '../types';
import { fmtDate, fmtTime } from '../lib/format';
import { linkProps } from '../lib/router';

/** 記事1件のカード（読んだ記事・先行事例で使う）。name は画面に出す会社名（正式名が分かれば正式名） */
export function ArticleCard({ a, name }: { a: KbArticle; name?: string }) {
  const k = a.kb;
  return (
    <article className="card kbcard">
      <div className="badges">
        {k?.isCase && <span className="badge case">事例</span>}
        {k?.industry && <span className="badge ind">{k.industry}</span>}
        {k?.stage && k.stage !== '不明' && <span className="badge stage">{k.stage}</span>}
        {!k && <span className="badge wait">{a.state === 'failed' ? '整理をやり直し中' : '整理待ち'}</span>}
        {a.stars > 0 && (
          <span className="stars" aria-label={`重要度 ${a.stars}`}>
            {'★'.repeat(a.stars)}
          </span>
        )}
      </div>
      <a className="ttl" href={a.url} target="_blank" rel="noreferrer">
        {k?.caseTitle || a.title}
      </a>
      <div className="byline">
        <a className="co" {...linkProps(`/c/${a.companyId}`)}>
          {name || a.company}
        </a>
        <span className="date">{fmtDate(a.publishedAt)}</span>
      </div>
      {k?.caseTitle && <p className="orig">{a.title}</p>}
      {(k?.caseSummary || a.draft?.summary) && <p className="sum">{k?.caseSummary || a.draft?.summary}</p>}
      {k && k.facts.length > 0 && (
        <div className="facts">
          {k.facts.map((f, i) => (
            <span key={i}>
              <b>{f.label}</b>
              {f.value}
            </span>
          ))}
        </div>
      )}
      {k && k.challenges.length > 0 && (
        <div className="block">
          <b className="lbl">課題・狙い</b>
          <div className="pills">
            {k.challenges.map((c) => (
              <span key={c} className="pill">
                {c}
              </span>
            ))}
          </div>
          {k.challengeNote && <p className="line">{k.challengeNote}</p>}
        </div>
      )}
      {k && k.talk.length > 0 && (
        <div className="block talkbox">
          <b className="lbl">トーク例</b>
          <ul className="talk">
            {k.talk.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {a.memo && (
        <div className="block memo">
          <b className="lbl">自分のメモ</b>
          <p>{a.memo}</p>
        </div>
      )}
      <div className="cardfoot">
        {a.themes && a.themes.length > 0 && (
          <div className="chips">
            {a.themes.map((t) => (
              <a key={t} className="chip" {...linkProps(`/themes/${t}`)}>
                # {t}
              </a>
            ))}
          </div>
        )}
        {a.analyzedAt && (
          <small className="ver">
            AIの整理 v{a.analysisV ?? 1} · {fmtTime(a.analyzedAt)}
          </small>
        )}
      </div>
    </article>
  );
}
