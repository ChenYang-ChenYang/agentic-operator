# Power-Purchase Agentic Operator 运行设计

状态：R1 Local Fixture / Shadow 条件签署；Overlay 为描述性策略回执

日期：2026-09-01

业务域：`power-purchase`

源 Ontology Package：`power-purchase@1.0.3`
源 package hash：`sha256:893a26cf8c65b4194023301269f246d43f74fc75a181d78731cc9dd273b8ca1c`

## 1. 规范化执行请求

### 目标状态

在不改写 `power-purchase@1.0.3`、不伪造 MetaERP 合同、不授予 Agent 审批或执行权的前提下，形成一套可以由 Agentic Operator 注册、触发、暂停、人工恢复和审计的采购时效工作流与 Agent 方案。系统必须明确区分：

1. 确定性业务判断；
2. Agent 的证据分析和建议；
3. 人工决定；
4. 被能力门阻断的外部动作；
5. 尚待 `power-purchase@1.1.0` 发布的新增业务语义。

### R1 当前输入

- 调用方显式提供的案例键、状态、预期/实际进度、工作日偏差与正式阈值；
- 仅在 `formal_candidate` 阶段使用调用方显式提供的 `on_time_score` 与组织角色快照；
- `on_time_score` 被视为已固定的上游输入，本轮没有实现 `PP-RULE-SCORE-001`，因此不能称为端到端准时分计算；
- 经授权入口提交的事件或 Shadow fixture；
- R1 manifest 记录源 package hash，但 runtime 尚未加载 Overlay，也未强制校验
  Workflow/Rule/Calendar/Threshold/Prompt/model/evidence hash pin。

固定 evidence hash、版本 pin、案例权限和最小 `AgentCaseContextEnvelope` 是生产目标契约，
不是 R1 已强制能力。

### 输出

- 确定性的偏差状态、风险等级和路由建议；
- 证据约束的原因候选、DQ 修复建议、处置建议、预警摘要、执行对账建议和阈值复核建议；
- 可恢复的人工任务与决定回执；
- 明确的 `blocked_by_capability_gate`、`indeterminate` 或 `result_unknown`；
- Operator 的 run、step、event、Task 与模型调用回执。package/hash 目前保存在描述性
  Overlay 中，尚未与每次运行建立受信 admission 绑定。

### 硬约束

- `power-purchase@1.0.3` 保持字节和 package hash 不变。
- Ontology Package runtime-plan candidate 仍然不可导入、不可 bootstrap、不可部署。
- Shadow 环境真实 MetaERP 网络调用次数必须为 0。
- 金额偏差在当前版本保持禁用。
- 缺关键字段时风险等级必须为 `null`，不得将 DQ 显示为“无风险”。
- Agent 不得重新计算偏差、概率、预警等级或审批结果。
- 人工决定缺失或未知时 fail closed；tenant 级 Operator RBAC 由服务器强制。
- 案例级业务角色、SoD、对象版本和 artifact/request hash 尚未强制，因此 R1 task 不能
  解释为业务批准，生产激活保持拒绝。

## 2. 运行层级

| 层级                   | 当前允许                                                     | 当前禁止                             |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------ |
| R1 Shadow              | 固定输入、纯计算、Agent 建议、内部 Task、事件和审计回执      | 所有真实 MetaERP 调用和真实业务通知  |
| R2 Read-only pilot     | 仅在 13 个查询合同、状态映射、分页和授权完成后逐 Action 开启 | MetaERP 写操作                       |
| R3 Governed write      | 单独批准的到货承诺变更，具备新鲜审批、SoD、幂等和读回        | 未验证写入、库存调拨自动执行         |
| R4 Controlled autonomy | 本场景暂不规划                                               | Agent 自主审批、关闭、阈值发布或补偿 |

本轮实现目标是 R1。它是真实的 Operator 运行与人工任务，不是生产 MetaERP 集成。

## 3. 原 1.0.3 决策内核

`power-purchase@1.0.3` 已声明 11 个 Workflow、84 个 step、52 个 Action、7 个同步子流程、2 个 Wait、3 个人工门和 34 个事件发射。它们保留为单案例确定性决策内核：

