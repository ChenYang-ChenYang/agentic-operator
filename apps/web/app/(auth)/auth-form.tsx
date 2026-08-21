"use client";

/**
 * AuthForm (P6-AUTH) — the sign-in / sign-up card.
 *
 * Lives outside /portal, so it mounts its own PreferencesProvider to get
 * i18n + theme (the portal's provider isn't an ancestor here). Submits
 * straight to the api (`/v1/auth/{login,register}`) through the Next `/v1/*`
 * rewrite so the Set-Cookie lands same-origin; on success it hard-navigates
 * to the portal (or the `?return=` path).
 */

import { useState, type FormEvent } from "react";
import {
  PreferencesProvider,
  useI18n,
} from "@/app/portal/lib/preferences-context";
import { LanguageToggle } from "@/app/portal/components/shell/appearance-controls";
import { ApiResponseError, readApiData } from "@/lib/api-response";

interface AuthResult {
  tenant?: unknown;
  memberships?: Array<{ tenantSlug?: unknown }>;
}

function tenantFromAuthResult(result: AuthResult): string | null {
  const candidate =
    typeof result.tenant === "string"
      ? result.tenant
      : result.memberships?.[0]?.tenantSlug;
  return typeof candidate === "string" && /^[a-z0-9_-]{1,64}$/i.test(candidate)
    ? candidate
    : null;
}

export function AuthForm({
  initialMode,
}: {
  initialMode: "signin" | "signup";
}) {
  return (
    <PreferencesProvider>
      <AuthFormInner initialMode={initialMode} />
    </PreferencesProvider>
  );
}

function mapError(code: string | undefined, t: (k: string) => string): string {
  switch (code) {
    case "invalid_credentials":
      return t("auth.invalidCredentials");
    case "email_taken":
      return t("auth.emailTaken");
    default:
      return t("auth.genericError");
  }
}

