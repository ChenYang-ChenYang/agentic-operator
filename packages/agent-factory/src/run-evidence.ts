// #RUN-EVIDENCE (P1-1) — 大脑读取【持久运行证据】的读路径。
//
// 缺陷（实测）：`inspect_run` 只读内存里的 `ctx.lastSandbox`（ranAgents/degradedAgents），输出永远
// 只有 ran|degraded|missed 三个词——没有一句错误原文、没有工具名、没有任何可引用的位置；而且
// `ctx.lastSandbox` 一旦不在（新会话、别人的运行、重启之后），它直接罢工说「还没 sandbox_run」。
// 于是「为什么失败」只剩两条路：让 LLM 对着同一份内存状态猜（analyze_failure），或者让 FDE 去翻 UI。
//
// 证据一直在盘上：`<dataRoot>/logs/factory-runs/<tenant>/<runId>.ndjson`——append-only NDJSON，
// 一次 factory run 的事件全量真源（含 think 增量），由 apps/api 的 factory-run-transcript.ts 写入。
// 在此之前它唯一的读者是 run-registry 的 SSE 重放；没有任何大脑工具能碰到它。
//
// 三条纪律：
//
//  1) 租户隔离在【地址】里，不在过滤器里。读哪个目录完全由调用方已认证的 tenantId 决定，runId 只是
//     文件名；「读别人租户的 run」因此在物理上就是一次 miss，而不是一次「记得写 where」的判断。缺少
//     可验证 tenant 身份时 fail closed（拒读），绝不退化成共享目录。
//
//  2) 有界，而且把界【说出来】。33MB 的流不可能进 prompt。逐行流式扫描（常驻内存 = 一行 + 上限
//     内的若干帧），只留决策相关帧；任何一处触到上限都产出显式的 truncation 通知——对齐 #ACI 的
//     windowToolOutput（packages/runtime/src/step-engine.ts）与 harness telemetry 的
//     `telemetry_truncated`（apps/api/src/services/ontocode-harness-worker.ts）纪律：静默截断等于
//     对运行撒谎。
//
//  3) 只给【证据引用】，不给散文。每条选中帧携带 index + 绝对 byteOffset + t + stage + tool + ts，
//     所以下游答案可以指着说「第 568 帧（偏移 1047491）的 tool.result ok:false」，可复核。时间戳是
//     run-registry 在唯一 emit 收口处盖的服务端墙上钟（#OBSERVABILITY 的 `ts`，unix-ms）；帧上没有
//     它就不给，绝不臆造一个时间。
//
// 与 run-analysis.ts 的分工：那个模块把【已经拿到手】的 BrainEvent[] 交给 LLM 写叙事评审；它没有读
// 路径，也不产出可引用位置。本模块只负责「取到并选出证据」，不做判断——判断留给大脑。
//
// 布局说明（唯一的重复点，故意留下）：写入方 apps/api/.../factory-run-transcript.ts 有它自己的一份
// 路径推导。它没有改成 import 这里，是因为 apps/api/test/factory-run-terminal-durability.test.ts 用
// 非 partial 的 `vi.mock("@agentic/agent-factory", …)`——写入方多一个来自该 barrel 的【值】导入就会
// 让那套测试整体炸掉（另一位工程师刚踩过同一颗雷）。防漂移改由跨边界不变量测试承担：
// apps/api/test/tc-factory-run-evidence-layout.test.ts —— 用真实写入方写、用本模块读，读不到即红。

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { sanitizeSensitiveInput } from "./sensitive-input";

// ── 布局契约（与写入方逐字一致；见文件头「布局说明」） ────────────────────────

const TRANSCRIPT_EXT = ".ndjson";

/** 未绑定 tenant 的运行落在这里。读路径【永不】寻址它：一次无租户身份的读取是拒读，不是共享读。 */
const UNSCOPED_TENANT_SEGMENT = "_shared";

function dataRoot(): string {
  return process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
}

/** Path-safe segment：id 是不透明字符串，绝不允许其中一个逃出目录。 */
export function runTranscriptSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_");
  return cleaned.slice(0, 200) || "_";
}

