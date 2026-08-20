import { defineTool, type ToolContext } from "@agentic/agent-kit";
import { z } from "zod";

export type OntologyOperation =
  | "search_nodes"
  | "get_node"
  | "neighbors"
  | "find_paths"
  | "schema";

interface OntologyConfig {
  base_url?: string;
  database?: string;
  username_env?: string;
  password_env?: string;
  tenant_property?: string;
  id_property?: string;
  timeout_ms?: number;
  max_execution_time_ms?: number;
  search_properties?: string[];
}

const DEFAULT_SAFE_PROPERTIES = [
  "id",
  "slug",
  "name",
  "title",
  "description",
  "summary",
  "content",
  "type",
  "status",
  "category",
  "score",
  "confidence",
  "created_at",
  "updated_at",
] as const;
const SENSITIVE_KEY =
  /(?:password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key)/i;

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function safePropertyNames(values: readonly string[]): string[] {
  return Array.from(
    new Set(
      values.filter(
        (value) =>
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !SENSITIVE_KEY.test(value),
      ),
    ),
  ).slice(0, 50);
}

/**
 * Returned properties are a server-owned policy, not an agent-authored
 * expansion point. Tool arguments/config may only narrow this allow-list.
 */
function serverPropertyAllowlist(): string[] {
  const configured = safePropertyNames(
    csv(process.env.NEO4J_ALLOWED_PROPERTIES),
  );
  return configured.length > 0 ? configured : [...DEFAULT_SAFE_PROPERTIES];
}

function narrowedProperties(
  requested: readonly string[] | undefined,
  allowed: readonly string[],
): string[] {
  const allow = new Set(allowed);
  const narrowed = safePropertyNames(requested ?? []).filter((property) =>
    allow.has(property),
  );
  return narrowed.length > 0 ? narrowed : [...allowed];
}

function propertyProjection(
  variable: string,
  properties: readonly string[],
): string {
  return `${variable} { ${properties.map((property) => `.${property}`).join(", ")} }`;
}

interface GeneratedOntologyQuery {
  statement: string;
  parameters: Record<string, unknown>;
  limit: number;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;
}

function strings(value: unknown, max = 50): string[] {
  return Array.isArray(value)
    ? value
        .filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
        .map((item) => item.trim())
        .slice(0, max)
    : [];
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = typeof args[key] === "string" ? args[key].trim() : "";
  if (!value) throw new Error(`ontology.query: \`${key}\` is required`);
  if (value.length > 2_000)
    throw new Error(`ontology.query: \`${key}\` is too long`);
  return value;
}

function config(ctx: ToolContext): OntologyConfig {
  return (ctx.config ?? {}) as OntologyConfig;
}

/**
 * Generate one of a small set of parameterized, read-only Cypher statements.
 * There is deliberately no arbitrary `cypher` argument: the LLM controls
 * values only, while this SDK owns query structure and tenant predicates.
 */
