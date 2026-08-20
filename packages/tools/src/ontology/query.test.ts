import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOntologyQuery, ontologyQuery } from "./query";

const OPERATIONS = [
  { operation: "search_nodes" as const, args: { query: "南方电缆" } },
  { operation: "get_node" as const, args: { id: "SUP-001" } },
  { operation: "neighbors" as const, args: { id: "SUP-001" } },
  { operation: "find_paths" as const, args: { start_id: "SUP-001", end_id: "SUP-003" } },
  { operation: "schema" as const, args: {} },
];

describe("buildOntologyQuery", () => {
  it("forces the tenant predicate onto every operation", () => {
    for (const { operation, args } of OPERATIONS) {
      const query = buildOntologyQuery({
        operation,
        args,
        tenantSlug: "power-scm",
        tenantProperty: "tenant_slug",
        idProperty: "instanceId",
        returnProperties: ["id", "name"],
      });
      expect(query.statement, operation).toContain("$tenantProperty");
      expect(query.parameters.tenantSlug, operation).toBe("power-scm");
      // Values are parameters, never interpolated into the statement text.
      expect(query.statement, operation).not.toContain("power-scm");
    }
  });

  it("exposes the neighbors filters the compiled tool schema advertises", () => {
    const query = buildOntologyQuery({
      operation: "neighbors",
      args: {
        id: "SUP-001",
        relationship_types: ["CONTROLLED_BY"],
        neighbor_labels: ["UltimateController"],
      },
      tenantSlug: "power-scm",
      tenantProperty: "tenant_slug",
      idProperty: "instanceId",
      returnProperties: ["id", "controller_id"],
    });
    expect(query.parameters.relationshipTypes).toEqual(["CONTROLLED_BY"]);
    expect(query.parameters.neighborLabels).toEqual(["UltimateController"]);
  });
});

describe("ontologyQuery truncation reporting", () => {
  const previousEnv = { ...process.env };
  let rowCount = 0;

  beforeEach(() => {
    process.env.NEO4J_QUERY_API_URL = "http://127.0.0.1:7474";
    process.env.NEO4J_USERNAME = "neo4j";
    process.env.NEO4J_PASSWORD = "test-password";
    process.env.NEO4J_DATABASE = "neo4j";
    process.env.NEO4J_ID_PROPERTY = "instanceId";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const values = Array.from({ length: rowCount }, (_unused, index) => [
          `n-${index}`,
        ]);
        return new Response(JSON.stringify({ data: { fields: ["id"], values } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...previousEnv };
  });

  async function run(limit: number) {
    return (await ontologyQuery.handler({
      tenantSlug: "power-scm",
      agentName: "test-agent",
      correlationId: "cor-test",
      config: {},
      event: { data: { operation: "search_nodes", query: "x", limit } },
    } as never)) as { data: { count: number; truncated: boolean } };
  }

  it("reports truncated when the row cap was reached", async () => {
    // Neo4j applies `LIMIT $limit` server-side, so a capped result is
    // indistinguishable from an exhausted one except by hitting the cap. For a
    // relationship scan the two lead to opposite conclusions ("no related
    // party" vs "unverified"), so the cap must be reported.
    rowCount = 5;
    const result = await run(5);
    expect(result.data.count).toBe(5);
    expect(result.data.truncated).toBe(true);
  });

  it("does not report truncated for a short result", async () => {
    rowCount = 2;
    const result = await run(5);
    expect(result.data.count).toBe(2);
    expect(result.data.truncated).toBe(false);
  });
});
