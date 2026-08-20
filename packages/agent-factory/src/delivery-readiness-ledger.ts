/**
 * #READINESS-LEDGER — 交付就绪账本：把「还没被证明的东西」列成一份可执行的待办，
 * 而不是拿它去挡住生成。
 *
 * 产品前提（这是整个模块存在的理由）：
 * 外部平台没起、凭证只配了 dev、探针从没跑过、规则义务没有落点、人工环节永远自动化不了——
 * 这些【都不许阻塞生成】。FDE 拿到的交付里必须带一份逐条的清单：还差什么、谁能清掉它、
 * 清掉之前哪个阶段过不去、以及先做哪一条。
 *
 * 六条硬约束，每一条都对应下面一段实现：
 *
 *  1. 【全部派生，绝不手维护】。这里没有任何一处写死的阻塞项清单。每条 entry 都来自一份
 *     已经存在的分析：preflight 的 integrationBindings / analyzeToolRequirements 的逐条判定 /
 *     analyzeOntologyStructure 的 RuleAnalysis 与 gaps / reportRuleGateCoverage 的运行期覆盖 /
 *     productionIntegrationProbeIssues 的晋升门。每条 entry 都带 `source` 说明它是从哪读出来的。
 *
 *  2. 【替身通过不是证据】。`rung` 只能由 `deriveVerificationRung(evidence)` 这一个构造器产生，
 *     它读的是仓库里【已有的】词汇：`__sbDecision`（live/stub/replay/gate_*）、cassette 的
 *     `evidence.mode`（live-probe vs signed-fixture/runtime-record）、`sandboxExecutionReceipt`、
 *     `evidenceQualification.promotion`。只要 `evidence.substitute` 非空，rung 就被结构性地
 *     压到 `sandbox` 以下，永远到不了 `live`/`production`。这里做错了，这个产品就变成一台
 *     谎言生成器——所以它是本模块最重要的性质，并且由 `ledgerIntegrityIssues` 复核。
 *
 *  3. 【每条都写明谁能清掉它】。owner 有五种，各自有明确的派生依据；没有「未知负责人」这个
 *     选项——账本里出现一条没人认领的条目本身就是账本的缺陷（`ledgerIntegrityIssues` 会报）。
 *
 *  4. 【按依赖排序】。没凭证就没探针，没探针就没晋升，没选定 profile 就没探针，没 API 契约
 *     就没法造工具。边是从数据里连出来的，输出的是拓扑序而不是一袋子。
 *
 *  5. 【可延后 vs 硬阻塞】。`deferrable` 严格走 `probeDispositionOf` / `isProbeDeferrable`：
 *     服务从没应答 + 凭证已配置 → 可延后；服务应答了并拒绝 → 不可延后；没有凭证 → 没得延后。
 *     本模块不另设一套判据。
 *
 *  6. 【不发明原因，也不发明修法】。判不出来就是 `not_determinable`，并说明为什么判不出来。
 *
 * 纯函数、无 I/O、不碰模型。持久化与端口装配在 apps/api 侧。
 */

import {
  assessRisk,
  isProbeDeferrable,
  probeDeferralNotice,
  probeDispositionOf,
  type ProbeDisposition,
  type RiskFacets,
} from "@agentic/shared";

import type { OntologyStructuralAnalysis, RuleFacet } from "./ontology-analysis";
import type {
  ToolRequirementAnalysis,
  ToolRequirementRow,
} from "./ontology-tool-requirements";

export const DELIVERY_READINESS_LEDGER_SCHEMA =
  "agent-factory-delivery-readiness-ledger/v1" as const;

// ─────────────────────────────────────────────────────────────────────────────
// 词汇
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一条待办到底被验证到了哪一级。
 *
 * 刻意不叫 "passed" —— 仓库里已经有四套「通过」的说法（`__sbDecision`、cassette
 * `evidence.mode`、`sandboxExecutionReceipt`、`evidenceQualification.promotion`），
 * 再加第五套只会让替身通过混进真通过里。这里做的是把那四套【读】成一个可比较的刻度。
 */
export type VerificationRung =
  /** 判不出来。绝不读作「没问题」。 */
  | "unknown"
  /** 只有一处声明（本体 / manifest / 集成契约），没有任何一侧被检查过。 */
  | "declared"
  /** 一次只读的静态分析给出了结论（preflight / 绑定引擎 / 规则分析）。 */
  | "analyzed"
  /** 有「通过」，但通过的是替身：stub / cassette 签名夹具 / replay / 被门控 / 模拟沙箱。 */
  | "substituted"
  /** 在隔离执行平面上真跑过，但外部调用仍是回放（工厂沙箱对 external 一律 replay）。 */
  | "sandbox"
  /** 对真实系统跑通过一次 live probe。 */
  | "live"
  /** 生产门接受了它：命中当前 production profile 的未过期 live probe（含写探针证明）。 */
  | "production";

/** 由低到高。比较必须走这张表，别按字典序。 */
export const VERIFICATION_RUNG_ORDER: readonly VerificationRung[] = [
  "unknown",
  "declared",
  "analyzed",
  "substituted",
  "sandbox",
  "live",
  "production",
];

export function verificationRungRank(rung: VerificationRung): number {
  const index = VERIFICATION_RUNG_ORDER.indexOf(rung);
  // 未知取值按最低处理：不认识的等级绝不能当成更高的等级。
  return index < 0 ? 0 : index;
}

/**
 * 证据来自仓库里的哪一套既有词汇。新增一个取值意味着新增一个真实的证据来源，
 * 而不是新增一种说法。
 */
export type LedgerEvidenceBasis =
  | "none"
  /** 本体 / 集成契约里的一处声明。 */
  | "ontology_declaration"
  /** 只读分析：preflight、analyzeToolRequirements、analyzeOntologyStructure、规则门覆盖。 */
  | "static_analysis"
  /** `probeDispositionOf()` 读出来的上一次探针观测。 */
  | "probe_disposition"
  /** cassette 的 `evidence.mode`。 */
  | "cassette_evidence_mode"
  /** 运行时 `__sbDecision` / `SandboxToolDispatchReceipt.kind`。 */
  | "sb_decision"
  /** `sandboxExecutionReceipt`（隔离执行平面签名回执）。 */
  | "sandbox_execution_receipt"
  /** `evidenceQualification.promotion`。 */
  | "evidence_qualification"
  /** `productionIntegrationProbeIssues()` / 提交边界的生产探针门。 */
  | "production_probe_gate";

/** 替身的种类。取值全部来自既有词汇，不新造。 */
export type LedgerSubstituteKind =
  /** `__sbDecision === "stub"`。 */
  | "stub"
  /** `__sbDecision === "replay"` / dispatch receipt kind `replay`。 */
  | "replay"
  /** cassette `evidence.mode === "signed-fixture"`。 */
  | "cassette_signed_fixture"
  /** cassette `evidence.mode === "runtime-record"`。 */
  | "cassette_runtime_record"
  /** `__sbDecision === "gate_profile" | "gate_grant"`：调用根本没发出去。 */
  | "gated"
  /** `lastSandbox.simulated === true`：整场沙箱是模拟的。 */
  | "simulated_sandbox";

export interface LedgerEvidence {
  basis: LedgerEvidenceBasis;
  /** 从那个来源里【原样】读到的值，好让读者能自己去核对。判不出来时为 null。 */
  observed: string | null;
  /**
   * 非空即表示这次「通过」来自替身。它在结构上封死了 live/production：
   * `deriveVerificationRung` 会把等级压到 `sandbox` 以下。
   */
  substitute: { kind: LedgerSubstituteKind; detail: string } | null;
  /**
   * 凭证只留在/不在的位（与 `credentialPresence()` 同一性质）。
   * 任何情况下都不携带值、前缀或长度。
   */
  credentials?: Array<{ env: string; configured: boolean }>;
  /** 探针观测的判读，来自 `probeDispositionOf`。 */
  disposition?: ProbeDisposition;
  /** 与这条证据绑定的定义指纹（探针只为它所签的那个定义作证）。 */
  definitionHash?: string;
  /**
   * 这条证据还说不说得上话。词汇与 `ProbeVerificationIssue` 的
   * `probe_definition_drift` / `probe_expired` 一一对应，不新造。
   *
   * 一次 `verified` 探针，如果签的是【另一个】定义指纹，或者已经超出声明的新鲜度窗口，
   * 那它证明的就不是当下要发的这份东西 —— 所以它会把等级从 live 降回 analyzed。
   * 「验证过」和「验证的是这一版」是两件事。
   */
  staleness?: "current" | "definition_drift" | "expired";
}

/**
 * rung 的【唯一】构造器。
 *
 * 之所以只留一个入口：只要还存在第二条产生 rung 的路径，就一定会有人在那条路径上
 * 把一次 replay 写成 live。
 */
export function deriveVerificationRung(evidence: LedgerEvidence): VerificationRung {
  const naive = ((): VerificationRung => {
    switch (evidence.basis) {
      case "none":
        return "unknown";
      case "ontology_declaration":
        return "declared";
      case "static_analysis":
        return "analyzed";
      case "probe_disposition":
        // 只有 disposition==="verified" 才是真的对上了真实系统。
        // "never_probed" 连一次尝试都没有，退到「只有声明」。
        if (evidence.disposition === "verified") return "live";
        if (evidence.disposition === "never_probed" || !evidence.disposition) return "declared";
        return "analyzed";
      case "cassette_evidence_mode":
        return evidence.observed === "live-probe" ? "live" : "substituted";
      case "sb_decision":
        return evidence.observed === "live" || evidence.observed === "external_live"
          ? "live"
          : "substituted";
      case "sandbox_execution_receipt":
        return "sandbox";
      case "evidence_qualification":
        // `candidate` 在它自己的声明处就写明了：这只代表可以进入独立的生产门，
        // 从来不是生产集成已就绪的证明。所以它最高只到 sandbox。
        return evidence.observed === "candidate" ? "sandbox" : "analyzed";
      case "production_probe_gate":
        return evidence.observed === "clear" ? "production" : "analyzed";
    }
  })();
  // 陈旧的证据只能说明「当时对那一版是通的」，说明不了当下要发的这一版。
  // 降到 analyzed 而不是 unknown：我们确实有一次真实读数，只是它不为这一版作证。
  if (
    evidence.staleness &&
    evidence.staleness !== "current" &&
    verificationRungRank(naive) >= verificationRungRank("live")
  ) {
    return "analyzed";
  }
  if (!evidence.substitute) return naive;
  // 结构性封顶：只要有替身，等级最高就到 `substituted`。
  //
  // 封在 `substituted` 而不是 `sandbox`，是被一次实测逼出来的：一场
  // `simulated:true` 的沙箱走的是 `sandbox_execution_receipt`，naive 读数正是
  // `sandbox`；封顶如果设在 `sandbox`，模拟运行就会和一次真实的隔离平面运行
  // 落在同一格 —— 那正是这个模块要防的那种等号。
  const capped = verificationRungRank("substituted");
  return verificationRungRank(naive) > capped ? "substituted" : naive;
}

/**
 * 谁能清掉这一条。没有「未知」——账本里出现无主条目是账本自己的缺陷。
 */
export type LedgerOwner =
  /** FDE：配置、接线、以及需要人来拍板的选择。 */
  | "fde"
  /** 业务负责人：规则强制级别这种永远推不出来的政策裁决。 */
  | "business_owner"
  /** 运维 / 基础设施：把服务部起来、恢复额度、开通网络。 */
  | "operator"
  /** 外部厂商：没有权威 API 契约，谁也造不出对的工具。 */
  | "external_vendor"
  /** 平台（本工厂）：分析自己没跑成，或工具库缺一个通用能力。 */
  | "platform";

export const LEDGER_OWNERS: readonly LedgerOwner[] = [
  "fde",
  "operator",
  "external_vendor",
  "business_owner",
  "platform",
];

