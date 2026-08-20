"use client";
// OntoCode v10 · 地图：把本域 Ontology 的链路按流程先后摆出来。
//
// 之前画的是一棵缩进树。树只给得起一个父亲，所以「两条线汇到同一个环节」被降级成
// 一句「汇入 X」的文字、环被降级成一句「回到 X」，深链还会被缩进推到右边缘。业务
// 上最要紧的三件事——合流、分叉、往返——全都不是可见结构，得靠读文字重建。
//
// 现在它们都是结构：合流是卡顶的汇合冠（每条来源落在自己的锚点上），分叉是卡底的
// 结果条（线从各自的锚点发散），往返是左侧回流沟 + 一个把成员框住的往返框。执行方
// 边界占真实空间——一条道一列，道头写本体自己声明的原文。
//
// 坐标全部来自 `ontology-map-layout.ts`（纯整数、与视口无关）+ `ontology-map-geometry.ts`
// （整数 → 像素）。没有任何一处判断依赖动作名、事件名或类别名的字面量：把整份本体
// 改名，图的形状一个像素都不会变。
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchOntoCodeArtifactVersionContent,
  ONTOCODE_KEYS,
  type OntoCodeArtifactSummaryItem,
} from "@/lib/hooks/useOntoCodeWorkspace";
import styles from "./workbench.module.css";
import { latestStageDocumentForKind } from "./ArtifactInspector";
import { readMapSource } from "./ontology-map-model";
import {
  buildOntologyMapLayout,
  type OntologyMapModel,
} from "./ontology-map-layout";
import {
  buildMapMinimap,
  buildMapScene,
  foldRuns,
  truncateLabel,
  type MapScene,
  type SceneEdge,
  type SceneNode,
} from "./ontology-map-geometry";

/** 未匹配标签在一颗 chip 里的分隔符。 */
const LABEL_JOIN = "、";
/**
 * 取景档位。缩放只改画布的呈现尺寸，绝不回头去改布局——布局是本体结构的
 * 纯函数，容器尺寸永远不许进入它。
 */
const ZOOM_STEPS = [0.2, 0.3, 0.45, 0.6, 0.8, 1, 1.3];
const ZOOM_DEFAULT = 1;
/** 缩略条的固定尺寸。整张图等比塞进这条带子，用来在长图上定位。 */
const MINIMAP_W = 208;
const MINIMAP_H = 116;
/** 本体没声明执行方时的如实说法——绝不并进任何一边。 */
const UNDECLARED_LANE = "本体未声明执行方";
/**
 * 执行方多到摆不下时布局会把道并成一条。那条道既不属于谁、也不是「没声明」，
 * 必须自己有一句话——否则「并过」会冒充「本体没声明」，是两件完全不同的事。
 */
const COLLAPSED_LANE = "执行方已并成一条道";
/** 箭头三角的边长。 */
const ARROW = 6;

/** 道头文案取本体自己声明的原文；空串与并道各有自己的说法。 */
type LaneCaption = (id: string) => string;

function laneText(id: string): string {
  return id === "" ? UNDECLARED_LANE : id;
}

/* -------------------------------- SVG 片段 -------------------------------- */

function pointsAttr(points: Array<[number, number]>): string {
  return points.map(([x, y]) => `${x},${y}`).join(" ");
}

/** 箭头：按最后一段的走向摆一个三角形，不用 marker（marker 需要全局 id）。 */
function Arrow(props: { at: [number, number]; from: [number, number] }) {
  const [x, y] = props.at;
  const [px, py] = props.from;
  const dx = x - px;
  const dy = y - py;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const tail = [x - ux * ARROW, y - uy * ARROW];
  const left = [tail[0]! - uy * (ARROW / 2), tail[1]! + ux * (ARROW / 2)];
  const right = [tail[0]! + uy * (ARROW / 2), tail[1]! - ux * (ARROW / 2)];
  return (
    <polygon
      className={styles.mapArrow}
      points={`${x},${y} ${Math.round(left[0]!)},${Math.round(left[1]!)} ${Math.round(right[0]!)},${Math.round(right[1]!)}`}
    />
  );
}

