"use client";

/** Settings only exposes sections backed by working persistence/API routes. */

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon, ViewHeader } from "@/app/portal/components";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useSession } from "@/app/portal/lib/session-context";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useDirty } from "@/app/portal/lib/dirty-context";
import {
  SETTINGS_SECTIONS,
  resolveDeepLinkedSection,
  type SettingsSectionId,
} from "@/app/portal/components/settings/data";
import { WorkspaceSection } from "@/app/portal/components/settings/sections/Workspace";
import { AppearanceSection } from "@/app/portal/components/settings/sections/Appearance";
import { AccountSection } from "@/app/portal/components/settings/sections/Account";
import { PeopleSection } from "@/app/portal/components/settings/sections/People";
import { AISection } from "@/app/portal/components/settings/sections/AI";
import { ModelsSection } from "@/app/portal/components/settings/sections/Models";
import { TokensSection } from "@/app/portal/components/settings/sections/Tokens";
import {
  IntegrationsSection,
  type IntegrationConfigurationTaskContext,
} from "@/app/portal/components/settings/sections/Integrations";
import { BillingSection } from "@/app/portal/components/settings/sections/Billing";
import {
  ontocodeConfigurationTaskProvider,
  ontocodeConfigurationTaskSessionHref,
  ontocodeConfigurationTaskSystemName,
  useOntoCodeConfigurationTask,
} from "@/lib/hooks/useOntoCodeWorkspace";

// P3-FE-03 / P3-FE-05 — these section ids deep-link to their own sub-routes
// instead of being rendered inline (the views are too heavy to live in the
// section switch). Clicking the sidebar entry pushes the URL; refresh +
// browser back/forward work.
const ROUTED_SECTIONS: Record<string, string> = {
  usage: "usage",
  audit: "audit",
};

// Region label for the workspace subtitle. Comes from
// `NEXT_PUBLIC_AGENTIC_REGION` so prod/staging can differ. **No fake
// fallback** — if the env var isn't set we show "—" so the operator
// doesn't read a region they didn't deploy to (the prior default was
// "cn-shenzhen-1", which actively misled non-China deployments).
const REGION = (process.env.NEXT_PUBLIC_AGENTIC_REGION ?? "").trim() || "—";

