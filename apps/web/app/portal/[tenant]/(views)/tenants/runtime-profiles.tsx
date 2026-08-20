"use client";

import { useMemo, useState } from "react";
import type {
  RuntimeAdapterCoordinates,
  RuntimeProfileVersion,
} from "@agentic/contracts";
import { Badge, Button, Icon, Panel, useToast } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useIsSuperadmin } from "@/lib/hooks/useMe";
import {
  useArchiveRuntimeProfile,
  useCreateRuntimeProfile,
  useCreateRuntimeProfileVersion,
  useRuntimeProfiles,
} from "@/lib/hooks/useRuntimeProfiles";

interface EditorState {
  mode: "create" | "version";
  profileId: string | null;
  name: string;
  description: string;
  kind: RuntimeAdapterCoordinates["kind"];
  adapterRegistrySlug: string;
  adapterRegistryVersion: string;
  eventNamespace: string;
  compatibilityTenantSlug: string;
}

const EMPTY_EDITOR: EditorState = {
  mode: "create",
  profileId: null,
  name: "",
  description: "",
  kind: "native",
  adapterRegistrySlug: "",
  adapterRegistryVersion: "",
  eventNamespace: "",
  compatibilityTenantSlug: "",
};

function versionEditor(
  profileId: string,
  name: string,
  description: string | null,
  version: RuntimeProfileVersion,
): EditorState {
  return {
    mode: "version",
    profileId,
    name,
    description: description ?? "",
    kind: version.adapter.kind,
    adapterRegistrySlug: version.adapter.adapterRegistrySlug,
    adapterRegistryVersion: version.adapter.adapterRegistryVersion,
    eventNamespace: version.adapter.eventNamespace,
    compatibilityTenantSlug:
      version.adapter.compatibilityTenantSlug ?? "",
  };
}

