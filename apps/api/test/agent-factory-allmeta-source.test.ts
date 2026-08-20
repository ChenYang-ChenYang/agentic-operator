/**
 * AllmetaOntologySource + CompositeOntologySource — the live AllmetaOntology
 * ontology source (Studio HTTP API at :3500) and the composite that routes the
 * factory between local models/ domains and live Allmeta domains
 * (e.g. "Agents-generation").
 *
 * Pure-unit: the HTTP path is exercised with a stubbed global fetch, so this never
 * touches a real Studio, the DB, or the test harness.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { OntologySource, DomainOntology } from "@agentic/agent-factory";
import {
  parseJsonField,
  normDomainId,
  resolveAllmetaDomainId,
  assertUniqueActionsByName,
  buildEmitByAction,
  normalizeAllmetaAction,
  normalizeAllmetaActionStep,
  normalizeAllmetaEvent,
  normalizeAllmetaManagedLink,
  normalizeAllmetaObject,
  AllmetaOntologySource,
} from "../src/services/agent-factory/allmeta-ontology-source";
import { CompositeOntologySource } from "../src/services/agent-factory/composite-ontology-source";

// ── fetch stub ──────────────────────────────────────────────────────────────
type Body = Record<string, unknown>;
/** Stub global fetch: pick the first route whose substring is in the URL. */
function stubFetch(
  routes: Array<[string, Body]>,
  opts?: { failAll?: boolean },
) {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (opts?.failAll) return { ok: false, json: async () => ({}) } as Response;
    for (const [needle, body] of routes) {
      if (url.includes(needle))
        return { ok: true, json: async () => body } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
}
afterEach(() => vi.unstubAllGlobals());

const cfg = {
  baseUrl: "http://localhost:3500",
  apiKey: "abc123",
  timeoutMs: 2000,
};

describe("parseJsonField", () => {
  it("parses a stringified array", () => {
    expect(parseJsonField('["a","b"]', [] as string[])).toEqual(["a", "b"]);
  });
  it("passes an object through", () => {
    expect(parseJsonField({ x: 1 }, {} as Body)).toEqual({ x: 1 });
  });
  it("rejects invalid JSON", () => {
    expect(() => parseJsonField("{not json", [] as string[])).toThrow(
      /malformed/i,
    );
  });
  it("rejects an object when an array is expected", () => {
    expect(() => parseJsonField('{"x":1}', [] as string[])).toThrow(/array/i);
  });
  it("falls back on null/undefined", () => {
    expect(parseJsonField(null, ["d"])).toEqual(["d"]);
    expect(parseJsonField(undefined, 7)).toBe(7);
  });
});

describe("normDomainId", () => {
  it("collapses case / spaces / underscores / hyphens", () => {
    expect(normDomainId("Agents-generation")).toBe("agentsgeneration");
    expect(normDomainId("Agents_Generation")).toBe("agentsgeneration");
    expect(normDomainId("RAAS-v1")).toBe("raasv1");
    expect(normDomainId("agents generation")).toBe("agentsgeneration");
  });
});

describe("resolveAllmetaDomainId", () => {
  it("prefers an exact id even when an earlier catalog row has the same normalized alias", () => {
    const list = [
      { id: "foo", name: "first" },
      { id: "Foo", name: "second" },
    ];
    expect(resolveAllmetaDomainId(list, "Foo")).toBe("Foo");
  });

  it("accepts only a unique normalized alias and refuses an ambiguous one", () => {
    expect(
      resolveAllmetaDomainId(
        [{ id: "Agents-generation" }],
        "agents_generation",
      ),
    ).toBe("Agents-generation");
    expect(
      resolveAllmetaDomainId([{ id: "foo-bar" }, { id: "foo_bar" }], "FOO BAR"),
    ).toBe("FOO BAR");
  });
});

describe("normalizers", () => {
  it("normalizeAllmetaObject parses stringified properties + id/uid fallback", () => {
    const o = normalizeAllmetaObject({
      uid: "Job_Posting",
      name: "职位发布",
      properties: JSON.stringify([{ name: "job_posting_id", type: "String" }]),
    });
    expect(o.id).toBe("Job_Posting");
    expect(o.properties).toHaveLength(1);
    expect(o.properties?.[0]?.name).toBe("job_posting_id");
  });

  it("normalizeAllmetaEvent parses the stringified payload envelope", () => {
    const e = normalizeAllmetaEvent({
      name: "JD_GENERATED",
      producers: ["createJD"],
      consumers: '["jdReview"]',
      payload: JSON.stringify({
        source_action: "createJD",
        source_domain: "RAAS-v1",
        event_data: [
          {
            name: "job_posting_id",
            type: "String",
            target_object: "Job_Posting",
          },
        ],
        state_mutations: [
          {
            target_object: "Job_Posting",
            mutation_type: "CREATE",
            impacted_properties: ["x"],
          },
        ],
      }),
    });
    expect(e.payload.source_action).toBe("createJD");
    expect(e.payload.source_domain).toBe("RAAS-v1");
    expect(e.producers).toEqual(["createJD"]);
    expect(e.consumers).toEqual(["jdReview"]);
    expect(e.payload.event_data).toHaveLength(1);
    expect(e.payload.state_mutations).toHaveLength(1);
  });

  it("normalizes Allmeta's blank producer fields to the contract's null absence", () => {
    const event = normalizeAllmetaEvent({
      name: "ANALYSIS_COMPLETED",
      source_action: "",
      source_domain: "   ",
      payload: JSON.stringify({
        source_action: "",
        event_data: [
          {
            name: "requirement_id",
            type: "String",
            target_object: null,
          },
        ],
        state_mutations: [],
      }),
    });

    expect(event.payload.source_action).toBeNull();
    expect(event.payload).not.toHaveProperty("source_domain");
  });

  it("normalizeAllmetaAction parses *_json fields and reads action_id", () => {
    const a = normalizeAllmetaAction(
      {
        action_id: "4",
        name: "createJD",
        actor_json: '["Agent"]',
        trigger_json: '["REQUIREMENT_LOGGED"]',
        triggered_event_json: '["JD_GENERATED"]',
        target_objects_json: '["Job_Posting"]',
        action_steps_json: JSON.stringify([
          { order: "1", name: "generateJD", rules: [{ id: "4-1" }] },
        ]),
        integration_json: JSON.stringify({
          systems: [{ name: "RoboHire", role: "calls" }],
        }),
      },
      new Map(),
    );
    expect(a.id).toBe("4");
    expect(a.actor).toEqual(["Agent"]);
    expect(a.trigger).toEqual(["REQUIREMENT_LOGGED"]);
    expect(a.triggered_event).toEqual(["JD_GENERATED"]);
    expect(a.target_objects).toEqual(["Job_Posting"]);
    expect(a.action_steps?.[0]).toMatchObject({ name: "generateJD" });
    expect(a.integration).toMatchObject({ systems: [{ name: "RoboHire" }] });
  });

  it("normalizeAllmetaAction preserves standard bare trigger/emit exports", () => {
    const a = normalizeAllmetaAction(
      {
        id: "4",
        name: "createJD",
        actor: ["Agent"],
        trigger: ["JOB_REQUIREMENTS_READY"],
        emit: ["JD_GENERATED"],
        instruction: "generate from authoritative requirement",
        on_success: "emit_jd_generated",
        on_failure: "fail_without_emit",
      },
      new Map(),
    );
    expect(a.trigger).toEqual(["JOB_REQUIREMENTS_READY"]);
    expect(a.triggered_event).toEqual(["JD_GENERATED"]);
    expect(a).toMatchObject({
      instruction: "generate from authoritative requirement",
      on_success: "emit_jd_generated",
      on_failure: "fail_without_emit",
    });
  });

  it("normalizeAllmetaActionStep decodes execution-bearing JSON fields", () => {
    const step = normalizeAllmetaActionStep({
      id: "9-1::parseResume",
      name: "parseResume",
      order: "2",
      condition: "download complete",
      inputs_json: '[{"name":"object_key"}]',
      outputs_json: '[{"name":"parsed_resume"}]',
      rules_json: '[{"id":"9-2"}]',
    });
    expect(step).toMatchObject({
      id: "9-1::parseResume",
      name: "parseResume",
      order: "2",
      inputs: [{ name: "object_key" }],
      outputs: [{ name: "parsed_resume" }],
      rules: [{ id: "9-2" }],
    });
  });

  it("normalizes only central modern managed links", () => {
    expect(
      normalizeAllmetaManagedLink({
        id: "action/4/includes/step-1",
        kind: "action-includes-step",
        managedBy: "links-builder",
        allmetaLink: true,
        status: "approved",
        fromId: "4",
        fromLabel: "Action",
        toId: "step-1",
        toLabel: "ActionStep",
      }),
    ).toMatchObject({
      id: "action/4/includes/step-1",
      kind: "action-includes-step",
      status: "approved",
      from: { type: "Action", id: "4" },
      to: { type: "ActionStep", id: "step-1" },
    });
    expect(
      normalizeAllmetaManagedLink({
        linkId: "legacy",
        type: "HAS_STEP",
        fromId: "4",
        toId: "step-1",
      }),
    ).toBeNull();
    expect(() =>
      normalizeAllmetaManagedLink({
        id: "broken",
        kind: "rule-governs",
        allmetaLink: true,
      }),
    ).toThrow(/from id/);
  });

  it("normalizeAllmetaAction derives emitted events from emitByAction when the node lacks them", () => {
    const emitByAction = new Map([["processResume", ["RESUME_PROCESSED"]]]);
    const a = normalizeAllmetaAction(
      { name: "processResume", actor_json: '["Agent"]' },
      emitByAction,
    );
    expect(a.triggered_event).toEqual(["RESUME_PROCESSED"]);
  });

  it("preserves an explicitly empty emitted-event list instead of deriving stale producers", () => {
    const emitByAction = new Map([["processResume", ["RESUME_PROCESSED"]]]);
    const action = normalizeAllmetaAction(
      {
        name: "processResume",
        actor_json: '["Agent"]',
        triggered_event_json: "[]",
      },
      emitByAction,
    );
    expect(action.triggered_event).toEqual([]);
  });

  it("buildEmitByAction maps source_action → emitted event names", () => {
    const map = buildEmitByAction([
      normalizeAllmetaEvent({
        name: "RESUME_PROCESSED",
        payload: JSON.stringify({ source_action: "processResume" }),
      }),
      normalizeAllmetaEvent({
        name: "JD_GENERATED",
        producers: ["createJD", "repairJD"],
        payload: JSON.stringify({ source_action: null }),
      }),
    ]);
    expect(map.get("processResume")).toEqual(["RESUME_PROCESSED"]);
    expect(map.get("createJD")).toEqual(["JD_GENERATED"]);
    expect(map.get("repairJD")).toEqual(["JD_GENERATED"]);
  });

  it("rejects duplicate action identities instead of silently discarding live ontology rows", () => {
    const mk = (name: string, id: string) =>
      normalizeAllmetaAction(
        { name, action_id: id, actor_json: '["Agent"]' },
        new Map(),
      );
    expect(() =>
      assertUniqueActionsByName([mk("createJD", "4"), mk("createJD", "4-dup")]),
    ).toThrow(/duplicate action name/);
    expect(
      assertUniqueActionsByName([mk("createJD", "4"), mk("matchResume", "10")]),
    ).toHaveLength(2);
  });

  it("rejects missing actors and malformed nested rows rather than filtering or defaulting them", () => {
    expect(() =>
      normalizeAllmetaAction({ action_id: "4", name: "createJD" }, new Map()),
    ).toThrow(/actor is required/);
    expect(() =>
      normalizeAllmetaAction(
        { action_id: "4", name: "createJD", actor_json: '["Agent",7]' },
        new Map(),
      ),
    ).toThrow(/actor\[1\]/);
    expect(() =>
      normalizeAllmetaEvent({ name: "E", payload: '{"event_data":{}}' }),
    ).toThrow(/event_data must be an array/);
    expect(() => normalizeAllmetaObject({ id: "ObjectWithoutName" })).toThrow(
      /name is required/,
    );
  });
});

describe("AllmetaOntologySource — unconfigured", () => {
  it("reports not configured and fails closed for catalog and ontology reads", async () => {
    const src = new AllmetaOntologySource({
      baseUrl: "",
      apiKey: "",
      timeoutMs: 1000,
    });
    expect(src.configured).toBe(false);
    await expect(src.listDomains()).rejects.toThrow(/ALLMETA_BASE_URL/);
    await expect(src.fetchOntology("Agents-generation")).rejects.toThrow(
      /ALLMETA_BASE_URL/,
    );
    await expect(
      src.fetchActionRules("Agents-generation", "createJD"),
    ).rejects.toThrow(/ALLMETA_BASE_URL/);
  });
});

describe("AllmetaOntologySource — live (stubbed fetch)", () => {
  it("reads a bounded instance page from the exact Allmeta domain", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/api/domains")) {
        return {
          ok: true,
          json: async () => ({
            domains: [{ id: "Agents-generation" }],
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              job_requisition_id: "jr-1",
              title: "FDE",
              email: "private@example.test",
            },
          ],
          nextCursor: "cursor-2",
        }),
      } as Response;
    });

    const page = await new AllmetaOntologySource(cfg, {
      domainIdentity: "exact",
    }).listInstances("Agents-generation", "Job_Requisition", { limit: 5 });

    expect(page).toEqual({
      items: [
        {
          job_requisition_id: "jr-1",
          title: "FDE",
          email: "private@example.test",
        },
      ],
      nextCursor: "cursor-2",
    });
    expect(seen.at(-1)).toBe(
      "http://localhost:3500/api/v1/ontology/instances/Job_Requisition?domain=Agents-generation&limit=5",
    );
  });

  it("rejects oversized instance samples before reaching Allmeta", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      new AllmetaOntologySource(cfg).listInstances(
        "Agents-generation",
        "Candidate",
        { limit: 21 },
      ),
    ).rejects.toThrow(/1 to 20/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches + normalizes a domain ontology with source 'allmeta'", async () => {
    stubFetch([
      [
        "/api/domains",
        { domains: [{ id: "Agents-generation", name: "Agents generation" }] },
      ],
      [
        "/api/v1/ontology/actions/4/steps",
        {
          action_steps: [
            {
              id: "4::generateJD",
              name: "generateJD",
              order: "1",
              inputs_json: "[]",
              outputs_json: "[]",
              rules_json: '[{"id":"4-1"}]',
            },
          ],
        },
      ],
      [
        "/api/v1/ontology/actions/9/steps",
        {
          action_steps: [
            {
              id: "9::download",
              name: "download",
              order: "1",
              inputs_json: "[]",
              outputs_json: "[]",
              rules_json: "[]",
            },
            {
              id: "9::parse",
              name: "parse",
              order: "2",
              inputs_json: "[]",
              outputs_json: "[]",
              rules_json: "[]",
            },
          ],
        },
      ],
      [
        "/api/v1/ontology/actions",
        {
          items: [
            {
              action_id: "4",
              name: "createJD",
              actor_json: '["Agent"]',
              trigger_json: '["REQUIREMENT_LOGGED"]',
              triggered_event_json: '["JD_GENERATED"]',
            },
            // no triggered_event_json → emitted derived from the events below
            {
              action_id: "9",
              name: "processResume",
              actor_json: '["Agent"]',
              trigger_json: '["RESUME_DOWNLOADED"]',
            },
          ],
        },
      ],
      [
        "/api/v1/ontology/events",
        {
          items: [
            {
              name: "JD_GENERATED",
              payload: JSON.stringify({ source_action: "createJD" }),
            },
            {
              name: "RESUME_PROCESSED",
              payload: JSON.stringify({ source_action: "processResume" }),
            },
          ],
        },
      ],
      [
        "/api/v1/ontology/objects",
        { items: [{ id: "Job_Posting", name: "职位发布", properties: "[]" }] },
      ],
      [
        "/api/v1/ontology/rules",
        { items: [{ id: "4-1", businessLogicRuleName: "x" }] },
      ],
      [
        "/api/v1/ontology/links",
        {
          items: [
            {
              id: "action/4/includes/4::generateJD",
              kind: "action-includes-step",
              managedBy: "links-builder",
              allmetaLink: true,
              status: "approved",
              fromId: "4",
              fromLabel: "Action",
              toId: "4::generateJD",
              toLabel: "ActionStep",
            },
            {
              linkId: "legacy-link",
              type: "HAS_STEP",
              fromId: "4",
              toId: "4::generateJD",
            },
          ],
        },
      ],
    ]);

    const src = new AllmetaOntologySource(cfg);
    const o: DomainOntology = await src.fetchOntology("agents_generation"); // odd casing → resolved
    expect(o.source).toBe("allmeta");
    expect(o.domainId).toBe("agents_generation"); // AO-facing id preserved
    expect(o.actions.map((a) => a.name)).toEqual(["createJD", "processResume"]);
    expect(
      o.actions.find((a) => a.name === "processResume")?.triggered_event,
    ).toEqual(["RESUME_PROCESSED"]);
    expect(
      o.actions.find((a) => a.name === "createJD")?.action_steps,
    ).toHaveLength(1);
    expect(
      o.actions.find((a) => a.name === "createJD")?.action_steps?.[0],
    ).toMatchObject({
      id: "4::generateJD",
      rules: [{ id: "4-1" }],
    });
    expect(
      o.actions.find((a) => a.name === "processResume")?.action_steps,
    ).toHaveLength(2);
    expect(o.objects).toHaveLength(1);
    expect(o.events).toHaveLength(2);
    expect(o.rules).toHaveLength(1);
    expect(o.links).toEqual([
      expect.objectContaining({
        id: "action/4/includes/4::generateJD",
        kind: "action-includes-step",
        from: { id: "4", type: "Action" },
        to: { id: "4::generateJD", type: "ActionStep" },
      }),
    ]);
    expect(o.workflow).toEqual([]);
  });

  it("accepts two stable complete reads and treats an empty step endpoint as authoritative", async () => {
    const counts = new Map<string, number>();
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
      let body: Body;
      if (url.pathname === "/api/domains") {
        body = { domains: [{ id: "Agents-generation" }] };
      } else if (url.pathname === "/api/v1/ontology/actions") {
        body = {
          items: [
            {
              action_id: "4",
              name: "createJD",
              actor_json: '["Agent"]',
              triggered_event_json: "[]",
              action_steps_json:
                '[{"id":"stale-step","name":"must-not-return"}]',
            },
          ],
        };
      } else if (url.pathname === "/api/v1/ontology/events") {
        body = {
          items: [
            {
              name: "STALE_EVENT",
              payload: JSON.stringify({ source_action: "createJD" }),
            },
          ],
        };
      } else if (
        url.pathname === "/api/v1/ontology/objects" ||
        url.pathname === "/api/v1/ontology/rules" ||
        url.pathname === "/api/v1/ontology/links"
      ) {
        body = { items: [] };
      } else if (url.pathname === "/api/v1/ontology/actions/4/steps") {
        body = { action_steps: [] };
      } else {
        body = {};
      }
      return { ok: true, json: async () => body } as Response;
    });

    const ontology = await new AllmetaOntologySource(cfg).fetchOntology(
      "Agents-generation",
    );
    expect(ontology.actions[0]?.action_steps).toEqual([]);
    expect(ontology.actions[0]?.triggered_event).toEqual([]);
    for (const resource of ["actions", "events", "objects", "rules", "links"]) {
      expect(counts.get(`/api/v1/ontology/${resource}`), resource).toBe(2);
    }
    expect(counts.get("/api/v1/ontology/actions/4/steps")).toBe(2);
  });

  it("fails closed when ActionSteps change between the two complete reads", async () => {
    let stepRead = 0;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      let body: Body;
      if (url.pathname === "/api/domains") {
        body = { domains: [{ id: "Agents-generation" }] };
      } else if (url.pathname === "/api/v1/ontology/actions") {
        body = {
          items: [
            { action_id: "4", name: "createJD", actor_json: '["Agent"]' },
          ],
        };
      } else if (
        url.pathname === "/api/v1/ontology/events" ||
        url.pathname === "/api/v1/ontology/objects" ||
        url.pathname === "/api/v1/ontology/rules" ||
        url.pathname === "/api/v1/ontology/links"
      ) {
        body = { items: [] };
      } else if (url.pathname === "/api/v1/ontology/actions/4/steps") {
        stepRead += 1;
        body = {
          action_steps: [
            {
              id: "4::generate",
              name: stepRead === 1 ? "generate-v1" : "generate-v2",
            },
          ],
        };
      } else {
        body = {};
      }
      return { ok: true, json: async () => body } as Response;
    });

    await expect(
      new AllmetaOntologySource(cfg).fetchOntology("Agents-generation"),
    ).rejects.toThrow(/读取期间发生变化[\s\S]*稍后重试/);
    expect(stepRead).toBe(2);
  });

  it("limits ActionStep hydration to eight simultaneous requests", async () => {
    const actions = Array.from({ length: 20 }, (_, index) => ({
      action_id: `action-${index}`,
      name: `action-${index}`,
      actor_json: '["Agent"]',
    }));
    let active = 0;
    let maximum = 0;
    let stepReads = 0;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      let body: Body;
      if (url.pathname === "/api/domains") {
        body = { domains: [{ id: "Agents-generation" }] };
      } else if (url.pathname === "/api/v1/ontology/actions") {
        body = { items: actions };
      } else if (
        url.pathname === "/api/v1/ontology/events" ||
        url.pathname === "/api/v1/ontology/objects" ||
        url.pathname === "/api/v1/ontology/rules" ||
        url.pathname === "/api/v1/ontology/links"
      ) {
        body = { items: [] };
      } else if (
        /^\/api\/v1\/ontology\/actions\/action-\d+\/steps$/.test(url.pathname)
      ) {
        stepReads += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        body = { action_steps: [] };
      } else {
        body = {};
      }
      return { ok: true, json: async () => body } as Response;
    });

    const ontology = await new AllmetaOntologySource(cfg).fetchOntology(
      "Agents-generation",
    );
    expect(ontology.actions).toHaveLength(20);
    expect(stepReads).toBe(40);
    expect(maximum).toBe(8);
  });

  it("reads every cursor page when a resource exceeds Allmeta's 1,000-row page clamp", async () => {
    const link = (index: number) => ({
      id: `action/4/includes/step-${index}`,
      kind: "action-includes-step",
      managedBy: "links-builder",
      allmetaLink: true,
      status: "approved",
      fromId: "4",
      fromLabel: "Action",
      toId: `step-${index}`,
      toLabel: "ActionStep",
    });
    const firstPage = Array.from({ length: 1_000 }, (_, index) => link(index));
    const linkRequests: URL[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      let body: Body;
      if (url.pathname === "/api/domains") {
        body = { domains: [{ id: "Agents-generation" }] };
      } else if (url.pathname === "/api/v1/ontology/actions") {
        body = {
          items: [
            { action_id: "4", name: "createJD", actor_json: '["Agent"]' },
          ],
        };
      } else if (url.pathname === "/api/v1/ontology/events") {
        body = { items: [] };
      } else if (
        url.pathname === "/api/v1/ontology/objects" ||
        url.pathname === "/api/v1/ontology/rules"
      ) {
        body = { items: [] };
      } else if (url.pathname === "/api/v1/ontology/links") {
        linkRequests.push(url);
        body =
          url.searchParams.get("cursor") === "links-page-2"
            ? { items: [firstPage[999]!, link(1_000)], nextCursor: null }
            : { items: firstPage, nextCursor: "links-page-2" };
      } else if (url.pathname === "/api/v1/ontology/actions/4/steps") {
        body = { action_steps: [] };
      } else {
        body = {};
      }
      return { ok: true, json: async () => body } as Response;
    });

    const ontology = await new AllmetaOntologySource(cfg).fetchOntology(
      "Agents-generation",
    );
    expect(ontology.links).toHaveLength(1_001);
    expect(linkRequests).toHaveLength(4);
    expect(linkRequests[0]!.searchParams.get("limit")).toBe("1000");
    expect(linkRequests[0]!.searchParams.get("cursor")).toBeNull();
    expect(linkRequests[1]!.searchParams.get("cursor")).toBe("links-page-2");
    expect(linkRequests[2]!.searchParams.get("cursor")).toBeNull();
    expect(linkRequests[3]!.searchParams.get("cursor")).toBe("links-page-2");
  });

  it("fails closed when Allmeta repeats a pagination cursor", async () => {
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      let body: Body;
      if (url.pathname === "/api/domains") {
        body = { domains: [{ id: "Agents-generation" }] };
      } else if (url.pathname === "/api/v1/ontology/actions") {
        body = {
          items: [
            { action_id: "4", name: "createJD", actor_json: '["Agent"]' },
          ],
        };
      } else if (url.pathname === "/api/v1/ontology/events") {
        body = { items: [] };
      } else if (url.pathname === "/api/v1/ontology/links") {
        body = { items: [], nextCursor: "stuck" };
      } else if (
        url.pathname === "/api/v1/ontology/objects" ||
        url.pathname === "/api/v1/ontology/rules"
      ) {
        body = { items: [] };
      } else if (url.pathname === "/api/v1/ontology/actions/4/steps") {
        body = { action_steps: [] };
      } else {
        body = {};
      }
      return { ok: true, json: async () => body } as Response;
    });

    await expect(
      new AllmetaOntologySource(cfg).fetchOntology("Agents-generation"),
    ).rejects.toThrow(/repeated nextCursor/);
  });

  it("does not invent pagination for aggregate ActionStep and ActionRule endpoints", async () => {
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      let body: Body;
      if (url.pathname === "/api/domains") {
        body = { domains: [{ id: "Agents-generation" }] };
      } else if (url.pathname === "/api/v1/ontology/actions") {
        body = {
          items: [
            { action_id: "4", name: "createJD", actor_json: '["Agent"]' },
          ],
        };
      } else if (
        url.pathname === "/api/v1/ontology/events" ||
        url.pathname === "/api/v1/ontology/objects" ||
        url.pathname === "/api/v1/ontology/rules" ||
        url.pathname === "/api/v1/ontology/links"
      ) {
        body = { items: [] };
      } else if (url.pathname === "/api/v1/ontology/actions/4/steps") {
        body = { action_steps: [], nextCursor: "unexpected-page" };
      } else {
        body = {};
      }
      return { ok: true, json: async () => body } as Response;
    });
    await expect(
      new AllmetaOntologySource(cfg).fetchOntology("Agents-generation"),
    ).rejects.toThrow(/action steps endpoint advertised pagination/);

    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      const body =
        url.pathname === "/api/domains"
          ? { domains: [{ id: "Agents-generation" }] }
          : { rules: [], nextCursor: "unexpected-page" };
      return { ok: true, json: async () => body } as Response;
    });
    await expect(
      new AllmetaOntologySource(cfg).fetchActionRules(
        "Agents-generation",
        "createJD",
      ),
    ).rejects.toThrow(/action rules endpoint advertised pagination/);
  });

  it("STRICT: throws when the domain has no actions (empty graph / unreachable)", async () => {
    stubFetch([
      ["/api/domains", { domains: [{ id: "Agents-generation" }] }],
      ["/api/v1/ontology/actions", { items: [] }],
      ["/api/v1/ontology/events", { items: [] }],
      ["/api/v1/ontology/objects", { items: [] }],
      ["/api/v1/ontology/rules", { items: [] }],
      ["/api/v1/ontology/links", { items: [] }],
    ]);
    const src = new AllmetaOntologySource(cfg);
    await expect(src.fetchOntology("Agents-generation")).rejects.toThrow(
      /未返回|本体读取失败/,
    );
  });

  // A refusal keeps its REAL reason. `fetchOntology` re-wraps whatever escapes
  // the live read in a domain-level sentence; the reason it attaches used to be
  // `payload_contract` for anything that carried no typed reason of its own —
  // i.e. a defect in OUR normalizers was reported to the FDE as "the ontology
  // service returned content that violates the read contract", sending them to
  // audit data that was never at fault. An unknown cause is reported as unknown.
  it("attributes an untyped internal failure to itself, not to the ontology service", async () => {
    stubFetch([["/api/domains", { domains: [{ id: "Agents-generation" }] }]]);
    const src = new AllmetaOntologySource(cfg);
    // Whatever breaks inside the live read — here a platform-side TypeError —
    // reaches the same catch as a genuine upstream payload violation.
    (src as unknown as { fetchLive: () => Promise<never> }).fetchLive =
      async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'map')");
      };
    await expect(src.fetchOntology("Agents-generation")).rejects.toMatchObject({
      failure: "internal",
      transport: "allmeta",
    });
  });

  it("still reports a REAL payload-contract violation as payload_contract", async () => {
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/domains")) {
        return {
          ok: true,
          json: async () => ({ domains: [{ id: "Agents-generation" }] }),
        } as Response;
      }
      // The service answered 200 with a body that is not JSON at all.
      return {
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        },
      } as unknown as Response;
    });
    const src = new AllmetaOntologySource(cfg);
    await expect(src.fetchOntology("Agents-generation")).rejects.toMatchObject({
      failure: "payload_contract",
    });
  });

  it("listDomains keeps exact Allmeta provenance with every catalog identity", async () => {
    stubFetch([
      [
        "/api/domains",
        {
          domains: [
            { id: "Agents-generation", name: "Agents generation" },
            { id: "RAAS-v1" },
          ],
        },
      ],
    ]);
    const src = new AllmetaOntologySource(cfg);
    const ds = await src.listDomains();
    expect(ds).toEqual([
      {
        id: "Agents-generation",
        name: "Agents generation",
        source: "allmeta",
      },
      { id: "RAAS-v1", source: "allmeta" },
    ]);
  });

  it("fetchActionRules reads the per-action rules endpoint", async () => {
    stubFetch([
      ["/api/domains", { domains: [{ id: "Agents-generation" }] }],
      ["/rules", { rules: [{ id: "r1" }, { id: "r2" }] }],
    ]);
    const src = new AllmetaOntologySource(cfg);
    const rules = await src.fetchActionRules("Agents-generation", "createJD");
    expect(rules).toHaveLength(2);
  });
});

