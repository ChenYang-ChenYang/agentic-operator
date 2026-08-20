"use client";

/**
 * TopBar — 44px header strip above every view. v1_1 app.jsx:291-374.
 *
 * Left: breadcrumb derived from URL.
 * Right: Cmd-K search button (240px), LIVE/PAUSED toggle, user chip.
 *
 * Breadcrumb logic: split the path after `/portal/<tenant>/`, capitalize
 * the first segment for plain views, render mono-styled IDs (runId/agentId/
 * eventName/taskId) as the final crumb. v1_1 used in-component state to
 * decide the breadcrumb shape; here the URL is the source of truth.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "../Icon";
import { Kbd } from "../atoms";
import { useI18n } from "../../lib/preferences-context";
import { ThemeToggle, LanguageToggle } from "./appearance-controls";
import { useCommandPalette } from "../cmd-k";
import { useTenant } from "../../lib/use-tenant";
import { useMe, useLogout, useChangePassword } from "@/lib/hooks/useMe";
import { formatApiError } from "@/lib/api-response";

export interface TopBarProps {
  /** Display name + avatar initials for the user chip. */
  user: { name: string; initials: string };
}

type Translate = (key: string) => string;

export function TopBar({ user }: TopBarProps) {
  const pathname = usePathname() ?? "";
  const tenant = useTenant();
  const { t } = useI18n();
  const cmdK = useCommandPalette();

  const crumb = useMemo(
    () => buildCrumb(pathname, tenant, t),
    [pathname, tenant, t],
  );

  // OntoCode has its own domain/project/session context header. Rendering the
  // generic breadcrumb/search bar above it would duplicate navigation and
  // shrink the full-height engineering canvas.
  if (/\/ontocode-workspace(?:\/|$)/.test(pathname)) return null;

  return (
    <div
      data-portal-topbar
      style={{
        height: 44,
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        padding: "0 18px",
        gap: 14,
        background: "var(--bg)",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          color: "var(--text-3)",
        }}
      >
        {crumb.map((c, i) => {
          const last = i === crumb.length - 1;
          if (last) {
            return (
              <span
                key={i}
                style={{ color: "var(--text)" }}
                className={c.mono ? "mono" : ""}
              >
                {c.label}
              </span>
            );
          }
          if (c.href) {
            return (
              <span
                key={i}
                style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
              >
                <Link href={c.href as never} style={{ color: "var(--text-2)" }}>
                  {c.label}
                </Link>
                <Icon
                  name="chevron-right"
                  size={10}
                  style={{ color: "var(--text-4)" }}
                />
              </span>
            );
          }
          return (
            <span
              key={i}
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              <span style={{ color: "var(--text-2)" }}>{c.label}</span>
              <Icon
                name="chevron-right"
                size={10}
                style={{ color: "var(--text-4)" }}
              />
            </span>
          );
        })}
      </div>

      <button
        onClick={() => cmdK.setOpen(true)}
        aria-label={t("topbar.openCommandPalette")}
        style={{
          marginLeft: "auto",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 9px",
          background: "var(--panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 5,
          fontSize: 11.5,
          color: "var(--text-3)",
          minWidth: 240,
        }}
      >
        <Icon name="search" size={11} />
        <span>{t("topbar.search")}</span>
        <span style={{ marginLeft: "auto" }}>
          <Kbd>⌘</Kbd> <Kbd>K</Kbd>
        </span>
      </button>

      <ThemeToggle />
      <LanguageToggle />

      <UserMenu fallbackName={user.name} fallbackInitials={user.initials} />
    </div>
  );
}

/**
 * Account chip + dropdown. Identity/role come from `useMe()`; falls back to the
 * SSR session values until the query resolves. Sign-out clears the session
 * cookie via the api and redirects to /sign-in.
 */
function UserMenu({
  fallbackName,
  fallbackInitials,
}: {
  fallbackName: string;
  fallbackInitials: string;
}) {
  const { t } = useI18n();
  const { data: me } = useMe();
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const name = me?.user.name || fallbackName;
  const email = me?.user.email ?? "";
  const initials = (name.trim().slice(0, 2) || fallbackInitials).toUpperCase();
  const isSuper = me?.user.platformRole === "superadmin";
  const role = me?.activeTenant?.role ?? null;

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: 0,
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: "var(--violet)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            color: "var(--on-accent)",
            fontWeight: 600,
          }}
        >
          {initials}
        </span>
        <span style={{ fontSize: 11.5, color: "var(--text-2)" }}>{name}</span>
      </button>

      {open ? (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: "var(--z-overlay)" }}
            aria-hidden
          />
          <div
            role="menu"
            style={{
              position: "absolute",
              top: "calc(100% + 8px)",
              right: 0,
              minWidth: 220,
              background: "var(--panel)",
              border: "1px solid var(--border-2)",
              borderRadius: 8,
              boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
              padding: 6,
              zIndex: "var(--z-modal)",
            }}
          >
            <div style={{ padding: "8px 10px 10px" }}>
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--text)",
                  fontWeight: 600,
                }}
              >
                {name}
              </div>
              {email ? (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--text-3)",
                    fontFamily: "var(--mono)",
                    marginTop: 2,
                  }}
                >
                  {email}
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                {isSuper ? (
                  <Pill text={t("access.platformSuperadmin")} tone="signal" />
                ) : role ? (
                  <Pill
                    text={t(
                      `access.role${role[0]!.toUpperCase()}${role.slice(1)}`,
                    )}
                    tone="muted"
                  />
                ) : null}
              </div>
            </div>
            <div
              style={{
                height: 1,
                background: "var(--border)",
                margin: "2px 0",
              }}
            />
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setPwOpen(true);
              }}
              style={menuItemStyle}
            >
              {t("auth.changePassword")}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setLogoutError(null);
                logout.mutate(undefined, {
                  onError: (error) => setLogoutError(formatApiError(error, t)),
                });
              }}
              disabled={logout.isPending}
              style={{
                ...menuItemStyle,
                cursor: logout.isPending ? "wait" : "pointer",
              }}
            >
              {logout.isPending ? "…" : t("auth.signOut")}
            </button>
            {logoutError ? (
              <div
                role="alert"
                style={{
                  padding: "5px 10px",
                  fontSize: 11,
                  color: "var(--red)",
                }}
              >
                {t("auth.signOutFailed")}: {logoutError}
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {pwOpen ? <ChangePasswordModal onClose={() => setPwOpen(false)} /> : null}
    </div>
  );
}

