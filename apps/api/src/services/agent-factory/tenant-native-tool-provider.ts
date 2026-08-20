import { createHash } from "node:crypto";
import type {
  TenantRegistry,
  ToolDescriptor,
  ToolFactoryMetadata,
  ToolWriteProbeLifecycle,
} from "@agentic/agent-kit";
import type { RealTool } from "@agentic/agent-factory";
import {
  isToolExecutionPolicy,
  type ToolCatalogEntry,
} from "@agentic/tools";
import { inspectWriteProbeSafety } from "@agentic/shared";

export interface RuntimeTenantRegistrySnapshot {
  tenantSlug: string;
  /** Version selected by the runtime (deployment pointer or workspace package). */
  selectedVersion: string;
  registry: TenantRegistry;
}

export interface TenantNativeProbeSummary {
  status: "verified" | "failed" | "required";
  verifiedDefinitionHashes: string[];
  productionVerifiedDefinitionHashes: string[];
  evidenceMode?: "live-probe" | "signed-fixture" | "runtime-record";
  definitionHash?: string;
}

export interface ResolvedTenantNativeFactoryTool {
  registryKey: string;
  descriptor: ToolDescriptor;
  catalog: ToolCatalogEntry & { sourceIdentity: Record<string, unknown> };
  realTool: RealTool;
}

const snapshots = new Map<string, RuntimeTenantRegistrySnapshot>();

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Capture the exact already-expanded registry used by runtime dispatch. */
export function publishRuntimeTenantRegistrySnapshot(
  snapshot: RuntimeTenantRegistrySnapshot,
): void {
  if (!nonEmpty(snapshot.tenantSlug) || !nonEmpty(snapshot.selectedVersion)) {
    throw new Error("runtime tenant registry snapshot requires tenantSlug and selectedVersion");
  }
  snapshots.set(snapshot.tenantSlug, {
    ...snapshot,
    tenantSlug: snapshot.tenantSlug.trim(),
    selectedVersion: snapshot.selectedVersion.trim(),
  });
}

export function removeRuntimeTenantRegistrySnapshot(tenantSlug: string): void {
  snapshots.delete(tenantSlug);
}

export function getRuntimeTenantRegistrySnapshot(
  tenantSlug: string,
): RuntimeTenantRegistrySnapshot | undefined {
  return snapshots.get(tenantSlug);
}

/** Test-only state reset; production callers publish/replace one slug at a time. */
export function clearRuntimeTenantRegistrySnapshots(): void {
  snapshots.clear();
}

function handlerDigest(descriptor: ToolDescriptor): string {
  return createHash("sha256")
    .update(Function.prototype.toString.call(descriptor.handler))
    .digest("hex");
}

function runtimeBuildIdentity(): string {
  const buildId = process.env.AGENTIC_BUILD_ID?.trim()
    || process.env.GIT_SHA?.trim()
    || (process.env.NODE_ENV === "production"
      ? ""
      : "unverified-development-build");
  if (!buildId) {
    throw new Error(
      "AGENTIC_BUILD_ID or GIT_SHA is required to identify tenant tool implementations",
    );
  }
  return buildId;
}

function requiredLifecycleCoordinate(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500) {
    throw new Error(`tenant factory write-probe lifecycle ${field} is invalid`);
  }
  return value.trim();
}

/** Public, non-secret identity only. Callback source never leaves the process;
 * its digest makes an implementation change invalidate old probe evidence even
 * when a package author forgets to bump the reviewed revision. */
export function tenantWriteProbeLifecycleSourceIdentity(
  lifecycle: ToolWriteProbeLifecycle | undefined,
): Record<string, unknown> | null {
  if (!lifecycle) return null;
  const digest = (handler: Function): string => createHash("sha256")
    .update(Function.prototype.toString.call(handler))
    .digest("hex");
  return {
    schema: "agentic-write-probe-lifecycle/v1",
    id: requiredLifecycleCoordinate(lifecycle.identity?.id, "identity.id"),
    revision: requiredLifecycleCoordinate(
      lifecycle.identity?.revision,
      "identity.revision",
    ),
    cleanupHandlerSha256: digest(lifecycle.cleanup),
    readbackHandlerSha256: digest(lifecycle.readback),
  };
}

