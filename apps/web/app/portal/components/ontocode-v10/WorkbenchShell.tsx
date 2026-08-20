"use client";
// OntoCode v10 · 三栏骨架：左右两栏都可收起、都可拖拽调宽，状态由容器持有并持久化。
//
// 本组件是纯受控的展示层：宽度/收起状态从 props 进来，交互只往外报意图。
// 几何与钳制规则全部在 workbench-layout.ts（纯函数，node 环境可单测），
// 这里不出现任何裸像素——中栏永远留得下 OC_FLOW_MIN_WIDTH。
import React, { useRef, useState } from "react";
import styles from "./workbench.module.css";
import {
  OC_INSPECTOR_MIN_WIDTH,
  OC_RAIL_MIN_WIDTH,
  OC_RESIZE_KEYBOARD_STEP,
  inspectorMaxWidth,
  railMaxWidth,
  resolveWorkbenchWidths,
  sideOccupiedWidth,
} from "./workbench-layout";
import type { WorkbenchLayout } from "./workbench-layout";

export interface WorkbenchShellProps {
  rail: React.ReactNode;
  crumb: React.ReactNode;
  flow: React.ReactNode;
  composer?: React.ReactNode;
  inspector: React.ReactNode;
  /** Widths + collapsed flags. Owned (and persisted) by the container. */
  layout: WorkbenchLayout;
  /** Live `window.innerWidth`; 0/undefined during SSR → design maxima apply. */
  viewportWidth?: number;
  inspectorFullscreen?: boolean;
  onToggleRail: () => void;
  onToggleInspector: () => void;
  onResizeRail: (width: number) => void;
  onResizeInspector: (width: number) => void;
}

type Side = "rail" | "inspector";

