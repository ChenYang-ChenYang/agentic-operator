"use client";
// OntoCode v10 · 行动卡片：纯展示 + 回调。数据绑定（hooks）由容器完成。
import React, { useState } from "react";
import { HelpTip } from "@/app/portal/components";
import styles from "./workbench.module.css";
import type { ActionCardLifecycleState, ActionCardVM } from "./projection";
import { RETRY_PRIMARY_LABEL } from "./projection";

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
  /** config: 去配置；authorization: 批准。deploy_confirm 在执行器接入前不调用。 */
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
  config: {
    label: "配置",
    className: "tagCfg",
    cardClassName: "cardConfig",
  },
  decision: { label: "拍板", className: "tagRec", cardClassName: "" },
  authorization: {
    label: "授权",
    className: "tagReq",
    cardClassName: "cardAuth",
  },
  deploy_confirm: {
    label: "上线",
    className: "tagRec",
    cardClassName: "cardDeploy",
  },
  system: { label: "提醒", className: "tagSys", cardClassName: "" },
};

/** 状态 chip 的色调。proposed 不出 chip——没发生的事不占屏。 */
const LIFECYCLE_CHIP_CLASS: Record<ActionCardLifecycleState, string | null> = {
  proposed: null,
  running: "lifeRun",
  done: "lifeDone",
  failed: "lifeBad",
  superseded: "lifeGone",
};