export function buildOntologyQuery(input: {
  operation: OntologyOperation;
  args: Record<string, unknown>;
  tenantSlug: string;
  tenantProperty?: string;
  idProperty?: string;
  searchProperties?: string[];
  returnProperties?: string[];
}): GeneratedOntologyQuery {
  const { operation, args, tenantSlug } = input;
  const limit = boundedInteger(args.limit, 20, 1, 100);
  const allowedProperties = safePropertyNames(
    input.returnProperties?.length
      ? input.returnProperties
      : DEFAULT_SAFE_PROPERTIES,
  );
  const returnProperties =
    allowedProperties.length > 0
      ? allowedProperties
      : [...DEFAULT_SAFE_PROPERTIES];
  const requestedSearchProperties = strings(args.properties);
  const configuredSearchProperties = narrowedProperties(
    input.searchProperties,
    returnProperties,
  );
  const searchProperties = narrowedProperties(
    requestedSearchProperties.length > 0
      ? requestedSearchProperties
      : configuredSearchProperties,
    returnProperties,
  );
  const common = {
    tenantSlug,
    tenantProperty: input.tenantProperty?.trim() || "tenant_slug",
    idProperty: input.idProperty?.trim() || "id",
    returnProperties,
    limit,
  };
  if (operation === "search_nodes") {
    return {
      statement: [
        "MATCH (n)",
        "WHERE n[$tenantProperty] = $tenantSlug",
        "  AND (size($labels) = 0 OR any(label IN labels(n) WHERE label IN $labels))",
        "  AND any(property IN $properties WHERE toLower(toString(n[property])) CONTAINS toLower($query))",
        `RETURN elementId(n) AS element_id, labels(n) AS labels, ${propertyProjection("n", returnProperties)} AS properties`,
        "LIMIT $limit",
      ].join("\n"),
      parameters: {
        ...common,
        query: requiredString(args, "query"),
        labels: strings(args.labels),
        properties: searchProperties,
      },
      limit,
    };
  }
  if (operation === "get_node") {
    return {
      statement: [
        "MATCH (n)",
        "WHERE n[$tenantProperty] = $tenantSlug",
        "  AND (elementId(n) = $id OR toString(n[$idProperty]) = $id)",
        `RETURN elementId(n) AS element_id, labels(n) AS labels, ${propertyProjection("n", returnProperties)} AS properties`,
        "LIMIT 1",
      ].join("\n"),
      parameters: { ...common, id: requiredString(args, "id") },
      limit: 1,
    };
  }
  if (operation === "neighbors") {
    return {
      statement: [
        "MATCH (n)-[r]-(neighbor)",
        "WHERE n[$tenantProperty] = $tenantSlug",
        "  AND neighbor[$tenantProperty] = $tenantSlug",
        "  AND (elementId(n) = $id OR toString(n[$idProperty]) = $id)",
        "  AND (size($relationshipTypes) = 0 OR type(r) IN $relationshipTypes)",
        "  AND (size($neighborLabels) = 0 OR any(label IN labels(neighbor) WHERE label IN $neighborLabels))",
        `RETURN elementId(n) AS source_id, type(r) AS relationship_type, ${propertyProjection("r", returnProperties)} AS relationship,`,
        `       elementId(neighbor) AS neighbor_id, labels(neighbor) AS neighbor_labels, ${propertyProjection("neighbor", returnProperties)} AS neighbor`,
        "LIMIT $limit",
      ].join("\n"),
      parameters: {
        ...common,
        id: requiredString(args, "id"),
        relationshipTypes: strings(args.relationship_types),
        neighborLabels: strings(args.neighbor_labels),
      },
      limit,
    };
  }
  if (operation === "find_paths") {
    const depth = boundedInteger(args.max_depth, 3, 1, 4);
    return {
      statement: [
        `MATCH p = (start)-[*1..${depth}]-(end)`,
        "WHERE start[$tenantProperty] = $tenantSlug",
        "  AND end[$tenantProperty] = $tenantSlug",
        "  AND (elementId(start) = $startId OR toString(start[$idProperty]) = $startId)",
        "  AND (elementId(end) = $endId OR toString(end[$idProperty]) = $endId)",
        "  AND all(node IN nodes(p) WHERE node[$tenantProperty] = $tenantSlug)",
        `RETURN [node IN nodes(p) | {element_id: elementId(node), labels: labels(node), properties: ${propertyProjection("node", returnProperties)}}] AS nodes,`,
        `       [rel IN relationships(p) | {type: type(rel), properties: ${propertyProjection("rel", returnProperties)}}] AS relationships,`,
        "       length(p) AS length",
        "ORDER BY length ASC",
        "LIMIT $limit",
      ].join("\n"),
      parameters: {
        ...common,
        startId: requiredString(args, "start_id"),
        endId: requiredString(args, "end_id"),
      },
      limit,
    };
  }
  return {
    statement: [
      "CALL {",
      "  MATCH (n)",
      "  WHERE n[$tenantProperty] = $tenantSlug",
      "  UNWIND labels(n) AS label",
      "  RETURN collect(DISTINCT label) AS labels, collect(DISTINCT [key IN keys(n) WHERE key IN $returnProperties | key]) AS nested_property_keys",
      "}",
      "CALL {",
      "  MATCH (source)-[r]->(target)",
      "  WHERE source[$tenantProperty] = $tenantSlug",
      "    AND target[$tenantProperty] = $tenantSlug",
      "  RETURN collect(DISTINCT type(r)) AS relationship_types",
      "}",
      "RETURN labels, relationship_types,",
      "       reduce(all_keys = [], item IN nested_property_keys | all_keys + item) AS property_keys",
      "LIMIT 1",
    ].join("\n"),
    parameters: common,
    limit: 1,
  };
}

