import type { KbArticle, KbTheme } from '../types';
import { matchesText, SERVICES } from './kb';

/**
 * 知識のつながり（会社・テーマ・業界の丸と線）。追加の AI は使わず、読んだ記事の整理の共通点から作る（本人の決定）。
 * - 会社 ─ テーマ：その会社の記事がそのテーマに入っている
 * - 会社 ─ 業界：AI の整理の業界（業界タグが台帳にできたら切り替える）
 * - 会社 ─ 会社（似ている）：共通点の点数が SIMILAR_MIN 以上。同じテーマ 3点、同じ業界 2点、同じ課題・狙い 1点、同じ規模・段階 1点
 * あとで「意味の近さ」（Vertex AI で記事を数値にしたもの）の線を足す
 */

export type GKind = 'company' | 'theme' | 'industry';
export interface GNode {
  id: string;
  kind: GKind;
  label: string;
  /** 丸の大きさ（記事の数・★） */
  val: number;
  /** テーマのサービス（色分け） */
  service?: string;
  cid?: string;
  count: number;
}
export type GLinkKind = 'theme' | 'industry' | 'similar';
export interface GLink {
  source: string;
  target: string;
  kind: GLinkKind;
  /** 似ている会社どうしの点数と理由 */
  score?: number;
  reasons?: string[];
}
export interface Graph {
  nodes: GNode[];
  links: GLink[];
}

export const SIMILAR_MIN = 3;
/** 1社あたり、似ている会社の線は多い順にこの数まで（線が多すぎて見えなくならないように） */
export const SIMILAR_PER_COMPANY = 6;

interface CompanyAgg {
  cid: string;
  name: string;
  themes: Set<string>;
  industries: Set<string>;
  challenges: Set<string>;
  stages: Set<string>;
  articles: KbArticle[];
  stars: number;
}

export function aggregate(articles: KbArticle[], names: Record<string, string>): Map<string, CompanyAgg> {
  const m = new Map<string, CompanyAgg>();
  for (const a of articles) {
    if (!a.kb || !a.companyId) continue;
    const c =
      m.get(a.companyId) ??
      { cid: a.companyId, name: names[a.companyId] ?? a.company, themes: new Set(), industries: new Set(), challenges: new Set(), stages: new Set(), articles: [], stars: 0 };
    for (const t of a.themes ?? []) c.themes.add(t);
    if (a.kb.industry) c.industries.add(a.kb.industry);
    for (const x of a.kb.challenges ?? []) if (x !== 'その他') c.challenges.add(x);
    if (a.kb.stage && a.kb.stage !== '不明') c.stages.add(a.kb.stage);
    c.articles.push(a);
    c.stars = Math.max(c.stars, a.stars ?? 0);
    m.set(a.companyId, c);
  }
  return m;
}

/** 2社の共通点の点数と理由 */
export function similarity(a: CompanyAgg, b: CompanyAgg): { score: number; reasons: string[] } {
  const both = (x: Set<string>, y: Set<string>) => [...x].filter((v) => y.has(v));
  const t = both(a.themes, b.themes);
  const i = both(a.industries, b.industries);
  const c = both(a.challenges, b.challenges);
  const s = both(a.stages, b.stages);
  const reasons = [
    ...t.map((v) => `同じテーマ「${v}」`),
    ...i.map((v) => `同じ業界「${v}」`),
    ...c.map((v) => `同じ課題・狙い「${v}」`),
    ...s.map((v) => `同じ規模・段階「${v}」`),
  ];
  return { score: t.length * 3 + i.length * 2 + c.length + s.length, reasons };
}

