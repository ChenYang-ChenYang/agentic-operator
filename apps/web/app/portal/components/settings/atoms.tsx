"use client";

/**
 * Settings-local design tokens — Field / Toggle / RoleBadge / etc.
 *
 * Ported verbatim from `apps/web/public/portal/views/settings.jsx:157-265`.
 * Lives next to the foundation primitives so other settings sections can
 * import them without circular dependency back into the heavy view.
 */

import type { CSSProperties, ReactNode } from "react";
import { Badge, Icon, StatusDot } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";

// ---------- Field ----------
export function Field({
  label,
  hint,
  children,
  locked,
  right,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  locked?: boolean;
  right?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "200px 1fr",
        gap: 16,
        padding: "14px 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ paddingTop: 5 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            color: "var(--text)",
          }}
        >
          {label}
          {locked && (
            <Icon name="check" size={10} style={{ color: "var(--text-4)" }} />
          )}
        </div>
        {hint && (
          <div
            style={{
              marginTop: 3,
              fontSize: 11,
              color: "var(--text-3)",
              lineHeight: 1.5,
            }}
          >
            {hint}
          </div>
        )}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
        {right}
      </div>
    </div>
  );
}

// ---------- TextIn ----------
export function TextIn({
  value,
  onChange,
  placeholder,
  mono,
  suffix,
  prefix,
  ariaLabel,
  disabled,
  type,
}: {
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  suffix?: ReactNode;
  prefix?: ReactNode;
  /**
   * P2-FE-24 — accessible name for the underlying `<input>`. Falls back
   * to placeholder so the input is never axe-critical, but every Field
   * caller should pass the section field label here for screen readers.
   */
  ariaLabel?: string;
  disabled?: boolean;
  /** Native input type. Defaults to text; "password" masks the value. */
  type?: "text" | "password" | "email";
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "var(--panel-2)",
        border: "1px solid var(--border-2)",
        borderRadius: 5,
        padding: "6px 9px",
      }}
    >
      {prefix && (
        <span
          style={{
            fontSize: 12,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
          }}
        >
          {prefix}
        </span>
      )}
      <input
        type={type ?? "text"}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder ?? t("settingsAtoms.textInput")}
        style={{
          flex: 1,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--text)",
          fontFamily: mono ? "var(--mono)" : "var(--sans)",
          fontSize: mono ? 12 : 12.5,
          minWidth: 0,
          cursor: disabled ? "not-allowed" : undefined,
          opacity: disabled ? 0.6 : 1,
        }}
      />
      {suffix && (
        <span
          style={{
            fontSize: 11,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
          }}
        >
          {suffix}
        </span>
      )}
    </div>
  );
}

// ---------- SelectIn ----------
export type SelectOption = string | { value: string; label: string };

export function SelectIn({
  value,
  onChange,
  options,
  ariaLabel,
  disabled,
}: {
  value: string;
  onChange?: (v: string) => void;
  options: SelectOption[];
  /** P2-FE-24 — accessible name. Defaults to "Select" to silence axe. */
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
      aria-label={ariaLabel ?? t("settingsAtoms.select")}
      style={{
        background: "var(--panel-2)",
        border: "1px solid var(--border-2)",
        borderRadius: 5,
        padding: "6px 9px",
        color: "var(--text)",
        fontSize: 12.5,
        fontFamily: "var(--sans)",
        outline: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        appearance: "none",
        backgroundImage:
          "linear-gradient(45deg, transparent 50%, var(--text-3) 50%), linear-gradient(135deg, var(--text-3) 50%, transparent 50%)",
        backgroundPosition: "calc(100% - 14px) 50%, calc(100% - 10px) 50%",
        backgroundSize: "4px 4px, 4px 4px",
        backgroundRepeat: "no-repeat",
        paddingRight: 26,
      }}
    >
      {options.map((o) => {
        const opt = typeof o === "string" ? { value: o, label: o } : o;
        return (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        );
      })}
    </select>
  );
}

// ---------- Toggle ----------
export function Toggle({
  value,
  onChange,
  ariaLabel,
  disabled,
}: {
  value: boolean;
  onChange?: (v: boolean) => void;
  /** P2-FE-24 — accessible name. Required for icon-only toggles. */
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange?.(!value)}
      aria-label={
        ariaLabel ?? (value ? t("settingsAtoms.on") : t("settingsAtoms.off"))
      }
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        background: value ? "var(--signal)" : "var(--panel-3)",
        border: `1px solid ${value ? "var(--signal)" : "var(--border-2)"}`,
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        transition: "background 0.12s",
      }}
      aria-pressed={value}
    >
      <span
        style={{
          position: "absolute",
          top: 1,
          left: value ? 17 : 1,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: value ? "var(--on-signal)" : "var(--text-3)",
          transition: "left 0.12s",
        }}
      />
    </button>
  );
}

// ---------- CardRow ----------
export function CardRow({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "grid",
        alignItems: "center",
        gap: 14,
        padding: "12px 14px",
        borderBottom: "1px solid var(--border)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ---------- StatusPill ----------
export function StatusPill({
  status,
}: {
  status: "ok" | "warn" | "err" | "off";
}) {
  const { t } = useI18n();
  const map = {
    ok: {
      tone: "green" as const,
      label: t("settingsAtoms.statusConnected"),
      dot: "ok" as const,
    },
    warn: {
      tone: "amber" as const,
      label: t("settingsAtoms.statusDegraded"),
      dot: "waiting" as const,
    },
    err: {
      tone: "red" as const,
      label: t("settingsAtoms.statusError"),
      dot: "failed" as const,
    },
    off: {
      tone: "muted" as const,
      label: t("settingsAtoms.statusDisconnected"),
      dot: "idle" as const,
    },
  };
  const entry = map[status] ?? map.off;
  return (
    <Badge tone={entry.tone}>
      <StatusDot status={entry.dot} size={5} /> {entry.label}
    </Badge>
  );
}

// ---------- RoleBadge ----------
export function RoleBadge({ role }: { role: string }) {
  const { t } = useI18n();
  const map: Record<string, "signal" | "violet" | "blue" | "muted" | "amber"> =
    {
      Owner: "signal",
      Admin: "violet",
      Operator: "blue",
      Viewer: "muted",
      Service: "amber",
    };
  const labels: Record<string, string> = {
    Owner: t("settingsAtoms.roleOwner"),
    Admin: t("settingsAtoms.roleAdmin"),
    Operator: t("settingsAtoms.roleOperator"),
    Viewer: t("settingsAtoms.roleViewer"),
    Service: t("settingsAtoms.roleService"),
  };
  return <Badge tone={map[role] ?? "muted"}>{labels[role] ?? role}</Badge>;
}
