"use client";
// OntoCode v10 · 三栏骨架：组合 + 右栏宽度手柄（拖拽调宽 / 点击收起 / 全屏）。
// 采纳自 Codex 版 mockup 的右栏交互：360–860px 可拖，宽度持久化。
import React, { useEffect, useRef, useState } from "react";
import styles from "./workbench.module.css";

const WIDTH_KEY = "oc:v10:inspectorW";
const MIN_W = 360;
const MAX_W = 860;

export interface WorkbenchShellProps {
  rail: React.ReactNode;
  crumb: React.ReactNode;
  flow: React.ReactNode;
  composer?: React.ReactNode;
  inspector: React.ReactNode;
  inspectorOpen: boolean;
  inspectorFullscreen?: boolean;
  onToggleInspector: () => void;
}

export function WorkbenchShell(props: WorkbenchShellProps) {
  const [width, setWidth] = useState(432);
  const [dragging, setDragging] = useState(false);
  const dragMoved = useRef(false);

  useEffect(() => {
    const saved = Number(window.localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= MIN_W && saved <= MAX_W) {
      setWidth(saved);
    }
  }, []);

  const onHandlePointerDown = (e: React.PointerEvent) => {
    if (!props.inspectorOpen || props.inspectorFullscreen) return;
    e.preventDefault();
    dragMoved.current = false;
    setDragging(true);
    const startX = e.clientX;
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 4) dragMoved.current = true;
      const next = Math.min(
        MAX_W,
        Math.max(MIN_W, window.innerWidth - ev.clientX),
      );
      setWidth(next);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragging(false);
      if (dragMoved.current) {
        const finalW = Math.min(
          MAX_W,
          Math.max(MIN_W, window.innerWidth - ev.clientX),
        );
        window.localStorage.setItem(WIDTH_KEY, String(finalW));
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const inspectorClass = [
    styles.inspector,
    props.inspectorOpen ? "" : styles.inspectorClosed,
    props.inspectorFullscreen ? styles.inspectorFullscreen : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={dragging ? `${styles.root} ${styles.rootDragging}` : styles.root}>
      <aside className={styles.rail}>{props.rail}</aside>
      <section className={styles.flow}>
        <div className={styles.crumb}>{props.crumb}</div>
        <div className={styles.scroll}>
          <div className={styles.col}>{props.flow}</div>
        </div>
        {props.composer ? (
          <div className={styles.composerWrap}>{props.composer}</div>
        ) : null}
      </section>
      <button
        type="button"
        className={styles.handle}
        onPointerDown={onHandlePointerDown}
        onClick={() => {
          if (!dragMoved.current) props.onToggleInspector();
        }}
        aria-label={props.inspectorOpen ? "收起或拖宽右栏" : "展开右栏"}
        title="点击收起/展开 · 拖动调宽"
      >
        {props.inspectorOpen ? "⋮" : "‹"}
      </button>
      <aside
        className={inspectorClass}
        style={
          props.inspectorOpen && !props.inspectorFullscreen
            ? { width }
            : undefined
        }
        aria-label="生成产物"
      >
        {props.inspector}
      </aside>
    </div>
  );
}
