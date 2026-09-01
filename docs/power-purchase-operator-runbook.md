# Power-Purchase Agentic Operator 运行手册

本入口加载 `models/power-purchase-v1/` 中的 Shadow + Decision Assist 工作流。
它绑定 `power-purchase@1.0.3`，只允许确定性时效评估和受约束的建议型 Agent；
MetaERP 生产调用、真实预警通知和自动业务审批仍然是 `denied`。

## 1. 准备运行时

仓库要求精确的 Node.js `26.5.0` 和 pnpm `11.21.0`：

```bash
nvm use 26.5.0
node --version
pnpm --version
```

预期分别为 `v26.5.0` 和 `11.21.0`。

## 2. 创建 Business Domain

先迁移数据库，再执行幂等 seed：

```bash
pnpm db:migrate
pnpm power-purchase:seed
```

该 seed 只创建 slug 为 `power-purchase` 的 tenant 行，不创建用户或
membership。重复执行不会产生第二条 tenant。生产环境中的操作员仍需由现有身份与
权限流程获得该 tenant 的 membership；本 seed 不绕过授权。

全新本地数据库还没有开发身份时，先按仓库标准流程执行 `pnpm db:seed`，或配置已有
active superadmin/用户及 membership；否则 `AUTH_MODE=dev` 会按设计拒绝启动。本脚本
不会为了方便测试而创建或提升身份。

## 3. 启动并加载 manifest

在没有正在运行的本仓库开发栈时执行：

```bash
pnpm dev
```

必须启动完整栈，不能只启动 API：`POST /v1/events` 需要 Inngest 才能实际分发。
API 健康检查地址是 `http://localhost:3540/health`。manifest 在 API 启动时从
`models/power-purchase-v1/` 自动发现，因此已经运行的 API 需要在合适的维护窗口
重新启动后才会看到新 tenant/workflow。

纯确定性评估不依赖模型；但正式预警会继续触发建议型 Agent，因此需按仓库标准配置
真实且获准的 `LLM_DEFAULT_PROVIDER`、`LLM_DEFAULT_MODEL` 与凭据。非测试进程会拒绝
test-only mock provider；模型或凭据缺失时 Agent 按设计失败关闭，不会回退为业务批准。

## 4. 注入 fixture/shadow 事件

下面的请求使用 API 的真实契约：`POST /v1/events`，业务字段放在 `payload`，
事件名保持为裸名（API 会按已认证 tenant 自动加命名空间）。`test: true` 明确标记
fixture，`targetAgent` 将入口限定到确定性评估 workflow。请求仍可能触发其声明的
下游 Shadow/Decision Assist Agent，但不会调用 MetaERP 或发送真实通知。

该示例只用于合成 fixture。当前建议型 Agent 仍会在执行期间接收完整内部事件上下文；
11 个运行单元已关闭 raw run input 与 raw model response 持久化，并将本场景记录保留期
设为 30 天，但字段白名单、脱敏与证据 hash 验证尚未实现。在这些生产控制完成评审前，
不要在此入口提交真实客户记录或秘密字段。

本地 `AUTH_MODE=dev` 可使用 `x-agentic-tenant` 选择已创建的 tenant；生产环境必须
改用已有的有效 cookie 或 Bearer token，并满足 `events.publish` 权限。

```bash
curl --fail-with-body -sS -X POST http://localhost:3540/v1/events \
  -H 'content-type: application/json' \
  -H 'x-agentic-tenant: power-purchase' \
  -H 'Idempotency-Key: pp-fixture-case-20260901-001' \
  -d '{
    "name": "POWER_PURCHASE_CASE_SNAPSHOT_OBSERVED",
    "subject": "PP-FIXTURE-2026-0001",
    "source": "operator",
    "test": true,
    "targetAgent": "powerPurchaseCaseAssessment",
    "payload": {
      "case_id": "PP-FIXTURE-2026-0001",
      "case_status": "in_progress",
      "expected_completion_ratio": 0.75,
      "actual_completion_ratio": 0.45,
      "time_deviation_working_days": 8,
      "formal_threshold_working_days": 7,
      "on_time_score": 0.55,
      "role_assignments": [
        {
          "governance_role": "executive_in_charge",
          "principal_id": "fixture-executive-001",
          "resolution_status": "resolved"
        }
      ]
    }
  }'
```

成功响应包含 `data.event_id` 和命名空间化后的 `data.name`。不要复用同一个
`Idempotency-Key` 来表达不同 fixture；相同 key 是同一次发布的安全重试。

## 5. 安全边界

- 当前模式仅为 `shadow_decision_assist`，不是生产执行模式。
- `powerPurchase.evaluateTimeliness` 是纯确定性工具，不读写外部系统；它只对调用方
  给出的上游 `on_time_score` 在正式阶段做分类，不实现 `PP-RULE-SCORE-001`。
- Overlay 记录所有 MetaERP Action 为 `deny`，但 runtime 尚不加载该 Overlay；当前
  技术阻断来自 manifest 没有授予 MetaERP 工具，也没有对应 adapter。
- 真实预警、短信、邮件或平台通知仍为 `deny`。
- Agent 不能批准、执行、关闭案例、重分类或发布阈值版本。
- 上线 MetaERP 前必须另行提供已验证的 adapter、凭据、授权、SoD、幂等与回执契约，
  并完成生产安全与客户验收；不能通过修改 fixture 或 manifest 绕过这些闸口。
- 当前完整 broker fan-out、durable manual 三路与 replay 去重仍需按运行设计中的 E2E
  清单验收；相关单元/契约测试通过不等于生产业务链已签署。
