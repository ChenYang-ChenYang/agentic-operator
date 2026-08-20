"use client";
// OntoCode v10 · 中栏引导流：目标卡 + 流条目 + 单行状态 + composer。
// 行动卡由容器通过 renderCard 注入（容器负责把 hooks 绑到具体卡上）。
import React, { useState } from "react";
import styles from "./workbench.module.css";
import { Markdown } from "@/app/portal/components/markdown";
import { HelpTip } from "@/app/portal/components";
import type { FlowItemVM } from "./projection";
import type { LiveAnswerVM } from "./answer-stream";
import { OntoCodeChart } from "./OntoCodeChart";
import { AUTONOMY_MODE_COPY, autonomyModeDescription } from "./autonomy-copy";
import { formatWaitDuration, type AssistantWaitVM } from "./assistant-wait";

export interface GuidedFlowProps {
  goal: { title: string; chips: string[] } | null;
  items: FlowItemVM[];
  renderCard: (
    item: Extract<FlowItemVM, { kind: "actionCard" }>,
  ) => React.ReactNode;
  /**
   * 正在流式生成的回答（每个 Harness 作业至多一个直播气泡）。
   * 权威始终是落库消息：作业的 durable 答案一到，容器就不再传对应条目。
   */
  liveAnswers?: LiveAnswerVM[];
  /** Open the persisted stage result in the right-hand artifact inspector. */
  onInspectStage?: (kind: "analysis" | "scope" | "blueprint") => void;
  /**
   * #ASSISTANT-CITE — open the artifact an answer stood on. Without it the
   * citations render as inert text, which is the状态 this fix removes.
   */
  onOpenCitation?: (ref: { artifactId: string; versionId: string }) => void;
  /** Retry a recoverable failure under the exact persisted Harness Job id. */
  onRetryJob?: (jobId: string) => void;
  retryingJobId?: string | null;
  retryErrorJobId?: string | null;
  retryError?: string | null;
  /** 停下正在跑的作业。缺省不显示——没有作业在跑时不该有停止按钮。 */
  onStop?: () => void;
  stopping?: boolean;
  /**
   * 对话推理正在飞。缺省不渲染。
   *
   * 中央网关单发、没有 token 流，所以模型思考期间必然有空窗——这一行说的就是
   * 那段空窗，且只说得出两件真事：已经过去多久、最后一条过程记录是什么。
   */
  waiting?: AssistantWaitVM | null;
}

/**
 * 等待行。
 *
 * 刻意没有转圈：空窗期什么都没发生，屏幕上就不该有东西在动。会变的只有秒数，
 * 而那个数是真实经过的时间。
 */
function WaitLine({ waiting }: { waiting: AssistantWaitVM }) {
  return (
    <div className={styles.waitLine} role="status" aria-live="polite">
      <span className={styles.waitClock}>
        等待模型返回 · 已 {formatWaitDuration(waiting.elapsedMs)}
      </span>
      <span className={styles.waitFact}>
        {waiting.lastFact !== null && waiting.sinceLastFactMs !== null
          ? `最近：${waiting.lastFact}（${formatWaitDuration(
              waiting.sinceLastFactMs,
            )}前）`
          : "尚无过程记录"}
      </span>
      <HelpTip>
        这里的秒数是真实经过的时间，不是进度。模型这一次返回之前不会有新的过程记录——中央网关单发，没有逐字流。
      </HelpTip>
    </div>
  );
}