const menuItemStyle: React.CSSProperties = {
  width: "100%",
  textAlign: "left",
  padding: "8px 10px",
  background: "transparent",
  border: "none",
  borderRadius: 6,
  color: "var(--text-2)",
  fontSize: 12.5,
  cursor: "pointer",
};

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const changePw = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    setError(null);
    if (next.length < 8) {
      setError(t("auth.passwordMin"));
      return;
    }
    try {
      await changePw.mutateAsync({
        currentPassword: current,
        newPassword: next,
      });
      setDone(true);
      setTimeout(onClose, 900);
    } catch (caught) {
      setError(formatApiError(caught, t, "auth.passwordChangeFailed"));
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: "var(--z-modal)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 380,
          maxWidth: "90vw",
          background: "var(--panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 12,
          padding: 22,
        }}
      >
        <h2
          style={{
            margin: "0 0 14px",
            fontSize: 17,
            fontFamily: "var(--display)",
            fontWeight: 400,
            color: "var(--text)",
          }}
        >
          {t("auth.changePassword")}
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <PwField
            label={t("auth.currentPassword")}
            value={current}
            onChange={setCurrent}
          />
          <PwField
            label={t("auth.newPassword")}
            value={next}
            onChange={setNext}
          />
        </div>
        {error ? (
          <div
            role="alert"
            style={{ marginTop: 12, fontSize: 12, color: "var(--red)" }}
          >
            {error}
          </div>
        ) : null}
        {done ? (
          <div style={{ marginTop: 12, fontSize: 12, color: "var(--green)" }}>
            {t("auth.passwordChanged")}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 18,
          }}
        >
          <button
            onClick={onClose}
            style={{ ...menuItemStyle, width: "auto", padding: "7px 12px" }}
          >
            {t("auth.cancel")}
          </button>
          <button
            onClick={submit}
            disabled={changePw.isPending || !current || !next}
            style={{
              padding: "7px 14px",
              background: "var(--signal)",
              color: "var(--on-signal)",
              border: "none",
              borderRadius: 7,
              fontSize: 12.5,
              fontWeight: 600,
              cursor: changePw.isPending ? "wait" : "pointer",
              opacity: changePw.isPending || !current || !next ? 0.6 : 1,
            }}
          >
            {t("auth.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

function PwField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 11.5, color: "var(--text-2)" }}>{label}</span>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: "9px 11px",
          background: "var(--panel-2)",
          border: "1px solid var(--border-2)",
          borderRadius: 7,
          color: "var(--text)",
          fontSize: 13,
          outline: "none",
        }}
      />
    </label>
  );
}

function Pill({ text, tone }: { text: string; tone: "signal" | "muted" }) {
  return (
    <span
      style={{
        fontSize: 9.5,
        fontFamily: "var(--mono)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        padding: "2px 6px",
        borderRadius: 4,
        background:
          tone === "signal"
            ? "color-mix(in srgb, var(--signal) 14%, transparent)"
            : "var(--panel-2)",
        color: tone === "signal" ? "var(--accent-text)" : "var(--text-3)",
        border: `1px solid ${tone === "signal" ? "color-mix(in srgb, var(--signal) 30%, transparent)" : "var(--border)"}`,
      }}
    >
      {text}
    </span>
  );
}

interface CrumbPart {
  label: string;
  href?: string;
  mono?: boolean;
}

/** Translate a view segment via `nav.<view>`, falling back to Capitalized. */
function viewLabel(view: string, t: Translate): string {
  const key = `nav.${view}`;
  const translated = t(key);
  return translated === key ? capitalize(view) : translated;
}

/** Build breadcrumb parts from `/portal/<tenant>/<view>[/<id>]`. */
function buildCrumb(
  pathname: string,
  tenant: string,
  t: Translate,
): CrumbPart[] {
  // Split, drop leading "portal" + tenant.
  const parts = pathname.split("/").filter(Boolean);
  // parts: ["portal", tenant, view?, ...rest]
  const view = parts[2];
  const rest = parts.slice(3);
  const base = `/portal/${tenant}`;

  if (!view) {
    return [{ label: t("nav.dashboard") }];
  }
  const viewTitle = viewLabel(view, t);
  if (rest.length === 0) {
    return [{ label: viewTitle }];
  }
  // Detail view — last segment is an ID.
  const tail = rest[rest.length - 1] ?? "";
  return [
    { label: viewTitle, href: `${base}/${view}` },
    { label: tail, mono: looksLikeId(tail) },
  ];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function looksLikeId(s: string): boolean {
  return /^(run|evt|agt|tsk|TASK|REQ|CAN)-/i.test(s);
}
