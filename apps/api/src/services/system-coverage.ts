/**
 * System coverage — which external systems a domain's ontology references, and
 * whether each one is covered by a confirmed System Profile (外部系统档案).
 *
 * Pure summarizer over (ontology actions × tenant profiles × tool→system map);
 * the route layer supplies all three. A system is "referenced" when EITHER an
 * action declares it in `integration.systems[]` OR the action lists a tool
 * (`tool_use[]`) whose catalog capability declares that system — because in this
 * platform an agent most commonly reaches an external system through a tool, not
 * through an `integration.systems` block. Missing the tool path is what let a
 * pure-tool_use action show "fully covered" falsely.
 *
 * Name matching uses the same NFKC/lowercase/separator-stripping normalization
 * as the integration-binding engine so "RAAS_System" and a profile alias
 * "RAAS System" agree here exactly like they will at design time.
 */

import {
  deriveIntegrationRequirements,
  type IntegrationRequirement,
  type OntologyAction,
} from "@agentic/agent-factory";
import { systemProfileNames, type SystemProfileV1 } from "@agentic/contracts";

/** How a system came to be referenced by the domain. */
export type SystemReferenceVia = "ontology" | "tool";

export interface SystemCoverageRow {
  system: string;
  referencedByActions: string[];
  /** "ontology" = declared in action.integration.systems; "tool" = reached via
   *  a tool_use[] whose catalog capability declares this system. */
  referencedVia: SystemReferenceVia[];
  profileId: string | null;
  humanBoundary: boolean;
  /** satisfied by a platform RUNTIME capability (LLM gateway / internal invoke)
   *  — the FDE builds no external connection for it; counts as covered. */
  runtimeProvided: boolean;
}

export interface SystemCoverageSummary {
  systems: SystemCoverageRow[];
  totals: {
    referenced: number;
    profiled: number;
    humanBoundary: number;
    unprofiled: number;
  };
}

/** A trusted, tenant/domain-scoped draft projection used to resolve an
 * `agentSlugs` selector. The route builds these records from FsAgentDraftStore;
 * callers never get to provide the action/tool/system contents themselves. */
export interface SystemCoverageAgentScope {
  slug: string;
  actionName: string;
  parentAction?: string;
  isSubAgent?: boolean;
  tools: string[];
  integrationRequirements?: IntegrationRequirement[];
  versionId?: string;
}

export interface SystemCoverageScopeRequest {
  actionIds: string[];
  agentSlugs: string[];
  /** A complete client-side assertion of the server-derived dependency set.
   * It NEVER filters coverage. When present it must match every derived row. */
  systems: string[];
}

export interface SystemCoverageScopeEvidence {
  actions: Array<{
    actionId: string | null;
    actionName: string;
    source: "domain" | "action_id" | "agent_draft";
  }>;
  agents: Array<{
    slug: string;
    actionName: string;
    ontologyActionId: string | null;
    versionId: string | null;
    source: "latest_draft";
  }>;
  systems: Array<{
    system: string;
    referencedByActions: string[];
    referencedVia: SystemReferenceVia[];
    assertedByClient: boolean;
  }>;
}

export interface SystemCoverageScopeMetadata {
  mode: "domain" | "selection";
  basis: Array<"domain" | "actionIds" | "agentSlugs">;
  requested: SystemCoverageScopeRequest;
  resolved: {
    actionIds: string[];
    actionNames: string[];
    agentSlugs: string[];
    systems: string[];
  };
  domainActionCount: number;
  selectedActionCount: number;
  systemAssertion: "not_requested" | "verified_complete";
  evidence: SystemCoverageScopeEvidence;
}

export interface ResolvedSystemCoverageScope {
  actions: OntologyAction[];
  scope: Omit<
    SystemCoverageScopeMetadata,
    "resolved" | "systemAssertion" | "evidence"
  > & {
    resolved: Omit<SystemCoverageScopeMetadata["resolved"], "systems">;
    evidence: Omit<SystemCoverageScopeEvidence, "systems">;
  };
}

