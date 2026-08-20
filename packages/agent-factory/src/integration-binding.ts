import type { OntologyAction } from "./ontology-types";
import type { RealTool, ToolCapabilityDescriptor } from "./tool-catalog";
import { catalogToolDefinitionHash, declarativeToolDefinitionHash } from "./declarative-tool-hash";
import { validateIntegrationToolConfig, type IntegrationProfile } from "./integration-profile";
import { integrationProfileScopeIssues } from "./integration-profile-authorization";
import { inspectWriteProbeSafety } from "@agentic/shared";
import { isGeneratedToolExecutionPolicy } from "./tool-execution-policy";

type Row = Record<string, unknown>;

export interface IntegrationRequirement {
  id: string;
  actionName: string;
  system: string;
  kind: string;
  role: string;
  capability?: string;
  operations: string[];
  objectTypes: string[];
  /** Event-backed integrations (notification/handoff/inbound trigger) must
   * name the exact ontology events that implement the boundary. */
  /** Optional for persisted v1 requirements; freshly-derived requirements
   * always populate it.  Keeping this optional lets old immutable drafts be
   * reviewed without pretending they already carried event-boundary proof. */
  eventNames?: string[];
  replayable: boolean;
  /**
   * Exact, structured tool identity authored by the Ontology.
   *
   * `integration.systems[].via_tool` is authoritative when present. An
   * `action_step_id` may additionally (or independently) point to one exact
   * `action_steps[]` tool. Resolution never infers either value from
   * descriptions, rationale, call order, or model prose.
   */
  toolBindingConstraint?: {
    viaTool?: string;
    actionStepId?: string;
    actionStepTool?: string;
    issue?: string;
  };
  /**
   * Authoritative evidence that this integration path is disabled by default.
   *
   * This affects draft authoring only: the unresolved binding remains
   * `missing`, `IntegrationBindingReport.ready` remains false, and sandbox /
   * promotion continue to fail closed.  The evidence is carried on the
   * requirement so reviewers can trace the decision back to the Ontology
   * rather than to a model inference.
   */
  authoringOptional?: {
    reason: "disabled_by_default";
    source: "integration.systems" | "action_step.condition";
    evidence: string;
    stepId?: string;
  };
}

export type IntegrationBindingStatus = "resolved" | "needs_config" | "needs_probe" | "missing" | "human_boundary";

/** #HUMAN-BOUNDARY — a (system, mode) integration gap the HUMAN explicitly confirmed as a
 * deliberate manual boundary via a clarify card. Written ONLY by the server while consuming a
 * `[澄清回答]` (never by the model or a tool argument); carries the interaction id for audit. */
export interface IntegrationHumanBoundary {
  system: string;
  /** requirement role ("read"/"write") or "all". */
  mode: string;
  interactionId?: string;
  actor?: string;
  confirmedAt: number;
}

export interface IntegrationBindingCandidate {
  bindingKind: "tool" | "runtime";
  bindingId: string;
  toolName?: string;
  score: number;
}

/** A human choice recorded by the server from one exact interaction option.
 * The ontology hash is part of the authority coordinate: a changed Ontology
 * never inherits an earlier binding choice. */
export interface IntegrationBindingSelection {
  ontologyHash: string;
  actionName: string;
  requirementId: string;
  bindingKind: "tool" | "runtime";
  bindingId: string;
  interactionId?: string;
  actor?: string;
  selectedAt: number;
}

/** Server-owned state for the currently displayed integration choice. Tokens
 * are opaque option values; free prose is never interpreted as a binding. */
export interface PendingIntegrationSelectionAsk {
  ontologyHash: string;
  actionName: string;
  options: Array<{
    token: string;
    requirementId: string;
    bindingKind: "tool" | "runtime";
    bindingId: string;
  }>;
}

export type IntegrationExecutionRef =
  | {
      kind: "tool";
      toolName: string;
      planStepIds: string[];
    }
  | {
      kind: "runtime";
      providerId: string;
      planStepIds: string[];
    }
  | {
      kind: "event";
      eventNames: string[];
    };

export interface IntegrationToolBinding {
  requirement: IntegrationRequirement;
  bindingKind?: "tool" | "runtime" | "event";
  bindingId?: string;
  toolName?: string;
  /** The selected capability deliberately used systems:["*"]. This is
   * auditable and carries stricter profile rules than an exact system match. */
  genericSystemBinding?: boolean;
  /** Exact executable surface that realizes this requirement. A selected
   * capability is not execution evidence until it points at concrete plan
   * steps (or exact event boundaries). */
  executionRef?: IntegrationExecutionRef;
  status: IntegrationBindingStatus;
  missingCredentialEnv?: string[];
  missingConfigKeys?: string[];
  invalidConfigKeys?: string[];
  /** More than one distinct binding has the same highest capability score.
   * Callers must ask a person to choose or make the Ontology more specific. */
  selectionRequired?: boolean;
  selectionCandidates?: IntegrationBindingCandidate[];
  /** Safe next step for an incomplete write-probe contract. */
  next?: "ask_user";
  missingSafety?: string[];
  reason: string;
  /** #HUMAN-BOUNDARY audit trail — present iff status === "human_boundary". */
  humanBoundary?: { interactionId?: string; actor?: string; confirmedAt: number };
}

export interface IntegrationBindingReport {
  ready: boolean;
  bindings: IntegrationToolBinding[];
  counts: Record<IntegrationBindingStatus, number>;
}

/** Non-tool execution surfaces self-declare their integration coverage here.
 * Examples are the host AgentRuntime reason RPC or another platform-owned
 * capability. Keeping these descriptors injected avoids pretending a runtime
 * primitive is a dispatchable tool. */
export interface IntegrationCapabilityProvider {
  id: string;
  capabilities: ToolCapabilityDescriptor[];
  status: "available" | "needs_config";
  reason?: string;
}

const rows = (value: unknown): Row[] =>
  Array.isArray(value)
    ? value.filter((row): row is Row => !!row && typeof row === "object" && !Array.isArray(row))
    : [];

const stringValue = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const key = (value: string): string => value.normalize("NFKC").toLocaleLowerCase().replace(/[\s_.:/()-]+/g, "");

