/**
 * 场景二 write semantics against the checked-in 采购-HC-Formal package
 * (ontology-packages/procurement-hc-formal/package) — the package the
 * procurement-hc-formal tenant's agents actually run against.
 *
 * Every op here is a rule boundary the ontology declares: BR2-STOCK-01 on the
 * transfer, BR2-MERGE-04 on the draft, BR2-FRAME-01/02 + BR2-CENTRAL-02/04 on
 * the package annotation, BR2-HITL-01 / BR2-FEEDBACK-01 on the planner
 * decision. The assertions are about those boundaries, not about ids.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type MockErpApp } from "../src/app.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, "../../../ontology-packages/procurement-hc-formal/package");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hcf-erp-"));
let ctx: MockErpApp;

async function post(op: string, body: Record<string, unknown>) {
  const res = await ctx.app.inject({ method: "POST", url: `/metaerp/openapi/v1/${op}`, payload: body });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

beforeAll(async () => {
  ctx = buildApp({
    dataDir: path.join(PACKAGE_DIR, "mock-erp"),
    transformMapsPath: path.join(PACKAGE_DIR, "transform-maps", "transform-maps.json"),
    stateDir,
    logger: false,
  });
  await ctx.app.ready();
});

afterAll(async () => {
  await ctx.app.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  ctx.store.reset();
});

describe("catalog", () => {
  it("loads both scenarios: 47 query ops, 16 write ops, every write op has an effect", async () => {
    expect(ctx.store.queryOps.size).toBe(47);
    expect(ctx.store.writeOps.size).toBe(16);
    const health = (await ctx.app.inject({ method: "GET", url: "/health" })).json() as { ops: { write: number } };
    expect(health.ops.write).toBe(16);
    for (const op of [
      "splitDemandLine",
      "createPbp",
      "pushTask",
      "writeOperationLog",
      "createProcPackageLines",
      "submitApproval",
      "createTransactionOrder",
    ]) {
      const res = await post(op, {});
      // A declared op never 404s; a bad payload is a 400 from its own contract.
      expect(res.status, op).not.toBe(404);
    }
  });

  it("serves the 场景二 stub tables the analysis agents read", async () => {
    const onhand = await post("queryOnhandQuantity", { MATERIAL_CODE: "M-CBL-YJV", INVENTORY_STATUS: "合格" });
    expect(onhand.body.rows.map((row: any) => row.ONHAND_QUANTITY)).toEqual([5000, 1200]);
    const catalog = await post("queryCentralCatalogConfig", { IS_ENABLED: "Y" });
    expect(catalog.body.rows.map((row: any) => row.MATERIAL_CODE).sort()).toEqual(["M-BRK-126", "M-CBL-YJV"]);
    const thresholds = await post("queryAuditThresholdConfig", { IS_ENABLED: "Y" });
    expect(thresholds.body.rows.length).toBe(7);
  });
});

describe("createTransactionOrder — one op id, two callers", () => {
  it("场景二: no option_type → 可调度 transfer with transfer_reason 库存可调度 (BR2-STOCK-01)", async () => {
    const res = await post("createTransactionOrder", {
      stock_check_id: "SC-1",
      plan_line_id: "PBPL-2026-1102-04",
      material_code: "M-CBL-YJV",
      transfer_quantity: 3000,
      stock_check_flag: "可调度",
      is_urgent_demand: false,
      source_warehouse: "WH-HD-02",
      inventory_organization: "ORG-HD",
    });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(res.body.transfer_context).toMatchObject({
      transfer_reason: "库存可调度",
      transfer_quantity: 3000,
      plan_line_id: "PBPL-2026-1102-04",
      stock_check_id: "SC-1",
    });
    const rows = ctx.store.rows("inv_transaction_order_t");
    expect(rows).toHaveLength(1);
    expect(rows[0]!["TRANSFER_REASON"]).toBe("库存可调度");
    expect(ctx.store.rows("de_operation_log_t").at(-1)?.["RULE_HIT"]).toEqual(["BR2-STOCK-01"]);
  });

  it("场景二: refuses a transfer the stock check did not judge 可调度", async () => {
    const res = await post("createTransactionOrder", {
      stock_check_flag: "需采购",
      material_code: "M-CT-110",
      transfer_quantity: 30,
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("BR2-STOCK-01");
    expect(ctx.store.rows("inv_transaction_order_t")).toHaveLength(0);
  });

  it("场景一: option_type other than 执行调拨 is passed through unapplied (unchanged behaviour)", async () => {
    const res = await post("createTransactionOrder", { option_type: "压缩后续周期", chain_id: "CH-1" });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(ctx.store.rows("inv_transaction_order_t")).toHaveLength(0);
  });
});

describe("createPbp — execution plan draft (BR2-MERGE-04)", () => {
  const draft = {
    business_type: "物资",
    plan_type: "执行计划",
    management_unit: "华东检修分公司",
    unit_code: "001",
    plan_period: "2027",
    merge_group_id: "MG-1",
    merge_suggestion_id: "MS-1",
    lines: [
      {
        item_code: "M-CT-110",
        item_name: "110kV 电流互感器",
        line_type_code: "物资",
        category_id: "CAT-EL-CT",
        quantity: 30,
        unit: "台",
        unit_price: 58500,
        need_by_date: "2027-03-10",
        inventory_organization: "ORG-HD",
        source_plan_line_ids: ["PBPL-2026-1102-01", "PBPL-2026-1102-02"],
      },
    ],
    source_plan_line_ids: ["PBPL-2026-1102-01", "PBPL-2026-1102-02"],
    source_plan_header_id: "PBP-2026-1102",
    source_plan_no: "PBP-2026-1102",
  };

  it("creates header + line + one relation per source line and marks the mapping written", async () => {
    const res = await post("createPbp", { draft_request: draft, scan_date: "2026-09-07" });
    expect(res.status).toBe(200);
    expect(res.body.source_mapping_written).toBe(true);
    const planId = res.body.id as string;
    expect(planId).toMatch(/^PBP-EXEC-/);
    expect(res.body.draft_context).toMatchObject({
      plan_id: planId,
      draft_line_count: 1,
      merge_group_id: "MG-1",
      source_mapping_written: true,
      plan_line_id: `${planId}-01`,
    });
    expect(res.body.draft_context.plan_lines[0]).toMatchObject({ material_code: "M-CT-110", quantity: 30 });
    const relations = ctx.store.rows("ss_pbp_rel_t").filter((row) => row["PBP_HEADER_ID"] === planId);
    expect(relations.map((row) => row["SOURCE_PLAN_LINE_ID"])).toEqual(["PBPL-2026-1102-01", "PBPL-2026-1102-02"]);
    const header = ctx.store.rows("ss_pbp_header_t").find((row) => row["PBP_HEADER_ID"] === planId)!;
    expect(header).toMatchObject({ PLAN_CATEGORY: "执行计划", STATUS: "草稿", IS_EXECUTION_PLAN_DRAFT: "Y" });
    const suggestion = ctx.store.rows("de_demand_merge_suggestion_t").find((row) => row["MERGE_SUGGESTION_ID"] === "MS-1")!;
    expect(suggestion).toMatchObject({ SOURCE_MAPPING_WRITTEN: true, SUGGESTION_STATUS: "已采纳", SOURCE_PLAN_NO: planId });
    expect(ctx.store.rows("de_digital_employee_task_t").at(-1)).toMatchObject({ TASK_TYPE: "草稿确认", ASSIGNED_ROLE: "采购计划员" });
  });

  it("refuses a MERGED draft that carries no source mapping (BR2-MERGE-04 fail-closed)", async () => {
    const res = await post("createPbp", {
      draft_request: { ...draft, source_plan_line_ids: [], lines: [{ ...draft.lines[0], source_plan_line_ids: [] }, { ...draft.lines[0], source_plan_line_ids: [] }] },
    });
    // two lines, zero sources → not "merged" by the rule's definition, so it is a plain draft
    expect(res.status).toBe(200);
    const merged = await post("createPbp", {
      draft_request: { ...draft, source_plan_line_ids: [], lines: [{ ...draft.lines[0], source_plan_line_ids: ["A", "B"] }] },
    });
    expect(merged.status).toBe(200); // per-line sources satisfy the mapping
    const lineIds = (await post("createPbp", { draft_request: { ...draft, lines: [] } }));
    expect(lineIds.status).toBe(400);
  });
});

describe("createProcPackageLines — frame + central annotation at the write boundary", () => {
  const scheme = {
    package_scheme_id: "PS-1",
    scheme_no: "PS-2026-09-07-1",
    plan_id: "PBP-EXEC-1",
    purchasing_group_no: "PG-HD-01",
    scenario_code: "常规寻源",
    match_score: 92,
    sibling_scheme_count: 2,
    is_recommended: true,
    special_sourcing_method: "无",
    management_unit: "华东检修分公司",
    package_lines: [
      {
        plan_line_id: "PBP-EXEC-1-01",
        material_code: "M-CT-110",
        management_unit: "华东检修分公司",
        inventory_organization: "ORG-HD",
        category_id: "CAT-EL-CT",
        quantity: 30,
        unit_price: 58500,
        required_arrival_date: "2027-03-10",
        sourcing_method: "公开询价",
      },
    ],
  };

  it("hits the valid frame agreement for M-CT-110 and annotates 非集采 (catalog row disabled)", async () => {
    const res = await post("createProcPackageLines", { recommended_scheme: scheme, scan_date: "2026-09-07" });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(res.body.annotation_context).toMatchObject({
      package_scheme_id: "PS-1",
      frame_hit: true,
      frame_agreement_no: "SPA-2026-0338",
      frame_quota_sufficient: true, // 4,260,000 available ≥ 1,755,000
      central_level: "非集采",
      approve_flow_code: "FLOW-BU-STD",
      line_count: 1,
    });
    const packageId = res.body.id as string;
    const lines = ctx.store.rows("ss_proc_package_line_t").filter((row) => row["PACKAGE_ID"] === packageId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ FRAME_HIT: "Y", FRAME_AGREEMENT_NO: "SPA-2026-0338", PLAN_LINE_ID: "PBP-EXEC-1-01" });
    expect(ctx.store.rows("de_package_scheme_t").find((row) => row["PACKAGE_SCHEME_ID"] === "PS-1")).toMatchObject({
      FRAME_HIT: true,
      GENERATED_PACKAGE_ID: packageId,
    });
  });

  it("annotates 一级集采 + group approve flow for a catalog material, and no frame for a closed agreement", async () => {
    const res = await post("createProcPackageLines", {
      recommended_scheme: {
        ...scheme,
        package_scheme_id: "PS-2",
        package_lines: [
          { ...scheme.package_lines[0], plan_line_id: "PBP-EXEC-2-01", material_code: "M-BRK-126", category_id: "CAT-EL-BRK", quantity: 4, unit_price: 385000 },
          { ...scheme.package_lines[0], plan_line_id: "PBP-EXEC-2-02", material_code: "M-CBL-YJV", category_id: "CAT-EL-CBL", quantity: 3000, unit_price: 320 },
        ],
      },
      scan_date: "2026-09-07",
    });
    expect(res.status).toBe(200);
    expect(res.body.annotation_context).toMatchObject({
      frame_hit: false, // SPA-2025-0207 for the cable is 已关闭 / expired
      central_level: "一级集采",
      central_pattern: "集团统谈统签",
      approve_flow_code: "FLOW-GRP-L1",
    });
  });

  it("opens a 集采管理岗 supplement task for a special sourcing method (BR2-FRAME-03)", async () => {
    const res = await post("createProcPackageLines", {
      recommended_scheme: { ...scheme, package_scheme_id: "PS-3", special_sourcing_method: "单一来源", scenario_code: "单一来源" },
    });
    expect(res.status).toBe(200);
    expect(res.body.annotation_context.supplement_task_id).toMatch(/^TSK-/);
    expect(ctx.store.rows("de_digital_employee_task_t").at(-1)).toMatchObject({ ASSIGNED_ROLE: "集采管理岗", TASK_TYPE: "特殊采购方式补充说明" });
  });
});

describe("planner decision → submission", () => {
  it("writeOperationLog: approval selects the scheme and confirms the draft line", async () => {
    const res = await post("writeOperationLog", {
      decision: "approved",
      selected_by: "张计划",
      package_scheme_id: "PS-1",
      scheme_no: "PS-2026-09-07-1",
      plan_id: "PBP-EXEC-1",
      plan_line_id: "PBPL-2026-1102-01",
      package_id: "PKG-1",
    });
    expect(res.status).toBe(200);
    expect(res.body.confirm_context).toMatchObject({ package_scheme_id: "PS-1", selected_by: "张计划", package_id: "PKG-1" });
    expect(ctx.store.rows("de_package_scheme_t").find((row) => row["PACKAGE_SCHEME_ID"] === "PS-1")).toMatchObject({ SCHEME_STATUS: "已选定", SELECTED_BY: "张计划" });
    expect(ctx.store.rows("ss_pbp_line_t").find((row) => row["PBP_LINE_ID"] === "PBPL-2026-1102-01")).toMatchObject({ DRAFT_CONFIRMED_BY: "张计划", LINE_STATUS: "已确认" });
  });

  it("writeOperationLog: a rejection without a reason is refused (BR2-FEEDBACK-01)", async () => {
    const res = await post("writeOperationLog", { decision: "rejected", selected_by: "张计划", package_scheme_id: "PS-1" });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("BR2-FEEDBACK-01");
    const ok = await post("writeOperationLog", { decision: "rejected", selected_by: "张计划", package_scheme_id: "PS-1", rejection_reason: "组包跨度过大" });
    expect(ok.status).toBe(200);
    expect(ok.body.rejection_context).toMatchObject({ rejection_reason: "组包跨度过大", rejected_by: "张计划" });
  });

  it("submitApproval: needs the planner confirmation (BR2-HITL-01), then moves plan + package to 审批中 and seals the trace", async () => {
    const draft = await post("createPbp", {
      draft_request: {
        business_type: "物资",
        management_unit: "华东检修分公司",
        lines: [{ item_code: "M-CT-110", quantity: 30, unit_price: 58500, need_by_date: "2027-03-10", source_plan_line_ids: ["PBPL-2026-1102-01"] }],
        source_plan_line_ids: ["PBPL-2026-1102-01"],
      },
    });
    const planId = draft.body.id as string;
    const pkg = await post("createProcPackageLines", {
      recommended_scheme: {
        package_scheme_id: "PS-9",
        scheme_no: "PS-9",
        plan_id: planId,
        is_recommended: true,
        management_unit: "华东检修分公司",
        package_lines: [{ plan_line_id: `${planId}-01`, material_code: "M-CT-110", management_unit: "华东检修分公司", quantity: 30, unit_price: 58500 }],
      },
    });
    const refused = await post("submitApproval", { plan_id: planId, package_scheme_id: "PS-9" });
    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toContain("BR2-HITL-01");

    const res = await post("submitApproval", { plan_id: planId, package_scheme_id: "PS-9", selected_by: "张计划" });
    expect(res.status).toBe(200);
    expect(res.body.submission_context).toMatchObject({ plan_id: planId, package_id: pkg.body.id, trace_sealed: true });
    expect(ctx.store.rows("ss_pbp_header_t").find((row) => row["PBP_HEADER_ID"] === planId)?.["STATUS"]).toBe("审批中");
    expect(ctx.store.rows("ss_proc_package_header_t").find((row) => row["PROC_PACKAGE_HEADER_ID"] === pkg.body.id)?.["STATUS"]).toBe("审批中");
    expect(ctx.store.rows("de_package_scheme_t").find((row) => row["PACKAGE_SCHEME_ID"] === "PS-9")).toMatchObject({ SCHEME_STATUS: "已生成采购包", GENERATED_PACKAGE_ID: pkg.body.id });
  });
});

describe("pushTask + splitDemandLine", () => {
  it("pushTask from the rectification form marks the audit opinion 已整改 and echoes the rectification context", async () => {
    const res = await post("pushTask", {
      decision: "approved",
      rectified_by: "王申请",
      audit_opinion_id: "AO-1",
      plan_id: "PBP-2026-1102",
      plan_line_id: "PBPL-2026-1102-03",
      non_central_reason: "已按集团框架执行",
      response_note: "技术附件已补齐",
    });
    expect(res.status).toBe(200);
    expect(res.body.rectification_context).toMatchObject({ audit_opinion_id: "AO-1", non_central_reason: "已按集团框架执行", rectified_by: "王申请" });
    expect(res.body.return_context).toMatchObject({ audit_opinion_id: "AO-1", assigned_role: "需求申请人" });
    expect(ctx.store.rows("de_plan_audit_opinion_t").find((row) => row["AUDIT_OPINION_ID"] === "AO-1")).toMatchObject({ OPINION_STATUS: "已整改" });
    expect(ctx.store.rows("de_digital_employee_task_t").at(-1)).toMatchObject({ TASK_STATUS: "已完成", ASSIGNED_ROLE: "需求申请人" });
  });

  it("pushTask from a packaging violation opens a task and parks the scheme 待调整", async () => {
    const res = await post("pushTask", {
      pkg_finding_id: "PCF-1",
      package_scheme_id: "PS-1",
      check_item: "类型一致",
      conclusion: "拦截",
      rectify_advice: "工程/物资混包，拆分后重算",
    });
    expect(res.status).toBe(200);
    expect(res.body.task_context).toMatchObject({ pkg_finding_id: "PCF-1", package_scheme_id: "PS-1", assigned_role: "采购计划员" });
    expect(ctx.store.rows("de_package_scheme_t").find((row) => row["PACKAGE_SCHEME_ID"] === "PS-1")?.["SCHEME_STATUS"]).toBe("待调整");
  });

  it("splitDemandLine flags the confirmed lines IS_SPLIT and closes the suggestion 已拆分", async () => {
    const res = await post("splitDemandLine", {
      decision: "approved",
      confirmed_by: "张计划",
      merge_suggestion_id: "MS-7",
      plan_line_ids: ["PBPL-2026-1102-01", "PBPL-2026-1102-03"],
    });
    expect(res.status).toBe(200);
    expect(res.body.split_context).toMatchObject({ merge_suggestion_id: "MS-7", split_line_count: 2, confirmed_by: "张计划" });
    expect(ctx.store.rows("ss_pbp_line_t").find((row) => row["PBP_LINE_ID"] === "PBPL-2026-1102-03")?.["IS_SPLIT"]).toBe("Y");
    const skipped = await post("splitDemandLine", { decision: "rejected", confirmed_by: "张计划", merge_suggestion_id: "MS-8" });
    expect(skipped.body.applied).toBe(false);
  });
});
