import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, tenants } from "@agentic/db";
import {
  INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
  integrationProfileConfigDigest,
  integrationProfileToolDefinitionDigest,
  probeDefinitionHash,
  validateIntegrationToolConfig,
  type IntegrationProfile,
  type RealTool,
} from "@agentic/agent-factory";
import {
  type OntoCodeConfigurationTask,
  type OntoCodeConfigurationVerificationResult,
  type SystemProfileV1,
} from "@agentic/contracts";
import { canonicalEvidenceJson } from "@agentic/shared";
import {
  getIntegrationVerificationSnapshot,
  type IntegrationVerificationSnapshot,
} from "./integration-store";
import {
  getLLMGateway,
  probeDefaultLLMProvider,
  type DefaultProviderReadiness,
} from "./llm";
import {
  buildSystemToolIndex,
  requirementFor,
  type IntegrationLite,
  type ToolEntryLite,
} from "./system-config-requirements";
import { norm } from "./system-coverage";
import { listSystemProfiles } from "./system-profile-store";
import { getOntoCodeProject } from "./ontocode-session-store";
import { type OntoCodeConfigurationTaskVerifier } from "./ontocode-configuration-task-store";
import { currentFactoryExecutionTools } from "./agent-factory/execution-resource-snapshot";
import { listIntegrationProfiles } from "./agent-factory/integration-profile-store";

interface VerificationContext {
  domainId: string;
  tenantSlug: string;
  profiles: SystemProfileV1[];
  tools: RealTool[];
}

interface GatewaySnapshot {
  defaultProvider: string;
  defaultModel: string | null;
  providers: Array<{ id: string; hasKey: boolean }>;
}

export interface OntoCodeConfigurationVerifierDependencies {
  now(): number;
  loadContext(task: OntoCodeConfigurationTask): Promise<VerificationContext>;
  getIntegration(
    tenantId: string,
    provider: string,
  ): IntegrationVerificationSnapshot | null;
  listToolProfiles(
    tenantId: string,
    domainId: string,
    toolName: string,
    environment: "sandbox" | "production",
  ): IntegrationProfile[];
  envPresent(name: string): boolean;
  gatewaySnapshot(): GatewaySnapshot;
  probeDefaultGateway(): Promise<DefaultProviderReadiness>;
}

function tenantSlug(tenantId: string): string {
  const row = getDb()
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .get();
  if (!row) throw new Error("Configuration Task tenant no longer exists");
  return row.slug;
}

const DEFAULT_DEPENDENCIES: OntoCodeConfigurationVerifierDependencies = {
  now: () => Date.now(),
  loadContext: async (task) => {
    const project = getOntoCodeProject(
      { tenantId: task.tenantId },
      task.projectId,
    );
    const slug = tenantSlug(task.tenantId);
    const [profiles, tools] = await Promise.all([
      Promise.resolve(listSystemProfiles(task.tenantId)),
      currentFactoryExecutionTools({
        tenantId: task.tenantId,
        tenantSlug: slug,
        domainId: project.domain,
      }),
    ]);
    return {
      domainId: project.domain,
      tenantSlug: slug,
      profiles,
      tools,
    };
  },
  getIntegration: getIntegrationVerificationSnapshot,
  listToolProfiles: (tenantId, domainId, toolName, environment) =>
    listIntegrationProfiles(tenantId, domainId, toolName, environment),
  envPresent: (name) => Boolean(process.env[name]?.trim()),
  gatewaySnapshot: () => {
    const gateway = getLLMGateway();
    return {
      defaultProvider: gateway.defaultProvider,
      defaultModel: gateway.defaultModel,
      providers: gateway
        .listProviders()
        .map((provider) => ({ id: provider.id, hasKey: provider.hasKey })),
    };
  },
  probeDefaultGateway: () =>
    probeDefaultLLMProvider({ force: true, maxAgeMs: 0 }),
};

function digest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalEvidenceJson(value), "utf8")
    .digest("hex");
}

