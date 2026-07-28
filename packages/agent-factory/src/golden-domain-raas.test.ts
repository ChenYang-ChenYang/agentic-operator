// Golden-domain regression suite — RAAS-v1 as the benchmark for the generator.
//
// Six battle-tested production agents (~4,900 lines plus ~1,900 lines of their
// own tests) define what an agent for these Ontology Actions must guarantee. The
// generator produced six agents for the same Actions from the Agents-generation
// Ontology. This suite states each production guarantee as a check against the
// generator's OUTPUT — so it fails when the GENERATOR regresses, not when some
// draft artifact on disk drifts.
//
// Committed specs, no network, no LLM, no database. Layer 1 reads the spec;
// Layer 2 renders through the real renderer and inspects the emitted TypeScript.
//
// The suite is RATCHETED: baseline.json records the ids that pass today, and the
// run fails only on regression or on an id disappearing. Fixing a generator
// defect flips rows and requires an explicit baseline bump — which is what makes
// progress reviewable instead of merely assertable.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { renderTsFunctionModule } from "./ts-function-module";
import { validatePlan } from "./plan-projection";
import type { GeneratedAgentSpec, PlanStep } from "./spec-types";
import {
  ALL_AGENTS,
  GOLDEN_ASSERTIONS,
  type GoldenAssertion,
} from "./__fixtures__/golden-domain-raas/assertions";
import {
  CLIENT_IDENTITY_FIELDS,
  TOOL_CONTRACTS,
} from "./__fixtures__/golden-domain-raas/tool-contracts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "__fixtures__", "golden-domain-raas");
const BASELINE_PATH = join(FIXTURES, "baseline.json");

function loadSpec(agent: string): GeneratedAgentSpec {
  const raw = readFileSync(join(FIXTURES, "specs", `${agent}.json`), "utf8");
  return (JSON.parse(raw) as { spec: GeneratedAgentSpec }).spec;
}

const SPECS = new Map(ALL_AGENTS.map((a) => [a, loadSpec(a)] as const));
const RENDERED = new Map(
  ALL_AGENTS.map((a) => [a, renderTsFunctionModule(SPECS.get(a)!)] as const),
);

function plan(spec: GeneratedAgentSpec): PlanStep[] {
  return Array.isArray(spec.plan) ? spec.plan : [];
}

/** Every string value reachable in a step's tool arguments. */
function argValues(step: PlanStep): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk((step as { toolArguments?: unknown }).toolArguments);
  return out;
}

// ── Layer 2 helpers: read the rendered module as a syntax tree ─────────────

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile("agent.ts", code, ts.ScriptTarget.ES2022, true);
}

function collectCalls(
  src: ts.SourceFile,
  matcher: (name: string) => boolean,
): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const text = node.expression.getText(src);
      if (matcher(text)) found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return found;
}

/**
 * The first argument of a durable step call, with `idSuffix(mapped, "input.*")`
 * constant-folded to the empty string it actually produces at run time.
 */
function durableId(call: ts.CallExpression, src: ts.SourceFile): string | null {
  const arg = call.arguments[0];
  if (!arg) return null;
  const text = arg.getText(src);
  // `idSuffix(<scope>, "input.x")` resolves at run time; fold every call to the
  // empty string it produced while the scope was wrong, so a suite run can tell
  // "these ids are distinct" from "these ids only look distinct in source".
  return text.replace(/idSuffix\([\s\S]*?\)\s*$/g, '""');
}

function objectLiteralProperty(
  call: ts.CallExpression,
  src: ts.SourceFile,
  name: string,
): ts.Expression | null {
  for (const arg of call.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const prop of arg.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        prop.name.getText(src).replace(/["']/g, "") === name
      ) {
        return prop.initializer;
      }
    }
  }
  return null;
}