export class SystemCoverageScopeError extends Error {
  constructor(
    readonly code:
      | "COVERAGE_SCOPE_INVALID"
      | "COVERAGE_SCOPE_ACTION_NOT_FOUND"
      | "COVERAGE_SCOPE_AGENT_NOT_FOUND"
      | "COVERAGE_SCOPE_SYSTEMS_REQUIRE_SELECTION"
      | "COVERAGE_SCOPE_SYSTEM_NOT_FOUND"
      | "COVERAGE_SCOPE_SYSTEMS_INCOMPLETE",
    message: string,
  ) {
    super(message);
    this.name = "SystemCoverageScopeError";
  }
}

/** Shared name normalization — exported so every consumer (coverage, config
 * requirement derivation, binding) agrees on when two names are the same system. */
export const norm = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s_.:/()-]+/g, "");

const unique = (values: readonly string[]): string[] => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean)),
];

/** Accept both repeated query params and comma-separated lists. Invalid
 * structured values fail closed instead of becoming "[object Object]". */
export function parseSystemCoverageScopeList(
  value: unknown,
  field: keyof SystemCoverageScopeRequest,
): string[] {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some((entry) => typeof entry !== "string")) {
    throw new SystemCoverageScopeError(
      "COVERAGE_SCOPE_INVALID",
      `${field} must be a string, a comma-separated string, or repeated query parameters`,
    );
  }
  const parsed = unique(
    (values as string[])
      .flatMap((entry) => entry.split(","))
      .map((entry) => entry.trim()),
  );
  if (parsed.length > 200 || parsed.some((entry) => entry.length > 240)) {
    throw new SystemCoverageScopeError(
      "COVERAGE_SCOPE_INVALID",
      `${field} exceeds the coverage scope limit`,
    );
  }
  return parsed;
}

const integrationRows = (
  action: OntologyAction,
): Array<Record<string, unknown>> => {
  const integration =
    action.integration &&
    typeof action.integration === "object" &&
    !Array.isArray(action.integration)
      ? action.integration
      : {};
  return Array.isArray((integration as Record<string, unknown>).systems)
    ? ((integration as Record<string, unknown>).systems as unknown[]).filter(
        (row): row is Record<string, unknown> =>
          !!row && typeof row === "object" && !Array.isArray(row),
      )
    : [];
};

const draftRequirementRow = (
  requirement: IntegrationRequirement,
): Record<string, unknown> => ({
  name: requirement.system,
  kind: requirement.kind,
  role: requirement.role,
  ...(requirement.capability ? { capability: requirement.capability } : {}),
  ...(Array.isArray(requirement.objectTypes) && requirement.objectTypes.length
    ? { objects: requirement.objectTypes }
    : {}),
});

const validDraftRequirements = (
  requirements: IntegrationRequirement[] | undefined,
): IntegrationRequirement[] =>
  (requirements ?? []).filter(
    (requirement) =>
      !!requirement &&
      typeof requirement.system === "string" &&
      requirement.system.trim().length > 0,
  );

function mergeActionWithAgent(
  action: OntologyAction,
  agent: SystemCoverageAgentScope,
): OntologyAction {
  const integration =
    action.integration &&
    typeof action.integration === "object" &&
    !Array.isArray(action.integration)
      ? action.integration
      : {};
  return {
    ...action,
    tool_use: unique([...(action.tool_use ?? []), ...(agent.tools ?? [])]),
    integration: {
      ...integration,
      systems: [
        ...integrationRows(action),
        ...validDraftRequirements(agent.integrationRequirements).map(
          draftRequirementRow,
        ),
      ],
    },
  };
}

function draftOnlyAction(agent: SystemCoverageAgentScope): OntologyAction {
  const name = agent.actionName.trim() || agent.slug;
  return {
    id: `draft:${agent.slug}`,
    name,
    description: "Server-resolved generated-agent scope",
    actor: ["Agent"],
    trigger: [],
    triggered_event: [],
    target_objects: [],
    tool_use: unique(agent.tools ?? []),
    system_prompt: "",
    user_prompt: "",
    integration: {
      systems: validDraftRequirements(agent.integrationRequirements).map(
        draftRequirementRow,
      ),
    },
  };
}

