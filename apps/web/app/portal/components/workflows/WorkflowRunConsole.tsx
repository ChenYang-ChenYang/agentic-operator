"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { normalizeWorkflowManifest } from "@agentic/contracts";
import type {
  WorkflowRunEntrypoint,
  WorkflowRunInputDescriptor,
  WorkflowRunToolPolicy,
  WorkflowTestAgentRun,
  WorkflowTestRunResponse,
} from "@agentic/contracts";
import { Badge, Button, Icon, ModalOverlay } from "@/app/portal/components";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useI18n, type Translate } from "@/app/portal/lib/preferences-context";
import {
  runStatusLabel,
  workflowTestStatusLabel,
} from "@/app/portal/lib/protocol-labels";
import { useEventCausality, useEmitEvent } from "@/lib/hooks/useEvents";
import {
  formatWorkflowAuthoringError,
  useRunWorkflowTest,
  useWorkflowRunProfile,
} from "@/lib/hooks/useWorkflowAuthoring";
import {
  buildWorkflowPayloadGuide,
  buildWorkflowEventPayload,
  deriveWorkflowEntrypoints,
  parseWorkflowTestLimits,
  seedWorkflowInputValue,
  validateWorkflowInputValues,
  workflowInputControl,
  workflowInputDisplayExample,
  workflowInputIsRuntimeProvided,
  type WorkflowPayloadGuide,
} from "./workflow-runner";
import {
  chatCapableEntrypoint,
  chatIsDefault,
  hasIncompleteCascade,
  historyForNextTurn,
  replyBubblesFromRun,
  type WorkflowChatBubble,
  type WorkflowChatTurn,
} from "./workflow-chat";
import { WorkflowChatPanel } from "./WorkflowChatPanel";
import styles from "./WorkflowRunConsole.module.css";

type RunTarget = "draft" | "live";
type RunMode = "chat" | "payload";
type ResultTab = "summary" | "agents" | "events" | "json";

export interface WorkflowRunConsoleProps {
  workflowSlug: string;
  workflowName: string;
  manifest: unknown;
  currentVersion: string;
  liveVersionId: string | null;
  onClose: () => void;
}

interface LiveReceipt {
  eventId: string;
  eventName: string;
  submittedAt: number;
}

interface WorkflowRunFileValue {
  name: string;
  type: string;
  size: number;
  dataUrl: string;
}

const TERMINAL_RUN_STATUSES = new Set([
  "ok",
  "failed",
  "cancelled",
  "timed_out",
]);

function defaultSubject(): string {
  const random = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0")
    .toUpperCase();
  return `WFT-${random}`;
}

function inputValueForForm(
  input: WorkflowRunInputDescriptor,
  value: unknown,
): unknown {
  const control = workflowInputControl(input);
  if (control === "json") return JSON.stringify(value, null, 2);
  if (control === "number") {
    return value === "" ? "" : String(value);
  }
  return value;
}

function inputSeedForForm(input: WorkflowRunInputDescriptor): unknown {
  return inputValueForForm(input, seedWorkflowInputValue(input));
}

function compactExample(
  value: unknown,
  maxLength = 150,
  notSupplied = "not supplied",
): string {
  if (value === undefined) return notSupplied;
  const serialized = JSON.stringify(value);
  if (!serialized) return String(value);
  return serialized.length > maxLength
    ? `${serialized.slice(0, maxLength - 1)}…`
    : serialized;
}

