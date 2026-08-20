"use client";

/**
 * Tenants — workspace management table (P5-TEN-01b).
 *
 * Lists every tenant the operator can see (active + optionally archived),
 * with inline edit / archive / restore actions and an entry point into the
 * 4-step create wizard that the sidebar TenantSwitcher already mounts.
 *
 * Why this lives at `/portal/<tenant>/tenants` rather than `/portal/tenants`:
 * the App Router shell (`apps/web/app/portal/[tenant]/layout.tsx`) owns the
 * sidebar + topbar + provider tree. Putting this view under `[tenant]`
 * keeps it inside that shell with no special-case routing.
 *
 * Mutations: `useUpdateTenant`, `useArchiveTenant`, `useRestoreTenant` —
 * hooks below speak directly to the api with `credentials: "same-origin"`
 * so the session cookie carries over. Each mutation invalidates
 * `TENANTS_KEYS.all` so the sidebar dropdown reflects the change.
 *
 * Bootstrap-token reveal: the sidebar already shows the one-shot modal on
 * successful create. This table only handles updates / archive / restore,
 * none of which produce a token.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Empty,
  Icon,
  Panel,
  ViewHeader,
  ModalOverlay,
  useToast,
} from "@/app/portal/components";
import { fmtAgo } from "@/app/portal/lib/format";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  TENANTS_KEYS,
  useSetTenantInngestDeployment,
  useTenants,
  type TenantListItem,
} from "@/lib/hooks/useTenants";
import { useIsSuperadmin } from "@/lib/hooks/useMe";
import { isVisibleRuntimeDomain } from "@/lib/domain-display";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { readApiData } from "@/lib/api-response";
import { DomainSyncPanel } from "./domain-sync";
import { RuntimeProfilesPanel } from "./runtime-profiles";

const DEFAULT_COLORS = [
  "#d0ff00",
  "#7c9eff",
  "#f5c46b",
  "#65e0a3",
  "#b594ff",
  "#ff6470",
  "#5deeff",
  "#ffb547",
];

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

async function callV1<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
    ...init,
  });
  return readApiData<T>(res, path);
}

interface UpdateInput {
  slug: string;
  patch: { name?: string; subtitle?: string | null; color?: string | null };
}

function useUpdateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateInput) =>
      callV1<TenantListItem>(`/v1/tenants/${input.slug}`, {
        method: "PUT",
        body: JSON.stringify(input.patch),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TENANTS_KEYS.all });
    },
  });
}

interface ArchiveInput {
  slug: string;
  confirm: string;
  reason?: string;
}

function useArchiveTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ArchiveInput) =>
      callV1<{ slug: string; archivedAt: number }>(
        `/v1/tenants/${input.slug}`,
        {
          method: "DELETE",
          body: JSON.stringify({
            confirm: input.confirm,
            reason: input.reason,
          }),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TENANTS_KEYS.all });
    },
  });
}

function useRestoreTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      callV1<TenantListItem>(`/v1/tenants/${slug}/restore`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TENANTS_KEYS.all });
    },
  });
}

export default function TenantsPage() {
  const activeTenant = useTenant();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [editTarget, setEditTarget] = useState<TenantListItem | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<TenantListItem | null>(
    null,
  );
  const toast = useToast();
  const restore = useRestoreTenant();
  const setInngestDeployment = useSetTenantInngestDeployment();
  const isSuperadmin = useIsSuperadmin();
  const { t } = useI18n();

  const query = useTenants({ includeArchived });

  function handleRestore(slug: string) {
    restore.mutate(slug, {
      onSuccess: () =>
        toast({
          tone: "green",
          title: t("tenants.toastRestored"),
          description: slug,
        }),
      onError: (err) =>
        toast({
          tone: "red",
          title: t("tenants.toastRestoreFailed"),
          description: (err as Error).message,
        }),
    });
  }

  function handleInngestDeployment(target: TenantListItem, enabled: boolean) {
    const confirmation = enabled
      ? t("tenants.inngestDeployConfirm", { name: target.name })
      : t("tenants.inngestStopConfirm", { name: target.name });
    if (!window.confirm(confirmation)) return;
    setInngestDeployment.mutate(
      { slug: target.slug, enabled },
      {
        onSuccess: (result) =>
          toast({
            tone: enabled ? "green" : "amber",
            title: enabled
              ? t("tenants.inngestDeployedToast")
              : t("tenants.inngestStoppedToast"),
            description: enabled
              ? t("tenants.inngestFunctionCount", {
                  count: result.functionCount,
                })
              : result.appId,
          }),
        onError: (error) =>
          toast({
            tone: "red",
            title: t("tenants.inngestChangeFailedToast"),
            description: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }

  const rows = (query.data?.items ?? []).filter((row) =>
    isVisibleRuntimeDomain(row),
  );
  const rowCount: string | number =
    query.isError && !query.data
      ? "—"
      : query.isLoading && !query.data
        ? "…"
        : rows.length;
  const activeRows = rows.filter((row) => !row.archivedAt);
  const processScopedRows = activeRows.filter(
    (row) => row.inngestProcessScoped,
  );
  const deployedCount = processScopedRows.filter(
    (row) => row.inngestEnabled,
  ).length;

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "20px 24px" }}>
      <ViewHeader
        title={t("nav.tenants")}
        subtitle={t("tenants.subtitle")}
        badge={
          <Badge tone="muted" style={{ fontFamily: "var(--mono)" }}>
            {rowCount}{" "}
            {rowCount === 1
              ? t("tenants.countSingular")
              : t("tenants.countPlural")}
          </Badge>
        }
      />

      <div style={{ marginBottom: 14 }}>
        <DomainSyncPanel activeTenant={activeTenant} />
      </div>

      <div style={{ marginBottom: 14 }}>
        <RuntimeProfilesPanel activeTenant={activeTenant} />
      </div>

      <Panel
        title={t("tenants.inngestPanelTitle")}
        style={{ marginBottom: 14 }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div
            style={{
              color: "var(--text-2)",
              fontSize: 12,
              lineHeight: 1.5,
              maxWidth: 760,
            }}
          >
            {t("tenants.inngestPanelHint")}
          </div>
          <Badge tone="signal" style={{ whiteSpace: "nowrap" }}>
            {t("tenants.inngestSelectedCount", {
              selected: deployedCount,
              total: processScopedRows.length,
            })}
          </Badge>
        </div>
      </Panel>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 14,
          fontSize: 12,
          color: "var(--text-3)",
        }}
      >
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          {t("tenants.showArchived")}
        </label>
        <button
          onClick={() => query.refetch()}
          style={{
            padding: "3px 8px",
            border: "1px solid var(--border-2)",
            borderRadius: 4,
            color: "var(--text-2)",
            fontSize: 11,
            background: "transparent",
          }}
        >
          {t("tenants.refresh")}
        </button>
        <span style={{ marginLeft: "auto", color: "var(--text-3)" }}>
          {t("tenants.createHint")}
        </span>
      </div>

      {query.isError && (
        <div
          style={{
            padding: "8px 12px",
            marginBottom: 12,
            background: "color-mix(in srgb, var(--red) 8%, transparent)",
            border: "1px solid color-mix(in srgb, var(--red) 30%, transparent)",
            borderRadius: 4,
            color: "var(--red)",
            fontSize: 12,
          }}
        >
          {(query.error as Error).message}
        </div>
      )}

      {query.isError && !query.data ? null : query.isLoading &&
        rows.length === 0 ? (
        <Empty
          title={t("tenants.loadingTitle")}
          hint={t("tenants.loadingHint")}
        />
      ) : rows.length === 0 ? (
        <Empty
          title={t("tenants.emptyTitle")}
          hint={
            includeArchived
              ? t("tenants.emptyHintAll")
              : t("tenants.emptyHintActive")
          }
        />
      ) : (
        <TenantsTable
          rows={rows}
          onEdit={setEditTarget}
          onArchive={setArchiveTarget}
          onRestore={handleRestore}
          onInngestDeployment={handleInngestDeployment}
          deploymentPendingSlug={setInngestDeployment.variables?.slug ?? null}
          isDeploymentPending={setInngestDeployment.isPending}
          isSuperadmin={isSuperadmin}
        />
      )}

      {editTarget && (
        <EditModal
          target={editTarget}
          onClose={() => setEditTarget(null)}
          onUpdated={(slug) => {
            setEditTarget(null);
            toast({
              tone: "green",
              title: t("tenants.toastUpdated"),
              description: slug,
            });
          }}
        />
      )}
      {archiveTarget && (
        <ArchiveModal
          target={archiveTarget}
          onClose={() => setArchiveTarget(null)}
          onArchived={(slug) => {
            setArchiveTarget(null);
            toast({
              tone: "amber",
              title: t("tenants.toastArchived"),
              description: slug,
            });
          }}
        />
      )}
    </div>
  );
}

// ─── Table ─────────────────────────────────────────────────────────────────

function TenantsTable({
  rows,
  onEdit,
  onArchive,
  onRestore,
  onInngestDeployment,
  deploymentPendingSlug,
  isDeploymentPending,
  isSuperadmin,
}: {
  rows: TenantListItem[];
  onEdit: (t: TenantListItem) => void;
  onArchive: (t: TenantListItem) => void;
  onRestore: (slug: string) => void;
  onInngestDeployment: (t: TenantListItem, enabled: boolean) => void;
  deploymentPendingSlug: string | null;
  isDeploymentPending: boolean;
  isSuperadmin: boolean;
}) {
  const { t } = useI18n();
  return (
    <Panel padded={false}>
      <div
        style={{
          display: "grid",
          minWidth: 1080,
          gridTemplateColumns:
            "32px 1.1fr 1.3fr 70px 70px 70px 120px 1fr 270px",
          gap: 12,
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
          fontSize: 10,
          fontFamily: "var(--mono)",
          color: "var(--text-3)",
          textTransform: "uppercase",
          letterSpacing: "0.1em",
        }}
      >
        <div></div>
        <div>{t("tenants.colTenant")}</div>
        <div>{t("tenants.colDescription")}</div>
        <div style={{ textAlign: "right" }}>{t("tenants.colAgents")}</div>
        <div style={{ textAlign: "right" }}>{t("tenants.colRuns24h")}</div>
        <div style={{ textAlign: "right" }}>{t("tenants.colOpenTasks")}</div>
        <div>{t("tenants.colInngest")}</div>
        <div>{t("tenants.colCreated")}</div>
        <div></div>
      </div>
      {rows.map((t) => {
        const displayName = t.name;
        return (
          <Row
            key={t.slug}
            tenant={t}
            displayName={displayName}
            onEdit={() => onEdit({ ...t, name: displayName })}
            onArchive={() => onArchive({ ...t, name: displayName })}
            onRestore={() => onRestore(t.slug)}
            onInngestDeployment={(enabled) => onInngestDeployment(t, enabled)}
            deploymentPending={
              isDeploymentPending && deploymentPendingSlug === t.slug
            }
            deploymentMutationActive={isDeploymentPending}
            canManageDeployment={isSuperadmin || t.membership === "admin"}
          />
        );
      })}
    </Panel>
  );
}

function Row({
  tenant,
  displayName,
  onEdit,
  onArchive,
  onRestore,
  onInngestDeployment,
  deploymentPending,
  deploymentMutationActive,
  canManageDeployment,
}: {
  tenant: TenantListItem;
  displayName: string;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onInngestDeployment: (enabled: boolean) => void;
  deploymentPending: boolean;
  deploymentMutationActive: boolean;
  canManageDeployment: boolean;
}) {
  const { language, t } = useI18n();
  const archived = !!tenant.archivedAt;
  return (
    <div
      style={{
        display: "grid",
        minWidth: 1080,
        gridTemplateColumns: "32px 1.1fr 1.3fr 70px 70px 70px 120px 1fr 270px",
        gap: 12,
        padding: "12px 14px",
        borderBottom: "1px solid var(--border)",
        alignItems: "center",
        opacity: archived ? 0.55 : 1,
      }}
    >
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: 4,
          background: tenant.color ?? "#6f7178",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#000",
          fontFamily: "var(--mono)",
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        {displayName[0] ?? "?"}
      </div>
      <div>
        <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 500 }}>
          {displayName}
        </div>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10.5,
            color: "var(--text-3)",
          }}
        >
          {tenant.slug}
          {archived && (
            <Badge tone="amber" style={{ marginLeft: 8, fontSize: 9 }}>
              {t("tenants.archivedBadge")}
            </Badge>
          )}
        </div>
      </div>
      <div
        style={{
          color: "var(--text-2)",
          fontSize: 12,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {tenant.subtitle ?? <span style={{ color: "var(--text-4)" }}>—</span>}
      </div>
      <div
        style={{
          textAlign: "right",
          fontFamily: "var(--mono)",
          fontSize: 12,
          color: "var(--text)",
        }}
      >
        {tenant.agentCount}
      </div>
      <div
        style={{
          textAlign: "right",
          fontFamily: "var(--mono)",
          fontSize: 12,
          color: "var(--text)",
        }}
      >
        {tenant.runs24h}
      </div>
      <div
        style={{
          textAlign: "right",
          fontFamily: "var(--mono)",
          fontSize: 12,
          color: tenant.openTasks > 0 ? "var(--amber)" : "var(--text)",
        }}
      >
        {tenant.openTasks}
      </div>
      <div style={{ display: "flex", alignItems: "center" }}>
        {!tenant.inngestProcessScoped ? (
          <Badge tone="muted">{t("tenants.inngestExternal")}</Badge>
        ) : tenant.inngestEnabled ? (
          <Badge tone="signal">{t("tenants.inngestDeployed")}</Badge>
        ) : (
          <Badge tone="muted">{t("tenants.inngestStopped")}</Badge>
        )}
      </div>
      <div
        style={{
          color: "var(--text-3)",
          fontSize: 11,
          fontFamily: "var(--mono)",
        }}
      >
        {fmtAgo(tenant.createdAt, language)}
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        {!archived ? (
          <>
            {canManageDeployment && tenant.inngestProcessScoped && (
              <button
                onClick={() => onInngestDeployment(!tenant.inngestEnabled)}
                disabled={deploymentMutationActive}
                style={{
                  padding: "3px 8px",
                  border: `1px solid color-mix(in srgb, ${
                    tenant.inngestEnabled ? "var(--amber)" : "var(--signal)"
                  } 35%, transparent)`,
                  borderRadius: 4,
                  fontSize: 11,
                  color: tenant.inngestEnabled
                    ? "var(--amber)"
                    : "var(--signal)",
                  background: "transparent",
                  opacity: deploymentMutationActive ? 0.55 : 1,
                }}
              >
                {deploymentPending
                  ? t("tenants.inngestChanging")
                  : tenant.inngestEnabled
                    ? t("tenants.inngestStop")
                    : t("tenants.inngestDeploy")}
              </button>
            )}
            <button
              onClick={onEdit}
              style={{
                padding: "3px 8px",
                border: "1px solid var(--border-2)",
                borderRadius: 4,
                fontSize: 11,
                color: "var(--text-2)",
                background: "transparent",
              }}
            >
              {t("tenants.edit")}
            </button>
            <button
              onClick={onArchive}
              style={{
                padding: "3px 8px",
                border:
                  "1px solid color-mix(in srgb, var(--red) 30%, transparent)",
                borderRadius: 4,
                fontSize: 11,
                color: "var(--red)",
                background: "transparent",
              }}
            >
              {t("tenants.archive")}
            </button>
          </>
        ) : (
          <button
            onClick={onRestore}
            style={{
              padding: "3px 8px",
              border: "1px solid var(--border-2)",
              borderRadius: 4,
              fontSize: 11,
              color: "var(--text-2)",
              background: "transparent",
            }}
          >
            {t("tenants.restore")}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Edit modal ────────────────────────────────────────────────────────────

function EditModal({
  target,
  onClose,
  onUpdated,
}: {
  target: TenantListItem;
  onClose: () => void;
  onUpdated: (slug: string) => void;
}) {
  const [name, setName] = useState(target.name);
  const [subtitle, setSubtitle] = useState(target.subtitle ?? "");
  const [color, setColor] = useState(target.color ?? DEFAULT_COLORS[0]!);
  const update = useUpdateTenant();
  const { t } = useI18n();

  const colorOk = HEX_COLOR_RE.test(color);
  const canSave = name.trim().length > 0 && colorOk && !update.isPending;

  function submit() {
    if (!canSave) return;
    update.mutate(
      {
        slug: target.slug,
        patch: {
          name: name.trim(),
          subtitle: subtitle.trim() || null,
          color,
        },
      },
      {
        onSuccess: () => onUpdated(target.slug),
      },
    );
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div
        style={{
          width: 480,
          maxWidth: "92vw",
          background: "var(--panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 6,
          boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>
            {t("tenants.editTitle")} · {target.slug}
          </div>
          <button
            onClick={onClose}
            style={{
              color: "var(--text-3)",
              padding: 4,
              background: "transparent",
              border: "none",
            }}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
        <div
          style={{
            padding: "16px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {update.isError && (
            <div
              style={{
                padding: "8px 12px",
                background: "color-mix(in srgb, var(--red) 8%, transparent)",
                border:
                  "1px solid color-mix(in srgb, var(--red) 30%, transparent)",
                borderRadius: 4,
                color: "var(--red)",
                fontSize: 12,
              }}
            >
              {(update.error as Error).message}
            </div>
          )}
          <Field label={t("tenants.fieldName")}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle()}
            />
          </Field>
          <Field label={t("tenants.fieldSubtitle")}>
            <input
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              style={inputStyle()}
            />
          </Field>
          <Field
            label={t("tenants.fieldAccent")}
            error={!colorOk ? t("tenants.colorError") : null}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {DEFAULT_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  type="button"
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 5,
                    background: c,
                    border:
                      color === c
                        ? "2px solid var(--text)"
                        : "1px solid var(--border-2)",
                    cursor: "pointer",
                  }}
                  title={c}
                />
              ))}
              <input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                style={{
                  ...inputStyle(),
                  width: 110,
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                }}
              />
            </div>
          </Field>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>
            {t("tenants.slugImmutable")}
          </div>
        </div>
        <div
          style={{
            padding: "12px 18px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: "6px 12px",
              border: "1px solid var(--border-2)",
              borderRadius: 4,
              fontSize: 12,
              color: "var(--text-2)",
              background: "transparent",
            }}
          >
            {t("tenants.cancel")}
          </button>
          <Button tone="primary" disabled={!canSave} onClick={submit}>
            {update.isPending ? t("tenants.saving") : t("tenants.save")}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}

// ─── Archive modal (confirm by typing slug) ───────────────────────────────

function ArchiveModal({
  target,
  onClose,
  onArchived,
}: {
  target: TenantListItem;
  onClose: () => void;
  onArchived: (slug: string) => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const archive = useArchiveTenant();
  const { t } = useI18n();

  function submit() {
    if (confirm !== target.slug || archive.isPending) return;
    archive.mutate(
      {
        slug: target.slug,
        confirm,
        reason: reason.trim() || undefined,
      },
      {
        onSuccess: () => onArchived(target.slug),
      },
    );
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div
        style={{
          width: 480,
          maxWidth: "92vw",
          background: "var(--panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 6,
          boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>
            {t("tenants.archiveTitle")} · {target.slug}
          </div>
          <button
            onClick={onClose}
            style={{
              color: "var(--text-3)",
              padding: 4,
              background: "transparent",
              border: "none",
            }}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
        <div
          style={{
            padding: "16px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {archive.isError && (
            <div
              style={{
                padding: "8px 12px",
                background: "color-mix(in srgb, var(--red) 8%, transparent)",
                border:
                  "1px solid color-mix(in srgb, var(--red) 30%, transparent)",
                borderRadius: 4,
                color: "var(--red)",
                fontSize: 12,
              }}
            >
              {(archive.error as Error).message}
            </div>
          )}
          <div
            style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}
          >
            {t("tenants.archiveBody", { name: target.name })}
          </div>
          <Field
            label={t("tenants.confirmLabel", { slug: target.slug })}
            preserveCase
          >
            <input
              autoFocus
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={target.slug}
              style={{ ...inputStyle(), fontFamily: "var(--mono)" }}
            />
          </Field>
          <Field label={t("tenants.fieldReason")}>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              style={{
                ...inputStyle(),
                resize: "vertical",
                minHeight: 60,
              }}
            />
          </Field>
        </div>
        <div
          style={{
            padding: "12px 18px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: "6px 12px",
              border: "1px solid var(--border-2)",
              borderRadius: 4,
              fontSize: 12,
              color: "var(--text-2)",
              background: "transparent",
            }}
          >
            {t("tenants.cancel")}
          </button>
          <Button
            tone="danger"
            disabled={confirm !== target.slug || archive.isPending}
            onClick={submit}
          >
            {archive.isPending ? t("tenants.archiving") : t("tenants.archive")}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}

// ─── Layout primitives ─────────────────────────────────────────────────────

function Field({
  label,
  error,
  preserveCase = false,
  children,
}: {
  label: string;
  error?: string | null;
  preserveCase?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div
        style={{
          fontSize: 11,
          fontFamily: "var(--mono)",
          color: "var(--text-3)",
          textTransform: preserveCase ? "none" : "uppercase",
          letterSpacing: preserveCase ? 0 : "0.08em",
        }}
      >
        {label}
      </div>
      {children}
      {error && (
        <div style={{ fontSize: 11, color: "var(--red)" }}>{error}</div>
      )}
    </div>
  );
}

function inputStyle(): React.CSSProperties {
  return {
    padding: "7px 10px",
    background: "var(--bg)",
    border: "1px solid var(--border-2)",
    borderRadius: 4,
    color: "var(--text)",
    fontSize: 13,
    fontFamily: "var(--sans)",
    width: "100%",
  };
}