1. 采购执行偏差三级预警主流程；
2. MetaERP 源数据采集；
3. 进度同步；
4. 基线与偏差评估；
5. 风险分类与预警路由；
6. 处置决策；
7. 处置执行；
8. 告警升级；
9. 关闭资格与状态投影；
10. 告警质量反馈；
11. 处置补偿。

这些声明不能直接转换为普通线性 `WorkflowManifest`：包内含循环、同步子流程、类型化 context patch、CEL 条件和多事件 Wait。现有异步 `subflow` 不是等价替代。

R1 的纯工具只实现 DQ、进度、超期阶段、正式阶段的既有分数分类与角色路由五个规则
切片。它不实现 `PP-RULE-SCORE-001`，也不等价执行原 11 Workflow / 84 step。

## 4. power-purchase@1.1.0 演进 Workflow

以下是新增业务语义，必须进入新的不可变 package release；不能回填或伪称已由 `1.0.3` 授权。

当前 Ontology Package schema bundle 3.2.0 只有六个 artifact family，没有受治理的
Agent family、Agent schema/hash/semantic validator 或 Agent→Action Link。因此
`power-purchase@1.1.0` **尚未发布**；OntoPlanet 只生成了
`power-purchase-1.1.0-evolution-candidate.json`。该候选 `candidate_status=not_publishable`，
不得导入 Studio 或 Operator，也不得仅把 Agent 塞进 `extensions` 后冒充正式包。

| 优先级 | Workflow ID                                     | 目标与关键边界                                                                                                   |
| ------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| P0     | `workflow-procurement-monitoring-orchestration` | 定时、事件、人工三入口；发现开放承诺、限流逐案派发、批次水位、重放回执。未签查询合同时 fail closed。             |
| P0     | `workflow-case-policy-resolution`               | 精确解析并固定阶段周期、日历和阈值，生成 `ResolvedCasePolicyBundle`；消除隐式 resolver。                         |
| P0     | `workflow-data-quality-resolution`              | DQ 分诊建议、数据管理员提交、系统哈希/读回验证、解决或拒绝、生成新快照并重放；关键 DQ 不可人工豁免后直接分级。   |
| P0     | `workflow-alert-delivery-acknowledgement`       | 严格区分 routed、delivered、acknowledged、responded；内部任务可运行，外部通知 adapter 保持禁用。                 |
| P0     | `workflow-cause-confirmation`                   | Agent 只产生 suspected/unknown 和证据缺口；采购责任人确认或拒绝，系统写入确认事实。                              |
| P0     | `workflow-case-schedule-compression-execution`  | 只生成案例级基线修订，append/supersede；不得修改共享策略。                                                       |
| P0     | `workflow-delivery-commitment-change-execution` | 原值/当前值/建议值、精确请求哈希、需求负责人审批与 SoD、写入、读回和对账；副作用不明时不得盲重试。               |
| P0     | `workflow-inventory-transfer-feasibility`       | 只做可行性建议和库存负责人审批；无库存证据时不得声称地点或数量，当前不执行库存事务。                             |
| P0     | `workflow-execution-result-reconciliation`      | 对 `result_unknown`、超时或读回不一致做 ledger/只读核实和人工确认；只有已验证副作用与签名调用回执才可进入补偿。  |
| P1     | `workflow-threshold-review-governance`          | 汇总已复核误报，验证窗口和分母，Agent 提议、规则评审组决定，只发 Studio 版本变更请求。                           |
| P1     | `workflow-timeliness-kpi-measurement`           | 同时保留原始基线和修订后口径，计算覆盖率、DQ 抑制、送达/确认、误报分母和 lead time；不能把顾问目标写成已达收益。 |

原 `workflow-remediation-execution@1.1.0` 应退化为确定性路由器，固定调用计划压缩、承诺变更、库存可行性和执行结果对账四个子流程。运行中的 `1.0.3` 案例继续固定旧版本，不做中途迁移。

## 5. Agent 团队

