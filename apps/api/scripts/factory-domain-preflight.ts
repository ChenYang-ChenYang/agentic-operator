/**
 * Read-only Agent Factory domain preflight.
 *
 * Evidence comes from the same production composition root as a factory run:
 * live ontology, the real tool registry + stored probe receipts, and runtime
 * capability providers. It never deploys a sandbox, runs a probe, or invokes a
 * tool. Secret values are reduced to presence bits before pure binding logic
 * sees them and are never included in the report.
 */

import { pathToFileURL } from "node:url";
import {
  analyzeOntologyReadiness,
  integrationProfileScopeIssues,
  persistedToolAsRealTool,
  probeDefinitionHash,
  resolveOntologyReferences,
  resolveIntegrationBindings,
  validateIntegrationToolConfig,
  type DeclarativeTool,
  type DomainOntology,
  type IntegrationBindingStatus,
  type IntegrationCapabilityProvider,
  type IntegrationProfile,
  type IntegrationToolBinding,
  type OntologyAction,
  type OntologyReadinessIssue,
  type RealTool,
} from "@agentic/agent-factory";

export type PreflightBindingStatus = IntegrationBindingStatus | "needs_profile_selection";

export interface PreflightProfileCandidate {
  id: string;
  profileKey: string;
  compatible: boolean;
  ready: boolean;
  missingEnvRefs: string[];
  reasons: string[];
}

export interface PreflightProfileSelection {
  state: "selected" | "unselected" | "ambiguous" | "unavailable";
  explicit: boolean;
  selectedProfileId?: string;
  selectedProfileKey?: string;
  candidates: PreflightProfileCandidate[];
}

export interface FactoryDomainPreflightOptions {
  tenantId: string;
  tenantSlug: string;
  domain: string;
  allowBlocked: boolean;
}

export type ParsedFactoryDomainPreflightArgs =
  | FactoryDomainPreflightOptions
  | { help: true };

export class FactoryDomainPreflightUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactoryDomainPreflightUsageError";
  }
}

/** Preflight is evidence collection, never a writer. Enforce SQLite read-only
 * mode before the production composition root is imported so this CLI can run
 * alongside the single supervised API writer without opening another WAL
 * writer. An explicit writable setting is rejected rather than silently
 * overridden. */
export function enforceFactoryPreflightReadOnlyDatabase(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const configured = env.AGENTIC_DATABASE_READONLY?.trim().toLowerCase();
  if (!configured) {
    env.AGENTIC_DATABASE_READONLY = "1";
    return;
  }
  if (configured !== "1" && configured !== "true") {
    throw new Error(
      "Factory domain preflight requires AGENTIC_DATABASE_READONLY=1; writable preflight is forbidden",
    );
  }
}

export interface PreflightBindingRow {
  action: string;
  requirement: {
    id: string;
    system: string;
    kind: string;
    role: string;
    capability?: string;
    operations: string[];
    objectTypes: string[];
    eventNames: string[];
  };
  bindingKind: "tool" | "runtime" | "event";
  bindingId?: string;
  toolName?: string;
  status: PreflightBindingStatus;
  missingConfigKeys: string[];
  missingCredentialEnv: string[];
  invalidConfigKeys: string[];
  profileSelection?: PreflightProfileSelection;
  selectionRequired?: boolean;
  selectionCandidates?: Array<{
    bindingKind: "tool" | "runtime";
    bindingId: string;
    toolName?: string;
    score: number;
  }>;
  reason: string;
}

export interface FactoryDomainPreflightReport {
  schemaVersion: 1;
  mode: "read_only";
  scope: { tenantId: string; tenantSlug: string; domain: string };
  ready: boolean;
  blocked: boolean;
  source: {
    ontology: DomainOntology["source"];
    degraded: boolean;
    degradedFrom?: string;
    degradedReason?: string;
  };
  ontologyReadiness: {
    ready: boolean;
    counts: ReturnType<typeof analyzeOntologyReadiness>["counts"];
    groups: {
      blocking: OntologyReadinessIssue[];
      warnings: OntologyReadinessIssue[];
    };
  };
  integrationBindings: {
    ready: boolean;
    counts: Record<PreflightBindingStatus, number>;
    groups: {
      tool: PreflightBindingRow[];
      runtime: PreflightBindingRow[];
      event: PreflightBindingRow[];
    };
  };
  missing: {
    config: PreflightBindingRow[];
    profileSelection: PreflightBindingRow[];
    probe: PreflightBindingRow[];
    binding: PreflightBindingRow[];
  };
  inventory: {
    actions: number;
    agentActions: number;
    integrationRequirements: number;
    globalTools: number;
    declarativeTools: number;
    declarativeShadowedByGlobal: number;
    executableTools: number;
    runtimeProviders: number;
  };
  blockedReasons: string[];
}

