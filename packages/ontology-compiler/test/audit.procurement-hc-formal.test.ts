/**
 * Static audit of the 29 compiled 采购-HC-Formal agents.
 *
 * The golden test pins the compiler's OUTPUT; this one asks whether that
 * output is internally consistent code: every event has a producer or is a
 * declared entry point, every emitted event has a consumer or is a declared
 * leaf, every ERP operation an agent may call exists in the catalog AND in
 * the mock data plane, every `depends_on` / `results.<key>` reference names a
 * step of the same agent, every human form is well-formed, every gate reads a
 * field the trigger can actually carry, and every analysis prompt names the
 * fields its output contract promises. A typo in the overlay that the schema
 * accepts (a gate on `input.planer_confirmed_by`, an emission from
 * `results.derivePurchaseSchedul`) fails here instead of in production.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateCondition } from "@agentic/runtime";
import type { CompiledAgent, CompiledStep, CompilerOverlay } from "../src/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..", "..", "..");
const MODELS = path.join(REPO_ROOT, "models", "procurement-hc-formal-v1");
const PACKAGE = path.join(REPO_ROOT, "ontology-packages", "procurement-hc-formal", "package");
const OVERLAY = path.join(REPO_ROOT, "overlays", "procurement-hc-formal.json");
const EFFECTS = path.join(REPO_ROOT, "apps", "mock-erp", "src", "effects.ts");

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

const rawWorkflow = readJson<CompiledAgent[] | { agents: CompiledAgent[] }>(path.join(MODELS, "workflow_v1.json"));
const agents: CompiledAgent[] = Array.isArray(rawWorkflow) ? rawWorkflow : rawWorkflow.agents;
const events = (readJson<{ events: Array<{ name: string; payload?: { event_data?: Array<{ name: string; required?: boolean }> } }> }>(
  path.join(MODELS, "events_v1.json"),
)).events;
const catalog = readJson<{ operations: Array<{ operation_id: string; kind: "query" | "write" }> } | Array<{ operation_id: string; kind: "query" | "write" }>>(
  path.join(MODELS, "erp-operations.json"),
);
const operations = Array.isArray(catalog) ? catalog : catalog.operations;
const mockIndex = readJson<{ endpoints: Array<{ operation: string; entity: string }> }>(path.join(PACKAGE, "mock-erp", "_index.json"));
const overlay = readJson<CompilerOverlay>(OVERLAY);
const mockEffectOps = new Set(
  [...readFileSync(EFFECTS, "utf8").matchAll(/^  ([A-Za-z]+): \(store, _?payload\) =>/gm)].map((m) => m[1]!),
);

const byName = new Map(agents.map((agent) => [agent.name, agent]));
const producers = new Map<string, string[]>();
const consumers = new Map<string, string[]>();
for (const agent of agents) {
  for (const event of agent.triggered_event) producers.set(event, [...(producers.get(event) ?? []), agent.name]);
  for (const event of agent.trigger) consumers.set(event, [...(consumers.get(event) ?? []), agent.name]);
}
const eventFields = new Map(events.map((event) => [event.name, (event.payload?.event_data ?? []).map((field) => field.name)]));

/** ERP operations an agent may invoke: pinned config, or the merged enum. */
function erpOperationsOf(agent: CompiledAgent): string[] {
  const ops: string[] = [];
  for (const entry of agent.tool_use) {
    if (entry.name !== "metaerp.invoke") continue;
    if (entry.config.operation) ops.push(entry.config.operation);
    const enumOps = (entry.input_schema as { properties?: { operation?: { enum?: string[] } } } | undefined)?.properties?.operation?.enum;
    if (enumOps) ops.push(...enumOps);
  }
  return ops;
}