/** 直播中的回答气泡：累积 markdown + 到场图表 + 最近一次工具活动。 */
function LiveAnswerBubble({ live }: { live: LiveAnswerVM }) {
  return (
    <div className={styles.aiMsg}>
      <span className={styles.aiAvatar}>✦</span>
      <div className={styles.aiBody}>
        {live.markdown ? <Markdown>{live.markdown}</Markdown> : null}
        {live.charts.map((spec, index) => (
          <OntoCodeChart key={index} spec={spec} />
        ))}
        {live.truncated ? (
          <div className={styles.liveNote}>
            回答分片已达上限，这段实时预览不完整——完整内容以最终消息为准。
          </div>
        ) : null}
        {live.invalidFrames > 0 ? (
          <div className={styles.liveNote}>
            有 {live.invalidFrames}{" "}
            条实时分片无法解析，这段预览可能缺内容——完整内容以最终消息为准。
          </div>
        ) : null}
        {live.activity ? (
          <div className={styles.liveActivity}>
            {live.activity.busy ? <span className={styles.spin} /> : null}
            {live.activity.text}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function GuidedFlow(props: GuidedFlowProps) {
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const liveAnswers = props.liveAnswers ?? [];
  // 直播气泡插在状态行之前：回答还在生成，进行中的状态行仍然收尾。
  const lastItem = props.items[props.items.length - 1];
  const trailingStatus =
    lastItem && lastItem.kind === "statusLine" ? lastItem : null;
  const bodyItems = trailingStatus ? props.items.slice(0, -1) : props.items;

  const renderItem = (item: FlowItemVM): React.ReactNode => {
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
              {item.text ? <Markdown>{item.text}</Markdown> : null}
              {(item.charts ?? []).map((spec, index) => (
                <OntoCodeChart key={`${item.id}-chart-${index}`} spec={spec} />
              ))}
              {/*
                The evidence this answer named. Rendering it is what lets an
                FDE check a claim instead of trusting it.
              */}
              {(item.citations ?? []).length > 0 ? (
                <div className={styles.citeRow}>
                  <span className={styles.citeLabel}>依据</span>
                  {item.citations!.map((ref, index) => (
                    <button
                      key={ref.raw}
                      type="button"
                      className={styles.citeChip}
                      title={ref.raw}
                      onClick={() =>
                        props.onOpenCitation?.({
                          artifactId: ref.artifactId,
                          versionId: ref.versionId,
                        })
                      }
                      disabled={!props.onOpenCitation}
                    >
                      产物 {index + 1}
                    </button>
                  ))}
                </div>
              ) : null}
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
              onClick={() => setOpenGroups((s) => ({ ...s, [item.id]: !open }))}
            >
              {item.title}
              <span className={styles.execMeter}>
                {item.steps.length > 0 ? `${item.steps.length} 步` : ""}
              </span>
            </button>
            {item.stageDocKind && props.onInspectStage ? (
              <button
                type="button"
                className={styles.execResultButton}
                onClick={() => props.onInspectStage?.(item.stageDocKind!)}
              >
                查看 <span aria-hidden="true">→</span>
              </button>
            ) : null}
            {item.retryJobId && props.onRetryJob ? (
              <button
                type="button"
                className={styles.execResultButton}
                onClick={() => props.onRetryJob?.(item.retryJobId!)}
                disabled={props.retryingJobId === item.retryJobId}
              >
                {props.retryingJobId === item.retryJobId
                  ? "重新排队中…"
                  : "重试这一步"}
              </button>
            ) : null}
            {item.retryJobId === props.retryErrorJobId && props.retryError ? (
              <div className={styles.cardError} role="alert">
                重试失败：{props.retryError}
              </div>
            ) : null}
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
            {/* 在此之前，作业跑飞了的唯一出路是删掉整个 Session——
                连带消息、事件、产物、证据一起没了。 */}
            {props.onStop ? (
              <button
                type="button"
                className={styles.mini}
                onClick={props.onStop}
                disabled={props.stopping}
              >
                {props.stopping ? "停止中…" : "停止"}
              </button>
            ) : null}
          </div>
        );
      default:
        return null;
    }
  };

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

      {bodyItems.map(renderItem)}
      {liveAnswers.map((live) => (
        <LiveAnswerBubble key={`live-${live.jobId}`} live={live} />
      ))}
      {trailingStatus ? renderItem(trailingStatus) : null}
      {/* 等待行永远排在最后：它说的是「此刻之后还没有东西到」。 */}
      {props.waiting ? <WaitLine waiting={props.waiting} /> : null}
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
  autonomyChanging?: boolean;
  autonomyError?: string | null;
  contextTokens: string[];
  /** 一行一键动作。刻意少——中栏保持极简。 */
  quickActions?: Array<{ label: string; run: () => void }>;
}

export function Composer(props: ComposerProps) {
  const canSend =
    !props.sending &&
    !props.disabled &&
    !props.autonomyChanging &&
    props.value.trim().length > 0;
  return (
    <div className={styles.composer}>
      <textarea
        className={styles.composerInput}
        placeholder={
          props.disabled
            ? (props.disabledReason ?? "当前会话只读")
            : "说点什么…"
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
          disabled={props.disabled || props.autonomyChanging}
          aria-label="自主性"
        >
          {AUTONOMY_MODE_COPY.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {/* 当前模式的能力边界事实收进 HelpTip——事实原样保留，不常驻占屏。 */}
        {autonomyModeDescription(props.autonomy) ? (
          <HelpTip>{autonomyModeDescription(props.autonomy)}</HelpTip>
        ) : null}
        <HelpTip>Enter 发送，Shift+Enter 换行</HelpTip>
        <button
          type="button"
          className={styles.sendBtn}
          onClick={props.onSend}
          disabled={!canSend}
        >
          {props.sending ? "发送中…" : "发送"}
        </button>
      </div>
      {props.autonomyError ? (
        <div className={styles.cardError} role="alert">
          执行方式未切换：{props.autonomyError}
        </div>
      ) : null}
      {props.quickActions && props.quickActions.length > 0 ? (
        <div className={styles.quickRow}>
          {props.quickActions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={styles.quickChip}
              onClick={action.run}
              disabled={
                props.disabled || props.sending || props.autonomyChanging
              }
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