function coerceInputValue(
  input: WorkflowRunInputDescriptor,
  value: unknown,
  t?: Translate,
): unknown {
  const control = workflowInputControl(input);
  if (control === "json") {
    if (typeof value !== "string") return value;
    try {
      return value.trim() ? JSON.parse(value) : null;
    } catch (error) {
      throw new Error(
        t?.("workflowRunConsole.errorValidJson", {
          label: input.label,
          error: error instanceof Error ? error.message : String(error),
        }) ??
          `${input.label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (control === "number") {
    if (value === "") return undefined;
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new Error(
        t?.("workflowRunConsole.errorNumber", { label: input.label }) ??
          `${input.label} must be a number.`,
      );
    }
    const schema = input.schema as Record<string, unknown>;
    if (schema.type === "integer" && !Number.isInteger(number)) {
      throw new Error(
        t?.("workflowRunConsole.errorInteger", { label: input.label }) ??
          `${input.label} must be a whole number.`,
      );
    }
    return number;
  }
  return value;
}

function statusTone(
  status: string,
): "green" | "red" | "amber" | "blue" | "muted" {
  if (status === "ok") return "green";
  if (status === "failed" || status === "blocked") return "red";
  if (status === "partial" || status === "running") return "amber";
  if (status === "queued") return "blue";
  return "muted";
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function mediaTypeAllowed(contentType: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.some((candidate) =>
    candidate.endsWith("/*")
      ? contentType.startsWith(candidate.slice(0, -1))
      : candidate === contentType,
  );
}

function formatFileBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function exampleSourceLabel(
  source: WorkflowPayloadGuide["fields"][number]["exampleSource"],
  t: Translate,
): string {
  return {
    "authored example": t("workflowRunConsole.sourceAuthoredExample"),
    "authored default": t("workflowRunConsole.sourceAuthoredDefault"),
    "schema generated": t("workflowRunConsole.sourceSchemaGenerated"),
    "binding generated": t("workflowRunConsole.sourceBindingGenerated"),
  }[source];
}

function readRunFile(file: File, t?: Translate): Promise<WorkflowRunFileValue> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(
        new Error(
          t?.("workflowRunConsole.couldNotReadFile", { name: file.name }) ??
            `Could not read ${file.name}.`,
        ),
      );
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(
          new Error(
            t?.("workflowRunConsole.couldNotEncodeFile", {
              name: file.name,
            }) ?? `Could not encode ${file.name}.`,
          ),
        );
        return;
      }
      const encodedType = reader.result.match(/^data:([^;,]+)/)?.[1];
      resolve({
        name: file.name,
        type: file.type || encodedType || "application/octet-stream",
        size: file.size,
        dataUrl: reader.result,
      });
    };
    reader.readAsDataURL(file);
  });
}

export function WorkflowRunConsole({
  workflowSlug,
  workflowName,
  manifest,
  currentVersion,
  liveVersionId,
  onClose,
}: WorkflowRunConsoleProps) {
  const { t } = useI18n();
  const tenant = useTenant();
  const router = useRouter();
  const draftProfile = useMemo(
    () => deriveWorkflowEntrypoints(manifest, t),
    [manifest, t],
  );
  const [target, setTarget] = useState<RunTarget>("draft");
  const liveProfile = useWorkflowRunProfile(
    workflowSlug,
    "live",
    target === "live" && Boolean(liveVersionId),
  );
  const runTest = useRunWorkflowTest(workflowSlug);
  const emitLive = useEmitEvent();
  const [selectedEvent, setSelectedEvent] = useState("");
  const [subject, setSubject] = useState(defaultSubject);
  const [inputValues, setInputValues] = useState<Record<string, unknown>>({});
  const [rawPayload, setRawPayload] = useState("{}");
  const [showRawPayload, setShowRawPayload] = useState(false);
  const [toolPolicy, setToolPolicy] = useState<WorkflowRunToolPolicy>("safe");
  const [confirmLiveEffects, setConfirmLiveEffects] = useState(false);
  const [failurePolicy, setFailurePolicy] = useState<"continue" | "fail_fast">(
    "continue",
  );
  const [humanDecision, setHumanDecision] = useState<
    "approve" | "reject" | "supplement"
  >("approve");
  const [maxAgentRuns, setMaxAgentRuns] = useState("25");
  const [maxEvents, setMaxEvents] = useState("75");
  const [maxDepth, setMaxDepth] = useState("12");
  const [confirmLiveDispatch, setConfirmLiveDispatch] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<WorkflowTestRunResponse | null>(null);
  const [liveReceipt, setLiveReceipt] = useState<LiveReceipt | null>(null);
  const [resultTab, setResultTab] = useState<ResultTab>("summary");
  const [selectedAgentRunId, setSelectedAgentRunId] = useState<string | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [payloadExampleStatus, setPayloadExampleStatus] = useState<
    "loaded" | "copied" | null
  >(null);
  const causality = useEventCausality(liveReceipt?.eventId);

  // ─── Chat mode ────────────────────────────────────────────────────────────
  const [chatTurns, setChatTurns] = useState<WorkflowChatTurn[]>([]);
  const [chatBubbles, setChatBubbles] = useState<WorkflowChatBubble[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatCascadeWarning, setChatCascadeWarning] = useState(false);
  const [mode, setMode] = useState<RunMode | null>(null);

  const entrypoints =
    target === "draft"
      ? draftProfile.entrypoints
      : (liveProfile.data?.entrypoints ?? []);
  const profileWarnings =
    target === "draft"
      ? draftProfile.warnings
      : (liveProfile.data?.warnings ?? []);
  const entrypoint = entrypoints.find(
    (candidate) => candidate.event === selectedEvent,
  );
  const payloadGuide = useMemo(
    () => (entrypoint ? buildWorkflowPayloadGuide(entrypoint, t) : null),
    [entrypoint, t],
  );
  const selectedAgentRun =
    result?.agentRuns.find((run) => run.id === selectedAgentRunId) ??
    result?.agentRuns[0] ??
    null;

  const manifestAgents = useMemo(() => {
    try {
      return normalizeWorkflowManifest(manifest).agents;
    } catch {
      return [];
    }
  }, [manifest]);
  const chatEntrypoint = useMemo(
    () => chatCapableEntrypoint(entrypoints),
    [entrypoints],
  );
  // Chat needs a reply to render, and the live path returns an event id rather
  // than an answer — so it is a draft-only affordance.
  const chatAvailable = target === "draft" && chatEntrypoint !== null;
  const effectiveMode: RunMode =
    mode ??
    (chatAvailable && chatIsDefault(manifestAgents, chatEntrypoint)
      ? "chat"
      : "payload");

  useEffect(() => {
    if (!chatAvailable && effectiveMode === "chat") setMode("payload");
  }, [chatAvailable, effectiveMode]);

  useEffect(() => {
    const first =
      entrypoints.find((candidate) => candidate.recommended) ?? entrypoints[0];
    if (!entrypoints.some((candidate) => candidate.event === selectedEvent)) {
      setSelectedEvent(first?.event ?? "");
    }
  }, [entrypoints, selectedEvent]);

  useEffect(() => {
    if (!entrypoint) {
      setInputValues({});
      return;
    }
    setInputValues(
      Object.fromEntries(
        entrypoint.inputs
          .filter((input) => !workflowInputIsRuntimeProvided(input))
          .map((input) => [input.id, inputSeedForForm(input)]),
      ),
    );
    setRawPayload("{}");
    setShowRawPayload(entrypoint.requiresRawPayload);
    setFormError(null);
    setPayloadExampleStatus(null);
  }, [entrypoint?.event]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setResult(null);
    setLiveReceipt(null);
    setResultTab("summary");
    setSelectedAgentRunId(null);
    setFormError(null);
    setPayloadExampleStatus(null);
  }, [target]);

  const liveRuns = causality.data?.runs ?? [];
  const liveRunTerminal =
    liveRuns.length > 0 &&
    liveRuns.every((run) => TERMINAL_RUN_STATUSES.has(run.status));
  const pending = runTest.isPending || emitLive.isPending;

  function showPayloadExampleStatus(status: "loaded" | "copied") {
    setPayloadExampleStatus(status);
    window.setTimeout(() => setPayloadExampleStatus(null), 1_800);
  }

  function loadPayloadExample() {
    if (!entrypoint || !payloadGuide) return;
    setInputValues(
      Object.fromEntries(
        entrypoint.inputs.map((input) => {
          if (workflowInputIsRuntimeProvided(input)) {
            return [input.id, undefined];
          }
          const example = payloadGuide.inputValues[input.id];
          return [
            input.id,
            example === undefined
              ? inputSeedForForm(input)
              : inputValueForForm(input, example),
          ];
        }),
      ),
    );
    setRawPayload(JSON.stringify(payloadGuide.rawPayload, null, 2));
    if (
      entrypoint.requiresRawPayload ||
      Object.keys(payloadGuide.rawPayload).length > 0
    ) {
      setShowRawPayload(true);
    }
    setFormError(null);
    showPayloadExampleStatus("loaded");
  }

  async function copyPayloadExample() {
    if (!payloadGuide) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(payloadGuide.eventPayload, null, 2),
      );
      showPayloadExampleStatus("copied");
    } catch (error) {
      setFormError(
        t("workflowRunConsole.copyExampleFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  function buildSubmission(): {
    inputs: Record<string, unknown>;
    payload: Record<string, unknown>;
  } {
    const errors = validateWorkflowInputValues(
      entrypoint,
      inputValues,
      t,
      false,
    );
    if (errors.length > 0) throw new Error(errors[0]);
    const inputs: Record<string, unknown> = {};
    for (const input of entrypoint?.inputs ?? []) {
      const value = coerceInputValue(input, inputValues[input.id], t);
      if (value !== undefined && value !== "") inputs[input.id] = value;
    }
    let payload: unknown;
    try {
      payload = rawPayload.trim() ? JSON.parse(rawPayload) : {};
    } catch (error) {
      throw new Error(
        t("workflowRunConsole.rawPayloadValidJson", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(t("workflowRunConsole.rawPayloadObject"));
    }
    return {
      inputs,
      payload: payload as Record<string, unknown>,
    };
  }

  /**
   * One chat turn = one draft test run. The prior turns go along for the ride
   * because the draft runner is stateless; the server re-bounds them.
   */
  async function sendChatTurn() {
    const text = chatDraft.trim();
    if (!text || !chatEntrypoint) return;
    setChatError(null);
    setChatCascadeWarning(false);
    const priorTurns = chatTurns;
    setChatDraft("");
    setChatBubbles((current) => [
      ...current,
      { role: "user", content: text },
    ]);
    try {
      const response = await runTest.mutateAsync({
        manifest,
        triggerEvent: chatEntrypoint.event,
        subject: subject.trim() || undefined,
        inputs: { prompt: text },
        payload: {},
        toolPolicy: "safe",
        confirmLiveEffects: false,
        failurePolicy: "continue",
        humanDecision: "approve",
        limits: parseWorkflowTestLimits(
          { maxAgentRuns, maxEvents, maxDepth },
          t,
        ),
        conversationHistory: historyForNextTurn([
          ...priorTurns,
          { role: "user", content: text },
        ]),
      });
      const replies = replyBubblesFromRun(response, manifestAgents);
      setChatBubbles((current) => [...current, ...replies]);
      setChatTurns([
        ...priorTurns,
        { role: "user", content: text },
        ...replies.map((reply) => ({
          role: "assistant" as const,
          content: reply.content,
        })),
      ]);
      setChatCascadeWarning(hasIncompleteCascade(response, manifestAgents));
      // Keep the full trace available under the Payload tab's result panes.
      setResult(response);
      setSelectedAgentRunId(response.agentRuns[0]?.id ?? null);
    } catch (error) {
      setChatError(
        formatWorkflowAuthoringError(error, t),
      );
    }
  }

  async function execute() {
    setFormError(null);
    setCopied(false);
    if (!entrypoint) {
      setFormError(t("workflowRunConsole.selectEntryEvent"));
      return;
    }
    try {
      const submission = buildSubmission();
      if (target === "draft") {
        const limits = parseWorkflowTestLimits(
          {
            maxAgentRuns,
            maxEvents,
            maxDepth,
          },
          t,
        );
        const response = await runTest.mutateAsync({
          manifest,
          triggerEvent: entrypoint.event,
          subject: subject.trim() || undefined,
          inputs: submission.inputs,
          payload: submission.payload,
          toolPolicy,
          confirmLiveEffects,
          failurePolicy,
          humanDecision,
          limits,
          // The payload form is a one-shot run; chat continuity lives in the
          // chat composer, which sends its own transcript.
          conversationHistory: [],
        });
        setResult(response);
        setSelectedAgentRunId(response.agentRuns[0]?.id ?? null);
        setResultTab("summary");
        return;
      }

      if (!confirmLiveDispatch) {
        throw new Error(t("workflowRunConsole.confirmPublishedStart"));
      }
      const response = await emitLive.mutateAsync({
        name: entrypoint.event,
        subject: subject.trim() || undefined,
        payload: buildWorkflowEventPayload(
          submission.inputs,
          submission.payload,
        ),
        source: "operator",
      });
      setLiveReceipt({
        eventId: response.event_id,
        eventName: response.name,
        submittedAt: Date.now(),
      });
      setResultTab("summary");
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : t("workflowRunConsole.executionFailed"),
      );
    }
  }

  async function copyReport() {
    const value =
      target === "draft"
        ? result
        : {
            receipt: liveReceipt,
            causality: causality.data ?? null,
          };
    if (!value) return;
    await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  function requestClose() {
    if (pending) return;
    onClose();
  }

  return (
    <ModalOverlay
      onClose={requestClose}
      ariaLabel={t("workflowRunConsole.runWorkflowAria", {
        name: workflowName,
      })}
    >
      <div className={styles.console} style={consoleStyle}>
        <header className={styles.header} style={headerStyle}>
          <div style={{ minWidth: 0 }}>
            <div style={eyebrowStyle}>{t("workflowRunConsole.operations")}</div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <h2 style={titleStyle}>
                {t("workflowRunConsole.runTitle", { name: workflowName })}
              </h2>
              <Badge tone={target === "draft" ? "amber" : "green"}>
                {target === "draft"
                  ? t("workflowRunConsole.currentDraftBadge")
                  : t("workflowRunConsole.publishedLiveBadge")}
              </Badge>
            </div>
            <p style={subtitleStyle}>{t("workflowRunConsole.subtitle")}</p>
            {chatAvailable ? (
              <div
                role="tablist"
                aria-label={t("workflowRunConsole.modeAria")}
                style={{ display: "flex", gap: 4, marginTop: 10 }}
              >
                <ModeButton
                  selected={effectiveMode === "chat"}
                  onClick={() => setMode("chat")}
                  label={t("workflowRunConsole.modeChat")}
                />
                <ModeButton
                  selected={effectiveMode === "payload"}
                  onClick={() => {
                    // Show the mechanism rather than hiding it: whatever is in
                    // the composer becomes the prompt input on the form.
                    if (chatDraft.trim()) {
                      setInputValues((current) => ({
                        ...current,
                        prompt: chatDraft.trim(),
                      }));
                    }
                    setMode("payload");
                  }}
                  label={t("workflowRunConsole.modePayload")}
                />
              </div>
            ) : null}
          </div>
          <Button
            icon="x"
            tone="ghost"
            ariaLabel={t("workflowRunConsole.closeAria")}
            onClick={requestClose}
            disabled={pending}
          />
        </header>

        {effectiveMode === "chat" && chatEntrypoint ? (
          <WorkflowChatPanel
            entrypoint={chatEntrypoint}
            bubbles={chatBubbles}
            pending={pending}
            error={chatError}
            incompleteCascade={chatCascadeWarning}
            draft={chatDraft}
            onDraftChange={setChatDraft}
            onSend={() => void sendChatTurn()}
          />
        ) : (
          <>
        <div className={styles.body} style={bodyStyle}>
          <aside className={styles.setup} style={setupStyle}>
            <SetupSection
              number="01"
              title={t("workflowRunConsole.executionTarget")}
              hint={t("workflowRunConsole.executionTargetHint")}
            >
              <div className={styles.segmented} style={segmentedStyle}>
                <TargetButton
                  selected={target === "draft"}
                  onClick={() => setTarget("draft")}
                  title={t("workflowRunConsole.currentDraftTest")}
                  detail={currentVersion}
                />
                <TargetButton
                  selected={target === "live"}
                  disabled={!liveVersionId}
                  onClick={() => setTarget("live")}
                  title={t("workflowRunConsole.publishedLive")}
                  detail={
                    liveVersionId
                      ? t("workflowRunConsole.durableExecution")
                      : t("workflowRunConsole.notPublished")
                  }
                />
              </div>
              {target === "live" && liveProfile.isError ? (
                <InlineNotice tone="red">
                  {formatWorkflowAuthoringError(liveProfile.error, t)}
                </InlineNotice>
              ) : null}
            </SetupSection>

            <SetupSection
              number="02"
              title={t("workflowRunConsole.entryEvent")}
              hint={t("workflowRunConsole.entryEventHint")}
            >
              <label style={fieldLabelStyle}>
                {t("workflowRunConsole.triggerEvent")}
                <select
                  style={controlStyle}
                  value={selectedEvent}
                  onChange={(event) => setSelectedEvent(event.target.value)}
                  disabled={
                    target === "live" &&
                    (liveProfile.isLoading || liveProfile.isError)
                  }
                >
                  {entrypoints.length === 0 ? (
                    <option value="">
                      {target === "live" && liveProfile.isLoading
                        ? t("workflowRunConsole.loadingEntrypoints")
                        : t("workflowRunConsole.noTriggerEvents")}
                    </option>
                  ) : null}
                  {entrypoints.some((item) => item.recommended) ? (
                    <optgroup
                      label={t("workflowRunConsole.recommendedEntrypoints")}
                    >
                      {entrypoints
                        .filter((item) => item.recommended)
                        .map((item) => (
                          <option key={item.event} value={item.event}>
                            {item.event} · {item.listenerAgentIds.length}{" "}
                            {t("workflowRunConsole.listenerCount", {
                              count: item.listenerAgentIds.length,
                            })}
                          </option>
                        ))}
                    </optgroup>
                  ) : null}
                  {entrypoints.some((item) => !item.recommended) ? (
                    <optgroup label={t("workflowRunConsole.internalEvents")}>
                      {entrypoints
                        .filter((item) => !item.recommended)
                        .map((item) => (
                          <option key={item.event} value={item.event}>
                            {item.event} · {t("workflowRunConsole.internal")}
                          </option>
                        ))}
                    </optgroup>
                  ) : null}
                </select>
              </label>
              {entrypoint ? (
                <div style={entrypointMetaStyle}>
                  <span>
                    {t("workflowRunConsole.starts")}{" "}
                    <strong style={{ color: "var(--text)" }}>
                      {entrypoint.listenerTitles.join(", ")}
                    </strong>
                  </span>
                  <span>
                    {t("workflowRunConsole.inputCount", {
                      count: entrypoint.inputs.length,
                    })}
                  </span>
                </div>
              ) : null}
              <label style={fieldLabelStyle}>
                {t("workflowRunConsole.subjectKey")}
                <input
                  style={controlStyle}
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  placeholder="WFT-…"
                />
              </label>
            </SetupSection>

            <SetupSection
              number="03"
              title={t("workflowRunConsole.inputVariables")}
              hint={t("workflowRunConsole.inputVariablesHint")}
            >
              {entrypoint && payloadGuide ? (
                <PayloadRecipe
                  entrypoint={entrypoint}
                  guide={payloadGuide}
                  status={payloadExampleStatus}
                  onLoad={loadPayloadExample}
                  onCopy={() => void copyPayloadExample()}
                />
              ) : null}
              {entrypoint?.inputs.length ? (
                <div style={{ display: "grid", gap: 11 }}>
                  {entrypoint.inputs.map((input) => (
                    <WorkflowInputField
                      key={input.id}
                      input={input}
                      value={inputValues[input.id]}
                      onChange={(value) => {
                        setPayloadExampleStatus(null);
                        setInputValues((current) => ({
                          ...current,
                          [input.id]: value,
                        }));
                      }}
                    />
                  ))}
                </div>
              ) : (
                <div style={emptyInputStyle}>
                  {t("workflowRunConsole.noNamedInputs")}
                </div>
              )}
              <button
                type="button"
                onClick={() => setShowRawPayload((current) => !current)}
                aria-expanded={showRawPayload}
                style={rawToggleStyle}
              >
                <span>{showRawPayload ? "▾" : "▸"}</span>
                {t("workflowRunConsole.rawEventPayload")}
                {entrypoint?.requiresRawPayload ? (
                  <Badge tone="amber">
                    {t("workflowRunConsole.bindingsDetected")}
                  </Badge>
                ) : null}
              </button>
              {showRawPayload ? (
                <div style={{ display: "grid", gap: 7 }}>
                  <div
                    id="workflow-raw-payload-help"
                    className={styles.rawPayloadHelp}
                  >
                    <strong>
                      {t("workflowRunConsole.advancedPayloadOverlay")}
                    </strong>
                    <span>
                      {t("workflowRunConsole.advancedPayloadBefore")}{" "}
                      <code>inputs</code>{" "}
                      {t("workflowRunConsole.advancedPayloadAfter")}
                    </span>
                  </div>
                  <textarea
                    aria-label={t("workflowRunConsole.rawPayloadAria")}
                    aria-describedby="workflow-raw-payload-help"
                    value={rawPayload}
                    onChange={(event) => {
                      setRawPayload(event.target.value);
                      setPayloadExampleStatus(null);
                    }}
                    rows={8}
                    spellCheck={false}
                    style={{ ...controlStyle, ...monoAreaStyle }}
                  />
                </div>
              ) : null}
            </SetupSection>

            {target === "draft" ? (
              <SetupSection
                number="04"
                title={t("workflowRunConsole.testPolicy")}
                hint={t("workflowRunConsole.testPolicyHint")}
              >
                <label style={fieldLabelStyle}>
                  {t("workflowRunConsole.toolEffects")}
                  <select
                    style={controlStyle}
                    value={toolPolicy}
                    onChange={(event) => {
                      setToolPolicy(
                        event.target.value as WorkflowRunToolPolicy,
                      );
                      setConfirmLiveEffects(false);
                    }}
                  >
                    <option value="safe">
                      {t("workflowRunConsole.toolSafe")}
                    </option>
                    <option value="simulate">
                      {t("workflowRunConsole.toolReadOnly")}
                    </option>
                    <option value="live">
                      {t("workflowRunConsole.toolLive")}
                    </option>
                  </select>
                </label>
                {toolPolicy === "live" ? (
                  <ConfirmRow
                    checked={confirmLiveEffects}
                    onChange={setConfirmLiveEffects}
                    tone="red"
                  >
                    {t("workflowRunConsole.confirmLiveEffects")}
                  </ConfirmRow>
                ) : null}
                <div className={styles.twoColumn} style={twoColumnStyle}>
                  <label style={fieldLabelStyle}>
                    {t("workflowRunConsole.failurePolicy")}
                    <select
                      style={controlStyle}
                      value={failurePolicy}
                      onChange={(event) =>
                        setFailurePolicy(
                          event.target.value as "continue" | "fail_fast",
                        )
                      }
                    >
                      <option value="continue">
                        {t("workflowRunConsole.continueBranches")}
                      </option>
                      <option value="fail_fast">
                        {t("workflowRunConsole.stopFirstFailure")}
                      </option>
                    </select>
                  </label>
                  <label style={fieldLabelStyle}>
                    {t("workflowRunConsole.humanDecision")}
                    <select
                      style={controlStyle}
                      value={humanDecision}
                      onChange={(event) =>
                        setHumanDecision(
                          event.target.value as
                            | "approve"
                            | "reject"
                            | "supplement",
                        )
                      }
                    >
                      <option value="approve">
                        {t("workflowRunConsole.approve")}
                      </option>
                      <option value="reject">
                        {t("workflowRunConsole.reject")}
                      </option>
                      <option value="supplement">
                        {t("workflowRunConsole.supplement")}
                      </option>
                    </select>
                  </label>
                </div>
                <div className={styles.threeColumn} style={threeColumnStyle}>
                  <BudgetField
                    label={t("workflowRunConsole.agentRuns")}
                    value={maxAgentRuns}
                    onChange={setMaxAgentRuns}
                  />
                  <BudgetField
                    label={t("workflowRunConsole.events")}
                    value={maxEvents}
                    onChange={setMaxEvents}
                  />
                  <BudgetField
                    label={t("workflowRunConsole.depth")}
                    value={maxDepth}
                    onChange={setMaxDepth}
                  />
                </div>
              </SetupSection>
            ) : (
              <SetupSection
                number="04"
                title={t("workflowRunConsole.productionConfirmation")}
                hint={t("workflowRunConsole.productionConfirmationHint")}
              >
                <ConfirmRow
                  checked={confirmLiveDispatch}
                  onChange={setConfirmLiveDispatch}
                  tone="amber"
                >
                  {t("workflowRunConsole.startPublishedConfirm")}
                </ConfirmRow>
              </SetupSection>
            )}

            {profileWarnings.length > 0 ? (
              <div style={{ display: "grid", gap: 6 }}>
                {profileWarnings.map((warning) => (
                  <InlineNotice key={warning} tone="amber">
                    {warning}
                  </InlineNotice>
                ))}
              </div>
            ) : null}
          </aside>

          <main className={styles.results} style={resultsStyle}>
            <div className={styles.resultsHeader} style={resultsHeaderStyle}>
              <div>
                <div style={eyebrowStyle}>
                  {t("workflowRunConsole.executionEvidence")}
                </div>
                <h3 style={{ ...titleStyle, fontSize: 17 }}>
                  {target === "draft"
                    ? result
                      ? t("workflowRunConsole.testResultId", {
                          id: result.runId,
                        })
                      : t("workflowRunConsole.draftTestResult")
                    : liveReceipt
                      ? t("workflowRunConsole.liveDispatchId", {
                          id: liveReceipt.eventId,
                        })
                      : t("workflowRunConsole.liveRunReceipt")}
                </h3>
              </div>
              <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                {target === "draft" && result ? (
                  <Badge tone={statusTone(result.status)}>
                    {workflowTestStatusLabel(t, result.status)}
                  </Badge>
                ) : null}
                {target === "live" && liveReceipt ? (
                  <Badge tone={liveRunTerminal ? "green" : "blue"}>
                    {liveRunTerminal
                      ? t("workflowRunConsole.terminalBadge")
                      : t("workflowRunConsole.trackingBadge")}
                  </Badge>
                ) : null}
                <Button
                  small
                  icon="code"
                  tone="ghost"
                  onClick={() => void copyReport()}
                  disabled={target === "draft" ? !result : !liveReceipt}
                >
                  {copied
                    ? t("workflowRunConsole.copied")
                    : t("workflowRunConsole.copyJson")}
                </Button>
              </div>
            </div>

            {(result || liveReceipt) && (
              <div role="tablist" style={tabsStyle}>
                {(
                  [
                    ["summary", t("workflowRunConsole.summary")],
                    ["agents", t("workflowRunConsole.agentTrace")],
                    ["events", t("workflowRunConsole.events")],
                    ["json", t("workflowRunConsole.rawJson")],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={resultTab === value}
                    onClick={() => setResultTab(value)}
                    style={tabStyle(resultTab === value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            <div style={resultContentStyle}>
              {!result && !liveReceipt ? (
                <EmptyEvidence target={target} />
              ) : target === "draft" && result ? (
                <DraftEvidence
                  result={result}
                  tab={resultTab}
                  selectedAgentRun={selectedAgentRun}
                  onSelectAgent={setSelectedAgentRunId}
                />
              ) : liveReceipt ? (
                <LiveEvidence
                  receipt={liveReceipt}
                  tab={resultTab}
                  loading={causality.isLoading}
                  error={causality.isError ? causality.error.message : null}
                  data={causality.data}
                  onOpenRun={(runId) =>
                    router.push(
                      `/portal/${tenant}/runs/${encodeURIComponent(runId)}` as never,
                    )
                  }
                />
              ) : null}
            </div>
          </main>
        </div>

        <footer className={styles.footer} style={footerStyle}>
          <div style={{ minWidth: 0 }}>
            {formError ? (
              <div role="alert" style={{ color: "var(--red)", fontSize: 12 }}>
                {formError}
              </div>
            ) : (
              <div style={{ color: "var(--text-3)", fontSize: 11.5 }}>
                {target === "draft"
                  ? t("workflowRunConsole.draftFooterHint")
                  : t("workflowRunConsole.liveFooterHint")}
              </div>
            )}
          </div>
          <div
            className={styles.footerActions}
            style={{ display: "flex", gap: 8 }}
          >
            <Button tone="ghost" onClick={requestClose} disabled={pending}>
              {t("workflowRunConsole.close")}
            </Button>
            <Button
              icon="run"
              tone="primary"
              onClick={() => void execute()}
              disabled={
                pending ||
                !entrypoint ||
                (target === "draft" &&
                  toolPolicy === "live" &&
                  !confirmLiveEffects) ||
                (target === "live" && (!liveVersionId || !confirmLiveDispatch))
              }
            >
              {pending
                ? target === "draft"
                  ? t("workflowRunConsole.runningDraft")
                  : t("workflowRunConsole.dispatching")
                : target === "draft"
                  ? t("workflowRunConsole.runDraftTest")
                  : t("workflowRunConsole.runPublished")}
            </Button>
          </div>
        </footer>
          </>
        )}
      </div>
    </ModalOverlay>
  );
}

function PayloadRecipe({
  entrypoint,
  guide,
  status,
  onLoad,
  onCopy,
}: {
  entrypoint: WorkflowRunEntrypoint;
  guide: WorkflowPayloadGuide;
  status: "loaded" | "copied" | null;
  onLoad: () => void;
  onCopy: () => void;
}) {
  const { t } = useI18n();
  const requiredCount = guide.fields.filter((field) => field.required).length;
  const hasFileInput = guide.fields.some((field) =>
    field.type.startsWith("file"),
  );
  const [contractOpen, setContractOpen] = useState(
    guide.fields.length > 0 && guide.fields.length <= 4,
  );

  useEffect(() => {
    setContractOpen(guide.fields.length > 0 && guide.fields.length <= 4);
  }, [entrypoint.event, guide.fields.length]);

  return (
    <div className={styles.payloadRecipe}>
      <div className={styles.payloadRecipeHeader}>
        <div style={{ minWidth: 0 }}>
          <div className={styles.payloadRecipeEyebrow}>
            <Icon name="code" size={11} />
            {t("workflowRunConsole.payloadRecipe")}
            <Badge tone="signal">{t("workflowRunConsole.schemaGuided")}</Badge>
          </div>
          <strong className={styles.payloadRecipeTitle}>
            {t("workflowRunConsole.examplePayload")}
          </strong>
          <p className={styles.payloadRecipeDescription}>
            {t("workflowRunConsole.examplePayloadBefore")}{" "}
            <code>{entrypoint.event}</code>.{" "}
            {t("workflowRunConsole.examplePayloadAfter")}
          </p>
        </div>
        <div className={styles.payloadRecipeCounts}>
          <span>
            {t("workflowRunConsole.fieldCount", {
              count: guide.fields.length,
            })}
          </span>
          <span>
            {t("workflowRunConsole.requiredCount", { count: requiredCount })}
          </span>
        </div>
      </div>

      <pre
        className={styles.payloadRecipeCode}
        aria-label={t("workflowRunConsole.examplePayloadAria", {
          event: entrypoint.event,
        })}
      >
        {JSON.stringify(guide.eventPayload, null, 2)}
      </pre>

      <div className={styles.payloadRecipeActions}>
        <Button
          small
          icon="replay"
          onClick={onLoad}
          title={t("workflowRunConsole.loadExampleTitle")}
        >
          {t("workflowRunConsole.loadExample")}
        </Button>
        <Button small tone="ghost" icon="code" onClick={onCopy}>
          {t("workflowRunConsole.copyJson")}
        </Button>
        <span
          className={styles.payloadRecipeStatus}
          role="status"
          aria-live="polite"
        >
          {status === "loaded"
            ? t("workflowRunConsole.exampleLoaded")
            : status === "copied"
              ? t("workflowRunConsole.exampleCopied")
              : ""}
        </span>
      </div>

      <details
        className={styles.payloadContract}
        open={contractOpen}
        onToggle={(event) => setContractOpen(event.currentTarget.open)}
      >
        <summary>
          {t("workflowRunConsole.expectedFields")}
          <span>{guide.fields.length}</span>
        </summary>
        {guide.fields.length > 0 ? (
          <div className={styles.payloadFieldList}>
            {guide.fields.map((field) => {
              return (
                <div key={field.inputId} className={styles.payloadField}>
                  <div className={styles.payloadFieldHeader}>
                    <strong>{field.label}</strong>
                    <code>{field.type}</code>
                    {field.runtimeProvided ? (
                      <Badge tone="blue">
                        {t("workflowRunConsole.derivedBadge")}
                      </Badge>
                    ) : field.required ? (
                      <Badge tone="amber">
                        {t("workflowRunConsole.requiredBadge")}
                      </Badge>
                    ) : (
                      <Badge tone="muted">
                        {t("workflowRunConsole.optionalBadge")}
                      </Badge>
                    )}
                    {field.sensitivity !== "none" ? (
                      <Badge tone="amber">
                        {field.sensitivity.toUpperCase()}
                      </Badge>
                    ) : null}
                  </div>
                  <div className={styles.payloadLocations}>
                    {field.locations.map((location) => (
                      <code key={location}>{location}</code>
                    ))}
                  </div>
                  {field.description ? <p>{field.description}</p> : null}
                  <div className={styles.payloadFieldExample}>
                    <span>
                      {field.runtimeProvided
                        ? t("workflowRunConsole.derivedExample")
                        : t("workflowRunConsole.example")}
                    </span>
                    <code>
                      {compactExample(
                        field.example,
                        150,
                        t("workflowRunConsole.notSupplied"),
                      )}
                    </code>
                    <span>{exampleSourceLabel(field.exampleSource, t)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className={styles.payloadContractEmpty}>
            {t("workflowRunConsole.noCallerFields")}
          </div>
        )}
      </details>

      <div className={styles.payloadRecipeNote}>
        {t("workflowRunConsole.recipeNoteBefore")} <code>inputs</code>{" "}
        {t("workflowRunConsole.recipeNoteAfter")}
        {hasFileInput ? t("workflowRunConsole.fileExampleNote") : ""}
      </div>
    </div>
  );
}

function WorkflowInputField({
  input,
  value,
  onChange,
}: {
  input: WorkflowRunInputDescriptor;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t } = useI18n();
  const control = workflowInputControl(input);
  const schema = input.schema as Record<string, unknown>;
  const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
  const example = workflowInputDisplayExample(input);
  const runtimeProvided = workflowInputIsRuntimeProvided(input);
  const FieldContainer = runtimeProvided ? "div" : "label";
  const [fileError, setFileError] = useState<string | null>(null);

  async function selectFiles(files: FileList | null) {
    setFileError(null);
    const selected = Array.from(files ?? []);
    if (selected.length === 0) {
      onChange(input.file?.multiple ? [] : null);
      return;
    }
    const allowedTypes = input.file?.media_types ?? [];
    const maxBytes = input.file?.max_bytes;
    for (const file of selected) {
      const contentType = file.type || "application/octet-stream";
      if (!mediaTypeAllowed(contentType, allowedTypes)) {
        setFileError(
          t("workflowRunConsole.fileTypeError", {
            name: file.name,
            type: contentType,
            allowed: allowedTypes.join(", "),
          }),
        );
        return;
      }
      if (maxBytes && file.size > maxBytes) {
        setFileError(
          t("workflowRunConsole.fileSizeError", {
            name: file.name,
            size: formatFileBytes(file.size),
            max: formatFileBytes(maxBytes),
          }),
        );
        return;
      }
    }
    try {
      const encoded = await Promise.all(
        selected.map((file) => readRunFile(file, t)),
      );
      onChange(input.file?.multiple ? encoded : (encoded[0] ?? null));
    } catch (error) {
      setFileError(
        error instanceof Error
          ? error.message
          : t("workflowRunConsole.couldNotReadGeneric"),
      );
    }
  }

  return (
    <FieldContainer style={fieldLabelStyle}>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        {input.label}
        {runtimeProvided ? (
          <Badge tone="blue">{t("workflowRunConsole.derivedBadge")}</Badge>
        ) : input.required ? (
          <span style={{ color: "var(--amber)" }}>*</span>
        ) : null}
        <Badge tone="muted">{input.kind.toUpperCase()}</Badge>
        {input.sensitivity !== "none" ? (
          <Badge tone="amber">{input.sensitivity.toUpperCase()}</Badge>
        ) : null}
        {input.conflict ? (
          <Badge tone="red">{t("workflowRunConsole.schemaConflict")}</Badge>
        ) : null}
      </span>
      {input.description ? (
        <span style={fieldHintStyle}>{input.description}</span>
      ) : null}
      {runtimeProvided ? (
        <div className={styles.runtimeInputNotice}>
          <strong>{t("workflowRunConsole.noValueToEnter")}</strong>
          <span>
            {t("workflowRunConsole.runtimeDerivesFrom")}{" "}
            {input.bindings
              .map((binding) =>
                binding.mode === "template"
                  ? binding.expression
                  : t("workflowRunConsole.authoredConstant"),
              )
              .join(" · ")}
          </span>
        </div>
      ) : control === "textarea" ? (
        <textarea
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
          rows={4}
          placeholder={input.ui?.placeholder}
          style={{ ...controlStyle, resize: "vertical" }}
        />
      ) : control === "select" ? (
        <select
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
          style={controlStyle}
        >
          {!input.required ? (
            <option value="">— {t("workflowRunConsole.notSupplied")} —</option>
          ) : null}
          {enumValues.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      ) : control === "checkbox" ? (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
          style={{ justifySelf: "start" }}
        />
      ) : control === "json" ? (
        <textarea
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
          rows={6}
          spellCheck={false}
          style={{ ...controlStyle, ...monoAreaStyle }}
        />
      ) : control === "file" ? (
        <>
          <input
            type="file"
            accept={input.file?.media_types?.join(",")}
            multiple={input.file?.multiple}
            onChange={(event) => void selectFiles(event.target.files)}
            style={controlStyle}
          />
          {input.file ? (
            <span style={fieldHintStyle}>
              {input.file.multiple
                ? t("workflowRunConsole.multipleFiles")
                : t("workflowRunConsole.oneFile")}
              {input.file.media_types?.length
                ? ` · ${input.file.media_types.join(", ")}`
                : ""}
              {input.file.max_bytes
                ? t("workflowRunConsole.maxEach", {
                    size: formatFileBytes(input.file.max_bytes),
                  })
                : ""}
            </span>
          ) : null}
          {fileError ? (
            <span
              role="alert"
              style={{ ...fieldHintStyle, color: "var(--red)" }}
            >
              {fileError}
            </span>
          ) : null}
        </>
      ) : (
        <input
          type={control === "number" ? "number" : "text"}
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
          placeholder={input.ui?.placeholder}
          style={controlStyle}
        />
      )}
      {input.ui?.helpText ? (
        <span style={fieldHintStyle}>{input.ui.helpText}</span>
      ) : null}
      {control !== "file" ? (
        <span className={styles.inputExample}>
          {t("workflowRunConsole.example")}{" "}
          <code>
            {compactExample(example, 120, t("workflowRunConsole.notSupplied"))}
          </code>
        </span>
      ) : null}
      <span style={fieldHintStyle}>
        {t("workflowRunConsole.usedBy", {
          consumers: input.consumers.join(", "),
        })}
        {input.bindings.some((binding) => binding.mode !== "direct")
          ? ` · ${input.bindings
              .filter((binding) => binding.mode !== "direct")
              .map(
                (binding) =>
                  `${binding.agentId}:${binding.mode}${binding.expression ? ` ${binding.expression}` : ""}`,
              )
              .join(" · ")}`
          : ""}
      </span>
    </FieldContainer>
  );
}

function DraftEvidence({
  result,
  tab,
  selectedAgentRun,
  onSelectAgent,
}: {
  result: WorkflowTestRunResponse;
  tab: ResultTab;
  selectedAgentRun: WorkflowTestAgentRun | null;
  onSelectAgent: (id: string) => void;
}) {
  const { t } = useI18n();
  if (tab === "json") return <JsonPanel value={result} />;
  if (tab === "events") {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        {result.events.map((event) => (
          <div key={event.id} style={evidenceRowStyle}>
            <div>
              <div style={rowTitleStyle}>
                <Icon name="event" size={11} />
                {event.name}
                {event.terminal ? (
                  <Badge tone="muted">
                    {t("workflowRunConsole.terminalBadge")}
                  </Badge>
                ) : null}
              </div>
              <div style={rowMetaStyle}>
                {event.id} ·{" "}
                {t("workflowRunConsole.depthValue", {
                  depth: event.depth,
                })}{" "}
                ·{" "}
                {t("workflowRunConsole.consumerCount", {
                  count: event.consumerAgentIds.length,
                })}
              </div>
            </div>
            <code style={payloadPreviewStyle}>
              {JSON.stringify(event.payload)}
            </code>
          </div>
        ))}
      </div>
    );
  }
  if (tab === "agents") {
    return (
      <div className={styles.agentTrace} style={agentTraceStyle}>
        <div style={{ display: "grid", gap: 6, alignContent: "start" }}>
          {result.agentRuns.map((run, index) => (
            <button
              key={run.id}
              type="button"
              onClick={() => onSelectAgent(run.id)}
              style={{
                ...agentSelectStyle,
                borderColor:
                  selectedAgentRun?.id === run.id
                    ? "var(--signal)"
                    : "var(--border)",
                background:
                  selectedAgentRun?.id === run.id
                    ? "rgba(208,255,0,0.055)"
                    : "var(--panel-2)",
              }}
            >
              <span style={{ color: "var(--text-3)" }}>
                {String(index + 1).padStart(2, "0")}
              </span>
              <span style={{ minWidth: 0 }}>
                <strong style={{ color: "var(--text)", display: "block" }}>
                  {run.agentTitle}
                </strong>
                <span style={rowMetaStyle}>
                  {formatDuration(run.durationMs)} ·{" "}
                  {t("workflowRunConsole.stepCount", {
                    count: run.steps.length,
                  })}
                </span>
              </span>
              <Badge tone={statusTone(run.status)}>
                {workflowTestStatusLabel(t, run.status)}
              </Badge>
            </button>
          ))}
        </div>
        {selectedAgentRun ? (
          <AgentRunEvidence run={selectedAgentRun} />
        ) : (
          <div style={emptyInputStyle}>
            {t("workflowRunConsole.noAgentExecution")}
          </div>
        )}
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={metricGridStyle}>
        <Metric
          label={t("workflowRunConsole.status")}
          value={workflowTestStatusLabel(t, result.status)}
        />
        <Metric
          label={t("workflowRunConsole.agentRuns")}
          value={t("workflowRunConsole.passedCount", {
            passed: result.summary.passed,
            total: result.summary.agentRuns,
          })}
        />
        <Metric
          label={t("workflowRunConsole.steps")}
          value={String(result.summary.steps)}
        />
        <Metric
          label={t("workflowRunConsole.events")}
          value={t("workflowRunConsole.eventsSummary", {
            count: result.summary.events,
            terminal: result.summary.terminalEvents,
          })}
        />
        <Metric
          label={t("workflowRunConsole.modelTokens")}
          value={t("workflowRunConsole.tokenSummary", {
            input: result.summary.tokensIn,
            output: result.summary.tokensOut,
          })}
        />
        <Metric
          label={t("workflowRunConsole.duration")}
          value={formatDuration(result.durationMs)}
        />
      </div>
      {result.warnings.length > 0 ? (
        <div style={{ display: "grid", gap: 6 }}>
          {result.warnings.map((warning) => (
            <InlineNotice key={warning} tone="amber">
              {warning}
            </InlineNotice>
          ))}
        </div>
      ) : null}
      <div>
        <div style={sectionHeadingStyle}>
          {t("workflowRunConsole.terminalOutputs")}
        </div>
        {result.terminalOutputs.length > 0 ? (
          <div style={{ display: "grid", gap: 8 }}>
            {result.terminalOutputs.map((output) => (
              <div key={output.agentRunId} style={outputCardStyle}>
                <div style={rowTitleStyle}>
                  <Icon name="check" size={11} />
                  {output.agentTitle}
                  {output.emittedEvents.map((event) => (
                    <Badge key={event} tone="blue">
                      {event}
                    </Badge>
                  ))}
                </div>
                <pre style={preStyle}>
                  {JSON.stringify(output.output, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        ) : (
          <div style={emptyInputStyle}>
            {t("workflowRunConsole.noTerminalOutput")}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentRunEvidence({ run }: { run: WorkflowTestAgentRun }) {
  const { t } = useI18n();
  return (
    <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
      <div style={metricGridStyle}>
        <Metric
          label={t("workflowRunConsole.status")}
          value={workflowTestStatusLabel(t, run.status)}
        />
        <Metric
          label={t("workflowRunConsole.triggeredBy")}
          value={run.triggerEvent}
        />
        <Metric
          label={t("workflowRunConsole.duration")}
          value={formatDuration(run.durationMs)}
        />
        <Metric
          label={t("workflowRunConsole.model")}
          value={
            run.provider || run.model
              ? `${run.provider ?? t("workflowRunConsole.defaultValue")} / ${run.model ?? t("workflowRunConsole.defaultValue")}`
              : t("workflowRunConsole.noModelCall")
          }
        />
      </div>
      {run.error ? (
        <InlineNotice tone="red">
          {run.error.code}: {run.error.message}
        </InlineNotice>
      ) : null}
      <div>
        <div style={sectionHeadingStyle}>
          {t("workflowRunConsole.validatedInputs")}
        </div>
        <pre style={preStyle}>{JSON.stringify(run.inputs, null, 2)}</pre>
      </div>
      <div>
        <div style={sectionHeadingStyle}>
          {t("workflowRunConsole.actionTimeline")}
        </div>
        <div style={{ display: "grid", gap: 7 }}>
          {run.steps.map((step, index) => (
            <div key={step.id} style={stepStyle}>
              <div style={stepRailStyle}>
                <span>{String(index + 1).padStart(2, "0")}</span>
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={rowTitleStyle}>
                  {step.name}
                  <Badge tone={statusTone(step.status)}>
                    {workflowTestStatusLabel(t, step.status)}
                  </Badge>
                  <Badge tone="muted">{step.type.toUpperCase()}</Badge>
                </div>
                <div style={rowMetaStyle}>
                  {formatDuration(step.durationMs)}
                  {step.provider || step.model
                    ? ` · ${step.provider ?? t("workflowRunConsole.defaultValue")}/${step.model ?? t("workflowRunConsole.defaultValue")}`
                    : ""}
                  {step.tokensIn + step.tokensOut > 0
                    ? t("workflowRunConsole.tokensSuffix", {
                        count: step.tokensIn + step.tokensOut,
                      })
                    : ""}
                  {step.branchTarget
                    ? t("workflowRunConsole.branchSuffix", {
                        target: step.branchTarget,
                      })
                    : ""}
                </div>
                {step.simulation ? (
                  <div style={{ ...fieldHintStyle, color: "var(--amber)" }}>
                    {step.simulation}
                  </div>
                ) : null}
                {step.error ? (
                  <div style={{ ...fieldHintStyle, color: "var(--red)" }}>
                    {step.error.code}: {step.error.message}
                  </div>
                ) : null}
                <details style={{ marginTop: 7 }}>
                  <summary style={detailsSummaryStyle}>
                    {t("workflowRunConsole.inputOutput")}
                  </summary>
                  <div className={styles.twoColumn} style={twoColumnStyle}>
                    <pre style={preStyle}>
                      {JSON.stringify(step.input, null, 2)}
                    </pre>
                    <pre style={preStyle}>
                      {JSON.stringify(step.output, null, 2)}
                    </pre>
                  </div>
                </details>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div style={sectionHeadingStyle}>
          {t("workflowRunConsole.validatedOutput")}
        </div>
        <pre style={preStyle}>{JSON.stringify(run.output, null, 2)}</pre>
      </div>
    </div>
  );
}

function LiveEvidence({
  receipt,
  tab,
  loading,
  error,
  data,
  onOpenRun,
}: {
  receipt: LiveReceipt;
  tab: ResultTab;
  loading: boolean;
  error: string | null;
  data: ReturnType<typeof useEventCausality>["data"] | undefined;
  onOpenRun: (runId: string) => void;
}) {
  const { language, t } = useI18n();
  if (tab === "json") {
    return <JsonPanel value={{ receipt, causality: data ?? null }} />;
  }
  if (error) return <InlineNotice tone="red">{error}</InlineNotice>;
  if (tab === "events") {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        {(data?.events ?? []).map((event) => (
          <div key={event.id} style={evidenceRowStyle}>
            <div>
              <div style={rowTitleStyle}>
                <Icon name="event" size={11} />
                {event.name}
              </div>
              <div style={rowMetaStyle}>
                {event.id} ·{" "}
                {event.subject ?? t("workflowRunConsole.noSubject")}
              </div>
            </div>
            <span style={rowMetaStyle}>
              {t("workflowRunConsole.consumerCount", {
                count: event.consumers?.length ?? 0,
              })}
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (tab === "agents") {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        {(data?.runs ?? []).map((run) => (
          <div key={run.id} style={evidenceRowStyle}>
            <div>
              <div style={rowTitleStyle}>
                <Icon name="agent" size={11} />
                {run.agentName ?? t("workflowRunConsole.manifestAgent")}
                <Badge tone={statusTone(run.status)}>
                  {runStatusLabel(t, run.status)}
                </Badge>
              </div>
              <div style={rowMetaStyle}>
                {run.id} · {t("workflowRunConsole.triggerLabel")}{" "}
                {run.triggerEventId ?? t("workflowRunConsole.pending")}
              </div>
            </div>
            <Button small icon="external" onClick={() => onOpenRun(run.id)}>
              {t("workflowRunConsole.openRun")}
            </Button>
          </div>
        ))}
        {!loading && (data?.runs.length ?? 0) === 0 ? (
          <div style={emptyInputStyle}>
            {t("workflowRunConsole.waitingDurableRun")}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={metricGridStyle}>
        <Metric
          label={t("workflowRunConsole.seedEvent")}
          value={receipt.eventId}
          mono
        />
        <Metric
          label={t("workflowRunConsole.event")}
          value={receipt.eventName}
          mono
        />
        <Metric
          label={t("workflowRunConsole.durableRuns")}
          value={String(data?.runs.length ?? 0)}
        />
        <Metric
          label={t("workflowRunConsole.observedEvents")}
          value={String(data?.events.length ?? 0)}
        />
      </div>
      <InlineNotice tone="green">
        {t("workflowRunConsole.eventAcceptedBefore")}{" "}
        {new Date(receipt.submittedAt).toLocaleTimeString(
          language === "zh" ? "zh-CN" : "en-US",
        )}
        . {t("workflowRunConsole.eventAcceptedAfter")}
      </InlineNotice>
      {loading ? (
        <div style={emptyInputStyle}>
          {t("workflowRunConsole.readingCausality")}
        </div>
      ) : (data?.runs.length ?? 0) === 0 ? (
        <InlineNotice tone="amber">
          {t("workflowRunConsole.noRunConsumedBefore")} <code>pnpm dev</code>{" "}
          {t("workflowRunConsole.noRunConsumedAfter")}
        </InlineNotice>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {data?.runs.map((run) => (
            <div key={run.id} style={evidenceRowStyle}>
              <div>
                <div style={rowTitleStyle}>
                  {run.agentName ?? t("workflowRunConsole.manifestAgent")}
                  <Badge tone={statusTone(run.status)}>
                    {runStatusLabel(t, run.status)}
                  </Badge>
                </div>
                <div style={rowMetaStyle}>{run.id}</div>
              </div>
              <Button small icon="external" onClick={() => onOpenRun(run.id)}>
                {t("workflowRunConsole.inspectEvidence")}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyEvidence({ target }: { target: RunTarget }) {
  const { t } = useI18n();
  return (
    <div style={emptyEvidenceStyle}>
      <div style={emptyIconStyle}>
        <Icon name={target === "draft" ? "workflow" : "deploy"} size={24} />
      </div>
      <div style={{ fontSize: 15, color: "var(--text)", fontWeight: 650 }}>
        {target === "draft"
          ? t("workflowRunConsole.readyDraftTitle")
          : t("workflowRunConsole.readyLiveTitle")}
      </div>
      <div style={{ maxWidth: 520, color: "var(--text-3)", lineHeight: 1.6 }}>
        {target === "draft"
          ? t("workflowRunConsole.readyDraftBody")
          : t("workflowRunConsole.readyLiveBody")}
      </div>
    </div>
  );
}

function JsonPanel({ value }: { value: unknown }) {
  return (
    <pre style={{ ...preStyle, minHeight: "100%", margin: 0 }}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Metric({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div style={metricStyle}>
      <span style={metricLabelStyle}>{label}</span>
      <strong
        style={{
          color: "var(--text)",
          fontSize: 13,
          fontFamily: mono ? "var(--mono)" : "var(--sans)",
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </strong>
    </div>
  );
}

function SetupSection({
  number,
  title,
  hint,
  children,
}: {
  number: string;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section style={setupSectionStyle}>
      <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
        <span style={sectionNumberStyle}>{number}</span>
        <div>
          <div style={setupTitleStyle}>{title}</div>
          <div style={fieldHintStyle}>{hint}</div>
        </div>
      </div>
      <div style={{ display: "grid", gap: 10 }}>{children}</div>
    </section>
  );
}

/** Chat | Payload. Visible rather than hidden behind an "advanced" toggle. */
function ModeButton({
  selected,
  onClick,
  label,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      style={{
        padding: "5px 12px",
        fontSize: 11.5,
        background: selected ? "rgba(208,255,0,0.07)" : "transparent",
        color: selected ? "var(--text)" : "var(--text-3)",
        border: `1px solid ${selected ? "var(--signal)" : "var(--border)"}`,
        borderRadius: 5,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function TargetButton({
  selected,
  disabled,
  onClick,
  title,
  detail,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: "9px 10px",
        textAlign: "left",
        background: selected ? "rgba(208,255,0,0.07)" : "var(--panel-2)",
        color: disabled ? "var(--text-3)" : "var(--text)",
        border: `1px solid ${selected ? "var(--signal)" : "var(--border)"}`,
        borderRadius: 5,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.58 : 1,
      }}
    >
      <strong style={{ display: "block", fontSize: 12 }}>{title}</strong>
      <span style={{ color: "var(--text-3)", fontSize: 10.5 }}>{detail}</span>
    </button>
  );
}

function BudgetField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label style={fieldLabelStyle}>
      {label}
      <input
        type="number"
        min={1}
        step={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={controlStyle}
      />
    </label>
  );
}

function ConfirmRow({
  checked,
  onChange,
  tone,
  children,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  tone: "amber" | "red";
  children: React.ReactNode;
}) {
  return (
    <label
      style={{
        display: "grid",
        gridTemplateColumns: "18px 1fr",
        gap: 8,
        alignItems: "start",
        padding: "9px 10px",
        color: tone === "red" ? "var(--red)" : "var(--amber)",
        background:
          tone === "red" ? "rgba(255,100,112,0.06)" : "rgba(240,180,41,0.06)",
        border: `1px solid ${
          tone === "red" ? "rgba(255,100,112,0.3)" : "rgba(240,180,41,0.3)"
        }`,
        borderRadius: 5,
        fontSize: 11.5,
        lineHeight: 1.45,
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

function InlineNotice({
  tone,
  children,
}: {
  tone: "green" | "amber" | "red";
  children: React.ReactNode;
}) {
  const color =
    tone === "green"
      ? "var(--signal)"
      : tone === "red"
        ? "var(--red)"
        : "var(--amber)";
  return (
    <div
      style={{
        padding: "8px 10px",
        color,
        background: `color-mix(in srgb, ${color} 6%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
        borderRadius: 5,
        fontSize: 11.5,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

const consoleStyle: CSSProperties = {
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr) auto",
  overflow: "hidden",
  background: "var(--panel)",
  border: "1px solid var(--border-2)",
  borderRadius: 7,
  boxShadow: "0 28px 90px rgba(0,0,0,0.52)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 16,
  padding: "16px 18px",
  borderBottom: "1px solid var(--border)",
  background:
    "linear-gradient(110deg, color-mix(in srgb, var(--signal) 4%, var(--panel)), var(--panel) 38%)",
};

const eyebrowStyle: CSSProperties = {
  color: "var(--text-3)",
  fontFamily: "var(--mono)",
  fontSize: 9.5,
  letterSpacing: "0.12em",
  marginBottom: 5,
};

const titleStyle: CSSProperties = {
  margin: 0,
  color: "var(--text)",
  fontFamily: "var(--display)",
  fontSize: 20,
  fontWeight: 560,
};

const subtitleStyle: CSSProperties = {
  margin: "5px 0 0",
  color: "var(--text-2)",
  fontSize: 12,
};

const bodyStyle: CSSProperties = {
  minHeight: 0,
  display: "grid",
};

const setupStyle: CSSProperties = {
  minHeight: 0,
  overflow: "auto",
  padding: 14,
  display: "grid",
  gap: 11,
  alignContent: "start",
  background: "var(--bg)",
};

const resultsStyle: CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  display: "grid",
  gridTemplateRows: "auto auto minmax(0, 1fr)",
  background: "var(--panel)",
};

const resultsHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "14px 16px 11px",
};

const resultContentStyle: CSSProperties = {
  minHeight: 0,
  overflow: "auto",
  padding: 16,
};

const footerStyle: CSSProperties = {
  minHeight: 58,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 14,
  padding: "10px 14px",
  borderTop: "1px solid var(--border)",
  background: "var(--panel-2)",
};

const setupSectionStyle: CSSProperties = {
  display: "grid",
  gap: 11,
  padding: 12,
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 6,
};

const sectionNumberStyle: CSSProperties = {
  color: "var(--signal)",
  fontFamily: "var(--mono)",
  fontSize: 10,
  paddingTop: 1,
};

const setupTitleStyle: CSSProperties = {
  color: "var(--text)",
  fontSize: 12.5,
  fontWeight: 680,
  marginBottom: 2,
};

const fieldLabelStyle: CSSProperties = {
  display: "grid",
  gap: 5,
  color: "var(--text-2)",
  fontSize: 10.5,
  fontFamily: "var(--mono)",
  letterSpacing: "0.035em",
};

const fieldHintStyle: CSSProperties = {
  color: "var(--text-3)",
  fontFamily: "var(--sans)",
  fontSize: 10.5,
  lineHeight: 1.45,
  letterSpacing: 0,
};

const controlStyle: CSSProperties = {
  width: "100%",
  minHeight: 34,
  padding: "7px 9px",
  color: "var(--text)",
  background: "var(--bg-2)",
  border: "1px solid var(--border-2)",
  borderRadius: 4,
  fontFamily: "var(--sans)",
  fontSize: 12,
};

const monoAreaStyle: CSSProperties = {
  minHeight: 126,
  resize: "vertical",
  fontFamily: "var(--mono)",
  fontSize: 11,
  lineHeight: 1.45,
};

const segmentedStyle: CSSProperties = {
  display: "grid",
  gap: 6,
};

const twoColumnStyle: CSSProperties = {
  display: "grid",
  gap: 8,
};

const threeColumnStyle: CSSProperties = {
  display: "grid",
  gap: 7,
};

const agentTraceStyle: CSSProperties = {
  display: "grid",
  gap: 12,
  minHeight: 0,
};

const entrypointMetaStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  flexWrap: "wrap",
  color: "var(--text-3)",
  fontSize: 10.5,
};

const emptyInputStyle: CSSProperties = {
  padding: "10px 11px",
  color: "var(--text-3)",
  background: "var(--panel-2)",
  border: "1px dashed var(--border-2)",
  borderRadius: 5,
  fontSize: 11.5,
  lineHeight: 1.5,
};

const rawToggleStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "4px 0",
  color: "var(--text-2)",
  background: "transparent",
  border: 0,
  fontSize: 11,
  fontFamily: "var(--mono)",
  textAlign: "left",
  cursor: "pointer",
};