function assertMetadata(
  tenantSlug: string,
  registryKey: string,
  descriptor: ToolDescriptor,
  metadata: ToolFactoryMetadata,
): void {
  if (descriptor.name !== registryKey) {
    throw new Error(
      `tenant ${tenantSlug} factory tool registry key '${registryKey}' does not match descriptor name '${descriptor.name}'`,
    );
  }
  if (!nonEmpty(metadata.category) || !nonEmpty(metadata.source?.modulePath)) {
    throw new Error(
      `tenant ${tenantSlug} factory tool '${registryKey}' requires category and source.modulePath`,
    );
  }
  if (!isToolExecutionPolicy(metadata)) {
    throw new Error(
      `tenant ${tenantSlug} factory tool '${registryKey}' has an invalid operation/effectScope/sandboxPolicy contract`,
    );
  }
  for (const capability of metadata.capabilities ?? []) {
    if (
      capability.systems.length === 0
      || capability.kinds.length === 0
      || capability.roles.length === 0
    ) {
      throw new Error(
        `tenant ${tenantSlug} factory tool '${registryKey}' has an incomplete capability declaration`,
      );
    }
  }
  if (descriptor.factoryWriteProbeLifecycle) {
    const safety = inspectWriteProbeSafety(
      metadata.sideEffect,
      metadata.probeSafety,
    );
    if (
      metadata.sandboxPolicy !== "requires_attempt_grant"
      || safety.status !== "ready"
    ) {
      throw new Error(
        `tenant ${tenantSlug} factory tool '${registryKey}' lifecycle requires a complete write/dual probeSafety contract and requires_attempt_grant policy`,
      );
    }
    tenantWriteProbeLifecycleSourceIdentity(
      descriptor.factoryWriteProbeLifecycle,
    );
  }
}

function resolvedTool(
  snapshot: RuntimeTenantRegistrySnapshot,
  registryKey: string,
  descriptor: ToolDescriptor,
  probe?: TenantNativeProbeSummary,
): ResolvedTenantNativeFactoryTool | null {
  const metadata = descriptor.factory;
  // Tenant tools remain executable without Factory metadata; omission means
  // only that Agent Factory is not allowed to claim/bind the capability.
  if (!metadata) return null;
  assertMetadata(snapshot.tenantSlug, registryKey, descriptor, metadata);

  const risky = metadata.effectScope === "external"
    || metadata.operation === "write"
    || metadata.operation === "read_write"
    || metadata.sideEffect === "write"
    || metadata.sideEffect === "dual";
  // A risky declaration can never opt itself out of evidence accidentally.
  // This is policy-generic and independent of tenant/domain/tool names.
  const capabilities = (metadata.capabilities ?? []).map((capability) => ({
    ...capability,
    probeRequired: risky ? true : capability.probeRequired,
  }));
  const sourceIdentity = {
    provider: "tenant_registry",
    // A handler often delegates into imported helpers. Function#toString alone
    // cannot see helper-byte changes, so bind probe/cassette identity to the
    // immutable application build as well as the selected tenant package.
    buildId: runtimeBuildIdentity(),
    tenantSlug: snapshot.tenantSlug,
    selectedVersion: snapshot.selectedVersion,
    registry: snapshot.registry.factory?.source ?? null,
    tool: metadata.source,
    handlerSha256: handlerDigest(descriptor),
    ...(descriptor.factoryWriteProbeLifecycle
      ? {
          writeProbeLifecycle: tenantWriteProbeLifecycleSourceIdentity(
            descriptor.factoryWriteProbeLifecycle,
          ),
        }
      : {}),
  } satisfies Record<string, unknown>;
  const sourcePath = metadata.source.modulePath;
  const catalog: ResolvedTenantNativeFactoryTool["catalog"] = {
    name: descriptor.name,
    category: metadata.category,
    summary: metadata.summary ?? descriptor.description ?? descriptor.name,
    description: descriptor.description,
    sideEffect: metadata.sideEffect,
    operation: metadata.operation,
    effectScope: metadata.effectScope,
    sandboxPolicy: metadata.sandboxPolicy,
    aliases: metadata.aliases,
    argsSchema: metadata.argsSchema,
    returnsSchema: metadata.returnsSchema,
    configSchema: metadata.configSchema,
    configContract: metadata.configContract,
    credentialEnv: metadata.credentialEnv,
    credentialPosture: (metadata.credentialEnv?.length ?? 0) > 0
      ? "environment_reference_only"
      : "none",
    probeRequired: risky || capabilities.some((capability) => capability.probeRequired === true),
    capabilities,
    profileScope: metadata.profileScope,
    probeSafety: metadata.probeSafety,
    sourcePath,
    sourceIdentity,
  };
  const realTool: RealTool = {
    name: descriptor.name,
    summary: catalog.summary,
    aliases: metadata.aliases,
    category: metadata.category,
    sideEffect: metadata.sideEffect,
    operation: metadata.operation,
    effectScope: metadata.effectScope,
    sandboxPolicy: metadata.sandboxPolicy,
    configKeys: metadata.configSchema ? Object.keys(metadata.configSchema) : [],
    credentialEnv: metadata.credentialEnv ?? [],
    capabilities,
    ...(probe
      ? {
          probeStatus: probe.status,
          definitionHash: probe.definitionHash,
          verifiedDefinitionHashes: probe.verifiedDefinitionHashes,
          productionVerifiedDefinitionHashes:
            probe.productionVerifiedDefinitionHashes,
          probeEvidenceMode: probe.evidenceMode,
        }
      : risky
        ? {
            probeStatus: "required" as const,
            verifiedDefinitionHashes: [],
            productionVerifiedDefinitionHashes: [],
          }
        : {}),
    catalogDefinition: {
      name: catalog.name,
      category: catalog.category,
      sourcePath,
      sourceIdentity,
      sideEffect: catalog.sideEffect,
      operation: catalog.operation,
      effectScope: catalog.effectScope,
      sandboxPolicy: catalog.sandboxPolicy,
      argsSchema: catalog.argsSchema,
      returnsSchema: catalog.returnsSchema,
      configSchema: catalog.configSchema,
      ...(catalog.configContract !== undefined
        ? { configContract: catalog.configContract }
        : {}),
      capabilities: catalog.capabilities,
      profileScope: catalog.profileScope,
      probeSafety: catalog.probeSafety,
    },
  };
  return { registryKey, descriptor, catalog, realTool };
}