function EdgeShape(props: { edge: SceneEdge; showLabels: boolean }) {
  const { edge } = props;
  const back = edge.kind === "back";
  // 线上的名字按预算截尾；全名永远在这条线自己的说明里，不必去别处找。
  const full = edge.eventLabels.join(LABEL_JOIN);
  return (
    <g
      data-oc-edge={edge.kind}
      data-oc-handoff={edge.handoff ? "true" : undefined}
      data-oc-gutter={back ? edge.gutter ?? 0 : undefined}
      className={back ? styles.mapEdgeBack : styles.mapEdge}
    >
      {full ? <title>{full}</title> : null}
      <polyline className={styles.mapEdgeLine} points={pointsAttr(edge.points)} />
      <Arrow at={edge.arrowAt} from={edge.arrowFrom} />
      {back ? (
        // 一条回边把小半张图圈进同一个往返组时，铺一句「会回到前面」等于没说；
        // 说清楚它落在哪个环节上，才答得出「环在哪闭合」。
        <text
          className={styles.mapEdgeNote}
          x={edge.noteAt[0] + 6}
          y={edge.noteAt[1]}
        >
          {`回到 ${truncateLabel(edge.toLabel, "dots")}`}
        </text>
      ) : null}
      {props.showLabels && edge.handoff ? (
        <text
          className={styles.mapHandoffTag}
          x={edge.midpoint[0]}
          y={edge.midpoint[1]}
          textAnchor="middle"
        >
          交接
        </text>
      ) : null}
      {props.showLabels && !back && edge.eventLabels.length > 0 ? (
        <text
          className={styles.mapEdgeChip}
          x={edge.midpoint[0] + 8}
          y={edge.midpoint[1] + 4}
        >
          {edge.eventLabels.length > 1
            ? `${truncateLabel(edge.eventLabels[0]!, "dots")} +${edge.eventLabels.length - 1}`
            : truncateLabel(edge.eventLabels[0]!, "dots")}
        </text>
      ) : null}
    </g>
  );
}

function NodeShape(props: {
  node: SceneNode;
  scene: MapScene;
  laneCaption: LaneCaption;
  onToggleFold: (foldId: string) => void;
}) {
  const { node, scene } = props;
  const isEvent = node.kind === "event";
  const rounded = node.laneOrder !== null && node.laneOrder % 2 === 0;
  const title = truncateLabel(node.label, scene.tier);
  const folded = node.foldCount > 0;
  const className = [
    isEvent ? styles.mapPill : styles.mapCard,
    folded ? styles.mapFoldCard : null,
    node.highlighted || node.focused ? styles.mapCardHit : null,
  ]
    .filter(Boolean)
    .join(" ");
  const foldId = node.foldId;
  return (
    <g
      data-oc-node={node.kind}
      data-oc-lane={node.laneId ? node.laneId : undefined}
      data-oc-lane-undeclared={node.laneId === "" ? "true" : undefined}
      data-oc-highlighted={node.highlighted ? "true" : undefined}
      data-oc-focused={node.focused ? "true" : undefined}
      data-oc-event-role={node.eventRole ?? undefined}
      data-oc-fanout={
        isEvent && node.outDegree >= 2 ? node.outDegree : undefined
      }
      data-oc-fold={folded ? node.foldCount : undefined}
      className={folded ? styles.mapFoldHit : undefined}
      onClick={foldId ? () => props.onToggleFold(foldId) : undefined}
    >
      {/* 合并卡交代自己折了谁——原名一个不少，永远不做「更多」这种交代。 */}
      <title>{folded ? node.foldedLabels.join(LABEL_JOIN) : node.label}</title>
      <rect
        className={className}
        x={node.x}
        y={node.y}
        width={node.w}
        height={node.h}
        rx={isEvent ? Math.round(node.h / 2) : rounded ? 9 : 2}
      />
      {!isEvent && node.laneOrder !== null ? (
        <line
          className={styles.mapLaneStripe}
          x1={node.x + 1}
          y1={node.y + 4}
          x2={node.x + 1}
          y2={node.y + node.h - 4}
          strokeDasharray={node.laneOrder % 2 === 0 ? undefined : "3 3"}
        />
      ) : null}
      <text
        className={isEvent ? styles.mapPillText : styles.mapCardText}
        x={node.cx}
        y={node.y + Math.round(node.h / 2) + 4}
        textAnchor="middle"
      >
        {title}
      </text>
      {scene.tier === "full" && !isEvent && node.laneId !== null ? (
        <text
          className={styles.mapCardLane}
          x={node.cx}
          y={node.y + Math.round(node.h / 2) + 17}
          textAnchor="middle"
        >
          {props.laneCaption(node.laneId)}
        </text>
      ) : null}
      {node.entryPorts.map((label, index) => (
        <text
          key={label}
          data-oc-entry-port=""
          className={styles.mapPort}
          x={node.x + 4}
          y={node.y - 6 - index * 12}
        >
          {`${truncateLabel(label, "dots")} · 图内无来源`}
        </text>
      ))}
      {node.exitPorts.map((label, index) => (
        <text
          key={label}
          data-oc-exit-port=""
          className={styles.mapPort}
          x={node.x + 4}
          y={node.y + node.h + 14 + index * 12}
        >
          {`${truncateLabel(label, "dots")} · 无后续环节`}
        </text>
      ))}
      {node.selfLoops.map((label) => (
        <text
          key={label}
          data-oc-self-loop=""
          className={styles.mapPort}
          x={node.x - 4}
          y={node.y + Math.round(node.h / 2)}
          textAnchor="end"
        >
          {`↺ ${truncateLabel(label, "dots")}`}
        </text>
      ))}
    </g>
  );
}

