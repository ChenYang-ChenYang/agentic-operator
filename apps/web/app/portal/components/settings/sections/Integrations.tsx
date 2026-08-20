"use client";

/**
 * Settings → Integrations — configure external services this workspace can
 * reach. Wires to the real `/v1/integrations` surface: list configured
 * integrations, add/edit one, test the connection, and remove one.
 *
 * The editor form is DYNAMIC: it renders the config-field specs derived from
 * the System Profile / tool declarations (`/v1/integrations/requirements`) —
 * base URL + API key remain first-class; extra secrets go to the encrypted
 * bag, non-secrets to the plain bag, env_only fields display presence only.
 * When no richer spec exists it falls back to the classic two-field form.
 *
 * Secret values are write-only — sent on save, never returned; stored fields
 * show "leave blank to keep".
 */

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Icon, Panel } from "@/app/portal/components";
import {
  Field,
  StatusPill,
  TextIn,
} from "@/app/portal/components/settings/atoms";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { BuildConnectionNeeds } from "./BuildConnectionNeeds";
import {
  useDeleteIntegration,
  useIntegrationRequirement,
  useIntegrations,
  useTestIntegration,
  useUpsertIntegration,
  type DerivedConfigField,
  type Integration,
  type IntegrationStatus,
} from "@/lib/hooks/useIntegrations";

function pillStatus(s: IntegrationStatus): "ok" | "warn" | "err" | "off" {
  if (s === "ok") return "ok";
  if (s === "error") return "err";
  return "off";
}

/** Stable render order: endpoint → primary key → the rest → env-only last. */
function fieldOrder(f: DerivedConfigField): number {
  if (f.kind === "base_url") return 0;
  if (f.kind === "api_key" && f.key === "api_key") return 1;
  if (f.kind === "env_only") return 3;
  return 2;
}

/**
 * The exact rule packages/contracts/src/integrations.ts enforces on the wire.
 * Checking it here means the operator learns about a bad provider id before a
 * round-trip, not after.
 */
const MANUAL_PROVIDER_RE = /^[a-z][a-z0-9-]*$/;
const MANUAL_PROVIDER_HINT =
  "集成标识只能用小写字母、数字和连字符，且必须以字母开头（例：object-storage）。";

interface EditorState {
  provider: string;
  isNew: boolean;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** True when the row being edited already has a key stored. */
  hadKey: boolean;
  /** Dynamic extra-field values (beyond base_url/api_key), keyed by spec key. */
  values: Record<string, string>;
  /** Snapshot at open — save() only sends keys the operator changed. */
  initialValues: Record<string, string>;
  /** Extra secret keys already stored server-side (values never come down). */
  storedSecretKeys: string[];
}

export interface IntegrationConfigurationTaskContext {
  state: "loading" | "error" | "ready";
  id: string;
  provider?: string;
  systemName?: string | null;
  taskTitle?: string;
  requirementSummary?: string;
  status?: string;
  returnHref?: string;
}

type ConfigurationTaskProgress = "idle" | "saved" | "tested" | "test_failed";