export type LedgerCategory =
  /** 缺凭证：能点出具体的环境变量名。 */
  | "credential"
  /**
   * 还要配置，但缺的【不是】凭证 —— 真实语料里最常见的一种是写探针安全契约未就绪
   * （canary 数据 / 幂等键 / 隔离 namespace / cleanup / 缺席回读）。
   * 与 credential 分开，是因为「去配一个 key」和「去补一套写探针生命周期」是两件事。
   */
  | "configuration"
  /** 有多个同等候选，必须由人来选。【不是】缺工具。 */
  | "choice"
  /** 需要一次对真实系统的探针。 */
  | "probe"
  /** 全库没有任何工具声明覆盖它 —— 真缺口。 */
  | "tool_gap"
  /** 外部系统没有权威 API 契约。 */
  | "api_contract"
  /** 本体声明的人工环节。既不是缺口，也不阻塞任何阶段。 */
  | "human_step"
  /** 规则义务：强制级别未声明、或阻塞级规则没有任何落点。 */
  | "rule_obligation"
  /** 运行期规则门覆盖缺口（会改状态的调用没有任何门管它）。 */
  | "rule_gate"
  /** 影响面未声明：连爆炸半径都读不出来。 */
  | "effect_declaration"
  /** 本体结构 / 字段缺陷。 */
  | "ontology_defect"
  /** 晋升证据：生产门当场要的东西。 */
  | "promotion_evidence"
  /** 判不出来。 */
  | "not_determinable";

/**
 * 这一条卡住哪个阶段。
 *
 * 【生成不在其中，而且是故意的】：本产品的核心承诺就是生成永不被挡。
 * 账本顶层的 `generationBlocked` 恒为 false 并被测试钉住。
 */
export type LedgerStage = "sandbox" | "promotion" | "production_runtime";

/** 这条 entry 是从哪份分析读出来的 —— 让每一条都可回溯、可复核。 */
export interface LedgerSource {
  /** 产出这条事实的模块。 */
  analysis:
    | "factory-domain-preflight"
    | "ontology-tool-requirements"
    | "ontology-analysis"
    | "rule-gate-coverage"
    | "risk-tier"
    | "production-integration-probe-gate"
    | "tenant-integration-contract"
    | "sandbox-evidence";
  /** 该模块里的具体字段路径，例如 `integrationBindings.groups.tool[].status`。 */
  field: string;
  /** 具体的当事人（action / requirementId / ruleId / tool 名），让结论可核查。 */
  subjects: string[];
}

export interface LedgerEntry {
  /** 稳定且派生的 id（`<category>:<subject>`），跨次运行可比对。 */
  id: string;
  title: string;
  category: LedgerCategory;
  rung: VerificationRung;
  owner: LedgerOwner;
  /** 严格是 `isProbeDeferrable` 的语义：可以当成「已记录的义务」带着走。 */
  deferrable: boolean;
  /** 卡住的阶段。空数组 = 只记录，不卡任何阶段。 */
  blocks: LedgerStage[];
  /** 前置条件的 entry id。 */
  dependsOn: string[];
  evidence: LedgerEvidence;
  /** 为什么这条重要 —— 直接引用来源的理由，不另编话术。 */
  reason: string;
  /** 下一步该做什么。判不出来时明说判不出来。 */
  nextAction: string;
  source: LedgerSource;
}

/** 一个维度到底是【查过是 0】还是【压根没查】。后者才是会骗人的那种 0。 */
export interface LedgerDimension {
  source: LedgerSource["analysis"];
  state: "checked" | "not_checked";
  /** state 为 not_checked 时说明缺的是哪一侧输入；checked 时为 null。 */
  blockedReason: string | null;
  /** 真正扫过的条数，让「0 条待办」可读。 */
  scanned: number;
  entries: number;
}

