/**
 * Non-secret integration contract for the Agents-generation Ontology domain.
 *
 * This file is executable metadata for FDE/Factory tooling. It contains only
 * environment-variable NAMES and reviewed capability coordinates—never
 * credentials, endpoints, SQL, or probe results.
 *
 * A populated environment reference is not evidence that an API works. Every
 * profile keeps code generation open with an explicit warning, while runtime
 * and promotion remain blocked until the declared real probe succeeds.
 */

export const AGENTS_GENERATION_DOMAIN_ID = "Agents-generation" as const;
export const AGENTS_GENERATION_TENANT_SLUG = "agents-generation" as const;

export const AGENTS_GENERATION_ACTIONS = [
  "createJD",
  "processResume",
  "ruleCheckForCandidateIdentity",
  "ruleCheckForMatchResume",
  "matchResume",
  "inviteInternalInterview",
] as const;

export type AgentsGenerationAction =
  (typeof AGENTS_GENERATION_ACTIONS)[number];

export interface AgentsGenerationIntegrationProfileContract {
  id: string;
  systemName: string;
  toolNames: readonly string[];
  actions: readonly AgentsGenerationAction[];
  requiredEnv: readonly string[];
  optionalEnv: readonly string[];
  /**
   * Migration candidates only. Tooling may report that one is populated, but
   * must never auto-select/copy it into a new profile. An FDE confirms exactly
   * one reference for each slot, preserving read/write separation.
   */
  legacyEnvAlternatives: readonly {
    preferredEnv: string;
    alternatives: readonly string[];
    migrationNote: string;
  }[];
  probeTool: string | null;
  /**
   * Fields that cannot be inferred from env documentation or Ontology prose
   * and must be confirmed by an operator/profile author.
   */
  requiredHumanFields: readonly string[];
  codeGenerationPolicy: "continue_with_warning";
  runtimePolicy: "require_config_and_verified_probe";
  fdeSummary: string;
}

