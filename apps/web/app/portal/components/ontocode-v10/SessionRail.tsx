"use client";
// OntoCode v10 · 左栏：域上下文 + Session 列表（数据由容器传入，全部真实记录投影）。
import React, { useMemo, useState } from "react";
import type { OntoCodeOntologyFreshness } from "@agentic/contracts";
import { HelpTip } from "@/app/portal/components";
import styles from "./workbench.module.css";
import {
  describeOntologyFreshness,
  type OntologyFreshnessChipVM,
  type OntologyFreshnessTone,
} from "./ontology-freshness";
import type { SessionRowVM, SessionTone } from "./projection";

const DOT_CLASS: Record<SessionTone, string> = {
  ok: "dotOk",
  run: "dotRun",
  warn: "dotWarn",
  bad: "dotBad",
  idle: "dotIdle",
};

const CHIP_TONE_CLASS: Record<OntologyFreshnessTone, string> = {
  ok: "ontoChipOk",
  warn: "ontoChipWarn",
  bad: "ontoChipBad",
};

/**
 * 本体来源 + 新鲜度芯片。
 *
 * 取代原来那句永远为真的「已锁定」：锁定说的是「我们钉住了一个快照」，
 * 从来没说过「源现在还是这份」，也从没说过是【谁】提供的这份。没测量过
 * 时保持原样，绝不把「没核对」画成「没问题」。
 */
function OntologyChip({
  vm,
  onCreateSession,
}: {
  vm: OntologyFreshnessChipVM;
  onCreateSession: () => void;
}) {
  const className = `${styles.ontoChip} ${styles[CHIP_TONE_CLASS[vm.tone]]}`;
  const body = (
    <>
      {vm.label}
      {vm.helpText ? <HelpTip size={13}>{vm.helpText}</HelpTip> : null}
    </>
  );
  // changed 必须是可执行的：点一下就走既有的「新建 Session」恢复路径。
  if (vm.action === "createSession") {
    return (
      <button
        type="button"
        className={className}
        onClick={onCreateSession}
        title="新建会话以锁定当前本体"
      >
        {body}
      </button>
    );
  }
  return <span className={className}>{body}</span>;
}

export interface SessionRailProps {
  businessDomainLabel: string;
  ontologyDomainLabel: string;
  snapshotShort: string | null;
  /** 服务端当场测量的本体新鲜度；null＝还没核对过。 */
  ontologyFreshness?: OntoCodeOntologyFreshness | null;
  sessions: SessionRowVM[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => void;
  onOpenSettings: () => void;
  onDeleteSession?: (sessionId: string) => void;
  deletingSessionId?: string | null;
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
  const freshnessChip = useMemo(
    () => describeOntologyFreshness(props.ontologyFreshness),
    [props.ontologyFreshness],
  );

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
        ＋ 新建
      </button>
      <div className={styles.selCard}>
        <div>
          <div className={styles.selLabel}>业务域</div>
          <div className={styles.selValue}>{props.businessDomainLabel}</div>
        </div>
      </div>
      <div className={styles.selCard}>
        <div>
          <div className={styles.selLabel}>本体域</div>
          <div className={styles.selValue}>
            {props.ontologyDomainLabel}{" "}
            {freshnessChip ? (
              <OntologyChip
                vm={freshnessChip}
                onCreateSession={props.onCreateSession}
              />
            ) : props.snapshotShort ? (
              <small>已锁定</small>
            ) : (
              <small>待锁定</small>
            )}
          </div>
        </div>
      </div>
      <div className={styles.railSec}>SESSIONS</div>
      {searchable ? (
        <input
          className={styles.railSearch}
          placeholder="搜索会话…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      ) : null}
      <div className={styles.sList}>
        {visible.length === 0 ? (
          <div className={styles.railEmpty}>
            {props.sessions.length === 0 ? "暂无会话" : "没有匹配的会话。"}
          </div>
        ) : (
          visible.map((s) => (
            <div key={s.id} className={styles.sItemWrap}>
              <button
                type="button"
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
                  {s.label}
                  {s.sub ? ` · ${s.sub}` : ""}
                </div>
              </button>
              {props.onDeleteSession ? (
                <button
                  type="button"
                  className={styles.sItemDelete}
                  title="删除这个会话"
                  aria-label={`删除 ${s.title}`}
                  disabled={props.deletingSessionId === s.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onDeleteSession?.(s.id);
                  }}
                >
                  {props.deletingSessionId === s.id ? "…" : "🗑"}
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>
      <button
        type="button"
        className={styles.railFoot}
        onClick={props.onOpenSettings}
      >
        ⚙ 设置
      </button>
    </>
  );
}
