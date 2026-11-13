/**
 * レポートのメール（Resend。送信用のサブドメイン kb.spark-partners.jp から、本人だけに）。
 * キーは Secret Manager の RESEND_API_KEY（送信だけの権限・kb.spark-partners.jp だけ）。値はログに出さない
 */

export const MAIL_FROM = 'Knowledge Base <report@kb.spark-partners.jp>';
export const MAIL_TO = 'i-kato@spark-partners.jp';
export const APP_URL = 'https://prtimes-knowledge.web.app';

export interface Mail {
  subject: string;
  html: string;
  text: string;
}
export type SendMail = (m: Mail) => Promise<void>;

export function resendSender(apiKey: string): SendMail {
  return async (m) => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [MAIL_TO], subject: m.subject, html: m.html, text: m.text }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`メールを送れませんでした（Resend ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 200)}）`);
  };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** PR TIMES の記事ページだけをリンクにする（ほかの住所は文字だけ） */
const safeHref = (u: unknown) => (typeof u === 'string' && /^https:\/\/prtimes\.jp\//.test(u) ? u : '');
const a = (href: unknown, text: unknown) => (safeHref(href) ? `<a href="${esc(safeHref(href))}" style="color:#2a3d8f">${esc(text)}</a>` : esc(text));
const company = (c: { company?: string; companyId?: string }) =>
  c.companyId && /^\d+$/.test(c.companyId) ? `<a href="${APP_URL}/c/${c.companyId}" style="color:#353d4b">${esc(c.company)}</a>` : esc(c.company);

const shell = (title: string, body: string) => `<!doctype html><html lang="ja"><body style="margin:0;background:#eef1f6;font-family:'Hiragino Sans','Yu Gothic UI',Meiryo,sans-serif;color:#10141c">
<div style="max-width:640px;margin:0 auto;padding:20px 14px">
<p style="margin:0 0 4px;font-size:12px;color:#576071">Knowledge Base</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.5">${esc(title)}</h1>
${body}
<p style="margin:20px 0 0;font-size:12px;color:#576071"><a href="${APP_URL}/reports" style="color:#2a3d8f">アプリでレポートを開く</a>（自分専用。ログインが要ります）</p>
</div></body></html>`;
const card = (inner: string) => `<div style="background:#fff;border:1px solid #d3d9e3;border-radius:12px;padding:14px 16px;margin:0 0 12px">${inner}</div>`;
const h2 = (t: string) => `<h2 style="margin:0 0 10px;font-size:16px">${esc(t)}</h2>`;
const small = (t: string) => `<div style="font-size:12px;color:#576071;margin-top:2px">${t}</div>`;

interface Art {
  title?: string;
  company?: string;
  companyId?: string;
  url?: string;
  tracked?: string;
}

export function dailyMail(r: { date: string; picks?: (Art & { reason?: string; service?: string })[]; netas?: (Art & { talk?: string; to?: string })[]; counts?: { articles?: number }; note?: string }): Mail {
  const picks = r.picks ?? [];
  const netas = r.netas ?? [];
  const title = `デイリー ${r.date}：注目記事 ${picks.length}件と今日の営業ネタ`;
  const body = [
    r.note ? card(esc(r.note)) : '',
    netas.length
      ? card(
          h2('今日の営業ネタ') +
            netas
              .map(
                (x) =>
                  `<div style="border-left:4px solid #2a3d8f;background:#e4e9fa;border-radius:0 8px 8px 0;padding:8px 12px;margin:0 0 8px"><div style="font-weight:600;line-height:1.7">${esc(x.talk)}</div>${small(`話す相手：${esc(x.to)}`)}${small(`根拠：${a(x.url, x.title)}（${company(x)}）`)}</div>`,
              )
              .join(''),
        )
      : '',
    card(
      h2(`昨日の注目記事（${picks.length}件）`) +
        picks
          .map(
            (p, i) =>
              `<div style="padding:8px 0;border-bottom:1px solid #eef1f6"><div style="font-weight:600">${i + 1}. ${a(p.url, p.title)}</div>${small(`${company(p)}${p.tracked ? `・<b style="color:#17663f">追っている会社（${esc(p.tracked)}）</b>` : ''}`)}<div style="font-size:14px;line-height:1.7;margin-top:4px"><span style="background:#e1edfa;color:#14558f;border-radius:4px;padding:0 6px;font-size:12px">${esc(p.service)}</span> ${esc(p.reason)}</div></div>`,
          )
          .join(''),
    ),
    small(`昨日の記事 ${r.counts?.articles ?? 0} 件から AI が選びました。`),
  ].join('');
  const text = [
    title,
    '',
    '■ 今日の営業ネタ',
    ...netas.map((x) => `・${x.talk}（話す相手：${x.to}／根拠：${x.title}）`),
    '',
    '■ 昨日の注目記事',
    ...picks.map((p, i) => `${i + 1}. ${p.title}（${p.company}${p.tracked ? `・追っている会社` : ''}）\n   ${p.service}：${p.reason}\n   ${safeHref(p.url)}`),
    '',
    `${APP_URL}/reports`,
  ].join('\n');
  return { subject: title, html: shell(title, body), text };
}

export function weeklyMail(r: {
  date: string;
  from?: string;
  summary?: string;
  counts?: { articles?: number; reads?: number; byType?: Record<string, number> };
  best?: (Art & { why?: string })[];
  companies?: (Art & { reason?: string; service?: string; action?: string })[];
  cost?: { usdJpy: number; week: { kb: number; watcher: number }; month: { kb: number; watcher: number } };
}): Mail {
  const title = `ウィークリー ${r.from ?? ''}〜${r.date}`;
  const yen = (usd: number) => `約${Math.round(usd * (r.cost?.usdJpy ?? 150)).toLocaleString('ja-JP')}円`;
  const types = Object.entries(r.counts?.byType ?? {})
    .sort((x, y) => y[1] - x[1])
    .map(([t, k]) => `${esc(t)} ${k}`)
    .join('・');
  const c = r.cost;
  const body = [
    card(
      h2('今週のふりかえり') +
        (r.summary ? `<p style="margin:0 0 8px;line-height:1.8">${esc(r.summary)}</p>` : '') +
        small(`読んだ記事 ${r.counts?.reads ?? 0} 件・今週の全記事 ${r.counts?.articles ?? 0} 件`) +
        (types ? small(types) : ''),
    ),
    card(
      h2('今週の事例ベスト') +
        (r.best ?? [])
          .map((b, i) => `<div style="padding:8px 0;border-bottom:1px solid #eef1f6"><div style="font-weight:600">${i + 1}. ${a(b.url, b.title)}</div>${small(company(b))}<div style="font-size:14px;line-height:1.7;margin-top:4px">${esc(b.why)}</div></div>`)
          .join(''),
    ),
    card(
      h2('来週動くとよい会社') +
        (r.companies ?? [])
          .map(
            (x, i) =>
              `<div style="padding:8px 0;border-bottom:1px solid #eef1f6"><div style="font-weight:600">${i + 1}. ${company(x)}${x.tracked ? ` <span style="color:#17663f;font-size:12px">追っている会社（${esc(x.tracked)}）</span>` : ''}</div><div style="font-size:14px;line-height:1.7"><span style="background:#e1edfa;color:#14558f;border-radius:4px;padding:0 6px;font-size:12px">${esc(x.service)}</span> ${esc(x.reason)}</div><div style="font-size:14px;line-height:1.7"><b>来週やること</b> ${esc(x.action)}</div>${small(`根拠：${a(x.url, x.title)}`)}</div>`,
          )
          .join(''),
    ),
    c
      ? card(
          h2('AI の費用') +
            `<div style="font-size:14px;line-height:1.9">今週：Knowledge Base ${yen(c.week.kb)}・Watcher・台帳 ${yen(c.week.watcher)}<br>今月の合計：<b>${yen(c.month.kb + c.month.watcher)}</b>（Knowledge Base ${yen(c.month.kb)}・Watcher・台帳 ${yen(c.month.watcher)}）</div>` +
            small(`1ドル=${c.usdJpy}円で計算した見積もり`),
        )
      : '',
  ].join('');
  const text = [
    title,
    '',
    r.summary ?? '',
    '',
    '■ 今週の事例ベスト',
    ...(r.best ?? []).map((b, i) => `${i + 1}. ${b.title}（${b.company}）\n   ${b.why}`),
    '',
    '■ 来週動くとよい会社',
    ...(r.companies ?? []).map((x, i) => `${i + 1}. ${x.company}：${x.reason}\n   来週やること：${x.action}`),
    '',
    c ? `■ AI の費用：今月の合計 ${yen(c.month.kb + c.month.watcher)}` : '',
    `${APP_URL}/reports`,
  ].join('\n');
  return { subject: title, html: shell(title, body), text };
}
