/**
 * config.inspectEnvironmentReferences — non-secret integration-profile
 * readiness diagnostics.
 *
 * The model supplies no environment names. A reviewed tool profile carries
 * the exact references in ctx.config, and this handler reports presence only:
 * environment values never enter the result, logs, or model context.
 *
 * This is deliberately NOT a connectivity probe and declares no integration
 * capabilities. It helps an FDE distinguish "code can still be generated"
 * from "this dependency is ready to execute" without letting configuration
 * presence satisfy a production-readiness gate.
 */

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_REFERENCES = 64;
const ALLOWED_CONFIG_KEYS = new Set([
  "profile_name",
  "system_name",
  "required_env",
  "optional_env",
  "legacy_env_alternatives",
  "probe_tool",
]);

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "config.inspectEnvironmentReferences: a reviewed config object is required",
    );
  }
  return value as JsonRecord;
}

function requiredText(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 200) {
    throw new Error(
      `config.inspectEnvironmentReferences: config.${field} must be a non-empty string of at most 200 characters`,
    );
  }
  return normalized;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, field);
}

function environmentNames(
  value: unknown,
  field: string,
  options: { required: boolean },
): string[] {
  if (value === undefined && !options.required) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `config.inspectEnvironmentReferences: config.${field} must be an array of environment variable names`,
    );
  }
  if (
    (options.required && value.length === 0) ||
    value.length > MAX_REFERENCES
  ) {
    throw new Error(
      `config.inspectEnvironmentReferences: config.${field} must contain ${options.required ? "1" : "0"}-${MAX_REFERENCES} references`,
    );
  }
  const names = value.map((item) =>
    typeof item === "string" ? item.trim() : "",
  );
  if (names.some((name) => !ENV_NAME.test(name))) {
    throw new Error(
      `config.inspectEnvironmentReferences: config.${field} contains an invalid environment variable name`,
    );
  }
  if (new Set(names).size !== names.length) {
    throw new Error(
      `config.inspectEnvironmentReferences: config.${field} must not contain duplicate references`,
    );
  }
  return names;
}

export interface EnvironmentReferenceInspection {
  profile_name: string;
  system_name: string;
  status:
    | "needs_configuration"
    | "needs_profile_selection"
    | "configured_unverified";
  configured_env: string[];
  missing_env: string[];
  unresolved_missing_env: string[];
  optional_configured_env: string[];
  optional_missing_env: string[];
  legacy_configured_alternatives: Array<{
    required_env: string;
    configured_alternatives: string[];
  }>;
  probe_tool: string | null;
  code_generation_disposition: "continue_with_warning";
  runtime_disposition:
    | "blocked_until_configured_and_probed"
    | "blocked_until_profile_selected_and_probed"
    | "blocked_until_probed";
  warning: string;
}

export function inspectEnvironmentReferences(
  configValue: unknown,
  environment: Record<string, string | undefined> = process.env,
): EnvironmentReferenceInspection {
  const config = record(configValue);
  for (const key of Object.keys(config)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      throw new Error(
        `config.inspectEnvironmentReferences: unknown config.${key}; only reviewed non-secret profile fields are accepted`,
      );
    }
  }

  const profileName = requiredText(config.profile_name, "profile_name");
  const systemName = requiredText(config.system_name, "system_name");
  const required = environmentNames(config.required_env, "required_env", {
    required: true,
  });
  const optional = environmentNames(config.optional_env, "optional_env", {
    required: false,
  });
  const overlap = required.find((name) => optional.includes(name));
  if (overlap) {
    throw new Error(
      `config.inspectEnvironmentReferences: ${overlap} cannot be both required and optional`,
    );
  }
  const probeTool = optionalText(config.probe_tool, "probe_tool");
  const legacyAlternativesRaw =
    config.legacy_env_alternatives === undefined
      ? {}
      : record(config.legacy_env_alternatives);
  const legacyAlternatives = Object.entries(legacyAlternativesRaw).map(
    ([requiredName, alternatives]) => {
      if (!required.includes(requiredName)) {
        throw new Error(
          `config.inspectEnvironmentReferences: legacy alternative key ${requiredName} is not present in config.required_env`,
        );
      }
      return {
        required_env: requiredName,
        alternatives: environmentNames(
          alternatives,
          `legacy_env_alternatives.${requiredName}`,
          { required: true },
        ),
      };
    },
  );
  const allAlternativeNames = legacyAlternatives.flatMap(
    (entry) => entry.alternatives,
  );
  if (new Set(allAlternativeNames).size !== allAlternativeNames.length) {
    throw new Error(
      "config.inspectEnvironmentReferences: legacy alternatives must be unique across required references",
    );
  }
  if (
    allAlternativeNames.some(
      (name) => required.includes(name) || optional.includes(name),
    )
  ) {
    throw new Error(
      "config.inspectEnvironmentReferences: a legacy alternative cannot also be a required or optional reference",
    );
  }

  const isConfigured = (name: string): boolean =>
    typeof environment[name] === "string" &&
    environment[name]!.trim().length > 0;
  const configuredEnv = required.filter(isConfigured);
  const missingEnv = required.filter((name) => !isConfigured(name));
  const optionalConfiguredEnv = optional.filter(isConfigured);
  const optionalMissingEnv = optional.filter((name) => !isConfigured(name));
  const legacyConfiguredAlternatives = legacyAlternatives
    .map((entry) => ({
      required_env: entry.required_env,
      configured_alternatives: entry.alternatives.filter(isConfigured),
    }))
    .filter((entry) => entry.configured_alternatives.length > 0);
  const unresolvedMissingEnv = missingEnv.filter(
    (name) =>
      !legacyConfiguredAlternatives.some(
        (entry) => entry.required_env === name,
      ),
  );
  const everyMissingHasLegacyCandidate =
    missingEnv.length > 0 && unresolvedMissingEnv.length === 0;
  const legacySelectionWarning =
    legacyConfiguredAlternatives.length > 0
      ? ` Configured legacy alternatives were found for ${legacyConfiguredAlternatives
          .map((entry) => entry.required_env)
          .join(", ")}; those catalog slots are migration candidates, not absent. An FDE must explicitly select exactly one reviewed reference per slot without copying values or mixing read/write catalogs.`
      : "";
  const status =
    missingEnv.length === 0
      ? "configured_unverified"
      : everyMissingHasLegacyCandidate
        ? "needs_profile_selection"
        : "needs_configuration";

  return {
    profile_name: profileName,
    system_name: systemName,
    status,
    configured_env: configuredEnv,
    missing_env: missingEnv,
    unresolved_missing_env: unresolvedMissingEnv,
    optional_configured_env: optionalConfiguredEnv,
    optional_missing_env: optionalMissingEnv,
    legacy_configured_alternatives: legacyConfiguredAlternatives,
    probe_tool: probeTool ?? null,
    code_generation_disposition: "continue_with_warning",
    runtime_disposition:
      status === "needs_configuration"
        ? "blocked_until_configured_and_probed"
        : status === "needs_profile_selection"
          ? "blocked_until_profile_selected_and_probed"
          : "blocked_until_probed",
    warning:
      status === "needs_configuration"
        ? `Code generation may continue, but ${systemName} is missing ${unresolvedMissingEnv.join(", ")}. Runtime execution must remain blocked until configuration and a real probe succeed.${legacySelectionWarning}`
        : status === "needs_profile_selection"
          ? `Code generation may continue. ${systemName} has configured legacy environment alternatives for ${missingEnv.join(", ")}, so the catalog must not be reported absent; an FDE must explicitly select exactly one reviewed reference per slot without copying values or mixing read/write catalogs, then run a real probe.`
        : `All required environment references for ${systemName} are present, but presence is not connectivity proof. Code generation may continue; runtime execution must remain blocked until a real probe succeeds.`,
  };
}

