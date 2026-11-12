import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D from '3d-force-graph';
import ForceGraph from 'force-graph';
import SpriteText from 'three-spritetext';
import { around, buildGraph, matchingNodes, neighbors, similarOf, type GLink, type GNode, type Graph } from '../lib/graph';
import { fmtDate, n } from '../lib/format';
import { linkProps, navigate } from '../lib/router';
import type { KbData } from '../data/useKb';

/**
 * 知識のつながり（会社・テーマ・業界の丸と、似ている会社どうしの線）。3D と 2D を切り替えられる。
 * 丸を押すと、周りだけ光らせ、横に要点を出す。「ここを中心に広げる」で2歩先までに絞る。
 */

type Mode = '3d' | '2d';
const MODE_KEY = 'kb.graph.mode';
const readMode = (): Mode => {
  try {
    return localStorage.getItem(MODE_KEY) === '2d' ? '2d' : '3d';
  } catch {
    return '3d';
  }
};

/** 色（暗い表示・明るい表示）。テーマはサービスごとに色を分ける */
function palette() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return dark
    ? {
        bg: '#0b0e14',
        company: '#f2f4f8',
        industry: '#5fd3e6',
        similar: '#9db1ff',
        text: '#f2f4f8',
        service: { '経営・事業支援': '#b49cff', '資金調達・M&A支援': '#f2c14e', 'マーケ・営業支援': '#ff8fb1', '人材・組織支援': '#7fdcaa', その他: '#a3acbb' } as Record<string, string>,
      }
    : {
        bg: '#f4f6fa',
        company: '#1f2633',
        industry: '#0f7f93',
        similar: '#2a3d8f',
        text: '#10141c',
        service: { '経営・事業支援': '#6b46c1', '資金調達・M&A支援': '#b07800', 'マーケ・営業支援': '#c2185b', '人材・組織支援': '#17663f', その他: '#6b7280' } as Record<string, string>,
      };
}

/** 色を背景に近づけて薄くする（押した丸の周り以外を目立たなくする） */
function fade(hex: string, bg: string, t = 0.82): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [a, b] = [p(hex), p(bg)];
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

const endId = (v: unknown) => (typeof v === 'string' ? v : (v as { id: string }).id);
const KIND_LABEL = { company: '会社', theme: 'テーマ', industry: '業界' } as const;

type AnyGraph = {
  graphData: (d: Graph) => AnyGraph;
  width: (w: number) => AnyGraph;
  height: (h: number) => AnyGraph;
  _destructor: () => void;
  [k: string]: unknown;
};