export interface DeliveryReadinessLedger {
  schema: typeof DELIVERY_READINESS_LEDGER_SCHEMA;
  scope: { tenantId?: string; tenantSlug?: string; domain: string };
  /**
   * 本产品的核心承诺，写成一个常量而不是一次判断：交付永远产出，账本只描述还差什么。
   */
  generationBlocked: false;
  counts: {
    total: number;
    hard: number;
    deferred: number;
    informational: number;
    byOwner: Record<LedgerOwner, number>;
    byStage: Record<LedgerStage, number>;
  };
  dimensions: LedgerDimension[];
  entries: LedgerEntry[];
  /** 拓扑序的 entry id：前置永远排在依赖它的条目之前。 */
  order: string[];
  /** 账本【自己】的缺陷（无主条目、rung 与替身矛盾、依赖成环……）。 */
  integrity: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 输入：每一份都是某个既有分析的结构化视图
// ─────────────────────────────────────────────────────────────────────────────

export type PreflightBindingStatusView =
  | "resolved"
  | "needs_config"
  | "needs_profile_selection"
  | "needs_probe"
  | "missing"
  | "human_boundary";

export interface PreflightBindingRowView {
  action: string;
  requirement: {
    id: string;
    system: string;
    kind: string;
    role: string;
    capability?: string;
    objectTypes: string[];
  };
  bindingKind: "tool" | "runtime" | "event";
  toolName?: string;
  status: PreflightBindingStatusView;
  missingConfigKeys: string[];
  missingCredentialEnv: string[];
  invalidConfigKeys: string[];
  selectionRequired?: boolean;
  selectionCandidates?: Array<{
    bindingKind: "tool" | "runtime";
    bindingId: string;
    toolName?: string;
    score: number;
  }>;
  profileSelection?: {
    state: "selected" | "unselected" | "ambiguous" | "unavailable";
    explicit: boolean;
    candidates: Array<{
      id: string;
      profileKey: string;
      compatible: boolean;
      ready: boolean;
      missingEnvRefs: string[];
    }>;
  };
  reason: string;
}

/** `FactoryDomainPreflightReport` 的结构化视图（apps/api/scripts/factory-domain-preflight.ts）。 */
export interface PreflightLedgerView {
  integrationBindings: {
    groups: {
      tool: readonly PreflightBindingRowView[];
      runtime: readonly PreflightBindingRowView[];
      event: readonly PreflightBindingRowView[];
    };
  };
  ontologyReadiness?: {
    ready: boolean;
    groups: {
      /** `OntologyReadinessIssue`：`code` 是稳定的机器可读标识，`message` 是散文。 */
      blocking: ReadonlyArray<PreflightReadinessIssueView>;
      warnings: ReadonlyArray<PreflightReadinessIssueView>;
    };
  };
}

export interface PreflightReadinessIssueView {
  code: string;
  message: string;
  domain?: string;
  action?: string;
  event?: string;
  object?: string;
  step?: string;
  rule?: string;
  link?: string;
  field?: string;
}

/** `reportRuleGateCoverage()` 的返回视图（packages/runtime/src/bootstrap.ts）。 */
export interface RuleGateCoverageView {
  unboundBlocking: readonly string[];
  ruleRefsWithoutTool: readonly string[];
  ungatedMutatingTools: ReadonlyArray<{
    agent: string;
    tool: string;
    tier: string;
    reason: string;
  }>;
  undeclaredEffectTools: ReadonlyArray<{ agent: string; tool: string }>;
}

/** `ProductionIntegrationProbeIssue` 的视图（apps/api/.../production-integration-probe-gate.ts）。 */
export interface ProductionProbeIssueView {
  code:
    | "tool_missing"
    | "definition_identity_missing"
    | "production_live_probe_missing"
    | "production_cassette_invalid"
    | "production_write_probe_incomplete";
  tool: string;
  specSlugs: readonly string[];
  expectedDefinitionHash?: string;
}

/** 一次探针观测。字段名与 `ToolProbeState` / `IntegrationProbeResult` 一致。 */
export interface ProbeObservationView {
  /** `IntegrationProbeResult["classification"]`，原样透传。 */
  classification?: string | null;
  status?: number | null;
  credentialConfigured?: boolean | null;
  verifiedAt?: number | null;
  /** 这次探针【当时签的】定义指纹。 */
  definitionHash?: string | null;
  /** 当下要发的这一版的定义指纹。两者都知道且不同 ⇒ 漂移。 */
  currentDefinitionHash?: string | null;
  /**
   * 回执上【声明的】证明有效期（`evidence.attestationExpiresAt`）。
   * 这是仓库自己的过期机制 —— `isSandboxReplayToolProbeReceipt` 判的就是它。
   */
  attestationExpiresAt?: string | null;
}

/**
 * 探针的新鲜度窗口。刻意【没有】默认值：一个由本模块发明的过期时间，
 * 是把政策决定伪装成默认值 —— 与 `evaluateProbeVerification` 的做法保持一致。
 * 优先用回执自己声明的 `attestationExpiresAt`；`ttlMs` 只是给没有声明的旧回执兜底，
 * 而且必须由调用方显式给出。
 */
export interface ProbeFreshnessView {
  ttlMs?: number;
  nowMs?: number;
}

/** 读出这条探针证据还说不说得上话。两侧都知道才比较，缺一侧一律读作「当下有效」。 */
export function probeStaleness(
  observation: ProbeObservationView | undefined,
  freshness: ProbeFreshnessView | undefined,
): NonNullable<LedgerEvidence["staleness"]> {
  if (!observation) return "current";
  if (
    observation.definitionHash &&
    observation.currentDefinitionHash &&
    observation.definitionHash !== observation.currentDefinitionHash
  ) {
    return "definition_drift";
  }
  const nowMs = freshness?.nowMs ?? Date.now();
  // 回执自己声明的有效期优先 —— 这是既有机制，不是本模块的政策。
  if (typeof observation.attestationExpiresAt === "string") {
    const expiresAt = Date.parse(observation.attestationExpiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return "expired";
  }
  const ttlMs = freshness?.ttlMs;
  if (
    typeof ttlMs === "number" &&
    typeof observation.verifiedAt === "number" &&
    Number.isFinite(observation.verifiedAt) &&
    nowMs - observation.verifiedAt > ttlMs
  ) {
    return "expired";
  }
  return "current";
}

/** 沙箱 / 回归证据里与「替身 vs 真身」有关的部分。 */
export interface SandboxEvidenceView {
  /** `lastSandbox.simulated`。 */
  simulated?: boolean | null;
  /** `sandboxExecutionReceipt.isolationTier`。 */
  isolationTier?: "same_host_container" | "remote_container" | "remote_vm" | null;
  /** `evidenceQualification.promotion`。 */
  promotion?: "candidate" | "blocked" | null;
  promotionBlockers?: ReadonlyArray<{ code: string; detail: string }>;
  /** `cassetteRefs[]`：每个外部工具这次用的是哪种证据。 */
  cassettes?: ReadonlyArray<{
    tool: string;
    evidenceMode?: "live-probe" | "signed-fixture" | "runtime-record";
    definitionHash?: string;
    specSlugs?: readonly string[];
  }>;
  /** `SandboxToolDispatchReceipt[]` / `__sbDecision` 的落地形态。 */
  dispatches?: ReadonlyArray<{
    tool: string;
    kind: "replay" | "replay_miss" | "sandbox_local" | "external_live";
  }>;
}

/** 每个工具声明的影响面（来自真实工具目录 / spec 的 `toolPolicies`）。 */
export interface ToolEffectFacetsView extends RiskFacets {
  tool: string;
  /** 哪些 agent/spec 选了它。 */
  usedBy?: readonly string[];
  /** 这个工具声明它需要的凭证环境变量名。 */
  credentialEnv?: readonly string[];
}

/** `legacyEnvAlternatives`：一次显式的 FDE 选择，永远不是自动迁移。 */
export interface LegacyEnvChoiceView {
  preferredEnv: string;
  alternatives: readonly string[];
  migrationNote: string;
  system?: string;
  profileId?: string;
}

/**
 * 租户集成契约里的一份 profile（如 `AGENTS_GENERATION_INTEGRATION_PROFILES` 的一项）。
 *
 * 这是全仓库唯一一处把「哪个工具属于哪个外部系统、要哪些环境引用、拿哪个工具去探针、
 * 哪些字段只能由人确认」写在一起的声明。工具注册表本身今天一个 `credentialEnv` 都没声明，
 * 所以「没凭证就没探针」这条依赖边只能从这里连出来 —— 靠猜是连不出来的。
 */
export interface IntegrationProfileContractView {
  id: string;
  systemName: string;
  toolNames: readonly string[];
  requiredEnv: readonly string[];
  optionalEnv?: readonly string[];
  /** 该 profile 声明用哪个工具做探针；null 表示没有可探的入口。 */
  probeTool: string | null;
  /** 从 env 文档和本体散文里都推不出来、必须由人确认的字段。 */
  requiredHumanFields?: readonly string[];
  legacyEnvAlternatives?: readonly LegacyEnvChoiceView[];
  fdeSummary?: string;
}

/** 本体点了名、但没有权威 API 契约的外部系统。 */
export interface UnresolvedExternalSystemView {
  systemName: string;
  action?: string;
  capability?: string;
  disposition: string;
  fdeSummary: string;
}

export interface DeliveryReadinessLedgerInput {
  scope: { tenantId?: string; tenantSlug?: string; domain: string };
  preflight?: PreflightLedgerView;
  toolRequirements?: ToolRequirementAnalysis;
  ontologyAnalysis?: OntologyStructuralAnalysis;
  ruleGateCoverage?: RuleGateCoverageView;
  promotionGate?: { issues: readonly ProductionProbeIssueView[] };
  sandboxEvidence?: SandboxEvidenceView;
  /** 工具名 → 上一次探针观测。 */
  probes?: Readonly<Record<string, ProbeObservationView>>;
  /** 声明的探针新鲜度窗口。不给就不判过期 —— 本模块不发明一个默认过期时间。 */
  probeFreshness?: ProbeFreshnessView;
  /** 工具影响面。用于 `assessRisk`：说明「为什么这条重要」。 */
  toolEffects?: readonly ToolEffectFacetsView[];
  /**
   * 只留在/不在的位（`credentialPresence()` 的输出形状：值为 "configured" 或 undefined）。
   * 绝不携带真实值。
   */
  envPresence?: Readonly<Record<string, string | undefined>>;
  legacyEnvChoices?: readonly LegacyEnvChoiceView[];
  unresolvedExternalSystems?: readonly UnresolvedExternalSystemView[];
  integrationProfileContracts?: readonly IntegrationProfileContractView[];
}

/** 工具名 → 该工具所属 profile 声明的环境引用 / 人工字段。纯查表，不推断。 */
interface ContractIndex {
  envByTool: Map<string, string[]>;
  humanFieldsByTool: Map<string, { profileId: string; fields: string[] }>;
  systemByTool: Map<string, string>;
}

function indexContracts(
  contracts: readonly IntegrationProfileContractView[] | undefined,
): ContractIndex {
  const envByTool = new Map<string, string[]>();
  const humanFieldsByTool = new Map<string, { profileId: string; fields: string[] }>();
  const systemByTool = new Map<string, string>();
  for (const contract of contracts ?? []) {
    for (const tool of contract.toolNames) {
      envByTool.set(tool, [
        ...new Set([...(envByTool.get(tool) ?? []), ...contract.requiredEnv]),
      ]);
      systemByTool.set(tool, contract.systemName);
      if (contract.requiredHumanFields?.length) {
        humanFieldsByTool.set(tool, {
          profileId: contract.id,
          fields: [...contract.requiredHumanFields],
        });
      }
    }
  }
  return { envByTool, humanFieldsByTool, systemByTool };
}

// ─────────────────────────────────────────────────────────────────────────────
// 派生
// ─────────────────────────────────────────────────────────────────────────────

const idSafe = (value: string): string =>
  value.trim().replace(/\s+/g, "_").replace(/[^\w.@/:*-]/g, "-").slice(0, 120) || "unknown";

function credentialBits(
  envNames: readonly string[],
  envPresence: Readonly<Record<string, string | undefined>> | undefined,
): Array<{ env: string; configured: boolean }> {
  return [...new Set(envNames)].sort().map((env) => ({
    env,
    // 未提供 envPresence 时不假设已配置：缺信息按「没配」读，才不会把未验证说成已就绪。
    configured: typeof envPresence?.[env] === "string" && envPresence[env]!.trim() !== "",
  }));
}

function allConfigured(bits: ReadonlyArray<{ configured: boolean }>): boolean {
  return bits.length > 0 && bits.every((bit) => bit.configured);
}

/** 一份 preflight 报告里的全部绑定行，展平。 */
function preflightRows(view: PreflightLedgerView): PreflightBindingRowView[] {
  return [
    ...view.integrationBindings.groups.tool,
    ...view.integrationBindings.groups.runtime,
    ...view.integrationBindings.groups.event,
  ];
}

/**
 * 一行绑定属于哪一类。
 *
 * 顺序是【故意的】，且与 `ontology-tool-requirements.ts` 的 `bindingVerdict` 一致：
 * `selectionRequired` 必须在 `status` 之前判。绑定引擎在同分多选时写的是
 * `status:"missing" + selectionRequired:true`——照 status 读会把「有两个都能用、
 * 需要你选一个」报成「一个工具都没有」，这是两件完全不同的事，也是两种完全不同的下一步。
 */
function classifyBinding(row: PreflightBindingRowView): LedgerCategory {
  if (row.selectionRequired === true) return "choice";
  switch (row.status) {
    case "needs_profile_selection":
      return "choice";
    case "needs_config":
      // 能点出环境变量名才叫「缺凭证」；点不出来就只说「还要配置」，
      // 缺什么由 preflight 的 reason 原样转述，不替它编一个。
      return row.missingCredentialEnv.length ? "credential" : "configuration";
    case "needs_probe":
      return "probe";
    case "missing":
      return "tool_gap";
    case "human_boundary":
      return "human_step";
    case "resolved":
      return "not_determinable"; // 不会被收进账本
  }
}

interface EntryDraft extends Omit<LedgerEntry, "rung"> {
  rung?: VerificationRung;
}

function entry(draft: EntryDraft): LedgerEntry {
  return { ...draft, rung: deriveVerificationRung(draft.evidence) };
}

/** 为什么这条重要：能读出影响面就用 `assessRisk` 的原话，读不出就明说读不出。 */
function riskReason(
  facets: ToolEffectFacetsView | undefined,
): { reason: string; controls: string[]; undetermined: boolean } {
  if (!facets) {
    return {
      reason: "当前没有拿到这个调用的影响面声明，无法说明它需要哪些管控",
      controls: [],
      undetermined: true,
    };
  }
  const assessment = assessRisk(facets);
  return {
    reason: `${assessment.tier} · ${assessment.reason} · 需要的管控：${assessment.controls.join("、")}`,
    controls: assessment.controls,
    undetermined: assessment.undetermined,
  };
}

// ── 维度 1：preflight 的集成绑定 ────────────────────────────────────────────

interface IntegrationCollection {
  entries: LedgerEntry[];
  scanned: number;
  /** requirementId → 已经为它建好的 entry id。跨维度合并要用它，避免同一条需求被两份分析各报一次。 */
  entryByRequirement: Map<string, string>;
  /** 工具名 → 探针待办 id。连依赖边时按名字精确对上，不做模糊匹配。 */
  probeEntryByTool: Map<string, string>;
  /** 工具名 → 「这个工具的 integration profile 还没选定」待办 id。 */
  profileChoiceByTool: Map<string, string>;
  /** 工具名 → 「这个工具还要配置」待办 id（写探针安全契约等）。 */
  configEntryByTool: Map<string, string>;
}

function collectIntegrationEntries(
  input: DeliveryReadinessLedgerInput,
  contracts: ContractIndex,
): IntegrationCollection {
  const entryByRequirement = new Map<string, string>();
  const probeEntryByTool = new Map<string, string>();
  const profileChoiceByTool = new Map<string, string>();
  const configEntryByTool = new Map<string, string>();
  const empty = { entryByRequirement, probeEntryByTool, profileChoiceByTool, configEntryByTool };
  const view = input.preflight;
  if (!view) return { entries: [], scanned: 0, ...empty };
  const rows = preflightRows(view);
  const effectsByTool = new Map(
    (input.toolEffects ?? []).map((facets) => [facets.tool, facets] as const),
  );
  const unresolvedSystems = new Map(
    (input.unresolvedExternalSystems ?? []).map((system) => [system.systemName, system] as const),
  );

  // 同一个凭证 / 同一个工具会在多条 action 上重复出现。合并成一条待办，
  // 把当事人放进 subjects —— FDE 要做的是【一件事】，不是十九件。
  const grouped = new Map<string, {
    category: LedgerCategory;
    rows: PreflightBindingRowView[];
    key: string;
  }>();

  for (const row of rows) {
    if (row.status === "resolved") continue;
    const category = classifyBinding(row);
    const key = ((): string => {
      switch (category) {
        case "credential":
          // 以「缺哪些 env」聚合：那才是要做的那一件事。
          return `credential:${idSafe([...row.missingCredentialEnv].sort().join("+"))}`;
        case "configuration":
          return `configuration:${idSafe(
            [...row.missingConfigKeys].sort().join("+") || row.toolName || row.requirement.system,
          )}`;
        case "choice":
          return `choice:${idSafe(row.requirement.id)}`;
        case "probe":
          return `probe:${idSafe(row.toolName ?? row.requirement.system)}`;
        case "tool_gap":
          return `tool-gap:${idSafe(`${row.requirement.system}/${row.requirement.kind}/${row.requirement.role}`)}`;
        case "human_step":
          return `human-step:${idSafe(`${row.requirement.system}/${row.requirement.role}`)}`;
        default:
          return `not-determinable:${idSafe(row.requirement.id)}`;
      }
    })();
    const bucket = grouped.get(key) ?? { category, rows: [], key };
    bucket.rows.push(row);
    grouped.set(key, bucket);
  }

  const entries: LedgerEntry[] = [];

  // 本体就绪度的【阻塞级】问题：preflight 自己就把它列成 blockedReasons 的第一项。
  // 按稳定的 `code` 聚合，当事人放进 subjects —— 散文 message 不作为归并键。
  const readinessByCode = new Map<string, PreflightReadinessIssueView[]>();
  for (const issue of view.ontologyReadiness?.groups.blocking ?? []) {
    const bucket = readinessByCode.get(issue.code) ?? [];
    bucket.push(issue);
    readinessByCode.set(issue.code, bucket);
  }
  for (const [code, issues] of [...readinessByCode].sort(([a], [b]) => a.localeCompare(b))) {
    const subjects = [
      ...new Set(
        issues.flatMap((issue) =>
          [issue.action, issue.event, issue.object, issue.step, issue.rule, issue.link, issue.field]
            .filter((value): value is string => Boolean(value)),
        ),
      ),
    ].sort();
    entries.push(entry({
      id: `ontology-defect:readiness/${idSafe(code)}`,
      title: `本体就绪度阻塞：${code}（${issues.length} 处）`,
      category: "ontology_defect",
      owner: "business_owner",
      deferrable: false,
      // 本体读不通，沙箱里跑出来的东西也就没有意义。
      blocks: ["sandbox", "promotion"],
      dependsOn: [],
      evidence: { basis: "static_analysis", observed: code, substitute: null },
      reason: issues[0]!.message,
      nextAction: "由本体作者修正这些声明后重跑 preflight；这里只报 preflight 判为阻塞级的问题",
      source: {
        analysis: "factory-domain-preflight",
        field: "ontologyReadiness.groups.blocking[].code",
        subjects: subjects.length ? subjects.slice(0, 200) : [code],
      },
    }));
  }

  for (const bucket of grouped.values()) {
    const head = bucket.rows[0]!;
    const subjects = [
      ...new Set(bucket.rows.map((row) => `${row.action}/${row.requirement.id}`)),
    ].sort();
    const source: LedgerSource = {
      analysis: "factory-domain-preflight",
      field: "integrationBindings.groups[].status",
      subjects,
    };
    const toolName = head.toolName;
    const facets = toolName ? effectsByTool.get(toolName) : undefined;
    const risk = riskReason(facets);

    if (bucket.category === "credential" || bucket.category === "configuration") {
      const envNames = [
        ...new Set(bucket.rows.flatMap((row) => row.missingCredentialEnv)),
      ].sort();
      const configKeys = [
        ...new Set(bucket.rows.flatMap((row) => row.missingConfigKeys)),
      ].sort();
      const bits = credentialBits(envNames, input.envPresence);
      entries.push(entry({
        id: bucket.key,
        title: envNames.length
          ? `配置凭证：${envNames.join("、")}`
          : configKeys.length
            ? `补齐工具配置：${configKeys.join("、")}`
            : `补齐 ${toolName ?? head.requirement.system} 的工具配置`,
        category: bucket.category,
        owner: "fde",
        // 没有凭证就没得延后 —— `isProbeDeferrable` 在 credentialConfigured=false 时恒 false。
        deferrable: false,
        blocks: ["promotion", "production_runtime"],
        dependsOn: [],
        evidence: {
          basis: "static_analysis",
          observed: head.status,
          substitute: null,
          ...(bits.length ? { credentials: bits } : {}),
        },
        reason: `${head.reason}${risk.undetermined ? "" : `；${risk.reason}`}`,
        nextAction: envNames.length
          ? `由 FDE 在服务端配置 ${envNames.join("、")}（只记在/不在，值不入账本）后重跑 preflight`
          : configKeys.length
            ? `由 FDE 在 manifest tool_use[].config 或 Integration Profile 里补齐 ${configKeys.join("、")}`
            // 缺什么由 preflight 自己说 —— 不替它编一个修法。
            : `由 FDE 按 preflight 给出的理由补齐配置：${head.reason}`,
        source,
      }));
      for (const row of bucket.rows) entryByRequirement.set(row.requirement.id, bucket.key);
      if (bucket.category === "configuration" && toolName) configEntryByTool.set(toolName, bucket.key);
      continue;
    }

    if (bucket.category === "choice") {
      const profileState = head.profileSelection?.state;
      const candidates = [
        ...new Set([
          ...bucket.rows.flatMap((row) =>
            (row.selectionCandidates ?? []).map((candidate) => candidate.toolName ?? candidate.bindingId)),
          ...bucket.rows.flatMap((row) =>
            (row.profileSelection?.candidates ?? []).map((candidate) => candidate.profileKey)),
        ]),
      ].sort();
      const isProfile = head.selectionRequired !== true && head.status === "needs_profile_selection";
      entries.push(entry({
        id: bucket.key,
        title: isProfile
          ? `选定 integration profile：${head.toolName ?? head.requirement.system}`
          : `在同等候选之间做出选择：${head.requirement.system}/${head.requirement.kind}/${head.requirement.role}`,
        category: "choice",
        owner: "fde",
        deferrable: false,
        // 没选定就没有可派发的执行面，沙箱同样跑不了。
        blocks: ["sandbox", "promotion"],
        dependsOn: [],
        evidence: {
          basis: "static_analysis",
          // 原样保留 preflight 的 status —— 这里正是 `missing` 会骗人的地方，
          // 所以把它摆出来，同时用 category 说清它其实是一次选择。
          observed: `${head.status}${head.selectionRequired ? "+selectionRequired" : ""}${profileState ? `+profile:${profileState}` : ""}`,
          substitute: null,
        },
        reason: `${head.reason}。这【不是】缺工具：候选已经存在且同分，替 FDE 挑一个可能选中的是另一套系统。`,
        nextAction: candidates.length
          ? `由 FDE 明确选择其一：${candidates.join("、")}（或把本体的 integration 坐标写得更具体，让匹配唯一）`
          : "由 FDE 明确选择绑定，或把本体的 integration 坐标写得更具体",
        source: { ...source, field: "integrationBindings.groups[].selectionRequired / profileSelection.state" },
      }));
      for (const row of bucket.rows) entryByRequirement.set(row.requirement.id, bucket.key);
      if (isProfile && toolName) profileChoiceByTool.set(toolName, bucket.key);
      continue;
    }

    if (bucket.category === "probe") {
      const observation = toolName ? input.probes?.[toolName] : undefined;
      const disposition = probeDispositionOf({
        classification: observation?.classification ?? null,
        status: observation?.status ?? null,
      });
      const declaredEnv = [
        ...new Set([
          ...(facets?.credentialEnv ?? []),
          // 工具注册表今天一个 credentialEnv 都没声明；租户集成契约是唯一说得出
          // 「这个工具要哪几个环境引用」的地方，所以「没凭证就没探针」这条边靠它连。
          ...(toolName ? contracts.envByTool.get(toolName) ?? [] : []),
          ...bucket.rows.flatMap((row) => row.missingCredentialEnv),
        ]),
      ];
      const bits = credentialBits(declaredEnv, input.envPresence);
      // 凭证是否配置：优先信探针自己记下的那一位，其次看 env 存在位。
      const credentialConfigured =
        observation?.credentialConfigured === true ||
        (observation?.credentialConfigured !== false && allConfigured(bits));
      const deferrable = isProbeDeferrable(disposition, {
        credentialConfigured,
        production: false,
      });
      const notice = probeDeferralNotice({
        toolName: toolName ?? head.requirement.system,
        disposition,
        attemptedAt: observation?.verifiedAt ?? null,
        system: head.requirement.system,
      });
      const owner: LedgerOwner =
        disposition === "service_unreachable"
          ? "operator" // 服务没应答，凭证在手也做不了什么 —— 得有人把它部起来。
          : disposition === "authorization_required"
            ? "business_owner"
            : "fde";
      const staleness = probeStaleness(observation, input.probeFreshness);
      entries.push(entry({
        id: bucket.key,
        title: `对真实系统跑一次探针：${toolName ?? head.requirement.system}`,
        category: "probe",
        owner,
        deferrable,
        blocks: ["promotion", "production_runtime"],
        dependsOn: [],
        evidence: {
          basis: "probe_disposition",
          observed: observation?.classification ?? null,
          substitute: null,
          disposition,
          staleness,
          credentials: bits,
          ...(observation?.definitionHash ? { definitionHash: observation.definitionHash } : {}),
        },
        reason: [
          head.reason,
          risk.undetermined ? null : risk.reason,
          disposition === "never_probed"
            ? "这个集成从来没有被探测过——「没探过」不等于「探过没问题」。"
            : null,
          staleness === "definition_drift"
            ? "上一次探针签的是另一个定义指纹：它证明的不是当下要发的这一版。"
            : staleness === "expired"
              ? "上一次探针已经超出声明的新鲜度窗口。"
              : null,
        ].filter(Boolean).join("；"),
        nextAction: deferrable
          ? (notice ?? "凭证已配置但服务没有应答；作为已记录的义务带着走，晋升前必须补一次真实 live probe")
          : disposition === "credential_missing"
            ? "先配置凭证，然后才谈得上探针"
            : disposition === "rejected"
              ? "服务应答并拒绝了：核对凭证、base 路径与请求形状（一次 404 是接线缺陷，不是服务没起）"
              : `由 ${owner === "operator" ? "运维把服务部起来后" : "FDE"} 对 ${toolName ?? head.requirement.system} 跑一次真实探针并留下回执`,
        source: { ...source, field: "integrationBindings.groups[].status=needs_probe + probeDispositionOf()" },
      }));
      for (const row of bucket.rows) entryByRequirement.set(row.requirement.id, bucket.key);
      if (toolName) probeEntryByTool.set(toolName, bucket.key);
      continue;
    }

    if (bucket.category === "tool_gap") {
      const unresolved = unresolvedSystems.get(head.requirement.system);
      if (unresolved) {
        entries.push(entry({
          id: `api-contract:${idSafe(head.requirement.system)}`,
          title: `取得 ${head.requirement.system} 的权威 API 契约`,
          category: "api_contract",
          owner: "external_vendor",
          deferrable: false,
          blocks: ["sandbox", "promotion"],
          dependsOn: [],
          evidence: {
            basis: "ontology_declaration",
            observed: unresolved.disposition,
            substitute: null,
          },
          reason: `${unresolved.fdeSummary.replace(/[。.\s]+$/, "")}。通用 HTTP 工具不能假装实现这个业务系统。`,
          nextAction:
            "向外部厂商索取权威 API schema / Integration Profile；在拿到之前，只能由业务方确认改走人工边界",
          source: {
            analysis: "tenant-integration-contract",
            field: "UNRESOLVED_EXTERNAL_SYSTEMS[]",
            subjects: [unresolved.systemName, ...(unresolved.action ? [unresolved.action] : [])],
          },
        }));
        for (const row of bucket.rows) {
          entryByRequirement.set(row.requirement.id, `api-contract:${idSafe(head.requirement.system)}`);
        }
        continue;
      }
      entries.push(entry({
        id: bucket.key,
        title: `补一个覆盖 ${head.requirement.system}/${head.requirement.kind}/${head.requirement.role} 的工具`,
        category: "tool_gap",
        owner: "fde",
        deferrable: false,
        blocks: ["sandbox", "promotion"],
        dependsOn: [],
        evidence: {
          basis: "static_analysis",
          observed: head.status,
          substitute: null,
        },
        reason: head.reason,
        nextAction:
          "在 packages/tools 里实现并注册一个显式声明该 capability 的工具，或由业务方确认这是人工边界",
        source,
      }));
      for (const row of bucket.rows) entryByRequirement.set(row.requirement.id, bucket.key);
      continue;
    }

    if (bucket.category === "human_step") {
      entries.push(entry({
        id: bucket.key,
        title: `人工边界：${head.requirement.system}/${head.requirement.role}`,
        category: "human_step",
        owner: "business_owner",
        deferrable: false,
        blocks: [], // 只记录：既不是缺口，也不卡任何阶段。
        dependsOn: [],
        evidence: {
          basis: "ontology_declaration",
          observed: head.status,
          substitute: null,
        },
        reason: head.reason,
        nextAction: "确认这一环的人工作业手册存在且有人负责；本条不阻塞任何阶段",
        source,
      }));
      for (const row of bucket.rows) entryByRequirement.set(row.requirement.id, bucket.key);
      continue;
    }
  }
  return {
    entries,
    scanned: rows.length,
    entryByRequirement,
    probeEntryByTool,
    profileChoiceByTool,
    configEntryByTool,
  };
}

// ── 维度 2：analyzeToolRequirements ─────────────────────────────────────────

function collectToolRequirementEntries(
  input: DeliveryReadinessLedgerInput,
  integration: IntegrationCollection,
): { entries: LedgerEntry[]; scanned: number } {
  const analysis = input.toolRequirements;
  if (!analysis) return { entries: [], scanned: 0 };
  const entries: LedgerEntry[] = [];
  const existingById = new Map(integration.entries.map((row) => [row.id, row] as const));

  const group = (
    predicate: (row: ToolRequirementRow) => boolean,
    keyOf: (row: ToolRequirementRow) => string,
  ): Map<string, ToolRequirementRow[]> => {
    const map = new Map<string, ToolRequirementRow[]>();
    for (const row of analysis.rows.filter(predicate)) {
      const key = keyOf(row);
      (map.get(key) ?? map.set(key, []).get(key)!).push(row);
    }
    return map;
  };

  // 本体声明的人工环节：显式保留，绝不并进缺口。
  for (const [key, rows] of group(
    (row) => row.verdict === "human_step",
    (row) => `human-step:${idSafe(`${row.system}/${row.role}`)}`,
  )) {
    const head = rows[0]!;
    entries.push(entry({
      id: key,
      title: `人工环节（本体声明）：${head.system}/${head.role}`,
      category: "human_step",
      owner: "business_owner",
      deferrable: false,
      blocks: [],
      dependsOn: [],
      evidence: { basis: "ontology_declaration", observed: "human_ui", substitute: null },
      reason: head.reason,
      nextAction: "确认人工作业手册与负责人；这不是缺工具，不需要补任何工具",
      source: {
        analysis: "ontology-tool-requirements",
        field: "rows[].verdict=human_step",
        subjects: [...new Set(rows.map((row) => `${row.actionName}/${row.requirementId}`))].sort(),
      },
    }));
  }

  // 匹配没跑成 ≠ 库里没有。这是平台侧的缺陷，不是让 FDE 去建工具的信号。
  for (const [key, rows] of group(
    (row) => row.verdict === "unknown",
    (row) => `not-determinable:${idSafe(row.actionName)}`,
  )) {
    const head = rows[0]!;
    entries.push(entry({
      id: key,
      title: `判不出来：${head.actionName} 的集成需求没有完成匹配`,
      category: "not_determinable",
      owner: "platform",
      deferrable: false,
      blocks: ["promotion"],
      dependsOn: [],
      evidence: { basis: "none", observed: null, substitute: null },
      reason: `${head.reason}。「我们没判成」和「库里没有」是两件事，不能并成缺口。`,
      nextAction: "由平台侧排查能力匹配引擎为何拒绝这个 Action；在判出来之前不要据此新建工具",
      source: {
        analysis: "ontology-tool-requirements",
        field: "rows[].verdict=unknown",
        subjects: [...new Set(rows.map((row) => `${row.actionName}/${row.requirementId}`))].sort(),
      },
    }));
  }

  // 同分多选 —— 这是【要人来选】，不是【缺工具】。
  //
  // 两份分析看的是两个问题，都成立：preflight 带着本体的 `tool_use[]` 约束跑，约束把候选
  // 全排除掉时它写 `missing`；analyzeToolRequirements 不带约束跑，答的是「库里有没有」，
  // 于是它看到两个同分候选写 `ambiguous`。把这两句话合成一条待办才是 FDE 能行动的形态：
  // 候选是存在的，被本体的绑定约束挡在外面 —— 该做的是【选一个 / 把坐标写具体】，
  // 而不是去新建一个工具。所以这里【改判】而不是再报一条。
  const reclassified = new Set<string>();
  for (const row of analysis.rows.filter((candidate) => candidate.verdict === "ambiguous")) {
    const existingId = integration.entryByRequirement.get(row.requirementId);
    const existing = existingId ? existingById.get(existingId) : undefined;
    const citation = `ontology-tool-requirements 在不带 tool_use 约束时读到 ${row.tools.length} 个同分候选：${row.tools.join(" | ")}`;
    // 【只】改判 preflight 报成「缺工具」的那一条。
    // preflight 报 needs_config / needs_probe 时，本体的 tool_use 已经把工具选定了 ——
    // 那时的待办是「去配 / 去探」，把它改判成「去选」会把一条已经定了的绑定重新打开。
    if (existing && (existing.category === "tool_gap" || reclassified.has(existing.id))) {
      if (!reclassified.has(existing.id)) {
        existing.id = `choice:${existing.id.slice("tool-gap:".length)}`;
        existing.category = "choice";
        existing.owner = "fde";
        existing.blocks = ["sandbox", "promotion"];
        existing.reason = `${existing.reason}。但这【不是】缺工具：${citation}——替 FDE 挑一个，可能挑中的是另一套系统。`;
        reclassified.add(existing.id);
        existingById.set(existing.id, existing);
        for (const [requirementId, id] of [...integration.entryByRequirement]) {
          if (id === existingId) integration.entryByRequirement.set(requirementId, existing.id);
        }
      }
      existing.nextAction = `由 FDE 明确选择其一：${row.tools.join("、")}（或把本体的 integration 坐标写得更具体，让匹配唯一）`;
      existing.source.subjects = [
        ...new Set([...existing.source.subjects, `${row.actionName}/${row.requirementId}`]),
      ].sort();
      continue;
    }
    if (existing) {
      // preflight 已经有一条待办，而且它不是「缺工具」—— 说明本体的 tool_use 已经在这些
      // 同分候选里指定了一个。没有待决的选择，但也不能就此静默丢掉这条读数：
      // 把它记在已有待办的理由里，读者才知道这里曾经有过分歧、以及谁把它定下来的。
      if (!existing.reason.includes(citation)) {
        existing.reason = `${existing.reason}。（${citation}；本体的 tool_use 已在其中指定，故此处没有待决选择）`;
        existing.source.subjects = [
          ...new Set([...existing.source.subjects, `${row.actionName}/${row.requirementId}`]),
        ].sort();
      }
      continue;
    }
    entries.push(entry({
      id: `choice:${idSafe(row.requirementId)}`,
      title: `在同等候选之间做出选择：${row.system}/${row.kind}/${row.role}`,
      category: "choice",
      owner: "fde",
      deferrable: false,
      blocks: ["sandbox", "promotion"],
      dependsOn: [],
      evidence: { basis: "static_analysis", observed: "ambiguous", substitute: null },
      reason: `${row.reason}。${citation}`,
      nextAction: `由 FDE 明确选择其一：${row.tools.join("、")}（或把本体的 integration 坐标写得更具体，让匹配唯一）`,
      source: {
        analysis: "ontology-tool-requirements",
        field: "rows[].verdict=ambiguous",
        subjects: [`${row.actionName}/${row.requirementId}`],
      },
    }));
  }

  return { entries, scanned: analysis.total };
}

// ── 维度 3：analyzeOntologyStructure 的规则与结构缺陷 ────────────────────────

function ruleUndeclared(rule: RuleFacet): boolean {
  return rule.enforcementLevel === null && rule.failurePolicy === null;
}

function collectOntologyEntries(
  input: DeliveryReadinessLedgerInput,
): { entries: LedgerEntry[]; scanned: number } {
  const analysis = input.ontologyAnalysis;
  if (!analysis) return { entries: [], scanned: 0 };
  const entries: LedgerEntry[] = [];
  const rules = analysis.rules;

  // 强制级别未声明 —— 这一条永远推不出来，只能由业务方裁决。
  const undeclared = rules.rules.filter(ruleUndeclared);
  if (undeclared.length) {
    entries.push(entry({
      id: "rule-enforcement:undeclared",
      title: `裁定 ${undeclared.length} 条规则的强制级别`,
      category: "rule_obligation",
      owner: "business_owner",
      deferrable: false,
      blocks: ["promotion"],
      dependsOn: [],
      evidence: { basis: "static_analysis", observed: "undeclared", substitute: null },
      reason:
        "本体既没有声明 enforcementLevel 也没有声明 failurePolicy。兜底成 warn 会把一条本该拦住流程的政策悄悄降级——这是业务裁决，任何推断都是错的。",
      nextAction: "由业务负责人为每条规则明确 block / warn；在本体里补上后重跑分析",
      source: {
        analysis: "ontology-analysis",
        field: "rules.rules[].enforcementLevel=null && failurePolicy=null",
        subjects: undeclared.map((rule) => rule.id || rule.name).sort().slice(0, 200),
      },
    }));
  }

  // 阻塞级规则一条动作都走不到：生成器根本看不见它。
  const unreachableBlocking = rules.rules.filter(
    (rule) => rule.failurePolicy === "block" && rule.referencedByActions.length === 0,
  );
  if (unreachableBlocking.length) {
    entries.push(entry({
      id: "rule-obligation:unreferenced-blocking",
      title: `${unreachableBlocking.length} 条阻塞级规则没有任何动作引用它`,
      category: "rule_obligation",
      owner: "business_owner",
      deferrable: false,
      blocks: ["promotion", "production_runtime"],
      dependsOn: ["rule-enforcement:undeclared"],
      evidence: { basis: "static_analysis", observed: "block", substitute: null },
      reason:
        "规则能拦住流程，但没有任何 action_steps[].rules[] 指向它，于是没有任何一次派发会去咨询它——义务存在，落点不存在。",
      nextAction:
        "由业务负责人在本体里把这些规则接到具体的动作步骤上，或明确它们不适用于本域",
      source: {
        analysis: "ontology-analysis",
        field: "rules.rules[].failurePolicy=block && referencedByActions=[]",
        subjects: unreachableBlocking.map((rule) => rule.id || rule.name).sort().slice(0, 200),
      },
    }));
  }

  // 同一动作挂着分属不同客户的规则：照单生成会把 A 的政策套到 B 身上。
  if (rules.crossClientActions.length) {
    entries.push(entry({
      id: "rule-obligation:cross-client",
      title: `${rules.crossClientActions.length} 个动作同时挂着不同客户的规则`,
      category: "rule_obligation",
      owner: "business_owner",
      deferrable: false,
      blocks: ["promotion", "production_runtime"],
      dependsOn: [],
      evidence: { basis: "static_analysis", observed: "cross_client", substitute: null },
      reason:
        "同一个动作上存在分属不同客户的互斥规则。照单生成会把某个客户的政策套到另一个客户身上——这是业务裁决，不能由代码选边。",
      nextAction: "由业务负责人明确每个动作在每个客户下适用哪一套规则",
      source: {
        analysis: "ontology-analysis",
        field: "rules.crossClientActions[]",
        subjects: rules.crossClientActions.map((row) => row.action).sort(),
      },
    }));
  }

  // 结构 / 字段缺陷：本体作者的活。
  for (const gap of analysis.gaps) {
    if (gap.kind === "rules_without_enforcement" || gap.kind === "rules_without_actions") continue; // 上面已单列
    entries.push(entry({
      id: `ontology-defect:${idSafe(gap.kind)}`,
      title: `本体缺陷：${gap.kind}`,
      category: "ontology_defect",
      owner: gap.kind === "agents_inconsistent_with_ontology" ? "fde" : "business_owner",
      deferrable: false,
      blocks: gap.kind === "object_field_defects" ? ["promotion"] : ["promotion"],
      dependsOn: [],
      evidence: { basis: "static_analysis", observed: gap.kind, substitute: null },
      reason: gap.detail,
      nextAction:
        gap.kind === "agents_inconsistent_with_ontology"
          ? "由 FDE 让已生成 agent 与当前本体对齐（工具 / 动作 / 事件三处声明）"
          : "由本体作者修正声明；这里只报实测到的缺陷，不做任何命名约定推断",
      source: {
        analysis: "ontology-analysis",
        field: "gaps[].kind",
        // 有些缺口是【整个域】层面的事实（例如根本没有关系图），它本来就没有逐个当事人。
        // 那就把域本身写成当事人 —— 空 subjects 会让这条待办无从核查。
        subjects: gap.subjects.length ? gap.subjects.slice(0, 200) : [analysis.domainId],
      },
    }));
  }

  return {
    entries,
    scanned: rules.total + analysis.gaps.length + analysis.objectFields.objects,
  };
}

// ── 维度 4：运行期规则门覆盖 ────────────────────────────────────────────────

function collectRuleGateEntries(
  input: DeliveryReadinessLedgerInput,
): { entries: LedgerEntry[]; scanned: number } {
  const coverage = input.ruleGateCoverage;
  if (!coverage) return { entries: [], scanned: 0 };
  const entries: LedgerEntry[] = [];
  const effectsByTool = new Map(
    (input.toolEffects ?? []).map((facets) => [facets.tool, facets] as const),
  );

  if (coverage.unboundBlocking.length) {
    entries.push(entry({
      id: "rule-gate:unbound-blocking",
      title: `${coverage.unboundBlocking.length} 条阻塞级规则没有任何门绑定它`,
      category: "rule_gate",
      owner: "fde",
      deferrable: false,
      blocks: ["promotion", "production_runtime"],
      dependsOn: ["rule-enforcement:undeclared"],
      evidence: { basis: "static_analysis", observed: "unboundBlocking", substitute: null },
      reason:
        "规则声明为 block，但既没有 manifest 的 rule_gate 也没有本体派生的绑定，于是没有任何一次派发会咨询它。agent 可以靠「不声明门」给自己免检。",
      nextAction: "由 FDE 在 manifest tool_use[].rule_gate 里绑定这些规则，或在本体步骤上写明执行工具",
      source: {
        analysis: "rule-gate-coverage",
        field: "unboundBlocking[]",
        subjects: [...coverage.unboundBlocking].sort().slice(0, 200),
      },
    }));
  }

  if (coverage.ruleRefsWithoutTool.length) {
    entries.push(entry({
      id: "rule-gate:refs-without-tool",
      title: `${coverage.ruleRefsWithoutTool.length} 条规则挂在没有工具的步骤上`,
      category: "rule_gate",
      owner: "business_owner",
      deferrable: false,
      blocks: ["promotion", "production_runtime"],
      dependsOn: [],
      evidence: { basis: "static_analysis", observed: "ruleRefsWithoutTool", substitute: null },
      reason:
        "本体把规则挂在了一个 logic / invoke / 人工步骤上。工具边界的门在结构上够不着它们——不是代码缺陷，是本体的授权落点问题。",
      nextAction:
        "由本体作者为这些步骤写明执行工具，或明确它们是人工边界（人工边界要有人认领）",
      source: {
        analysis: "rule-gate-coverage",
        field: "ruleRefsWithoutTool[]",
        subjects: [...coverage.ruleRefsWithoutTool].sort().slice(0, 200),
      },
    }));
  }

  for (const row of coverage.ungatedMutatingTools) {
    const id = `rule-gate:${idSafe(`${row.agent}/${row.tool}`)}`;
    entries.push(entry({
      id,
      title: `会改状态的调用没有门：${row.agent} → ${row.tool}`,
      category: "rule_gate",
      owner: "fde",
      deferrable: false,
      blocks: ["promotion", "production_runtime"],
      dependsOn: [],
      evidence: { basis: "static_analysis", observed: row.tier, substitute: null },
      // 「哪些工具该被门管」是 assessRisk 判的，不是谁维护的一张名单。
      reason: `${row.reason}（风险级别 ${row.tier}，由 #RISK-TIER 从工具自己声明的影响面判出）`,
      nextAction: `由 FDE 为 ${row.tool} 声明 rule_gate，或在本体步骤上把规则接到这个工具`,
      source: {
        analysis: "rule-gate-coverage",
        field: "ungatedMutatingTools[]",
        subjects: [`${row.agent}/${row.tool}`],
      },
    }));
  }

  for (const row of coverage.undeclaredEffectTools) {
    const facets = effectsByTool.get(row.tool);
    entries.push(entry({
      id: `effect-declaration:${idSafe(`${row.agent}/${row.tool}`)}`,
      title: `影响面未声明：${row.agent} → ${row.tool}`,
      category: "effect_declaration",
      owner: "fde",
      deferrable: false,
      blocks: ["promotion", "production_runtime"],
      dependsOn: [],
      evidence: { basis: "none", observed: null, substitute: null },
      reason: riskReason(facets).reason,
      nextAction:
        `由 FDE 在 manifest 或工具目录里为 ${row.tool} 补上 side_effect / operation / effectScope；未知的爆炸半径按最高管控处理`,
      source: {
        analysis: "rule-gate-coverage",
        field: "undeclaredEffectTools[]",
        subjects: [`${row.agent}/${row.tool}`],
      },
    }));
  }

  return {
    entries,
    scanned:
      coverage.unboundBlocking.length +
      coverage.ruleRefsWithoutTool.length +
      coverage.ungatedMutatingTools.length +
      coverage.undeclaredEffectTools.length,
  };
}

// ── 维度 5：晋升门 + 沙箱证据的真身/替身 ────────────────────────────────────

const PROMOTION_ISSUE_ACTION: Record<ProductionProbeIssueView["code"], string> = {
  tool_missing: "这个工具已不在当前真实工具目录：由 FDE 重新选择或恢复该工具后重建证据",
  definition_identity_missing:
    "算不出当前实现与 production profile 的稳定身份：由 FDE 补齐 profile 配置后重跑",
  production_live_probe_missing:
    "对当前 production profile / 凭证跑一次未过期的 live probe，并留下已签名回执",
  production_cassette_invalid:
    "live probe 索引在，但精确 cassette 过不了路径 / HMAC / revision / 2xx / 返回契约校验：重跑一次真实探针",
  production_write_probe_incomplete:
    "写工具必须完整证明 create、幂等、清理、缺席回读；补齐隔离写探针生命周期后重跑",
};

function collectPromotionEntries(
  input: DeliveryReadinessLedgerInput,
): { entries: LedgerEntry[]; scanned: number } {
  const gate = input.promotionGate;
  if (!gate) return { entries: [], scanned: 0 };
  const effectsByTool = new Map(
    (input.toolEffects ?? []).map((facets) => [facets.tool, facets] as const),
  );
  const entries: LedgerEntry[] = [];
  for (const issue of gate.issues) {
    const facets = effectsByTool.get(issue.tool);
    const risk = riskReason(facets);
    entries.push(entry({
      id: `promotion:${idSafe(`${issue.code}/${issue.tool}`)}`,
      title: `晋升门要求：${issue.tool}（${issue.code}）`,
      category: "promotion_evidence",
      // 生产门报的每一种问题都落在配置/接线上，全部归 FDE：工具不在目录里要重选，
      // profile 身份算不出来要补配置，探针缺失/失效要去跑。没有一种是业务裁决。
      owner: "fde",
      deferrable: false,
      // 硬条目按定义就是晋升门当场要的东西。
      blocks: ["promotion", "production_runtime"],
      dependsOn: [],
      evidence: {
        basis: "production_probe_gate",
        observed: issue.code,
        substitute: null,
        ...(issue.expectedDefinitionHash ? { definitionHash: issue.expectedDefinitionHash } : {}),
      },
      reason: `生产门在提交边界要求这项证据；${risk.reason}`,
      nextAction: PROMOTION_ISSUE_ACTION[issue.code],
      source: {
        analysis: "production-integration-probe-gate",
        field: "productionIntegrationProbeIssues()[].code",
        subjects: [issue.tool, ...issue.specSlugs].sort(),
      },
    }));
  }
  return { entries, scanned: gate.issues.length };
}

function collectSandboxEvidenceEntries(
  input: DeliveryReadinessLedgerInput,
): { entries: LedgerEntry[]; scanned: number } {
  const evidence = input.sandboxEvidence;
  if (!evidence) return { entries: [], scanned: 0 };
  const entries: LedgerEntry[] = [];
  let scanned = 0;

  // 每个外部工具「这次到底是怎么通过的」。这里正是替身与真身必须分得开的地方。
  const byTool = new Map<string, {
    cassetteMode?: "live-probe" | "signed-fixture" | "runtime-record";
    dispatchKind?: "replay" | "replay_miss" | "sandbox_local" | "external_live";
    definitionHash?: string;
    specSlugs: Set<string>;
  }>();
  for (const cassette of evidence.cassettes ?? []) {
    scanned += 1;
    const row = byTool.get(cassette.tool) ?? { specSlugs: new Set<string>() };
    row.cassetteMode = cassette.evidenceMode ?? row.cassetteMode;
    if (cassette.definitionHash) row.definitionHash = cassette.definitionHash;
    for (const slug of cassette.specSlugs ?? []) row.specSlugs.add(slug);
    byTool.set(cassette.tool, row);
  }
  for (const dispatch of evidence.dispatches ?? []) {
    scanned += 1;
    const row = byTool.get(dispatch.tool) ?? { specSlugs: new Set<string>() };
    // 最保守的一次读数获胜：只要有一次是替身，就不能说这个工具跑的是真身。
    if (row.dispatchKind !== "replay" && row.dispatchKind !== "replay_miss") {
      row.dispatchKind = dispatch.kind;
    }
    if (dispatch.kind === "replay" || dispatch.kind === "replay_miss") row.dispatchKind = dispatch.kind;
    byTool.set(dispatch.tool, row);
  }

  for (const [tool, row] of [...byTool.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const substituteKind: LedgerSubstituteKind | null =
      row.cassetteMode === "signed-fixture"
        ? "cassette_signed_fixture"
        : row.cassetteMode === "runtime-record"
          ? "cassette_runtime_record"
          : row.dispatchKind === "replay" || row.dispatchKind === "replay_miss"
            ? "replay"
            : null;
    if (!substituteKind) continue; // live-probe / external_live：真身，不进待办
    entries.push(entry({
      id: `promotion:substituted/${idSafe(tool)}`,
      title: `${tool} 这次的「通过」来自替身，不构成对真实系统的证据`,
      category: "promotion_evidence",
      owner: "fde",
      deferrable: false,
      blocks: ["promotion", "production_runtime"],
      dependsOn: [],
      evidence: {
        basis: row.cassetteMode ? "cassette_evidence_mode" : "sb_decision",
        observed: row.cassetteMode ?? row.dispatchKind ?? null,
        substitute: {
          kind: substituteKind,
          detail: row.cassetteMode
            ? `cassette evidence.mode=${row.cassetteMode}`
            : `dispatch kind=${row.dispatchKind}`,
        },
        ...(row.definitionHash ? { definitionHash: row.definitionHash } : {}),
      },
      reason:
        "工厂沙箱对 effectScope=external 一律走回放，签名夹具也只是可回放的证据，不是真实系统的应答。晋升仍然要对当前 production profile 拿一次 live probe。",
      nextAction: `对 ${tool} 的当前 production profile 跑一次真实 live probe（写工具还要补完整的写探针生命周期）`,
      source: {
        analysis: "sandbox-evidence",
        field: row.cassetteMode ? "cassetteRefs[].evidenceMode" : "SandboxToolDispatchReceipt.kind",
        subjects: [tool, ...[...row.specSlugs].sort()],
      },
    }));
  }

  if (evidence.simulated === true) {
    scanned += 1;
    entries.push(entry({
      id: "promotion:simulated-sandbox",
      title: "本次沙箱是模拟运行，不构成交付证据",
      category: "promotion_evidence",
      owner: "fde",
      deferrable: false,
      blocks: ["promotion", "production_runtime"],
      dependsOn: [],
      evidence: {
        basis: "sandbox_execution_receipt",
        observed: evidence.isolationTier ?? null,
        substitute: { kind: "simulated_sandbox", detail: "lastSandbox.simulated=true" },
      },
      reason: "模拟运行没有真实部署、没有真实派发，任何据此得出的「通过」都是替身通过。",
      nextAction: "在独立执行平面上重跑一次真实沙箱，取得签名 sandboxExecutionReceipt",
      source: { analysis: "sandbox-evidence", field: "lastSandbox.simulated", subjects: ["sandbox"] },
    }));
  } else if (evidence.isolationTier === "same_host_container") {
    scanned += 1;
    entries.push(entry({
      id: "promotion:same-host-isolation",
      title: "沙箱与 Primary API 共用宿主，只能作诊断",
      category: "promotion_evidence",
      owner: "operator",
      deferrable: false,
      blocks: ["promotion"],
      dependsOn: [],
      evidence: {
        basis: "sandbox_execution_receipt",
        observed: "same_host_container",
        substitute: null,
      },
      reason:
        "同宿主执行证明不了独立执行平面，因此这次运行只产出 development_only 诊断回执，不产生可晋升版本。",
      nextAction: "由运维接入独立 remote_container / remote_vm 执行平面后，用同一不可变版本重跑",
      source: {
        analysis: "sandbox-evidence",
        field: "sandboxExecutionReceipt.isolationTier",
        subjects: ["sandbox"],
      },
    }));
  }

  for (const blocker of evidence.promotionBlockers ?? []) {
    scanned += 1;
    entries.push(entry({
      id: `promotion:qualification/${idSafe(blocker.code)}`,
      title: `晋升资格被挡：${blocker.code}`,
      category: "promotion_evidence",
      owner: "fde",
      deferrable: false,
      blocks: ["promotion"],
      dependsOn: [],
      evidence: {
        basis: "evidence_qualification",
        observed: evidence.promotion ?? "blocked",
        substitute: null,
      },
      reason: blocker.detail,
      nextAction: "按 blocker 说明补齐证据后重新生成不可变回归工件",
      source: {
        analysis: "sandbox-evidence",
        field: "evidenceQualification.blockers[]",
        subjects: [blocker.code],
      },
    }));
  }

  return { entries, scanned };
}

// ── 维度 6：租户集成契约（凭证 / 人工字段 / legacyEnvAlternatives） ──────────

function collectContractEntries(
  input: DeliveryReadinessLedgerInput,
  integration: IntegrationCollection,
): { entries: LedgerEntry[]; scanned: number } {
  const contracts = input.integrationProfileContracts ?? [];
  const choices = [
    ...(input.legacyEnvChoices ?? []),
    ...contracts.flatMap((contract) =>
      (contract.legacyEnvAlternatives ?? []).map((choice) => ({
        ...choice,
        system: choice.system ?? contract.systemName,
        profileId: choice.profileId ?? contract.id,
      }))),
  ];
  if (!choices.length && !contracts.length) return { entries: [], scanned: 0 };
  const entries: LedgerEntry[] = [];

  for (const contract of contracts) {
    // 声明要的环境引用里，有任何一个不在 —— 这就是一条 FDE 的配置待办。
    // 「在/不在」是 `credentialPresence()` 的同一性质，值永远不进账本。
    const bits = credentialBits(contract.requiredEnv, input.envPresence);
    const absent = bits.filter((bit) => !bit.configured);
    if (absent.length) {
      entries.push(entry({
        id: `credential:${idSafe(absent.map((bit) => bit.env).sort().join("+"))}`,
        title: `配置凭证：${absent.map((bit) => bit.env).sort().join("、")}`,
        category: "credential",
        owner: "fde",
        // 没有凭证就没得延后：`isProbeDeferrable` 在 credentialConfigured=false 时恒 false。
        deferrable: false,
        blocks: ["promotion", "production_runtime"],
        dependsOn: [],
        evidence: {
          basis: "ontology_declaration",
          observed: "required_env_absent",
          substitute: null,
          credentials: bits,
        },
        reason: `${contract.systemName} 的集成契约（${contract.id}）声明这些环境引用是必需的，当前不在。${contract.fdeSummary ?? ""}`,
        nextAction: `由 FDE 在服务端配置 ${absent.map((bit) => bit.env).sort().join("、")}；配置之前，这个系统上的任何探针都无从谈起`,
        source: {
          analysis: "tenant-integration-contract",
          field: "INTEGRATION_PROFILES[].requiredEnv",
          subjects: [contract.id, contract.systemName, ...contract.toolNames].sort(),
        },
      }));
    }
    if (contract.requiredHumanFields?.length) {
      entries.push(entry({
        id: `choice:human-fields/${idSafe(contract.id)}`,
        title: `确认 ${contract.id} 的人工字段：${contract.requiredHumanFields.join("、")}`,
        category: "choice",
        owner: "fde",
        deferrable: false,
        blocks: ["promotion", "production_runtime"],
        dependsOn: [],
        evidence: { basis: "ontology_declaration", observed: "required_human_fields", substitute: null },
        reason:
          "集成契约把这些字段标为「从 env 文档和本体散文里都推不出来」。没有它们，写探针的隔离命名空间、幂等键、canary 值都无从确定——推断出来的值会真的写到别人的数据上。",
        nextAction: `由 profile 作者逐项确认 ${contract.requiredHumanFields.join("、")}；不要从命名约定推断任何一项`,
        source: {
          analysis: "tenant-integration-contract",
          field: "INTEGRATION_PROFILES[].requiredHumanFields",
          subjects: [contract.id, ...contract.toolNames].sort(),
        },
      }));
    }

    // 契约声明 `runtimePolicy: require_config_and_verified_probe`，并且指名了探针工具。
    // preflight 没有为它建过探针待办时（工具还没绑上、或者整个系统还是缺口），
    // 这里补一条 —— 否则一个「凭证在手、服务没起」的系统会从账本里整个消失，
    // 而那恰恰是最需要写清楚「可以延后」的那一类。
    const probeTool = contract.probeTool;
    if (!probeTool || integration.probeEntryByTool.has(probeTool)) continue;
    const observation = input.probes?.[probeTool];
    const disposition = probeDispositionOf({
      classification: observation?.classification ?? null,
      status: observation?.status ?? null,
    });
    const staleness = probeStaleness(observation, input.probeFreshness);
    // 已经对真实系统验过、而且验的就是当下这一版 —— 没有待办。
    // 漂移或过期时仍然要报：一次为别的版本签的探针不是这一版的证据。
    if (disposition === "verified" && staleness === "current") continue;
    const credentialConfigured =
      observation?.credentialConfigured === true ||
      (observation?.credentialConfigured !== false && allConfigured(bits));
    const deferrable = isProbeDeferrable(disposition, { credentialConfigured, production: false });
    const owner: LedgerOwner =
      disposition === "service_unreachable"
        ? "operator" // 服务没应答：凭证在手也做不了什么，得有人把它部起来。
        : disposition === "authorization_required"
          ? "business_owner"
          : "fde";
    const id = `probe:${idSafe(probeTool)}`;
    integration.probeEntryByTool.set(probeTool, id);
    entries.push(entry({
      id,
      title: `对真实系统跑一次探针：${probeTool}（${contract.systemName}）`,
      category: "probe",
      owner,
      deferrable,
      blocks: ["promotion", "production_runtime"],
      dependsOn: [],
      evidence: {
        basis: "probe_disposition",
        observed: observation?.classification ?? null,
        substitute: null,
        disposition,
        staleness,
        credentials: bits,
        ...(observation?.definitionHash ? { definitionHash: observation.definitionHash } : {}),
      },
      reason: [
        `集成契约（${contract.id}）声明 runtime 必须有已验证探针才放行。`,
        disposition === "never_probed"
          ? "这个集成从来没有被探测过——「没探过」不等于「探过没问题」。"
          : null,
        staleness === "definition_drift"
          ? "上一次探针签的是另一个定义指纹：它证明的不是当下要发的这一版。"
          : staleness === "expired"
            ? "上一次探针已经超出声明的新鲜度窗口。"
            : null,
        deferrable
          ? "凭证已配置、服务没有应答：这是排期事实，不是接线缺陷。"
          : null,
      ].filter(Boolean).join(""),
      nextAction: deferrable
        ? (probeDeferralNotice({
            toolName: probeTool,
            disposition,
            attemptedAt: observation?.verifiedAt ?? null,
            system: contract.systemName,
          }) ?? "作为已记录的义务带着走；晋升前必须补一次真实 live probe")
        : disposition === "credential_missing"
          ? "先配置这个 profile 声明的环境引用，然后才谈得上探针"
          : disposition === "rejected"
            ? "服务应答并拒绝了：核对凭证、base 路径与请求形状（一次 404 是接线缺陷，不是服务没起）"
            : `由 ${owner === "operator" ? "运维把服务部起来后" : "FDE"} 对 ${probeTool} 跑一次真实探针并留下回执`,
      source: {
        analysis: "tenant-integration-contract",
        field: "INTEGRATION_PROFILES[].probeTool + probeDispositionOf()",
        subjects: [contract.id, contract.systemName, probeTool].sort(),
      },
    }));
  }

  for (const choice of choices) {
    const bits = credentialBits([choice.preferredEnv, ...choice.alternatives], input.envPresence);
    const preferred = bits.find((bit) => bit.env === choice.preferredEnv);
    const populatedLegacy = bits.filter(
      (bit) => bit.env !== choice.preferredEnv && bit.configured,
    );
    // 首选已配置，且没有别的候选也被填着 —— 没有需要人来选的东西。
    if (preferred?.configured && populatedLegacy.length === 0) continue;
    entries.push(entry({
      id: `choice:env/${idSafe(choice.preferredEnv)}`,
      title: `明确选定环境引用：${choice.preferredEnv}`,
      category: "choice",
      owner: "fde",
      deferrable: false,
      blocks: ["promotion"],
      dependsOn: [],
      evidence: {
        basis: "ontology_declaration",
        observed: preferred?.configured ? "preferred_configured" : "preferred_absent",
        substitute: null,
        credentials: bits,
      },
      reason: `${choice.migrationNote}。这是一次显式的 FDE 选择：工具可以报告哪一个被填着，但绝不能自动挑一个或把值复制过去。`,
      nextAction: `由 FDE 明确选择 ${choice.preferredEnv} 或 ${choice.alternatives.join("、")} 之一（读写不得复用同一个）`,
      source: {
        analysis: "tenant-integration-contract",
        field: "legacyEnvAlternatives[]",
        subjects: [choice.preferredEnv, ...choice.alternatives, ...(choice.system ? [choice.system] : [])],
      },
    }));
  }
  return { entries, scanned: choices.length + contracts.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// 依赖：没凭证就没探针，没探针就没晋升
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从数据里连边，不是手写的一张图。
 *
 *   credential → probe        一个工具缺的凭证，是它探针的前置
 *   choice(profile) → probe   profile 没选定，探不了
 *   api_contract → tool_gap   没有权威契约就造不出对的工具
 *   probe → promotion         晋升门要的 live probe，前置就是这次探针
 */
function linkDependencies(
  entries: LedgerEntry[],
  integration: Pick<
    IntegrationCollection,
    "probeEntryByTool" | "profileChoiceByTool" | "configEntryByTool"
  >,
  contracts: readonly IntegrationProfileContractView[],
): void {
  const byId = new Map(entries.map((row) => [row.id, row] as const));
  // env → 那条「去配置它」的待办。同一个 env 只会有一条。
  const credentialByEnv = new Map<string, string>();
  for (const row of entries) {
    if (row.category !== "credential") continue;
    for (const credential of row.evidence.credentials ?? []) {
      if (!credential.configured && !credentialByEnv.has(credential.env)) {
        credentialByEnv.set(credential.env, row.id);
      }
    }
  }
  const apiContractBySystem = new Map<string, string>();
  for (const row of entries) {
    if (row.category !== "api_contract") continue;
    for (const subject of row.source.subjects) apiContractBySystem.set(subject, row.id);
  }
  // 工具 → 它所属 profile 的人工字段确认待办。
  const humanFieldsByTool = new Map<string, string>();
  for (const contract of contracts) {
    const id = `choice:human-fields/${idSafe(contract.id)}`;
    if (!byId.has(id)) continue;
    for (const tool of contract.toolNames) humanFieldsByTool.set(tool, id);
  }

  const add = (row: LedgerEntry, dependency: string | undefined): void => {
    if (!dependency || dependency === row.id || !byId.has(dependency)) return;
    if (!row.dependsOn.includes(dependency)) row.dependsOn.push(dependency);
  };
  // entry id → 它说的是哪个工具。探针待办的 id 就是按工具名构造的，反查回来即可。
  const toolOfProbe = new Map<string, string>();
  for (const [tool, id] of integration.probeEntryByTool) toolOfProbe.set(id, tool);

  for (const row of entries) {
    if (row.category === "probe") {
      const tool = toolOfProbe.get(row.id);
      // 没凭证就没探针。
      for (const credential of row.evidence.credentials ?? []) {
        if (credential.configured) continue;
        add(row, credentialByEnv.get(credential.env));
      }
      if (tool) {
        // profile 没选定，就没有可探的配置身份。
        add(row, integration.profileChoiceByTool.get(tool));
        // 人工字段没确认，写探针的隔离命名空间/幂等键就是编的。
        add(row, humanFieldsByTool.get(tool));
        // 写探针安全契约没就绪，这个工具连「安全地探一次」都做不到。
        add(row, integration.configEntryByTool.get(tool));
      }
    }
    if (row.category === "tool_gap") {
      // tool_gap 的 id 里带着 system；没有权威契约就造不出对的工具。
      const system = row.id.slice("tool-gap:".length).split("/")[0] ?? "";
      add(row, apiContractBySystem.get(system));
    }
    if (row.category === "promotion_evidence") {
      // 晋升门要的是一次真实 live probe —— 前置就是那条探针待办（以及它的凭证）。
      const tool = row.source.subjects[0];
      if (!tool) continue;
      const probeId = integration.probeEntryByTool.get(tool);
      add(row, probeId);
      add(row, integration.configEntryByTool.get(tool));
      if (!probeId) {
        for (const env of contracts
          .filter((contract) => contract.toolNames.includes(tool))
          .flatMap((contract) => contract.requiredEnv)) {
          add(row, credentialByEnv.get(env));
        }
      }
    }
  }
  // 指向不存在条目的依赖一律剪掉：账本不能引用一条它自己没有的待办。
  for (const row of entries) {
    row.dependsOn = [...new Set(row.dependsOn.filter((id) => byId.has(id) && id !== row.id))].sort();
  }
}

const OWNER_RANK: Record<LedgerOwner, number> = {
  fde: 0,
  operator: 1,
  external_vendor: 2,
  business_owner: 3,
  platform: 4,
};

const CATEGORY_RANK: Record<LedgerCategory, number> = {
  api_contract: 0,
  credential: 1,
  configuration: 2,
  choice: 3,
  probe: 4,
  tool_gap: 5,
  promotion_evidence: 6,
  rule_obligation: 7,
  rule_gate: 8,
  effect_declaration: 9,
  ontology_defect: 10,
  not_determinable: 11,
  human_step: 12,
};

/**
 * 稳定的拓扑序（Kahn）。同层按 owner → category → id 排，保证同一份输入永远同一个顺序。
 * 成环时把剩余节点按同样的次序附在末尾，并由 `ledgerIntegrityIssues` 报出来 —— 绝不静默丢。
 */
function topologicalOrder(entries: readonly LedgerEntry[]): string[] {
  const byId = new Map(entries.map((row) => [row.id, row] as const));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const row of entries) {
    indegree.set(row.id, row.dependsOn.length);
    for (const dependency of row.dependsOn) {
      (dependents.get(dependency) ?? dependents.set(dependency, []).get(dependency)!).push(row.id);
    }
  }
  const rank = (id: string): string => {
    const row = byId.get(id)!;
    return `${OWNER_RANK[row.owner]}${CATEGORY_RANK[row.category]} ${row.id}`;
  };
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  ready.sort((a, b) => rank(a).localeCompare(rank(b)));
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of (dependents.get(id) ?? []).sort()) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort((a, b) => rank(a).localeCompare(rank(b)));
      }
    }
  }
  if (order.length < entries.length) {
    const seen = new Set(order);
    order.push(
      ...entries
        .map((row) => row.id)
        .filter((id) => !seen.has(id))
        .sort((a, b) => rank(a).localeCompare(rank(b))),
    );
  }
  return order;
}

