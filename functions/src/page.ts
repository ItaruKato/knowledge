/** PR TIMES の記事ページの取得と本文の取り出し（prtimes-inbox の functions/src/parse.ts・collect.ts と同じ読み方） */

const UA = 'prtimes-knowledge/1.0 (personal reader)';

export async function httpGet(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** PR TIMES の記事ページだけを読む（ほかのサイトには行かない） */
export function isPrtimesUrl(url: string | undefined): url is string {
  return typeof url === 'string' && /^https:\/\/prtimes\.jp\/main\/html\/rd\/p\/\d+\.\d+\.html$/.test(url);
}

export function extractBody(html: string, maxChars = 20000): string {
  const i = html.indexOf('id="press-release-body"');
  if (i < 0) return '';
  const start = html.indexOf('>', i) + 1;
  const re = /<(\/?)div\b/g;
  re.lastIndex = start;
  let depth = 1;
  let end = html.length;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) {
      end = m.index;
      break;
    }
  }
  return html
    .slice(start, end)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '')
    .replace(/<(br|\/p|\/h\d|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
    .slice(0, maxChars);
}