function result(
  deps: OntoCodeConfigurationVerifierDependencies,
  outcome: "pending" | "passed" | "failed",
  code: string,
  summary: string,
  state: unknown,
  refs: string[],
): OntoCodeConfigurationVerificationResult {
  return {
    outcome,
    code,
    summary,
    checkedAt: deps.now(),
    resourceDigest: digest(state),
    refs: [...new Set(refs)].sort(),
  };
}

function confirmedProfiles(profiles: SystemProfileV1[]): SystemProfileV1[] {
  return profiles.filter(
    (profile) =>
      Boolean(profile.provenance.confirmedBy?.trim()) &&
      profile.provenance.confirmedAt !== undefined,
  );
}

function integrationLite(
  snapshot: IntegrationVerificationSnapshot,
): IntegrationLite {
  return {
    baseUrl: snapshot.baseUrlPresent ? "configured" : null,
    hasKey: snapshot.apiKeyPresent,
    config: Object.fromEntries(
      snapshot.plainFieldKeys.map((key) => [key, "configured"]),
    ),
    // Exact additional-secret key names cannot be proven without decrypting
    // the encrypted bag. Keep them absent and handle that case as pending.
    secretKeysStored: [],
    enabled: snapshot.enabled,
  };
}

function requirementToolEntry(tool: RealTool): ToolEntryLite {
  const configSchema = tool.catalogDefinition?.configSchema;
  return {
    name: tool.name,
    category: tool.category ?? tool.name.split(".")[0] ?? tool.name,
    credentialEnv: tool.credentialEnv,
    configSchema:
      configSchema &&
      typeof configSchema === "object" &&
      !Array.isArray(configSchema)
        ? (configSchema as Record<string, unknown>)
        : undefined,
    capabilities: tool.capabilities,
  };
}

function derivedSystem(task: OntoCodeConfigurationTask): string | null {
  switch (task.target.kind) {
    case "integration":
      return task.target.system ?? task.target.provider;
    case "system_profile":
    case "tool":
      return task.target.system;
    default:
      return null;
  }
}

function shapeDrift(
  task: OntoCodeConfigurationTask,
  fields: Array<{
    key: string;
    label: string;
    kind: string;
    required: boolean;
    envRef?: string;
    source: string;
  }>,
): string[] {
  const authoritative = new Map(fields.map((field) => [field.key, field]));
  return task.requirement.missingFields.flatMap((declared) => {
    const current = authoritative.get(declared.key);
    if (
      !current ||
      current.kind !== declared.kind ||
      current.required !== declared.required ||
      (current.envRef ?? null) !== declared.envRef ||
      current.source !== declared.source
    ) {
      return [declared.key];
    }
    return [];
  });
}

