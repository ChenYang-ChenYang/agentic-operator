"use client";
// OntoCode v10 · 三栏骨架：纯组合组件，不发请求、不含业务状态。
import React from "react";
import styles from "./workbench.module.css";

export interface WorkbenchShellProps {
  rail: React.ReactNode;
  crumb: React.ReactNode;
  flow: React.ReactNode;
  composer?: React.ReactNode;
  inspector: React.ReactNode;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
}

export function WorkbenchShell(props: WorkbenchShellProps) {
  return (
    <div className={styles.root}>
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
        onClick={props.onToggleInspector}
        aria-label={props.inspectorOpen ? "收起右栏" : "展开右栏"}
      >
        {props.inspectorOpen ? "›" : "‹"}
      </button>
      <aside
        className={
          props.inspectorOpen
            ? styles.inspector
            : `${styles.inspector} ${styles.inspectorClosed}`
        }
        aria-label="生成产物"
      >
        {props.inspector}
      </aside>
    </div>
  );
}
