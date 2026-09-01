# HC-采购 · 场景一本体待修正项

> 面向本体维护者（含 AI 辅助修改）。每一条给出：**改哪个文件的哪个 id、现状原文、
> 建议改成什么、为什么、以及支撑该结论的实跑证据**。
>
> 目标本体：`采购-HC-Formal v0_1_004`
> （`ontology-packages/hc-procurement/source/{objects,rules,events}_v0_*.json`）
>
> 证据来源：`hc-procurement` 租户在 2026-09-01 的实跑（15 个编译后的 agent，
> 真实 LLM + mock Meta ERP），详见 `docs/hc-procurement-deviation-runbook.md`。

---

## C-01（必改）BR-DEV-01：判定口径应改为「比时间点」，且进度偏差不应无条件参与

**文件**：`rules_v0_2_004.json` → `payload[] where id == "BR-DEV-01"`

**现状**

```json
"machine_expression": {
  "source": "deviation.time_deviation_days > 7 || deviation.schedule_deviation_ratio > 0.2"
}
```
描述：「如果节点时间偏差大于 7 天，或进度偏差大于 20%，则判定该链路节点存在执行偏差」。

**问题**

进度偏差 = `1 − 已接收数量 / 订单数量`，在订单刚生效、按计划正常分批到货时天然就是一个大数。
只要这个比例超过 20%，即使该节点**距计划完成时间还很远**，也会被判为「存在执行偏差」并一路
走到红/黄/蓝定级与预警推送。

**实跑证据**

链路 `PBP-2026-0914`（110kV 电流互感器 30 台，需求到货 2027-01-20）：

| 事实 | 值 |
|---|---|
| 当前节点 | 到货（验收 18/30，部分接收） |
| 到货节点计划完成时间（按物资类周期倒排） | 2027-01-20 |
| 扫描日 | 2026-09-01 |
| 距计划完成 | **还有 141 天，未延期** |
| 时间偏差 | 负数（提前） |
| 进度偏差 | `1 − 18/30 = 0.4 > 0.2` |
| BR-DEV-01 判定 | **有偏差 → 预警** |

一条提前 141 天、已到货 60% 的正常链路被判为有偏差。这正是 R1-07「预警误报回收」
要处理的那一类误报，而它是规则本身产生的，不是数据质量问题。

### C-01a 时间维度：从「大于 7 天」改为「超过计划完成时间点即为延期」

**这是业务方 2026-09-01 明确的口径**：预警不看纯天数，而是比较**当前所处环节的计划完成
时间点**与**扫描当天**——超过了就预警，不设 7 天容忍窗口。

各环节的延迟也**不累计**：节点1 计划 5 天实际 8 天（延迟 3）、节点2 计划 7 天实际 1 天，
整体 12 天计划 / 9 天实际，扫描时若当前节点尚未到期，就**不预警**。这一条现有实现已经
满足——计划完成时间由需求到货日期固定倒排得出，与前序节点实际耗时无关，偏差只在当前
节点算一次（详见 C-03 的公式）。需要改的只是时间阈值本身。

`description` 改为：

> 如果当前节点的实际时间点（未完成节点代入扫描日）**超过**其计划完成时间点，则判定该链路
> 节点存在执行偏差。判定的是两个**时间点**的先后，不是各环节耗时的累加；前序节点的超期
> 若已被后续节点追回，当前节点未到期即不预警。时间阈值可调，**默认 0 天（超期即预警）**。

**配套配置**：`预警阈值配置表` 的 `时间偏差天数` 由 `7` 改为 `0`
（本仓库已改：`cfg_alert_threshold_t` 的 `TH-TIME-7D` → `TH-TIME-0D`，`THRESHOLD_VALUE = 0`）。
BR-DEV-02 要求阈值必须来自配置表，因此这是配置变更而非代码常量。

### C-01b 进度维度：只在该节点已过期时才参与判定

**合并后的建议表达式**

```json
"machine_expression": {
  "language": "cel",
  "source": "deviation.time_deviation_days > threshold.time_deviation_days || (deviation.time_deviation_days > 0 && deviation.schedule_deviation_ratio > threshold.schedule_deviation_ratio)",
  "version": "allmeta-cel-safe-v1"
}
```

描述补充：「节点尚未到期时，进度偏差不单独构成偏差——未完成且未延期的采购不预警。」