/** 一个租户全部持久转录所在目录。 */
export function runTranscriptDir(tenantId: string): string {
  return path.resolve(
    dataRoot(),
    "logs",
    "factory-runs",
    runTranscriptSegment(tenantId || UNSCOPED_TENANT_SEGMENT),
  );
}

/** 某次运行的持久转录文件。 */
export function runTranscriptFile(tenantId: string, runId: string): string {
  return path.join(
    runTranscriptDir(tenantId),
    `${runTranscriptSegment(runId)}${TRANSCRIPT_EXT}`,
  );
}

// ── 失败探针（按【字段】声明，绝不按事件类型 t 声明） ──────────────────────────

/**
 * 一条字段级失败探针。刻意以 FIELD 为键、绝不以事件判别式 `t` 为键：一张 `t` 白名单对【之后新增的
 * 每一个 BrainEvent 变体】都是 fail OPEN（#TOOL-EFFECT 为工具元数据关掉的正是同一个洞）。一条带
 * `ok:false` 的帧是决策相关的，跟本文件听说过它的 `t` 没有关系。
 */
export interface RunEvidenceProbe {
  /** 探针读取的顶层字段名。 */
  field: string;
  /** 命中后记在帧上的信号标签——下游答案引用的就是它。 */
  signal: string;
  failed(value: unknown): boolean;
}

