"use client";
// OntoCode v10 · 行动卡片：纯展示 + 回调。数据绑定（hooks）由容器完成。
import React, { useState } from "react";
import styles from "./workbench.module.css";
import type { ActionCardVM } from "./projection";

export interface ActionCardViewProps {
  card: ActionCardVM;
  busy?: boolean;
  errorText?: string | null;
  /** config: 去配置；authorization/deploy_confirm: 批准 */
  onPrimary?: () => void;
  /** config: 已完成、校验并继续；authorization/deploy_confirm: 拒绝 */
  onSecondary?: () => void;
  /** decision: 选项点击或「其它」提交 */
  onAnswer?: (answer: string) => void;
}

const KIND_TAG: Record<
  ActionCardVM["kind"],
  { label: string; className: string; cardClassName: string }
> = {
  config: { label: "需要配置", className: "tagCfg", cardClassName: "cardConfig" },
  decision: { label: "需要你拍板", className: "tagRec", cardClassName: "" },
  authorization: { label: "需要授权", className: "tagReq", cardClassName: "cardAuth" },
  deploy_confirm: { label: "上线确认", className: "tagRec", cardClassName: "cardDeploy" },
  system: { label: "系统提醒", className: "tagSys", cardClassName: "" },
};

export function ActionCardView(props: ActionCardViewProps) {
  const { card } = props;
  const [other, setOther] = useState("");
  const tag = KIND_TAG[card.kind];
  const cardClass = tag.cardClassName
    ? `${styles.card} ${styles[tag.cardClassName]}`
    : styles.card;

  return (
    <div className={cardClass} data-card-kind={card.kind}>
      <div className={styles.cardHead}>
        <span className={`${styles.cardTag} ${styles[tag.className]}`}>
          {tag.label}
        </span>
        {card.title}
      </div>
      {card.why ? <div className={styles.cardWhy}>为什么问：{card.why}</div> : null}
      {card.impact ? (
        <div className={styles.cardImpact}>影响范围:{card.impact}</div>
      ) : null}

      {card.kind === "decision" ? (
        <div className={styles.cardBtns}>
          {(card.options ?? []).map((o) => (
            <button
              key={o.value}
              type="button"
              disabled={props.busy}
              className={o.recommended ? `${styles.btn} ${styles.btnRec}` : styles.btn}
              onClick={() => props.onAnswer?.(o.value)}
            >
              {o.recommended ? "✓ " : ""}
              {o.label}
            </button>
          ))}
          {card.allowOther !== false ? (
            <>
              <input
                className={styles.otherInput}
                placeholder="其它——直接输入你的答案"
                value={other}
                onChange={(e) => setOther(e.target.value)}
                disabled={props.busy}
              />
              <button
                type="button"
                className={styles.btn}
                disabled={props.busy || other.trim().length === 0}
                onClick={() => {
                  const v = other.trim();
                  if (v) props.onAnswer?.(v);
                  setOther("");
                }}
              >
                提交
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {card.kind === "config" ? (
        <div className={styles.cardBtns}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnAmber}`}
            onClick={props.onPrimary}
            disabled={props.busy}
          >
            去配置 →
          </button>
          <button
            type="button"
            className={styles.btn}
            onClick={props.onSecondary}
            disabled={props.busy}
          >
            {props.busy ? "校验中…" : "已配置完成，校验并继续"}
          </button>
        </div>
      ) : null}

      {card.kind === "system" && props.onPrimary ? (
        <div className={styles.cardBtns}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGreen}`}
            onClick={props.onPrimary}
            disabled={props.busy}
          >
            {card.options?.[0]?.label ?? "处理"}
          </button>
        </div>
      ) : null}

      {card.kind === "authorization" || card.kind === "deploy_confirm" ? (
        <div className={styles.cardBtns}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGreen}`}
            onClick={props.onPrimary}
            disabled={props.busy}
          >
            {card.kind === "deploy_confirm" ? "批准上线" : "批准"}
          </button>
          <button
            type="button"
            className={styles.btn}
            onClick={props.onSecondary}
            disabled={props.busy}
          >
            拒绝
          </button>
        </div>
      ) : null}

      {props.errorText ? (
        <div className={styles.cardError}>{props.errorText}</div>
      ) : null}
    </div>
  );
}