export function IntegrationsSection({
  initialProvider,
  configurationTask,
  /**
   * #CONFIG-GAPS — set when an operator arrived from a paused Build. It turns
   * this page from a generic provider list into "what THIS Build still needs".
   */
  buildSessionId,
}: {
  initialProvider?: string | null;
  configurationTask?: IntegrationConfigurationTaskContext;
  buildSessionId?: string | null;
}) {
  const { t, language } = useI18n();
  const tenant = useTenant();
  const q = useIntegrations();
  const upsert = useUpsertIntegration();
  const del = useDeleteIntegration();
  const test = useTestIntegration();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taskProgress, setTaskProgress] =
    useState<ConfigurationTaskProgress>("idle");
  const req = useIntegrationRequirement(editor?.provider ?? null);

  const integrations = q.data?.integrations ?? [];
  const available = q.data?.available ?? [];

  // Providers from the catalog that aren't configured yet — the "Add" picker.
  const addable = useMemo(
    () =>
      available.filter((a) => !integrations.some((i) => i.provider === a.id)),
    [available, integrations],
  );
  const taskProviderAvailable =
    configurationTask?.state !== "ready" ||
    !configurationTask.provider ||
    integrations.some(
      (integration) => integration.provider === configurationTask.provider,
    ) ||
    available.some((provider) => provider.id === configurationTask.provider);

  useEffect(() => {
    setTaskProgress("idle");
    setError(null);
  }, [configurationTask?.id]);

  // #MANUAL-INTEGRATION — open the editor for a provider the catalogue has
  // never heard of. The wire protocol already accepts any kebab-case provider
  // (contracts/integrations.ts: "Deliberately NOT an enum of the static
  // catalog"), so derivation coming up short must not leave the operator with
  // no way in.
  function openManualProvider(provider: string) {
    const id = provider.trim().toLowerCase();
    if (!MANUAL_PROVIDER_RE.test(id)) {
      setError(MANUAL_PROVIDER_HINT);
      return;
    }
    openNew({ id, name: id, defaultBaseUrl: "" });
  }

  function openNew(provider: {
    id: string;
    name: string;
    defaultBaseUrl: string;
  }) {
    setError(null);
    setEditor({
      provider: provider.id,
      isNew: true,
      name: provider.name,
      baseUrl: provider.defaultBaseUrl,
      apiKey: "",
      hadKey: false,
      values: {},
      initialValues: {},
      storedSecretKeys: [],
    });
  }

  function openEdit(row: Integration) {
    setError(null);
    // Non-secret dynamic values prefill; secrets start blank (= keep stored).
    const values = { ...(row.config ?? {}) };
    setEditor({
      provider: row.provider,
      isNew: false,
      name: row.name,
      baseUrl: row.baseUrl ?? "",
      apiKey: "",
      hadKey: row.hasKey,
      values,
      initialValues: { ...values },
      storedSecretKeys: row.secretKeysStored ?? [],
    });
  }

  // Deep-link (?section=integrations&provider=x): auto-open that provider's
  // editor once the list has loaded — edit if configured, else add.
  const consumedDeepLink = useRef<string | null>(null);
  useEffect(() => {
    if (!initialProvider || !q.data || editor) return;
    const deepLinkKey = `${configurationTask?.id ?? "direct"}:${initialProvider}`;
    if (consumedDeepLink.current === deepLinkKey) return;
    consumedDeepLink.current = deepLinkKey;
    const row = q.data.integrations.find((i) => i.provider === initialProvider);
    if (row) {
      openEdit(row);
      return;
    }
    const provider = q.data.available.find((a) => a.id === initialProvider);
    if (provider) {
      openNew(provider);
      return;
    }
    // The catalogue does not know this provider. Previously the deep link fell
    // through here in silence and the operator's click did nothing at all.
    openManualProvider(initialProvider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configurationTask?.id, initialProvider, q.data, editor]);

  async function save() {
    if (!editor) return;
    setError(null);
    // Diff dynamic values against the open snapshot: changed keys go up
    // (empty string = delete server-side); untouched keys stay omitted.
    const changed: Record<string, string> = {};
    for (const [k, v] of Object.entries(editor.values)) {
      if ((editor.initialValues[k] ?? "") !== v) changed[k] = v;
    }
    for (const k of Object.keys(editor.initialValues)) {
      if (!(k in editor.values)) changed[k] = "";
    }
    try {
      await upsert.mutateAsync({
        provider: editor.provider,
        name: editor.name || undefined,
        baseUrl: editor.baseUrl.trim() || undefined,
        // Only send the key when the operator typed one — blank means "keep".
        apiKey: editor.apiKey.length > 0 ? editor.apiKey : undefined,
        fields: Object.keys(changed).length > 0 ? changed : undefined,
      });
      if (
        configurationTask?.state === "ready" &&
        configurationTask.provider === editor.provider
      ) {
        setTaskProgress("saved");
      }
      setEditor(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(provider: string, name: string) {
    if (!confirm(t("integrationsSection.removeConfirm", { name }))) return;
    setError(null);
    try {
      await del.mutateAsync(provider);
      if (editor?.provider === provider) setEditor(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function runTest(provider: string) {
    setError(null);
    try {
      const r = await test.mutateAsync(provider);
      if (!r.ok) {
        setError(
          t("integrationsSection.testFailed", {
            error: r.message ?? t("integrationsSection.unknownError"),
          }),
        );
        if (
          configurationTask?.state === "ready" &&
          configurationTask.provider === provider
        ) {
          setTaskProgress("test_failed");
        }
      } else if (
        configurationTask?.state === "ready" &&
        configurationTask.provider === provider
      ) {
        setTaskProgress("tested");
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {configurationTask ? (
        <ConfigurationTaskBanner
          task={configurationTask}
          progress={taskProgress}
          providerAvailable={taskProviderAvailable}
        />
      ) : null}

      {buildSessionId ? (
        <BuildConnectionNeeds
          tenant={tenant}
          sessionId={buildSessionId}
          onConfigureProvider={(provider) => {
            const row = integrations.find((i) => i.provider === provider);
            if (row) {
              openEdit(row);
              return;
            }
            const known = available.find((a) => a.id === provider);
            if (known) {
              openNew(known);
              return;
            }
            openManualProvider(provider);
          }}
        />
      ) : null}

      {error && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "9px 12px",
            background: "rgba(255,107,107,0.08)",
            border: "1px solid rgba(255,107,107,0.3)",
            borderRadius: 5,
            fontSize: 12,
            color: "var(--text-2)",
          }}
        >
          <Icon name="alert" size={12} style={{ color: "var(--red)" }} />
          {error}
        </div>
      )}

      <Panel
        title={t("integrations.title", { n: integrations.length })}
        subtitle={t("integrationsSection.subtitle")}
        padded={false}
        action={
          // There is ALWAYS a way in. A catalogue entry is a shortcut, not a
          // precondition — when derivation offers nothing (or offers a
          // provider that is already configured), the operator can still name
          // the integration by hand.
          <Button
            small
            icon="plus"
            tone="primary"
            onClick={() => {
              if (addable.length > 0) {
                openNew(addable[0]!);
                return;
              }
              const typed = window.prompt(
                `${t("integrations.newIntegration")}\n${MANUAL_PROVIDER_HINT}`,
                "",
              );
              if (typed !== null) openManualProvider(typed);
            }}
            disabled={!!editor}
          >
            {addable.length === 1
              ? t("integrationsSection.addProvider", {
                  name: addable[0]!.name,
                })
              : t("integrations.newIntegration")}
          </Button>
        }
      >
        {q.isLoading && (
          <div style={{ padding: 16, fontSize: 12.5, color: "var(--text-3)" }}>
            {t("integrationsSection.loading")}
          </div>
        )}
        {q.isError && (
          <div style={{ padding: 16, fontSize: 12.5, color: "var(--red)" }}>
            {t("integrationsSection.unavailable")}
          </div>
        )}
        {!q.isLoading && !q.isError && integrations.length === 0 && (
          <div style={{ padding: 16, fontSize: 12.5, color: "var(--text-3)" }}>
            {t("integrationsSection.none")}
            {addable.length > 0 &&
              ` ${t("integrationsSection.addToStart", { name: addable[0]!.name })}`}
          </div>
        )}

        {integrations.map((i, idx) => (
          <div
            key={i.id}
            style={{
              display: "grid",
              gridTemplateColumns: "32px 1fr 220px 150px 84px",
              alignItems: "center",
              gap: 14,
              padding: "12px 14px",
              borderBottom:
                idx < integrations.length - 1
                  ? "1px solid var(--border)"
                  : "none",
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 4,
                background: "var(--panel-2)",
                border: "1px solid var(--border-2)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon
                name="external"
                size={12}
                style={{ color: "var(--text-3)" }}
              />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, color: "var(--text)" }}>{i.name}</div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-3)",
                  fontFamily: "var(--mono)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {i.baseUrl ?? t("integrationsSection.noBaseUrl")} ·{" "}
                {i.hasKey
                  ? (i.keyMasked ?? t("integrationsSection.keySet"))
                  : t("integrationsSection.noKey")}
              </div>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-2)" }}>
              {i.lastError && i.status === "error" ? (
                <span style={{ color: "var(--red)" }}>{i.lastError}</span>
              ) : i.lastError && i.status === "ok" ? (
                // Reachable-with-hint verdicts persist on the row (amber) so the
                // operator sees them after the toast is gone — e.g. "no /health
                // route at this base; check for a missing path prefix".
                <span style={{ color: "var(--signal)" }} title={i.lastError}>
                  ⚠ {i.lastError}
                </span>
              ) : i.lastCheckedAt ? (
                t("integrationsSection.checkedAt", {
                  time: new Date(i.lastCheckedAt).toLocaleString(
                    language === "zh" ? "zh-CN" : "en-US",
                  ),
                })
              ) : (
                t("integrationsSection.notTested")
              )}
            </div>
            <div>
              <StatusPill status={pillStatus(i.status)} />
            </div>
            <div
              style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}
            >
              <Button
                small
                tone="ghost"
                onClick={() => runTest(i.provider)}
                disabled={test.isPending || !i.hasKey}
                title={
                  i.hasKey
                    ? t("integrationsSection.testConnection")
                    : t("integrationsSection.addKeyFirst")
                }
              >
                {test.isPending && test.variables === i.provider
                  ? t("integrationsSection.testing")
                  : t("integrationsSection.test")}
              </Button>
              <Button
                small
                tone="ghost"
                onClick={() => openEdit(i)}
                disabled={!!editor}
                ariaLabel={t("integrationsSection.configureAria", {
                  name: i.name,
                })}
              >
                <Icon name="settings" size={10} />
              </Button>
              <Button
                small
                tone="ghost"
                onClick={() => remove(i.provider, i.name)}
                disabled={del.isPending}
                ariaLabel={t("integrationsSection.removeAria", {
                  name: i.name,
                })}
              >
                <Icon name="x" size={10} />
              </Button>
            </div>
          </div>
        ))}
      </Panel>

      {editor &&
        (() => {
          const requirement = req.data?.requirement;
          const dynFields =
            requirement?.posture === "fields" ||
            requirement?.posture === "env_only"
              ? [...requirement.fields].sort(
                  (a, b) => fieldOrder(a) - fieldOrder(b),
                )
              : [];
          const showLegacy =
            !req.isLoading &&
            dynFields.length === 0 &&
            requirement?.posture !== "none" &&
            requirement?.posture !== "planned" &&
            requirement?.posture !== "server_managed";
          const sourceLabel = (s: DerivedConfigField["source"]) =>
            s === "profile"
              ? t("integrationsSection.sourceProfile")
              : s === "tool"
                ? t("integrationsSection.sourceTool")
                : s === "catalog"
                  ? t("integrationsSection.sourceCatalog")
                  : t("integrationsSection.sourceDefault");
          const isSecretF = (f: DerivedConfigField) =>
            f.secret ??
            (f.kind === "api_key" ||
              f.kind === "secret" ||
              f.kind === "env_only");

          const renderDynField = (f: DerivedConfigField) => {
            const label = f.required ? `${f.label} *` : f.label;
            if (f.kind === "base_url") {
              return (
                <Field
                  key={f.key}
                  label={label}
                  hint={f.hint ?? t("integrationsSection.baseUrlHint")}
                >
                  <TextIn
                    value={editor.baseUrl}
                    onChange={(v) => setEditor({ ...editor, baseUrl: v })}
                    placeholder={f.placeholder ?? "https://…"}
                    mono
                    ariaLabel={f.label}
                  />
                </Field>
              );
            }
            if (f.kind === "api_key" && f.key === "api_key") {
              return (
                <Field
                  key={f.key}
                  label={label}
                  hint={
                    editor.hadKey
                      ? t("integrationsSection.keyStoredHint")
                      : (f.hint ?? t("integrationsSection.newKeyHint"))
                  }
                >
                  <TextIn
                    value={editor.apiKey}
                    onChange={(v) => setEditor({ ...editor, apiKey: v })}
                    placeholder={
                      editor.hadKey
                        ? t("integrationsSection.keepKeyPlaceholder")
                        : (f.placeholder ??
                          t("integrationsSection.keyPlaceholder"))
                    }
                    mono
                    ariaLabel={f.label}
                  />
                </Field>
              );
            }
            if (f.kind === "env_only") {
              const envName = f.envRef ?? f.label;
              return (
                <Field
                  key={f.key}
                  label={label}
                  hint={t("integrationsSection.envOnlyHint", { name: envName })}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 0",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        color: "var(--text-2)",
                      }}
                    >
                      {envName}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        padding: "1px 8px",
                        borderRadius: 999,
                        border: "1px solid var(--border-2)",
                        color: f.envPresent ? "var(--signal)" : "var(--red)",
                      }}
                    >
                      {f.envPresent
                        ? t("integrationsSection.envPresent")
                        : t("integrationsSection.envMissing")}
                    </span>
                  </div>
                </Field>
              );
            }
            if (f.kind === "select") {
              return (
                <Field
                  key={f.key}
                  label={label}
                  hint={
                    f.hint ??
                    (f.source === "profile" ? sourceLabel(f.source) : undefined)
                  }
                >
                  <select
                    value={editor.values[f.key] ?? ""}
                    onChange={(e) =>
                      setEditor({
                        ...editor,
                        values: { ...editor.values, [f.key]: e.target.value },
                      })
                    }
                    aria-label={f.label}
                    style={{
                      width: "100%",
                      padding: "7px 10px",
                      fontSize: 12.5,
                      background: "var(--panel-2)",
                      color: "var(--text)",
                      border: "1px solid var(--border-2)",
                      borderRadius: 5,
                    }}
                  >
                    <option value="">
                      {t("integrationsSection.selectPlaceholder")}
                    </option>
                    {(f.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </Field>
              );
            }
            // Extra secret or plain text field.
            const secret = isSecretF(f);
            const stored = secret && editor.storedSecretKeys.includes(f.key);
            return (
              <Field
                key={f.key}
                label={label}
                hint={
                  stored
                    ? t("integrationsSection.keyStoredHint")
                    : (f.hint ??
                      (secret
                        ? t("integrationsSection.newKeyHint")
                        : f.source === "profile"
                          ? sourceLabel(f.source)
                          : undefined))
                }
              >
                <TextIn
                  value={editor.values[f.key] ?? ""}
                  onChange={(v) =>
                    setEditor({
                      ...editor,
                      values: { ...editor.values, [f.key]: v },
                    })
                  }
                  placeholder={
                    stored
                      ? t("integrationsSection.keepKeyPlaceholder")
                      : (f.placeholder ??
                        (secret
                          ? t("integrationsSection.secretPlaceholder")
                          : ""))
                  }
                  mono
                  ariaLabel={f.label}
                />
              </Field>
            );
          };

          return (
            <Panel
              title={
                editor.isNew
                  ? t("integrationsSection.addTitle", { name: editor.name })
                  : t("integrationsSection.configureTitle", {
                      name: editor.name,
                    })
              }
              subtitle={
                req.data?.profileId
                  ? `${available.find((a) => a.id === editor.provider)?.description ?? ""} · ${t("integrationsSection.sourceProfile")}: ${req.data.systemName}`
                  : (available.find((a) => a.id === editor.provider)
                      ?.description ??
                    t("integrationsSection.configureFallback"))
              }
              padded
            >
              <div style={{ display: "flex", flexDirection: "column" }}>
                {req.isLoading && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-3)",
                      paddingBottom: 8,
                    }}
                  >
                    {t("integrationsSection.reqLoading")}
                  </div>
                )}
                {requirement?.note && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-2)",
                      padding: "8px 10px",
                      marginBottom: 10,
                      background: "var(--panel-2)",
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                    }}
                  >
                    {requirement.posture === "none"
                      ? t("integrationsSection.noConfigNeeded")
                      : requirement.note}
                  </div>
                )}
                {dynFields.map(renderDynField)}
                {showLegacy && (
                  <>
                    <Field
                      label={t("integrationsSection.baseUrl")}
                      hint={t("integrationsSection.baseUrlHint")}
                    >
                      <TextIn
                        value={editor.baseUrl}
                        onChange={(v) => setEditor({ ...editor, baseUrl: v })}
                        placeholder="https://api.gohire.io/v1"
                        mono
                        ariaLabel={t("integrationsSection.baseUrl")}
                      />
                    </Field>
                    <Field
                      label={t("integrationsSection.apiKey")}
                      hint={
                        editor.hadKey
                          ? t("integrationsSection.keyStoredHint")
                          : t("integrationsSection.newKeyHint")
                      }
                    >
                      <TextIn
                        value={editor.apiKey}
                        onChange={(v) => setEditor({ ...editor, apiKey: v })}
                        placeholder={
                          editor.hadKey
                            ? t("integrationsSection.keepKeyPlaceholder")
                            : t("integrationsSection.keyPlaceholder")
                        }
                        mono
                        ariaLabel={t("integrationsSection.apiKey")}
                      />
                    </Field>
                  </>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <Button
                    tone="primary"
                    small
                    onClick={save}
                    disabled={upsert.isPending}
                  >
                    {upsert.isPending
                      ? t("common.saving")
                      : t("integrationsSection.save")}
                  </Button>
                  <Button
                    tone="ghost"
                    small
                    onClick={() => setEditor(null)}
                    disabled={upsert.isPending}
                  >
                    {t("integrationsSection.cancel")}
                  </Button>
                  {!editor.isNew && (
                    <Button
                      tone="ghost"
                      small
                      onClick={() => runTest(editor.provider)}
                      disabled={test.isPending}
                    >
                      {test.isPending
                        ? t("integrationsSection.testing")
                        : t("integrationsSection.testConnection")}
                    </Button>
                  )}
                </div>
              </div>
            </Panel>
          );
        })()}
    </div>
  );
}

