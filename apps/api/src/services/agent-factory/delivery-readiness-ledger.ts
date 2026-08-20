/**
 * #READINESS-LEDGER 的接线端：把纯账本接到真实证据上，并按邻居回执的同一套纪律落成
 * 一份不可变工件。
 *
 * 纯核在 `@agentic/agent-factory/delivery-readiness-ledger`：它只会把已有分析读成待办。
 * 这里负责的是【取证】和【落盘】两件事，其他一概不做：
 *
 *   取证：production composition root 已经有的东西 —— preflight 的绑定判定、
 *         analyzeToolRequirements 的逐条结论、analyzeOntologyStructure 的规则读数、
 *         productionIntegrationProbeIssues 的晋升要求、factory_tool_probes 里
 *         上一次探针真正看到的 classification、以及租户集成契约。
 *         这里不新建任何一套判定；缺哪一份输入，账本就如实报「这一维没查过」。
 *
 *   落盘：复用 `FsAgentDraftStore.writeReviewReceipt` —— 也就是 development_only 诊断
 *         回执走的那条既有原子写路径（reviews/ 目录、0700、writeDurableAtomic）。
 *         【不开第二条写路径】。回执里带内容摘要，改一个字就对不上。
 *
 * 两条不可让步的性质：
 *  1. 账本永远不阻塞交付。落盘失败也只在回执上如实写 `persisted:false` + 原因，
 *     绝不把 finish 打回 —— 「还没证明」是要告诉 FDE 的信息，不是拦路的门。
 *  2. 凭证只留在/不在的位。这里对每一条面向人的文案再过一遍 preflight 自己的脱敏器，
 *     保证从探针 reason 里带出来的东西不会变成账本里的明文。
 */

import { createHash, randomUUID } from "node:crypto";

import {
  analyzeOntologyStructure,
  analyzeToolRequirements,
  buildDeliveryReadinessLedger,
  canonicalEvidenceJson,
  probeDefinitionHash,
  renderDeliveryReadinessLedger,
  type DeliveryReadinessLedger,
  type DeliveryReadinessLedgerInput,
  type DomainOntology,
  type GeneratedAgentSpec,
  type IntegrationCapabilityProvider,
  type IntegrationProfileContractView,
  type LedgerEntry,
  type ProbeObservationView,
  type RealTool,
  type SandboxEvidenceView,
  type ToolEffectFacetsView,
  type UnresolvedExternalSystemView,
} from "@agentic/agent-factory";

import { integrationContractForTenant } from "../integration-contract-registry";

import {
  credentialPresence,
  preflightProfileHashKey,
  redactPreflightDiagnostic,
  summarizeFactoryDomainPreflight,
} from "../../../scripts/factory-domain-preflight";
import { productionIntegrationProbeIssues } from "./production-integration-probe-gate";
import {
  listGlobalToolProbeReceipts,
  type GlobalToolProbeReceipt,
} from "./tool-probe-store";
import type { DraftStoreScope, FsAgentDraftStore } from "./agent-draft-store";

export const DELIVERY_READINESS_LEDGER_RECEIPT_SCHEMA =
  "agent-factory-delivery-readiness-ledger-receipt/v1" as const;

/**
 * 哪些租户发布了机器可读的集成契约——查 bootstrap 时注册的 #NO-TENANT-TABLE
 * 注册表，而不是编译期客户表。没注册的租户不会因此被报成「没有契约」，账本只会把
 * 这一维标成没查过；新客户发布契约是登记数据，不是改 apps/api 的代码。
 */