const tabsStyle: CSSProperties = {
  display: "flex",
  gap: 2,
  padding: "0 16px",
  borderBottom: "1px solid var(--border)",
};

function tabStyle(selected: boolean): CSSProperties {
  return {
    padding: "8px 10px",
    color: selected ? "var(--signal)" : "var(--text-3)",
    background: "transparent",
    border: 0,
    borderBottom: selected
      ? "2px solid var(--signal)"
      : "2px solid transparent",
    fontFamily: "var(--mono)",
    fontSize: 10.5,
    cursor: "pointer",
  };
}

const emptyEvidenceStyle: CSSProperties = {
  minHeight: "100%",
  display: "grid",
  placeItems: "center",
  alignContent: "center",
  gap: 9,
  padding: 40,
  textAlign: "center",
  backgroundImage:
    "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
  backgroundSize: "32px 32px",
  backgroundPosition: "-1px -1px",
};

const emptyIconStyle: CSSProperties = {
  width: 52,
  height: 52,
  display: "grid",
  placeItems: "center",
  color: "var(--signal)",
  background: "var(--panel)",
  border: "1px solid var(--border-2)",
  borderRadius: 8,
};

const metricGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
  gap: 8,
};

const metricStyle: CSSProperties = {
  display: "grid",
  gap: 5,
  minHeight: 66,
  alignContent: "center",
  padding: "9px 10px",
  background: "var(--panel-2)",
  border: "1px solid var(--border)",
  borderRadius: 5,
};

