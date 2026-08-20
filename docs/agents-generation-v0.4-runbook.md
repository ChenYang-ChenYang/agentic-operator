# Agents-generation v0.4 运行手册

这套流程只通过 AllmetaOntology HTTP API 读写 Ontology，不允许 Agent Factory、发布脚本或生成的 functions 直连 Neo4j。

## 1. 生成可审查候选包

```bash
pnpm run build:agents-generation-ontology
```

脚本会读取：

- 用户提供的 `actions_v0_2_001.json`、`objects_v0_2_001.json`、`rules_v0_2_001.json`；
- 当前 AllmetaOntology 中 `Agents-generation` 的实时 Rules；
- 旧六函数仅作为事件/数据契约对照，不把旧 tenant 的候选人判定、阈值或路由代码带入新 tenant。

当前 reviewed 版本输出目录为 `artifacts/ontology/Agents-generation/v0_4_001/`。只有 `releaseGrounding.mode=live_allmeta_api`、`allmetaRulesRead=true` 且 `releasable=true` 的包能进入发布预览。

本版本的 full-domain 发布范围严格限定为 DataObjects、Rules、PolicyScopes、Actions、ActionSteps、Events 和 Links。Allmeta 的这个发布端点不管理运行时 Workflow，因此：

- `domain_ontology_v0_4_001.json` 中的 `workflow: []` 是有意的，表示候选 Ontology 不夹带手写 Agent；
- `release_bundle_v0_4_001.json` 不含 `workflow` 字段，不会删除或伪造运行时 deployment；
- 业务串联由 Event 与 Action 的输入/输出/触发 Links 表达，实际 Inngest functions 只能由 Factory 草稿、审查、sandbox、promotion 流程产生。

仅做本地结构测试时可使用：

```bash
ALLOW_OFFLINE_LIVE_RULES=1 pnpm run build:agents-generation-ontology
```

离线包会被永久标记为 `offline_scaffold_test`；发布客户端会在发出任何 Allmeta 请求前拒绝它，不能把离线结果冒充已读取实时 Ontology。

仓库中的 `v0_4_000` 仅保留为历史离线结构参考，不是 reviewed 发布输入，也不是发布客户端默认 bundle。不要对它执行 preview、authorize 或 execute；需要发布时必须重新生成 live-grounded `v0_4_001`。

## 2. 只读发布预览

```bash
pnpm run preview:agents-generation-ontology-release
```

默认是 dry-run：读取完整 before-image、生成差异与所有权确认模板，不执行覆盖。只有预览没有候选契约错误，并且人工完成 domain-less ownership/removal 确认后，才可使用 `--execute`。发布客户端只接受精确 domain `Agents-generation`。

在能访问 AllmetaOntology 的部署主机上，执行顺序是：

```bash
pnpm run build:agents-generation-ontology
pnpm run preview:agents-generation-ontology-release
pnpm run preview:agents-generation-ontology-release -- --execute --operator-id "<可审计的操作人>" --confirmation-file "<dry-run 生成并经人工审查的确认文件>"
```

如果 dry-run 证明没有 domain-less 所有权选择需要确认，可以省略 `--confirmation-file`。API token 与独立的 release operator token 只通过环境变量或受管密钥引用提供，不能写进 Ontology、release artifact、fixture、日志或聊天记录。

## 3. Factory 实际交付路径

1. Allmeta 预检：读取 Objects、Events、Actions、ActionSteps、Rules、Links。
2. 生成 6 个 Agent 草稿：旧 RAAS 判决工具在本 tenant 不可用；Factory 按 `integration.systems` 与工具 capability 元数据选择 profile-bound 原始事实读取能力（当前 canonical 工具为 `facts.query`），判决使用实时 Rules/decision table。工具选择不是从名称或描述猜出来的；同分候选、缺 profile 或缺参数映射时进入 `ask_user`。
3. 人工字段级审查：任何 PATCH 都产生新不可变版本，并使旧 sandbox/review 证据失效。
4. 外部 sandbox：创建临时 Inngest App，以独立 sandbox profile、签名 fixture/cassette 和真实模型执行回放；完成后验证删除并保存回执。
5. production 探针：按当前 production endpoint、credential、工具实现和 config 重新做 HMAC live probe；写工具还必须证明创建、幂等、清理和删除后缺席。
6. promotion：重新读取当前 Ontology、profile、工具和探针；验证人工签核、镜像供应链、回归与 Inngest 注册后才提交。
7. 真实运行：只加载 target tenant 的 production manifest；临时 sandbox App 与最终 App 身份隔离。