export const AGENTS_GENERATION_INTEGRATION_PROFILES = {
  raasRead: {
    id: "agents-generation-raas-read",
    systemName: "RAAS_System",
    toolNames: ["facts.query"],
    actions: [
      "createJD",
      "ruleCheckForCandidateIdentity",
      "ruleCheckForMatchResume",
      "inviteInternalInterview",
    ],
    requiredEnv: [
      "RAAS_POSTGRES_URL",
      "AGENTS_GENERATION_RAAS_READ_STATEMENTS",
    ],
    optionalEnv: ["RAAS_POSTGRES_TIMEOUT_MS"],
    legacyEnvAlternatives: [
      {
        preferredEnv: "AGENTS_GENERATION_RAAS_READ_STATEMENTS",
        alternatives: ["AGENTS_GENERATION_RAAS_STATEMENTS"],
        migrationNote:
          "The live deployment may already hold the reviewed 11-entry read catalog under this legacy name. Do not report the catalog absent; ask the FDE to select either the preferred or legacy env reference explicitly.",
      },
    ],
    probeTool: "facts.query",
    requiredHumanFields: ["allowed_operations", "probe_fixture_values"],
    codeGenerationPolicy: "continue_with_warning",
    runtimePolicy: "require_config_and_verified_probe",
    fdeSummary:
      "The generated function may be drafted against the named statement contract while RAAS is unavailable. Runtime remains blocked until the read-only role, operation allow-list, fixture values, and live query probe are verified.",
  },
  raasWrite: {
    id: "agents-generation-raas-write",
    systemName: "RAAS_System",
    toolNames: ["entities.write"],
    actions: [
      "createJD",
      "processResume",
      "ruleCheckForMatchResume",
      "matchResume",
      "inviteInternalInterview",
    ],
    requiredEnv: [
      "RAAS_POSTGRES_URL",
      "AGENTS_GENERATION_RAAS_WRITE_STATEMENTS",
    ],
    optionalEnv: ["RAAS_POSTGRES_TIMEOUT_MS"],
    legacyEnvAlternatives: [
      {
        preferredEnv: "AGENTS_GENERATION_RAAS_WRITE_STATEMENTS",
        alternatives: ["AGENTS_GENERATION_RAAS_WRITES"],
        migrationNote:
          "The live deployment may already hold the reviewed 16-entry write catalog under this legacy name. Never reuse it for reads and never copy its value; a new profile records one operator-confirmed env reference.",
      },
    ],
    probeTool: "entities.write",
    requiredHumanFields: [
      "allowed_operations",
      "operation_values_mapping",
      "idempotency_key_mapping",
      "reviewed_write_probe_lifecycle",
    ],
    codeGenerationPolicy: "continue_with_warning",
    runtimePolicy: "require_config_and_verified_probe",
    fdeSummary:
      "Code generation may preserve typed write ports and idempotency contracts before RAAS is reachable. No write may run or promote until the isolated create/readback/cleanup/absence probe succeeds.",
  },
  gohire: {
    id: "agents-generation-gohire",
    systemName: "GoHire_System",
    toolNames: [
      "gohireHealthApi",
      "generateJdApi",
      "gohireParseResumeApi",
      "gohireMatchResumeApi",
      "gohireInviteCandidateApi",
    ],
    actions: [
      "createJD",
      "processResume",
      "matchResume",
      "inviteInternalInterview",
    ],
    requiredEnv: ["GOHIRE_API_BASE_URL", "GOHIRE_API_KEY"],
    optionalEnv: ["GOHIRE_TIMEOUT_MS"],
    legacyEnvAlternatives: [],
    probeTool: "gohireHealthApi",
    requiredHumanFields: [
      "sandbox_tenant",
      "non_side_effecting_fixture",
      "invitation_human_boundary_or_reversible_test_api",
    ],
    codeGenerationPolicy: "continue_with_warning",
    runtimePolicy: "require_config_and_verified_probe",
    fdeSummary:
      "Typed GoHire calls may be generated while the provider is unavailable. Health/parse/match stay unverified until probed; interview delivery remains a human/attempt-grant boundary unless the vendor supplies a reversible test invitation API.",
  },
  allmetaRead: {
    id: "agents-generation-allmeta-read",
    systemName: "Allmeta_Ontology_System",
    toolNames: [
      "ontology.fetchActionRules",
      "reasoning.evaluateRules",
    ],
    actions: [
      "createJD",
      "processResume",
      "ruleCheckForCandidateIdentity",
      "ruleCheckForMatchResume",
      "matchResume",
      "inviteInternalInterview",
    ],
    requiredEnv: ["ALLMETA_BASE_URL", "ALLMETA_API_KEY"],
    optionalEnv: ["ALLMETA_TIMEOUT_MS"],
    legacyEnvAlternatives: [],
    probeTool: "ontology.fetchActionRules",
    requiredHumanFields: ["action", "domain", "read_fixture"],
    codeGenerationPolicy: "continue_with_warning",
    runtimePolicy: "require_config_and_verified_probe",
    fdeSummary:
      "Ontology-grounded code may be drafted from the captured snapshot when Allmeta is temporarily unreachable, but the final summary must mark rule/graph reads stale and runtime must re-read and probe the exact action before execution.",
  },
  allmetaWrite: {
    id: "agents-generation-allmeta-write",
    systemName: "Allmeta_Ontology_System",
    toolNames: ["ontology.writeInstance"],
    actions: [
      "createJD",
      "processResume",
      "ruleCheckForMatchResume",
      "matchResume",
      "inviteInternalInterview",
    ],
    requiredEnv: ["ALLMETA_BASE_URL", "ALLMETA_API_KEY"],
    optionalEnv: ["ALLMETA_TIMEOUT_MS"],
    legacyEnvAlternatives: [],
    probeTool: "ontology.writeInstance",
    requiredHumanFields: [
      "allowed_tenants",
      "allowed_domains",
      "allowed_actions",
      "allowed_objects",
      "probe_domain",
      "probe_action",
      "probe_object",
      "probe_namespace",
      "probe_primary_key_field",
      "probe_marker_field",
      "probe_namespace_field",
      "probe_idempotency_field",
    ],
    codeGenerationPolicy: "continue_with_warning",
    runtimePolicy: "require_config_and_verified_probe",
    fdeSummary:
      "The write port may be generated, but no Allmeta write is executable until an operator supplies an isolated disposable object and the code-owned create/cleanup/absence lifecycle is verified.",
  },
  objectStore: {
    id: "agents-generation-object-store",
    systemName: "Object_Storage_System",
    toolNames: ["objectStore.getObject", "document.convert"],
    actions: ["processResume"],
    requiredEnv: [
      "AGENTS_GENERATION_OBJECT_STORE_ENDPOINT",
      "AGENTS_GENERATION_OBJECT_STORE_ACCESS_KEY",
      "AGENTS_GENERATION_OBJECT_STORE_SECRET_KEY",
    ],
    optionalEnv: ["AGENTS_GENERATION_OBJECT_STORE_SESSION_TOKEN"],
    legacyEnvAlternatives: [],
    probeTool: "objectStore.getObject",
    requiredHumanFields: [
      "allowed_buckets",
      "probe_bucket",
      "probe_object_key",
      "max_bytes",
    ],
    codeGenerationPolicy: "continue_with_warning",
    runtimePolicy: "require_config_and_verified_probe",
    fdeSummary:
      "The download/convert/parse chain may be generated against its typed port. Runtime stays blocked until a bounded signed fixture can be read from an allowlisted bucket and its digest is verified.",
  },
} as const satisfies Record<
  string,
  AgentsGenerationIntegrationProfileContract
>;

export type AgentsGenerationIntegrationProfileId =
  (typeof AGENTS_GENERATION_INTEGRATION_PROFILES)[keyof typeof AGENTS_GENERATION_INTEGRATION_PROFILES]["id"];

export function agentsGenerationEnvironmentInspectionConfig(
  profileId: AgentsGenerationIntegrationProfileId,
): {
  profile_name: string;
  system_name: string;
  required_env: string[];
  optional_env: string[];
  legacy_env_alternatives: Record<string, string[]>;
  probe_tool: string | null;
} {
  const profile = Object.values(AGENTS_GENERATION_INTEGRATION_PROFILES).find(
    (candidate) => candidate.id === profileId,
  );
  if (!profile) {
    throw new Error(
      `Unknown Agents-generation integration profile '${profileId}'`,
    );
  }
  return {
    profile_name: profile.id,
    system_name: profile.systemName,
    required_env: [...profile.requiredEnv],
    optional_env: [...profile.optionalEnv],
    legacy_env_alternatives: Object.fromEntries(
      profile.legacyEnvAlternatives.map((entry) => [
        entry.preferredEnv,
        [...entry.alternatives],
      ]),
    ),
    probe_tool: profile.probeTool,
  };
}

/**
 * The Ontology currently names Internal_Recruitment_System but does not
 * publish an authoritative API contract. A generic HTTP tool must not pretend
 * to implement that business system.
 */
export const AGENTS_GENERATION_UNRESOLVED_EXTERNAL_SYSTEMS = [
  {
    systemName: "Internal_Recruitment_System",
    action: "processResume",
    capability: "read-lock-facts",
    disposition: "require_api_contract_or_human_boundary",
    fdeSummary:
      "Continue generating the typed lock-facts port, but keep this dependency unresolved and remind the FDE to attach an authoritative API schema/profile or approve a human boundary.",
  },
] as const;
