import { describe, expect, it } from "vitest";
import {
  getGlobalToolCatalogEntry,
  globalToolExecutionPolicy,
  globalToolRegistry,
  isToolExecutionPolicy,
  listGlobalTools,
} from "./registry";

describe("generic data-plane registry", () => {
  it("declares a valid reviewed execution policy for every global tool", () => {
    expect(
      listGlobalTools().filter((tool) => !isToolExecutionPolicy({
        operation: tool.operation,
        effectScope: tool.effectScope,
        sandboxPolicy: tool.sandboxPolicy,
      })),
    ).toEqual([]);
  });

  it("binds every global catalog entry to the actual handler and build identity", () => {
    for (const tool of listGlobalTools()) {
      expect(tool.sourceIdentity).toEqual(expect.objectContaining({
        provider: "global_registry",
        buildId: expect.any(String),
        handlerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }));
    }
  });

  it("publishes the records.upsert code-owned canary lifecycle in definition identity", () => {
    const descriptor = globalToolRegistry.get("records.upsert");
    const catalog = listGlobalTools().find((tool) => tool.name === "records.upsert");
    expect(descriptor?.factoryWriteProbeLifecycle?.identity).toEqual({
      id: "records.upsert/write-probe",
      revision: "1",
    });
    expect(catalog).toMatchObject({
      sideEffect: "write",
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      probeSafety: {
        testDataContract: { marker: { path: "_agent_factory_probe.marker" } },
        idempotency: { path: "_agent_factory_probe.idempotency_key" },
        isolation: {
          namespace: { path: "_agent_factory_probe.namespace" },
          target: { path: "_agent_factory_probe.target" },
        },
      },
      sourceIdentity: {
        writeProbeLifecycle: {
          schema: "agentic-write-probe-lifecycle/v1",
          id: "records.upsert/write-probe",
          revision: "1",
          cleanupHandlerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          readbackHandlerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      returnsSchema: {
        _record: { type: "object", required: true },
      },
    });
    expect(catalog?.returnsExample).toMatchObject({
      _record: {
        record_id: expect.any(String),
        record_type: "candidate",
        record_key: "cand-1",
        upserted: true,
      },
    });
  });

  it("allows non-mutating recruitment calls only with an independent sandbox profile", () => {
    // Legacy RoboHire names alias to the canonical GoHire implementations;
    // the reviewed policy must resolve identically through either name.
    for (const name of [
      "robohireHealthApi",
      "gohireHealthApi",
      "parseJdApi",
      "gohireParseJdApi",
      "generateJdApi",
      "parseResumeApi",
      "gohireParseResumeApi",
      "matchResumeApi",
      "gohireMatchResumeApi",
    ]) {
      expect(getGlobalToolCatalogEntry(name)).toMatchObject({
        effectScope: "external",
        sandboxPolicy: "live_external",
      });
    }
    for (const name of ["inviteCandidateApi", "gohireInviteCandidateApi"]) {
      const invite = getGlobalToolCatalogEntry(name);
      expect(invite).toMatchObject({
        operation: "write",
        effectScope: "external",
        sandboxPolicy: "requires_attempt_grant",
      });
      expect(invite?.capabilities?.[0]?.roles).toEqual(
        expect.arrayContaining(["write", "writes"]),
      );
    }
    // generateJdApi still rides the env-reference-only RoboHire helper: both
    // env references stay REQUIRED and nothing implicit may stand in.
    expect(getGlobalToolCatalogEntry("generateJdApi")?.configSchema).toMatchObject({
      api_key_env: { required: true },
      base_url_env: { required: true },
    });
    for (const name of ["robohireHealthApi", "parseJdApi", "generateJdApi", "parseResumeApi", "matchResumeApi", "inviteCandidateApi"]) {
      const tool = getGlobalToolCatalogEntry(name);
      // The canonical GoHire family resolves credentials via the Settings →
      // Integrations store with fail-closed env-reference overrides; the
      // catalog must still document both override knobs for every entry.
      expect(tool?.configSchema?.api_key_env).toBeDefined();
      expect(tool?.configSchema?.base_url_env).toBeDefined();
      // The profile decides the env-var names; the registry must not smuggle
      // one tenant's/bootstrap variable in as an implicit alternative.
      expect(tool?.credentialEnv).toBeUndefined();
    }
  });

  it("keeps GoHire capability systems separate from RAAS while preserving legacy tool-name aliases", () => {
    const aliases = [
      ["gohireHealthApi", "robohireHealthApi"],
      ["gohireParseJdApi", "parseJdApi"],
      ["generateJdApi", "gohire.generateJd"],
      ["gohireParseResumeApi", "parseResumeApi"],
      ["gohireMatchResumeApi", "matchResumeApi"],
      ["gohireInviteCandidateApi", "inviteCandidateApi"],
    ] as const;

    for (const [canonicalName, legacyName] of aliases) {
      const canonical = getGlobalToolCatalogEntry(canonicalName);
      const legacy = getGlobalToolCatalogEntry(legacyName);
      expect(canonical?.name).toBe(canonicalName);
      expect(legacy?.name).toBe(canonicalName);

      const systems =
        canonical?.capabilities?.flatMap(
          (capability) => capability.systems ?? [],
        ) ?? [];
      expect(systems).toEqual(
        expect.arrayContaining(["GoHire", "GoHire_System"]),
      );
      expect(systems).not.toContain("RAAS");
      expect(systems).not.toContain("RAAS_System");
    }
  });

  it("resolves the same reviewed policy for aliases and rejects unknown names", () => {
    const aliased = listGlobalTools().find((tool) => tool.aliases?.length);
    expect(aliased).toBeDefined();
    expect(globalToolExecutionPolicy(aliased!.aliases![0]!)).toEqual(
      globalToolExecutionPolicy(aliased!.name),
    );
    expect(globalToolExecutionPolicy("missing.tool")).toBeUndefined();
  });

  it("publishes non-secret profile diagnostics without claiming integration coverage", () => {
    const diagnostic = getGlobalToolCatalogEntry(
      "config.inspectEnvironmentReferences",
    );
    expect(diagnostic).toMatchObject({
      operation: "compute",
      effectScope: "none",
      sandboxPolicy: "pure",
      testPolicy: "allow",
      configSchema: {
        profile_name: { required: true },
        system_name: { required: true },
        required_env: { required: true },
      },
    });
    expect(diagnostic?.capabilities).toBeUndefined();
    expect(diagnostic?.credentialEnv).toBeUndefined();
  });

  it("covers the exact Agents-generation Ontology operation coordinates", () => {
    const operations = (name: string): string[] =>
      getGlobalToolCatalogEntry(name)?.capabilities?.flatMap(
        (capability) => capability.operations ?? [],
      ) ?? [];

    expect(operations("generateJdApi")).toContain("jd.generate");
    expect(operations("parseResumeApi")).toContain("resume.parse");
    expect(operations("matchResumeApi")).toContain("resume.match");
    expect(operations("inviteCandidateApi")).toContain("interview.invite");
    expect(operations("ontology.fetchActionRules")).toEqual(
      expect.arrayContaining(["rules.fetch", "rules.select"]),
    );
    expect(operations("ontology.writeInstance")).toEqual(
      expect.arrayContaining([
        "instance.mirror",
        "instance.write",
        "cmr.mirror",
        "cmr.merge_overall",
      ]),
    );
    expect(operations("ontology.query")).toContain("graph.verify");
  });

  it.each([
    ["objectStore.getObject", "read", "external", "live_external", "environment_reference_only", true],
    ["postgres.executeStatement", "read_write", "external", "requires_attempt_grant", "environment_reference_only", true],
    ["postgres.executeTransaction", "read_write", "external", "requires_attempt_grant", "environment_reference_only", true],
    ["crypto.sha256", "compute", "none", "pure", "none", false],
    ["document.convert", "compute", "none", "pure", "none", false],
    ["ontology.writeInstance", "write", "external", "requires_attempt_grant", "environment_reference_only", true],
    ["persistRuleCheckAudit", "write", "external", "requires_attempt_grant", "environment_reference_only", true],
  ] as const)(
    "registers %s with executable descriptor and explicit safety metadata",
    (name, operation, effectScope, sandboxPolicy, credentialPosture, probeRequired) => {
      const descriptor = globalToolRegistry.get(name);
      const catalog = listGlobalTools().find((tool) => tool.name === name);
      expect(descriptor).toMatchObject({ kind: "tool", name });
      expect(typeof descriptor?.handler).toBe("function");
      expect(catalog).toMatchObject({
        name,
        operation,
        effectScope,
        sandboxPolicy,
        credentialPosture,
        probeRequired,
      });
      expect(catalog?.capabilities?.length).toBeGreaterThan(0);
      expect(
        catalog?.capabilities?.every(
          (capability) => capability.probeRequired === probeRequired,
        ),
      ).toBe(true);
      expect(catalog?.argsSchema).toBeDefined();
      expect(catalog?.returnsSchema).toBeDefined();
      expect(catalog?.configSchema).toBeDefined();
    },
  );

  it("publishes the Allmeta dedicated-object canary lifecycle and required profile fields", () => {
    const catalog = listGlobalTools().find((tool) => tool.name === "ontology.writeInstance");
    const descriptor = globalToolRegistry.get("ontology.writeInstance");
    expect(catalog?.probeSafety).toMatchObject({
      testDataContract: { marker: { path: "_agent_factory_probe.marker" } },
      isolation: {
        namespace: { path: "_agent_factory_probe.namespace" },
        target: { path: "_agent_factory_probe.target" },
      },
      cleanup: { handler: "ontology.writeInstance.canary.cleanup" },
      absenceProof: { handler: "ontology.writeInstance.canary.readback" },
    });
    expect(catalog?.configSchema).toMatchObject({
      probe_domain: { required: true },
      probe_action: { required: true },
      probe_object: { required: true },
      probe_namespace: { required: true },
      probe_primary_key_field: { required: true },
      probe_marker_field: { required: true },
      probe_namespace_field: { required: true },
      probe_idempotency_field: { required: true },
    });
    expect(descriptor?.factoryWriteProbeLifecycle?.identity).toEqual({
      id: "ontology.writeInstance/write-probe",
      revision: "1",
    });
    expect(catalog?.sourceIdentity?.writeProbeLifecycle).toMatchObject({
      id: "ontology.writeInstance/write-probe",
      revision: "1",
      cleanupHandlerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      readbackHandlerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("publishes the exact atomic PostgreSQL batch contract", () => {
    const catalog = listGlobalTools().find(
      (tool) => tool.name === "postgres.executeTransaction",
    );
    expect(catalog?.argsSchema).toEqual({
      operations: expect.objectContaining({
        required: true,
        type: "Array<{operation:string,values:Record<string, JSON value>}>",
      }),
    });
    expect(catalog?.configSchema).toMatchObject({
      connection_url_env: { required: true, type: "string" },
      statement_catalog_env: { required: true, type: "string" },
      allowed_operations: { type: "string[]" },
      allow_write: { type: "boolean", default: false },
      max_operations: { type: "number", default: 20 },
      max_batch_bytes: { type: "number", default: 1048576 },
      max_rows: { type: "number", default: 1000 },
      timeout_ms: { type: "number", default: 30000 },
    });
    expect(catalog?.configSchema).not.toHaveProperty("connection_url");
    expect(catalog?.configSchema).not.toHaveProperty("statement_catalog");
    expect(catalog?.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          systems: expect.arrayContaining(["PostgreSQL"]),
          roles: expect.arrayContaining(["read"]),
          operations: expect.arrayContaining([
            "transaction",
            "execute-transaction",
            "atomic-batch",
          ]),
          probeRequired: true,
        }),
        expect.objectContaining({
          systems: expect.arrayContaining(["PostgreSQL"]),
          roles: expect.arrayContaining(["write"]),
          operations: expect.arrayContaining([
            "transaction",
            "execute-transaction",
            "atomic-batch",
          ]),
          probeRequired: true,
        }),
      ]),
    );
    expect(catalog?.returnsSchema).toHaveProperty("operation_results");
  });

  it.each([
    ["postgres.executeStatement", "postgres.executeStatement/write-probe"],
    ["postgres.executeTransaction", "postgres.executeTransaction/write-probe"],
  ] as const)("publishes %s as a code-owned isolated PostgreSQL canary", (name, lifecycleId) => {
    const catalog = listGlobalTools().find((tool) => tool.name === name);
    const descriptor = globalToolRegistry.get(name);
    expect(catalog?.probeSafety).toMatchObject({
      testDataContract: {
        marker: { path: "_agent_factory_postgres_probe.marker" },
      },
      idempotency: {
        path: "_agent_factory_postgres_probe.idempotency_key",
      },
      isolation: {
        namespace: { path: "_agent_factory_postgres_probe.namespace" },
        target: { path: "_agent_factory_postgres_probe.target" },
      },
      cleanup: { kind: "handler" },
      absenceProof: { kind: "handler" },
    });
    expect(catalog?.configSchema).toMatchObject({
      write_probe_connection_url_env: { required: true, type: "string" },
      write_probe_statement_catalog_env: { required: true, type: "string" },
      write_probe_namespace: { required: true, type: "string" },
      write_probe_create_operation: { required: true, type: "string" },
      write_probe_readback_operation: { required: true, type: "string" },
      write_probe_cleanup_operation: { required: true, type: "string" },
    });
    expect(descriptor?.factoryWriteProbeLifecycle?.identity).toEqual({
      id: lifecycleId,
      revision: "1",
    });
    expect(catalog?.sourceIdentity?.writeProbeLifecycle).toMatchObject({
      id: lifecycleId,
      revision: "1",
      cleanupHandlerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      readbackHandlerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("publishes object-store cross-field config rules as catalog metadata", () => {
    const catalog = listGlobalTools().find(
      (tool) => tool.name === "objectStore.getObject",
    );
    expect(catalog?.configContract).toEqual({
      atLeastOne: [{ keys: ["endpoint", "endpoint_env"] }],
      mutuallyExclusive: [{ keys: ["endpoint", "endpoint_env"] }],
      requiredUnless: [{
        keys: ["access_key_env", "secret_key_env"],
        unless: { key: "auth", equals: "anonymous" },
      }],
    });
    expect(catalog?.configSchema?.auth).toMatchObject({
      type: "string",
      allowedValues: ["sigv4", "anonymous"],
      default: "sigv4",
    });
  });

  it("publishes exact rule-audit scope and evidence persistence capabilities", () => {
    const catalog = listGlobalTools().find(
      (tool) => tool.name === "persistRuleCheckAudit",
    );
    expect(catalog?.aliases).toContain("records.persistRuleCheckAudit");
    expect(catalog?.configSchema).toMatchObject({
      tenant: { required: true },
      domain: { required: true },
      action: { required: true },
      postgres_url_env: { required: true },
      allmeta_base_url_env: { type: "string" },
      allmeta_api_key_env: { type: "string" },
    });
    expect(catalog?.profileScope?.exact).toEqual([
      { configKey: "tenant", source: "tenantSlug" },
      { configKey: "domain", source: "domain" },
      { configKey: "action", source: "action" },
    ]);
    expect(catalog?.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          systems: expect.arrayContaining(["PostgreSQL"]),
          objectTypes: expect.arrayContaining([
            "Rule_Check_Audit",
            "RuleCheckFlag",
          ]),
        }),
        expect.objectContaining({
          systems: expect.arrayContaining(["Allmeta"]),
          operations: expect.arrayContaining(["write-instance"]),
        }),
      ]),
    );
  });
});
