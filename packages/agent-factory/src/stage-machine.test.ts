import { describe, it, expect } from "vitest";
import { stageAdmission } from "./conductor";
import { ensureCoverage } from "./test-cases";
import type { BrainCtx } from "./brain-types";

// #W2-STAGE — admission gates: pipeline order enforced by structure, not prompt prose.
const mk = (over: Partial<Record<string, unknown>>): BrainCtx =>
  ({
    specs: [],
    ontology: null,
    currentPlan: null,
    lastValidation: null,
    lastSandbox: null,
    ...over,
  }) as unknown as BrainCtx;

describe("stageAdmission (#W2-STAGE)", () => {
  it("refuses design/plan tools before read_ontology, admits after", () => {
    expect(stageAdmission("create_plan", mk({}))).toMatch(/read_ontology/);
    expect(stageAdmission("design_agent", mk({}))).toMatch(/read_ontology/);
    const withOnt = mk({
      ontology: { actions: [], events: [], objects: [], rules: [] },
      currentPlan: { version: 1 },
    });
    expect(stageAdmission("create_plan", withOnt)).toBeNull();
    expect(stageAdmission("design_agent", withOnt)).toBeNull();
  });
  it("refuses design_agent without a plan; sandbox_run without validation; finish without sandbox evidence", () => {
    const ont = { actions: [], events: [], objects: [], rules: [] };
    expect(stageAdmission("design_agent", mk({ ontology: ont }))).toMatch(
      /create_plan/,
    );
    expect(
      stageAdmission("sandbox_run", mk({ ontology: ont, specs: [{}] })),
    ).toMatch(/validate_graph/);
    expect(
      stageAdmission(
        "sandbox_run",
        mk({
          ontology: ont,
          specs: [{}],
          lastValidation: { agentIssueMap: {} },
        }),
      ),
    ).toMatch(/ok=true/);
    expect(
      stageAdmission(
        "sandbox_run",
        mk({
          ontology: ont,
          specs: [{}],
          lastValidation: { ok: false, agentIssueMap: {} },
        }),
      ),
    ).toMatch(/ok=true/);
    expect(
      stageAdmission(
        "sandbox_run",
        mk({
          ontology: ont,
          specs: [{}],
          lastValidation: { ok: true, agentIssueMap: {} },
        }),
      ),
    ).toBeNull();
    expect(
      stageAdmission("finish", mk({ ontology: ont, specs: [{}] })),
    ).toMatch(/沙箱/);
    expect(
      stageAdmission(
        "finish",
        mk({ ontology: ont, specs: [{}], lastSandbox: { fullChainRan: true } }),
      ),
    ).toBeNull();
  });
  it("never gates non-stage tools (info/HITL/tool-smith)", () => {
    expect(stageAdmission("ask_user", mk({}))).toBeNull();
    expect(stageAdmission("list_domains", mk({}))).toBeNull();
    expect(stageAdmission("create_skill", mk({}))).toBeNull();
  });
});

// #W3-FAULT — coverage matrix now BACKFILLS fault cells for tooled entry agents.
describe("ensureCoverage fault backfill (#W3-FAULT)", () => {
  it("backfills a fault case with a __fault marker for a tooled entry agent", () => {
    const ctx = mk({
      ontology: { actions: [], events: [], objects: [], rules: [] },
      specs: [
        {
          actionName: "MatchResume",
          short: "MatchResume",
          nameZh: "匹配",
          tools: ["robohire.match"],
          trigger: ["RESUME_PROCESSED"],
          emit: ["MATCH_PASSED"],
          hitl: false,
        },
      ],
    });
    const { cases, coverage } = ensureCoverage(ctx, []);
    const fault = cases.find((c) => c.kind === "fault");
    expect(fault).toBeTruthy();
    expect(
      (fault!.payload as { __fault?: { tool: string; kind: string } }).__fault,
    ).toEqual({ tool: "robohire.match", kind: "timeout" });
    expect(fault!.payload._demo).toBe(true); // legacy event has no canonical event_data
    expect(
      coverage.backfilled.some((b) => b.startsWith("fault:MatchResume")),
    ).toBe(true);
    // happy cell for the entry event also backfilled
    expect(
      cases.some(
        (c) => c.kind === "pass" && c.entryEvent === "RESUME_PROCESSED",
      ),
    ).toBe(true);
  });

  it("keeps happy/fault backfills scoped to the entry event's canonical payload", () => {
    const ctx = mk({
      ontology: {
        actions: [],
        objects: [],
        rules: [],
        events: [
          {
            name: "RESUME_READY",
            payload: {
              source_action: null,
              event_data: [
                { name: "resume_file", type: "File", target_object: null },
              ],
              state_mutations: [],
            },
          },
          {
            name: "OTHER_ENTRY",
            payload: {
              source_action: null,
              event_data: [
                { name: "foreign_field", type: "String", target_object: null },
              ],
              state_mutations: [],
            },
          },
        ],
      },
      specs: [
        {
          actionName: "ParseResume",
          short: "ParseResume",
          nameZh: "解析",
          tools: ["parser"],
          trigger: ["RESUME_READY"],
          emit: ["PARSED"],
          hitl: false,
        },
      ],
    });
    const { cases } = ensureCoverage(ctx, []);
    const scoped = cases.filter(
      (testCase) => testCase.entryEvent === "RESUME_READY",
    );
    expect(scoped).toHaveLength(2);
    for (const testCase of scoped) {
      expect(testCase.payload).toHaveProperty("resume_file");
      expect(testCase.payload).not.toHaveProperty("foreign_field");
    }
  });
});
