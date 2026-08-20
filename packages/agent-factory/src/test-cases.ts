// Full-flow test-case generation + the user-approval gate (migrated from the OLD
// lib/agent-factory-v3/tools/test-cases.ts).
//
// Before the sandbox really fires, the brain authors a small set of NAMED full-flow
// use cases (happy / reject / edge), each an entry event + payload exercising one path
// of the event graph. They stream to the chat as a proposal; the conductor PARKS
// (awaitingApproval) until the user clicks 执行 or 重新生成. On 执行, sandbox_run fires
// THESE cases, so the verification panel proves real I/O on reviewed inputs.

import { chatOnce, isGatewayConfigured } from "./stream-gateway";
import { synthesizeField } from "./fixtures";
import { deriveDecisionBoundaryFixtures } from "./decision-tables";
import type {
  BrainTool,
  BrainCtx,
  BrainToolResult,
  TestCase,
} from "./brain-types";
import {
  autopilotTestApprovalBlockReason,
  recordFactoryAssumption,
} from "./interaction-policy";

function params(
  props: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      reasoning: { type: "string", description: "为什么现在造测试用例" },
      ...props,
    },
    required: ["reasoning", ...required],
    additionalProperties: false,
  };
}

function entryEventsOf(ctx: BrainCtx): string[] {
  const produced = new Set<string>();
  for (const s of ctx.specs)
    for (const e of s.emit) if (e && e !== "—") produced.add(e);
  const entry = new Set<string>();
  for (const s of ctx.specs)
    for (const t of s.trigger)
      if (t && t !== "—" && !produced.has(t)) entry.add(t);
  return [...entry];
}

// Phase 4 — back the seed values with the realistic fixtures generator: emails/phones/dates get
// plausible values and a file/binary-typed field (e.g. a resume) gets a VALID synthetic PDF
// (base64), so a file-consuming agent can actually be exercised. Falls back to `<field>_demo` for
// plain unknown fields (back-compat with the prior typed-default behavior).
function typedDefault(type: string, field: string): unknown {
  return synthesizeField(field, type);
}

/** R1 + #9a: ground a test payload in the entry event's CANONICAL event_data. When the event
 *  defines a payload contract, return ONLY those fields (value = the LLM's where present, else a
 *  representative base value, else a typed default) — this both fills missing required fields AND
 *  STRIPS foreign fields the LLM may have invented (e.g. a recruitment field on a logistics domain),
 *  so the fixture is generic to ANY domain, never the RAAS shape. No event_data → keep as authored. */
function fillCanonical(
  payload: Record<string, unknown>,
  eventName: string,
  ctx: BrainCtx,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const canon =
    ctx.ontology?.events.find((e) => e.name === eventName)?.payload
      ?.event_data ?? [];
  if (!canon.length) return { ...payload };
  const out: Record<string, unknown> = {};
  for (const f of canon) {
    if (!f?.name) continue;
    out[f.name] =
      payload[f.name] !== undefined
        ? payload[f.name]
        : (base[f.name] ?? typedDefault(f.type, f.name));
  }
  return out;
}

/** #9 (de-hardcode): derive a representative seed payload PURELY from the live ontology — every
 *  DataObject's primary_key + properties and every event's canonical event_data field gets a typed
 *  default (`<field>_demo` / 1 / true / []). No per-domain hardcoded recruitment/energy/费控 values,
 *  so a brand-new domain (logistics, insurance, …) never gets foreign seed data leaking in. */
export function deriveBaseFixture(ctx: BrainCtx): Record<string, unknown> {
  const base: Record<string, unknown> = { _demo: true };
  const put = (name: string | undefined, type?: string) => {
    if (name && base[name] === undefined)
      base[name] = typedDefault(type ?? "", name);
  };
  for (const o of ctx.ontology?.objects ?? []) {
    if (o.primary_key) base[o.primary_key] = `${o.primary_key}_demo`;
    for (const p of o.properties ?? []) put(p?.name, p?.type);
  }
  // Cover every event's canonical payload field so fillCanonical's back-fill always has a value.
  for (const ev of ctx.ontology?.events ?? []) {
    for (const f of ev.payload?.event_data ?? []) put(f?.name, f?.type);
  }
  return base;
}

/** Scope deterministic fixtures to the selected entry contract when one is
 * authoritative. Legacy events without event_data keep the historical global
 * base fallback because there is no contract surface available to crop by. */
function baseFixtureForEntry(
  eventName: string,
  ctx: BrainCtx,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const hasCanonicalPayload = Boolean(
    ctx.ontology?.events.find((event) => event.name === eventName)?.payload
      .event_data.length,
  );
  return hasCanonicalPayload ? fillCanonical({}, eventName, ctx, base) : base;
}

