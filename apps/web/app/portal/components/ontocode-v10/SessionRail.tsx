"use client";
// OntoCode v10 · 左栏：域上下文 + Session 列表（数据由容器传入，全部真实记录投影）。
import React, { useMemo, useState } from "react";
import styles from "./workbench.module.css";
import type { SessionRowVM, SessionTone } from "./projection";

const DOT_CLASS: Record<SessionTone, string> = {
  ok: "dotOk",
  run: "dotRun",
  warn: "dotWarn",
  bad: "dotBad",
  idle: "dotIdle",
};

export interface SessionRailProps {
  businessDomainLabel: string;
  ontologyDomainLabel: string;
  snapshotShort: string | null;
  sessions: SessionRowVM[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => void;
  onOpenSettings: () => void;
}

export function SessionRail(props: SessionRailProps) {
  const [query, setQuery] = useState("");
  const searchable = props.sessions.length >= 10;
  const visible = useMemo(() => {
    if (!query.trim()) return props.sessions;
    const q = query.trim().toLowerCase();
    return props.sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) || s.sub.toLowerCase().includes(q),
    );
  }, [props.sessions, query]);

  return (
    <>
      <div className={styles.brand}>
        Onto<b>Code</b>
      </div>
      <button
        type="button"
        className={styles.newBtn}
        onClick={props.onCreateSession}
      >
        ＋ 新建 Session
      </button>
      <div className={styles.selCard}>
        <div>
          <div className={styles.selLabel}>BUSINESS DOMAIN</div>
          <div className={styles.selValue}>{props.businessDomainLabel}</div>
        </div>
      </div>
      <div className={styles.selCard}>
        <div>
          <div className={styles.selLabel}>ONTOLOGY DOMAIN</div>
          <div className={styles.selValue}>
            {props.ontologyDomainLabel}{" "}
            {props.snapshotShort ? (
              <small>快照 #{props.snapshotShort} 已锁定</small>
            ) : (
              <small>快照待锁定</small>
            )}
          </div>
        </div>
      </div>
      <div className={styles.railSec}>SESSIONS</div>
      {searchable ? (
        <input
          className={styles.railSearch}
          placeholder="搜索 Session…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      ) : null}
      <div className={styles.sList}>
        {visible.length === 0 ? (
          <div className={styles.railEmpty}>
            {props.sessions.length === 0
              ? "还没有 Session——点上方「新建 Session」，说一句业务目标就能开始。"
              : "没有匹配的 Session。"}
          </div>
        ) : (
          visible.map((s) => (
            <button
              type="button"
              key={s.id}
              className={
                s.id === props.activeSessionId
                  ? `${styles.sItem} ${styles.sItemOn}`
                  : styles.sItem
              }
              onClick={() => props.onSelectSession(s.id)}
            >
              {s.needsAttention > 0 ? (
                <span className={styles.sBadge}>{s.needsAttention}</span>
              ) : null}
              <h4>
                <span
                  className={`${styles.dot} ${styles[DOT_CLASS[s.tone]]}`}
                />
                {s.title}
              </h4>
              <div className={styles.sItemSub}>
                {s.label} · {s.sub}
              </div>
            </button>
          ))
        )}
      </div>
      <button
        type="button"
        className={styles.railFoot}
        onClick={props.onOpenSettings}
      >
        ⚙ 设置 · 凭证与集成
      </button>
    </>
  );
}
