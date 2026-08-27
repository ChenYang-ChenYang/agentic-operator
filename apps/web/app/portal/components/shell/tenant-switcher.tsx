"use client";

/**
 * TenantSwitcher — dropdown of available tenants with active highlight.
 *
 * Ported from v1_1 app.jsx:181-238. Behaviour:
 *   - Tenant is in the URL (P2-FE-25); selecting one calls `useTenantNavigate`
 *     to push `/portal/<new-slug>/<rest>`.
 *   - "New tenant" opens the 3-step `TenantCreateModal`, then optionally
 *     shows the bootstrap token reveal, then auto-launches the
 *     `ImportManifestModal` so the operator can populate the new tenant.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { TenantCreateResponse } from "@agentic/contracts";
import { Icon } from "../Icon";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant, useTenantNavigate } from "../../lib/use-tenant";
import { toast } from "../toast";
import { TENANTS_KEYS } from "@/lib/hooks/useTenants";
import { TenantCreateModal } from "./TenantCreateModal";
import {
  TenantTokenRevealModal,
  type TenantTokenRevealPayload,
} from "./TenantTokenRevealModal";
import { ImportManifestModal } from "../import-manifest/ImportManifestModal";
import { downloadWorkflowTemplateFile } from "@/lib/hooks/useWorkflowAuthoring";
import styles from "./sidebar.module.css";

export interface TenantOption {
  id: string;
  name: string;
  subtitle?: string;
  color: string;
  agentCount?: number;
  runs24h?: number;
}

export function TenantSwitcher({
  tenants,
  expanded,
  onRequestExpand,
}: {
  tenants: TenantOption[];
  expanded: boolean;
  onRequestExpand: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [tokenReveal, setTokenReveal] =
    useState<TenantTokenRevealPayload | null>(null);
  const [importForSlug, setImportForSlug] = useState<string | null>(null);
  const { t, t: tr } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const activeId = useTenant();
  const navigate = useTenantNavigate();
  const active = tenants.find((t) => t.id === activeId) ?? tenants[0];

  useEffect(() => {
    if (!expanded) setOpen(false);
  }, [expanded]);

  /**
   * The wizard that opens right after a Business Domain is created is an
   * IMPORT wizard, which is a dead end for someone who has no manifest yet.
   * These two give that screen a way forward: create a blank workflow in the
   * new domain, or take the annotated starter file away and edit it.
   */
  function startBlankIn(slug: string) {
    setImportForSlug(null);
    navigate(slug);
    // `?new=blank` is honoured by the workflows view, which opens the New
    // workflow modal with the blank path preselected.
    router.push(`/portal/${slug}/workflows?new=blank`);
  }

  async function downloadTemplate() {
    try {
      const filename = await downloadWorkflowTemplateFile();
      toast({
        tone: "green",
        title: filename,
        description: t("tenantSwitcher.templateDownloaded"),
      });
    } catch (error) {
      toast({
        tone: "red",
        title: t("tenantSwitcher.templateDownloadFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function handleCreated(created: TenantCreateResponse) {
    setCreateOpen(false);
    queryClient.invalidateQueries({ queryKey: TENANTS_KEYS.all });
    router.refresh();
    const slug = created.tenant.slug;
    const name = created.tenant.name;
    toast({
      tone: "green",
      title: t("tenantSwitcher.toastProvisionedTitle"),
      description: t("tenantSwitcher.toastProvisionedDesc", { name, slug }),
    });
    navigate(slug);
    if (created.token?.plaintext) {
      setTokenReveal({
        slug,
        name,
        token: created.token.plaintext,
        scopes: created.token.scopes ?? [],
      });
    } else {
      setImportForSlug(slug);
    }
  }

  if (!active) {
    // Even without an active tenant we still need to render the create modal
    // host so an empty-state UI can mount the switcher.
    return (
      <>
        {createOpen && (
          <TenantCreateModal
            onClose={() => setCreateOpen(false)}
            onCreated={handleCreated}
            existingSlugs={new Set(tenants.map((t) => t.id))}
          />
        )}
        {tokenReveal && (
          <TenantTokenRevealModal
            payload={tokenReveal}
            onClose={() => {
              const slug = tokenReveal.slug;
              setTokenReveal(null);
              setImportForSlug(slug);
            }}
          />
        )}
        {importForSlug && (
          <ImportManifestModal
            onClose={() => setImportForSlug(null)}
            mode="workflow"
            tenantSlug={importForSlug}
            onStartBlank={() => startBlankIn(importForSlug)}
            onDownloadTemplate={() => void downloadTemplate()}
          />
        )}
      </>
    );
  }

  return (
    <div className={styles.tenantSwitcher}>
      <button
        type="button"
        onClick={() => {
          if (!expanded) {
            onRequestExpand();
            return;
          }
          setOpen((v) => !v);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={
          expanded
            ? t("tenantSwitcher.switchAria", { name: active.name })
            : t("tenantSwitcher.openAria", { name: active.name })
        }
        data-sidebar-tooltip={t("tenantSwitcher.tooltip", {
          name: active.name,
        })}
        className={styles.tenantButton}
      >
        <div
          style={{
            width: 22,
            height: 22,
            background: active.color,
            borderRadius: 3,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            fontFamily: "var(--mono)",
            color: "#000",
            fontWeight: 700,
          }}
        >
          {active.name[0]}
        </div>
        <div className={styles.tenantDetails}>
          <div style={{ fontSize: 12, color: "var(--text)", fontWeight: 500 }}>
            {active.name}
          </div>
          {active.subtitle && (
            <div
              style={{
                fontSize: 10.5,
                color: "var(--text-3)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {active.subtitle}
            </div>
          )}
        </div>
        <span className={styles.tenantChevron} aria-hidden="true">
          <Icon
            name="chevron-down"
            size={11}
            style={{ color: "var(--text-3)" }}
          />
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "100%",
            left: 12,
            right: 12,
            zIndex: "var(--z-overlay)" as unknown as number,
            marginTop: 4,
            background: "var(--panel)",
            border: "1px solid var(--border-2)",
            borderRadius: 5,
            boxShadow: "0 8px 20px rgba(0,0,0,0.4)",
            overflow: "hidden",
          }}
        >
          {tenants.map((t) => (
            <button
              key={t.id}
              role="option"
              aria-selected={t.id === active.id}
              onClick={() => {
                if (t.id !== active.id) navigate(t.id);
                setOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "8px 10px",
                background:
                  t.id === active.id ? "var(--panel-2)" : "transparent",
                textAlign: "left",
                fontSize: 12,
                borderBottom: "1px solid var(--border)",
              }}
            >
              <div
                style={{
                  width: 18,
                  height: 18,
                  background: t.color,
                  borderRadius: 3,
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ color: "var(--text)" }}>{t.name}</div>
                {(t.agentCount != null || t.runs24h != null) && (
                  <div style={{ fontSize: 10, color: "var(--text-3)" }}>
                    {t.agentCount != null &&
                      tr("tenantSwitcher.agentCount", { count: t.agentCount })}
                    {t.agentCount != null && t.runs24h != null && " · "}
                    {t.runs24h != null &&
                      tr("tenantSwitcher.runs24h", { count: t.runs24h })}
                  </div>
                )}
              </div>
              {t.id === active.id && (
                <Icon
                  name="check"
                  size={12}
                  style={{ color: "var(--accent-text)" }}
                />
              )}
            </button>
          ))}
          <button
            onClick={() => {
              setOpen(false);
              setCreateOpen(true);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "8px 10px",
              fontSize: 12,
              color: "var(--text-2)",
            }}
          >
            <Icon name="plus" size={11} /> {t("tenantSwitcher.newTenant")}
          </button>
        </div>
      )}
      {createOpen && (
        <TenantCreateModal
          onClose={() => setCreateOpen(false)}
          onCreated={handleCreated}
          existingSlugs={new Set(tenants.map((t) => t.id))}
        />
      )}
      {tokenReveal && (
        <TenantTokenRevealModal
          payload={tokenReveal}
          onClose={() => {
            const slug = tokenReveal.slug;
            setTokenReveal(null);
            setImportForSlug(slug);
          }}
        />
      )}
      {importForSlug && (
        <ImportManifestModal
          onClose={() => setImportForSlug(null)}
          mode="workflow"
          tenantSlug={importForSlug}
          onStartBlank={() => startBlankIn(importForSlug)}
          onDownloadTemplate={() => void downloadTemplate()}
        />
      )}
    </div>
  );
}
