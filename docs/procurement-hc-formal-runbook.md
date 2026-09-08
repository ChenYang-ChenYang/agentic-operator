# 采购-HC-Formal · 本体包 procurement-hc-formal@0.1.8 → 可运行 Agent

业务领域（tenant）slug `procurement-hc-formal`，显示名「采购-HC-Formal」。
源包 `ontology-packages/procurement-hc-formal/source/`（immutable Ontology Package
archive，schema bundle 3.2.0：`package.json` + `manifest.json`，sha256 校验），
规整后的编译器输入 `ontology-packages/procurement-hc-formal/package/`，编译产物
`models/procurement-hc-formal-v1/`（29 个 AgentSpec = 29 个 Inngest function，
app `agentic-operator-procurement-hc-formal`）。

包里两个工作流：

| 工作流 | action 数 | 入口事件 |
|---|---|---|
| `procurement-chain-deviation-alert` 采购全链路执行偏差三级预警（场景一） | 15 | `DAILY_DEVIATION_SCAN_SCHEDULED` / `PROCUREMENT_DOCUMENT_STATUS_CHANGED` / `ALERT_TIMEOUT_SCAN_SCHEDULED` |
| `procurement-digital-employee-operations` 数字化员工的智能作业实践（场景二） | 14 | `DAILY_DEMAND_PLAN_SCAN_SCHEDULED` / `DEMAND_PLAN_APPROVED` / `DEMAND_PLAN_SUBMITTED_FOR_APPROVAL` |

场景一的 15 个 action 与 `hc-procurement` 租户（Studio 导出 v0_1_004）逐 id 相同，
编译结构逐 step 相同（`packages/ontology-compiler/test/compile.procurement-hc-formal.test.ts`
守着这一点）；不同的只有 catalog_path 指向本租户。

**本体是唯一事实来源**：事件名、动作粒度、规则绑定一律以 archive 为准；archive
本身永不修改（hash-bound），所有映射决定都在 `scripts/stage-procurement-hc-formal-ontology.mjs`
与 `overlays/procurement-hc-formal.json` 里以表的形式声明。

## 一条命令跑通

```bash
pnpm hcf:compile
```

```bash
pnpm hcf:seed
```

（种子必须在 dev 栈停掉时跑：SQLite 单写者租约。它建租户行，并给所有 active 用户
一个 admin membership，`--no-grant-memberships` 可关。）

```bash
pnpm dev
```

```bash
pnpm hcf:erp
```

**顺序是依赖不是习惯**：mock ERP 必须在 api 之后启动（`scripts/stop-dev.sh` 的
kill 模式含 `tsx.*src/server\.ts`）。api 侧必须有 `METAERP_BASE_URL=http://localhost:3620`
（已写进 `apps/api/.env.local`；`--env-file` 只在启动时读，改了要整栈重启）——
没有它，每个带 `metaerp.invoke` 的 agent 都会 fail-closed，分析型 agent 会在没有阈值
配置的情况下"推算中断"、把整条链路判成无偏差。

把本体装进 AllmetaOntology 的 Neo4j（多域并存，domainId=`采购-HC-Formal`，
同时打 `tenant_slug=procurement-hc-formal` + `id`，即 `ontology.query` 工具的
服务端谓词）：

```bash
NEO4J_PASSWORD=… pnpm hcf:neo4j
```

漂移检测（编译产物与 overlay/stage 表是否一致，CI 可用）：

```bash
pnpm hcf:check
```

## 触发

```bash
curl -s -X POST http://localhost:3540/v1/events \
  -H 'content-type: application/json' -H 'x-agentic-tenant: procurement-hc-formal' \
  -d '{"name":"DAILY_DEMAND_PLAN_SCAN_SCHEDULED","data":{"subject":"S2-2026-09-07","scan_date":"2026-09-07","scan_batch_id":"SCAN-2026-09-07-01","scan_scope":"全集团","plan_id":"PBP-2026-1102"}}'
```