export function ActionCardView(props: ActionCardViewProps) {
  const { card } = props;
  const [other, setOther] = useState("");
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>(
    {},
  );
  const tag = KIND_TAG[card.kind];
  const cardClass = tag.cardClassName
    ? `${styles.card} ${styles[tag.cardClassName]}`
    : styles.card;
  const configItems = card.kind === "config" ? (card.items ?? []) : [];
  const answeredConfigItems = configItems.filter(
    (item) =>
      Boolean(selections[item.id]) || Boolean(customAnswers[item.id]?.trim()),
  ).length;
  const configAnswer = configItems
    .map((item, index) => {
      const answer =
        customAnswers[item.id]?.trim() || selections[item.id]?.trim();
      return answer ? `${index + 1}. ${answer}` : null;
    })
    .filter((answer): answer is string => Boolean(answer))
    .join("；");
  const verifiedConnections =
    props.systemLinks?.filter((link) => link.probeOk === true).length ?? 0;
  // 这一步已经发生过（或正在发生）时，再给一个「开始…」按钮就是在骗人。
  // 状态全部来自 projection 的落库事实判定，这里只负责闭嘴。
  const lifecycleState = card.lifecycle?.state ?? "proposed";
  const settled = lifecycleState === "done" || lifecycleState === "superseded";
  const actionsSuppressed = settled || lifecycleState === "running";
  const chipClass = LIFECYCLE_CHIP_CLASS[lifecycleState];
  const lifecycleChip =
    chipClass && card.lifecycle?.label ? (
      <span className={`${styles.cardTag} ${styles[chipClass]}`}>
        {card.lifecycle.label}
      </span>
    ) : null;

  const head = (
    <div className={styles.cardHead}>
      <span className={`${styles.cardTag} ${styles[tag.className]}`}>
        {tag.label}
      </span>
      <span className={styles.cardTitle}>{card.title}</span>
      {lifecycleChip}
      {/* The reasoning behind the question is available on demand rather than
          as a paragraph the reader must scan past to reach the buttons. */}
      {card.why ? <HelpTip>{card.why}</HelpTip> : null}
    </div>
  );

  // 已收尾的卡收成一行：标题 + 状态。预告过的「影响」已经兑现或作废，不再占屏。
  if (settled) {
    return (
      <div className={cardClass} data-card-kind={card.kind}>
        {head}
      </div>
    );
  }

  return (
    <div className={cardClass} data-card-kind={card.kind}>
      {head}
      {card.impact ? (
        <div className={styles.cardImpact}>影响:{card.impact}</div>
      ) : null}

      {card.kind === "decision" && !actionsSuppressed ? (
        <div className={styles.cardBtns}>
          {(card.options ?? []).map((o) => (
            <button
              key={o.value}
              type="button"
              disabled={props.busy}
              className={
                o.recommended ? `${styles.btn} ${styles.btnRec}` : styles.btn
              }
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
                placeholder="其它…"
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

      {card.kind === "config" && !actionsSuppressed ? (
        <>
          {configItems.length > 0 ? (
            <>
              <div className={styles.configDecisionList}>
                {configItems.map((item, index) => {
                  const selected = selections[item.id];
                  const custom = customAnswers[item.id] ?? "";
                  return (
                    <fieldset key={item.id} className={styles.configDecision}>
                      <legend className={styles.configDecisionHead}>
                        <span className={styles.configOrdinal}>
                          {index + 1}
                        </span>
                        <span>{item.question}</span>
                        {item.system ? (
                          <span className={styles.configSystem}>
                            {item.system}
                          </span>
                        ) : null}
                      </legend>
                      {item.context ? (
                        <div className={styles.configContext}>
                          {item.context}
                        </div>
                      ) : null}
                      {item.options.length > 0 ? (
                        <div className={styles.configOptions}>
                          {item.options.map((option) => {
                            const active =
                              selected === option.value && !custom.trim();
                            return (
                              <button
                                key={option.value}
                                type="button"
                                className={
                                  active
                                    ? `${styles.configOption} ${styles.configOptionSelected}`
                                    : styles.configOption
                                }
                                aria-pressed={active}
                                disabled={props.busy}
                                onClick={() => {
                                  setSelections((current) => ({
                                    ...current,
                                    [item.id]: option.value,
                                  }));
                                  setCustomAnswers((current) => ({
                                    ...current,
                                    [item.id]: "",
                                  }));
                                }}
                              >
                                <span className={styles.configRadio} />
                                <span className={styles.configOptionText}>
                                  {option.label}
                                </span>
                                {option.recommended ? (
                                  <span className={styles.configRecommended}>
                                    推荐
                                  </span>
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                      {item.allowOther !== false ? (
                        <input
                          className={styles.configOther}
                          placeholder={
                            item.options.length > 0
                              ? "其它处理方式（可选）"
                              : "其它…"
                          }
                          value={custom}
                          onChange={(event) => {
                            const value = event.target.value;
                            setCustomAnswers((current) => ({
                              ...current,
                              [item.id]: value,
                            }));
                            if (value.trim()) {
                              setSelections((current) => {
                                const next = { ...current };
                                delete next[item.id];
                                return next;
                              });
                            }
                          }}
                          disabled={props.busy}
                        />
                      ) : null}
                    </fieldset>
                  );
                })}
              </div>
              <div className={styles.secretNotice}>
                安全提示：API key 等密钥请仅保存在「集成设置」，不要发到会话里；这里只提交选择与环境变量名。
              </div>
              <div className={styles.configSubmitRow}>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnGreen}`}
                  disabled={
                    props.busy ||
                    answeredConfigItems !== configItems.length ||
                    !props.onAnswer
                  }
                  onClick={() => props.onAnswer?.(configAnswer)}
                >
                  {props.busy ? "提交中…" : "提交并继续"}
                </button>
                <span className={styles.configProgress}>
                  {answeredConfigItems}/{configItems.length}
                </span>
              </div>
            </>
          ) : null}
          {props.systemLinks && props.systemLinks.length > 0 ? (
            <details
              className={styles.configConnections}
              open={configItems.length === 0 ? true : undefined}
            >
              <summary>
                连接 {verifiedConnections}/{props.systemLinks.length}
              </summary>
              <div className={styles.sysLinks}>
                {props.systemLinks.map((link) => (
                  <div key={link.system} className={styles.sysLinkRow}>
                    <span className={styles.docMono}>{link.system}</span>
                    {link.runtimeProvided ? (
                      <span className={styles.agStatOk}>运行时提供</span>
                    ) : link.provider ? (
                      <>
                        {link.configured ? (
                          <span
                            className={
                              link.probeOk === false
                                ? styles.agStatBad
                                : link.probeOk === true
                                  ? styles.agStatOk
                                  : styles.agStatRun
                            }
                          >
                            {link.probeOk === false
                              ? "已配置 · 验证失败"
                              : link.probeOk === true
                                ? "✓ 已配置 · 连接已验证"
                                : "已配置 · 未验证"}
                          </span>
                        ) : (
                          <span className={styles.agStatOff}>未配置</span>
                        )}
                        <button
                          type="button"
                          className={`${styles.btn} ${link.configured ? "" : styles.btnAmber}`}
                          onClick={() =>
                            props.onConfigureProvider?.(link.provider!)
                          }
                          disabled={props.busy}
                        >
                          配置 →
                        </button>
                      </>
                    ) : (
                      <span className={styles.agStatOff}>未建档</span>
                    )}
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          <div className={styles.cardBtns}>
            {props.onPrimary ? (
              <button
                type="button"
                className={`${styles.btn} ${
                  configItems.length === 0 ? styles.btnAmber : ""
                }`}
                onClick={props.onPrimary}
                disabled={props.busy}
              >
                {card.primaryLabel ?? "去设置 →"}
              </button>
            ) : null}
            {props.onSecondary ? (
              <button
                type="button"
                className={`${styles.btn} ${
                  configItems.length === 0 ? styles.btnGreen : ""
                }`}
                onClick={props.onSecondary}
                disabled={props.busy}
              >
                {props.busy ? "校验中…" : "校验并继续"}
              </button>
            ) : null}
          </div>
          {card.systems &&
          card.systems.length > 0 &&
          !props.systemLinks?.length ? (
            <div className={styles.cardWhy}>
              涉及系统：{card.systems.join("、")}
              <HelpTip>
                配置真实工具或凭证后点「校验并继续」，会重读工具与凭证再继续构建。
              </HelpTip>
            </div>
          ) : null}
          {card.boundaryEligible ? (
            <details className={styles.secondaryActions}>
              <summary>其它处理方式</summary>
              <div className={styles.cardBtns}>
                <button
                  type="button"
                  className={styles.btn}
                  onClick={props.onConfirmBoundary}
                  disabled={props.busy}
                  title="这些系统没有真实工具、由人工承担。仅生成设计稿供审阅；候选/沙箱/上线仍会拦截。"
                >
                  人工边界
                </button>
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => props.onAnswer?.("已更新，请重读")}
                  disabled={props.busy}
                >
                  已更新，重读
                </button>
              </div>
            </details>
          ) : null}
        </>
      ) : null}

      {card.kind === "system" && props.onPrimary && !actionsSuppressed ? (
        <div className={styles.cardBtns}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGreen}`}
            onClick={props.onPrimary}
            disabled={props.busy}
          >
            {/* 失败卡上的按钮就是恢复路径，说清它是重试而不是首次执行。 */}
            {lifecycleState === "failed"
              ? RETRY_PRIMARY_LABEL
              : (card.primaryLabel ?? card.options?.[0]?.label ?? "处理")}
          </button>
        </div>
      ) : null}

      {card.kind === "authorization" && !actionsSuppressed ? (
        <div className={styles.cardBtns}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGreen}`}
            onClick={props.onPrimary}
            disabled={props.busy}
          >
            批准
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

      {card.kind === "deploy_confirm" && !actionsSuppressed ? (
        <>
          <div className={styles.cardBtns}>
            <button
              type="button"
              className={styles.btn}
              disabled
              title="需候选包达到 release-ready，并接入生产部署执行器"
            >
              未接入
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
        </>
      ) : null}

      {props.errorText ? (
        <div className={styles.cardError}>{props.errorText}</div>
      ) : null}
    </div>
  );
}
