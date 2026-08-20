"use client";

import Link from "next/link";
import React, { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import type { OntoCodeAutonomyMode } from "@agentic/contracts";
import { Icon } from "@/app/portal/components/Icon";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { LanguageToggle } from "@/app/portal/components/shell/appearance-controls";
import {
  PHASE_LABELS,
  SESSION_STATUS_ICONS,
  workspaceScopeGoal,
  workspaceSessionCreationBlockers,
  type CreateWorkspaceSessionInput,
  type SessionStatus,
  type WorkspaceBoundAction,
  type WorkspaceBoundOntology,
  type WorkspaceHubReadiness,
  type WorkspaceSession,
  type WorkspaceSessionScopeMode,
  type WorkspaceTenantIdentity,
} from "./model";
import styles from "./workspace.module.css";

const STATUS_FILTERS: Array<{
  id: "all" | SessionStatus;
  labelKey: string;
}> = [
  { id: "all", labelKey: "ontocode.hub.filter.all" },
  { id: "running", labelKey: "ontocode.hub.filter.running" },
  { id: "needs_action", labelKey: "ontocode.hub.filter.needsAction" },
  { id: "ready", labelKey: "ontocode.hub.filter.ready" },
  { id: "released", labelKey: "ontocode.hub.filter.released" },
];

const SCOPE_STARTERS: Array<{
  id: WorkspaceSessionScopeMode;
  step: string;
  titleKey: string;
  descriptionKey: string;
  icon: "workflow" | "spark" | "task";
}> = [
  {
    id: "full_domain",
    step: "01",
    titleKey: "ontocode.hub.scope.full.title",
    descriptionKey: "ontocode.hub.scope.full.description",
    icon: "workflow",
  },
  {
    id: "scenario",
    step: "02",
    titleKey: "ontocode.hub.scope.scenario.title",
    descriptionKey: "ontocode.hub.scope.scenario.description",
    icon: "spark",
  },
  {
    id: "selected_actions",
    step: "03",
    titleKey: "ontocode.hub.scope.actions.title",
    descriptionKey: "ontocode.hub.scope.actions.description",
    icon: "task",
  },
];

const AUTONOMY_MODES: Array<{
  id: OntoCodeAutonomyMode;
  titleKey: string;
  descriptionKey: string;
}> = [
  {
    id: "sandbox_autopilot",
    titleKey: "ontocode.hub.autonomy.autonomous.title",
    descriptionKey: "ontocode.hub.autonomy.autonomous.description",
  },
  {
    id: "copilot",
    titleKey: "ontocode.hub.autonomy.confirm.title",
    descriptionKey: "ontocode.hub.autonomy.confirm.description",
  },
  {
    id: "guide",
    titleKey: "ontocode.hub.autonomy.analysis.title",
    descriptionKey: "ontocode.hub.autonomy.analysis.description",
  },
];

export interface WorkspaceSessionHubProps {
  sessions?: WorkspaceSession[];
  tenantIdentity?: WorkspaceTenantIdentity | null;
  /**
   * Default registered Ontology Domain. Its Actions are available for the
   * optional selected-actions starter; it is not a singleton write binding.
   */
  boundOntology?: WorkspaceBoundOntology | null;
  /** Active registrations returned by the Business Domain registry API. */
  availableOntologyDomains?: WorkspaceBoundOntology[];
  /** Exact Action inventory keyed by stable registration id. */
  ontologyActionsByRegistrationId?: Record<string, WorkspaceBoundAction[]>;
  /** Truthful read state for each exact registration inventory. */
  ontologyActionsStateByRegistrationId?: Record<
    string,
    "loading" | "ready" | "error"
  >;
  /** Compatibility input for the default registration. */
  boundActions?: WorkspaceBoundAction[];
  readiness?: WorkspaceHubReadiness;
  sessionBasePath?: string;
  appendSessionId?: boolean;
  onCreateSession?: (
    input: CreateWorkspaceSessionInput,
  ) => void | Promise<void>;
  onOpenSession?: (session: WorkspaceSession) => void;
}

export function WorkspaceSessionHub({
  sessions: sessionSource = [],
  tenantIdentity,
  boundOntology = null,
  availableOntologyDomains = [],
  ontologyActionsByRegistrationId = {},
  ontologyActionsStateByRegistrationId = {},
  boundActions = [],
  readiness,
  sessionBasePath,
  appendSessionId = true,
  onCreateSession,
  onOpenSession,
}: WorkspaceSessionHubProps = {}) {
  const { language, t } = useI18n();
  const params = useParams<{ tenant?: string }>();
  const routeTenant = params.tenant?.trim() || "";
  const tenant =
    tenantIdentity ??
    (routeTenant
      ? { id: routeTenant, slug: routeTenant, name: routeTenant }
      : null);
  const resolvedReadiness: WorkspaceHubReadiness = {
    bindingState: boundOntology ? "ready" : "missing",
    gatewayConfigured: false,
    configurationState: "checked_in_session",
    ...readiness,
  };
  const resolvedSessionBasePath =
    sessionBasePath ??
    (routeTenant
      ? `/portal/${routeTenant}/ontocode-workspace`
      : "/portal/ontocode-workspace");
  const sessionHref = (sessionId: string) =>
    appendSessionId
      ? `${resolvedSessionBasePath}/${sessionId}`
      : resolvedSessionBasePath;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | SessionStatus>("all");
  const [creating, setCreating] = useState(false);
  const [scopeMode, setScopeMode] =
    useState<WorkspaceSessionScopeMode>("full_domain");
  const [title, setTitle] = useState("");
  const [titleManaged, setTitleManaged] = useState(true);
  const [goal, setGoal] = useState("");
  const [goalManaged, setGoalManaged] = useState(true);
  const [autonomyMode, setAutonomyMode] =
    useState<OntoCodeAutonomyMode>("copilot");
  const [selectedActionIds, setSelectedActionIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const registeredDomains = useMemo(
    () =>
      availableOntologyDomains
        .filter(
          (domain) =>
            Boolean(domain.registrationId) &&
            (domain.source === "allmeta" || domain.source === "upload"),
        )
        .sort(
          (a, b) =>
            Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) ||
            a.name.localeCompare(b.name),
        ),
    [availableOntologyDomains],
  );
  const [selectedRegistrationId, setSelectedRegistrationId] = useState(() => {
    const defaultRegistration = registeredDomains.find(
      (domain) => domain.isDefault,
    )?.registrationId;
    return (
      defaultRegistration ||
      (boundOntology &&
      registeredDomains.some(
        (domain) => domain.registrationId === boundOntology.registrationId,
      )
        ? boundOntology.registrationId
        : "") ||
      registeredDomains[0]?.registrationId ||
      ""
    );
  });
  const selectedOntology =
    registeredDomains.find(
      (domain) => domain.registrationId === selectedRegistrationId,
    ) ?? null;

  useEffect(() => {
    const defaultRegistration = registeredDomains.find(
      (domain) => domain.isDefault,
    )?.registrationId;
    setSelectedRegistrationId((selected) =>
      registeredDomains.some((domain) => domain.registrationId === selected)
        ? selected
        : defaultRegistration || registeredDomains[0]?.registrationId || "",
    );
  }, [registeredDomains]);

  const sessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessionSource.filter((session) => {
      if (status !== "all" && session.status !== status) return false;
      return (
        !needle ||
        session.title.toLowerCase().includes(needle) ||
        session.domain.toLowerCase().includes(needle) ||
        session.goal.toLowerCase().includes(needle)
      );
    });
  }, [query, sessionSource, status]);

  const selectedActionsState = selectedOntology
    ? (ontologyActionsStateByRegistrationId[selectedOntology.registrationId] ??
      "ready")
    : "ready";
  const actionsForSelectedOntology = selectedOntology
    ? (ontologyActionsByRegistrationId[selectedOntology.registrationId] ??
      (selectedOntology.registrationId === boundOntology?.registrationId
        ? boundActions
        : []))
    : [];
  const selectedActions = useMemo(() => {
    const selected = new Set(selectedActionIds);
    return actionsForSelectedOntology.filter((action) =>
      selected.has(action.id),
    );
  }, [actionsForSelectedOntology, selectedActionIds]);

  const creationBlockers = workspaceSessionCreationBlockers({
    tenant,
    ontology: selectedOntology,
    actions: actionsForSelectedOntology,
    readiness: resolvedReadiness,
    hasCreateHandler: Boolean(onCreateSession),
  });
  const modeBlocker =
    scopeMode === "selected_actions" && selectedActionIds.length === 0
      ? t("ontocode.hub.validation.action")
      : null;
  const formBlocker = !title.trim()
    ? t("ontocode.hub.validation.title")
    : !goal.trim()
      ? scopeMode === "scenario"
        ? t("ontocode.hub.validation.scenario")
        : t("ontocode.hub.validation.goal")
      : modeBlocker;
  const canSubmit =
    creationBlockers.length === 0 && !formBlocker && !submitting;

  const activeCount = sessionSource.filter(
    (session) =>
      session.status === "running" ||
      session.status === "needs_action" ||
      session.status === "paused",
  ).length;
  const needsActionCount = sessionSource.filter(
    (session) => session.status === "needs_action",
  ).length;
  const reviewCount = sessionSource.filter(
    (session) => session.status === "ready",
  ).length;
  const releasedCount = sessionSource.filter(
    (session) => session.status === "released",
  ).length;
  const ontologyActionCount =
    selectedOntology?.counts?.actions ?? actionsForSelectedOntology.length;
  const ontologySourceLabel =
    selectedOntology?.source === "allmeta"
      ? t("ontocode.hub.sourceAllmeta")
      : selectedOntology?.source === "upload"
        ? t("ontocode.hub.sourceUpload")
        : t("ontocode.hub.sourceUnknown");

  function suggestedTitle(mode: WorkspaceSessionScopeMode): string {
    if (!selectedOntology) return "";
    const suffix: Record<WorkspaceSessionScopeMode, string> = {
      full_domain: language === "en" ? "Domain Agent build" : "全域 Agent 构建",
      scenario: language === "en" ? "Scenario Agent build" : "场景 Agent 构建",
      selected_actions:
        language === "en" ? "Selected Actions build" : "Actions Agent 构建",
    };
    return `${selectedOntology.name} · ${suffix[mode]}`;
  }

  function openCreation() {
    const next = !creating;
    setCreating(next);
    setCreateError(null);
    if (!next) return;
    if (!title.trim() || titleManaged) {
      setTitle(suggestedTitle(scopeMode));
      setTitleManaged(true);
    }
    if (!goal.trim() || goalManaged) {
      setGoal(
        workspaceScopeGoal(
          scopeMode,
          selectedOntology,
          selectedActions,
          language,
        ),
      );
      setGoalManaged(true);
    }
  }

  function selectScopeMode(mode: WorkspaceSessionScopeMode) {
    setScopeMode(mode);
    setSelectedActionIds([]);
    setCreateError(null);
    if (titleManaged) setTitle(suggestedTitle(mode));
    if (goalManaged) {
      setGoal(workspaceScopeGoal(mode, selectedOntology, [], language));
    }
  }

  function selectOntologyDomain(registrationId: string) {
    const nextOntology =
      registeredDomains.find(
        (domain) => domain.registrationId === registrationId,
      ) ?? null;
    setSelectedRegistrationId(registrationId);
    setSelectedActionIds([]);
    setCreateError(null);
    if (scopeMode === "selected_actions") {
      setScopeMode("full_domain");
    }
    if (titleManaged) {
      const suffix =
        language === "en" ? "Domain Agent build" : "全域 Agent 构建";
      setTitle(nextOntology ? `${nextOntology.name} · ${suffix}` : "");
    }
    if (goalManaged) {
      setGoal(workspaceScopeGoal("full_domain", nextOntology, [], language));
    }
  }

  function toggleAction(actionId: string) {
    const nextIds = selectedActionIds.includes(actionId)
      ? selectedActionIds.filter((candidate) => candidate !== actionId)
      : [...selectedActionIds, actionId];
    setSelectedActionIds(nextIds);
    if (goalManaged) {
      const selected = new Set(nextIds);
      setGoal(
        workspaceScopeGoal(
          "selected_actions",
          selectedOntology,
          actionsForSelectedOntology.filter((action) =>
            selected.has(action.id),
          ),
          language,
        ),
      );
    }
  }

  async function createSession() {
    if (!canSubmit || !onCreateSession || !selectedOntology) return;
    const input: CreateWorkspaceSessionInput = {
      title: title.trim(),
      goal: goal.trim(),
      autonomyMode,
      ontologyDomainRegistrationId: selectedOntology.registrationId,
      domain: selectedOntology.id,
      scopeMode,
      ...(scopeMode === "selected_actions"
        ? { actionIds: selectedActionIds }
        : {}),
    };
    setSubmitting(true);
    setCreateError(null);
    try {
      await onCreateSession(input);
      setCreating(false);
    } catch (error) {
      setCreateError(
        error instanceof Error
          ? error.message
          : t("ontocode.hub.validation.createFailed"),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={styles.hubShell}>
      <header className={styles.hubHeader}>
        <div>
          <span className={styles.eyebrow}>{t("ontocode.hub.eyebrow")}</span>
          <h1>{t("ontocode.hub.title")}</h1>
          <p>{t("ontocode.hub.description")}</p>
        </div>
        <div className={styles.hubHeaderActions}>
          <LanguageToggle />
          <button
            type="button"
            className={styles.primaryButton}
            onClick={openCreation}
            aria-expanded={creating}
          >
            <Icon name={creating ? "x" : "plus"} size={15} />
            {creating
              ? t("ontocode.hub.closeCreate")
              : t("ontocode.hub.create")}
          </button>
        </div>
      </header>

      <section
        className={styles.hubBindingSummary}
        aria-label={t("ontocode.hub.currentContext")}
      >
        <div className={styles.hubBindingIntro}>
          <span className={styles.iconWell}>
            <Icon name="library" size={16} />
          </span>
          <div>
            <small>{t("ontocode.hub.currentContext")}</small>
            <strong>{tenant?.name ?? "—"}</strong>
            <span>{tenant?.slug ?? tenant?.id ?? "—"}</span>
          </div>
        </div>
        <div className={styles.hubBindingStat}>
          <span>{t("ontocode.hub.ontology")}</span>
          <strong>
            {selectedOntology?.name ?? t("ontocode.hub.noOntology")}
          </strong>
          <small>
            {selectedOntology?.id ?? "—"} ·{" "}
            {t("ontocode.hub.actionsCount", {
              count: ontologyActionCount,
            })}{" "}
            · {ontologySourceLabel}
          </small>
        </div>
        <div className={styles.hubBindingStat}>
          <span>{t("ontocode.hub.sessions")}</span>
          <strong>{sessionSource.length}</strong>
          <small>
            {t("ontocode.hub.sessionsCount", {
              count: sessionSource.length,
            })}
          </small>
        </div>
        <details className={styles.hubReadinessDetails}>
          <summary>{t("ontocode.hub.details")}</summary>
          <div className={styles.readinessStrip}>
            <ReadinessItem
              label={t("ontocode.hub.readinessItem.binding")}
              value={
                resolvedReadiness.bindingState === "loading"
                  ? t("ontocode.hub.readinessItem.loading")
                  : selectedOntology
                    ? selectedOntology.name
                    : t("ontocode.hub.readinessItem.notConnected")
              }
              state={
                resolvedReadiness.bindingState === "loading"
                  ? "neutral"
                  : selectedOntology
                    ? "ready"
                    : "blocked"
              }
              href={
                selectedOntology
                  ? undefined
                  : resolvedReadiness.ontologySettingsHref
              }
              actionLabel={t("ontocode.hub.readinessItem.configure")}
            />
            <ReadinessItem
              label={t("ontocode.hub.readinessItem.gateway")}
              value={
                resolvedReadiness.gatewayConfigured
                  ? resolvedReadiness.gatewayLabel ||
                    t("ontocode.hub.readinessItem.configured")
                  : t("ontocode.hub.readinessItem.notConfigured")
              }
              state={resolvedReadiness.gatewayConfigured ? "ready" : "blocked"}
              href={
                resolvedReadiness.gatewayConfigured
                  ? undefined
                  : resolvedReadiness.gatewaySettingsHref
              }
              actionLabel={t("ontocode.hub.readinessItem.configure")}
            />
            <ReadinessItem
              label={t("ontocode.hub.readinessItem.harness")}
              value={
                resolvedReadiness.configurationLabel ||
                t("ontocode.hub.readinessItem.verifiedInSession")
              }
              state={
                resolvedReadiness.configurationState === "blocked"
                  ? "blocked"
                  : "neutral"
              }
              href={resolvedReadiness.configurationHref}
              actionLabel={t("ontocode.hub.readinessItem.inspect")}
            />
          </div>
        </details>
        {resolvedReadiness.ontologySettingsHref ? (
          <Link
            className={styles.hubOntologyUploadLink}
            href={resolvedReadiness.ontologySettingsHref}
          >
            {t("ontocode.hub.manageRegisteredDomains")}
            <Icon name="external" size={12} />
          </Link>
        ) : null}
      </section>

      <div
        className={styles.hubMetrics}
        aria-label={t("ontocode.hub.overviewAria")}
      >
        <Metric
          label={t("ontocode.hub.metric.active")}
          value={String(activeCount)}
          detail={t("ontocode.hub.metricDetail.active", {
            count: sessionSource.length,
          })}
          icon="replay"
        />
        <Metric
          label={t("ontocode.hub.metric.needsAction")}
          value={String(needsActionCount)}
          detail={t("ontocode.hub.metricDetail.needsAction")}
          icon="alert"
          tone={needsActionCount > 0 ? "warning" : "success"}
        />
        <Metric
          label={t("ontocode.hub.metric.review")}
          value={String(reviewCount)}
          detail={t("ontocode.hub.metricDetail.review")}
          icon="logs"
        />
        <Metric
          label={t("ontocode.hub.metric.released")}
          value={String(releasedCount)}
          detail={t("ontocode.hub.metricDetail.released")}
          icon="deploy"
          tone="success"
        />
      </div>

      {creating ? (
        <form
          className={styles.createSessionPanel}
          onSubmit={(event) => {
            event.preventDefault();
            void createSession();
          }}
        >
          <header className={styles.createSessionHeading}>
            <span className={styles.iconWell}>
              <Icon name="spark" size={17} />
            </span>
            <div>
              <strong>{t("ontocode.hub.createHeading")}</strong>
              <span>{t("ontocode.hub.createSubheading")}</span>
            </div>
          </header>

          {creationBlockers.length > 0 ? (
            <div className={styles.creationBlocker} role="alert">
              <span className={styles.warningWell}>
                <Icon name="alert" size={15} />
              </span>
              <div>
                <strong>
                  {t("ontocode.hub.blockers", {
                    count: creationBlockers.length,
                  })}
                </strong>
                <ul>
                  {creationBlockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
                <div className={styles.blockerLinks}>
                  {!selectedOntology &&
                  resolvedReadiness.ontologySettingsHref ? (
                    <Link href={resolvedReadiness.ontologySettingsHref}>
                      {t("ontocode.hub.connectOntology")}
                      <Icon name="external" size={12} />
                    </Link>
                  ) : null}
                  {!resolvedReadiness.gatewayConfigured &&
                  resolvedReadiness.gatewaySettingsHref ? (
                    <Link href={resolvedReadiness.gatewaySettingsHref}>
                      {t("ontocode.hub.configureGateway")}
                      <Icon name="external" size={12} />
                    </Link>
                  ) : null}
                  {selectedOntology?.runtimeExecutable === false &&
                  resolvedReadiness.runtimeProfileSettingsHref ? (
                    <Link href={resolvedReadiness.runtimeProfileSettingsHref}>
                      {t("ontocode.hub.configureRuntimeProfile")}
                      <Icon name="external" size={12} />
                    </Link>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          <div className={styles.createLockedContext}>
            <div>
              <span>{t("ontocode.hub.businessDomainFixed")}</span>
              <strong>{tenant?.name ?? t("ontocode.hub.unavailable")}</strong>
              <small>{tenant?.slug ?? tenant?.id ?? "—"}</small>
            </div>
            <Icon name="chevron-right" size={14} />
            <label className={styles.createDomainSelector}>
              <span>{t("ontocode.hub.chooseOntologyDomain")}</span>
              <select
                value={selectedRegistrationId}
                onChange={(event) =>
                  selectOntologyDomain(event.currentTarget.value)
                }
                disabled={registeredDomains.length === 0 || submitting}
              >
                {registeredDomains.length === 0 ? (
                  <option value="">{t("ontocode.hub.notConnected")}</option>
                ) : null}
                {registeredDomains.map((domain) => (
                  <option
                    key={domain.registrationId}
                    value={domain.registrationId}
                  >
                    {domain.name} · {domain.id}
                    {domain.isDefault
                      ? ` · ${t("ontocode.hub.defaultDomain")}`
                      : ""}
                    {domain.runtimeExecutable === false
                      ? ` · ${t("ontocode.hub.runtimeBlocked")}`
                      : ""}
                  </option>
                ))}
              </select>
              <small>
                {selectedOntology
                  ? `${selectedOntology.source} · ${selectedOntology.registrationId}${
                      selectedOntology.runtimeProfileLabel
                        ? ` · ${selectedOntology.runtimeProfileLabel}`
                        : ""
                    }`
                  : "—"}
              </small>
              {selectedOntology?.runtimeExecutable === false ? (
                <small role="alert">
                  {selectedOntology.runtimeReadinessMessage ??
                    t("ontocode.hub.runtimeBlocked")}
                </small>
              ) : null}
              {selectedOntology && selectedActionsState !== "ready" ? (
                <small
                  role={selectedActionsState === "error" ? "alert" : "status"}
                >
                  {selectedActionsState === "loading"
                    ? language === "zh"
                      ? "正在从精确来源读取 Actions…"
                      : "Loading Actions from the exact source…"
                    : language === "zh"
                      ? "精确 Actions 读取失败；指定 Actions 暂不可用"
                      : "Exact Actions failed to load; selected Actions are unavailable"}
                </small>
              ) : null}
            </label>
            <Icon name="chevron-right" size={14} />
            <div>
              <span>{t("ontocode.hub.sessionIndependent")}</span>
              <strong>{t("ontocode.hub.independentDetail")}</strong>
              <small>Snapshot pinned at Session creation</small>
            </div>
          </div>
          <p className={styles.createDomainPolicy}>
            <Icon name="library" size={12} />
            {t("ontocode.hub.domainPolicy")}
          </p>

          <label className={styles.intentField}>
            <span>
              <Icon name="spark" size={13} />
              {t("ontocode.hub.intentLabel")}
            </span>
            <textarea
              value={goal}
              onChange={(event) => {
                setGoal(event.target.value);
                setGoalManaged(false);
              }}
              placeholder={t("ontocode.hub.intentPlaceholder")}
              rows={4}
              maxLength={20_000}
              autoFocus
            />
          </label>

          <fieldset className={styles.autonomyFieldset}>
            <legend>{t("ontocode.hub.autonomy.legend")}</legend>
            <div className={styles.autonomyGrid}>
              {AUTONOMY_MODES.map((mode) => (
                <button
                  type="button"
                  key={mode.id}
                  className={
                    autonomyMode === mode.id
                      ? styles.autonomyOptionActive
                      : styles.autonomyOption
                  }
                  onClick={() => setAutonomyMode(mode.id)}
                  aria-pressed={autonomyMode === mode.id}
                >
                  <strong>{t(mode.titleKey)}</strong>
                  <small>{t(mode.descriptionKey)}</small>
                </button>
              ))}
            </div>
            <p>{t("ontocode.hub.autonomy.productionGate")}</p>
          </fieldset>

          <details className={styles.createAdvanced}>
            <summary>
              <Icon name="settings" size={13} />
              {t("ontocode.hub.advanced")}
            </summary>
            <div>
              <fieldset className={styles.scopeStarterFieldset}>
                <legend>{t("ontocode.hub.scopeLegend")}</legend>
                <div className={styles.scopeStarterGrid}>
                  {SCOPE_STARTERS.map((starter) => {
                    const unavailable =
                      starter.id === "selected_actions" &&
                      (selectedActionsState !== "ready" ||
                        actionsForSelectedOntology.length === 0);
                    return (
                      <button
                        type="button"
                        key={starter.id}
                        className={
                          scopeMode === starter.id
                            ? styles.scopeStarterActive
                            : styles.scopeStarter
                        }
                        onClick={() => selectScopeMode(starter.id)}
                        disabled={unavailable}
                        aria-pressed={scopeMode === starter.id}
                      >
                        <span className={styles.scopeStarterTop}>
                          <span>{starter.step}</span>
                          <Icon name={starter.icon} size={16} />
                        </span>
                        <strong>{t(starter.titleKey)}</strong>
                        <small>{t(starter.descriptionKey)}</small>
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              {scopeMode === "selected_actions" ? (
                <fieldset className={styles.actionPicker}>
                  <legend>
                    Ontology Actions
                    <span>
                      {t("ontocode.hub.selectedActions", {
                        selected: selectedActionIds.length,
                        total: actionsForSelectedOntology.length,
                      })}
                    </span>
                  </legend>
                  {actionsForSelectedOntology.length > 0 ? (
                    <div className={styles.actionPickerGrid}>
                      {actionsForSelectedOntology.map((action) => (
                        <label key={action.id} className={styles.actionOption}>
                          <input
                            type="checkbox"
                            checked={selectedActionIds.includes(action.id)}
                            onChange={() => toggleAction(action.id)}
                          />
                          <span>
                            <strong>{action.name}</strong>
                            <small>{action.id}</small>
                            {action.description ? (
                              <p>{action.description}</p>
                            ) : null}
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.actionPickerEmpty}>
                      {t("ontocode.hub.noActions")}
                    </div>
                  )}
                </fieldset>
              ) : null}

              <label className={styles.advancedNameField}>
                {t("ontocode.hub.sessionName")}
                <input
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setTitleManaged(false);
                  }}
                  placeholder={
                    selectedOntology
                      ? `${selectedOntology.name} · Agent build`
                      : t("ontocode.hub.noOntology")
                  }
                  maxLength={200}
                />
              </label>
            </div>
          </details>

          <footer className={styles.createSessionFooter}>
            <div>
              <strong>{t("ontocode.hub.createHelpTitle")}</strong>
              <span>{t("ontocode.hub.createHelpDetail")}</span>
              {createError ? (
                <small className={styles.createError} role="alert">
                  {createError}
                </small>
              ) : formBlocker ? (
                <small>{formBlocker}</small>
              ) : null}
            </div>
            <button
              type="submit"
              className={styles.primaryButton}
              disabled={!canSubmit}
            >
              {submitting
                ? t("ontocode.hub.creating")
                : t("ontocode.hub.createSubmit")}
              <Icon name="chevron-right" size={14} />
            </button>
          </footer>
        </form>
      ) : null}

      <div className={styles.hubToolbar}>
        <div className={styles.searchBox}>
          <Icon name="search" size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("ontocode.hub.searchPlaceholder")}
            aria-label={t("ontocode.hub.searchAria")}
          />
        </div>
        <div
          className={styles.filterRow}
          aria-label={t("ontocode.hub.filterAria")}
        >
          {STATUS_FILTERS.map((filter) => (
            <button
              type="button"
              key={filter.id}
              className={
                status === filter.id ? styles.filterActive : styles.filterButton
              }
              onClick={() => setStatus(filter.id)}
            >
              {t(filter.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.sessionGrid}>
        {sessions.map((session) => (
          <Link
            href={sessionHref(session.id)}
            className={styles.sessionCard}
            key={session.id}
            onClick={(event) => {
              if (!onOpenSession) return;
              event.preventDefault();
              onOpenSession(session);
            }}
          >
            <div className={styles.sessionCardTop}>
              <span
                className={`${styles.sessionStatus} ${
                  session.status === "needs_action" ? styles.statusWarning : ""
                }`}
              >
                <Icon name={SESSION_STATUS_ICONS[session.status]} size={13} />
                {session.statusLabel}
              </span>
              <span className={styles.updated}>{session.updatedLabel}</span>
            </div>
            <h2>{session.title}</h2>
            <p>{session.goal}</p>
            <div className={styles.sessionMeta}>
              <span>{session.domain}</span>
              <span>{session.ontology}</span>
              <span>{session.id.toUpperCase()}</span>
            </div>
            <div className={styles.progressHeader}>
              <span>{PHASE_LABELS[session.phase]}</span>
              <strong>{session.progress}%</strong>
            </div>
            <div
              className={styles.progressTrack}
              aria-label={`${session.progress}%`}
            >
              <span style={{ width: `${session.progress}%` }} />
            </div>
            <footer>
              <span>
                <Icon name="agent" size={13} />
                {session.agents} Agents
              </span>
              <span>
                <Icon name="task" size={13} />
                {session.testSummary}
              </span>
              <span className={styles.openSession}>
                {t("ontocode.hub.open")}
                <Icon name="chevron-right" size={13} />
              </span>
            </footer>
          </Link>
        ))}
      </div>

      {sessions.length === 0 ? (
        <div className={styles.emptySessions}>
          <Icon name={selectedOntology ? "workflow" : "alert"} size={22} />
          <strong>
            {selectedOntology
              ? t("ontocode.hub.emptyTitle")
              : t("ontocode.hub.blockedEmptyTitle")}
          </strong>
          <span>
            {selectedOntology
              ? t("ontocode.hub.emptyDetail")
              : t("ontocode.hub.blockedEmptyDetail")}
          </span>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => {
              if (!creating) openCreation();
            }}
          >
            {t("ontocode.hub.inspectReadiness")}
            <Icon name="chevron-right" size={13} />
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ReadinessItem({
  label,
  value,
  state,
  href,
  actionLabel,
}: {
  label: string;
  value: string;
  state: "ready" | "blocked" | "neutral";
  href?: string;
  actionLabel: string;
}) {
  return (
    <div className={styles.readinessItem} data-state={state}>
      <span className={styles.readinessDot}>
        <Icon
          name={
            state === "ready" ? "check" : state === "blocked" ? "alert" : "dot"
          }
          size={12}
        />
      </span>
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
      </span>
      {href ? (
        <Link href={href}>
          {actionLabel}
          <Icon name="chevron-right" size={11} />
        </Link>
      ) : null}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  icon,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  icon: "replay" | "alert" | "logs" | "deploy";
  tone?: "warning" | "success";
}) {
  return (
    <article className={styles.metricCard} data-tone={tone}>
      <span className={styles.metricIcon}>
        <Icon name={icon} size={16} />
      </span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}