async function verifyDerivedRequirement(
  task: OntoCodeConfigurationTask,
  deps: OntoCodeConfigurationVerifierDependencies,
  context: VerificationContext,
): Promise<OntoCodeConfigurationVerificationResult> {
  if (task.verificationPolicy.kind !== "derived_requirement") {
    throw new Error("derived verifier received the wrong policy");
  }
  const system = derivedSystem(task);
  if (!system) {
    return result(
      deps,
      "failed",
      "derived_target_unsupported",
      "This target cannot be verified through a derived integration requirement.",
      { targetKind: task.target.kind },
      [`configuration-task:${task.id}`],
    );
  }

  const profiles = confirmedProfiles(context.profiles);
  const integration = deps.getIntegration(
    task.tenantId,
    task.verificationPolicy.provider,
  );
  const integrationsByProvider = new Map<string, IntegrationLite>();
  if (integration) {
    integrationsByProvider.set(
      integration.provider,
      integrationLite(integration),
    );
  }
  const requirement = requirementFor(system, {
    profiles,
    toolIndex: buildSystemToolIndex(context.tools.map(requirementToolEntry)),
    integrationsByProvider,
    envPresent: deps.envPresent,
  });
  const profile = profiles.find((candidate) =>
    [candidate.id, candidate.name, ...candidate.aliases].some(
      (name) => norm(name) === norm(system),
    ),
  );
  const refs = [
    `configuration-task:${task.id}`,
    `ontology-system:${system}`,
    ...(profile ? [`system-profile:${profile.id}`] : []),
  ];
  const derivedState = {
    system,
    domainId: context.domainId,
    provider: requirement.provider,
    posture: requirement.posture,
    fields: requirement.fields.map((field) => ({
      key: field.key,
      kind: field.kind,
      required: field.required,
      source: field.source,
      envRef: field.envRef ?? null,
      satisfied: field.satisfied,
      envPresent: field.envPresent ?? null,
    })),
  };

  if (requirement.posture === "unsupported" || requirement.provider === null) {
    return result(
      deps,
      "pending",
      "system_contract_missing",
      "No confirmed System Profile or executable Tool contract authoritatively resolves this system to a configuration provider.",
      derivedState,
      refs,
    );
  }
  if (requirement.posture === "planned") {
    return result(
      deps,
      "pending",
      "system_not_live",
      "The authoritative System Profile still marks this system as planned, so no live integration can be verified.",
      derivedState,
      refs,
    );
  }
  if (
    requirement.provider !== task.verificationPolicy.provider ||
    (task.target.kind === "integration" &&
      task.target.provider !== requirement.provider)
  ) {
    return result(
      deps,
      "failed",
      "derived_provider_mismatch",
      "The freshly derived provider does not match the Configuration Task target.",
      {
        ...derivedState,
        requestedProvider: task.verificationPolicy.provider,
      },
      refs,
    );
  }

  const drifted = shapeDrift(task, requirement.fields);
  if (drifted.length > 0) {
    return result(
      deps,
      "failed",
      "requirement_shape_drift",
      "The authoritative required-field contract changed after this Configuration Task was created.",
      { ...derivedState, driftedFieldKeys: drifted.sort() },
      refs,
    );
  }

  const current = deps.getIntegration(task.tenantId, requirement.provider);
  if (!current) {
    return result(
      deps,
      "failed",
      "integration_missing",
      "The derived provider has no tenant integration record.",
      derivedState,
      refs,
    );
  }
  const integrationRefs = [...refs, `integration:${current.provider}`];
  const integrationState = {
    ...derivedState,
    integration: {
      id: current.id,
      provider: current.provider,
      enabled: current.enabled,
      baseUrlPresent: current.baseUrlPresent,
      apiKeyPresent: current.apiKeyPresent,
      plainFieldKeys: current.plainFieldKeys,
      additionalSecretsPresent: current.additionalSecretsPresent,
      status: current.status,
      lastCheckedAt: current.lastCheckedAt,
      updatedAt: current.updatedAt,
    },
  };
  if (!current.enabled) {
    return result(
      deps,
      "failed",
      "integration_disabled",
      "The derived provider integration exists but is disabled.",
      integrationState,
      integrationRefs,
    );
  }

  const missing = requirement.fields.filter(
    (field) => field.required && !field.satisfied,
  );
  const unverifiableSecrets = missing.filter(
    (field) =>
      field.kind === "secret" &&
      current.additionalSecretsPresent &&
      field.envPresent !== true,
  );
  if (unverifiableSecrets.length > 0) {
    return result(
      deps,
      "pending",
      "secret_presence_unverifiable",
      "An encrypted additional-secret bag exists, but its exact required field names cannot be verified without decrypting it.",
      {
        ...integrationState,
        unverifiableFieldKeys: unverifiableSecrets
          .map((field) => field.key)
          .sort(),
      },
      integrationRefs,
    );
  }
  if (missing.length > 0) {
    return result(
      deps,
      "failed",
      "required_configuration_missing",
      "One or more freshly derived required fields are still unconfigured.",
      {
        ...integrationState,
        missingFieldKeys: missing.map((field) => field.key).sort(),
      },
      integrationRefs,
    );
  }
  if (
    current.lastCheckedAt !== null &&
    current.lastCheckedAt < current.updatedAt
  ) {
    return result(
      deps,
      "pending",
      "integration_probe_stale",
      "The persisted integration connection check predates the current configuration revision.",
      integrationState,
      integrationRefs,
    );
  }
  if (current.status === "error") {
    return result(
      deps,
      "failed",
      "integration_probe_failed",
      "The latest persisted integration connection check failed.",
      integrationState,
      integrationRefs,
    );
  }
  if (current.status !== "ok" || current.lastCheckedAt === null) {
    return result(
      deps,
      "pending",
      "integration_probe_required",
      "Required fields are configured, but an authoritative successful connection check has not been recorded.",
      integrationState,
      integrationRefs,
    );
  }
  if (
    profile?.lastProbe &&
    (profile.lastProbe.ok !== true ||
      (profile.lastProbe.provider !== undefined &&
        profile.lastProbe.provider !== requirement.provider))
  ) {
    return result(
      deps,
      "failed",
      "system_probe_failed",
      "The persisted System Profile connection probe does not pass for the derived provider.",
      {
        ...integrationState,
        systemProbe: {
          ok: profile.lastProbe.ok,
          at: profile.lastProbe.at,
          provider: profile.lastProbe.provider ?? null,
        },
      },
      integrationRefs,
    );
  }
  return result(
    deps,
    "passed",
    "configuration_verified",
    "The provider was freshly derived, its integration is enabled, all required fields are present, and the persisted connection check passes.",
    integrationState,
    integrationRefs,
  );
}