function nonEmptyText(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function nonEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * 断言「正常」的 status 取值。其它一切——包括本文件从没见过的 status——都算决策相关。
 *
 * 方向是刻意的、fail-closed 的：多收一帧的代价是几百字符窗口；少收一帧的代价可能是丢掉【唯一】解释
 * 这次失败的那一帧。所以未知 status 一律进证据面，而不是被默默放行。
 */
export const RUN_EVIDENCE_HEALTHY_STATUS: ReadonlySet<string> = new Set([
  "finished",
  "ok",
  "active",
  "ran",
  "running",
  "queued",
  "draft",
  "retired",
  "ephemeral",
  "pass",
  "passed",
  "success",
  "succeeded",
  "completed",
]);

/** 全部探针。新增一条就是新增一列证据面，不需要动任何事件类型判断。 */
export const RUN_EVIDENCE_PROBES: readonly RunEvidenceProbe[] = [
  // true = 这一步是好的 ⇒ false 才是失败。
  { field: "ok", signal: "ok:false", failed: (v) => v === false },
  { field: "pass", signal: "pass:false", failed: (v) => v === false },
  { field: "allPass", signal: "allPass:false", failed: (v) => v === false },
  {
    field: "reachedSuccessTerminal",
    signal: "未到成功终态",
    failed: (v) => v === false,
  },
  { field: "fullChainRan", signal: "整链未跑通", failed: (v) => v === false },
  // true = 这一步坏了。
  { field: "deployFailed", signal: "部署失败", failed: (v) => v === true },
  { field: "degraded", signal: "降级", failed: (v) => v === true },
  { field: "regression", signal: "评分退步", failed: (v) => v === true },
  // 一段非空的诊断原文本身就是证据。
  { field: "error", signal: "error", failed: nonEmptyText },
  { field: "message", signal: "error_message", failed: nonEmptyText },
  { field: "stopReason", signal: "stopReason", failed: nonEmptyText },
  { field: "syncError", signal: "syncError", failed: nonEmptyText },
  { field: "transportError", signal: "transportError", failed: nonEmptyText },
  // 一串非空的抱怨清单。
  { field: "issues", signal: "校验问题", failed: nonEmptyList },
  { field: "degradedAgents", signal: "降级 agent", failed: nonEmptyList },
  { field: "fidelityFailures", signal: "保真违约", failed: nonEmptyList },
  {
    field: "uncoveredExternalInputs",
    signal: "缺外部输入",
    failed: nonEmptyList,
  },
  // 一个本文件无法确认为健康的 status（见 RUN_EVIDENCE_HEALTHY_STATUS 的 fail-closed 说明）。
  {
    field: "status",
    signal: "status",
    failed: (v) => typeof v === "string" && !RUN_EVIDENCE_HEALTHY_STATUS.has(v),
  },
];

/** 一帧命中的全部信号（空数组 = 这帧不是失败证据）。纯函数，可单测。 */
export function frameFailureSignals(frame: Record<string, unknown>): string[] {
  const signals: string[] = [];
  for (const probe of RUN_EVIDENCE_PROBES) {
    if (!(probe.field in frame)) continue;
    if (probe.failed(frame[probe.field])) signals.push(probe.signal);
  }
  return signals;
}

// ── 上限 ──────────────────────────────────────────────────────────────────────

export interface RunEvidenceLimits {
  /** 从转录【尾部】最多读取的字节数（尾部才有终态与晚期失败）。 */
  maxScanBytes: number;
  /** 单行最长字节数；超过即视为损坏行计入 parseErrors（防一行 33MB 把内存吃光）。 */
  maxLineBytes: number;
  /** 最多保留几条失败帧。 */
  maxFailures: number;
  /** 终态帧之前保留几帧上下文。 */
  leadUp: number;
  /** 单帧原文窗口（字符）。 */
  frameChars: number;
  /** 序列化后的证据载荷硬上限（字符）。 */
  maxPayloadChars: number;
}

function envInt(name: string, fallback: number, floor: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= floor ? Math.floor(raw) : fallback;
}

/**
 * 默认上限。maxPayloadChars 默认 12,000：远低于 conductor 的 FACTORY_TOOL_RESULT_CAP（60,000），
 * 因为一次【诊断读】不该吃掉整个上下文窗口——大脑还要拿它去改东西。
 */
export function runEvidenceLimits(
  overrides: Partial<RunEvidenceLimits> = {},
): RunEvidenceLimits {
  const base: RunEvidenceLimits = {
    maxScanBytes: envInt(
      "FACTORY_RUN_EVIDENCE_SCAN_BYTES",
      64 * 1024 * 1024,
      64 * 1024,
    ),
    maxLineBytes: envInt(
      "FACTORY_RUN_EVIDENCE_LINE_BYTES",
      8 * 1024 * 1024,
      4 * 1024,
    ),
    maxFailures: envInt("FACTORY_RUN_EVIDENCE_MAX_FRAMES", 12, 1),
    leadUp: envInt("FACTORY_RUN_EVIDENCE_LEAD_UP", 8, 0),
    frameChars: envInt("FACTORY_RUN_EVIDENCE_FRAME_CHARS", 600, 80),
    maxPayloadChars: envInt("FACTORY_RUN_EVIDENCE_PAYLOAD_CHARS", 12_000, 2_000),
  };
  const merged = { ...base, ...overrides };
  // 上限只能被【收紧或放宽到合法范围内】，绝不能被调用方传成 0/负数把守卫关掉。
  return {
    maxScanBytes: Math.max(64 * 1024, Math.floor(merged.maxScanBytes)),
    maxLineBytes: Math.max(4 * 1024, Math.floor(merged.maxLineBytes)),
    maxFailures: Math.max(1, Math.floor(merged.maxFailures)),
    leadUp: Math.max(0, Math.floor(merged.leadUp)),
    frameChars: Math.max(80, Math.floor(merged.frameChars)),
    maxPayloadChars: Math.max(2_000, Math.floor(merged.maxPayloadChars)),
  };
}

/**
 * 单块原文窗口：留头 + 留尾，中间放一个【说出省略了多少】的标记。行为刻意镜像 #ACI 的
 * windowToolOutput（packages/runtime/src/step-engine.ts，只读、不可编辑），这里不 import 它是因为
 * @agentic/agent-factory 不依赖 @agentic/runtime。
 */
export function windowEvidenceText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = Math.floor(cap * 0.7);
  const tail = Math.max(0, cap - head);
  return `${text.slice(0, head)}…[截断：省略 ${text.length - cap} 字符]…${tail ? text.slice(text.length - tail) : ""}`;
}