function tenantIntegrationContractViews(tenantSlug: string):
  | {
      profiles: IntegrationProfileContractView[];
      unresolvedExternalSystems: UnresolvedExternalSystemView[];
    }
  | undefined {
  const lookup = integrationContractForTenant(tenantSlug);
  if (lookup.status !== "declared") return undefined;
  return {
    profiles: lookup.contract.profiles.map((profile) => ({
      id: profile.id,
      systemName: profile.systemName,
      toolNames: [...profile.toolNames],
      requiredEnv: [...profile.requiredEnv],
      optionalEnv: [...profile.optionalEnv],
      probeTool: profile.probeTool,
      requiredHumanFields: [...profile.requiredHumanFields],
      legacyEnvAlternatives: profile.legacyEnvAlternatives.map((entry) => ({
        preferredEnv: entry.preferredEnv,
        alternatives: [...entry.alternatives],
        migrationNote: entry.migrationNote,
        system: profile.systemName,
        profileId: profile.id,
      })),
      fdeSummary: profile.fdeSummary,
    })),
    unresolvedExternalSystems: lookup.contract.unresolvedExternalSystems.map(
      (system) => ({
        systemName: system.systemName,
        action: system.action,
        capability: system.capability,
        disposition: system.disposition,
        fdeSummary: system.fdeSummary,
      }),
    ),
  };
}
/**
 * 上一次探针【真正看到的】东西。`evidence.classification` 是探针自己写下的原话。
 *
 * `currentDefinitionHash` 是当下要发的这一版的身份；两者一并带出来，账本才能把
 * 「验证过」和「验证的是这一版」分开 —— 这正是 `probe_definition_drift` 说的那件事。
 */
export function probeObservationsFromReceipts(
  receipts: readonly GlobalToolProbeReceipt[],
  credentialConfigured: (toolName: string) => boolean | undefined,
  currentDefinitionHash: (toolName: string) => string | undefined = () => undefined,
): Record<string, ProbeObservationView> {
  const output: Record<string, ProbeObservationView> = {};
  for (const receipt of receipts) {
    const classification = receipt.evidence?.classification;
    const previous = output[receipt.toolName];
    // 同一个工具可能有多条（多份 config）。已验证的那条优先，否则留最近的一条。
    const verified = receipt.status === "verified";
    if (previous && previous.classification === "verified" && !verified) continue;
    output[receipt.toolName] = {
      classification: typeof classification === "string" ? classification : verified ? "verified" : null,
      credentialConfigured: credentialConfigured(receipt.toolName) ?? null,
      verifiedAt: receipt.verifiedAt ? Date.parse(receipt.verifiedAt) : null,
      definitionHash: receipt.definitionHash,
      currentDefinitionHash: currentDefinitionHash(receipt.toolName) ?? null,
      // 仓库自己的过期机制：`isSandboxReplayToolProbeReceipt` 判的就是这一位。
      attestationExpiresAt:
        typeof receipt.evidence?.attestationExpiresAt === "string"
          ? receipt.evidence.attestationExpiresAt
          : null,
    };
  }
  return output;
}

/** 每个工具自己声明的影响面。`assessRisk` 用它回答「为什么这条重要」。 */
export function toolEffectFacets(tools: readonly RealTool[]): ToolEffectFacetsView[] {
  return tools.map((tool) => ({
    tool: tool.name,
    sideEffect: tool.sideEffect ?? null,
    operation: tool.operation ?? null,
    effectScope: tool.effectScope ?? null,
    sandboxPolicy: tool.sandboxPolicy ?? null,
    credentialEnv: tool.credentialEnv ?? [],
  }));
}