function verifySystemProbe(
  task: OntoCodeConfigurationTask,
  deps: OntoCodeConfigurationVerifierDependencies,
  context: VerificationContext,
): OntoCodeConfigurationVerificationResult {
  if (task.verificationPolicy.kind !== "system_probe") {
    throw new Error("system probe verifier received the wrong policy");
  }
  const policy = task.verificationPolicy;
  const profile = context.profiles.find(
    (candidate) => candidate.id === policy.profileId,
  );
  const refs = [
    `configuration-task:${task.id}`,
    `system-profile:${policy.profileId}`,
  ];
  if (!profile) {
    return result(
      deps,
      "failed",
      "system_profile_missing",
      "The bound System Profile no longer exists.",
      { profileId: policy.profileId },
      refs,
    );
  }
  const targetSystem =
    task.target.kind === "system_profile" ? task.target.system : null;
  const profileNames = [profile.id, profile.name, ...profile.aliases];
  if (
    task.target.kind !== "system_profile" ||
    task.target.profileId !== policy.profileId ||
    !profileNames.some((name) => norm(name) === norm(targetSystem ?? ""))
  ) {
    return result(
      deps,
      "failed",
      "system_probe_subject_mismatch",
      "The Configuration Task system does not match the System Profile bound to this probe.",
      {
        profileId: profile.id,
        targetKind: task.target.kind,
        targetProfileId:
          task.target.kind === "system_profile" ? task.target.profileId : null,
        targetSystem,
        profileNames: profileNames.sort(),
      },
      refs,
    );
  }
  if (
    !profile.provenance.confirmedBy?.trim() ||
    profile.provenance.confirmedAt === undefined
  ) {
    return result(
      deps,
      "pending",
      "system_profile_confirmation_required",
      "The System Profile has not been committed by an authenticated reviewer.",
      {
        profileId: profile.id,
        availability: profile.availability,
      },
      refs,
    );
  }
  if (profile.availability !== "live") {
    return result(
      deps,
      "pending",
      "system_not_live",
      "The System Profile is still planned and cannot pass a live probe.",
      { profileId: profile.id, availability: profile.availability },
      refs,
    );
  }
  if (!profile.lastProbe) {
    return result(
      deps,
      "pending",
      "system_probe_required",
      "No authoritative System Profile connection probe has been recorded.",
      {
        profileId: profile.id,
        confirmedAt: profile.provenance.confirmedAt,
      },
      refs,
    );
  }
  const declaredProvider = profile.credential?.provider?.trim() ?? "";
  const probedProvider = profile.lastProbe.provider?.trim() ?? "";
  if (
    !declaredProvider ||
    !probedProvider ||
    declaredProvider !== probedProvider
  ) {
    return result(
      deps,
      "failed",
      "system_probe_provider_mismatch",
      "The persisted System Profile probe is not bound to its declared credential provider.",
      {
        profileId: profile.id,
        declaredProvider: declaredProvider || null,
        probedProvider: probedProvider || null,
        probeAt: profile.lastProbe.at,
      },
      refs,
    );
  }
  return result(
    deps,
    profile.lastProbe.ok ? "passed" : "failed",
    profile.lastProbe.ok ? "system_probe_verified" : "system_probe_failed",
    profile.lastProbe.ok
      ? "The latest persisted System Profile connection probe passes."
      : "The latest persisted System Profile connection probe failed.",
    {
      profileId: profile.id,
      confirmedAt: profile.provenance.confirmedAt,
      probe: {
        ok: profile.lastProbe.ok,
        at: profile.lastProbe.at,
        provider: profile.lastProbe.provider ?? null,
      },
    },
    refs,
  );
}