function sameSystem(left: string, right: string, aliasGroups?: readonly (readonly string[])[]): boolean {
  // Direct label equality first. Beyond that, the ONLY sanctioned synonym
  // source is the tenant's human-confirmed System Profiles (alias groups):
  // two different names cross-bind iff one confirmed profile lists both.
  // Unknown vendor names never cross-bind through a code-owned synonym table.
  if (key(left) === key(right)) return true;
  if (!aliasGroups?.length) return false;
  const l = key(left);
  const r = key(right);
  return aliasGroups.some((group) => {
    let hasL = false;
    let hasR = false;
    for (const name of group) {
      const k = key(name);
      if (k === l) hasL = true;
      if (k === r) hasR = true;
      if (hasL && hasR) return true;
    }
    return false;
  });
}
function operationsFromCapability(value: string): string[] {
  const operations = new Set<string>();
  // Typed Ontology sources commonly publish a stable namespaced operation
  // before the human description, for example `rules.fetch — 拉取现行规则`
  // or `candidate.pool_query — ...`. Preserve that exact coordinate.
  // Otherwise every graph/database tool with the same system/kind/role/object
  // coverage becomes an equal candidate and a rule reader can be confused
  // with a generic graph query SDK.
  for (const match of value.matchAll(
    /\b([A-Za-z0-9][A-Za-z0-9_-]*(?:[.:][A-Za-z0-9][A-Za-z0-9_-]*)+)\b/g,
  )) {
    if (match[1]) operations.add(match[1]);
  }
  for (const match of value.matchAll(/\/(?:api\/v\d+\/)?([A-Za-z0-9_-]+)/g)) {
    if (match[1]) operations.add(match[1]);
  }
  for (const match of value.matchAll(/\b(?:get|set|save|sync|create|update|delete|parse|match|invite|generate)[A-Z][A-Za-z0-9]*/g)) {
    operations.add(match[0]);
  }
  return [...operations];
}

const roleAliases: Record<string, string> = {
  read: "read",
  reads: "read",
  fetch: "read",
  query: "read",
  write: "write",
  writes: "write",
  persist: "write",
  upsert: "write",
  call: "call",
  calls: "call",
  invoke: "call",
  execute: "call",
  exec: "call",
  run: "call",
  notify: "notify",
  notifies: "notify",
  trigger: "trigger",
  triggers: "trigger",
  consume: "consume",
  consumes: "consume",
};

const canonicalRole = (value: string): string => roleAliases[key(value)] ?? key(value);
const isReplayableRole = (value: string): boolean => !new Set(["trigger", "consume"]).has(canonicalRole(value));
const explicitlyDisabledByDefault = (value: string): boolean =>
  /(?:默认|缺省)\s*(?:关|关闭|停用|禁用)|default(?:s|ed)?\s*(?:to\s*)?(?:off|disabled)|disabled\s+by\s+default/i.test(value);

function exactToolBindingConstraint(
  action: OntologyAction,
  system: Row,
): IntegrationRequirement["toolBindingConstraint"] {
  const viaTool = stringValue(system.via_tool ?? system.viaTool);
  const actionStepId = stringValue(
    system.action_step_id ??
      system.actionStepId ??
      system.step_id ??
      system.stepId,
  );
  if (!viaTool && !actionStepId) return undefined;

  if (!actionStepId) return { viaTool };
  const pointed = rows(action.action_steps).filter((step) =>
    [step.id, step.step_id, step.stepId, step.name].some(
      (value) => stringValue(value) === actionStepId,
    ),
  );
  if (pointed.length !== 1) {
    return {
      ...(viaTool ? { viaTool } : {}),
      actionStepId,
      issue:
        pointed.length === 0
          ? `action_step_id ${actionStepId} 未指向任何 action_steps[]`
          : `action_step_id ${actionStepId} 指向多个 action_steps[]`,
    };
  }
  const actionStepTool = stringValue(pointed[0]!.tool);
  if (!actionStepTool) {
    return {
      ...(viaTool ? { viaTool } : {}),
      actionStepId,
      issue: `action_step_id ${actionStepId} 指向的步骤没有声明 tool`,
    };
  }
  return {
    ...(viaTool ? { viaTool } : {}),
    actionStepId,
    actionStepTool,
  };
}