function ConfigurationTaskBanner({
  task,
  progress,
  providerAvailable,
}: {
  task: IntegrationConfigurationTaskContext;
  progress: ConfigurationTaskProgress;
  providerAvailable: boolean;
}) {
  const { t } = useI18n();
  const ready = task.state === "ready";
  const tone =
    task.state === "error" || !providerAvailable || progress === "test_failed"
      ? "var(--red)"
      : progress === "saved" || progress === "tested"
        ? "var(--signal)"
        : "var(--text-2)";
  const detail =
    task.state === "loading"
      ? t("integrationsSection.task.loading")
      : task.state === "error"
        ? t("integrationsSection.task.loadFailed")
        : !providerAvailable
          ? t("integrationsSection.task.providerUnavailable", {
              provider: task.provider ?? "—",
            })
          : progress === "tested"
            ? t("integrationsSection.task.tested")
            : progress === "saved"
              ? t("integrationsSection.task.saved")
              : progress === "test_failed"
                ? t("integrationsSection.task.testFailed")
                : t("integrationsSection.task.pending");
  const returnEmphasis = progress === "saved" || progress === "tested";

  return (
    <section
      role={
        task.state === "error" ||
        !providerAvailable ||
        progress === "test_failed"
          ? "alert"
          : "status"
      }
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 14,
        flexWrap: "wrap",
        padding: "12px 14px",
        border: `1px solid color-mix(in srgb, ${tone} 35%, var(--border))`,
        borderRadius: 8,
        background: `color-mix(in srgb, ${tone} 5%, var(--panel))`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          minWidth: 0,
          flex: 1,
        }}
      >
        <Icon
          name={
            task.state === "loading"
              ? "replay"
              : returnEmphasis
                ? "check"
                : task.state === "error" || !providerAvailable
                  ? "alert"
                  : "settings"
          }
          size={15}
          style={{ color: tone, marginTop: 1 }}
        />
        <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
          <strong style={{ color: "var(--text)", fontSize: 12.5 }}>
            {t("integrationsSection.task.title")}
            {task.systemName ? ` · ${task.systemName}` : ""}
          </strong>
          {ready && task.taskTitle ? (
            <span
              style={{ color: "var(--text)", fontSize: 12, lineHeight: 1.5 }}
            >
              {task.taskTitle}
            </span>
          ) : null}
          {ready && task.requirementSummary ? (
            <span
              style={{ color: "var(--text-2)", fontSize: 12, lineHeight: 1.5 }}
            >
              {task.requirementSummary}
            </span>
          ) : null}
          <span
            style={{ color: "var(--text-2)", fontSize: 12, lineHeight: 1.5 }}
          >
            {detail}
          </span>
          {ready ? (
            <code
              style={{
                color: "var(--text-3)",
                fontSize: 10.5,
                overflowWrap: "anywhere",
              }}
            >
              {task.id} · {task.provider} · {task.status}
            </code>
          ) : null}
        </div>
      </div>
      {ready && task.returnHref ? (
        <Link
          href={task.returnHref}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 10px",
            borderRadius: 5,
            border: `1px solid ${
              returnEmphasis ? "var(--signal)" : "var(--border-2)"
            }`,
            background: returnEmphasis ? "var(--signal)" : "transparent",
            color: returnEmphasis ? "var(--on-signal)" : "var(--text-2)",
            textDecoration: "none",
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          {returnEmphasis
            ? t("integrationsSection.task.returnToVerify")
            : t("integrationsSection.task.return")}
          <Icon name="chevron-right" size={11} />
        </Link>
      ) : null}
    </section>
  );
}
