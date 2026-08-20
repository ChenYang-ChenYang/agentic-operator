"use client";

import { Button, Icon, ModalOverlay } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";

/**
 * A tenant runs exactly one live workflow deployment, so publishing a manifest
 * that no longer declares an agent removes that agent from the running system.
 * The server answers 409 with the diff rather than deciding for the operator;
 * this dialog is where the operator sees what would disappear.
 */
export function ConfirmPublishOverwriteModal(props: {
  reason: "removes_agents" | "modifies_threshold";
  removed: string[];
  modified: string[];
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const destructive = props.removed.length > 0;

  return (
    <ModalOverlay
      onClose={props.onClose}
      ariaLabel={t("publishOverwrite.ariaLabel")}
    >
      <div
        style={{
          width: "min(560px, calc(100vw - 32px))",
          maxHeight: "88vh",
          background: "var(--panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 8,
          overflow: "hidden",
          boxShadow: "0 24px 60px -20px rgba(0,0,0,0.7)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <Icon
            name="alert"
            size={15}
            style={{ color: destructive ? "var(--red)" : "var(--signal)" }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{ fontSize: 15, color: "var(--text)", fontWeight: 600 }}
            >
              {destructive
                ? t("publishOverwrite.removesTitle")
                : t("publishOverwrite.modifiesTitle")}
            </div>
            <div
              style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 2 }}
            >
              {t("publishOverwrite.subtitle")}
            </div>
          </div>
        </header>

        <div style={{ padding: 20, overflow: "auto", flex: 1 }}>
          {props.removed.length > 0 && (
            <AgentList
              label={t("publishOverwrite.removedLabel", {
                count: props.removed.length,
              })}
              names={props.removed}
              tone="var(--red)"
            />
          )}
          {props.modified.length > 0 && (
            <AgentList
              label={t("publishOverwrite.modifiedLabel", {
                count: props.modified.length,
              })}
              names={props.modified}
              tone="var(--text-2)"
            />
          )}
          <p
            style={{
              fontSize: 12,
              lineHeight: 1.6,
              color: "var(--text-2)",
              margin: "16px 0 0",
            }}
          >
            {destructive
              ? t("publishOverwrite.removesExplanation")
              : t("publishOverwrite.modifiesExplanation")}
          </p>
        </div>

        <footer
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "14px 20px",
            borderTop: "1px solid var(--border)",
          }}
        >
          <Button tone="ghost" onClick={props.onClose}>
            {t("publishOverwrite.cancel")}
          </Button>
          <Button
            tone={destructive ? "danger" : "primary"}
            onClick={props.onConfirm}
            disabled={props.pending}
          >
            {props.pending
              ? t("publishOverwrite.publishing")
              : t("publishOverwrite.confirm")}
          </Button>
        </footer>
      </div>
    </ModalOverlay>
  );
}

function AgentList(props: { label: string; names: string[]; tone: string }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          color: "var(--text-3)",
          marginBottom: 6,
        }}
      >
        {props.label}
      </div>
      <ul
        style={{
          margin: 0,
          padding: 0,
          listStyle: "none",
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        {props.names.map((name) => (
          <li
            key={name}
            style={{
              fontSize: 12,
              fontFamily: "var(--mono, ui-monospace, monospace)",
              color: props.tone,
              background: "var(--panel-2)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "3px 8px",
            }}
          >
            {name}
          </li>
        ))}
      </ul>
    </div>
  );
}
