"use client";

/**
 * ErpIntegrationBanner — the reminder an operator asked for on 2026-09-07:
 * when the Meta ERP behind the live workflow cannot be reached (VPN off,
 * proxy intercepting, base URL wrong), say so on the workflow page itself
 * instead of letting them discover it from a red run several minutes later.
 *
 * Renders nothing while the live manifest uses no ERP or every target is
 * configured and reachable. Data: `GET /v1/integrations/erp/status`.
 */

import { useI18n } from "@/app/portal/lib/preferences-context";
import { useErpStatus } from "@/lib/hooks/useErpStatus";

export function ErpIntegrationBanner() {
  const { t, language } = useI18n();
  const status = useErpStatus();
  const data = status.data;
  if (!data || !data.usesErp || data.ok) return null;
  const broken = data.targets.filter(
    (target) => !target.configured || target.reachable === false,
  );
  if (broken.length === 0) return null;
  const joiner = language === "zh" ? "、" : ", ";
  // Every agent of an ERP-centric workflow binds the ERP; listing all 29 is
  // noise. Name a few, count the rest.
  const MAX_NAMED = 5;
  const agentList = (agents: string[]): string => {
    const named = agents.slice(0, MAX_NAMED).join(joiner);
    return agents.length > MAX_NAMED
      ? `${named}${t("workflowPage.erpAgentsMore", { count: agents.length - MAX_NAMED })}`
      : named;
  };
  return (
    <div
      role="alert"
      data-testid="erp-integration-banner"
      style={{
        margin: "0 0 10px",
        padding: "10px 14px",
        borderRadius: 8,
        border: "1px solid color-mix(in srgb, var(--amber) 55%, transparent)",
        background: "color-mix(in srgb, var(--amber) 10%, var(--panel))",
        color: "var(--text)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 12.5,
        lineHeight: 1.5,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontWeight: 600 }}>⚠ {t("workflowPage.erpBannerTitle")}</span>
        <button
          type="button"
          onClick={() => void status.refetch()}
          disabled={status.isFetching}
          style={{
            marginLeft: "auto",
            fontSize: 11.5,
            padding: "3px 9px",
            borderRadius: 5,
            border: "1px solid var(--border-2)",
            background: "var(--panel-2)",
            color: "var(--text-2)",
            cursor: status.isFetching ? "default" : "pointer",
          }}
        >
          {status.isFetching
            ? t("workflowPage.erpChecking")
            : t("workflowPage.erpRecheck")}
        </button>
      </div>
      {broken.map((target) => (
        <div key={target.env}>
          {target.configured
            ? t("workflowPage.erpUnreachable", {
                env: target.env,
                url: target.baseUrl ?? "",
                error: target.error ?? "",
                agents: agentList(target.agents),
              })
            : t("workflowPage.erpNotConfigured", {
                env: target.env,
                agents: agentList(target.agents),
              })}
        </div>
      ))}
      <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>
        {t("workflowPage.erpBannerHint")}
      </div>
    </div>
  );
}