/** `results.<key>` and `results.<key>.<field>` references inside a data path. */
function resultRefs(pathExpr: string): string[] {
  return [...pathExpr.matchAll(/results\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
}

describe("采购-HC-Formal · static audit of the 29 compiled agents", () => {
  it("has exactly 29 generated agents, each with retries, a zh title and an en title", () => {
    expect(agents).toHaveLength(29);
    for (const agent of agents) {
      expect(agent.generated, agent.name).toBe(true);
      expect(agent.retries, agent.name).toBeGreaterThanOrEqual(0);
      expect(agent.title_i18n?.zh, agent.name).toBeTruthy();
      expect(agent.title_i18n?.en, agent.name).toBeTruthy();
      expect(agent.title, agent.name).toBe(agent.title_i18n?.zh);
    }
  });

  it("event graph: every trigger is produced by an agent or is a declared external entry; every emitted event is consumed or is a declared leaf", () => {
    const entries = [...consumers.keys()].filter((event) => !producers.has(event)).sort();
    const leaves = [...producers.keys()].filter((event) => !consumers.has(event)).sort();
    // Entry points: the three schedules plus three signals the ERP itself
    // raises (a plan approved / submitted for approval / a procurement
    // document changing status). Nothing inside the workflow produces them.
    expect(entries).toEqual([
      "ALERT_TIMEOUT_SCAN_SCHEDULED",
      "DAILY_DEMAND_PLAN_SCAN_SCHEDULED",
      "DAILY_DEVIATION_SCAN_SCHEDULED",
      "DEMAND_PLAN_APPROVED",
      "DEMAND_PLAN_SUBMITTED_FOR_APPROVAL",
      "PROCUREMENT_DOCUMENT_STATUS_CHANGED",
    ]);
    // Leaves are end-of-chain facts (archived / submitted / returned /
    // recycled …) plus two informational emissions (the raw deviation
    // calculation, the schedule conflict notice). Anything new here means an
    // emitted event nobody listens to — check it is intended before adding.
    expect(leaves).toEqual([
      "BLUE_ALERT_SELF_HANDLED",
      "CHAIN_MONITORING_ARCHIVED",
      "EXECUTION_DEVIATION_CALCULATED",
      "FALSE_ALARM_RECYCLED",
      "INVENTORY_AVAILABILITY_VERIFIED",
      "INVENTORY_TRANSFER_ORDER_CREATED",
      "PLAN_RETURNED_FOR_RECTIFICATION",
      "PLAN_SUBMITTED_FOR_APPROVAL",
      "SCHEDULE_TIME_CONFLICT_DETECTED",
      "THRESHOLD_REVIEW_ITEM_CREATED",
    ]);
    // PLAN_AND_PACKAGE_REJECTED is consumed (it re-enters packaging), so it
    // must NOT be a leaf.
    expect(consumers.has("PLAN_AND_PACKAGE_REJECTED")).toBe(true);
    // Every event an agent names is declared in the package's event family.
    const declared = new Set(events.map((event) => event.name));
    for (const agent of agents) {
      for (const event of [...agent.trigger, ...agent.triggered_event]) {
        expect(declared.has(event), `${agent.name} names undeclared event ${event}`).toBe(true);
      }
    }
  });

  it("every ERP operation an agent may call is in the catalog, and the mock data plane implements it (effect for writes, table for queries)", () => {
    const catalogByOp = new Map(operations.map((op) => [op.operation_id, op]));
    const mockQueryOps = new Set(mockIndex.endpoints.map((endpoint) => endpoint.operation));
    for (const agent of agents) {
      for (const op of erpOperationsOf(agent)) {
        const entry = catalogByOp.get(op);
        expect(entry, `${agent.name} calls ${op}, which is not in erp-operations.json`).toBeDefined();
        if (entry!.kind === "write") {
          expect(mockEffectOps.has(op), `${agent.name} writes ${op}, but apps/mock-erp has no effect for it`).toBe(true);
        } else {
          expect(mockQueryOps.has(op), `${agent.name} queries ${op}, but the mock data plane has no table for it`).toBe(true);
        }
      }
      for (const entry of agent.tool_use) {
        expect(entry.execution_policy, `${agent.name}/${entry.name} lacks a reviewed execution_policy`).toBeDefined();
        if (entry.name === "metaerp.invoke") {
          expect(entry.config.catalog_path).toBe("models/procurement-hc-formal-v1/erp-operations.json");
          expect(entry.config.base_url_env).toBe("METAERP_BASE_URL");
        }
      }
    }
  });

  it("every write step is a tool step with the reviewed failure ladder, and every tool step names exactly its own tool", () => {
    for (const agent of agents) {
      for (const step of agent.actions) {
        if (step.type !== "tool") continue;
        expect(step.allowed_tools, `${agent.name}/${step.name}`).toEqual([step.name]);
        expect(agent.tool_use.some((entry) => entry.name === step.name), `${agent.name} dispatches ${step.name} without allow-listing it`).toBe(true);
        if (step.name === "metaerp.invoke") {
          expect(Array.isArray(step.on_error), `${agent.name}: ERP write without a failure ladder`).toBe(true);
        }
        if (step.name === "control.fail") {
          expect(step.on_error, `${agent.name}: control.fail must be terminal`).toBe("terminal");
          expect(step.depends_on?.length, `${agent.name}: control.fail must sit behind a blocked-when condition`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("depends_on, tool_arguments and emit_payload_from only reference steps that exist earlier in the same agent", () => {
    for (const agent of agents) {
      const seen = new Set<string>();
      for (const step of agent.actions) {
        for (const dep of step.depends_on ?? []) {
          expect(seen.has(dep), `${agent.name}/${step.name} depends_on ${dep}, which is not an earlier step`).toBe(true);
        }
        for (const [arg, source] of Object.entries(step.tool_arguments ?? {})) {
          if ("from" in source) {
            for (const ref of resultRefs(source.from)) {
              expect(seen.has(ref), `${agent.name}/${step.name} argument ${arg} reads results.${ref}, which is not an earlier step`).toBe(true);
            }
            expect(
              /^(event\.data|input|lastResult|results\.)/.test(source.from),
              `${agent.name}/${step.name} argument ${arg} reads an unknown root: ${source.from}`,
            ).toBe(true);
          }
        }
        if (step.emit_payload_from) {
          for (const ref of resultRefs(step.emit_payload_from)) {
            expect(seen.has(ref), `${agent.name}/${step.name} emits from results.${ref}, which is not an earlier step`).toBe(true);
          }
        }
        if (step.condition) {
          for (const ref of resultRefs(step.condition)) {
            expect(seen.has(ref), `${agent.name}/${step.name} condition reads results.${ref}, which is not an earlier step`).toBe(true);
          }
        }
        if (step.result_key) seen.add(step.result_key);
      }
      // Every declared emission is one of the agent's triggered events.
      for (const step of agent.actions) {
        if (step.emit_event) {
          expect(agent.triggered_event, `${agent.name} emits ${step.emit_event} it does not declare`).toContain(step.emit_event);
        }
      }
    }
  });

  it("human steps carry a role, a task type and a form whose required fields exist", () => {
    for (const agent of agents) {
      for (const step of agent.actions) {
        if (step.type !== "manual") continue;
        expect(step.awaiting_role, `${agent.name}/${step.name} has no awaiting_role`).toBeTruthy();
        expect(step.task_type, `${agent.name}/${step.name} has no task_type`).toBeTruthy();
        const schema = step.form_schema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
        expect(schema?.properties, `${agent.name}/${step.name} has no form properties`).toBeDefined();
        for (const field of schema?.required ?? []) {
          expect(schema!.properties, `${agent.name}/${step.name} requires ${field} but does not declare it`).toHaveProperty(field);
        }
      }
    }
  });

  it("every gate reads a field the trigger can carry: declared on the event, promised by an upstream contract, or minted by the upstream write", () => {
    // Fields the mock ERP effects place in the contexts they emit and the
    // human forms feed forward; not derivable from the ontology text.
    const mintedUpstream = new Set([
      "planner_confirmed_by", "option_type", "option_id", "alert_level", "alert_id", "chain_id",
      "verification_result", "selected_by", "package_scheme_id", "stock_check_flag", "is_urgent_demand",
      "decision", "deviation_id", "notified_role",
    ]);
    for (const agent of agents) {
      const upstreamFields = new Set<string>();
      for (const event of agent.trigger) {
        for (const field of eventFields.get(event) ?? []) upstreamFields.add(field);
        for (const producer of producers.get(event) ?? []) {
          for (const field of Object.keys(overlay.output_contracts?.[producer]?.fields ?? {})) upstreamFields.add(field);
          // A producer's emit payload can be a nested context object; its
          // contract text names the keys inside — accept them too.
          for (const text of Object.values(overlay.output_contracts?.[producer]?.fields ?? {})) {
            for (const key of text.matchAll(/\b([a-z][a-z0-9_]{2,})\b/g)) upstreamFields.add(key[1]!);
          }
        }
      }
      for (const step of agent.actions) {
        if (step.type !== "condition" || !step.condition) continue;
        if (!/^(rule-gate|submission-gate):/.test(step.name)) continue;
        for (const match of step.condition.matchAll(/input\.([A-Za-z0-9_]+)/g)) {
          const field = match[1]!;
          expect(
            upstreamFields.has(field) || mintedUpstream.has(field),
            `${agent.name}/${step.name} gates on input.${field}, which nothing upstream declares`,
          ).toBe(true);
        }
      }
    }
  });

  it("every analysis prompt names each field its output contract promises, and only calls tools the agent allow-lists", () => {
    for (const agent of agents) {
      const contractFields = Object.keys(overlay.output_contracts?.[agent.name]?.fields ?? {});
      const logic = agent.actions.filter((step) => step.type === "logic");
      if (contractFields.length === 0) continue;
      expect(logic.length, `${agent.name} has an output contract but no analysis step`).toBeGreaterThan(0);
      const prompt = logic.map((step) => step.action_prompt ?? "").join("\n");
      for (const field of contractFields) {
        expect(prompt.includes(`"${field}"`) || prompt.includes(`${field}:`) || prompt.includes(`- ${field}`), `${agent.name}: prompt never names contract field ${field}`).toBe(true);
      }
      for (const step of logic) {
        for (const tool of step.allowed_tools ?? []) {
          expect(agent.tool_use.some((entry) => entry.name === tool), `${agent.name}/${step.name} allows ${tool} which is not in tool_use`).toBe(true);
        }
      }
    }
  });

  it("scan_date contract: every scan-dated analysis agent fails when it echoes a different business date than its trigger, and stays quiet when the trigger carries none", () => {
    const scanDated = [
      "collectChainExecutionData",
      "calculateExecutionDeviation",
      "scoreOnTimeProbability",
      "scanApprovedDemandPlan",
      "analyzeDemandMerge",
      "verifyInventoryAvailability",
      "derivePurchaseSchedule",
      "auditAnnualPlanCompliance",
      "recommendPackagingScheme",
    ];
    for (const name of scanDated) {
      const gate = byName.get(name)!.actions.find((step) => step.name === "blocked-when:scan_date_mismatch");
      expect(gate?.condition, name).toBe("event.data.scan_date && lastResult.scan_date != event.data.scan_date");
      const when = gate!.condition!;
      // 2026-09-08 live run: the model wrote the data's sync date instead of the event's scan date.
      expect(evaluateCondition(when, { lastResult: { scan_date: "2026-08-19" }, event: { name: "X", data: { scan_date: "2026-09-08" } } })).toBe(true);
      expect(evaluateCondition(when, { lastResult: { scan_date: "2026-09-08" }, event: { name: "X", data: { scan_date: "2026-09-08" } } })).toBe(false);
      // A required field left out is a violation too.
      expect(evaluateCondition(when, { lastResult: {}, event: { name: "X", data: { scan_date: "2026-09-08" } } })).toBe(true);
      // Triggers that carry no scan_date (ERP status changes, plan approvals) are not gated.
      expect(evaluateCondition(when, { lastResult: { scan_date: "2026-09-08" }, event: { name: "X", data: {} } })).toBe(false);
    }
  });

  it("blocking outcomes: each declared one compiled to a condition + terminal control.fail with a reason path into the analysis result", () => {
    for (const [agentName, outcomes] of Object.entries(overlay.blocking_outcomes ?? {})) {
      const agent = byName.get(agentName);
      expect(agent, agentName).toBeDefined();
      for (const outcome of outcomes) {
        const gate = agent!.actions.find((step) => step.name === `blocked-when:${outcome.code}`);
        expect(gate?.condition, `${agentName}/${outcome.code} gate`).toBe(outcome.when);
        const stop = agent!.actions.find(
          (step: CompiledStep) => step.name === "control.fail" && step.depends_on?.includes(`blocked-when-${outcome.code}`),
        );
        expect(stop, `${agentName}/${outcome.code} control.fail`).toBeDefined();
        const message = stop!.tool_arguments?.message;
        expect(message, `${agentName}/${outcome.code} message`).toBeDefined();
        if (message && "from" in message) expect(message.from.startsWith("lastResult.") || message.from.startsWith("results.")).toBe(true);
      }
    }
  });
});