function AuthFormInner({ initialMode }: { initialMode: "signin" | "signup" }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"signin" | "signup">(initialMode);
  const isSignup = mode === "signup";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Toggle between sign-in and register in place (no navigation) so the login
  // screen itself can register. Also keeps the URL in sync for shareability.
  function switchMode() {
    const next = isSignup ? "signin" : "signup";
    setMode(next);
    setError(null);
    setPassword("");
    if (typeof window !== "undefined") {
      window.history.replaceState(
        null,
        "",
        next === "signup" ? "/sign-up" : "/sign-in",
      );
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (isSignup && password.length < 8) {
      setError(t("auth.passwordMin"));
      return;
    }
    setBusy(true);
    try {
      const path = isSignup ? "/v1/auth/register" : "/v1/auth/login";
      const body = isSignup ? { email, password, name } : { email, password };
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const result = await readApiData<AuthResult>(res, path);
      const params = new URLSearchParams(window.location.search);
      const requested = params.get("return");
      const authenticatedTenant = tenantFromAuthResult(result);
      let destination = authenticatedTenant
        ? `/portal/${encodeURIComponent(authenticatedTenant)}/dashboard`
        : "/portal";
      if (
        requested?.startsWith("/") &&
        !requested.startsWith("//") &&
        !requested.includes("\\")
      ) {
        try {
          const resolved = new URL(requested, window.location.origin);
          if (resolved.origin === window.location.origin) {
            destination = `${resolved.pathname}${resolved.search}${resolved.hash}`;
          }
        } catch {
          // Malformed return targets fall back to the tenant portal.
        }
      }
      window.location.href = destination;
    } catch (cause) {
      setError(
        cause instanceof ApiResponseError
          ? mapError(cause.code, t)
          : t("auth.genericError"),
      );
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        padding: 20,
      }}
    >
      <div
        style={{
          position: "fixed",
          top: 20,
          right: 20,
          zIndex: 1,
        }}
      >
        <LanguageToggle />
      </div>
      <div
        style={{
          width: 380,
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 28,
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: 24,
            fontFamily: "var(--display)",
            fontWeight: 400,
            color: "var(--text)",
          }}
        >
          {t(isSignup ? "auth.signUpTitle" : "auth.signInTitle")}
        </h1>
        <p
          style={{
            marginTop: 6,
            marginBottom: 20,
            fontSize: 12.5,
            color: "var(--text-3)",
          }}
        >
          {t(isSignup ? "auth.signUpSubtitle" : "auth.signInSubtitle")}
        </p>

        <form
          onSubmit={onSubmit}
          style={{ display: "flex", flexDirection: "column", gap: 14 }}
        >
          {isSignup ? (
            <Field
              label={t("auth.name")}
              value={name}
              onChange={setName}
              type="text"
              autoComplete="name"
              required
            />
          ) : null}
          <Field
            label={t("auth.email")}
            value={email}
            onChange={setEmail}
            type="email"
            autoComplete="email"
            required
          />
          <Field
            label={t("auth.password")}
            value={password}
            onChange={setPassword}
            type="password"
            autoComplete={isSignup ? "new-password" : "current-password"}
            required
            revealLabels={{
              show: t("auth.showPassword"),
              hide: t("auth.hidePassword"),
            }}
          />

          {error ? (
            <div
              role="alert"
              style={{
                fontSize: 12,
                color: "var(--red)",
                background: "color-mix(in srgb, var(--red) 10%, transparent)",
                border:
                  "1px solid color-mix(in srgb, var(--red) 30%, transparent)",
                borderRadius: 6,
                padding: "8px 10px",
              }}
            >
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            style={{
              marginTop: 4,
              padding: "10px 12px",
              background: "var(--signal)",
              color: "var(--on-signal)",
              border: "none",
              borderRadius: 7,
              fontSize: 13,
              fontWeight: 600,
              cursor: busy ? "wait" : "pointer",
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy
              ? t(isSignup ? "auth.signingUp" : "auth.signingIn")
              : t(isSignup ? "auth.signUp" : "auth.signIn")}
          </button>
        </form>

        <div
          style={{
            marginTop: 18,
            fontSize: 12,
            color: "var(--text-3)",
            textAlign: "center",
          }}
        >
          {t(isSignup ? "auth.haveAccount" : "auth.noAccount")}{" "}
          <button
            type="button"
            onClick={switchMode}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              color: "var(--accent-text)",
              fontSize: 12,
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            {t(isSignup ? "auth.signInLink" : "auth.signUpLink")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Text input, with an optional reveal toggle for password fields.
 *
 * Passing `revealLabels` swaps the input between `password` and `text` — the
 * usual defence against a typo in a masked field that only surfaces as a
 * failed sign-in. The toggle is a real button so it is reachable by keyboard,
 * and it is excluded from the tab order between the field and the submit
 * button so the common path (type, Enter) is unchanged.
 */
function Field({
  label,
  value,
  onChange,
  type,
  autoComplete,
  required,
  revealLabels,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type: string;
  autoComplete?: string;
  required?: boolean;
  revealLabels?: { show: string; hide: string };
}) {
  const [revealed, setRevealed] = useState(false);
  const canReveal = Boolean(revealLabels);
  const effectiveType = canReveal && revealed ? "text" : type;

  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 11.5, color: "var(--text-2)" }}>{label}</span>
      <span style={{ position: "relative", display: "block" }}>
        <input
          type={effectiveType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          required={required}
          style={{
            width: "100%",
            padding: canReveal ? "9px 40px 9px 11px" : "9px 11px",
            background: "var(--panel-2)",
            border: "1px solid var(--border-2)",
            borderRadius: 7,
            color: "var(--text)",
            fontSize: 13,
            outline: "none",
          }}
        />
        {canReveal ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setRevealed((v) => !v)}
            aria-pressed={revealed}
            aria-label={revealed ? revealLabels!.hide : revealLabels!.show}
            title={revealed ? revealLabels!.hide : revealLabels!.show}
            style={{
              position: "absolute",
              top: "50%",
              right: 6,
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              padding: 0,
              background: "transparent",
              border: "none",
              borderRadius: 5,
              color: "var(--text-3)",
              cursor: "pointer",
            }}
          >
            <EyeIcon off={revealed} />
          </button>
        ) : null}
      </span>
    </label>
  );
}

/** Outline eye; the `off` variant adds the slash. 16px, inherits currentColor. */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
      {off ? <path d="m4 4 16 16" /> : null}
    </svg>
  );
}
