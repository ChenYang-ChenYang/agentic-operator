"use client";

import Link from "next/link";
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  PROVIDER_IDS,
  findCatalogModel,
  type ProviderId,
  type ReasoningConfig,
  type ReasoningContext,
  type ReasoningEffort,
  type ReasoningMode,
  type ReasoningSummary,
  type TextVerbosity,
} from "@agentic/contracts";
import { Badge, Button, Empty, Icon, Splitter } from "@/app/portal/components";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { fmtDur, fmtNum } from "@/app/portal/lib/format";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  useAgentRunHistory,
  useCreateAgentRun,
  useRunOutput,
  useRunSession,
  useRunTrace,
  formatAgentStudioError,
  type AgentStudioRunRow,
  type CreateAgentRunRequest,
  type RunTraceEvent,
} from "@/lib/hooks/useAgentStudio";
import {
  useCancelRun,
  useRun,
  useRunArtifacts,
  type RunDetail,
} from "@/lib/hooks/useRuns";
import { formatUsdNanos } from "@/lib/format-usd";
import { useRunLogStream } from "@/lib/hooks/useRunLogStream";
import { useAvailableModels } from "@/lib/hooks/useModelFleet";
import {
  Field,
  InlineNotice,
  JsonValueEditor,
  Segmented,
  SelectInput,
  TextInput,
} from "./fields";
import {
  asRecord,
  isRecord,
  isTerminalStatus,
  toPrettyJson,
  type StudioDefinition,
  type StudioInputPort,
} from "./model";
import {
  assistantTextFromValue,
  assistantTextOutputKeys,
  buildChatTranscript,
  isStructuredChatValue,
  prettyChatValue,
  prettyJsonOutput,
  type ChatMessageView,
} from "./chat-model";
import { buildStudioChatRunRequest } from "./chat-request";
import {
  clampPanelWidth,
  maxTestHistoryWidth,
  maxTestSetupWidth,
  testHistoryFitsInline,
  TEST_HISTORY_DEFAULT_WIDTH,
  TEST_HISTORY_DEFAULT_HEIGHT,
  TEST_HISTORY_MAX_HEIGHT,
  TEST_HISTORY_MAX_WIDTH,
  TEST_HISTORY_MIN_HEIGHT,
  TEST_HISTORY_MIN_WIDTH,
  TEST_SETUP_MIN_WIDTH,
} from "./test-layout";
import {
  CUSTOM_MODEL_OPTION,
  providerModelIds,
  providerOverrideNeedsModel,
  testModelOptions,
} from "./test-model-selector";
import { studioLocale, studioUi, type StudioTranslate } from "./copy";

type ResultTab = "chat" | "trace" | "output" | "logs" | "artifacts";
const RUN_PROVIDERS = ["", ...PROVIDER_IDS];
const DEFAULT_FILE_MAX_BYTES = 10_000_000;

interface StudioFilePolicy {
  mediaTypes: string[];
  maxBytes: number;
  multiple: boolean;
}

interface StudioFileValue {
  name: string;
  type: string;
  size: number;
  dataUrl: string;
}

interface StudioDraftTarget {
  id: string;
  revision: number;
}

interface PendingChatTurn {
  prompt: string;
  state: "publishing" | "queued";
  runId: string | null;
  eventId: string | null;
  eventName: string | null;
}

interface ChatDispatchReceipt {
  runId: string;
  eventId: string;
  eventName: string;
}

function filePolicyFor(input: StudioInputPort): StudioFilePolicy {
  const policy = asRecord(input.file);
  const maxBytes = policy.max_bytes;
  return {
    mediaTypes: Array.isArray(policy.media_types)
      ? policy.media_types
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : [],
    maxBytes:
      typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0
        ? maxBytes
        : DEFAULT_FILE_MAX_BYTES,
    multiple: policy.multiple === true,
  };
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

function readFileValue(
  file: File,
  t: StudioTranslate,
): Promise<StudioFileValue> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(
        new Error(studioUi(t, "Could not read {file}.", { file: file.name })),
      );
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(
          new Error(
            studioUi(t, "Could not encode {file}.", { file: file.name }),
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

function statusTone(
  status: string,
): "green" | "red" | "amber" | "blue" | "muted" {
  if (status === "ok") return "green";
  if (status === "failed" || status === "cancelled") return "red";
  if (status === "running" || status === "queued") return "blue";
  if (status === "waiting" || status === "paused") return "amber";
  return "muted";
}

function valueForInput(input: StudioInputPort): unknown {
  if (input.default !== undefined) return input.default;
  if (input.example !== undefined) return input.example;
  if (input.kind === "file") return filePolicyFor(input).multiple ? [] : null;
  if (input.schema.type === "boolean") return false;
  if (input.schema.type === "number" || input.schema.type === "integer")
    return 0;
  if (input.schema.type === "array") return [];
  if (input.schema.type === "object") return {};
  return "";
}

function displayTime(
  value: Date | string | null | undefined,
  locale: string,
): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(locale);
}

function TraceRow({ event }: { event: RunTraceEvent }) {
  const color =
    event.status === "ok"
      ? "var(--green)"
      : event.status === "failed"
        ? "var(--red)"
        : event.status === "running"
          ? "var(--signal)"
          : "var(--text-3)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "28px minmax(0, 1fr) auto",
        gap: 9,
        padding: "10px 4px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div className="mono" style={{ color: "var(--text-3)", fontSize: 10 }}>
        {event.seq}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: color,
              flexShrink: 0,
            }}
          />
          <span
            style={{ color: "var(--text)", fontSize: 11.5, fontWeight: 500 }}
          >
            {event.name}
          </span>
          <Badge tone="muted">{event.kind}</Badge>
        </div>
        {event.summary && (
          <div
            style={{
              marginTop: 5,
              color: "var(--text-2)",
              fontSize: 10.5,
              lineHeight: 1.5,
            }}
          >
            {event.summary}
          </div>
        )}
      </div>
      <span className="mono" style={{ color: "var(--text-3)", fontSize: 10 }}>
        {event.durationMs == null ? "" : `${event.durationMs}ms`}
      </span>
    </div>
  );
}

function traceEventTitle(event: RunTraceEvent, t: StudioTranslate): string {
  const known: Record<string, string> = {
    "run.queued": "Run queued",
    "run.started": "Runtime started",
    "run.completed": "Run completed",
    "input.validation": "Inputs validated",
    "prompt.compiled": "Prompt prepared",
    "llm.call": "Model call",
    "llm.output_repair": "Output repair",
    "output.validation": "Output validated",
    "output.repair.validation": "Repaired output validated",
    "output.persisted": "Output saved",
  };
  const known_ = known[event.name];
  return known_ ? studioUi(t, known_) : event.name;
}

/** Collapse running/terminal updates for one activity in the compact card. */
function compactProgressEvents(events: RunTraceEvent[]): RunTraceEvent[] {
  const latest = new Map<string, RunTraceEvent>();
  for (const event of events) {
    if (event.name === "llm.reasoning_summary") continue;
    const iteration =
      event.data && typeof event.data.iteration === "number"
        ? `:${event.data.iteration}`
        : "";
    const key = `${event.kind}:${event.stepId ?? "run"}:${event.name}${iteration}`;
    latest.set(key, event);
  }
  return Array.from(latest.values()).sort(
    (left, right) => left.seq - right.seq,
  );
}

/**
 * The "Test Lab uses the real runtime" explainer, as a hover/focus hint next
 * to the Conversation heading rather than a standing banner — the notice is
 * read once but the vertical space it costs is paid on every run.
 */
function RuntimeHint() {
  const { t } = useI18n();
  return (
    <span className="agent-studio-runtime-hint">
      <button
        type="button"
        className="agent-studio-runtime-hint__trigger"
        aria-label={studioUi(t, "How Test Lab runs are executed")}
        aria-describedby="agent-studio-runtime-hint-content"
      >
        <Icon name="info" size={12} />
      </button>
      <span
        id="agent-studio-runtime-hint-content"
        className="agent-studio-runtime-hint__tooltip"
        role="tooltip"
      >
        <strong>{studioUi(t, "Test Lab uses the real runtime.")}</strong>{" "}
        {studioUi(
          t,
          "Send publishes a runtime event and copies this message into the agent's prompt input. Structured variables stay separate. Runs, traces, logs, and artifacts are saved in history.",
        )}
      </span>
    </span>
  );
}

/**
 * Live execution card shown inline in the chat while a run is in flight.
 *
 * Token counts and cost come from the run's `usage` aggregate
 * (`GET /v1/runs/:id` → `getRunUsageSummary`) rather than the run row, so
 * retried provider attempts are counted once logically but billed in full.
 * Falls back to the run/history row when no attempt has been recorded yet.
 */