export default function GraphPage({ data, q }: { data: KbData; q: string }) {
  const [mode, setMode] = useState<Mode>(readMode);
  const [similar, setSimilar] = useState(true);
  const [showInd, setShowInd] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [center, setCenter] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const graphRef = useRef<AnyGraph | null>(null);

  const full = useMemo(() => buildGraph(data.articles, data.names, data.themes, { similar, industries: showInd }), [data, similar, showInd]);
  const g = useMemo(() => (center && full.nodes.some((x) => x.id === center) ? around(full, center, 2) : full), [full, center]);
  const hits = useMemo(() => matchingNodes(g, q, data.articles, data.names), [g, q, data.articles, data.names]);
  const focus = useMemo(() => (selected ? neighbors(g, selected) : null), [g, selected]);
  const byId = useMemo(() => new Map(g.nodes.map((x) => [x.id, x])), [g]);

  // 見た目の決まり（押した丸・検索の当たりを目立たせ、ほかを薄く）。最新の値を描画のたびに読む
  const look = useRef({ focus, hits, selected });
  look.current = { focus, hits, selected };
  // 丸の配置が落ち着いたら、全体が画面に収まるように寄せる（データを渡し直したときだけ）
  const needFit = useRef(true);

  const choose = (id: string | null) => setSelected(id);

  // グラフを作る（3D / 2D を切り替えたら作り直す）
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const pal = palette();
    const lit = (id: string) => {
      const { focus: f, hits: h } = look.current;
      if (f) return f.has(id);
      if (h) return h.has(id);
      return true;
    };
    const nodeColor = (node: GNode) => {
      const c = node.kind === 'company' ? pal.company : node.kind === 'industry' ? pal.industry : (pal.service[node.service ?? 'その他'] ?? pal.service['その他']);
      return lit(node.id) ? c : fade(c, pal.bg);
    };
    const linkLit = (l: GLink) => lit(endId(l.source)) && lit(endId(l.target));
    const linkColor = (l: GLink) => {
      const c = l.kind === 'similar' ? pal.similar : l.kind === 'industry' ? pal.industry : pal.service['その他'];
      return linkLit(l) ? c : fade(c, pal.bg, 0.9);
    };
    const onClick = (node: GNode & { x?: number; y?: number; z?: number }) => {
      choose(node.id);
      const gr = graphRef.current as unknown as Record<string, (...a: unknown[]) => unknown>;
      if (mode === '3d') {
        const d = 120;
        const r = 1 + d / Math.max(1, Math.hypot(node.x ?? 0, node.y ?? 0, node.z ?? 0));
        gr.cameraPosition({ x: (node.x ?? 0) * r, y: (node.y ?? 0) * r, z: (node.z ?? 0) * r }, node, 900);
      } else {
        gr.centerAt(node.x, node.y, 600);
        gr.zoom(2.4, 600);
      }
    };
    let gr: AnyGraph;
    if (mode === '3d') {
      const fg = new ForceGraph3D(el, { controlType: 'orbit' });
      fg.backgroundColor(pal.bg)
        .showNavInfo(false)
        .nodeLabel(() => '')
        .nodeVal((x) => (x as GNode).val)
        .nodeRelSize(3)
        .nodeOpacity(0.95)
        .nodeColor((x) => nodeColor(x as GNode))
        .nodeThreeObjectExtend(true)
        .nodeThreeObject((x) => {
          const node = x as GNode;
          const s = new SpriteText(node.label.length > 18 ? node.label.slice(0, 17) + '…' : node.label);
          s.color = lit(node.id) ? pal.text : fade(pal.text, pal.bg, 0.85);
          s.textHeight = node.kind === 'company' ? 4.2 : 3.4;
          s.fontWeight = node.kind === 'company' ? '700' : '500';
          s.center.y = -0.9;
          return s;
        })
        .linkColor((l) => linkColor(l as GLink))
        .linkOpacity(0.55)
        .linkWidth((l) => ((l as GLink).kind === 'similar' ? 1.4 : 0.35))
        .onNodeClick((x) => onClick(x as GNode))
        .onBackgroundClick(() => choose(null));
      gr = fg as unknown as AnyGraph;
    } else {
      const fg = new ForceGraph(el);
      fg.backgroundColor(pal.bg)
        .nodeLabel(() => '')
        .nodeVal((x) => (x as GNode).val)
        .nodeRelSize(4)
        .nodeColor((x) => nodeColor(x as GNode))
        .nodeCanvasObjectMode(() => 'after')
        .nodeCanvasObject((x, ctx, scale) => {
          const node = x as GNode & { x: number; y: number };
          const size = (node.kind === 'company' ? 13 : 11) / scale;
          ctx.font = `${node.kind === 'company' ? 700 : 500} ${size}px "IBM Plex Sans JP", sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = lit(node.id) ? pal.text : fade(pal.text, pal.bg, 0.85);
          const r = Math.sqrt(node.val) * 4;
          ctx.fillText(node.label.length > 18 ? node.label.slice(0, 17) + '…' : node.label, node.x, node.y + r + 2 / scale);
        })
        .linkColor((l) => linkColor(l as GLink))
        .linkWidth((l) => ((l as GLink).kind === 'similar' ? 1.6 : 0.6))
        .linkLineDash((l) => ((l as GLink).kind === 'similar' ? [4, 3] : null))
        .onNodeClick((x) => onClick(x as GNode))
        .onBackgroundClick(() => choose(null));
      gr = fg as unknown as AnyGraph;
    }
    // 丸どうしの間隔を少し広げ、落ち着いたら全体を画面に収める
    const fx = gr as unknown as Record<string, (...a: unknown[]) => unknown>;
    (fx.d3Force('charge') as { strength: (v: number) => void } | undefined)?.strength(mode === '3d' ? -110 : -140);
    fx.cooldownTicks(160);
    fx.onEngineStop(() => {
      if (!needFit.current) return;
      needFit.current = false;
      fx.zoomToFit(700, 50);
    });
    graphRef.current = gr;
    const resize = () => gr.width(el.clientWidth).height(el.clientHeight);
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    return () => {
      ro.disconnect();
      gr._destructor();
      el.innerHTML = '';
      graphRef.current = null;
    };
  }, [mode]);

  // 丸と線を渡す（ライブラリが中身を書き換えるので写しを渡す）
  useEffect(() => {
    needFit.current = true;
    graphRef.current?.graphData({ nodes: g.nodes.map((x) => ({ ...x })), links: g.links.map((l) => ({ ...l })) });
  }, [g, mode]);

  // 押した丸・検索が変わったら描き直す
  useEffect(() => {
    const gr = graphRef.current as unknown as Record<string, (...a: unknown[]) => unknown> | null;
    if (!gr) return;
    gr.nodeColor(gr.nodeColor());
    gr.linkColor(gr.linkColor());
    if (mode === '3d') gr.nodeThreeObject(gr.nodeThreeObject());
  }, [focus, hits, mode]);

  // スマホ（図の下に要点が出る幅）では、丸を押したら要点まで下げる
  useEffect(() => {
    if (selected && matchMedia('(max-width: 900px)').matches) panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [selected]);

  const setModeSaved = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* 覚えられなくても動く */
    }
  };

  const node = selected ? byId.get(selected) : undefined;
  const companies = g.nodes.filter((x) => x.kind === 'company').length;
  const similarLinks = g.links.filter((l) => l.kind === 'similar').length;
  const pal = palette();

  return (
    <div className="graph">
      <div className="toolbar">
        <div className="seg">
          <button type="button" aria-pressed={mode === '3d'} onClick={() => setModeSaved('3d')}>
            3D
          </button>
          <button type="button" aria-pressed={mode === '2d'} onClick={() => setModeSaved('2d')}>
            2D
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={similar} onChange={(e) => setSimilar(e.target.checked)} />
          似ている会社どうしの線
        </label>
        <label className="check">
          <input type="checkbox" checked={showInd} onChange={(e) => setShowInd(e.target.checked)} />
          業界の丸
        </label>
        {center && (
          <button type="button" className="ghost" onClick={() => setCenter(null)}>
            全体に戻る
          </button>
        )}
        <span className="meta">
          会社 {n(companies)} · 似ている線 {n(similarLinks)}
          {hits ? ` · 「${q.trim()}」に当てはまる丸 ${n(hits.size)}` : ''}
        </span>
      </div>
      <div className="graphgrid">
        <div className="graphbox" ref={boxRef} aria-label="知識のつながりの図。丸を押すと横に要点が出ます" />
        <aside className="card graphpanel" ref={panelRef}>
          {!node ? (
            <>
              <h3>知識のつながり</h3>
              <p className="line">
                読んだ記事の会社を、テーマ・業界でつなぎました。点線（2D）・太い線（3D）は、共通点の多い「似ている会社」どうしです。丸を押すと、つながる丸だけが光り、ここに要点が出ます。
              </p>
              <p className="note">{mode === '3d' ? 'ドラッグで回す・ホイール（2本指）で近づく。' : 'ドラッグで動かす・ホイール（2本指）で拡大。'}何もない所を押すと元に戻ります。</p>
              <b className="lbl">丸の色</b>
              <ul className="legend">
                <li>
                  <i style={{ background: pal.company }} />会社（大きいほど記事・★が多い）
                </li>
                <li>
                  <i style={{ background: pal.industry }} />業界
                </li>
                {Object.entries(pal.service).map(([s, c]) => (
                  <li key={s}>
                    <i style={{ background: c }} />
                    テーマ（{s}）
                  </li>
                ))}
              </ul>
              <p className="note">似ている会社は、同じテーマ（3点）・同じ業界（2点）・同じ課題/狙い（1点）・同じ規模/段階（1点）の合計が3点以上の会社です。</p>
            </>
          ) : (
            <NodePanel
              node={node}
              g={g}
              data={data}
              byId={byId}
              onSelect={choose}
              onCenter={() => {
                setCenter(node.id);
              }}
              centered={center === node.id}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function NodePanel({
  node,
  g,
  data,
  byId,
  onSelect,
  onCenter,
  centered,
}: {
  node: GNode;
  g: Graph;
  data: KbData;
  byId: Map<string, GNode>;
  onSelect: (id: string) => void;
  onCenter: () => void;
  centered: boolean;
}) {
  const near = [...neighbors(g, node.id)].filter((id) => id !== node.id).map((id) => byId.get(id)!).filter(Boolean);
  const nearOf = (k: GNode['kind']) => near.filter((x) => x.kind === k);
  const jump = (id: string) => (
    <button type="button" className="nodelink" onClick={() => onSelect(id)}>
      {byId.get(id)?.label ?? id}
    </button>
  );
  const centerBtn = (
    <button type="button" className="ghost" disabled={centered} onClick={onCenter}>
      {centered ? '中心に表示中' : 'ここを中心に広げる'}
    </button>
  );

  if (node.kind === 'company') {
    const arts = data.articles.filter((a) => a.companyId === node.cid && a.kb);
    const kb = arts[0]?.kb;
    const sim = similarOf(g, node.id);
    return (
      <div className="panelbody">
        <span className="badge">会社</span>
        <h3>{node.label}</h3>
        <div className="badges">
          {kb?.industry && <span className="badge ind">{kb.industry}</span>}
          {kb?.stage && kb.stage !== '不明' && <span className="badge stage">{kb.stage}</span>}
        </div>
        <div className="panelacts">
          <a className="btn primary" {...linkProps(`/c/${node.cid}`)}>
            会社ページを開く
          </a>
          {centerBtn}
        </div>
        <b className="lbl">読んだ記事（{arts.length}件）</b>
        <ul className="plainlist">
          {arts.slice(0, 4).map((a) => (
            <li key={a.id}>
              <a href={a.url} target="_blank" rel="noreferrer">
                {a.kb?.caseTitle || a.title}
              </a>
              <small className="sub"> {fmtDate(a.publishedAt)}</small>
            </li>
          ))}
        </ul>
        {kb && kb.talk.length > 0 && (
          <div className="block talkbox">
            <b className="lbl">トーク例</b>
            <ul className="talk">
              {kb.talk.slice(0, 2).map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </div>
        )}
        <b className="lbl">似ている会社（{sim.length}社）</b>
        {sim.length === 0 ? (
          <p className="note">共通点が3点以上の会社はまだありません。</p>
        ) : (
          <ul className="simlist">
            {sim.map((s) => (
              <li key={s.id}>
                {jump(s.id)} <span className="score">{s.score}点</span>
                <small className="sub">{s.reasons.join('、')}</small>
              </li>
            ))}
          </ul>
        )}
        {nearOf('theme').length > 0 && (
          <>
            <b className="lbl">テーマ</b>
            <div className="chips">
              {nearOf('theme').map((t) => (
                <button key={t.id} type="button" className="chip" onClick={() => onSelect(t.id)}>
                  # {t.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  const comps = nearOf('company').sort((a, b) => b.val - a.val);
  const theme = node.kind === 'theme' ? data.themes.find((t) => t.name === node.label) : undefined;
  return (
    <div className="panelbody">
      <span className="badge">{KIND_LABEL[node.kind]}</span>
      <h3>{node.label}</h3>
      {theme?.description && <p className="line">{theme.description}</p>}
      {node.service && <small className="sub">{node.service}</small>}
      <div className="panelacts">
        {node.kind === 'theme' && (
          <button type="button" className="btn primary" onClick={() => navigate(`/themes/${node.label}`)}>
            ネタ帳で開く
          </button>
        )}
        {centerBtn}
      </div>
      <b className="lbl">つながる会社（{comps.length}社）</b>
      <ul className="simlist">
        {comps.map((c) => (
          <li key={c.id}>{jump(c.id)}</li>
        ))}
      </ul>
    </div>
  );
}