function goldenFixture(ctx: BrainCtx): TestCase[] {
  const entries = entryEventsOf(ctx);
  const base = deriveBaseFixture(ctx);
  if (!entries.length)
    return [
      {
        id: "tc_golden_1",
        name: "默认全流程用例",
        scenario: "用代表性种子数据触发整条链",
        kind: "pass",
        entryEvent: "(入口)",
        payload: base,
        expectedOutcome: "走到成功终态",
      },
    ];
  return entries.map((e, i) => ({
    id: `tc_golden_${i + 1}`,
    name: `${e} · 代表性用例`,
    scenario: `用代表性数据触发 ${e}，预期整条链跑到成功终态`,
    kind: "pass" as const,
    entryEvent: e,
    payload: baseFixtureForEntry(e, ctx, base),
    expectedOutcome: "走到成功终态(非失败分支)",
  }));
}

function parseJsonArray(text: string): unknown[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** #INDEPENDENT-TESTER — build the test-designer's LLM input from CONTRACT DATA ONLY.
 *
 *  INVARIANT (locked by test-cases-independence.test.ts): the assembled prompt must never
 *  contain the designed agents' `generatedCode` / `systemPrompt` / `decisionLogic`. AgentCoder
 *  (arXiv 2312.13010) ablated exactly this: tests authored WITHOUT seeing the code under test
 *  reach 87.8% test accuracy vs 61.0% when the same model sees the code — a test designer that
 *  reads the implementation inherits its blind spots and loses objectivity. The designer here
 *  sees only: domain, event graph shape (trigger/emit/short), ontology event_data contracts,
 *  DataObject properties, and inputSchema FIELD NAMES/TYPES (contract, not implementation). */
export function buildTestAuthorPrompt(ctx: BrainCtx): {
  sys: string;
  user: string;
} {
  const entries = entryEventsOf(ctx);
  const chains: string[] = [];
  for (const a of ctx.specs)
    for (const e of a.emit)
      for (const b of ctx.specs)
        if (b.slug !== a.slug && b.trigger.includes(e))
          chains.push(`${a.short} —${e}→ ${b.short}`);
  const emitted = new Set(
    ctx.specs.flatMap((s) => s.emit).filter((e) => e && e !== "—"),
  );
  const consumed = new Set(ctx.specs.flatMap((s) => s.trigger).filter(Boolean));
  const terminals = [...emitted].filter((e) => !consumed.has(e));
  const objIndex = new Map<string, { name: string; type?: string }[]>();
  for (const o of ctx.ontology?.objects ?? [])
    objIndex.set(
      o.name,
      (o.properties ?? []).map((p) => ({ name: p.name, type: p.type })),
    );
  // R1: prefer the entry event's CANONICAL payload (ontology event_data) as the authoritative
  // field contract; fall back to the agent's (now event_data-grounded) inputSchema + DataObjects.
  const evByName = new Map(
    (ctx.ontology?.events ?? []).map((ev) => [ev.name, ev]),
  );
  const entryFields = entries.map((e) => {
    const canon = (evByName.get(e)?.payload?.event_data ?? []).map(
      (f) =>
        `${f.name}:${f.type}${f.target_object ? `(${f.target_object})` : ""}`,
    );
    if (canon.length)
      return `${e} 的权威 payload 字段(event_data): ${canon.slice(0, 16).join(", ")}`;
    const spec = ctx.specs.find((s) => s.trigger.includes(e));
    const fields = (spec?.inputSchema ?? []).map((f) => `${f.field}:${f.type}`);
    const objs = (spec?.objects ?? []).flatMap((n) =>
      (objIndex.get(n) ?? []).map((p) => `${p.name}:${p.type ?? "?"}`),
    );
    return `${e} 需要字段: ${[...new Set([...fields, ...objs])].slice(0, 14).join(", ") || "(未知,用代表性值)"}`;
  });
  const sys =
    "你是工厂的【独立测试用例设计师】(一个聚焦子大脑)。你【看不到】被测 agent 的实现代码/提示词——只按契约出题(独立出题防被实现带偏)。给定一组将要部署的业务 agent 和它们的事件图,设计 2-4 个【全流程测试用例】,每个用一条入口事件 + 一份真实感的 payload 去触发整条链,覆盖不同路径:至少一个 kind=pass、一个 kind=reject、可选一个 kind=edge。payload 字段必须严格对齐给出的【权威 payload 字段(event_data)】——字段名和类型照搬,值填真实数据;reject 用例要让某个字段违反业务规则,edge 用例可缺一个非必需字段。" +
    '只输出 JSON 数组,每个元素 {"name":string,"scenario":string,"kind":"pass"|"reject"|"edge","entryEvent":string,"payload":object,"expectedOutcome":string}。entryEvent 必须是给出的入口事件之一。不要任何其它文字。';
  const user = [
    `业务域: ${ctx.domain}`,
    `入口事件: ${entries.join("、") || "(无明确入口)"}`,
    `事件链: ${chains.slice(0, 12).join(" | ") || "(单段)"}`,
    `成功/失败终态: ${terminals.join("、") || "(未知)"}`,
    `各入口事件的 payload 字段:\n${entryFields.join("\n")}`,
    `agent: ${ctx.specs.map((s) => `${s.short}(${s.trigger.join("/") || "入口"}→${s.emit.join("/") || "终态"})`).join("; ")}`,
  ].join("\n");
  return { sys, user };
}

async function authorTestCases(ctx: BrainCtx): Promise<TestCase[]> {
  if (!isGatewayConfigured() || !ctx.ontology) return goldenFixture(ctx);
  const entries = entryEventsOf(ctx);
  const { sys, user } = buildTestAuthorPrompt(ctx);
  try {
    const text = await chatOnce(sys, user, {
      temperature: 0.6,
      maxTokens: 1800,
    });
    const rows = parseJsonArray(text);
    const cases: TestCase[] = [];
    rows.forEach((row, i) => {
      if (!row || typeof row !== "object") return;
      const r = row as Record<string, unknown>;
      const entryEvent = String(r.entryEvent ?? entries[0] ?? "(入口)");
      const kind = ["pass", "reject", "edge"].includes(String(r.kind))
        ? (String(r.kind) as TestCase["kind"])
        : "pass";
      const resolvedEntry = entries.includes(entryEvent)
        ? entryEvent
        : (entries[0] ?? entryEvent);
      const rawPayload = (
        r.payload && typeof r.payload === "object" ? r.payload : {}
      ) as Record<string, unknown>;
      cases.push({
        id: `tc_${i + 1}`,
        name: String(r.name ?? `用例 ${i + 1}`).slice(0, 60),
        scenario: String(r.scenario ?? "").slice(0, 200),
        kind,
        entryEvent: resolvedEntry,
        // R1: fill any canonical event_data field the LLM omitted, so the real fire is schema-complete.
        payload: fillCanonical(
          rawPayload,
          resolvedEntry,
          ctx,
          deriveBaseFixture(ctx),
        ),
        expectedOutcome: String(r.expectedOutcome ?? "").slice(0, 120),
      });
    });
    return cases.length ? cases : goldenFixture(ctx);
  } catch {
    return goldenFixture(ctx);
  }
}

/** Generate + PROPOSE test cases: store on ctx, surface as a 子大脑, emit test.cases,
 *  and PARK (awaitingApproval) for the user's decision. Shared by generate_test_cases
 *  AND sandbox_run's first-run auto-gate. */
export async function proposeTestCases(
  ctx: BrainCtx,
): Promise<BrainToolResult> {
  ctx.emit({ t: "subagent.start", task: "造全流程测试用例" });
  const authored = await authorTestCases(ctx);
  // #W2-4 — enforce the coverage matrix HERE (single source of truth): backfill safe cells (incl. the
  // fault-injection cell for tooled entry agents) + surface data-needing gaps, so BOTH call sites
  // (generate_test_cases + sandbox_run's auto-gate) get a covered, fault-carrying suite + coverage report.
  const { cases, coverage } = ensureCoverage(ctx, authored);
  ctx.testCases = cases;
  ctx.testCoverage = coverage;
  ctx.testCoverageWaiver = undefined;
  ctx.testDataSupplementPending = false;
  const kinds = cases.reduce<Record<string, number>>((m, c) => {
    m[c.kind] = (m[c.kind] ?? 0) + 1;
    return m;
  }, {});
  const kindStr = Object.entries(kinds)
    .map(([k, n]) => `${k}×${n}`)
    .join(" · ");
  ctx.emit({
    t: "subagent.done",
    task: "造全流程测试用例",
    summary: `生成 ${cases.length} 个用例(${kindStr})`,
  });
  const autopilotRequested = ctx.interactionPolicy === "autopilot";
  const autopilotBlock = autopilotRequested
    ? autopilotTestApprovalBlockReason(ctx)
    : null;
  const autopilotApproved = autopilotRequested && autopilotBlock === null;
  ctx.awaitingApproval = !autopilotApproved;
  if (autopilotApproved) {
    ctx.emit({ t: "test.cases", cases, awaitingApproval: false, coverage });
    const assumption = recordFactoryAssumption(ctx, {
      gate: "test_approval",
      subject: `执行当前测试用例集（${cases.map((testCase) => testCase.id).join(",")}）`,
      value: "approve",
      source: "safe_default",
      detail: "覆盖矩阵完整、无待处理授权、无外部写；继续沙箱验证",
    });
    ctx.emit({
      t: "test.decision",
      decision: "approve",
      note: `autopilot assumption ${assumption.id}`,
    });
  } else {
    ctx.emit({ t: "test.cases", cases, awaitingApproval: true, coverage });
  }
  const covNote = coverage.uncoveredNeedingData.length
    ? ` · ⚠ 覆盖矩阵缺 ${coverage.uncoveredNeedingData.length} 格需真实数据的用例(${coverage.uncoveredNeedingData.slice(0, 3).join("、")})`
    : " · 覆盖矩阵齐 ✓";
  return {
    ok: true,
    summary: autopilotApproved
      ? `已生成 ${cases.length} 个全流程测试用例(${kindStr})${coverage.backfilled.length ? ` · 矩阵补位 ${coverage.backfilled.length} 例` : ""}${covNote}。Autopilot 已按安全默认记录假设并批准这批用例；现在继续调用 sandbox_run。`
      : `已生成 ${cases.length} 个全流程测试用例(${kindStr})${coverage.backfilled.length ? ` · 矩阵补位 ${coverage.backfilled.length} 例` : ""}${covNote}并展示给用户确认。${autopilotBlock ? `Autopilot 安全门保留人工确认（${autopilotBlock}）。` : ""}【现在暂停,等用户点「执行」或「重新生成」——不要继续调别的工具】。用户确认后我会把决策作为消息发给你,你再调 sandbox_run 用这些用例真实跑通。`,
    output: { cases, awaitingApproval: !autopilotApproved, coverage },
  };
}

// #W2-4 — CONTRACT-DRIVEN COVERAGE MATRIX. The LLM used to author cases narratively; nothing
// guaranteed every (entry event → happy), every rule-gate (reject), or every multi-branch agent had a
// case — so allPass could be a false positive. This computes the REQUIRED cells, BACKFILLS the safe
// ones deterministically (happy per uncovered entry, golden-style), and REPORTS the cells that need
// authored data (reject per rule gate, branch per multi-emit agent) so the brain regenerates honestly
// instead of shipping a hollow "all pass".
export function ensureCoverage(
  ctx: BrainCtx,
  cases: TestCase[],
): {
  cases: TestCase[];
  coverage: {
    required: string[];
    covered: string[];
    backfilled: string[];
    uncoveredNeedingData: string[];
  };
} {
  const specs = ctx.specs;
  const entries = ctx.ontology ? computeEntryEvents(ctx) : [];
  const required: string[] = [];
  const covered: string[] = [];
  const backfilled: string[] = [];
  const needData: string[] = [];
  const base = deriveBaseFixture(ctx);
  const out = [...cases];
  // happy per entry event — backfillable deterministically.
  for (const e of entries) {
    const cell = `happy:${e}`;
    required.push(cell);
    if (out.some((c) => c.kind === "pass" && c.entryEvent === e))
      covered.push(cell);
    else {
      out.push({
        id: `tc_fill_${out.length + 1}`,
        name: `${e} · 覆盖矩阵补位(happy)`,
        scenario: `矩阵要求每个入口事件至少一条通过用例`,
        kind: "pass",
        entryEvent: e,
        payload: baseFixtureForEntry(e, ctx, base),
        expectedOutcome: "走到成功终态",
      });
      backfilled.push(cell);
    }
  }
  // reject per rule gate — needs rule-violating DATA we must not fabricate blindly: report, don't invent.
  for (const sp of specs) {
    if (!sp.tools.includes("ontology.fetchActionRules")) continue;
    const cell = `reject:${sp.actionName}`;
    required.push(cell);
    if (out.some((c) => c.kind === "reject")) covered.push(cell);
    else needData.push(cell);
  }
  // #W3-FAULT — fault per tooled ENTRY agent: BACKFILLABLE deterministically (base fixture + __fault
  // marker; step-engine injects the failure at dispatch, sandbox-only). Verifies the failure path is
  // wired: a poisoned tool must not produce a clean success terminal. Entry agents only — the marker
  // rides the ENTRY payload, so mid-chain agents' faults need authored cases (reported, not faked).
  for (const sp of specs) {
    if (!sp.tools.length) continue;
    const entry = (sp.trigger ?? []).find((t) => entries.includes(t));
    if (!entry) continue;
    const cell = `fault:${sp.actionName}`;
    required.push(cell);
    if (out.some((c) => c.kind === "fault" && c.entryEvent === entry)) {
      covered.push(cell);
      continue;
    }
    out.push({
      id: `tc_fault_${out.length + 1}`,
      name: `${sp.short} · 故障注入(${sp.tools[0]})`,
      scenario: `注入 ${sp.tools[0]} 超时故障，验证失败路径接线：不得在工具中毒时仍产出成功终态`,
      kind: "fault",
      entryEvent: entry,
      payload: {
        ...baseFixtureForEntry(entry, ctx, base),
        __fault: { tool: sp.tools[0], kind: "timeout" },
      },
      expectedOutcome: "优雅处理（不崩溃、不假成功）",
    });
    backfilled.push(cell);
  }
  // branch per multi-emit agent — same: report so the author covers each outcome path.
  for (const sp of specs) {
    const emits = (sp.emit ?? []).filter((x) => x && x !== "—");
    if (emits.length >= 2) {
      const cell = `branch:${sp.actionName}(${emits.join("|")})`;
      required.push(cell);
      if (
        out.filter(
          (c) => c.entryEvent && (sp.trigger ?? []).includes(c.entryEvent),
        ).length >= 2
      )
        covered.push(cell);
      else needData.push(cell);
    }
  }
  // Structured decision tables are executable data, so their direct-input
  // rows can produce exact boundary fixtures mechanically (39/40/missing,
  // enum member, etc.). Put them first so a bounded live sandbox cannot spend
  // its case budget on narrative cases while skipping the machine rules.
  const decisionCases: TestCase[] = [];
  for (const sp of specs) {
    if (!sp.decisionTables?.length) continue;
    const entryEvent =
      (sp.trigger ?? []).find((event) => entries.includes(event)) ??
      sp.trigger?.[0];
    if (!entryEvent) continue;
    const fixtures = deriveDecisionBoundaryFixtures(
      sp.actionName,
      sp.decisionTables,
      baseFixtureForEntry(entryEvent, ctx, base),
    );
    for (const fixture of fixtures) {
      required.push(fixture.cell);
      const existing = out.find(
        (testCase) => testCase.coverageCell === fixture.cell,
      );
      if (existing) {
        covered.push(fixture.cell);
        continue;
      }
      decisionCases.push({
        id: fixture.id,
        name: fixture.name,
        scenario: `结构化决策表边界：${fixture.cell}`,
        kind: "edge",
        entryEvent,
        // A `:missing` boundary is intentionally schema-incomplete. Do not let
        // canonical back-fill silently turn the null/missing test into a normal
        // value (the exact bug this table is meant to catch).
        payload: fixture.cell.endsWith(":missing")
          ? fixture.payload
          : fillCanonical(fixture.payload, entryEvent, ctx, base),
        expectedOutcome: fixture.expectedOutcome,
        expectedEvent: fixture.expectedEvent,
        coverageCell: fixture.cell,
      });
      backfilled.push(fixture.cell);
    }
  }
  if (decisionCases.length) out.unshift(...decisionCases);
  return {
    cases: out,
    coverage: { required, covered, backfilled, uncoveredNeedingData: needData },
  };
}

function computeEntryEvents(ctx: BrainCtx): string[] {
  const emitted = new Set(ctx.specs.flatMap((s) => s.emit ?? []));
  return [...new Set(ctx.specs.flatMap((s) => s.trigger ?? []))].filter(
    (t) => t && !emitted.has(t),
  );
}

export const generate_test_cases: BrainTool = {
  name: "generate_test_cases",
  // 用例集落在 ctx 并交用户确认——不落盘、不跑外部；SANDBOX 阶段的入口动作，点亮导轨。
  effect: {
    sideEffect: "write",
    scope: "conversation",
    checkpoint: "turn",
    gate: "sandbox",
    advancesStage: true,
  },
  description:
    "在 sandbox_run 之前,沿事件图设计一批【全流程测试用例】(正常通过 / 规则不符 / 缺字段各覆盖),每个=一条入口事件+真实 payload,触发整条链。生成后展示给用户确认(执行/重新生成),你需要【暂停等待用户决策】再继续。这把『喂进沙箱的输入』变成用户可见、可控的用例。用户要求重做用例时也调它。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.specs.length)
      return { ok: false, summary: "还没有 agent 可测,先 design_agent。" };
    // #W2-4 — proposeTestCases now owns the coverage matrix (backfill + report), so both entry points
    // stay in lockstep. No second ensureCoverage pass here (it was idempotent, but double-work).
    return proposeTestCases(ctx);
  },
};
