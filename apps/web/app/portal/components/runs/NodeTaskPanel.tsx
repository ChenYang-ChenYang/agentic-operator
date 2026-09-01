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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useResolveTask, useTask } from "@/lib/hooks/useTasks";
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

  // Re-seed the form whenever the panel switches task, so a half-typed answer
  // for one subject can never be submitted against another.
  useEffect(() => {
    setValues(initialTaskFormValues(definition));
    setErrors({});
    setFailure(null);
  }, [definition, activeId]);

  const submit = useCallback(
    (option: TaskDecisionOption) => {
      if (!activeId) return;
      const built = buildTaskResolutionPayload(definition, values, option, t);
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
    [activeId, definition, resolveTask, t, values],
  );

  if (taskIds.length === 0) return null;

  const context = payload.context ?? payload.decisionContext ?? null;

  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--panel-2)",
        maxHeight: "46%",
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

            {context !== null && (
              <pre
                className="mono"
                style={{
                  margin: 0,
                  padding: 10,
                  fontSize: 11,
                  lineHeight: 1.6,
                  background: "var(--panel-3)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--r-sm)",
                  maxHeight: 160,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {JSON.stringify(context, null, 2)}
              </pre>
            )}

            <TaskFormFields
              definition={definition}
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

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {definition.decisions.map((option) => (
                <Button
                  key={option.decision}
                  small
                  tone={option.decision === "approve" ? "primary" : "ghost"}
                  disabled={resolveTask.isPending}
                  onClick={() => submit(option)}
                >
                  {option.label}
                </Button>
              ))}
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