**同时补充 test_cases**（现有四条保留，新增两条）：

```json
{
  "id": "tc-dev01-early-partial",
  "comment": "未到期 + 进度偏差超阈值 → 不预警（业务口径：未完成且未延期不预警）",
  "context": { "deviation": { "time_deviation_days": -141, "schedule_deviation_ratio": 0.4 } },
  "expected": false
},
{
  "id": "tc-dev01-late-partial",
  "comment": "已超期 + 进度偏差超阈值 → 预警",
  "context": { "deviation": { "time_deviation_days": 3, "schedule_deviation_ratio": 0.4 } },
  "expected": true
},
{
  "id": "tc-dev01-late-1day",
  "comment": "只超期 1 天、进度正常 → 预警（阈值 0：超期即预警，取代原来的 >7 天）",
  "context": { "deviation": { "time_deviation_days": 1, "schedule_deviation_ratio": 0.0 } },
  "expected": true
},
{
  "id": "tc-dev01-ontime",
  "comment": "当天恰好是计划完成时间点、尚未超过 → 不预警",
  "context": { "deviation": { "time_deviation_days": 0, "schedule_deviation_ratio": 0.0 } },
  "expected": false
}
```

原有四条 test_case 中的 `tc-dev01-boundary`（`time_deviation_days: 7` 期望 false）
在新口径下**期望值应改为 `true`**——7 天已经超过计划完成时间点。

**影响面**：`Execution_Deviation.has_deviation` 的判定；`DEVIATION_DETECTED` /
`NO_DEVIATION_CONFIRMED` 的分流。R1-07 的误报率指标应随之下降。

**平台侧已先行实现（2026-09-01）**：本体 JSON 尚未更新，但
`overlays/hc-procurement.json` 里 `calculateExecutionDeviation` 的
`has_deviation` 判定口径已按上面的表达式改写，编译进
`models/hc-procurement-v1/`。原因是不改这条，默认全量扫描会同时命中
PBP-2026-0873（定标超期 5 天，红色）和 PBP-2026-0914（到货部分接收 18/30，
但需求到货日 2027-01-20 尚有 141 天），两条链路一起进入预警分支后
`pushAlert` 收到 `alert_level: ["红色","蓝色"]` 被 metaERP 以 HTTP 400 拒绝，
整条流程走不完。**本体 JSON 更新后请回来核对两侧表达一致。**

---

## C-02（必改）「当前扫描日」缺少来源绑定

**文件**：`objects_v0_1_004.json` → `payload[] where id == "Execution_Deviation"`

**现状**

```json
{ "name": "actual_finish_date", "description": "该节点实际完成时间；未完成时取当前扫描日。" }
{ "name": "evaluated_at", "is_required": true, "description": "本次偏差计算时间。" }
```

**问题**

「当前扫描日」和「本次偏差计算时间」都没有说明取自哪里。事件
`DAILY_DEVIATION_SCAN_SCHEDULED.scan_date` 明明已经承载了这个业务日期，但两个字段的
描述都没有指向它——执行方就会各自取"现在"，时间轴随之漂移，整条时间偏差链路失真。

**实跑证据**

链路 `PBP-2026-0873` 停在定标节点（无定标行），扫描事件 `scan_date = 2026-09-01`：

```json
"stage_node": "定标",
"actual_finish_date": "2026-08-20",   // 定标从未完成，这个日期是凭空生成的
"evaluated_at": "2026-08-20",         // 不等于 scan_date
"time_deviation_days": -32            // 结论是「提前 32 天」
```

正确结果应为：`actual_finish_date = 2026-09-01`（扫描日）、`evaluated_at = 2026-09-01`、
`time_deviation_days = +5`（定标计划完成 2026-08-27）。**「已延迟就预警」与「未延期不预警」
两条业务规则都依赖这个值，算错则两条都失效。**

第二例（同一次实跑，链路 `PBP-2026-0914`）：到货节点为**部分接收**（验收 18 / 订单 30），
按本体「接收数量=订单数量才算完全接收」它并未完成，`actual_finish_date` 应代入扫描日
2026-09-01；实跑填的是验收单时间戳 `2026-08-19T15:20:00+08:00`，时间偏差因此算成 −154 而非
−141。本例两者同为负数、结论（未延期→不预警）未变，但数值失真；若该节点已过期，同样的
错误会直接改变预警与否。

