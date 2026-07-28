# 外部沙箱执行面部署记录 —— 本机 Linux VM（2026-07-28）

## 这套拓扑是什么，不是什么

这是一台跑在**开发者 Mac 上**的 Colima/Lima Linux VM（profile `agentic-sandbox`），承载 external sandbox 栈；
主 API 以原生 node 进程跑在同一台 Mac 上。

**是真实的**：独立内核与独立 `/etc/machine-id`；镜像来自真实 registry 的 `repository@sha256`；
TLS 由 VM 内的反向代理终结，证书由本地 CA 签发并按主机名验签；VM 自身 nftables 出站策略。

**不是的**：物理主机独立性。VM 与主 API 共享同一台机器的 CPU、磁盘、供电与物理保管——
**Mac 失守，VM 一并失守**。签名用的 Ed25519 attestor 私钥也在这台 Mac 上，
设计意图中"attestor 是独立于运行方与 API 方的第三方"在这里不成立。

这些不是被绕过的检查，是**这套拓扑不具备的属性**。任何据此产生的促升证据都应带着这句话一起读。

---

## 实测事实

### 身份（四者两两不同）

| | 值 |
|---|---|
| VM 主机 sha256(machine-id) | `c39ae9de…c70` |
| VM daemon sha256(id) | `8d636464…a36` |
| Mac 主机 sha256(IOPlatformUUID) | `3cad9474…539` |
| Mac daemon sha256(id) | `d21f84b4…520` |

`remote-runner-entrypoint.sh` 在每次容器启动时**重算** VM machine-id 并要求 ≠ primary；
仅修改 `SANDBOX_RUNNER_ACTUAL_ISOLATION_TIER` 绕不过这一检查。

### 镜像

VM 内 `registry:2`，七个镜像按内容 digest 入库并回拉，daemon 记录真实 RepoDigest。
`docker save/load` 只作传输用；digest 由 registry 在 push 时按内容计算 —— 直接 save/load
不保留 RepoDigest，那样自报的 digest 是编造的，validator 也会当场识破。

### 网络

- 容器 → 主机：`192.168.5.2`（Lima 用户态网关），实测可达。
- 主机 → runner：Lima 端口转发到 VM 的 `3570`。
- 容器**无通用外网出站**（实测：临时放行 1.1.1.1 后仍不通）。
  因此"仅 model proxy 可达"这一性质成立，但**不是由本部署的 nftables 规则强制的** ——
  规则已装载并在链上，但归因不成立，不应记为本次配置的成果。

### TLS

- runner ingress：`https://sandbox.factory.internal:3570`，TLS 在 VM 内终结。
  `openssl s_client -CAfile ca.crt -servername sandbox.factory.internal` → `Verify return code: 0 (ok)`。
  node + `NODE_EXTRA_CA_CERTS` 走真实客户端路径 → HTTP 401（runner 要求控制令牌，属正确行为）。
- model proxy：`https://192.168.5.2:8443`，证书带 IP SAN，容器侧以本地 CA 校验握手成功。

### 执行面证明

用仓库自身的 `sandboxExecutionPlaneAttestationIssues()` 对签出的证明做校验：

```
isolationTier = remote_vm
校验问题数 = 0
```

### 栈状态

`sandbox-runner / workload / broker-gateway / inngest / postgres / redis` 全部 healthy，
runner 自报 `SANDBOX_RUNNER_ACTUAL_ISOLATION_TIER=remote_vm`。

---

## 过程中发现并修复的两个仓库缺陷

1. **redis 永远起不来**（`compose.external.yml`）。redis 官方入口以 root 启动 `redis-server` 时会
   `gosu` 降权，降权重建补充组，把 `group_add` 给的 secret-reader 组丢掉，容器随后读不到 `0640`
   的 ACL 文件（`Aborting Redis startup because of ACL errors`）。
   修法：以 `user: "999:${EXTERNAL_SANDBOX_SECRET_GID}"` 启动 —— 入口看到自己非 root 就不再降权，
   既保住最小权限（仍非 root），也拿得到密钥。**已改在仓库源文件里。**

2. **loopback ingress overlay 无法生效**（未改仓库，用等效方案绕过）。
   `sandbox-runner` 只连 `external-sandbox-execution`，而该网络 `internal: true`。
   Docker 不会为纯 internal 网络上的容器创建 docker-proxy 监听，所以
   `compose.external-loopback.yml` 的端口发布**静默无效**（`PortBindings` 有值，但无监听）。
   等效方案：runner 保持 internal-only 不动，让 TLS 反代同时接入 internal 网络与一张可发布网桥 ——
   它正是 README 所说的"宿主现有的反向代理"。
   **建议的上游修法**：给 `sandbox-runner` 增加一张仅入站的非 internal 网桥，或在 README 中写明
   ingress 必须由跨网反代承担。