function verifyToolContract(
  task: OntoCodeConfigurationTask,
  deps: OntoCodeConfigurationVerifierDependencies,
  context: VerificationContext,
): OntoCodeConfigurationVerificationResult {
  if (
    task.verificationPolicy.kind !== "tool_contract" ||
    task.target.kind !== "tool"
  ) {
    throw new Error("tool contract verifier received the wrong target");
  }
  const target = task.target;
  const hasRequirementKind = Boolean(target.requirementKind);
  const hasRequirementRole = Boolean(target.requirementRole);
  if (hasRequirementKind !== hasRequirementRole) {
    return result(
      deps,
      "failed",
      "tool_requirement_incomplete",
      "The Configuration Task has only one half of the exact integration kind/role selector.",
      {
        system: target.system,
        requirementKind: target.requirementKind,
        requirementRole: target.requirementRole,
      },
      [`configuration-task:${task.id}`, `ontology-system:${target.system}`],
    );
  }
  const boundReadinessRequirement =
    hasRequirementKind && hasRequirementRole;

  const requestedSystem = norm(target.system);
  const profile = confirmedProfiles(context.profiles).find((candidate) =>
    [candidate.id, candidate.name, ...candidate.aliases].some(
      (name) => norm(name) === requestedSystem,
    ),
  );
  const authorizedSystemNames = new Set(
    [
      target.system,
      ...(profile ? [profile.id, profile.name, ...profile.aliases] : []),
    ].map(norm),
  );
  const candidateTools = context.tools.flatMap((tool) => {
    if (target.desiredToolName && tool.name !== target.desiredToolName) {
      return [];
    }
    const matchingCapabilities = (tool.capabilities ?? []).filter(
      (capability) => {
        const systems = (capability.systems ?? []).map(norm);
        const kinds = (capability.kinds ?? []).map(norm);
        const roles = (capability.roles ?? []).map(norm);
        return (
          systems.some(
            (system) =>
              system !== norm("*") && authorizedSystemNames.has(system),
          ) &&
          (!boundReadinessRequirement ||
            (kinds.includes(norm(target.requirementKind!)) &&
              roles.includes(norm(target.requirementRole!))))
        );
      },
    );
    return matchingCapabilities.length > 0
      ? [
          {
            name: tool.name,
            operation: tool.operation,
            effectScope: tool.effectScope,
            sandboxPolicy: tool.sandboxPolicy,
            probeStatus: tool.probeStatus ?? "required",
            capabilities: matchingCapabilities.map((capability) => ({
              systems: [...capability.systems].sort(),
              kinds: [...capability.kinds].sort(),
              roles: [...capability.roles].sort(),
              operations: [...(capability.operations ?? [])].sort(),
              objectTypes: [...(capability.objectTypes ?? [])].sort(),
              probeRequired: capability.probeRequired,
            })),
          },
        ]
      : [];
  });
  const state = {
    domainId: context.domainId,
    mode: boundReadinessRequirement ? "bound_readiness" : "standalone",
    system: target.system,
    requirementKind: target.requirementKind,
    requirementRole: target.requirementRole,
    desiredToolName: target.desiredToolName,
    candidates: candidateTools,
  };
  const refs = [
    `configuration-task:${task.id}`,
    `ontology-system:${target.system}`,
    ...(profile ? [`system-profile:${profile.id}`] : []),
    ...candidateTools.map((tool) => `tool:${tool.name}`),
  ];
  if (candidateTools.length === 0) {
    return result(
      deps,
      "failed",
      "tool_contract_missing",
      boundReadinessRequirement
        ? "No persisted executable Tool explicitly covers the exact system, integration kind, and role from this readiness requirement."
        : "No persisted executable Tool explicitly covers the requested system and optional Tool identity.",
      state,
      refs,
    );
  }
  if (candidateTools.length > 1) {
    return result(
      deps,
      "pending",
      "tool_contract_selection_required",
      boundReadinessRequirement
        ? "Multiple persisted Tools cover this exact requirement; an explicit Tool selection is required before OntoCode can resume."
        : "Multiple persisted Tools cover this standalone system request; an explicit namespaced Tool selection is required.",
      state,
      refs,
    );
  }
  return result(
    deps,
    "passed",
    "tool_contract_verified",
    boundReadinessRequirement
      ? "A persisted executable Tool now explicitly covers the exact system, integration kind, and role. OntoCode will resume the waiting Build and re-evaluate profile, probe, sandbox, and promotion gates."
      : "A persisted executable Tool now explicitly covers the standalone system request. The governed Tool-authoring task is satisfied.",
    state,
    refs,
  );
}