/**
 * 账本【自己】的缺陷。这是第二条独立的核对路径：构造器已经保证的性质，在这里被重新验一遍。
 * 空数组才是「账本可信」，非空说明账本本身有问题，必须先修账本。
 */
export function ledgerIntegrityIssues(ledger: DeliveryReadinessLedger): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const row of ledger.entries) {
    if (ids.has(row.id)) issues.push(`duplicate entry id: ${row.id}`);
    ids.add(row.id);
    if (!LEDGER_OWNERS.includes(row.owner)) {
      issues.push(`entry ${row.id} has no owner`);
    }
    // 最重要的那条：替身永远不能得出 live/production。
    if (row.evidence.substitute && verificationRungRank(row.rung) >= verificationRungRank("live")) {
      issues.push(
        `entry ${row.id} claims rung '${row.rung}' from a substitute (${row.evidence.substitute.kind})`,
      );
    }
    if (row.rung !== deriveVerificationRung(row.evidence)) {
      issues.push(`entry ${row.id} rung '${row.rung}' does not follow from its evidence`);
    }
    // 可延后 ⇒ 一定有已配置的凭证（`isProbeDeferrable` 的前提）。
    if (row.deferrable && !(row.evidence.credentials ?? []).some((bit) => bit.configured)) {
      issues.push(`entry ${row.id} is deferrable without a configured credential`);
    }
    if (row.deferrable && row.evidence.disposition !== "service_unreachable") {
      issues.push(
        `entry ${row.id} is deferrable but its probe disposition is '${row.evidence.disposition ?? "(none)"}'`,
      );
    }
    // 硬条目必须卡住晋升，否则「硬」这个字没有意义。
    if (!row.deferrable && row.blocks.length > 0 && !row.blocks.includes("promotion")) {
      issues.push(`entry ${row.id} is hard but does not block promotion`);
    }
    // 「可延后」说的是【晋升前必须补上】的义务；一条什么都不卡的待办谈不上延后，
    // 它只是记录。两者混在一起会让三桶重叠，摘要和明细就会说两套话。
    if (row.deferrable && row.blocks.length === 0) {
      issues.push(`entry ${row.id} is deferrable but blocks nothing`);
    }
    for (const dependency of row.dependsOn) {
      if (!ledger.entries.some((candidate) => candidate.id === dependency)) {
        issues.push(`entry ${row.id} depends on unknown entry ${dependency}`);
      }
    }
  }
  // 顺序必须是全序且拓扑正确。
  const position = new Map(ledger.order.map((id, index) => [id, index] as const));
  if (position.size !== ledger.entries.length) {
    issues.push("order does not cover every entry exactly once");
  }
  for (const row of ledger.entries) {
    for (const dependency of row.dependsOn) {
      const here = position.get(row.id);
      const there = position.get(dependency);
      if (here === undefined || there === undefined || there >= here) {
        issues.push(`prerequisite ${dependency} does not precede ${row.id} (dependency cycle?)`);
      }
    }
  }
  return [...new Set(issues)].sort();
}