```bash
curl -s -X POST http://localhost:3540/v1/events \
  -H 'content-type: application/json' -H 'x-agentic-tenant: procurement-hc-formal' \
  -d '{"name":"DAILY_DEVIATION_SCAN_SCHEDULED","data":{"subject":"S1-2026-09-07","scan_date":"2026-09-07","scan_batch_id":"SCAN-2026-09-07-S1","chain_scope":"指定计划","plan_id":"PBP-2026-0873","plan_no":"PBP-2026-0873"}}'
```

（生产鉴权下要带 session cookie 或 API token；本地 `AUTH_MODE=dev` 时
`.claude/launch.json` 的 `ao-full-dev-hcf` 配置已把 dev 租户钉在本域。）

## 场景二 · 14 个 Agent 与事件链

| 阶段 | Agent | 编译形态 | 触发 | 发射 |
|---|---|---|---|---|
| ①查 | `scanApprovedDemandPlan` | prompt + queryPbpHeader/queryPbpLine | `DAILY_DEMAND_PLAN_SCAN_SCHEDULED`、`DEMAND_PLAN_APPROVED` | `APPROVED_DEMAND_PLAN_SCANNED` |
| ②析 | `analyzeDemandMerge` | prompt（纯推理） | `APPROVED_DEMAND_PLAN_SCANNED` | `DEMAND_MERGE_ANALYZED`（merge_ready）/ `DEMAND_SPLIT_REQUIRED`（split_required） |
| ③行 | `splitOversizedDemand` | external：manual `confirmSplitByPlanner` → `splitDemandLine` | `DEMAND_SPLIT_REQUIRED` | `DEMAND_SPLIT_CONFIRMED` |
| ④析 | `verifyInventoryAvailability` | prompt + 3 个库存查询 | `DEMAND_MERGE_ANALYZED`、`DEMAND_SPLIT_CONFIRMED` | `INVENTORY_AVAILABILITY_VERIFIED` + `STOCK_SUFFICIENT_FOR_DEMAND`（可调度）/ `PURCHASE_REQUIRED_CONFIRMED`（需采购） |
| ⑤行 | `createInventoryTransferOrder` | external：闸口 BR2-STOCK-01 → `createTransactionOrder` | `STOCK_SUFFICIENT_FOR_DEMAND` | `INVENTORY_TRANSFER_ORDER_CREATED` |
| ⑥算 | `derivePurchaseSchedule` | prompt + queryStageCycleConfig | `PURCHASE_REQUIRED_CONFIRMED` | `PURCHASE_SCHEDULE_DERIVED` + `SCHEDULE_TIME_CONFLICT_DETECTED`（冲突时） |
| ⑦行 | `generateExecutionPlanDraft` | external：`createPbp`（写来源映射，BR2-MERGE-04 在写边界） | `PURCHASE_SCHEDULE_DERIVED` | `EXECUTION_PLAN_DRAFT_GENERATED` |
| ⑧审 | `auditAnnualPlanCompliance` | prompt + 4 个查询（阈值/集采目录/历史订单行/合同） | 草稿生成、需求计划提交审批、整改回流 | `ANNUAL_PLAN_AUDITED`（通过）/ `PLAN_AUDIT_INTERCEPTED`（拦截） |
| ⑨警 | `returnPlanForRectification` | external：manual `acceptRectification` → `pushTask` | `PLAN_AUDIT_INTERCEPTED` | `PLAN_RETURNED_FOR_RECTIFICATION` + `PLAN_RECTIFICATION_SUBMITTED`（申请人已整改） |
| ⑩析 | `recommendPackagingScheme` | prompt + 阈值/品类查询 | 审核通过、组包预警调整后、计划员驳回 | `PACKAGING_SCHEME_RECOMMENDED` / `PACKAGING_COMPLIANCE_VIOLATED` |
| ⑪行 | `annotateFrameAndCentralPurchase` | external：`createProcPackageLines`（框架命中/集采标注在 ERP 写边界内） | `PACKAGING_SCHEME_RECOMMENDED` | `FRAME_AND_CENTRAL_ANNOTATED` |
| ⑫警 | `raisePackagingComplianceAlert` | external：`pushTask` | `PACKAGING_COMPLIANCE_VIOLATED` | `PACKAGING_ALERT_RAISED` |
| ⑬断 | `confirmPlanAndPackage` | external：manual `confirmByPlanner` → `writeOperationLog` | `FRAME_AND_CENTRAL_ANNOTATED` | `PLAN_AND_PACKAGE_CONFIRMED`（approved）/ `PLAN_AND_PACKAGE_REJECTED`（rejected，原因必填） |
| ⑭行 | `submitPlanForApproval` | external：闸口 BR2-HITL-01 → `submitApproval` | `PLAN_AND_PACKAGE_CONFIRMED` | `PLAN_SUBMITTED_FOR_APPROVAL` |

