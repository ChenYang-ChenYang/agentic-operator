# OntoCode 现状与最后一公里（2026-07-28）

本文只写**已核实**的事实：每条结论都有代码位置、测试或真实运行输出支撑。

---

## 一句话结论

**"从 Ontology 的 Action / Event / DataObject 生成可部署代码" 这件事本身已经跑通并有实证产物**——磁盘上有 6 个 agent、3671 行由本体生成的 TypeScript，全部带 `inngest.createFunction` 接线。**唯一没打通的是最后一步"部署"，其阻塞是基础设施（缺一个隔离沙箱运行器），不是代码缺失。**

---

## 一、已经是事实的部分（有产物）

真实生成物位置：
`data/factory-drafts/_tenants/ten-f17312c2b674/Agents-generation-620ca30d05ec5df2/versions/v-20260720054912892-0f578b0e/agents/`

| Agent | 行数 | 来源 Ontology Action |
|---|---:|---|
| agents-gener-create-jd.ts | 618 | createJD |
| agents-gener-process-resume.ts | 659 | processResume |
| agents-gener-match-resume.ts | 589 | matchResume |
| agents-gener-invite-internal-interview.ts | 594 | inviteInternalInterview |
| agents-gener-rule-check-for-candidate-identity.ts | 552 | 规则闸 |
| agents-gener-rule-check-for-match-resume.ts | 659 | 规则闸 |

生成代码里可核对的三要素接地（摘自 create-jd.ts 头部）：
- **Action** → `由 Agent 工厂从本体动作 createJD(Agents-generation) 生成`
- **Event** → `trigger: REQUIREMENT_LOGGED / CLARIFICATION_READY / JD_REJECTED → emit: JD_GENERATED`
- **DataObject** → `mapFields` 按本体输入 schema 逐字段落实并标注来源路径（`Job_Requisition.job_requisition_id`、`Client.client_id`）
- **部署目标** → `import { inngest } from "@/server/inngest/client"`，6/6 均含 Inngest function 接线

---

## 二、最后一公里为什么还没通（精确原因）

部署唯一可用的内核是 legacy `promoteDrafts()`，它有约 20 道 fail-closed 门。逐门核对后，**真正的硬阻塞只有一个**：

> 促升需要一份**由隔离沙箱运行器签名的执行回执**。本机 runner 是 `same_host_container`，其结果资格恒为 `development_only`；`promote.ts` 明确拒绝 `allowDiagnosticSameHost`。

其余门（人工 HMAC 审核回执、no-mock、整版促升、生产集成探针、工具/权限解析）都是**合理且应当保留**的治理门，不是障碍物。

另外两项确认：
- 磁盘上的 draft 版本 `regression: null` —— 只有 `finishDraftSandbox` 能产出带证据的可促升版本，而它需要上面那个合格沙箱。
- OntoCode 的 build **本来就会**在磁盘留下 legacy draft 版本（`runFactoryBuild` 缺它会直接 `factory_draft_missing`）。所以不需要"物化桥"，只需把它变成候选包的一等引用。

---

## 三、本轮新增（全部有测试）

| 能力 | 位置 | 验证 |
|---|---|---|
| Session 硬删除（任意状态可删，级联 15 张子表 + 审计留痕） | `ontocode-session-store.ts` `deleteOntoCodeSession` + `DELETE /v1/ontocode/sessions/:id` | api 4 测 |
| 右栏四 tab：产物 / 连接 / 日志 / 推理 | `ontocode-v10/{ArtifactInspector,SessionLog,SystemConnections}.tsx` | web 40 测 |
| 全部系统连接阶梯（不止阻塞的那一个）+ 配置 / 探针 / 标人工边界 | `SystemConnections.tsx` + `GET /v1/system-profiles/coverage` + `POST /v1/system-profiles/human-boundary` | 同上 |
| **Ontology Analyst**（新 `ontology_analysis` 作业种类，零迁移） | `packages/agent-factory/src/ontology-analysis.ts` + `apps/api/src/services/ontocode-ontology-analyst.ts` | 纯函数 10 测 + 服务 6 测 + 真 worker e2e 1 测 |
| 人工边界确认清设计门 | `ontocode-human-boundary.ts` | api 4 测 |
| **上线预检**（promotion 作业不再 `executor_not_available`） | `ontocode-deploy.ts` + worker `promotion` executor | api 4 测 |

四个包 typecheck 全清；web 739 测全绿；ontocode 相关 api 套件 49 测全绿。

### Ontology Analyst 的根因发现

`read_ontology` 只给模型 **`links: <count>`——一个整数**。Allmeta 编译好的 580 条带证据关系边被读入内存后直接丢弃。这就是"理解不了 Ontology"的真正原因：模型从来没见过关系图。

对 live Allmeta 实跑结果（`Agents-generation`）：
- 13 种关系类型 / 580 条边：`object-fk ×108`、`rule-references-object ×106`、`event-carries-object ×82`、`action-targets-object ×71` …
- 真实枢纽：`Job_Requisition`（入 62）、`Candidate`（59）、`Client`（43）、`Employee`（41）
- 事件链：`REQUIREMENT_LOGGED → createJD → jdReview`
- 7 个外部系统（含卡住构建的 `Internal_Recruitment_System`）

该实跑还抓出两个真 bug 并已修：`integration.systems` 是**对象数组**（只读字符串导致所有 live 域报"零外部系统"）；闭合事件图（无严格入口事件）导致"零事件链"。

诚实性是被测试锁死的：模型结论必须引用本体 id，**每个引用回查本体，引用不存在的 id 一律降级为"未验证"**；substrate 三态区分"没法看"（not_configured / unsupported_by_source）与"看了没有"（empty）。

---

## 四、要真正部署，还差什么

按优先级：

1. **合格的隔离沙箱运行器**（唯一硬阻塞，属基础设施）。仓库里外部 Docker 沙箱架构齐全，需要把 runner 用正确镜像拉起来并通过注册/执行/drain/cleanup 四类回读。这一步需要你拍板。
2. `promotion` 执行器补齐后半段：调用 `finishDraftSandbox` → `createSandboxedVersion` → `validateSandboxedRegression` → `publishValidatedVersion`（全部复用既有函数，不重写一行判断）。
3. `deploy` 执行器：直接调 `promoteDrafts(domain, {versionId, receiptId})`，成功后写 `released` + deployments 行 + 回滚点。
4. 候选包加第五种 artifact `package/factory-draft.json`，把磁盘 draft 版本纳入 dependencyRoot，使 CAS 产物、磁盘 draft、绑定文档三方哈希必须一致才允许部署。
5. 人工 HMAC 审核回执在 OntoCode 内直通（`/release/preview` + `/release/review` 透传既有服务，保持"仅交互式人类可签"）。

**Neo4j 说明**：`ontology.query` 工具存在且已注册，但本机无 `NEO4J_*` 配置，且其 `tenant_slug` 谓词与 Allmeta 节点的 `domainId` 不匹配（大小写也不同），盲接会返回 0 行却看起来成功。Analyst 因此如实报 `not_configured` 并改用 Allmeta 的关系图——那里本来就有真图。