/** Resolve a safe coverage selection.
 *
 * - actionIds must exactly identify actions in the current authoritative domain.
 * - agentSlugs must identify server-loaded drafts. Ontology-backed agents retain
 *   the authoritative Action dependencies and add any generated tools/systems.
 * - scenario agents that intentionally have no ontology Action are represented
 *   by their trusted persisted spec, allowing the "describe a scenario" path.
 * - systems is never a selector; it is verified later as a complete assertion.
 */
export function resolveSystemCoverageScope(
  domainActions: OntologyAction[],
  request: SystemCoverageScopeRequest,
  agentScopes: SystemCoverageAgentScope[] = [],
): ResolvedSystemCoverageScope {
  const requested: SystemCoverageScopeRequest = {
    actionIds: unique(request.actionIds),
    agentSlugs: unique(request.agentSlugs),
    systems: unique(request.systems),
  };
  const selecting =
    requested.actionIds.length > 0 || requested.agentSlugs.length > 0;
  if (!selecting && requested.systems.length > 0) {
    throw new SystemCoverageScopeError(
      "COVERAGE_SCOPE_SYSTEMS_REQUIRE_SELECTION",
      "systems cannot narrow coverage by itself; provide verified actionIds or agentSlugs",
    );
  }

  const actionById = new Map(
    domainActions.map((action) => [action.id, action]),
  );
  const actionByName = new Map(
    domainActions.map((action) => [action.name, action]),
  );
  const selected = new Map<string, OntologyAction>();
  const actionEvidence = new Map<
    string,
    SystemCoverageScopeEvidence["actions"][number]
  >();
  const agentEvidence: SystemCoverageScopeEvidence["agents"] = [];

  if (!selecting) {
    for (const action of domainActions) {
      selected.set(`ontology:${action.id}`, action);
      actionEvidence.set(`domain:${action.id}`, {
        actionId: action.id,
        actionName: action.name,
        source: "domain",
      });
    }
  } else {
    for (const actionId of requested.actionIds) {
      const action = actionById.get(actionId);
      if (!action) {
        throw new SystemCoverageScopeError(
          "COVERAGE_SCOPE_ACTION_NOT_FOUND",
          `actionIds contains an action outside this domain: ${actionId}`,
        );
      }
      selected.set(`ontology:${action.id}`, action);
      actionEvidence.set(`action:${action.id}`, {
        actionId: action.id,
        actionName: action.name,
        source: "action_id",
      });
    }

    const agentsBySlug = new Map(
      agentScopes.map((agent) => [agent.slug, agent]),
    );
    for (const slug of requested.agentSlugs) {
      const agent = agentsBySlug.get(slug);
      if (!agent) {
        throw new SystemCoverageScopeError(
          "COVERAGE_SCOPE_AGENT_NOT_FOUND",
          `agentSlugs contains an agent outside this tenant/domain draft scope: ${slug}`,
        );
      }
      const ontologyAction =
        agent.isSubAgent === true
          ? undefined
          : (actionByName.get(agent.actionName) ??
            actionById.get(agent.actionName));
      if (ontologyAction) {
        const key = `ontology:${ontologyAction.id}`;
        const base = selected.get(key) ?? ontologyAction;
        selected.set(key, mergeActionWithAgent(base, agent));
        actionEvidence.set(`agent-action:${ontologyAction.id}`, {
          actionId: ontologyAction.id,
          actionName: ontologyAction.name,
          source: "agent_draft",
        });
      } else {
        const synthetic = draftOnlyAction(agent);
        selected.set(`draft:${slug}`, synthetic);
        actionEvidence.set(`agent-draft:${slug}`, {
          actionId: null,
          actionName: synthetic.name,
          source: "agent_draft",
        });
      }
      agentEvidence.push({
        slug,
        actionName: agent.actionName,
        ontologyActionId: ontologyAction?.id ?? null,
        versionId: agent.versionId ?? null,
        source: "latest_draft",
      });
    }
  }

  const actions = [...selected.values()];
  const ontologyActionIds = actions
    .map((action) => action.id)
    .filter((id) => actionById.has(id));
  return {
    actions,
    scope: {
      mode: selecting ? "selection" : "domain",
      basis: selecting
        ? [
            ...(requested.actionIds.length ? (["actionIds"] as const) : []),
            ...(requested.agentSlugs.length ? (["agentSlugs"] as const) : []),
          ]
        : ["domain"],
      requested,
      resolved: {
        actionIds: unique(ontologyActionIds),
        actionNames: unique(actions.map((action) => action.name)),
        agentSlugs: requested.agentSlugs,
      },
      domainActionCount: domainActions.length,
      selectedActionCount: actions.length,
      evidence: {
        actions: [...actionEvidence.values()],
        agents: agentEvidence,
      },
    },
  };
}