场景一的 15 个与 `docs/hc-procurement-deviation-runbook.md` 完全一致。

## Agent 命名（中英双语）

archive 里 action 只有英文 id，中文措辞只在工作流步骤名上（`b·计算·需求合并分析`）。
overlay 的 `titles` 表把它们逐个声明成 `{zh, en}`，编译器据 `title_locale`（zh）把中文
放进 AgentSpec `title`、整张表放进 `title_i18n`；DAG 契约透传为 `titleI18n`，portal 用
`apps/web/lib/agent-title.ts` 按当前语言（EN/中 切换）取标题，缺省回退到 `title` → `name`。
`agents` 表里的标题：bootstrap 只在行标题仍是「manifest 名默认值」时刷新，操作员手改过的
标题不动。

## 阻断结论与失败语义（2026-09-07 「跑不了」修复）

活体复盘：`derivePurchaseSchedule` 如实报告 BR-PLAN-01（拿不到周期配置）却仍发射
`PURCHASE_SCHEDULE_DERIVED`，下游 `generateExecutionPlanDraft` 把 `draft_request: null`
送进 `createPbp` 得到 HTTP 400，运行时按默认策略重试 4 次共 6 分钟，画布一直显示
「running」，最后靠人工取消。现在三道防线：

1. **阻断结论 → 运行失败**：overlay `blocking_outcomes[actionId]` 声明「分析结果何时等于
   不能继续」（条件 DSL 作用于 `lastResult`）。编译成 `blocked-when:<code>` 条件步 +
   `control.fail` 工具步（`on_error: terminal`），命中即以模型自己给出的原因（`message_from`）
   结束运行、不发任何事件，画布标红。已声明：`derivePurchaseSchedule/schedule_blocked`、
   `calculateExecutionDeviation/deviation_calc_blocked`。
2. **ERP 写步骤失败阶梯**：每个 `metaerp.invoke` 写步骤带 `on_error` 阶梯——
   `integration_unreachable`（连不上）重试、HTTP 4xx 立即终止（负载错了，重试无意义）、
   其余重试。`metaerp.invoke` 的传输层失败现在抛 `IntegrationUnreachableError`
   （`code=integration_unreachable`，中英文说明含 env 名与地址）。
3. **运行行必收口**：步骤失败离开 handler 时（终止错误、或 SDK 在重试耗尽后抛出的
   `StepError`）先把 `runs` 行写成 `failed` 并带真实原因，再抛出——不再留下「running」僵尸。
   注意 Inngest 的函数级 `attempt` 计数不随步骤重试增长，不能用它判断「最后一次」。

**scan_date 照抄门**（2026-09-08 静态审计后加）：九个带 scan_date 契约的分析 agent 各带一条
`scan_date_mismatch` 阻断结论——触发事件带 scan_date 而分析输出的 scan_date 与之不同（或缺失）时，
运行失败而不是用错的「今天」继续算偏差；触发事件不带 scan_date（ERP 状态变更、计划审批等入口）时不判。
起因是一次活体运行里模型把数据同步日期 2026-08-19 当成了 scan_date。

**已知本体缺口 BR-CLOSE-01**：`closeDeviationHandling` 的规则「偏差未消除则不予闭环」绑定为
validation 阶段，编译器只把 precondition 编成闸门，且这个写动作没有可以重算偏差的分析步——
上游三条分支的事件都不带 `deviation_eliminated`，闭环写入会照做。要落实它需要编译器支持
「先分析再写」形态（同样阻碍 annotateFrameAndCentralPurchase 接真 ERP）。overlay 里原先挂在这个
写动作上的 output_contract 是死配置，已删除，编译器现在拒绝给 external 动作声明契约。
同类：`auditAnnualPlanCompliance`/`recommendPackagingScheme` 的 BR2-THRESH-01（阈值必须取自配置）
只以提示词义务形式存在，确定性落实要读工具账本。