export const inspectEnvironmentReferencesTool = defineTool({
  name: "config.inspectEnvironmentReferences",
  description:
    "Report whether the environment references declared by a reviewed integration profile are populated, without returning any values. " +
    "This is configuration diagnostics only—not a network probe—and always tells generated code to preserve an FDE warning until a real probe succeeds.",
  factory: {
    category: "config",
    sideEffect: "read",
    operation: "compute",
    effectScope: "none",
    sandboxPolicy: "pure",
    configSchema: {
      profile_name: {
        type: "string",
        required: true,
        description: "Stable non-secret integration-profile label.",
      },
      system_name: {
        type: "string",
        required: true,
        description: "Exact Ontology integration system represented by the profile.",
      },
      required_env: {
        type: "string[]",
        required: true,
        description:
          "Reviewed environment-variable names required by the profile. Values are never returned.",
      },
      optional_env: {
        type: "string[]",
        description:
          "Reviewed optional environment-variable names. Values are never returned.",
      },
      legacy_env_alternatives: {
        type: "Record<string,string[]>",
        description:
          "Migration-only mapping from a preferred required env name to explicitly allowed legacy names. Presence is reported but never auto-selected or copied.",
      },
      probe_tool: {
        type: "string",
        description:
          "Real probe tool the FDE should run after configuration; informational only.",
      },
    },
    argsSchema: {},
    returnsSchema: {
      profile_name: { type: "string", required: true },
      system_name: { type: "string", required: true },
      status: {
        type:
          "'needs_configuration'|'needs_profile_selection'|'configured_unverified'",
        required: true,
      },
      configured_env: { type: "string[]", required: true },
      missing_env: { type: "string[]", required: true },
      unresolved_missing_env: { type: "string[]", required: true },
      optional_configured_env: { type: "string[]", required: true },
      optional_missing_env: { type: "string[]", required: true },
      legacy_configured_alternatives: {
        type:
          "Array<{required_env:string,configured_alternatives:string[]}>",
        required: true,
      },
      probe_tool: { type: "string|null", required: true },
      code_generation_disposition: {
        type: "'continue_with_warning'",
        required: true,
      },
      runtime_disposition: {
        type:
          "'blocked_until_configured_and_probed'|'blocked_until_profile_selected_and_probed'|'blocked_until_probed'",
        required: true,
      },
      warning: { type: "string", required: true },
    },
    source: {
      modulePath:
        "packages/tools/src/config/inspect-environment-references.ts",
      exportName: "inspectEnvironmentReferencesTool",
    },
  },
  output: z.object({
    profile_name: z.string(),
    system_name: z.string(),
    status: z.enum([
      "needs_configuration",
      "needs_profile_selection",
      "configured_unverified",
    ]),
    configured_env: z.array(z.string()),
    missing_env: z.array(z.string()),
    unresolved_missing_env: z.array(z.string()),
    optional_configured_env: z.array(z.string()),
    optional_missing_env: z.array(z.string()),
    legacy_configured_alternatives: z.array(
      z.object({
        required_env: z.string(),
        configured_alternatives: z.array(z.string()),
      }),
    ),
    probe_tool: z.string().nullable(),
    code_generation_disposition: z.literal("continue_with_warning"),
    runtime_disposition: z.enum([
      "blocked_until_configured_and_probed",
      "blocked_until_profile_selected_and_probed",
      "blocked_until_probed",
    ]),
    warning: z.string(),
  }),
  async handler(ctx) {
    return {
      data: inspectEnvironmentReferences(ctx.config),
      meta: {
        secretValuesExposed: false,
        connectivityVerified: false,
      },
    };
  },
});