---

## 落地位置

| 内容 | 路径 |
|---|---|
| VM 内 env（49 变量） | VM `/secure/sandbox-external.env`（副本 `~/.agentic/sandbox-external.env`） |
| VM 内密钥（13 项，0640 / GID 1999） | VM `/secure/agentic-factory-sandbox/` |
| 签名证明 + attestor 公钥 | VM `/secure/agentic-factory-sandbox-attestations/` |
| attestor 私钥（**本机**，设计意图外） | VM `/secure/attestor/attestor-private.pem` |
| 本地 CA 与证书 | Mac `~/.agentic/sandbox-pki/` |
| 主 API 侧 env 与共享密钥 | Mac `~/.agentic/sandbox-primary/` |

---

## 主 API 接入（不需要提权）

把 `~/.agentic/sandbox-primary/primary.env` 加载进原生 api 进程即可。

`FACTORY_SB_RUNNER_URL` 用的是 `https://127.0.0.1:3570` 而不是 `sandbox.factory.internal`，
只为免去一条需要 root 的 `/etc/hosts` 记录。runner 证书**同时带 DNS 与 IP 两个 SAN**，
两种写法都通过严格校验；将来加了 hosts 记录，改这一行即可切换，不用重签。

这不削弱任何保证：防「同宿主冒充」靠的是入口脚本重算 machine-id、签名证明里的
`remote_vm` 与三个互异身份哈希、以及镜像 digest 绑定，**都与本机侧 URL 无关**；
URL 只决定把字节发到哪，而 Lima 拓扑下 Mac 确实是经回环端口转发到达 VM 的。
代价是审计可读性——只看本机侧配置的人无法从 URL 分辨它与同宿主 runner，靠本文与
`primary.env` 里的注释补齐。

### 已用主 API 自身代码验证过的部分

- `loadRemoteSandboxConnectionConfig()` 接受全套配置，且**平台证明比对面已配置**
  （未配置时 `verifySandboxExecutionPlaneReceipt` 会以 `execution_plane_attestation_unconfigured` 拒绝促升）。
- `sandboxExecutionPlaneAttestationIssues()` 对签出的证明返回 **0 问题**，`isolationTier = remote_vm`。
- node + `NODE_EXTRA_CA_CERTS` 走真实客户端路径（IP 与 SNI 两种）均通过严格 TLS 校验，
  runner 返回 401（要求控制令牌，正确行为）。

### qualification 的判定链

`qualification: "promotable"` 由 runner 内部无条件写入回执
（`sandbox-runner-executor.ts` 的 `ManifestSandboxDeployer` 选项）。
**真正的门在主 API 侧**：`sandboxExecutionReceiptIssues()` 检查回执的 `isolationTier`，
若为 `same_host_container` 即返回「sandbox isolation tier is not promotable」并拒绝。
本部署的 runner 声明 `remote_vm`，且该声明写在已验签的证明里 —— 决定 qualification 的每一环都已逐项验证。

**注意：主 API 一次只能配一个 runner**（`FACTORY_SB_RUNNER_URL` 是标量）。
加载后 API 改用外部 runner；同宿主诊断 runner（`127.0.0.1:3560`）继续运行但不再被使用。

---

## 回退

```bash
# 1) 主 API：不加载 primary.env 即回到原诊断 runner
# 2) 停外部栈（诊断栈不受影响）
colima ssh --profile agentic-sandbox -- sudo sh -c \
  'cd /opt/agentic/deploy/factory-sandbox && docker compose \
   --env-file /secure/sandbox-external.env \
   -f compose.external.yml -f compose.external-loopback.yml down'
# 3) 彻底移除 VM
colima delete --profile agentic-sandbox --force
```

同宿主诊断栈（Docker Desktop 上的 `agentic-operator-sandbox-*`）全程未被改动，
默认 docker context 也已还原为 `desktop-linux`。

---

## 这仍然没有证明什么

- **没有跑过一次真实 attempt**。证明门与 TLS 链路都已逐项验证，但端到端拿到一份
  `qualification: promotable` 的回执，需要 API 带上述 env 启动后真跑一次。
- **物理主机独立性**（见开头）。
- **独立 attestor 保管**。
- **公网可验证的 TLS**：信任根是本机生成的 CA，无证书透明度、无外部吊销。
- **平台级出站策略**：VM 之上没有独立于沙箱自身的网络策略层。
