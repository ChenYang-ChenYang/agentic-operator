/**
 * NodeTaskPanel — resolve a node's blocking human task without leaving the
 * runtime view.
 *
 * When the canvas shows a node in `waiting_human`, the operator's next move is
 * always the same: read the decision context, pick an option, let the flow
 * continue. Sending them to the Tasks page to do it loses the picture of where
 * the chain actually is.
 *
 * The form itself is NOT reimplemented here: `buildTaskFormDefinition` +
 * `TaskFormFields` + `buildTaskResolutionPayload` are the same shared modules
 * the Tasks page renders, so an authored `form_schema` behaves identically on
 * both surfaces and only has to be got right once.
 */
"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useResolveTask, useTask } from "@/lib/hooks/useTasks";
import { useRun } from "@/lib/hooks/useRuns";
import { useMe } from "@/lib/hooks/useMe";
import type { DagAgent } from "@/lib/hooks/useAgents";
import { Badge, Button } from "@/app/portal/components";
import { TaskFormFields } from "@/app/portal/components/tasks/TaskFormFields";
import {
  buildTaskFormDefinition,
  buildTaskResolutionPayload,
  initialTaskFormValues,
  type TaskDecisionOption,
  type TaskFormRawValue,
} from "@/app/portal/components/tasks/task-form";
import {
  actorDefaults,
  contextInsights,
  contextSummary,
  decisionOptions,
  prefillFromContext,
  type ContextFact,
  type DecisionOption,
} from "./task-context";

