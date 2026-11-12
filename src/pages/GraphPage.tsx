import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D from '3d-force-graph';
import ForceGraph from 'force-graph';
import SpriteText from 'three-spritetext';
import { Vector3, type SpriteMaterial } from 'three';
import { around, buildGraph, capitalOf, matchingNodes, neighbors, type GLink, type GNode, type Graph } from '../lib/graph';
import { fmtDate, n } from '../lib/format';
import { linkProps, navigate } from '../lib/router';
import type { KbData } from '../data/useKb';

/**
 * 知識のつながり。会社と会社を直接結ぶ線は資本関係だけ。ビジネスが似ている会社は 会社─ビジネス─会社 でつなぐ。3D と 2D を切り替えられる。
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
        business: '#ff9f5a',
        capital: '#ff6b6b',
        external: '#7c8496',
        text: '#f2f4f8',
        service: { '経営・事業支援': '#b49cff', '資金調達・M&A支援': '#f2c14e', 'マーケ・営業支援': '#ff8fb1', '人材・組織支援': '#7fdcaa', その他: '#a3acbb' } as Record<string, string>,
      }
    : {
        bg: '#f4f6fa',
        company: '#1f2633',
        industry: '#0f7f93',
        business: '#c2410c',
        capital: '#d62d2d',
        external: '#9aa1ad',
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

/**
 * 名前は近づいたときだけ出す（遠くでは重なって読めないため）。
 * 3D：画面に映る文字の高さが LABEL_PX_FROM（px）で出はじめ、LABEL_PX_FULL 以上ではっきり（読める大きさになったら出す）
 * 2D：拡大率が LABEL_FROM_2D 以上で出はじめ、LABEL_FULL_2D 以上ではっきり
 * 押した丸とつながる丸・検索で当たった丸は、遠くても出す。マウスを乗せた丸は小さく名前を出す
 */
const LABEL_PX_FROM = 7;
const LABEL_PX_FULL = 10;
const LABEL_FROM_2D = 1.2;
const LABEL_FULL_2D = 2;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 3D の球の大きさの係数と、球の半径（3d-force-graph と同じ計算：∛val × nodeRelSize） */
const REL_3D = 3;
const sphereRadius3d = (val: number) => Math.cbrt(Math.max(0, val)) * REL_3D;

const endId = (v: unknown) => (typeof v === 'string' ? v : (v as { id: string }).id);
const KIND_LABEL = { company: '会社', business: 'ビジネス', theme: 'テーマ', industry: '業界' } as const;

type AnyGraph = {
  graphData: (d: Pick<Graph, "nodes" | "links">) => AnyGraph;
  width: (w: number) => AnyGraph;
  height: (h: number) => AnyGraph;
  _destructor: () => void;
  [k: string]: unknown;
};