const exactIdentifierMention = (value: string, identifier: string): boolean => {
  const haystack = value.normalize("NFKC");
  const needle = identifier.normalize("NFKC").trim();
  if (!haystack || !needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`,
    "iu",
  ).test(haystack);
};

const identifierTokens = (value: string): string[] =>
  value
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);

/**
 * Some live Ontology integrations expose a stable namespaced operation
 * (`candidate.lock_check`) while the corresponding Action step deliberately
 * uses an implementation-facing id (`optional_ownership_lock_check`).  The
 * integration call order is not a safe join key: Allmeta numbers external
 * calls independently from action_steps.
 *
 * Accept only the final segment of an explicitly namespaced capability and
 * only when it contains at least two lexical tokens.  This keeps the join
 * exact/auditable and prevents broad prose such as "optional enrichment" (or
 * a single verb such as "read") from becoming identity evidence.
 */
function namespacedCapabilityReferencedStep(
  action: OntologyAction,
  system: Row,
): Row | null | undefined {
  const capability = stringValue(system.capability);
  const stableIdentifier = capability
    .split(/[\s—–]+/u)[0]
    ?.match(/^[A-Za-z0-9][A-Za-z0-9_-]*(?:[.:/][A-Za-z0-9][A-Za-z0-9_-]*)+$/u)?.[0];
  if (!stableIdentifier) return undefined;

  const operation = stableIdentifier.split(/[.:/]/u).at(-1) ?? "";
  const operationTokens = identifierTokens(operation);
  if (operationTokens.length < 2) return undefined;

  const containsOperation = (value: unknown): boolean => {
    const candidateTokens = identifierTokens(stringValue(value));
    if (candidateTokens.length < operationTokens.length) return false;
    return candidateTokens.some((_, start) =>
      operationTokens.every(
        (token, offset) => candidateTokens[start + offset] === token,
      ),
    );
  };
  const matched = rows(action.action_steps).filter((step) =>
    [step.step_id, step.stepId, step.id, step.name].some(containsOperation),
  );
  if (!matched.length) return undefined;
  return matched.length === 1 ? matched[0] : null;
}

function explicitlyReferencedStep(
  action: OntologyAction,
  system: Row,
): Row | null | undefined {
  const actionSteps = rows(action.action_steps);
  const systemName = stringValue(system.name ?? system.system);

  // Prefer an explicit system -> step pointer when the source supplies one.
  // A dangling or ambiguous pointer is contradictory evidence, so it must not
  // silently fall back to a positional guess.
  const declaredStepRef = stringValue(
    system.action_step_id ??
      system.actionStepId ??
      system.step_id ??
      system.stepId ??
      system.step_name ??
      system.stepName,
  );
  if (declaredStepRef) {
    const pointed = actionSteps.filter((step) =>
      [
        step.id,
        step.step_id,
        step.stepId,
        step.name,
      ].some((value) => key(stringValue(value)) === key(declaredStepRef)),
    );
    return pointed.length === 1 ? pointed[0] : null;
  }

  if (!systemName) return undefined;
  const structured = actionSteps.filter((step) =>
    [
      step.integration_system,
      step.integrationSystem,
      step.system,
      step.system_name,
      step.systemName,
      step.external_system,
      step.externalSystem,
    ].some((value) => key(stringValue(value)) === key(systemName)),
  );
  if (structured.length) return structured.length === 1 ? structured[0] : null;

  // Live Allmeta Actions may describe the owning integration in the step text
  // while integration.call_order describes only the external-call sequence
  // (not action_steps[] position). Require an exact system identifier and one
  // unique step; fuzzy vendor-name matching would be unsafe here.
  const mentioned = actionSteps.filter((step) =>
    [
      step.condition,
      step.description,
      step.instruction,
    ].some((value) =>
      exactIdentifierMention(stringValue(value), systemName),
    ),
  );
  if (mentioned.length) return mentioned.length === 1 ? mentioned[0] : null;

  return namespacedCapabilityReferencedStep(action, system);
}

function authoringOptionalEvidence(
  action: OntologyAction,
  system: Row,
): IntegrationRequirement["authoringOptional"] {
  const rolloutMode = stringValue(
    system.rollout_mode ?? system.rolloutMode ?? system.execution_mode,
  );
  if (
    system.enabled_by_default === false ||
    system.default_enabled === false ||
    system.dark_launch === true ||
    /^(?:dark[-_ ]?launch|disabled|off)$/i.test(rolloutMode)
  ) {
    return {
      reason: "disabled_by_default",
      source: "integration.systems",
      evidence:
        system.enabled_by_default === false
          ? "enabled_by_default=false"
          : system.default_enabled === false
            ? "default_enabled=false"
            : system.dark_launch === true
              ? "dark_launch=true"
              : `rollout_mode=${rolloutMode}`,
    };
  }

  const referencedStep = explicitlyReferencedStep(action, system);
  if (referencedStep === null) return undefined;
  if (referencedStep) {
    const condition = stringValue(referencedStep.condition);
    if (!explicitlyDisabledByDefault(condition)) return undefined;
    const stepId = stringValue(
      referencedStep.step_id ?? referencedStep.stepId ?? referencedStep.id,
    );
    return {
      reason: "disabled_by_default",
      source: "action_step.condition",
      evidence: condition,
      ...(stepId ? { stepId } : {}),
    };
  }

  const callOrder = Number(system.call_order ?? system.callOrder);
  if (!Number.isInteger(callOrder) || callOrder < 1) return undefined;
  // Allmeta's live Action endpoint normalizes step.order to a zero-based
  // index, while integration.call_order remains one-based. Uploaded/local
  // Ontologies may preserve the original one-based order. Accept both shapes,
  // but only when exactly one positional candidate carries an explicit
  // disabled-by-default condition.
  const matchingSteps = rows(action.action_steps).filter((step) => {
    const order = Number(step.order ?? step.call_order ?? step.callOrder);
    return Number.isInteger(order)
      && (order === callOrder || order === callOrder - 1);
  });
  // A zero-based candidate and a one-based candidate are genuinely
  // indistinguishable here, even if only one happens to mention the feature
  // flag.  Treating the condition as a tie-breaker would infer which step the
  // integration belongs to, so fail closed until the positional identity is
  // unique.
  if (matchingSteps.length !== 1) return undefined;
  const disabledSteps = matchingSteps
    .map((step) => ({ step, condition: stringValue(step.condition) }))
    .filter(({ condition }) =>
      Boolean(condition) && explicitlyDisabledByDefault(condition));
  if (disabledSteps.length !== 1) return undefined;
  const { step, condition } = disabledSteps[0]!;
  const stepId = stringValue(step.step_id ?? step.stepId ?? step.id);
  return {
    reason: "disabled_by_default",
    source: "action_step.condition",
    evidence: condition,
    ...(stepId ? { stepId } : {}),
  };
}

/** Turn descriptive `integration.systems[]` into stable executable
 * requirements. This is intentionally generic; it never special-cases a domain,
 * action, vendor, or tool name. */
export function deriveIntegrationRequirements(action: OntologyAction): IntegrationRequirement[] {
  const integration = action.integration && typeof action.integration === "object"
    ? action.integration as Row
    : {};
  const notificationEvents = rows(
    action.side_effects && typeof action.side_effects === "object"
      ? (action.side_effects as Row).notifications
      : undefined,
  ).map((notification) => stringValue(notification.triggered_event ?? notification.event)).filter(Boolean);
  return rows(integration.systems).map((system, index) => {
    const capability = stringValue(system.capability);
    const role = stringValue(system.role);
    const canonical = canonicalRole(role);
    const optionalEvidence = authoringOptionalEvidence(action, system);
    const toolBindingConstraint = exactToolBindingConstraint(action, system);
    const eventNames = canonical === "notify"
      ? [...new Set(notificationEvents)]
      : canonical === "trigger" || canonical === "consume"
        ? [...new Set(action.trigger ?? [])]
        : [];
    return {
      id: `${action.id || action.name}:integration:${index + 1}`,
      actionName: action.name,
      system: stringValue(system.name ?? system.system),
      kind: stringValue(system.kind),
      role,
      capability: capability || undefined,
      operations: operationsFromCapability(capability),
      objectTypes: Array.isArray(system.objects)
        ? system.objects.map(stringValue).filter(Boolean)
        : [],
      eventNames,
      replayable: isReplayableRole(role),
      ...(toolBindingConstraint ? { toolBindingConstraint } : {}),
      ...(optionalEvidence ? { authoringOptional: optionalEvidence } : {}),
    };
  });
}

function capabilityMatches(
  requirement: IntegrationRequirement,
  capability: ToolCapabilityDescriptor,
  aliasGroups?: readonly (readonly string[])[],
): { matches: boolean; score: number; reason?: string } {
  // A code-owned, profile-bound transport may explicitly declare `*` when it
  // is system-agnostic (for example a server-owned SQL statement catalog).
  // This relaxes only the label match: kind, role, object coverage, selected
  // profile, credentials and probe checks below remain mandatory.
  const systemWildcard = capability.systems.some(
    (system) => system.trim() === "*",
  );
  if (
    !systemWildcard &&
    !capability.systems.some((system) =>
      sameSystem(system, requirement.system, aliasGroups),
    )
  ) {
    return { matches: false, score: 0, reason: "system mismatch" };
  }
  if (requirement.kind && !capability.kinds.some((kind) => key(kind) === key(requirement.kind))) {
    return { matches: false, score: 0, reason: "kind mismatch" };
  }
  if (requirement.role && !capability.roles.some((role) => canonicalRole(role) === canonicalRole(requirement.role))) {
    return { matches: false, score: 0, reason: "role mismatch" };
  }
  const declaredObjects = new Set((capability.objectTypes ?? []).map(key));
  if (requirement.objectTypes.length && !declaredObjects.has("*") && requirement.objectTypes.some((object) => !declaredObjects.has(key(object)))) {
    return { matches: false, score: 0, reason: "object coverage mismatch" };
  }
  const declaredOperations = new Set((capability.operations ?? []).map(key));
  // A structured operation coordinate is authority for executable
  // API/database/graph/LLM boundaries, not only HTTP. These transports are
  // often deliberately broad on object coverage; ignoring `rules.fetch` or
  // `candidate.pool_query` makes unrelated adapters indistinguishable.
  // File/object-store capability prose remains descriptive for compatibility
  // unless its descriptor explicitly sets requiresOperation.
  if (capability.requiresOperation && requirement.operations.length === 0) {
    return { matches: false, score: 0, reason: "operation required" };
  }
  const operationRequired =
    requirement.operations.length > 0 &&
    new Set([
      "externalapi",
      "graphdb",
      "graphdatabase",
      "ontology",
      "rulebase",
      "database",
      "datastore",
      "relationaldatabase",
      "llm",
      "llmgateway",
      "modelgateway",
    ]).has(key(requirement.kind));
  const matchedOperationCount = requirement.operations.filter((operation) =>
    declaredOperations.has(key(operation)),
  ).length;
  if (operationRequired && matchedOperationCount === 0) {
    return { matches: false, score: 0, reason: "operation mismatch" };
  }
  return {
    matches: true,
    // Prefer an adapter that covers more of an explicit compound contract.
    // For `rules.select + graph.verify`, a rules-only fetcher must not tie
    // with the evaluator that covers both operations.
    score:
      100 +
      requirement.objectTypes.length * 5 +
      (operationRequired ? matchedOperationCount * 10 : 0),
  };
}

export function resolveIntegrationBindings(
  action: OntologyAction,
  tools: RealTool[],
  opts: {
    /** When supplied, only tools actually selected by the generated spec may bind. */
    boundToolNames?: string[];
    /** Selected non-secret runtime config. `*_env` values name the real secret
     * env var and are checked without persisting the secret itself. */
    toolConfigs?: Record<string, Record<string, unknown>>;
    env?: Record<string, string | undefined>;
    /** Trusted precomputed hashes for contexts that must not receive raw env
     * values (for example read-only preflight). */
    expectedDefinitionHashes?: Record<string, string>;
    /** Tenant-confirmed System Profile alias groups: names in one group refer
     * to the same external system. The ONLY sanctioned synonym source. */
    systemAliasGroups?: readonly (readonly string[])[];
    capabilityProviders?: IntegrationCapabilityProvider[];
    /** Current-hash, server-recorded human choices. The caller is responsible
     * for filtering by ontologyHash; the resolver additionally scopes every
     * choice to this exact action + requirement id. */
    bindingSelections?: Array<
      Pick<
        IntegrationBindingSelection,
        "actionName" | "requirementId" | "bindingKind" | "bindingId"
      >
    >;
    /** The exact confirmed profile selected for each tool. Binding rechecks
     * identity and catalog profileScope; a stored config alone is not proof
     * that this action is authorized to use it. */
    toolProfiles?: Record<string, IntegrationProfile>;
    /** Authenticated execution owner. action/object scope comes from the
     * ontology requirement currently being bound, never from caller input. */
    executionScope?: { tenantId?: string; tenantSlug?: string; domainId: string; environment?: import("./integration-profile").IntegrationProfileEnvironment };
    /** Concrete generated plan. When supplied, every resolved non-event
     * binding is fail-closed unless the selected surface appears in it. */
    plan?: Array<{
      stepId: string;
      kind: string;
      tool?: string;
      body?: Array<any>;
    }>;
  } = {},
): IntegrationBindingReport {
  const env = opts.env ?? process.env;
  const bound = opts.boundToolNames ? new Set(opts.boundToolNames) : null;
  // Alias-aware: a manifest may bind a tool by any of its registered names
  // (e.g. the legacy `robohire*` aliases for the canonical `gohire*` tools).
  // Matching only the canonical `tool.name` silently drops alias-bound tools.
  const candidates = bound
    ? tools.filter(
        (tool) =>
          bound.has(tool.name) ||
          (tool.aliases ?? []).some((alias) => bound.has(alias)),
      )
    : tools;
  const rawBindings = deriveIntegrationRequirements(action).map((requirement): IntegrationToolBinding => {
    const eventBacked = new Set(["notify", "trigger", "consume"]).has(canonicalRole(requirement.role));
    if (eventBacked) {
      const eventNames = requirement.eventNames ?? [];
      const declared = new Set(((canonicalRole(requirement.role) === "notify" ? action.triggered_event : action.trigger) ?? []).map(key));
      const missingEvents = eventNames.filter((event) => !declared.has(key(event)));
      if (!eventNames.length || missingEvents.length) {
        return {
          requirement,
          bindingKind: "event",
          status: "missing",
          reason: !eventNames.length
            ? `事件型集成 ${requirement.system}/${requirement.role} 没有声明可验证的 ontology event`
            : `事件型集成引用了 action 未声明的 event: ${missingEvents.join(",")}`,
        };
      }
      return {
        requirement,
        bindingKind: "event",
        bindingId: eventNames.join(","),
        status: "resolved",
        reason: `由 ontology event ${eventNames.join(",")} 实现外部边界`,
      };
    }

    const providerMatches = (opts.capabilityProviders ?? [])
      .flatMap((provider) => provider.capabilities.map((capability) => ({ provider, result: capabilityMatches(requirement, capability, opts.systemAliasGroups) })))
      .filter((candidate) => candidate.result.matches)
      .sort((left, right) => right.result.score - left.result.score || left.provider.id.localeCompare(right.provider.id));
    const toolMatches = candidates
      .flatMap((tool) => (tool.capabilities ?? []).map((capability) => ({ tool, capability, result: capabilityMatches(requirement, capability, opts.systemAliasGroups) })))
      .filter((candidate) => candidate.result.matches)
      .sort((left, right) => right.result.score - left.result.score || left.tool.name.localeCompare(right.tool.name));

    type RankedCandidate =
      | { bindingKind: "runtime"; bindingId: string; score: number; provider: IntegrationCapabilityProvider }
      | { bindingKind: "tool"; bindingId: string; score: number; tool: RealTool; capability: ToolCapabilityDescriptor };
    let rankedRaw: RankedCandidate[] = [
      // An explicit bound tool disambiguates this requirement from runtime
      // providers. If none of the selected tools covers it, providers remain
      // eligible rather than making unrelated tool selections disable runtime.
      ...(bound && toolMatches.length ? [] : providerMatches.map(({ provider, result }) => ({
        bindingKind: "runtime" as const,
        bindingId: provider.id,
        score: result.score,
        provider,
      }))),
      ...toolMatches.map(({ tool, capability, result }) => ({
        bindingKind: "tool" as const,
        bindingId: tool.name,
        score: result.score,
        tool,
        capability,
      })),
    ];
    const constraint = requirement.toolBindingConstraint;
    if (constraint) {
      if (constraint.issue) {
        return {
          requirement,
          bindingKind: "tool",
          status: "missing",
          reason: `Ontology 的精确工具约束无效：${constraint.issue}`,
        };
      }
      const declaredNames = [
        ...new Set(
          [constraint.viaTool, constraint.actionStepTool].filter(
            (value): value is string => Boolean(value),
          ),
        ),
      ];
      const resolvedTools = declaredNames.map((declaredName) => {
        const exact = tools.filter((tool) => tool.name === declaredName);
        const aliases = exact.length
          ? []
          : tools.filter((tool) => (tool.aliases ?? []).includes(declaredName));
        const matches = exact.length ? exact : aliases;
        return { declaredName, matches };
      });
      const unresolved = resolvedTools.find(({ matches }) => matches.length !== 1);
      if (unresolved) {
        return {
          requirement,
          bindingKind: "tool",
          status: "missing",
          reason:
            unresolved.matches.length === 0
              ? `Ontology 精确声明的工具 ${unresolved.declaredName} 不在当前可执行 registry，禁止退回语义候选`
              : `Ontology 精确声明的工具 ${unresolved.declaredName} 命中多个 registry identity，禁止猜测`,
        };
      }
      const identities = new Set(
        resolvedTools.map(({ matches }) => matches[0]!.name),
      );
      if (identities.size !== 1) {
        return {
          requirement,
          bindingKind: "tool",
          status: "missing",
          reason: `integration via_tool 与 action_step_id 指向不同工具（${resolvedTools.map(({ declaredName, matches }) => `${declaredName}→${matches[0]!.name}`).join("、")}）`,
        };
      }
      const exactTool = resolvedTools[0]!.matches[0]!;
      if (
        bound &&
        !bound.has(exactTool.name) &&
        !(exactTool.aliases ?? []).some((alias) => bound.has(alias))
      ) {
        return {
          requirement,
          bindingKind: "tool",
          status: "missing",
          reason: `Ontology 精确要求工具 ${exactTool.name}，但当前生成规格没有选择它`,
        };
      }
      const exactMatches = (exactTool.capabilities ?? [])
        .flatMap((capability) => {
          const result = capabilityMatches(
            requirement,
            capability,
            opts.systemAliasGroups,
          );
          return result.matches
            ? [
                {
                  bindingKind: "tool" as const,
                  bindingId: exactTool.name,
                  score: result.score,
                  tool: exactTool,
                  capability,
                },
              ]
            : [];
        });
      if (!exactMatches.length) {
        return {
          requirement,
          bindingKind: "tool",
          status: "missing",
          reason: `Ontology 精确要求工具 ${exactTool.name}，但其当前 capability 与 ${requirement.system}/${requirement.kind}/${requirement.role} 不匹配`,
        };
      }
      rankedRaw = exactMatches;
    }
    // Multiple capability descriptors on the same provider/tool are one
    // binding candidate. Keep its strongest descriptor only.
    const rankedByIdentity = new Map<string, RankedCandidate>();
    for (const candidate of rankedRaw) {
      const identity = `${candidate.bindingKind}:${candidate.bindingId}`;
      const prior = rankedByIdentity.get(identity);
      if (!prior || candidate.score > prior.score) rankedByIdentity.set(identity, candidate);
    }
    const ranked = [...rankedByIdentity.values()].sort((left, right) =>
      right.score - left.score || left.bindingKind.localeCompare(right.bindingKind) || left.bindingId.localeCompare(right.bindingId));
    const highestScore = ranked[0]?.score;
    let highest = highestScore === undefined ? [] : ranked.filter((candidate) => candidate.score === highestScore);
    const recordedSelection = opts.bindingSelections?.find(
      (selection) =>
        selection.actionName === action.name &&
        selection.requirementId === requirement.id,
    );
    if (!constraint && recordedSelection) {
      const selected = ranked.find(
        (candidate) =>
          candidate.bindingKind === recordedSelection.bindingKind &&
          candidate.bindingId === recordedSelection.bindingId,
      );
      if (!selected) {
        const selectionCandidates: IntegrationBindingCandidate[] = highest.map(
          (candidate) => ({
            bindingKind: candidate.bindingKind,
            bindingId: candidate.bindingId,
            ...(candidate.bindingKind === "tool"
              ? { toolName: candidate.tool.name }
              : {}),
            score: candidate.score,
          }),
        );
        return {
          requirement,
          bindingKind: "tool",
          status: "missing",
          selectionRequired: true,
          selectionCandidates,
          reason: `此前记录的集成选择 ${recordedSelection.bindingKind}:${recordedSelection.bindingId} 已不满足当前 capability，必须重新选择`,
        };
      }
      highest = [selected];
    }
    if (highest.length > 1) {
      const selectionCandidates: IntegrationBindingCandidate[] = highest.map((candidate) => ({
        bindingKind: candidate.bindingKind,
        bindingId: candidate.bindingId,
        ...(candidate.bindingKind === "tool" ? { toolName: candidate.tool.name } : {}),
        score: candidate.score,
      }));
      return {
        requirement,
        bindingKind: "tool",
        status: "missing",
        selectionRequired: true,
        selectionCandidates,
        reason: `有 ${highest.length} 个同等匹配的集成候选，需要用户明确选择：${selectionCandidates.map((candidate) => `${candidate.bindingKind === "tool" ? "工具" : "运行时能力"} ${candidate.bindingId}`).join("、")}`,
      };
    }
    const best = highest[0];
    if (!best) {
      return {
        requirement,
        bindingKind: "tool",
        status: "missing",
        reason: `没有工具显式覆盖 ${requirement.system}/${requirement.kind}/${requirement.role}${requirement.objectTypes.length ? `/${requirement.objectTypes.join(",")}` : ""}`,
      };
    }
    if (best.bindingKind === "runtime") {
      return best.provider.status === "available"
        ? {
            requirement,
            bindingKind: "runtime",
            bindingId: best.provider.id,
            status: "resolved",
            reason: `由运行时能力 ${best.provider.id} 提供`,
          }
        : {
            requirement,
            bindingKind: "runtime",
            bindingId: best.provider.id,
            status: "needs_config",
            next: "ask_user",
            reason: best.provider.reason ?? `运行时能力 ${best.provider.id} 尚未配置`,
          };
    }
    const bestTool = best;
    const systemWildcard = bestTool.capability.systems.some(
      (system) => system.trim() === "*",
    );
    const selectedProfile = opts.toolProfiles?.[bestTool.tool.name];
    // A wildcard is a reusable transport implementation, not authority to
    // guess the endpoint behind an Ontology system label. Require a confirmed
    // profile and an authenticated execution scope even when the tool happens
    // to have no other config fields.
    if (systemWildcard && (!selectedProfile || !opts.executionScope)) {
      return {
        requirement,
        bindingKind: "tool",
        bindingId: bestTool.tool.name,
        toolName: bestTool.tool.name,
        genericSystemBinding: true,
        status: "needs_config",
        next: "ask_user",
        reason: `通用工具 ${bestTool.tool.name} 只能通过当前 tenant/domain/environment 已确认的 integration profile 绑定到 ${requirement.system}，不能根据 systems:[\"*\"] 猜连接`,
      };
    }
    if (systemWildcard) {
      const systemConfigKey = stringValue(
        bestTool.capability.systemConfigKey,
      );
      if (!systemConfigKey) {
        return {
          requirement,
          bindingKind: "tool",
          bindingId: bestTool.tool.name,
          toolName: bestTool.tool.name,
          genericSystemBinding: true,
          status: "needs_config",
          next: "ask_user",
          reason: `通用工具 ${bestTool.tool.name} 的 capability 没有声明 systemConfigKey，无法证明 profile 连接的是 ${requirement.system}`,
        };
      }
      const configuredSystem = selectedProfile!.config[systemConfigKey];
      if (
        typeof configuredSystem !== "string" ||
        !configuredSystem.trim() ||
        !sameSystem(configuredSystem, requirement.system, opts.systemAliasGroups)
      ) {
        return {
          requirement,
          bindingKind: "tool",
          bindingId: bestTool.tool.name,
          toolName: bestTool.tool.name,
          genericSystemBinding: true,
          status: "needs_config",
          next: "ask_user",
          missingConfigKeys:
            typeof configuredSystem === "string" && configuredSystem.trim()
              ? []
              : [systemConfigKey],
          invalidConfigKeys:
            typeof configuredSystem === "string" && configuredSystem.trim()
              ? [systemConfigKey]
              : [],
          reason: `工具 ${bestTool.tool.name} 的 profile.${systemConfigKey} 必须精确绑定 Ontology system ${requirement.system}，当前值为 ${typeof configuredSystem === "string" && configuredSystem.trim() ? configuredSystem : "未配置"}`,
        };
      }
    }
    const config = opts.toolConfigs?.[bestTool.tool.name] ?? {};
    const configValidation = validateIntegrationToolConfig(bestTool.tool, config, { env });
    if (!configValidation.ready) {
      const detail = [
        ...new Set(configValidation.issues.map((issue) => issue.message)),
        configValidation.missingEnvRefs.length
          ? `服务器尚未配置环境变量 ${configValidation.missingEnvRefs.join(",")}`
          : "",
      ].filter(Boolean).join("；");
      return {
        requirement,
        bindingKind: "tool",
        bindingId: bestTool.tool.name,
        toolName: bestTool.tool.name,
        status: "needs_config",
        next: "ask_user",
        missingCredentialEnv: configValidation.missingEnvRefs,
        missingConfigKeys: configValidation.missingConfigKeys,
        invalidConfigKeys: configValidation.invalidConfigKeys,
        reason: `工具 ${bestTool.tool.name} 的集成配置未就绪：${detail || configValidation.issues[0]?.message || "配置未通过校验"}`,
      };
    }
    if (opts.executionScope && (selectedProfile || bestTool.tool.catalogDefinition?.profileScope)) {
      if (!selectedProfile) {
        return {
          requirement,
          bindingKind: "tool",
          bindingId: bestTool.tool.name,
          toolName: bestTool.tool.name,
          status: "needs_config",
          next: "ask_user",
          reason: `工具 ${bestTool.tool.name} 声明了执行 scope，但没有绑定用户确认过的 integration profile`,
        };
      }
      const scopeIssues = integrationProfileScopeIssues(selectedProfile, bestTool.tool, {
        ...opts.executionScope,
        environment: opts.executionScope.environment ?? "production",
        actionName: action.name,
        requiredObjects: requirement.objectTypes,
      });
      if (scopeIssues.length) {
        return {
          requirement,
          bindingKind: "tool",
          bindingId: bestTool.tool.name,
          toolName: bestTool.tool.name,
          status: "needs_config",
          next: "ask_user",
          reason: `工具 ${bestTool.tool.name} 的 integration profile 不适用于当前执行：${scopeIssues.join("；")}`,
        };
      }
    }
    const declarativePolicy = bestTool.tool.declarativeDefinition
      && isGeneratedToolExecutionPolicy(bestTool.tool.declarativeDefinition)
      ? bestTool.tool.declarativeDefinition
      : undefined;
    if (bestTool.tool.declarativeDefinition && !declarativePolicy) {
      return {
        requirement,
        bindingKind: "tool",
        bindingId: bestTool.tool.name,
        toolName: bestTool.tool.name,
        status: "needs_config",
        next: "ask_user",
        reason: `工具 ${bestTool.tool.name} 还没有完整、可审核的 execution policy；请先明确 operation、effectScope 和 sandboxPolicy，不会从旧 sideEffect 或 HTTP method 推断`,
      };
    }
    const expectedDefinitionHash = opts.expectedDefinitionHashes?.[bestTool.tool.name]
      ?? (bestTool.tool.declarativeDefinition
        ? declarativeToolDefinitionHash({
            ...bestTool.tool.declarativeDefinition,
            operation: declarativePolicy!.operation,
            effectScope: declarativePolicy!.effectScope,
            sandboxPolicy: declarativePolicy!.sandboxPolicy,
          }, config, env)
        : bestTool.tool.catalogDefinition
          ? catalogToolDefinitionHash(bestTool.tool.catalogDefinition, config, env)
          : undefined);
    if (bestTool.capability.probeRequired) {
      const safety = inspectWriteProbeSafety(
        bestTool.tool.sideEffect,
        bestTool.tool.catalogDefinition?.probeSafety ?? bestTool.tool.declarativeDefinition?.probeSafety,
      );
      if (safety.status === "needs_config") {
        return {
          requirement,
          bindingKind: "tool",
          bindingId: bestTool.tool.name,
          toolName: bestTool.tool.name,
          status: "needs_config",
          next: "ask_user",
          missingSafety: safety.missing,
          reason: `工具 ${bestTool.tool.name} 的写探针安全契约未就绪：${safety.question}`,
        };
      }
    }
    const verifiedDefinitionHashes = new Set([
      ...(bestTool.tool.verifiedDefinitionHashes ?? []),
      ...(bestTool.tool.probeStatus === "verified" && bestTool.tool.definitionHash
        ? [bestTool.tool.definitionHash]
        : []),
    ]);
    const hasVerifiedProbe = bestTool.tool.probeStatus === "verified" || verifiedDefinitionHashes.size > 0;
    const probedDefinitionMatches = !expectedDefinitionHash || verifiedDefinitionHashes.has(expectedDefinitionHash);
    if (bestTool.capability.probeRequired && (!hasVerifiedProbe || !probedDefinitionMatches)) {
      return {
        requirement,
        bindingKind: "tool",
        bindingId: bestTool.tool.name,
        toolName: bestTool.tool.name,
        status: "needs_probe",
        reason: hasVerifiedProbe && !probedDefinitionMatches
          ? `工具 ${bestTool.tool.name} 的 probe evidence 与当前 definition/config hash 不一致`
          : `工具 ${bestTool.tool.name} 尚无与当前 definition/config 绑定的 probe evidence`,
      };
    }
    return {
      requirement,
      bindingKind: "tool",
      bindingId: bestTool.tool.name,
      toolName: bestTool.tool.name,
      ...(systemWildcard ? { genericSystemBinding: true } : {}),
      status: "resolved",
      reason: systemWildcard
        ? "generic transport bound through exact confirmed profile"
        : "capability exact match",
    };
  });
  // Generated specs currently select one profile per tool/environment. That
  // single endpoint must not silently stand in for two distinct Ontology
  // systems merely because the underlying transport is generic. The safe
  // resolution is to define separate capability adapters/profile slots (or
  // correct the Ontology system identity) and let a person choose explicitly.
  const genericSystemsByTool = new Map<string, Set<string>>();
  for (const binding of rawBindings) {
    if (
      binding.status !== "resolved" ||
      binding.bindingKind !== "tool" ||
      !binding.toolName ||
      binding.genericSystemBinding !== true
    ) continue;
    const systems = genericSystemsByTool.get(binding.toolName) ?? new Set<string>();
    systems.add(key(binding.requirement.system));
    genericSystemsByTool.set(binding.toolName, systems);
  }
  const conflictingGenericTools = new Set(
    [...genericSystemsByTool]
      .filter(([, systems]) => systems.size > 1)
      .map(([toolName]) => toolName),
  );
  const profileScopedBindings = rawBindings.map((binding): IntegrationToolBinding => {
    if (!binding.toolName || !conflictingGenericTools.has(binding.toolName)) {
      return binding;
    }
    const systems = rawBindings
      .filter((candidate) =>
        candidate.toolName === binding.toolName &&
        candidate.genericSystemBinding === true,
      )
      .map((candidate) => candidate.requirement.system)
      .filter((value, index, all) => all.findIndex((item) => key(item) === key(value)) === index);
    return {
      ...binding,
      status: "needs_config",
      next: "ask_user",
      reason: `同一个 integration profile 不能让通用工具 ${binding.toolName} 同时代表多个 system（${systems.join("、")}）；请为每个 system 提供独立工具/profile 槽，或先修正 Ontology system 标识`,
    };
  });
  const flattenPlan = (steps: NonNullable<typeof opts.plan>): NonNullable<typeof opts.plan> =>
    steps.flatMap((step) => [step, ...flattenPlan(step.body ?? [])]);
  const planSteps = opts.plan ? flattenPlan(opts.plan) : null;
  const bindings = profileScopedBindings.map((binding): IntegrationToolBinding => {
    if (binding.status !== "resolved") return binding;
    const kind = binding.bindingKind ?? (binding.toolName ? "tool" : undefined);
    if (kind === "event") {
      const eventNames = (binding.requirement.eventNames ?? [])
        .filter((event) => (binding.bindingId ?? "").split(",").map((value) => value.trim()).includes(event));
      return eventNames.length
        ? { ...binding, executionRef: { kind: "event", eventNames } }
        : { ...binding, status: "missing", next: "ask_user", reason: "event binding 没有可执行的精确 event 边界" };
    }
    // Preflight resolves infrastructure readiness before an agent plan exists.
    // Authoring/finish/promotion supply a plan and therefore require the exact
    // executable reference below.
    if (!planSteps) return binding;
    if (kind === "tool") {
      const toolName = binding.toolName ?? binding.bindingId ?? "";
      const planStepIds = planSteps
        .filter((step) => step.kind === "tool" && step.tool === toolName)
        .map((step) => step.stepId);
      return planStepIds.length
        ? { ...binding, executionRef: { kind: "tool", toolName, planStepIds } }
        : {
            ...binding,
            status: "missing",
            next: "ask_user",
            reason: `工具 ${toolName} 虽然能力匹配，但生成的 plan 没有任何步骤实际调用它`,
          };
    }
    if (kind === "runtime") {
      const providerId = binding.bindingId ?? "";
      const planStepIds = planSteps
        .filter((step) => step.kind === "logic")
        .map((step) => step.stepId);
      return providerId && planStepIds.length
        ? { ...binding, executionRef: { kind: "runtime", providerId, planStepIds } }
        : {
            ...binding,
            status: "missing",
            next: "ask_user",
            reason: `运行时能力 ${providerId || "(unknown)"} 虽然匹配，但 plan 没有可执行的 logic 步骤`,
          };
    }
    return {
      ...binding,
      status: "missing",
      next: "ask_user",
      reason: "resolved binding 没有可验证的执行类型",
    };
  });
  const counts: Record<IntegrationBindingStatus, number> = {
    resolved: 0,
    needs_config: 0,
    needs_probe: 0,
    missing: 0,
    human_boundary: 0,
  };
  for (const binding of bindings) counts[binding.status] += 1;
  return {
    // human_boundary deliberately does NOT count toward ready: it unblocks AUTHORING only
    // (via the design gate's identity-gap filter); execution/promotion readiness stays false.
    ready: counts.missing === 0 && counts.needs_config === 0 && counts.needs_probe === 0 && counts.human_boundary === 0,
    bindings,
    counts,
  };
}