function Canvas(props: {
  scene: MapScene;
  laneCaption: LaneCaption;
  zoom: number;
  onToggleFold: (foldId: string) => void;
}) {
  const { scene } = props;
  const showLabels = scene.tier !== "dots";
  // 缩放只改呈现尺寸：viewBox 不变，所以形状与坐标一个字节都不动。
  return (
    <svg
      aria-hidden="true"
      className={styles.mapSvg}
      width={Math.round(scene.width * props.zoom)}
      height={Math.round(scene.height * props.zoom)}
      viewBox={`0 0 ${scene.width} ${scene.height}`}
    >
      {/* 道：占真实空间的一列，道头写本体自己声明的原文。 */}
      {scene.lanes.map((lane) => (
        <g key={`lane-${lane.order}`}>
          <rect
            className={
              lane.order % 2 === 0 ? styles.mapLaneBand : styles.mapLaneBandAlt
            }
            x={lane.x - 8}
            y={0}
            width={lane.w + 16}
            height={scene.height}
          />
          <text
            data-oc-lane-head={lane.id}
            className={styles.mapLaneHead}
            x={lane.x}
            y={19}
          >
            {props.laneCaption(lane.id)}
          </text>
        </g>
      ))}
      {/* 结果列：被多个环节产出或接住的结果站在这里，所以它也得有个名字。 */}
      {scene.junction ? (
        <text
          className={styles.mapLaneHead}
          x={scene.junction.x}
          y={19}
        >
          结果
        </text>
      ) : null}
      {/* 互不相连的流程之间画一道分隔，并说清楚这是另一段——不编号。 */}
      {scene.components
        .filter((component) => component.position > 0)
        .map((component) => (
          <g key={`sep-${component.position}`} data-oc-component-break="">
            <line
              className={styles.mapSeparator}
              x1={0}
              y1={component.top - 30}
              x2={scene.width}
              y2={component.top - 30}
            />
            <text
              className={styles.mapSeparatorText}
              x={8}
              y={component.top - 12}
            >
              {`另一段互不相连的流程 · ${component.actionCount} 个环节`}
            </text>
          </g>
        ))}
      {/* 往返框：成员各自留在自己的道上，框把它们围起来。
          框本身只说得出「这些是一个环」；真正有用的是它在哪儿闭合，所以
          标题直接写出回边的落点，不再让一个满页大框独自代表一句「有环」。 */}
      {scene.loops.map((loop) => (
        <g key={loop.slot} data-oc-loop={loop.memberCount}>
          <title>
            {loop.closes
              .map((close) => `${close.from} → ${close.to}`)
              .join(LABEL_JOIN)}
          </title>
          <rect
            className={styles.mapLoopFrame}
            x={loop.x}
            y={loop.y}
            width={loop.w}
            height={loop.h}
            rx={12}
          />
          <text className={styles.mapLoopText} x={loop.x + 6} y={loop.y - 5}>
            {loopCaption(loop.memberCount, loop.closes)}
          </text>
        </g>
      ))}
      {scene.edges.map((edge) => (
        <EdgeShape key={edge.slot} edge={edge} showLabels={showLabels} />
      ))}
      {/* 汇合冠：横棒 + 每条来源一个锚点。只说有几个来源。 */}
      {scene.crowns.map((crown) => (
        <g key={crown.slot} data-oc-merge={crown.count}>
          <line
            className={styles.mapCrownBar}
            x1={crown.x}
            y1={crown.y}
            x2={crown.x + crown.w}
            y2={crown.y}
          />
          {crown.anchors.map((anchor) => (
            <circle
              key={anchor.slot}
              data-oc-merge-anchor=""
              className={styles.mapAnchor}
              cx={anchor.x}
              cy={anchor.y}
              r={3}
            />
          ))}
          {showLabels ? (
            <text
              className={styles.mapCrownCount}
              x={crown.x + crown.w + 6}
              y={crown.y + 4}
            >
              {`${crown.count} 个来源`}
            </text>
          ) : null}
        </g>
      ))}
      {/* 结果条：线从各自的锚点发散，不从同一点出发。不标互斥——本体没声明。 */}
      {scene.forks.map((fork) => (
        <g key={fork.slot} data-oc-fork={fork.count}>
          <line
            className={styles.mapForkBar}
            x1={fork.x}
            y1={fork.y}
            x2={fork.x + fork.w}
            y2={fork.y}
          />
          {fork.anchors.map((anchor) => (
            <circle
              key={anchor.slot}
              data-oc-fork-anchor=""
              className={styles.mapAnchor}
              cx={anchor.x}
              cy={anchor.y}
              r={3}
            />
          ))}
          {showLabels ? (
            <text
              className={styles.mapForkCount}
              x={fork.x + fork.w + 6}
              y={fork.y + 4}
            >
              {`${fork.count} 种结果`}
            </text>
          ) : null}
        </g>
      ))}
      {scene.nodes.map((node) => (
        <NodeShape
          key={node.slot}
          node={node}
          scene={scene}
          laneCaption={props.laneCaption}
          onToggleFold={props.onToggleFold}
        />
      ))}
    </svg>
  );
}