async function verifyToolProfile(
  task: OntoCodeConfigurationTask,
  deps: OntoCodeConfigurationVerifierDependencies,
  context: VerificationContext,
): Promise<OntoCodeConfigurationVerificationResult> {
  if (task.verificationPolicy.kind !== "tool_profile") {
    throw new Error("tool profile verifier received the wrong policy");
  }
  const policy = task.verificationPolicy;
  const refs = [
    `configuration-task:${task.id}`,
    `tool:${policy.toolName}`,
    `tool-profile:${policy.environment}:${policy.profileKey}`,
  ];
  const profile = deps
    .listToolProfiles(
      task.tenantId,
      context.domainId,
      policy.toolName,
      policy.environment,
    )
    .find((candidate) => candidate.profileKey === policy.profileKey);
  if (!profile) {
    return result(
      deps,
      "failed",
      "tool_profile_missing",
      "The bound human-confirmed Tool Profile no longer exists.",
      {
        toolName: policy.toolName,
        environment: policy.environment,
        profileKey: policy.profileKey,
      },
      refs,
    );
  }
  const tool = context.tools.find(
    (candidate) => candidate.name === policy.toolName,
  );
  if (!tool) {
    return result(
      deps,
      "failed",
      "tool_contract_missing",
      "The executable Tool contract no longer exists in this tenant and domain.",
      {
        toolName: policy.toolName,
        environment: policy.environment,
        profileKey: policy.profileKey,
      },
      refs,
    );
  }
  const definitionDigest = integrationProfileToolDefinitionDigest(tool);
  const configDigest = integrationProfileConfigDigest(profile.config);
  if (
    profile.toolDefinitionDigest !== definitionDigest ||
    profile.configDigest !== configDigest ||
    profile.authorizationProtocolVersion !==
      INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION
  ) {
    return result(
      deps,
      "failed",
      "tool_profile_stale",
      "The Tool Profile no longer matches the current executable Tool contract or authorization protocol.",
      {
        toolName: tool.name,
        environment: policy.environment,
        profileKey: policy.profileKey,
        definitionDigest,
        configDigest,
        authorizationProtocolVersion: profile.authorizationProtocolVersion,
      },
      refs,
    );
  }

  const structural = validateIntegrationToolConfig(tool, profile.config, {
    env: {},
  });
  const presenceOnlyEnv = Object.fromEntries(
    structural.envRefs.map((name) => [
      name,
      deps.envPresent(name) ? "configured" : undefined,
    ]),
  );
  const validation = validateIntegrationToolConfig(tool, profile.config, {
    env: presenceOnlyEnv,
  });
  if (!validation.valid) {
    return result(
      deps,
      "failed",
      "tool_profile_invalid",
      "The persisted Tool Profile no longer satisfies the current configuration schema.",
      {
        toolName: tool.name,
        profileKey: profile.profileKey,
        invalidConfigKeys: validation.invalidConfigKeys,
        missingConfigKeys: validation.missingConfigKeys,
      },
      refs,
    );
  }
  if (!validation.ready) {
    return result(
      deps,
      "pending",
      "tool_profile_environment_missing",
      "The Tool Profile is valid, but one or more referenced runtime environment variables are absent.",
      {
        toolName: tool.name,
        profileKey: profile.profileKey,
        missingEnvRefs: validation.missingEnvRefs,
      },
      refs,
    );
  }
  const probeRequired =
    tool.effectScope === "external" ||
    tool.operation === "write" ||
    tool.operation === "read_write" ||
    tool.sideEffect === "write" ||
    tool.sideEffect === "dual" ||
    tool.capabilities?.some((capability) => capability.probeRequired) === true;
  const expectedProbeDefinitionHash = probeRequired
    ? probeDefinitionHash(tool, profile.config)
    : undefined;
  const currentProbeVerified = Boolean(
    expectedProbeDefinitionHash &&
    tool.verifiedDefinitionHashes?.includes(expectedProbeDefinitionHash),
  );
  if (probeRequired && !expectedProbeDefinitionHash) {
    return result(
      deps,
      "failed",
      "tool_probe_definition_unavailable",
      "The current executable Tool and profile cannot produce an exact probe definition identity.",
      {
        toolName: tool.name,
        profileKey: profile.profileKey,
        probeStatus: tool.probeStatus ?? "required",
      },
      refs,
    );
  }
  if (probeRequired && !currentProbeVerified) {
    return result(
      deps,
      "pending",
      "tool_probe_required",
      "The exact executable Tool contract still requires a verified probe.",
      {
        toolName: tool.name,
        profileKey: profile.profileKey,
        probeStatus: tool.probeStatus ?? "required",
        expectedProbeDefinitionHash,
      },
      refs,
    );
  }
  if (
    probeRequired &&
    policy.environment === "production" &&
    !tool.productionVerifiedDefinitionHashes?.includes(
      expectedProbeDefinitionHash!,
    )
  ) {
    return result(
      deps,
      "pending",
      "production_tool_probe_required",
      "The Tool has no current production-attested live probe.",
      {
        toolName: tool.name,
        profileKey: profile.profileKey,
        probeStatus: tool.probeStatus ?? "required",
        expectedProbeDefinitionHash,
      },
      refs,
    );
  }
  return result(
    deps,
    "passed",
    "tool_profile_verified",
    "The human-confirmed Tool Profile matches the current Tool definition, environment, and probe posture.",
    {
      toolName: tool.name,
      profileKey: profile.profileKey,
      environment: profile.environment,
      definitionDigest,
      configDigest,
      confirmedBy: profile.confirmedBy,
      confirmedAt: profile.confirmedAt,
    },
    refs,
  );
}