// ── 结果形状 ──────────────────────────────────────────────────────────────────

export interface RunEvidenceFrame {
  /** 追加序号（引用用）。`indexOrigin` 说明它是文件内真实序号还是扫描窗口内相对序号。 */
  index: number;
  /** 该行在 NDJSON 文件里的【绝对】字节偏移——最强的引用，与是否跳过头部无关。 */
  byteOffset: number;
  /** BrainEvent 判别式。 */
  t: string;
  /** 让这帧成为证据的信号；上下文帧为空数组。 */
  signals: string[];
  /** 该帧生效时的流水线阶段（流里声明过才有）。 */
  stage?: string;
  /** 该帧涉及的工具名（帧自己带 `name` 才有）。 */
  tool?: string;
  /** 服务端墙上钟（unix-ms）。run-registry 在唯一 emit 收口处盖的 `#OBSERVABILITY` ts；
   *  帧上没有就缺席——绝不臆造一个时间。 */
  ts?: number;
  /** >0 ⇔ excerpt 是【脱敏后】的渲染（这么多个字段/值被判为密钥形并替换）。缺席 = 逐字原文。 */
  redacted?: number;
  /** 该帧 JSON 原文的窗口化片段。 */
  excerpt: string;
}

export interface RunEvidence {
  schema: "agent-factory-run-evidence/v1";
  source: "factory-run-transcript-ndjson";
  runId: string;
  /** false = 本租户下没有这次运行的持久转录。没有证据就不给结论。 */
  found: boolean;
  /** 扫描到的帧数。 */
  frames: number;
  /** 转录文件总字节数。 */
  bytes: number;
  /** "file" = index 是文件内真实追加序号；"scan_window" = 头部被跳过，index 是窗口内相对序号。 */
  indexOrigin: "file" | "scan_window";
  /** 命中探针的帧总数（未受 focus / 上限影响）。 */
  failureCount: number;
  /** 调用方给的收窄关键词（原样回显，便于复核这份证据面是怎么来的）。 */
  focus?: string;
  /** focus 生效时，同时命中探针与全部关键词的帧数。 */
  focusMatched?: number;
  /** 保留下来的失败帧：取最早的一半 + 最晚的一半（最早常是根因，最晚离终态最近）。 */
  failures: RunEvidenceFrame[];
  /** 因上限被丢掉的失败帧数。>0 时 truncation 里必有一条对应通知。 */
  failuresOmitted: number;
  /** 终态帧之前的若干帧（append-only 日志里「最后发生的事」）。 */
  leadUp: RunEvidenceFrame[];
  /** 终态帧 = 文件最后一帧（结构性判定，不是 t 白名单）。 */
  terminal: RunEvidenceFrame | null;
  /** 这次运行的服务端时间跨度（首帧 → 末帧 ts）。两端都有 ts 才给——半个跨度不如没有。 */
  tsRange?: { first: number; last: number };
  /** 解析失败被跳过的行数（崩溃中途的残行 / 超长行 / 磁盘损坏）。 */
  parseErrors: number;
  /** 显式损失清单。为空 ⇔ 这份载荷对扫描到的内容是完整的。 */
  truncation: string[];
}

export interface RunTranscriptListEntry {
  /** 文件名还原出的 run id（写入方对 id 做过 path-safe 归一，`frn-…` 形态下与原 id 一致）。 */
  runId: string;
  bytes: number;
  modifiedAt: number;
}

// ── 读取 ──────────────────────────────────────────────────────────────────────

/**
 * 本租户最近有持久转录的运行（新到旧）。用途只有一个：run id 没命中时【如实】给出可选项，而不是
 * 让大脑对着一个不存在的 id 编原因。目录即租户边界。
 *
 * 有界说明：run id 是随机的，文件名顺序与时间无关，而排序需要 mtime、mtime 需要 stat。所以本函数
 * 只对最多 STAT_SCAN_CAP 个条目做 stat；超过这个数量时返回的是【有界样本里最新的几个】，不保证是全
 * 目录最新的几个。这只是一句提示性的可选项，不是索引——任何依赖「完整最新列表」的功能都不该用它。
 */