export function RuntimeProfilesPanel({
  activeTenant,
}: {
  activeTenant: string;
}) {
  const { t } = useI18n();
  const isSuperadmin = useIsSuperadmin();
  const toast = useToast();
  const profiles = useRuntimeProfiles(activeTenant, { includeArchived: true });
  const createProfile = useCreateRuntimeProfile(activeTenant);
  const createVersion = useCreateRuntimeProfileVersion(activeTenant);
  const archiveProfile = useArchiveRuntimeProfile(activeTenant);
  const [showArchived, setShowArchived] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const rows = useMemo(
    () =>
      (profiles.data?.items ?? [])
        .filter(
          ({ profile }) => showArchived || profile.status !== "archived",
        )
        .sort(
          (a, b) =>
            Number(b.profile.status === "active") -
              Number(a.profile.status === "active") ||
            a.profile.name.localeCompare(b.profile.name),
        ),
    [profiles.data?.items, showArchived],
  );
  const pending =
    createProfile.isPending ||
    createVersion.isPending ||
    archiveProfile.isPending;

  function adapterFromEditor(): RuntimeAdapterCoordinates {
    return {
      kind: editor!.kind,
      adapterRegistrySlug: editor!.adapterRegistrySlug.trim(),
      adapterRegistryVersion: editor!.adapterRegistryVersion.trim(),
      eventNamespace: editor!.eventNamespace.trim(),
      compatibilityTenantSlug:
        editor!.kind === "tenant_registry_compat"
          ? editor!.compatibilityTenantSlug.trim()
          : null,
    };
  }

  async function saveEditor() {
    if (!editor) return;
    try {
      const receipt =
        editor.mode === "create"
          ? await createProfile.mutateAsync({
              name: editor.name.trim(),
              description: editor.description.trim() || undefined,
              adapter: adapterFromEditor(),
            })
          : await createVersion.mutateAsync({
              profileId: editor.profileId!,
              request: { adapter: adapterFromEditor() },
            });
      setEditor(null);
      toast({
        tone: "green",
        title:
          receipt.mode === "created"
            ? t("tenants.runtimeProfiles.created")
            : t("tenants.runtimeProfiles.versionCreated"),
        description: `${receipt.profile.name} · v${
          receipt.version?.version ?? "—"
        }`,
      });
    } catch (error) {
      toast({
        tone: "red",
        title: t("tenants.runtimeProfiles.saveFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const editorValid =
    Boolean(editor?.name.trim()) &&
    Boolean(editor?.adapterRegistrySlug.trim()) &&
    Boolean(editor?.adapterRegistryVersion.trim()) &&
    Boolean(editor?.eventNamespace.trim()) &&
    (editor?.kind !== "tenant_registry_compat" ||
      Boolean(editor.compatibilityTenantSlug.trim()));

  return (
    <section id="runtime-profiles">
      <Panel title={t("tenants.runtimeProfiles.panelTitle")}>
        <div style={{ display: "grid", gap: 14, padding: 14 }}>
          <div style={headerStyle}>
            <div style={{ maxWidth: 780 }}>
              <div style={titleRowStyle}>
                <Badge tone="signal">
                  {t("tenants.runtimeProfiles.businessDomain")}
                </Badge>
                <strong style={{ fontSize: 13 }}>{activeTenant}</strong>
                <Icon name="chevron-right" size={12} />
                <Badge tone="muted">
                  {t("tenants.runtimeProfiles.runtimeProfiles")}
                </Badge>
              </div>
              <p style={descriptionStyle}>
                {t("tenants.runtimeProfiles.description")}
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <label style={checkboxStyle}>
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(event) => setShowArchived(event.target.checked)}
                />
                {t("tenants.runtimeProfiles.showArchived")}
              </label>
              {isSuperadmin ? (
                <Button
                  tone="primary"
                  icon="plus"
                  disabled={pending}
                  onClick={() => setEditor({ ...EMPTY_EDITOR })}
                >
                  {t("tenants.runtimeProfiles.create")}
                </Button>
              ) : (
                <Badge tone="muted">
                  {t("tenants.runtimeProfiles.platformManaged")}
                </Badge>
              )}
            </div>
          </div>

          {editor ? (
            <div style={editorStyle}>
              <div style={editorTitleStyle}>
                <div>
                  <strong style={{ fontSize: 12.5 }}>
                    {editor.mode === "create"
                      ? t("tenants.runtimeProfiles.createTitle")
                      : t("tenants.runtimeProfiles.versionTitle", {
                          name: editor.name,
                        })}
                  </strong>
                  <p style={editorHintStyle}>
                    {t("tenants.runtimeProfiles.immutableHint")}
                  </p>
                </div>
                <Button small onClick={() => setEditor(null)} disabled={pending}>
                  {t("common.discard")}
                </Button>
              </div>
              <div style={formGridStyle}>
                {editor.mode === "create" ? (
                  <>
                    <Field
                      label={t("tenants.runtimeProfiles.name")}
                      value={editor.name}
                      disabled={pending}
                      onChange={(name) =>
                        setEditor((current) =>
                          current ? { ...current, name } : current,
                        )
                      }
                    />
                    <Field
                      label={t("tenants.runtimeProfiles.descriptionLabel")}
                      value={editor.description}
                      disabled={pending}
                      onChange={(description) =>
                        setEditor((current) =>
                          current ? { ...current, description } : current,
                        )
                      }
                    />
                  </>
                ) : null}
                <label style={fieldStyle}>
                  <span style={fieldLabelStyle}>
                    {t("tenants.runtimeProfiles.adapterKind")}
                  </span>
                  <select
                    value={editor.kind}
                    disabled={pending}
                    style={inputStyle}
                    onChange={(event) =>
                      setEditor((current) =>
                        current
                          ? {
                              ...current,
                              kind: event.target.value as EditorState["kind"],
                              compatibilityTenantSlug:
                                event.target.value === "native"
                                  ? ""
                                  : current.compatibilityTenantSlug,
                            }
                          : current,
                      )
                    }
                  >
                    <option value="native">
                      {t("tenants.runtimeProfiles.native")}
                    </option>
                    <option value="tenant_registry_compat">
                      {t("tenants.runtimeProfiles.compatibility")}
                    </option>
                  </select>
                </label>
                <Field
                  label={t("tenants.runtimeProfiles.registrySlug")}
                  value={editor.adapterRegistrySlug}
                  disabled={pending}
                  onChange={(adapterRegistrySlug) =>
                    setEditor((current) =>
                      current ? { ...current, adapterRegistrySlug } : current,
                    )
                  }
                />
                <Field
                  label={t("tenants.runtimeProfiles.registryVersion")}
                  value={editor.adapterRegistryVersion}
                  disabled={pending}
                  onChange={(adapterRegistryVersion) =>
                    setEditor((current) =>
                      current
                        ? { ...current, adapterRegistryVersion }
                        : current,
                    )
                  }
                />
                <Field
                  label={t("tenants.runtimeProfiles.eventNamespace")}
                  value={editor.eventNamespace}
                  disabled={pending}
                  onChange={(eventNamespace) =>
                    setEditor((current) =>
                      current ? { ...current, eventNamespace } : current,
                    )
                  }
                />
                {editor.kind === "tenant_registry_compat" ? (
                  <Field
                    label={t("tenants.runtimeProfiles.compatibilitySlug")}
                    value={editor.compatibilityTenantSlug}
                    disabled={pending}
                    onChange={(compatibilityTenantSlug) =>
                      setEditor((current) =>
                        current
                          ? { ...current, compatibilityTenantSlug }
                          : current,
                      )
                    }
                  />
                ) : null}
              </div>
              <div style={editorFooterStyle}>
                <span>
                  {t("tenants.runtimeProfiles.credentialScope", {
                    tenant: activeTenant,
                  })}
                </span>
                <Button
                  tone="primary"
                  disabled={!editorValid || pending}
                  onClick={() => void saveEditor()}
                >
                  {pending
                    ? t("common.saving")
                    : t("tenants.runtimeProfiles.save")}
                </Button>
              </div>
            </div>
          ) : null}

          {profiles.isError ? (
            <div style={errorStyle} role="alert">
              <Icon name="alert" size={13} />
              {t("tenants.runtimeProfiles.readError", {
                message: (profiles.error as Error).message,
              })}
            </div>
          ) : null}

          <div style={{ display: "grid", gap: 8 }}>
            {rows.map(({ profile, versions }) => {
              const sortedVersions = [...versions].sort(
                (a, b) => b.version - a.version,
              );
              const latest = sortedVersions[0];
              return (
                <div
                  key={profile.id}
                  style={{
                    ...rowStyle,
                    opacity: profile.status === "archived" ? 0.68 : 1,
                    background:
                      profile.status === "archived"
                        ? "var(--panel-3)"
                        : "var(--panel)",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={titleRowStyle}>
                      <strong style={{ fontSize: 12.5 }}>{profile.name}</strong>
                      <Badge
                        tone={
                          profile.status === "active" ? "blue" : "muted"
                        }
                      >
                        {t(
                          `tenants.runtimeProfiles.status.${profile.status}`,
                        )}
                      </Badge>
                      <Badge tone="muted">
                        {t("tenants.runtimeProfiles.versionCount", {
                          count: versions.length,
                        })}
                      </Badge>
                    </div>
                    {profile.description ? (
                      <p style={rowDescriptionStyle}>{profile.description}</p>
                    ) : null}
                    {latest ? (
                      <div style={coordinatesStyle}>
                        <span>v{latest.version}</span>
                        <span>{latest.adapter.kind}</span>
                        <span>
                          {latest.adapter.adapterRegistrySlug}@
                          {latest.adapter.adapterRegistryVersion}
                        </span>
                        <span>{latest.adapter.eventNamespace}</span>
                        {latest.adapter.compatibilityTenantSlug ? (
                          <span>
                            compat:
                            {latest.adapter.compatibilityTenantSlug}
                          </span>
                        ) : null}
                        <span>
                          {t("tenants.runtimeProfiles.credentialsOwned")}
                        </span>
                      </div>
                    ) : null}
                  </div>
                  <div style={actionsStyle}>
                    {isSuperadmin &&
                    profile.status === "active" &&
                    latest ? (
                      <Button
                        small
                        disabled={pending}
                        onClick={() =>
                          setEditor(
                            versionEditor(
                              profile.id,
                              profile.name,
                              profile.description,
                              latest,
                            ),
                          )
                        }
                      >
                        {t("tenants.runtimeProfiles.newVersion")}
                      </Button>
                    ) : null}
                    {isSuperadmin && profile.status === "active" ? (
                      <Button
                        small
                        tone="danger"
                        disabled={pending}
                        onClick={() => {
                          if (
                            !window.confirm(
                              t("tenants.runtimeProfiles.archiveConfirm", {
                                name: profile.name,
                              }),
                            )
                          ) {
                            return;
                          }
                          void archiveProfile
                            .mutateAsync({
                              profileId: profile.id,
                              request: { confirmName: profile.name },
                            })
                            .then(() =>
                              toast({
                                tone: "green",
                                title: t(
                                  "tenants.runtimeProfiles.archived",
                                ),
                                description: profile.name,
                              }),
                            )
                            .catch((error) =>
                              toast({
                                tone: "red",
                                title: t(
                                  "tenants.runtimeProfiles.archiveFailed",
                                ),
                                description:
                                  error instanceof Error
                                    ? error.message
                                    : String(error),
                              }),
                            );
                        }}
                      >
                        {t("tenants.runtimeProfiles.archive")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {!profiles.isLoading && !profiles.isError && rows.length === 0 ? (
              <div style={emptyStyle}>
                {t("tenants.runtimeProfiles.empty")}
              </div>
            ) : null}
          </div>
        </div>
      </Panel>
    </section>
  );
}

function Field({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label style={fieldStyle}>
      <span style={fieldLabelStyle}>{label}</span>
      <input
        value={value}
        disabled={disabled}
        style={inputStyle}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 16,
  flexWrap: "wrap",
};
const titleRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  flexWrap: "wrap",
};
const descriptionStyle: React.CSSProperties = {
  margin: "5px 0 0",
  color: "var(--text-2)",
  fontSize: 12,
  lineHeight: 1.55,
};
const checkboxStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  color: "var(--text-3)",
  fontSize: 11,
};
const editorStyle: React.CSSProperties = {
  display: "grid",
  gap: 12,
  padding: 12,
  border: "1px solid color-mix(in srgb, var(--signal) 32%, var(--border))",
  borderRadius: 7,
  background: "var(--panel-2)",
};
const editorTitleStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
};
const editorHintStyle: React.CSSProperties = {
  margin: "4px 0 0",
  color: "var(--text-3)",
  fontSize: 10.5,
  lineHeight: 1.5,
};
const formGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
  gap: 10,
};
const fieldStyle: React.CSSProperties = {
  display: "grid",
  gap: 5,
};
const fieldLabelStyle: React.CSSProperties = {
  color: "var(--text-3)",
  fontSize: 10,
  fontWeight: 650,
  letterSpacing: ".04em",
  textTransform: "uppercase",
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 32,
  border: "1px solid var(--border-2)",
  borderRadius: 5,
  padding: "0 9px",
  color: "var(--text)",
  background: "var(--panel)",
  fontSize: 11.5,
  outline: "none",
};
const editorFooterStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  color: "var(--text-3)",
  fontSize: 10.5,
};
const rowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 12,
  padding: "11px 12px",
  border: "1px solid var(--border)",
  borderRadius: 7,
};
const rowDescriptionStyle: React.CSSProperties = {
  margin: "5px 0 0",
  color: "var(--text-2)",
  fontSize: 11,
  lineHeight: 1.45,
};
const coordinatesStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  marginTop: 6,
  color: "var(--text-3)",
  fontFamily: "var(--mono)",
  fontSize: 10,
  flexWrap: "wrap",
};
const actionsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 6,
  flexWrap: "wrap",
};
const emptyStyle: React.CSSProperties = {
  padding: 18,
  border: "1px dashed var(--border-2)",
  borderRadius: 7,
  color: "var(--text-3)",
  fontSize: 12,
  textAlign: "center",
};
const errorStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "8px 10px",
  border: "1px solid color-mix(in srgb, var(--red) 32%, transparent)",
  borderRadius: 6,
  color: "var(--red)",
  background: "color-mix(in srgb, var(--red) 5%, transparent)",
  fontSize: 11,
};