async function verifyGateway(
  task: OntoCodeConfigurationTask,
  deps: OntoCodeConfigurationVerifierDependencies,
): Promise<OntoCodeConfigurationVerificationResult> {
  const gateway = deps.gatewaySnapshot();
  const requested =
    task.target.kind === "llm_gateway"
      ? (task.target.provider ?? gateway.defaultProvider)
      : gateway.defaultProvider;
  const refs = [`configuration-task:${task.id}`, `llm-provider:${requested}`];
  const provider = gateway.providers.find(
    (candidate) => candidate.id === requested,
  );
  const defaultModel = gateway.defaultModel?.trim() ?? "";
  if (
    !provider ||
    !provider.hasKey ||
    (requested === gateway.defaultProvider && !defaultModel)
  ) {
    return result(
      deps,
      "failed",
      "gateway_configuration_missing",
      "The selected LLM provider is not registered with usable credential configuration.",
      {
        requestedProvider: requested,
        defaultProvider: gateway.defaultProvider,
        modelConfigured: Boolean(defaultModel),
        providerRegistered: Boolean(provider),
        providerHasKey: provider?.hasKey ?? false,
      },
      refs,
    );
  }
  if (requested !== gateway.defaultProvider) {
    return result(
      deps,
      "pending",
      "gateway_probe_unavailable",
      "The provider is configured, but this verifier has no authoritative connectivity probe for a non-default route.",
      {
        requestedProvider: requested,
        defaultProvider: gateway.defaultProvider,
        providerHasKey: provider.hasKey,
      },
      refs,
    );
  }
  const probe = await deps.probeDefaultGateway();
  const probeMatchesSubject =
    probe.provider === requested && probe.model?.trim() === defaultModel;
  if (!probeMatchesSubject) {
    return result(
      deps,
      "pending",
      "gateway_probe_subject_mismatch",
      "The authoritative probe result does not match the current default provider and model configuration.",
      {
        requestedProvider: requested,
        requestedModel: defaultModel,
        probedProvider: probe.provider,
        probedModel: probe.model,
        checkedAt: probe.checkedAt,
      },
      refs,
    );
  }
  return result(
    deps,
    probe.ok ? "passed" : "failed",
    probe.ok ? "gateway_verified" : "gateway_probe_failed",
    probe.ok
      ? "The configured default LLM provider passed its authoritative credential and connectivity probe."
      : "The configured default LLM provider failed its authoritative credential or connectivity probe.",
    {
      provider: probe.provider,
      model: probe.model,
      reachable: probe.reachable,
      checkedAt: probe.checkedAt,
      latencyMs: probe.latencyMs,
      statusCode: probe.statusCode,
      note: probe.note ?? null,
    },
    refs,
  );
}