export function resolveTenantNativeFactoryTools(input: {
  tenantSlug: string;
  expectedVersion?: string;
  probesByTool?: ReadonlyMap<string, TenantNativeProbeSummary>;
}): ResolvedTenantNativeFactoryTool[] {
  const snapshot = snapshots.get(input.tenantSlug);
  if (!snapshot) return [];
  return resolveTenantNativeFactoryToolsFromSnapshot({
    snapshot,
    expectedVersion: input.expectedVersion,
    probesByTool: input.probesByTool,
  });
}

/**
 * Resolve from a caller-provided, already-reviewed registry projection.
 *
 * Runtime Profile compatibility execution uses this path so an exact adapter
 * release can be selected independently of the Business Domain tenant slug.
 * The snapshot's slug is code provenance only; callers must continue passing
 * the Business Domain slug into ToolContext when invoking the descriptor.
 */
export function resolveTenantNativeFactoryToolsFromSnapshot(input: {
  snapshot: RuntimeTenantRegistrySnapshot;
  expectedVersion?: string;
  probesByTool?: ReadonlyMap<string, TenantNativeProbeSummary>;
}): ResolvedTenantNativeFactoryTool[] {
  const { snapshot } = input;
  if (input.expectedVersion && input.expectedVersion !== snapshot.selectedVersion) {
    throw new Error(
      `tenant registry version mismatch for ${snapshot.tenantSlug}: expected ${input.expectedVersion}, runtime selected ${snapshot.selectedVersion}`,
    );
  }
  return Object.entries(snapshot.registry.tools ?? {}).flatMap(([key, descriptor]) => {
    const resolved = resolvedTool(snapshot, key, descriptor, input.probesByTool?.get(key));
    return resolved ? [resolved] : [];
  });
}

export function listTenantNativeFactoryTools(input: {
  tenantSlug: string;
  expectedVersion?: string;
  probesByTool?: ReadonlyMap<string, TenantNativeProbeSummary>;
}): RealTool[] {
  return resolveTenantNativeFactoryTools(input).map((tool) => tool.realTool);
}

export function listTenantNativeFactoryToolsFromSnapshot(input: {
  snapshot: RuntimeTenantRegistrySnapshot;
  expectedVersion?: string;
  probesByTool?: ReadonlyMap<string, TenantNativeProbeSummary>;
}): RealTool[] {
  return resolveTenantNativeFactoryToolsFromSnapshot(input).map(
    (tool) => tool.realTool,
  );
}

export function resolveTenantNativeFactoryTool(input: {
  tenantSlug: string;
  name: string;
  expectedVersion?: string;
}): ResolvedTenantNativeFactoryTool | undefined {
  return resolveTenantNativeFactoryTools(input).find(
    (tool) => tool.registryKey === input.name || tool.realTool.aliases?.includes(input.name),
  );
}

export function resolveTenantNativeFactoryToolFromSnapshot(input: {
  snapshot: RuntimeTenantRegistrySnapshot;
  name: string;
  expectedVersion?: string;
}): ResolvedTenantNativeFactoryTool | undefined {
  return resolveTenantNativeFactoryToolsFromSnapshot(input).find(
    (tool) => tool.registryKey === input.name || tool.realTool.aliases?.includes(input.name),
  );
}