/**
 * 每个维度的元信息。`missingReason` 存在的唯一理由：没有输入时账本必须说「这一维没查过」，
 * 而不是让它看起来像「查过是 0」。
 */
const DIMENSION_META: ReadonlyArray<{
  source: LedgerSource["analysis"];
  supplied: (input: DeliveryReadinessLedgerInput) => boolean;
  missingReason: string;
}> = [
  {
    source: "factory-domain-preflight",
    supplied: (input) => Boolean(input.preflight),
    missingReason: "没有提供 preflight 报告：集成绑定这一维没有查过",
  },
  {
    source: "ontology-tool-requirements",
    supplied: (input) => Boolean(input.toolRequirements),
    missingReason: "没有提供 analyzeToolRequirements 结果：人工环节 / 同分多选 / 判不出来这一维没有查过",
  },
  {
    source: "ontology-analysis",
    supplied: (input) => Boolean(input.ontologyAnalysis),
    missingReason: "没有提供 analyzeOntologyStructure 结果：规则与本体结构这一维没有查过",
  },
  {
    source: "rule-gate-coverage",
    supplied: (input) => Boolean(input.ruleGateCoverage),
    missingReason:
      "没有提供 reportRuleGateCoverage 结果（需要一份已部署 manifest）：运行期规则门覆盖这一维没有查过",
  },
  {
    source: "production-integration-probe-gate",
    supplied: (input) => Boolean(input.promotionGate),
    missingReason: "没有提供生产探针门结果：晋升要求这一维没有查过",
  },
  {
    source: "sandbox-evidence",
    supplied: (input) => Boolean(input.sandboxEvidence),
    missingReason: "没有提供沙箱 / 回归证据：真身与替身这一维没有查过",
  },
  {
    source: "tenant-integration-contract",
    supplied: (input) =>
      Boolean(
        input.legacyEnvChoices?.length ||
          input.unresolvedExternalSystems?.length ||
          input.integrationProfileContracts?.length,
      ),
    missingReason: "没有提供租户集成契约：凭证 / 人工字段 / 遗留环境引用这一维没有查过",
  },
];

