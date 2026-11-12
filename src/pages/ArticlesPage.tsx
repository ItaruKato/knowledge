import { ArticleCard } from '../components/ArticleCard';
import { fmtTime, n } from '../lib/format';
import type { IngestStatus } from '../types';
import type { KbData } from '../data/useKb';

/** 取り込み（10分ごと）の様子。うまく動いていないときに気づけるように */
function StatusLine({ s }: { s: IngestStatus }) {
  const running = s.startedAt && (!s.lastRunAt || s.startedAt > s.lastRunAt) && Date.now() - new Date(s.startedAt).getTime() < 10 * 60e3;
  return (
    <p className="note">
      {!s.startedAt && !s.lastRunAt && !s.lastError
        ? '取り込みはまだ一度も動いていません（10分ごとに動きます）。'
        : running
          ? `取り込み中です（${fmtTime(s.startedAt)} から。1件に1〜2分かかります）。`
          : `最後の取り込み：${fmtTime(s.lastRunAt)}${s.last ? `（整理 ${s.last.analyzed ?? 0}・更新 ${s.last.synced ?? 0}・失敗 ${s.last.failed ?? 0}）` : ''}。10分ごとに動きます。`}
      {s.lastError && <span className="err"> 止まりました（{fmtTime(s.lastErrorAt)}）：{s.lastError}</span>}
    </p>
  );
}

/** 読んだ記事（読了にした順） */
export function ArticlesPage({ data }: { data: KbData }) {
  const done = data.articles.filter((a) => a.state === 'done').length;
  return (
    <>
      <section className="stats">
        <div>
          <span>受け取った記事</span>
          <b>{n(data.handoffCount)}</b>
        </div>
        <div>
          <span>整理した記事</span>
          <b>{n(done)}</b>
        </div>
        <div>
          <span>テーマ</span>
          <b>{n(data.themes.filter((t) => t.count > 0).length)}</b>
        </div>
      </section>
      <StatusLine s={data.status} />
      {data.articles.map((a) => (
        <ArticleCard key={a.id} a={a} />
      ))}
    </>
  );
}
