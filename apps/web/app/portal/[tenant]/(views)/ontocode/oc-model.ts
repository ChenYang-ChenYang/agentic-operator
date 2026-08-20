/**
 * OntoCode — projection layer over the factory brain stream.
 *
 * Pure functions only. The factory's `toBlocks`/`deriveAgents`/`deriveBrainFlow`
 * remain the source of truth; this module reshapes those outputs into the
 * OntoCode surfaces: the decision todo queue (待你决定), the single execution
 * line (执行行), and the event-flow graph (事件与业务流).
 */

import type { BrainEvent } from "@/lib/hooks/useBrainStream";
import type {
  AgentCardData,
  Block,
  BrainStep,
  BrainStepStatus,
  DraftRow,
} from "../factory/model";

// ── FDE build intent ─────────────────────────────────────────────────────────

export interface OntoCodeActionIntent {
  id: string;
  name: string;
}

export function isAgentOwnedOntologyAction(action: { actor: string[] }): boolean {
  return action.actor.includes("Agent");
}

/**
 * Keep the human-readable goal for the existing factory brain while the same
 * intent is also sent as structured `actionIds` / `scenario` fields. This makes
 * old persisted runs understandable and lets the backend adopt the structured
 * contract without losing backwards compatibility.
 */
export function buildOntoCodeIntentGoal(
  actions: OntoCodeActionIntent[],
  scenario: string,
): string {
  const cleanScenario = scenario.trim();
  const actionLines = actions.map((action) => `- ${action.id}（${action.name || action.id}）`);
  if (actionLines.length > 0) {
    return [
      "将以下 Ontology Actions 转为可运行、可沙箱验证的 Agents：",
      ...actionLines,
      ...(cleanScenario ? ["场景与业务约束：", cleanScenario] : []),
      "自动采用安全的推荐值继续；生成代码、契约和测试证据，并在沙箱中跑通。",
    ].join("\n");
  }
  return [
    "基于当前 Ontology，为以下场景生成可运行的场景型 Agent（不回写 Ontology）：",
    cleanScenario,
    "自动采用安全的推荐值继续；生成代码、契约和测试证据，并在沙箱中跑通。",
  ].join("\n");
}

export type OntoCodeStartMode = "new_scope" | "modify_existing" | "scope_changed";
export type OntoCodeComposerSubmit = "analyze_scope" | "start_run";
export type OntoCodeOntologyDomainState = "loading" | "error" | "empty" | "ready";

/**
 * Keep transport failures distinct from a valid response containing no
 * Ontology domains. An error must win even when React Query still has stale
 * data from an earlier successful request: starting from a stale snapshot can
 * bind a recommendation to the wrong Ontology hash.
 */
export function deriveOntologyDomainState(input: {
  hasData: boolean;
  isPending: boolean;
  isError: boolean;
  domainCount: number;
  domainId: string;
}): OntoCodeOntologyDomainState {
  if (input.isError) return "error";
  if (input.isPending || !input.hasData) return "loading";
  if (input.domainCount === 0 || !input.domainId) return "empty";
  return "ready";
}

/**
 * Initial FDE input must always go through server-side Ontology analysis.
 * Only an existing task or a validated recommendation may start generation.
 */
export function resolveOntoCodeComposerSubmit(input: {
  hasCurrentTask: boolean;
  hasRecommendation: boolean;
}): OntoCodeComposerSubmit {
  return input.hasCurrentTask || input.hasRecommendation
    ? "start_run"
    : "analyze_scope";
}

/**
 * Bind a server recommendation to the domain snapshot currently rendered by
 * the client. One missing/non-Agent ID invalidates the whole recommendation;
 * never silently shrink it to the subset that happens to match.
 */
export function matchBoundRecommendationActionIds(input: {
  recommendedActionIds: string[];
  boundAgentActionIds: string[];
}): string[] | null {
  const bound = new Set(input.boundAgentActionIds);
  return input.recommendedActionIds.every((id) => bound.has(id))
    ? [...input.recommendedActionIds]
    : null;
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return right.every((value) => values.has(value));
}

