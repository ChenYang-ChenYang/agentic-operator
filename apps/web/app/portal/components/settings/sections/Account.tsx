"use client";

/**
 * Settings → Account — the signed-in user's OWN credentials.
 *
 * Deliberately separate from People/Access, which manage OTHER users and
 * require admin rights: every user can reach this, including one with no
 * memberships at all. Verification lives entirely in the api
 * (POST /v1/me/password re-checks the current password), so a stolen session
 * still cannot rotate a password without knowing the existing one.
 */

import { useState } from "react";
import { Button, Panel } from "@/app/portal/components";
import { Field, TextIn } from "@/app/portal/components/settings/atoms";
import { toast } from "@/app/portal/components/toast";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useChangePassword, useMe } from "@/lib/hooks/useMe";
import { formatApiError } from "@/lib/api-response";
import { PASSWORD_MIN } from "@agentic/contracts";

export function AccountSection() {
  const { t } = useI18n();
  const me = useMe();
  const changePassword = useChangePassword();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const tooShort = newPassword.length > 0 && newPassword.length < PASSWORD_MIN;
  const mismatch =
    confirmPassword.length > 0 && newPassword !== confirmPassword;
  // Catching "same as current" here keeps the user from believing a rotation
  // happened when nothing changed — the api would accept it happily.
  const unchanged =
    newPassword.length > 0 && newPassword === currentPassword;
  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length >= PASSWORD_MIN &&
    newPassword === confirmPassword &&
    !unchanged &&
    !changePassword.isPending;

  async function submit() {
    setError(null);
    try {
      await changePassword.mutateAsync({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast({ tone: "signal", title: t("account.toastChanged") });
    } catch (e) {
      setError(formatApiError(e, t, "account.apiUnreachable"));
    }
  }

  const problem = tooShort
    ? t("account.errTooShort", { min: PASSWORD_MIN })
    : mismatch
      ? t("account.errMismatch")
      : unchanged
        ? t("account.errUnchanged")
        : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Panel title={t("account.identityTitle")}>
        <Field label={t("account.emailLabel")}>
          <div style={{ fontSize: 12.5, color: "var(--text-2)", paddingTop: 6 }}>
            {me.data?.user.email ?? "—"}
          </div>
        </Field>
        <Field label={t("account.nameLabel")}>
          <div style={{ fontSize: 12.5, color: "var(--text-2)", paddingTop: 6 }}>
            {me.data?.user.name ?? "—"}
          </div>
        </Field>
      </Panel>

      <Panel title={t("account.passwordTitle")}>
        <Field
          label={t("account.currentLabel")}
          hint={t("account.currentHint")}
        >
          <TextIn
            type="password"
            value={currentPassword}
            onChange={setCurrentPassword}
            ariaLabel={t("account.currentLabel")}
          />
        </Field>
        <Field
          label={t("account.newLabel")}
          hint={t("account.newHint", { min: PASSWORD_MIN })}
        >
          <TextIn
            type="password"
            value={newPassword}
            onChange={setNewPassword}
            ariaLabel={t("account.newLabel")}
          />
        </Field>
        <Field label={t("account.confirmLabel")}>
          <TextIn
            type="password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            ariaLabel={t("account.confirmLabel")}
          />
        </Field>

        {(problem || error) && (
          <div
            role="alert"
            style={{
              fontSize: 11.5,
              color: "var(--red)",
              padding: "10px 0 0",
            }}
          >
            {error ?? problem}
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            paddingTop: 14,
          }}
        >
          <Button
            tone="primary"
            small
            onClick={submit}
            disabled={!canSubmit}
          >
            {changePassword.isPending
              ? t("account.changing")
              : t("account.changePassword")}
          </Button>
        </div>
      </Panel>
    </div>
  );
}