/**
 * 往返框的标题。回边的落点就是环的闭合处——这是这个框唯一说得准、
 * 又确实有人要问的事。多条回边只报头一条 + 还有几条，全名在 `<title>` 里。
 */
function loopCaption(
  memberCount: number,
  closes: Array<{ from: string; to: string }>,
): string {
  const head = closes[0];
  if (!head) return `往返 · ${memberCount} 个环节`;
  const more = closes.length > 1 ? ` +${closes.length - 1}` : "";
  return `往返 ${memberCount} 个 · ${truncateLabel(head.from, "dots")} 回到 ${truncateLabel(head.to, "dots")}${more}`;
}

/** 缩略条：整张图等比铺成一条带子，取景框跟着滚动位置走。 */
function Minimap(props: {
  scene: MapScene;
  viewport: { left: number; top: number; width: number; height: number } | null;
  zoom: number;
  onJump: (fraction: { x: number; y: number }) => void;
}) {
  const mini = buildMapMinimap(props.scene, MINIMAP_W, MINIMAP_H);
  const scale = mini.scale / Math.max(props.zoom, 0.01);
  const view = props.viewport;
  const box = view
    ? {
        x: Math.max(0, Math.round(view.left * scale)),
        y: Math.max(0, Math.round(view.top * scale)),
        w: Math.min(mini.width, Math.round(view.width * scale)),
        h: Math.min(mini.height, Math.round(view.height * scale)),
      }
    : { x: 0, y: 0, w: mini.width, h: mini.height };
  return (
    <svg
      data-oc-minimap=""
      className={styles.mapMini}
      width={mini.width}
      height={mini.height}
      viewBox={`0 0 ${mini.width} ${mini.height}`}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        props.onJump({
          x: (event.clientX - rect.left) / rect.width,
          y: (event.clientY - rect.top) / rect.height,
        });
      }}
    >
      {mini.rects.map((entry) => (
        <rect
          key={entry.slot}
          className={
            entry.folded
              ? styles.mapMiniFold
              : entry.kind === "event"
                ? styles.mapMiniPill
                : styles.mapMiniCard
          }
          x={entry.x}
          y={entry.y}
          width={entry.w}
          height={entry.h}
        />
      ))}
      <rect
        data-oc-minimap-viewport=""
        className={styles.mapMiniViewport}
        x={box.x}
        y={box.y}
        width={Math.max(box.w, 2)}
        height={Math.max(box.h, 2)}
      />
    </svg>
  );
}

/**
 * 画布是给眼睛的，这份清单是给读屏和键盘的——两者同源，顺序就是画布上的顺序
 * （分量 → 层 → 列 → 次序）。画布 aria-hidden，可访问的语义全在这里。
 */