export function WorkbenchShell(props: WorkbenchShellProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const { layout, viewportWidth = 0 } = props;
  const { railWidth, inspectorWidth } = resolveWorkbenchWidths(
    layout,
    viewportWidth,
  );

  // Each side's live ceiling depends on what the other side occupies, so the
  // separator can advertise an honest aria-valuemax.
  const railMax = railMaxWidth(
    viewportWidth,
    sideOccupiedWidth(inspectorWidth, layout.inspectorCollapsed),
  );
  const inspectorMax = inspectorMaxWidth(
    viewportWidth,
    sideOccupiedWidth(railWidth, layout.railCollapsed),
  );

  /** Pointer x → the width that side should take, measured off the shell box. */
  const widthFromClientX = (side: Side, clientX: number): number => {
    const rect = rootRef.current?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const right = rect?.right ?? viewportWidth;
    return side === "rail" ? clientX - left : right - clientX;
  };

  const commit = (side: Side, width: number) => {
    if (side === "rail") props.onResizeRail(width);
    else props.onResizeInspector(width);
  };

  const onSeparatorPointerDown =
    (side: Side) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.isPrimary || e.button !== 0) return;
      e.preventDefault();
      const pointerId = e.pointerId;
      const target = e.currentTarget;
      target.setPointerCapture(pointerId);
      setDragging(true);

      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        commit(side, widthFromClientX(side, ev.clientX));
      };
      const cleanUp = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        target.removeEventListener("lostpointercapture", cleanUp);
        setDragging(false);
      };
      function finish(ev: PointerEvent) {
        if (ev.pointerId !== pointerId) return;
        cleanUp();
        if (target.hasPointerCapture(pointerId)) {
          target.releasePointerCapture(pointerId);
        }
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      target.addEventListener("lostpointercapture", cleanUp);
    };

  // Keyboard resize (mirrors the portal's shared Splitter): arrows nudge,
  // Home/End jump to the ends. The rail grows rightwards, the inspector
  // leftwards, so the inspector's arrow mapping is inverted.
  const onSeparatorKeyDown =
    (side: Side) => (e: React.KeyboardEvent<HTMLDivElement>) => {
      const invert = side === "inspector";
      const current = side === "rail" ? railWidth : inspectorWidth;
      const min = side === "rail" ? OC_RAIL_MIN_WIDTH : OC_INSPECTOR_MIN_WIDTH;
      const max = side === "rail" ? railMax : inspectorMax;
      const step = OC_RESIZE_KEYBOARD_STEP;
      let next: number;
      if (e.key === "ArrowLeft") next = invert ? current + step : current - step;
      else if (e.key === "ArrowRight")
        next = invert ? current - step : current + step;
      else if (e.key === "Home") next = min;
      else if (e.key === "End") next = max;
      else return;
      e.preventDefault();
      commit(side, next);
    };

  const separator = (side: Side) => (
    <div className={styles.gutter}>
      <div
        className={styles.handle}
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={side === "rail" ? "拖动调整左栏宽度" : "拖动调整右栏宽度"}
        aria-valuenow={side === "rail" ? railWidth : inspectorWidth}
        aria-valuemin={side === "rail" ? OC_RAIL_MIN_WIDTH : OC_INSPECTOR_MIN_WIDTH}
        aria-valuemax={side === "rail" ? railMax : inspectorMax}
        onPointerDown={onSeparatorPointerDown(side)}
        onKeyDown={onSeparatorKeyDown(side)}
        title="拖动调宽 · 方向键微调 · Home/End 到两端"
      />
      <button
        type="button"
        className={styles.edgeBtn}
        aria-label={side === "rail" ? "收起左栏" : "收起右栏"}
        aria-expanded={true}
        onClick={side === "rail" ? props.onToggleRail : props.onToggleInspector}
      >
        {side === "rail" ? "‹" : "›"}
      </button>
    </div>
  );

  const strip = (side: Side) => (
    <div
      className={side === "rail" ? styles.railStrip : styles.inspectorStrip}
    >
      <button
        type="button"
        className={styles.edgeBtn}
        aria-label={side === "rail" ? "展开左栏" : "展开右栏"}
        aria-expanded={false}
        onClick={side === "rail" ? props.onToggleRail : props.onToggleInspector}
      >
        {side === "rail" ? "›" : "‹"}
      </button>
    </div>
  );

  // Collapsed panels are hidden, not unmounted: the inspector holds open
  // artifacts/queries and the rail holds its search box — collapsing must not
  // throw that away.
  const railClass = [styles.rail, layout.railCollapsed ? styles.railHidden : ""]
    .filter(Boolean)
    .join(" ");
  const inspectorClass = [
    styles.inspector,
    layout.inspectorCollapsed ? styles.inspectorClosed : "",
    props.inspectorFullscreen ? styles.inspectorFullscreen : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={rootRef}
      className={
        dragging ? `${styles.root} ${styles.rootDragging}` : styles.root
      }
    >
      {layout.railCollapsed ? strip("rail") : null}
      <aside
        className={railClass}
        style={{ ["--oc-rail-w" as string]: `${railWidth}px` }}
        aria-label="会话与域上下文"
        aria-hidden={layout.railCollapsed || undefined}
      >
        {props.rail}
      </aside>
      {layout.railCollapsed ? null : separator("rail")}

      <section className={styles.flow}>
        <div className={styles.crumb}>{props.crumb}</div>
        <div className={styles.scroll}>
          <div className={styles.col}>{props.flow}</div>
        </div>
        {props.composer ? (
          <div className={styles.composerWrap}>{props.composer}</div>
        ) : null}
      </section>

      {layout.inspectorCollapsed || props.inspectorFullscreen
        ? null
        : separator("inspector")}
      <aside
        className={inspectorClass}
        style={
          props.inspectorFullscreen
            ? undefined
            : { ["--oc-inspector-w" as string]: `${inspectorWidth}px` }
        }
        aria-label="生成产物"
        aria-hidden={layout.inspectorCollapsed || undefined}
      >
        {props.inspector}
      </aside>
      {layout.inspectorCollapsed ? strip("inspector") : null}
    </div>
  );
}
