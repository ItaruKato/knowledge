import type { KbArticle, KbCompanyInfo, KbTheme } from '../types';
import { matchesText, SERVICES } from './kb';
import { coreName } from './names';

/**
 * 知識のつながり（本人の決定 2026-11-12）。
 * - 会社と会社を直接結ぶ線は「資本関係」だけ（出資・買収・子会社化・資本業務提携・合併など。会社の AI のまとめの capital）
 * - ビジネスが似ている会社は「会社 ─ ビジネス ─ 会社」で結ぶ（会社の AI のまとめの businesses）
 * - あわせて、会社 ─ テーマ（ネタ帳）、会社 ─ 業界 の丸と線も出せる
 * - 「似ている会社」の一覧は線にせず、共通点の点数（同じビジネス3・同じテーマ3・同じ業界2・同じ課題/狙い1・同じ規模/段階1）で横に出す
 * 追加の AI は使わない。⑤で「意味の近さ」も足す
 */

export type GKind = 'company' | 'business' | 'theme' | 'industry';
export interface GNode {
  id: string;
  kind: GKind;
  label: string;
  /** 丸の大きさ */
  val: number;
  /** テーマのサービス（色分け） */
  service?: string;
  cid?: string;
  /** 読んでいない会社（資本関係の相手先として出てくるだけの会社） */
  external?: boolean;
  count: number;
}
export type GLinkKind = 'business' | 'theme' | 'industry' | 'capital';
export interface GLink {
  source: string;
  target: string;
  kind: GLinkKind;
  /** 資本関係の種類（出資・買収・子会社化・親会社・子会社 は source → target の向き。資本業務提携・合併・事業譲渡 は向きなし） */
  relation?: string;
  directed?: boolean;
  date?: string;
  articleId?: string;
}

/**
 * 資本関係を「出資・買収する側 → される側」の向きにそろえる。
 * AI のまとめの relation は、その会社から見た言い方（例：出資を受けた）なので、in なら相手 → 自分、out なら自分 → 相手。
 */
const DIRECTION: Record<string, [dir: 'in' | 'out' | 'none', label: string]> = {
  出資を受けた: ['in', '出資'],
  出資した: ['out', '出資'],
  買収した: ['out', '買収'],
  買収された: ['in', '買収'],
  子会社化した: ['out', '子会社化'],
  子会社になった: ['in', '子会社化'],
  親会社: ['in', '親会社・子会社'],
  '子会社・グループ会社': ['out', '親会社・子会社'],
  資本業務提携: ['none', '資本業務提携'],
  合併: ['none', '合併'],
  事業を譲り受けた: ['none', '事業譲渡'],
  事業を譲渡した: ['none', '事業譲渡'],
};
/** 向きのある関係を、その会社の側から読んだ言い方 */
const AS_SOURCE: Record<string, string> = { 出資: '出資した', 買収: '買収した', 子会社化: '子会社化した', '親会社・子会社': '子会社・グループ会社' };
const AS_TARGET: Record<string, string> = { 出資: '出資を受けた', 買収: '買収された', 子会社化: '子会社になった', '親会社・子会社': '親会社' };
export interface Similar {
  id: string;
  score: number;
  reasons: string[];
}
export interface Graph {
  nodes: GNode[];
  links: GLink[];
  /** 会社の丸 id → 似ている会社（点数の高い順） */
  similar: Map<string, Similar[]>;
}

export const SIMILAR_MIN = 3;
export const SIMILAR_MAX = 10;

interface CompanyAgg {
  cid: string;
  name: string;
  businesses: Set<string>;
  themes: Set<string>;
  industries: Set<string>;
  challenges: Set<string>;
  stages: Set<string>;
  articles: number;
  stars: number;
}