**建议改成**

```json
{
  "name": "actual_finish_date",
  "description": "该节点实际完成时间，仅当 stage_status 为「已完成」时取自对应业务单据的完成字段；「未开始」「进行中」「部分完成」一律视为未完成，代入本次扫描的业务日期（DAILY_DEVIATION_SCAN_SCHEDULED.scan_date），不得使用系统当前时间、不得推测日期、也不得拿部分完成单据上的时间戳充当完成时间。"
},
{
  "name": "evaluated_at",
  "is_required": true,
  "description": "本次偏差计算所基于的业务日期，必须等于触发本次计算的 DAILY_DEVIATION_SCAN_SCHEDULED.scan_date。它是「今天」的唯一定义，时间偏差、滞留天数、超期判定全部以它为基准。"
}
```

**影响面**：`time_deviation_days`、`dwell_days`、`Deviation_Alert.overdue_hours`
的口径统一；BR-ESC-01/02 的超时判定也依赖同一个「今天」。

---

## C-03（必改）倒排公式没有写进规则，只有文字描述

**文件**：`rules_v0_2_004.json` → `payload[] where id == "BR-PLAN-01"`
（并同步 `objects_v0_1_004.json` → `Chain_Stage_Progress.planned_finish_date`）

**现状**

BR-PLAN-01 只约束「缺配置则不予推算」：

```json
"source": "standard.standard_cycle_days > 0"
```

`Chain_Stage_Progress.planned_finish_date` 的描述是「由需求到货日期按标准周期逐级倒排得出」，
R1-02 说「以需求到货日期为终点按配置的标准周期逐级倒排」——**都没有给出公式**。

**问题**

「逐级倒排」有多种可能解释（是否含本节点周期、从哪一节起算、正排与倒排如何交叉校验），
执行方每次可能算出不同结果。

**实跑证据**

链路 `PBP-2026-0873`，需求到货 `2026-11-30`，物资类周期
立项10 / 组包15 / 询价20 / 定标15 / 合同15 / 订单10 / 到货70：

| | 定标节点计划完成时间 |
|---|---|
| 按公式 `2026-11-30 − (到货70 + 订单10 + 合同15) = 2026-08-27` | **2026-08-27** |
| 实跑算出 | **2026-09-20**（少减了一段） |

差 24 天，直接把「延期 5 天」算成了「提前 32 天」。

**建议改成**

在 BR-PLAN-01 的 `description` 中补入公式，或新增一条 `BR-PLAN-02`：

> 节点 k（k = 1..7，按 立项/组包/询价/定标/合同/订单/到货 顺序）的计划完成时间：
>
> ```
> planned_finish(k) = required_arrival_date − Σ standard_cycle_days(j)，j = k+1 .. 7
> ```
>
> 即：到货节点（k=7）的计划完成时间等于需求到货日期本身；其余每个节点的计划完成时间
> 等于需求到货日期减去它**之后**所有节点的标准周期之和（不含本节点周期）。
>
> 正排校验：`planned_finish(k) = planned_finish(k−1) + standard_cycle_days(k)`。
> 两向结果一致才可置 `planned_date_derived = true`；任一节点缺周期配置则该节点不予推算
> （BR-PLAN-01），并转系统管理员补配。

**影响面**：`Chain_Stage_Progress.planned_finish_date`、`planned_date_derived`；
`Execution_Deviation.time_deviation_days` 的正确性；进而是 C-01 的判定输入。

---

## C-04（建议）`deviation_level` 在偏差计算阶段没有合法取值

**文件**：`objects_v0_1_004.json` → `Execution_Deviation.deviation_level`

**现状**

```json
{
  "name": "deviation_level",
  "enum_values": ["无偏差", "蓝色", "黄色", "红色"],
  "is_required": true
}
```

**问题**

等级由 `scoreOnTimeProbability` 按按期概率映射得出（BR-PROB-01~03），但
`calculateExecutionDeviation` 产出这个对象时评分尚未发生，而字段是 `is_required: true`。
执行方只能随便填一个——实跑中填了「无偏差」，同时 `has_deviation: true`，对象自相矛盾。

**建议改成**

补一个中间态取值，或放宽必填：

