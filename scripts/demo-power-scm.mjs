#!/usr/bin/env node
/**
 * One-command driver for the power-scm launch demo (三个时刻).
 *
 * Brings the whole stack up in the ONE order that works, then fires the three
 * scenarios end-to-end — real Inngest fan-out, real LLM decisions, real graph
 * queries, real ERP writes — approving the human gates as they appear and
 * printing the evidence each scenario is supposed to produce.
 *
 *   node scripts/demo-power-scm.mjs            # up + run all three
 *   node scripts/demo-power-scm.mjs up         # just start services
 *   node scripts/demo-power-scm.mjs run 2      # just scenario 2 (1|2|3|all)
 *   node scripts/demo-power-scm.mjs status     # what is listening
 *   node scripts/demo-power-scm.mjs down       # stop everything this started
 *
 * Flags: --compile (recompile the ontology package first)
 *        --no-approve (leave human tasks pending, for demoing the portal)
 *        --keep-journal (skip the ERP journal reset)
 *        --verbose (keep the api request log at info; it is noisy)
 *
 * Start order is a dependency, not a habit: the root `predev` kills workspace
 * processes, so the mock ERP has to come up AFTER the api — and while the ERP
 * is down, write agents burn their Inngest retries and land in `failed`.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_DIR = path.join(ROOT, ".demo");
const ONTOLOGY_DIST =
  process.env.POWER_SCM_DIST
  ?? "/Users/kenny/CSI-AICOE/allmetaOntology/demo-packages/power-scm/dist";

const API = "http://localhost:3540";
const ERP = "http://localhost:3620";
const PORTAL = "http://localhost:3599";
const TENANT = "power-scm";
const HEAD = { "content-type": "application/json", "x-agentic-tenant": TENANT };

// ── tiny console kit ────────────────────────────────────────────────────────
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  amber: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const log = (...a) => console.log(...a);
const step = (s) => log(`\n${C.bold("▸")} ${C.bold(s)}`);
const ok = (s) => log(`  ${C.green("✓")} ${s}`);
const warn = (s) => log(`  ${C.amber("!")} ${s}`);
const fail = (s) => log(`  ${C.red("✗")} ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── service probes ──────────────────────────────────────────────────────────
function portPid(port) {
  const r = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  return r.stdout.trim().split("\n").filter(Boolean)[0] ?? null;
}

async function reachable(url, opts = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** The api answers /v1/runs long before /health goes green — /health also reports
 *  "degraded" whenever any tenant's connect-gateway is down, which is normal here. */
const apiReady = () => reachable(`${API}/v1/runs?limit=1`, { headers: HEAD });
const erpReady = () => reachable(`${ERP}/health`);

async function waitFor(label, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write(`  ${C.dim("…")} waiting for ${label}`);
  while (Date.now() < deadline) {
    if (await probe()) {
      process.stdout.write(`\r  ${C.green("✓")} ${label} ready${" ".repeat(20)}\n`);
      return true;
    }
    process.stdout.write(".");
    await sleep(2500);
  }
  process.stdout.write(`\r  ${C.red("✗")} ${label} did not come up in ${Math.round(timeoutMs / 1000)}s\n`);
  return false;
}

/**
 * Detached start with a TRUNCATING log.
 *
 * The api logs every request at info level, and this driver polls /v1/runs and
 * /v1/tasks while it waits — an appending, unrotated log turns that pair into a
 * loop that fills the disk, which first shows up as the mock ERP silently
 * failing to append to its journal. So: truncate per start, and quiet the
 * request log unless the caller asked for it.
 */
function startDetached(name, command, args, cwd, extraEnv = {}) {
  mkdirSync(RUN_DIR, { recursive: true });
  const logPath = path.join(RUN_DIR, `${name}.log`);
  const fd = openSync(logPath, "w");
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, ...extraEnv },
  });
  child.unref();
  writeFileSync(path.join(RUN_DIR, `${name}.pid`), String(child.pid));
  return logPath;
}