export function summarizeSystemCoverage(
  actions: OntologyAction[],
  profiles: SystemProfileV1[],
  /** normalized(toolName | alias) → the systems that tool's capability declares. */
  toolSystems?: Map<string, string[]>,
  /** system names satisfied by platform runtime capabilities (LLM gateway /
   *  internal invoke) — the FDE never builds an external connection for these. */
  runtimeSystems?: readonly string[],
): SystemCoverageSummary {
  const byName = new Map<string, { id: string; humanBoundary: boolean }>();
  for (const profile of profiles) {
    const entry = {
      id: profile.id,
      humanBoundary: profile.governance?.humanBoundary === true,
    };
    for (const name of systemProfileNames(profile))
      byName.set(norm(name), entry);
  }
  const runtimeSet = new Set((runtimeSystems ?? []).map(norm));

  const rows = new Map<string, SystemCoverageRow>();
  const addRef = (
    systemName: string,
    actionName: string,
    via: SystemReferenceVia,
  ): void => {
    const k = norm(systemName);
    if (!k) return;
    const row = rows.get(k) ?? {
      system: systemName,
      referencedByActions: [],
      referencedVia: [],
      profileId: null,
      humanBoundary: false,
      runtimeProvided: runtimeSet.has(k),
    };
    if (!row.referencedByActions.includes(actionName))
      row.referencedByActions.push(actionName);
    if (!row.referencedVia.includes(via)) row.referencedVia.push(via);
    const hit = byName.get(k);
    if (hit) {
      row.profileId = hit.id;
      row.humanBoundary = hit.humanBoundary;
    }
    rows.set(k, row);
  };

  // Pass 1 — ontology-declared systems (the authoritative binding side).
  for (const action of actions) {
    for (const requirement of deriveIntegrationRequirements(action)) {
      addRef(requirement.system, action.name, "ontology");
    }
  }

  // Pass 2 — systems reached only through tool_use[]. Runs after pass 1 so a
  // tool that lists many aliases for one system MERGES onto an already-declared
  // row instead of spawning one row per alias.
  if (toolSystems) {
    for (const action of actions) {
      for (const toolName of action.tool_use ?? []) {
        const declared = toolSystems.get(norm(toolName));
        if (!declared?.length) continue;
        const rep = pickRepresentativeSystem(declared, rows, byName);
        if (rep) addRef(rep, action.name, "tool");
      }
    }
  }

  const systems = [...rows.values()].sort((a, b) =>
    a.system.localeCompare(b.system),
  );
  const profiled = systems.filter((row) => row.profileId !== null);
  // A runtime-provided system needs no profile — exclude it from "unprofiled"
  // so the FDE is not told to build a connection for a platform-runtime system.
  const unprofiled = systems.filter(
    (row) => row.profileId === null && !row.runtimeProvided,
  );
  return {
    systems,
    totals: {
      referenced: systems.length,
      profiled: profiled.length,
      humanBoundary: profiled.filter((row) => row.humanBoundary).length,
      unprofiled: unprofiled.length,
    },
  };
}

/** Attach server-derived dependency evidence and verify an optional client
 * assertion. The assertion must cover EVERY returned system (aliases from a
 * confirmed profile are accepted); it never removes rows from the summary. */
