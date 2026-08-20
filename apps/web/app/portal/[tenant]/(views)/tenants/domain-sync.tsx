"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Icon, Panel, useToast } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  useArchiveBusinessOntologyDomain,
  useBusinessOntologyDomainCatalog,
  useBusinessOntologyDomains,
  useRegisterBusinessOntologyDomain,
  useUpdateBusinessOntologyDomain,
  useVerifyBusinessOntologyDomain,
} from "@/lib/hooks/useBusinessOntologyDomains";
import {
  useBindBusinessOntologyDomainRuntimeProfile,
  useRuntimeProfiles,
} from "@/lib/hooks/useRuntimeProfiles";

/**
 * One Business Domain can own many exact Ontology Domain registrations.
 * This panel changes only the tenant-scoped association. Archiving never
 * claims to delete the corresponding Domain from Allmeta.
 */
export function DomainSyncPanel({ activeTenant }: { activeTenant: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const registry = useBusinessOntologyDomains(activeTenant, {
    includeArchived: true,
    includeUnavailable: true,
  });
  const catalog = useBusinessOntologyDomainCatalog(activeTenant);
  const register = useRegisterBusinessOntologyDomain(activeTenant);
  const update = useUpdateBusinessOntologyDomain(activeTenant);
  const verify = useVerifyBusinessOntologyDomain(activeTenant);
  const archive = useArchiveBusinessOntologyDomain(activeTenant);
  const runtimeProfiles = useRuntimeProfiles(activeTenant, {
    includeArchived: true,
  });
  const bindRuntimeProfile =
    useBindBusinessOntologyDomainRuntimeProfile(activeTenant);
  const [catalogDomainId, setCatalogDomainId] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const rows = useMemo(
    () =>
      (registry.data?.items ?? [])
        .filter((domain) => showArchived || domain.status !== "archived")
        .sort(
          (a, b) =>
            Number(b.isDefault) - Number(a.isDefault) ||
            a.displayName.localeCompare(b.displayName),
        ),
    [registry.data?.items, showArchived],
  );
  const attachableCatalog = useMemo(
    () =>
      (catalog.data?.items ?? []).filter(
        (item) =>
          !item.registrationId || item.registrationStatus === "archived",
      ),
    [catalog.data?.items],
  );
  const selectedCatalogId =
    attachableCatalog.some(
      (item) => item.ontologyDomainId === catalogDomainId,
    )
      ? catalogDomainId
      : attachableCatalog[0]?.ontologyDomainId ?? "";
  const mutationPending =
    register.isPending ||
    update.isPending ||
    verify.isPending ||
    archive.isPending ||
    bindRuntimeProfile.isPending;
  const runtimeProfileVersions = useMemo(
    () =>
      (runtimeProfiles.data?.items ?? [])
        .flatMap(({ profile, versions }) =>
          versions.map((version) => ({ profile, version })),
        )
        .sort(
          (a, b) =>
            a.profile.name.localeCompare(b.profile.name) ||
            b.version.version - a.version.version,
        ),
    [runtimeProfiles.data?.items],
  );

  function notifySuccess(title: string, detail: string) {
    toast({ tone: "green", title, description: detail });
  }

  function notifyError(title: string, error: unknown) {
    toast({
      tone: "red",
      title,
      description: error instanceof Error ? error.message : String(error),
    });
  }

  async function attachSelectedDomain() {
    if (!selectedCatalogId) return;
    try {
      const receipt = await register.mutateAsync({
        ontologyDomainId: selectedCatalogId,
        source: "allmeta",
        makeDefault:
          !(registry.data?.items ?? []).some(
            (domain) => domain.status === "active" && domain.isDefault,
          ),
      });
      setCatalogDomainId("");
      notifySuccess(
        t("tenants.domainSync.registered"),
        receipt.domain.displayName,
      );
    } catch (error) {
      notifyError(t("tenants.domainSync.registerFailed"), error);
    }
  }

  return (
    <section id="ontology-domains">
      <Panel title={t("tenants.domainSync.panelTitle")}>
        <div style={{ display: "grid", gap: 14, padding: 14 }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ maxWidth: 760 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 5,
                }}
              >
                <Badge tone="signal">
                  {t("tenants.domainSync.businessDomain")}
                </Badge>
                <strong style={{ fontSize: 13 }}>{activeTenant}</strong>
                <Icon name="chevron-right" size={12} />
                <Badge tone="muted">
                  {t("tenants.domainSync.ontologyDomains")}
                </Badge>
              </div>
              <p
                style={{
                  margin: 0,
                  color: "var(--text-2)",
                  fontSize: 12,
                  lineHeight: 1.55,
                }}
              >
                {t("tenants.domainSync.description")}
              </p>
            </div>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                color: "var(--text-3)",
                fontSize: 11,
              }}
            >
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
              />
              {t("tenants.domainSync.showArchived")}
            </label>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(260px, 1fr) auto",
              gap: 8,
              padding: 10,
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--panel-2)",
            }}
          >
            <label style={{ display: "grid", gap: 5 }}>
              <span
                style={{
                  color: "var(--text-3)",
                  fontSize: 10,
                  fontWeight: 650,
                  letterSpacing: ".04em",
                  textTransform: "uppercase",
                }}
              >
                {t("tenants.domainSync.allmetaCatalog")}
              </span>
              <select
                value={selectedCatalogId}
                onChange={(event) => setCatalogDomainId(event.target.value)}
                disabled={
                  catalog.isLoading ||
                  mutationPending ||
                  attachableCatalog.length === 0
                }
                style={selectStyle}
              >
                {attachableCatalog.length === 0 ? (
                  <option value="">
                    {catalog.isLoading
                      ? t("tenants.domainSync.loadingCatalog")
                      : t("tenants.domainSync.noAttachableDomains")}
                  </option>
                ) : null}
                {attachableCatalog.map((item) => (
                  <option
                    key={item.ontologyDomainId}
                    value={item.ontologyDomainId}
                  >
                    {item.displayName} · {item.ontologyDomainId}
                  </option>
                ))}
              </select>
            </label>
            <Button
              tone="primary"
              icon="plus"
              disabled={!selectedCatalogId || mutationPending}
              onClick={() => void attachSelectedDomain()}
              style={{ alignSelf: "end", height: 32 }}
            >
              {register.isPending
                ? t("tenants.domainSync.registering")
                : t("tenants.domainSync.register")}
            </Button>
          </div>

          {catalog.data?.catalogError ? (
            <div style={errorStyle} role="alert">
              <Icon name="alert" size={13} />
              {t("tenants.domainSync.catalogError", {
                message: catalog.data.catalogError,
              })}
            </div>
          ) : null}
          {registry.isError ? (
            <div style={errorStyle} role="alert">
              <Icon name="alert" size={13} />
              {t("tenants.domainSync.readError", {
                message: (registry.error as Error).message,
              })}
            </div>
          ) : null}

          <div style={{ display: "grid", gap: 8 }}>
            {rows.map((domain) => (
              <div
                key={domain.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  alignItems: "center",
                  gap: 12,
                  padding: "11px 12px",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  background:
                    domain.status === "archived"
                      ? "var(--panel-3)"
                      : "var(--panel)",
                  opacity: domain.status === "archived" ? 0.68 : 1,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      flexWrap: "wrap",
                    }}
                  >
                    <strong style={{ fontSize: 12.5 }}>
                      {domain.displayName}
                    </strong>
                    {domain.isDefault ? (
                      <Badge tone="green">
                        {t("tenants.domainSync.default")}
                      </Badge>
                    ) : null}
                    <Badge
                      tone={
                        domain.status === "active"
                          ? "blue"
                          : domain.status === "unavailable"
                            ? "amber"
                            : "muted"
                      }
                    >
                      {t(`tenants.domainSync.status.${domain.status}`)}
                    </Badge>
                    <Badge tone="muted">{domain.source}</Badge>
                    <Badge
                      tone={
                        domain.executionReadiness.executable
                          ? "green"
                          : domain.executionReadiness.state === "invalid" ||
                              domain.executionReadiness.state ===
                                "profile_archived"
                            ? "red"
                            : "amber"
                      }
                    >
                      {domain.executionReadiness.executable
                        ? t("tenants.domainSync.runtimeReady")
                        : t("tenants.domainSync.runtimeBlocked")}
                    </Badge>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 12,
                      marginTop: 5,
                      color: "var(--text-3)",
                      fontFamily: "var(--mono)",
                      fontSize: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <span>{domain.ontologyDomainId}</span>
                    <span>{domain.id}</span>
                    {domain.lastVerifiedAt ? (
                      <span>
                        {t("tenants.domainSync.verifiedAt")}{" "}
                        {new Date(domain.lastVerifiedAt).toLocaleString()}
                      </span>
                    ) : null}
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gap: 4,
                      marginTop: 7,
                      padding: "7px 8px",
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                      background: "var(--panel-2)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: 7,
                        alignItems: "center",
                        flexWrap: "wrap",
                        fontSize: 10.5,
                      }}
                    >
                      <strong>
                        {t("tenants.domainSync.runtimeBinding")}
                      </strong>
                      {domain.runtimeProfileVersion ? (
                        <>
                          <span style={{ color: "var(--text-2)" }}>
                            {
                              domain.runtimeProfileVersion.adapter
                                .adapterRegistrySlug
                            }
                            @
                            {
                              domain.runtimeProfileVersion.adapter
                                .adapterRegistryVersion
                            }
                          </span>
                          <span style={{ color: "var(--text-3)" }}>
                            v{domain.runtimeProfileVersion.version}
                          </span>
                          <span style={{ color: "var(--text-3)" }}>
                            {domain.runtimeProfileVersion.adapter.eventNamespace}
                          </span>
                        </>
                      ) : (
                        <span style={{ color: "var(--text-3)" }}>
                          {domain.runtimeBindingMode === "legacy_native"
                            ? t("tenants.domainSync.legacyRuntime")
                            : t("tenants.domainSync.runtimeUnbound")}
                        </span>
                      )}
                    </div>
                    <span
                      style={{
                        color: domain.executionReadiness.executable
                          ? "var(--text-3)"
                          : "var(--amber)",
                        fontSize: 10.5,
                        lineHeight: 1.45,
                      }}
                    >
                      {domain.executionReadiness.message}
                    </span>
                    <span
                      style={{
                        color: "var(--text-3)",
                        fontSize: 10,
                        lineHeight: 1.4,
                      }}
                    >
                      {t("tenants.domainSync.credentialsStayHere", {
                        tenant: activeTenant,
                      })}
                    </span>
                  </div>
                  {domain.lastError ? (
                    <p
                      style={{
                        margin: "6px 0 0",
                        color: "var(--red)",
                        fontSize: 10.5,
                      }}
                    >
                      {domain.lastError}
                    </p>
                  ) : null}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    gap: 6,
                    flexWrap: "wrap",
                  }}
                >
                  {domain.status === "active" ? (
                    <select
                      aria-label={t("tenants.domainSync.bindRuntime")}
                      value={domain.runtimeProfileVersionId ?? ""}
                      disabled={
                        mutationPending || runtimeProfileVersions.length === 0
                      }
                      style={{ ...selectStyle, width: 220 }}
                      onChange={(event) => {
                        const runtimeProfileVersionId = event.target.value;
                        if (!runtimeProfileVersionId) return;
                        void bindRuntimeProfile
                          .mutateAsync({
                            registrationId: domain.id,
                            request: { runtimeProfileVersionId },
                          })
                          .then((receipt) =>
                            notifySuccess(
                              t("tenants.domainSync.runtimeBound"),
                              receipt.domain.displayName,
                            ),
                          )
                          .catch((error) =>
                            notifyError(
                              t("tenants.domainSync.runtimeBindFailed"),
                              error,
                            ),
                          );
                      }}
                    >
                      <option value="">
                        {runtimeProfiles.isLoading
                          ? t("tenants.domainSync.runtimeLoading")
                          : t("tenants.domainSync.bindRuntime")}
                      </option>
                      {runtimeProfileVersions.map(({ profile, version }) => (
                        <option
                          key={version.id}
                          value={version.id}
                          disabled={profile.status !== "active"}
                        >
                          {profile.name} · v{version.version} ·{" "}
                          {version.adapter.adapterRegistrySlug}
                          {profile.status !== "active"
                            ? ` · ${t("tenants.domainSync.runtimeArchived")}`
                            : ""}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {domain.status === "active" && !domain.isDefault ? (
                    <Button
                      small
                      disabled={mutationPending}
                      onClick={() => {
                        void update
                          .mutateAsync({
                            registrationId: domain.id,
                            patch: { makeDefault: true },
                          })
                          .then((receipt) =>
                            notifySuccess(
                              t("tenants.domainSync.defaultUpdated"),
                              receipt.domain.displayName,
                            ),
                          )
                          .catch((error) =>
                            notifyError(
                              t("tenants.domainSync.defaultFailed"),
                              error,
                            ),
                          );
                      }}
                    >
                      {t("tenants.domainSync.setDefault")}
                    </Button>
                  ) : null}
                  {domain.status !== "archived" ? (
                    <Button
                      small
                      icon="replay"
                      disabled={mutationPending}
                      onClick={() => {
                        void verify
                          .mutateAsync(domain.id)
                          .then((receipt) =>
                            notifySuccess(
                              t("tenants.domainSync.verified"),
                              receipt.domain.displayName,
                            ),
                          )
                          .catch((error) =>
                            notifyError(
                              t("tenants.domainSync.verifyFailed"),
                              error,
                            ),
                          );
                      }}
                    >
                      {t("tenants.domainSync.verify")}
                    </Button>
                  ) : null}
                  {domain.status !== "archived" ? (
                    <Button
                      small
                      tone="danger"
                      disabled={mutationPending}
                      onClick={() => {
                        if (
                          !window.confirm(
                            t("tenants.domainSync.archiveConfirm", {
                              domain: domain.ontologyDomainId,
                            }),
                          )
                        ) {
                          return;
                        }
                        void archive
                          .mutateAsync({
                            registrationId: domain.id,
                            request: {
                              confirmOntologyDomainId:
                                domain.ontologyDomainId,
                            },
                          })
                          .then((receipt) =>
                            notifySuccess(
                              t("tenants.domainSync.archived"),
                              receipt.domain.displayName,
                            ),
                          )
                          .catch((error) =>
                            notifyError(
                              t("tenants.domainSync.archiveFailed"),
                              error,
                            ),
                          );
                      }}
                    >
                      {t("tenants.domainSync.archive")}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
            {!registry.isLoading && !registry.isError && rows.length === 0 ? (
              <div
                style={{
                  padding: 18,
                  border: "1px dashed var(--border-2)",
                  borderRadius: 7,
                  color: "var(--text-3)",
                  fontSize: 12,
                  textAlign: "center",
                }}
              >
                {t("tenants.domainSync.empty")}
              </div>
            ) : null}
          </div>

          <p
            style={{
              margin: 0,
              color: "var(--text-3)",
              fontSize: 10.5,
              lineHeight: 1.5,
            }}
          >
            <Icon name="library" size={11} />{" "}
            {t("tenants.domainSync.archivePolicy")}
          </p>
        </div>
      </Panel>
    </section>
  );
}

const selectStyle: React.CSSProperties = {
  width: "100%",
  height: 32,
  border: "1px solid var(--border-2)",
  borderRadius: 5,
  padding: "0 28px 0 9px",
  color: "var(--text)",
  background: "var(--panel)",
  fontSize: 11.5,
  outline: "none",
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