export function aggregate(articles: KbArticle[], names: Record<string, string>, companies: Record<string, KbCompanyInfo> = {}): Map<string, CompanyAgg> {
  const m = new Map<string, CompanyAgg>();
  for (const a of articles) {
    if (!a.kb || !a.companyId) continue;
    const c =
      m.get(a.companyId) ??
      ({
        cid: a.companyId,
        name: names[a.companyId] ?? a.company,
        businesses: new Set(companies[a.companyId]?.businesses ?? []),
        themes: new Set(),
        industries: new Set(),
        challenges: new Set(),
        stages: new Set(),
        articles: 0,
        stars: 0,
      } as CompanyAgg);
    for (const t of a.themes ?? []) c.themes.add(t);
    if (a.kb.industry) c.industries.add(a.kb.industry);
    for (const x of a.kb.challenges ?? []) if (x !== 'その他') c.challenges.add(x);
    if (a.kb.stage && a.kb.stage !== '不明') c.stages.add(a.kb.stage);
    c.articles++;
    c.stars = Math.max(c.stars, a.stars ?? 0);
    m.set(a.companyId, c);
  }
  return m;
}

/** 2社の共通点の点数と理由 */
export function similarity(a: CompanyAgg, b: CompanyAgg): { score: number; reasons: string[] } {
  const both = (x: Set<string>, y: Set<string>) => [...x].filter((v) => y.has(v));
  const bz = both(a.businesses, b.businesses);
  const t = both(a.themes, b.themes);
  const i = both(a.industries, b.industries);
  const c = both(a.challenges, b.challenges);
  const s = both(a.stages, b.stages);
  const reasons = [
    ...bz.map((v) => `同じビジネス「${v}」`),
    ...t.map((v) => `同じテーマ「${v}」`),
    ...i.map((v) => `同じ業界「${v}」`),
    ...c.map((v) => `同じ課題・狙い「${v}」`),
    ...s.map((v) => `同じ規模・段階「${v}」`),
  ];
  return { score: bz.length * 3 + t.length * 3 + i.length * 2 + c.length + s.length, reasons };
}

export interface GraphOpts {
  businesses?: boolean;
  themes?: boolean;
  industries?: boolean;
  capital?: boolean;
}