**取消必须精确**：`POST /v1/runs/:id/cancel` 现在发出 `{runId, agent, triggerEventId, subject}`，
函数的 `cancelOn` 先按「触发事件 id + agent 名」精确匹配；只有不带 triggerEventId 的旧发送方
才退回 subject 匹配，且 subject 为 null 时不匹配。之前只按 subject 匹配，而本体编译的 agent 没有
subject（日志里 `subject="—"`），`null == null` 让「取消一个僵尸运行」顺带取消了同一函数所有在飞
运行（2026-09-07 实测：取消旧的 generateExecutionPlanDraft 僵尸，杀掉了正在跑的年度计划审核）。

**ERP 不可达提醒**：`GET /v1/integrations/erp/status` 按线上 manifest 的 `base_url_env`
探测（20s 缓存），工作流页在不可达/未配置时显示琥珀色横幅（涉及的智能体、错误、复检按钮）。

`approveAdjustmentOption` 的 ERP 负载改为 `lastResult`（领导拍板表单 + 计划员确认表单合并），
否则 ERP 记录里 `decided_by` 为空。`调整需求日期` 分支：本体的两张表单都不带新日期，
mock `changePbpLine` 从事件携带的 `options[]` 里按 `option_id` 取 `expected_arrival_date_after`
（显式 `required_arrival_date` 优先）——接真 ERP 前需在表单或决策上下文里补该字段。

## 规则闸口

编译器只把 `phase=precondition && enforcement=mandatory` 的绑定编成闸口步骤：

- 场景一：BR-ALERT-03（stage 表 `GUARD_AS_PRECONDITION` 提升）、BR-OPT-05、BR-FB-01 —— 同 hc-procurement。
- **BR2-STOCK-01**（现有量达上限且非紧急才转调拨）→ 确定性条件
  `input.stock_check_flag == '可调度' && input.is_urgent_demand == false`，挡在 `createTransactionOrder` 前。
- **BR2-HITL-01**（未经计划员确认不得提交审批）→ `input.selected_by && input.package_scheme_id`，挡在 `submitApproval` 前。

两条本体写成 precondition、但会把自己的 action 锁死的绑定被 **降级**（stage 表
`PRECONDITION_DEMOTIONS`，原 phase 留在 `studio_phase`）：

- `splitOversizedDemand` 的 BR2-HITL-01：它要的计划员确认正是这个 action 自己的人工步骤
  `confirmSplitByPlanner` 收集的；作为前置闸口第一次运行就死锁。规则仍然成立——写步骤
  依赖人工步骤，没确认就不写。
- `generateExecutionPlanDraft` 的 BR2-MERGE-04：来源映射是这个 action 自己的 `createPbp`
  调用写入的；它是对写的契约，由 mock ERP 在写边界执行（合并草稿没有 `source_plan_line_ids`
  → 400）。

## 人工步骤

archive 0.1.8 仍带着 `docs/hc-procurement-ontology-corrections.md` 的 C-06/C-07/C-08
（`DROP_MANUAL_STEPS` 沿用），另加一条场景二的同类问题：`confirmPlanAndPackage.captureRejectionReason`
让同一个计划员在确认之后再答一次驳回原因——原因改为确认表单里的字段（驳回时必填，
BR2-FEEDBACK-01），一个决策一次点击。本体修好后删掉 stage 表里的条目即可（步骤不存在时
stage 脚本会报错提醒）。

manual 步骤的 `result_key` 用本体 step order：`confirmSplitByPlanner`=`results.manual-3`、
`acceptRectification`=`results.manual-4`、`confirmByPlanner`=`results.manual-2`。表单 `decision`
取 `approved|rejected`，是表单字段，不是任务 API 的 approve/reject。