const metricLabelStyle: CSSProperties = {
  color: "var(--text-3)",
  fontFamily: "var(--mono)",
  fontSize: 9.5,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
};

const sectionHeadingStyle: CSSProperties = {
  marginBottom: 7,
  color: "var(--text-2)",
  fontFamily: "var(--mono)",
  fontSize: 10.5,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

const outputCardStyle: CSSProperties = {
  padding: 11,
  background: "var(--panel-2)",
  border: "1px solid var(--border)",
  borderRadius: 5,
};

const preStyle: CSSProperties = {
  margin: "7px 0 0",
  padding: 10,
  overflow: "auto",
  color: "var(--text-2)",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  fontFamily: "var(--mono)",
  fontSize: 10.5,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const rowTitleStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
  color: "var(--text)",
  fontSize: 12,
  fontWeight: 650,
};

const rowMetaStyle: CSSProperties = {
  marginTop: 3,
  color: "var(--text-3)",
  fontFamily: "var(--mono)",
  fontSize: 10.5,
};

const evidenceRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "10px 11px",
  background: "var(--panel-2)",
  border: "1px solid var(--border)",
  borderRadius: 5,
};

const payloadPreviewStyle: CSSProperties = {
  maxWidth: "48%",
  overflow: "hidden",
  color: "var(--text-3)",
  fontSize: 9.5,
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const agentSelectStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "24px minmax(0, 1fr) auto",
  gap: 7,
  alignItems: "center",
  width: "100%",
  padding: "9px 8px",
  textAlign: "left",
  border: "1px solid var(--border)",
  borderRadius: 5,
  cursor: "pointer",
};

const stepStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "30px minmax(0, 1fr)",
  gap: 8,
  padding: 9,
  background: "var(--panel-2)",
  border: "1px solid var(--border)",
  borderRadius: 5,
};

const stepRailStyle: CSSProperties = {
  display: "grid",
  placeItems: "start center",
  paddingTop: 2,
  color: "var(--signal)",
  fontFamily: "var(--mono)",
  fontSize: 10,
  borderRight: "1px solid var(--border)",
};

const detailsSummaryStyle: CSSProperties = {
  color: "var(--text-3)",
  fontFamily: "var(--mono)",
  fontSize: 10,
  cursor: "pointer",
};