/**
 * A factory conversation has an immutable source scope. Follow-up edits reuse
 * that server scope and therefore send only `goal`; changing Actions must begin
 * a fresh task/conversation.
 */
export function resolveOntoCodeStartMode(input: {
  hasSuite: boolean;
  hasConversation: boolean;
  selectedActionIds: string[];
  sourceActionIds: string[];
}): OntoCodeStartMode {
  if (!input.hasSuite || !input.hasConversation) return "new_scope";
  return sameStringSet(input.selectedActionIds, input.sourceActionIds)
    ? "modify_existing"
    : "scope_changed";
}

export interface OntoCodeBuildContext {
  actionIds: string[];
  scenario: string | null;
  virtualAction: { id: string; name: string } | null;
  assumptions: Array<{
    id: string;
    gate: string | null;
    subject: string;
    value: string;
    source: string | null;
    detail: string | null;
    appliedAt: number | null;
    summary: string;
  }>;
}

function eventString(event: BrainEvent, ...keys: string[]): string {
  for (const key of keys) {
    const value = event[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function compactValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function shortValue(value: unknown, max = 72): string {
  const text = compactValue(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Project structured scope/autopilot events into compact provenance. The
 * backend events are intentionally parsed defensively so replaying an early
 * schema variant still gives FDEs useful context.
 */
export function deriveOntoCodeBuildContext(events: BrainEvent[]): OntoCodeBuildContext {
  const actionIds = new Set<string>();
  let scenario: string | null = null;
  let virtualAction: OntoCodeBuildContext["virtualAction"] = null;
  const assumptions: OntoCodeBuildContext["assumptions"] = [];

  for (const event of events) {
    if (event.t === "source.scope") {
      const rawActions = Array.isArray(event.actionIds)
        ? event.actionIds
        : Array.isArray(event.actions)
          ? event.actions
          : [];
      for (const action of rawActions) {
        if (typeof action === "string" && action.trim()) actionIds.add(action.trim());
        else if (action && typeof action === "object") {
          const id = (action as Record<string, unknown>).id;
          if (typeof id === "string" && id.trim()) actionIds.add(id.trim());
        }
      }
      scenario = eventString(event, "scenario", "description") || scenario;
    } else if (event.t === "virtual_action.created") {
      const id = eventString(event, "id", "actionId", "slug") || "scenario-agent";
      const name = eventString(event, "name", "title", "actionName") || id;
      virtualAction = { id, name };
      scenario = eventString(event, "scenario", "description") || scenario;
    } else if (event.t === "assumption.applied") {
      const raw = event.assumption;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const record = raw as Record<string, unknown>;
        const id = compactValue(record.id) || `assumption-${assumptions.length + 1}`;
        const gate = shortValue(record.gate) || null;
        const subject = shortValue(record.subject, 48) || gate || id;
        const value = shortValue(record.value) || "采用推荐值";
        const source = compactValue(record.source) || null;
        const detail = shortValue(record.detail, 120) || null;
        const appliedAt =
          typeof record.appliedAt === "number" && Number.isFinite(record.appliedAt)
            ? record.appliedAt
            : null;
        if (!assumptions.some((assumption) => assumption.id === id)) {
          assumptions.push({
            id,
            gate,
            subject,
            value,
            source,
            detail,
            appliedAt,
            summary: `${subject} → ${value}`,
          });
        }
      } else {
        const summary = eventString(event, "summary", "assumption", "text", "decision");
        if (summary && !assumptions.some((assumption) => assumption.summary === summary)) {
          assumptions.push({
            id: `assumption-${assumptions.length + 1}`,
            gate: null,
            subject: "自动假设",
            value: summary,
            source: null,
            detail: null,
            appliedAt: null,
            summary,
          });
        }
      }
    }
  }

  return {
    actionIds: [...actionIds].filter((id) => id !== virtualAction?.id),
    scenario,
    virtualAction,
    assumptions,
  };
}

// ── 待你决定 (todo queue) ──────────────────────────────────────────────────────

export type TodoKind = "clarify" | "test_approval" | "boundary";

export interface TodoItem {
  id: string;
  interactionId?: string;
  kind: TodoKind;
  /** All park gates block the run in P0, so every open todo is required. */
  required: true;
  /** Clarify gates raised for a missing credential render the guide variant. */
  credentialLike: boolean;
  /** Provider hint parsed from a credential todo's text — deep-links 去配置
   *  straight to that provider's editor. Null = go to the workbench instead. */
  providerHint?: string | null;
  title: string;
  context?: string;
  options?: Array<{ label: string; value: string; recommended?: boolean }>;
  cases?: Extract<Block, { kind: "testcases" }>["cases"];
  coverage?: Extract<Block, { kind: "testcases" }>["coverage"];
  proposals?: Extract<Block, { kind: "boundarycases" }>["proposals"];
}

const CREDENTIAL_RE = /凭证|密钥|credential|api[ _-]?key|token|secret/i;

/** 从凭证类 todo 的文本里提取 provider 提示（供「去配置」深链自动展开对应
 * 编辑器）。两个来源，都是从 todo 自己的文本派生、零硬编码映射：
 *   1. 显式标注 `provider: gohire` / `provider=gohire`
 *   2. 环境变量名 `GOHIRE_API_KEY` / `X_TOKEN` / `Y_SECRET` → 前缀小写、_→-
 * 提不出来返回 null——那说明缺口在系统层面（建档/绑定），该去工作台而不是
 * Settings。 */
export function extractProviderHint(text: string): string | null {
  const explicit = /provider\s*[:=]\s*["']?([a-z][a-z0-9-]{1,60})/i.exec(text);
  if (explicit) return explicit[1]!.toLowerCase();
  const env = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*?)_(?:API_KEY|APIKEY|KEY|TOKEN|SECRET)\b/.exec(text);
  if (env) return env[1]!.toLowerCase().replace(/_/g, "-");
  return null;
}

export function deriveTodos(blocks: Block[]): TodoItem[] {
  const todos: TodoItem[] = [];
  for (const b of blocks) {
    if (b.kind === "clarify" && b.awaiting) {
      const blob = `${b.question} ${b.context ?? ""}`;
      const credentialLike = CREDENTIAL_RE.test(blob);
      todos.push({
        id: b.interactionId ?? b.id,
        interactionId: b.interactionId,
        kind: "clarify",
        required: true,
        credentialLike,
        providerHint: credentialLike ? extractProviderHint(blob) : null,
        title: b.question,
        context: b.context,
        options: b.options,
      });
    } else if (b.kind === "testcases" && b.awaiting) {
      todos.push({
        id: b.interactionId ?? b.id,
        interactionId: b.interactionId,
        kind: "test_approval",
        required: true,
        credentialLike: false,
        title: `批准 ${b.cases.length} 条沙箱测试用例`,
        cases: b.cases,
        coverage: b.coverage,
      });
    } else if (b.kind === "boundarycases" && b.awaiting) {
      todos.push({
        id: b.interactionId ?? b.id,
        interactionId: b.interactionId,
        kind: "boundary",
        required: true,
        credentialLike: false,
        title: `${b.proposals.length} 个边界事件需要分类`,
        proposals: b.proposals,
      });
    }
  }
  return todos;
}

// ── 待你决定的行呈现（一行一题：徽章分级 + 短标题 + 溯源 + 行内快捷选项） ────────

export type TodoTier = "required" | "recommended";

export interface TodoPresentation {
  tier: TodoTier;
  /** ≤64 字的行标题；超长原文只在配置层显示。 */
  shortTitle: string;
  truncated: boolean;
  sourceHint?: string;
  /** 行内直接可点的快捷选项（推荐优先，最多 2 个，长标签只进配置层）。 */
  inlineOptions: Array<{ label: string; recommended: boolean }>;
}

const SHORT_TITLE_LIMIT = 64;
const INLINE_LABEL_LIMIT = 16;

export function presentTodo(todo: TodoItem): TodoPresentation {
  const firstSentence = todo.title.split(/(?<=[。？！；])|\n/)[0]?.trim() || todo.title.trim();
  const base = firstSentence.length <= SHORT_TITLE_LIMIT
    ? firstSentence
    : `${firstSentence.slice(0, SHORT_TITLE_LIMIT)}…`;
  const truncated = base.length < todo.title.trim().length;

  const options = todo.options ?? [];
  const recommended = options.filter((o) => o.recommended && o.label.length <= INLINE_LABEL_LIMIT);
  const others = options.filter((o) => !o.recommended && o.label.length <= INLINE_LABEL_LIMIT);
  const inlineOptions = [
    ...recommended.slice(0, 1).map((o) => ({ label: o.label, recommended: true })),
    ...others.slice(0, 1).map((o) => ({ label: o.label, recommended: false })),
  ];

  const tier: TodoTier =
    !todo.credentialLike && inlineOptions.some((o) => o.recommended) ? "recommended" : "required";

  const context = todo.context?.trim();
  return {
    tier,
    shortTitle: base,
    truncated,
    ...(context ? { sourceHint: context.length > 44 ? `${context.slice(0, 44)}…` : context } : {}),
    inlineOptions,
  };
}

export function todoTierCounts(todos: TodoItem[]): { required: number; recommended: number } {
  let required = 0;
  let recommended = 0;
  for (const todo of todos) {
    if (presentTodo(todo).tier === "recommended") recommended += 1;
    else required += 1;
  }
  return { required, recommended };
}

// Wire tags are parsed by the brain — must stay byte-identical to the factory page.
export function clarifyAnswerText(answer: string): string {
  return `[澄清回答] ${answer}`;
}
export function testDecisionText(decision: "approve" | "regenerate", note?: string): string {
  return `[测试用例决策: ${decision === "approve" ? "执行" : "重新生成"}] ${note ?? ""}`.trim();
}
export function boundaryDecisionText(
  events: Array<{ event: string; kind: string; consumer?: string; payloadContract?: string }>,
): string {
  return `[边界事件决策] ${JSON.stringify(events)}`;
}

// ── 执行行 (single in-place execution line) ───────────────────────────────────

export interface ExecLineState {
  state: "idle" | "running" | "done" | "error";
  /** Main line text, e.g. `调用 gohireMatchResumeApi` / `完成`. */
  text: string;
  detail?: string;
  toolCount: number;
  agentCount: number;
}

export function deriveExecLine(events: BrainEvent[], running: boolean): ExecLineState {
  let toolCount = 0;
  const openTools: Array<{ id: string; name: string }> = [];
  const agentSlugs = new Set<string>();
  let done: { status: string } | null = null;
  let lastError: string | null = null;
  let sawAny = false;

  for (const e of events) {
    sawAny = true;
    switch (e.t) {
      case "tool.call": {
        toolCount += 1;
        openTools.push({ id: String(e.id ?? ""), name: String(e.name ?? "") });
        break;
      }
      case "tool.result": {
        const idx = openTools.findIndex((o) => o.id === String(e.id ?? ""));
        if (idx >= 0) openTools.splice(idx, 1);
        break;
      }
      case "agent.created": {
        const spec = e.spec as Record<string, unknown> | undefined;
        if (spec?.slug) agentSlugs.add(String(spec.slug));
        break;
      }
      case "done": done = { status: String(e.status ?? "") }; lastError = null; break;
      case "error": lastError = String(e.message ?? "执行出错"); break;
    }
  }

  const base = { toolCount, agentCount: agentSlugs.size };
  if (lastError && !running) return { state: "error", text: lastError, ...base };
  if (running) {
    const current = openTools[openTools.length - 1];
    return {
      state: "running",
      text: current ? `调用 ${current.name}` : "正在构建",
      ...base,
    };
  }
  if (done) {
    return {
      state: "done",
      text: done.status === "waiting_human" ? "等待你的决定" : "完成",
      detail: done.status,
      ...base,
    };
  }
  return { state: sawAny ? "done" : "idle", text: sawAny ? "已结束" : "", ...base };
}

// ── compact build stages (right rail default) ────────────────────────────────

export interface BuildStageSummary {
  id: "context" | "plan" | "generate" | "validate" | "sandbox" | "deliver";
  label: string;
  status: BrainStepStatus;
  count: number;
  interactionId?: string;
}

const BUILD_STAGE_DEFS: Array<{
  id: BuildStageSummary["id"];
  label: string;
  kinds: BrainStep["kind"][];
}> = [
  { id: "context", label: "读取 Ontology 与上下文", kinds: ["read", "skill"] },
  { id: "plan", label: "规划 Agent 套件", kinds: ["plan", "subagent"] },
  { id: "generate", label: "生成 Agent 代码", kinds: ["design", "refine", "revert", "reflect"] },
  { id: "validate", label: "校验契约与依赖", kinds: ["validate", "gate"] },
  { id: "sandbox", label: "沙箱运行与测试", kinds: ["sandbox"] },
  { id: "deliver", label: "产物就绪", kinds: ["answer", "deliver", "error"] },
];

/**
 * Collapse a potentially noisy brain timeline into stable product phases.
 * Labels/details from individual reasoning and tool frames intentionally do
 * not leak into this projection; Diagnostics remains available when needed.
 */
export function deriveBuildStages(steps: BrainStep[]): BuildStageSummary[] {
  return BUILD_STAGE_DEFS.flatMap((definition) => {
    const matching = steps.filter((step) => definition.kinds.includes(step.kind));
    if (!matching.length) return [];
    const latest = matching[matching.length - 1]!;
    const status: BrainStepStatus = matching.some((step) => step.status === "fail")
      ? "fail"
      : matching.some((step) => step.status === "await")
        ? "await"
        : latest.status;
    const awaiting = [...matching].reverse().find(
      (step) => step.status === "await" && step.interactionId,
    );
    return [{
      id: definition.id,
      label: definition.label,
      status,
      count: matching.length,
      ...(awaiting?.interactionId ? { interactionId: awaiting.interactionId } : {}),
    }];
  });
}

// ── 事件与业务流 (event-flow graph) ───────────────────────────────────────────

export interface FlowGraphData {
  nodes: Array<{ slug: string; name: string; trigger: string[]; emit: string[] }>;
  /** agent → agent edges labelled by the connecting event. */
  edges: Array<{ from: string; to: string; event: string }>;
  /** Events consumed by an agent but produced by no agent (external entries). */
  entryEvents: Array<{ event: string; to: string }>;
  /** Events produced by an agent but consumed by no agent (terminals). */
  terminalEvents: Array<{ event: string; from: string }>;
}

export function deriveFlowGraph(agents: AgentCardData[]): FlowGraphData {
  const producers = new Map<string, string[]>();
  for (const a of agents) {
    for (const ev of a.emit) {
      const list = producers.get(ev) ?? [];
      list.push(a.slug);
      producers.set(ev, list);
    }
  }
  const edges: FlowGraphData["edges"] = [];
  const entryEvents: FlowGraphData["entryEvents"] = [];
  const consumed = new Set<string>();
  for (const a of agents) {
    for (const ev of a.trigger) {
      consumed.add(ev);
      const from = producers.get(ev);
      if (from?.length) {
        for (const producer of from) edges.push({ from: producer, to: a.slug, event: ev });
      } else {
        entryEvents.push({ event: ev, to: a.slug });
      }
    }
  }
  const terminalEvents: FlowGraphData["terminalEvents"] = [];
  for (const a of agents) {
    for (const ev of a.emit) {
      if (!consumed.has(ev)) terminalEvents.push({ event: ev, from: a.slug });
    }
  }
  return {
    nodes: agents.map((a) => ({
      slug: a.slug,
      name: a.actionName || a.nameZh || a.short || a.slug,
      trigger: a.trigger,
      emit: a.emit,
    })),
    edges,
    entryEvents,
    terminalEvents,
  };
}

// ── 事件流线性化（业务阶段带 + 节点图共用） ────────────────────────────────────

/** BFS from entry nodes; one row per branch chain. Pure — shared by ribbon + graph. */
export function linearizeFlow(graph: FlowGraphData): string[][] {
  const next = new Map<string, Array<{ to: string; event: string }>>();
  for (const e of graph.edges) {
    const list = next.get(e.from) ?? [];
    list.push({ to: e.to, event: e.event });
    next.set(e.from, list);
  }
  const started = new Set(graph.entryEvents.map((e) => e.to));
  const roots = graph.nodes.filter((n) => started.has(n.slug));
  const seen = new Set<string>();
  const rows: string[][] = [];
  const walk = (slug: string, row: string[]) => {
    if (seen.has(slug)) { rows.push([...row, slug]); return; }
    seen.add(slug);
    row.push(slug);
    const outs = next.get(slug) ?? [];
    if (outs.length === 0) { rows.push(row); return; }
    outs.forEach((o, i) => walk(o.to, i === 0 ? row : [slug]));
  };
  for (const r of roots.length ? roots : graph.nodes.slice(0, 1)) walk(r.slug, []);
  for (const n of graph.nodes) if (!seen.has(n.slug)) rows.push([n.slug]);
  return rows;
}

// ── 已决事项（闭环三态的归档态） ───────────────────────────────────────────────

export interface ResolvedGate { id: string; kind: TodoKind; title: string }

/** Gates whose awaiting flag flipped false — the green ✓ archive rows. */
export function deriveResolvedGates(blocks: Block[]): ResolvedGate[] {
  const out: ResolvedGate[] = [];
  for (const b of blocks) {
    if (b.kind === "clarify" && !b.awaiting) {
      out.push({ id: b.interactionId ?? b.id, kind: "clarify", title: b.question });
    } else if (b.kind === "testcases" && !b.awaiting) {
      out.push({ id: b.interactionId ?? b.id, kind: "test_approval", title: `${b.cases.length} 条沙箱用例已批准` });
    } else if (b.kind === "boundarycases" && !b.awaiting) {
      out.push({ id: b.interactionId ?? b.id, kind: "boundary", title: `${b.proposals.length} 个边界事件已分类` });
    }
  }
  return out;
}

// ── 用量（budget 帧 → 执行行计量） ─────────────────────────────────────────────

export function deriveTokensUsed(events: BrainEvent[]): number | null {
  let tokens: number | null = null;
  for (const e of events) {
    if (e.t === "budget" && typeof e.tokens === "number") tokens = e.tokens;
  }
  return tokens;
}

// ── 相对时间（左栏行的「N 分钟前」） ───────────────────────────────────────────

export function timeAgo(iso: string, now: number): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "刚刚";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d === 1) return "昨天";
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString();
}

// ── 连接就绪门（端到端：系统连接工作台的验证结果 → 部署前检查） ──────────────────

export interface ConnectionReadiness {
  allReady: boolean;
  /** systems that are neither probe-verified nor a human boundary. */
  pending: string[];
  verified: number;
  total: number;
}

/** A system is "connection-ready" for deploy when its connection was probe-
 * verified (lastProbe.ok), it is a deliberate human boundary, OR it is provided
 * by a platform runtime capability (LLM gateway / internal invoke — no external
 * connection to build). PLANNED systems (ontology references them, platform not
 * built yet) follow their chosen fallback: human_boundary = ready (a person does
 * that step, deploy proceeds); block = pending (deploy gate keeps warning until
 * the system is built and flipped live). Everything else is pending. */
export function deriveConnectionReadiness(
  systems: ReadonlyArray<{
    system: string;
    probeOk: boolean | null;
    humanBoundary: boolean;
    runtimeProvided?: boolean;
    availability?: "live" | "planned";
    plannedFallback?: "human_boundary" | "block";
  }>,
): ConnectionReadiness {
  const covered = (s: (typeof systems)[number]): boolean => {
    if (s.availability === "planned") return s.plannedFallback === "human_boundary";
    return s.probeOk === true || s.humanBoundary || s.runtimeProvided === true;
  };
  const pending = systems
    .filter((s) => !covered(s))
    .map((s) => (s.availability === "planned" ? `${s.system}（规划中）` : s.system));
  return {
    allReady: pending.length === 0,
    pending,
    verified: systems.length - pending.length,
    total: systems.length,
  };
}

// ── 部署（晋升）资格 ──────────────────────────────────────────────────────────
// Mirrors the factory page's client-side promotion gating byte-for-byte so the
// OntoCode deploy button can never open a review the backend would reject.

export interface DraftChip {
  label: string;
  tone: "ok" | "warn" | "dim";
  blockers: string[];
}

export function isDraftPromotable(d: DraftRow): boolean {
  return (
    d.replayReady === true &&
    d.regressionReady === true &&
    d.promotionGateAdmission === true &&
    d.promotionEligible === true &&
    d.promotionEvidenceReady === true &&
    d.evidenceQualification?.promotion === "candidate"
  );
}

export function draftChip(d: DraftRow): DraftChip {
  if (isDraftPromotable(d)) return { label: "可部署 ✓", tone: "ok", blockers: [] };
  const blockers = d.promotionBlockers?.length
    ? d.promotionBlockers
    : d.replayReady !== true || d.regressionReady !== true
      ? ["缺沙箱回放/回归证据"]
      : ["晋升资格未就绪"];
  return {
    label: d.replayReady === true ? "待补证据" : "草稿",
    tone: d.replayReady === true ? "warn" : "dim",
    blockers,
  };
}

export type PromotableSet =
  | { ok: true; versionId: string; slugs: string[] }
  | { ok: false; reason: string };

/** Never let a domain-wide draft listing widen the current streamed suite. */
export function scopeDraftsToAgents(drafts: DraftRow[], agentSlugs: string[]): DraftRow[] {
  if (!agentSlugs.length) return [];
  const allowed = new Set(agentSlugs);
  return drafts.filter((draft) => allowed.has(draft.slug));
}

export function pickPromotableSet(drafts: DraftRow[]): PromotableSet {
  if (!drafts.length) return { ok: false, reason: "暂无草稿——先完成一次生成" };
  const ready = drafts.filter(isDraftPromotable);
  if (!ready.length) {
    return { ok: false, reason: "没有满足部署条件的草稿（需要沙箱回放证据与晋升资格）" };
  }
  const versionIds = [...new Set(ready.map((d) => d.versionId).filter(Boolean))] as string[];
  if (versionIds.length !== 1 || ready.some((d) => !d.versionId)) {
    return { ok: false, reason: "就绪草稿分属不同版本——请在高级模式中分批晋升" };
  }
  return { ok: true, versionId: versionIds[0]!, slugs: ready.map((d) => d.slug) };
}

/** Server must confirm every slug went live — anything less is a failed deploy. */
export function confirmPromotionOutcome(
  slugs: string[],
  data: { promoted?: unknown; functionsRegistered?: unknown; liveAgents?: unknown },
): boolean {
  const promoted = Array.isArray(data.promoted)
    ? data.promoted.filter((s): s is string => typeof s === "string")
    : null;
  if (!promoted || promoted.length !== slugs.length) return false;
  if (!slugs.every((s) => promoted.includes(s))) return false;
  return (
    typeof data.functionsRegistered === "number" &&
    data.functionsRegistered > 0 &&
    typeof data.liveAgents === "number" &&
    data.liveAgents >= promoted.length
  );
}

// ── 下一步建议 (post-run suggestion chips) ────────────────────────────────────

export interface NextStep { id: string; label: string; href?: string }

export function deriveNextSteps(
  exec: ExecLineState,
  todos: TodoItem[],
  tenant: string,
): NextStep[] {
  if (exec.state !== "done") return [];
  const steps: NextStep[] = [];
  if (todos.some((t) => t.credentialLike)) {
    steps.push({
      id: "credential",
      label: "去配置",
      // Deep-link straight to the Integrations tab — that is where production
      // credentials are added; the bare /settings URL lands on Workspace.
      href: `/portal/${tenant}/settings?section=integrations`,
    });
  }
  if (exec.agentCount > 0) {
    steps.push({ id: "advanced", label: "高级模式", href: `/portal/${tenant}/factory` });
  }
  return steps;
}