export function buildDeliveryReadinessLedger(
  input: DeliveryReadinessLedgerInput,
): DeliveryReadinessLedger {
  const contracts = input.integrationProfileContracts ?? [];
  const contractIndex = indexContracts(contracts);
  const supplied = new Map(
    DIMENSION_META.map((meta) => [meta.source, meta.supplied(input)] as const),
  );
  const empty = { entries: [] as LedgerEntry[], scanned: 0 };

  // preflight 先跑：它是就绪判定的权威，后面的维度要在它的结论上做合并/改判。
  const integration = supplied.get("factory-domain-preflight")
    ? collectIntegrationEntries(input, contractIndex)
    : {
        ...empty,
        entryByRequirement: new Map<string, string>(),
        probeEntryByTool: new Map<string, string>(),
        profileChoiceByTool: new Map<string, string>(),
        configEntryByTool: new Map<string, string>(),
      };

  const collected = new Map<LedgerSource["analysis"], { entries: LedgerEntry[]; scanned: number }>([
    ["factory-domain-preflight", { entries: integration.entries, scanned: integration.scanned }],
    [
      "ontology-tool-requirements",
      supplied.get("ontology-tool-requirements")
        ? collectToolRequirementEntries(input, integration)
        : empty,
    ],
    ["ontology-analysis", supplied.get("ontology-analysis") ? collectOntologyEntries(input) : empty],
    ["rule-gate-coverage", supplied.get("rule-gate-coverage") ? collectRuleGateEntries(input) : empty],
    [
      "production-integration-probe-gate",
      supplied.get("production-integration-probe-gate") ? collectPromotionEntries(input) : empty,
    ],
    ["sandbox-evidence", supplied.get("sandbox-evidence") ? collectSandboxEvidenceEntries(input) : empty],
    [
      "tenant-integration-contract",
      supplied.get("tenant-integration-contract")
        ? collectContractEntries(input, integration)
        : empty,
    ],
  ]);

  const entries: LedgerEntry[] = [];
  const dimensions: LedgerDimension[] = [];
  for (const meta of DIMENSION_META) {
    const result = collected.get(meta.source) ?? empty;
    for (const row of result.entries) {
      // 同一条待办可能被两份分析各读出一次（人工环节在 preflight 与
      // analyzeToolRequirements 里都会出现；凭证在 preflight 与集成契约里都会出现）。
      // 先到的保留，后到的把当事人并进去 —— 一件事就是一条待办。
      const existing = entries.find((candidate) => candidate.id === row.id);
      if (existing) {
        existing.source.subjects = [
          ...new Set([...existing.source.subjects, ...row.source.subjects]),
        ].sort();
        continue;
      }
      entries.push(row);
    }
    dimensions.push({
      source: meta.source,
      state: supplied.get(meta.source) ? "checked" : "not_checked",
      blockedReason: supplied.get(meta.source) ? null : meta.missingReason,
      scanned: result.scanned,
      entries: result.entries.length,
    });
  }

  linkDependencies(entries, integration, contracts);
  const order = topologicalOrder(entries);

  const byOwner = Object.fromEntries(
    LEDGER_OWNERS.map((owner) => [owner, entries.filter((row) => row.owner === owner).length]),
  ) as Record<LedgerOwner, number>;
  const byStage = Object.fromEntries(
    (["sandbox", "promotion", "production_runtime"] as LedgerStage[]).map((stage) => [
      stage,
      entries.filter((row) => row.blocks.includes(stage)).length,
    ]),
  ) as Record<LedgerStage, number>;

  const ledger: DeliveryReadinessLedger = {
    schema: DELIVERY_READINESS_LEDGER_SCHEMA,
    scope: input.scope,
    generationBlocked: false,
    counts: {
      total: entries.length,
      // 三桶按构造互斥：硬阻塞 / 可延后 / 只记录，任何一条恰好落进一桶。
      hard: entries.filter((row) => !row.deferrable && row.blocks.length > 0).length,
      deferred: entries.filter((row) => row.deferrable).length,
      informational: entries.filter((row) => !row.deferrable && row.blocks.length === 0).length,
      byOwner,
      byStage,
    },
    dimensions,
    entries,
    order,
    integrity: [],
  };
  ledger.integrity = ledgerIntegrityIssues(ledger);
  return ledger;
}