function StructureList(props: {
  scene: MapScene;
  laneCaption: LaneCaption;
  onToggleFold: (foldId: string) => void;
}) {
  const names = (labels: string[]) =>
    labels.length > 0 ? `（${labels.join(LABEL_JOIN)}）` : "";
  return (
    <ol className={styles.mapList}>
      {props.scene.nodes.map((node) => {
        // 卡面按字符预算截尾，这份清单永远是全名——截断在这套代码里等于撒谎。
        const sources = [...node.inLabels, ...node.entryPorts];
        const results = [...node.outLabels, ...node.exitPorts];
        const foldId = node.foldId;
        return (
          <li key={node.slot}>
            <span>{node.label}</span>
            {/* 合并卡在这里交出被折进去的全部原名与结果名。任何规模下，
                动作原名都不许从可访问表述里消失，展开也只是一次点击。 */}
            {foldId ? (
              <>
                <span>{` · 折了${names(node.foldedLabels)}`}</span>
                {node.foldedEventLabels.length > 0 ? (
                  <span>{` · 段内结果${names(node.foldedEventLabels)}`}</span>
                ) : null}
                <button
                  type="button"
                  onClick={() => props.onToggleFold(foldId)}
                >
                  {`展开 ${node.foldCount} 个`}
                </button>
              </>
            ) : null}
            {node.kind === "action" && node.laneId !== null ? (
              <span>{` · 执行方 ${props.laneCaption(node.laneId)}`}</span>
            ) : null}
            <span>{` · 来源 ${sources.length}${names(sources)}`}</span>
            <span>{` · 结果 ${results.length}${names(results)}`}</span>
            {node.entryPorts.length > 0 ? <span> · 图内无来源</span> : null}
            {node.exitPorts.length > 0 ? <span> · 无后续环节</span> : null}
            {node.selfLoops.length > 0 ? (
              <span>{` · 自己回到自己${names(node.selfLoops)}`}</span>
            ) : null}
            {node.inLoop ? <span> · 会回到前面</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/* --------------------------------- 视图 --------------------------------- */

export interface OntologyMapViewProps {
  model: OntologyMapModel;
  loading: boolean;
  error: string | null;
  /**
   * 全屏是外壳的能力：按钮在检查器 tab 栏上，八个 tab 共用一颗。地图这里只收
   * 结果，用来决定画多细——绝不再长第二颗全屏按钮。
   */
  fullscreen?: boolean;
  /** 容器接了才渲染「看全图」；没接就不渲染，绝不留一个按了没反应的控件。 */
  onShowAll?: () => void;
}

export function OntologyMapView(props: OntologyMapViewProps) {
  const { model } = props;
  // 取景状态：缩放档位、展开了哪几张合并卡、画布滚到了哪里。
  // 三者都只影响呈现，一个都不回流进布局——布局永远是本体结构的纯函数。
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  const [expandedFolds, setExpandedFolds] = useState<string[]>([]);
  const [viewport, setViewport] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const scene = useMemo(
    () => buildMapScene(model, { expandedFolds }),
    [model, expandedFolds],
  );
  const foldable = useMemo(() => foldRuns(model), [model]);

  const toggleFold = useCallback((foldId: string) => {
    setExpandedFolds((current) =>
      current.includes(foldId)
        ? current.filter((entry) => entry !== foldId)
        : [...current, foldId],
    );
  }, []);

  const readViewport = useCallback(() => {
    const node = canvasRef.current;
    if (!node) return;
    setViewport({
      left: node.scrollLeft,
      top: node.scrollTop,
      width: node.clientWidth,
      height: node.clientHeight,
    });
  }, []);

  const stepZoom = useCallback((direction: 1 | -1) => {
    setZoom((current) => {
      const at = ZOOM_STEPS.findIndex((step) => step >= current - 0.001);
      const next = Math.min(
        ZOOM_STEPS.length - 1,
        Math.max(0, (at < 0 ? ZOOM_STEPS.length - 1 : at) + direction),
      );
      return ZOOM_STEPS[next]!;
    });
  }, []);

  /** 适应视口：读一次容器尺寸算出比例。容器尺寸只到这里为止，进不了布局。 */
  const fitTo = useCallback(
    (mode: "width" | "page", width: number, height: number) => {
      const node = canvasRef.current;
      if (!node || width <= 0 || height <= 0) return;
      const byWidth = (node.clientWidth - 32) / width;
      const byHeight = (node.clientHeight - 16) / height;
      const next = mode === "width" ? byWidth : Math.min(byWidth, byHeight);
      if (!Number.isFinite(next) || next <= 0) return;
      setZoom(Math.min(1.3, Math.max(0.05, next)));
    },
    [],
  );

  const jumpTo = useCallback((fraction: { x: number; y: number }) => {
    const node = canvasRef.current;
    if (!node) return;
    node.scrollLeft = fraction.x * node.scrollWidth - node.clientWidth / 2;
    node.scrollTop = fraction.y * node.scrollHeight - node.clientHeight / 2;
  }, []);

  if (props.loading) return <div className={styles.iEmpty}>读取中…</div>;
  if (props.error) return <div className={styles.iEmpty}>{props.error}</div>;

  const wrapClass = props.fullscreen
    ? `${styles.mapWrap} ${styles.mapWrapFull}`
    : styles.mapWrap;

  const unmatchedChip =
    model.view.unmatched.length > 0 ? (
      <span className={`${styles.ovChip} ${styles.ovChipWarn}`}>
        {`未匹配 ${model.view.unmatched.join(LABEL_JOIN)}`}
      </span>
    ) : null;
  // 名单超上限被切掉的那些从来没参与过匹配。静默切片会让「点了名却没生效」
  // 永远发现不了，所以它必须自己占一颗 chip，并报出截断前的真实条数。
  const omittedChip =
    model.view.omitted.length > 0 ? (
      <span className={`${styles.ovChip} ${styles.ovChipWarn}`}>
        {`${model.view.omitted.length} 个名字超出上限未参与 ${model.view.omitted.join(LABEL_JOIN)}`}
      </span>
    ) : null;

  // AI 调过视图才出现这一条；用户必须永远知道是谁在替他决定看什么。
  const viewBar = model.view.applied ? (
    <div className={styles.mapViewBar}>
      <div className={styles.mapViewLine}>
        <span className={styles.mapViewMark}>✦ 这一段是模型替你截取的</span>
        {model.view.note ? (
          <span className={styles.mapViewNote}>{`「${model.view.note}」`}</span>
        ) : null}
        {props.onShowAll ? (
          <button
            type="button"
            className={styles.btn}
            onClick={props.onShowAll}
          >
            看全图
          </button>
        ) : null}
      </div>
      <div className={styles.mapViewKnobs}>
        {model.view.direction === "upstream" ? (
          <span className={styles.mapKnob}>看上游</span>
        ) : null}
        {model.view.direction === "both" ? (
          <span className={styles.mapKnob}>上下游都看</span>
        ) : null}
        {model.view.radius !== null ? (
          <span className={styles.mapKnob}>{`${model.view.radius} 跳以内`}</span>
        ) : null}
        {model.view.lanes.length > 0 ? (
          <span className={styles.mapKnob}>
            {`只看 ${model.view.lanes.map(laneText).join(LABEL_JOIN)}`}
          </span>
        ) : null}
      </div>
    </div>
  ) : null;

  if (model.oversized) {
    return (
      <div className={wrapClass}>
        <div className={styles.iEmpty}>
          {`这份本体太大，暂时画不出来（共 ${model.counts.total.nodes} 个环节与结果）`}
        </div>
      </div>
    );
  }

  if (model.nodes.length === 0) {
    // 视图规格把图收窄没了，和「这个域本来就没有关系」是两回事——分开说。
    if (model.view.applied && model.counts.total.nodes > 0) {
      return (
        <div className={wrapClass}>
          {viewBar}
          <div className={styles.ovSum}>
            <span className={`${styles.ovChip} ${styles.ovChipWarn}`}>
              {`已聚焦 0/${model.counts.total.nodes}`}
            </span>
            {unmatchedChip}
            {omittedChip}
          </div>
          <div className={styles.iEmpty}>所选范围内暂无关系</div>
        </div>
      );
    }
    return <div className={styles.iEmpty}>暂无可展示的关系</div>;
  }

  const laneCaption: LaneCaption =
    model.notes.laneMode === "collapsed" ? () => COLLAPSED_LANE : laneText;
  const narrowed =
    model.view.applied &&
    model.counts.narrowed.nodes < model.counts.total.nodes;
  const folded = scene.foldedActions;

  return (
    <div className={wrapClass}>
      {viewBar}
      <div className={styles.ovSum}>
        {folded > 0 ? (
          <span className={styles.ovChip}>
            {`共 ${model.drawn.cards} 个环节 · 当前展开 ${model.drawn.cards - folded} · 已合并 ${folded}`}
          </span>
        ) : (
          <span className={styles.ovChip}>{`${model.drawn.cards} 个环节`}</span>
        )}
        {model.lanes.map((lane) => (
          <span key={`lane-${lane.order}`} className={styles.ovChip}>
            {`${laneCaption(lane.id)} ${lane.actionCount}`}
          </span>
        ))}
        {model.notes.duplicateActionLabels.length > 0 ? (
          <span className={`${styles.ovChip} ${styles.ovChipWarn}`}>
            {`${model.notes.duplicateActionLabels.length} 个同名环节已合并`}
          </span>
        ) : null}
        <span className={styles.ovChip}>{`${scene.maxRankCount} 层先后`}</span>
        {model.notes.handoffEdgeCount > 0 ? (
          <span className={styles.ovChip}>
            {`交接 ${model.notes.handoffEdgeCount} 处`}
          </span>
        ) : null}
        {scene.backCount > 0 ? (
          <span className={styles.ovChip}>
            {`${scene.backCount} 处会回到前面`}
          </span>
        ) : null}
        {scene.forkCount > 0 ? (
          <span className={styles.ovChip}>{`${scene.forkCount} 处分叉`}</span>
        ) : null}
        {scene.mergeCount > 0 ? (
          <span className={styles.ovChip}>{`${scene.mergeCount} 处合流`}</span>
        ) : null}
        {model.ledger.exitPorts > 0 ? (
          <span className={styles.ovChip}>
            {`${model.ledger.exitPorts} 处无后续环节`}
          </span>
        ) : null}
        {narrowed ? (
          <span className={styles.ovChip}>
            {`已聚焦 ${model.counts.narrowed.nodes}/${model.counts.total.nodes}`}
          </span>
        ) : null}
        {/* 收窄掉的关系以前一条痕迹都不留：节点数报了，边数没人报，账本又把
            收窄之后的边数当作源关系数，于是「结构少了一块」永远发现不了。 */}
        {model.ledger.narrowedAwayRelations > 0 ? (
          <span className={styles.ovChip}>
            {`${model.ledger.narrowedAwayRelations}/${model.ledger.totalRelations} 关系不在这张图上`}
          </span>
        ) : null}
        {unmatchedChip}
        {omittedChip}
        {model.sourceTruncated ? (
          <span className={`${styles.ovChip} ${styles.ovChipWarn}`}>
            上游分析已限幅
          </span>
        ) : null}
        {/* 账本是唯一的静默丢边探测器。它变 false 必须在界面上有后果，
            否则就是一颗没人看的假保险。 */}
        {!model.ledger.balanced ? (
          <span className={`${styles.ovChip} ${styles.ovChipWarn}`}>
            {`账本对不上 ${model.ledger.sourceRelations} 条源关系 · 可能漏画`}
          </span>
        ) : null}
      </div>
      {model.notes.disconnectedComponents > 1 ? (
        // 这张图只按动作表的「触发 / 产出」两列连线。连不上不等于本体没有
        // 声明先后——那两列之外还有别的声明，说「本体没有声明」是超额断言。
        <div
          className={styles.mapBanner}
          title="这张图只按动作表的触发与产出两列连线；这几段在这两列里没有连上，别处有没有声明这张图看不出来"
        >
          {`${model.notes.disconnectedComponents} 段流程互不相连`}
        </div>
      ) : null}
      <div className={styles.mapTools}>
        <button
          type="button"
          className={styles.mini}
          onClick={() => fitTo("width", scene.width, scene.height)}
        >
          适应宽度
        </button>
        <button
          type="button"
          className={styles.mini}
          onClick={() => fitTo("page", scene.width, scene.height)}
        >
          整页
        </button>
        <button
          type="button"
          className={styles.mini}
          onClick={() => stepZoom(-1)}
        >
          缩小
        </button>
        <button
          type="button"
          className={styles.mini}
          onClick={() => stepZoom(1)}
        >
          放大
        </button>
        <span
          className={styles.mapZoomReadout}
          data-oc-zoom={Math.round(zoom * 100)}
        >
          {`${Math.round(zoom * 100)}%`}
        </span>
        {/* 这一档确实折了东西，或者刚被全部展开——只有这两种情况这颗按钮
            才有事可做。有折叠资格但这一档不折时不渲染它：一屏看得完的图上
            留一颗按了没反应的控件，和留一句假话没有区别。 */}
        {scene.foldGroupCount > 0 || expandedFolds.length > 0 ? (
          <button
            type="button"
            className={styles.mini}
            onClick={() =>
              setExpandedFolds((current) =>
                current.length > 0 ? [] : foldable.map((group) => group.id),
              )
            }
          >
            {expandedFolds.length > 0
              ? `合并 ${foldable.length} 段`
              : `展开 ${scene.foldGroupCount} 段`}
          </button>
        ) : null}
        <Minimap
          scene={scene}
          viewport={viewport}
          zoom={zoom}
          onJump={jumpTo}
        />
      </div>
      <div className={styles.mapLegend}>
        <span className={styles.mapLegendItem}>
          <i className={`${styles.mapSwatch} ${styles.mapSwatchCard}`} />
          环节
        </span>
        <span className={styles.mapLegendItem}>
          <i className={`${styles.mapSwatch} ${styles.mapSwatchPill}`} />
          结果
        </span>
        <span className={styles.mapLegendItem}>
          <i className={`${styles.mapSwatch} ${styles.mapSwatchBack}`} />
          会回到前面
        </span>
        <span className={styles.mapLegendItem}>越往下越靠后</span>
        {scene.mergeCount > 0 ? (
          // 到齐规则不在这四列里，所以这里只报来源数。说「本体没有声明」
          // 是超额断言——本体别处有没有声明，这张图答不上来。
          <span
            className={styles.mapLegendItem}
            title="是要全部到齐还是任意一件，这张图的四列里没有"
          >
            合流只报来源数
          </span>
        ) : null}
      </div>
      <div
        className={styles.mapCanvasWrap}
        ref={canvasRef}
        onScroll={readViewport}
      >
        <Canvas
          scene={scene}
          laneCaption={laneCaption}
          zoom={zoom}
          onToggleFold={toggleFold}
        />
      </div>
      <StructureList
        scene={scene}
        laneCaption={laneCaption}
        onToggleFold={toggleFold}
      />
    </div>
  );
}

/**
 * 数据接线：地图读的是本会话最新那份 Ontology 分析产物。
 * 分析没跑过 → 没有产物 → 如实显示「暂无可展示的关系」，不去别处凑一张图。
 *
 * `viewSpec` 是「AI 随时可以调整地图」的注入口：不传就用产物自带的那份，
 * 两者都没有就画全图。规格只挑看哪一段，节点与边永远来自服务端推导的动作表。
 */
export function OntologyMapConnected(props: {
  tenant: string;
  items: OntoCodeArtifactSummaryItem[];
  viewSpec?: unknown;
  fullscreen?: boolean;
}) {
  const row = latestStageDocumentForKind(props.items, "analysis");
  const versionId = row?.item.latestVersion.id ?? "";
  // 版本内容是内容寻址的不可变对象，与检查器共用同一个缓存键，不会重复拉取。
  const contentQ = useQuery({
    queryKey: ONTOCODE_KEYS.artifactVersionContent(props.tenant, versionId),
    queryFn: () =>
      fetchOntoCodeArtifactVersionContent(props.tenant, versionId),
    enabled: Boolean(props.tenant && versionId),
    staleTime: Number.POSITIVE_INFINITY,
  });

  // 「看全图」只改本地这一个开关，不动产物、也不回写给模型。
  const [showAll, setShowAll] = useState(false);

  const model = useMemo(() => {
    const raw = contentQ.data?.content;
    let parsed: unknown = null;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        // 产物不是 JSON——如实按「没有可展示的关系」处理，不猜内容。
        parsed = null;
      }
    }
    const source = readMapSource(parsed);
    if (showAll) return buildOntologyMapLayout(source, undefined);
    if (props.viewSpec !== undefined) {
      return buildOntologyMapLayout(source, props.viewSpec);
    }
    // 产物自带的那份规格：外层可能带 `presentation` 外壳，也可能已经是 presentation。
    const shell = isRecord(parsed) ? parsed : null;
    const presentation =
      shell && isRecord(shell.presentation) ? shell.presentation : shell;
    return buildOntologyMapLayout(source, presentation?.mapView);
  }, [contentQ.data, props.viewSpec, showAll]);

  return (
    <OntologyMapView
      model={model}
      loading={Boolean(versionId) && contentQ.isLoading}
      error={
        contentQ.error instanceof Error
          ? `无法读取 Ontology 分析：${contentQ.error.message}`
          : null
      }
      fullscreen={props.fullscreen}
      onShowAll={model.view.applied ? () => setShowAll(true) : undefined}
    />
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