不要创建 LLM 协调器。Workflow 是协调器，确定性规则和人工门拥有状态转换权。

| Agent contract                                         | 唯一职责                           | 允许输出                                          | 禁止能力                           |
| ------------------------------------------------------ | ---------------------------------- | ------------------------------------------------- | ---------------------------------- |
| `procurement-evidence-analyst@1.0.0`                   | 整理证据、提出原因候选与最小缺证据 | suspected/unknown 原因分析 Shadow DTO             | confirmed 原因、重新分级、外部调用 |
| `procurement-timeliness-agent@1.1.0-overlay`           | 形成处置建议                       | 处置建议 Shadow DTO，含原 KPI、剩余风险及能力阻断 | 批准、执行、关闭、MetaERP          |
| `procurement-dq-triage-assistant@1.0.0`                | 分析 DQ 成因与修复路径             | DQ 分诊 Shadow DTO                                | 修改 ERP、关闭 DQ、豁免关键字段    |
| `procurement-alert-briefing-assistant@1.0.0`           | 形成事实约束的预警摘要             | 未发送的预警摘要 Shadow DTO                       | 任意收件人选择、通知发送、升级决定 |
| `procurement-execution-reconciliation-assistant@1.0.0` | 分析 ledger、调用和读回证据        | 执行对账 Shadow DTO、人工核实问题                 | 重试写入、认定未经验证的成功、补偿 |
| `procurement-feedback-review-assistant@1.0.0`          | 汇总已复核误报并提出规则复核建议   | 阈值复核 Shadow DTO                               | 发布阈值、重开告警、直接改 Rule    |

统一约束：

- workflow-bound、单轮、严格 JSON Schema、无跨案例记忆；
- `temperature=0`、最多一次 schema repair、不持久化 raw response；
- Agent 输出执行 strict JSON Schema 验证；R1 尚未实现 evidence ID、范围与 hash 的独立
  System Action 验证，因此这些输出明确不是 1.0.3 的正式 Ontology Object；
- `tool_use=[]`，除非未来单独批准只读工具；绝不授予 MetaERP 工具。

R1 的建议型 Agent 仍使用 `context.path="$"` 接收完整内部事件上下文，但 11 个运行单元
均已设置 `persist_run_input=false`、`persist_raw_response=false` 和
`retention_days=30`。这降低了本地 Shadow 的数据滞留面，并不等于完成生产数据最小化：
真实客户数据试点前仍必须实现字段白名单/最小 `AgentCaseContextEnvelope`、脱敏、证据
hash 验证以及按数据分类批准的保留策略；否则 Security 不得签署。

## 6. R1 可运行事件链

本轮 Operator manifest 提供以下安全链路（事件名与
`models/power-purchase-v1/workflow_v1.json` 一致）：

```text
POWER_PURCHASE_CASE_SNAPSHOT_OBSERVED
  -> deterministic timeliness evaluation
     -> POWER_PURCHASE_MONITORING_UPDATED
     -> POWER_PURCHASE_FORMAL_ALERT_CLASSIFIED
        -> evidence analyst
           -> POWER_PURCHASE_CAUSE_ASSESSMENT_PROPOSED
           -> deterministic cause router
              -> suspected: POWER_PURCHASE_CAUSE_ASSESSMENT_ACCEPTED
                 -> remediation planner
                    -> POWER_PURCHASE_REMEDIATION_PROPOSED
                    -> deterministic proposal router
                       -> proposal: POWER_PURCHASE_REMEDIATION_SHADOW_REVIEW_READY
                          -> durable operator shadow-review task
                          -> POWER_PURCHASE_REMEDIATION_SHADOW_REVIEW_RESOLVED
                          -> deterministic shadow guard
                             -> approve: POWER_PURCHASE_EXTERNAL_EXECUTION_BLOCKED
                             -> reject: POWER_PURCHASE_REMEDIATION_REJECTED
                             -> supplement: POWER_PURCHASE_REMEDIATION_SUPPLEMENT_REQUESTED
                                -> evidence analyst (new evidence cycle)
                       -> abstain_data_quality: POWER_PURCHASE_DATA_QUALITY_HANDOFF_REQUIRED
              -> unknown/abstain_data_quality: POWER_PURCHASE_DATA_QUALITY_HANDOFF_REQUIRED
        -> alert briefing assistant
           -> POWER_PURCHASE_ALERT_BRIEF_PREPARED
     -> POWER_PURCHASE_DATA_QUALITY_HANDOFF_REQUIRED
        -> DQ triage assistant
        -> POWER_PURCHASE_DQ_TRIAGE_PROPOSED

POWER_PURCHASE_EXECUTION_RECONCILIATION_REQUESTED
  -> execution reconciliation assistant
  -> POWER_PURCHASE_EXECUTION_RECONCILIATION_PROPOSED

POWER_PURCHASE_ALERT_QUALITY_WINDOW_REVIEW_REQUESTED
  -> feedback review assistant
  -> POWER_PURCHASE_THRESHOLD_REVIEW_RECOMMENDED
```

