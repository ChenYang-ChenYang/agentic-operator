"use client";

import React from "react";
import Link from "next/link";
import { Icon } from "@/app/portal/components/Icon";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { ApiResponseError } from "@/lib/api-response";
import styles from "./workspace.module.css";

export function isBusinessDomainScopedSessionMiss(error: unknown): boolean {
  return (
    error instanceof ApiResponseError &&
    (error.status === 403 || error.status === 404)
  );
}

export function SessionLoadErrorState({
  tenantSlug,
  tenantName,
  unavailable,
}: {
  tenantSlug: string;
  tenantName: string;
  unavailable: boolean;
}) {
  const { t } = useI18n();
  const sessionCenterHref = `/portal/${tenantSlug}/ontocode-workspace`;

  return (
    <div className={styles.connectedPage}>
      <main
        className={styles.connectionState}
        data-tone="error"
        data-session-load-state={unavailable ? "unavailable" : "failed"}
      >
        <div className={styles.sessionUnavailableCard}>
          <span className={styles.sessionUnavailableIcon} aria-hidden="true">
            <Icon name="alert" size={20} />
          </span>
          <div className={styles.sessionUnavailableCopy}>
            <strong>
              {t(
                unavailable
                  ? "ontocode.workspace.sessionUnavailableTitle"
                  : "ontocode.workspace.loadSessionFailed",
              )}
            </strong>
            <p>
              {t(
                unavailable
                  ? "ontocode.workspace.sessionUnavailableDetail"
                  : "ontocode.workspace.loadSessionFailedDetail",
              )}
            </p>
          </div>
          <div className={styles.sessionUnavailableDomain}>
            <span>{t("ontocode.workspace.currentBusinessDomain")}</span>
            <strong>{tenantName}</strong>
            {tenantName !== tenantSlug ? <code>{tenantSlug}</code> : null}
          </div>
          <Link
            href={sessionCenterHref as never}
            className={styles.sessionUnavailableAction}
          >
            <Icon name="chevron-left" size={13} />
            {t("ontocode.workspace.returnBusinessDomainSessions")}
          </Link>
        </div>
      </main>
    </div>
  );
}