// ── neo4j (scenario 2's evidence source) ────────────────────────────────────
function neo4jHome() {
  const base = "/Users/kenny/Library/Application Support/neo4j-desktop/Application";
  const dbms = path.join(base, "Data/dbmss/dbms-bca1f667-bacb-43b2-83f5-9d376fb448b7");
  const jdk = path.join(base, "Cache/runtime/zulu21.44.17-ca-jdk21.0.8-macosx_aarch64");
  return existsSync(path.join(dbms, "bin/neo4j")) && existsSync(path.join(jdk, "bin/java"))
    ? { dbms, jdk }
    : null;
}

async function ensureNeo4j() {
  if (portPid(7687)) return ok("Neo4j already listening on :7687");
  const home = neo4jHome();
  if (!home) {
    warn("Neo4j is not running and the bundled DBMS was not found.");
    warn("Scenario 2 will still run, but the related-party judge will fail closed");
    warn("(证据不足 → violation) because 实控人 lives only in the graph.");
    return;
  }
  spawnSync(path.join(home.dbms, "bin/neo4j"), ["start"], {
    env: { ...process.env, JAVA_HOME: home.jdk, NEO4J_HOME: home.dbms },
    encoding: "utf8",
  });
  const up = await waitFor("Neo4j bolt :7687", async () => Boolean(portPid(7687)), 180_000);
  if (!up) warn("Neo4j did not start; scenario 2 will fail closed on the graph check.");
}