export default function GraphPage({ data, q }: { data: KbData; q: string }) {
  const [mode, setMode] = useState<Mode>(readMode);
  const [show, setShow] = useState({ businesses: true, capital: true, themes: true, industries: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [center, setCenter] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const graphRef = useRef<AnyGraph | null>(null);

  const full = useMemo(() => buildGraph(data.articles, data.names, data.themes, data.companies, show), [data, show]);
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
    /** 遠くても名前を出す丸（押した丸とつながる丸、検索で当たった丸） */
    const forced = (id: string) => {
      const { focus: f, hits: h } = look.current;
      return f ? f.has(id) : h ? h.has(id) : false;
    };
    const tooltip = (x: unknown) => `<span class="gtip">${esc((x as GNode).label)}</span>`;
    const nodeColor = (node: GNode) => {
      const c =
        node.kind === 'company'
          ? node.external
            ? pal.external
            : pal.company
          : node.kind === 'business'
            ? pal.business
            : node.kind === 'industry'
              ? pal.industry
              : (pal.service[node.service ?? 'その他'] ?? pal.service['その他']);
      return lit(node.id) ? c : fade(c, pal.bg);
    };
    const linkLit = (l: GLink) => lit(endId(l.source)) && lit(endId(l.target));
    const linkColor = (l: GLink) => {
      const c = l.kind === 'capital' ? pal.capital : l.kind === 'business' ? pal.business : l.kind === 'industry' ? pal.industry : pal.service['その他'];
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
        .nodeLabel(tooltip)
        .nodeVal((x) => (x as GNode).val)
        .nodeRelSize(REL_3D)
        // 球をなめらかに（初期の 8 分割だと角ばって凸凹に見える）。透けると重なりがまだらに見えるので不透明に
        .nodeResolution(32)
        .nodeOpacity(1)
        .nodeColor((x) => nodeColor(x as GNode))
        .nodeThreeObjectExtend(true)
        .nodeThreeObject((x) => {
          const node = x as GNode;
          const s = new SpriteText(node.label.length > 18 ? node.label.slice(0, 17) + '…' : node.label);
          s.color = lit(node.id) ? pal.text : fade(pal.text, pal.bg, 0.85);
          s.textHeight = node.kind === 'company' ? 4.2 : 3.4;
          s.fontWeight = node.kind === 'company' ? '700' : '500';
          // 名前は自分の球に重ならないよう、球の大きさ（半径 = ∛大きさ × REL_3D）の分だけ真下に離す
          s.position.y = -(sphereRadius3d(node.val) + s.textHeight * 1.05);
          // 近づいたときだけ名前を出す（描くたびにカメラとの距離で濃さを決める）
          const mat = s.material as SpriteMaterial;
          mat.transparent = true;
          mat.depthWrite = false;
          const at = new Vector3();
          s.onBeforeRender = (renderer, _sc, camera) => {
            if (forced(node.id)) {
              mat.opacity = 1;
              return;
            }
            // 画面に映る文字の高さ（px）= 文字の高さ × 画面の高さ ÷（2 × 距離 × tan(視野角/2)）
            const d = Math.max(1, camera.position.distanceTo(s.getWorldPosition(at)));
            const fov = ((camera as { fov?: number }).fov ?? 40) * (Math.PI / 180);
            const px = (s.textHeight * renderer.domElement.clientHeight) / (2 * d * Math.tan(fov / 2));
            mat.opacity = clamp01((px - LABEL_PX_FROM) / (LABEL_PX_FULL - LABEL_PX_FROM));
          };
          return s;
        })
        .linkColor((l) => linkColor(l as GLink))
        .linkOpacity(0.55)
        .linkWidth((l) => ((l as GLink).kind === 'capital' ? 2.2 : (l as GLink).kind === 'business' ? 0.9 : 0.3))
        .onNodeClick((x) => onClick(x as GNode))
        .onBackgroundClick(() => choose(null));
      gr = fg as unknown as AnyGraph;
    } else {
      const fg = new ForceGraph(el);
      fg.backgroundColor(pal.bg)
        .nodeLabel(tooltip)
        .nodeVal((x) => (x as GNode).val)
        .nodeRelSize(4)
        .nodeColor((x) => nodeColor(x as GNode))
        .nodeCanvasObjectMode(() => 'after')
        .nodeCanvasObject((x, ctx, scale) => {
          const node = x as GNode & { x: number; y: number };
          // 近づいた（拡大した）ときだけ名前を出す
          const alpha = forced(node.id) ? 1 : clamp01((scale - LABEL_FROM_2D) / (LABEL_FULL_2D - LABEL_FROM_2D));
          if (alpha <= 0.02) return;
          const size = (node.kind === 'company' ? 13 : 11) / scale;
          ctx.font = `${node.kind === 'company' ? 700 : 500} ${size}px "IBM Plex Sans JP", sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = lit(node.id) ? pal.text : fade(pal.text, pal.bg, 0.85);
          // 名前は自分の丸に重ならないよう、丸の半径（√大きさ × 4）の下に置く
          const r = Math.sqrt(Math.max(0, node.val)) * 4;
          ctx.globalAlpha = alpha;
          ctx.fillText(node.label.length > 18 ? node.label.slice(0, 17) + '…' : node.label, node.x, node.y + r + 3 / scale);
          ctx.globalAlpha = 1;
        })
        .linkColor((l) => linkColor(l as GLink))
        .linkWidth((l) => ((l as GLink).kind === 'capital' ? 2.6 : (l as GLink).kind === 'business' ? 1.4 : 0.6))
        .linkLineDash((l) => ((l as GLink).kind === 'theme' || (l as GLink).kind === 'industry' ? [2, 3] : null))
        .linkDirectionalArrowLength((l) => ((l as GLink).directed ? 6 : 0))
        .linkDirectionalArrowRelPos(0.6)
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

  /** 拡大・回転・移動したあとに、最初の「全体が収まる表示」に戻す（押した丸の光りも消す） */
  const resetView = () => {
    const gr = graphRef.current as unknown as Record<string, (...a: unknown[]) => unknown> | null;
    if (!gr) return;
    setSelected(null);
    if (mode === '3d') {
      // 正面から見る向きに戻してから、全体を収める
      const cam = gr.cameraPosition() as { x: number; y: number; z: number };
      gr.cameraPosition({ x: 0, y: 0, z: Math.max(200, Math.hypot(cam.x, cam.y, cam.z)) }, { x: 0, y: 0, z: 0 }, 500);
      setTimeout(() => gr.zoomToFit(600, 50), 520);
    } else {
      gr.zoomToFit(600, 50);
    }
  };

  const setModeSaved = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* 覚えられなくても動く */
    }
  };

  const node = selected ? byId.get(selected) : undefined;
  const companies = g.nodes.filter((x) => x.kind === 'company' && !x.external).length;
  const businessCount = g.nodes.filter((x) => x.kind === 'business').length;
  const capitalLinks = g.links.filter((l) => l.kind === 'capital').length;
  const noBusiness = data.articles.length > 0 && Object.values(data.companies).every((c) => !c.businesses?.length);
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
        {(
          [
            ['businesses', 'ビジネス'],
            ['capital', '資本関係'],
            ['themes', 'テーマ'],
            ['industries', '業界'],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="check">
            <input type="checkbox" checked={show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} />
            {label}
          </label>
        ))}
        {center && (
          <button type="button" className="ghost" onClick={() => setCenter(null)}>
            全体に戻る
          </button>
        )}
        <span className="meta">
          会社 {n(companies)} · ビジネス {n(businessCount)} · 資本関係 {n(capitalLinks)}
          {hits ? ` · 「${q.trim()}」に当てはまる丸 ${n(hits.size)}` : ''}
        </span>
      </div>
      <div className="graphgrid">
        <div className="graphwrap">
          <div className="graphbox" ref={boxRef} aria-label="知識のつながりの図。丸を押すと横に要点が出ます" />
          <button type="button" className="graphreset" onClick={resetView} title="拡大・回転を元に戻し、全体を表示します">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3 8V3h5M17 12v5h-5M3 3l5 5M17 17l-5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            全体を表示
          </button>
        </div>
        <aside className="card graphpanel" ref={panelRef}>
          {!node ? (
            <>
              <h3>知識のつながり</h3>
              <p className="line">
                会社と会社を直接結ぶ赤い線は<b>資本関係</b>（出資・買収・子会社化・資本業務提携など。2D の矢印は、出資・買収する側 → される側）だけです。ビジネスが似ている会社は、オレンジの<b>ビジネス</b>の丸を間にはさんでつながります。丸を押すと、つながる丸だけが光り、ここに要点が出ます。
              </p>
              {noBusiness && <p className="note">ビジネスと資本関係は、会社の AI のまとめを作り直すと出てきます（自動で1社ずつ進めています）。</p>}
              <p className="note">{mode === '3d' ? 'ドラッグで回す・ホイール（2本指）で近づく。' : 'ドラッグで動かす・ホイール（2本指）で拡大。'}名前は近づいたときだけ出ます（丸にマウスを乗せても出ます）。何もない所を押すと光りが消え、右上の「全体を表示」で拡大・回転も元に戻ります。</p>
              <b className="lbl">丸の色</b>
              <ul className="legend">
                <li>
                  <i style={{ background: pal.company }} />会社（大きいほど記事・★が多い）
                </li>
                <li>
                  <i style={{ background: pal.external }} />資本関係の相手（まだ記事を読んでいない会社・ファンド）
                </li>
                <li>
                  <i style={{ background: pal.business }} />ビジネス（事業）
                </li>
                <li>
                  <i className="bar" style={{ background: pal.capital }} />資本関係の線
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
              <p className="note">会社を押すと「似ている会社」も出ます（線にはしません）。同じビジネス・同じテーマ（各3点）、同じ業界（2点）、同じ課題/狙い・同じ規模/段階（各1点）の合計が3点以上の会社です。</p>
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

  const cap = capitalOf(g, node.id);
  const capList = cap.length > 0 && (
    <>
      <b className="lbl">資本関係（{cap.length}件）</b>
      <ul className="simlist">
        {cap.map((c, i) => (
          <li key={i}>
            <span className="badge cap">{c.relation}</span>
            {jump(c.other)}
            <small className="sub">
              {c.date}
              {c.articleId && (
                <>
                  {' · '}
                  <a href={`https://prtimes.jp/main/html/rd/p/${c.articleId}.html`} target="_blank" rel="noreferrer">
                    根拠の記事
                  </a>
                </>
              )}
            </small>
          </li>
        ))}
      </ul>
    </>
  );

  if (node.kind === 'company' && node.external) {
    return (
      <div className="panelbody">
        <span className="badge">資本関係の相手</span>
        <h3>{node.label}</h3>
        <p className="note">まだ記事を読んでいない会社・ファンドです。読んだ会社の資本関係から出てきました。</p>
        <div className="panelacts">{centerBtn}</div>
        {capList}
      </div>
    );
  }

  if (node.kind === 'company') {
    const arts = data.articles.filter((a) => a.companyId === node.cid && a.kb);
    const kb = arts[0]?.kb;
    const sim = g.similar.get(node.id) ?? [];
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
        {nearOf('business').length > 0 && (
          <>
            <b className="lbl">ビジネス</b>
            <div className="chips">
              {nearOf('business').map((t) => (
                <button key={t.id} type="button" className="chip biz" onClick={() => onSelect(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>
          </>
        )}
        {capList}
        <b className="lbl">似ている会社（{sim.length}社）</b>
        {sim.length === 0 ? (
          <p className="note">共通点が3点以上の会社はまだありません。</p>
        ) : (
          <ul className="simlist">
            {sim.map((s) => (
              <li key={s.id}>
                {byId.has(s.id) ? jump(s.id) : <b>{data.names[s.id.slice(2)] ?? s.id}</b>} <span className="score">{s.score}点</span>
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
