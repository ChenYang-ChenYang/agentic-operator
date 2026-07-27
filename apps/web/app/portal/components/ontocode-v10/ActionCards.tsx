"use client";
// OntoCode v10 · 行动卡片：纯展示 + 回调。数据绑定（hooks）由容器完成。
import React, { useState } from "react";
import { HelpTip } from "@/app/portal/components";
import styles from "./workbench.module.css";
import type { ActionCardVM } from "./projection";

export interface SystemLinkVM {
  system: string;
  /** 可配置的 provider（Settings→Integrations 深链目标）；null=尚无连接档案。 */
  provider: string | null;
  configured: boolean;
  probeOk: boolean | null;
  runtimeProvided: boolean;
}

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
  /** 人工边界确认（boundaryEligible 的 config 卡） */
  onConfirmBoundary?: () => void;
  /** config 卡：每个系统的连接成熟度 + 打开对应 provider 配置页 */
  systemLinks?: SystemLinkVM[];
  onConfigureProvider?: (provider: string) => void;
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
        {/* The reasoning behind the question is available on demand rather than
            as a paragraph the reader must scan past to reach the buttons. */}
        {card.why ? <HelpTip>{card.why}</HelpTip> : null}
      </div>
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
        <>
          {props.systemLinks && props.systemLinks.length > 0 ? (
            <div className={styles.sysLinks}>
              {props.systemLinks.map((link) => (
                <div key={link.system} className={styles.sysLinkRow}>
                  <span className={styles.docMono}>{link.system}</span>
                  {link.runtimeProvided ? (
                    <span className={styles.agStatOk}>✓ 运行时提供，无需配置</span>
                  ) : link.provider ? (
                    <>
                      {link.configured ? (
                        <span
                          className={
                            link.probeOk === false
                              ? styles.agStatBad
                              : styles.agStatOk
                          }
                        >
                          {link.probeOk === false
                            ? "已配置 · 探针失败"
                            : link.probeOk
                              ? "✓ 已配置 · 连接已验证"
                              : "✓ 已配置"}
                        </span>
                      ) : (
                        <span className={styles.agStatOff}>未配置</span>
                      )}
                      <button
                        type="button"
                        className={`${styles.btn} ${link.configured ? "" : styles.btnAmber}`}
                        onClick={() => props.onConfigureProvider?.(link.provider!)}
                        disabled={props.busy}
                      >
                        {link.configured ? "查看/重配" : "配置"} {link.provider} →
                      </button>
                    </>
                  ) : (
                    <span className={styles.agStatOff}>
                      暂无连接档案——需先建立系统档案（或确认人工边界）
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : null}
          <div className={styles.cardBtns}>
            {!props.systemLinks?.length ? (
              <button
                type="button"
                className={`${styles.btn} ${styles.btnAmber}`}
                onClick={props.onPrimary}
                disabled={props.busy}
              >
                去配置真实工具 →
              </button>
            ) : null}
            <button
              type="button"
              className={`${styles.btn} ${styles.btnGreen}`}
              onClick={props.onSecondary}
              disabled={props.busy}
            >
              {props.busy ? "重试中…" : "已配置完成，校验并继续"}
            </button>
          </div>
          {card.systems && card.systems.length > 0 && !props.systemLinks?.length ? (
            <div className={styles.cardWhy}>
              涉及系统：{card.systems.join("、")}
              <HelpTip>
                配置真实工具或凭证后，点「已配置完成，校验并继续」会重新执行构建；届时会重新读取工具与凭证，通过即继续。
              </HelpTip>
            </div>
          ) : null}
          {card.boundaryEligible ? (
            <div className={styles.cardBtns}>
              <button
                type="button"
                className={styles.btn}
                onClick={props.onConfirmBoundary}
                disabled={props.busy}
                title="这些系统没有真实工具、由人工承担。仅生成设计稿供审阅；候选/沙箱/上线仍会拦截。"
              >
                确认人工边界（仅设计稿，不可交付）
              </button>
              <button
                type="button"
                className={styles.btn}
                onClick={() => props.onAnswer?.("已更新，请重读")}
                disabled={props.busy}
              >
                已更新 Ontology，请重读
              </button>
            </div>
          ) : null}
        </>
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