const STAT_SCAN_CAP = 2_000;

export async function listRunTranscripts(
  tenantId: string,
  limit = 8,
): Promise<RunTranscriptListEntry[]> {
  const dir = runTranscriptDir(tenantId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const candidates = names
    .filter((name) => name.endsWith(TRANSCRIPT_EXT))
    .sort()
    .slice(-STAT_SCAN_CAP);
  const rows: RunTranscriptListEntry[] = [];
  for (const name of candidates) {
    try {
      const info = await stat(path.join(dir, name));
      rows.push({
        runId: name.slice(0, -TRANSCRIPT_EXT.length),
        bytes: info.size,
        modifiedAt: info.mtimeMs,
      });
    } catch {
      /* 竞态删除：跳过，不算失败 */
    }
  }
  rows.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return rows.slice(0, Math.max(1, limit));
}

/** 逐行流式读取，产出每行的【绝对】字节偏移。内存驻留 = 一行（受 maxLineBytes 限制）。 */
async function* iterateLines(
  file: string,
  startByte: number,
  maxLineBytes: number,
): AsyncGenerator<{ byteOffset: number; text: string | null }> {
  const stream = createReadStream(file, { start: startByte });
  let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let offset = startByte;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const buf: Buffer<ArrayBufferLike> = carry.length
      ? Buffer.concat([carry, chunk])
      : chunk;
    let from = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, from);
      if (nl === -1) break;
      const line = buf.subarray(from, nl);
      // `\n` 不会出现在 UTF-8 多字节序列内部，所以按字节切行对中文安全。
      yield {
        byteOffset: offset,
        text: line.length > maxLineBytes ? null : line.toString("utf8"),
      };
      offset += line.length + 1;
      from = nl + 1;
    }
    carry = buf.subarray(from);
    if (carry.length > maxLineBytes) {
      // 一行长到超过上限：作为损坏行报出并丢弃，绝不无界增长 carry。
      yield { byteOffset: offset, text: null };
      offset += carry.length;
      carry = Buffer.alloc(0);
    }
  }
  if (carry.length)
    yield {
      byteOffset: offset,
      text: carry.length > maxLineBytes ? null : carry.toString("utf8"),
    };
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** `ts` is the canonical server-stamped wall clock (#OBSERVABILITY, run-registry.bufferEvent).
 *  `at` is accepted as a fallback so an event that stamped itself is not silently timeless. */
function frameTs(parsed: Record<string, unknown>): number | undefined {
  for (const key of ["ts", "at"] as const) {
    const value = parsed[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** 扫描期只留这些（廉价、有界）；窗口化 + 脱敏只在【真的被留下来】的帧上做一次。 */
interface PendingFrame {
  index: number;
  byteOffset: number;
  raw: string;
  parsed: Record<string, unknown>;
  signals: string[];
  stage: string | undefined;
}

function buildFrame(
  pending: PendingFrame,
  frameChars: number,
): RunEvidenceFrame {
  const { parsed } = pending;
  const ts = frameTs(parsed);
  // 证据帧会进入【另一个会话】的上下文与检查点。转录里的 tool.result 输出从来不保证脱敏过，
  // 所以原文在离开本模块前必须过一遍密钥/密钥形值的脱敏；脱敏发生了就在帧上标出来，
  // 让「这段原文被改动过」是一个可见事实而不是一个静默替换。byteOffset 仍指向真实那一行。
  const scan = sanitizeSensitiveInput(parsed, "frame");
  const text = scan.paths.length ? JSON.stringify(scan.sanitized) : pending.raw;
  return {
    index: pending.index,
    byteOffset: pending.byteOffset,
    t: textOf(parsed.t) ?? "(unknown)",
    signals: pending.signals,
    ...(pending.stage ? { stage: pending.stage } : {}),
    ...(textOf(parsed.name) ? { tool: textOf(parsed.name) } : {}),
    ...(ts !== undefined ? { ts } : {}),
    ...(scan.paths.length ? { redacted: scan.paths.length } : {}),
    excerpt: windowEvidenceText(text, frameChars),
  };
}

export interface ReadRunEvidenceInput {
  /** 已认证租户 id。地址的一部分，不是过滤器。 */
  tenantId: string;
  runId: string;
  /** 空格分隔关键词；全部命中的失败帧才进证据面（与 recall_conversation 同一套关键词方言）。 */
  focus?: string;
  limits?: Partial<RunEvidenceLimits>;
}

/**
 * 读一次运行的持久转录，选出决策相关证据帧并强制载荷上限。
 *
 * 「读不到」与「没有失败」是两件事：文件不存在/不可读 ⇒ `found:false`（调用方必须如实说没有证据），
 * 绝不返回一个空的成功结果假装这次运行是干净的。
 */
export async function readRunEvidence(
  input: ReadRunEvidenceInput,
): Promise<RunEvidence> {
  const limits = runEvidenceLimits(input.limits);
  const runId = input.runId.slice(0, 200);
  const empty: RunEvidence = {
    schema: "agent-factory-run-evidence/v1",
    source: "factory-run-transcript-ndjson",
    runId,
    found: false,
    frames: 0,
    bytes: 0,
    indexOrigin: "file",
    failureCount: 0,
    failures: [],
    failuresOmitted: 0,
    leadUp: [],
    terminal: null,
    parseErrors: 0,
    truncation: [],
  };
  if (!input.tenantId.trim()) return empty;

  const file = runTranscriptFile(input.tenantId, input.runId);
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return empty;
    size = info.size;
  } catch {
    return empty;
  }

  const terms = (input.focus ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const startByte = size > limits.maxScanBytes ? size - limits.maxScanBytes : 0;
  const truncation: string[] = [];
  if (startByte > 0)
    truncation.push(
      `转录 ${size} 字节超过单次扫描上限 ${limits.maxScanBytes}，只扫了尾部 ${limits.maxScanBytes} 字节（头部 ${startByte} 字节未读，其中的失败帧不在本结果内）；帧序号是扫描窗口内相对序号，字节偏移仍是文件绝对偏移。`,
    );

  const headKeep = Math.ceil(limits.maxFailures / 2);
  const tailKeep = limits.maxFailures - headKeep;
  const head: PendingFrame[] = [];
  const tail: PendingFrame[] = [];
  const ring: PendingFrame[] = [];
  let index = -1;
  let frames = 0;
  let parseErrors = 0;
  let failureCount = 0;
  let focusMatched = 0;
  let stage: string | undefined;
  let terminal: PendingFrame | null = null;
  let firstTs: number | undefined;
  let droppedFirstPartial = startByte === 0;

  for await (const line of iterateLines(file, startByte, limits.maxLineBytes)) {
    if (!droppedFirstPartial) {
      // 从字节偏移起读时，第一行几乎一定是半条记录——按写入方同样的规则跳过。
      droppedFirstPartial = true;
      continue;
    }
    if (line.text === null) {
      parseErrors += 1;
      continue;
    }
    const raw = line.text.trim();
    if (!raw) continue;
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        parseErrors += 1;
        continue;
      }
      parsed = value as Record<string, unknown>;
    } catch {
      // 崩溃中途的残行：跳过并计数，绝不当成一条真事件。
      parseErrors += 1;
      continue;
    }
    index += 1;
    frames += 1;
    const declaredStage = textOf(parsed.stage);
    if (declaredStage) stage = declaredStage;
    if (firstTs === undefined) firstTs = frameTs(parsed);
    const signals = frameFailureSignals(parsed);

    const pending: PendingFrame = {
      index,
      byteOffset: line.byteOffset,
      raw,
      parsed,
      signals,
      stage,
    };

    // 终态帧 = 最后一帧（append-only 日志的结构性事实，不是 t 白名单）。
    if (terminal) {
      ring.push(terminal);
      if (ring.length > limits.leadUp) ring.shift();
    }
    terminal = pending;

    if (!signals.length) continue;
    failureCount += 1;
    const haystack = raw.toLowerCase();
    if (terms.length && !terms.every((term) => haystack.includes(term)))
      continue;
    focusMatched += 1;
    if (head.length < headKeep) head.push(pending);
    else if (tailKeep > 0) {
      tail.push(pending);
      if (tail.length > tailKeep) tail.shift();
    }
  }

  const retained = (tailKeep > 0 ? [...head, ...tail] : [...head]).map((p) =>
    buildFrame(p, limits.frameChars),
  );
  const eligible = terms.length ? focusMatched : failureCount;
  const failuresOmitted = Math.max(0, eligible - retained.length);
  if (failuresOmitted > 0)
    truncation.push(
      `失败帧共 ${eligible} 条，只带回 ${retained.length} 条（最早 ${head.length} + 最晚 ${tail.length}），省略 ${failuresOmitted} 条；要看省略的部分请用 focus 关键词收窄或调高 limit。`,
    );
  if (parseErrors > 0)
    truncation.push(
      `有 ${parseErrors} 行无法解析（崩溃中途的残行 / 超长行），已跳过；它们的内容不在本结果内。`,
    );

  const terminalFrame = terminal ? buildFrame(terminal, limits.frameChars) : null;
  const lastTs = terminalFrame?.ts;
  const evidence: RunEvidence = {
    schema: "agent-factory-run-evidence/v1",
    source: "factory-run-transcript-ndjson",
    runId,
    found: true,
    frames,
    bytes: size,
    indexOrigin: startByte > 0 ? "scan_window" : "file",
    failureCount,
    ...(terms.length ? { focus: terms.join(" "), focusMatched } : {}),
    failures: retained,
    failuresOmitted,
    leadUp: ring.map((p) => buildFrame(p, limits.frameChars)),
    terminal: terminalFrame,
    ...(firstTs !== undefined && lastTs !== undefined
      ? { tsRange: { first: firstTs, last: lastTs } }
      : {}),
    parseErrors,
    truncation,
  };
  return enforceEvidenceBudget(evidence, limits);
}

/**
 * 强制载荷上限。任何一次收缩都必须留下一条【说出来】的通知——静默变小和静默丢失一样是撒谎。
 * 返回值保证 `JSON.stringify(result).length <= limits.maxPayloadChars`。
 */
export function enforceEvidenceBudget(
  evidence: RunEvidence,
  limits: RunEvidenceLimits,
): RunEvidence {
  const cap = limits.maxPayloadChars;
  const size = (value: RunEvidence): number => JSON.stringify(value).length;
  if (size(evidence) <= cap) return evidence;

  const shrunk: RunEvidence = {
    ...evidence,
    failures: evidence.failures.map((f) => ({ ...f })),
    leadUp: evidence.leadUp.map((f) => ({ ...f })),
    terminal: evidence.terminal ? { ...evidence.terminal } : null,
    truncation: [...evidence.truncation],
  };
  const note = (text: string): void => {
    if (!shrunk.truncation.includes(text)) shrunk.truncation.push(text);
  };
  const allFrames = (): RunEvidenceFrame[] => [
    ...shrunk.failures,
    ...shrunk.leadUp,
    ...(shrunk.terminal ? [shrunk.terminal] : []),
  ];

  // 1) 逐级收紧单帧原文窗口。
  let appliedFrameCap: number | null = null;
  for (const frameCap of [300, 160, 80]) {
    if (size(shrunk) <= cap) break;
    for (const frame of allFrames())
      frame.excerpt = windowEvidenceText(frame.excerpt, frameCap);
    appliedFrameCap = frameCap;
  }
  if (appliedFrameCap !== null)
    note(
      `证据载荷超过 ${cap} 字符上限，已把每帧原文窗口收紧到 ${appliedFrameCap} 字符；要看某一帧的完整原文请带 focus 关键词重取。`,
    );
  // 2) 丢最早的上下文帧（离终态最远的先走）。
  while (shrunk.leadUp.length && size(shrunk) > cap) {
    shrunk.leadUp.shift();
    note("证据载荷仍超上限，已丢弃部分终态前上下文帧（只保留离终态最近的几帧）。");
  }
  // 3) 从中间丢失败帧（最早的根因帧与最晚的近终态帧最后走）。
  while (shrunk.failures.length > 2 && size(shrunk) > cap) {
    shrunk.failures.splice(Math.floor(shrunk.failures.length / 2), 1);
    shrunk.failuresOmitted += 1;
    note("证据载荷仍超上限，已从中间丢弃失败帧；首尾（最早根因 / 最近终态）保留。");
  }
  if (size(shrunk) <= cap) return shrunk;

  // 4) 兜底：连骨架都超上限（例如上限被压到最小值）。返回一个自述其损失的最小结果，
  //    绝不返回一个超上限的载荷去撑爆上下文。
  const minimal: RunEvidence = {
    ...shrunk,
    failures: [],
    failuresOmitted: shrunk.failuresOmitted + shrunk.failures.length,
    leadUp: [],
    terminal: shrunk.terminal
      ? { ...shrunk.terminal, excerpt: windowEvidenceText(shrunk.terminal.excerpt, 200) }
      : null,
    truncation: [
      `证据载荷无法压进 ${cap} 字符上限，本次只返回统计与终态帧；请提高 FACTORY_RUN_EVIDENCE_PAYLOAD_CHARS 或用 focus 关键词收窄后重取。`,
    ],
  };
  if (size(minimal) <= cap) return minimal;
  return { ...minimal, terminal: null };
}

/** 一行人类可读的证据概要（工具 summary 与 UI 共用，避免两处各写一遍口径）。 */
export function summarizeRunEvidence(evidence: RunEvidence): string {
  if (!evidence.found)
    return `没有运行 ${evidence.runId} 的持久转录。`;
  const kb = Math.max(1, Math.round(evidence.bytes / 1024));
  const focusNote =
    evidence.focus !== undefined
      ? `（关键词「${evidence.focus}」命中 ${evidence.focusMatched ?? 0} 条）`
      : "";
  const terminalNote = evidence.terminal
    ? `终态帧 #${evidence.terminal.index} ${evidence.terminal.t}${evidence.terminal.signals.length ? `（${evidence.terminal.signals.join("、")}）` : ""}`
    : "转录为空，没有终态帧";
  const failureNote = evidence.failureCount
    ? `失败帧 ${evidence.failureCount} 条${focusNote}，已带回 ${evidence.failures.length} 条原文与位置`
    : `没有任何帧命中失败探针${focusNote}`;
  const lossNote = evidence.truncation.length
    ? ` · ⚠ ${evidence.truncation.length} 处有界截断（见 truncation）`
    : "";
  const spanNote = evidence.tsRange
    ? ` · 服务端跨度 ${Math.max(0, Math.round((evidence.tsRange.last - evidence.tsRange.first) / 1000))}s（结束于 ${new Date(evidence.tsRange.last).toISOString()}）`
    : "";
  return `运行 ${evidence.runId}：${evidence.frames} 帧 / ${kb}KB${spanNote} · ${failureNote} · ${terminalNote}${lossNote}`;
}

/**
 * 把证据帧对上【本会话已知的 agent】：找到第一条原文里提到该 agent 名字的失败帧。
 *
 * 只做子串匹配，匹配用的名字完全由调用方传入（ctx.specs 的 slug/short）——本文件不认识任何具体
 * agent、tenant 或业务 id。匹配不上就返回 undefined，绝不硬塞一条「看起来像」的原因。
 */
export function attributeEvidenceToName(
  evidence: RunEvidence,
  names: readonly string[],
): { frame: RunEvidenceFrame; matched: string } | undefined {
  const wanted = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (!wanted.length) return undefined;
  for (const frame of evidence.failures) {
    const haystack = frame.excerpt.toLowerCase();
    const matched = wanted.find((name) => haystack.includes(name));
    if (matched) return { frame, matched };
  }
  return undefined;
}