这条链路不会调用源 runtime-plan candidate，也不会声称覆盖全部 84 个 package step。
DQ 数据管理员处置/重放、原因确认、业务审批、规则评审任务和阈值版本请求仍属于
`power-purchase@1.1.0` 目标 Workflow，不是 R1 已运行能力。完整 11/84 语义投影仍需专用
Ontology Workflow deployment lane。

## 7. 目标人工门与职责分离

下表是 `power-purchase@1.1.0` 与生产激活应实现的业务门。当前 R1 只创建
`awaiting_role=operator` 的 durable shadow-review task；它不是业务批准，且显式携带
`business_approval=false`、`external_execution_authority=false`。在 Agentic Operator
完成案例级业务角色与 SoD 强制前，不得把 R1 task 改名或解释为下表中的生产批准。

| 门            | 责任角色                     | 服务器侧检查                                        |
| ------------- | ---------------------------- | --------------------------------------------------- |
| DQ 证据提交   | data steward                 | tenant/domain/case、证据哈希、关键字段不可豁免      |
| 原因确认      | procurement owner            | 只能确认已有证据候选；Agent 不能作为确认人          |
| 计划压缩      | procurement/process owner    | 建议者、批准者、执行者分离                          |
| 到货日期变更  | demand owner                 | 精确 proposal/request hash、对象版本、新鲜权限、SoD |
| 库存可行性    | inventory owner              | 只批准可行性评审，不产生事务成功                    |
| 未知执行核实  | business executor + operator | ledger、读回、签名调用回执                          |
| 关闭/风险接受 | 原因特定授权角色             | 原因特定最低证据                                    |
| 阈值版本请求  | rule review group            | 已复核分母、窗口、原阈值和建议版本                  |

人工恢复事件中的 decision 必须是 `approve | reject | supplement`。缺失或未知值在 runtime 层 fail closed，不能回退成 approve。

## 8. External Action deny list

R1 Overlay 记录下列 15 个 Action 的 deny 策略：

- `action-metaerp-query-open-pbp-header`
- `action-metaerp-query-open-pbp-line`
- `action-metaerp-get-all-pbp-line-page-by-query`
- `action-metaerp-query-pr`
- `action-metaerp-query-proc-package-line-execute-mode`
- `action-metaerp-query-rfx-list`
- `action-metaerp-query-award-list`
- `action-metaerp-get-spa-by-query`
- `action-metaerp-get-contract-by-query`
- `action-metaerp-query-po-header`
- `action-metaerp-query-po-line-shipment`
- `action-metaerp-query-accept-header`
- `action-metaerp-query-accept-transaction`
- `action-metaerp-change-pbp`
- `action-metaerp-create-transaction-order`

当前 runtime 不加载该 Overlay；真实 dispatch 的技术阻断来自 manifest 没有授予这些工具、
也没有对应 adapter。Overlay 是经测试的策略证据，不是激活权威。读取合同完成后，应按
Action 逐一激活 13 个 query；`changePbp` 必须单独通过写操作 Gate；库存事务继续
propose-only。

## 9. Operator 平台演进