export function buildGraph(articles: KbArticle[], names: Record<string, string>, themes: KbTheme[], opts: { similar?: boolean; industries?: boolean } = {}): Graph {
  const { similar = true, industries = true } = opts;
  const agg = aggregate(articles, names);
  const service = new Map(themes.map((t) => [t.name, t.service]));
  const nodes = new Map<string, GNode>();
  const links: GLink[] = [];
  const add = (n: GNode) => {
    const prev = nodes.get(n.id);
    if (prev) {
      prev.count += n.count;
      prev.val = 1 + prev.count;
    } else nodes.set(n.id, n);
  };
  for (const c of agg.values()) {
    add({ id: `c:${c.cid}`, kind: 'company', label: c.name, val: 2 + c.articles.length + c.stars, cid: c.cid, count: c.articles.length });
    for (const t of c.themes) {
      add({ id: `t:${t}`, kind: 'theme', label: t, val: 2, service: service.get(t) ?? 'その他', count: 1 });
      links.push({ source: `c:${c.cid}`, target: `t:${t}`, kind: 'theme' });
    }
    if (industries)
      for (const i of c.industries) {
        add({ id: `i:${i}`, kind: 'industry', label: i, val: 2, count: 1 });
        links.push({ source: `c:${c.cid}`, target: `i:${i}`, kind: 'industry' });
      }
  }
  if (similar) {
    const list = [...agg.values()];
    const best = new Map<string, { other: string; score: number; reasons: string[] }[]>();
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) {
        const r = similarity(list[x], list[y]);
        if (r.score < SIMILAR_MIN) continue;
        for (const [p, q] of [
          [list[x].cid, list[y].cid],
          [list[y].cid, list[x].cid],
        ])
          best.set(p, [...(best.get(p) ?? []), { other: q, ...r }]);
      }
    const seen = new Set<string>();
    for (const [cid, arr] of best) {
      for (const r of arr.sort((p, q) => q.score - p.score).slice(0, SIMILAR_PER_COMPANY)) {
        const key = [cid, r.other].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ source: `c:${cid}`, target: `c:${r.other}`, kind: 'similar', score: r.score, reasons: r.reasons });
      }
    }
  }
  return { nodes: [...nodes.values()], links };
}

const endId = (v: unknown) => (typeof v === 'string' ? v : (v as { id: string }).id);

/** 丸 id とじかにつながる丸の id（自分も含む） */
export function neighbors(g: Graph, id: string): Set<string> {
  const out = new Set([id]);
  for (const l of g.links) {
    const s = endId(l.source);
    const t = endId(l.target);
    if (s === id) out.add(t);
    if (t === id) out.add(s);
  }
  return out;
}

/** 丸 id を中心に、steps 歩先までの丸と線だけにする */
export function around(g: Graph, id: string, steps = 2): Graph {
  let keep = new Set([id]);
  for (let i = 0; i < steps; i++) {
    const next = new Set(keep);
    for (const k of keep) for (const n of neighbors(g, k)) next.add(n);
    keep = next;
  }
  return {
    nodes: g.nodes.filter((n) => keep.has(n.id)),
    links: g.links.filter((l) => keep.has(endId(l.source)) && keep.has(endId(l.target))),
  };
}

/** 検索窓の言葉に当てはまる丸（会社は記事の中身でも探す） */
export function matchingNodes(g: Graph, q: string, articles: KbArticle[], names: Record<string, string>): Set<string> | null {
  const w = q.normalize('NFKC').toLowerCase().trim();
  if (!w) return null;
  const hitCompanies = new Set(articles.filter((a) => matchesText(a, q, names[a.companyId])).map((a) => `c:${a.companyId}`));
  return new Set(g.nodes.filter((n) => hitCompanies.has(n.id) || n.label.normalize('NFKC').toLowerCase().includes(w)).map((n) => n.id));
}

/** 似ている会社（点数の高い順）と理由 */
export function similarOf(g: Graph, id: string): { id: string; score: number; reasons: string[] }[] {
  return g.links
    .filter((l) => l.kind === 'similar' && (endId(l.source) === id || endId(l.target) === id))
    .map((l) => ({ id: endId(l.source) === id ? endId(l.target) : endId(l.source), score: l.score ?? 0, reasons: l.reasons ?? [] }))
    .sort((a, b) => b.score - a.score);
}

export const SERVICE_KEYS = [...SERVICES, 'その他'] as const;