// ─────────────────────────────────────────────────────────────────────────────
// 渲染
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_LABEL: Record<LedgerOwner, string> = {
  fde: "FDE（配置 / 接线 / 选择）",
  operator: "运维 / 基础设施（把服务部起来、恢复额度）",
  external_vendor: "外部厂商（缺 API 契约）",
  business_owner: "业务负责人（政策裁决，推不出来）",
  platform: "平台（工厂自身）",
};

const RUNG_LABEL: Record<VerificationRung, string> = {
  unknown: "判不出来",
  declared: "仅有声明",
  // 「有结论」既包括一次只读分析，也包括一次真跑但没通过的探针 ——
  // 两者都不是验证，所以共用一格；到底是哪一种由紧跟其后的「证据来源」说明。
  analyzed: "有结论但未验证",
  substituted: "替身通过（不是证据）",
  sandbox: "沙箱真跑（外部仍是回放）",
  live: "真实系统 live probe",
  production: "生产门已接受",
};

const STAGE_LABEL: Record<LedgerStage, string> = {
  sandbox: "沙箱",
  promotion: "晋升",
  production_runtime: "生产运行",
};

/**
 * 给助手 / UI 看的渲染：按负责人分组、组内按依赖序、硬阻塞与可延后一眼分得开。
 * 截断必须自报，绝不让读者以为看到的是全量。
 */
