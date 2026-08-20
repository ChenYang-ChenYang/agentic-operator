/**
 * Ontology-analysis report jobs — the "领域报告" backend for the factory ops sidebar.
 *
 * A job: fetch the domain ontology (same OntologySource stack the brain reads —
 * uploaded > local > Allmeta) → digest it → pre-render deterministic SVG charts
 * (viz.renderSvgChart) → one ReportAgent LLM call authors a complete
 * self-contained HTML report ({{CHART:id}} placeholders substituted server-side)
 * → persist under data/reports/<tenant>/ + `artifacts` rows → optionally print
 * to PDF via local headless Chrome (report.htmlFileToPdf).
 *
 * In-process registry (like run-registry): jobs run detached from the HTTP
 * request; the sidebar's 后台 section polls GET /agent-factory/background.
 * A missing Chrome is a hard failure for a PDF-only request. A `both` request
 * may complete partially with an explicit note because HTML is also requested.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { agentRegistry } from "@agentic/agents";
import { substituteCharts, buildReportMessages, type ReportChart, type ReportInput, type ReportOutput } from "@agentic/agents/system";
import { renderSvgChart, htmlFileToPdf, findChrome, reportArchiveDir, listGlobalTools } from "@agentic/tools";
import type { DomainOntology, OntologyAction } from "@agentic/agent-factory";
import { verifyReportGrounding, correctionInstruction, residualWarningHtml, looksDegenerate, chatOnce, isGatewayConfigured } from "@agentic/agent-factory";
import { artifacts, getDb } from "@agentic/db";
import { makeId } from "@agentic/shared";

import { assertRealLLMGateway } from "../llm";
import { makeFactoryPorts } from "./index";
import { getFactoryDomainBinding } from "./domain-binding";
import { beginFactoryActiveWork } from "./active-work";

export type ReportFormat = "html" | "pdf" | "both";

export interface ReportJobArtifact {
  id: string;
  kind: string;
  size: number;
  label: string;
}

export interface ReportJob {
  id: string;
  kind: "ontology-report";
  tenantId: string;
  tenantSlug: string;
  domain: string;
  domainName?: string;
  format: ReportFormat;
  focus?: string;
  status: "running" | "done" | "error";
  /** Claude-desktop-style live phase while running: 读取本体 → 预渲染图表 → 撰写报告 → 打印 PDF. */
  phase?: string;
  createdAt: number;
  finishedAt?: number;
  error?: string;
  /** Non-fatal caveat, e.g. "PDF 跳过：未找到 Chrome". */
  note?: string;
  runId?: string;
  title?: string;
  artifacts: ReportJobArtifact[];
}

const jobs = new Map<string, ReportJob>();
const MAX_JOBS = 50;
// Report-write completion budget. Long reports were silently truncated at a fixed 16000; keep that
// as the default but let operators raise it for token-hungry domains.
const REPORT_MAX_TOKENS = Number(process.env.FACTORY_REPORT_MAX_TOKENS) || 16000;

// ── durable job sidecars — tsx-watch restarts mid-job must not vanish the report ─────
// One JSON per job under data/reports/_jobs/. On boot we rehydrate the Map: finished
// jobs keep their download links; a job persisted as "running" is flipped to error
// (its in-flight promise died with the old process) so the sidebar shows the truth.

function jobsDir(): string {
  return reportArchiveDir("_jobs");
}

