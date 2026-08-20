import { describe, expect, it } from "vitest";
import { sandboxTenantSlug } from "../src/services/agent-factory/sandbox-deployer";
import {
  AgentSchema,
  FactoryToolDomainConflictError,
  ManifestToolResolutionError,
  ManifestInvokeConfigurationError,
  assertManifestInvokesValid,
  assertManifestToolsResolvable,
  selectFactoryToolsForManifest,
  type WorkflowManifest,
} from "@agentic/runtime";

function agent(id: string, tool: string, domain?: string): WorkflowManifest[number] {
  return AgentSchema.parse({
    id,
    name: id,
    actor: ["Agent"],
    trigger: [],
    triggered_event: [],
    actions: [{ order: "1", name: id, type: "logic" }],
    tool_use: [{ name: tool }],
    ...(domain ? { factory_domain_id: domain } : {}),
  });
}

function row(id: string, name: string, scopeKey: string, domainKey: string) {
  return {
    id,
    scopeKey,
    domainKey,
    name,
    tenantId: scopeKey === "shared" ? null : scopeKey,
    description: id,
    method: "GET",
    urlTemplate: `https://${id}.example.com`,
    headers: null,
    bodyTemplate: null,
    sideEffect: "read",
    domain: domainKey || null,
    paramsSchema: null,
    returnsSchema: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("Agent Factory tenant/domain isolation", () => {
  it("derives a fresh content-labelled sandbox slug from tenant, domain, candidate and attempt", () => {
    const a = { tenantId: "ten-a", tenantSlug: "acme" };
    const b = { tenantId: "ten-b", tenantSlug: "beta" };
    const fp1 = "sandbox-evidence:v5:candidate-one";
    const fp2 = "sandbox-evidence:v5:candidate-two";

    expect(sandboxTenantSlug("recruiting-v1", a, fp1, "attempt-1"))
      .toBe(sandboxTenantSlug("recruiting-v1", a, fp1, "attempt-1"));
    expect(sandboxTenantSlug("recruiting-v1", a, fp1, "attempt-1"))
      .not.toBe(sandboxTenantSlug("recruiting-v1", a, fp1, "attempt-2"));
    expect(sandboxTenantSlug("recruiting-v1", a, fp1, "attempt-1"))
      .not.toBe(sandboxTenantSlug("recruiting-v1", b, fp1, "attempt-1"));
    expect(sandboxTenantSlug("recruiting-v1", a, fp1, "attempt-1"))
      .not.toBe(sandboxTenantSlug("finance-v1", a, fp1, "attempt-1"));
    expect(sandboxTenantSlug("recruiting-v1", a, fp1, "attempt-1"))
      .not.toBe(sandboxTenantSlug("recruiting-v1", a, fp2, "attempt-1"));
    expect(sandboxTenantSlug("recruiting-v1", a, fp1, "attempt-1"))
      .toMatch(/^af-sbx-[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{12}-sb$/);
  });

  it("fails closed when two additive ontology agents resolve one tool name to different rows", () => {
    const rows = [
      row("tool-a", "acme.lookup", "ten-a", "ontology-a"),
      row("tool-b", "acme.lookup", "ten-a", "ontology-b"),
    ];
    const manifest = [
      agent("agent-a", "acme.lookup", "ontology-a"),
      agent("agent-b", "acme.lookup", "ontology-b"),
    ];
    expect(() => selectFactoryToolsForManifest(rows, manifest, "ten-a"))
      .toThrow(FactoryToolDomainConflictError);
  });

  it("lets an old unmarked agent resolve general tools only", () => {
    const exactOnly = [row("tool-a", "acme.lookup", "ten-a", "ontology-a")];
    expect(() => selectFactoryToolsForManifest(exactOnly, [agent("legacy", "acme.lookup")], "ten-a"))
      .toThrow(/other ontology domains/);

    const withGeneral = [...exactOnly, row("tool-general", "acme.lookup", "ten-a", "")];
    expect(selectFactoryToolsForManifest(withGeneral, [agent("legacy", "acme.lookup")], "ten-a").map((r) => r.id))
      .toEqual(["tool-general"]);
  });

  it("prefers tenant exact-domain over general/shared for one marked agent", () => {
    const rows = [
      row("shared-general", "acme.lookup", "shared", ""),
      row("tenant-general", "acme.lookup", "ten-a", ""),
      row("tenant-exact", "acme.lookup", "ten-a", "ontology-a"),
    ];
    expect(selectFactoryToolsForManifest(rows, [agent("agent-a", "acme.lookup", "ontology-a")], "ten-a").map((r) => r.id))
      .toEqual(["tenant-exact"]);
  });

  it("fails boot validation when a manifest tool_use has no callable descriptor", () => {
    expect(() =>
      assertManifestToolsResolvable({
        tenantSlug: "acme",
        manifest: [agent("agent-a", "acme.missing")],
        globalRegistry: new Map(),
      }),
    ).toThrow(ManifestToolResolutionError);
  });

  it("validates both direct tool actions and tool_use against the effective registry", () => {
    const manifest = [
      AgentSchema.parse({
        id: "agent-a",
        name: "agent-a",
        actor: ["Agent"],
        trigger: [],
        triggered_event: [],
        actions: [{ order: "1", name: "acme.lookup", type: "tool" }],
        tool_use: [{ name: "acme.lookup" }],
      }),
    ];
    const callable = {
      name: "acme.lookup",
      description: "real handler",
      handler: async () => ({ ok: true, data: {} }),
    } as never;

    expect(() =>
      assertManifestToolsResolvable({
        tenantSlug: "acme",
        manifest,
        tenantRegistry: { tools: { "acme.lookup": callable } },
        globalRegistry: new Map(),
      }),
    ).not.toThrow();

    expect(() =>
      assertManifestToolsResolvable({
        tenantSlug: "acme",
        manifest,
        tenantRegistry: { tools: { "acme.lookup": { name: "broken" } as never } },
        globalRegistry: new Map(),
      }),
    ).toThrow(/do not resolve to a callable/);
  });

  it("makes invoke terminal by default and requires an explicit fallback for soft mode", () => {
    const child = AgentSchema.parse({
      id: "child",
      name: "childFn",
      actor: ["Agent"],
      trigger: ["child.invoked"],
      triggered_event: [],
      actions: [{ order: "1", name: "childLogic", type: "logic" }],
    });
    const parent = (invoke: string, extra: Record<string, unknown> = {}) =>
      AgentSchema.parse({
        id: "parent",
        name: "parentFn",
        actor: ["Agent"],
        trigger: ["START"],
        triggered_event: ["DONE"],
        actions: [{ order: "1", name: "callChild", type: "invoke", invoke, ...extra }],
      });

    expect(() =>
      assertManifestInvokesValid({
        tenantSlug: "acme",
        manifest: [parent("childFn"), child],
      }),
    ).not.toThrow();
    // The canonical manifest schema rejects this invalid contract at the
    // earliest boundary. Bootstrap keeps the same check as defence in depth
    // for callers that construct typed values without parsing them first.
    expect(() => parent("childFn", { on_error: "soft" }))
      .toThrow(/on_error=soft requires an explicit default_result/);
    const unparsedInvalidParent = parent("childFn");
    unparsedInvalidParent.actions[0]!.on_error = "soft";
    expect(() =>
      assertManifestInvokesValid({
        tenantSlug: "acme",
        manifest: [unparsedInvalidParent, child],
      }),
    ).toThrow(ManifestInvokeConfigurationError);
    expect(() =>
      assertManifestInvokesValid({
        tenantSlug: "acme",
        manifest: [parent("childFn", { on_error: "soft", default_result: null }), child],
      }),
    ).not.toThrow();
    expect(() =>
      assertManifestInvokesValid({
        tenantSlug: "acme",
        manifest: [parent("missingFn"), child],
      }),
    ).toThrow(/target is not an enabled/);
  });

  it("accepts a generated invoke that names the business Action it was built from", () => {
    // Generated fleets carry two names for one function: the manifest `name`
    // (the agent's short name) and `factory_action_name` (the Ontology Action
    // that authorised it). A generated plan step naturally writes the Action
    // name, which used to fail the whole tenant's bootstrap — one dangling
    // reference took its five healthy siblings down with it.
    const child = AgentSchema.parse({
      id: "agents-gener-rule-check-for-candidate-identity",
      name: "RuleCheckForCandidateIdentityAgent",
      factory_action_name: "ruleCheckForCandidateIdentity",
      actor: ["Agent"],
      trigger: ["CANDIDATE_IDENTITY_REQUESTED"],
      triggered_event: [],
      actions: [{ order: "1", name: "check", type: "logic" }],
    });
    const parent = (invoke: string) =>
      AgentSchema.parse({
        id: "agents-gener-process-resume",
        name: "ProcessResumeAgent",
        factory_action_name: "processResume",
        actor: ["Agent"],
        trigger: ["RESUME_DOWNLOADED"],
        triggered_event: ["RESUME_PROCESSED"],
        actions: [
          { order: "1", name: "invoke_candidate_identity", type: "invoke", invoke },
        ],
      });

    expect(() =>
      assertManifestInvokesValid({
        tenantSlug: "agents-generation",
        manifest: [parent("ruleCheckForCandidateIdentity"), child],
      }),
    ).not.toThrow();
    expect(() =>
      assertManifestInvokesValid({
        tenantSlug: "agents-generation",
        manifest: [
          parent("agents-generation.ruleCheckForCandidateIdentity"),
          child,
        ],
      }),
    ).not.toThrow();
    // An Action name nobody generated stays dangling.
    expect(() =>
      assertManifestInvokesValid({
        tenantSlug: "agents-generation",
        manifest: [parent("ruleCheckForSomethingElse"), child],
      }),
    ).toThrow(/target is not an enabled/);
    // A trigger-less agent is not a callable target under either name.
    const triggerless = AgentSchema.parse({
      ...child,
      trigger: [],
    });
    expect(() =>
      assertManifestInvokesValid({
        tenantSlug: "agents-generation",
        manifest: [parent("ruleCheckForCandidateIdentity"), triggerless],
      }),
    ).toThrow(/target is not an enabled/);
  });
});
