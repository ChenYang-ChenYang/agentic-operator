"use client";
// OntoCode v10 · 原生新建 Session：选活跃 Ontology 域 + 一句业务目标 → 创建并进入。
// 复用旧 Hub 的创建语义（确保 Project → 创建 Session → bootstrap），零 mock。
import React, { useMemo, useState } from "react";
import { useBusinessOntologyDomains } from "@/lib/hooks/useBusinessOntologyDomains";
import {
  useBootstrapOntoCodeSession,
  useCreateOntoCodeProject,
  useCreateOntoCodeSession,
  useOntoCodeProjects,
} from "@/lib/hooks/useOntoCodeWorkspace";
import styles from "./workbench.module.css";

const SOURCE_LABEL: Record<string, string> = {
  allmeta: "Allmeta 实时源",
  upload: "上传快照",
  manifest_legacy: "历史绑定",
};

export interface CreateSessionPanelProps {
  tenant: string;
  open: boolean;
  /** standalone=true 用于「还没有任何 Session」的首屏，占满内容区而非弹层。 */
  standalone?: boolean;
  onClose?: () => void;
  onCreated: (sessionId: string) => void;
}

export function CreateSessionPanel(props: CreateSessionPanelProps) {
  const domainsQ = useBusinessOntologyDomains(props.tenant);
  const projectsQ = useOntoCodeProjects(props.tenant);
  const createProject = useCreateOntoCodeProject(props.tenant);
  const createSession = useCreateOntoCodeSession(props.tenant);
  const bootstrap = useBootstrapOntoCodeSession(props.tenant);

  const [goal, setGoal] = useState("");
  const [registrationId, setRegistrationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const registrations = useMemo(
    () =>
      (domainsQ.data?.items ?? []).filter(
        (d) => d.status === "active" && d.archivedAt === null,
      ),
    [domainsQ.data],
  );
  const selected =
    registrations.find((r) => r.id === registrationId) ??
    registrations.find((r) => r.isDefault) ??
    registrations[0] ??
    null;

  if (!props.open) return null;

  const submit = async () => {
    if (!selected) {
      setError("当前 Business Domain 还没有活跃的 Ontology 域——先在「管理 Ontology Domains」注册或上传一个。");
      return;
    }
    if (!selected.executionReadiness.executable) {
      setError(selected.executionReadiness.message || "所选域尚未运行时就绪。");
      return;
    }
    const goalText =
      goal.trim() ||
      "根据当前 Ontology 分析业务范围，并生成可测试、可审查的 Agent 套件。";
    setBusy(true);
    setError(null);
    try {
      let project = (projectsQ.data?.items ?? []).find(
        (p) => p.ontologyDomainRegistrationId === selected.id,
      );
      if (!project) {
        const receipt = await createProject.mutateAsync({
          domain: selected.ontologyDomainId,
          ontologyDomainRegistrationId: selected.id,
          name: selected.displayName || selected.ontologyDomainId,
          description: "OntoCode 工作台管理的 Agent 工程项目。",
        });
        project = receipt.project;
      }
      const receipt = await createSession.mutateAsync({
        projectId: project.id,
        title: goalText.slice(0, 56) || "新的 Agent 构建",
        goal: goalText,
        autonomyMode: "copilot",
      });
      await bootstrap.mutateAsync({
        sessionId: receipt.session.id,
        goal: goalText,
      });
      props.onCreated(receipt.session.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <div className={styles.createPanel}>
      <div className={styles.goalLabel}>新建 Session</div>
      <h2 className={styles.goalTitle}>你想构建什么？</h2>
      <label className={styles.createLabel} htmlFor="oc-create-domain">
        Ontology 域
      </label>
      <select
        id="oc-create-domain"
        className={styles.createSelect}
        value={selected?.id ?? ""}
        onChange={(e) => setRegistrationId(e.target.value)}
        disabled={busy || registrations.length === 0}
      >
        {registrations.length === 0 ? (
          <option value="">（无活跃域——请先注册或上传）</option>
        ) : (
          registrations.map((r) => (
            <option key={r.id} value={r.id}>
              {r.displayName || r.ontologyDomainId} ·{" "}
              {SOURCE_LABEL[r.source] ?? r.source}
              {r.executionReadiness.executable ? "" : " · 未就绪"}
            </option>
          ))
        )}
      </select>
      {selected && !selected.executionReadiness.executable ? (
        <div className={styles.cardError}>
          {selected.executionReadiness.message || "该域尚未运行时就绪。"}
        </div>
      ) : null}
      <label className={styles.createLabel} htmlFor="oc-create-goal">
        业务目标（一句话即可）
      </label>
      <textarea
        id="oc-create-goal"
        className={styles.createGoal}
        placeholder="例：基于当前 Ontology 的全部可执行 Actions，生成可测试、可审查的 Agent 套件…"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        disabled={busy}
      />
      {error ? <div className={styles.cardError}>{error}</div> : null}
      <div className={styles.cardBtns}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnGreen}`}
          onClick={() => void submit()}
          disabled={busy}
        >
          {busy ? "创建中…" : "创建并开始"}
        </button>
        {props.onClose ? (
          <button
            type="button"
            className={styles.btn}
            onClick={props.onClose}
            disabled={busy}
          >
            取消
          </button>
        ) : null}
      </div>
      <div className={styles.createHint}>
        域列表来自当前 Business Domain 的活跃注册项；需要新增或上传域时，去
        「Business Domains」页注册一次即可长期复用。
      </div>
    </div>
  );

  if (props.standalone) {
    return <div className={styles.createStandalone}>{body}</div>;
  }
  return (
    <div
      className={styles.overlayBackdrop}
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) props.onClose?.();
      }}
    >
      {body}
    </div>
  );
}