function syncJobsDirectory(): void {
  const fd = fs.openSync(jobsDir(), "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function persistJob(job: ReportJob): void {
  const dir = jobsDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${job.id}.json`);
  const temp = path.join(dir, `.${job.id}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(job), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    syncJobsDirectory();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function unlinkJob(id: string): void {
  try {
    fs.unlinkSync(path.join(jobsDir(), `${id}.json`));
    syncJobsDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function rehydrateJobs(): void {
  let names: string[];
  try {
    names = fs.readdirSync(jobsDir()).filter((n) => n.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const n of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(jobsDir(), n), "utf8")) as ReportJob;
      if (!j?.id || jobs.has(j.id)) continue;
      if (j.status === "running") {
        j.status = "error";
        j.error = "服务重启，任务中断——请重新生成。";
        j.finishedAt = j.finishedAt ?? Date.now();
        persistJob(j);
      }
      jobs.set(j.id, j);
    } catch (error) {
      throw new Error(`cannot rehydrate report job sidecar ${n}`, { cause: error });
    }
  }
}
rehydrateJobs();

export function listReportJobs(tenantId?: string): ReportJob[] {
  return [...jobs.values()]
    .filter((j) => !tenantId || j.tenantId === tenantId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getReportJob(id: string, tenantId: string): ReportJob | null {
  const j = jobs.get(id);
  if (!j || j.tenantId !== tenantId) return null;
  return j;
}

function evict(): void {
  if (jobs.size <= MAX_JOBS) return;
  const finished = [...jobs.values()].filter((j) => j.status !== "running").sort((a, b) => a.createdAt - b.createdAt);
  for (const j of finished) {
    if (jobs.size <= MAX_JOBS) break;
    jobs.delete(j.id);
    unlinkJob(j.id);
  }
}

// ── ontology digest + deterministic charts ──────────────────────────────────

const cap = (s: unknown, n: number): string => String(s ?? "").slice(0, n);
const escStr = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Normalize one rule to the fields the report needs. Handles BOTH the Allmeta shape
 *  (standardizedLogicRule/businessLogicRuleName/enforcementLevel/specificScenarioStage/ruleSource)
 *  and generic {text, action, level} shapes — the old action-only extraction silently returned
 *  `undefined` for every Allmeta rule, which downstream misread as "闸口无规则" (a pipeline bug,
 *  not an ontology fact). */
function ruleSummary(r: Record<string, unknown>): { id: string; name?: string; text: string; level?: string; stage?: string; source?: string; action?: string } {
  const text = cap(r.standardizedLogicRule ?? r.text ?? r.rule ?? r.description ?? r.name ?? JSON.stringify(r), 220);
  const action = [r.action, r.action_name, r.actionName, r.target_action].map((v) => (typeof v === "string" ? v : "")).find(Boolean);
  const pick = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? cap(v, n) : undefined);
  return {
    id: cap(r.id ?? r.rule_id ?? "", 40),
    name: pick(r.businessLogicRuleName ?? r.ruleName, 60),
    text,
    level: pick(r.enforcementLevel ?? r.level, 20),
    stage: pick(r.specificScenarioStage ?? r.stage, 40),
    source: pick(r.ruleSource, 40),
    ...(action ? { action } : {}),
  };
}

/** Walk ONE chain from an entry event. Concurrent consumers of the same event render as a single
 *  "A ∥ B" node (v1 walked only the first consumer and narrated a parallel fan-out as a serial
 *  funnel); the walk then continues along the branch that has further internal chain. */
function chainFrom(entry: string, ont: DomainOntology): string[] {
  const producedBy = new Map<string, string[]>();
  const consumers = new Map<string, OntologyAction[]>();
  for (const a of ont.actions) {
    for (const e of a.triggered_event ?? []) producedBy.set(e, [...(producedBy.get(e) ?? []), a.name]);
    for (const e of a.trigger ?? []) consumers.set(e, [...(consumers.get(e) ?? []), a]);
  }
  const steps: string[] = [`⚡ ${entry}`];
  const seen = new Set<string>([entry]);
  let ev: string | undefined = entry;
  for (let i = 0; i < 5 && ev; i++) {
    const acts: OntologyAction[] = consumers.get(ev) ?? [];
    if (!acts.length) break;
    steps.push(acts.map((a) => a.name).join(" ∥ "));
    // follow the branch that continues INTERNALLY (its emit has a consumer); else the first emit
    const nexts: string[] = acts.flatMap((a) => a.triggered_event ?? []).filter((e: string) => !seen.has(e));
    ev = nexts.find((e: string) => (consumers.get(e) ?? []).length > 0) ?? nexts[0];
    if (!ev) break;
    seen.add(ev);
    steps.push(`⚡ ${ev}`);
  }
  return steps;
}

/** All entry events (consumed internally, produced by no internal action), longest chains first. */
function entryChains(ont: DomainOntology): Array<{ entry: string; steps: string[] }> {
  const produced = new Set(ont.actions.flatMap((a) => a.triggered_event ?? []));
  const consumed = new Set(ont.actions.flatMap((a) => a.trigger ?? []));
  const entries = [...consumed].filter((e) => !produced.has(e));
  return entries
    .map((entry) => ({ entry, steps: chainFrom(entry, ont) }))
    .sort((a, b) => b.steps.length - a.steps.length);
}

function buildCharts(ont: DomainOntology): ReportChart[] {
  const charts: ReportChart[] = [];
  const push = (id: string, title: string, svg: string | null) => {
    if (svg) charts.push({ id, title, svg });
  };
  const byActor = new Map<string, number>();
  for (const a of ont.actions) {
    const actor = a.actor?.[0] ?? "未标注";
    byActor.set(actor, (byActor.get(actor) ?? 0) + 1);
  }
  if (byActor.size) {
    const data = [...byActor.entries()].map(([label, value]) => ({ label, value }));
    push("actor-donut", "动作执行者分布", renderSvgChart({ kind: "donut", title: "动作执行者分布", data }).svg);
  }
  const withTools = ont.actions.filter((a) => (a.tool_use ?? []).length > 0);
  const data = (withTools.length ? withTools : ont.actions)
    .map((a) => ({
      label: a.name,
      value: withTools.length ? (a.tool_use ?? []).length : (a.trigger ?? []).length + (a.triggered_event ?? []).length,
    }))
    .sort((x, y) => y.value - x.value)
    .slice(0, 10);
  if (data.length) {
    const title = withTools.length ? "各动作绑定工具数 Top 10" : "各动作事件连接数 Top 10";
    push("action-bar", title, renderSvgChart({ kind: "bar", title, data }).svg);
  }
  // One flow chart PER entry event (top 3 by chain length) — a multi-entry domain narrated off a
  // single chain is how v1 missed half the process. "∥" nodes mark concurrent fan-outs.
  entryChains(ont)
    .filter((c) => c.steps.length >= 2)
    .slice(0, 3)
    .forEach((c, i) => {
      const title = `链路 ${i + 1}：从 ${c.entry} 出发`;
      push(`event-flow-${i + 1}`, title, renderSvgChart({ kind: "flow", title, steps: c.steps }).svg);
    });
  return charts;
}

/** Computed structural analysis — the report's substance lives HERE, deterministically. The LLM's
 *  job is business interpretation of these verdicts, never re-derivation: v1 shipped English key
 *  lists (entryEvents/terminalEvents/orphanConsumed) and the model mislabeled a terminal event as
 *  "无生产者的被消费" and missed the domain's real chain break entirely. So every event now carries
 *  a SELF-DESCRIBING Chinese classification with its producers/consumers inline, and likely chain
 *  breaks are pre-computed as suggestedBridges (terminal ↔ entry name-token overlap). */
function computeAnalysis(ont: DomainOntology): Record<string, unknown> {
  const producedBy = new Map<string, string[]>(); // event → actions that emit it
  const consumedBy = new Map<string, string[]>(); // event → actions that consume it
  for (const a of ont.actions) {
    for (const e of a.triggered_event ?? []) producedBy.set(e, [...(producedBy.get(e) ?? []), a.name]);
    for (const e of a.trigger ?? []) consumedBy.set(e, [...(consumedBy.get(e) ?? []), a.name]);
  }
  const allEvents = [...new Set<string>([...producedBy.keys(), ...consumedBy.keys()])].sort();

  const classify = (e: string): string => {
    const p = producedBy.has(e);
    const c = consumedBy.has(e);
    if (p && c) return "内部链路（有生产者也有消费者）";
    if (!p && c) return "外部入口（仅被内部消费，由外部系统/人工触发）";
    return "终态或外部交接（内部产出后无内部消费者）";
  };
  // Heuristic verdict per terminal: a name that still "asks for" downstream work (NEED/REQUEST/
  // PASSED/READY) smells like a chain break; FAILED/CONFLICT/REJECTED/SENT/DONE smell like an
  // intentional exit. A hint for the narrator, clearly labeled as such.
  const terminalHint = (e: string): string =>
    /NEED|REQUEST|READY|PASSED|CHECKED/i.test(e)
      ? "疑似需要下游衔接（名字暗示后续动作，但本体内无消费者）"
      : /FAIL|CONFLICT|REJECT|SENT|DONE|COMPLETE|CANCEL/i.test(e)
        ? "疑似合理出口（失败/异常/完成类，通常由外部系统或人工接管）"
        : "归属待判断（外部交接或死胡同）";

  const events = allEvents.map((e) => ({
    name: e,
    class: classify(e),
    producers: producedBy.get(e) ?? [],
    consumers: consumedBy.get(e) ?? [],
    ...(producedBy.has(e) && !consumedBy.has(e) ? { verdictHint: terminalHint(e) } : {}),
  }));

  // Likely chain breaks: a TERMINAL and an ENTRY sharing a meaningful name token (e.g.
  // MATCH_PASSED_NEED_INTERVIEW ↔ INTERVIEW_INVITATION_REQUESTED share INTERVIEW) usually mean
  // "this handoff should be wired (or explicitly owned by an external system)".
  const GENERIC = new Set(["PASSED", "FAILED", "NEED", "NO", "READY", "CHECK", "CHECKED", "DONE", "NEW", "OLD", "EVENT"]);
  const tokens = (e: string) => e.split(/[_\-.]/).map((t) => t.toUpperCase()).filter((t) => t.length >= 4 && !GENERIC.has(t));
  const entries = allEvents.filter((e) => !producedBy.has(e) && consumedBy.has(e));
  const terminals = allEvents.filter((e) => producedBy.has(e) && !consumedBy.has(e));
  const suggestedBridges: Array<{ from: string; fromProducer: string[]; to: string; toConsumer: string[]; sharedTokens: string[] }> = [];
  for (const t of terminals) {
    for (const en of entries) {
      const shared = tokens(t).filter((x) => tokens(en).includes(x));
      if (shared.length) suggestedBridges.push({ from: t, fromProducer: producedBy.get(t) ?? [], to: en, toConsumer: consumedBy.get(en) ?? [], sharedTokens: [...new Set(shared)] });
    }
  }

  const edges: Array<{ from: string; event: string; to: string }> = [];
  for (const [ev, producers] of producedBy) {
    for (const from of producers) for (const to of consumedBy.get(ev) ?? []) edges.push({ from, event: ev, to });
  }
  // Concurrent fan-outs: one event consumed by 2+ actions — v1's linear narrative missed these.
  const fanOuts = allEvents
    .filter((e) => (consumedBy.get(e) ?? []).length >= 2)
    .map((e) => ({ event: e, consumers: consumedBy.get(e)!, note: "一个事件并发触发多个动作（并行支线，不是串行漏斗）" }));

  // ── rules: FULL-population aggregation + honest action linkage ───────────────
  const summaries = ont.rules.map((r) => ruleSummary(r as Record<string, unknown>));
  const byStage = new Map<string, { count: number; mandatory: number; samples: Array<{ id: string; name?: string }> }>();
  for (const s of summaries) {
    const key = s.stage ?? "（未标注阶段）";
    const b = byStage.get(key) ?? { count: 0, mandatory: 0, samples: [] };
    b.count++;
    if (/mandatory|强制/i.test(s.level ?? "")) b.mandatory++;
    if (b.samples.length < 2) b.samples.push({ id: s.id, name: s.name });
    byStage.set(key, b);
  }
  const ruleClusters = [...byStage.entries()].sort((a, b) => b[1].count - a[1].count).map(([stage, v]) => ({ stage, ...v }));
  const levelDist = new Map<string, number>();
  for (const s of summaries) levelDist.set(s.level ?? "（未标注）", (levelDist.get(s.level ?? "（未标注）") ?? 0) + 1);

  // Action linkage: explicit keys when present; otherwise a TEXT heuristic (stage/rule-name tokens
  // appearing in the action's Chinese name/description). Method is REPORTED so the narrator can't
  // present a heuristic (or a failed extraction) as an ontology fact.
  const explicit = summaries.some((s) => s.action);
  const actionText = (a: OntologyAction) => `${a.name} ${a.description ?? ""}`;
  const stageHits = (stage: string, a: OntologyAction): boolean => {
    const txt = actionText(a);
    // any 2+ char CJK chunk of the stage appearing in the action text counts (简历匹配→"匹配")
    for (let i = 0; i < stage.length - 1; i++) {
      const bi = stage.slice(i, i + 2);
      if (/[一-鿿]{2}/.test(bi) && txt.includes(bi)) return true;
    }
    return false;
  };
  const perAction = ont.actions.map((a) => {
    const n = explicit
      ? summaries.filter((s) => s.action === a.name).length
      : summaries.filter((s) => s.stage && stageHits(s.stage, a)).length;
    return { action: a.name, linkedRules: n };
  });
  const modeledStages = new Set(ruleClusters.filter((c) => ont.actions.some((a) => stageHits(c.stage, a))).map((c) => c.stage));
  const unmodeledStages = ruleClusters.filter((c) => c.stage !== "（未标注阶段）" && !modeledStages.has(c.stage)).map((c) => ({ stage: c.stage, rules: c.count }));

  const objTouch = new Map<string, number>();
  for (const a of ont.actions) for (const o of a.target_objects ?? []) objTouch.set(o, (objTouch.get(o) ?? 0) + 1);
  const actionsNoTool = ont.actions.filter((a) => (a.tool_use ?? []).length === 0 && (a.actor?.[0] ?? "Agent") === "Agent").map((a) => a.name);

  return {
    eventGraph: { events, edges: edges.slice(0, 120), fanOuts },
    suggestedBridges,
    gaps: {
      orphanConsumedEvents: allEvents.filter((e) => !producedBy.has(e) && !consumedBy.has(e)), // pathological only
      agentActionsWithoutTools: actionsNoTool,
    },
    ruleAnalysis: {
      total: ont.rules.length,
      levelDistribution: [...levelDist.entries()].map(([level, count]) => ({ level, count })),
      clusters: ruleClusters,
      linkageMethod: explicit ? "explicit（本体显式提供规则→动作关联）" : "text-heuristic（本体未提供显式关联；按阶段名与动作描述的文字重合启发式对应，仅供参考）",
      perAction,
      unmodeledStages,
      unmodeledStagesNote: "这些阶段的规则在本体中没有对应的 Agent 动作——通常意味着流程只建模了一部分（规则覆盖面 > 动作覆盖面），不是“动作缺规则”。",
    },
    objectTouch: [...objTouch.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([object, actions]) => ({ object, actions })),
  };
}

function buildDigest(ont: DomainOntology): Record<string, unknown> {
  return {
    domainId: ont.domainId,
    source: ont.source,
    counts: {
      actions: ont.actions.length,
      events: ont.events.length,
      objects: ont.objects.length,
      rules: ont.rules.length,
      workflow: ont.workflow?.length ?? 0,
    },
    actions: ont.actions.slice(0, 80).map((a) => ({
      name: a.name,
      description: cap(a.description, 220),
      category: a.category,
      actor: a.actor,
      trigger: a.trigger,
      triggered_event: a.triggered_event,
      tool_use: a.tool_use,
      target_objects: a.target_objects,
      submission_criteria: cap(a.submission_criteria, 200),
    })),
    events: ont.events.slice(0, 120).map((e) => ({
      name: e.name,
      description: cap(e.description, 140),
      source_action: e.payload?.source_action ?? null,
      fields: (e.payload?.event_data ?? []).map((f) => f.name).slice(0, 12),
    })),
    // Rules reach the LLM as FULL-population aggregates (analysis.ruleAnalysis) + a stratified
    // sample here (top clusters × a few rules each, mandatory first) — v1's raw slice(0,100)
    // let the model generalize from an arbitrary 38% and invent the rest.
    rulesSample: (() => {
      const summaries = ont.rules.map((r) => ruleSummary(r as Record<string, unknown>));
      const byStage = new Map<string, typeof summaries>();
      for (const s of summaries) {
        const k = s.stage ?? "（未标注阶段）";
        byStage.set(k, [...(byStage.get(k) ?? []), s]);
      }
      const sample: typeof summaries = [];
      for (const [, list] of [...byStage.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const sorted = [...list].sort((a, b) => (/mandatory|强制/i.test(b.level ?? "") ? 1 : 0) - (/mandatory|强制/i.test(a.level ?? "") ? 1 : 0));
        sample.push(...sorted.slice(0, 4));
        if (sample.length >= 72) break;
      }
      return sample;
    })(),
    rulesSampleNote: `分层采样：按业务阶段（specificScenarioStage）每簇最多 4 条、mandatory 优先，共 ≤72/${ont.rules.length} 条；全量统计见 analysis.ruleAnalysis。`,
    objects: ont.objects.slice(0, 60).map((o) => ({ id: o.id, name: o.name, type: o.type, properties: (o.properties ?? []).map((p) => p.name).slice(0, 16) })),
    entryChains: entryChains(ont),
    analysis: computeAnalysis(ont),
    // #TOOL-LAYER — deterministic framing for the "0 tools bound" reading. A semantic ontology
    // may intentionally declare no tool bindings; the factory binds tools at DESIGN
    // time from the global registry (semantic rank → auto-floor → search_tools → ask_user, incl. the
    // missing-credential gate). Without this note the narrator reads "0 tools" as a platform defect
    // ("重大落地缺口") — accurate about the ontology LAYER, misleading about the SYSTEM. Attached only
    // when zero actions bind tools (when some do, the ordinary gap analysis applies unchanged).
    toolBinding: (() => {
      const actionsWithTools = ont.actions.filter((a) => (a.tool_use ?? []).length > 0).length;
      if (actionsWithTools > 0) return { layered: false, actionsWithTools };
      const registryTools = listGlobalTools().length;
      return {
        layered: true,
        actionsWithTools: 0,
        registryTools,
        note:
          `本体层（语义本体）按分层设计【不声明】工具绑定——本体只回答“谁在何时做什么”；工具由 Agent 工厂在设计期从全局工具注册表（当前 ${registryTools} 个）为每个 agent 语义匹配并绑定（缺凭证会 ask_user 向用户确认）。因此“动作未绑定工具”应解读为【设计期待办】（工厂生成时完成），不是平台或本体的重大缺陷。`,
      };
    })(),
  };
}

// ── job runner ───────────────────────────────────────────────────────────────

function insertArtifactRow(tenantId: string, runId: string, kind: string, filePath: string): { id: string; size: number } {
  const size = fs.statSync(filePath).size;
  const id = makeId("art");
  try {
    getDb()
      .insert(artifacts)
      .values({ id, tenantId, runId, kind, path: filePath, size, createdAt: new Date() })
      .run();
  } catch (error) {
    try {
      fs.unlinkSync(filePath);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "artifact DB insert and file cleanup both failed");
    }
    throw error;
  }
  return { id, size };
}

function writeDurableArtifact(filePath: string, contents: string): void {
  const temp = `${filePath}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, filePath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function fsyncArtifact(filePath: string): void {
  const fd = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function runJob(job: ReportJob, extraHtml?: string): Promise<void> {
  const setPhase = (p: string) => {
    job.phase = p;
    persistJob(job); // #AUDIT-FIX(L33) — 每个阶段落盘：重启后已归档的产物/进度不再被 finally 的 error 覆盖丢失
  };
  try {
    setPhase("读取本体");
    const ports = makeFactoryPorts(job.tenantSlug, job.tenantId, job.domain);
    const ont = await ports.ontology.fetchOntology(job.domain);
    if (!ont || !ont.actions?.length) throw new Error(`业务域「${job.domain}」没有可分析的本体内容（0 个 action）。`);
    const domains = await ports.ontology.listDomains();
    job.domainName = domains.find((d: { id: string; name?: string }) => d.id === job.domain)?.name ?? job.domain;

    setPhase("预渲染图表");
    const charts = buildCharts(ont);
    const digest = buildDigest(ont);

    setPhase("撰写报告");
    const input: ReportInput = {
      subject: `业务域「${job.domainName}」(${job.domain}) 的 Ontology 领域分析 — ${ont.actions.length} 动作 / ${ont.events.length} 事件 / ${ont.rules.length} 规则 / ${ont.objects.length} 数据对象`,
      title: `${job.domainName} · Ontology 领域分析报告`,
      focus: job.focus,
      language: "zh-CN",
      data: digest,
      charts,
    };
    // The report must originate from the registered reportGenerator run. A
    // previous direct factory-gateway branch invented a run id with no runs
    // row, breaking artifact attribution and FK integrity.
    assertRealLLMGateway("ontology report generation");
    const factoryReady = isGatewayConfigured();
    // Author via the factory REASONING gateway using the EXACT same deep-analysis prompt the
    // reportGenerator agent uses (buildReportMessages — SVG_SKILLS + grounding contract + section
    // spec). This closes the old gap where this path used a thinner hand-rolled prompt and produced a
    // shallower report; now both narrative paths reason at the same depth. On a grounding-verify retry
    // the correction block is appended to the SAME prompt.
    const writeViaFactory = async (violations?: import("@agentic/agent-factory").ReportViolation[]): Promise<string> => {
      const msgs = buildReportMessages(
        input,
        violations && violations.length ? correctionInstruction(violations) : undefined,
      );
      const sys = String(msgs[0]?.content ?? "");
      const usr = String(msgs[1]?.content ?? "");
      return await chatOnce(sys, usr, {
        maxTokens: REPORT_MAX_TOKENS,
        purpose: "report-write",
        context: {
          tenantId: job.tenantId,
          tenantSlug: job.tenantSlug,
          domain: job.domain,
          runId: job.runId ?? undefined,
        },
      });
    };

    const agent = agentRegistry.get("reportGenerator");
    if (!agent) throw new Error("reportGenerator agent 未注册（bootstrap 未加载 @agentic/agents/system）。");
    const result = await agent.run(input as never, { tenantSlug: job.tenantSlug, correlationId: makeId("cor"), invocationId: job.id });
    job.runId = result.runId;
    const output = result.output as ReportOutput | null;
    if (!output?.html) throw new Error("报告 agent 未产出 HTML。");
    let baseHtml = output.html;
    let narrativeVia = "reportGenerator agent（主 LLM 网关）";
    let degen = looksDegenerate(baseHtml);
    job.title = output.title;
    // A second, independently configured real gateway may repair a
    // degenerate response, but the artifact remains attributed to the real
    // reportGenerator run that initiated the supervised job.
    if (degen.degenerate && factoryReady) {
      setPhase("主网关退化 · 工厂网关重写");
      const alt = await writeViaFactory();
      if (alt && !looksDegenerate(alt).degenerate) {
        baseHtml = alt;
        narrativeVia = "工厂网关回退撰写（主网关退化）";
        degen = looksDegenerate(alt);
        job.title = String(input.title);
      }
    }
    if (degen.degenerate) {
      throw new Error(
        `报告正文生成退化（${degen.reason}）——拒绝交付非报告内容。请检查主 LLM 与工厂网关的真实 provider/model 配置后重试。`,
      );
    }

    // #REPORT-VERIFY — 接地审校闭环（自己检查 → 定向纠错 → 复检 → 诚实披露残留）。
    // ① 检查：正文引用的事件/动作/工具/对象名必须能在【模型看到的 digest ∪ 本体全量】核到，
    //    四类核心计数必须命中合法数集；② 违规 → 一次定向修正重写（把"错在哪、去哪核对"逐条
    //    喂回模型）；③ 复检仍残留 → 报告内插入可见"审校警示"块——绝不静默交付错误内容。
    setPhase("接地审校");
    let finalHtml = baseHtml;
    let check = verifyReportGrounding(finalHtml, ont, digest);
    let verifyNote = "审校通过 ✓（正文引用与计数均可在源数据核到）";
    if (!check.ok) {
      setPhase("审校修正");
      try {
        // #NOMOCK — 修正重写统一走工厂网关（真实模型）：无论初稿来自哪条通道，修正都用真实
        // 模型（主网关 mock 时 agent 重试只会再回声一次）。
        let retryHtml: string | null = null;
        if (factoryReady) {
          const fixed = await writeViaFactory(check.violations);
          retryHtml = fixed && !looksDegenerate(fixed).degenerate ? fixed : null;
        }
        if (retryHtml) {
          const recheck = verifyReportGrounding(retryHtml, ont, digest);
          // 只有修正稿确实更干净才采用（否则保留原稿，避免越修越糟）。
          if (recheck.violations.length < check.violations.length) {
            finalHtml = retryHtml;
            check = recheck;
          }
        }
      } catch {
        /* 修正重写失败 → 走残留披露路径 */
      }
      if (check.ok) {
        verifyNote = "审校通过（经 1 次自动修正）✓";
      } else {
        verifyNote = `审校残留 ${check.violations.length} 处（已在报告内可见标注，请勿采信标注处）`;
        const warn = residualWarningHtml(check.violations);
        finalHtml = finalHtml.includes("</body>") ? finalHtml.replace("</body>", () => `${warn}\n</body>`) : `${finalHtml}${warn}`;
        job.note = job.note ? `${job.note}；${verifyNote}` : verifyNote;
      }
    }

    // Deterministic methodology footer — sampling scope / linkage method / classification
    // provenance must reach the reader regardless of whether the model remembered to disclose.
    const ra = (digest as { analysis?: { ruleAnalysis?: { linkageMethod?: string } } }).analysis?.ruleAnalysis;
    const tb = (digest as { toolBinding?: { layered?: boolean; registryTools?: number } }).toolBinding;
    const tbLine = tb?.layered ? `<br>· 工具绑定：本体层按分层设计不声明工具（正常现象，非缺陷）——由 Agent 工厂在设计期从全局注册表（${tb.registryTools ?? 0} 个工具）语义绑定，缺凭证走 ask_user。` : "";
    const footer = `\n<section style="max-width:880px;margin:32px auto 8px;padding:14px 18px;border:1px solid #ddd;border-radius:10px;background:#fafafa;font-size:12.5px;color:#666;line-height:1.7"><b style="color:#444">附：数据与方法</b><br>· 数据源：业务域「${escStr(job.domainName ?? job.domain)}」本体全量（${ont.actions.length} 动作 · ${ont.events.length} 事件 · ${ont.rules.length} 规则 · ${ont.objects.length} 数据对象）。<br>· 规则统计基于全量；正文引用的规则明细来自分层采样（${escStr(String((digest as Record<string, unknown>).rulesSampleNote ?? ""))}）。<br>· 规则→动作关联方法：${escStr(ra?.linkageMethod ?? "（未知）")}。${tbLine}<br>· 事件分类（外部入口 / 内部链路 / 终态或外部交接）与断链候选由系统按生产者-消费者关系确定性判定，图表由确定性渲染器生成；模型仅负责业务解读。<br>· 撰写通道：${escStr(narrativeVia)}。<br>· 接地审校：${escStr(verifyNote)}。</section>`;
    // #BLUEPRINT — a build_blueprint section (its own deterministic SVGs + grounded phases) is
    // appended before the footer so the blueprint ships inside this report's HTML/PDF verbatim.
    const withBlueprint = extraHtml ? `${footer}\n${extraHtml}` : footer;
    const withFooter = finalHtml.includes("</body>") ? finalHtml.replace("</body>", () => `${withBlueprint}\n</body>`) : `${finalHtml}${withBlueprint}`;
    const html = substituteCharts(withFooter, charts);
    const dir = reportArchiveDir(job.tenantSlug);
    fs.mkdirSync(dir, { recursive: true });
    const stem = `ontology-${job.domain.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40)}-${job.id.slice(-6)}`;
    const htmlPath = path.join(dir, `${stem}.html`);
    writeDurableArtifact(htmlPath, html);
    const htmlArt = insertArtifactRow(job.tenantId, job.runId ?? job.id, "text/html", htmlPath);
    job.artifacts.push({ id: htmlArt.id, kind: "text/html", size: htmlArt.size, label: "HTML 报告" });
    persistJob(job); // #AUDIT-FIX(L33)

    if (job.format === "pdf" || job.format === "both") {
      setPhase("打印 PDF");
      if (!findChrome()) {
        const message = "PDF 生成失败：未找到本机 Chrome/Chromium（可安装 Chrome 或设置 CHROME_PATH 后重试）。";
        if (job.format === "pdf") throw new Error(message);
        job.note = `${message}HTML 版本已生成。`;
      } else {
        try {
          const pdfPath = path.join(dir, `${stem}.pdf`);
          await htmlFileToPdf(htmlPath, pdfPath);
          fsyncArtifact(pdfPath);
          const pdfArt = insertArtifactRow(job.tenantId, job.runId ?? job.id, "application/pdf", pdfPath);
          job.artifacts.push({ id: pdfArt.id, kind: "application/pdf", size: pdfArt.size, label: "PDF 报告" });
          persistJob(job); // #AUDIT-FIX(L33)
        } catch (e) {
          const message = `PDF 打印失败：${(e as Error).message ?? String(e)}。`;
          if (job.format === "pdf") throw new Error(message, { cause: e });
          job.note = `${message}HTML 版本已生成。`;
        }
      }
    }

    job.status = "done";
  } catch (e) {
    job.status = "error";
    job.error = (e as Error).message ?? String(e);
  } finally {
    job.phase = undefined;
    job.finishedAt = Date.now();
    persistJob(job);
  }
}

/** Clear a FINISHED job (panel's Clear / per-item dismiss). Running jobs are refused —
 *  there is no abort path for the in-flight promise, so hiding it would lie. */
export function deleteReportJob(id: string, tenantId?: string): boolean {
  const j = jobs.get(id);
  if (!j || (tenantId && j.tenantId !== tenantId) || j.status === "running") return false;
  unlinkJob(id);
  jobs.delete(id);
  return true;
}

export function startOntologyReportJob(opts: {
  tenantId: string;
  tenantSlug: string;
  domain: string;
  format: ReportFormat;
  focus?: string;
  /** #BLUEPRINT — pre-rendered ontology-grounded blueprint section appended into the report. */
  extraHtml?: string;
}): ReportJob {
  const jobId = makeId("rpt");
  // Claim durable active-work ownership before the first binding read. A
  // rebind in another API process now either completes before this claim (and
  // this check sees the new identity) or is refused until the report ends.
  const endActiveWork = beginFactoryActiveWork(opts.tenantId, jobId, "report");
  // Service-level trust boundary: reports may be started by the brain port or
  // another internal caller, not only by the guarded HTTP route.
  let job: ReportJob;
  try {
    const binding = getFactoryDomainBinding(opts.tenantId);
    if (!binding) throw new Error(`业务领域「${opts.tenantSlug}」尚未连接本体，拒绝生成报告。`);
    if (binding.ontologyDomainId !== opts.domain) {
      throw new Error(`业务领域「${opts.tenantSlug}」只允许分析已连接本体「${binding.ontologyDomainId}」，不能分析「${opts.domain}」。`);
    }
    job = {
      id: jobId,
      kind: "ontology-report",
      tenantId: opts.tenantId,
      tenantSlug: opts.tenantSlug,
      domain: opts.domain,
      format: opts.format,
      focus: opts.focus,
      status: "running",
      createdAt: Date.now(),
      artifacts: [],
    };
    persistJob(job);
    jobs.set(job.id, job);
  } catch (error) {
    endActiveWork();
    throw error;
  }
  evict();
  void runJob(job, opts.extraHtml)
    .catch((error) => {
      job.status = "error";
      job.error = `报告任务状态持久化失败：${error instanceof Error ? error.message : String(error)}`;
      job.phase = undefined;
      job.finishedAt = Date.now();
      console.error(`[factory-report] ${job.id}: ${job.error}`);
    })
    .finally(endActiveWork);
  return job;
}