/** 沙箱这一次到底是怎么通过的：cassette 的 evidence.mode 与派发回执的 kind，原样带出。 */
export function sandboxEvidenceView(result: {
  cassetteRefs?: ReadonlyArray<{
    tool: string;
    evidenceMode?: "live-probe" | "signed-fixture" | "runtime-record";
    definitionHash?: string;
    specSlugs?: readonly string[];
  }>;
  replayReceipts?: ReadonlyArray<{
    tool: string;
    kind: "replay" | "replay_miss" | "sandbox_local" | "external_live";
  }>;
  sandboxDispatches?: ReadonlyArray<{
    tool: string;
    kind: "replay" | "replay_miss" | "sandbox_local" | "external_live";
  }>;
  executionReceipt?: { isolationTier?: "same_host_container" | "remote_container" | "remote_vm" };
  simulated?: boolean;
  promotion?: "candidate" | "blocked";
  promotionBlockers?: ReadonlyArray<{ code: string; detail: string }>;
}): SandboxEvidenceView {
  return {
    simulated: result.simulated ?? false,
    isolationTier: result.executionReceipt?.isolationTier ?? null,
    promotion: result.promotion ?? null,
    ...(result.promotionBlockers ? { promotionBlockers: result.promotionBlockers } : {}),
    cassettes: (result.cassetteRefs ?? []).map((ref) => ({
      tool: ref.tool,
      ...(ref.evidenceMode ? { evidenceMode: ref.evidenceMode } : {}),
      ...(ref.definitionHash ? { definitionHash: ref.definitionHash } : {}),
      ...(ref.specSlugs ? { specSlugs: ref.specSlugs } : {}),
    })),
    dispatches: [...(result.replayReceipts ?? []), ...(result.sandboxDispatches ?? [])].map(
      (receipt) => ({ tool: receipt.tool, kind: receipt.kind }),
    ),
  };
}

export interface DeliveryReadinessLedgerEvidence {
  scope: DraftStoreScope & { domain: string };
  ontology: DomainOntology;
  registryTools: RealTool[];
  declarativeTools: Parameters<typeof summarizeFactoryDomainPreflight>[0]["declarativeTools"];
  realTools: RealTool[];
  integrationCapabilities: IntegrationCapabilityProvider[];
  systemAliasGroups?: string[][];
  specs: readonly GeneratedAgentSpec[];
  sandboxEvidence?: SandboxEvidenceView;
  env?: Record<string, string | undefined>;
  /** 测试用的注入点；生产读真实 factory_tool_probes。 */
  probeReceipts?: readonly GlobalToolProbeReceipt[];
}

/**
 * 从真实证据装配纯账本的输入。这里【没有】任何一处判定：每个字段都指回一份既有分析。
 */
