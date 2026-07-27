"use client";
// OntoCode v10 · 中栏引导流：目标卡 + 流条目 + 单行状态 + composer。
// 行动卡由容器通过 renderCard 注入（容器负责把 hooks 绑到具体卡上）。
import React, { useState } from "react";
import styles from "./workbench.module.css";
import { Markdown } from "@/app/portal/components/markdown";
import type { FlowItemVM } from "./projection";

export interface GuidedFlowProps {
  goal: { title: string; chips: string[] } | null;
  items: FlowItemVM[];
  renderCard: (item: Extract<FlowItemVM, { kind: "actionCard" }>) => React.ReactNode;
}

export function GuidedFlow(props: GuidedFlowProps) {
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  return (
    <>
      {props.goal ? (
        <div className={styles.goal}>
          <div className={styles.goalLabel}>当前目标</div>
          <h2 className={styles.goalTitle}>{props.goal.title}</h2>
          {props.goal.chips.length > 0 ? (
            <div className={styles.gChips}>
              {props.goal.chips.map((c) => (
                <span key={c} className={styles.gChip}>
                  {c}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {props.items.length === 0 ? (
        <div className={styles.aiMsg}>
          <span className={styles.aiAvatar}>✦</span>
          <div className={styles.aiBody}>
            说一句业务目标就能开始——我会读取 Ontology、给出范围建议，然后生成可验证的
            agent 代码。需要你拍板或配置时，会以卡片形式出现在这里。
          </div>
        </div>
      ) : null}

      {props.items.map((item) => {
        switch (item.kind) {
          case "user":
            return (
              <div key={item.id} className={styles.userMsg}>
                {item.text}
              </div>
            );
          case "aiText":
            return (
              <div key={item.id} className={styles.aiMsg}>
                <span className={styles.aiAvatar}>✦</span>
                <div className={styles.aiBody}>
                  <Markdown>{item.text}</Markdown>
                </div>
              </div>
            );
          case "execGroup": {
            const open = openGroups[item.id] ?? false;
            return (
              <div key={item.id} className={styles.execGroup}>
                <button
                  type="button"
                  className={styles.execHead}
                  onClick={() =>
                    setOpenGroups((s) => ({ ...s, [item.id]: !open }))
                  }
                >
                  {item.title}
                  <span className={styles.execMeter}>
                    {item.steps.length > 0
                      ? `${item.steps.length} 步 · ${open ? "收起" : "展开"}`
                      : ""}
                  </span>
                </button>
                {open && item.steps.length > 0 ? (
                  <div className={styles.execBody}>
                    {item.steps.map((s, i) => (
                      <div key={`${item.id}-${i}`} className={styles.execRow}>
                        <span className={styles.execTick}>✓</span>
                        {s}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          }
          case "actionCard":
            return (
              <React.Fragment key={item.id}>
                {props.renderCard(item)}
              </React.Fragment>
            );
          case "receipt":
            return (
              <div key={item.id} className={styles.receipt}>
                <span className={styles.receiptOk}>✓</span>
                {item.text}
              </div>
            );
          case "statusLine":
            return (
              <div key={item.id} className={styles.statusLine}>
                <span className={styles.spin} />
                {item.text}
                <span className={styles.statusMeta}>实时同步中</span>
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

/* ------------------------------- Composer ------------------------------- */

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  disabled?: boolean;
  disabledReason?: string;
  autonomy: string;
  onAutonomyChange: (mode: string) => void;
  contextTokens: string[];
  /** 一行一键动作。刻意少——中栏保持极简。 */
  quickActions?: Array<{ label: string; run: () => void }>;
}

const AUTONOMY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "sandbox_autopilot", label: "自主执行" },
  { value: "copilot", label: "每步确认" },
  { value: "guide", label: "仅分析" },
];

export function Composer(props: ComposerProps) {
  const canSend =
    !props.sending && !props.disabled && props.value.trim().length > 0;
  return (
    <div className={styles.composer}>
      <textarea
        className={styles.composerInput}
        placeholder={
          props.disabled
            ? (props.disabledReason ?? "当前 Session 只读")
            : "询问原因、调整要求，或让 OntoCode 执行下一步…（Enter 发送，Shift+Enter 换行）"
        }
        value={props.value}
        disabled={props.disabled || props.sending}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (canSend) props.onSend();
          }
        }}
      />
      <div className={styles.composerRow}>
        {props.contextTokens.map((t) => (
          <span key={t} className={styles.atToken}>
            @ {t}
          </span>
        ))}
        <select
          className={styles.modeSel}
          value={props.autonomy}
          onChange={(e) => props.onAutonomyChange(e.target.value)}
          disabled={props.disabled}
          aria-label="自主性"
        >
          {AUTONOMY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.sendBtn}
          onClick={props.onSend}
          disabled={!canSend}
        >
          {props.sending ? "发送中…" : "发送"}
        </button>
      </div>
      {props.quickActions && props.quickActions.length > 0 ? (
        <div className={styles.quickRow}>
          {props.quickActions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={styles.quickChip}
              onClick={action.run}
              disabled={props.disabled || props.sending}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