export function renderDeliveryReadinessLedger(
  ledger: DeliveryReadinessLedger,
  opts: { maxEntriesPerOwner?: number } = {},
): string {
  const maxPerOwner = opts.maxEntriesPerOwner ?? 20;
  const position = new Map(ledger.order.map((id, index) => [id, index] as const));
  const lines: string[] = [];

  lines.push(`# 交付就绪账本 · ${ledger.scope.domain}`);
  lines.push(
    `生成【没有】被阻塞（这是本产品的承诺）。下面是还没被证明的 ${ledger.counts.total} 项：`
    + ` 硬阻塞 ${ledger.counts.hard} · 可延后 ${ledger.counts.deferred} · 仅记录 ${ledger.counts.informational}`,
  );
  lines.push(
    `卡住的阶段：${(Object.keys(ledger.counts.byStage) as LedgerStage[])
      .map((stage) => `${STAGE_LABEL[stage]} ${ledger.counts.byStage[stage]}`)
      .join(" · ")}`,
  );

  const notChecked = ledger.dimensions.filter((dimension) => dimension.state === "not_checked");
  lines.push(
    notChecked.length
      ? `⚠ 有 ${notChecked.length} 个维度【没有查过】（不是查过是 0）：${notChecked
          .map((dimension) => `${dimension.source}——${dimension.blockedReason}`)
          .join("；")}`
      : `全部 ${ledger.dimensions.length} 个维度都查过了；上面的每个 0 都是查过的 0。`,
  );
  if (ledger.integrity.length) {
    lines.push(`❌ 账本自身有 ${ledger.integrity.length} 处缺陷，先修账本：`);
    for (const issue of ledger.integrity.slice(0, 10)) lines.push(`- ${issue}`);
  }

  for (const owner of LEDGER_OWNERS) {
    const rows = ledger.entries
      .filter((row) => row.owner === owner)
      .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
    if (!rows.length) continue;
    lines.push(`\n## ${OWNER_LABEL[owner]} · ${rows.length} 项`);
    const shown = rows.slice(0, maxPerOwner);
    if (shown.length < rows.length) {
      lines.push(`（共 ${rows.length} 项，下列为按依赖序排在最前的 ${shown.length} 项）`);
    }
    for (const row of shown) {
      const mark = row.blocks.length === 0
        ? "记录"
        : row.deferrable
          ? "可延后"
          : "硬阻塞";
      lines.push(
        `\n### [${mark}] ${row.title}`,
      );
      lines.push(
        `- 验证到：${RUNG_LABEL[row.rung]}`
        + `（证据来源 ${row.evidence.basis}${row.evidence.observed ? ` = ${row.evidence.observed}` : ""}`
        + `${row.evidence.substitute ? ` · 替身：${row.evidence.substitute.detail}` : ""}）`,
      );
      lines.push(
        `- 卡住：${row.blocks.length ? row.blocks.map((stage) => STAGE_LABEL[stage]).join("、") : "不卡任何阶段"}`
        + `${row.dependsOn.length ? ` · 前置：${row.dependsOn.join("、")}` : ""}`,
      );
      if (row.evidence.credentials?.length) {
        lines.push(
          `- 凭证（只报在/不在）：${row.evidence.credentials
            .map((bit) => `${bit.env}=${bit.configured ? "已配置" : "未配置"}`)
            .join("、")}`,
        );
      }
      lines.push(`- 为什么重要：${row.reason}`);
      lines.push(`- 下一步：${row.nextAction}`);
      lines.push(
        `- 依据：${row.source.analysis} · ${row.source.field} · ${row.source.subjects.slice(0, 6).join("、")}`
        + `${row.source.subjects.length > 6 ? ` 等 ${row.source.subjects.length} 处` : ""}`,
      );
    }
  }
  return lines.join("\n");
}