// ─── #HUMAN-BOUNDARY — design-admissible human confirmations ────────────────────────────────────

const nfkcLower = (value: string): string => value.normalize("NFKC").trim().toLowerCase();

/** Overlay human-confirmed boundaries onto a binding report's bindings: an IDENTITY-GAP binding
 * (status "missing", no bound tool/binding id, not an ambiguity that needs a human CHOICE) whose
 * (system, role) the human confirmed becomes status:"human_boundary" with an audit trail. Pure —
 * callers decide where the confirmations come from (the conductor's clarify consumption). Every
 * execution-stage gate (sandbox/acceptance/promotion) still treats human_boundary as unresolved. */
export function applyIntegrationHumanBoundaries(
  bindings: IntegrationToolBinding[],
  boundaries: IntegrationHumanBoundary[] | undefined,
): IntegrationToolBinding[] {
  if (!boundaries?.length) return bindings;
  return bindings.map((binding) => {
    const identityGap =
      binding.status === "missing"
      && !binding.bindingId
      && !binding.toolName
      && binding.selectionRequired !== true;
    if (!identityGap) return binding;
    const hit = boundaries.find((boundary) =>
      nfkcLower(boundary.system) === nfkcLower(binding.requirement.system)
      && (boundary.mode === "all" || nfkcLower(boundary.mode) === nfkcLower(binding.requirement.role)));
    if (!hit) return binding;
    return {
      ...binding,
      status: "human_boundary",
      reason: `用户确认为人工边界（${hit.interactionId ?? "clarify"} · ${new Date(hit.confirmedAt).toISOString()}）——设计稿可继续；沙箱/交付/晋升仍按未接通拦截`,
      humanBoundary: {
        ...(hit.interactionId ? { interactionId: hit.interactionId } : {}),
        ...(hit.actor ? { actor: hit.actor } : {}),
        confirmedAt: hit.confirmedAt,
      },
    };
  });
}