function normalizeEndpoint(raw: string, database?: string): URL {
  const base = new URL(raw);
  if (
    base.protocol !== "https:" &&
    base.hostname !== "localhost" &&
    base.hostname !== "127.0.0.1"
  ) {
    throw new Error("ontology.query: Neo4j Query API endpoint must use HTTPS");
  }
  if (!/\/db\/[^/]+\/query\/v2\/?$/.test(base.pathname)) {
    const encodedDatabase = encodeURIComponent(database?.trim() || "neo4j");
    base.pathname = `${base.pathname.replace(/\/$/, "")}/db/${encodedDatabase}/query/v2`;
  }
  base.hash = "";
  return base;
}

function tenantEnvPrefix(tenantSlug: string): string {
  return tenantSlug.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function isTenantCredentialEnv(envName: string, tenantSlug: string): boolean {
  const prefix = tenantEnvPrefix(tenantSlug);
  return (
    envName.startsWith(`TENANT_${prefix}_`) || envName.startsWith(`${prefix}_`)
  );
}

function endpoint(cfg: OntologyConfig, tenantSlug: string): URL {
  const configuredRaw = cfg.base_url?.trim();
  const serverRaw = process.env.NEO4J_QUERY_API_URL?.trim();
  const raw = configuredRaw || serverRaw;
  if (!raw) {
    throw new Error(
      "ontology.query: configure NEO4J_QUERY_API_URL or tool_use[].config.base_url",
    );
  }
  const database =
    cfg.database?.trim() || process.env.NEO4J_DATABASE?.trim() || "neo4j";
  const resolved = normalizeEndpoint(raw, database);
  if (configuredRaw) {
    const pinned = serverRaw
      ? normalizeEndpoint(
          serverRaw,
          process.env.NEO4J_DATABASE?.trim() || "neo4j",
        )
      : null;
    const allowedHosts = new Set(
      csv(process.env.NEO4J_QUERY_API_ALLOWED_HOSTS),
    );
    if (resolved.href !== pinned?.href && !allowedHosts.has(resolved.host)) {
      throw new Error(
        "ontology.query: configured endpoint is not the server-pinned Neo4j URL or in NEO4J_QUERY_API_ALLOWED_HOSTS",
      );
    }
    const usernameEnv = cfg.username_env?.trim();
    const passwordEnv = cfg.password_env?.trim();
    if (
      !usernameEnv ||
      !passwordEnv ||
      !isTenantCredentialEnv(usernameEnv, tenantSlug) ||
      !isTenantCredentialEnv(passwordEnv, tenantSlug)
    ) {
      throw new Error(
        "ontology.query: a configured endpoint requires explicit tenant-scoped username_env and password_env bindings",
      );
    }
  }
  return resolved;
}

function credentials(cfg: OntologyConfig): string {
  const usernameEnv = cfg.username_env?.trim() || "NEO4J_USERNAME";
  const passwordEnv = cfg.password_env?.trim() || "NEO4J_PASSWORD";
  const username = process.env[usernameEnv]?.trim();
  const password = process.env[passwordEnv];
  if (!username || !password) {
    throw new Error(
      `ontology.query: credentials missing; configure ${usernameEnv} and ${passwordEnv}`,
    );
  }
  return Buffer.from(`${username}:${password}`).toString("base64");
}

async function boundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(
      `ontology.query: Neo4j response exceeds ${maxBytes} byte limit`,
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(
        `ontology.query: Neo4j response exceeds ${maxBytes} byte limit`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  ).toString("utf8");
}

function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[TRUNCATED]";
  if (Array.isArray(value))
    return value.map((item) => redactSensitive(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitive(item, depth + 1),
    ]),
  );
}