export function finalizeSystemCoverageScope(
  resolved: ResolvedSystemCoverageScope["scope"],
  summary: SystemCoverageSummary,
  profiles: SystemProfileV1[],
): SystemCoverageScopeMetadata {
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const acceptedNames = summary.systems.map((row) => {
    const profile = row.profileId ? profileById.get(row.profileId) : undefined;
    return {
      row,
      names: [row.system, ...(profile ? systemProfileNames(profile) : [])],
    };
  });
  const assertedRows = new Set<SystemCoverageRow>();

  for (const requested of resolved.requested.systems) {
    const requestedKey = norm(requested);
    const match = acceptedNames.find(({ names }) =>
      names.some((name) => norm(name) === requestedKey),
    );
    if (!match) {
      throw new SystemCoverageScopeError(
        "COVERAGE_SCOPE_SYSTEM_NOT_FOUND",
        `systems contains a dependency not derived from the selected actions/agents: ${requested}`,
      );
    }
    assertedRows.add(match.row);
  }

  if (
    resolved.requested.systems.length > 0 &&
    assertedRows.size !== summary.systems.length
  ) {
    const missing = summary.systems
      .filter((row) => !assertedRows.has(row))
      .map((row) => row.system);
    throw new SystemCoverageScopeError(
      "COVERAGE_SCOPE_SYSTEMS_INCOMPLETE",
      `systems must attest the complete derived dependency set; missing: ${missing.join(", ")}`,
    );
  }

  return {
    ...resolved,
    resolved: {
      ...resolved.resolved,
      systems: summary.systems.map((row) => row.system),
    },
    systemAssertion:
      resolved.requested.systems.length > 0
        ? "verified_complete"
        : "not_requested",
    evidence: {
      ...resolved.evidence,
      systems: summary.systems.map((row) => ({
        system: row.system,
        referencedByActions: row.referencedByActions,
        referencedVia: row.referencedVia,
        assertedByClient: assertedRows.has(row),
      })),
    },
  };
}

/** A tool's capability may list many aliases for ONE external system. Pick a
 * single representative so the tool contributes one coverage row, preferring
 * (a) a system already referenced by the ontology, then (b) a profiled system,
 * else the first declared name — so tool_use merges onto existing rows rather
 * than exploding aliases. */
function pickRepresentativeSystem(
  declared: string[],
  rows: Map<string, SystemCoverageRow>,
  byName: Map<string, unknown>,
): string | null {
  const wildcardStripped = declared.filter((s) => s.trim() && s.trim() !== "*");
  if (!wildcardStripped.length) return null;
  const alreadyReferenced = wildcardStripped.find((s) => rows.has(norm(s)));
  if (alreadyReferenced) return alreadyReferenced;
  const profiled = wildcardStripped.find((s) => byName.has(norm(s)));
  if (profiled) return profiled;
  return wildcardStripped[0]!;
}

/** A tool capability may declare a LOCAL pseudo-system ("local filesystem",
 * "cryptography", "runtime"…) that is NOT an external platform an FDE builds a
 * profile for. Coverage must skip these — otherwise a tool_use:["crypto.sha256"]
 * would tell the operator to profile "cryptography". Real external systems
 * (Object_Storage_System, RAAS_System…) are kept; only local/utility names drop. */
function isLocalPseudoSystem(name: string): boolean {
  const k = name
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s_.:/()-]+/g, "");
  return (
    k.startsWith("local") ||
    new Set([
      "runtime",
      "cryptography",
      "crypto",
      "computation",
      "documentprocessing",
      "utility",
    ]).has(k)
  );
}

/** Build the normalized(toolName|alias) → systems map from tool catalog
 * entries. Pure — the route passes catalog entries (global + tenant). Local
 * pseudo-systems are dropped; a tool left with no external system is skipped. */
export function buildToolSystemsMap(
  entries: ReadonlyArray<{
    name: string;
    aliases?: string[];
    capabilities?: ReadonlyArray<{ systems?: string[] }>;
  }>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const entry of entries) {
    const systems = [
      ...new Set(
        (entry.capabilities ?? [])
          .flatMap((c) => c.systems ?? [])
          .filter((s) => s && !isLocalPseudoSystem(s)),
      ),
    ];
    if (!systems.length) continue;
    for (const alias of [entry.name, ...(entry.aliases ?? [])]) {
      const k = alias
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/[\s_.:/()-]+/g, "");
      if (k) map.set(k, systems);
    }
  }
  return map;
}