本地 runtime manifest 也有明确边界：`models/agents-generation-v1/workflow_v1.json` 仅保留旧六 Agent 供审计和契约比较，空的 `workflow_v2.json` 是当前有效 head，所以旧六 Agent 不会被启动。只有一次通过全部 promotion gate 的 Factory 发布才能写入下一版。所有 `generated: true` 的 Agent——无论是 declarative 还是 CodeAct——都必须绑定被审查 spec、渲染模块和精确 manifest hash 的持久授权记录；启动时和每次真实运行前都会重新校验，撤销、回滚或篡改后旧 Inngest closure 也不能继续执行。

## 4. 仍需由部署方提供的真实环境数据

- 外部 sandbox runner 的 DNS/TLS/VPN、机器身份、镜像 digest/build allowlist、签名密钥与模型代理；
- 每个外部工具独立的 sandbox 与 production integration profile；
- GoHire/RAAS/PostgreSQL/Allmeta 的测试租户、测试 namespace 和可回收的 canary 数据；
- 写工具的安全探针契约。不可逆邀请不能用真实候选人做自动 canary，应保留人工 `INTERVIEW_INVITATION_REQUESTED` 闸门或由平台提供可撤销测试邀约 API。

缺少上述内容时，Factory 可以继续生成带有 typed dependency port、错误分支与
未验证标记的 **non-promotable 草稿**，并在总结中逐系统告诉 FDE 缺什么；
它不能生成假配置、假成功或把 signed fixture 当作 production 证明。
真正的 sandbox 执行、production probe 与 promotion 仍停在 `ask_user` /
配置闸门，直到 profile 和真实探针证据齐全。环境引用与诊断返回契约见
[`agents-generation-tool-env-contract.md`](./agents-generation-tool-env-contract.md)。

### 集成 profile 与安全探针最低要求

| 能力槽 | profile 必须明确 | sandbox / production 证明 |
| --- | --- | --- |
| `objectStore.getObject` | 对象存储系统、bucket/namespace、只读 credential 引用、允许的对象类型 | 可读取签名 fixture；生产探针只读专用 canary，并核对字节数与摘要 |
| `facts.query` | 精确 `system_name`、只读角色、服务端 statement-catalog operation allowlist、连接 credential 引用 | 禁止模型提交任意 SQL；探针证明 operation 存在、只读且结果 schema 匹配 |
| `parseResumeApi` / `generateJdApi` / `matchResumeApi` | 外部系统、endpoint、模型/版本、超时、幂等和 credential 引用 | sandbox 使用隔离租户或签名 cassette；production 用不触发业务副作用的 canary 验证真实 endpoint |
| `records.upsert` | 目标 store、tenant namespace、主键/幂等键、写 credential 引用 | 创建、重复写、清理、删除后缺席四项均成功 |
| `entities.write` | 精确 system 绑定（`system_name`）、写角色、当前 Action 固定的 server-owned operation、statement-catalog allowlist、values 字段映射、稳定幂等键与 credential 引用 | 创建、重复写、事务回滚、清理、删除后缺席均有证据；当前若没有 cleanup/absence adapter，状态必须保持 `needs_config` |
| `ontology.fetchActionRules` | Allmeta base URL、精确 domain、只读 credential 引用 | 通过 Allmeta API 读取当前 Action/Rule/Link 版本与摘要，禁止直连 Neo4j |
| `ontology.writeInstance` | Allmeta base URL、精确 domain、隔离 canary namespace、写 credential 引用 | 创建、幂等、清理、删除后通过 Allmeta API 证明缺席 |
| `inviteCandidateApi` | 外部系统、审批事件、幂等键、可恢复/补偿策略、credential 引用 | 不允许拿真实候选人做自动探针；必须使用可撤销测试邀约 API，或停在人工闸门 |

`reasoning.evaluateRules` 是本地、确定性的规则执行能力，但它仍必须绑定运行时刚读取到的 Rule/decision-table 摘要，不能把旧 RAAS 阈值或判决复制进代码。工具名只是能力槽；Factory 依据结构化 capability、integration profile、参数映射和探针证据选择实现，不从 Action 的自然语言描述猜平台。

通用 transport 的 `systems:["*"]` 只表示实现可以复用，不表示它有权猜 endpoint。它必须绑定当前 tenant/domain/environment 已确认的 profile；同一个 profile 若被要求同时代表两个不同的 Ontology system，Factory 会停在 `ask_user`，要求拆成独立工具/profile 槽或先修正 system 标识。
