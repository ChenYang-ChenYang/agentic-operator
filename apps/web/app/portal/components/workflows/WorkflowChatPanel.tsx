"use client";

/**
 * Chat mode for the workflow Run console.
 *
 * The person types a message; it becomes the entry event's `prompt` input on a
 * DRAFT test run, and the agent's reply comes back as prose. Prior turns ride
 * along on each request — the draft runner writes nothing to the database, so
 * continuity lives in the request rather than in a session table. That is why
 * the composer says the conversation is not saved.
 *
 * Deliberately a sibling of the payload form rather than a replacement: the
 * operator's daily surface (entry event, typed inputs, tool policy, limits) is
 * one tab away and unchanged.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { WorkflowRunEntrypoint } from "@agentic/contracts";
import { Button, Icon } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import type { WorkflowChatBubble } from "./workflow-chat";

export interface WorkflowChatPanelProps {
  entrypoint: WorkflowRunEntrypoint;
  bubbles: WorkflowChatBubble[];
  pending: boolean;
  /** Non-null when the last turn failed before producing any reply. */
  error: string | null;
  incompleteCascade: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
}

const transcriptStyle: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "20px 24px",
  display: "flex",
  flexDirection: "column",
  gap: 14,
  minHeight: 0,
};

const composerWrapStyle: CSSProperties = {
  borderTop: "1px solid var(--border)",
  padding: "12px 16px 14px",
  background: "var(--panel)",
  display: "grid",
  gap: 8,
};

const composerRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-end",
};

const textareaStyle: CSSProperties = {
  flex: 1,
  resize: "none",
  minHeight: 44,
  maxHeight: 160,
  padding: "11px 12px",
  borderRadius: 6,
  border: "1px solid var(--border-2)",
  background: "var(--panel-2)",
  color: "var(--text)",
  font: "inherit",
  fontSize: 13,
  lineHeight: 1.5,
};

function bubbleStyle(role: "user" | "assistant"): CSSProperties {
  return {
    alignSelf: role === "user" ? "flex-end" : "flex-start",
    maxWidth: "min(74ch, 86%)",
    padding: "10px 13px",
    borderRadius: 10,
    background: role === "user" ? "var(--panel-3)" : "var(--panel-2)",
    border: `1px solid ${role === "user" ? "var(--border-2)" : "var(--border)"}`,
    color: "var(--text)",
    fontSize: 13,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };
}

export function WorkflowChatPanel({
  entrypoint,
  bubbles,
  pending,
  error,
  incompleteCascade,
  draft,
  onDraftChange,
  onSend,
}: WorkflowChatPanelProps) {
  const { t } = useI18n();
  const endRef = useRef<HTMLDivElement | null>(null);
  const [coldStart, setColdStart] = useState(false);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [bubbles.length, pending]);

  // A first call against a cold model can take a while; saying so is kinder
  // than a spinner that looks stuck.
  useEffect(() => {
    if (!pending) {
      setColdStart(false);
      return;
    }
    const timer = setTimeout(() => setColdStart(true), 20_000);
    return () => clearTimeout(timer);
  }, [pending]);

  const empty = bubbles.length === 0 && !pending;

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--bg)",
      }}
    >
      <div style={transcriptStyle}>
        {empty ? (
          <div
            style={{
              margin: "auto",
              textAlign: "center",
              maxWidth: 460,
              display: "grid",
              gap: 10,
              color: "var(--text-2)",
            }}
          >
            <Icon name="spark" size={22} />
            <strong style={{ color: "var(--text)", fontSize: 15 }}>
              {t("workflowRunConsole.chatEmptyTitle")}
            </strong>
            <p style={{ fontSize: 12.5, lineHeight: 1.6, margin: 0 }}>
              {t("workflowRunConsole.chatEmptyBody", {
                event: entrypoint.event,
                agent: entrypoint.listenerTitles[0] ?? entrypoint.event,
              })}
            </p>
            <div>
              <Button
                small
                tone="ghost"
                onClick={() =>
                  onDraftChange(t("workflowRunConsole.chatSuggestion"))
                }
              >
                {t("workflowRunConsole.chatSuggestion")}
              </Button>
            </div>
          </div>
        ) : null}

        {bubbles.map((bubble, index) => (
          <div key={`${bubble.role}-${index}`} style={bubbleStyle(bubble.role)}>
            {bubble.byline ? (
              <div
                style={{
                  color: "var(--text-3)",
                  fontSize: 10.5,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  marginBottom: 5,
                }}
              >
                {bubble.byline}
              </div>
            ) : null}
            {bubble.content}
          </div>
        ))}

        {pending ? (
          <div
            style={{ ...bubbleStyle("assistant"), color: "var(--text-2)" }}
            role="status"
          >
            {t("workflowRunConsole.chatRunning", {
              agent: entrypoint.listenerTitles[0] ?? entrypoint.event,
            })}
            {coldStart ? (
              <div style={{ marginTop: 6, color: "var(--text-3)", fontSize: 12 }}>
                {t("workflowRunConsole.chatColdStart")}
              </div>
            ) : null}
          </div>
        ) : null}

        {incompleteCascade ? (
          <div
            role="status"
            style={{
              alignSelf: "flex-start",
              color: "var(--text-3)",
              fontSize: 11.5,
              paddingLeft: 2,
            }}
          >
            {t("workflowRunConsole.chatPartialCascade")}
          </div>
        ) : null}

        <div ref={endRef} />
      </div>

      <div style={composerWrapStyle}>
        {error ? (
          <div role="alert" style={{ color: "var(--red)", fontSize: 12 }}>
            {error}
          </div>
        ) : null}
        <div style={composerRowStyle}>
          <textarea
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!pending && draft.trim()) onSend();
              }
            }}
            placeholder={t("workflowRunConsole.chatPlaceholder")}
            aria-label={t("workflowRunConsole.chatPlaceholder")}
            rows={2}
            style={textareaStyle}
            disabled={pending}
          />
          <Button
            icon="run"
            tone="primary"
            onClick={onSend}
            disabled={pending || !draft.trim()}
          >
            {t("workflowRunConsole.chatSend")}
          </Button>
        </div>
        <div style={{ color: "var(--text-3)", fontSize: 11 }}>
          {t("workflowRunConsole.chatMeta")} · {t("workflowRunConsole.chatNotSaved")}
        </div>
      </div>
    </div>
  );
}