function RunProgressCard({
  runId,
  historyRow,
  detail,
  traceEvents,
  traceLoading,
  expectedSteps,
  onOpenTrace,
}: {
  runId: string;
  historyRow: AgentStudioRunRow | undefined;
  detail: RunDetail | undefined;
  traceEvents: RunTraceEvent[];
  traceLoading: boolean;
  expectedSteps: number;
  onOpenTrace: () => void;
}) {
  const { t } = useI18n();
  const run = detail?.run;
  const usage = detail?.usage;
  const status = run?.status ?? historyRow?.status ?? "queued";
  const live = !isTerminalStatus(status);
  const startedAt = run?.startedAt ?? historyRow?.startedAt;
  const startedMs = startedAt ? new Date(startedAt).getTime() : Number.NaN;
  const durationMs =
    run?.durationMs ??
    historyRow?.durationMs ??
    (live && Number.isFinite(startedMs)
      ? Math.max(0, Date.now() - startedMs)
      : null);
  const steps = detail?.steps ?? [];
  const completedSteps = steps.filter((step) =>
    ["ok", "failed", "skipped"].includes(step.status),
  ).length;
  const currentStep = [...steps]
    .reverse()
    .find((step) => step.status === "running" || step.status === "pending");
  const progressEvents = compactProgressEvents(traceEvents);
  const visibleEvents = progressEvents.slice(-6);
  const latestEvent = progressEvents.at(-1);
  const totalSteps = Math.max(expectedSteps, steps.length);
  const tokensIn =
    usage && usage.attempts > 0
      ? usage.tokensIn
      : (run?.tokensIn ?? historyRow?.tokensIn ?? 0);
  const tokensOut =
    usage && usage.attempts > 0
      ? usage.tokensOut
      : (run?.tokensOut ?? historyRow?.tokensOut ?? 0);
  const provider =
    usage?.latestProvider ?? run?.provider ?? historyRow?.provider ?? null;
  const model = usage?.latestModel ?? run?.model ?? historyRow?.model ?? null;
  const phase =
    status === "queued"
      ? studioUi(t, "Waiting for the runtime")
      : status === "ok"
        ? studioUi(t, "Response completed")
        : status === "failed"
          ? studioUi(t, "Run failed")
          : status === "cancelled"
            ? studioUi(t, "Run cancelled")
            : currentStep
              ? studioUi(t, "Running {step}", { step: currentStep.name })
              : (latestEvent?.summary ?? "") ||
                studioUi(t, "Agent is working");
  const cost =
    usage?.costUsdNanos != null
      ? formatUsdNanos(usage.costUsdNanos)
      : usage?.inFlight
        ? studioUi(t, "Calculating")
        : usage?.unpricedCalls
          ? studioUi(t, "Unpriced")
          : "—";
  const callValue = usage ? fmtNum(usage.logicalCalls) : "—";

  return (
    <section
      className={`agent-studio-run-progress agent-studio-run-progress--${status}`}
      aria-label={studioUi(t, "Execution progress for run {id}", {
        id: runId,
      })}
      aria-live="polite"
    >
      <div className="agent-studio-run-progress__header">
        <div className="agent-studio-run-progress__identity">
          <span
            className={`agent-studio-run-progress__pulse${live ? " is-live" : ""}`}
            aria-hidden="true"
          />
          <span>
            <span className="agent-studio-run-progress__eyebrow">
              {studioUi(t, "Execution")}
            </span>
            <strong>{phase}</strong>
          </span>
        </div>
        <div className="agent-studio-run-progress__header-meta">
          <Badge tone={statusTone(status)}>{studioUi(t, status)}</Badge>
          <span className="mono">{fmtDur(durationMs)}</span>
        </div>
      </div>

      {(provider || model) && (
        <div className="agent-studio-run-progress__model mono">
          {provider ?? studioUi(t, "default provider")} /{" "}
          {model ?? studioUi(t, "default model")}
        </div>
      )}

      <div className="agent-studio-run-progress__metrics">
        <div>
          <span>{studioUi(t, "Steps")}</span>
          <strong>
            {completedSteps}
            {totalSteps > 0 ? ` / ${totalSteps}` : ""}
          </strong>
        </div>
        <div>
          <span>{studioUi(t, "Model calls")}</span>
          <strong>{callValue}</strong>
          {usage && usage.attempts > usage.logicalCalls && (
            <small>
              {studioUi(t, "{n} attempts", { n: usage.attempts })}
            </small>
          )}
        </div>
        <div>
          <span>{studioUi(t, "Tokens")}</span>
          <strong>
            {studioUi(t, "{in} in · {out} out", {
              in: fmtNum(tokensIn),
              out: fmtNum(tokensOut),
            })}
          </strong>
          {usage &&
            (usage.cachedInputTokens > 0 || usage.reasoningTokens > 0) && (
              <small>
                {usage.cachedInputTokens > 0
                  ? studioUi(t, "{n} cached", {
                      n: fmtNum(usage.cachedInputTokens),
                    })
                  : ""}
                {usage.cachedInputTokens > 0 && usage.reasoningTokens > 0
                  ? " · "
                  : ""}
                {usage.reasoningTokens > 0
                  ? studioUi(t, "{n} reasoning", {
                      n: fmtNum(usage.reasoningTokens),
                    })
                  : ""}
              </small>
            )}
        </div>
        <div>
          <span>{studioUi(t, "LLM cost")}</span>
          <strong>{cost}</strong>
          {usage && usage.unpricedCalls > 0 && usage.costUsdNanos != null && (
            <small>
              {studioUi(t, "+ {n} unpriced calls", { n: usage.unpricedCalls })}
            </small>
          )}
        </div>
      </div>

      <div className="agent-studio-run-progress__timeline">
        <div className="agent-studio-run-progress__timeline-heading">
          <span>{studioUi(t, "Live activity")}</span>
          <button type="button" onClick={onOpenTrace}>
            {studioUi(t, "Open full trace")}
          </button>
        </div>
        {traceLoading && visibleEvents.length === 0 ? (
          <div className="agent-studio-run-progress__waiting">
            {studioUi(t, "Waiting for the first runtime event…")}
          </div>
        ) : visibleEvents.length > 0 ? (
          <div className="agent-studio-run-progress__events">
            {progressEvents.length > visibleEvents.length && (
              <div className="agent-studio-run-progress__earlier mono">
                {studioUi(t, "+{n} earlier activities", {
                  n: progressEvents.length - visibleEvents.length,
                })}
              </div>
            )}
            {visibleEvents.map((event) => (
              <div
                className={`agent-studio-run-progress__event agent-studio-run-progress__event--${event.status}`}
                key={event.id}
              >
                <span className="agent-studio-run-progress__event-dot" />
                <span className="agent-studio-run-progress__event-copy">
                  <span>
                    <strong>{traceEventTitle(event, t)}</strong>
                    <small>{event.kind.replaceAll("_", " ")}</small>
                  </span>
                  {event.summary && <p>{event.summary}</p>}
                </span>
                <span className="mono agent-studio-run-progress__event-time">
                  {event.durationMs == null ? "" : fmtDur(event.durationMs)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="agent-studio-run-progress__waiting">
            {studioUi(
              t,
              "The run was accepted. Detailed activity will appear here.",
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function VariableControl({
  input,
  value,
  onChange,
}: {
  input: StudioInputPort;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t } = useI18n();
  const [fileError, setFileError] = useState<string | null>(null);
  const [readingFiles, setReadingFiles] = useState(false);

  if (input.kind === "file") {
    const policy = filePolicyFor(input);
    return (
      <div style={{ display: "grid", gap: 5 }}>
        <input
          type="file"
          accept={
            policy.mediaTypes.length > 0
              ? policy.mediaTypes.join(",")
              : undefined
          }
          multiple={policy.multiple}
          disabled={readingFiles}
          onChange={(event) => {
            const element = event.currentTarget;
            const files = Array.from(element.files ?? []);
            if (files.length === 0) {
              setFileError(null);
              onChange(policy.multiple ? [] : null);
              return;
            }

            const oversized = files.find((file) => file.size > policy.maxBytes);
            if (oversized) {
              setFileError(
                studioUi(
                  t,
                  "{file} is {size}; the limit is {limit} per file.",
                  {
                    file: oversized.name,
                    size: formatFileBytes(oversized.size),
                    limit: formatFileBytes(policy.maxBytes),
                  },
                ),
              );
              element.value = "";
              onChange(policy.multiple ? [] : null);
              return;
            }

            const disallowed = files.find(
              (file) =>
                !mediaTypeAllowed(
                  file.type || "application/octet-stream",
                  policy.mediaTypes,
                ),
            );
            if (disallowed) {
              setFileError(
                studioUi(t, "{file} has media type {type}. Choose {allowed}.", {
                  file: disallowed.name,
                  type: disallowed.type || "application/octet-stream",
                  allowed: policy.mediaTypes.join(", "),
                }),
              );
              element.value = "";
              onChange(policy.multiple ? [] : null);
              return;
            }

            setFileError(null);
            setReadingFiles(true);
            onChange(policy.multiple ? [] : null);
            void Promise.all(files.map((file) => readFileValue(file, t)))
              .then((encoded) =>
                onChange(policy.multiple ? encoded : (encoded[0] ?? null)),
              )
              .catch((error: unknown) => {
                setFileError(
                  error instanceof Error
                    ? error.message
                    : studioUi(t, "Could not read the selected file."),
                );
                element.value = "";
                onChange(policy.multiple ? [] : null);
              })
              .finally(() => setReadingFiles(false));
          }}
          style={{
            width: "100%",
            padding: 8,
            border: "1px dashed var(--border-2)",
            borderRadius: 5,
            color: "var(--text-2)",
            fontSize: 11,
          }}
        />
        <div
          style={{
            color: fileError ? "var(--red)" : "var(--text-3)",
            fontSize: 10,
            lineHeight: 1.4,
          }}
        >
          {fileError ??
            (readingFiles
              ? policy.multiple
                ? studioUi(t, "Preparing files…")
                : studioUi(t, "Preparing file…")
              : studioUi(t, "{types} · {size} max per file{multiple}", {
                  types:
                    policy.mediaTypes.length > 0
                      ? policy.mediaTypes.join(", ")
                      : studioUi(t, "Any media type"),
                  size: formatFileBytes(policy.maxBytes),
                  multiple: policy.multiple
                    ? studioUi(t, " · Multiple files allowed")
                    : "",
                }))}
        </div>
      </div>
    );
  }
  if (input.schema.type === "boolean") {
    return (
      <SelectInput
        value={value === true ? "true" : "false"}
        onChange={(next) => onChange(next === "true")}
        options={[
          { value: "false", label: studioUi(t, "No") },
          { value: "true", label: studioUi(t, "Yes") },
        ]}
      />
    );
  }
  if (["object", "array"].includes(String(input.schema.type))) {
    return (
      <JsonValueEditor
        value={value}
        onChange={onChange}
        height={120}
        label={input.label}
      />
    );
  }
  return (
    <TextInput
      value={
        typeof value === "string" || typeof value === "number" ? value : ""
      }
      type={
        ["number", "integer"].includes(String(input.schema.type))
          ? "number"
          : "text"
      }
      onChange={(next) =>
        onChange(
          ["number", "integer"].includes(String(input.schema.type))
            ? next.trim()
              ? Number(next)
              : undefined
            : next,
        )
      }
      placeholder={String(
        asRecord(input.ui).placeholder ?? input.description ?? "",
      )}
    />
  );
}

function ChatBubble({
  message,
  selected,
  textOutputKeys,
  onInspectRun,
}: {
  message: ChatMessageView;
  selected: boolean;
  textOutputKeys: readonly string[];
  onInspectRun: (runId: string) => void;
}) {
  const { language, t } = useI18n();
  const assistantText =
    message.role === "assistant"
      ? assistantTextFromValue(message.content, textOutputKeys)
      : null;
  const structured =
    assistantText == null && isStructuredChatValue(message.content);
  const stateLabel =
    message.state === "working"
      ? studioUi(t, "Working")
      : message.state === "failed"
        ? studioUi(t, "Failed")
        : message.state === "cancelled"
          ? studioUi(t, "Cancelled")
          : message.state === "empty"
            ? studioUi(t, "No result")
            : null;
  return (
    <article
      className={`agent-studio-chat-message agent-studio-chat-message--${message.role}${selected ? " agent-studio-chat-message--selected" : ""}`}
      aria-label={
        message.role === "user"
          ? studioUi(t, "Your message")
          : studioUi(t, "Agent message")
      }
    >
      <div className="agent-studio-chat-avatar" aria-hidden="true">
        {message.role === "user" ? studioUi(t, "YOU") : "AI"}
      </div>
      <div className="agent-studio-chat-body">
        <div className="agent-studio-chat-byline">
          <span>
            {message.role === "user"
              ? studioUi(t, "You")
              : studioUi(t, "Agent")}
          </span>
          {stateLabel && (
            <span
              className={`agent-studio-chat-state agent-studio-chat-state--${message.state}`}
            >
              {message.state === "working" && (
                <span className="live-dot" aria-hidden="true" />
              )}
              {stateLabel}
            </span>
          )}
        </div>
        {assistantText != null ? (
          <div className="agent-studio-chat-text">{assistantText}</div>
        ) : structured ? (
          <pre className="agent-studio-chat-json">
            {prettyChatValue(message.content)}
          </pre>
        ) : (
          <div className="agent-studio-chat-text">
            {prettyChatValue(message.content)}
          </div>
        )}
        <div className="agent-studio-chat-meta">
          {message.createdAt && (
            <span>
              {displayTime(message.createdAt, studioLocale(language))}
            </span>
          )}
          {message.runId && (
            <button
              type="button"
              className="agent-studio-chat-run-link"
              aria-pressed={selected}
              onClick={() => onInspectRun(message.runId!)}
            >
              {selected
                ? studioUi(t, "Inspecting this run")
                : studioUi(t, "Inspect run")}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

export function TestLab({
  agentId,
  definition,
  draft,
  liveVersionId,
  canRun,
  draftHasUnsavedChanges,
}: {
  agentId: string;
  definition: StudioDefinition;
  draft: StudioDraftTarget | null;
  liveVersionId: string | null;
  canRun: boolean;
  draftHasUnsavedChanges: boolean;
}) {
  const tenant = useTenant();
  const { language, t } = useI18n();
  const promptInput = definition.inputs.find(
    (input) => input.kind === "prompt",
  );
  const variableInputs = definition.inputs.filter(
    (input) => input.kind !== "prompt",
  );
  // A chat turn must always be authored by the operator. Legacy manifest
  // agents receive a synthetic prompt default ("Process the incoming workflow
  // event…") during normalization; pre-filling it here makes Send look ready
  // even though no user message has been entered. Keep defaults/examples in
  // the definition for non-chat runtimes, but start the conversation composer
  // empty and let its placeholder explain what belongs here.
  const [prompt, setPrompt] = useState("");
  const [inputs, setInputs] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      variableInputs.map((input) => [input.id, valueForInput(input)]),
    ),
  );
  const [inputMode, setInputMode] = useState<"form" | "json">("form");
  const [target, setTarget] = useState<"draft" | "live">(
    draft ? "draft" : "live",
  );
  const [toolPolicy, setToolPolicy] = useState<"safe" | "simulate" | "live">(
    "safe",
  );
  const [resultTab, setResultTab] = useState<ResultTab>("chat");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [conversationTarget, setConversationTarget] = useState<
    CreateAgentRunRequest["target"] | null
  >(null);
  const [triggerEvent, setTriggerEvent] = useState(definition.trigger[0] ?? "");
  const [conversationTriggerEvent, setConversationTriggerEvent] = useState<
    string | undefined
  >();
  const [pendingTurn, setPendingTurn] = useState<PendingChatTurn | null>(null);
  const [lastDispatch, setLastDispatch] = useState<ChatDispatchReceipt | null>(
    null,
  );
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [manualModelEntry, setManualModelEntry] = useState(false);
  const [reasoningMode, setReasoningMode] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [reasoningSummary, setReasoningSummary] = useState("");
  const [reasoningContext, setReasoningContext] = useState("");
  const [verbosity, setVerbosity] = useState("");
  const [storeResponse, setStoreResponse] = useState("");
  const [temperature, setTemperature] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState("");
  const [setupPanelWidth, setSetupPanelWidth] = useState<number | null>(null);
  const [historyPanelWidth, setHistoryPanelWidth] = useState(
    TEST_HISTORY_DEFAULT_WIDTH,
  );
  const [historyPanelHeight, setHistoryPanelHeight] = useState(
    TEST_HISTORY_DEFAULT_HEIGHT,
  );
  const [historyOpen, setHistoryOpen] = useState(true);
  const [testGridWidth, setTestGridWidth] = useState(1_500);
  const [historyInline, setHistoryInline] = useState(true);
  const createRun = useCreateAgentRun(agentId);
  const history = useAgentRunHistory(agentId, { limit: 100 });
  const session = useRunSession(sessionId);
  const selectedHistory =
    session.data?.runs.find((row) => row.id === selectedRunId) ??
    history.data?.items.find((row) => row.id === selectedRunId);
  const runIsLive = Boolean(
    selectedRunId && !isTerminalStatus(selectedHistory?.status),
  );
  const trace = useRunTrace(selectedRunId, 0, runIsLive);
  const output = useRunOutput(selectedRunId, runIsLive);
  // Carries the run's `usage` aggregate for the inline execution card.
  const runDetail = useRun(selectedRunId, { live: runIsLive });
  const artifacts = useRunArtifacts(selectedRunId);
  const logs = useRunLogStream(selectedRunId, {
    follow: runIsLive,
    maxLines: 2000,
  });
  const cancelRun = useCancelRun();
  const effectiveProvider = provider || definition.provider;
  const availableModels = useAvailableModels(effectiveProvider);
  const hadDraft = useRef(Boolean(draft));
  const dispatchInFlightRef = useRef(false);
  const hydratedSessionRef = useRef<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const testGridRef = useRef<HTMLDivElement>(null);
  const setupPanelRef = useRef<HTMLElement>(null);
  const artifactFilename = String(
    asRecord(definition.output_config.artifact).filename ?? "output.json",
  );
  const hasPreviewSteps = definition.actions.some(
    (action) => action.type === "delay" || action.type === "subflow",
  );
  const triggerEvents = useMemo(
    () =>
      conversationTriggerEvent &&
      !definition.trigger.includes(conversationTriggerEvent)
        ? [conversationTriggerEvent, ...definition.trigger]
        : definition.trigger,
    [conversationTriggerEvent, definition.trigger],
  );
  const emittedEvents = useMemo(
    () =>
      Array.from(
        new Set(
          definition.triggered_event
            .map((eventName) => eventName.trim())
            .filter(Boolean),
        ),
      ),
    [definition.triggered_event],
  );
  const textOutputKeys = useMemo(
    () => assistantTextOutputKeys(definition.outputs),
    [definition.outputs],
  );
  const historyWidthForBounds = clampPanelWidth(
    historyPanelWidth,
    TEST_HISTORY_MIN_WIDTH,
    TEST_HISTORY_MAX_WIDTH,
  );
  const historyVisibleInline = historyInline && historyOpen;
  const setupPanelMaxWidth = maxTestSetupWidth(
    testGridWidth,
    historyWidthForBounds,
    historyVisibleInline,
  );
  const effectiveSetupPanelWidth =
    setupPanelWidth == null
      ? null
      : clampPanelWidth(
          setupPanelWidth,
          TEST_SETUP_MIN_WIDTH,
          setupPanelMaxWidth,
        );
  const setupWidthForBounds =
    effectiveSetupPanelWidth ??
    Math.round(
      setupPanelRef.current?.getBoundingClientRect().width ??
        TEST_SETUP_MIN_WIDTH,
    );
  const historyPanelMaxWidth = maxTestHistoryWidth(
    testGridWidth,
    setupWidthForBounds,
    historyVisibleInline,
  );
  const effectiveHistoryPanelWidth = clampPanelWidth(
    historyPanelWidth,
    TEST_HISTORY_MIN_WIDTH,
    historyPanelMaxWidth,
  );
  const effectiveHistoryPanelHeight = clampPanelWidth(
    historyPanelHeight,
    TEST_HISTORY_MIN_HEIGHT,
    TEST_HISTORY_MAX_HEIGHT,
  );

  useEffect(() => {
    if (sessionId) return;
    if (draft && !hadDraft.current) setTarget("draft");
    hadDraft.current = Boolean(draft);
    if (!draft && target === "draft") setTarget("live");
    if (!liveVersionId && target === "live" && draft) setTarget("draft");
  }, [draft, liveVersionId, sessionId, target]);

  useEffect(() => {
    if (sessionId) return;
    setTriggerEvent((current) =>
      definition.trigger.includes(current)
        ? current
        : (definition.trigger[0] ?? ""),
    );
  }, [definition.trigger, sessionId]);

  useEffect(() => {
    const element = testGridRef.current;
    if (!element) return;

    const updateBounds = () => {
      const nextWidth = Math.max(
        0,
        Math.round(element.getBoundingClientRect().width),
      );
      setTestGridWidth(nextWidth);
      setHistoryInline(testHistoryFitsInline(nextWidth));
    };

    updateBounds();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateBounds);
    observer?.observe(element);
    window.addEventListener("resize", updateBounds);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateBounds);
    };
  }, []);

  useEffect(() => {
    const continuation = session.data?.continuation;
    if (
      !sessionId ||
      !continuation ||
      hydratedSessionRef.current === sessionId
    ) {
      return;
    }
    // A saved chat owns its execution target, trigger and structured inputs.
    // Hydrate from the server instead of guessing from the current editor,
    // which may now point at another draft revision or trigger.
    hydratedSessionRef.current = sessionId;
    setConversationTarget(continuation.target);
    setConversationTriggerEvent(continuation.triggerEvent);
    setTarget(continuation.target.kind);
    setInputs(continuation.inputs);
    setToolPolicy(continuation.toolPolicy);
  }, [session.data?.continuation, sessionId]);

  const activeStatus = isTerminalStatus(selectedHistory?.status)
    ? selectedHistory!.status
    : (output.data?.status ??
      selectedHistory?.status ??
      (selectedRunId ? "queued" : null));
  const selectedOutputText =
    output.data?.output == null ? "" : prettyJsonOutput(output.data.output);
  const selectedOutputPlaceholder = !selectedRunId
    ? studioUi(
        t,
        "Run the agent or select a saved run to inspect its JSON output.",
      )
    : output.isLoading
      ? studioUi(t, "Loading the selected run output…")
      : output.isError
        ? formatAgentStudioError(output.error, t)
        : output.data && !isTerminalStatus(output.data.status)
          ? studioUi(t, "The selected run is still producing output…")
          : studioUi(t, "This run did not produce a validated JSON output.");
  const reasoningSummaries = useMemo(
    () =>
      (trace.data?.events ?? []).filter(
        (event) => event.name === "llm.reasoning_summary" && event.summary,
      ),
    [trace.data],
  );
  const chatTranscript = useMemo(() => {
    const fallbackOutputs = new Map<string, unknown>();
    if (selectedRunId && output.data?.status === "ok") {
      fallbackOutputs.set(selectedRunId, output.data.output);
    }
    return buildChatTranscript(session.data, fallbackOutputs);
  }, [output.data, selectedRunId, session.data]);
  const pendingTurnIsPersisted = Boolean(
    pendingTurn?.runId &&
    session.data?.messages.some(
      (message) =>
        message.role === "user" && message.runId === pendingTurn.runId,
    ),
  );
  const missingRequired = variableInputs.filter((input) => {
    if (!input.required) return false;
    const value = inputs[input.id];
    if (input.kind === "file") {
      if (Array.isArray(value)) return value.length === 0;
      if (isRecord(value)) {
        return (
          typeof value.dataUrl !== "string" &&
          typeof value.artifactId !== "string"
        );
      }
    }
    return value == null || value === "";
  });
  const parsedTemperature = Number(temperature);
  const parsedMaxTokens = Number(maxTokens);
  const parsedTimeoutSeconds = Number(timeoutSeconds);
  const modelOverride = model.trim();
  const effectiveModel = modelOverride || definition.model;
  const catalogModelCapabilities =
    effectiveProvider && effectiveModel
      ? findCatalogModel(effectiveProvider as ProviderId, effectiveModel)
      : undefined;
  const discoveredModelCapabilities = availableModels.data?.models.find(
    (candidate) => candidate.id === effectiveModel.replace(/^~/, ""),
  );
  const modelCapabilities = {
    reasoningModes: discoveredModelCapabilities?.reasoningModes.length
      ? discoveredModelCapabilities.reasoningModes
      : catalogModelCapabilities?.reasoningModes,
    reasoningEfforts: discoveredModelCapabilities?.reasoningEfforts.length
      ? discoveredModelCapabilities.reasoningEfforts
      : catalogModelCapabilities?.reasoningEfforts,
    reasoningSummaries: catalogModelCapabilities?.reasoningSummaries,
    reasoningContexts: catalogModelCapabilities?.reasoningContexts,
    textVerbosities: discoveredModelCapabilities?.textVerbosities.length
      ? discoveredModelCapabilities.textVerbosities
      : catalogModelCapabilities?.textVerbosities,
    temperatureRange:
      discoveredModelCapabilities?.temperatureRange !== undefined
        ? discoveredModelCapabilities.temperatureRange
        : catalogModelCapabilities?.temperatureRange,
  };
  const temperatureUnsupported = modelCapabilities.temperatureRange === null;
  const temperatureMin = modelCapabilities.temperatureRange?.min ?? 0;
  const temperatureMax = modelCapabilities.temperatureRange?.max ?? 2;
  const modelIds = providerModelIds(
    effectiveProvider,
    availableModels.data?.models,
  );
  const modelOptions = testModelOptions({
    providerOverride: provider,
    effectiveProvider,
    inheritedModel: definition.model,
    modelIds,
  });
  const modelDiscoveryPending =
    Boolean(effectiveProvider) &&
    availableModels.isLoading &&
    modelIds.length === 0;
  const showModelSelector =
    Boolean(effectiveProvider) &&
    (modelIds.length > 0 || modelDiscoveryPending);
  const providerModelMissing = providerOverrideNeedsModel(provider, model);
  const reasoningOverride: ReasoningConfig = {
    ...(reasoningMode ? { mode: reasoningMode as ReasoningMode } : {}),
    ...(reasoningEffort ? { effort: reasoningEffort as ReasoningEffort } : {}),
    ...(reasoningSummary
      ? { summary: reasoningSummary as ReasoningSummary }
      : {}),
    ...(reasoningContext
      ? { context: reasoningContext as ReasoningContext }
      : {}),
  };
  const hasReasoningOverride = Object.keys(reasoningOverride).length > 0;
  const numericRuntimeOverridesInvalid = Boolean(
    (!temperatureUnsupported &&
      temperature.trim() &&
      (!Number.isFinite(parsedTemperature) ||
        parsedTemperature < temperatureMin ||
        parsedTemperature > temperatureMax)) ||
    (maxTokens.trim() &&
      (!Number.isInteger(parsedMaxTokens) || parsedMaxTokens <= 0)) ||
    (timeoutSeconds.trim() &&
      (!Number.isInteger(parsedTimeoutSeconds) || parsedTimeoutSeconds <= 0)),
  );
  const runtimeOverridesInvalid =
    numericRuntimeOverridesInvalid || providerModelMissing;
  const draftNotReady =
    !sessionId && target === "draft" && draftHasUnsavedChanges;
  const sessionHasActiveRun = Boolean(
    session.data?.runs.some((run) => !isTerminalStatus(run.status)),
  );
  const conversationBusy =
    createRun.isPending ||
    sessionHasActiveRun ||
    Boolean(selectedRunId && activeStatus && !isTerminalStatus(activeStatus));
  const targetUnavailable = sessionId
    ? !conversationTarget
    : target === "draft"
      ? !draft
      : !liveVersionId;
  const submitDisabled =
    !canRun ||
    !prompt.trim() ||
    missingRequired.length > 0 ||
    runtimeOverridesInvalid ||
    draftNotReady ||
    targetUnavailable ||
    conversationBusy;

  useEffect(() => {
    if (resultTab !== "chat") return;
    chatEndRef.current?.scrollIntoView({
      block: "end",
    });
  }, [
    activeStatus,
    chatTranscript.length,
    pendingTurn?.runId,
    pendingTurn?.state,
    resultTab,
  ]);

  useEffect(() => {
    if (pendingTurnIsPersisted) setPendingTurn(null);
  }, [pendingTurnIsPersisted]);

  useEffect(() => {
    if (!isTerminalStatus(selectedHistory?.status)) return;
    void trace.refetch();
    void output.refetch();
    void artifacts.refetch();
  }, [
    selectedHistory?.status,
    trace.refetch,
    output.refetch,
    artifacts.refetch,
  ]);

  async function run() {
    if (submitDisabled || dispatchInFlightRef.current) return;
    dispatchInFlightRef.current = true;
    const submittedPrompt = prompt;
    const requestedTarget: CreateAgentRunRequest["target"] | null = sessionId
      ? conversationTarget
      : target === "draft" && draft
        ? { kind: "draft", draftId: draft.id, revision: draft.revision }
        : target === "live" && liveVersionId
          ? { kind: "live", agentVersionId: liveVersionId }
          : null;
    if (!requestedTarget) {
      dispatchInFlightRef.current = false;
      return;
    }
    const requestedTriggerEvent = sessionId
      ? conversationTriggerEvent
      : triggerEvent || undefined;
    setPendingTurn({
      prompt: submittedPrompt,
      state: "publishing",
      runId: null,
      eventId: null,
      eventName: requestedTriggerEvent ?? null,
    });
    try {
      const response = await createRun.mutateAsync(
        buildStudioChatRunRequest({
          ...(sessionId ? { sessionId } : {}),
          target: requestedTarget,
          ...(requestedTriggerEvent
            ? { triggerEvent: requestedTriggerEvent }
            : {}),
          prompt: submittedPrompt,
          inputs,
          toolPolicy,
          runtimeOverrides: {
            ...(provider ? { provider: provider as ProviderId } : {}),
            ...(modelOverride ? { model: modelOverride } : {}),
            ...(hasReasoningOverride ? { reasoning: reasoningOverride } : {}),
            ...(verbosity ? { verbosity: verbosity as TextVerbosity } : {}),
            ...(storeResponse ? { store: storeResponse === "true" } : {}),
            ...(!temperatureUnsupported &&
            temperature.trim() &&
            Number.isFinite(parsedTemperature)
              ? { temperature: parsedTemperature }
              : {}),
            ...(maxTokens.trim() &&
            Number.isInteger(parsedMaxTokens) &&
            parsedMaxTokens > 0
              ? { maxTokens: parsedMaxTokens }
              : {}),
            ...(timeoutSeconds.trim() &&
            Number.isInteger(parsedTimeoutSeconds) &&
            parsedTimeoutSeconds > 0
              ? { timeoutS: parsedTimeoutSeconds }
              : {}),
          },
        }),
      );
      setSelectedRunId(response.runId);
      setSessionId(response.sessionId);
      setConversationTarget(requestedTarget);
      setConversationTriggerEvent(response.eventName);
      setLastDispatch({
        runId: response.runId,
        eventId: response.eventId,
        eventName: response.eventName,
      });
      setPendingTurn({
        prompt: submittedPrompt,
        state: "queued",
        runId: response.runId,
        eventId: response.eventId,
        eventName: response.eventName,
      });
      setPrompt("");
      setResultTab("chat");
    } catch {
      setPendingTurn(null);
      // The mutation exposes its typed error below the controls. Absorb the
      // rejected mutateAsync promise so a failed dispatch is never unhandled.
    } finally {
      dispatchInFlightRef.current = false;
    }
  }

  function clearModelSpecificOverrides() {
    setReasoningMode("");
    setReasoningEffort("");
    setReasoningSummary("");
    setReasoningContext("");
    setVerbosity("");
    setStoreResponse("");
    setTemperature("");
  }

  function changeProvider(nextProvider: string) {
    setProvider(nextProvider);
    setModel("");
    setManualModelEntry(false);
    clearModelSpecificOverrides();
  }

  function changeCatalogModel(nextModel: string) {
    if (nextModel === CUSTOM_MODEL_OPTION) {
      setModel("");
      setManualModelEntry(true);
    } else {
      setModel(nextModel);
      setManualModelEntry(false);
    }
    clearModelSpecificOverrides();
  }

  function changeManualModel(nextModel: string) {
    setModel(nextModel);
    clearModelSpecificOverrides();
  }

  function newChat() {
    hydratedSessionRef.current = null;
    setSessionId(undefined);
    setSelectedRunId(null);
    setConversationTarget(null);
    setConversationTriggerEvent(undefined);
    setTriggerEvent(definition.trigger[0] ?? "");
    setPendingTurn(null);
    setLastDispatch(null);
    setPrompt("");
    setResultTab("chat");
    createRun.reset();
  }

  return (
    <div className="agent-studio-test-lab" style={{ display: "grid", gap: 14 }}>
      {/* The standing "uses the real runtime" banner is now the `RuntimeHint`
          hover/focus tooltip beside the Conversation heading — it is read once
          but the vertical space it took was paid on every run. */}
      {hasPreviewSteps && (
        <InlineNotice
          tone="amber"
          title={studioUi(t, "Preview steps in this definition")}
        >
          {studioUi(
            t,
            "Delay and subflow steps are recorded in the trace, but delays do not wait and subflows are not invoked by the production runtime yet.",
          )}
        </InlineNotice>
      )}
      <div
        ref={testGridRef}
        className={`agent-studio-test-grid${historyOpen ? "" : " agent-studio-test-grid--history-closed"}`}
        style={
          {
            display: "grid",
            minHeight: 600,
            border: "1px solid var(--border)",
            borderRadius: 7,
            overflow: "hidden",
            background: "var(--panel)",
            "--agent-studio-test-setup-width":
              effectiveSetupPanelWidth == null
                ? undefined
                : `${effectiveSetupPanelWidth}px`,
            "--agent-studio-test-history-width": `${effectiveHistoryPanelWidth}px`,
            "--agent-studio-test-history-height": `${effectiveHistoryPanelHeight}px`,
          } as CSSProperties
        }
      >
        <section
          id="agent-studio-test-setup-panel"
          ref={setupPanelRef}
          className="agent-studio-test-setup"
          style={{
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          <div
            className="agent-studio-test-panel-header"
            style={{
              padding: 12,
              borderBottom: "1px solid var(--border)",
              display: "flex",
              gap: 8,
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{ color: "var(--text)", fontSize: 12, fontWeight: 600 }}
              >
                {studioUi(t, "Test setup")}
              </div>
              <div
                style={{ color: "var(--text-3)", fontSize: 10.5, marginTop: 2 }}
              >
                {studioUi(t, "Structured inputs and runtime settings")}
              </div>
            </div>
            {sessionId ? (
              <Badge tone="blue">
                {target === "draft"
                  ? studioUi(t, "Draft")
                  : studioUi(t, "Live")}{" "}
                · {studioUi(t, "locked")}
              </Badge>
            ) : (
              <Segmented
                ariaLabel={studioUi(t, "Version to test")}
                value={target}
                onChange={setTarget}
                options={[
                  ...(draft
                    ? [
                        {
                          value: "draft" as const,
                          label: studioUi(t, "Draft"),
                        },
                      ]
                    : []),
                  ...(liveVersionId
                    ? [
                        {
                          value: "live" as const,
                          label: studioUi(t, "Live"),
                        },
                      ]
                    : []),
                ]}
              />
            )}
          </div>
          <div
            className="agent-studio-test-target-note"
            style={{
              padding: "7px 12px",
              borderBottom: "1px solid var(--border)",
              color: "var(--text-3)",
              fontSize: 10,
              lineHeight: 1.4,
            }}
          >
            {sessionId
              ? studioUi(
                  t,
                  "{target} is pinned for this conversation. Start a new chat to change it.",
                  {
                    target:
                      target === "draft"
                        ? studioUi(t, "Draft")
                        : studioUi(t, "Live"),
                  },
                )
              : target === "draft"
                ? studioUi(
                    t,
                    "Draft runs test your saved changes without changing the live agent.",
                  )
                : studioUi(
                    t,
                    "Live runs use the currently published version—the same version production callers use.",
                  )}
          </div>
          <div
            className="agent-studio-test-setup-body"
            style={{
              flex: 1,
              overflow: "auto",
              padding: 12,
              display: "grid",
              gap: 14,
              alignContent: "start",
            }}
          >
            {variableInputs.length > 0 && (
              <div>
                <div
                  className="agent-studio-test-section-toolbar"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 8,
                  }}
                >
                  <span
                    style={{
                      color: "var(--text)",
                      fontSize: 11.5,
                      fontWeight: 500,
                    }}
                  >
                    {studioUi(t, "Input variables")}
                  </span>
                  <Segmented
                    ariaLabel={studioUi(t, "Input editor view")}
                    value={inputMode}
                    onChange={setInputMode}
                    options={[
                      { value: "form", label: studioUi(t, "Form") },
                      { value: "json", label: "JSON" },
                    ]}
                  />
                </div>
                {inputMode === "json" ? (
                  <JsonValueEditor
                    value={inputs}
                    onChange={(value) => setInputs(asRecord(value))}
                    height={230}
                    label={studioUi(t, "All test inputs")}
                    hint={studioUi(
                      t,
                      "Advanced view of the same form fields. Each key must match an input's internal field name.",
                    )}
                    example={'{"customer_tier":"gold","language":"en"}'}
                  />
                ) : (
                  <div style={{ display: "grid", gap: 12 }}>
                    {variableInputs.map((input) => (
                      <Field
                        key={input.id}
                        label={input.label}
                        required={input.required}
                        hint={
                          input.description ||
                          studioUi(
                            t,
                            "Enter the {field} expected by this agent.",
                            { field: input.label.toLowerCase() },
                          )
                        }
                        example={
                          input.example == null
                            ? undefined
                            : typeof input.example === "string"
                              ? input.example
                              : toPrettyJson(input.example)
                        }
                      >
                        <VariableControl
                          input={input}
                          value={inputs[input.id]}
                          onChange={(value) =>
                            setInputs((current) => ({
                              ...current,
                              [input.id]: value,
                            }))
                          }
                        />
                      </Field>
                    ))}
                  </div>
                )}
              </div>
            )}
            {triggerEvents.length > 0 && (
              <Field
                label={studioUi(t, "Trigger event")}
                hint={
                  sessionId
                    ? studioUi(
                        t,
                        "Pinned for every message in this conversation.",
                      )
                    : studioUi(
                        t,
                        "Pressing Send publishes this event to start the agent.",
                      )
                }
              >
                <SelectInput
                  value={
                    sessionId
                      ? (conversationTriggerEvent ?? triggerEvent)
                      : triggerEvent
                  }
                  onChange={setTriggerEvent}
                  disabled={Boolean(sessionId)}
                  options={triggerEvents.map((name) => ({
                    value: name,
                    label: name,
                  }))}
                />
              </Field>
            )}
            <div>
              <div
                style={{
                  marginBottom: 4,
                  color: "var(--text)",
                  fontSize: 11,
                  fontWeight: 500,
                }}
              >
                {emittedEvents.length === 1
                  ? studioUi(t, "Emit event")
                  : studioUi(t, "Emit events")}
              </div>
              <div
                style={{
                  marginBottom: 6,
                  color: "var(--text-3)",
                  fontSize: 10.5,
                  lineHeight: 1.45,
                }}
              >
                {studioUi(
                  t,
                  "Configured outgoing events. Successful runs can publish them to continue downstream workflow steps.",
                )}
              </div>
              {emittedEvents.length > 0 ? (
                <div
                  className="agent-studio-test-event-list"
                  role="list"
                  aria-label={studioUi(t, "Emitted events")}
                >
                  {emittedEvents.map((name) => (
                    <span
                      key={name}
                      className="agent-studio-test-event-chip"
                      role="listitem"
                      title={name}
                    >
                      {name}
                    </span>
                  ))}
                </div>
              ) : (
                <div
                  className="agent-studio-test-event-list agent-studio-test-event-empty"
                  role="status"
                >
                  {studioUi(t, "No emitted events configured")}
                </div>
              )}
            </div>
            <details className="agent-studio-output-details">
              <summary>
                <span>{studioUi(t, "JSON OUTPUT")}</span>
                <span>
                  {selectedRunId
                    ? (activeStatus ?? studioUi(t, "selected run"))
                    : studioUi(t, "no run selected")}
                </span>
              </summary>
              <div className="agent-studio-output-details__body">
                <textarea
                  aria-label={studioUi(t, "Selected run JSON output")}
                  aria-busy={output.isLoading}
                  readOnly
                  spellCheck={false}
                  rows={10}
                  value={selectedOutputText}
                  placeholder={selectedOutputPlaceholder}
                />
                <div className="agent-studio-output-details__hint">
                  {selectedOutputText
                    ? studioUi(
                        t,
                        "Complete validated output for the selected run. This remains JSON even when the conversation shows only its response text.",
                      )
                    : selectedOutputPlaceholder}
                </div>
              </div>
            </details>
            <details
              className="agent-studio-test-advanced"
              open={runtimeOpen}
              onToggle={(event) => setRuntimeOpen(event.currentTarget.open)}
              style={{ borderTop: "1px solid var(--border)", paddingTop: 9 }}
            >
              <summary
                className="mono"
                style={{
                  cursor: "pointer",
                  color: "var(--text-3)",
                  fontSize: 10.5,
                }}
              >
                {studioUi(t, "ADVANCED TEST SETTINGS")}
              </summary>
              <div
                className="agent-studio-test-advanced-body"
                style={{ display: "grid", gap: 10, marginTop: 10 }}
              >
                <Field
                  label={studioUi(t, "What tools may change")}
                  hint={studioUi(
                    t,
                    "Safe is recommended and runs only tools explicitly approved for tests. Read-only permits approved reads but blocks writes. Live can change connected systems.",
                  )}
                >
                  <SelectInput
                    value={toolPolicy}
                    onChange={(value) =>
                      setToolPolicy(value as typeof toolPolicy)
                    }
                    options={[
                      {
                        value: "safe",
                        label: studioUi(
                          t,
                          "Safe test — approved test tools only",
                        ),
                      },
                      {
                        value: "simulate",
                        label: studioUi(
                          t,
                          "Read-only — approved reads, writes blocked",
                        ),
                      },
                      {
                        value: "live",
                        label: studioUi(
                          t,
                          "Live effects — allow configured changes",
                        ),
                      },
                    ]}
                  />
                </Field>
                {toolPolicy === "live" && (
                  <InlineNotice
                    tone="amber"
                    title={studioUi(t, "External side effects enabled")}
                  >
                    {studioUi(
                      t,
                      "This run may write files, call third-party services, or change downstream systems through the agent's allowed tools.",
                    )}
                  </InlineNotice>
                )}
                <div className="agent-studio-test-runtime-grid agent-studio-test-runtime-grid--pair">
                  <Field
                    label={studioUi(t, "Temporary AI provider")}
                    hint={studioUi(
                      t,
                      "Only changes this test run. Leave inherited to test the agent exactly as configured.",
                    )}
                  >
                    <SelectInput
                      value={provider}
                      onChange={changeProvider}
                      options={RUN_PROVIDERS.map((value) => ({
                        value,
                        label:
                          value ||
                          studioUi(t, "Use agent / workspace{provider}", {
                            provider: definition.provider
                              ? ` (${definition.provider})`
                              : "",
                          }),
                      }))}
                    />
                  </Field>
                  <Field
                    label={studioUi(t, "Temporary AI model")}
                    required={providerModelMissing}
                    hint={
                      providerModelMissing
                        ? studioUi(
                            t,
                            "Choose or enter a model for {provider}. A temporary provider override must send an explicit provider/model pair.",
                            { provider: effectiveProvider },
                          )
                        : !effectiveProvider
                          ? studioUi(
                              t,
                              "Select a provider to browse its models, or enter a workspace model ID manually.",
                            )
                          : showModelSelector
                            ? studioUi(
                                t,
                                "Choose a model available from {provider}, or enter a custom model ID.",
                                { provider: effectiveProvider },
                              )
                            : studioUi(
                                t,
                                "Enter the model or deployment ID expected by {provider}; no provider model list is available.",
                                { provider: effectiveProvider },
                              )
                    }
                  >
                    <div style={{ display: "grid", gap: 6 }}>
                      {showModelSelector ? (
                        <SelectInput
                          value={manualModelEntry ? CUSTOM_MODEL_OPTION : model}
                          onChange={changeCatalogModel}
                          disabled={modelDiscoveryPending}
                          options={
                            modelDiscoveryPending
                              ? [
                                  {
                                    value: "",
                                    label: studioUi(
                                      t,
                                      "Loading {provider} models…",
                                      { provider: effectiveProvider },
                                    ),
                                  },
                                ]
                              : modelOptions.map((option) => ({
                                  ...option,
                                  label:
                                    option.value === CUSTOM_MODEL_OPTION
                                      ? studioUi(t, "Enter a custom model ID…")
                                      : option.value
                                        ? option.label
                                        : provider
                                          ? studioUi(
                                              t,
                                              "Choose a model from {provider}",
                                              { provider: effectiveProvider },
                                            )
                                          : definition.model
                                            ? studioUi(
                                                t,
                                                "Use agent / workspace ({model})",
                                                { model: definition.model },
                                              )
                                            : studioUi(
                                                t,
                                                "Use agent / workspace model",
                                              ),
                                }))
                          }
                        />
                      ) : null}
                      {(!showModelSelector || manualModelEntry) && (
                        <TextInput
                          value={model}
                          mono
                          placeholder={
                            provider
                              ? studioUi(t, "Enter a {provider} model ID", {
                                  provider,
                                })
                              : definition.model ||
                                studioUi(t, "Use agent / workspace model")
                          }
                          onChange={changeManualModel}
                        />
                      )}
                    </div>
                  </Field>
                </div>
                {(modelCapabilities?.reasoningModes?.length ||
                  modelCapabilities?.reasoningEfforts?.length ||
                  modelCapabilities?.reasoningSummaries?.length ||
                  modelCapabilities?.reasoningContexts?.length ||
                  modelCapabilities?.textVerbosities?.length ||
                  effectiveProvider === "openai" ||
                  effectiveProvider === "openrouter") && (
                  <div className="agent-studio-test-runtime-grid agent-studio-test-runtime-grid--pair">
                    {modelCapabilities?.reasoningModes?.length ? (
                      <Field
                        label={studioUi(t, "Temporary reasoning mode")}
                        hint={studioUi(
                          t,
                          "Standard balances quality and latency; Pro uses the model's highest-compute execution path.",
                        )}
                      >
                        <SelectInput
                          value={reasoningMode}
                          onChange={setReasoningMode}
                          options={[
                            {
                              value: "",
                              label: studioUi(t, "Use agent / model{setting}", {
                                setting: asRecord(definition.reasoning).mode
                                  ? ` (${String(asRecord(definition.reasoning).mode)})`
                                  : ` ${studioUi(t, "default")}`,
                              }),
                            },
                            ...modelCapabilities.reasoningModes.map(
                              (value) => ({
                                value,
                                label: value,
                              }),
                            ),
                          ]}
                        />
                      </Field>
                    ) : null}
                    {modelCapabilities?.reasoningEfforts?.length ? (
                      <Field
                        label={studioUi(t, "Temporary reasoning effort")}
                        hint={studioUi(
                          t,
                          "Higher effort may improve difficult reasoning while increasing latency and reasoning-token cost.",
                        )}
                      >
                        <SelectInput
                          value={reasoningEffort}
                          onChange={setReasoningEffort}
                          options={[
                            {
                              value: "",
                              label: studioUi(t, "Use agent / model{setting}", {
                                setting: asRecord(definition.reasoning).effort
                                  ? ` (${String(asRecord(definition.reasoning).effort)})`
                                  : ` ${studioUi(t, "default")}`,
                              }),
                            },
                            ...modelCapabilities.reasoningEfforts.map(
                              (value) => ({
                                value,
                                label: value,
                              }),
                            ),
                          ]}
                        />
                      </Field>
                    ) : null}
                    {modelCapabilities?.reasoningSummaries?.length ? (
                      <Field
                        label={studioUi(t, "Temporary reasoning summary")}
                        hint={studioUi(
                          t,
                          "Requests a safe provider-generated summary; raw chain-of-thought is never recorded.",
                        )}
                      >
                        <SelectInput
                          value={reasoningSummary}
                          onChange={setReasoningSummary}
                          options={[
                            {
                              value: "",
                              label: studioUi(t, "Use agent / model default"),
                            },
                            ...modelCapabilities.reasoningSummaries.map(
                              (value) => ({
                                value,
                                label: value,
                              }),
                            ),
                          ]}
                        />
                      </Field>
                    ) : null}
                    {modelCapabilities?.reasoningContexts?.length ? (
                      <Field
                        label={studioUi(t, "Temporary reasoning context")}
                        hint={studioUi(
                          t,
                          "Controls which persisted reasoning items may be reused on later conversation turns.",
                        )}
                      >
                        <SelectInput
                          value={reasoningContext}
                          onChange={setReasoningContext}
                          options={[
                            {
                              value: "",
                              label: studioUi(t, "Use agent / model default"),
                            },
                            ...modelCapabilities.reasoningContexts.map(
                              (value) => ({
                                value,
                                label: value.replaceAll("_", " "),
                              }),
                            ),
                          ]}
                        />
                      </Field>
                    ) : null}
                    {modelCapabilities?.textVerbosities?.length ? (
                      <Field
                        label={studioUi(t, "Temporary answer verbosity")}
                        hint={studioUi(
                          t,
                          "Controls how concise or detailed the model's visible answer should be.",
                        )}
                      >
                        <SelectInput
                          value={verbosity}
                          onChange={setVerbosity}
                          options={[
                            {
                              value: "",
                              label: studioUi(t, "Use agent / model{setting}", {
                                setting: definition.verbosity
                                  ? ` (${definition.verbosity})`
                                  : ` ${studioUi(t, "default")}`,
                              }),
                            },
                            ...modelCapabilities.textVerbosities.map(
                              (value) => ({
                                value,
                                label: value,
                              }),
                            ),
                          ]}
                        />
                      </Field>
                    ) : null}
                    {effectiveProvider === "openai" ||
                    effectiveProvider === "openrouter" ? (
                      <Field
                        label={studioUi(t, "Temporary provider storage")}
                        hint={studioUi(
                          t,
                          "Controls upstream response retention for this test. Local run logs and usage accounting are separate.",
                        )}
                      >
                        <SelectInput
                          value={storeResponse}
                          onChange={setStoreResponse}
                          options={[
                            {
                              value: "",
                              label: studioUi(t, "Use agent / service default"),
                            },
                            {
                              value: "false",
                              label: studioUi(t, "Do not store upstream"),
                            },
                            ...(effectiveProvider === "openai"
                              ? [
                                  {
                                    value: "true",
                                    label: studioUi(t, "Store upstream"),
                                  },
                                ]
                              : []),
                          ]}
                        />
                      </Field>
                    ) : null}
                  </div>
                )}
                <div className="agent-studio-test-runtime-grid agent-studio-test-runtime-grid--numeric">
                  <Field
                    label={studioUi(t, "Temporary creativity")}
                    hint={
                      temperatureUnsupported
                        ? studioUi(
                            t,
                            "{model} does not support temperature. The saved agent setting is omitted for this test.",
                            {
                              model: `${effectiveProvider}/${effectiveModel.replace(/^~/, "")}`,
                            },
                          )
                        : `${studioUi(t, "0 is consistent; higher values are more varied. Leave blank to use the agent setting.")}${
                            modelCapabilities.temperatureRange
                              ? ` ${studioUi(
                                  t,
                                  "Accepted range: {min}–{max}.",
                                  {
                                    min: temperatureMin,
                                    max: temperatureMax,
                                  },
                                )}`
                              : ""
                          }`
                    }
                    example={temperatureUnsupported ? undefined : "0.2"}
                  >
                    <TextInput
                      value={temperature}
                      type="number"
                      min={temperatureMin}
                      max={temperatureMax}
                      disabled={temperatureUnsupported}
                      placeholder={
                        temperatureUnsupported
                          ? studioUi(t, "Not supported — omitted")
                          : studioUi(t, "Agent: {value}", {
                              value: definition.temperature,
                            })
                      }
                      onChange={setTemperature}
                    />
                  </Field>
                  <Field
                    label={studioUi(t, "Temporary answer length")}
                    hint={studioUi(
                      t,
                      "Maximum tokens for this test. Leave blank to use the agent setting.",
                    )}
                    example="2000"
                  >
                    <TextInput
                      value={maxTokens}
                      type="number"
                      min={1}
                      placeholder={studioUi(t, "Agent: {value}", {
                        value: definition.max_tokens,
                      })}
                      onChange={setMaxTokens}
                    />
                  </Field>
                  <Field
                    label={studioUi(t, "Temporary time limit")}
                    hint={studioUi(
                      t,
                      "Stop this test after this many seconds. Leave blank to use the agent setting.",
                    )}
                    example="120"
                  >
                    <TextInput
                      value={timeoutSeconds}
                      type="number"
                      min={1}
                      placeholder={studioUi(t, "Agent: {value}", {
                        value: definition.timeout_s,
                      })}
                      onChange={setTimeoutSeconds}
                    />
                  </Field>
                </div>
                {numericRuntimeOverridesInvalid && (
                  <div style={{ color: "var(--red)", fontSize: 10.5 }}>
                    {studioUi(
                      t,
                      "Temperature must be between {min} and {max}; max tokens and timeout must be positive whole numbers.",
                      { min: temperatureMin, max: temperatureMax },
                    )}
                  </div>
                )}
              </div>
            </details>
          </div>
          {draftNotReady && (
            <div
              style={{
                padding: "0 12px 10px",
                color: "var(--amber)",
                fontSize: 10.5,
              }}
            >
              {studioUi(
                t,
                "Save the current draft changes before running so the test is pinned to this exact revision.",
              )}
            </div>
          )}
          {missingRequired.length > 0 && (
            <div
              style={{
                padding: "0 12px 10px",
                color: "var(--amber)",
                fontSize: 10.5,
              }}
            >
              {studioUi(t, "Complete required inputs:")}{" "}
              {missingRequired.map((input) => input.label).join(", ")}
            </div>
          )}
        </section>

        <div className="agent-studio-test-splitter agent-studio-test-splitter--setup">
          <Splitter
            axis="x"
            getValue={() =>
              effectiveSetupPanelWidth ??
              Math.round(
                setupPanelRef.current?.getBoundingClientRect().width ??
                  TEST_SETUP_MIN_WIDTH,
              )
            }
            setValue={setSetupPanelWidth}
            min={TEST_SETUP_MIN_WIDTH}
            max={setupPanelMaxWidth}
            ariaLabel={studioUi(t, "Resize Test setup and Conversation panels")}
            ariaControls="agent-studio-test-setup-panel agent-studio-test-conversation-panel"
          />
        </div>

        <section
          id="agent-studio-test-conversation-panel"
          className="agent-studio-test-conversation"
          style={{
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            className="agent-studio-test-panel-header agent-studio-test-conversation-header"
            style={{
              minHeight: 54,
              padding: "10px 12px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                <span
                  style={{
                    color: "var(--text)",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {studioUi(t, "Conversation")}
                </span>
                <RuntimeHint />
                {activeStatus && (
                  <Badge tone={statusTone(activeStatus)}>
                    {studioUi(t, activeStatus)}
                  </Badge>
                )}
                {output.data?.outputValid != null && (
                  <Badge tone={output.data.outputValid ? "green" : "red"}>
                    {output.data.outputValid
                      ? studioUi(t, "Schema valid")
                      : studioUi(t, "Invalid output")}
                  </Badge>
                )}
                {lastDispatch?.runId === selectedRunId && (
                  <Link
                    href={`/portal/${tenant}/events?eventId=${encodeURIComponent(lastDispatch.eventId)}`}
                    title={studioUi(t, "Trigger event {event}", {
                      event: lastDispatch.eventId,
                    })}
                    style={{ display: "inline-flex" }}
                  >
                    <Badge tone="muted">
                      {studioUi(t, "event")} · {lastDispatch.eventName}
                    </Badge>
                  </Link>
                )}
              </div>
              <div
                style={{ color: "var(--text-3)", fontSize: 10, marginTop: 3 }}
              >
                {sessionId
                  ? session.data?.session.title ||
                    studioUi(t, "Session {id}…", {
                      id: sessionId.slice(0, 12),
                    })
                  : studioUi(t, "Start a chat to test the agent")}
              </div>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                flexWrap: "wrap",
                gap: 7,
              }}
            >
              <Button
                small
                tone="ghost"
                icon="logs"
                title={
                  historyOpen
                    ? studioUi(t, "Hide run history")
                    : studioUi(t, "Show run history")
                }
                onClick={() => setHistoryOpen((open) => !open)}
                ariaLabel={
                  historyOpen
                    ? studioUi(t, "Hide run history")
                    : studioUi(t, "Show run history")
                }
                ariaControls="agent-studio-test-history-panel"
                ariaExpanded={historyOpen}
              >
                {studioUi(t, "History")}
              </Button>
              {sessionId && (
                <Button small disabled={conversationBusy} onClick={newChat}>
                  {studioUi(t, "New chat")}
                </Button>
              )}
              {activeStatus && !isTerminalStatus(activeStatus) && (
                <Button
                  small
                  tone="danger"
                  icon="x"
                  disabled={!selectedRunId || cancelRun.isPending}
                  onClick={() =>
                    selectedRunId && cancelRun.mutate(selectedRunId)
                  }
                >
                  {studioUi(t, "Stop")}
                </Button>
              )}
              {selectedRunId && (
                <Link
                  href={`/portal/${tenant}/runs/${selectedRunId}`}
                  style={{ color: "var(--blue)", fontSize: 10.5 }}
                >
                  {studioUi(t, "Open full run ↗")}
                </Link>
              )}
            </div>
          </div>
          <div
            role="tablist"
            aria-label={studioUi(t, "Run details")}
            className="agent-studio-test-result-tabs"
            style={{
              padding: "8px 12px",
              display: "flex",
              gap: 6,
              borderBottom: "1px solid var(--border)",
            }}
          >
            {(["chat", "trace", "output", "logs", "artifacts"] as const).map(
              (tab) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={resultTab === tab}
                  key={tab}
                  onClick={() => setResultTab(tab)}
                  style={{
                    padding: "5px 8px",
                    color:
                      resultTab === tab ? "var(--signal)" : "var(--text-3)",
                    borderBottom: `2px solid ${resultTab === tab ? "var(--signal)" : "transparent"}`,
                    fontFamily: "var(--mono)",
                    fontSize: 10.5,
                  }}
                >
                  {studioUi(t, tab)}
                </button>
              ),
            )}
          </div>
          <div
            role="tabpanel"
            className={
              resultTab === "chat" ? "agent-studio-chat-scroll" : undefined
            }
            style={{
              flex: 1,
              minHeight: 0,
              overflow: "auto",
              padding: resultTab === "chat" ? 0 : 12,
            }}
          >
            {resultTab === "chat" ? (
              <div
                className="agent-studio-chat-log"
                role="log"
                aria-label={studioUi(t, "Test Lab conversation")}
                aria-live="polite"
                aria-relevant="additions text"
                aria-busy={conversationBusy}
              >
                {session.isLoading ? (
                  <Empty title={studioUi(t, "Loading conversation…")} />
                ) : session.isError ? (
                  <Empty
                    title={studioUi(t, "Conversation unavailable")}
                    hint={session.error.message}
                  />
                ) : chatTranscript.length ? (
                  chatTranscript.map((message) => (
                    <ChatBubble
                      key={message.id}
                      message={message}
                      selected={message.runId === selectedRunId}
                      textOutputKeys={textOutputKeys}
                      onInspectRun={setSelectedRunId}
                    />
                  ))
                ) : !pendingTurn ? (
                  <div className="agent-studio-chat-welcome">
                    <div className="agent-studio-chat-welcome-mark">AI</div>
                    <h3>{studioUi(t, "Test your agent in a conversation")}</h3>
                    <p>
                      {studioUi(
                        t,
                        "Send an end-user prompt below. The result appears here, and follow-up messages continue with the same session context.",
                      )}
                    </p>
                  </div>
                ) : null}
                {pendingTurn && !pendingTurnIsPersisted && (
                  <>
                    <ChatBubble
                      message={{
                        id: "pending-user-message",
                        role: "user",
                        runId: pendingTurn.runId,
                        content: pendingTurn.prompt,
                        state: "complete",
                        createdAt: null,
                      }}
                      selected={Boolean(
                        pendingTurn.runId &&
                        pendingTurn.runId === selectedRunId,
                      )}
                      textOutputKeys={textOutputKeys}
                      onInspectRun={setSelectedRunId}
                    />
                    <ChatBubble
                      message={{
                        id: "pending-agent-message",
                        role: "assistant",
                        runId: pendingTurn.runId,
                        content:
                          pendingTurn.state === "publishing"
                            ? studioUi(
                                t,
                                "Publishing the trigger event to the agent runtime…",
                              )
                            : studioUi(
                                t,
                                "{event}{id} was accepted. The agent is working on this request…",
                                {
                                  event:
                                    pendingTurn.eventName ??
                                    studioUi(t, "The trigger event"),
                                  id: pendingTurn.eventId
                                    ? ` (${pendingTurn.eventId})`
                                    : "",
                                },
                              ),
                        state: "working",
                        createdAt: null,
                      }}
                      selected={Boolean(
                        pendingTurn.runId &&
                        pendingTurn.runId === selectedRunId,
                      )}
                      textOutputKeys={textOutputKeys}
                      onInspectRun={setSelectedRunId}
                    />
                  </>
                )}
                {selectedRunId && (
                  <RunProgressCard
                    runId={selectedRunId}
                    historyRow={selectedHistory}
                    detail={runDetail.data}
                    traceEvents={trace.data?.events ?? []}
                    traceLoading={trace.isLoading}
                    expectedSteps={definition.actions.length}
                    onOpenTrace={() => setResultTab("trace")}
                  />
                )}
                <div ref={chatEndRef} aria-hidden="true" />
              </div>
            ) : !selectedRunId ? (
              <Empty
                title={studioUi(t, "Run the agent to inspect it")}
                hint={studioUi(
                  t,
                  "The live sequence, reasoning summaries, logs, and output appear here.",
                )}
              />
            ) : resultTab === "trace" ? (
              <div>
                <InlineNotice title={studioUi(t, "Reasoning visibility")}>
                  {studioUi(
                    t,
                    "The studio shows concise model reasoning summaries and tool decisions when enabled. Hidden chain-of-thought is never exposed.",
                  )}
                </InlineNotice>
                {reasoningSummaries.length > 0 && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: 10,
                      border: "1px solid rgba(181,148,255,0.3)",
                      background: "rgba(181,148,255,0.05)",
                      borderRadius: 5,
                    }}
                  >
                    <div
                      className="mono"
                      style={{
                        color: "var(--violet)",
                        fontSize: 10,
                        marginBottom: 6,
                      }}
                    >
                      {studioUi(t, "REASONING SUMMARY")}
                    </div>
                    {reasoningSummaries.map((event) => (
                      <div
                        key={event.id}
                        style={{
                          color: "var(--text-2)",
                          fontSize: 11,
                          lineHeight: 1.55,
                          marginTop: 4,
                        }}
                      >
                        {event.summary}
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: 10 }}>
                  {trace.isLoading ? (
                    <Empty title={studioUi(t, "Loading trace…")} />
                  ) : trace.isError ? (
                    <Empty
                      title={studioUi(t, "Trace unavailable")}
                      hint={trace.error.message}
                    />
                  ) : trace.data?.events.length ? (
                    trace.data.events.map((event) => (
                      <TraceRow key={event.id} event={event} />
                    ))
                  ) : (
                    <Empty
                      title={studioUi(t, "Waiting for the first trace event…")}
                    />
                  )}
                </div>
              </div>
            ) : resultTab === "output" ? (
              output.isLoading ? (
                <Empty title={studioUi(t, "Waiting for output…")} />
              ) : output.isError ? (
                <Empty
                  title={studioUi(t, "Output is not ready")}
                  hint={output.error.message}
                />
              ) : output.data && !isTerminalStatus(output.data.status) ? (
                <Empty
                  title={studioUi(t, "Run is still producing output…")}
                  hint={studioUi(
                    t,
                    "The validated JSON artifact will appear when the run completes.",
                  )}
                />
              ) : output.data?.output == null ? (
                <Empty
                  title={studioUi(t, "No validated output")}
                  hint={
                    selectedHistory?.error ??
                    studioUi(t, "The run finished with status {status}.", {
                      status:
                        output.data?.status ??
                        activeStatus ??
                        studioUi(t, "unknown"),
                    })
                  }
                />
              ) : (
                <div>
                  <div style={{ display: "flex", gap: 7, marginBottom: 8 }}>
                    <Badge tone="green">
                      {output.data.artifact?.logicalName ?? artifactFilename}
                    </Badge>
                    {output.data.artifact && (
                      <Badge tone="muted">
                        {studioUi(t, "{count} bytes", {
                          count: output.data.artifact.size,
                        })}
                      </Badge>
                    )}
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: 12,
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                      background: "var(--bg-2)",
                      color: "var(--text-2)",
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      lineHeight: 1.55,
                      overflow: "auto",
                    }}
                  >
                    {prettyJsonOutput(output.data.output)}
                  </pre>
                </div>
              )
            ) : resultTab === "logs" ? (
              <div>
                <div style={{ display: "flex", gap: 7, marginBottom: 8 }}>
                  <Badge tone={logs.connected ? "green" : "muted"}>
                    {logs.connected
                      ? studioUi(t, "Live")
                      : studioUi(t, "Closed")}
                  </Badge>
                  {logs.error && (
                    <span style={{ color: "var(--amber)", fontSize: 10.5 }}>
                      {studioUi(t, "Disconnected — retry in {seconds}s", {
                        seconds: logs.error.retrySeconds,
                      })}
                    </span>
                  )}
                </div>
                <pre
                  style={{
                    minHeight: 300,
                    margin: 0,
                    padding: 12,
                    background: "#080a0b",
                    color: "var(--text-2)",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    fontFamily: "var(--mono)",
                    fontSize: 10.5,
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {logs.lines
                    .map((line) =>
                      line.kind === "end"
                        ? studioUi(t, "Stream closed by server")
                        : line.text,
                    )
                    .join("\n") || studioUi(t, "Waiting for runtime logs…")}
                </pre>
              </div>
            ) : artifacts.isLoading ? (
              <Empty title={studioUi(t, "Loading artifacts…")} />
            ) : artifacts.isError ? (
              <Empty
                title={studioUi(t, "Artifacts unavailable")}
                hint={artifacts.error.message}
              />
            ) : artifacts.data?.length ? (
              <div style={{ display: "grid", gap: 7 }}>
                {artifacts.data.map((artifact) => (
                  <a
                    key={artifact.id}
                    href={artifact.downloadPath}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0, 1fr) auto",
                      gap: 8,
                      padding: 10,
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                      background: "var(--panel-2)",
                    }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span
                        style={{
                          display: "block",
                          color: "var(--text)",
                          fontSize: 11.5,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {artifact.logicalName ?? artifact.kind}
                      </span>
                      {artifact.role && (
                        <span
                          className="mono"
                          style={{
                            display: "block",
                            marginTop: 3,
                            color: "var(--text-3)",
                            fontSize: 9.5,
                          }}
                        >
                          {artifact.role}
                        </span>
                      )}
                    </span>
                    <span
                      className="mono"
                      style={{ color: "var(--text-3)", fontSize: 10 }}
                    >
                      {artifact.size} B
                    </span>
                  </a>
                ))}
              </div>
            ) : (
              <Empty
                title={studioUi(t, "No artifacts yet")}
                hint={studioUi(
                  t,
                  "Every completed Studio run stores its aggregate JSON output as an artifact.",
                )}
              />
            )}
          </div>
          {resultTab === "chat" && (
            <form
              className="agent-studio-chat-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void run();
              }}
            >
              <div className="agent-studio-chat-composer-box">
                <textarea
                  value={prompt}
                  aria-label={studioUi(t, "Message for the agent ({input})", {
                    input: promptInput?.id ?? "prompt",
                  })}
                  placeholder={
                    sessionId
                      ? studioUi(t, "Ask a follow-up…")
                      : studioUi(t, "Message the agent to start a test…")
                  }
                  rows={3}
                  disabled={createRun.isPending || targetUnavailable}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void run();
                    }
                  }}
                />
                <Button
                  type="submit"
                  tone="primary"
                  disabled={submitDisabled}
                  style={{ alignSelf: "flex-end" }}
                >
                  {createRun.isPending
                    ? studioUi(t, "Sending event…")
                    : conversationBusy
                      ? studioUi(t, "Agent running…")
                      : studioUi(t, "Send")}
                </Button>
              </div>
              <div className="agent-studio-chat-composer-meta">
                <span>
                  {createRun.isPending
                    ? studioUi(t, "Publishing the agent trigger event…")
                    : sessionHasActiveRun
                      ? studioUi(
                          t,
                          "Wait for this response before sending a follow-up",
                        )
                      : studioUi(
                          t,
                          "Enter to send · Shift+Enter for a new line",
                        )}
                </span>
                <span>
                  {sessionId
                    ? studioUi(t, "{target} target · session context", {
                        target:
                          target === "draft"
                            ? studioUi(t, "Draft")
                            : studioUi(t, "Live"),
                      })
                    : studioUi(t, "{target} target · new conversation", {
                        target:
                          target === "draft"
                            ? studioUi(t, "Draft")
                            : studioUi(t, "Live"),
                      })}
                </span>
              </div>
              {draftNotReady && (
                <div className="agent-studio-chat-composer-error">
                  {studioUi(
                    t,
                    "Save the draft before starting this conversation.",
                  )}
                </div>
              )}
              {missingRequired.length > 0 && (
                <div className="agent-studio-chat-composer-error">
                  {studioUi(t, "Complete required inputs in Test setup:")}{" "}
                  {missingRequired.map((input) => input.label).join(", ")}
                </div>
              )}
              {sessionId && targetUnavailable && (
                <div className="agent-studio-chat-composer-error">
                  {studioUi(
                    t,
                    "This saved conversation cannot safely reuse its pinned target. Start a new chat to continue.",
                  )}
                </div>
              )}
              {createRun.isError && (
                <div className="agent-studio-chat-composer-error">
                  {formatAgentStudioError(createRun.error, t)}
                </div>
              )}
              {cancelRun.isError && (
                <div className="agent-studio-chat-composer-error">
                  {studioUi(t, "Could not stop the run:")}{" "}
                  {cancelRun.error.message}
                </div>
              )}
            </form>
          )}
        </section>

        {historyOpen && (
          <div className="agent-studio-test-splitter agent-studio-test-splitter--history">
            <Splitter
              axis={historyInline ? "x" : "y"}
              getValue={() =>
                historyInline
                  ? effectiveHistoryPanelWidth
                  : effectiveHistoryPanelHeight
              }
              setValue={
                historyInline ? setHistoryPanelWidth : setHistoryPanelHeight
              }
              min={
                historyInline ? TEST_HISTORY_MIN_WIDTH : TEST_HISTORY_MIN_HEIGHT
              }
              max={
                historyInline ? historyPanelMaxWidth : TEST_HISTORY_MAX_HEIGHT
              }
              invert
              ariaLabel={
                historyInline
                  ? studioUi(t, "Resize Conversation and Run history panels")
                  : studioUi(t, "Resize Conversation and Run history rows")
              }
              ariaControls="agent-studio-test-conversation-panel agent-studio-test-history-panel"
            />
          </div>
        )}

        <aside
          id="agent-studio-test-history-panel"
          className="agent-studio-test-history"
          aria-hidden={!historyOpen}
          style={{
            minWidth: 0,
            display: historyOpen ? "flex" : "none",
            flexDirection: "column",
          }}
        >
          <div className="agent-studio-test-history-header">
            <div style={{ minWidth: 0 }}>
              <div
                style={{ color: "var(--text)", fontSize: 12, fontWeight: 600 }}
              >
                {studioUi(t, "Run history")}
              </div>
              <div
                style={{ color: "var(--text-3)", fontSize: 10.5, marginTop: 2 }}
              >
                {studioUi(t, "Saved for this agent")}
              </div>
            </div>
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            {history.isLoading ? (
              <Empty title={studioUi(t, "Loading history…")} />
            ) : history.isError ? (
              <Empty
                title={studioUi(t, "History unavailable")}
                hint={history.error.message}
              />
            ) : history.data?.items.length ? (
              history.data.items.map((row: AgentStudioRunRow) => (
                <button
                  type="button"
                  key={row.id}
                  onClick={() => {
                    const sameConversation =
                      Boolean(row.sessionId) && row.sessionId === sessionId;
                    setSelectedRunId(row.id);
                    setTarget(row.target.kind);
                    if (!sameConversation) {
                      setConversationTriggerEvent(undefined);
                      setLastDispatch(null);
                      setConversationTarget(
                        row.target.kind === "live" && row.target.agentVersionId
                          ? {
                              kind: "live",
                              agentVersionId: row.target.agentVersionId,
                            }
                          : null,
                      );
                    }
                    setSessionId(row.sessionId ?? undefined);
                    setResultTab("chat");
                  }}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    textAlign: "left",
                    borderBottom: "1px solid var(--border)",
                    background:
                      selectedRunId === row.id
                        ? "rgba(208,255,0,0.05)"
                        : "transparent",
                  }}
                >
                  <div
                    style={{ display: "flex", gap: 6, alignItems: "center" }}
                  >
                    <Badge tone={statusTone(row.status)}>
                      {studioUi(t, row.status)}
                    </Badge>
                    <Badge tone="muted">{studioUi(t, row.target.kind)}</Badge>
                  </div>
                  <div
                    style={{
                      marginTop: 7,
                      color: "var(--text-2)",
                      fontSize: 10.5,
                      lineHeight: 1.4,
                      overflow: "hidden",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}
                  >
                    {row.promptPreview ||
                      row.subject ||
                      studioUi(t, "No prompt preview")}
                  </div>
                  <div
                    className="mono"
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 7,
                      color: "var(--text-3)",
                      fontSize: 9.5,
                    }}
                  >
                    <span>
                      {displayTime(
                        row.startedAt ?? row.queuedAt,
                        studioLocale(language),
                      )}
                    </span>
                    <span>
                      {row.durationMs == null ? "" : `${row.durationMs}ms`}
                    </span>
                  </div>
                </button>
              ))
            ) : (
              <Empty
                title={studioUi(t, "No runs yet")}
                hint={studioUi(t, "Your first test run will be retained here.")}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
