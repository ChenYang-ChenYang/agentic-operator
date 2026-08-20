import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS, SUBAGENT_TOOLS } from "./tools";
import type { BrainCtx } from "./brain-types";
import type { DomainOntology } from "./ontology-types";

// #LINK-GRAPH — read_ontology reports `links: <count>`, so the compiled typed
// relationship graph was fetched and discarded. This tool is the brain's only
// way to see the real edges before it designs against them.
const queryLinks = FACTORY_TOOLS.find((t) => t.name === "query_links")!;

const ontology = (overrides: Partial<DomainOntology> = {}): DomainOntology =>
  ({
    domainId: "D",
    source: "allmeta",
    objects: [
      { id: "Job_Requisition", name: "Job_Requisition" },
      { id: "Job_Posting", name: "Job_Posting" },
      { id: "Client", name: "Client" },
    ],
    actions: [
      {
        id: "1",
        name: "createJD",
        actor: ["Agent"],
        trigger: ["requisition.approved"],
        triggered_event: ["jd.generated"],
        target_objects: ["Job_Requisition"],
        tool_use: [],
        system_prompt: "",
        user_prompt: "",
      },
    ],
    events: [{ name: "requisition.approved" }, { name: "jd.generated" }],
    rules: [],
    workflow: [],
    links: [
      {
        id: "object-fk/Job_Posting/Job_Requisition",
        kind: "object-fk",
        from: { id: "Job_Posting", type: "DataObject" },
        to: { id: "Job_Requisition", type: "DataObject" },
      },
      {
        id: "object-fk/Job_Requisition/Client",
        kind: "object-fk",
        from: { id: "Job_Requisition", type: "DataObject" },
        to: { id: "Client", type: "DataObject" },
      },
      {
        id: "action-targets-object/createJD/Job_Requisition",
        kind: "action-targets-object",
        from: { id: "createJD", type: "Action" },
        to: { id: "Job_Requisition", type: "DataObject" },
      },
    ],
    ...overrides,
  }) as DomainOntology;

const ctx = (ont: DomainOntology | null): BrainCtx =>
  ({ ontology: ont }) as unknown as BrainCtx;

describe("query_links", () => {
  it("is available to the brain and to read-only sub-agents", () => {
    expect(queryLinks).toBeTruthy();
    expect(SUBAGENT_TOOLS.map((t) => t.name)).toContain("query_links");
  });

  it("summarizes the real graph — kinds, hubs, chains — with no filter", async () => {
    const r = await queryLinks.execute({}, ctx(ontology()));
    expect(r.ok).toBe(true);
    const out = r.output as {
      hasLinkGraph: boolean;
      relationshipKinds: Array<{ kind: string; count: number }>;
      hubs: Array<{ id: string }>;
    };
    expect(out.hasLinkGraph).toBe(true);
    expect(out.relationshipKinds.find((k) => k.kind === "object-fk")?.count).toBe(2);
    // Job_Requisition is the busiest node: two edges in, one out.
    expect(out.hubs[0]?.id).toBe("Job_Requisition");
    expect(r.summary).toContain("object-fk ×2");
  });

  it("returns one entity's actual inbound and outbound edges", async () => {
    const r = await queryLinks.execute(
      { node: "Job_Requisition" },
      ctx(ontology()),
    );
    expect(r.ok).toBe(true);
    const out = r.output as { matched: number; edges: Array<{ id: string }> };
    expect(out.matched).toBe(3);
    expect(out.edges.map((e) => e.id)).toContain(
      "action-targets-object/createJD/Job_Requisition",
    );
  });

  it("honours direction so 'what points at me' differs from 'what I point at'", async () => {
    const inbound = await queryLinks.execute(
      { node: "Job_Requisition", direction: "in" },
      ctx(ontology()),
    );
    const outbound = await queryLinks.execute(
      { node: "Job_Requisition", direction: "out" },
      ctx(ontology()),
    );
    expect((inbound.output as { matched: number }).matched).toBe(2);
    expect((outbound.output as { matched: number }).matched).toBe(1);
    expect(
      (outbound.output as { edges: Array<{ to: string }> }).edges[0]?.to,
    ).toBe("Client");
  });

  it("filters by relationship kind", async () => {
    const r = await queryLinks.execute({ kind: "object-fk" }, ctx(ontology()));
    expect((r.output as { matched: number }).matched).toBe(2);
  });

  it("refuses an unknown node instead of returning a misleading empty result", async () => {
    const r = await queryLinks.execute({ node: "Candidat" }, ctx(ontology()));
    expect(r.ok).toBe(false);
    const out = r.output as { reason: string; knownNodes: string[] };
    expect(out.reason).toBe("unknown_node");
    expect(out.knownNodes).toContain("Job_Requisition");
  });

  it("says plainly when the source supplied no graph, rather than implying none exists", async () => {
    const r = await queryLinks.execute(
      {},
      ctx(ontology({ links: undefined })),
    );
    expect(r.ok).toBe(true);
    expect((r.output as { hasLinkGraph: boolean }).hasLinkGraph).toBe(false);
    expect(r.summary).toContain("没有提供编译好的关系图");
  });

  it("requires read_ontology first", async () => {
    const r = await queryLinks.execute({}, ctx(null));
    expect(r.ok).toBe(false);
    expect((r.output as { next: string }).next).toBe("read_ontology");
  });

  it("caps the payload but reports the true match count", async () => {
    const many = ontology({
      links: Array.from({ length: 150 }, (_, i) => ({
        id: `object-fk/O${i}/Job_Requisition`,
        kind: "object-fk",
        from: { id: `O${i}`, type: "DataObject" },
        to: { id: "Job_Requisition", type: "DataObject" },
      })),
    } as unknown as Partial<DomainOntology>);
    const r = await queryLinks.execute(
      { node: "Job_Requisition", limit: 10 },
      ctx(many),
    );
    const out = r.output as { matched: number; returned: number };
    expect(out.matched).toBe(150);
    expect(out.returned).toBe(10);
  });
});