/** Server-side consumption of a `[澄清回答]` for a pending integration-boundary ask: the asked
 * (system, mode) pairs come from the GATE's own recorded ask (never from the model); the human's
 * reply confirms them iff it affirms 人工边界 without negating it. Returns the confirmed entries,
 * or null when the reply does not confirm (the pending ask is cleared by the caller either way —
 * a later attempt re-derives and re-asks whatever is still missing). */
export function consumeIntegrationBoundaryAnswer(
  pending: Array<{ system: string; mode: string }>,
  answerText: string,
  meta: { interactionId?: string; actor?: string; confirmedAt: number },
): IntegrationHumanBoundary[] | null {
  if (!pending.length) return null;
  const text = answerText.trim();
  const mentions = /人工边界/.test(text);
  const negated = /[不别勿非][^。；;\n]{0,6}人工边界|人工边界[^。；;\n]{0,6}(不行|不对|不合适|除外)/.test(text);
  if (!mentions || negated) return null;
  return pending.map((pair) => ({
    system: pair.system,
    mode: pair.mode,
    ...(meta.interactionId ? { interactionId: meta.interactionId } : {}),
    ...(meta.actor ? { actor: meta.actor } : {}),
    confirmedAt: meta.confirmedAt,
  }));
}

/** Consume only an exact option token emitted by the server-owned integration
 * choice gate. Labels, prose, tool rationale, and partial identifiers are not
 * binding authority. */
export function consumeIntegrationSelectionAnswer(
  pending: PendingIntegrationSelectionAsk,
  answerValue: string,
  meta: { interactionId?: string; actor?: string; selectedAt: number },
): IntegrationBindingSelection | null {
  const token = answerValue.trim();
  if (!token) return null;
  const selected = pending.options.find((option) => option.token === token);
  if (!selected) return null;
  return {
    ontologyHash: pending.ontologyHash,
    actionName: pending.actionName,
    requirementId: selected.requirementId,
    bindingKind: selected.bindingKind,
    bindingId: selected.bindingId,
    ...(meta.interactionId ? { interactionId: meta.interactionId } : {}),
    ...(meta.actor ? { actor: meta.actor } : {}),
    selectedAt: meta.selectedAt,
  };
}
