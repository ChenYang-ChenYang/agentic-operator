"use client";
// OntoCode v10 · 连接面板：本域 Ontology 引用的【全部】系统及其连接成熟度。
// 阻塞卡只显示"本次被拦下的那一个"；这里回答"还有哪些系统、各自什么状态、怎么处理"。
import React from "react";
import type { SystemCoverageItem } from "@/lib/hooks/useOntoCodeWorkspace";
import { HelpTip } from "@/app/portal/components";
import styles from "./workbench.module.css";

export type ConnectionStage =
  | "runtime"
  | "verified"
  | "configured"
  | "boundary"
  | "needsCredential"
  | "needsProfile";

const STAGE_LABEL: Record<ConnectionStage, string> = {
  runtime: "运行时提供",
  verified: "连接已验证",
  configured: "已配置 · 未验证",
  boundary: "人工边界",
  needsCredential: "待配置凭证",
  needsProfile: "待建档",
};

const STAGE_CLASS: Record<ConnectionStage, string> = {
  runtime: "agStatOk",
  verified: "agStatOk",
  configured: "agStatRun",
  boundary: "agStatOff",
  needsCredential: "agStatBad",
  needsProfile: "agStatBad",
};

/** 连接成熟度阶梯：运行时 → 已验证 → 已配置 → 人工边界 → 缺凭证 → 未建档。 */
export function connectionStage(row: SystemCoverageItem): ConnectionStage {
  if (row.runtimeProvided) return "runtime";
  if (row.probeOk === true) return "verified";
  if (row.credentialConfigured) return "configured";
  if (row.humanBoundary) return "boundary";
  if (row.credentialProvider) return "needsCredential";
  return "needsProfile";
}

export interface SystemConnectionsViewProps {
  domainLabel: string;
  rows: SystemCoverageItem[];
  totals?: { referenced: number; profiled: number; humanBoundary: number; unprofiled: number };
  loading?: boolean;
  errorText?: string | null;
  busySystem?: string | null;
  onConfigure: (provider: string) => void;
  onProbe: (profileId: string) => void;
  onMarkBoundary: (system: string) => void;
  onOpenFactoryProfiles?: () => void;
}

export function SystemConnectionsView(props: SystemConnectionsViewProps) {
  if (props.loading) {
    return <div className={styles.iEmpty}>读取中…</div>;
  }
  if (props.errorText) {
    return <div className={styles.iEmpty}>{props.errorText}</div>;
  }
  if (props.rows.length === 0) {
    return <div className={styles.iEmpty}>无外部系统</div>;
  }
  const verified = props.rows.filter((row) => row.probeOk === true).length;

  return (
    <div>
      <div className={styles.ovSum}>
        <span className={`${styles.ovChip} ${styles.ovChipOk}`}>
          {verified} 已验证
        </span>
        {props.totals ? (
          <>
            <span className={styles.ovChip}>
              {props.totals.referenced} 个系统
            </span>
            {props.totals.humanBoundary > 0 ? (
              <span className={styles.ovChip}>
                {props.totals.humanBoundary} 人工边界
              </span>
            ) : null}
            {props.totals.unprofiled > 0 ? (
              <span className={`${styles.ovChip} ${styles.ovChipWarn}`}>
                {props.totals.unprofiled} 待建档
              </span>
            ) : null}
          </>
        ) : null}
        <HelpTip>
          每个系统需真实工具或凭证；人工边界系统只出设计稿，沙箱与上线仍会拦截。
        </HelpTip>
        {props.onOpenFactoryProfiles ? (
          <button
            type="button"
            className={styles.mini}
            onClick={props.onOpenFactoryProfiles}
          >
            集成档案 →
          </button>
        ) : null}
      </div>

      {props.rows.map((row) => {
        const stage = connectionStage(row);
        const busy =
          props.busySystem === row.system || props.busySystem === row.profileId;
        const envOnly = row.configRequirement?.posture === "env_only";
        return (
          <div key={row.system} className={styles.connRow}>
            <div className={styles.connHead}>
              <span className={styles.connName}>{row.system}</span>
              <span
                className={`${styles.agStat} ${styles[STAGE_CLASS[stage]]}`}
              >
                {STAGE_LABEL[stage]}
              </span>
            </div>
            {row.referencedByActions.length > 0 ? (
              <div className={styles.connMeta}>
                {row.referencedByActions.slice(0, 4).join("、")}
                {row.referencedByActions.length > 4
                  ? ` 等 ${row.referencedByActions.length} 个动作`
                  : ""}
              </div>
            ) : null}
            {envOnly ? (
              <div className={styles.connMeta}>
                {row.credentialConfigured
                  ? "环境引用已就绪；凭证值不会进入浏览器。"
                  : "环境引用缺失；由运维在服务端补齐。凭证值不会进入浏览器。"}
              </div>
            ) : null}
            {/*
              Naming the variables is the actionable half. "由运维补齐" without
              a list leaves the operator to guess which ones, and presence is
              the only fact a browser may learn about a deployment secret.
            */}
            {envOnly && (row.configRequirement?.fields?.length ?? 0) > 0 ? (
              <div className={styles.connMeta}>
                {row.configRequirement!.fields.map((field) => (
                  <span key={field.key} style={{ marginRight: 10 }}>
                    {field.key}
                    {field.envPresent ? " ✓" : field.required ? " *" : ""}
                  </span>
                ))}
              </div>
            ) : null}
            <div className={styles.connBtns}>
              {row.credentialProvider ? (
                <button
                  type="button"
                  className={
                    row.credentialConfigured
                      ? styles.mini
                      : `${styles.mini} ${styles.btnAmber}`
                  }
                  onClick={() => props.onConfigure(row.credentialProvider!)}
                  disabled={busy}
                >
                  配置 →
                </button>
              ) : null}
              {row.profileId &&
              row.credentialConfigured &&
              row.probeSupported ? (
                <button
                  type="button"
                  className={styles.mini}
                  onClick={() => props.onProbe(row.profileId!)}
                  disabled={busy}
                >
                  {busy
                    ? "测试中…"
                    : row.probeKind === "allmeta_ontology_read"
                      ? "验证本体只读"
                      : "测试"}
                </button>
              ) : null}
              {row.profileId &&
              row.credentialConfigured &&
              !row.probeSupported ? (
                <span className={`${styles.agStat} ${styles.agStatOff}`}>
                  无探针
                </span>
              ) : null}
              {!row.runtimeProvided && !row.humanBoundary ? (
                <button
                  type="button"
                  className={styles.mini}
                  onClick={() => props.onMarkBoundary(row.system)}
                  disabled={busy}
                >
                  人工边界
                </button>
              ) : null}
              {row.probeOk === false ? (
                <span className={`${styles.agStat} ${styles.agStatBad}`}>
                  测试失败
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