```json
{
  "name": "deviation_level",
  "enum_values": ["待定级", "无偏差", "蓝色", "黄色", "红色"],
  "is_required": true,
  "default": "待定级",
  "description": "偏差等级（三级预警）。偏差计算阶段尚未评分，一律为「待定级」；由 scoreOnTimeProbability 按按期概率映射后回写（BR-PROB-01~03）。判定为无偏差的链路直接置「无偏差」。"
}
```

---

## C-05（可选）扫描事件缺少单计划过滤字段

**文件**：`events_v0_1_004.json` → `events[] where name == "DAILY_DEVIATION_SCAN_SCHEDULED"`

**现状**

```json
{ "name": "chain_scope", "type": "String", "required": false, "description": "扫描范围：全集团或指定单位。" }
```

**问题**

`chain_scope` 是自由文本，只能表达"单位"级范围。演示、排障、单链路重算都需要
"只跑这一条计划"，现在没有结构化字段承载。

**建议补充**

```json
{ "name": "plan_id", "type": "String", "required": false, "description": "限定只处理该采购计划（ss_pbp_header_t.PBP_HEADER_ID）。为空时按 chain_scope 与 BR-COV-01 全量扫描。" }
```

同时在 BR-COV-01 的描述里说明：显式指定 `plan_id` 时，全量覆盖义务在本次扫描内让位于
指定范围——这是排障口径，不是抽查。

---

## C-06（必改）`closeDeviationHandling` 的人工步骤与它自己的 actor 矛盾

该 action 的 `actor` 是 `["Agent","System"]`，描述写的是
「方案执行后**重算偏差**做消除校验：确认偏差已回落到阈值以内则闭环并留痕」——
这是一次**由智能体计算**的判定。但它的 `action_steps` 里却声明了一个
`object_type: "manual"` 的 `collectVerification`「采集业务核实结果」，
把这个判定改成向人索取。两者不能同时成立。

而且这个人工步骤**没有任何 rule gate**，所以红色链路每跑一次就停一次，
停在闭环前的最后一步。实跑中 run-e1ca6e1b1e55 就卡在这里。

**建议**：删除 `collectVerification` 这个 action_step，`verification_result` /
`deviation_eliminated` 由智能体重算得出（这正是 actor=Agent 的含义）。

**平台侧已先行实现（2026-09-01）**：`scripts/stage-hc-procurement-ontology.mjs`
的 `DROP_MANUAL_STEPS` 在投影时剔除该步骤。本体修正后请删掉对应条目。

---

## C-07（必改）BR-OPT-05 被重复采集了四次

`approveAdjustmentOption.plannerConfirm` 已经按 BR-OPT-05 收过一次计划员确认，
并且是具名的、在回写业务单据之前。但 `compressDownstreamCycle`、
`adjustRequiredArrivalDate`、`createStockTransferRequest` 三个执行分支各自又声明了
一个 `confirmByPlanner` 人工步骤，引用的还是同一条 BR-OPT-05。

同一个人、同一条规则、同一次决策，被要求确认四次。执行分支是
`ADJUSTMENT_OPTION_APPROVED` 的下游——那个事件本身就是「计划员已确认」的凭据。

**建议**：删除三个执行分支里的 `confirmByPlanner`，BR-OPT-05 只在
`plannerConfirm` 收一次。

**平台侧已先行实现（2026-09-01）**：同 C-06，见 `DROP_MANUAL_STEPS`。

**修正后的人工节点**：红色链路上只剩 `approveAdjustmentOption` 一处会停下来；
`handleBlueAlertLocally`（门控 `alert_level == '蓝色'`）与 `recycleFalseAlarm`
（门控 `verification_result == '误报'`）都不会在该链路上触发。

---

## 修改后需要重跑的验证

1. `pnpm hc:compile` —— 重新编译，`--check` 应报 outputs up to date
2. 发一次 `DAILY_DEVIATION_SCAN_SCHEDULED`（`scan_date` 用当天）
3. 断言：
   - 链路 `PBP-2026-0873`：`stage_node=定标`、`planned_finish_date=2026-08-27`、
     `actual_finish_date=<scan_date>`、`time_deviation_days≈+5`、`has_deviation=true`
   - 链路 `PBP-2026-0914`：`time_deviation_days<0`、`schedule_deviation_ratio=0.4`、
     **`has_deviation=false`**（C-01 生效后不再误报）