/** Own keys of an object literal (spreads are reported separately). */
function ownKeys(expr: ts.Expression, src: ts.SourceFile): string[] {
  if (!ts.isObjectLiteralExpression(expr)) return [];
  return expr.properties.flatMap((p) =>
    ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)
      ? [p.name!.getText(src).replace(/["']/g, "")]
      : [],
  );
}

// ── the checks, keyed by the assertion-id suffix they satisfy ──────────────

type Probe = {
  agent: string;
  spec: GeneratedAgentSpec;
  code: string;
  src: ts.SourceFile;
};

type Check = (p: Probe) => void;

const UNIVERSAL_CHECKS: Record<string, Check> = {
  "trigger-events-are-ontology-events": ({ spec }) => {
    expect(Array.isArray(spec.trigger)).toBe(true);
    expect(spec.trigger!.length).toBeGreaterThan(0);
    for (const t of spec.trigger!) expect(typeof t).toBe("string");
  },

  "retries-are-declared": ({ spec, code }) => {
    expect(typeof spec.retries).toBe("number");
    expect(code).toContain("retries");
  },

  "plan-passes-generator-validator": ({ spec }) => {
    const result = validatePlan(plan(spec), {
      knownTools: spec.tools ?? [],
      declaredEvents: spec.emit ?? [],
    });
    expect(result.errors, result.errors.join("; ")).toEqual([]);
  },

  "no-unresolved-template-literal-on-the-wire": ({ code }) => {
    // `{{...}}` in the rendered module means a descriptor was inlined verbatim
    // and will travel to a downstream consumer as a literal string.
    const hits = code.match(/\{\{[^}]+\}\}/g) ?? [];
    expect(hits).toEqual([]);
  },

  "durable-step-ids-are-distinct": ({ code, src }) => {
    const calls = collectCalls(
      src,
      (n) =>
        n === "step.run" || n === "step.invoke" || n === "step.sendEvent",
    );
    const ids = calls
      .map((c) => durableId(c, src))
      .filter((v): v is string => v !== null);
    expect(ids.length).toBeGreaterThan(0);
    void code;
    expect(new Set(ids).size).toBe(ids.length);
  },

  "invoke-payload-descriptors-resolved": ({ src }) => {
    // The payload reaches the callee through a helper, so search the whole
    // call for the `invokeInput` property rather than only its direct args.
    for (const call of collectCalls(src, (n) => n === "step.invoke")) {
      const payload = findProperty(call, src, "invokeInput");
      if (!payload || !ts.isObjectLiteralExpression(payload)) continue;
      for (const prop of payload.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const init = prop.initializer;
        if (!ts.isObjectLiteralExpression(init)) continue;
        const keys = ownKeys(init, src);
        expect(
          keys.includes("from") || keys.includes("const"),
          `${prop.name.getText(src)} reaches the callee as a literal {${keys.join(",")}} descriptor instead of a resolved value`,
        ).toBe(false);
      }
    }
  },

  "required-inputs-guarded-before-side-effects": ({ code, spec }) => {
    const required = (spec.inputSchema ?? []).filter((f) => f?.required);
    if (required.length === 0) return;
    // The guard must exist AND precede the first durable step.
    const guardAt = code.search(/missing required input anchors/);
    expect(guardAt, "no required-input guard is rendered").toBeGreaterThan(-1);
    const firstStepAt = code.search(/await step\.(run|invoke|sendEvent)\(/);
    expect(guardAt).toBeLessThan(firstStepAt);
  },

  "declared-failure-emit-is-reachable": ({ code }) => {
    // Structural property of the RENDERER, checked per failure block: inside one
    // step's error resolution, the declared `emitEvent` send must come BEFORE
    // the terminal/retry throws. Behind them it is dead code on every terminal
    // path, so a declared failure event can never leave the process.
    const blocks = splitFailureBlocks(code);
    expect(blocks.length, "no failure resolution is rendered").toBeGreaterThan(
      0,
    );
    for (const block of blocks) {
      const emitAt = block.indexOf("_resolution.emitEvent");
      const terminalAt = block.indexOf('_resolution.disposition === "terminal"');
      if (emitAt === -1 || terminalAt === -1) continue;
      expect(
        emitAt < terminalAt,
        "the declared failure emit sits after the terminal throw, so it is dead code",
      ).toBe(true);
    }
  },

  "quota-failures-park-not-terminal": ({ code }) => {
    // 402 / out-of-funds self-heals on top-up: it must park for retry.
    const quotaLine = code
      .split("\n")
      .find((l) => l.includes("402") && l.includes("return"));
    expect(quotaLine, "no 402 classification is rendered").toBeTruthy();
    expect(quotaLine).toContain('"park"');
  },

  "failure-event-never-reuses-a-business-verdict": ({ code, spec }) => {
    const failEmit = outerCatchEmit(code);
    if (!failEmit) return;
    // A run error is not a business verdict. Reusing an alternate BUSINESS route
    // as the generic failure event turns an HTTP 401 into, say, a permanent
    // candidate rejection — carrying none of the evidence that decision needs.
    expect(
      /_(FAILED|ERROR|REJECTED|DENIED)$/.test(failEmit),
      `${failEmit} is a business verdict but is emitted for any run error`,
    ).toBe(true);
    // And it must never be an event this agent never declared.
    const declared = (spec.emit ?? []).filter(Boolean);
    const synthesized = !declared.includes(failEmit);
    expect(
      !synthesized || /_(FAILED|ERROR)$/.test(failEmit),
      `${failEmit} is emitted but appears nowhere in spec.emit`,
    ).toBe(true);
  },
};

/** One text block per rendered per-step error resolution. */
function splitFailureBlocks(code: string): string[] {
  const parts = code.split("const _resolution = _afResolveFailure(");
  return parts
    .slice(1)
    .map((part) => part.split("last = _resolution.defaultResult;")[0] ?? part);
}

/** The event name the handler's outer catch emits for any unclassified error. */
function outerCatchEmit(code: string): string | null {
  const at = code.lastIndexOf('if (kind === "park"');
  if (at === -1) return null;
  const tail = code.slice(at);
  return tail.match(/step\.sendEvent\([^,]+,\s*\{\s*name:\s*"([^"]+)"/)?.[1] ?? null;
}

/** Find a property assignment by name anywhere inside a call expression. */
function findProperty(
  call: ts.CallExpression,
  src: ts.SourceFile,
  name: string,
): ts.Expression | null {
  let found: ts.Expression | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(src).replace(/["']/g, "") === name
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(call, visit);
  return found;
}

const PER_AGENT_CHECKS: Record<string, Check> = {
  "createjd-no-client-org-name-outbound": ({ spec }) => {
    for (const step of plan(spec)) {
      if ((step as { kind?: string }).kind !== "tool") continue;
      for (const value of argValues(step)) {
        for (const forbidden of CLIENT_IDENTITY_FIELDS) {
          expect(
            value.includes(forbidden),
            `${(step as { stepId?: string }).stepId} sends ${forbidden} to an external system, which rule 4-2 forbids`,
          ).toBe(false);
        }
      }
    }
  },

  "createjd-rulerefs-are-fetched-before-use": ruleFetchCheck,
  "processresume-rulerefs-are-fetched-before-use": ruleFetchCheck,
  "rulecheck-rulerefs-are-fetched-before-use": ruleFetchCheck,
  "identity-rulerefs-are-fetched-before-use": ruleFetchCheck,

  "match-routing-is-deterministic": deterministicRouting,
  "rulecheck-routing-is-deterministic": deterministicRouting,
  "invite-routing-is-deterministic": deterministicRouting,
  "processresume-routing-is-deterministic": deterministicRouting,

  "match-condition-steps-are-consumed": conditionsConsumed,
  "rulecheck-condition-steps-are-consumed": conditionsConsumed,

  "identity-returns-business-verdict": ({ code }) => {
    const ret = code.match(/return \{\s*ok:[^}]*\}/)?.[0] ?? "";
    expect(
      ret.replace(/\s/g, "") !== "return{ok:decision.pass!==false&&decision.ok!==false}",
      "the handler returns only {ok}, so a caller can read no business verdict",
    ).toBe(true);
  },

  "createjd-emit-projects-declared-outputs": emitProjectsOutputs,
  "match-emit-projects-declared-outputs": emitProjectsOutputs,
  "invite-emit-projects-declared-outputs": emitProjectsOutputs,

  "createjd-anchor-reads-envelope-positions": anchorEnvelopePositions,
  "invite-anchor-reads-envelope-positions": anchorEnvelopePositions,

  "processresume-compensates-on-terminal": ({ spec }) => {
    const writes = (
      (spec as { stateBindings?: Array<{ writes?: string[] }> }).stateBindings ??
      []
    ).flatMap((b) => b.writes ?? []);
    if (writes.length === 0) return;
    const compensates = plan(spec).some((step) =>
      (
        (step as { onError?: Array<{ compensate?: unknown }> }).onError ?? []
      ).some((rule) => rule.compensate),
    );
    expect(
      compensates,
      "stateBindings declares a lifecycle write that no terminal path performs",
    ).toBe(true);
  },

  "processresume-ontology-step-conditions-materialised": ({ spec }) => {
    // Every step the Ontology gates must carry a condition or depend on one.
    const steps = plan(spec);
    const gated = steps.filter((s) =>
      /download|parse/i.test((s as { stepId?: string }).stepId ?? ""),
    );
    expect(gated.length).toBeGreaterThan(0);
    for (const step of gated) {
      const s = step as { condition?: unknown; dependsOn?: string[] };
      const dependsOnCondition = (s.dependsOn ?? []).some((dep) =>
        steps.some(
          (o) =>
            (o as { stepId?: string }).stepId === dep &&
            (o as { kind?: string }).kind === "condition",
        ),
      );
      expect(
        Boolean(s.condition) || dependsOnCondition,
        `${(step as { stepId?: string }).stepId} is ungated, so a legacy event that already carries parsed data pays for a second vendor parse`,
      ).toBe(true);
    }
  },

  "rulecheck-per-item-verdict": ({ spec }) => {
    const steps = plan(spec);
    const foreach = steps.find((s) => (s as { kind?: string }).kind === "foreach");
    if (!foreach) return;
    const body = ((foreach as { body?: PlanStep[] }).body ?? []) as PlanStep[];
    const emitsInside = body.some((s) => (s as { kind?: string }).kind === "emit");
    expect(
      emitsInside,
      "the per-entity verdict is emitted once per run instead of once per entity, and zero entities still emits success",
    ).toBe(true);
  },

  "processresume-tool-args-match-tool-contract": toolArgsMatchContract,
  "rulecheck-result-paths-match-tool-contract": resultPathsMatchContract,

  "invite-killswitch-before-irreversible-send": killSwitchGuard,
  "identity-killswitch-before-write": killSwitchGuard,

  "createjd-deterministic-derivation-not-llm": deterministicDerivation,
  "match-deterministic-derivation-not-llm": deterministicDerivation,

  "match-dependency-health-attribution": dependencyHealth,
  "processresume-dependency-health-attribution": dependencyHealth,

  "match-resultmap-tolerates-optional-fields": ({ spec }) => {
    const optionalCapable = plan(spec).some((step) => {
      const fields = (
        step as { resultMap?: { fields?: Record<string, unknown> } }
      ).resultMap?.fields;
      return Object.values(fields ?? {}).some(
        (v) => typeof v === "object" && v !== null,
      );
    });
    expect(
      optionalCapable,
      "resultMap can only express a bare path, so a 200 that omits an optional field kills a good run",
    ).toBe(true);
  },

  "processresume-dedup-key-has-content-fallback": ({ spec }) => {
    const hasCoalesce = plan(spec).some((step) =>
      Object.values(
        (step as { toolArguments?: Record<string, unknown> }).toolArguments ??
          {},
      ).some(
        (v) =>
          typeof v === "object" && v !== null && "fromFirst" in (v as object),
      ),
    );
    expect(
      hasCoalesce,
      "a dedup key bound to a nullable event field has no content-derived fallback, so a manual upload re-delivers as a duplicate",
    ).toBe(true);
  },

  "createjd-success-path-health-check": ({ spec }) => {
    const hasSuccessRule = plan(spec).some(
      (step) =>
        ((step as { healthSignals?: unknown[] }).healthSignals ?? []).length > 0,
    );
    expect(
      hasSuccessRule,
      "a 200 with an empty body flows through as success — success-path rules are unreachable",
    ).toBe(true);
  },
};

function ruleFetchCheck({ spec }: Probe) {
  const refs = (spec as { ruleRefs?: string[] }).ruleRefs ?? [];
  if (refs.length === 0) return;
  const steps = plan(spec);
  const fetchIndex = steps.findIndex(
    (s) =>
      (s as { kind?: string }).kind === "tool" &&
      /fetchActionRules|fetchRules/i.test((s as { tool?: string }).tool ?? ""),
  );
  expect(
    fetchIndex,
    "ruleRefs are declared but no plan step ever fetches them",
  ).toBeGreaterThan(-1);
  // It must be ordered before, and threaded into, a consumer.
  const consumerIndex = steps.findIndex((s, i) => {
    if (i <= fetchIndex) return false;
    const fetchId = (steps[fetchIndex] as { stepId?: string }).stepId ?? "";
    return argValues(s).some((v) => v.includes(`results.${fetchId}`));
  });
  expect(
    consumerIndex,
    "the fetched rules are never threaded into any later step",
  ).toBeGreaterThan(-1);
}

function deterministicRouting({ code, spec }: Probe) {
  if ((spec.emit ?? []).length < 2) return;
  expect(
    code.includes("decision.emit"),
    "an LLM's free-text decision.emit can override the computed terminal event",
  ).toBe(false);
}

function conditionsConsumed({ spec, code }: Probe) {
  const steps = plan(spec);
  const conditions = steps.filter(
    (s) => (s as { kind?: string }).kind === "condition",
  );
  if (conditions.length === 0) return;
  for (const cond of conditions) {
    const id = (cond as { stepId?: string }).stepId ?? "";
    const hasDependent = steps.some((s) =>
      ((s as { dependsOn?: string[] }).dependsOn ?? []).includes(id),
    );
    if (hasDependent) continue;
    // A terminal condition must reach the routing decision, not just `_cond`.
    expect(
      code.includes("_route"),
      `condition ${id} has no dependents and no route binding, so its result is computed and discarded`,
    ).toBe(true);
  }
}

function emitProjectsOutputs({ spec, src }: Probe) {
  const declared = (spec.outputSchema ?? []).filter((f) => f?.required);
  if (declared.length === 0) return;
  const sends = collectCalls(src, (n) => n === "step.sendEvent");
  expect(sends.length).toBeGreaterThan(0);
  for (const send of sends) {
    const data = objectLiteralProperty(send, src, "data");
    if (!data) continue;
    const keys = ownKeys(data, src);
    for (const field of declared) {
      expect(
        keys.includes(field.field),
        `${field.field} is required by outputSchema but is not projected onto the emitted event`,
      ).toBe(true);
    }
  }
}

function anchorEnvelopePositions({ spec }: Probe) {
  const anchors = (spec.inputSchema ?? []).filter((f) => f?.required);
  if (anchors.length === 0) return;
  for (const anchor of anchors) {
    const paths = (anchor as { eventPaths?: string[] }).eventPaths ?? [];
    expect(
      paths.length,
      `required anchor ${anchor.field} declares no envelope positions, so it resolves to undefined on a real payload-nested event`,
    ).toBeGreaterThan(0);
  }
}

function toolArgsMatchContract({ spec }: Probe) {
  for (const step of plan(spec)) {
    if ((step as { kind?: string }).kind !== "tool") continue;
    const toolName = (step as { tool?: string }).tool ?? "";
    const contract = TOOL_CONTRACTS[toolName];
    if (!contract) continue;
    const supplied = Object.keys(
      (step as { toolArguments?: Record<string, unknown> }).toolArguments ?? {},
    );
    for (const [name, meta] of Object.entries(contract.args)) {
      if (!meta.required) continue;
      expect(
        supplied.includes(name),
        `${toolName} requires ${name} and the plan does not supply it (${contract.source})`,
      ).toBe(true);
    }
    for (const name of supplied) {
      expect(
        name in contract.args,
        `${toolName} has no argument named ${name} (${contract.source})`,
      ).toBe(true);
    }
  }
}

function resultPathsMatchContract({ spec }: Probe) {
  for (const step of plan(spec)) {
    const toolName = (step as { tool?: string }).tool ?? "";
    const contract = TOOL_CONTRACTS[toolName];
    if (!contract) continue;
    const fields =
      (step as { resultMap?: { fields?: Record<string, string> } }).resultMap
        ?.fields ?? {};
    for (const path of Object.values(fields)) {
      if (typeof path !== "string") continue;
      const bare = path.replace(/^result\./, "");
      expect(
        contract.resultRoots.some(
          (root) => bare === root || bare.startsWith(`${root}.`),
        ),
        `${toolName} never returns ${path} (${contract.source}); the first live call dies here`,
      ).toBe(true);
    }
  }
}

function killSwitchGuard({ code }: Probe) {
  const guardAt = code.search(/__agentPauseCheck|_paused|KILL_SWITCH/);
  expect(
    guardAt,
    "no operational pause or kill-switch guard precedes the irreversible side effect",
  ).toBeGreaterThan(-1);
  const firstStepAt = code.search(/await step\.(run|invoke|sendEvent)\(/);
  expect(guardAt).toBeLessThan(firstStepAt);
}

function deterministicDerivation({ spec }: Probe) {
  // A field another agent consumes must not originate from an LLM turn.
  const logicSteps = plan(spec).filter(
    (s) => (s as { kind?: string }).kind === "logic",
  );
  const derivations = logicSteps.filter((s) =>
    /derive|build|normalize|validate|check/i.test(
      (s as { stepId?: string }).stepId ?? "",
    ),
  );
  expect(
    derivations.length,
    `${derivations.map((s) => (s as { stepId?: string }).stepId).join(", ")} render as LLM turns; deterministic derivation needs a pure step kind`,
  ).toBe(0);
}

function dependencyHealth({ code }: Probe) {
  expect(
    code.includes("dependencySignal") || code.includes("dep-signal"),
    "a vendor 401/429/5xx is never attributed to the vendor, so dependency health is unknowable",
  ).toBe(true);
}

// ── runner ────────────────────────────────────────────────────────────────

function checkFor(assertion: GoldenAssertion): Check | null {
  const suffix = assertion.id.split("/")[1];
  if (suffix && UNIVERSAL_CHECKS[suffix]) return UNIVERSAL_CHECKS[suffix]!;
  return PER_AGENT_CHECKS[assertion.id] ?? null;
}

const satisfied = new Set<string>();

describe("golden domain · RAAS-v1 capability equivalence", () => {
  it("every committed spec renders through the real generator", () => {
    for (const agent of ALL_AGENTS) {
      const code = RENDERED.get(agent)!;
      expect(code.length).toBeGreaterThan(1_000);
      expect(code).toContain("inngest.createFunction");
    }
  });

  it("every assertion in the table has a real check behind it", () => {
    const orphans = GOLDEN_ASSERTIONS.filter((a) => !checkFor(a)).map(
      (a) => a.id,
    );
    expect(orphans).toEqual([]);
  });

  describe.each(GOLDEN_ASSERTIONS)("$id", (assertion) => {
    it(assertion.guarantee, () => {
      const check = checkFor(assertion);
      if (!check) throw new Error(`no check for ${assertion.id}`);
      const spec = SPECS.get(assertion.agent as (typeof ALL_AGENTS)[number])!;
      const code = RENDERED.get(assertion.agent as (typeof ALL_AGENTS)[number])!;
      const probe: Probe = {
        agent: assertion.agent,
        spec,
        code,
        src: parse(code),
      };
      try {
        check(probe);
        satisfied.add(assertion.id);
      } catch (error) {
        // A known, confirmed gap is recorded, not thrown — the ratchet below is
        // what fails the run. Throwing here would make the suite red on merge
        // and stop it being usable as a progress instrument.
        if (!assertion.gap) throw error;
      }
    });
  });
});

// The ratchet runs last: it is the only test that can fail on a known gap, and
// it fails only when something that USED to hold stops holding.
describe("golden domain · coverage ratchet", () => {
  it("no previously satisfied guarantee has regressed", () => {
    const baseline = JSON.parse(
      readFileSync(BASELINE_PATH, "utf8"),
    ) as { satisfied: string[] };
    if (process.env.UPDATE_GOLDEN_BASELINE === "1") {
      writeFileSync(
        BASELINE_PATH,
        `${JSON.stringify({ satisfied: [...satisfied].sort() }, null, 2)}\n`,
      );
      return;
    }
    const lost = baseline.satisfied.filter((id) => !satisfied.has(id));
    expect(
      lost,
      `these guarantees used to hold and no longer do: ${lost.join(", ")}`,
    ).toEqual([]);
    const gained = [...satisfied].filter(
      (id) => !baseline.satisfied.includes(id),
    );
    // Gaining is good — but the baseline must be bumped so the win is locked in
    // and cannot silently regress later.
    expect(
      gained,
      `these guarantees now hold; re-run with UPDATE_GOLDEN_BASELINE=1 to lock them in: ${gained.join(", ")}`,
    ).toEqual([]);
  });

  it("the fixture set still covers all six production Actions", () => {
    const files = readdirSync(join(FIXTURES, "specs")).filter((f) =>
      f.endsWith(".json"),
    );
    expect(files.length).toBe(ALL_AGENTS.length);
  });
});
