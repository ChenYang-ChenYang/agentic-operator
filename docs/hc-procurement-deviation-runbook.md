# HC-采购 · 采购全链路执行偏差三级预警 — 本体到可运行 Agent

业务领域（tenant）slug `hc-procurement`，编译产物 `models/hc-procurement-v1/`，
源包 `ontology-packages/hc-procurement/`（`source/` 原始 Studio 导出 →
`package/` 规整后）。对应 allmeta Ontology Studio 的
`采购-HC-Formal v0_1_004` 六件套（actions / events / objects / rules /
workflows / links）与 `场景1_采购全链路执行偏差三级预警.docx` 的 R1-01~R1-07。

**本体是唯一事实来源**：docx 只用作理解业务，平台里的 event / workflow / agent
一律以 JSON 本体为准。

## 一条命令跑通

```bash
pnpm hc:compile
```

```bash
pnpm db:migrate && pnpm hc:seed
```

```bash
pnpm dev
```

```bash
pnpm hc:erp
```

**顺序是依赖不是习惯**：mock ERP 必须在 api 之后启动。`scripts/stop-dev.sh` 的
kill 模式含 `tsx.*src/server\.ts`，正是 mock ERP 的 argv，所以每次 `pnpm dev` /
`restart.sh` 都会杀掉它；ERP 不在时，带 `metaerp.invoke` 的 agent 会耗尽
Inngest 重试落到 `failed`。

## 触发

链路有两个外部入口事件（本体 `triggers`）：

```bash
curl -s -b cookie.txt -X POST http://localhost:3540/v1/events \
  -H 'content-type: application/json' -H 'x-agentic-tenant: hc-procurement' \
  -d '{"name":"DAILY_DEVIATION_SCAN_SCHEDULED","data":{"subject":"SCAN-2026-08-24","scan_date":"2026-08-24","scan_batch_id":"SCAN-2026-08-24-01","chain_scope":"全集团"}}'
```

```bash
curl -s -b cookie.txt -X POST http://localhost:3540/v1/events \
  -H 'content-type: application/json' -H 'x-agentic-tenant: hc-procurement' \
  -d '{"name":"ALERT_TIMEOUT_SCAN_SCHEDULED","data":{"subject":"ESC-2026-08-24","scan_at":"2026-08-24T09:00:00+08:00","scan_batch_id":"ESC-2026-08-24-01"}}'
```

单据状态变更也可入口：`PROCUREMENT_DOCUMENT_STATUS_CHANGED`。

## 15 个 Agent 与 R1 规则组的对应

| 阶段 | Agent | 触发事件 | 发射事件 |
|---|---|---|---|
| ①查 R1-01 | `collectChainExecutionData` | `DAILY_DEVIATION_SCAN_SCHEDULED`、`PROCUREMENT_DOCUMENT_STATUS_CHANGED` | `CHAIN_PROGRESS_SYNCED` |
| ②析 R1-02/03 | `calculateExecutionDeviation` | `CHAIN_PROGRESS_SYNCED` | `EXECUTION_DEVIATION_CALCULATED` + `DEVIATION_DETECTED` / `NO_DEVIATION_CONFIRMED`（按 `has_deviation` 分支）|
| 归档 | `archiveDeviationMonitoring` | `NO_DEVIATION_CONFIRMED` | `CHAIN_MONITORING_ARCHIVED` |
| ③评 R1-04 | `scoreOnTimeProbability` | `DEVIATION_DETECTED` | `ON_TIME_PROBABILITY_SCORED` |
| ④警 R1-03 | `raiseDeviationAlert` | `ON_TIME_PROBABILITY_SCORED`、`DEVIATION_ALERT_ESCALATED` | `DEVIATION_ALERT_RAISED` |
| 蓝色 | `handleBlueAlertLocally` | `DEVIATION_ALERT_RAISED` | `BLUE_ALERT_SELF_HANDLED` |
| ⑤断 R1-05 | `generateAdjustmentOptions` | `DEVIATION_ALERT_RAISED` | `ADJUSTMENT_OPTIONS_GENERATED`（仅红/黄）|
| ⑤断 R1-05 | `approveAdjustmentOption` | `ADJUSTMENT_OPTIONS_GENERATED` | `ADJUSTMENT_OPTION_APPROVED` |
| ⑥行 方案① | `compressDownstreamCycle` | `ADJUSTMENT_OPTION_APPROVED` | `CHAIN_PLAN_SCHEDULE_COMPRESSED` |
| ⑥行 方案② | `adjustRequiredArrivalDate` | `ADJUSTMENT_OPTION_APPROVED` | `REQUIRED_ARRIVAL_DATE_ADJUSTED` |
| ⑥行 方案③ | `createStockTransferRequest` | `ADJUSTMENT_OPTION_APPROVED` | `STOCK_TRANSFER_REQUEST_CREATED` |
| ⑥行 跟踪 | `trackTransferFulfillment` | `STOCK_TRANSFER_REQUEST_CREATED` | `STOCK_TRANSFER_FULFILLED` |
| ⑦升 R1-06 | `escalateOverdueAlert` | `ALERT_TIMEOUT_SCAN_SCHEDULED` | `DEVIATION_ALERT_ESCALATED` |
| ⑧闭环 | `closeDeviationHandling` | 三个执行完成事件 | `DEVIATION_HANDLING_CLOSED` |
| ⑨馈 R1-07 | `recycleFalseAlarm` | `DEVIATION_HANDLING_CLOSED` | `FALSE_ALARM_RECYCLED` + `THRESHOLD_REVIEW_ITEM_CREATED` |