const VALUE_FLAGS: ReadonlyMap<string, "tenantId" | "tenantSlug" | "domain"> = new Map([
  ["--tenant-id", "tenantId"],
  ["--tenant-slug", "tenantSlug"],
  ["--domain", "domain"],
] as const);

function boundedArgument(value: string, flag: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new FactoryDomainPreflightUsageError(`${flag} requires a non-empty value`);
  if (trimmed.length > 256 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new FactoryDomainPreflightUsageError(`${flag} contains an invalid value`);
  }
  return trimmed;
}

/** Pure, strict CLI parser. Both `--flag value` and `--flag=value` are accepted. */
export function parseFactoryDomainPreflightArgs(
  argv: string[],
): ParsedFactoryDomainPreflightArgs {
  const values: Partial<Record<"tenantId" | "tenantSlug" | "domain", string>> = {};
  let allowBlocked = false;
  let help = false;
  let separatorSeen = false;

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === "--") {
      if (separatorSeen) throw new FactoryDomainPreflightUsageError("argument separator -- was provided more than once");
      separatorSeen = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--allow-blocked") {
      if (allowBlocked) throw new FactoryDomainPreflightUsageError("--allow-blocked was provided more than once");
      allowBlocked = true;
      continue;
    }

    const equal = token.indexOf("=");
    const flag = equal >= 0 ? token.slice(0, equal) : token;
    const key = VALUE_FLAGS.get(flag);
    if (!key) throw new FactoryDomainPreflightUsageError(`unknown argument: ${token}`);
    if (values[key] !== undefined) throw new FactoryDomainPreflightUsageError(`${flag} was provided more than once`);
    const raw = equal >= 0 ? token.slice(equal + 1) : argv[++index];
    if (raw === undefined || (equal < 0 && raw.startsWith("--"))) {
      throw new FactoryDomainPreflightUsageError(`${flag} requires a value`);
    }
    values[key] = boundedArgument(raw, flag);
  }

  if (help) return { help: true };
  for (const [flag, key] of VALUE_FLAGS) {
    if (values[key] === undefined) throw new FactoryDomainPreflightUsageError(`missing required ${flag}`);
  }
  return {
    tenantId: values.tenantId!,
    tenantSlug: values.tenantSlug!,
    domain: values.domain!,
    allowBlocked,
  };
}