function responseRows(body: unknown): {
  fields: string[];
  values: unknown[][];
} {
  if (!body || typeof body !== "object") return { fields: [], values: [] };
  const data = (body as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { fields: [], values: [] };
  const record = data as Record<string, unknown>;
  return {
    fields: Array.isArray(record.fields)
      ? record.fields.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    values: Array.isArray(record.values)
      ? record.values.filter((value): value is unknown[] =>
          Array.isArray(value),
        )
      : [],
  };
}

export const ontologyQuery = defineTool({
  name: "ontology.query",
  description:
    "Tenant-scoped, read-only Neo4j ontology retrieval. Choose search_nodes, get_node, neighbors, find_paths, or schema. The SDK generates parameterized Cypher and forces the tenant predicate onto every matched node; arbitrary Cypher and writes are not accepted.",
  output: z.object({
    operation: z.enum([
      "search_nodes",
      "get_node",
      "neighbors",
      "find_paths",
      "schema",
    ]),
    fields: z.array(z.string()),
    records: z.array(z.record(z.string(), z.unknown())),
    count: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  async handler(ctx) {
    const args = (ctx.event?.data ?? {}) as Record<string, unknown>;
    const operation = args.operation;
    if (
      ![
        "search_nodes",
        "get_node",
        "neighbors",
        "find_paths",
        "schema",
      ].includes(String(operation))
    ) {
      throw new Error(
        "ontology.query: operation must be search_nodes, get_node, neighbors, find_paths, or schema",
      );
    }
    const cfg = config(ctx);
    const tenantProperty =
      process.env.NEO4J_TENANT_PROPERTY?.trim() || "tenant_slug";
    if (
      cfg.tenant_property?.trim() &&
      cfg.tenant_property.trim() !== tenantProperty
    ) {
      throw new Error(
        "ontology.query: tenant_property is server-owned and cannot be overridden by an agent",
      );
    }
    const idProperty = process.env.NEO4J_ID_PROPERTY?.trim() || "id";
    if (cfg.id_property?.trim() && cfg.id_property.trim() !== idProperty) {
      throw new Error(
        "ontology.query: id_property is server-owned and cannot be overridden by an agent",
      );
    }
    const serverDatabase = process.env.NEO4J_DATABASE?.trim() || "neo4j";
    const allowedDatabases = new Set([
      serverDatabase,
      ...csv(process.env.NEO4J_ALLOWED_DATABASES),
    ]);
    if (cfg.database?.trim() && !allowedDatabases.has(cfg.database.trim())) {
      throw new Error(
        "ontology.query: database is not present in the server-owned Neo4j database allow-list",
      );
    }
    const returnProperties = serverPropertyAllowlist();
    const query = buildOntologyQuery({
      operation: operation as OntologyOperation,
      args,
      tenantSlug: ctx.tenantSlug,
      tenantProperty,
      idProperty,
      searchProperties: cfg.search_properties,
      returnProperties,
    });
    const maxExecutionTimeMs = boundedInteger(
      cfg.max_execution_time_ms,
      15_000,
      100,
      60_000,
    );
    const maxExecutionTime = Math.max(1, Math.ceil(maxExecutionTimeMs / 1_000));
    const timeoutMs = boundedInteger(cfg.timeout_ms, 20_000, 1_000, 120_000);
    const maxResponseBytes = boundedInteger(
      Number(process.env.NEO4J_MAX_RESPONSE_BYTES),
      512 * 1_024,
      16 * 1_024,
      2 * 1_024 * 1_024,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint(cfg, ctx.tenantSlug), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials(cfg)}`,
        },
        body: JSON.stringify({
          statement: query.statement,
          parameters: query.parameters,
          accessMode: "Read",
          maxExecutionTime,
          txMetadata: {
            tenant: ctx.tenantSlug,
            agent: ctx.agentName,
            correlation_id: ctx.correlationId,
            tool: "ontology.query",
          },
        }),
        signal: controller.signal,
      });
      const responseText = await boundedResponseText(
        response,
        maxResponseBytes,
      );
      let body: unknown = responseText;
      try {
        body = responseText ? JSON.parse(responseText) : {};
      } catch {
        // Preserve text for the bounded error below.
      }
      if (!response.ok) {
        throw new Error(
          `ontology.query: Neo4j Query API returned ${response.status}: ${responseText.slice(0, 500)}`,
        );
      }
      const rows = responseRows(body);
      const records = rows.values
        .slice(0, query.limit)
        .map((values) =>
          Object.fromEntries(
            rows.fields.map((field, index) => [
              field,
              redactSensitive(values[index]),
            ]),
          ),
        );
      return {
        data: {
          operation: operation as OntologyOperation,
          fields: rows.fields,
          records,
          count: records.length,
          // Every generated statement ends in `LIMIT $limit`, so the server has
          // already applied the cap and the slice above never drops a row —
          // comparing the two would report `false` even when rows were cut.
          // Hitting the limit exactly is the only signal available that more
          // rows may exist, and the model needs it: on a relationship scan,
          // "no more results" and "capped" lead to opposite conclusions.
          truncated: records.length >= query.limit,
        },
        meta: {
          tool: "ontology.query",
          readOnly: true,
          tenantScoped: true,
          status: response.status,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  },
});