export function collectDeliveryReadinessLedgerInput(
  evidence: DeliveryReadinessLedgerEvidence,
): DeliveryReadinessLedgerInput {
  const env = evidence.env ?? process.env;
  const contracts = tenantIntegrationContractViews(evidence.scope.tenantSlug);
  // 存在位的取材面 = 工具自己声明的凭证 + integration profile 里的 *_env 引用 +
  // 租户契约声明的必需环境引用。三者都只留 "configured"/undefined，绝不留值。
  const envPresence: Record<string, string | undefined> = {
    ...credentialPresence(evidence.realTools, env),
  };
  for (const name of new Set(
    (contracts?.profiles ?? []).flatMap((profile) => [
      ...profile.requiredEnv,
      ...(profile.optionalEnv ?? []),
      ...(profile.legacyEnvAlternatives ?? []).flatMap((choice) => [
        choice.preferredEnv,
        ...choice.alternatives,
      ]),
    ]),
  )) {
    envPresence[name] = typeof env[name] === "string" && env[name]!.trim() ? "configured" : undefined;
  }

  const profileDefinitionHashes: Record<string, string> = {};
  for (const tool of evidence.realTools) {
    for (const profile of tool.integrationProfiles ?? []) {
      const hash = probeDefinitionHash(tool, profile.config, env);
      if (hash) profileDefinitionHashes[preflightProfileHashKey(tool.name, profile.id)] = hash;
    }
  }

  const preflight = summarizeFactoryDomainPreflight({
    scope: {
      tenantId: evidence.scope.tenantId,
      tenantSlug: evidence.scope.tenantSlug,
      domain: evidence.scope.domain,
    },
    ontology: evidence.ontology,
    globalTools: evidence.registryTools,
    declarativeTools: evidence.declarativeTools,
    runtimeProviders: evidence.integrationCapabilities,
    ...(evidence.systemAliasGroups ? { systemAliasGroups: evidence.systemAliasGroups } : {}),
    envPresence,
    profileDefinitionHashes,
  });

  const receipts =
    evidence.probeReceipts ??
    listGlobalToolProbeReceipts(evidence.scope.tenantId, evidence.scope.domain);
  const envByTool = new Map<string, string[]>();
  for (const profile of contracts?.profiles ?? []) {
    for (const tool of profile.toolNames) {
      envByTool.set(tool, [...(envByTool.get(tool) ?? []), ...profile.requiredEnv]);
    }
  }
  const credentialConfigured = (toolName: string): boolean | undefined => {
    const names = [
      ...(envByTool.get(toolName) ?? []),
      ...(evidence.realTools.find((tool) => tool.name === toolName)?.credentialEnv ?? []),
    ];
    return names.length ? names.every((name) => envPresence[name] === "configured") : undefined;
  };
  // 当下这一版的定义身份，按晋升门自己的算法算：`probeDefinitionHash(tool, spec 的 config)`。
  // 用同一套算法，账本说的漂移才和门说的是同一件事。
  const specToolConfig = new Map<string, Record<string, unknown>>();
  for (const spec of evidence.specs) {
    for (const [toolName, config] of Object.entries(spec.toolConfigs ?? {})) {
      if (!specToolConfig.has(toolName)) specToolConfig.set(toolName, config);
    }
  }
  const currentDefinitionHash = (toolName: string): string | undefined => {
    const tool = evidence.realTools.find((candidate) => candidate.name === toolName);
    return tool ? probeDefinitionHash(tool, specToolConfig.get(toolName) ?? {}, env) : undefined;
  };

  return {
    scope: {
      tenantId: evidence.scope.tenantId,
      tenantSlug: evidence.scope.tenantSlug,
      domain: evidence.scope.domain,
    },
    preflight,
    toolRequirements: analyzeToolRequirements(evidence.ontology, evidence.realTools, {
      ...(evidence.systemAliasGroups ? { systemAliasGroups: evidence.systemAliasGroups } : {}),
      capabilityProviders: evidence.integrationCapabilities,
    }),
    ontologyAnalysis: analyzeOntologyStructure(evidence.ontology),
    // 晋升门用【结构版】：它就是 promote 先跑的那一支，所以账本里的「硬」与门是同一句话。
    // 提交边界的 HMAC 复核留在 promote 自己那里，账本不替它盖章。
    promotionGate: {
      issues: productionIntegrationProbeIssues(evidence.specs, evidence.realTools, env),
    },
    ...(evidence.sandboxEvidence ? { sandboxEvidence: evidence.sandboxEvidence } : {}),
    probes: probeObservationsFromReceipts(receipts, credentialConfigured, currentDefinitionHash),
    toolEffects: toolEffectFacets(evidence.realTools),
    envPresence,
    ...(contracts
      ? {
          integrationProfileContracts: contracts.profiles,
          unresolvedExternalSystems: contracts.unresolvedExternalSystems,
        }
      : {}),
    // reportRuleGateCoverage 需要一份已部署 manifest；草稿阶段没有，
    // 于是这一维如实报「没查过」，而不是报成 0 个规则门缺口。
  };
}

/** 面向人的每一处文案再过一遍 preflight 的脱敏器：探针 reason 也不许把凭证带出来。 */
function redactEntry(row: LedgerEntry): LedgerEntry {
  return {
    ...row,
    title: redactPreflightDiagnostic(row.title),
    reason: redactPreflightDiagnostic(row.reason),
    nextAction: redactPreflightDiagnostic(row.nextAction),
    evidence: {
      ...row.evidence,
      observed: row.evidence.observed === null ? null : redactPreflightDiagnostic(row.evidence.observed),
      ...(row.evidence.substitute
        ? {
            substitute: {
              ...row.evidence.substitute,
              detail: redactPreflightDiagnostic(row.evidence.substitute.detail),
            },
          }
        : {}),
    },
    source: { ...row.source, subjects: row.source.subjects.map(redactPreflightDiagnostic) },
  };
}

