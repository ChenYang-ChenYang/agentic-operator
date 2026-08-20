/**
 * Read-only fact transport for ontology-driven agents.
 *
 * This adapter deliberately knows nothing about candidate identity tiers,
 * recruiter ownership, match thresholds, rule enforcement or workflow
 * events.  A reviewed integration profile selects a bounded set of named
 * statements from a server-owned catalog; the caller supplies only the
 * operation name and parameter values.  The returned rows are evidence for
 * ontology.fetchActionRules + reasoning/decision-table steps, never a
 * business verdict.
 */

import { defineTool, type ToolContext } from "@agentic/agent-kit";
import {
  executePostgresStatement,
  type PostgresExecuteOptions,
} from "@agentic/tools/postgres";
import { z } from "zod";

type JsonRecord = Record<string, unknown>;

const OPERATION_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const ALLOWED_CONFIG_KEYS = new Set([
  "tenant_slug",
  "system_name",
  "connection_url_env",
  "statement_catalog_env",
  "allowed_operations",
  "max_rows",
  "max_values_bytes",
  "timeout_ms",
]);

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`facts.query: ${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (
    actual.length !== allowed.length ||
    actual.some((key, index) => key !== allowed[index])
  ) {
    throw new Error(
      `facts.query: ${label} must contain exactly ${expected.join(", ")}`,
    );
  }
}

function reviewedConfig(value: unknown): JsonRecord {
  const config = record(value, "config");
  for (const key of Object.keys(config)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      throw new Error(
        `facts.query: unknown or unsafe config '${key}' is rejected; use only reviewed environment references`,
      );
    }
  }
  const allowedOperations = config.allowed_operations;
  if (
    !Array.isArray(allowedOperations) ||
    allowedOperations.length === 0 ||
    !allowedOperations.every(
      (operation) =>
        typeof operation === "string" && OPERATION_RE.test(operation),
    ) ||
    new Set(allowedOperations).size !== allowedOperations.length
  ) {
    throw new Error(
      "facts.query: config.allowed_operations must be a non-empty unique list of safe server-catalog operation names",
    );
  }
  return config;
}

export async function executeFactsQuery(
  argsValue: unknown,
  configValue: unknown,
  options: PostgresExecuteOptions = {},
) {
  const args = record(argsValue, "input");
  exactKeys(args, ["operation", "values"], "input");
  record(args.values, "input.values");
  const config = reviewedConfig(configValue);

  // Pass a closed config projection to the generic transport. In particular,
  // `allow_write` can never cross this adapter, even if an Action description
  // or generated function tries to request it.
  const result = await executePostgresStatement(
    args,
    {
      connection_url_env: config.connection_url_env,
      statement_catalog_env: config.statement_catalog_env,
      allowed_operations: config.allowed_operations,
      allow_write: false,
      ...(config.max_rows === undefined ? {} : { max_rows: config.max_rows }),
      ...(config.max_values_bytes === undefined
        ? {}
        : { max_values_bytes: config.max_values_bytes }),
      ...(config.timeout_ms === undefined
        ? {}
        : { timeout_ms: config.timeout_ms }),
    },
    options,
  );
  if (result.mode !== "read") {
    // executePostgresStatement rejects this before execution because
    // allow_write=false. Keep the postcondition as a second fail-closed guard
    // in case the lower-level implementation changes.
    throw new Error(
      `facts.query: server catalog operation '${result.operation}' is not read-only`,
    );
  }
  return {
    operation: result.operation,
    row_count: result.row_count,
    rows: result.rows,
    source: "postgres-statement-catalog" as const,
  };
}

export const queryFacts = defineTool({
  name: "facts.query",
  description:
    "Read raw recruitment facts through a reviewed, server-owned PostgreSQL statement catalog. " +
    "Returns rows only; it never chooses identity precedence, ownership conflicts, thresholds, block/warn policy, verdicts or events.",
  factory: {
    category: "fact-catalog",
    sideEffect: "read",
    operation: "read",
    effectScope: "external",
    sandboxPolicy: "live_external",
    argsSchema: {
      operation: {
        type: "string",
        required: true,
        description:
          "Exact named read operation allowed by the reviewed integration profile.",
      },
      values: {
        type: "Record<string, JSON value>",
        required: true,
        description:
          "Exact parameter map required by the server-owned statement catalog entry.",
      },
    },
    returnsSchema: {
      operation: { type: "string", required: true },
      row_count: { type: "integer", required: true },
      rows: {
        type: "unknown[]",
        required: true,
        description:
          "Bounded raw fact rows. No candidate/verdict/route fields are synthesized.",
      },
      source: { type: "string", required: true },
    },
    configSchema: {
      tenant_slug: { type: "string", required: true },
      system_name: {
        type: "string",
        required: true,
        description:
          "Exact Ontology integration.systems[].name represented by this profile.",
      },
      connection_url_env: {
        type: "string",
        required: true,
        description: "Server env reference containing the profile-bound PostgreSQL URL.",
      },
      statement_catalog_env: {
        type: "string",
        required: true,
        description:
          "Server env reference containing the reviewed named-statement catalog.",
      },
      allowed_operations: {
        type: "string[]",
        required: true,
        description:
          "Non-empty action/profile-specific subset of read operations; prose cannot expand it.",
      },
      max_rows: { type: "integer", default: 1000 },
      max_values_bytes: { type: "integer", default: 1048576 },
      timeout_ms: { type: "integer", default: 30000 },
    },
    capabilities: [
      {
        // Explicit wildcard means this server-owned statement-catalog adapter
        // may represent any named database system. Kind/role/profile/probe and
        // operation allow-list checks remain mandatory.
        systems: ["*"],
        systemConfigKey: "system_name",
        kinds: ["database", "datastore", "relational_database"],
        roles: ["read", "reads", "lookup", "query", "load"],
        operations: [
          "facts.query",
          // Exact capability coordinates currently authored in the
          // Agents-generation Ontology. These are transport operations only;
          // the reviewed statement catalog still owns SQL and meaning.
          "requirement.load",
          "candidate.pool_query",
          "rule_context.load",
          "material.backfill",
          "candidate.identity_facts.query",
          "requirement.facts.query",
          "rule_context.facts.query",
          "query",
          "select",
          "read",
        ],
        objectTypes: ["*"],
        probeRequired: true,
      },
    ],
    profileScope: {
      exact: [{ configKey: "tenant_slug", source: "tenantSlug" }],
    },
    source: {
      modulePath: "packages/recruitment-capabilities/src/tools/raas-facts.ts",
      exportName: "queryFacts",
    },
  },
  output: z.object({
    operation: z.string(),
    row_count: z.number().int().nonnegative(),
    rows: z.array(z.unknown()),
    source: z.literal("postgres-statement-catalog"),
  }),
  async handler(ctx: ToolContext) {
    return {
      data: await executeFactsQuery(ctx.event?.data, ctx.config),
      meta: {
        decision_free: true,
        statement_source: "server-environment-catalog",
      },
    };
  },
});

/** Backward-compatible code exports only. The descriptor identity remains the
 * domain-neutral `facts.query`; old names are not registered as tools. */
export const executeRaasFactsQuery = executeFactsQuery;
export const queryRaasFacts = queryFacts;