export function NodeTaskPanel({
  agent,
  taskIds,
  onClose,
}: {
  agent: DagAgent;
  taskIds: readonly string[];
  onClose: () => void;
}) {
  const { language, t } = useI18n();
  const tenant = useTenant();
  const copy = useCallback(
    (zh: string, en: string) => (language === "zh" ? zh : en),
    [language],
  );

  // An agent can block on several subjects at once; the panel works one task at
  // a time and keeps the rest listed so nothing is silently hidden.
  const [activeId, setActiveId] = useState<string | null>(taskIds[0] ?? null);
  useEffect(() => {
    setActiveId((prev) =>
      prev && taskIds.includes(prev) ? prev : (taskIds[0] ?? null),
    );
  }, [taskIds]);

  const task = useTask(activeId);
  const resolveTask = useResolveTask();
  const [values, setValues] = useState<Record<string, TaskFormRawValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);

  const payload = (task.data?.payloadJson ?? {}) as Record<string, unknown>;
  const definition = useMemo(
    () => buildTaskFormDefinition(payload.formSchema),
    [payload.formSchema],
  );

  // The run that opened this task carries what the agents found — the alert,
  // the deviation, the options. Both halves of this panel come from it: the
  // identifiers nobody could type, and the context nobody could decide without.
  const run = useRun(task.data?.runId ?? null);
  const me = useMe();
  const sources = useMemo(
    () => [payload.preparedContext, run.data?.run?.inputPayload],
    [payload.preparedContext, run.data],
  );
  const fieldNames = useMemo(
    () => definition.fields.map((field) => field.name),
    [definition],
  );
  const runPayload = run.data?.run?.inputPayload;
  const summary = useMemo(() => contextSummary(runPayload), [runPayload]);
  const insights = useMemo(() => contextInsights(runPayload), [runPayload]);
  const options = useMemo(
    () => decisionOptions(runPayload, fieldNames),
    [runPayload, fieldNames],
  );
  // Nothing is preselected: an approval that arrives pre-answered is not one.
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => setChosen(null), [activeId]);

  // Fields the chosen option already answers are not asked again.
  const suppliedByOptions = useMemo(() => {
    const names = new Set<string>();
    for (const option of options) {
      for (const name of Object.keys(option.values)) names.add(name);
    }
    return names;
  }, [options]);
  const remainingFields = useMemo(
    () => ({
      ...definition,
      fields: definition.fields.filter(
        (field) => !suppliedByOptions.has(field.name),
      ),
    }),
    [definition, suppliedByOptions],
  );

  // One affirmative decision. Reject is gone from this surface on purpose: the
  // ask was a single confirm, and declining is what Cancel does — it leaves the
  // node waiting rather than recording a rejection nobody asked for.
  const confirmDecision =
    definition.decisions.find((option) => option.decision === "approve") ??
    definition.decisions[0] ??
    null;
  // With options on the table, one has to be picked. With none, confirming is
  // itself the whole decision.
  const canConfirm = Boolean(confirmDecision) && (options.length === 0 || chosen !== null);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  // The panel's own header is sticky, so a scrolled body still looks like the
  // top of the panel. Land at the actual top whenever the task changes.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [activeId]);

  // Re-seed the form whenever the panel switches task, so a half-typed answer
  // for one subject can never be submitted against another. Prefill lands over
  // the schema defaults, never blanking a field the context has nothing for.
  useEffect(() => {
    const seeded = initialTaskFormValues(definition);
    const names = definition.fields.map((field) => field.name);
    const filled = {
      ...actorDefaults(names, me.data?.user?.name),
      ...prefillFromContext(names, sources),
    };
    for (const [name, value] of Object.entries(filled)) {
      if (name in seeded) seeded[name] = value;
    }
    setValues(seeded);
    setErrors({});
    setFailure(null);
  }, [definition, activeId, sources, me.data]);

  const submit = useCallback(
    (option: TaskDecisionOption) => {
      if (!activeId) return;
      // The chosen option supplies the identifiers the downstream write needs,
      // so the approver picks a plan rather than transcribing codes.
      const picked = options.find((candidate) => candidate.key === chosen);
      const merged = { ...values, ...(picked?.values ?? {}) };
      const built = buildTaskResolutionPayload(definition, merged, option, t);
      if (!built.ok) {
        setErrors(built.errors);
        return;
      }
      setErrors({});
      setFailure(null);
      resolveTask.mutate(
        { id: activeId, decision: option.decision, payload: built.payload },
        {
          onError: (error) =>
            setFailure(error instanceof Error ? error.message : String(error)),
        },
      );
    },
    [activeId, chosen, definition, options, resolveTask, t, values],
  );

  if (taskIds.length === 0) return null;

  return (
    <div
      ref={bodyRef}
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--panel-2)",
        maxHeight: "58%",
        overflow: "auto",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
          position: "sticky",
          top: 0,
          background: "var(--panel-2)",
          // Sticky header over the panel's own scrolled body — overlay, not modal.
          zIndex: "var(--z-overlay)",
        }}
      >
        <Badge tone="amber">{copy("待人工", "Waiting")}</Badge>
        <strong style={{ fontSize: 13 }}>{agent.title || agent.name}</strong>
        {task.data?.awaitingRole && (
          <span style={{ fontSize: 12, color: "var(--text-3)" }}>
            {copy("等待", "awaiting")} {task.data.awaitingRole}
          </span>
        )}
        <Button small tone="ghost" onClick={onClose} style={{ marginLeft: "auto" }}>
          {copy("收起", "Close")}
        </Button>
      </div>

      {taskIds.length > 1 && (
        <div
          style={{
            display: "flex",
            gap: 6,
            padding: "8px 14px 0",
            flexWrap: "wrap",
          }}
        >
          {taskIds.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveId(id)}
              className="mono"
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: "var(--r-sm)",
                cursor: "pointer",
                background: "transparent",
                color: id === activeId ? "var(--accent-text)" : "var(--text-3)",
                border: `1px solid ${id === activeId ? "var(--signal)" : "var(--border)"}`,
              }}
            >
              {id}
            </button>
          ))}
        </div>
      )}

      <div style={{ padding: "12px 14px", display: "grid", gap: 12 }}>
        {task.isLoading && (
          <span style={{ fontSize: 12, color: "var(--text-3)" }}>
            {copy("正在载入任务…", "Loading the task…")}
          </span>
        )}

        {task.isError && (
          <span style={{ fontSize: 12, color: "var(--red)" }}>
            {task.error instanceof Error
              ? task.error.message
              : copy("任务载入失败", "Could not load the task")}
          </span>
        )}

        {task.data && (
          <>
            <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.7 }}>
              {task.data.title}
            </div>

            {summary.length > 0 && (
              <FactStrip title={copy("采购概况", "Context")} facts={summary} />
            )}

            {insights.length > 0 && (
              <section>
                <SectionTitle>{copy("判断依据", "What the agents found")}</SectionTitle>
                <div style={{ display: "grid", gap: 6 }}>
                  {insights.map((fact) => (
                    <p
                      key={fact.key}
                      style={{
                        margin: 0,
                        fontSize: 12,
                        lineHeight: 1.75,
                        color: "var(--text-2)",
                      }}
                    >
                      {fact.value}
                    </p>
                  ))}
                </div>
              </section>
            )}

            {options.length > 0 && (
              <section>
                <SectionTitle>
                  {copy("请选择一个方案", "Choose one")}
                </SectionTitle>
                <div style={{ display: "grid", gap: 8 }}>
                  {options.map((option) => (
                    <OptionChoice
                      key={option.key}
                      option={option}
                      checked={chosen === option.key}
                      disabled={resolveTask.isPending}
                      onChoose={() => setChosen(option.key)}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Whatever the schema still wants that the options do not supply. */}
            <TaskFormFields
              definition={remainingFields}
              values={values}
              errors={errors}
              disabled={resolveTask.isPending}
              selectPlaceholder={copy("请选择…", "Select…")}
              confirmLabel={copy("确认", "Confirm")}
              onChange={(name, value) =>
                setValues((prev) => ({ ...prev, [name]: value }))
              }
            />

            {failure && (
              <span style={{ fontSize: 12, color: "var(--red)" }}>{failure}</span>
            )}

            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                position: "sticky",
                bottom: 0,
                background: "var(--panel-2)",
                borderTop: "1px solid var(--border)",
                margin: "0 -14px -12px",
                padding: "10px 14px",
                zIndex: "var(--z-overlay)",
              }}
            >
              <Button
                small
                tone="primary"
                disabled={resolveTask.isPending || !canConfirm}
                title={
                  canConfirm
                    ? undefined
                    : copy("请先选择一个方案", "Choose an option first")
                }
                onClick={() => confirmDecision && submit(confirmDecision)}
              >
                {copy("确认", "Confirm")}
              </Button>
              <Button small tone="ghost" onClick={onClose}>
                {copy("取消", "Cancel")}
              </Button>
              <span style={{ fontSize: 11, color: "var(--text-3)", alignSelf: "center" }}>
                {copy("取消＝暂不决策，节点仍等待人工", "Cancel leaves the node waiting")}
              </span>
              <a
                href={`/portal/${encodeURIComponent(tenant)}/tasks`}
                style={{
                  fontSize: 11.5,
                  color: "var(--text-3)",
                  alignSelf: "center",
                  marginLeft: "auto",
                }}
              >
                {copy("在人工任务中打开", "Open in Tasks")}
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: "var(--text-3)",
        letterSpacing: "0.04em",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

/** The few facts that place the decision, as one scannable strip. */
function FactStrip({ title, facts }: { title: string; facts: ContextFact[] }) {
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
          gap: "6px 14px",
        }}
      >
        {facts.map((fact) => (
          <div key={fact.key} style={{ minWidth: 0 }}>
            <div
              className="mono"
              style={{ fontSize: 10, color: "var(--text-4)" }}
            >
              {fact.key}
            </div>
            <div
              style={{
                fontSize: 12.5,
                color: "var(--text)",
                overflowWrap: "anywhere",
              }}
            >
              {fact.value}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** One option, as a radio the whole card selects. */
function OptionChoice({
  option,
  checked,
  disabled,
  onChoose,
}: {
  option: DecisionOption;
  checked: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        padding: "10px 12px",
        borderRadius: "var(--r-sm)",
        cursor: disabled ? "default" : "pointer",
        background: checked ? "var(--panel-3)" : "transparent",
        border: `1px solid ${checked ? "var(--signal)" : "var(--border)"}`,
      }}
    >
      <input
        type="radio"
        name="decision-option"
        checked={checked}
        disabled={disabled}
        onChange={onChoose}
        style={{ marginTop: 3 }}
      />
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text)",
          }}
        >
          {option.title}
        </span>
        <span
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "2px 12px",
            marginTop: 3,
            fontSize: 11.5,
            color: "var(--text-3)",
          }}
        >
          {option.facts.map((fact) => (
            <span key={fact.key} style={{ overflowWrap: "anywhere" }}>
              <span className="mono" style={{ color: "var(--text-4)" }}>
                {fact.key}
              </span>{" "}
              {fact.value}
            </span>
          ))}
        </span>
      </span>
    </label>
  );
}