function verifyEnvironment(
  task: OntoCodeConfigurationTask,
  deps: OntoCodeConfigurationVerifierDependencies,
): OntoCodeConfigurationVerificationResult {
  if (task.verificationPolicy.kind !== "environment_presence") {
    throw new Error("environment verifier received the wrong policy");
  }
  const presence = task.verificationPolicy.envRefs
    .map((name) => ({ name, present: deps.envPresent(name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const missing = presence
    .filter((entry) => !entry.present)
    .map((entry) => entry.name);
  return result(
    deps,
    missing.length === 0 ? "passed" : "failed",
    missing.length === 0 ? "environment_verified" : "environment_missing",
    missing.length === 0
      ? "Every required runtime environment reference is present."
      : "One or more required runtime environment references are absent.",
    { presence },
    [
      `configuration-task:${task.id}`,
      ...presence.map((entry) => `environment:${entry.name}`),
    ],
  );
}

export function createOntoCodeConfigurationTaskVerifier(
  overrides: Partial<OntoCodeConfigurationVerifierDependencies> = {},
): OntoCodeConfigurationTaskVerifier {
  const deps: OntoCodeConfigurationVerifierDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  return {
    async verify({ task }) {
      switch (task.verificationPolicy.kind) {
        case "derived_requirement": {
          const context = await deps.loadContext(task);
          return verifyDerivedRequirement(task, deps, context);
        }
        case "system_probe": {
          const context = await deps.loadContext(task);
          return verifySystemProbe(task, deps, context);
        }
        case "tool_profile": {
          const context = await deps.loadContext(task);
          return verifyToolProfile(task, deps, context);
        }
        case "tool_contract": {
          const context = await deps.loadContext(task);
          return verifyToolContract(task, deps, context);
        }
        case "gateway_configuration":
          return verifyGateway(task, deps);
        case "environment_presence":
          return verifyEnvironment(task, deps);
        case "manual_external":
          return result(
            deps,
            "pending",
            "manual_verification_required",
            "This external configuration requires an explicit human or provider-specific verification receipt.",
            {
              targetKind: task.target.kind,
              policy: "manual_external",
            },
            [`configuration-task:${task.id}`],
          );
      }
    },
  };
}