export function buildGraph(
  articles: KbArticle[],
  names: Record<string, string>,
  themes: KbTheme[],
  companies: Record<string, KbCompanyInfo> = {},
  opts: GraphOpts = {},
): Graph {
  const { businesses = true, themes: showThemes = true, industries = true, capital = true } = opts;
  const agg = aggregate(articles, names, companies);
  const service = new Map(themes.map((t) => [t.name, t.service]));
  const nodes = new Map<string, GNode>();
  const links: GLink[] = [];
  const hub = (n: GNode) => {
    const prev = nodes.get(n.id);
    if (prev) {
      prev.count++;
      prev.val = 2 + prev.count;
    } else nodes.set(n.id, n);
  };

  for (const c of agg.values()) {
    nodes.set(`c:${c.cid}`, { id: `c:${c.cid}`, kind: 'company', label: c.name, val: 2 + c.articles + c.stars, cid: c.cid, count: c.articles });
    if (businesses)
      for (const b of c.businesses) {
        hub({ id: `b:${b}`, kind: 'business', label: b, val: 3, count: 1 });
        links.push({ source: `c:${c.cid}`, target: `b:${b}`, kind: 'business' });
      }
    if (showThemes)
      for (const t of c.themes) {
        hub({ id: `t:${t}`, kind: 'theme', label: t, val: 3, service: service.get(t) ?? 'その他', count: 1 });
        links.push({ source: `c:${c.cid}`, target: `t:${t}`, kind: 'theme' });
      }
    if (industries)
      for (const i of c.industries) {
        hub({ id: `i:${i}`, kind: 'industry', label: i, val: 3, count: 1 });
        links.push({ source: `c:${c.cid}`, target: `i:${i}`, kind: 'industry' });
      }
  }

  // 資本関係：相手先が読んだ会社なら、その会社の丸に直接つなぐ。いなければ相手先の丸を足す
  if (capital) {
    const byCore = new Map<string, string>();
    for (const c of agg.values()) {
      for (const n of [c.name, articles.find((a) => a.companyId === c.cid)?.company ?? '']) {
        const k = coreName(n);
        if (k.length >= 2) byCore.set(k, `c:${c.cid}`);
      }
    }
    const find = (name: string) => {
      const k = coreName(name);
      if (k.length < 2) return null;
      if (byCore.has(k)) return byCore.get(k)!;
      for (const [core, id] of byCore) if (core.length >= 3 && k.length >= 3 && (core.includes(k) || k.includes(core))) return id;
      return null;
    };
    const seen = new Set<string>();
    for (const c of agg.values()) {
      for (const r of companies[c.cid]?.capital ?? []) {
        const from = `c:${c.cid}`;
        let to = find(r.counterpart);
        if (!to) {
          to = `x:${coreName(r.counterpart)}`;
          if (!nodes.has(to)) nodes.set(to, { id: to, kind: 'company', label: r.counterpart, val: 2, external: true, count: 0 });
        }
        if (to === from) continue;
        const [dir, label] = DIRECTION[r.relation] ?? ['none', r.relation];
        const [src, dst] = dir === 'in' ? [to, from] : [from, to];
        // 両方の会社のまとめに同じ関係が出てきても1本にする
        const key = (dir === 'none' ? [src, dst].sort().join('|') : `${src}>${dst}`) + label;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ source: src, target: dst, kind: 'capital', relation: label, directed: dir !== 'none', date: r.date, articleId: r.articleId });
      }
    }
  }

  // 似ている会社（線にはしない）
  const list = [...agg.values()];
  const similar = new Map<string, Similar[]>();
  for (let x = 0; x < list.length; x++)
    for (let y = x + 1; y < list.length; y++) {
      const r = similarity(list[x], list[y]);
      if (r.score < SIMILAR_MIN) continue;
      for (const [p, q] of [
        [list[x].cid, list[y].cid],
        [list[y].cid, list[x].cid],
      ])
        similar.set(`c:${p}`, [...(similar.get(`c:${p}`) ?? []), { id: `c:${q}`, ...r }]);
    }
  for (const [k, v] of similar) similar.set(k, v.sort((a, b) => b.score - a.score).slice(0, SIMILAR_MAX));

  return { nodes: [...nodes.values()], links, similar };
}

const endId = (v: unknown) => (typeof v === 'string' ? v : (v as { id: string }).id);

/** 丸 id とじかにつながる丸の id（自分も含む） */
export function neighbors(g: Pick<Graph, 'links'>, id: string): Set<string> {
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
    similar: g.similar,
  };
}

/** 資本関係（その会社の側から読んだ言い方：出資した／出資を受けた など） */
export function capitalOf(g: Pick<Graph, 'links'>, id: string): { other: string; relation: string; date: string; articleId?: string }[] {
  return g.links
    .filter((l) => l.kind === 'capital' && (endId(l.source) === id || endId(l.target) === id))
    .map((l) => {
      const isSource = endId(l.source) === id;
      const r = l.relation ?? '';
      return {
        other: isSource ? endId(l.target) : endId(l.source),
        relation: l.directed ? ((isSource ? AS_SOURCE[r] : AS_TARGET[r]) ?? r) : r,
        date: l.date ?? '',
        articleId: l.articleId,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 検索窓の言葉に当てはまる丸（会社は記事の中身でも探す） */
export function matchingNodes(g: Graph, q: string, articles: KbArticle[], names: Record<string, string>): Set<string> | null {
  const w = q.normalize('NFKC').toLowerCase().trim();
  if (!w) return null;
  const hitCompanies = new Set(articles.filter((a) => matchesText(a, q, names[a.companyId])).map((a) => `c:${a.companyId}`));
  return new Set(g.nodes.filter((n) => hitCompanies.has(n.id) || n.label.normalize('NFKC').toLowerCase().includes(w)).map((n) => n.id));
}

export const SERVICE_KEYS = [...SERVICES, 'その他'] as const;