describe("CompositeOntologySource — routing", () => {
  const fakeManifest: OntologySource = {
    async listDomains() {
      return [{ id: "raas", name: "RAAS-v1", counts: { actions: 6 } }];
    },
    async fetchOntology(id) {
      return {
        domainId: id,
        objects: [],
        rules: [],
        actions: [],
        events: [],
        workflow: [],
        source: "snapshot",
      };
    },
    async fetchActionRules() {
      return ["manifest-rule"];
    },
  };
  const fakeAllmeta: OntologySource = {
    async listDomains() {
      return [{ id: "Agents-generation", name: "Agents generation" }];
    },
    async fetchOntology(id) {
      return {
        domainId: id,
        objects: [],
        rules: [],
        actions: [],
        events: [],
        workflow: [],
        source: "allmeta",
      };
    },
    async fetchActionRules() {
      return ["allmeta-rule"];
    },
  };
  const comp = new CompositeOntologySource(fakeAllmeta, fakeManifest);

  it("listDomains returns the union (deduped by normalized id)", async () => {
    const ids = (await comp.listDomains()).map((d) => d.id);
    expect(ids).toContain("raas");
    expect(ids).toContain("Agents-generation");
    expect(ids).toHaveLength(2);
  });

  it("routes a local domain to the manifest source", async () => {
    expect((await comp.fetchOntology("raas")).source).toBe("snapshot");
    expect(await comp.fetchActionRules("raas", "x")).toEqual(["manifest-rule"]);
  });

  it("routes an Allmeta-only domain to the live source (any casing)", async () => {
    expect((await comp.fetchOntology("Agents-generation")).source).toBe(
      "allmeta",
    );
    expect((await comp.fetchOntology("agents_generation")).source).toBe(
      "allmeta",
    );
    expect(await comp.fetchActionRules("Agents-generation", "x")).toEqual([
      "allmeta-rule",
    ]);
  });

  it("listDomains surfaces an authoritative Allmeta failure", async () => {
    const throwingAllmeta: OntologySource = {
      async listDomains() {
        throw new Error("down");
      },
      fetchOntology: fakeAllmeta.fetchOntology,
      fetchActionRules: fakeAllmeta.fetchActionRules,
    };
    const c2 = new CompositeOntologySource(throwingAllmeta, fakeManifest);
    await expect(c2.listDomains()).rejects.toThrow("down");
  });
});