// ── api helpers ─────────────────────────────────────────────────────────────
async function api(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, { headers: HEAD, ...init });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${pathname} → ${res.status} ${text.slice(0, 200)}`);
  return body;
}

const runsForSubject = async (subject) =>
  ((await api("/v1/runs?limit=60")).data ?? []).filter((r) => r.subject === subject);

const openTasksForRuns = async (runIds) =>
  ((await api("/v1/tasks")).data ?? []).filter((t) => t.status === "open" && runIds.has(t.runId));

/** Tasks carry a formSchema, so a bare {decision} is rejected with 400 — the
 *  answer has to satisfy the form as well as the outcome. */
async function approve(task, comment) {
  await api(`/v1/tasks/${task.id}/resolve`, {
    method: "POST",
    body: JSON.stringify({
      decision: "approve",
      payload: { decision: "approve", comment },
    }),
  });
}

// ── scenarios ───────────────────────────────────────────────────────────────
/**
 * PSCM-EMG-004 asks whether the framework agreement is inside its validity
 * window *right now*. Without an as-of date in the payload the judge cannot
 * answer and correctly fails closed ("证据不足") — which silently drops the
 * emergency PO and makes the demo non-deterministic. A real 应急采购 event
 * carries its own as-of date, so the fixture does too.
 */
const TODAY = new Date().toISOString().slice(0, 10);

const SCENARIOS = {
  1: {
    name: "风暴 72 小时",
    blurb: "应急保供 · 一条缺口事件扇出四条并行处置",
    event: "PSCM_STOCK_GAP_IDENTIFIED",
    target: null,
    payload: {
      gap_report: {
        gap_exists: true,
        forecast_qty: 3200,
        available_qty: 1800,
        transfer: {
          material_id: "MAT-ST-P12",
          from_warehouse: "Warehouse-WZ-01",
          to_warehouse: "Warehouse-ST-01",
          qty: 1200,
        },
        lock: { lot_id: "InventoryLot-001", qty: 900 },
        recommended_po: {
          agreement_id: "FA-001",
          supplier_id: "SUP-004",
          material_id: "MAT-ST-P12",
          qty: 800,
        },
        agreement: {
          agreement_id: "FA-001",
          valid_from: "2025-10-24",
          valid_to: "2027-10-24",
          emergency_clause: true,
          as_of_date: TODAY,
        },
        collab: {
          target_entity_id: "LegalEntity-JY-001",
          material_id: "MAT-ST-P12",
          qty: 400,
        },
      },
      affected_regions: [
        { region_id: "GridRegion-ST-Chenghai", region_name: "汕头澄海网格", risk_level: "red" },
      ],
      as_of_date: TODAY,
    },
    approvalComment: "应急审批通过（自动演示）",
    expectOps: ["lockInventoryLot", "createEmergencyPo", "createTransferOrder", "createShipmentTask"],
    highlight: null,
  },
  2: {
    name: "一眼穿透",
    blurb: "供应商风险 · 图谱识破「马甲备选」",
    event: "PSCM_LEGAL_DISHONEST_RECEIVED",
    target: "action-scan-supplier-risk",
    payload: {
      risk_event: {
        event_id: "EXT-2026-0819-01",
        event_type: "legal_dishonest",
        supplier_id: "SUP-001",
        supplier_name: "南方电缆集团有限公司",
        source: "最高人民法院失信被执行人名单",
        published_at: "2026-08-19",
        summary:
          "SUP-001 被列入失信被执行人名单（执行标的 4200 万元），需立即穿透在手合同、在途订单与关键工程交付风险",
      },
      supplier_id: "SUP-001",
    },
    approvalComment: "风险处置确认（自动演示）",
    expectOps: ["sendExpediteNotice", "createInspectionTask", "addRiskFlag", "createRfq"],
    highlight: {
      agent: "action-scan-supplier-risk",
      render(output) {
        const screening = output?.exposure_report?.related_party_screening;
        if (!screening) return null;
        const rows = Array.isArray(screening) ? screening : [screening];
        const lines = rows.map((r) => {
          const shared = r.shares_controller_with_risk_supplier;
          const mark = shared ? C.red("✗ 关联方") : C.green("✓ 可用");
          return `      ${mark}  ${r.supplier_id ?? "?"}  实控人 ${r.controller_id ?? "?"}` +
            `  ${C.dim(r.disposition ?? r.screening_result ?? r.result ?? "")}`;
        });
        return ["    实控人穿透结果：", ...lines].join("\n");
      },
    },
  },
  3: {
    name: "拦下一张采购单",
    blurb: "两金压降 · 同物不同码 × 跨法人调剂",
    event: "PSCM_REQUISITION_SUBMITTED",
    target: "action-match-dormant-stock",
    payload: {
      requisition: {
        requisition_id: "REQ-2026-1101",
        material_id: "MAT-ST-XP70",
        material_name: "XP-70悬式绝缘子",
        req_qty: 30000,
        budget_amount: 1350000,
        requesting_entity_id: "LegalEntity-ST-001",
        status: "approved",
      },
    },
    approvalComment: "双边确认调剂（自动演示）",
    expectOps: ["suspendRequisition", "createAllocation", "confirmAllocation"],
    highlight: {
      agent: "action-match-dormant-stock",
      render(output) {
        const lot = output?.dormant_lot;
        const alloc = output?.allocation;
        if (!lot && !alloc) return null;
        const out = ["    拦截判定："];
        if (lot) {
          out.push(
            `      呆滞批次 ${lot.lot_id}（${lot.material_id}）` +
              `  库龄 ${lot.age_days} 天  ERP 状态 ${C.cyan(lot.status)}` +
              `  ${C.dim("← 呆滞是推导的，不是存的")}`,
          );
        }
        if (alloc) {
          out.push(
            `      调剂 ${alloc.qty} 件：${alloc.from_org_id} → ${alloc.to_org_id}` +
              `  可拦截 ${C.bold(Number(alloc.savings ?? 0).toLocaleString("zh-CN"))} 元`,
          );
        }
        return out.join("\n");
      },
    },
  },
};

async function readStepOutput(runId) {
  const dir = path.join(ROOT, "apps", "api", "artifacts", runId);
  for (const file of ["step-1-output.json", "output.json"]) {
    const p = path.join(dir, file);
    if (!existsSync(p)) continue;
    try {
      let d = JSON.parse(readFileSync(p, "utf8"));
      if (d && typeof d === "object" && "data" in d) d = d.data;
      if (typeof d === "string") d = JSON.parse(d);
      return d;
    } catch {
      /* fall through to the next candidate */
    }
  }
  return null;
}

/** /__journal answers {entries:[...]}; tolerate a bare array too so a shape
 *  change shows up as missing writes rather than a silently empty ledger. */
async function erpJournal() {
  try {
    const body = await (await fetch(`${ERP}/__journal`)).json();
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.entries)) return body.entries;
    if (Array.isArray(body?.data)) return body.data;
    return [];
  } catch {
    return [];
  }
}

async function runScenario(key, { approveTasks }) {
  const scn = SCENARIOS[key];
  const subject = `demo-s${key}-${Date.now().toString(36)}`;

  step(`场景${key} · ${scn.name}`);
  log(`  ${C.dim(scn.blurb)}`);

  // A previous scenario's last writes can land a beat after its runs report
  // terminal; snapshot only once the ledger has stopped growing, or they show
  // up as this scenario's evidence.
  let journalBefore = (await erpJournal()).length;
  for (let stable = 0; stable < 2; ) {
    await sleep(3000);
    const now = (await erpJournal()).length;
    stable = now === journalBefore ? stable + 1 : 0;
    journalBefore = now;
  }

  await api("/v1/events", {
    method: "POST",
    headers: { ...HEAD, "Idempotency-Key": subject },
    body: JSON.stringify({
      name: scn.event,
      subject,
      ...(scn.target ? { targetAgent: scn.target } : {}),
      payload: scn.payload,
    }),
  });
  ok(`已发射 ${C.cyan(scn.event)}  subject=${subject}`);

  // Drive to completion: approve every human gate as it appears. Sequential
  // gates (scenario 3's 调出方 then 调入方) surface one at a time, so the same
  // loop handles them without special-casing.
  const deadline = Date.now() + 15 * 60_000;
  // An accepted event that produces no run at all means the trigger reached
  // nobody — an unseeded tenant, or a manifest without a subscriber for this
  // event. Say so in a minute rather than idling for fifteen.
  const firstRunBy = Date.now() + 90_000;
  let approved = 0;
  let runs = [];
  while (Date.now() < deadline) {
    runs = await runsForSubject(subject);
    if (runs.length === 0 && Date.now() > firstRunBy) {
      fail(`事件被接受但没有产生任何运行 —— ${scn.event} 没有订阅者，或租户/清单没装好`);
      warn("先跑 `node scripts/demo-power-scm.mjs down && node scripts/demo-power-scm.mjs up --compile`");
      return false;
    }
    const settled = runs.length > 0 && runs.every((r) => r.status === "ok" || r.status === "failed");

    if (approveTasks) {
      const ids = new Set(runs.map((r) => r.id));
      for (const task of await openTasksForRuns(ids)) {
        await approve(task, scn.approvalComment);
        approved += 1;
        ok(`人工闸口已批准：${task.title ?? task.id}`);
      }
    }
    if (settled) break;
    await sleep(10_000);
  }

  // ---- evidence -----------------------------------------------------------
  log(`\n  ${C.bold("运行结果")}`);
  for (const r of runs.sort((a, b) => String(a.agentName).localeCompare(String(b.agentName)))) {
    const mark = r.status === "ok" ? C.green("ok    ") : r.status === "failed" ? C.red("failed") : C.amber(r.status.padEnd(6));
    log(`    ${mark}  ${String(r.agentName ?? "").padEnd(34)} ${C.dim(r.id)}`);
  }

  if (scn.highlight) {
    const target = runs.find((r) => r.agentName === scn.highlight.agent);
    if (target) {
      const rendered = scn.highlight.render(await readStepOutput(target.id));
      if (rendered) log(`\n${rendered}`);
    }
  }

  const journal = await erpJournal();
  const written = journal.slice(journalBefore);
  log(`\n  ${C.bold("ERP 写单")}${approveTasks ? "" : C.dim("（未批准人工闸口，写单可能不全）")}`);
  if (written.length === 0) {
    fail("流水账没有新记录");
  } else {
    for (const e of written) {
      const status = e?.result?.ok === false ? C.red("✗") : C.green("✓");
      log(`    ${status} ${String(e.op ?? "").padEnd(22)} ${C.dim(String(e?.result?.id ?? ""))}`);
    }
  }

  const seen = new Set(written.filter((e) => e?.result?.ok !== false).map((e) => e.op));
  const missing = scn.expectOps.filter((op) => !seen.has(op));
  const failedRuns = runs.filter((r) => r.status === "failed");
  const clean = missing.length === 0 && failedRuns.length === 0;

  log("");
  if (clean) ok(C.green(`场景${key} 全链路通过`) + C.dim(`  · ${approved} 个人工闸口 · ${written.length} 条 ERP 写单`));
  else if (!approveTasks) warn(`场景${key} 停在人工闸口（--no-approve）`);
  else fail(`场景${key} 未完整通过：缺 ${missing.join(", ") || "—"}${failedRuns.length ? `；失败运行 ${failedRuns.length} 个` : ""}`);

  return clean;
}

// ── commands ────────────────────────────────────────────────────────────────
async function cmdStatus() {
  step("服务状态");
  const rows = [
    ["Neo4j 图谱", 7687, null],
    ["AO API", 3540, await apiReady()],
    ["AO 门户", 3599, null],
    ["Mock Meta ERP", 3620, await erpReady()],
  ];
  for (const [name, port, healthy] of rows) {
    const pid = portPid(port);
    const mark = pid ? (healthy === false ? C.amber("◐") : C.green("●")) : C.red("○");
    log(`  ${mark} ${String(port).padEnd(6)} ${name.padEnd(16)} ${pid ? C.dim(`pid ${pid}`) : C.dim("未运行")}`);
  }
  log(`\n  ${C.dim(`门户 ${PORTAL}/portal/${TENANT}/workflows`)}`);
  log(`  ${C.dim(`ERP  ${ERP}/ui`)}`);
}

/**
 * The tenant seed is what turns an event into runs. A rebuilt control-plane DB
 * (a migration-journal divergence is enough) silently drops it, and then every
 * event is accepted with 200 while producing exactly zero runs — the most
 * confusing failure in this stack. Seeding is idempotent, so just do it, and it
 * has to happen while the SQLite writer lease is free, i.e. before `pnpm dev`.
 */
function ensureTenant() {
  step("确认 power-scm 租户");
  for (const script of ["seed-power-scm-tenant.mjs", "grant-power-scm-membership.mjs"]) {
    const r = spawnSync("node", [path.join(ROOT, "scripts", script)], { cwd: ROOT, encoding: "utf8" });
    if (r.status !== 0) {
      fail(`${script} 失败：${(r.stderr ?? "").slice(-300)}`);
      process.exit(1);
    }
    const line = (r.stdout ?? "").trim().split("\n").filter((l) => !l.startsWith("[db:migrate]")).pop();
    if (line) ok(line.replace(/^\[[^\]]+\]\s*/, ""));
  }
}

async function cmdUp({ compile, verboseLogs }) {
  step("启动依赖服务");
  await ensureNeo4j();

  if (!(await apiReady())) ensureTenant();
  else ok("主栈已在运行，跳过租户检查（写锁被占用）");

  if (compile) {
    step("编译本体包 → 智能体清单");
    const r = spawnSync(
      "corepack",
      ["pnpm", "ontology:compile", "--", "--source", ONTOLOGY_DIST, "--tenant", TENANT,
        "--overlay", "overlays/power-scm.json"],
      { cwd: ROOT, encoding: "utf8" },
    );
    const line = (r.stdout ?? "").trim().split("\n").pop();
    if (r.status !== 0) {
      fail(`编译失败：${(r.stderr ?? "").slice(-400)}`);
      process.exit(1);
    }
    ok(line ?? "compiled");
    if (portPid(3540)) {
      warn("编译产物是运行时加载的 —— 正在重启主栈以生效");
      spawnSync("bash", [path.join(ROOT, "scripts", "stop-dev.sh")], { cwd: ROOT, stdio: "ignore" });
      await sleep(2000);
    }
  }

  step("启动 AO 主栈");
  if (await apiReady()) {
    ok("API 已在运行");
  } else {
    const logPath = startDetached("stack", "corepack", ["pnpm", "dev"], ROOT,
      verboseLogs ? {} : { LOG_LEVEL: "warn" });
    log(`  ${C.dim(logPath)}`);
    if (!(await waitFor("AO API :3540", apiReady, 300_000))) {
      fail("主栈没起来，看上面的日志文件");
      process.exit(1);
    }
  }

  // Must be last: the root predev sweeps workspace dev processes, and an ERP
  // started earlier would be killed — after which write agents exhaust their
  // Inngest retries and land in `failed`.
  step("启动 Mock Meta ERP");
  if (await erpReady()) {
    ok("Mock ERP 已在运行");
  } else {
    const logPath = startDetached("mock-erp", "corepack", ["pnpm", "run", "dev"],
      path.join(ROOT, "apps", "mock-erp"));
    log(`  ${C.dim(logPath)}`);
    if (!(await waitFor("Mock ERP :3620", erpReady, 120_000))) {
      fail("Mock ERP 没起来，看上面的日志文件");
      process.exit(1);
    }
  }
}

async function cmdRun(which, opts) {
  if (!(await apiReady())) {
    fail("AO API 没在运行 —— 先跑 `node scripts/demo-power-scm.mjs up`");
    process.exit(1);
  }
  if (!(await erpReady())) {
    fail("Mock ERP 没在运行 —— 先跑 `node scripts/demo-power-scm.mjs up`");
    process.exit(1);
  }
  if (!opts.keepJournal) {
    await fetch(`${ERP}/__reset`, { method: "POST" }).catch(() => {});
    ok("已清空 ERP 流水账");
  }

  const keys = which === "all" ? ["1", "2", "3"] : [which];
  const results = [];
  for (const k of keys) results.push([k, await runScenario(k, { approveTasks: opts.approve })]);

  step("总结");
  for (const [k, passed] of results) {
    log(`  ${passed ? C.green("✓") : C.red("✗")} 场景${k} · ${SCENARIOS[k].name}`);
  }
  log(`\n  ${C.dim(`监控画布 ${PORTAL}/portal/${TENANT}/workflows`)}`);
  log(`  ${C.dim(`人工任务 ${PORTAL}/portal/${TENANT}/tasks`)}`);
  log(`  ${C.dim(`ERP 表单 ${ERP}/ui`)}`);
  if (results.some(([, p]) => !p)) process.exitCode = 1;
}

function cmdDown() {
  step("停止服务");
  spawnSync("bash", [path.join(ROOT, "scripts", "stop-dev.sh")], { cwd: ROOT, stdio: "inherit" });
  // stop-dev.sh matches `pnpm … dev` by workspace cwd, which covers the mock ERP
  // too; this is the belt-and-braces pass for a stale listener.
  const pid = portPid(3620);
  if (pid) {
    spawnSync("kill", ["-TERM", pid]);
    ok(`Mock ERP (pid ${pid}) 已停止`);
  }
  ok("Neo4j 保持运行（它是共享的本体图库，用 neo4j stop 手动停）");
}

// ── entry ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--"));
const cmd = positional[0] ?? "all";
const opts = {
  compile: flags.has("--compile"),
  approve: !flags.has("--no-approve"),
  keepJournal: flags.has("--keep-journal"),
  verboseLogs: flags.has("--verbose"),
};

const scenarioArg = (v) => (["1", "2", "3", "all"].includes(v) ? v : "all");

try {
  if (cmd === "status") await cmdStatus();
  else if (cmd === "down") cmdDown();
  else if (cmd === "up") { await cmdUp(opts); await cmdStatus(); }
  else if (cmd === "run") await cmdRun(scenarioArg(positional[1]), opts);
  else if (cmd === "all" || ["1", "2", "3"].includes(cmd)) {
    await cmdUp(opts);
    await cmdRun(cmd === "all" ? "all" : cmd, opts);
  } else {
    log(`未知命令 ${cmd}；可用：up | run [1|2|3|all] | status | down`);
    process.exit(1);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