完整 11/84 投影需要独立 Ontology Package deployment lane，而不是把所有流程压平为一个普通 manifest。最低能力包括：

1. 多 Workflow、独立版本、package/workflow hash 固定的同步 child invocation；
2. parent/child checkpoint 和真实 `parentRunId`；
3. 类型化 artifact/context-patch 合并与 evidence hash 重算；
4. `allmeta-cel-safe-v1` 编译器证明及包内 100 个测试向量；
5. 工作日历 durable wait、多 wake/cancel、active-time 计时；
6. 事务型事件 outbox 和 exactly-once replay 证据；
7. principal/tenant/domain/case/role/SoD 的服务端强制；
8. 人工恢复与 continuation 的原子状态转换；
9. Action binding、side-effect ledger、readback 与补偿资格；
10. 固定 package/compiler/runtime/tool/model/prompt/role-directory 的 activation ledger。

## 10. 验收标准

### R1 已验证

- manifest 能由当前 Agentic Operator parser 读取，且无 blocking lint；
- 确定性 Step Engine 回归覆盖基础 DQ、进度公式、首个超期信号、正式阈值、正式阶段
  红黄蓝边界、角色路由与治理 DQ；
- 6 个 Agent 均为 strict structured output，零 MetaERP tool grant；
- 4 个确定性运行单元与 1 个 Human review 单元闭合原因门、建议门和 Shadow 人工三路；
- 原因 `unknown/abstain_data_quality` 与建议 `abstain_data_quality` 均确定性转入 DQ，
  不会创建人工复核任务；补充材料事件可重新触发证据分析；
- 11 个运行单元均不持久化 raw run input/raw model response，场景保留上限为 30 天；
- package ID/release/hash、六族 hash、runtime plan hash 和 deployment mode 记录在 Overlay，
  但尚未由 runtime admission 强制；
- 15 个 external Action 记录为 deny；manifest 无对应 grant/adapter；
- 缺失或未知人工决定 fail closed；
- v2 `emit/invoke/foreach` 动作在规范化后保持确定性类型，不再降级成 LLM `logic`。

### R1 尚待端到端验收

- Formal event 对两个 Agent 的真实 broker fan-out；
- LLM 输出经真实 broker fan-out 后从 `abstain_data_quality` 到 DQ、从 proposal 到
  Shadow review 的完整运行（确定性 Step Engine 分支已回归）；
- durable manual task 的创建、恢复、approve/reject/supplement 三路及 approve 后 blocked
  event（决定路由的 Step Engine 分支已回归）；
- Inngest replay 不重复 Task/Event，以及多案例 subject/correlation 隔离；
- 最小上下文、evidence/hash 校验与 Overlay admission。

这些项目完成前，只能签署本地 Shadow 原型和外部副作用隔离，不能声明完整 R1 链路或
业务验收通过。

### 完整 1.1.0 / Package deployment lane

- 11/11 原 Workflow、84/84 step、7/7 同步 child、2/2 Wait、3/3 human gate 和 100/100 CEL vectors 无近似投影；
- 新增 11 个运营闭环 Workflow 进入不可变 `1.1.0`；
- 任一 package、family、compiler、runtime、tool、prompt、model、role 或 adapter hash 漂移即拒绝旧 activation；
- replay 不重复事件、Task 或 side effect；LLM replay 使用已存输出，重新调用模型属于新 evaluation；
- 生产启用仍需客户确认真实状态映射、合同/PO-line/库存关系、组织、日历和每个 MetaERP 合同。

## 11. 审查结论

- Ontology/Workflow Architecture：R1 local fixture/Shadow 条件签署通过；生产签署不通过。
- Principal Agentic Engineering：R1 local fixture/Shadow 实现签署通过；生产签署不通过；
  禁止直接导入 runtime-plan candidate。
- Product Owner / Enterprise Architecture：R1 local fixture/Shadow 有条件签署通过；完整
  R1 broker/manual/replay 端到端链路尚未签署；生产签署不通过。
- 生产 Operator/MetaERP、客户业务与 Security 签署均未取得，生产激活明确拒绝。