export default function SettingsPage() {
  const searchParams = useSearchParams();
  // Honor a `?section=` deep-link on entry (e.g. OntoCode's "去配置" → Integrations)
  // so callers can land the operator on the relevant tab, not the default one.
  const [section, setSection] = useState<SettingsSectionId>(() =>
    resolveDeepLinkedSection(searchParams.get("section")),
  );
  const sec =
    SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0];
  const router = useRouter();
  const tenant = useTenant();
  const dirty = useDirty();
  const session = useSession();
  const { t } = useI18n();
  const operatorName = session?.name ?? "—";
  const rawConfigurationTaskId = searchParams.get("configTask");
  const configurationTaskId =
    rawConfigurationTaskId &&
    /^ocfg-[a-f0-9]{32}$/u.test(rawConfigurationTaskId.trim())
      ? rawConfigurationTaskId.trim()
      : "";
  // #CONFIG-GAPS — arriving from a paused Build carries its Session id, which
  // turns the integration list into "what THIS Build still needs". Shape-check
  // it the same way the configTask id is checked: a malformed value must not
  // become a query.
  const rawBuildSessionId = searchParams.get("session");
  const buildSessionId =
    rawBuildSessionId && /^ocs-[a-f0-9]{16}$/u.test(rawBuildSessionId.trim())
      ? rawBuildSessionId.trim()
      : null;
  const configurationTaskQuery = useOntoCodeConfigurationTask(
    tenant,
    configurationTaskId,
  );
  const resolvedConfigurationTask = configurationTaskQuery.data?.task;
  let configurationTask: IntegrationConfigurationTaskContext | undefined;
  if (rawConfigurationTaskId !== null) {
    if (!configurationTaskId) {
      configurationTask = {
        state: "error",
        id: rawConfigurationTaskId,
      };
    } else if (configurationTaskQuery.isLoading) {
      configurationTask = {
        state: "loading",
        id: configurationTaskId,
      };
    } else if (
      configurationTaskQuery.isError ||
      !resolvedConfigurationTask ||
      resolvedConfigurationTask.id !== configurationTaskId
    ) {
      configurationTask = {
        state: "error",
        id: configurationTaskId,
      };
    } else {
      const provider = ontocodeConfigurationTaskProvider(
        resolvedConfigurationTask,
      );
      configurationTask = provider
        ? {
            state: "ready",
            id: resolvedConfigurationTask.id,
            provider,
            systemName: ontocodeConfigurationTaskSystemName(
              resolvedConfigurationTask,
            ),
            taskTitle: resolvedConfigurationTask.title,
            requirementSummary: resolvedConfigurationTask.requirement.summary,
            status: resolvedConfigurationTask.status,
            returnHref: ontocodeConfigurationTaskSessionHref(
              tenant,
              resolvedConfigurationTask,
            ),
          }
        : {
            state: "error",
            id: resolvedConfigurationTask.id,
          };
    }
  }
  // A configuration-task link trusts only its opaque task id. The provider
  // query remains available for ordinary Settings links, but is ignored as
  // soon as a task is present.
  const initialIntegrationProvider =
    rawConfigurationTaskId !== null
      ? configurationTask?.state === "ready"
        ? configurationTask.provider
        : null
      : searchParams.get("provider");

  function pick(id: SettingsSectionId) {
    if (id === section) return;
    // Guard in-progress edits (AI gateway drafts, workspace identity, …)
    // against a silent section switch — same dirty-context contract as the
    // workflow editor.
    if (dirty.isDirty()) {
      const detail = dirty.describe();
      const confirmed = window.confirm(
        detail
          ? t("settingsPage.unsavedConfirmWithDetail", { detail })
          : t("settingsPage.unsavedConfirm"),
      );
      if (!confirmed) return;
    }
    const sub = ROUTED_SECTIONS[id];
    if (sub) {
      router.push(`/portal/${tenant}/settings/${sub}` as never);
      return;
    }
    setSection(id);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("settings.title")}
        subtitle={
          <>
            {t("settingsPage.workspaceLabel")}{" "}
            <span className="mono" style={{ color: "var(--text)" }}>
              {tenant}
            </span>{" "}
            · {t("settingsPage.regionLabel")}{" "}
            <span className="mono" style={{ color: "var(--text)" }}>
              {REGION}
            </span>{" "}
            · {t("settingsPage.operatorLabel")}{" "}
            <span style={{ color: "var(--text)" }}>{operatorName}</span>
          </>
        }
      />

      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "232px 1fr",
          minHeight: 0,
        }}
      >
        <aside
          style={{
            borderRight: "1px solid var(--border)",
            overflow: "auto",
            padding: "14px 10px",
            background: "var(--bg-2)",
          }}
        >
          {SETTINGS_SECTIONS.map((s) => (
            <SectionNavItem
              key={s.id}
              section={s}
              active={s.id === section}
              onClick={() => pick(s.id)}
            />
          ))}
        </aside>

        <div style={{ overflow: "auto", minHeight: 0 }}>
          {/* The AI section hosts a three-column gateway console; give it a
           * wider canvas than the form-style sections. */}
          <div
            style={{ padding: 24, maxWidth: section === "ai" ? 1320 : 1080 }}
          >
            <SectionHeader section={sec} />
            {section === "workspace" && <WorkspaceSection />}
            {section === "appearance" && <AppearanceSection />}
            {section === "account" && <AccountSection />}
            {section === "people" && <PeopleSection />}
            {section === "ai" && <AISection />}
            {section === "models" && <ModelsSection />}
            {section === "tokens" && <TokensSection />}
            {section === "integrations" && (
              <IntegrationsSection
                initialProvider={initialIntegrationProvider}
                configurationTask={configurationTask}
                buildSessionId={buildSessionId}
              />
            )}
            {section === "billing" && <BillingSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionNavItem({
  section,
  active,
  onClick,
}: {
  section: (typeof SETTINGS_SECTIONS)[number];
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "8px 10px",
        marginBottom: 2,
        background: active ? "var(--panel-2)" : "transparent",
        borderLeft: `2px solid ${active ? "var(--signal)" : "transparent"}`,
        borderRadius: 4,
        textAlign: "left",
        cursor: "pointer",
        transition: "background 0.1s",
      }}
    >
      <Icon
        name={section.icon}
        size={13}
        style={{ color: active ? "var(--text)" : "var(--text-3)" }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12.5,
            color: active ? "var(--text)" : "var(--text-2)",
            fontWeight: active ? 500 : 400,
          }}
        >
          {t(`settings.section.${section.id}`)}
        </div>
        <div
          style={{
            fontSize: 10,
            color: "var(--text-3)",
            marginTop: 1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {t(`settings.hint.${section.id}`)}
        </div>
      </div>
    </button>
  );
}

function SectionHeader({
  section,
}: {
  section: (typeof SETTINGS_SECTIONS)[number];
}) {
  const { t } = useI18n();
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <Icon
          name={section.icon}
          size={14}
          style={{ color: "var(--accent-text)" }}
        />
        <span
          style={{
            fontSize: 11,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "var(--text-3)",
          }}
        >
          {t("settings.title")} · {t(`settings.section.${section.id}`)}
        </span>
      </div>
      <h2
        style={{
          margin: 0,
          fontSize: 26,
          fontFamily: "var(--display)",
          fontWeight: 400,
          letterSpacing: "-0.01em",
          color: "var(--text)",
        }}
      >
        {t(`settings.section.${section.id}`)}
      </h2>
      <div style={{ marginTop: 4, fontSize: 12.5, color: "var(--text-2)" }}>
        {t(`settings.hint.${section.id}`)}
      </div>
    </div>
  );
}