## Mock ERP（apps/mock-erp）

63 个 op：47 个查询 + 16 个写。场景二新增 7 个写效应（`apps/mock-erp/src/effects.ts`）：
`createTransactionOrder`（与场景一共用 op id，按 payload 有无 `option_type` 分流）、
`splitDemandLine`、`createPbp`、`pushTask`、`writeOperationLog`、`createProcPackageLines`、
`submitApproval`。每个写效应都落一条 `de_operation_log_t` 留痕（BR2-AUDIT-01 四要素）。

存根数据串了第二条完整样例：年度需求计划 `PBP-2026-1102`（华东检修分公司，已批准）四行——
互感器 20+10 台日期差 15 天可合并、可用量 4 < 30 需采购、倒排 155 天不冲突、审核通过、
组包命中框架协议 `SPA-2026-0338`（额度 426 万够）、计划员确认、提交审批；断路器 4 台命中
一级集采目录而集采层级未标识 → 应集采未集采拦截；电缆 3000 m 现有量 5000 ≥ 最大库存 4000
→ 可调度转调拨。

## 真实 MetaERP 接口（VPN 通了以后）

`ontology-packages/procurement-hc-formal/package/transform-maps/metaerp-api-bindings.json`
把 63 个 catalog op 逐个对到 APIG 注册路径（来自 `.claude/skills/metaerp-openapi-call/reference/ppm-scenario2-apis.md`）：
`openapi` 形态走 IAM token（`call_openapi.py`），`ui` 形态走门户会话（`call_uiapi.py`），
`platform` 形态（决策对象、配置表）MetaERP 没有 API、由平台数据面承载。`metaerp.invoke`
目前只讲 statement-catalog 方言（POST `METAERP_BASE_URL + /metaerp/openapi/v1/<op>`，无鉴权），
接真 ERP 需要一层适配器（IAM token、`x-renter-id`、beta/v15 前缀、UI 形态的 CSRF 会话）——
这是下一步，不在本次范围内。

## 测试

```bash
pnpm --filter @agentic/ontology-compiler exec vitest run
```

```bash
pnpm --filter @agentic/mock-erp exec vitest run test/procurement-hc-formal-effects.test.ts
```

```bash
pnpm --filter @agentic/api exec vitest run test/procurement-hc-formal-scenario2.e2e.test.ts
```

- 金编译测试（13）：29 agent、`WorkflowManifestSchema` 通过、场景一与 hc-procurement 结构相同、
  闸口/降级/人工步骤/发射条件逐项、63 op 目录、与 `models/` 字节一致。
- mock ERP 写效应（16）：每条规则边界的正反例。
- 端到端级联（5）：真实引擎 + 真实 mock ERP + 脚本化 LLM，场景二全链 14 个事件走通、
  拦截整改回流、两个闸口的负例、计划员驳回分支。

**harness 陷阱**：内存级联里事件不经 JSON 序列化，envelope 组装会在顶层与 `last_result`
之间复用同一对象实例；`tool_arguments` 整体映射 `event.data` 时 `cloneJsonConstant`
把 DAG 当环拒绝（`tool_arguments_unresolved`），真 Inngest 上不会发生。级联驱动器已按
线协议 JSON 克隆。

## 已知事项

- `pnpm ontology-package:inspect` 对本 archive 报 `$.artifacts.actions[1].implementation.executable: must be a boolean`：
  19 个 `typescript` 类 action 没带 `executable` 字段。3.2.0 schema 只对 `http` 类要求它，
  AO 的影子准入（package-admission）对所有 action 要求显式 `executable:false`，属于 AO 侧比
  schema 更严的 fail-closed 策略。不影响编译/部署路径（走的是 studio-models 编译）；
  要么本体侧给 typescript 类补 `executable:false`，要么 AO 放宽"缺省视为 false"——需拍板。
- `annotateFrameAndCentralPurchase` 编成 external：编译器没有"先推理再写"的形态，框架命中与
  集采层级标注放在 ERP 写边界（mock 效应）里判定；接真 ERP 时这段逻辑要回到 agent 侧
  （编译器需要 prompt+write 形态）。