/** Redact common credential shapes from upstream diagnostic prose. */
export function redactPreflightDiagnostic(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

function bindingRow(actionName: string, binding: IntegrationToolBinding): PreflightBindingRow {
  const safeList = (values: string[]): string[] => values.map(redactPreflightDiagnostic);
  return {
    action: redactPreflightDiagnostic(actionName),
    requirement: {
      id: redactPreflightDiagnostic(binding.requirement.id),
      system: redactPreflightDiagnostic(binding.requirement.system),
      kind: redactPreflightDiagnostic(binding.requirement.kind),
      role: redactPreflightDiagnostic(binding.requirement.role),
      ...(binding.requirement.capability ? { capability: redactPreflightDiagnostic(binding.requirement.capability) } : {}),
      operations: safeList(binding.requirement.operations),
      objectTypes: safeList(binding.requirement.objectTypes),
      eventNames: safeList(binding.requirement.eventNames ?? []),
    },
    bindingKind: binding.bindingKind ?? "tool",
    ...(binding.bindingId ? { bindingId: redactPreflightDiagnostic(binding.bindingId) } : {}),
    ...(binding.toolName ? { toolName: redactPreflightDiagnostic(binding.toolName) } : {}),
    ...(binding.selectionRequired ? { selectionRequired: true } : {}),
    ...(binding.selectionCandidates?.length ? {
      selectionCandidates: binding.selectionCandidates.map((candidate) => ({
        bindingKind: candidate.bindingKind,
        bindingId: redactPreflightDiagnostic(candidate.bindingId),
        ...(candidate.toolName ? { toolName: redactPreflightDiagnostic(candidate.toolName) } : {}),
        score: candidate.score,
      })),
    } : {}),
    status: binding.status,
    missingConfigKeys: binding.missingConfigKeys ?? [],
    missingCredentialEnv: binding.missingCredentialEnv ?? [],
    invalidConfigKeys: binding.invalidConfigKeys ?? [],
    reason: redactPreflightDiagnostic(binding.reason),
  };
}

function safeReadinessIssue(issue: OntologyReadinessIssue): OntologyReadinessIssue {
  return {
    ...issue,
    message: redactPreflightDiagnostic(issue.message),
    ...(issue.domain ? { domain: redactPreflightDiagnostic(issue.domain) } : {}),
    ...(issue.action ? { action: redactPreflightDiagnostic(issue.action) } : {}),
    ...(issue.event ? { event: redactPreflightDiagnostic(issue.event) } : {}),
    ...(issue.object ? { object: redactPreflightDiagnostic(issue.object) } : {}),
    ...(issue.step ? { step: redactPreflightDiagnostic(issue.step) } : {}),
    ...(issue.rule ? { rule: redactPreflightDiagnostic(issue.rule) } : {}),
    ...(issue.field ? { field: redactPreflightDiagnostic(issue.field) } : {}),
  };
}

export function mergeFactoryPreflightTools(
  globalTools: RealTool[],
  declarativeTools: DeclarativeTool[],
): {
  executableTools: RealTool[];
  declarativeShadowedByGlobal: number;
} {
  const globalNames = new Set(globalTools.map((tool) => tool.name));
  const activeDeclarative = declarativeTools.filter((tool) => !globalNames.has(tool.name));
  return {
    // Production currentExecutionResources uses the registry definition as
    // authority on an executable-name collision.
    executableTools: [
      ...globalTools,
      ...activeDeclarative.map(persistedToolAsRealTool),
    ],
    declarativeShadowedByGlobal: declarativeTools.length - activeDeclarative.length,
  };
}

type EvaluatedProfile = {
  profile: IntegrationProfile;
  candidate: PreflightProfileCandidate;
};

type ProfileDecision =
  | { state: "none" }
  | {
      state: "selected" | "unselected" | "ambiguous" | "unavailable";
      explicit: boolean;
      selected?: EvaluatedProfile;
      evaluated: EvaluatedProfile[];
    };

export function preflightProfileHashKey(toolName: string, profileId: string): string {
  return `${toolName}\u0000${profileId}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** `integration.profile_refs` is the explicit, reviewable ontology seam for
 * action→profile selection. Values may be a profile id or profileKey. */
function actionProfileRef(action: OntologyAction, toolName: string): string | undefined {
  const integration = asRecord(action.integration);
  const refs = asRecord(integration?.profile_refs ?? integration?.profileRefs);
  const value = refs?.[toolName];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function decideProfile(input: {
  tool: RealTool;
  action: OntologyAction;
  bindings: IntegrationToolBinding[];
  scope: { tenantId: string; tenantSlug: string; domain: string };
  envPresence: Record<string, string | undefined>;
}): ProfileDecision {
  // Domain preflight evaluates production deployability. Sandbox profiles are
  // intentionally invisible here and can never satisfy a production action.
  const profiles = (input.tool.integrationProfiles ?? [])
    .filter((profile) => profile.environment === "production");
  if (profiles.length === 0) return { state: "none" };
  const requiredObjects = [...new Set(input.bindings.flatMap((binding) => binding.requirement.objectTypes))];
  const evaluated: EvaluatedProfile[] = profiles.map((profile) => {
    const validation = validateIntegrationToolConfig(input.tool, profile.config, { env: input.envPresence });
    const scopeReasons = integrationProfileScopeIssues(profile, input.tool, {
      tenantId: input.scope.tenantId,
      tenantSlug: input.scope.tenantSlug,
      domainId: input.scope.domain,
      environment: "production",
      actionName: input.action.name,
      requiredObjects,
    });
    const reasons = [
      ...validation.issues.map((issue) => issue.message),
      ...scopeReasons,
    ].map(redactPreflightDiagnostic);
    return {
      profile,
      candidate: {
        id: redactPreflightDiagnostic(profile.id),
        profileKey: redactPreflightDiagnostic(profile.profileKey),
        compatible: scopeReasons.length === 0,
        ready: validation.ready && scopeReasons.length === 0,
        missingEnvRefs: validation.missingEnvRefs.map(redactPreflightDiagnostic),
        reasons,
      },
    };
  });
  const explicitRef = actionProfileRef(input.action, input.tool.name);
  if (explicitRef) {
    const selected = evaluated.find(({ profile }) => profile.id === explicitRef || profile.profileKey === explicitRef);
    if (selected?.candidate.compatible) {
      return { state: "selected", explicit: true, selected, evaluated };
    }
    return { state: "unavailable", explicit: true, evaluated };
  }
  const eligible = evaluated.filter((entry) => entry.candidate.compatible);
  const ready = eligible.filter((entry) => entry.candidate.ready);
  if (ready.length === 1) return { state: "unselected", explicit: false, evaluated };
  if (ready.length > 1) return { state: "ambiguous", explicit: false, evaluated };
  if (eligible.length === 1) return { state: "unselected", explicit: false, evaluated };
  return { state: eligible.length > 1 ? "ambiguous" : "unavailable", explicit: false, evaluated };
}

function publicProfileSelection(decision: Exclude<ProfileDecision, { state: "none" }>): PreflightProfileSelection {
  return {
    state: decision.state,
    explicit: decision.explicit,
    ...(decision.selected ? {
      selectedProfileId: redactPreflightDiagnostic(decision.selected.profile.id),
      selectedProfileKey: redactPreflightDiagnostic(decision.selected.profile.profileKey),
    } : {}),
    candidates: decision.evaluated.map((entry) => entry.candidate),
  };
}

/**
 * Convert raw, read-only evidence into a stable report. This function performs
 * no I/O and is the policy seam covered by unit tests.
 */
export function summarizeFactoryDomainPreflight(input: {
  scope: { tenantId: string; tenantSlug: string; domain: string };
  ontology: DomainOntology;
  globalTools: RealTool[];
  declarativeTools: DeclarativeTool[];
  runtimeProviders: IntegrationCapabilityProvider[];
  /** Tenant-confirmed System Profile alias groups (外部系统档案) — the same
   * synonym source the live design gate uses, so preflight verdicts agree. */
  systemAliasGroups?: string[][];
  /** Presence-only map (`"configured"`), never raw environment values. */
  envPresence?: Record<string, string | undefined>;
  /** Hashes computed at the I/O boundary with real env values. The pure
   * summarizer receives only digests, never credential material. */
  profileDefinitionHashes?: Record<string, string>;
}): FactoryDomainPreflightReport {
  const ontology = analyzeOntologyReadiness(input.ontology);
  const mergedTools = mergeFactoryPreflightTools(input.globalTools, input.declarativeTools);
  const groups: FactoryDomainPreflightReport["integrationBindings"]["groups"] = {
    tool: [],
    runtime: [],
    event: [],
  };
  const counts: Record<PreflightBindingStatus, number> = {
    resolved: 0,
    needs_config: 0,
    needs_profile_selection: 0,
    needs_probe: 0,
    missing: 0,
    human_boundary: 0,
  };
  const toolsByName = new Map(mergedTools.executableTools.map((tool) => [tool.name, tool]));
  const envPresence = input.envPresence ?? {};
  // Factory generation owns only actor=Agent Actions. Human/RAAS actions are
  // workflow boundaries, not functions the Factory must provision; including
  // their UI integrations here made a healthy six-Agent slice look blocked by
  // unrelated manual-platform gaps.
  const agentActions = input.ontology.actions.filter((action) => action.actor.includes("Agent"));

  for (const action of agentActions) {
    const declaredTools = (action.tool_use ?? []).filter(Boolean);
    const preliminary = resolveIntegrationBindings(action, mergedTools.executableTools, {
      ...(declaredTools.length ? { boundToolNames: declaredTools } : {}),
      toolConfigs: {},
      env: envPresence,
      capabilityProviders: input.runtimeProviders,
      systemAliasGroups: input.systemAliasGroups ?? [],
    });
    const decisions = new Map<string, ProfileDecision>();
    const toolConfigs: Record<string, Record<string, unknown>> = {};
    const toolProfiles: Record<string, IntegrationProfile> = {};
    const expectedDefinitionHashes: Record<string, string> = {};
    for (const toolName of new Set(preliminary.bindings.map((binding) => binding.toolName).filter((name): name is string => Boolean(name)))) {
      const tool = toolsByName.get(toolName);
      if (!tool) continue;
      const decision = decideProfile({
        tool,
        action,
        bindings: preliminary.bindings.filter((binding) => binding.toolName === toolName),
        scope: input.scope,
        envPresence,
      });
      decisions.set(toolName, decision);
      if (decision.state === "selected" && decision.selected) {
        toolConfigs[toolName] = decision.selected.profile.config;
        toolProfiles[toolName] = decision.selected.profile;
        const definitionHash = input.profileDefinitionHashes?.[
          preflightProfileHashKey(toolName, decision.selected.profile.id)
        ];
        if (definitionHash) expectedDefinitionHashes[toolName] = definitionHash;
      }
    }
    const result = resolveIntegrationBindings(action, mergedTools.executableTools, {
      ...(declaredTools.length ? { boundToolNames: declaredTools } : {}),
      toolConfigs,
      env: envPresence,
      expectedDefinitionHashes,
      capabilityProviders: input.runtimeProviders,
      systemAliasGroups: input.systemAliasGroups ?? [],
      toolProfiles,
      executionScope: {
        tenantId: input.scope.tenantId,
        tenantSlug: input.scope.tenantSlug,
        domainId: input.scope.domain,
      },
    });
    for (const binding of result.bindings) {
      const row = bindingRow(action.name, binding);
      const decision = binding.toolName ? decisions.get(binding.toolName) : undefined;
      if (decision && decision.state !== "none") {
        row.profileSelection = publicProfileSelection(decision);
        if (decision.state !== "selected") {
          row.status = "needs_profile_selection";
          row.reason = decision.state === "ambiguous"
            ? `工具 ${row.toolName ?? ""} 有多套可用 integration profile，需要用户明确选择`
            : decision.state === "unselected"
              ? `Ontology action.integration.profile_refs 尚未为工具 ${row.toolName ?? ""} 明确选择 integration profile`
              : `工具 ${row.toolName ?? ""} 没有与当前 tenant/domain/action 相容的 integration profile`;
          row.missingConfigKeys = [];
          row.missingCredentialEnv = [];
          row.invalidConfigKeys = [];
        }
      }
      groups[row.bindingKind].push(row);
      counts[row.status] += 1;
    }
  }

  const allBindings = [...groups.tool, ...groups.runtime, ...groups.event];
  const integrationReady = counts.needs_config === 0 && counts.needs_profile_selection === 0 && counts.needs_probe === 0 && counts.missing === 0;
  const degraded = input.ontology.degraded;
  const blockedReasons = [
    ...(!ontology.ready ? [`ontology_readiness:${ontology.blocking.length}`] : []),
    ...(degraded ? ["ontology_source_degraded"] : []),
    ...(counts.needs_profile_selection ? [`integration_needs_profile_selection:${counts.needs_profile_selection}`] : []),
    ...(counts.needs_config ? [`integration_needs_config:${counts.needs_config}`] : []),
    ...(counts.needs_probe ? [`integration_needs_probe:${counts.needs_probe}`] : []),
    ...(counts.missing ? [`integration_missing:${counts.missing}`] : []),
  ];
  const ready = blockedReasons.length === 0;

  return {
    schemaVersion: 1,
    mode: "read_only",
    scope: input.scope,
    ready,
    blocked: !ready,
    source: {
      ontology: input.ontology.source,
      degraded: Boolean(degraded),
      ...(degraded?.from ? { degradedFrom: degraded.from } : {}),
      ...(degraded?.reason ? { degradedReason: redactPreflightDiagnostic(degraded.reason) } : {}),
    },
    ontologyReadiness: {
      ready: ontology.ready,
      counts: ontology.counts,
      groups: {
        blocking: ontology.blocking.map(safeReadinessIssue),
        warnings: ontology.warnings.map(safeReadinessIssue),
      },
    },
    integrationBindings: { ready: integrationReady, counts, groups },
    missing: {
      config: allBindings.filter((row) => row.status === "needs_config"),
      profileSelection: allBindings.filter((row) => row.status === "needs_profile_selection"),
      probe: allBindings.filter((row) => row.status === "needs_probe"),
      binding: allBindings.filter((row) => row.status === "missing"),
    },
    inventory: {
      actions: input.ontology.actions.length,
      agentActions: agentActions.length,
      integrationRequirements: allBindings.length,
      globalTools: input.globalTools.length,
      declarativeTools: input.declarativeTools.length,
      declarativeShadowedByGlobal: mergedTools.declarativeShadowedByGlobal,
      executableTools: mergedTools.executableTools.length,
      runtimeProviders: input.runtimeProviders.length,
    },
    blockedReasons,
  };
}

/** Default CI/ops behavior: blocked is exit 1; --allow-blocked is diagnosis-only. */
export function factoryDomainPreflightExitCode(
  report: Pick<FactoryDomainPreflightReport, "blocked">,
  allowBlocked: boolean,
): 0 | 1 {
  return report.blocked && !allowBlocked ? 1 : 0;
}

export function credentialPresence(
  tools: RealTool[],
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const output: Record<string, string | undefined> = {};
  const profileEnvRefs: string[] = [];
  const collectEnvRefs = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectEnvRefs);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/_env$/i.test(key) && typeof item === "string") profileEnvRefs.push(item);
      collectEnvRefs(item);
    }
  };
  for (const tool of tools) {
    for (const profile of tool.integrationProfiles ?? []) collectEnvRefs(profile.config);
  }
  for (const name of new Set([
    ...tools.flatMap((tool) => tool.credentialEnv ?? []),
    ...profileEnvRefs,
  ])) {
    // Deliberately retain only a boolean-equivalent sentinel. Neither the raw
    // value nor a prefix/length is copied into evidence or output.
    output[name] = typeof env[name] === "string" && env[name]!.trim() ? "configured" : undefined;
  }
  return output;
}

/** Real read-only evidence collection through the production composition root. */
export async function runFactoryDomainPreflight(
  options: FactoryDomainPreflightOptions,
): Promise<FactoryDomainPreflightReport> {
  enforceFactoryPreflightReadOnlyDatabase();
  const [{ makeFactoryPorts }, { ensureTenantRegistrySnapshotForReadOnlyPreflight }] =
    await Promise.all([
      import("../src/services/agent-factory/index"),
      import("../src/bootstrap"),
    ]);
  // Standalone preflight deliberately skips API/Inngest bootstrap. Publish the
  // exact workspace or live tenant-code registry selected for this tenant so
  // tenant-native capabilities are not falsely reported as missing.
  await ensureTenantRegistrySnapshotForReadOnlyPreflight(options.tenantSlug);
  const ports = makeFactoryPorts(options.tenantSlug, options.tenantId, options.domain);
  const [rootOntology, globalTools, declarativeTools, runtimeProviders, systemAliasGroups] = await Promise.all([
    ports.ontology.fetchOntology(options.domain),
    ports.toolRegistry?.list() ?? Promise.resolve([]),
    ports.tools?.list(options.domain) ?? Promise.resolve([]),
    ports.integrationCapabilities?.list() ?? Promise.resolve([]),
    ports.systemAliases?.list() ?? Promise.resolve([]),
  ]);
  const ontology = await resolveOntologyReferences(rootOntology, ports.ontology);
  const mergedTools = mergeFactoryPreflightTools(globalTools, declarativeTools);
  const profileDefinitionHashes: Record<string, string> = {};
  for (const tool of mergedTools.executableTools) {
    for (const profile of tool.integrationProfiles ?? []) {
      const definitionHash = probeDefinitionHash(tool, profile.config, process.env);
      if (definitionHash) profileDefinitionHashes[preflightProfileHashKey(tool.name, profile.id)] = definitionHash;
    }
  }
  return summarizeFactoryDomainPreflight({
    scope: {
      tenantId: options.tenantId,
      tenantSlug: options.tenantSlug,
      domain: options.domain,
    },
    ontology,
    globalTools,
    declarativeTools,
    runtimeProviders,
    systemAliasGroups,
    envPresence: credentialPresence(mergedTools.executableTools, process.env),
    profileDefinitionHashes,
  });
}

export const FACTORY_DOMAIN_PREFLIGHT_USAGE = [
  "Usage:",
  "  pnpm --filter @agentic/api preflight:factory-domain -- \\",
  "    --tenant-id <immutable-id> --tenant-slug <slug> --domain <ontology-id> [--allow-blocked]",
  "",
  "The command is read-only. --allow-blocked changes only the exit code; the report remains blocked.",
].join("\n");

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseFactoryDomainPreflightArgs(argv);
  if ("help" in parsed) {
    process.stdout.write(`${FACTORY_DOMAIN_PREFLIGHT_USAGE}\n`);
    return 0;
  }
  const report = await runFactoryDomainPreflight(parsed);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return factoryDomainPreflightExitCode(report, parsed.allowBlocked);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry === import.meta.url) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const usage = error instanceof FactoryDomainPreflightUsageError;
      process.stderr.write(`${JSON.stringify({
        schemaVersion: 1,
        mode: "read_only",
        ready: false,
        blocked: true,
        error: {
          code: usage ? "invalid_arguments" : "preflight_failed",
          message: redactPreflightDiagnostic(error instanceof Error ? error.message : error),
        },
      }, null, 2)}\n`);
      if (usage) process.stderr.write(`${FACTORY_DOMAIN_PREFLIGHT_USAGE}\n`);
      process.exitCode = usage ? 2 : 1;
    });
}