export function redactDeliveryReadinessLedger(
  ledger: DeliveryReadinessLedger,
): DeliveryReadinessLedger {
  return { ...ledger, entries: ledger.entries.map(redactEntry) };
}

export function deliveryReadinessLedgerDigest(ledger: DeliveryReadinessLedger): string {
  return createHash("sha256").update(canonicalEvidenceJson(ledger), "utf8").digest("hex");
}

export interface DeliveryReadinessLedgerReceipt {
  schema: typeof DELIVERY_READINESS_LEDGER_RECEIPT_SCHEMA;
  receiptId: string;
  /** 落盘成功与否都如实说。false 不代表交付失败 —— 账本从不阻塞交付。 */
  persisted: boolean;
  persistFailure?: string;
  /** 内容摘要：改一个字就对不上。 */
  digest: string;
  counts: DeliveryReadinessLedger["counts"];
  /** 明确没有查过的维度，让「0 条待办」不至于被读成「全都没问题」。 */
  notChecked: string[];
  /** 账本自身的缺陷。非空说明先修账本。 */
  integrity: string[];
}

/**
 * 产出并落盘一份交付就绪账本。
 *
 * 走的是 `writeReviewReceipt` —— development_only 诊断回执用的同一条既有原子写路径。
 * 任何异常都被吞成回执上的 `persisted:false` + 原因：账本是交付要带的信息，不是门。
 */
export async function produceDeliveryReadinessLedger(args: {
  store: Pick<FsAgentDraftStore, "writeReviewReceipt">;
  evidence: DeliveryReadinessLedgerEvidence;
  versionId: string;
  /** 与这份账本同批的沙箱证据指纹，便于把账本挂回那一次不可变证据。 */
  evidenceFingerprint?: string;
  actor?: string;
}): Promise<{ ledger: DeliveryReadinessLedger; receipt: DeliveryReadinessLedgerReceipt; rendered: string }> {
  const ledger = redactDeliveryReadinessLedger(
    buildDeliveryReadinessLedger(collectDeliveryReadinessLedgerInput(args.evidence)),
  );
  const rendered = renderDeliveryReadinessLedger(ledger);
  const receiptId = `review-${randomUUID()}`;
  const digest = deliveryReadinessLedgerDigest(ledger);
  const notChecked = ledger.dimensions
    .filter((dimension) => dimension.state === "not_checked")
    .map((dimension) => `${dimension.source}: ${dimension.blockedReason ?? ""}`);

  let persisted = true;
  let persistFailure: string | undefined;
  try {
    await args.store.writeReviewReceipt(args.evidence.scope.domain, receiptId, {
      schema: DELIVERY_READINESS_LEDGER_RECEIPT_SCHEMA,
      receiptId,
      scope: {
        tenantId: args.evidence.scope.tenantId,
        tenantSlug: args.evidence.scope.tenantSlug,
        domain: args.evidence.scope.domain,
        versionId: args.versionId,
      },
      ...(args.evidenceFingerprint ? { evidenceFingerprint: args.evidenceFingerprint } : {}),
      ...(args.actor ? { actor: args.actor } : {}),
      digest,
      createdAt: new Date().toISOString(),
      ledger,
      rendered,
    });
  } catch (error) {
    persisted = false;
    persistFailure = redactPreflightDiagnostic(
      error instanceof Error ? error.message : String(error),
    );
  }

  return {
    ledger,
    rendered,
    receipt: {
      schema: DELIVERY_READINESS_LEDGER_RECEIPT_SCHEMA,
      receiptId,
      persisted,
      ...(persistFailure ? { persistFailure } : {}),
      digest,
      counts: ledger.counts,
      notChecked,
      integrity: ledger.integrity,
    },
  };
}