## 规则闸口

编译器只把 `phase=precondition && enforcement=mandatory` 的绑定编成闸口步骤：

- **BR-ALERT-03**（蓝色仅提示计划员）→ 确定性条件 `input.alert_level == '蓝色'`。
  本体把它写成 `guard`；`scripts/stage-hc-procurement-ontology.mjs` 的
  `GUARD_AS_PRECONDITION` 表把它提升为 precondition —— 否则红/黄预警也会给计划员
  开一个「自行处置」任务，而这条规则存在的意义正是拦住这个。提升是逐条列出的。
- **BR-OPT-05**（未经计划员确认不回写单据）→ 确定性条件
  `input.planner_confirmed_by`，三条 ⑥行 分支共用。
- **BR-FB-01**（误报未归因不予闭环）→ 确定性条件
  `input.verification_result == '误报'`，作为误报回收流程的入口条件。

其余规则（BR-COV-01 / BR-PLAN-01 / BR-DEV-01~04 / BR-PROB-01~04 /
BR-ALERT-01~02 / BR-OPT-01~04/06 / BR-ESC-01~03 / BR-CLOSE-01~02 / BR-FB-02~03）
以 `ontology_instructions` 与 `output_contracts` 的硬性约束形式进入 Agent 提示词，
其中阈值判定明确要求取自 `getAlertThresholdConfig` 返回值（BR-DEV-02：不得写死）。

## 四个非平凡的映射决定

1. **`typescript` 实现 = Agent 的推理，不是缺失的代码。** 本体 10 个 action 的
   `implementation.kind` 是 `typescript`，指向 `@allmeta/procurement-chain-deviation/actions`
   ——本仓库没有这个包。它们的 `action_steps` 全是 `logic`，那就是推理本身，
   所以编译成 prompt agent；只有同时声明了 `manual` 步骤的（人工闸口只能走
   external 路径）才编成 external，并带上它自己 `data_changes` 已声明的那次写回。
2. **三条 ⑥行 分支靠 `option_type` 自选。** 三个执行 agent 都订阅
   `ADJUSTMENT_OPTION_APPROVED`。ERP 写操作校验 `option_type` 是否属于自己，不属于
   就返回 `applied:false` 原样放行、不改任何单据；emission 条件是
   `lastResult.applied == true`，所以只有匹配的那条分支会发出完成事件。
3. **执行决策卡收在 `plannerConfirm`。** `metaerp.invoke` 的 payload 只能取单一
   路径，而下游三条分支同时需要 `option_type`（选分支）和 `planner_confirmed_by`
   （BR-OPT-05 闸口）。这两项分散在不同的人工步骤里，所以写回前最后一次人工触点
   （计划员确认）收齐了执行所需的全部字段，ERP 据此回执 `decision_context`。
4. **manual 步骤的 `result_key` 用的是本体 step order，不是 manual 的序号。**
   `approveAdjustmentOption` 的人工步骤是 order 1/3/4/5（order 2 是 logic），
   所以计划员确认是 `results.manual-5`。overlay 里的路径按编译产物核对过。

## Mock API

本场景的外部调用全部落在 mock Meta ERP（`apps/mock-erp`）：

- **26 个查询 op**，覆盖本体声明的 13 个链路采集接口
  （`queryOpenPbpHeader` / `queryPr` / `queryRfxList` / `queryPoLineShipment` /
  `queryAcceptTransaction` …）与 20 个数据对象的读取。
- **10 个写入 op**：`pushAlert`、`closeBlueAlert`、`approveAdjustmentOption`、
  `escalateAlert`、`changePbp`、`changePbpLine`、`createTransactionOrder`、
  `updateTransactionOrder`、`writeEventLog`、`createReviewItem`。
- **配置类接口也是 mock**：`getStageCycleConfig`（采购阶段周期标准）与
  `getAlertThresholdConfig`（预警阈值配置）作为普通查询 op 提供，对应本体的
  `Stage_Cycle_Standard` 与 `Alert_Threshold_Setting` 两个对象。

存根数据串了一条完整样例：大修专项计划 `PBP-2026-0873` 的断路器计划行
`PBPL-2026-0873-01`，需求到货 2026-11-30，链路停在「询价」——询价 2026-07-29 生效、
发标后流标重招，至今无定标行。按物资类标准周期（10/15/20/15/15/10/70 天）从需求
到货日期倒排，询价节点计划完成 2026-08-18，实际未完成，时间偏差远超 7 天阈值；
订单尚未生成，进度偏差 1.0。历史同类按期达成率 62%（样本 18）。

## 重新生成

三段（source → package → models）都入库，clone 下来不需要外部本体仓库就能重建：

```bash
pnpm hc:compile
```

`--check` 可当漂移检测用：

```bash
node scripts/ontology-compile.mjs --source ontology-packages/hc-procurement/package --tenant hc-procurement --overlay overlays/hc-procurement.json --check
```
