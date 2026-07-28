// The brain's tool/action space — the deterministic capabilities the autonomous loop
// orchestrates. Re-implemented for the new arch on ctx.ports + the ported foundation
// (graph / contract / codegen / tool-catalog). No Prisma, no Inngest, no Neo4j.
//
// Wave A: enriched read_ontology (event-flow digest + is_rule_check + suggested_tools
// + reusable_skills) and design_agent (tool grounding + explicit rule-tool choice + auto code
// render + hallucination/rule-leak warnings), plus the full tool set the OLD harness
// had: codegen_agent, refine_agent (w/ score delta), score_spec, read_spec, inspect_run,
// verify_chain, review_agent, diff_spec, revert_refine, list_domains, describe_domain,
// web_search, create_skill, use_skill, analyze_failure, finish.

import { createHash } from "node:crypto";

import type { BrainTool, BrainCtx, BuildPlan, ScoreDims, RefineAttempt, BoundaryProposal, TestCase } from "./brain-types";
import type { GeneratedAgentSpec, GeneratedInputBinding, GeneratedToolExecutionPolicy, GeneratedToolSideEffect, IoField, PlanStep } from "./spec-types";
import type { OntologyAction, DomainOntology } from "./ontology-types";
import type { DeclarativeTool, FactorySignedFixtureExchange } from "./ports";
import { SandboxLifecycleBlockedError } from "./ports";
import { compileGraph, verifyGraph, coverageGap } from "./graph";
import { analyzeOntologyStructure } from "./ontology-analysis";
import { acceptanceGate, assessCompleteSuite, assessIntegrationBindings } from "./acceptance";
import { parsePlan, validatePlan } from "./plan-projection";
import { analyzeExecutionPlanRequirement, validatePlanAgainstOntology } from "./ontology-execution";
import { deriveContractGraph, contractIssueStringsBySeverity, contractAgentIssueMap } from "./contract";
import { evaluateExecutionFidelity, expectedFieldsByEvent } from "./execution-fidelity";
import { attributeFidelityFailures, attributionSummary } from "./failure-attribution";
import { supervisorAudit, reconcileDefects, blockingDefects, supervisorSummary } from "./supervisor";
import { proposeOntologyRevisions, revisionSummary } from "./ontology-revision";
import { resolveCapabilityLadder } from "./capability-ladder";
import { parseStrategyPlan, describeStrategyPlan, selectStrategy, estimateDifficulty, classifyIntentKind, budgetForDifficulty, STRATEGY_DESC, type StrategyContext } from "./reasoning-policy";
import { kernelTokenCharge, runReasoning, asModelTier } from "./reasoning-kernel";
import { buildDeliveryBundle } from "./delivery-bundle";
import { keyVerdictsByCase, diffRegression } from "./regression-diff";
import { deriveBusinessFlow } from "./business-flow";
import { renderWorkflowSvg } from "./business-flow-svg";
import { buildOntologyAnchorIndex, groundBlueprint, type BlueprintDiagram, type BlueprintModel, type BlueprintPhase, type BlueprintProposal, type OntologyAnchor } from "./blueprint";
import { renderBlueprintSvg, renderBlueprintReportSection } from "./blueprint-svg";
import { shouldSuggestSplit } from "./reasoning-policy";
import { buildToolCatalog, rankRealTools, groundToolPicks, ungroundedEventTokens, searchRealTools, detectMissingToolCredentials, type RealTool, type ToolCapabilityDescriptor } from "./tool-catalog";
import { specToAgentCode, validateAgentCode, probeAgentModule } from "./codegen";
import {
  lintGeneratedToolCode,
  validateGeneratedToolAllowlist,
  validateGeneratedToolCoverage,
} from "./code-lint";
import { generatedSpecExecutionOwnership } from "./execution-ownership";
import { sandboxRegistrationEvidenceIssues } from "./sandbox-registration";
import { safeFetch } from "./egress-guard";
import { ensureCoverage, generate_test_cases, proposeTestCases } from "./test-cases";
import { runSpecialists, buildOntologySpecialistTasks, synthesizeUnderstanding, ruleEnforcementTag, type SpecialistResult } from "./specialists";
import { perspectivesEnabled, selectLenses, buildLensTasks, type LensSelection } from "./perspectives";
import { runInlineAnalysis } from "./inline-codeact";
import { designSelfCheck, internalDesignRefine, innerLoopEnabled, requiresAttemptGrantPolicy } from "./design-loop";
import { chatJson, chatJsonResult, isGatewayConfigured, type ChatJsonFailure } from "./stream-gateway";
import { modelChain, heterogeneousReviewChain } from "./model-router";
import {
  ontologyContentHash,
  sandboxCleanupReceiptIssues,
  sandboxEvidenceFingerprint,
} from "./evidence-fingerprint";
import { analyzeOntologyReadiness, type OntologyReadinessIssue } from "./ontology-readiness";
import {
  assertGeneratedSpecToolPoliciesCurrent,
  isGeneratedToolExecutionPolicy,
  realToolExecutionPolicy,
  ToolPolicyDriftError,
} from "./tool-execution-policy";
import { normalizeOntologySelfConsistency, applyOntologyRevision, blockingIssuesForAction, type OntologyRevisionPatch } from "./ontology-normalize";
import { resolveOntologyReferences } from "./ontology-references";
import { compileInputBindings } from "./input-bindings";
import {
  applyIntegrationHumanBoundaries,
  type IntegrationHumanBoundary,
  deriveIntegrationRequirements,
  resolveIntegrationBindings,
  type IntegrationBindingReport,
  type IntegrationCapabilityProvider,
} from "./integration-binding";
import {
  isIntegrationProfileEnvironment,
  resolveIntegrationProfile,
  validateIntegrationToolConfig,
  type IntegrationProfile,
} from "./integration-profile";
import {
  createIntegrationProfileAuthorizationBinding,
  integrationProfileConfigDigest,
  integrationProfileScopeIssues,
  validateGeneratedSpecIntegrationProfiles,
  type IntegrationProfileExecutionScope,
} from "./integration-profile-authorization";
import {
  createProbeAuthorizationBinding,
  findSensitiveProbeInputPath,
  probeDefinitionHash,
} from "./probe-authorization";
import { writeProbeCanarySeed } from "./declarative-tool-hash";
import {
  inspectWriteProbeSafety,
  isWriteCapableSideEffect,
  prepareWriteProbeCanary,
} from "@agentic/shared";
import { stableJson } from "@agentic/shared/cassette";
import { decisionTablesPromptBlock, parseDecisionTables } from "./decision-tables";
import { coverageWaiverMatches, normalizeCoverageCells } from "./coverage-waiver";
import { normalizeClarificationOptions } from "./clarification-policy";
import {
  DECLARATIVE_EXAMPLES_SCHEMA,
  DECLARATIVE_REQUEST_SPEC_SCHEMA,
  DECLARATIVE_RESPONSE_SPEC_SCHEMA,
  parseDeclarativeHttpContract,
  validateDeclarativeExamplesAgainstContract,
} from "./declarative-tool-spec";
import { validateDeclarativeToolPolicy } from "./declarative-tool-policy";
import { findSensitiveInputPath } from "./sensitive-input";
import type {
  FactoryAuthorizationChallenge,
  FactoryHumanAuthorizationReceipt,
} from "./authorization-challenge";
import { factoryExecutionScope } from "./authorization-challenge";
import { sandboxDesignReviewSubjectDigest } from "./sandbox-design-review";
import type {
  SandboxEvidencePlanBindingRequest,
  SandboxEvidencePlanReceipt,
} from "./sandbox-evidence-plan";
import { sandboxExecutionReceiptIssues } from "./sandbox-execution-plane";
import {
  FACTORY_TEST_FIXTURE_ASSET_SCHEMA,
  type FactoryTestFixtureAssetBinding,
  type FactoryTestFixtureAssetShape,
} from "./test-fixture-assets";
import {
  assessRuleGate,
  ontologyActionIsRuleGate,
  resolveActionRuleReferences,
  toolReadsRulebase,
} from "./rule-gate-evidence";
import { recallConversationTool } from "./conversation-archive";
import {
  applyFactoryGenerationOverlay,
  factoryGenerationAcceptanceOntology,
  factoryGenerationScopedAgentActionNames,
  factoryGenerationScopedAgentActions,
} from "./generation-directive";
import {
  autopilotClarificationHardBlockReason,
  autopilotTestApprovalBlockReason,
  recordFactoryAssumption,
  resolveAutopilotClarification,
} from "./interaction-policy";

export { ontologyContentHash, sandboxEvidenceFingerprint, specsFingerprint } from "./evidence-fingerprint";

// ── helpers ───────────────────────────────────────────────────────────────────
function params(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    properties: { reasoning: { type: "string", description: "动手前用一句话说清你为什么这么做。" }, ...props },
    required: ["reasoning", ...required],
    additionalProperties: false,
  };
}

function flattenPlanSteps(steps: readonly PlanStep[] | undefined): PlanStep[] {
  return (steps ?? []).flatMap((step) => [step, ...flattenPlanSteps(step.body)]);
}

/** Public JSON-schema surface for the runtime's fail-closed error classifier.
 * Keeping this beside `params` makes the model-facing contract identical for
 * top-level steps and foreach body steps; `parsePlan` remains the authoritative
 * validator and rejects malformed/missing default ladders. */
const ERROR_POLICY_SCHEMA: Record<string, unknown> = {
  type: "array",
  minItems: 1,
  description:
    "按顺序 first-match 的错误分类表。when 只能读取 kind/code/status/name/message/data/meta；最后一项必须用 default。park/retry=让 Inngest 重试，terminal=NonRetriableError，continue=带 defaultResult 继续。可用 emitEvent 选择已声明错误事件，或 suppressEmit 禁止历史隐式终态事件。",
  items: {
    type: "object",
    properties: {
      when: { type: "string", description: "安全谓词，如 status == 429 || code == 'QUOTA_EXHAUSTED'" },
      do: { type: "string", enum: ["park", "retry", "terminal", "continue"] },
      default: { type: "string", enum: ["park", "retry", "terminal", "continue"], description: "仅用于最后一项的兜底动作" },
      defaultResult: {},
      emitEvent: { type: "string", description: "可选；必须来自本 action 的 triggered_event" },
      emitPayload: { type: "object", additionalProperties: true },
      suppressEmit: { type: "boolean", description: "只抑制运行时隐式默认 emit，不吞显式 emit step" },
    },
    additionalProperties: false,
  },
};

const TOOL_ARGUMENTS_SCHEMA: Record<string, unknown> = {
  type: "object",
  minProperties: 1,
  description:
    "工具的精确 JSON 入参模板。每个参数必须显式写成 {from:'input.x',required?:boolean} 或 {const:<JSON>}；from 只允许 event/input/lastResult/results/locals 安全路径。禁止裸字符串、禁止按参数名猜值。省略本字段仅为旧 plan 的 whole-carry 兼容模式，会产生明确警告。",
  additionalProperties: {
    oneOf: [
      {
        type: "object",
        properties: {
          from: { type: "string", description: "安全路径，例如 input.candidate_id、results.fetch.jd_id、locals.resume.object_key" },
          required: { type: "boolean", description: "默认 true；缺失时 fail-closed。false 时缺值会省略该参数。" },
        },
        required: ["from"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { const: { description: "明确的静态 JSON 常量；不能包含 undefined/function/secret placeholder。" } },
        required: ["const"],
        additionalProperties: false,
      },
    ],
  },
};

const RESULT_MAP_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    "把工具原始返回映射为稳定命名字段。fields 的值必须是 result 根路径；任一路径缺失都会 fail-closed。includeRaw=true 时额外保留在 _raw。",
  properties: {
    fields: {
      type: "object",
      minProperties: 1,
      additionalProperties: { type: "string", description: "例如 result.data.candidate_id；必须从 result 开始" },
    },
    includeRaw: { type: "boolean" },
  },
  required: ["fields"],
  additionalProperties: false,
};

/** Recursive model-facing plan contract. Runtime validation remains the
 * authority, but exposing the recursive edge lets the factory author nested
 * foreach/invoke plans instead of requiring a post-generation hand edit. */
const PLAN_STEP_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    stepId: { type: "string" },
    kind: { type: "string", enum: ["tool", "logic", "condition", "invoke", "foreach", "emit"] },
    tool: { type: "string" },
    toolArguments: TOOL_ARGUMENTS_SCHEMA,
    resultMap: RESULT_MAP_SCHEMA,
    condition: { type: "string" },
    invoke: { type: "string" },
    invokeInput: { type: "object", additionalProperties: true },
    forwardLastResult: { type: "boolean" },
    forwardResults: { type: "boolean" },
    dependsOn: { type: "array", items: { type: "string" } },
    idempotencyKeyFrom: { type: "string" },
    onError: { type: "string", enum: ["terminal", "soft", "park"] },
    errorPolicy: ERROR_POLICY_SCHEMA,
    defaultResult: {},
    timeoutS: { type: "number" },
    itemsFrom: { type: "string", description: "foreach 集合安全路径，如 results.list.result.items 或 input.resumes" },
    itemAs: { type: "string", description: "foreach 当前项局部变量名，默认 item" },
    itemKeyFrom: { type: "string", description: "当前项内稳定业务键路径；禁止仅用数组下标" },
    body: {
      type: "array",
      description: "递归顺序 foreach body；支持 tool/logic/condition/invoke/foreach/emit",
      items: { $ref: "#/$defs/planStep" },
    },
    emitEvent: { type: "string", description: "emit 事件名，必须来自 action.triggered_event" },
    emitPayloadFrom: { type: "string", description: "显式事件 payload 的安全数据路径" },
    emitPayload: { type: "object", additionalProperties: true, description: "合并到事件 payload 的静态字段" },
    description: { type: "string" },
  },
  required: ["stepId", "kind"],
  additionalProperties: false,
};

const DECISION_PREDICATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    path: { type: "string", description: "安全数据路径，如 score / input.score / results.match.result.score" },
    op: { type: "string", enum: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "not_in", "contains", "exists", "missing"] },
    value: {},
    upper: { type: "number" },
    values: { type: "array", items: {} },
  },
  required: ["path", "op"],
  additionalProperties: false,
};

const DECISION_FALLBACK_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    outcome: { type: "string" },
    emitEvent: { type: "string" },
    payload: { type: "object", additionalProperties: true },
  },
  required: ["outcome"],
  additionalProperties: false,
};

const DECISION_TABLES_SCHEMA: Record<string, unknown> = {
  type: "array",
  description:
    "机器可执行的业务决策表（阈值/分层/置信门/去重顺序）。禁止只把 39/40/null 之类边界写进 prose；每表必须显式 missing 和 default，row first-match，emitEvent 必须来自本体 triggered_event。",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      description: { type: "string" },
      rows: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            all: { type: "array", items: DECISION_PREDICATE_SCHEMA },
            any: { type: "array", items: DECISION_PREDICATE_SCHEMA },
            outcome: { type: "string" },
            emitEvent: { type: "string" },
            payload: { type: "object", additionalProperties: true },
          },
          required: ["id", "outcome"],
          additionalProperties: false,
        },
      },
      missing: DECISION_FALLBACK_SCHEMA,
      default: DECISION_FALLBACK_SCHEMA,
    },
    required: ["id", "rows", "missing", "default"],
    additionalProperties: false,
  },
};

function proseContainsDecisionThreshold(text: string): boolean {
  return /(?:score|分数|置信|confidence|阈值|threshold|高于|低于|大于|小于|不少于|不超过|至少|至多|[<>]=?)\s*[:：]?[\s\S]{0,16}?-?\d+(?:\.\d+)?/i.test(text);
}
const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[_\s]+/g, "-").toLowerCase();
const pascal = (s: string) => s.replace(/(^|[-_\s])([a-z])/g, (_, __, c) => c.toUpperCase()).replace(/[-_\s]/g, "");
const domainPrefix = (d: string) => kebab(d).replace(/-v\d+$/, "").slice(0, 12) || "dom";

export function persistedToolAsRealTool(tool: DeclarativeTool): RealTool {
  return {
    name: tool.name,
    summary: tool.description || `${tool.method} ${tool.urlTemplate}`,
    category: tool.name.includes(".") ? tool.name.slice(0, tool.name.indexOf(".")) : "created",
    sideEffect: tool.sideEffect === "read" || tool.sideEffect === "write" || tool.sideEffect === "dual"
      ? tool.sideEffect
      : "call",
    operation: tool.operation,
    effectScope: tool.effectScope,
    sandboxPolicy: tool.sandboxPolicy,
    aliases: [],
    capabilities: tool.capabilities ?? [],
    probeStatus: tool.probeStatus ?? "required",
    definitionHash: tool.definitionHash,
    verifiedDefinitionHashes: tool.verifiedDefinitionHashes,
    productionVerifiedDefinitionHashes: tool.productionVerifiedDefinitionHashes,
    probeEvidenceMode: tool.probeEvidenceMode,
    integrationProfiles: tool.integrationProfiles ?? [],
    declarativeDefinition: {
      name: tool.name,
      method: tool.method,
      urlTemplate: tool.urlTemplate,
      headers: tool.headers,
      bodyTemplate: tool.bodyTemplate,
      sideEffect: tool.sideEffect,
      operation: tool.operation,
      effectScope: tool.effectScope,
      sandboxPolicy: tool.sandboxPolicy,
      requestSpec: tool.requestSpec as unknown as Record<string, unknown> | undefined,
      responseSpec: tool.responseSpec as unknown as Record<string, unknown> | undefined,
      examples: tool.examples as unknown as Array<Record<string, unknown>> | undefined,
      paramsSchema: tool.paramsSchema,
      returnsSchema: tool.returnsSchema,
      capabilities: tool.capabilities,
      probeSafety: tool.probeSafety,
    },
  };
}

function selectedToolPolicies(
  names: readonly string[],
  registry: readonly RealTool[],
): { values: Record<string, GeneratedToolExecutionPolicy>; missing: string[] } {
  const values: Record<string, GeneratedToolExecutionPolicy> = {};
  const missing: string[] = [];
  for (const name of names) {
    const tool = registry.find((candidate) =>
      candidate.name === name || candidate.aliases?.includes(name));
    const declared = realToolExecutionPolicy(tool);
    if (isGeneratedToolExecutionPolicy(declared)) {
      values[name] = declared;
    } else {
      missing.push(name);
    }
  }
  return { values, missing };
}

/** One-release serializer compatibility for the old manifest field. It is
 * never consulted for execution permission. */
function selectedLegacyToolSideEffects(
  names: readonly string[],
  registry: readonly RealTool[],
): Record<string, GeneratedToolSideEffect> {
  const values: Record<string, GeneratedToolSideEffect> = {};
  for (const name of names) {
    const declared = registry.find((candidate) => candidate.name === name)?.sideEffect;
    if (declared === "read" || declared === "write" || declared === "dual" || declared === "call") {
      values[name] = declared;
    }
  }
  return values;
}

interface CurrentExecutionResources {
  /** Registry tools plus tenant/domain declarative tools, de-duplicated by
   * executable name. Global registry definitions remain authoritative on a
   * collision. */
  realTools: RealTool[];
  declarativeTools: DeclarativeTool[];
  capabilityProviders: IntegrationCapabilityProvider[];
  /** Tenant-confirmed System Profile alias groups (System Profiles are the
   * only sanctioned synonym source for cross-name system matching). */
  systemAliasGroups: string[][];
  /** A3 — human-boundary confirmations pre-seeded from System Profiles marked
   * governance.humanBoundary:true (mode "all"), so such a system's identity-gap
   * is not re-asked every run. */
  systemProfileBoundaries: IntegrationHumanBoundary[];
}

class ExecutionResourcesUnavailableError extends Error {
  constructor() {
    super("execution resources unavailable");
    this.name = "ExecutionResourcesUnavailableError";
  }
}

/** Re-read every execution-bearing integration surface.  Design, sandbox and
 * finish all call this function so a configured/probed tool or runtime cannot
 * retain green evidence after it drifts. */
async function currentExecutionResources(ctx: BrainCtx): Promise<CurrentExecutionResources> {
  // Persisted/unit-test contexts created before the execution-resource ports
  // were introduced may not carry a `ports` object.  Treat those contexts as
  // having only their in-memory registry snapshot; production contexts still
  // fail closed when an explicitly configured port read rejects.
  const ports = ctx.ports;
  const [registryTools, declarativeTools, capabilityProviders, systemAliasGroups, boundarySystems] = await Promise.all([
    ports?.toolRegistry ? ports.toolRegistry.list() : Promise.resolve(ctx.realTools ?? []),
    ports?.tools ? ports.tools.list(ctx.domain) : Promise.resolve([]),
    ports?.integrationCapabilities ? ports.integrationCapabilities.list() : Promise.resolve([]),
    ports?.systemAliases ? ports.systemAliases.list() : Promise.resolve([]),
    ports?.systemHumanBoundaries ? ports.systemHumanBoundaries.list() : Promise.resolve([]),
  ]);
  const globalNames = new Set(registryTools.map((tool) => tool.name));
  const realTools = [
    ...registryTools,
    ...declarativeTools
      .filter((tool) => !globalNames.has(tool.name))
      .map(persistedToolAsRealTool),
  ];
  // mode:"all" is deliberate — a System Profile flagged humanBoundary treats the
  // WHOLE system as manually handled (both read & write roles). This is broader
  // than the per-(system,mode) run-time clarify path, but only ever affects PURE
  // identity gaps (tool-backed roles are excluded by applyIntegrationHumanBoundaries),
  // and execution/promotion gates still treat human_boundary as unresolved.
  const seededAt = Date.now();
  const systemProfileBoundaries: IntegrationHumanBoundary[] = boundarySystems.map((system) => ({
    system,
    mode: "all",
    actor: "system-profile",
    confirmedAt: seededAt,
  }));
  return { realTools, declarativeTools, capabilityProviders, systemAliasGroups, systemProfileBoundaries };
}

function executionResourcesUnavailable(scopeLabel: string) {
  const question = `${scopeLabel}需要的工具和连接配置清单刚才没有读到。请先确认 Agent Factory 的工具目录和配置服务可用，然后告诉我“已恢复，请重试”；如果你正在维护服务，也可以让我先暂停。`;
  return {
    ok: false as const,
    summary: `${scopeLabel}暂时不能继续：当前工具和连接配置清单不可用。没有可靠清单时不会生成、修改或部署代码。`,
    output: {
      next: "ask_user" as const,
      reason: "execution_resources_unavailable",
      question,
      missing: ["execution_resources_snapshot"],
    },
  };
}

/** Rebuild every spec's integration bindings from the current ontology and
 * current execution resources. Persisted `resolved` claims are never trusted
 * at sandbox/finish time. */
function refreshCurrentIntegrationBindings(
  ctx: BrainCtx,
  resources: CurrentExecutionResources,
  environment: "sandbox" | "production",
): void {
  if (!ctx.ontology) throw new Error("Ontology 未加载，无法复验集成绑定");
  const profileValidation = validateGeneratedSpecIntegrationProfiles({
    specs: ctx.specs,
    tools: resources.realTools,
    scope: {
      tenantId: ctx.ports?.factoryScope?.tenantId,
      tenantSlug: ctx.ports?.factoryScope?.tenantSlug,
      domainId: ctx.domain,
    },
    environments: [environment],
  });
  if (!profileValidation.ok) {
    throw new Error(profileValidation.issues.slice(0, 6).map((issue) => issue.message).join("；"));
  }
  const actions = new Map(ctx.ontology.actions.map((action) => [action.name, action]));
  for (const spec of ctx.specs) {
    if (spec.isSubAgent) continue;
    const action = actions.get(spec.actionName);
    if (!action) throw new Error(`agent ${spec.short} 的 action ${spec.actionName} 已不在当前 Ontology`);
    const selectedProfiles: Record<string, IntegrationProfile> = {};
    for (const toolName of spec.tools ?? []) {
      const tool = resources.realTools.find(
        (candidate) =>
          candidate.name === toolName ||
          (candidate.aliases ?? []).includes(toolName),
      );
      if (!tool || !toolRequiresConfirmedIntegrationProfile(tool)) continue;
      const profileRef = environment === "sandbox"
        ? spec.sandboxToolProfileRefs?.[toolName]
        : spec.toolProfileRefs?.[toolName];
      if (!profileRef) continue; // the pure validator above already reported this branch
      const profile = resolveIntegrationProfile(tool, profileRef, environment);
      if (profile) selectedProfiles[toolName] = profile;
    }
    const report = resolveIntegrationBindings(action, resources.realTools, {
      boundToolNames: spec.tools ?? [],
      toolConfigs: environment === "sandbox"
        ? (spec.sandboxToolConfigs ?? {})
        : (spec.toolConfigs ?? {}),
      capabilityProviders: resources.capabilityProviders,
      systemAliasGroups: resources.systemAliasGroups,
      toolProfiles: selectedProfiles,
      executionScope: {
        tenantId: ctx.ports?.factoryScope?.tenantId,
        tenantSlug: ctx.ports?.factoryScope?.tenantSlug,
        domainId: ctx.domain,
        environment,
      },
    });
    if (!report.ready) {
      const gaps = report.bindings
        .filter((binding) => binding.status !== "resolved")
        .slice(0, 6)
        .map((binding) => `${binding.requirement.system}/${binding.requirement.role}:${binding.status}(${binding.reason})`);
      throw new Error(`agent ${spec.short} 的当前集成能力未就绪：${gaps.join("；")}`);
    }
    spec.integrationRequirements = deriveIntegrationRequirements(action);
    spec.integrationBindings = report.bindings;
  }
  ctx.realTools = resources.realTools;
}

/** Capability coverage is authoritative for external boundaries; semantic
 * ranking only fills in internal transforms/utilities.  Put every concrete
 * candidate adapter from the binding report ahead of fuzzy recommendations so
 * auto-flooring cannot omit PostgreSQL/object-store/Allmeta simply because a
 * parser shares more name tokens with the action. */
function ontologyDeclaredExecutionTools(action: OntologyAction): string[] {
  const stepTools = analyzeExecutionPlanRequirement(action).ontologySteps
    .map((step) => step.tool)
    .filter((name): name is string => Boolean(name));
  const integration = action.integration
    && typeof action.integration === "object"
    && !Array.isArray(action.integration)
    ? action.integration as Record<string, unknown>
    : {};
  const integrationTools = Array.isArray(integration.systems)
    ? integration.systems.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return [];
        }
        const row = entry as Record<string, unknown>;
        const name = String(
          row.via_tool ?? row.viaTool ?? row.tool ?? "",
        ).trim();
        return name ? [name] : [];
      })
    : [];
  return [...new Set([...stepTools, ...integrationTools])];
}

function canonicalExecutionToolName(
  name: string,
  catalog: string[],
): string {
  const grounded = groundToolPicks([name], catalog);
  return grounded.unresolved.length === 0
    ? (grounded.resolved[0] ?? name)
    : name;
}

function canonicalizePlanExecutionTools(
  steps: PlanStep[],
  catalog: string[],
): PlanStep[] {
  return steps.map((step) => ({
    ...step,
    ...(step.tool
      ? { tool: canonicalExecutionToolName(step.tool, catalog) }
      : {}),
    ...(step.body
      ? { body: canonicalizePlanExecutionTools(step.body, catalog) }
      : {}),
  }));
}

function canonicalizeOntologyExecutionTools(
  action: OntologyAction,
  catalog: string[],
): OntologyAction {
  if (!action.action_steps?.length) return action;
  return {
    ...action,
    action_steps: action.action_steps.map((step) => {
      const raw = String(step.tool ?? "").trim();
      return raw
        ? {
            ...step,
            tool: canonicalExecutionToolName(raw, catalog),
          }
        : step;
    }),
  };
}

function executableToolSuggestions(
  action: OntologyAction,
  resources: CurrentExecutionResources,
): string[] {
  const integration = resolveIntegrationBindings(action, resources.realTools, {
    capabilityProviders: resources.capabilityProviders,
    systemAliasGroups: resources.systemAliasGroups,
  });
  const bindingTools = integration.bindings
    .map((binding) => binding.toolName)
    .filter((name): name is string => Boolean(name));
  const safeUtilities = rankRealTools(action, resources.realTools, 8)
    .filter((name) => !bindingTools.includes(name))
    .filter((name) => {
      const tool = resources.realTools.find((candidate) => candidate.name === name);
      return tool?.sideEffect === "read"
        && (tool.credentialEnv?.length ?? 0) === 0
        && !tool.capabilities?.some((capability) => capability.probeRequired);
    })
    .slice(0, 2);
  return [...new Set([
    ...ontologyDeclaredExecutionTools(action),
    ...(action.tool_use ?? []).filter(Boolean),
    ...bindingTools,
    ...safeUtilities,
  ])];
}

type HumanIntegrationCandidate = {
  kind: "tool" | "runtime";
  id: string;
  requirementId?: string;
  status?: string;
};

/** Project binding evidence into a stable, de-duplicated list suitable for an
 * ask_user choice. Ranking discovers candidates; it never chooses one. */
function humanIntegrationCandidates(report: IntegrationBindingReport): HumanIntegrationCandidate[] {
  const byIdentity = new Map<string, HumanIntegrationCandidate>();
  for (const binding of report.bindings) {
    for (const candidate of binding.selectionCandidates ?? []) {
      const item: HumanIntegrationCandidate = {
        kind: candidate.bindingKind,
        id: candidate.bindingId,
        requirementId: binding.requirement.id,
        status: "same_top_score",
      };
      byIdentity.set(`${item.kind}:${item.id}`, item);
    }
    if ((binding.bindingKind === "tool" || binding.bindingKind === "runtime") && binding.bindingId) {
      const item: HumanIntegrationCandidate = {
        kind: binding.bindingKind,
        id: binding.bindingId,
        requirementId: binding.requirement.id,
        status: binding.status,
      };
      byIdentity.set(`${item.kind}:${item.id}`, item);
    } else if (binding.toolName) {
      const item: HumanIntegrationCandidate = {
        kind: "tool",
        id: binding.toolName,
        requirementId: binding.requirement.id,
        status: binding.status,
      };
      byIdentity.set(`tool:${item.id}`, item);
    }
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
}

function askUserForIntegrationChoice(input: {
  actionName: string;
  reason: "integration_selection_required" | "ambiguous_integration_binding" | "rule_tool_selection_required";
  candidates: HumanIntegrationCandidate[];
  detail: string;
}): { ok: false; summary: string; output: Record<string, unknown> } {
  const labels = input.candidates.map((candidate) =>
    `${candidate.kind === "tool" ? "工具" : "运行时能力"}「${candidate.id}」`);
  const choices = labels.length ? labels.join("、") : "当前没有可验证的现成候选";
  const question = `动作「${input.actionName}」应该使用哪个真实连接方式？目前可选：${choices}。如果都不对，请告诉我实际由哪个系统或人工步骤完成，以及有没有可调用的接口；我不会替你随便选第一个。`;
  return {
    ok: false,
    summary: `${question} 需要你决定的原因是：${input.detail}。`,
    output: {
      next: "ask_user",
      reason: input.reason,
      action: input.actionName,
      question,
      candidates: input.candidates,
      choices: labels,
      resolution: ["design_agent.tools", "ontology.action.tool_use", "ontology.action.integration.profile_refs"],
    },
  };
}

function parseToolCapabilities(value: unknown): { ok: true; capabilities: ToolCapabilityDescriptor[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, capabilities: [] };
  if (!Array.isArray(value)) return { ok: false, error: "capabilities 必须是数组" };
  const capabilities: ToolCapabilityDescriptor[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `capabilities[${index}] 必须是对象` };
    const row = raw as Record<string, unknown>;
    const strings = (field: string): string[] | null => Array.isArray(row[field])
      ? [...new Set((row[field] as unknown[]).map(String).map((item) => item.trim()).filter(Boolean))]
      : null;
    const systems = strings("systems");
    const kinds = strings("kinds");
    const roles = strings("roles");
    const operations = strings("operations");
    const objectTypes = strings("objectTypes") ?? strings("object_types");
    const systemConfigKey = typeof row.systemConfigKey === "string"
      ? row.systemConfigKey.trim()
      : typeof row.system_config_key === "string"
        ? row.system_config_key.trim()
        : "";
    if (!systems?.length || !kinds?.length || !roles?.length) {
      return { ok: false, error: `capabilities[${index}] 必须显式声明非空 systems/kinds/roles` };
    }
    capabilities.push({
      systems,
      kinds,
      roles,
      ...(systemConfigKey ? { systemConfigKey } : {}),
      ...(operations?.length ? { operations } : {}),
      ...(objectTypes?.length ? { objectTypes } : {}),
      probeRequired: row.probeRequired === true || row.probe_required === true,
    });
  }
  return { ok: true, capabilities };
}

/** A declared config surface means the platform cannot silently invent a
 * tenant/domain configuration. Tools with no config schema/keys are explicit
 * platform-default tools and need no profile. */
export function toolRequiresConfirmedIntegrationProfile(tool: RealTool): boolean {
  const schema = tool.catalogDefinition?.configSchema;
  return (schema && Object.keys(schema).length > 0) || (tool.configKeys?.length ?? 0) > 0;
}

function parseToolConfigs(value: unknown, selectedTools: string[], realTools: RealTool[]): { ok: true; configs: Record<string, Record<string, unknown>> } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, configs: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "tool_configs 必须是 toolName→config 的对象" };
  const selected = new Set(selectedTools);
  const configs: Record<string, Record<string, unknown>> = {};
  for (const [toolName, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!selected.has(toolName)) return { ok: false, error: `tool_configs.${toolName} 不是本 agent 已选择的工具` };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: `tool_configs.${toolName} 必须是对象` };
    const tool = realTools.find((candidate) => candidate.name === toolName);
    const validation = validateIntegrationToolConfig(tool ?? { name: toolName }, raw, {
      rejectUnknownKeys: tool ? undefined : false,
    });
    if (!validation.valid) {
      return { ok: false, error: validation.issues.map((issue) => issue.message).join("；") };
    }
    configs[toolName] = validation.config;
  }
  return { ok: true, configs };
}

function rejectDirectDesignToolConfigs(value: unknown): { ok: true } | { ok: false; error: string } {
  if (value === undefined) return { ok: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "tool_configs 必须是 toolName→config 的对象" };
  if (Object.keys(value as Record<string, unknown>).length === 0) return { ok: true };
  return {
    ok: false,
    error: "tool_configs 已关闭：模型不能直接注入运行配置。请先用 confirm_integration_profile 把经过用户确认的非 secret 配置保存为 profile，再通过 tool_profiles 选择它。",
  };
}

/** Evidence requirement is derived from the reviewed execution boundary, not
 * an optional catalog hint. Keep this aligned with API registry discovery so
 * omitting capability.probeRequired can never opt an external/write tool out. */
function toolRequiresProbeEvidence(tool: RealTool): boolean {
  return tool.effectScope === "external"
    || tool.operation === "write"
    || tool.operation === "read_write"
    || tool.sideEffect === "write"
    || tool.sideEffect === "dual"
    || (tool.capabilities ?? []).some((capability) => capability.probeRequired === true);
}

function parseToolProfiles(
  value: unknown,
  selectedTools: string[],
  realTools: RealTool[],
  scope: IntegrationProfileExecutionScope,
  environment: "sandbox" | "production",
): { ok: true; configs: Record<string, Record<string, unknown>>; refs: Record<string, string>; profiles: Record<string, IntegrationProfile> } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, configs: {}, refs: {}, profiles: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "tool_profiles 必须是 toolName→profile key 的对象" };
  }
  const selected = new Set(selectedTools);
  const configs: Record<string, Record<string, unknown>> = {};
  const refs: Record<string, string> = {};
  const profiles: Record<string, IntegrationProfile> = {};
  for (const [toolName, rawRef] of Object.entries(value as Record<string, unknown>)) {
    if (!selected.has(toolName)) return { ok: false, error: `tool_profiles.${toolName} 不是本 agent 已选择的工具` };
    if (typeof rawRef !== "string" || !rawRef.trim()) return { ok: false, error: `tool_profiles.${toolName} 必须填写 profile key` };
    const tool = realTools.find((candidate) => candidate.name === toolName);
    if (!tool) return { ok: false, error: `工具 ${toolName} 不在当前真实 registry 中` };
    const profile = resolveIntegrationProfile(tool, rawRef.trim(), environment);
    if (!profile) {
      return { ok: false, error: `工具 ${toolName} 没有已确认的 ${environment} profile「${rawRef.trim()}」；请先让用户确认该环境的集成配置` };
    }
    const scopeIssues = integrationProfileScopeIssues(profile, tool, { ...scope, environment });
    if (scopeIssues.length) {
      return { ok: false, error: `profile ${profile.profileKey} 已失效：${scopeIssues.join("；")}` };
    }
    const validation = validateIntegrationToolConfig(tool, profile.config);
    if (!validation.valid) {
      return { ok: false, error: `profile ${profile.profileKey} 已失效：${validation.issues.map((issue) => issue.message).join("；")}` };
    }
    configs[toolName] = validation.config;
    refs[toolName] = profile.id;
    profiles[toolName] = profile;
  }
  return { ok: true, configs, refs, profiles };
}

type SelectedToolDeploymentEvidence = {
  ok: true;
  productionConfigs: Record<string, Record<string, unknown>>;
  productionRefs: Record<string, string>;
  productionProfiles: Record<string, IntegrationProfile>;
  sandboxConfigs: Record<string, Record<string, unknown>>;
  sandboxRefs: Record<string, string>;
  sandboxProfiles: Record<string, IntegrationProfile>;
  readiness: {
    authoringReady: true;
    sandboxReady: boolean;
    promotionReady: boolean;
    sandboxBlockers: string[];
    promotionBlockers: string[];
    missingSandboxProfiles: string[];
    missingProductionProfiles: string[];
    probeGaps: Array<{
      tool: string;
      /** Compatibility alias for sandboxReasons. */
      reasons: string[];
      sandboxReasons: string[];
      promotionReasons: string[];
      evidenceMode?: "live-probe" | "signed-fixture" | "runtime-record";
    }>;
  };
} | {
  ok: false;
  reason: string;
  question: string;
  missing: string[];
  details?: Record<string, unknown>;
};

/**
 * Stage-aware evidence shared by design/refine/helper paths. A selected tool's
 * identity and execution policy are authoring facts; profiles and probes are
 * execution facts. Missing execution facts therefore stay visible on the
 * draft but do not prevent code generation. sandbox_run and finish re-read and
 * enforce the appropriate environment, so this relaxation cannot promote an
 * unconfigured draft.
 */
function selectedToolDeploymentEvidence(input: {
  ctx: BrainCtx;
  actionName: string;
  requiredObjects: string[];
  selectedTools: string[];
  realTools: RealTool[];
  productionProfileRefs?: unknown;
  sandboxProfileRefs?: unknown;
}): SelectedToolDeploymentEvidence {
  const missingTools = input.selectedTools.filter((toolName) =>
    !input.realTools.some((tool) => tool.name === toolName || (tool.aliases ?? []).includes(toolName)));
  if (missingTools.length) {
    const question = `这些工具在当前真实工具目录里不存在：${missingTools.join("、")}。请先接入真实工具，或从工具目录中明确选择其它工具；我不会保存假工具名。`;
    return { ok: false, reason: "selected_tool_missing", question, missing: missingTools };
  }
  const scope: IntegrationProfileExecutionScope = {
    tenantId: input.ctx.ports?.factoryScope?.tenantId,
    tenantSlug: input.ctx.ports?.factoryScope?.tenantSlug,
    domainId: input.ctx.domain,
    environment: "production",
    actionName: input.actionName,
    requiredObjects: input.requiredObjects,
  };
  const productionResult = parseToolProfiles(
    input.productionProfileRefs,
    input.selectedTools,
    input.realTools,
    scope,
    "production",
  );
  const sandboxResult = parseToolProfiles(
    input.sandboxProfileRefs,
    input.selectedTools,
    input.realTools,
    scope,
    "sandbox",
  );
  const emptyProfiles = {
    configs: {} as Record<string, Record<string, unknown>>,
    refs: {} as Record<string, string>,
    profiles: {} as Record<string, IntegrationProfile>,
  };
  const production = productionResult.ok ? productionResult : emptyProfiles;
  const sandbox = sandboxResult.ok ? sandboxResult : emptyProfiles;

  const needsProfile = input.selectedTools.filter((toolName) => {
    const tool = input.realTools.find((candidate) => candidate.name === toolName);
    return Boolean(tool && (toolRequiresConfirmedIntegrationProfile(tool) || tool.catalogDefinition?.profileScope));
  });
  const missingProductionProfiles = needsProfile.filter((toolName) => !production.refs[toolName]);
  const missingSandboxProfiles = needsProfile.filter((toolName) => !sandbox.refs[toolName]);
  const probeGaps = input.selectedTools.flatMap((toolName) => {
    const tool = input.realTools.find((candidate) => candidate.name === toolName);
    if (!tool) return [{
      tool: toolName,
      reasons: ["tool_not_in_current_registry"],
      sandboxReasons: ["tool_not_in_current_registry"],
      promotionReasons: ["tool_not_in_current_registry"],
    }];
    // Remote disposable sandboxes replay every selected tool from an attested
    // cassette, including sandbox-local tools such as fs.readFromInbox.
    // Production live evidence remains required only for external/write-risk
    // surfaces.
    const promotionRequired = toolRequiresProbeEvidence(tool);
    const verifiedDefinitionHashes = new Set(tool.verifiedDefinitionHashes ?? []);
    const stagedTool = tool as RealTool & {
      productionVerifiedDefinitionHashes?: string[];
      probeEvidenceMode?: "live-probe" | "signed-fixture" | "runtime-record";
    };
    const productionVerifiedDefinitionHashes = new Set(
      stagedTool.productionVerifiedDefinitionHashes ?? [],
    );
    const sandboxExpectedHash = probeDefinitionHash(
      tool,
      sandbox.configs[toolName] ?? {},
      process.env,
    );
    const productionExpectedHash = probeDefinitionHash(
      tool,
      production.configs[toolName] ?? {},
      process.env,
    );
    const hasVerifiedEvidence = verifiedDefinitionHashes.size > 0;
    const currentDefinitionMatches = Boolean(
      sandboxExpectedHash && verifiedDefinitionHashes.has(sandboxExpectedHash),
    );
    const hasProductionEvidence = productionVerifiedDefinitionHashes.size > 0;
    const currentProductionDefinitionMatches = Boolean(
      productionExpectedHash
      && productionVerifiedDefinitionHashes.has(productionExpectedHash),
    );
    const safety = isWriteCapableSideEffect(tool.sideEffect)
      ? inspectWriteProbeSafety(
          tool.sideEffect,
          tool.catalogDefinition?.probeSafety ?? tool.declarativeDefinition?.probeSafety,
        )
      : undefined;
    const liveSafetyReasons = [
      ...(safety?.status === "needs_config" ? safety.missing : []),
      ...(safety && safety.status !== "ready" && safety.status !== "needs_config" ? ["probe_safety_invalid"] : []),
    ];
    const sandboxSafetyReasons = stagedTool.probeEvidenceMode === "signed-fixture"
      ? []
      : liveSafetyReasons;
    const sandboxReasons = [
      ...(!sandboxExpectedHash ? ["sandbox_probe_definition_unavailable"] : []),
      ...(!hasVerifiedEvidence ? ["probe_not_verified"] : []),
      ...(!currentDefinitionMatches ? ["probe_definition_changed"] : []),
      ...sandboxSafetyReasons,
    ];
    const promotionReasons = promotionRequired ? [
      ...(!productionExpectedHash ? ["production_probe_definition_unavailable"] : []),
      ...(!hasProductionEvidence ? ["live_probe_required_for_promotion"] : []),
      ...(!currentProductionDefinitionMatches ? ["production_probe_definition_changed"] : []),
      ...liveSafetyReasons,
    ] : [];
    return sandboxReasons.length || promotionReasons.length
      ? [{
          tool: toolName,
          reasons: sandboxReasons,
          sandboxReasons,
          promotionReasons,
          ...(stagedTool.probeEvidenceMode
            ? { evidenceMode: stagedTool.probeEvidenceMode }
            : {}),
        }]
      : [];
  });
  const sandboxBlockers = [
    ...(!sandboxResult.ok ? [`测试环境连接无效：${sandboxResult.error}`] : []),
    ...missingSandboxProfiles.map((tool) => `${tool} 缺少独立 sandbox profile`),
    ...probeGaps.filter((gap) => gap.sandboxReasons.length > 0)
      .map((gap) => `${gap.tool} 缺少当前安全 sandbox probe evidence`),
  ];
  const promotionOnlyBlockers = [
    ...(!productionResult.ok ? [`正式环境连接无效：${productionResult.error}`] : []),
    ...missingProductionProfiles.map((tool) => `${tool} 缺少 production profile`),
    ...probeGaps.filter((gap) => gap.promotionReasons.length > 0)
      .map((gap) => `${gap.tool} 缺少当前 definition/config 的 live probe，不能晋升`),
  ];

  return {
    ok: true,
    productionConfigs: production.configs,
    productionRefs: production.refs,
    productionProfiles: production.profiles,
    sandboxConfigs: sandbox.configs,
    sandboxRefs: sandbox.refs,
    sandboxProfiles: sandbox.profiles,
    readiness: {
      authoringReady: true,
      sandboxReady: sandboxBlockers.length === 0,
      promotionReady: sandboxBlockers.length === 0 && promotionOnlyBlockers.length === 0,
      sandboxBlockers,
      promotionBlockers: [...sandboxBlockers, ...promotionOnlyBlockers],
      missingSandboxProfiles,
      missingProductionProfiles,
      probeGaps,
    },
  };
}

type PlanCritiqueIssue = {
  severity: "high" | "med" | "low";
  problem: string;
  fix: string;
  [key: string]: unknown;
};

function parsePlanCritiqueIssues(value: unknown): PlanCritiqueIssue[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: PlanCritiqueIssue[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const issue = raw as Record<string, unknown>;
    const severity = issue.severity;
    const problem = typeof issue.problem === "string" ? issue.problem.trim() : "";
    const fix = typeof issue.fix === "string" ? issue.fix.trim() : "";
    if (
      (severity !== "high" && severity !== "med" && severity !== "low") ||
      !problem ||
      !fix
    ) {
      return null;
    }
    parsed.push({ ...issue, severity, problem, fix });
  }
  return parsed;
}

/** Strict parser for the blocking plan-review contract. An LLM response that
 * is valid JSON but not this schema is still a failed review; callers must not
 * turn it into `ok:true/issues:[]`. */
export function parsePlanCritiquePayload(value: unknown):
  | { ok: true; verdict: "ok" | "revise"; issues: PlanCritiqueIssue[] }
  | { ok: false; error: string } {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "review returned no JSON object" };
  }
  const raw = value as Record<string, unknown>;
  if (raw.verdict !== "ok" && raw.verdict !== "revise") {
    return { ok: false, error: "review verdict must be ok or revise" };
  }
  const issues = parsePlanCritiqueIssues(raw.issues);
  if (issues === null) {
    return { ok: false, error: "review issues do not match the required schema" };
  }
  return { ok: true, verdict: raw.verdict, issues };
}

/** Runtime validation for LLM review arrays. `chatJson<T>`'s generic only describes the desired
 * shape; it cannot make null, an object, or malformed rows safe at runtime. */
function parseReviewRows(
  value: unknown,
  requiredStrings: readonly string[],
  enums: Record<string, readonly string[]> = {},
): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new TypeError("LLM review returned no JSON array");
  return value.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new TypeError(`LLM review row #${index + 1} must be an object`);
    }
    const parsed = row as Record<string, unknown>;
    for (const field of requiredStrings) {
      if (typeof parsed[field] !== "string" || !(parsed[field] as string).trim()) {
        throw new TypeError(`LLM review row #${index + 1} requires a non-empty ${field}`);
      }
    }
    for (const [field, allowed] of Object.entries(enums)) {
      if (typeof parsed[field] !== "string" || !allowed.includes(parsed[field] as string)) {
        throw new TypeError(`LLM review row #${index + 1} has an invalid ${field}`);
      }
    }
    return parsed;
  });
}

function reviewFailure(stage: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error || "unknown LLM review failure");
  return `${stage}: ${detail.slice(0, 180)}`;
}

function parseIoSchema(raw: unknown): IoField[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => ({
      field: String(f.field ?? ""),
      type: String(f.type ?? "String"),
      description: f.description ? String(f.description) : undefined,
      source: f.source ? String(f.source) : undefined,
      ...(typeof f.required === "boolean" ? { required: f.required } : {}),
    }))
    .filter((f) => f.field);
}

/** Canonical payload fields for a set of events, read from the ontology's typed
 *  event_data — the AUTHORITATIVE contract (NOT the AI's guess). R1: agent I/O,
 *  the contract graph, and test-case payloads all ground in these. */
function eventFieldsOf(eventNames: string[], ont: DomainOntology | null): IoField[] {
  if (!ont) return [];
  const byName = new Map(ont.events.map((e) => [e.name, e]));
  const out: IoField[] = [];
  const seen = new Set<string>();
  for (const ev of eventNames) {
    for (const f of byName.get(ev)?.payload?.event_data ?? []) {
      if (!f?.name || seen.has(f.name)) continue;
      seen.add(f.name);
      out.push({
        field: f.name,
        type: f.type || "unknown",
        source: f.target_object ? `${f.target_object}.${f.name}` : undefined,
        description: `事件 ${ev} 的 payload 字段`,
        ...(typeof f.required === "boolean" ? { required: f.required } : {}),
      });
    }
  }
  return out;
}

/** Ground AI-authored I/O on the canonical event_data: canonical fields are the base
 *  (always present), the AI may enrich a field's description or add an extension field. */
function mergeFields(ai: IoField[], canonical: IoField[]): IoField[] {
  const out = new Map<string, IoField>();
  for (const f of canonical) out.set(f.field, f);
  for (const f of ai) {
    const base = out.get(f.field);
    out.set(f.field, base ? { ...base, description: f.description || base.description } : f);
  }
  return [...out.values()];
}

/** The canonical event payload contract per event, for contract reconciliation. */
function canonicalEventFields(ont: DomainOntology | null): Map<string, IoField[]> | undefined {
  if (!ont) return undefined;
  return new Map(ont.events.map((e) => [e.name, (e.payload?.event_data ?? []).map((f) => ({
    field: f.name,
    type: f.type || "unknown",
    source: f.target_object ?? undefined,
    ...(typeof f.required === "boolean" ? { required: f.required } : {}),
  }))]));
}

/** R5: per-DataObject read/write intent for an action, grounded in the ontology — reads from the
 *  trigger events' event_data (fields sourced from that object), writes from the emit events'
 *  state_mutations (impacted_properties). Spans target_objects ∪ any object touched by I/O. */
function deriveStateBindings(action: OntologyAction, ont: DomainOntology | null): Array<{ object: string; reads: string[]; writes: string[] }> {
  if (!ont) return [];
  const byEvent = new Map(ont.events.map((e) => [e.name, e]));
  const reads = new Map<string, Set<string>>();
  const writes = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, obj: string, field: string) => { if (!obj) return; (m.get(obj) ?? m.set(obj, new Set()).get(obj)!).add(field); };
  for (const t of action.trigger ?? []) for (const f of byEvent.get(t)?.payload?.event_data ?? []) if (f.target_object) add(reads, f.target_object, f.name);
  for (const e of action.triggered_event ?? []) for (const m of byEvent.get(e)?.payload?.state_mutations ?? []) for (const p of m.impacted_properties ?? []) add(writes, m.target_object, p);
  const objs = new Set<string>([...(action.target_objects ?? []), ...reads.keys(), ...writes.keys()]);
  return [...objs].map((o) => ({ object: o, reads: [...(reads.get(o) ?? [])], writes: [...(writes.get(o) ?? [])] }));
}

async function currentSandboxEvidenceSnapshot(
  ctx: BrainCtx,
  purpose: "sandbox" | "promotion",
): Promise<{
  fingerprint: string;
  cassetteRefs: Array<{ tool: string; path: string; definitionHash?: string; schemaHash?: string }>;
}> {
  // Re-read the selected tool catalogs at both sandbox and finish time. Volatile effectiveness
  // counters are intentionally excluded by sandboxEvidenceFingerprint; configuration/schema and
  // credential posture are not. A registry/store read failure therefore blocks evidence creation
  // instead of silently validating against a stale in-memory catalog.
  let resources: CurrentExecutionResources;
  try {
    resources = await currentExecutionResources(ctx);
  } catch {
    throw new ExecutionResourcesUnavailableError();
  }
  assertGeneratedSpecToolPoliciesCurrent(ctx.specs, resources.realTools);
  refreshCurrentIntegrationBindings(ctx, resources, purpose === "sandbox" ? "sandbox" : "production");
  const fingerprint = sandboxEvidenceFingerprint({
    domain: ctx.domain,
    specs: ctx.specs,
    ontology: ctx.ontology,
    testCases: ctx.testCases,
    testDataOverrides: ctx.testDataOverrides,
    boundaryEvents: ctx.boundaryEvents,
    testCoverageWaiver: ctx.testCoverageWaiver,
    realTools: resources.realTools,
    declarativeTools: resources.declarativeTools,
    integrationCapabilities: resources.capabilityProviders,
  });
  const selected = new Set<string>();
  const collectPlan = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const raw of steps) {
      if (!raw || typeof raw !== "object") continue;
      const step = raw as Record<string, unknown>;
      if (step.kind === "tool" && typeof step.tool === "string") selected.add(step.tool);
      if (step.kind === "foreach") collectPlan(step.body);
    }
  };
  for (const spec of ctx.specs) {
    for (const name of spec.tools ?? []) selected.add(name);
    collectPlan(spec.plan);
  }
  const cassetteRefs = resources.declarativeTools.flatMap((tool) => {
    if (!selected.has(tool.name)) return [];
    const evidence = tool.probeEvidence;
    const cassettePath = typeof evidence?.cassettePath === "string" ? evidence.cassettePath.trim() : "";
    if (!cassettePath) return [];
    return [{
      tool: tool.name,
      path: cassettePath,
      ...(tool.definitionHash ? { definitionHash: tool.definitionHash } : {}),
      ...(typeof evidence?.schemaHash === "string" ? { schemaHash: evidence.schemaHash } : {}),
    }];
  });
  return { fingerprint, cassetteRefs };
}

async function currentSandboxEvidenceFingerprint(ctx: BrainCtx): Promise<string> {
  return (await currentSandboxEvidenceSnapshot(ctx, "sandbox")).fingerprint;
}

// Exact Ontology rule identities used only for rule-leak review. Descriptions,
// logic text and arbitrary rule-ish keys are not identities and are ignored.
function ruleIdentifiers(ctx: BrainCtx): string[] {
  const ids = new Set<string>();
  for (const r of ctx.ontology?.rules ?? []) {
    const ro = r as Record<string, unknown>;
    for (const field of ["id", "name", "businessLogicRuleName", "title"] as const) {
      const value = ro[field];
      if (typeof value === "string" && value.trim()) ids.add(value.trim());
    }
  }
  return [...ids];
}

/** Does a prompt hardcode a specific ontology rule (by its name/identifier)? Domain-agnostic.
 *  Boundary-matched so a short id like "2-1" doesn't substring-collide inside "2-10" / "step 2-1". */
function promptEmbedsRule(promptText: string, ruleIds: string[]): boolean {
  return ruleIds.some((id) => {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      return new RegExp(`(?<![\\w-])${esc}(?![\\w-])`).test(promptText);
    } catch {
      return promptText.includes(id);
    }
  });
}

/** Score one spec across 4 orthogonal dimensions (each 0-100). */
function scoreSpec(spec: GeneratedAgentSpec, refineCount: number): ScoreDims {
  const requested = spec.tools.length + (spec.unresolvedTools?.length ?? 0);
  const toolResolution = requested === 0 ? 100 : Math.round((spec.tools.length / requested) * 100);
  const len = (spec.systemPrompt ?? "").trim().length;
  let promptRichness = spec.promptSource === "fallback" ? 35 : Math.min(100, 45 + Math.round(len / 18));
  if (spec.promptSource === "llm") promptRichness = Math.min(100, promptRichness + 5);
  const emits = spec.emit ?? [];
  let decisionCoverage: number;
  if (emits.length <= 1) decisionCoverage = 100;
  else {
    const text = `${spec.systemPrompt ?? ""} ${spec.decisionLogic ?? ""}`;
    const covered = emits.filter((e) => text.includes(e)).length;
    decisionCoverage = Math.round((covered / emits.length) * 100);
  }
  const refineHealth = refineCount === 0 ? 80 : refineCount <= 2 ? 100 : Math.max(40, 100 - (refineCount - 2) * 20);
  return { toolResolution, promptRichness, decisionCoverage, refineHealth };
}
const scoreTotal = (d: ScoreDims) => Math.round((d.toolResolution + d.promptRichness + d.decisionCoverage + d.refineHealth) / 4);
const grade = (t: number) => (t >= 85 ? "A" : t >= 70 ? "B" : t >= 55 ? "C" : "D");

function buildSpec(
  action: OntologyAction,
  domain: string,
  authored: { systemPrompt: string; tools: string[]; decisionLogic: string; reasoning: string; toolRationale: string },
  inputSchema: IoField[],
  outputSchema: IoField[],
  inputBindings: GeneratedInputBinding[],
): GeneratedAgentSpec {
  const isHuman = action.actor.includes("Human");
  const nameZh = (action.description ?? "").trim().split(/[。\n.]/)[0]?.slice(0, 18) || action.name;
  return {
    key: action.name,
    actionName: action.name,
    slug: `${domainPrefix(domain)}-${kebab(action.name)}`,
    short: `${pascal(action.name)}Agent`,
    domainId: domain,
    nameZh,
    kind: isHuman ? "simulated-human" : "llm",
    trigger: action.trigger ?? [],
    emit: action.triggered_event ?? [],
    tools: authored.tools,
    unresolvedTools: [],
    objects: action.target_objects ?? [],
    systemPrompt: authored.systemPrompt,
    userPrompt: action.user_prompt ?? "",
    designReasoning: authored.reasoning,
    toolRationale: authored.toolRationale,
    decisionLogic: authored.decisionLogic,
    steps: authored.tools.map((t, i) => ({ name: `step_${i + 1}`, description: `调用 ${t}`, tool: t })),
    ruleRefs: [],
    retries: 3,
    hitl: isHuman,
    confidence: 0.8,
    promptSource: "llm",
    inputSchema,
    inputBindings,
    outputSchema,
  };
}

const cardOf = (s: GeneratedAgentSpec) => ({ slug: s.slug, actionName: s.actionName, short: s.short, nameZh: s.nameZh, trigger: s.trigger, emit: s.emit, tools: s.tools, unresolved: s.unresolvedTools, isSubAgent: s.isSubAgent === true });
const designOf = (s: GeneratedAgentSpec) => ({ reasoning: s.designReasoning ?? "", systemPrompt: s.systemPrompt, toolRationale: s.toolRationale ?? "", decisionLogic: s.decisionLogic ?? "", decisionTables: s.decisionTables ?? [], code: s.generatedCode, codeSource: s.codeSource, codeExecuted: s.codeExecuted ?? false, probeReason: s.probeReason });

/** Render the spec's reference .ts and select exactly one execution owner.
 * Pure handlers may become CodeAct after compile/lint/probe. Plans that need
 * durable tool/invoke/foreach/error-policy semantics remain declarative; their
 * TypeScript is review material and is never used as a fallback execution path. */
async function renderExecutableCode(spec: GeneratedAgentSpec): Promise<void> {
  spec.generatedCode = specToAgentCode(spec);
  const ownership = generatedSpecExecutionOwnership(spec, spec.generatedCode);
  if (!ownership.codeActEligible) {
    spec.codeExecuted = false;
    spec.probeReason = `execution owner=${ownership.owner}: ${ownership.reason}`;
    return;
  }
  const code = spec.generatedCode ?? "";
  try {
    // #REDESIGN FU3 — reviewLoop stages: (1) COMPILE (real tsc), (2) LINT (AST security), (3) PROBE
    // (loads + exposes a callable handler). Only code that clears all three is graded truly executable
    // (CodeAct) — a compile-only pass used to let "compiles but no runnable handler" claim execution.
    const v = await validateAgentCode(code);
    const compileLintOk = v.ok && lintGeneratedToolCode(code).ok;
    if (compileLintOk) {
      const probe = await probeAgentModule(code);
      spec.codeExecuted = probe.loads;
      spec.probeReason = probe.loads ? undefined : probe.reason;
    } else {
      spec.codeExecuted = false;
    }
  } catch {
    spec.codeExecuted = false;
  }
}

// ── tools ───────────────────────────────────────────────────────────────────

function scopedOntologyReadiness(
  readiness: ReturnType<typeof analyzeOntologyReadiness>,
  actions: OntologyAction[],
): ReturnType<typeof analyzeOntologyReadiness> {
  const unique = (issues: OntologyReadinessIssue[]) => {
    const seen = new Set<string>();
    return actions
      .flatMap((action) => blockingIssuesForAction(issues, action))
      .filter((issue) => {
        const key = JSON.stringify(issue);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((issue) => ({ ...issue }));
  };
  const blocking = unique(readiness.blocking);
  const warnings = unique(readiness.warnings);
  return {
    ready: blocking.length === 0,
    blocking,
    warnings,
    issues: [...blocking, ...warnings],
    counts: {
      ...readiness.counts,
      actions: actions.length,
      actionSteps: actions.reduce(
        (total, action) => total + (action.action_steps?.length ?? 0),
        0,
      ),
      blocking: blocking.length,
      warnings: warnings.length,
    },
  };
}

function compactSentence(value: unknown, maxLength = 220): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const firstSentence = text.match(/^.*?[。！？!?](?:\s|$)/)?.[0]?.trim() ?? text;
  return firstSentence.length <= maxLength
    ? firstSentence
    : `${firstSentence.slice(0, maxLength - 1)}…`;
}

function ontologyReadinessGapKey(issue: OntologyReadinessIssue): string {
  const scope = [
    issue.domain && `domain=${issue.domain}`,
    issue.action && `action=${issue.action}`,
    issue.event && `event=${issue.event}`,
    issue.object && `object=${issue.object}`,
    issue.step && `step=${issue.step}`,
    issue.rule && `rule=${issue.rule}`,
    issue.link && `link=${issue.link}`,
    issue.field && `field=${issue.field}`,
  ].filter(Boolean);
  return [issue.code, ...scope].join("|");
}

const catalogRowIdentity = (
  row: Record<string, unknown>,
  fallback: string,
): { id: string; name?: string } => {
  const id = ["id", "rule_id", "ruleId", "name", "businessLogicRuleName"]
    .map((key) => row[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim() ?? fallback;
  const name = ["name", "businessLogicRuleName", "display_name", "displayName"]
    .map((key) => row[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim();
  return { id, ...(name && name !== id ? { name } : {}) };
};

function actionContractHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

const read_ontology: BrainTool = {
  name: "read_ontology",
  description:
    "读业务域本体：对象(DataObjects 属性)、动作(actor/trigger/triggered_event/description/inputs/outputs/is_rule_check/suggested_tools)、事件【含 payload 字段(event_data，权威 I/O 契约)+ state_mutations】、规则、事件流摘要(入口/终态/链路/闸口)、可复用技能库。这是你设计 agent 的事实地基——事件名/动作名/字段名/工具名都以这里为准，input_schema/output_schema 直接以事件的 payload 字段为准，不要脑补。",
  parameters: params({}),
  async execute(_args, ctx) {
    let ont: DomainOntology;
    try {
      const rootOntology = await ctx.ports.ontology.fetchOntology(ctx.domain);
      ont = applyFactoryGenerationOverlay(
        await resolveOntologyReferences(rootOntology, ctx.ports.ontology),
        ctx.generationDirective,
      );
    } catch (e) {
      // #NATIVE — 未命中【不写死话术、不写死分支】：把事实摆全（哪个域、底层错误、当前各来源
      // 合并后的可用域清单、平台支持上传本体 JSON 建新域），怎么向用户解释/引导由你推理决定。
      // 查找链路本身是分层的：租户上传的本体优先 → 本地 models/ → live Allmeta（错误文本里通常
      // 带来源信息）。唯一的硬约束：别编造本体、别不告知就擅自换域。
      let domains: Array<{ id: string; name?: string }> = [];
      try {
        domains = await ctx.ports.ontology.listDomains();
      } catch {
        // Keep the authoritative read failure fail-closed even when catalog
        // discovery is unavailable too; never replace it with a guessed domain.
      }
      const list = domains.slice(0, 40).map((d) => (d.name && d.name !== d.id ? `${d.id}(${d.name})` : d.id));
      const question = `现在读不到业务域「${ctx.domain}」的 Ontology。请确认 AllmetaOntology 服务和这个 domain 都可用；如果 domain 名写错了，请从当前可用列表里选一个。服务恢复后告诉我“已恢复，请重读”，我不会换到相似名字的 domain。`;
      return {
        ok: false,
        summary:
          `读不到域「${ctx.domain}」的本体。事实：底层错误=「${String((e as Error).message ?? e).slice(0, 180)}」；` +
          `当前可用域(${domains.length} 个)=${list.join("、") || "（任何来源都没有可用域）"}；` +
          `平台支持用户上传 actions/events/dataObjects/rules 的 JSON 文件创建新的业务域（聊天框 📎 上传即可，租户内立即可用）。` +
          `基于这些事实自行判断并回应用户——别编造本体，也别不打招呼就换域。`,
        output: {
          next: "ask_user",
          reason: "authoritative_ontology_unavailable",
          question,
          missing: ["authoritative_ontology"],
          requestedDomain: ctx.domain,
          error: String((e as Error).message ?? e).slice(0, 300),
          availableDomains: domains.map((d) => ({ id: d.id, name: d.name })),
          canUploadOntologyJson: true,
        },
      };
    }
    // #4: pin a signature on first read; flag drift on a re-read (the live Allmeta graph changed
    // under already-built specs) so the brain doesn't silently work against swapped ground truth.
    // #AUDIT-FIX(P2-03) — 数量 + 内容哈希：等量换血（改规则文本/字段但总数不变）也判为漂移。
    const sig = `${ont.actions.length}/${ont.events.length}/${ont.objects.length}/${ont.rules.length}#${ontologyContentHash(ont)}`;
    const drift = ctx.ontologySig && ctx.ontologySig !== sig ? `⚠ 本体自上次读取已变化（${ctx.ontologySig}→${sig}）：已设计的 specs 是基于旧本体的，请核对一致性。` : "";
    // #AUDIT-FIX(P2-04) — 严格源退化明示：本体是 Allmeta 失败后的薄 artifact（可能缺 events/objects/rules），
    // 告知 AI 别据此当完整本体设计/发布；需要完整本体时提示用户修复 Allmeta 连接或上传本体。
    const degradedNote = (ont as { degraded?: { from: string; reason: string } }).degraded
      ? `⚠ 本体为【退化源】：严格源 ${(ont as { degraded: { from: string } }).degraded.from} 读取失败，当前是本地薄 artifact，可能缺事件/对象/规则明细（原因：${(ont as { degraded: { reason: string } }).degraded.reason}）。据此设计要谨慎，别当完整本体；需要完整本体请修复严格源连接或让用户上传本体。`
      : "";
    ctx.ontologySig = sig;
    // #ONTOLOGY-HEAL — deterministic self-consistency normalization BEFORE the readiness gate may
    // fill an unambiguous primary_key already present as an id-like property, materialize a
    // same-name/type Event input binding only when every trigger proves the exact same path, and map
    // an Action output only to emitted Events that prove a unique same-name/type field. Event
    // topology is never unioned or inferred: producer/consumer/trigger/emit disagreements stay
    // visible blockers until the authoritative Ontology is updated and re-read. `revise_ontology`
    // may calculate a grounded proposal, but it never changes this working copy or pretends the
    // source was fixed.
    const heal = normalizeOntologySelfConsistency(ont);
    ont = heal.ontology;
    const healNote = heal.changes.length ? `🔧 已按 Ontology 内部唯一事实归一化 ${heal.changes.length} 处主键、Event 输入绑定或输出路由（事件拓扑未自动合并）。 ` : "";
    ctx.ontology = ont;
    const fullReadiness = analyzeOntologyReadiness(ont);
    // #KNOW-PACK (P1-A) — 新会话开局即受益：读到本体后按当前【归一化后】内容哈希预载历史沉淀的
    // 分析包。状态摘要 / 本体锚点 / 前置路由的歧义读数随 ctx 自动携带，即使本会话从不调
    // understand_ontology。哈希必须取 post-heal 的 ont（与 understand 的 curUnderstandSig 同源）——
    // 上面的 ctx.ontologySig 是另一个 pre-heal 的 counts#hash 字符串，不可用。
    if (!ctx.ontologyUnderstanding && ctx.ports?.domainInsights && process.env.FACTORY_DOMAIN_INSIGHTS !== "0") {
      try {
        const packSig = ontologyContentHash(ont);
        const pack = await ctx.ports.domainInsights.load(ctx.domain, packSig);
        if (pack) {
          ctx.ontologyUnderstanding = pack.digest;
          ctx.ontologyUnderstandingSig = packSig;
          ctx.ontologyUnderstandingMode = pack.mode;
          ctx.ontologyUnderstandingCoverage = pack.coverage;
          ctx.ontologyPerspectives = pack.perspectives;
          ctx.ontologyAmbiguityCount = pack.ambiguityCount ?? 0;
          ctx.emit({ t: "message", text: `🧠 本体未变化——已载入历史会话沉淀的领域分析包（${pack.mode === "deep" ? "四维深读" : "单跳"}${pack.perspectives ? ` · 业务视角 ${pack.perspectives.selected.map((l) => l.label).join("、")}` : ""}），understand_ontology 将直接复用。` });
        }
      } catch { /* advisory — 预载失败不影响 read_ontology */ }
    }
    if (heal.changes.length) ctx.emit({ t: "ontology.heal", changes: heal.changes, source: "auto" });
    // catalog = ontology tool_use ∪ any AI-authored persisted tools (Tool-Smith)
    let resources: CurrentExecutionResources;
    try {
      resources = await currentExecutionResources(ctx);
    } catch {
      return executionResourcesUnavailable(`业务域「${ctx.domain}」`);
    }
    const realTools = resources.realTools;
    ctx.realTools = realTools;
    ctx.toolCatalog = [...new Set([...buildToolCatalog(ont), ...realTools.map((t) => t.name)])];
    const allAgentActions = ont.actions.filter((a) => a.actor.includes("Agent"));
    const requestedActionNames = ctx.generationDirective
      ? new Set(ctx.generationDirective.requestedActionNames)
      : null;
    const agentActions = requestedActionNames
      ? allAgentActions.filter((action) =>
          requestedActionNames.has(action.name),
        )
      : allAgentActions;
    const readiness = requestedActionNames
      ? scopedOntologyReadiness(fullReadiness, agentActions)
      : fullReadiness;
    ctx.ontologyReadiness = readiness;
    // Resolve action→rule grounding only through exact action_steps rule IDs/names.
    // Prefixes, action/target text and semantic similarity are not evidence.
    const ruleRows = (ont.rules ?? []) as Array<Record<string, unknown>>;
    const ruleResolutionByAction = new Map(agentActions.map((action) => [
      action.name,
      resolveActionRuleReferences(action, ruleRows),
    ]));
    ctx.rulesByAction = Object.fromEntries(agentActions.map((action) => [
      action.name,
      ruleResolutionByAction.get(action.name)?.relevantRules ?? [],
    ]));
    const unresolvedRuleReferenceCount = [...ruleResolutionByAction.values()]
      .reduce((total, resolution) => total + resolution.unresolved.length, 0);
    const ruleResolutionNote = unresolvedRuleReferenceCount
      ? `⚠ ${unresolvedRuleReferenceCount} 条 action_steps 规则引用无法唯一解析；对应动作已标记 next=ask_user，确认准确 rule id/名称前不能设计。 `
      : "";
    // event-flow digest
    const graph = compileGraph(
      ctx.generationDirective ? agentActions : ont.actions,
      { domainId: ctx.domain },
    );
    const skills = ctx.ports.skills ? await ctx.ports.skills.list(ctx.domain) : [];
    ctx.emit({ t: "catalog", domain: ctx.domain, actions: ont.actions.length, events: ont.events.length, agentActions: agentActions.length });
    const scopeNote = requestedActionNames
      ? `本次范围 ${agentActions.length} / 全域 ${allAgentActions.length} 个 Agent Action`
      : `全域 ${allAgentActions.length} 个 Agent Action`;
    return {
      ok: true,
      summary: `${degradedNote ? degradedNote + " " : ""}${drift ? drift + " " : ""}${ruleResolutionNote}${healNote}本体已读：${ont.actions.length} 动作 · ${scopeNote} · ${ont.events.length} 事件 · ${ont.objects.length} 对象 · ${ont.rules.length} 规则 · 工具库 ${ctx.toolCatalog.length} 个 · 技能库 ${skills.length} 个（source=${ont.source}）。${readiness.ready ? `✅ 本次范围 Ontology 可执行性闸门通过（${readiness.warnings.length} 个非阻塞警告）——下一步 understand_ontology。` : `🛑 本次范围 Ontology 可执行性闸门未通过：${readiness.blocking.length} 个阻塞缺口、${readiness.warnings.length} 个警告。先用 inspect_action_readiness 看清范围内每个动作的真实缺口；revise_ontology 只能整理修订提案，不会修改工作副本或 Allmeta。需要修订时请 ask_user，并在 AllmetaOntology 更新后重新读取；只有动作切片本身已经就绪时才可继续 design_agent。`}`,
      output: {
        domain: ctx.domain,
        source: ont.source,
        ontology_hash: ontologyContentHash(ont),
        source_scope: {
          mode: ctx.generationDirective?.mode ?? "full_ontology",
          action_ids:
            ctx.generationDirective?.requestedActionIds ??
            allAgentActions.map((action) => action.id),
          action_names: agentActions.map((action) => action.name),
          selected_agent_actions: agentActions.length,
          all_agent_actions: allAgentActions.length,
        },
        domain_summary: {
          counts: {
            objects: ont.objects.length,
            actions: ont.actions.length,
            agentActions: allAgentActions.length,
            events: ont.events.length,
            rules: ont.rules.length,
            workflow: ont.workflow.length,
            // Only a count — the compiled edges themselves come from
            // query_links. This number is not grounds for any relationship claim.
            links: ont.links?.length ?? 0,
          },
          objects: ont.objects.map((object) => ({
            id: object.id,
            ...(object.name && object.name !== object.id ? { name: object.name } : {}),
          })),
          events: ont.events.map((event) => event.name),
          rules: ont.rules.map((rule, index) =>
            catalogRowIdentity(rule, `rule:${index + 1}`)),
          workflow: ont.workflow.map((item, index) =>
            catalogRowIdentity(item, `workflow:${index + 1}`)),
          event_flow: {
            entryEvents: graph.entryEvents,
            terminalEvents: graph.terminalEvents,
            branchActions: graph.branchActions,
            hitlActions: graph.hitlActions,
          },
          ...(ont.degraded ? { degraded: { ...ont.degraded } } : {}),
        },
        // Inventory only. Full inputs/outputs/steps/rules/integrations are
        // intentionally disclosed one Action at a time by read_action_contract.
        agentActions: allAgentActions.map((action) => ({
          id: action.id,
          name: action.name,
          actor: [...action.actor],
          trigger: [...action.trigger],
          triggered_event: [...action.triggered_event],
          description: compactSentence(action.description),
          selected: requestedActionNames
            ? requestedActionNames.has(action.name)
            : true,
          scope_status: requestedActionNames && !requestedActionNames.has(action.name)
            ? "excluded"
            : "selected",
        })),
        ontology_readiness: {
          ready: readiness.ready,
          counts: { ...readiness.counts },
          blocking: {
            count: readiness.blocking.length,
            gapKeys: readiness.blocking.map(ontologyReadinessGapKey),
          },
          warnings: {
            count: readiness.warnings.length,
            gapKeys: readiness.warnings.map(ontologyReadinessGapKey),
          },
        },
        tool_index: {
          count: realTools.length,
          tools: realTools.map((tool) => ({
            name: tool.name,
            ...(tool.category ? { category: tool.category } : {}),
            ...(tool.operation ? { operation: tool.operation } : {}),
            ...(tool.effectScope ? { effectScope: tool.effectScope } : {}),
            ...(tool.sandboxPolicy ? { sandboxPolicy: tool.sandboxPolicy } : {}),
          })),
          byAction: agentActions.map((action) => ({
            action: action.name,
            suggested: executableToolSuggestions(action, resources).slice(0, 12),
          })),
          runtimeCapabilities: resources.capabilityProviders.map((provider) => ({
            id: provider.id,
            status: provider.status,
          })),
        },
        skill_index: {
          count: skills.length,
          skills: skills.map((skill) => ({
            slug: skill.slug,
            name: skill.name,
            purpose: compactSentence(skill.purpose, 140),
          })),
        },
        progressive_disclosure: {
          nextTool: "read_action_contract",
          instruction:
            "在 design_agent 前，对本次 selected 的每个 Action 按需读取一次完整权威 contract；不要从 inventory 猜 inputs/outputs/steps/rules/integration。",
        },
      },
    };
  },
};

/** #LINK-GRAPH — read_ontology reports `links: <count>` to keep its payload small,
 * which meant the compiled typed relationship graph (the one thing that states how
 * Objects, Actions, Events and Rules actually connect) was fetched and then thrown
 * away. This tool hands the brain the real edges, filtered, so it can ground a
 * design in relationships instead of inferring them from names. */
const query_links: BrainTool = {
  name: "query_links",
  description:
    "【关系图查询】查本体编译出的真实关系边（object-fk / action-targets-object / event-carries-object / rule-references-object 等）。不带参数时给出关系类型分布、枢纽实体和事件链概览；带 node 时给出该节点的入边/出边。read_ontology 只报边的【总数】，设计前要靠这里看清对象之间到底怎么连、一个动作真正碰哪些对象、一个事件搬运什么数据。只读。",
  parameters: params({
    node: {
      type: "string",
      description:
        "可选。对象/动作/事件/规则的准确 id 或 name；给了就只返回与它相连的边",
    },
    kind: {
      type: "string",
      description: "可选。只看某一种关系类型，例如 object-fk",
    },
    direction: {
      type: "string",
      enum: ["in", "out", "both"],
      description: "可选。配合 node 使用，默认 both",
    },
    limit: {
      type: "number",
      description: "可选。返回边数上限，默认 60",
    },
  }),
  async execute(args, ctx) {
    if (!ctx.ontology) {
      return {
        ok: false,
        summary: "还没有 Ontology。请先调用 read_ontology；不会凭名字猜关系。",
        output: { reason: "ontology_not_loaded", next: "read_ontology" },
      };
    }
    const links = ctx.ontology.links ?? [];
    if (links.length === 0) {
      return {
        ok: true,
        summary:
          "这个域的来源没有提供编译好的关系图（links 为空）。对象之间的关联只能从 action 的 target_objects 和 event 的 payload 推断，不要当成已证实的外键关系。",
        output: { hasLinkGraph: false, links: [], next: "read_action_contract" },
      };
    }
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 60));
    const kindFilter = String(args.kind ?? "").trim();
    const nodeFilter = String(args.node ?? "").trim();
    const direction = ["in", "out", "both"].includes(String(args.direction))
      ? (String(args.direction) as "in" | "out" | "both")
      : "both";

    const matchesNode = (endpoint: { id?: string; name?: string }) =>
      endpoint.id === nodeFilter || endpoint.name === nodeFilter;
    const selected = links.filter((link) => {
      if (kindFilter && link.kind !== kindFilter) return false;
      if (!nodeFilter) return true;
      const from = matchesNode(link.from as { id?: string; name?: string });
      const to = matchesNode(link.to as { id?: string; name?: string });
      if (direction === "in") return to;
      if (direction === "out") return from;
      return from || to;
    });

    // A node filter that matches nothing is a real answer, not an empty page:
    // say so and name what the graph does contain, so the brain corrects the id
    // instead of quietly designing against a relationship that does not exist.
    if (nodeFilter && selected.length === 0) {
      const known = [
        ...new Set(
          links.flatMap((link) => [
            String((link.from as { id?: string }).id ?? ""),
            String((link.to as { id?: string }).id ?? ""),
          ]),
        ),
      ]
        .filter(Boolean)
        .slice(0, 40);
      return {
        ok: false,
        summary: `关系图里没有节点「${nodeFilter}」${kindFilter ? `（关系类型 ${kindFilter}）` : ""}。请用准确 id；不会按相似度替换。`,
        output: { reason: "unknown_node", node: nodeFilter, knownNodes: known },
      };
    }

    const edges = selected.slice(0, limit).map((link) => ({
      id: link.id,
      kind: link.kind,
      from: (link.from as { id?: string }).id ?? null,
      fromType: (link.from as { type?: string }).type ?? null,
      to: (link.to as { id?: string }).id ?? null,
      toType: (link.to as { type?: string }).type ?? null,
      ...(link.status ? { status: link.status } : {}),
    }));

    if (nodeFilter || kindFilter) {
      const byKind = new Map<string, number>();
      for (const link of selected) {
        byKind.set(link.kind, (byKind.get(link.kind) ?? 0) + 1);
      }
      const kindNote = [...byKind.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => `${kind} ×${count}`)
        .join("、");
      return {
        ok: true,
        summary: `${nodeFilter ? `「${nodeFilter}」` : ""}匹配 ${selected.length} 条边${selected.length > edges.length ? `（返回前 ${edges.length} 条）` : ""}：${kindNote}。`,
        output: {
          hasLinkGraph: true,
          node: nodeFilter || null,
          kind: kindFilter || null,
          direction,
          matched: selected.length,
          returned: edges.length,
          edges,
        },
      };
    }

    const analysis = analyzeOntologyStructure(ctx.ontology);
    return {
      ok: true,
      summary: `关系图 ${analysis.counts.links} 条边 / ${analysis.relationshipKinds.length} 种类型：${analysis.relationshipKinds
        .slice(0, 6)
        .map((k) => `${k.kind} ×${k.count}`)
        .join(
          "、",
        )}。枢纽：${analysis.hubs.slice(0, 4).map((h) => `${h.id}(${h.inbound + h.outbound})`).join("、") || "无"}。用 node 参数深入某个对象。`,
      output: {
        hasLinkGraph: true,
        counts: analysis.counts,
        relationshipKinds: analysis.relationshipKinds,
        hubs: analysis.hubs.slice(0, 12),
        isolatedEntities: analysis.isolatedEntities,
        eventChains: analysis.eventChains.slice(0, 8),
        externalSystems: analysis.externalSystems,
        gaps: analysis.gaps,
      },
    };
  },
};

/** Progressive disclosure for one selected Action. read_ontology keeps the
 * full Ontology server-side but exposes only inventories; this tool returns the
 * exact execution-bearing slice immediately before design. */
const read_action_contract: BrainTool = {
  name: "read_action_contract",
  description:
    "【单 Action 权威契约】按 read_ontology inventory 中的准确 Action.name，读取本次 selected 范围内一个 actor=Agent Action 的完整 inputs/outputs/action_steps/rules/integration/side_effects、关联 Event/Object 契约与 provenance/hash。只读，不创建 plan/spec、不探针、不部署。read_ontology 为了节省上下文只给摘要；提交 design_agent 前应对目标 Action 按需调用本工具，禁止从摘要猜字段或步骤。",
  parameters: params(
    {
      action: {
        type: "string",
        description: "read_ontology.agentActions 中 selected=true 的准确 Action.name",
      },
    },
    ["action"],
  ),
  async execute(args, ctx) {
    if (!ctx.ontology) {
      return {
        ok: false,
        summary: "还没有 Ontology。请先调用 read_ontology；不会凭 Action 名猜契约。",
        output: { reason: "ontology_not_loaded", next: "read_ontology" },
      };
    }
    const actionName = String(args.action ?? "").trim();
    const action = ctx.ontology.actions.find((candidate) => candidate.name === actionName);
    const allAgentActions = ctx.ontology.actions.filter((candidate) =>
      candidate.actor.includes("Agent"));
    if (!action) {
      return {
        ok: false,
        summary: `找不到 Action「${actionName}」。请使用 read_ontology.agentActions 中的准确 name；不会按相似度替换。`,
        output: {
          reason: "unknown_action",
          action: actionName,
          knownAgentActions: allAgentActions.map((candidate) => candidate.name),
        },
      };
    }
    if (!action.actor.includes("Agent")) {
      return {
        ok: false,
        summary: `Action「${actionName}」的 actor=${action.actor.join("、") || "未声明"}，不是 Agent 生成契约。`,
        output: {
          reason: "action_actor_not_agent",
          action: actionName,
          actor: [...action.actor],
        },
      };
    }
    const allowed = ctx.generationDirective?.requestedActionNames;
    if (allowed?.length && !allowed.includes(actionName)) {
      return {
        ok: false,
        summary: `Action「${actionName}」不在本次服务端锁定的生成范围内；不会读取或设计范围外动作。`,
        output: {
          reason: "action_outside_generation_scope",
          action: actionName,
          allowedActionNames: [...allowed],
        },
      };
    }

    const ruleResolution = resolveActionRuleReferences(
      action,
      (ctx.ontology.rules ?? []) as Array<Record<string, unknown>>,
    );
    const eventNames = new Set([
      ...(action.trigger ?? []),
      ...(action.triggered_event ?? []),
    ]);
    const objectNames = new Set(action.target_objects ?? []);
    const relatedEvents = ctx.ontology.events.filter((event) =>
      eventNames.has(event.name));
    const relatedObjects = ctx.ontology.objects.filter((object) =>
      objectNames.has(object.id) || objectNames.has(object.name));
    const contract = {
      action: structuredClone(action),
      rules: {
        relevant: structuredClone(ruleResolution.relevantRules),
        unresolved: structuredClone(ruleResolution.unresolved),
        explicitReferenceCount: ruleResolution.explicitReferenceCount,
        needsUserInput: ruleResolution.needsUserInput,
      },
      events: structuredClone(relatedEvents),
      objects: structuredClone(relatedObjects),
      integrationRequirements: deriveIntegrationRequirements(action),
      executionPlanRequirement: analyzeExecutionPlanRequirement(action),
    };
    const ontologyBlockers = blockingIssuesForAction(
      analyzeOntologyReadiness(ctx.ontology).blocking,
      action,
    );
    const sliceHash = actionContractHash(contract);
    return {
      ok: true,
      summary: `已读取 Action「${actionName}」的完整权威契约：${action.inputs?.length ?? 0} inputs · ${action.outputs?.length ?? 0} outputs · ${action.action_steps?.length ?? 0} steps · ${ruleResolution.relevantRules.length} resolved rules · ${deriveIntegrationRequirements(action).length} integrations。设计时以 contract 与 sliceHash 为准。`,
      output: {
        readOnly: true,
        provenance: {
          schema: "agent-factory-action-contract/v1",
          domainId: ctx.domain,
          ontologySource: ctx.ontology.source,
          ontologyHash: ontologyContentHash(ctx.ontology),
          actionId: action.id,
          actionName: action.name,
          selected: true,
          scopeMode: ctx.generationDirective?.mode ?? "full_ontology",
          authoritative: action.factoryProvenance ? false : true,
          ...(action.factoryProvenance
            ? { sessionOverlay: { ...action.factoryProvenance } }
            : {}),
          sliceHash,
        },
        readiness: {
          ontologyReady: ontologyBlockers.length === 0,
          ontologyBlockers: ontologyBlockers.map((issue) => ({
            key: ontologyReadinessGapKey(issue),
            code: issue.code,
            message: issue.message,
          })),
          rulesReady: !ruleResolution.needsUserInput,
        },
        contract,
      },
    };
  },
};

const create_plan: BrainTool = {
  name: "create_plan",
  description: "提交 BuildPlan：按事件链排序，每个 agent 的职责/触发/产出/候选工具/边界情况 + 跨 agent 注意点。会自检计划 vs 本体（未知动作、漏掉的 Agent 动作、未知工具）。设计前规划一次，发现计划错了可再调（version+1）。【范围】若服务端已给 actionIds/scenario generation scope，该范围就是本次完整验收全集，必须全部生成、测试、sandbox_run 并 finish；不得为未选的全域 Action 补齐。只有旧版无 generation scope、且用户临时要求部分设计稿时，才传 scope:\"partial\"+scope_reason 并走 save_draft。",
  parameters: params(
    {
      summary: { type: "string" },
      agents: { type: "array", items: { type: "object", properties: { actionName: { type: "string" }, role: { type: "string" }, triggerEvents: { type: "array", items: { type: "string" } }, emitEvents: { type: "array", items: { type: "string" } }, toolCandidates: { type: "array", items: { type: "string" } }, edgeCases: { type: "array", items: { type: "string" } } }, required: ["actionName", "role"] } },
      notes: { type: "array", items: { type: "string" } },
      scope: { type: "string", description: "full(默认)=按本体全量 Agent 动作交付；partial=用户明确只要其中一部分" },
      scope_reason: { type: "string", description: "scope=partial 时必填：用户原话/依据（如「只生成 createJD 的 function」）" },
    },
    ["summary", "agents"],
  ),
  async execute(args, ctx) {
    const version = (ctx.currentPlan?.version ?? 0) + 1;
    const serverScope = generationScopedAgentActionNames(ctx);
    const structuredScope = Boolean(ctx.generationDirective);
    const forcedPartial = false;
    const scope: "full" | "partial" =
      structuredScope
        ? "full"
        : forcedPartial || args.scope === "partial"
          ? "partial"
          : "full";
    const requestedScopeReason =
      typeof args.scope_reason === "string" && args.scope_reason.trim()
        ? args.scope_reason.trim()
        : undefined;
    const scopeReason = structuredScope
      ? `服务端 actionIds/scenario 生成范围：${serverScope.join("、")}`
      : requestedScopeReason;
    if (scope === "partial" && !scopeReason) {
      return { ok: false, summary: "scope=partial 需要 scope_reason（引用用户要求缩小范围的原话/依据）——范围收窄必须可追溯到用户意图，不能是 AI 自作主张。", output: { version: ctx.currentPlan?.version ?? 0 } };
    }
    const plan: BuildPlan = {
      summary: String(args.summary ?? ""),
      agents: Array.isArray(args.agents) ? (args.agents as Array<Record<string, unknown>>).map((a) => ({ actionName: String(a.actionName ?? ""), role: String(a.role ?? ""), triggerEvents: (a.triggerEvents as string[]) ?? [], emitEvents: (a.emitEvents as string[]) ?? [], toolCandidates: (a.toolCandidates as string[]) ?? [], edgeCases: (a.edgeCases as string[]) ?? [] })) : [],
      notes: (args.notes as string[]) ?? [],
      version,
      scope,
      ...(scopeReason ? { scopeReason } : {}),
    };
    ctx.currentPlan = plan;
    // self-validate vs ontology
    const warns: string[] = [];
    let missed: string[] = [];
    if (ctx.ontology) {
      const known = new Set(ctx.ontology.actions.map((a) => a.name));
      if (structuredScope && serverScope.length) {
        const allowed = new Set(serverScope);
        const outside = plan.agents
          .map((agent) => agent.actionName)
          .filter((actionName) => !allowed.has(actionName));
        if (outside.length) {
          ctx.currentPlan = null;
          return {
            ok: false,
            summary: `计划超出服务端生成范围：${[...new Set(outside)].join("、")}。本次只允许 ${serverScope.join("、")}。`,
            output: { allowedActions: serverScope },
          };
        }
        const omitted = serverScope.filter(
          (actionName) =>
            !plan.agents.some((agent) => agent.actionName === actionName),
        );
        if (omitted.length) {
          ctx.currentPlan = null;
          return {
            ok: false,
            summary: `计划没有覆盖本次选定的 Action：${omitted.join("、")}。`,
            output: { allowedActions: serverScope },
          };
        }
      }
      const agentActions = generationScopedAgentActionNames(ctx);
      const planned = new Set(plan.agents.map((a) => a.actionName));
      const unknown = plan.agents.map((a) => a.actionName).filter((n) => !known.has(n));
      missed = agentActions.filter((n) => !planned.has(n));
      if (unknown.length) warns.push(`计划里有本体没有的动作：${unknown.join("、")}`);
      // #SCOPE — a user-scoped partial plan treats uncovered actions as INTENT, not omission:
      // the old unconditional warning was the full-coverage bias that padded plans the user
      // never asked for. Full scope keeps the warning (a genuine omission signal).
      if (missed.length && scope !== "partial") warns.push(`还没规划的 Agent 动作：${missed.join("、")}`);
    }
    ctx.emit({ t: "plan", plan });
    ctx.planScope = { kind: scope, ...(scopeReason ? { reason: scopeReason } : {}), missedActions: missed };
    const scopeNote = structuredScope
      ? ` · 🎯 服务端本次验收全集 ${serverScope.length} 个 Action；全部通过测试与沙箱后走 finish`
      : scope === "partial"
      ? ` · 📌 部分范围（${scopeReason}）：未纳入 ${missed.length} 个动作属用户意图；交付走 save_draft，不走 finish`
      : "";
    return { ok: true, summary: `BuildPlan v${version}（${plan.agents.length} agent）${warns.length ? " · ⚠ " + warns.join("；") : ""}${scopeNote} · 设计前建议 critique_plan 让 AI 独立挑战这份分解`, output: { version, warnings: warns, scope, missedActions: missed } };
  },
};

// #KNOW-PACK (P1-A) — best-effort 写穿：store 故障绝不影响工具（run 自身的 ctx 缓存照常）。
// skeleton 永不落盘：无网关的确定性退化产物，重算免费；落盘会让一次故障毒化后续会话的查询。
async function saveDomainInsightPack(
  ctx: BrainCtx,
  pack: { sig: string; mode: "shallow" | "deep"; digest: string; coverage?: BrainCtx["ontologyUnderstandingCoverage"]; perspectives?: BrainCtx["ontologyPerspectives"]; ambiguityCount: number },
): Promise<void> {
  if (!ctx.ports?.domainInsights || process.env.FACTORY_DOMAIN_INSIGHTS === "0") return;
  try {
    await ctx.ports.domainInsights.save({ domain: ctx.domain, ontologySig: pack.sig, mode: pack.mode, digest: pack.digest, coverage: pack.coverage, perspectives: pack.perspectives, ambiguityCount: pack.ambiguityCount });
  } catch { /* advisory */ }
}

// understand_ontology — an EXPLICIT, AI-synthesized comprehension gate. After read_ontology dumps
// the raw graph, this makes the brain DIGEST it into a structured model (what to build, the event
// chain, rule gates, external handoffs, ambiguities to clarify) — real LLM reasoning, not a
// deterministic fold — so the design phase reasons over an understood model instead of "读了就忘",
// and the user can SEE that the AI understood + remembered. Answers 「我怎么知道 AI 分析好了并记住了」.
const understand_ontology: BrainTool = {
  name: "understand_ontology",
  description:
    "读完 read_ontology 后【先做一次显式理解+消化】再规划/设计：让 AI 把本体读懂的结论结构化输出——要造哪些 agent 及其职责、事件链怎么串、哪些是规则闸口、哪些产出是交给外部平台消费的「外部交接终态」、哪里有歧义/缺字段需要先 ask_user。结论会被记住贯穿后续设计。这是把『隐式读懂』变成『可见且被记住的理解』，create_plan 前调它。",
  parameters: params({ focus: { type: "string", description: "（可选）想重点理解的子问题" }, deep: { type: "boolean", description: "（可选）四维分治深读（objects/rules/actions/events 各派一位认知专家并行汇总）。是否深读由你判断：域大（规则多/对象多/动作多）、歧义重、或首次接触该域时建议 true；小域单跳即可" }, refresh: { type: "boolean", description: "（可选）true=忽略缓存强制重新理解。默认：本体内容未变化时直接复用已记住的理解" } }),
  async execute(args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    const ont = ctx.ontology;
    // #UNDERSTAND-CACHE — 本体没变就复用已记住的理解：四维深读一次 1~3 分钟、十几万 token，而
    // 理解本身随会话持久化。此前"继续"类追加消息每次都重烧全套深读。带 focus（聚焦新子问题）
    // 或 refresh=true 时照常重读；本体内容变了（哈希不同）自动失效。
    const curUnderstandSig = ontologyContentHash(ont);
    // #UNDERSTAND-FIDELITY — the content hash proves the ontology didn't change; it does NOT prove
    // the cached understanding is as DEEP as this call asks for. A cheap skeleton/single-hop read
    // used to stamp the same signature and then silently satisfy a later explicit deep:true, so the
    // four-dimension full-coverage analysis never ran and the replay carried no fidelity label.
    // A cache entry may only serve a request whose fidelity it actually meets.
    const cachedMode = ctx.ontologyUnderstandingMode ?? "shallow";
    // #PERSPECTIVES-FIDELITY — 镜头系统给深读缓存加了版本：ctx.ontologyPerspectives 的存在性标记
    // 「镜头感知」的深读（okCount 可以诚实为 0——诚实降级仍是镜头感知、可缓存；每轮重烧深读更糟）。
    // 镜头前的深读摘要（无此字段）不得静默满足镜头时代的显式 deep:true；开关关闭时退化为纯 mode 判断。
    const cacheMeetsRequest = args.deep === true
      ? cachedMode === "deep" && (!perspectivesEnabled() || ctx.ontologyPerspectives !== undefined)
      : true;
    if (
      args.refresh !== true && !args.focus && ctx.ontologyUnderstanding
      && ctx.ontologyUnderstandingSig === curUnderstandSig && cacheMeetsRequest
    ) {
      const cov = ctx.ontologyUnderstandingCoverage;
      // #PERSPECTIVES — 回放时如实重述理解里已含哪些业务视角结论（及其成败），不丢披露。
      const lensLabel = cachedMode === "deep" && ctx.ontologyPerspectives
        ? ` · 业务视角 ${ctx.ontologyPerspectives.selected.map((l) => l.label).join("、")}（${ctx.ontologyPerspectives.okCount}/${ctx.ontologyPerspectives.total} 成功）`
        : "";
      const fidelityLabel = (cachedMode === "deep"
        ? `四维分治深读${cov ? ` · ${cov.complete ? "逐条全量覆盖" : "⚠ 覆盖不完整"} ${cov.itemsAnalyzed}/${cov.itemsTotal} 项` : ""}`
        : cachedMode === "skeleton"
          ? "⚠ 确定性骨架（未经 LLM 分析，仅结构）"
          : "单跳理解（未做四维分治全量深读）") + lensLabel;
      return {
        ok: true,
        summary: `本体自上次理解后未变化——复用已记住的理解（${fidelityLabel}）。${cachedMode !== "deep" ? "要做全量深读传 deep=true；" : ""}要强制重读传 refresh=true；要聚焦新子问题传 focus。`,
        output: { mode: "cached", fidelity: cachedMode, understanding: ctx.ontologyUnderstanding, ...(cov ? { coverage: cov } : {}), ...(ctx.ontologyPerspectives ? { perspectives: ctx.ontologyPerspectives } : {}) },
      };
    }
    // #KNOW-PACK (P1-A) — ctx 缓存 miss → 跨会话分析包按内容哈希查询。保真纪律与上面的
    // #UNDERSTAND-FIDELITY / #PERSPECTIVES-FIDELITY 同形：浅包不满足 deep:true；无镜头深包在
    // 镜头开启时不满足显式 deep:true；refresh/focus 与关闭开关时完全旁路。查询失败=advisory。
    if (args.refresh !== true && !args.focus && ctx.ports?.domainInsights && process.env.FACTORY_DOMAIN_INSIGHTS !== "0") {
      try {
        const pack = await ctx.ports.domainInsights.load(ctx.domain, curUnderstandSig);
        const packMeets = pack
          && (args.deep !== true
            || (pack.mode === "deep" && (!perspectivesEnabled() || pack.perspectives !== undefined)));
        if (pack && packMeets) {
          ctx.ontologyUnderstanding = pack.digest;
          ctx.ontologyUnderstandingSig = curUnderstandSig;
          ctx.ontologyUnderstandingMode = pack.mode;
          ctx.ontologyUnderstandingCoverage = pack.coverage;
          ctx.ontologyPerspectives = pack.perspectives;
          ctx.ontologyAmbiguityCount = pack.ambiguityCount ?? 0;
          const pcov = pack.coverage;
          const lensNote = pack.perspectives ? ` · 业务视角 ${pack.perspectives.selected.map((l) => l.label).join("、")}（${pack.perspectives.okCount}/${pack.perspectives.total} 成功）` : "";
          const label = pack.mode === "deep"
            ? `四维分治深读${pcov ? ` · ${pcov.complete ? "逐条全量覆盖" : "⚠ 覆盖不完整"} ${pcov.itemsAnalyzed}/${pcov.itemsTotal} 项` : ""}${lensNote}`
            : "单跳理解（未做四维分治全量深读）";
          ctx.emit({ t: "reflect", kind: "understanding", lesson: `本体理解（跨会话复用 · ${label}）：${pack.digest.slice(0, 260)}${pack.digest.length > 260 ? "…" : ""}` });
          return {
            ok: true,
            summary: `本体内容与历史会话分析时一致——跨会话复用已沉淀的领域分析包（${label}），未重新消耗深读成本。${pack.mode !== "deep" ? "要做全量深读传 deep=true；" : ""}要强制重读传 refresh=true；要聚焦新子问题传 focus。`,
            output: { mode: "stored", fidelity: pack.mode, understanding: pack.digest, ...(pcov ? { coverage: pcov } : {}), ...(pack.perspectives ? { perspectives: pack.perspectives } : {}) },
          };
        }
      } catch { /* pack lookup is advisory — fall through to compute */ }
    }
    const agentActions = generationScopedAgentActions(ctx);
    const graph = compileGraph(
      generationAcceptanceOntology(ctx).actions,
      { domainId: ctx.domain },
    );
    // A structural skeleton always available — the deterministic floor under the LLM analysis, so
    // understand_ontology NEVER hard-fails (an LLM hiccup degrades to this rather than returning a
    // useless error that the brain then skips past).
    const skel = { domain: ctx.domain, agentsToBuild: agentActions.map((a) => a.name), eventChain: `入口 ${graph.entryEvents.join("、") || "—"} → 终态 ${graph.terminalEvents.join("、") || "—"}`, ruleGates: agentActions.filter(ontologyActionIsRuleGate).map((a) => a.name), externalHandoffs: [] as unknown[], ambiguities: [] as string[], risks: [] as string[] };
    const useSkeleton = (note: string) => {
      ctx.ontologyUnderstanding = JSON.stringify(skel);
      ctx.ontologyUnderstandingSig = curUnderstandSig;
      // #UNDERSTAND-FIDELITY — a structural floor, NOT an analysis: never let it satisfy deep:true.
      ctx.ontologyUnderstandingMode = "skeleton";
      ctx.ontologyUnderstandingCoverage = undefined;
      ctx.ontologyPerspectives = undefined; // #PERSPECTIVES — 非深读不得携带陈旧镜头声明
      ctx.ontologyAmbiguityCount = skel.ambiguities.length; // structural read finds none — record 0, don't leave stale
      ctx.emit({ t: "reflect", kind: "understanding", lesson: `本体理解（确定性骨架 · ${note}）：要造 ${skel.agentsToBuild.length} 个 agent；规则闸 ${skel.ruleGates.join("、") || "无"}；${skel.eventChain}。` });
      return { ok: true, summary: `已结构化理解本体（确定性骨架 · ${note}）：${skel.agentsToBuild.length} 个 agent，${skel.ruleGates.length} 个规则闸。`, output: skel };
    };
    if (!isGatewayConfigured()) return useSkeleton("未配网关");

    // ── v2 DEEP path：四维分治（认知专家轻通道，见 specialists.ts / 架构书 §4.5）──────────
    // 单跳消化大本体必然稀释（262 条规则在 v1 digest 里只剩 12 个名字）；超过阈值时按维度
    // fan out 四位专家（各拿本维度全量 + 全域概况），再由合成者 reduce 成整体理解。
    // 专家过半失败 → 诚实降级回 v1 单跳；再失败 → 确定性骨架。永不硬失败。
    // #NATIVE v3 — 【全面优先】：本体较大时默认自动四维分治深读（结果按内容签名缓存，一份本体只深读
    // 一次，是一次性成本）。这不是"每个动作规模阈值强制"，而是"大本体读一次就读透"；brain 仍可显式
    // deep=false 走快速单跳，或 deep=true 对小本体也强制深读。
    const large = ont.rules.length > 60 || ont.objects.length > 20 || ont.actions.length > 8;
    const deep = args.deep === true || (args.deep !== false && large);
    if (deep) ctx.emit({ t: "message", text: "🧠 深读分治启动：对象/规则/动作/事件 4 位认知专家并行分析中，每位专家会【自我复核并深化一轮】（大本体通常需要 1~3 分钟；期间每 ~15s 有心跳回执，不是卡住）。" });
    const scaleHint = "";
    if (deep) {
      ctx.emit({ t: "message", text: `🧠 本体较大（${ont.actions.length} 动作 · ${ont.rules.length} 规则 · ${ont.objects.length} 对象）——派 4 位认知专家按维度并行深读，各自初稿→自我复核深化…` });
      // Hand the actions expert the REAL registered tool names — its brief includes 「工具缺口」, which
      // is only decidable against the actual registry (it has no tool-calling channel of its own).
      const results = await runSpecialists(
        ctx,
        buildOntologySpecialistTasks(ont, { toolCatalog: (ctx.realTools ?? []).map((t) => t.name) }),
        { deepen: true },
      );
      const okCount = results.filter((r) => r.ok).length;
      if (okCount >= 2) {
        // ── #PERSPECTIVES — 第二梯队：业务视角镜头（选配→并行检视），结论并入同一次合成。
        // 结构四维立稳（okCount>=2）才起跑：镜头是补充读者，绝不救场失败的结构读。任何失败
        // 都不阻塞深读——选配失败回退默认三视角，镜头全败照常四维成立（诚实披露）。
        let lensResults: SpecialistResult[] = [];
        let selection: LensSelection | null = null;
        if (perspectivesEnabled()) {
          selection = await selectLenses(ont, results);
          ctx.emit({ t: "message", text: `🔭 业务视角深读：${selection.lenses.map((l) => l.label).join("、")}${selection.source === "fallback" ? "（视角选择降级——采用默认三视角）" : ""}——并行检视中…` });
          lensResults = await runSpecialists(ctx, buildLensTasks(ont, selection.lenses, results), {});
        }
        const lensOk = lensResults.filter((r) => r.ok).length;
        const understanding = await synthesizeUnderstanding([...results, ...lensResults], ont);
        if (understanding) {
          ctx.ontologyUnderstanding = understanding.slice(0, 10_000);
          ctx.ontologyUnderstandingSig = curUnderstandSig;
          ctx.ontologyUnderstandingMode = "deep";
          // 落账（显式赋值：镜头关闭时清掉旧状态，绝不携带上一次深读的镜头声明）。
          ctx.ontologyPerspectives = selection
            ? { selected: selection.lenses, okCount: lensOk, total: lensResults.length, source: selection.source }
            : undefined;
          const ambig: string[] = [];
          for (const r of [...results, ...lensResults]) {
            if (r.ok && r.output && typeof r.output === "object") {
              const a = (r.output as Record<string, unknown>).ambiguities;
              if (Array.isArray(a)) ambig.push(...(a as unknown[]).map(String));
            }
          }
          ctx.ontologyAmbiguityCount = ambig.length; // #AMBIGUITY-COUNT — data, so ask_first can actually route
          ctx.emit({ t: "reflect", kind: "understanding", lesson: `本体理解（四维分治 · ${okCount}/4 专家）：${understanding.slice(0, 260)}${understanding.length > 260 ? "…" : ""}` });
          // #FULL-DIMENSION — state the PROVABLE coverage. Each expert now receives its whole
          // dimension (batched when large) instead of a silently truncated slice, so "分析得全面"
          // is an auditable claim rather than an assurance.
          // Count what was ACTUALLY analyzed: a failed expert contributes 0, and a partially failed
          // batch set contributes only its surviving batches' items.
          const covered = results.filter((r) => r.ok).reduce((n, r) => n + (r.coverage?.itemsAnalyzed ?? r.coverage?.itemsTotal ?? 0), 0);
          const totalItems = results.reduce((n, r) => n + (r.coverage?.itemsTotal ?? 0), 0);
          const totalBatches = results.reduce((n, r) => n + (r.coverage?.batches ?? 0), 0);
          const oversized = results.reduce((n, r) => n + (r.coverage?.oversized ?? 0), 0);
          const complete = covered === totalItems;
          const coverageLine = `${complete ? "逐条全量覆盖" : "⚠ 覆盖不完整"} ${covered}/${totalItems} 项（${results.map((r) => `${r.role.replace(" 专家", "")} ${r.coverage?.itemsAnalyzed ?? r.coverage?.itemsTotal ?? 0}`).join(" · ")}；共 ${totalBatches} 批${complete ? "，无截断" : "，部分批次失败——结论不完整，可 refresh=true 重读"}）${oversized ? ` · ⚠ ${oversized} 项单条超长` : ""}`;
          // Retain the proof so a later cache replay restates it instead of dropping the disclosure.
          ctx.ontologyUnderstandingCoverage = { itemsAnalyzed: covered, itemsTotal: totalItems, batches: totalBatches, oversized, complete };
          // #KNOW-PACK — 写穿：深读产物落分析包（best-effort），下个会话开局即复用。
          await saveDomainInsightPack(ctx, { sig: curUnderstandSig, mode: "deep", digest: ctx.ontologyUnderstanding!, coverage: ctx.ontologyUnderstandingCoverage, perspectives: ctx.ontologyPerspectives, ambiguityCount: ambig.length });
          // #PERSPECTIVES — 镜头成败如实进 summary；覆盖率算术保持只看结构四维（镜头不做逐条覆盖声明）。
          const lensLine = selection
            ? (lensOk === 0
              ? "；⚠ 业务视角全部失败，本次理解仅含结构四维"
              : `；业务视角 ${lensOk}/${lensResults.length}（${selection.lenses.map((l) => l.label).join("、")}${selection.source === "fallback" ? "·默认三视角" : ""}）`)
            : "";
          return {
            ok: true,
            summary: `已完成四维分治深读（${okCount}/4 专家成功，理解已记住贯穿全程）· ${coverageLine}${lensLine}${ambig.length ? `；专家共标出 ${ambig.length} 处歧义，建议挑最关键的先 ask_user：${ambig.slice(0, 2).join("；")}` : "；无明显歧义，可 create_plan"}`,
            output: { mode: "deep", understanding, coverage: { itemsAnalyzed: covered, itemsTotal: totalItems, batches: totalBatches, oversized, complete, truncated: false }, specialists: results.map((r) => ({ role: r.role, ok: r.ok, summary: r.summary, coverage: r.coverage })), ambiguities: ambig.slice(0, 20), ...(selection ? { perspectives: { selected: selection.lenses, okCount: lensOk, total: lensResults.length, source: selection.source, specialists: lensResults.map((r) => ({ role: r.role, ok: r.ok, summary: r.summary })) } } : {}) },
          };
        }
      }
      ctx.emit({ t: "reflect", kind: "understanding", lesson: `四维分治未成（${okCount}/4 专家成功）——降级为单跳理解。` });
    }

    const digest = [
      `业务域：${ctx.domain}`,
      `要造 agent 的动作（actor=Agent，共 ${agentActions.length}）：\n${agentActions.map((a) => `· ${a.name}：${(a.description || "").slice(0, 110)} | 触发 ${a.trigger.join(",") || "—"} → 产出 ${a.triggered_event.join(",") || "—"}${ontologyActionIsRuleGate(a) ? " [结构化规则闸]" : ""}`).join("\n")}`,
      `事件流：入口 ${graph.entryEvents.join("、") || "—"} · 终态 ${graph.terminalEvents.join("、") || "—"} · 分支 ${graph.branchActions.join("、") || "—"}`,
      `对象：${ont.objects.map((o) => o.name).join("、") || "—"}`,
      // #FULL-RULES — feed EVERY rule (name + enforcement), not just 12: a single-pass read that only
      // saw 12 of N rules was the shallow "hardcoded-feel" default the user flagged.
      `规则（${ont.rules.length}，逐条）：${(ont.rules as Array<Record<string, unknown>>).map((r) => `${String(r.name ?? r.id ?? "")}${ruleEnforcementTag(r)}`).join("、") || "—"}`,
      args.focus ? `重点：${String(args.focus)}` : "",
    ].filter(Boolean).join("\n\n");
    const sys =
      "你是 agent 工厂的【本体分析师】。把这份业务域本体读懂、消化，输出结构化理解，供后续设计直接引用。只输出 JSON：" +
      '{"agentsToBuild":[{"action":string,"responsibility":string}],"eventChain":string(按事件把链路顺序讲清),"ruleGates":[string],"externalHandoffs":[{"event":string,"why":string}],"ambiguities":[string],"risks":[string]}。externalHandoffs=产出交给外部平台消费、算合法终态的事件；ambiguities=本体里不清楚/缺字段/需要用户补充的地方。不要任何其它文字。';
    // #JSON-FIX — was: greedy regex + maxTokens:1500. A 6-agent Chinese digest ≈1 token/char blew
    // the cap mid-JSON EVERY run → unbalanced slice → JSON.parse threw → deterministic skeleton
    // fallback («每次都这样»). chatJson = balanced extraction + truncation-aware bigger retry.
    const parsed = await chatJson<Record<string, unknown>>(sys, digest, { temperature: 0.3, maxTokens: 4000, signal: ctx.signal, models: modelChain("review"), purpose: "understand_ontology" });
    if (!parsed) return useSkeleton("LLM 两次尝试仍未产出完整 JSON，已回退");
    ctx.ontologyUnderstanding = JSON.stringify(parsed).slice(0, 10_000);
    ctx.ontologyUnderstandingSig = curUnderstandSig;
    // #UNDERSTAND-FIDELITY — a single-hop digest (names + clipped descriptions), NOT the四维分治
    // full-coverage read: it must never satisfy a later deep:true from cache.
    ctx.ontologyUnderstandingMode = "shallow";
    ctx.ontologyUnderstandingCoverage = undefined;
    ctx.ontologyPerspectives = undefined; // #PERSPECTIVES — 单跳理解不携带镜头声明
    const ambig = Array.isArray(parsed.ambiguities) ? (parsed.ambiguities as string[]) : [];
    ctx.ontologyAmbiguityCount = ambig.length; // #AMBIGUITY-COUNT — data, so ask_first can actually route
    // #KNOW-PACK — 写穿：单跳理解也值得跨会话复用（同哈希下 deep 包会升级覆盖它，反向被防降级挡住）。
    await saveDomainInsightPack(ctx, { sig: curUnderstandSig, mode: "shallow", digest: ctx.ontologyUnderstanding!, ambiguityCount: ambig.length });
    const ext = Array.isArray(parsed.externalHandoffs) ? (parsed.externalHandoffs as unknown[]) : [];
    const nBuild = Array.isArray(parsed.agentsToBuild) ? (parsed.agentsToBuild as unknown[]).length : 0;
    const gates = Array.isArray(parsed.ruleGates) ? (parsed.ruleGates as string[]) : [];
    ctx.emit({ t: "reflect", kind: "understanding", lesson: `本体理解：要造 ${nBuild} 个 agent；规则闸 ${gates.join("、") || "无"}；外部交接 ${ext.length} 处；${ambig.length ? `⚠ 待澄清 ${ambig.length} 处：${ambig.slice(0, 3).join("；")}` : "无明显歧义"}。` });
    return { ok: true, summary: `已显式理解并记住本体${ambig.length ? `；有 ${ambig.length} 处歧义，建议先 ask_user 再设计：${ambig.slice(0, 2).join("；")}` : "（无明显歧义，可 create_plan）"}${scaleHint}`, output: parsed };
  },
};

// capability_resolve — G1 能力解析门（支柱④「选型优先于制造」，附录 B）。understand 之后、
// create_plan 之前：对每个 actor=Agent 动作先查三面资产（舰队 functions / 技能库 / 本体声明工具），
// 输出「复用 / 组合 / 新造」决策表 + 新造形态判据。DETERMINISTIC（无 LLM 调用）：命中靠名称
// 规整重合 + 触发/产出事件交集，结论落 ctx.capabilityResolution（折叠幸存），create_plan 据此
// 少造重复轮子。舰队端口未接线时诚实说明（跳过该面，绝不猜）。
const capability_resolve: BrainTool = {
  name: "capability_resolve",
  description:
    "understand_ontology 之后、create_plan 之前调用：能力解析——先查已有资产再决定造什么。对每个 actor=Agent 动作检查 ① 舰队已交付的 functions（同名/同触发同产出 → 可复用或组合）② 技能库 SKILLS（方法可注入）③ Ontology 明确声明的 tool、integration 与执行步骤。输出每个动作的「复用/组合/新造」决策表；外部执行面只按结构化声明标成待绑定，后续再从 tool/runtime/event 候选中解析，绝不从描述关键词猜接口。结论会被记住贯穿设计（折叠不丢）。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology（建议也先 understand_ontology）。" };
    const agentActions = generationScopedAgentActions(ctx);
    const fleet = ctx.ports.fleet ? await ctx.ports.fleet.list() : null;
    const skills = ctx.ports.skills ? await ctx.ports.skills.list(ctx.domain) : [];
    const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "");
    // CJK 双字重合（沿用 report-jobs 的 stage 匹配思路）：技能面向中文名/用途，动作名是 camelCase，
    // 所以拿动作【描述】与技能 名称+用途 做双字命中。
    const cjkHit = (a: string, b: string): boolean => {
      const na = norm(a);
      const nb = norm(b);
      if (!na || !nb) return false;
      for (let i = 0; i < nb.length - 1; i++) {
        const bi = nb.slice(i, i + 2);
        if (/[一-鿿]{2}/.test(bi) && na.includes(bi)) return true;
      }
      return false;
    };
    const rows = agentActions.map((a) => {
      const an = norm(a.name);
      const fleetMatches = (fleet ?? [])
        .filter((f) => f.enabled !== false)
        .filter((f) => {
          const names = [f.kebabId, f.name, f.title ?? ""].map(norm).filter(Boolean);
          const nameHit = names.some((n) => n.includes(an) || an.includes(n));
          const flowHit = (f.trigger ?? []).some((t) => a.trigger.includes(t)) && (f.emit ?? []).some((e) => a.triggered_event.includes(e));
          return nameHit || flowHit;
        })
        .slice(0, 4);
      // 人读名字优先（RAAS 老 workflow 的 kebabId 是数字编号）+ G2 生产战绩内联：
      // 复用一个生产上正在翻车的 agent，必须在选型时当场看见。
      const fleetHits = fleetMatches.map((f) => {
        const label = f.name || f.title || f.kebabId;
        const stat = f.prodRuns ? `·生产${f.prodRuns}次${f.prodFailRate ? `${Math.round(f.prodFailRate * 100)}%失败${f.prodFailRate >= 0.5 ? "⚠" : ""}` : "0失败"}` : "";
        return `${label}${stat}`;
      });
      const skillHits = skills
        .filter((sk) => cjkHit(`${a.description ?? ""}${a.name}`, `${sk.name}${sk.purpose ?? ""}`))
        .map((sk) => sk.name)
        .slice(0, 3);
      const integrationRequirements = deriveIntegrationRequirements(a);
      const executionRequirement = analyzeExecutionPlanRequirement(a);
      // Shape comes only from executable Ontology facts. An integration may be
      // satisfied by a tool, runtime provider, or event boundary; description
      // prose is not authority to invent one. Unstructured instructions remain
      // an explicit human/Ontology clarification instead of a guessed adapter.
      const makeForm = (a.tool_use ?? []).length
        ? "agent+tool"
        : integrationRequirements.length
          ? "agent+待绑定执行面"
          : executionRequirement.unstructuredInstruction
            ? "agent+需确认执行面"
            : "agent";
      const decision = fleetHits.length ? "复用/组合" : "新造";
      return {
        action: a.name,
        decision,
        fleetHits,
        skillHits,
        declaredTools: a.tool_use ?? [],
        integrationRequirements: integrationRequirements.map((requirement) => ({
          id: requirement.id,
          system: requirement.system,
          role: requirement.role,
          kind: requirement.kind,
        })),
        executionReasons: executionRequirement.reasons,
        makeForm: decision === "新造" ? makeForm : undefined,
      };
    });
    const reuse = rows.filter((r) => r.decision === "复用/组合");
    const fresh = rows.filter((r) => r.decision === "新造");
    const line = (r: (typeof rows)[number]) =>
      `${r.action}→${r.decision}${r.fleetHits.length ? `(舰队:${r.fleetHits.join("/")})` : ""}${r.skillHits.length ? `(技能:${r.skillHits.join("/")})` : ""}${r.makeForm && r.makeForm !== "agent" ? `(${r.makeForm})` : ""}`;
    ctx.capabilityResolution = rows.map(line).join("；").slice(0, 1600);
    const fleetNote = fleet === null ? "（舰队目录未接线——复用面跳过，仅按技能/工具面解析）" : `舰队 ${fleet.length} 个 functions`;
    ctx.emit({ t: "reflect", kind: "capability", lesson: `能力解析：${reuse.length} 个动作可复用/组合、${fresh.length} 个需新造（${fleetNote}；技能库 ${skills.length}）。${reuse.length ? `复用候选：${reuse.map((r) => `${r.action}←${r.fleetHits.join("/")}`).join("；").slice(0, 300)}` : ""}` });
    return {
      ok: true,
      summary: `能力解析完成：${reuse.length} 复用/组合 · ${fresh.length} 新造${fleet === null ? "（舰队面未接线）" : ""}。create_plan 时：复用项不要重复设计（在计划里注明沿用），新造项按形态判据造。`,
      output: { rows, fleetWired: fleet !== null, skillCount: skills.length },
    };
  },
};

// analyze_with_code — G4 系统 A 的即席 CodeAct（附录 B）：LLM 数不清 262 条规则的分布，
// 代码一趟循环就数清。大脑亲笔写一小段 JS 分析代码，AST 安审 + 全局遮蔽 + 3s 超时后
// 在纯计算沙盒里真跑（input = 本体 + 当前规格，只读副本；无 I/O 无网络无模块系统）。
const analyze_with_code: BrainTool = {
  name: "analyze_with_code",
  description:
    "【即席代码分析】需要精确统计/交叉核对/图计算时（如：规则按阶段分布、事件字段对齐矩阵、哪些动作的产出没人消费），写一小段 JS 真跑，别靠心算。精确代码契约：函数体形式；只读 `input` 的键固定为 {ontology:{actions,agentActions,events,rules,objects}, specs:[{actionName,slug,trigger,emit,tools}]}，其中 agentActions 是 actions 中 actor 包含 Agent 的派生别名；必须 `return` 一个 JSON 可序列化的结果。禁 import/require/fetch/process/eval（安审会驳回）。适合确定性计算；需要语义判断的用认知专家（understand/critique 自带）。",
  parameters: params(
    {
      purpose: { type: "string", description: "这段代码要回答什么问题（一句话）" },
      code: { type: "string", description: "JS 函数体：用 input，return 结果。例：const byStage={}; for(const r of input.ontology.rules){const k=r.specificScenarioStage||'未标注'; byStage[k]=(byStage[k]||0)+1;} return byStage;" },
    },
    ["purpose", "code"],
  ),
  async execute(args, ctx) {
    if (!ctx.ontology) {
      return {
        ok: false,
        summary: "还没有可分析的 Ontology。请先调用 read_ontology；工厂不会拿 null 或猜出来的数据跑分析。",
      };
    }
    const purpose = String(args.purpose ?? "").trim() || "代码分析";
    const code = String(args.code ?? "");
    ctx.emit({ t: "subagent.start", task: `认知专家 · 代码分析（${purpose.slice(0, 24)}）`, role: "代码分析专家" });
    const actions = ctx.ontology.actions;
    const input = {
      ontology: {
        actions,
        agentActions: generationScopedAgentActions(ctx),
        events: ctx.ontology.events,
        rules: ctx.ontology.rules,
        objects: ctx.ontology.objects,
      },
      specs: ctx.specs.map((s) => ({ actionName: s.actionName, slug: s.slug, trigger: s.trigger, emit: s.emit, tools: s.tools })),
    };
    const r = await runInlineAnalysis(code, input, { timeoutMs: 3000 });
    const summary = r.ok
      ? `代码分析（${purpose}）完成：${JSON.stringify(r.result).slice(0, 400)}`
      : `代码分析（${purpose}）失败：${r.error}`;
    ctx.emit({ t: "subagent.done", task: `认知专家 · 代码分析（${purpose.slice(0, 24)}）`, summary: r.ok ? `⚙ ${purpose} · ${r.durationMs}ms` : `✗ ${r.error?.slice(0, 80)}` });
    return { ok: r.ok, summary, output: { purpose, result: r.result ?? null, error: r.error, durationMs: r.durationMs } };
  },
};

/** Build one action's read-only readiness report from an immutable Ontology/action
 * and one shared execution-resource snapshot. Keeping this calculation outside the
 * model-facing tools guarantees that the single-action and all-action views apply
 * exactly the same gates. */
function actionReadinessFromSnapshot(
  action: OntologyAction,
  ctx: BrainCtx,
  readiness: ReturnType<typeof analyzeOntologyReadiness>,
  resources: CurrentExecutionResources,
) {
  // One global issue may affect multiple Action slices. Clone per report so
  // aggregate-tool serialization does not mistake repeated object identity for
  // a circular reference and redact evidence from later Actions.
  const ontologyBlockers = blockingIssuesForAction(readiness.blocking, action)
    .map((issue) => ({ ...issue }));
  const ruleResolution = resolveActionRuleReferences(
    action,
    (ctx.ontology?.rules ?? []) as Array<Record<string, unknown>>,
  );
  const declaredTools = [...new Set((action.tool_use ?? []).map(String).map((value) => value.trim()).filter(Boolean))];
  // #TOOLUSE-AS-SUGGESTION (parity with design_agent) — tool_use[] is a SUGGESTION list authored
  // against whatever tools existed then; the AUTHORITATIVE requirement is integration.systems[].
  // Ground the declared names, keep only granted+policy-complete ones, and let pure capability
  // discovery supply the granted transport for every requirement the grants don't cover. An
  // ungranted suggestion is a reported SUBSTITUTION, not an authoring blocker — design_agent
  // substitutes exactly the same way, and the two authorities must not disagree.
  const groundedDeclared = declaredTools.map((name) => ({
    declared: name,
    tool: resources.realTools.find((candidate) =>
      candidate.name === name || (candidate.aliases ?? []).includes(name)),
  }));
  const resolvedDeclaredNames = [...new Set(groundedDeclared
    .map((entry) => entry.tool?.name)
    .filter((value): value is string => Boolean(value)))];
  const declaredPolicies = selectedToolPolicies(resolvedDeclaredNames, resources.realTools);
  const grantedDeclaredTools = resolvedDeclaredNames.filter((name) => !declaredPolicies.missing.includes(name));
  const missingDeclaredTools = declaredTools.filter((name) => {
    const entry = groundedDeclared.find((candidate) => candidate.declared === name);
    return !entry?.tool || declaredPolicies.missing.includes(entry.tool.name);
  });
  const isGate = ontologyActionIsRuleGate(action);
  const discoveryReport = resolveIntegrationBindings(action, resources.realTools, {
    capabilityProviders: resources.capabilityProviders,
    systemAliasGroups: resources.systemAliasGroups,
  });
  const uniqueDiscoveredTools = [...new Set(discoveryReport.bindings
    .filter((binding) => !binding.selectionRequired)
    .map((binding) => binding.toolName ?? (binding.bindingKind === "tool" ? binding.bindingId : undefined))
    .filter((value): value is string => Boolean(value)))];
  if (isGate && !uniqueDiscoveredTools.some((name) => {
    const tool = resources.realTools.find((candidate) => candidate.name === name);
    return Boolean(tool && toolReadsRulebase(tool));
  })) {
    const soleRuleCandidates = resources.realTools.filter(toolReadsRulebase).map((tool) => tool.name);
    if (soleRuleCandidates.length === 1) uniqueDiscoveredTools.push(soleRuleCandidates[0]!);
  }
  const effectiveTools = [...new Set([...grantedDeclaredTools, ...uniqueDiscoveredTools])];
  const integrationReportRaw = resolveIntegrationBindings(action, resources.realTools, {
    ...(effectiveTools.length ? { boundToolNames: effectiveTools } : {}),
    capabilityProviders: resources.capabilityProviders,
    systemAliasGroups: resources.systemAliasGroups,
  });
  // #HUMAN-BOUNDARY — confirmed manual boundaries stop counting as identity gaps (authoring may
  // proceed); the report's `ready` stays false so sandbox/promotion readiness is untouched.
  const integrationReport = {
    ...integrationReportRaw,
    bindings: applyIntegrationHumanBoundaries(integrationReportRaw.bindings, [
      ...(ctx.integrationHumanBoundaries ?? []),
      ...resources.systemProfileBoundaries,
    ]),
  };
  const candidateToolNames = new Set<string>(effectiveTools);
  for (const binding of integrationReport.bindings) {
    if (binding.toolName) candidateToolNames.add(binding.toolName);
  }
  const candidateTools = [...candidateToolNames]
    .map((name) => resources.realTools.find((tool) => tool.name === name))
    .filter((tool): tool is RealTool => Boolean(tool));
  const requiredObjects = [...new Set(
    deriveIntegrationRequirements(action).flatMap((requirement) => requirement.objectTypes),
  )];
  const environments = ["sandbox", "production"] as const;
  const profileTools = candidateTools.map((tool) => {
    const required = toolRequiresConfirmedIntegrationProfile(tool)
      || Boolean(tool.catalogDefinition?.profileScope);
    const profiles = (tool.integrationProfiles ?? []).map((profile) => {
      const config = validateIntegrationToolConfig(tool, profile.config);
      const scopeIssues = integrationProfileScopeIssues(profile, tool, {
        tenantId: ctx.ports?.factoryScope?.tenantId,
        tenantSlug: ctx.ports?.factoryScope?.tenantSlug,
        domainId: ctx.domain,
        environment: profile.environment,
        actionName: action.name,
        requiredObjects,
      });
      return {
        id: profile.id,
        profileKey: profile.profileKey,
        environment: profile.environment,
        confirmedAt: profile.confirmedAt,
        ready: config.ready && scopeIssues.length === 0,
        resolvedConfig: config.config,
        missingConfigKeys: config.missingConfigKeys,
        invalidConfigKeys: config.invalidConfigKeys,
        missingEnvRefs: config.missingEnvRefs,
        scopeIssues,
      };
    });
    const byEnvironment = environments.map((environment) => {
      const validProfiles = profiles.filter((profile) => profile.environment === environment && profile.ready);
      return {
        environment,
        required,
        ready: !required || validProfiles.length === 1,
        selectionRequired: required && validProfiles.length > 1,
        selectedConfig: validProfiles.length === 1
          ? validProfiles[0]!.resolvedConfig
          : undefined,
        availableProfileRefs: validProfiles.map((profile) => ({ id: profile.id, profileKey: profile.profileKey })),
      };
    });
    return {
      tool: tool.name,
      required,
      ready: byEnvironment.every((gate) => gate.ready),
      environments: byEnvironment,
      profiles,
    };
  });
  const profileGate = {
    ready: profileTools.every((tool) => tool.ready),
    sandboxReady: profileTools.every((tool) =>
      tool.environments.find((gate) => gate.environment === "sandbox")?.ready !== false),
    productionReady: profileTools.every((tool) =>
      tool.environments.find((gate) => gate.environment === "production")?.ready !== false),
    tools: profileTools,
  };

  const probeTools = candidateTools.map((tool) => {
    const promotionRequired = toolRequiresProbeEvidence(tool);
    const required = true;
    const verifiedDefinitionHashes = new Set(tool.verifiedDefinitionHashes ?? []);
    const stagedTool = tool as RealTool & {
      productionVerifiedDefinitionHashes?: string[];
      probeEvidenceMode?: "live-probe" | "signed-fixture" | "runtime-record";
    };
    const productionVerifiedDefinitionHashes = new Set(
      stagedTool.productionVerifiedDefinitionHashes ?? [],
    );
    const profileTool = profileTools.find((candidate) => candidate.tool === tool.name);
    const sandboxProfile = profileTool?.environments.find((gate) => gate.environment === "sandbox");
    const productionProfile = profileTool?.environments.find((gate) => gate.environment === "production");
    const sandboxConfig = profileTool?.required ? sandboxProfile?.selectedConfig : {};
    const productionConfig = profileTool?.required ? productionProfile?.selectedConfig : {};
    const sandboxExpectedHash = sandboxConfig === undefined
      ? undefined
      : probeDefinitionHash(tool, sandboxConfig, process.env);
    const productionExpectedHash = productionConfig === undefined
      ? undefined
      : probeDefinitionHash(tool, productionConfig, process.env);
    const hasVerifiedEvidence = verifiedDefinitionHashes.size > 0;
    const currentDefinitionMatches = Boolean(
      sandboxExpectedHash && verifiedDefinitionHashes.has(sandboxExpectedHash),
    );
    const hasProductionEvidence = productionVerifiedDefinitionHashes.size > 0;
    const currentProductionDefinitionMatches = Boolean(
      productionExpectedHash
      && productionVerifiedDefinitionHashes.has(productionExpectedHash),
    );
    const safety = promotionRequired && isWriteCapableSideEffect(tool.sideEffect)
      ? inspectWriteProbeSafety(
          tool.sideEffect,
          tool.catalogDefinition?.probeSafety ?? tool.declarativeDefinition?.probeSafety,
        )
      : undefined;
    const bindingStatuses = integrationReport.bindings
      .filter((binding) => binding.toolName === tool.name
        || binding.selectionCandidates?.some((candidate) =>
          candidate.bindingKind === "tool" && (candidate.toolName ?? candidate.bindingId) === tool.name))
      .map((binding) => ({ requirementId: binding.requirement.id, status: binding.status }));
    const liveSafetyReady = safety?.status !== "needs_config"
      && (!safety || safety.status === "ready");
    const sandboxSafetyReady = stagedTool.probeEvidenceMode === "signed-fixture"
      || liveSafetyReady;
    const sandboxReady = hasVerifiedEvidence
      && currentDefinitionMatches
      && sandboxSafetyReady;
    const promotionReady = !promotionRequired
      || (hasProductionEvidence && currentProductionDefinitionMatches && liveSafetyReady);
    return {
      tool: tool.name,
      required,
      promotionRequired,
      /** Compatibility alias: ready means sandbox replay readiness. */
      ready: sandboxReady,
      sandboxReady,
      promotionReady,
      evidenceMode: stagedTool.probeEvidenceMode,
      probeStatus: tool.probeStatus ?? "required",
      definitionHashPresent: Boolean(tool.definitionHash),
      sandboxExpectedDefinitionHash: sandboxExpectedHash,
      productionExpectedDefinitionHash: productionExpectedHash,
      verifiedDefinitionHashCount: verifiedDefinitionHashes.size,
      productionVerifiedDefinitionHashCount: productionVerifiedDefinitionHashes.size,
      currentDefinitionMatches,
      currentProductionDefinitionMatches,
      safety: safety
        ? { status: safety.status, missing: safety.status === "needs_config" ? safety.missing : [] }
        : undefined,
      bindingStatuses,
    };
  });
  const probeGate = {
    /** Compatibility alias: ready means sandbox replay readiness. */
    ready: probeTools.every((tool) => tool.sandboxReady),
    sandboxReady: probeTools.every((tool) => tool.sandboxReady),
    promotionReady: probeTools.every((tool) => tool.promotionReady),
    tools: probeTools,
  };
  const authoringOptionalGaps = integrationReport.bindings.filter((binding) =>
    binding.status === "missing"
    && !binding.bindingId
    && !binding.toolName
    && Boolean(binding.requirement.authoringOptional));
  const identityGaps = integrationReport.bindings.filter((binding) =>
    binding.selectionRequired === true
    || (binding.status === "missing"
      && !binding.bindingId
      && !binding.toolName
      && !binding.requirement.authoringOptional));
  const policyGaps = selectedToolPolicies([...candidateToolNames], resources.realTools).missing;
  // Rule-gate parity with design_agent: a rule-check action must have ONE explicitly chosen
  // rule-reading tool among what will actually execute; choosing the rule SOURCE is a real
  // decision the factory never guesses (rule_tool_selection_required at design time).
  const ruleToolCandidates = resources.realTools.filter(toolReadsRulebase).map((tool) => tool.name);
  const ruleToolSatisfied = !isGate || effectiveTools.some((name) => {
    const tool = resources.realTools.find((candidate) => candidate.name === name);
    return Boolean(tool && toolReadsRulebase(tool));
  });
  const integrationGate = {
    // Authoring needs one exact execution surface per requirement (+ a chosen rule reader for
    // gates). Ungranted tool_use[] suggestions are substitutions, not blockers; configuration and
    // probe state are deliberately evaluated by the later stage gates below.
    ready: identityGaps.length === 0 && ruleToolSatisfied && policyGaps.length === 0,
    executionReady: integrationReport.ready,
    report: integrationReport,
    candidates: humanIntegrationCandidates(integrationReport),
    declaredTools,
    /** Declared tool_use[] names this tenant does not grant — SUBSTITUTED by discovered granted
     *  transports (informational; mirrors design_agent's `unresolved`). */
    missingDeclaredTools,
    /** The tools that would actually execute: granted declared picks ∪ unique discovered transports. */
    effectiveTools,
    isRuleGate: isGate,
    ruleToolSatisfied,
    ruleToolCandidates,
    identityGaps,
    authoringOptionalGaps,
    policyGaps,
  };
  const authoringReady = ontologyBlockers.length === 0
    && ruleResolution.unresolved.length === 0
    && integrationGate.ready;
  const sandboxReady = authoringReady
    && profileGate.sandboxReady
    && probeGate.sandboxReady
    && integrationReport.bindings.every((binding) => {
      if (binding.status === "resolved") return true;
      if (binding.status === "needs_probe" || binding.status === "missing") return false;
      if (binding.bindingKind !== "tool" || !binding.toolName) return false;
      const tool = resources.realTools.find((candidate) => candidate.name === binding.toolName);
      return Boolean(tool && toolRequiresConfirmedIntegrationProfile(tool));
    });
  const promotionReady = sandboxReady
    && profileGate.productionReady
    && probeGate.promotionReady;
  const blockingCategories = [
    ontologyBlockers.length ? "ontology" : "",
    ruleResolution.unresolved.length ? "rules" : "",
    !integrationGate.ready ? "integration" : "",
  ].filter(Boolean);

  return {
    action: action.name,
    // Compatibility alias: `ready` now means "safe to author a draft". The
    // two execution stages are explicit and never inferred from this alias.
    ready: authoringReady,
    authoringReady,
    sandboxReady,
    promotionReady,
    stages: {
      authoring: { ready: authoringReady },
      sandbox: { ready: sandboxReady },
      promotion: { ready: promotionReady },
    },
    readOnly: true as const,
    ontologyBlockers,
    unknownRules: ruleResolution.unresolved,
    integrationGate,
    profileGate,
    probeGate,
    blockers: {
      categories: blockingCategories,
      ontology: ontologyBlockers.length,
      rules: ruleResolution.unresolved.length,
      integration: !integrationGate.ready,
      profiles: !profileGate.ready,
      probes: !probeGate.sandboxReady,
    },
    // Compatibility summaries intentionally contain fresh/minimal values rather
    // than aliases to the detailed objects above. The transcript sanitizer
    // treats repeated object identities as circular, so sharing references here
    // would redact otherwise valid readiness evidence.
    ontology: {
      ready: ontologyBlockers.length === 0,
      blockers: ontologyBlockers.map((issue) => ({ ...issue })),
    },
    rules: {
      unresolved: ruleResolution.unresolved.map((issue) => ({ ...issue })),
      needsUserInput: ruleResolution.needsUserInput,
    },
    integration: { ready: integrationGate.ready },
    profiles: {
      ready: profileGate.ready,
      sandboxReady: profileGate.sandboxReady,
      productionReady: profileGate.productionReady,
    },
    probes: {
      ready: probeGate.sandboxReady,
      sandboxReady: probeGate.sandboxReady,
      promotionReady: probeGate.promotionReady,
    },
  };
}

function actionReadinessGapLabels(report: ReturnType<typeof actionReadinessFromSnapshot>): string[] {
  const gate = report.integrationGate;
  return [
    report.ontologyBlockers.length ? `本体阻塞 ${report.ontologyBlockers.length}` : "",
    report.unknownRules.length ? `规则引用待确认 ${report.unknownRules.length}` : "",
    gate.identityGaps.length ? "还没有能真正连接外部系统的唯一工具/运行时契约" : "",
    !gate.ruleToolSatisfied ? `规则校验动作还没选定规则读取工具（候选：${gate.ruleToolCandidates.slice(0, 3).join("、") || "无"}）` : "",
    // Substitution is INFO, not a gap: the granted transports replace ungranted tool_use[] names.
    gate.ready && gate.missingDeclaredTools.length
      ? `tool_use 里 ${gate.missingDeclaredTools.length} 个未授权旧名已由已授权传输替代（${gate.missingDeclaredTools.slice(0, 3).join("、")}${gate.missingDeclaredTools.length > 3 ? "…" : ""}）`
      : "",
    report.authoringReady && !report.sandboxReady ? "草稿可生成，但沙箱连接或安全测试证据尚未就绪" : "",
    report.sandboxReady && !report.promotionReady ? "沙箱可运行，但正式环境连接尚未确认" : "",
  ].filter(Boolean);
}

function displayUnresolvedRuleReference(issue: { reference?: unknown }): string {
  if (typeof issue.reference === "string" && issue.reference.trim()) return issue.reference.trim();
  if (issue.reference && typeof issue.reference === "object") {
    const row = issue.reference as Record<string, unknown>;
    for (const key of ["id", "rule_id", "ruleId", "name", "rule_name", "ruleName"]) {
      if (typeof row[key] === "string" && row[key].trim()) return row[key].trim();
    }
  }
  return "未标识规则";
}

/** Readiness gaps that require authoritative business/configuration evidence are
 * never left as a prose suggestion for the model. The conductor treats
 * next=ask_user as control flow and pauses immediately. */
function readinessClarification(
  reports: Array<ReturnType<typeof actionReadinessFromSnapshot>>,
): { question: string; missing: string[] } | null {
  // Force-park ONLY on gaps that genuinely need USER input before any design attempt: ontology
  // contract corrections, unknown rule references, or integration identity gaps. A missing
  // rule-tool SELECTION is the designer's surface — design_agent itself asks
  // (rule_tool_selection_required) if the brain doesn't pick one explicitly; the inspector
  // duplicating that park re-asks a question the user may have just answered (deadlock pattern).
  const needsUserInput = (report: ReturnType<typeof actionReadinessFromSnapshot>): boolean =>
    report.ontologyBlockers.length > 0
    || report.unknownRules.length > 0
    || report.integrationGate.identityGaps.length > 0
    || report.integrationGate.policyGaps.length > 0;
  const notReady = reports.filter((report) => !report.authoringReady);
  const blocked = notReady.filter(needsUserInput);
  if (!blocked.length) return null;
  const missing: string[] = [];
  if (blocked.some((report) => report.ontologyBlockers.length > 0)) missing.push("authoritative_ontology_corrections");
  if (blocked.some((report) => report.unknownRules.length > 0)) missing.push("canonical_rule_references");
  if (blocked.some((report) => report.integrationGate.identityGaps.length > 0)) missing.push("integration_bindings");
  if (blocked.some((report) => report.integrationGate.policyGaps.length > 0)) missing.push("tool_execution_policies");
  // Piggyback rule-tool selection onto an ALREADY-happening park so one round-trip covers it.
  if (notReady.some((report) => !report.integrationGate.ruleToolSatisfied)) missing.push("rule_tool_selection");

  const parts: string[] = [];
  const ontologyExamples = blocked
    .flatMap((report) => report.ontologyBlockers.map((issue) => `${report.action}：${issue.message}`))
    .slice(0, 2);
  if (ontologyExamples.length) {
    parts.push(`请在 AllmetaOntology 中确认这些真实契约${ontologyExamples.length ? `（例如 ${ontologyExamples.join("；")}）` : ""}`);
  }
  const unresolvedRules = blocked.flatMap((report) =>
    report.unknownRules.map((issue) => `${report.action}/${displayUnresolvedRuleReference(issue)}`));
  if (unresolvedRules.length) {
    parts.push(`请指定规则的 canonical id 或唯一名称（${unresolvedRules.slice(0, 4).join("、")}${unresolvedRules.length > 4 ? "…" : ""}）`);
  }
  // Only REAL identity gaps ask about connections: a requirement with NO granted execution surface
  // at all, or several same-score candidates. Ungranted tool_use[] names are already substituted by
  // discovered granted transports and must never be asked about (that was the pre-#TOOLUSE bug).
  const identityAsks = blocked.flatMap((report) => report.integrationGate.identityGaps.map((binding) =>
    binding.selectionRequired
      ? `${report.action} 的 ${binding.requirement.system}/${binding.requirement.role} 有多个同分候选，需要你选定一个`
      : `${report.action} 需要连接 ${binding.requirement.system}（尚无任何已授权的工具/运行时能力）`));
  if (identityAsks.length) {
    parts.push(`请确认哪些真实工具负责连接这些系统（${[...new Set(identityAsks)].slice(0, 8).join("、")}${identityAsks.length > 8 ? "…" : ""}）；尚未建好的人工或外部平台可以明确保留为人工边界`);
  }
  const policyAsks = [...new Set(blocked.flatMap((report) => report.integrationGate.policyGaps))];
  if (policyAsks.length) {
    parts.push(`请先在工具目录中补齐这些工具的 operation、effectScope 和 sandboxPolicy：${policyAsks.slice(0, 8).join("、")}${policyAsks.length > 8 ? "…" : ""}`);
  }
  const ruleAsks = notReady.filter((report) => !report.integrationGate.ruleToolSatisfied);
  if (ruleAsks.length) {
    const candidates = [...new Set(ruleAsks.flatMap((report) => report.integrationGate.ruleToolCandidates))];
    parts.push(`这些动作承担规则校验，需要你明确选定规则读取工具：${ruleAsks.map((report) => report.action).join("、")}（候选：${candidates.slice(0, 4).join("、") || "当前没有任何带规则读取 capability 的工具"}）——规则来源（本体规则库 vs 伙伴库）是业务决定，我不会替你猜`);
  }
  const scope = blocked.length === 1
    ? `动作「${blocked[0]!.action}」`
    : `${blocked.length} 个动作（${blocked.map((report) => report.action).join("、")}）`;
  return {
    question: `${scope}目前还不能生成可靠草稿。${parts.join("；")}。如果你已经更新了权威 Ontology，直接告诉我“已更新，请重读”即可；对尚未建好的人工/外部环节，回复中明确说「确认人工边界」即可把相应系统缺口保留为人工边界（设计稿可继续；沙箱/交付/晋升仍会拦截）。工厂不会自行补路由、字段、规则或凭证，也不会猜工具契约。`,
    missing,
  };
}

/** #HUMAN-BOUNDARY — remember the exact (system, mode) identity gaps a readiness clarification is
 * about to ask, so the conductor can consume a 人工边界-affirming answer against the gate's OWN list
 * (never a model-supplied one). Ambiguous tool CHOICES are deliberately excluded — those need a
 * selection, not a boundary confirmation. */
function recordPendingBoundaryAsk(
  ctx: BrainCtx,
  reports: Array<ReturnType<typeof actionReadinessFromSnapshot>>,
): void {
  const pairs = reports
    .filter((report) => !report.authoringReady)
    .flatMap((report) => report.integrationGate.identityGaps
      .filter((binding) => binding.status === "missing" && !binding.bindingId && !binding.toolName)
      .map((binding) => ({ system: binding.requirement.system, mode: binding.requirement.role })));
  const unique = [...new Map(pairs.map((pair) => [`${pair.system} ${pair.mode}`, pair])).values()];
  if (unique.length) ctx.pendingIntegrationBoundaryAsk = unique;
}

/** Keep the catalog preflight cheap enough to call once without flooding the
 * model context. Exact profile configs, probe hashes, capability descriptors,
 * and resolved binding reports remain available through the action-scoped
 * inspector. This projection retains the identifiers and reasons needed to
 * trace every blocking summary back to the same immutable resource snapshot. */
function compactActionReadinessReport(
  report: ReturnType<typeof actionReadinessFromSnapshot>,
) {
  const unresolvedBindings = report.integrationGate.report.bindings
    .filter((binding) => binding.status !== "resolved")
    .slice(0, 12)
    .map((binding) => ({
      requirementId: binding.requirement.id,
      system: binding.requirement.system,
      kind: binding.requirement.kind,
      role: binding.requirement.role,
      status: binding.status,
      ...(binding.toolName || binding.bindingId
        ? { executionSurface: binding.toolName ?? binding.bindingId }
        : {}),
      ...(binding.selectionRequired
        ? {
            selectionCandidates: (binding.selectionCandidates ?? [])
              .slice(0, 6)
              .map((candidate) => ({
                kind: candidate.bindingKind,
                id: candidate.bindingId,
              })),
          }
        : {}),
      ...(binding.requirement.authoringOptional
        ? { authoringOptional: { ...binding.requirement.authoringOptional } }
        : {}),
      reason: binding.reason.slice(0, 260),
    }));
  const sandboxProfileBlockers = report.profileGate.tools
    .filter((tool) =>
      tool.environments.find((environment) => environment.environment === "sandbox")?.ready === false)
    .map((tool) => tool.tool);
  const productionProfileBlockers = report.profileGate.tools
    .filter((tool) =>
      tool.environments.find((environment) => environment.environment === "production")?.ready === false)
    .map((tool) => tool.tool);
  const sandboxProbeBlockers = report.probeGate.tools
    .filter((tool) => !tool.sandboxReady)
    .map((tool) => tool.tool);
  const productionProbeBlockers = report.probeGate.tools
    .filter((tool) => !tool.promotionReady)
    .map((tool) => tool.tool);
  return {
    action: report.action,
    ready: report.authoringReady,
    readOnly: true as const,
    stages: {
      authoring: report.authoringReady,
      sandbox: report.sandboxReady,
      promotion: report.promotionReady,
    },
    blockers: {
      categories: [...report.blockers.categories],
      ontology: {
        count: report.ontologyBlockers.length,
        examples: report.ontologyBlockers.slice(0, 6).map((issue) => ({
          code: issue.code,
          message: issue.message,
          ...(issue.action ? { action: issue.action } : {}),
          ...(issue.event ? { event: issue.event } : {}),
          ...(issue.object ? { object: issue.object } : {}),
          ...(issue.step ? { step: issue.step } : {}),
          ...(issue.rule ? { rule: issue.rule } : {}),
          ...(issue.link ? { link: issue.link } : {}),
          ...(issue.field ? { field: issue.field } : {}),
        })),
      },
      rules: {
        count: report.unknownRules.length,
        examples: report.unknownRules.slice(0, 6).map((issue) => ({
          reason: issue.reason,
          // Keep the catalog-wide response bounded even when a malformed
          // uploaded reference contains a very large nested object.  The
          // canonical id/name (or the explicit "unidentified" marker) is all
          // the aggregate needs; the action-scoped inspector retains the full
          // evidence for diagnosis.
          reference: displayUnresolvedRuleReference(issue),
        })),
      },
      integration: {
        ready: report.integrationGate.ready,
        identityGapRequirementIds: report.integrationGate.identityGaps
          .map((binding) => binding.requirement.id),
        authoringOptionalRequirementIds: report.integrationGate.authoringOptionalGaps
          .map((binding) => binding.requirement.id),
        ruleToolSatisfied: report.integrationGate.ruleToolSatisfied,
        ruleToolCandidates: report.integrationGate.ruleToolCandidates.slice(0, 6),
        declaredTools: report.integrationGate.declaredTools.slice(0, 12),
        selectedTools: report.integrationGate.effectiveTools.slice(0, 12),
        substitutedDeclaredTools: report.integrationGate.missingDeclaredTools.slice(0, 12),
        unresolvedBindings,
        unresolvedBindingCount: report.integrationGate.report.bindings
          .filter((binding) => binding.status !== "resolved").length,
      },
      profiles: {
        sandboxReady: report.profileGate.sandboxReady,
        productionReady: report.profileGate.productionReady,
        sandboxTools: sandboxProfileBlockers.slice(0, 12),
        productionTools: productionProfileBlockers.slice(0, 12),
      },
      probes: {
        sandboxReady: report.probeGate.sandboxReady,
        promotionReady: report.probeGate.promotionReady,
        sandboxTools: sandboxProbeBlockers.slice(0, 12),
        productionTools: productionProbeBlockers.slice(0, 12),
      },
    },
    detail: {
      tool: "inspect_action_readiness",
      action: report.action,
    },
  };
}

/** Read-only, action-scoped preflight. It deliberately does not create a plan/spec,
 * persist a profile, run a probe, or deploy anything: callers get the exact gaps and
 * can decide whether the next honest step is an Ontology revision proposal, ask_user, or a probe. */
const inspect_action_readiness: BrainTool = {
  name: "inspect_action_readiness",
  description:
    "只读检查一个 Ontology Action 是否已经具备生成条件：返回该动作切片的本体阻塞、无法唯一解析的规则引用、集成候选/缺口、sandbox+production profile 可用性和 probe evidence。它不要求先 create_plan，也不会创建 plan/spec、保存配置、执行探针或部署；遇到缺口只把事实和下一步说清楚。action 必须使用 read_ontology 返回的准确名称。",
  parameters: params(
    { action: { type: "string", description: "read_ontology 返回的准确 Action.name" } },
    ["action"],
  ),
  async execute(args, ctx) {
    if (!ctx.ontology) {
      return { ok: false, summary: "还没有 Ontology。请先调用 read_ontology，再检查具体动作；我不会凭动作名猜契约。" };
    }
    const actionName = String(args.action ?? "").trim();
    const action = ctx.ontology.actions.find((candidate) => candidate.name === actionName);
    if (!action) {
      const known = ctx.ontology.actions
        .filter((candidate) => candidate.actor.includes("Agent"))
        .map((candidate) => candidate.name);
      return {
        ok: false,
        summary: `找不到动作「${actionName}」。请使用 read_ontology 返回的准确名称${known.length ? `；当前 Agent 动作有：${known.join("、")}` : ""}。`,
        output: { action: actionName, knownAgentActions: known },
      };
    }

    const readiness = analyzeOntologyReadiness(ctx.ontology);
    const ontologyBlockers = blockingIssuesForAction(readiness.blocking, action);
    const ruleResolution = resolveActionRuleReferences(
      action,
      (ctx.ontology.rules ?? []) as Array<Record<string, unknown>>,
    );
    let resources: CurrentExecutionResources;
    try {
      resources = await currentExecutionResources(ctx);
    } catch (error) {
      return {
        ok: false,
        summary: `动作「${actionName}」的本体切片已检查，但当前工具和连接配置清单暂时读不到；没有可靠清单时不会继续生成。`,
        output: {
          next: "ask_user",
          reason: "execution_resources_unavailable",
          question: `动作「${actionName}」的工具和连接配置清单刚才没有读到。请先确认 Agent Factory 的工具目录和配置服务可用，然后告诉我“已恢复，请重试”；如果你正在维护服务，也可以让我先暂停。`,
          missing: ["execution_resources_snapshot"],
          action: actionName,
          readOnly: true,
          ontologyBlockers,
          unknownRules: ruleResolution.unresolved,
          ontology: { ready: ontologyBlockers.length === 0, blockers: ontologyBlockers },
          rules: ruleResolution,
          integration: { ready: false, error: "execution_resources_unavailable" },
        },
      };
    }

    const report = actionReadinessFromSnapshot(action, ctx, readiness, resources);
    const gaps = actionReadinessGapLabels(report);
    const clarification = readinessClarification([report]);
    if (clarification) recordPendingBoundaryAsk(ctx, [report]);
    return {
      ok: true,
      summary: !report.authoringReady
        ? (clarification
          ? `动作「${actionName}」还不能可靠生成草稿：${gaps.join("；")}。需要业务选择或真实工具契约的地方应交给 ask_user，不能硬编码代填。`
          : `动作「${actionName}」差一个设计侧选择：${gaps.join("；")}。在 design_agent 的 tools 里显式选定规则读取工具即可继续（候选：${report.integrationGate.ruleToolCandidates.slice(0, 3).join("、") || "无"}）；若规则来源有业务分歧再 ask_user。`)
        : report.promotionReady
          ? `动作「${actionName}」的三阶段只读预检通过：可生成、可沙箱、可进入晋升审查；本次检查没有创建 plan/spec，也没有保存或部署任何内容。`
          : `动作「${actionName}」已经可以生成草稿；${gaps.join("；")}。这些后续缺口不会阻止 authoring，但 sandbox_run / finish 会分别按阶段阻断。`,
      output: {
        ...report,
        ...(clarification ? {
          next: "ask_user" as const,
          reason: "action_readiness_requires_authoritative_input",
          question: clarification.question,
          missing: clarification.missing,
        } : {}),
      },
    };
  },
};

/** Deterministic all-action preflight. The action set is derived exclusively
 * from the loaded Ontology, never from model arguments, so a caller cannot
 * hallucinate, omit, or reorder the generation scope. */
const inspect_all_action_readiness: BrainTool = {
  name: "inspect_all_action_readiness",
  description:
    "【全量只读预检】一次检查当前 Ontology 中 actor 包含 Agent 的全部 Actions，返回总计和紧凑逐项阻断摘要。Action 全集只从已加载 Ontology 确定，调用方不提供动作列表，因此不能漏项或混入虚构 Action。只读取同一个资源快照；不会创建 plan/spec、保存配置、执行探针、部署或修改 Ontology。需要某个 Action 的完整 binding/profile/probe 证据时，再按摘要指引调用 inspect_action_readiness。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.ontology) {
      return {
        ok: false,
        summary: "还没有 Ontology。请先调用 read_ontology；全量预检不会接受调用方猜出的 Action 列表。",
      };
    }

    const agentActions = ctx.ontology.actions.filter((action) => action.actor.includes("Agent"));
    const actionNames = agentActions.map((action) => action.name);
    if (agentActions.length === 0) {
      return {
        ok: true,
        summary: "当前 Ontology 中没有 actor 包含 Agent 的 Action；全量只读预检完成，未创建或修改任何内容。",
        output: {
          readOnly: true,
          source: "ontology.agent_actions",
          actionNames,
          totals: {
            total: 0,
            ready: 0,
            blocked: 0,
            byGap: { ontology: 0, rules: 0, integration: 0, profiles: 0, probes: 0 },
            readyActions: [],
            blockedActions: [],
          },
          actions: [],
        },
      };
    }

    const readiness = analyzeOntologyReadiness(ctx.ontology);
    let resources: CurrentExecutionResources;
    try {
      // One immutable snapshot for the whole catalog: every action is judged
      // against the same tool/profile/probe state.
      resources = await currentExecutionResources(ctx);
    } catch (error) {
      const resourceError = String((error as Error).message ?? error).slice(0, 220);
      const actions = agentActions.map((action) => {
        const ontologyBlockers = blockingIssuesForAction(readiness.blocking, action);
        const rules = resolveActionRuleReferences(
          action,
          (ctx.ontology?.rules ?? []) as Array<Record<string, unknown>>,
        );
        const categories = [
          ontologyBlockers.length ? "ontology" : "",
          rules.unresolved.length ? "rules" : "",
          "execution_resources",
        ].filter(Boolean);
        return {
          action: action.name,
          ready: false,
          readOnly: true as const,
          blockers: {
            categories,
            ontology: ontologyBlockers,
            rules: rules.unresolved,
            integration: true,
            profiles: true,
            probes: true,
            resourceError: "execution_resources_unavailable",
          },
          ontology: { ready: ontologyBlockers.length === 0, blockers: ontologyBlockers },
          rules,
          integration: { ready: false, error: "execution_resources_unavailable" },
          profiles: { ready: false, error: "execution_resources_unavailable", tools: [] },
          probes: { ready: false, error: "execution_resources_unavailable", tools: [] },
        };
      });
      return {
        ok: false,
        summary: `已从 Ontology 完整识别 ${actions.length} 个 Agent Actions，但当前工具和连接配置清单暂时读不到。没有可靠清单时不会把任何动作标成 ready，也没有创建、保存、测试或部署。`,
        output: {
          next: "ask_user",
          reason: "execution_resources_unavailable",
          question: `${actions.length} 个 Agent 的工具和连接配置清单刚才没有读到。请先确认 Agent Factory 的工具目录和配置服务可用，然后告诉我“已恢复，请重试”；如果你正在维护服务，也可以让我先暂停。`,
          missing: ["execution_resources_snapshot"],
          readOnly: true,
          source: "ontology.agent_actions",
          actionNames,
          resourceError,
          totals: {
            total: actions.length,
            ready: 0,
            blocked: actions.length,
            byGap: {
              ontology: actions.filter((report) => !report.ontology.ready).length,
              rules: actions.filter((report) => report.rules.unresolved.length > 0).length,
              integration: actions.length,
              profiles: actions.length,
              probes: actions.length,
            },
            readyActions: [],
            blockedActions: actionNames,
          },
          actions,
        },
      };
    }

    const actions = agentActions.map((action) =>
      actionReadinessFromSnapshot(action, ctx, readiness, resources));
    const readyActions = actions.filter((report) => report.ready).map((report) => report.action);
    const blockedActions = actions.filter((report) => !report.ready).map((report) => report.action);
    const totals = {
      total: actions.length,
      ready: readyActions.length,
      blocked: blockedActions.length,
      byGap: {
        ontology: actions.filter((report) => !report.ontology.ready).length,
        rules: actions.filter((report) => report.unknownRules.length > 0).length,
        integration: actions.filter((report) => !report.integration.ready).length,
        profiles: actions.filter((report) => !report.profiles.ready).length,
        probes: actions.filter((report) => !report.probes.ready).length,
      },
      readyActions,
      blockedActions,
      stages: {
        authoring: {
          ready: actions.filter((report) => report.authoringReady).length,
          blocked: actions.filter((report) => !report.authoringReady).length,
        },
        sandbox: {
          ready: actions.filter((report) => report.sandboxReady).length,
          blocked: actions.filter((report) => !report.sandboxReady).length,
        },
        promotion: {
          ready: actions.filter((report) => report.promotionReady).length,
          blocked: actions.filter((report) => !report.promotionReady).length,
        },
      },
    };
    const clarification = readinessClarification(actions);
    if (clarification) recordPendingBoundaryAsk(ctx, actions);
    return {
      ok: true,
      summary: blockedActions.length === 0
        ? `已按 Ontology 全量检查 ${actions.length} 个 Agent Actions：${totals.stages.authoring.ready} 个可生成草稿、${totals.stages.sandbox.ready} 个可进沙箱、${totals.stages.promotion.ready} 个具备晋升前置条件。后两阶段的缺口不会反向阻止 authoring。`
        : `已按 Ontology 全量检查 ${actions.length} 个 Agent Actions：${readyActions.length} 个可生成草稿、${blockedActions.length} 个仍缺少权威契约（${blockedActions.join("、")}）。${!clarification && actions.some((report) => !report.authoringReady && !report.integrationGate.ruleToolSatisfied) ? "其中规则读取工具属设计侧选择：在 design_agent 的 tools 里显式选定即可继续，无需等待用户。" : ""}另有 sandbox ${totals.stages.sandbox.blocked} 个、promotion ${totals.stages.promotion.blocked} 个后续缺口；该检查没有创建、保存、探针或部署。`,
      output: {
        readOnly: true,
        source: "ontology.agent_actions",
        actionNames,
        totals,
        ...(clarification ? {
          next: "ask_user" as const,
          reason: "catalog_readiness_requires_authoritative_input",
          question: clarification.question,
          missing: clarification.missing,
        } : {}),
        actions: actions.map(compactActionReadinessReport),
      },
    };
  },
};

// critique_plan — an INDEPENDENT AI review of the decomposition (review tier), after create_plan and
// before mass design_agent. Challenges: missing/extra agents, wrong ordering, mis-identified rule
// gates, external-handoff-as-broken-chain, cross-agent I/O misalignment. Real LLM, must propose fixes.
const critique_plan: BrainTool = {
  name: "critique_plan",
  description:
    "create_plan 之后、大规模 design_agent 之前，让 AI【独立审查并挑战这份分解计划】：agent 是否多了/少了、事件链顺序对不对、规则闸口认对没、有没有把外部交接误当断链、跨 agent 的 I/O 契约是否对齐。发现问题就改计划(create_plan version+1)再设计——不走过场。",
  parameters: params({ deep: { type: "boolean", description: "（可选）三视角深评（链路完整/规则合规/IO 契约三位评审并行汇总）。是否深评由你判断：计划里 agent 多、规则密、或历史上这个难度出过保真违约时建议 true" } }),
  async execute(args, ctx) {
    if (!ctx.currentPlan) return { ok: false, summary: "还没 create_plan。" };
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    const plan = ctx.currentPlan;
    const agentActions = generationScopedAgentActionNames(ctx);
    if (!isGatewayConfigured()) {
      const planned = new Set(plan.agents.map((a) => a.actionName));
      const missed = agentActions.filter((n) => !planned.has(n));
      const detail = missed.length
        ? `；确定性检查另发现漏了 Agent 动作：${missed.join("、")}`
        : "";
      const issue = {
        severity: "high",
        problem: "方案评审所需的真实 LLM 网关未配置",
        fix: "配置真实 Factory LLM provider 后重新执行 critique_plan",
      };
      ctx.emit({
        t: "reflect",
        kind: "plan-critique",
        lesson: `方案评审阻断：真实 LLM 网关未配置${detail}`,
      });
      return {
        ok: false,
        summary: `方案评审未执行：真实 LLM 网关未配置，确定性覆盖检查不能替代独立 AI 评审${detail}。`,
        output: { verdict: "blocked", issues: [issue], failure: "llm_gateway_not_configured" },
      };
    }
    const digest = `业务域 ${ctx.domain}\n本体里 actor=Agent 的动作：${agentActions.join("、")}\n计划（v${plan.version}，${plan.agents.length} agent）：\n${plan.agents.map((a, i) => `${i + 1}. ${a.actionName}：${a.role ?? ""} | 触发 ${(a.triggerEvents ?? []).join(",")} → 产出 ${(a.emitEvents ?? []).join(",")} | 候选工具 ${(a.toolCandidates ?? []).join(",") || "—"}`).join("\n")}`;

    // ── G3 三视角分治评审（附录 B）：计划够大时，单跳评审必然顾此失彼——派三位视角专家
    // 并行挑战（链路完整 / 规则合规 / IO 契约），按 problem 去重合并；≥2 位专家成功才采用，
    // 否则诚实降级回单跳。事件冒泡沿用认知专家通道（UI 免费可视化）。
    const deepReview = args.deep === true; // #NATIVE — 深评与否由你决定（deep 参数）；计划大/规则多/历史保真教训时建议 true
    if (deepReview) {
      const und = ctx.ontologyUnderstanding ? `\n【本体理解（四维分治结论）】${ctx.ontologyUnderstanding.slice(0, 1200)}` : "";
      const mkTask = (id: string, role: string, focus: string, extra: string) => ({
        id,
        role,
        system: `你是方案评审的「${role}」，只从【${focus}】这一个视角挑战这份 agent 分解计划。只输出 JSON {"issues":[{"severity":"high"|"med"|"low","problem":string,"fix":string}]}；没问题输出 {"issues":[]}。名字必须逐字来自材料，不编造。发现要具体到 agent/事件名。`,
        user: `${digest}${extra}`,
        maxTokens: 1200,
      });
      const critiqueTasks = [
        mkTask("chain", "链路完整视角", "覆盖与事件链：漏/多 agent、顺序错乱、把外部交接误判为断链", `\n【Agent 动作全集】${agentActions.join("、")}${und}`),
        mkTask("rules", "规则合规视角", "规则闸口：校验类动作是否被识别为闸口、强制规则是否有 agent 承接", und),
        mkTask("contract", "IO 契约视角", "跨 agent 输入输出对齐：上游产出的事件字段能否满足下游触发所需", und),
      ];
      // #PERSPECTIVES P2 — 理解阶段有镜头结论（okCount>0）时追加一位「业务视角」挑战者。
      // 与 P1 去重：理解层发现已在 und 里给全体评审员——这位只提【计划层面】的新问题
      // （哪个 agent 边界/合并破坏了哪条视角要点、哪个交接点没有 agent 承接），复述由禁令+
      // 下方 problem 前缀去重双重吸收。仅 +1 个 fast 档调用，且只在镜头数据存在时发生。
      if (perspectivesEnabled() && ctx.ontologyPerspectives?.okCount) {
        const lensLabels = ctx.ontologyPerspectives.selected.map((l) => l.label).join("、");
        critiqueTasks.push(mkTask(
          "stakeholder",
          "业务视角",
          `业务视角挑战（${lensLabels}）：agent 边界/顺序/合并决策是否违背理解阶段标出的客户触点、运营接管、对账审计、合规与外部契约要点`,
          `${und}\n【注意】上方本体理解已包含各业务视角的结论——只提【计划层面】的新问题（哪个 agent 边界/合并破坏了哪条视角要点、哪个交接点没有 agent 承接），不要复述理解里已有的发现。`,
        ));
      }
      const perspectives = await runSpecialists(ctx, critiqueTasks);
      const paneLabel = critiqueTasks.length === 3 ? "三视角" : "四视角";
      const okR = perspectives
        .map((r) => ({ r, issues: r.ok ? parsePlanCritiqueIssues((r.output as Record<string, unknown> | null)?.issues) : null }))
        .filter((entry): entry is { r: typeof perspectives[number]; issues: PlanCritiqueIssue[] } => entry.issues !== null);
      if (okR.length >= 2) {
        const merged: Array<Record<string, unknown>> = [];
        const seen = new Set<string>();
        for (const { r, issues } of okR) {
          for (const i of issues) {
            const k = String(i.problem ?? "").slice(0, 30);
            if (k && !seen.has(k)) {
              seen.add(k);
              merged.push({ ...i, perspective: r.role });
            }
          }
        }
        const high = merged.filter((i) => i.severity === "high");
        const verdict = high.length ? "revise" : "ok";
        ctx.emit({ t: "reflect", kind: "plan-critique", lesson: merged.length ? `方案评审（${paneLabel} · ${okR.length}/${critiqueTasks.length}）：${merged.length} 处（${high.length} 高危）：${merged.slice(0, 3).map((i) => `[${String(i.perspective).replace(/视角$/, "")}] ${String(i.problem)}`).join("；")}` : `方案评审（${paneLabel} · ${okR.length}/${critiqueTasks.length}）：分解合理、覆盖完整 ✓` });
        return {
          ok: verdict !== "revise",
          summary: merged.length ? `${paneLabel}评审发现 ${merged.length} 处问题（${high.length} 高危）：${merged.slice(0, 3).map((i) => `${String(i.problem)}→${String(i.fix)}`).join("；")}${verdict === "revise" ? "。建议 create_plan v+1 改后再设计。" : ""}` : `${paneLabel}评审通过：链路/规则/契约${critiqueTasks.length === 4 ? "/业务视角" : ""}均无异议 ✓`,
          output: { verdict, issues: merged, perspectives: okR.map(({ r }) => r.role) },
        };
      }
      ctx.emit({ t: "reflect", kind: "plan-critique", lesson: `${paneLabel}评审未成（${okR.length}/${critiqueTasks.length} 成功）——降级为单跳评审。` });
    }

    const sys =
      "你是 agent 工厂的【方案评审】，独立挑战这份 agent 分解计划。逐条判断：(1) 是否漏了/多了 agent（对照本体 Agent 动作）；(2) 事件链顺序对不对；(3) 规则校验类动作是否被识别为闸口；(4) 是否有 agent 的产出其实是交给外部平台的终态而被当成断链；(5) 跨 agent 的 I/O 契约是否对齐；(6) 合并质询（OneFlow：同底模多 agent≈白付通信税，KV 复用可省 ~10×）——相邻两个 agent 若无【工具隔离/权限边界/独立部署必要/HITL 停点】任一结构性理由，就该质疑为什么不合并成一个多步 agent，把'不同角色'当理由不算数。只输出 JSON：" +
      '{"verdict":"ok"|"revise","issues":[{"severity":"high"|"med"|"low","problem":string,"fix":string}]}。没问题就 issues:[]、verdict:"ok"。不要任何其它文字。';
    const parsed = await chatJson<Record<string, unknown>>(sys, digest, { temperature: 0.3, maxTokens: 4000, signal: ctx.signal, models: modelChain("review"), purpose: "critique_plan" });
    const critique = parsePlanCritiquePayload(parsed);
    if (!critique.ok) {
      const issue = {
        severity: "high",
        problem: "方案评审 LLM 调用失败或返回无法验证的结构",
        fix: "检查网关/模型日志并重新执行 critique_plan，成功前不得进入批量设计",
      };
      ctx.emit({
        t: "reflect",
        kind: "plan-critique",
        lesson: `方案评审阻断：${critique.error}`,
      });
      return {
        ok: false,
        summary: `方案评审失败并已阻断：${critique.error}。不能把网关或解析故障当作零问题通过。`,
        output: { verdict: "blocked", issues: [issue], failure: "llm_or_parse_failure", detail: critique.error },
      };
    }
    const issues = critique.issues;
    const high = issues.filter((i) => i.severity === "high");
    ctx.emit({ t: "reflect", kind: "plan-critique", lesson: issues.length ? `方案评审 ${issues.length} 处（${high.length} 高危）：${issues.slice(0, 3).map((i) => String(i.problem)).join("；")}` : "方案评审：分解合理、覆盖完整 ✓" });
    const revise = critique.verdict === "revise" || high.length > 0;
    return { ok: !revise, summary: issues.length ? `方案评审发现 ${issues.length} 处问题（${high.length} 高危）：${issues.slice(0, 3).map((i) => `${String(i.problem)}→${String(i.fix)}`).join("；")}${revise ? "。建议 create_plan v+1 改后再设计。" : ""}` : "方案评审通过：分解合理、覆盖完整 ✓", output: { verdict: revise ? "revise" : critique.verdict, issues } };
  },
};

const design_agent: BrainTool = {
  name: "design_agent",
  description:
    "提交你为【一个】agent 动作设计好的 agent。先想清楚职责/边界/选哪些工具(为什么)/每个分支事件的触发条件，并【亲自写中文 system_prompt】。定义 input_schema/output_schema（参考 read_ontology 的 data_objects 真实属性）。若 execution_plan_requirement.required=true，plan 必填且必须覆盖 action_steps 给出的稳定 stepId，并精确保留其 kind/tool/invoke/emitEvent；action_steps[].tool 与 integration via_tool 是权威执行绑定，不能被语义推荐替换或省略。规则校验类动作(is_rule_check)的 prompt 必须写成运行时动态抓规则，绝不写死规则。suggested_tools 只用于发现：tools 留空时采用权威 step/via_tool，再采用 Ontology action.tool_use；其余 integration 只有一个精确 capability 候选时才自动补齐，同一需求有多个同分候选才 ask_user。缺 profile/probe 不阻止草稿，但会在 sandbox/finish 阶段阻断。一次只交一个。",
  parameters: {
    ...params(
    {
      action: { type: "string", description: "动作名（read_ontology agentActions[].name）" },
      role_name: { type: "string", description: "（可选）这个 function 的人类可读【显示名】（≤12 字，如「简历守门员」）——仅用于 UI 卡片/业务流全景的称呼；注意：角色设定属于生成过程中的工作者（过程角色），不属于交付的 functions。" },
      system_prompt: { type: "string", description: "你亲自写的中文系统提示：职责/依据/决策。要具体，别套模板。" },
      tools: { type: "array", items: { type: "string" }, description: "本次已明确选择的真实工具。无论是否填写，Ontology action_steps[].tool / integration via_tool 都会作为权威必选；留空再采用 action.tool_use，未覆盖 integration 仅在唯一精确 capability 候选时自动补齐。语义 suggested_tools 不会覆盖权威 step 工具。" },
      tool_configs: {
        type: "object",
        additionalProperties: { type: "object", additionalProperties: true },
        description: "已停用。模型不能直接写运行配置；有配置面的工具必须先 confirm_integration_profile，由它直接触发服务端确认门，再通过 tool_profiles 选用。",
      },
      tool_profiles: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "兼容字段：toolName→已确认的 production profile。新设计建议用 production_tool_profiles。",
      },
      production_tool_profiles: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "toolName→用户已确认的 production profile id/profileKey。",
      },
      sandbox_tool_profiles: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "toolName→用户已确认的 sandbox profile id/profileKey。必须使用独立 endpoint/credential/test namespace，不能借生产 profile。",
      },
      decision_logic: { type: "string", description: "必填：分支决策逻辑——依据什么条件走哪个分支、成功/失败/拦截各 emit 什么事件、异常怎么兜底。UI 卡片与复审都读它。" },
      decision_tables: DECISION_TABLES_SCHEMA,
      tool_rationale: { type: "string" },
      compensation_event: { type: "string", description: "#SAGA 可选：这个 agent 硬失败时 runtime 自动 emit 的【补偿事件】名（如 INVITATION_CANCELLED），用于撤销已发生的外部副作用（邀约已发/JD 已发布/已写外部系统）。有副作用工具的 agent 强烈建议声明；优先用本体已有事件名或与用户约定的补偿事件。" },
      input_schema: { type: "array", items: { type: "object", properties: { field: { type: "string" }, type: { type: "string" }, description: { type: "string" }, source: { type: "string" }, required: { type: "boolean" } }, required: ["field", "type"] } },
      output_schema: { type: "array", items: { type: "object", properties: { field: { type: "string" }, type: { type: "string" }, description: { type: "string" }, source: { type: "string" }, required: { type: "boolean" } }, required: ["field", "type"] } },
      plan: {
        type: "array",
        description:
          "这个 agent 的【有序多步 plan】——execution_plan_requirement.required=true 时必填，并必须覆盖 action_steps 中每个稳定 stepId；每个 integration 外部调用/写入是独立一步(运行时各包一个稳定业务键 durable step，可重放)。kind 支持 tool|logic|condition|invoke|foreach|emit。foreach 用 itemsFrom + itemAs + itemKeyFrom + body，支持嵌套 foreach 和循环内 invoke；每层 itemKeyFrom 都必须是稳定业务键。emit 用 emitEvent（必须在本体 triggered_event 白名单）+ emitPayloadFrom/emitPayload。tool/invoke 步要给精确输入、timeout 和 onError/errorPolicy；绝不按参数名猜映射。condition 使用安全 DSL；用 dependsOn 做分支。只有本体没有执行边界/副作用的简单动作才可省略 plan。",
        items: PLAN_STEP_SCHEMA,
      },
    },
      ["action", "system_prompt", "decision_logic"],
    ),
    $defs: { planStep: PLAN_STEP_SCHEMA },
  },
  async execute(args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先调用 read_ontology。" };
    const name = String(args.action ?? "").trim();
    const serverScope = ctx.generationDirective?.requestedActionNames;
    if (serverScope?.length && !serverScope.includes(name)) {
      return {
        ok: false,
        summary: `动作「${name}」不在本次服务端生成范围内；只允许：${serverScope.join("、")}。`,
      };
    }
    const action = ctx.ontology.actions.find((a) => a.name === name);
    if (!action) return { ok: false, summary: `找不到动作「${name}」，用 read_ontology 里的准确名字。` };
    if (!action.actor.includes("Agent")) {
      const actors = action.actor.length ? action.actor.join("、") : "未声明";
      const question = `动作「${name}」当前由 ${actors} 执行，不属于 Agent Factory 要生成 function 的 actor=Agent 动作。若确实要把它改成 Agent，请先在 AllmetaOntology 中明确修改 actor；否则请只从 read_ontology 返回的 agentActions 中选择，我不会把人工/平台操作伪装成 Agent。`;
      return {
        ok: false,
        summary: question,
        output: {
          next: "ask_user",
          reason: "action_actor_not_agent",
          action: name,
          actor: action.actor,
          question,
          missing: ["authoritative_actor_decision"],
        },
      };
    }
    const actionRuleResolution = resolveActionRuleReferences(
      action,
      (ctx.ontology.rules ?? []) as Array<Record<string, unknown>>,
    );
    // #ONTOLOGY-HEAL — per-action slicing: refuse ONLY when a blocking readiness issue actually affects
    // THIS action's slice (its own name, an object/event it touches). An action whose slice is clean
    // generates now even while the whole ontology is not yet ready (partial generation) — no more
    // all-or-nothing wall. Global structural blockers (no action/object/event scope) still block everyone.
    if (ctx.ontologyReadiness && !ctx.ontologyReadiness.ready) {
      const mine = blockingIssuesForAction(ctx.ontologyReadiness.blocking, action);
      if (mine.length) {
        const examples = mine
          .slice(0, 3)
          .map((issue) => issue.message);
        const unresolvedRules = actionRuleResolution.unresolved
          .map((issue) => displayUnresolvedRuleReference(issue))
          .slice(0, 4);
        const question = `动作「${name}」目前有 ${mine.length} 处权威 Ontology 契约不一致${unresolvedRules.length ? `，另有规则引用待确认（${unresolvedRules.join("、")}）` : ""}。例如：${examples.join("；")}${mine.length > examples.length ? "；还有其它项，完整证据已保留在详情中" : ""}。请在 AllmetaOntology 中修正后让我重读，或明确告诉我每一处应采用哪个真实字段/事件/规则；我不会自动补 producer/consumer、虚构对象或按相似度选规则。`;
        return {
          ok: false,
          summary: question,
          output: {
            next: "ask_user",
            reason: "authoritative_ontology_contract_unresolved",
            question,
            missing: ["authoritative_ontology_corrections", ...(unresolvedRules.length ? ["canonical_rule_references"] : [])],
            blockingForAction: mine,
            unresolvedRules: actionRuleResolution.unresolved,
            ontologyReadiness: ctx.ontologyReadiness,
          },
        };
      }
    }
    if (actionRuleResolution.needsUserInput) {
      return {
        ok: false,
        summary: actionRuleResolution.question ?? `动作「${name}」有无法唯一解析的规则引用，请先让用户确认准确的 rule id 或名称。`,
        output: {
          next: "ask_user",
          reason: "unresolved_ontology_rule_references",
          action: name,
          question: actionRuleResolution.question,
          unresolved: actionRuleResolution.unresolved,
          resolution: "在 Ontology action_steps[].rules 中填写能唯一匹配 Ontology Rule 的准确 id 或名称，然后重新 read_ontology。",
        },
      };
    }
    if (!String(args.system_prompt ?? "").trim()) return { ok: false, summary: `agent「${name}」缺少 system prompt——必须亲自写，不能留空套模板。` };
    // Same fail-and-resubmit contract as the empty-prompt guard: decision_logic drives the UI
    // card + triple-review; an agent without branch logic reads as half-designed (and the model
    // DOES skip optional fields when it's busy authoring plan[] — hence required + this guard).
    if (!String(args.decision_logic ?? "").trim()) return { ok: false, summary: `agent「${name}」缺少 decision_logic——写清楚：依据什么条件走哪个分支、成功/失败/拦截各 emit 什么事件、异常怎么兜底。补上后重交。` };

    const parsedDecisionTables = parseDecisionTables(args.decision_tables, { declaredEvents: action.triggered_event ?? [] });
    if (!parsedDecisionTables.ok) {
      return {
        ok: false,
        summary: `agent「${name}」的 decision_tables 无效：${parsedDecisionTables.errors.slice(0, 6).join("；")}。阈值/分层/null 语义必须以结构化表重交，不能只写 prose。`,
        output: { decisionTableErrors: parsedDecisionTables.errors },
      };
    }
    const decisionTables = parsedDecisionTables.tables;
    if (ontologyActionIsRuleGate(action) && proseContainsDecisionThreshold(`${args.system_prompt ?? ""}\n${args.decision_logic ?? ""}`) && !decisionTables.length) {
      return {
        ok: false,
        summary: `agent「${name}」包含数值阈值/置信门，但没有 decision_tables，已阻断。请用结构化 row + missing + default 明确边界（例如 39/40/null）并让用户确认；工厂不会把关键阈值只烘进 prompt。`,
        output: { needsStructuredDecisionTable: true },
      };
    }

    // ── 内部设计循环（内推演，架构书 §5）：确定性自检 → 命中硬问题就跑【一次】内部精修，把外层
    //    review→refine 的回环前移到设计当下。自检永远跑；精修 gateway-gated + env 可关 + 失败兜底原稿。 ──
    const isGate = ontologyActionIsRuleGate(action);
    let rawPrompt = String(args.system_prompt ?? "");
    let rawLogic = String(args.decision_logic ?? "");
    {
      const knownEv0 = new Set(ctx.ontology.actions.flatMap((a) => [...a.trigger, ...a.triggered_event]));
      const draftOf = () => ({
        actionName: name,
        emitEvents: action.triggered_event ?? [],
        systemPrompt: rawPrompt,
        decisionLogic: rawLogic,
        toolCount: Array.isArray(args.tools) ? (args.tools as string[]).filter(Boolean).length : 0,
        hitl: false,
        isGate,
        ruleLeak: !isGate && promptEmbedsRule(`${rawPrompt}\n${rawLogic}`, ruleIdentifiers(ctx)),
        ungroundedEvents: ungroundedEventTokens([`${rawPrompt}\n${rawLogic}`], knownEv0),
        // #SAGA — 副作用工具却没补偿事件 → 自检软警告（⑥），提醒大脑设计撤销路径。
        sideEffectful: Array.isArray(args.tools) && (args.tools as string[]).some((name) => {
          const tool = (ctx.realTools ?? []).find((candidate) => candidate.name === String(name));
          return requiresAttemptGrantPolicy(tool && {
            operation: tool.operation,
            effectScope: tool.effectScope,
            sandboxPolicy: tool.sandboxPolicy,
          });
        }),
        hasCompensation: Boolean(String(args.compensation_event ?? "").trim()),
      });
      const first = designSelfCheck(draftOf());
      if (first.hardCount > 0 && isGatewayConfigured() && innerLoopEnabled()) {
        const refined = await internalDesignRefine(draftOf(), first.issues, (sys, usr) =>
          chatJson<{ system_prompt?: string; decision_logic?: string }>(sys, usr, { temperature: 0.3, maxTokens: 3000, signal: ctx.signal, models: modelChain("review"), purpose: "design_self_refine" }),
        );
        if (refined) {
          rawPrompt = refined.systemPrompt;
          rawLogic = refined.decisionLogic;
          const after = designSelfCheck(draftOf());
          ctx.emit({ t: "reflect", kind: "design-refine", lesson: `内部设计自审「${name}」：修掉 ${first.hardCount - after.hardCount}/${first.hardCount} 处硬问题（${first.issues.filter((i) => i.hard).slice(0, 2).map((i) => i.message).join("；")}）` });
        }
      }
    }

    // ── tool/runtime grounding (de-hallucinate + explicit selection) ──
    // Re-read here instead of trusting read_ontology's earlier catalog: an FDE
    // may have configured/probed an adapter while this conversation was parked.
    let resources: CurrentExecutionResources;
    try {
      resources = await currentExecutionResources(ctx);
    } catch {
      return executionResourcesUnavailable(`agent「${name}」`);
    }
    ctx.realTools = resources.realTools;
    ctx.toolCatalog = [...new Set([
      ...buildToolCatalog(ctx.ontology),
      ...resources.realTools.map((tool) => tool.name),
    ])];
    const explicitPicks = Array.isArray(args.tools)
      ? (args.tools as unknown[]).map(String).map((value) => value.trim()).filter(Boolean)
      : [];
    const authoritativeExecutionPicks = ontologyDeclaredExecutionTools(action);
    const ontologyPicks = [...new Set([
      ...authoritativeExecutionPicks,
      ...(action.tool_use ?? [])
        .map(String)
        .map((value) => value.trim())
        .filter(Boolean),
    ])];
    let selectionSource = explicitPicks.length
      ? "design_agent.tools"
      : authoritativeExecutionPicks.length
        ? "ontology.action_steps"
        : ontologyPicks.length
        ? "ontology.action.tool_use"
        : "none";
    const discoveryBinding = resolveIntegrationBindings(action, resources.realTools, {
      capabilityProviders: resources.capabilityProviders,
      systemAliasGroups: resources.systemAliasGroups,
    });
    const ambiguousDiscovery = discoveryBinding.bindings.filter((binding) => binding.selectionRequired);
    if (selectionSource === "none" && ambiguousDiscovery.length) {
      return askUserForIntegrationChoice({
        actionName: name,
        reason: "integration_selection_required",
        candidates: humanIntegrationCandidates({
          ready: false,
          bindings: ambiguousDiscovery,
          counts: discoveryBinding.counts,
        }),
        detail: "同一个 integration 有多个同分候选，能力元数据不足以证明该选哪一个",
      });
    }
    // #TOOLUSE-AS-SUGGESTION — the ontology's tool_use[] is a SUGGESTION list, authored against
    // whatever tools existed when the ontology was written; the AUTHORITATIVE requirement is the
    // action's integration.systems[]. So ALWAYS run integration discovery — the granted transport
    // for each requirement (facts.query / entities.write / ontology.writeInstance / … via wildcard
    // capability match) is what actually executes. A suggested name this tenant does not grant is
    // dropped to `unresolved` and the discovered granted transport is used in its place — never a
    // hard block. (Genuinely uncovered requirements still fail closed at the integration gate below.)
    const uniqueDiscoveredTools = [...new Set(discoveryBinding.bindings
      .filter((binding) => !binding.selectionRequired)
      .map((binding) => binding.toolName ?? (binding.bindingKind === "tool" ? binding.bindingId : undefined))
      .filter((value): value is string => Boolean(value)))];
    if (isGate && !uniqueDiscoveredTools.some((toolName) => {
      const tool = resources.realTools.find((candidate) => candidate.name === toolName);
      return Boolean(tool && toolReadsRulebase(tool));
    })) {
      const ruleCandidates = resources.realTools.filter(toolReadsRulebase).map((tool) => tool.name);
      if (ruleCandidates.length === 1) uniqueDiscoveredTools.push(ruleCandidates[0]!);
    }
    // action_steps[].tool / integration via_tool are execution identity, not a
    // fuzzy suggestion. Resolve only declared aliases and fail closed if the
    // current registry cannot prove the exact adapter/policy.
    const authoritativeGrounded = groundToolPicks(
      authoritativeExecutionPicks,
      ctx.toolCatalog ?? [],
    );
    if (authoritativeGrounded.unresolved.length) {
      const question = `Ontology 为动作「${name}」的 action_steps/integration 明确声明了这些执行工具，但当前 registry 无法解析：${authoritativeGrounded.unresolved.join("、")}。请接入这些准确工具（或在 Ontology 中显式修正声明）；我不会用语义相近候选替换。`;
      return {
        ok: false,
        summary: question,
        output: {
          next: "ask_user",
          reason: "ontology_execution_tool_missing",
          question,
          missing: authoritativeGrounded.unresolved,
        },
      };
    }
    const authoritativePolicies = selectedToolPolicies(
      authoritativeGrounded.resolved,
      resources.realTools,
    );
    if (authoritativePolicies.missing.length) {
      const question = `Ontology 明确声明的执行工具缺少完整策略：${authoritativePolicies.missing.join("、")}。请补齐 operation、effectScope 和 sandboxPolicy；权威 step 工具不能被静默丢弃或替换。`;
      return {
        ok: false,
        summary: question,
        output: {
          next: "ask_user",
          reason: "tool_execution_policy_missing",
          question,
          missing: authoritativePolicies.missing,
        },
      };
    }
    // Explicit model picks may add tools, but can never remove the
    // authoritative execution bindings. Discovery remains a supplement.
    const picks = [...new Set([
      ...authoritativeExecutionPicks,
      ...(explicitPicks.length ? explicitPicks : ontologyPicks),
    ])];
    const grounded = groundToolPicks(picks, ctx.toolCatalog ?? []);
    const groundedPolicies = selectedToolPolicies(grounded.resolved, resources.realTools);
    // #TOOLUSE-ECHO — an explicit pick that merely ECHOES the ontology's tool_use[] is still a
    // SUGGESTION, not a deliberate model choice: fleet members and cautious solo turns routinely
    // copy tool_use into `tools`, and hard-asking about those re-parked every run with the same
    // templated question even though the granted transports fully cover the requirements (the live
    // "还有 5 个 Agent 需要补充…" loop). Only a policy-missing name the model introduced BEYOND the
    // ontology is a real hallucination/no-policy error worth a hard ask. Never silently substitute
    // those.
    const ontologyNameSet = new Set(ontologyPicks);
    const rawNamesOf = (resolved: string): string[] => [
      resolved,
      ...grounded.bridged.filter((bridge) => bridge.resolved === resolved).map((bridge) => bridge.raw),
    ];
    const novelMissing = explicitPicks.length
      ? groundedPolicies.missing.filter((name) => !rawNamesOf(name).some((raw) => ontologyNameSet.has(raw)))
      : [];
    if (novelMissing.length) {
      const question = `这些工具还没有完整、可审核的执行策略：${novelMissing.join("、")}。请先在工具库里明确 operation、effectScope 和 sandboxPolicy；我不会根据名字、HTTP 方法或旧的 read/write 标签来猜。`;
      return {
        ok: false,
        summary: question,
        output: { next: "ask_user", reason: "tool_execution_policy_missing", question, missing: novelMissing },
      };
    }
    // Ontology suggestions this tenant does not grant → drop them to `unresolved` (surfaced honestly).
    const grantedPickNames = grounded.resolved.filter((toolName) => !groundedPolicies.missing.includes(toolName));
    const ungrantedSuggestions = grounded.resolved.filter((toolName) => groundedPolicies.missing.includes(toolName));
    if (ungrantedSuggestions.length) grounded.unresolved = [...new Set([...grounded.unresolved, ...ungrantedSuggestions])];
    // Discovery only SUPPLEMENTS requirements the granted picks don't already cover — an author whose
    // grant is sufficient keeps exactly their tool set (and its source label).
    const addedByDiscovery = uniqueDiscoveredTools.filter((toolName) => !grantedPickNames.includes(toolName));
    const tools = [...new Set([...grantedPickNames, ...addedByDiscovery])];
    if (picks.length === 0 && addedByDiscovery.length) {
      selectionSource = "unique_capability_binding"; // pure auto-discovery (no author picks)
    } else if (addedByDiscovery.length) {
      selectionSource = `${selectionSource}+integration_binding`; // picks PLUS substituted transports
    }
    const selectedRuleTools = tools.filter((toolName) => {
      const tool = resources.realTools.find((candidate) => candidate.name === toolName);
      return Boolean(tool && toolReadsRulebase(tool));
    });
    if (isGate && selectedRuleTools.length === 0) {
      const availableRuleCandidates = resources.realTools
        .filter(toolReadsRulebase)
        .map((tool): HumanIntegrationCandidate => ({ kind: "tool", id: tool.name, status: "available_rule_tool" }));
      return askUserForIntegrationChoice({
        actionName: name,
        reason: "rule_tool_selection_required",
        candidates: availableRuleCandidates,
        detail: "这个动作看起来承担规则校验，但 Ontology 和本次显式选择都没有绑定一个带规则读取 capability 的工具",
      });
    }
    const executablePolicies = selectedToolPolicies(tools, resources.realTools);
    if (executablePolicies.missing.length) {
      const question = `这些自动发现的工具还没有完整、可审核的执行策略：${executablePolicies.missing.join("、")}。请先在工具库里明确 operation、effectScope 和 sandboxPolicy；唯一 capability 候选也不能绕过执行策略门。`;
      return {
        ok: false,
        summary: question,
        output: {
          next: "ask_user",
          reason: "tool_execution_policy_missing",
          question,
          missing: executablePolicies.missing,
        },
      };
    }

    let systemPrompt = rawPrompt; // 可能已被内部设计循环精修；不再偷偷注入规则工具指令
    const profileScope = {
      tenantId: ctx.ports?.factoryScope?.tenantId,
      tenantSlug: ctx.ports?.factoryScope?.tenantSlug,
      domainId: ctx.domain,
      environment: "production" as const,
      actionName: action.name,
      requiredObjects: [...new Set([
        ...(action.target_objects ?? []),
        ...deriveIntegrationRequirements(action).flatMap((requirement) => requirement.objectTypes),
      ])],
    };
    const parsedToolConfigs = rejectDirectDesignToolConfigs(args.tool_configs);
    if (!parsedToolConfigs.ok) return { ok: false, summary: `agent「${name}」的运行配置无效：${parsedToolConfigs.error}。` };
    const selectedToolEvidence = selectedToolDeploymentEvidence({
      ctx,
      actionName: action.name,
      requiredObjects: profileScope.requiredObjects,
      selectedTools: tools,
      realTools: resources.realTools,
      productionProfileRefs: args.production_tool_profiles ?? args.tool_profiles,
      sandboxProfileRefs: args.sandbox_tool_profiles,
    });
    if (!selectedToolEvidence.ok) {
      return {
        ok: false,
        summary: selectedToolEvidence.question,
        output: {
          next: "ask_user",
          reason: selectedToolEvidence.reason,
          question: selectedToolEvidence.question,
          missing: selectedToolEvidence.missing,
          ...selectedToolEvidence.details,
        },
      };
    }
    const toolConfigs = { ...selectedToolEvidence.productionConfigs };
    const sandboxToolConfigs = { ...selectedToolEvidence.sandboxConfigs };
    // weave in any skills the brain created this run
    if (ctx.createdSkills.length) {
      const frags = ctx.createdSkills.map((s) => `· ${s.name}：${s.decisionRule}`).join("\n");
      if (!systemPrompt.includes("【可复用技能】")) {
        systemPrompt += `\n\n【可复用技能】\n${frags}`;
        // Count each skill ACTUALLY woven into a delivered agent, so the effectiveness signal
        // (useCount vs successful-run evals) is meaningful for ranking reuse — weaving was the one
        // path that bumped nothing (only the explicit use_skill tool did).
        if (ctx.ports.skills?.bumpUse) {
          for (const s of ctx.createdSkills) await ctx.ports.skills.bumpUse(kebab(s.name));
        }
      }
    }
    // R3: compile the action's submission_criteria into a fail-close precondition block.
    const criteria = typeof action.submission_criteria === "string" ? action.submission_criteria.trim() : "";
    if (criteria && !systemPrompt.includes("【前置条件")) {
      systemPrompt += `\n\n【前置条件（运行前必须满足；不满足则 fail-close 发拦截/失败事件，不要继续）】\n${criteria}`;
    }

    const decisionTableBlock = decisionTablesPromptBlock(decisionTables);
    if (decisionTableBlock) {
      systemPrompt += `\n\n${decisionTableBlock}`;
      rawLogic += `\n\n${decisionTableBlock}`;
    }

    const authored = { systemPrompt, tools, decisionLogic: rawLogic, reasoning: typeof args.reasoning === "string" ? args.reasoning : "", toolRationale: String(args.tool_rationale ?? "") };
    // R1: ground I/O on the canonical event_data (trigger/emit events' payload) so the
    // spec carries the AUTHORITATIVE fields even if the AI under-typed; AI annotations layer on.
    const inputSchema = mergeFields(parseIoSchema(args.input_schema), eventFieldsOf(action.trigger ?? [], ctx.ontology));
    const outputSchema = mergeFields(parseIoSchema(args.output_schema), eventFieldsOf(action.triggered_event ?? [], ctx.ontology));
    // Phase 1 — optional STRUCTURED plan. When the brain authors one, enforce production
    // discipline (side-effecting steps need idempotencyKeyFrom + onError; deps reference prior
    // steps) and REJECT a sloppy plan (mirrors the empty-prompt rejection). No plan → the deploy
    // falls back to a single logic action (back-compat).
    const plan = canonicalizePlanExecutionTools(
      parsePlan(args.plan),
      ctx.toolCatalog ?? [],
    );
    if (decisionTables.length && plan.some((step) => step.kind === "emit" || step.body?.some((child) => child.kind === "emit"))) {
      return {
        ok: false,
        summary: `agent「${name}」同时声明了 decision_tables 与固定 emit step，路由来源冲突，已阻断。结构化表会决定 emitEvent；请移除固定 emit，或把该分支完全改成显式 plan（两者只选一个）。`,
        output: { decisionTableErrors: ["decision_tables_conflict_with_explicit_emit"] },
      };
    }
    const ontologyPlanErrors = validatePlanAgainstOntology(
      canonicalizeOntologyExecutionTools(
        action,
        ctx.toolCatalog ?? [],
      ),
      plan,
    );
    if (ontologyPlanErrors.length) {
      const requirement = analyzeExecutionPlanRequirement(action);
      return {
        ok: false,
        summary: `agent「${name}」会把本体执行语义压扁成单步 logic，已阻断：${ontologyPlanErrors.join("；")}`,
        output: { planErrors: ontologyPlanErrors, executionPlanRequirement: requirement },
      };
    }
    let planWarnings: string[] = [];
    if (plan.length) {
      const planCheck = validatePlan(plan, { knownTools: tools, declaredEvents: action.triggered_event ?? [] });
      if (!planCheck.ok) {
        return { ok: false, summary: `agent「${name}」的 plan 不合格——修正后重交：${planCheck.errors.slice(0, 5).join("；")}`, output: { planErrors: planCheck.errors } };
      }
      planWarnings = planCheck.warnings;
    }

    // Semantic recommendation is discovery only. An Ontology-declared system
    // boundary is authorable only when one exact selected tool/runtime covers
    // system/kind/role/operation/object. Config+probe are intentionally retained
    // as later-stage statuses; they block sandbox/promotion, not draft creation.
    const integrationBindingRaw = resolveIntegrationBindings(action, resources.realTools, {
      boundToolNames: tools,
      plan,
      toolConfigs,
      capabilityProviders: resources.capabilityProviders,
      systemAliasGroups: resources.systemAliasGroups,
      toolProfiles: selectedToolEvidence.productionProfiles,
      executionScope: {
        tenantId: ctx.ports?.factoryScope?.tenantId,
        tenantSlug: ctx.ports?.factoryScope?.tenantSlug,
        domainId: ctx.domain,
      },
    });
    // #HUMAN-BOUNDARY — human-confirmed manual boundaries (server-recorded from a clarify answer)
    // are no longer identity gaps: authoring proceeds and the spec records an honest
    // status:"human_boundary" binding. `ready` stays as resolved computed it, so every
    // execution-stage consumer still sees the integration as NOT ready.
    const integrationBinding = {
      ...integrationBindingRaw,
      bindings: applyIntegrationHumanBoundaries(integrationBindingRaw.bindings, [
        ...(ctx.integrationHumanBoundaries ?? []),
        ...resources.systemProfileBoundaries,
      ]),
    };
    if (!integrationBinding.ready) {
      const ambiguousBindings = integrationBinding.bindings.filter((binding) => binding.selectionRequired);
      if (ambiguousBindings.length) {
        return askUserForIntegrationChoice({
          actionName: name,
          reason: "ambiguous_integration_binding",
          candidates: humanIntegrationCandidates({
            ready: false,
            bindings: ambiguousBindings,
            counts: integrationBinding.counts,
          }),
          detail: "有多个同分的工具/运行时能力都满足当前 integration，单靠排序无法证明该选哪一个",
        });
      }
      const identityGaps = integrationBinding.bindings
        .filter((binding) =>
          binding.status === "missing"
          && !binding.bindingId
          && !binding.toolName
          && !binding.requirement.authoringOptional);
      if (identityGaps.length) {
        const gaps = identityGaps
        .slice(0, 5)
        .map((binding) => `${binding.requirement.system}/${binding.requirement.role}:${binding.status}${binding.toolName ? `(${binding.toolName})` : ""}`);
        // #HUMAN-BOUNDARY — record the EXACT pairs this card asks about; the conductor consumes a
        // 人工边界-affirming answer against THIS set (never a model-supplied list) and persists it.
        ctx.pendingIntegrationBoundaryAsk = identityGaps.map((binding) => ({
          system: binding.requirement.system,
          mode: binding.requirement.role,
        }));
        const question = `agent「${name}」还不知道由哪个真实执行面连接这些系统：${gaps.join("；")}${identityGaps.length > gaps.length ? "…" : ""}。请确认真实工具、运行时能力或人工边界；我不会根据描述猜一个接口。若这些系统属于尚未建好的人工/外部环节，回复中明确说「确认人工边界」即可把上述缺口保留为人工边界（设计稿可继续；沙箱/交付/晋升仍会拦截）。`;
        return {
          ok: false,
          summary: question,
          output: {
            next: "ask_user",
            reason: "integration_contract_missing",
            question,
            missing: ["integration identity and contract"],
            integrationBinding,
            provisioning: {
              needed: true,
              options: ["search_tools", "create_tool", "extract_api_schema", "ask_user"],
            },
          },
        };
      }
    }

    const compiledInputBindings = compileInputBindings(action, {
      plan,
      selectedTools: tools,
      registeredTools: resources.realTools,
      integrationBindings: integrationBinding.bindings,
      toolConfigs,
      toolProfileRefs: selectedToolEvidence.productionRefs,
      env: process.env,
      mode: "authoring",
    });
    if (!compiledInputBindings.ok) {
      const gaps = compiledInputBindings.errors.slice(0, 6);
      return {
        ok: false,
        summary: `agent「${name}」的输入还不能安全执行，已阻断：${gaps.map((gap) => `${gap.field}：${gap.message}`).join("；")}${compiledInputBindings.errors.length > gaps.length ? "…" : ""}。请用 ask_user 让用户补齐明确的来源、查找参数/结果路径或真实集成；不要猜字段、凭证或工具响应。`,
        output: {
          inputBindingErrors: compiledInputBindings.errors,
          inputBindingWarnings: compiledInputBindings.warnings,
          next: "ask_user",
        },
      };
    }

    const spec = buildSpec(action, ctx.domain, authored, inputSchema, outputSchema, compiledInputBindings.bindings);
    // Policies for the FINAL executable set (granted picks ∪ discovered transports), all granted by
    // construction — `.missing` is empty here, so `.values` covers every tool the spec will run.
    spec.toolPolicies = executablePolicies.values;
    spec.toolSideEffects = selectedLegacyToolSideEffects(tools, resources.realTools);
    spec.ruleRefs = actionRuleResolution.relevantRules
      .map((rule) => rule.id || rule.name)
      .filter(Boolean);
    if (decisionTables.length) spec.decisionTables = decisionTables;
    if (Object.keys(toolConfigs).length) spec.toolConfigs = toolConfigs;
    if (Object.keys(selectedToolEvidence.productionRefs).length) spec.toolProfileRefs = selectedToolEvidence.productionRefs;
    if (Object.keys(sandboxToolConfigs).length) spec.sandboxToolConfigs = sandboxToolConfigs;
    if (Object.keys(selectedToolEvidence.sandboxRefs).length) spec.sandboxToolProfileRefs = selectedToolEvidence.sandboxRefs;
    spec.integrationRequirements = deriveIntegrationRequirements(action);
    spec.integrationBindings = integrationBinding.bindings;
    // 显示名（非角色设定——角色属于过程 agents）：AI 给的显示名优先于描述截断兜底，
    // 仅供 UI 称呼；缺省时保留 buildSpec 的自动派生（永不为空）。
    const roleName = String(args.role_name ?? "").trim().slice(0, 18);
    if (roleName) spec.nameZh = roleName;
    if (plan.length) spec.plan = plan;
    spec.unresolvedTools = grounded.unresolved;
    // #SAGA — 补偿事件透传到 spec → mapToManifest 的 compensation_event → runtime 硬失败时幂等 emit。
    const comp = String(args.compensation_event ?? "").trim();
    if (comp) spec.compensationEvent = comp;
    spec.stateBindings = deriveStateBindings(action, ctx.ontology); // R5
    // auto-render readable code so every agent HAS code (codegen_agent can override w/ AI code), and
    // GRADE it so a compilable+safe render actually EXECUTES in the sandbox (true CodeAct), not just
    // sits there as a scaffold — this is what makes "生成的 code" really run.
    spec.codeSource = "render";
    await renderExecutableCode(spec);

    // warnings
    const promptText = `${systemPrompt}\n${authored.decisionLogic}`;
    const knownEv = new Set(ctx.ontology.actions.flatMap((a) => [...a.trigger, ...a.triggered_event]));
    const ungrounded = ungroundedEventTokens([promptText], knownEv);
    // #9: a non-gate agent leaks a rule if its prompt embeds a specific ontology rule identifier —
    // domain-agnostic (was a fixed Chinese-keyword + RAAS rule-id-regex check that never fired for
    // other domains, letting real leaks through).
    const ruleLeak = !isGate && promptEmbedsRule(promptText, ruleIdentifiers(ctx));

    ctx.specs = ctx.specs.filter((s) => s.actionName !== name);
    ctx.specs.push(spec);
    ctx.lastSandbox = null;
    ctx.emit({ t: "agent.created", spec: cardOf(spec), design: designOf(spec), forAgent: spec.actionName });
    ctx.emit({ t: "code", actionName: name, code: spec.generatedCode ?? "", codeSource: "render" });
    const execNote = spec.codeExecuted ? " · ⚙ 代码已过 编译+安全+加载探针，沙箱将真实执行（CodeAct）" : ` · 📄 声明式执行${spec.probeReason ? `（代码未过加载探针：${spec.probeReason}）` : ""}`;

    const agentActionNames = generationScopedAgentActionNames(ctx);
    const done = new Set(ctx.specs.map((s) => s.actionName));
    const remaining = agentActionNames.filter((n) => !done.has(n));
    const integrationGaps = (spec.integrationBindings ?? []).filter((binding) => binding.status !== "resolved");
    // #KEY-GAP — a BOUND, resolved tool can still be unusable if its REQUIRED credential env isn't set
    // on this deployment. Detect generically (each tool self-declares credentialEnv — NO tool name is
    // hardcoded) so the brain can reason + ask_user to RECOMMEND the operator configure the key. This
    // is only a SIGNAL: the brain decides whether the key is actually needed on the exercised path
    // before asking — never auto-filled, never hardcoded.
    const missingCred = detectMissingToolCredentials(spec.tools, ctx.realTools ?? [], process.env, spec.toolConfigs ?? {});
    const warn =
      (grounded.bridged.length ? ` · 🔗 工具名已对到真名：${grounded.bridged.map((b) => `${b.raw}→${b.resolved}`).join("、")}` : "") +
      (grounded.unresolved.length ? ` · ⚠ 工具库没有：${grounded.unresolved.join("、")}。【先 ask_user，禁止造桩】给选项：①接入真实工具/补该外部 API 的 I/O+凭证（recommended）②去掉或合并该 agent。` : "") +
      (integrationGaps.length ? ` · ⚠ Ontology 声明的执行能力尚未就绪：${integrationGaps.slice(0, 3).map((binding) => `${binding.requirement.system}/${binding.requirement.role}:${binding.status}`).join("；")}${integrationGaps.length > 3 ? "…" : ""}。按具体状态补配置、探针或让用户确认，不能用零工具与否来猜。` : "") +
      (missingCred.length ? ` · ⚠ 已绑工具缺凭证：${missingCred.map((m) => `${m.tool}（需环境变量 ${m.missingEnv.join(" 或 ")}，当前未配置）`).join("；")}。【可 ask_user】推荐用户在部署环境补上该 key，或选择其它已真实接入的工具——别把没配 key 的工具当能真跑。` : "") +
      (ungrounded.length ? ` · ⚠ prompt 出现本体没有的事件名:${ungrounded.join("、")}` : "") +
      (ruleLeak ? " · ⚠ 非校验 agent 写进了具体规则，应只属于校验闸口且运行时动态抓" : "") +
      (selectedRuleTools.length ? ` · 🔒 规则读取工具来自明确选择：${selectedRuleTools.join("、")}` : "") +
      (!selectedToolEvidence.readiness.sandboxReady
        ? ` · ⏭ 草稿已生成；沙箱前还需：${selectedToolEvidence.readiness.sandboxBlockers.slice(0, 3).join("；")}`
        : !selectedToolEvidence.readiness.promotionReady
          ? ` · ⏭ 沙箱前置已就绪；晋升前还需：${selectedToolEvidence.readiness.promotionBlockers.slice(0, 3).join("；")}`
          : "") +
      (plan.length ? ` · 🧭 已采纳 ${plan.length} 步可重放 plan（每步独立 step.run）${planWarnings.length ? ` · ⚠ ${planWarnings.length} 个旧式 whole-carry 工具步骤未声明精确 toolArguments` : ""}` : " · 💡 建议补一份多步 plan（每个外部/写入步骤独立可重放）");
    return {
      ok: true,
      summary: `已提交「${spec.nameZh}」(${agentActionNames.length - remaining.length}/${agentActionNames.length}) · 工具 ${spec.tools.length} 个 · 已渲染代码${execNote}${warn}${selectionSource === "ontology.action.tool_use" ? "｜tools 留空，已按 Ontology action.tool_use 的明确声明绑定" : ""}`,
      output: {
        committed: spec.short, tools: spec.tools, unresolved: spec.unresolvedTools, toolSelectionSource: selectionSource, planWarnings, done: agentActionNames.length - remaining.length, total: agentActionNames.length, remaining, needsCodegen: false,
        readiness: selectedToolEvidence.readiness,
        // #W3-1 — PROACTIVE provisioning: a structured gap signal (not just prose warnings) so the
        // brain/UI can act on "this agent lacks a capability" with concrete next actions.
        provisioning: integrationGaps.length || grounded.unresolved.length || missingCred.length
          ? { needed: true,
              gaps: [...new Set([
                ...integrationGaps.map((binding) => `integration_${binding.status}`),
                ...(grounded.unresolved.length ? ["unresolved_tools"] : []),
                ...(missingCred.length ? ["missing_credential"] : []),
              ])],
              options: ["search_tools", "create_tool", "extract_api_schema", "ask_user", "design_subagent"],
              suggested: rankRealTools(action, ctx.realTools ?? []).slice(0, 3),
              // #KEY-GAP — concrete {tool, missingEnv} so the brain/UI can ask_user for the exact env(s).
              missingCredentials: missingCred.length ? missingCred : undefined }
          : { needed: false },
      },
    };
  },
};

// #NEST design-time — decompose a COMPLEX parent agent into a parent + a deployable SUB-AGENT the
// parent invokes SYNCHRONOUSLY via a plan `kind:"invoke"` step (the "harness within harness").
// The sub-agent is a real registered function (excluded from ontology coverage — it's a helper, not
// an Agent action). ALSO the promotion path: pass `code` to formalize a runtime ctx.spawn-discovered
// sub-agent into a deployable one. Both P and S deploy → the end goal (deployable functions) holds.
const design_subagent: BrainTool = {
  name: "design_subagent",
  description:
    "把一个已 design_agent 的【复杂父 agent】拆出一个【子 agent】——可部署的辅助函数，父 agent 通过 plan 的 invoke 步骤同步调它（层层套的 harness）。子 agent 不是本体动作、不计入覆盖，但会真实注册+被父 invoke。用于把大 agent 分解成 父+子 都能上线的函数。也用于【固化】运行时 ctx.spawn 出来的子 agent：把它的完整 .ts 代码用 code 参数传进来即晋升为可部署子 agent（会过 TS+安全校验）。",
  parameters: params(
    {
      critical: { type: "boolean", description: "（建议显式声明）这个子任务对父 agent 是否关键：true=子失败即父失败（terminal）；false/缺省=失败降级为空结果继续（soft）。按业务后果判断，别默认都非关键。" },
      parent_action: { type: "string", description: "父 agent 的动作名（已 design_agent）" },
      task: { type: "string", description: "子 agent 负责的子任务（一句话，决定它的 slug）" },
      system_prompt: { type: "string", description: "子 agent 的中文系统提示（职责/决策）；不写会按父+任务生成一句" },
      decision_logic: { type: "string", description: "子 agent 的分支决策逻辑；不写会按父+任务合成一句（UI 卡片读它）" },
      tools: { type: "array", items: { type: "string" }, description: "子 agent 用的工具（真名，可空）" },
      tool_profiles: { type: "object", additionalProperties: { type: "string" }, description: "兼容字段：toolName→已确认的正式环境连接配置。建议使用 production_tool_profiles。" },
      production_tool_profiles: { type: "object", additionalProperties: { type: "string" }, description: "toolName→用户已确认的正式环境连接配置 id/key。" },
      sandbox_tool_profiles: { type: "object", additionalProperties: { type: "string" }, description: "toolName→用户已确认的独立测试环境连接配置 id/key；不能复用正式环境。" },
      input_schema: { type: "array", items: { type: "object", properties: { field: { type: "string" }, type: { type: "string" }, description: { type: "string" }, required: { type: "boolean" } }, required: ["field", "type"], additionalProperties: false }, description: "子 agent 输入字段（可空）" },
      output_schema: { type: "array", items: { type: "object", properties: { field: { type: "string" }, type: { type: "string" }, description: { type: "string" }, required: { type: "boolean" } }, required: ["field", "type"], additionalProperties: false }, description: "子 agent 输出字段（可空）" },
      code: { type: "string", description: "（可选）子 agent 的完整 .ts handler——用于晋升 ctx.spawn 出来的子 agent；过 TS+安全校验才采纳" },
      idempotency_key_from: { type: "string", description: "（可选）父 invoke 步骤的可重放业务键字段名；不填默认取父输入首字段/subject" },
    },
    ["parent_action", "task"],
  ),
  async execute(args, ctx) {
    const parentName = String(args.parent_action ?? "").trim();
    const parent = ctx.specs.find((s) => s.actionName === parentName && !s.isSubAgent);
    if (!parent) return { ok: false, summary: `没找到父 agent「${parentName}」——先 design_agent 它（子 agent 必须挂在一个已设计的父上）。` };
    const task = String(args.task ?? "").trim();
    if (!task) return { ok: false, summary: "task（子任务）不能为空。" };

    const taskKebab = (kebab(task).replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 24)) || "sub";
    const subSlug = `${parent.slug}-sub-${taskKebab}`;
    const subShort = subSlug; // = the manifest `name` fnRegistry indexes → the parent's invoke target
    const subActionName = `${parentName}__${taskKebab}`;
    // Collision guard: two DIFFERENT tasks that kebab to the same slug would silently clobber each
    // other (data loss). Reject with a clear message so the user disambiguates the task wording.
    const collides = ctx.specs.find((s) => s.slug === subSlug && s.isSubAgent && s.parentTask !== task);
    if (collides) return { ok: false, summary: `子任务命名冲突：「${collides.parentTask}」与「${task}」都规整成同一个 slug「${subSlug}」。换一个更具体的 task 描述来区分。`, output: { collision: true, collidesWith: collides.parentTask } };
    let resources: CurrentExecutionResources;
    try {
      resources = await currentExecutionResources(ctx);
    } catch {
      return executionResourcesUnavailable(`子 Agent「${task}」`);
    }
    ctx.realTools = resources.realTools;
    const grounded = groundToolPicks(Array.isArray(args.tools) ? (args.tools as string[]).map(String).filter(Boolean) : [], [
      ...(ctx.toolCatalog ?? []),
      ...resources.realTools.map((tool) => tool.name),
    ]);
    if (grounded.unresolved.length) {
      const question = `子 Agent 选中的这些工具在当前运行环境里不存在：${grounded.unresolved.join("、")}。请先接入真实工具，或明确改用工具库里已经存在的工具；我不会先生成一个假工具占位。`;
      return { ok: false, summary: question, output: { next: "ask_user", reason: "selected_tool_missing", question, missing: grounded.unresolved } };
    }
    const subPolicies = selectedToolPolicies(grounded.resolved, resources.realTools);
    if (subPolicies.missing.length) {
      const question = `子 Agent 选中的工具缺少完整执行策略：${subPolicies.missing.join("、")}。请先补 operation、effectScope 和 sandboxPolicy，我不会替你猜。`;
      return { ok: false, summary: question, output: { next: "ask_user", reason: "tool_execution_policy_missing", question, missing: subPolicies.missing } };
    }
    const deploymentEvidence = selectedToolDeploymentEvidence({
      ctx,
      actionName: subActionName,
      requiredObjects: [...new Set(parent.objects ?? [])],
      selectedTools: grounded.resolved,
      realTools: resources.realTools,
      productionProfileRefs: args.production_tool_profiles ?? args.tool_profiles,
      sandboxProfileRefs: args.sandbox_tool_profiles,
    });
    if (!deploymentEvidence.ok) {
      return {
        ok: false,
        summary: deploymentEvidence.question,
        output: {
          next: "ask_user",
          reason: deploymentEvidence.reason,
          question: deploymentEvidence.question,
          missing: deploymentEvidence.missing,
          ...deploymentEvidence.details,
        },
      };
    }
    const inputSchema = parseIoSchema(args.input_schema);
    const outputSchema = parseIoSchema(args.output_schema);

    const sub: GeneratedAgentSpec = {
      key: subActionName, actionName: subActionName, slug: subSlug, short: subShort, domainId: parent.domainId,
      nameZh: `${parent.nameZh}·子[${task.slice(0, 14)}]`, kind: "llm",
      // synthetic internal trigger so the Inngest fn registers cleanly; NEVER event-fired (only
      // step.invoke'd) and excluded from the event graph (isSubAgent).
      trigger: [`${subSlug}.invoked`], emit: [], tools: grounded.resolved, unresolvedTools: grounded.unresolved, objects: [],
      toolPolicies: subPolicies.values,
      toolSideEffects: selectedLegacyToolSideEffects(grounded.resolved, resources.realTools),
      systemPrompt: String(args.system_prompt ?? "").trim() || `你是「${parent.nameZh}」的子 agent，专注完成一个子任务：${task}。用给定输入推理并返回结构化结果。`,
      // Sub-agents previously shipped with an EMPTY decisionLogic (the spec field is required,
      // but the literal skipped it behind the cast) — the UI's 决策逻辑 button rendered dead.
      // Author it or synthesize a truthful one from the invoke contract.
      decisionLogic:
        String(args.decision_logic ?? "").trim() ||
        `被父「${parent.nameZh}」的 plan invoke 步同步调用：按输入完成「${task}」并返回结构化结果；失败抛错，由父步骤的 onError(soft) 用 defaultResult 兜底，不阻断父链路。`,
      userPrompt: "", steps: [], ruleRefs: [], retries: 1, hitl: false, confidence: 1, promptSource: "llm",
      inputSchema, outputSchema, designReasoning: `父「${parent.nameZh}」的子任务分解：${task}`,
      isSubAgent: true, parentAction: parentName, parentTask: task,
    } as GeneratedAgentSpec;
    if (Object.keys(deploymentEvidence.productionConfigs).length) sub.toolConfigs = deploymentEvidence.productionConfigs;
    if (Object.keys(deploymentEvidence.productionRefs).length) sub.toolProfileRefs = deploymentEvidence.productionRefs;
    if (Object.keys(deploymentEvidence.sandboxConfigs).length) sub.sandboxToolConfigs = deploymentEvidence.sandboxConfigs;
    if (Object.keys(deploymentEvidence.sandboxRefs).length) sub.sandboxToolProfileRefs = deploymentEvidence.sandboxRefs;

    // Code: promotion (given code) OR render+grade.
    const providedCode = args.code ? String(args.code) : "";
    let promoted = false;
    if (providedCode.trim()) {
      const v = await validateAgentCode(providedCode);
      if (!v.ok) return { ok: false, summary: `晋升的子 agent 代码没过 TS 校验：${v.errors.slice(0, 3).join("；")}`, output: { errors: v.errors } };
      const lint = lintGeneratedToolCode(providedCode);
      if (!lint.ok) return { ok: false, summary: `子 agent 代码安全校验未过（禁危险 API）：${lint.violations.slice(0, 3).join("；")}`, output: { violations: lint.violations } };
      const allowlist = validateGeneratedToolAllowlist(providedCode, sub.tools);
      if (!allowlist.ok) {
        return {
          ok: false,
          summary: `子 agent 代码调用了未审查的工具，已拒绝：${allowlist.violations.slice(0, 3).join("；")}。请先把真实工具加入 tools，并完成连接配置与安全测试；不能只在代码里写一个工具名。`,
          output: { next: "ask_user", reason: "generated_code_tool_allowlist_mismatch", violations: allowlist.violations, undeclaredTools: allowlist.undeclaredTools },
        };
      }
      // #REDESIGN FU3 — full reviewLoop on promotion too: compile ✓ + AST-lint ✓ + PROBE (loads a
      // callable handler). A promoted spawn that compiles+lints but exposes no handler must NOT claim
      // executable — reject it so the brain fixes the code before it becomes a deployable sub-agent.
      const probe = await probeAgentModule(providedCode);
      if (!probe.loads) return { ok: false, summary: `晋升的子 agent 代码未过加载探针（编译+安全过了，但没有可调用 handler）：${probe.reason}`, output: { probeReason: probe.reason } };
      sub.generatedCode = providedCode;
      sub.codeSource = "ai";
      const ownership = generatedSpecExecutionOwnership(sub, providedCode);
      if (ownership.codeActEligible) {
        const coverage = validateGeneratedToolCoverage(providedCode, sub.tools);
        if (!coverage.ok) {
          return {
            ok: false,
            summary: `子 agent 的 CodeAct handler 没有覆盖已审查能力：${coverage.violations.slice(0, 3).join("；")}`,
            output: { next: "ask_user", reason: "generated_code_tool_coverage_incomplete", violations: coverage.violations },
          };
        }
      }
      sub.codeExecuted = ownership.codeActEligible;
      sub.probeReason = ownership.codeActEligible
        ? undefined
        : `execution owner=${ownership.owner}: ${ownership.reason}`;
      promoted = true;
    } else {
      await renderExecutableCode(sub);
    }

    // Wire the parent → invoke(sub). If the parent has no plan, seed a logic step first so it keeps
    // its main work, THEN the invoke. Idempotent: don't add a second invoke for the same sub.
    const idemKey = String(args.idempotency_key_from ?? "").trim() || parent.inputSchema?.[0]?.field || "subject";
    // #AUDIT-FIX(L32) — 子任务关键性由 AI 显式声明（critical=true → terminal：子 agent 失败即父
    // 失败），不再硬编码 soft+{}（旧行为把关键子任务的失败静默换成空对象继续）。
    const subCritical = args.critical === true;
    const invokeStep: PlanStep = { stepId: `invoke-${taskKebab}`, kind: "invoke", invoke: subShort, idempotencyKeyFrom: idemKey, onError: subCritical ? "terminal" : "soft", ...(subCritical ? {} : { defaultResult: {} }), timeoutS: 60, description: `同步调用子 agent ${subShort}：${task}${subCritical ? "（关键子任务：失败即父失败）" : "（非关键：失败降级为空结果）"}` };
    const basePlan: PlanStep[] = parent.plan && parent.plan.length ? parent.plan : [{ stepId: `${kebab(parentName)}-logic`, kind: "logic", description: (parent.designReasoning ?? parentName).slice(0, 120) }];
    parent.plan = flattenPlanSteps(basePlan).some((s) => s.kind === "invoke" && s.invoke === subShort) ? basePlan : [...basePlan, invokeStep];
    const parentOwnership = generatedSpecExecutionOwnership(parent);
    const parentWasDemoted = parent.codeExecuted === true && !parentOwnership.codeActEligible;
    if (parentWasDemoted) {
      parent.codeExecuted = false;
      parent.probeReason = `execution owner=${parentOwnership.owner}: ${parentOwnership.reason}`;
    }

    ctx.specs = ctx.specs.filter((s) => s.slug !== subSlug);
    ctx.specs.push(sub);
    ctx.lastSandbox = null;
    ctx.emit({ t: "agent.created", spec: cardOf(sub), design: designOf(sub), forAgent: sub.actionName, parentAgent: parentName });
    ctx.emit({ t: "reflect", kind: "subagent", lesson: `为「${parent.nameZh}」拆出子 agent ${subShort}（${task}）——${promoted ? "由运行时 spawn 晋升" : "新设计"}，父通过 invoke 同步调用；两者都是可部署函数。` });
    const codeExecNote = parentWasDemoted
      ? ` · 父 Agent 已切换为 declarative-plan owner（新增 invoke 必须作为独立 durable step，原代码只保留审查参考）`
      : "";
    return {
      ok: true,
      summary: `已拆出子 agent ${subShort}（${promoted ? "晋升自 spawn 代码" : sub.codeExecuted ? "已渲染+可执行" : "已渲染"}）并接到「${parent.nameZh}」的 invoke 步骤（键=${idemKey}）${sub.unresolvedTools.length ? ` · ⚠ 未解析工具:${sub.unresolvedTools.join("、")}` : ""}${codeExecNote}。子 agent 不计入本体覆盖，但会真实部署+被父调用。`,
      output: { subSlug, subShort, parentAction: parentName, invokeWired: true, promoted, codeExecuted: sub.codeExecuted ?? false, idempotencyKeyFrom: idemKey, readiness: deploymentEvidence.readiness },
    };
  },
};

const codegen_agent: BrainTool = {
  name: "codegen_agent",
  description: "为一个已 design_agent 的 agent【亲手写完整 .ts 代码】（从 import 到导出），覆盖自动渲染的参考代码。会做 TS、危险 API、工具 allowlist 与加载探针。只有不调用 reason/tool/memory/invoke/spawn、也不读取 Date.now/new Date/Math.random/crypto/performance 等时间或熵源的纯确定性计算与 emit handler 可成为隔离 CodeAct owner；所需时间/ID必须由 durable host 通过 input 传入。其余代码仍保存供人工审查，真实运行由 declarative plan 的独立 durable steps 负责，绝不把两条路径同时执行。",
  parameters: params({ action: { type: "string" }, code: { type: "string", description: "完整 .ts 文件" } }, ["action", "code"]),
  async execute(args, ctx) {
    const name = String(args.action ?? "").trim();
    const spec = ctx.specs.find((s) => s.actionName === name);
    if (!spec) return { ok: false, summary: `还没设计过「${name}」，先 design_agent。` };
    const code = String(args.code ?? "");
    if (!code.trim()) return { ok: false, summary: "code 不能为空。" };
    const { ok, errors } = await validateAgentCode(code);
    if (!ok) return { ok: false, summary: `代码没通过校验：${errors.slice(0, 3).join("；")}`, output: { errors } };
    // Phase 2 — security lint: AI-authored code that EXECUTES (codeExecuted/CodeAct) must not reach
    // for dangerous APIs (child_process / fs / net / eval / process.exit). Block + explain.
    const lint = lintGeneratedToolCode(code);
    if (!lint.ok) return { ok: false, summary: `代码安全校验未过（禁用危险 API，改用受控工具）：${lint.violations.slice(0, 3).join("；")}`, output: { violations: lint.violations } };
    const allowlist = validateGeneratedToolAllowlist(code, spec.tools);
    if (!allowlist.ok) {
      return {
        ok: false,
        summary: `代码调用了这个 Agent 没有审查和绑定的工具，已拒绝：${allowlist.violations.slice(0, 3).join("；")}。请先用 design_agent/refine_agent 把真实工具加入 tools，并完成连接配置与安全测试；不能只改代码绕过。`,
        output: { next: "ask_user", reason: "generated_code_tool_allowlist_mismatch", violations: allowlist.violations, undeclaredTools: allowlist.undeclaredTools },
      };
    }
    // #W1-4 — 3-gate parity with design_agent: the AI code must also pass the LOAD PROBE (compiles+
    // lints but exposes no callable handler ≠ executable). Grade codeExecuted from THE NEW code —
    // previously the grade referred to the old rendered scaffold the AI code just replaced.
    const probe = await probeAgentModule(code);
    if (!probe.loads) return { ok: false, summary: `代码未过加载探针（编译+安全过了，但没有可调用 handler）：${probe.reason}——修正后重交。`, output: { probeReason: probe.reason } };
    const ownership = generatedSpecExecutionOwnership(spec, code);
    if (ownership.codeActEligible) {
      const coverage = validateGeneratedToolCoverage(code, spec.tools);
      if (!coverage.ok) {
        return {
          ok: false,
          summary: `CodeAct handler 没有覆盖全部已审查能力：${coverage.violations.slice(0, 3).join("；")}`,
          output: { next: "ask_user", reason: "generated_code_tool_coverage_incomplete", violations: coverage.violations },
        };
      }
    }
    spec.generatedCode = code;
    spec.codeSource = "ai";
    spec.codeExecuted = ownership.codeActEligible;
    spec.probeReason = ownership.codeActEligible
      ? undefined
      : `execution owner=${ownership.owner}: ${ownership.reason}`;
    ctx.lastSandbox = null;
    ctx.emit({ t: "code", actionName: name, code, codeSource: "ai" });
    ctx.emit({ t: "agent.created", spec: cardOf(spec), design: designOf(spec), forAgent: spec.actionName });
    return {
      ok: true,
      summary: ownership.codeActEligible
        ? `「${spec.nameZh}」的代码已采纳并由隔离 CodeAct 执行（TS、安全与加载探针通过）。`
        : `「${spec.nameZh}」的代码已采纳为审查参考；真实执行仍由声明式步骤负责，因为 ${ownership.reason}。等 durable command protocol 支持后才能切为 CodeAct。`,
      output: {
        codeSource: "ai",
        codeExecuted: ownership.codeActEligible,
        executionOwner: ownership.owner,
        ...(ownership.codeActEligible ? {} : {
          limitation: "durable_command_protocol_pending",
          referenceCodeOnly: true,
        }),
      },
    };
  },
};

const refine_agent: BrainTool = {
  name: "refine_agent",
  description: "精修一个已设计的 agent（针对 validate_graph / sandbox_run / score_spec 的具体问题）：覆盖 system_prompt / tools / decision_logic / input_schema / output_schema 中要改的部分。保留上一版快照到历史，自动算改前后分数变化，若退步会提示 revert_refine。改完该 agent 沙箱证据失效。",
  parameters: params(
    {
      action: { type: "string" },
      critique: { type: "string", description: "上一版哪里不对（要修的根因）" },
      system_prompt: { type: "string" },
      tools: { type: "array", items: { type: "string" } },
      tool_profiles: { type: "object", additionalProperties: { type: "string" }, description: "兼容字段：toolName→已确认的正式环境连接配置。" },
      production_tool_profiles: { type: "object", additionalProperties: { type: "string" }, description: "toolName→用户已确认的正式环境连接配置 id/key。" },
      sandbox_tool_profiles: { type: "object", additionalProperties: { type: "string" }, description: "toolName→用户已确认的独立测试环境连接配置 id/key。" },
      decision_logic: { type: "string" },
      input_schema: { type: "array", items: { type: "object", properties: { field: { type: "string" }, type: { type: "string" }, description: { type: "string" }, source: { type: "string" }, required: { type: "boolean" } }, required: ["field", "type"] } },
      output_schema: { type: "array", items: { type: "object", properties: { field: { type: "string" }, type: { type: "string" }, description: { type: "string" }, source: { type: "string" }, required: { type: "boolean" } }, required: ["field", "type"] } },
    },
    ["action", "critique"],
  ),
  async execute(args, ctx) {
    const name = String(args.action ?? "").trim();
    const spec = ctx.specs.find((s) => s.actionName === name);
    if (!spec) return { ok: false, summary: `还没设计过「${name}」，先 design_agent。` };
    const history = (ctx.attemptHistory[name] ??= []);
    // #CRITIC-GATE — repair ONLY on VERIFIED failure. CRITIC (ICLR24) measured that correcting
    // already-passing samples cuts the gain roughly in half vs correcting only verified-failed ones
    // (+11.4 vs +5.7 on GSM8k) and risks regressing correct output; "LLMs Cannot Self-Correct"
    // shows intrinsic re-editing DEGRADES without an external failure signal. So: once a REAL
    // sandbox has graded this fleet and THIS agent shows no verified-failure evidence (not degraded,
    // no fidelity violation, no open blocking defect, its code really ran), refuse a re-refine —
    // the change request should go through the contract/requirements (design_agent), not churn.
    // Design-stage iteration (no sandbox evidence yet) stays completely free.
    if (ctx.lastSandbox && ctx.lastSandbox.simulated === false) {
      const sb = ctx.lastSandbox;
      const degraded = (sb.degradedAgents ?? []).includes(spec.short);
      const fidelityBad = (sb.fidelityFailures ?? []).includes(spec.short);
      const openDefect = blockingDefects(ctx.defects ?? []).some((d) => d.agentSlug === spec.slug);
      const codeFellBack = !!spec.codeExecuted && !(sb.codeRanAgents ?? []).includes(spec.short);
      const verifiedFailed = degraded || fidelityBad || openDefect || codeFellBack;
      if (!verifiedFailed) {
        return {
          ok: false,
          summary: `agent「${name}」在最近一次真实沙箱里【已通过验收】（无降级/无契约违约/无阻塞缺陷/代码真跑）——不对已通过的 agent 重复修（CRITIC：对已通过样本再修正会引入退化）。若需求变了：改契约/本体后 design_agent 重设计；若怀疑另一个 agent 才是问题：verify_chain 定位真断点。`,
          output: { actionName: name, verdict: "passed_no_repair", advice: "redesign_via_contract_or_locate_real_break" },
        };
      }
    }
    // In-loop deliberation budget (ported from old AO): more refines tend to regress, not improve.
    // On hit, REFUSE + steer the brain to step UP a level (revert / verify_chain / re-plan / diagnose)
    // instead of grinding the same agent or churning across agents. Env-overridable; no domain logic.
    // #BUDGET-ROUTE (P1-5, arXiv 2408.03314) — band-aware refine budget: easy 磨得少(2+1)、难题
    // 不无限磨(3+1, 超限走 escalation=ask_user/tier_up 的提示语)。env 仍可强制覆盖。
    const REFINE_BUDGET = Number(process.env.FACTORY_REFINE_BUDGET) || budgetForDifficulty(ctx.policy?.band ?? "standard").reviseTurns + 1;
    const GLOBAL_REFINE_FACTOR = Number(process.env.FACTORY_GLOBAL_REFINE_FACTOR) || 3;
    const priorAttempts = history.length;
    if (priorAttempts >= REFINE_BUDGET) {
      // #ADAPT — 卡住才拆：复杂 agent 磨到预算上限，多半是"一个 agent 承载了太多步骤"，
      // 正确动作是 design_subagent 拆出同步 invoke 子 agent，而不是第 N+1 次改 prompt。
      const spSplit = ctx.specs.find((x) => x.actionName === name || x.short === name);
      const splitNote = shouldSuggestSplit(spSplit) ? `该 agent 较复杂（${spSplit?.tools?.length ?? 0} 工具${spSplit?.plan?.length ? `、${spSplit.plan.length} 步 plan` : ""}）——符合"卡住才拆"：考虑 design_subagent 把最容易失败的子步骤拆成同步 invoke 子 agent，父 agent 只保留编排。` : "";
      return { ok: false, summary: `agent「${name}」已 refine ${priorAttempts} 次，达到重试上限——别再硬修了。${splitNote}要么 revert_refine("${name}") 回滚到最好的一版并接受，要么 verify_chain 看链路全貌定位真断点；若方向就是错的，create_plan 重新规划，或 analyze_failure 诚实记根因。`, output: { actionName: name, attemptsUsed: priorAttempts, budget: REFINE_BUDGET, advice: splitNote ? "split_or_revert_or_replan" : "revert_or_verify_or_replan" } };
    }
    const totalRefines = Object.values(ctx.attemptHistory).reduce((s, h) => s + (h?.length ?? 0), 0);
    const globalCap = GLOBAL_REFINE_FACTOR * Math.max(1, ctx.specs.length);
    if (totalRefines >= globalCap) {
      return { ok: false, summary: `全域已累计 refine ${totalRefines} 次（上限 ${globalCap}≈${GLOBAL_REFINE_FACTOR}×${ctx.specs.length} 个 agent）——再逐个微调大概率解决不了，问题很可能在设计/数据/本体层面。停下：verify_chain 看链路全貌定位真断点，或 analyze_failure 诚实记根因收尾，别继续 churn。`, output: { totalRefines, globalCap, advice: "stop_churn_verify_or_analyze" } };
    }
    // #W1-13 — CONVERGENCE DETECTION: two consecutive near-zero deltas mean grinding, not improving.
    // Refuse further refines and steer to verify_chain / revert / replan instead of burning budget.
    const recent = history.slice(-2).map((h) => h.delta).filter((d): d is number => typeof d === "number");
    if (recent.length === 2 && recent.every((d) => Math.abs(d) < 5)) {
      const spConv = ctx.specs.find((x) => x.actionName === name || x.short === name);
      const convSplit = shouldSuggestSplit(spConv) ? `该 agent 较复杂（${spConv?.tools?.length ?? 0} 工具${spConv?.plan?.length ? `、${spConv.plan.length} 步 plan` : ""}），"卡住才拆"（ADaPT）：考虑 design_subagent 拆出子步骤。` : "";
      return { ok: false, summary: `agent「${name}」最近两轮 refine 分数几乎没动（Δ ${recent.join("、")}）——继续磨大概率无效。${convSplit}改走 verify_chain 看链路全貌、revert_refine 回滚到最好一版、或 create_plan 重新规划。`, output: { actionName: name, recentDeltas: recent, advice: "converged_stop_refining" } };
    }
    const priorScore = scoreTotal(scoreSpec(spec, history.length));
    // #W2 — structured review findings (from review_agent/review_context/review_completeness) can be
    // passed straight in; they are folded into the recorded critique so the refine visibly addresses them.
    const reviewFindings = Array.isArray(args.review_findings) ? (args.review_findings as string[]).map(String).filter(Boolean) : [];
    const critiqueText = [String(args.critique ?? ""), ...reviewFindings.map((f) => `[审查] ${f}`)].filter(Boolean).join("；");
    let pendingToolUpdate:
      | {
          resolved: string[];
          unresolved: string[];
          policies: Record<string, GeneratedToolExecutionPolicy>;
          legacySideEffects: Record<string, GeneratedToolSideEffect>;
          productionConfigs: Record<string, Record<string, unknown>>;
          productionRefs: Record<string, string>;
          sandboxConfigs: Record<string, Record<string, unknown>>;
          sandboxRefs: Record<string, string>;
        }
      | undefined;
    if (Array.isArray(args.tools) && (args.tools as string[]).length) {
      let resources: CurrentExecutionResources;
      try {
        resources = await currentExecutionResources(ctx);
      } catch {
        return executionResourcesUnavailable(`agent「${name}」的这次精修`);
      }
      const grounded = groundToolPicks((args.tools as string[]).map(String).filter(Boolean), [
        ...(ctx.toolCatalog ?? []),
        ...resources.realTools.map((tool) => tool.name),
      ]);
      if (grounded.unresolved.length) {
        const question = `这次精修选中的这些工具在当前运行环境里不存在：${grounded.unresolved.join("、")}。请先接入真实工具，或明确换成工具库里已经存在的工具；我不会先保存一个假工具名。`;
        return { ok: false, summary: question, output: { next: "ask_user", reason: "selected_tool_missing", question, missing: grounded.unresolved } };
      }
      const policies = selectedToolPolicies(grounded.resolved, resources.realTools);
      if (policies.missing.length) {
        const question = `这次精修选中的工具缺少完整执行策略：${policies.missing.join("、")}。请先补 operation、effectScope 和 sandboxPolicy，我不会替你猜。`;
        return { ok: false, summary: question, output: { next: "ask_user", reason: "tool_execution_policy_missing", question, missing: policies.missing } };
      }
      const existingRefsFor = (value: Record<string, string> | undefined) => Object.fromEntries(
        Object.entries(value ?? {}).filter(([toolName]) => grounded.resolved.includes(toolName)),
      );
      const deploymentEvidence = selectedToolDeploymentEvidence({
        ctx,
        actionName: spec.actionName,
        requiredObjects: [...new Set(spec.objects ?? [])],
        selectedTools: grounded.resolved,
        realTools: resources.realTools,
        productionProfileRefs: args.production_tool_profiles
          ?? args.tool_profiles
          ?? existingRefsFor(spec.toolProfileRefs),
        sandboxProfileRefs: args.sandbox_tool_profiles
          ?? existingRefsFor(spec.sandboxToolProfileRefs),
      });
      if (!deploymentEvidence.ok) {
        return {
          ok: false,
          summary: deploymentEvidence.question,
          output: {
            next: "ask_user",
            reason: deploymentEvidence.reason,
            question: deploymentEvidence.question,
            missing: deploymentEvidence.missing,
            ...deploymentEvidence.details,
          },
        };
      }
      ctx.realTools = resources.realTools;
      pendingToolUpdate = {
        resolved: grounded.resolved,
        unresolved: grounded.unresolved,
        policies: policies.values,
        legacySideEffects: selectedLegacyToolSideEffects(grounded.resolved, resources.realTools),
        productionConfigs: deploymentEvidence.productionConfigs,
        productionRefs: deploymentEvidence.productionRefs,
        sandboxConfigs: deploymentEvidence.sandboxConfigs,
        sandboxRefs: deploymentEvidence.sandboxRefs,
      };
    }
    const snapshot: RefineAttempt = { attemptNumber: history.length + 1, priorSpecSnapshot: { systemPrompt: spec.systemPrompt, tools: [...spec.tools], decisionLogic: spec.decisionLogic }, fullSnapshot: JSON.parse(JSON.stringify(spec)) as Record<string, unknown>, critique: critiqueText, changes: "" };

    const toolsBefore = [...spec.tools];
    if (typeof args.system_prompt === "string" && args.system_prompt.trim()) spec.systemPrompt = args.system_prompt;
    if (pendingToolUpdate) {
      spec.tools = pendingToolUpdate.resolved;
      spec.toolPolicies = pendingToolUpdate.policies;
      spec.toolSideEffects = pendingToolUpdate.legacySideEffects;
      spec.unresolvedTools = pendingToolUpdate.unresolved;
      if (Object.keys(pendingToolUpdate.productionConfigs).length) spec.toolConfigs = pendingToolUpdate.productionConfigs;
      else delete spec.toolConfigs;
      if (Object.keys(pendingToolUpdate.productionRefs).length) spec.toolProfileRefs = pendingToolUpdate.productionRefs;
      else delete spec.toolProfileRefs;
      if (Object.keys(pendingToolUpdate.sandboxConfigs).length) spec.sandboxToolConfigs = pendingToolUpdate.sandboxConfigs;
      else delete spec.sandboxToolConfigs;
      if (Object.keys(pendingToolUpdate.sandboxRefs).length) spec.sandboxToolProfileRefs = pendingToolUpdate.sandboxRefs;
      else delete spec.sandboxToolProfileRefs;
    }
    if (typeof args.decision_logic === "string") spec.decisionLogic = args.decision_logic;
    if (Array.isArray(args.input_schema)) spec.inputSchema = parseIoSchema(args.input_schema);
    if (Array.isArray(args.output_schema)) spec.outputSchema = parseIoSchema(args.output_schema);
    // re-render + re-grade code unless the user hand-wrote AI code (a refined spec → fresh executable render)
    if (spec.codeSource !== "ai") await renderExecutableCode(spec);
    ctx.lastSandbox = null;

    const newDims = scoreSpec(spec, history.length + 1);
    const newScore = scoreTotal(newDims);
    const delta = newScore - priorScore;
    const regression = delta <= -10;
    snapshot.changes = `prompt${args.system_prompt ? "改" : "未改"} · tools ${toolsBefore.length}→${spec.tools.length}`;
    snapshot.delta = delta; // #W1-13 — feeds convergence detection
    history.push(snapshot);

    ctx.emit({
      t: "refine",
      actionName: name,
      critique: String(args.critique ?? ""),
      diff: { systemPromptChanged: !!args.system_prompt, toolsAdded: spec.tools.filter((t) => !toolsBefore.includes(t)), toolsRemoved: toolsBefore.filter((t) => !spec.tools.includes(t)), decisionLogicChanged: typeof args.decision_logic === "string" },
    });
    ctx.emit({ t: "score.delta", actionName: name, priorTotal: priorScore, newTotal: newScore, delta, regression, dimensions: newDims });
    ctx.emit({ t: "agent.created", spec: cardOf(spec), design: designOf(spec), forAgent: spec.actionName });
    return { ok: true, summary: `已精修「${spec.nameZh}」 · 分 ${priorScore}→${newScore}(${delta >= 0 ? "+" : ""}${delta})${regression ? " · ⚠ 退步了，可 revert_refine 回滚" : ""} · 记得重新 sandbox_run`, output: { priorScore, newScore, delta, regression, attempt: history.length } };
  },
};

const revert_refine: BrainTool = {
  name: "revert_refine",
  description: "把一个 agent 回滚到上一次 refine 之前的快照（当 score.delta 显示这轮精修退步时用）。",
  parameters: params({ action: { type: "string" } }, ["action"]),
  async execute(args, ctx) {
    const name = String(args.action ?? "").trim();
    const spec = ctx.specs.find((s) => s.actionName === name);
    const history = ctx.attemptHistory[name];
    if (!spec || !history?.length) return { ok: false, summary: `「${name}」没有可回滚的精修历史。` };
    const pending = history.at(-1)!;
    const restoredTools = pending.fullSnapshot && Array.isArray(pending.fullSnapshot.tools)
      ? pending.fullSnapshot.tools.map(String)
      : pending.priorSpecSnapshot.tools;
    let resources: CurrentExecutionResources;
    try {
      resources = await currentExecutionResources(ctx);
    } catch {
      return executionResourcesUnavailable(`agent「${name}」的回滚`);
    }
    const policies = selectedToolPolicies(restoredTools, resources.realTools);
    if (policies.missing.length) {
      const question = `回滚快照里的工具缺少当前完整执行策略：${policies.missing.join("、")}。请先补齐工具元数据，我不会恢复旧权限快照。`;
      return { ok: false, summary: question, output: { next: "ask_user", reason: "tool_execution_policy_missing", question, missing: policies.missing } };
    }
    const restoredObjects = pending.fullSnapshot && Array.isArray(pending.fullSnapshot.objects)
      ? pending.fullSnapshot.objects.map(String)
      : spec.objects ?? [];
    const deploymentEvidence = selectedToolDeploymentEvidence({
      ctx,
      actionName: spec.actionName,
      requiredObjects: [...new Set(restoredObjects)],
      selectedTools: restoredTools,
      realTools: resources.realTools,
      productionProfileRefs: pending.fullSnapshot?.toolProfileRefs ?? spec.toolProfileRefs,
      sandboxProfileRefs: pending.fullSnapshot?.sandboxToolProfileRefs ?? spec.sandboxToolProfileRefs,
    });
    if (!deploymentEvidence.ok) {
      return {
        ok: false,
        summary: deploymentEvidence.question,
        output: {
          next: "ask_user",
          reason: deploymentEvidence.reason,
          question: deploymentEvidence.question,
          missing: deploymentEvidence.missing,
          ...deploymentEvidence.details,
        },
      };
    }
    const last = history.pop()!;
    if (last.fullSnapshot) {
      // #W1-12 — FULL rollback: restore every field (schemas/plan/code included), not just 3. The old
      // partial restore left half-reverted schema state after a refine that touched input/output_schema.
      Object.assign(spec, last.fullSnapshot);
      spec.tools = restoredTools;
      spec.toolPolicies = policies.values;
      spec.toolSideEffects = selectedLegacyToolSideEffects(restoredTools, resources.realTools);
    } else {
      spec.systemPrompt = last.priorSpecSnapshot.systemPrompt;
      spec.tools = [...last.priorSpecSnapshot.tools];
      spec.toolPolicies = policies.values;
      spec.toolSideEffects = selectedLegacyToolSideEffects(restoredTools, resources.realTools);
      spec.decisionLogic = last.priorSpecSnapshot.decisionLogic;
    }
    if (Object.keys(deploymentEvidence.productionConfigs).length) spec.toolConfigs = deploymentEvidence.productionConfigs;
    else delete spec.toolConfigs;
    if (Object.keys(deploymentEvidence.productionRefs).length) spec.toolProfileRefs = deploymentEvidence.productionRefs;
    else delete spec.toolProfileRefs;
    if (Object.keys(deploymentEvidence.sandboxConfigs).length) spec.sandboxToolConfigs = deploymentEvidence.sandboxConfigs;
    else delete spec.sandboxToolConfigs;
    if (Object.keys(deploymentEvidence.sandboxRefs).length) spec.sandboxToolProfileRefs = deploymentEvidence.sandboxRefs;
    else delete spec.sandboxToolProfileRefs;
    if (spec.codeSource !== "ai") await renderExecutableCode(spec);
    ctx.lastSandbox = null;
    ctx.emit({ t: "revert", actionName: name, revertedToAttempt: last.attemptNumber - 1 });
    ctx.emit({ t: "agent.created", spec: cardOf(spec), design: designOf(spec), forAgent: spec.actionName });
    return { ok: true, summary: `已把「${spec.nameZh}」回滚到第 ${last.attemptNumber} 次精修之前。`, output: {} };
  },
};

// Boundary events — events emitted with no INTERNAL consumer. Inngest events are global,
// so an emit can legitimately be consumed by an EXTERNAL platform / webhook / terminal,
// NOT a broken chain. The AI proposes a classification; the user confirms + supplements the
// external contract; verifyGraph then honors them so they aren't false-flagged as orphans.
const propose_boundary_events: BrainTool = {
  name: "propose_boundary_events",
  description:
    "当 validate_graph 报某些事件【悬空】(emit 了却没有内部 agent 消费),而你判断它们其实是【交给外部平台消费的交接事件】或【本就是终态】(不是真的链断了),用这个工具列出来交给【用户确认】。每个给:event(本体真事件名)、kind(external=外部交接 / terminal=终态)、why 一句理由、(external 时)consumer 外部消费方 + payloadContract 你猜的 payload 契约。提交后会暂停等用户逐个确认/补充;确认后这些事件不再算断点,external 的留一份对外契约给下游核对。【真正该修的断点别放进来】,那些用 refine_agent 修。",
  parameters: params({
    events: {
      type: "array",
      description: "你判断为外部交接/终态的悬空事件",
      items: {
        type: "object",
        properties: {
          event: { type: "string", description: "事件名(本体真事件名)" },
          kind: { type: "string", enum: ["external", "terminal"], description: "external=交给外部平台消费 / terminal=终态" },
          why: { type: "string", description: "一句理由" },
          consumer: { type: "string", description: "(external)外部消费方:平台/服务/团队" },
          payloadContract: { type: "string", description: "(external)payload 契约:外部消费方会拿到哪些字段" },
        },
        required: ["event", "kind"],
      },
    },
  }, ["events"]),
  async execute(args, ctx) {
    const raw = Array.isArray((args as { events?: unknown }).events) ? ((args as { events: Array<Record<string, unknown>> }).events) : [];
    if (!raw.length) return { ok: false, summary: "没有给出任何边界事件——如果是真断点请用 refine_agent 修,不要走这个流程。" };
    const producersOf = (ev: string) => ctx.specs.filter((s) => (s.emit ?? []).includes(ev)).map((s) => s.short);
    const proposals: BoundaryProposal[] = raw
      .filter((e) => !!e && typeof e === "object" && typeof e.event === "string")
      .map((e) => ({
        event: String(e.event),
        suggestedKind: (["external", "terminal", "break"].includes(String(e.kind)) ? String(e.kind) : "external") as BoundaryProposal["suggestedKind"],
        why: String(e.why ?? ""),
        producers: producersOf(String(e.event)),
        consumer: typeof e.consumer === "string" ? e.consumer : undefined,
        payloadContract: typeof e.payloadContract === "string" ? e.payloadContract : undefined,
      }));
    const unique =
      proposals.length > 0 &&
      new Set(proposals.map((proposal) => proposal.event)).size ===
        proposals.length &&
      proposals.every(
        (proposal) =>
          proposal.suggestedKind === "external" ||
          proposal.suggestedKind === "terminal",
      );
    if (ctx.interactionPolicy === "autopilot" && unique) {
      const decided = proposals.map((proposal) => ({
        event: proposal.event,
        kind: proposal.suggestedKind,
        ...(proposal.consumer ? { consumer: proposal.consumer } : {}),
        ...(proposal.payloadContract
          ? { payloadContract: proposal.payloadContract }
          : {}),
        note: `Autopilot 采用唯一建议分类：${proposal.why}`.slice(0, 500),
      }));
      const byEvent = new Map(
        (ctx.boundaryEvents ?? []).map((boundary) => [
          boundary.event,
          boundary,
        ]),
      );
      for (const boundary of decided) byEvent.set(boundary.event, boundary);
      ctx.boundaryEvents = [...byEvent.values()];
      ctx.awaitingBoundary = false;
      ctx.boundaryProposals = undefined;
      ctx.lastValidation = null;
      ctx.emit({ t: "boundary.cases", proposals, awaitingDecision: false });
      const assumption = recordFactoryAssumption(ctx, {
        gate: "boundary",
        subject: `边界事件分类：${proposals.map((proposal) => proposal.event).join("、")}`,
        value: JSON.stringify(
          decided.map((boundary) => ({
            event: boundary.event,
            kind: boundary.kind,
          })),
        ),
        source: "recommended",
        detail: "所有事件都只有一个 external/terminal 建议；未自动接受 break 或副作用授权。",
      });
      ctx.emit({ t: "boundary.decided", events: decided });
      return {
        ok: true,
        summary: `Autopilot 已记录假设 ${assumption.id} 并采用 ${decided.length} 个唯一边界分类；继续重新 validate_graph。`,
        output: {
          events: decided,
          awaitingDecision: false,
          assumptionId: assumption.id,
        },
      };
    }
    ctx.awaitingBoundary = true;
    ctx.boundaryProposals = proposals;
    ctx.emit({ t: "boundary.cases", proposals, awaitingDecision: true });
    return {
      ok: true,
      summary: `已把 ${proposals.length} 个边界事件交给用户确认(${proposals.map((p) => p.event).join("、")})。【现在暂停,等用户逐个确认是外部交接/终态/还是真断点并补充契约——不要继续调别的工具】。用户决定后我会把结果作为消息发给你,你再据此总结对外契约并继续。`,
      output: { proposals, awaitingDecision: true },
    };
  },
};

const validate_graph: BrainTool = {
  name: "validate_graph",
  description: "静态校验本次 generation scope 内所有 agent 的事件图：①结构闭合(emit被消费/是终态、trigger有产出者/是入口、可达)②覆盖(本次每个 Agent 动作都有 agent)③字段合同(下游 input 要的字段上游 output 有没有产出)。范围边缘事件按 external handoff/入口/终态处理；返回 agentIssueMap 把问题绑到具体 agent。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    if (!ctx.specs.length) return { ok: false, summary: "还没设计任何 agent。" };
    const specActions: OntologyAction[] = ctx.specs.map((s) => ({ id: s.slug, name: s.actionName, actor: s.hitl ? ["Human"] : ["Agent"], trigger: s.trigger ?? [], triggered_event: s.emit ?? [], target_objects: s.objects ?? [], tool_use: s.tools ?? [], system_prompt: s.systemPrompt, user_prompt: s.userPrompt }));
    const acceptanceOntology = generationAcceptanceOntology(ctx);
    // A selected subset is a complete executable boundary for this run. An
    // event crossing to/from an excluded Action is therefore an honest
    // external entry/handoff, not a producer/consumer that silently closes the
    // generated graph or an impossible missing-edge requirement.
    const known = compileGraph(acceptanceOntology.actions, {
      domainId: ctx.domain,
    });
    const specGraph = compileGraph(specActions, { domainId: ctx.domain });
    const v = verifyGraph(specGraph, { knownEntries: known.entryEvents, knownTerminals: known.terminalEvents, boundaryEvents: (ctx.boundaryEvents ?? []).filter((b) => b.kind !== "break").map((b) => b.event) });
    // Structured scope is issued by the server recommendation receipt and is
    // the full acceptance universe. planScope remains only for legacy,
    // unstructured draft conversations.
    const scopeMissed = ctx.planScope?.kind === "partial" ? new Set(ctx.planScope.missedActions ?? []) : new Set<string>();
    const acceptanceGap = coverageGap(
      acceptanceOntology.actions,
      ctx.specs.map((s) => s.actionName),
    );
    const gap = ctx.generationDirective
      ? acceptanceGap
      : acceptanceGap.filter((name) => !scopeMissed.has(name));
    const selectedNames = new Set(generationScopedAgentActionNames(ctx));
    const outOfScopeGap = ctx.generationDirective
      ? ctx.ontology.actions
          .filter((action) =>
            action.actor.includes("Agent") && !selectedNames.has(action.name),
          )
          .map((action) => action.name)
      : acceptanceGap.filter((name) => scopeMissed.has(name));
    const contract = deriveContractGraph(ctx.specs, ctx.domain, canonicalEventFields(ctx.ontology));
    const contractMap = contractAgentIssueMap(contract);
    // #SIMPLIFY 契约问题分级（结构化，替代旧的 summary 字符串 includes 判断——那种写法既脆、
    // 又漏了 type_mismatch/type_conflict 两类硬问题）：硬 = 运行期会解析爆炸，入主列表；
    // 软（untyped/non_canonical，envelope 可携带）折一行摘要，防止灌爆上下文触发过早压缩。
    const { hard: hardContract, soft: softContract } = contractIssueStringsBySeverity(contract);
    // #NATIVE（设计期契约降级）— 契约问题不再阻断（不翻 ok）：它们是【高置信事实提醒】——
    // 双方 schema 都是 AI 自己声明的，冲突=自相矛盾，提醒即修；真正的裁判是沙箱真实执行的
    // 保真结果（execution_fidelity，10 判据之一）。静态分析只告知，不替 AI 决定能否继续。
    const contractAdvisory = hardContract.map((l) => `⚠[契约提醒·高置信] ${l}`);
    const issues: string[] = [
      ...(gap.length ? [`缺少 agent 的动作：${gap.join("、")}`] : []),
      // 范围外的动作：陈述事实，不阻断。AI 看得见"本体还有这些没做"，自己判断要不要找用户扩范围。
      ...(outOfScopeGap.length ? [`（本体另有 ${outOfScopeGap.length} 个 Agent 动作不在本次范围内，未计入覆盖：${outOfScopeGap.join("、")}——这是服务端锁定的 generation scope${ctx.planScope?.reason ? `（${ctx.planScope.reason}）` : ""}，不是缺陷；范围边缘事件按 external handoff 处理）`] : []),
      ...v.issues.map((i) => (i.kind === "missing_producer" ? `「${i.action}」消费的 ${i.event} 没人产出` : i.kind === "orphan_emit" ? `「${i.action}」产出的 ${i.event} 没人消费且非终态` : i.kind === "unreachable_node" ? `「${i.action}」从入口不可达` : i.kind === "dead_end" ? `「${i.action}」从入口可达但到不了任何终态（困在环里/死路——补一条通向终态的分支或显式声明退出）` : i.kind === "cycle" ? `⛔ 无界事件环：${i.actions.join("→")}（经 ${i.events.join("、")} 互相触发，环内无 HITL 停止界——部署后会无限互相重触发。修法：给环加退出分支/终态事件，或在环内加人工闸口）` : i.kind === "no_entry" ? "无入口节点" : "到不了终态")),
      ...contractAdvisory,
      ...(softContract.length ? [`（另有 ${softContract.length} 处字段靠 envelope 携带，非阻断——如需严格对齐可补进本体）`] : []),
    ];
    const degradedShells = ctx.specs.filter((s) => s.degraded === true);
    const unresolvedToolSpecs = ctx.specs.filter((s) => (s.unresolvedTools ?? []).length > 0);
    if (degradedShells.length) issues.push(`仍是未完成降级壳的 agent：${degradedShells.map((s) => s.short).join("、")}`);
    if (unresolvedToolSpecs.length) issues.push(`工具未解析的 agent：${unresolvedToolSpecs.map((s) => `${s.short}[${s.unresolvedTools.join("、")}]`).join("；")}`);
    const agentIssueMap: Record<string, unknown[]> = {};
    for (const i of v.issues) if ("action" in i) (agentIssueMap[i.action] ??= []).push(i);
    for (const [action, list] of Object.entries(contractMap)) agentIssueMap[action] = [...(agentIssueMap[action] ?? []), ...list];
    for (const spec of degradedShells) (agentIssueMap[spec.actionName] ??= []).push({ kind: "explicit_degraded_shell" });
    for (const spec of unresolvedToolSpecs) (agentIssueMap[spec.actionName] ??= []).push({ kind: "unresolved_tools", tools: spec.unresolvedTools });
    // ok = 结构性事实（覆盖齐 + 事件图闭合）以及没有明确的未完成壳/未解析能力。
    // 零工具本身不是缺陷：纯计算、路由、校验和 event/runtime binding 都可以不调用外部工具。
    // 契约提醒不计入——设计期不阻断，
    // 沙箱保真才是行为裁判（AI 无视提醒 → 真实失败 + #ATTRIB 定位会把它带回来）。
    const ok = gap.length === 0 && v.ok && degradedShells.length === 0 && unresolvedToolSpecs.length === 0;
    ctx.lastValidation = { ok, agentIssueMap };
    ctx.emit({ t: "validation", ok, issues, agentIssueMap });
    // #BIZFLOW — the moment specs + ontology + boundary decisions are all on hand, derive the
    // complete business-flow model (external platforms · reads/calls/writes · branch semantics)
    // so the UI can render the generated end-to-end business diagram.
    ctx.emit({ t: "flow.business", model: deriveBusinessFlow(ctx.specs, acceptanceOntology, ctx.boundaryEvents) as unknown as Record<string, unknown> });
    const contractNote = contractAdvisory.length ? `；另有 ${contractAdvisory.length} 条契约提醒（高置信，建议当场修——沙箱保真会按真实行为裁定）：${contractAdvisory.slice(0, 2).join("；")}` : "";
    return { ok, summary: ok ? `事件图闭合 ✓（覆盖 + 结构）${contractNote}` : `未闭合：${issues.slice(0, 4).join("；")}${contractNote}`, output: { ok, issues, agentIssueMap, coverageGap: gap, contract: { ok: contract.ok, payloadGaps: contract.events.filter((e) => e.payloadGaps.length).map((e) => ({ event: e.name, missing: e.payloadGaps })) } } };
  },
};

const verify_chain: BrainTool = {
  name: "verify_chain",
  description: "本体接地的链路体检：从入口事件出发，沿真实事件链逐跳走，定位链路在哪个 agent 断了（消费了没人产的事件 / 产了没人收的事件），帮你精准定位要 refine 谁，而不是泛泛重试。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.ontology || !ctx.specs.length) return { ok: false, summary: "需要先 read_ontology + design_agent。" };
    // Sub-agents are invoke-only (synthetic trigger, never event-fired) — exclude from the event-chain
    // closure analysis so they aren't false-flagged as broken/orphan nodes.
    const chainSpecs = ctx.specs.filter((s) => !s.isSubAgent);
    const emitters = new Map<string, string[]>();
    const consumers = new Map<string, string[]>();
    for (const s of chainSpecs) {
      for (const e of s.emit ?? []) (emitters.get(e) ?? emitters.set(e, []).get(e)!).push(s.actionName);
      for (const e of s.trigger ?? []) (consumers.get(e) ?? consumers.set(e, []).get(e)!).push(s.actionName);
    }
    const known = compileGraph(
      generationAcceptanceOntology(ctx).actions,
      { domainId: ctx.domain },
    );
    const entrySet = new Set(known.entryEvents);
    const termSet = new Set(known.terminalEvents);
    const breaks: string[] = [];
    for (const s of chainSpecs) {
      for (const e of s.trigger ?? []) if (!emitters.has(e) && !entrySet.has(e)) breaks.push(`「${s.actionName}」等的事件 ${e} 没有上游产出（链路在此断）`);
      for (const e of s.emit ?? []) if (!consumers.has(e) && !termSet.has(e)) breaks.push(`「${s.actionName}」发的事件 ${e} 没有下游消费且非终态（链路悬空）`);
    }
    const ok = breaks.length === 0;
    return { ok, summary: ok ? "链路体检通过：每一跳都接得上 ✓" : `链路有 ${breaks.length} 处断点：${breaks.slice(0, 4).join("；")}`, output: { ok, breaks } };
  },
};

/** Human design sign-off is deliberately separate from promotion sign-off and
 * every tool's own write authorization. The server challenge is scoped to the
 * exact evidence tuple and the current execution build identity. */
function sandboxDesignReviewQuestion(ctx: BrainCtx, fingerprint: string): string {
  const flow = ctx.specs.map((spec) => {
    const triggers = (spec.trigger ?? []).join("/") || "无入口";
    const emits = (spec.emit ?? []).join("/") || "无产出";
    const tools = (spec.tools ?? []).join("/") || "无工具";
    return `${spec.actionName}：${triggers} → ${emits}（${tools}）`;
  }).join("；");
  return [
    `沙箱审查 ${fingerprint}：是否批准当前 ${ctx.domain} 的 ${ctx.specs.length} 个 Agent 设计和已批准测试输入进入隔离 Inngest 沙箱？`,
    "请先核对页面里的生成代码、触发/产出事件、工具、错误分支和测试数据。批准只允许进入这一次沙箱，不代表允许晋升，也不替代任何外部写操作的单独授权。",
    `当前链路：${flow}`,
  ].join("\n").slice(0, 1_900);
}

function exactSandboxDesignReviewDecline(
  ctx: BrainCtx,
  challenge: FactoryAuthorizationChallenge,
): boolean {
  const evidence = ctx.clarificationAnswerEvidence?.[normalizeQuestion(challenge.question)];
  const decline = challenge.options.find((option) => option.value !== challenge.token);
  if (
    !evidence
    || !decline
    || evidence.question !== challenge.question
    || evidence.context !== challenge.context
    || JSON.stringify(evidence.options ?? []) !== JSON.stringify(challenge.options)
    || !evidence.actor?.trim()
  ) return false;
  return evidence.answer === decline.value;
}

function sandboxDesignReviewReceiptIsCurrent(
  ctx: BrainCtx,
  fingerprint: string,
  subjectDigest: string,
): boolean {
  const review = ctx.sandboxDesignReview;
  return Boolean(
    review
    && review.fingerprint === fingerprint
    && review.subjectDigest === subjectDigest
    && review.receipt.kind === "sandbox_design_review"
    && review.receipt.subjectDigest === subjectDigest
    && review.receipt.runId === ctx.conversationId
    && review.receipt.conversationId === ctx.conversationId
    && review.receipt.actor.trim()
    && Number.isFinite(Date.parse(review.receipt.expiresAt))
    && Date.parse(review.receipt.expiresAt) > Date.now(),
  );
}

const sandbox_run: BrainTool = {
  name: "sandbox_run",
  description: "为当前不可变代码/规格创建一个全新的 Inngest 临时测试 App，发已批准的入口事件并观察整链；成功、失败或取消都会在返回前注销并验证清理。修改代码后一定创建另一个 App，绝不复用旧 App，也不会把沙箱 App 指针直接提升。缺独立 sandbox URL/key/注销能力时返回 next=ask_user，让用户补配置，不能猜。finish 前必须有一次匹配当前指纹和目标 domain 的真实成功证据。",
  parameters: params({ dry_run: { type: "boolean" } }),
  async execute(args, ctx) {
    if (!ctx.specs.length) return { ok: false, summary: "还没 agent 可部署。" };
    // First-run auto-gate: author full-flow test cases for the user to approve BEFORE
    // any real deploy/fire — so the inputs fed to the sandbox are user-reviewed.
    if (!ctx.testCases?.length && !ctx.awaitingApproval) return proposeTestCases(ctx);
    if (ctx.awaitingApproval) {
      return { ok: false, summary: "测试用例仍在等待用户确认，不能先执行 sandbox_run。请等用户明确选择「执行」。" };
    }
    const currentCoverage = ensureCoverage(ctx, ctx.testCases ?? []);
    ctx.testCoverage = currentCoverage.coverage;
    if (currentCoverage.coverage.backfilled.length) {
      return {
        ok: false,
        summary: `批准后的用例集又暴露出 ${currentCoverage.coverage.backfilled.length} 个可确定补位格（${currentCoverage.coverage.backfilled.join("、")}），不能静默改变已批准输入。请重新 generate_test_cases 并确认。`,
      };
    }
    const uncovered = normalizeCoverageCells(currentCoverage.coverage.uncoveredNeedingData);
    if (!coverageWaiverMatches(uncovered, ctx.testCoverageWaiver)) {
      return {
        ok: false,
        summary: `覆盖矩阵仍缺 ${uncovered.length} 个需真实数据的格（${uncovered.join("、")}）。请补齐用例，或由用户逐项显式确认覆盖豁免；普通批准不足以放行。`,
      };
    }
    let sbFp: string;
    try {
      // Snapshot BEFORE deploying: this is the exact execution-bearing state the sandbox receives.
      // finish calls the same function again and fails closed on any intervening drift.
      sbFp = await currentSandboxEvidenceFingerprint(ctx);
    } catch (error) {
      if (error instanceof ToolPolicyDriftError) {
        const question = `工具库在设计后发生了读写权限变化，我已停止创建沙箱 App。请重新审查并确认这些工具的 profile/sideEffect：${error.issues.slice(0, 6).join("；")}。`;
        return { ok: false, summary: question, output: { next: "ask_user", reason: "tool_policy_drift", question, missing: error.missing } };
      }
      if (error instanceof ExecutionResourcesUnavailableError) {
        return executionResourcesUnavailable("创建隔离测试环境");
      }
      const detail = String((error as Error)?.message ?? error).slice(0, 220);
      const question = `创建隔离测试环境前的证据复验没有通过：${detail}。我没有创建 Inngest 沙箱 App。请按这条原因修正 profile、probe 或工具策略后，再告诉我“已修复，请重新验证”。`;
      return {
        ok: false,
        summary: question,
        output: {
          next: "ask_user",
          reason: "sandbox_evidence_revalidation_failed",
          question,
          missing: ["current integration evidence"],
        },
      };
    }
    const reviewSubjectDigest = sandboxDesignReviewSubjectDigest({ domain: ctx.domain, fingerprint: sbFp });
    let autopilotReview: NonNullable<
      BrainCtx["lastSandbox"]
    >["autopilotReview"];
    const autopilotSafe =
      ctx.interactionPolicy === "autopilot" &&
      autopilotTestApprovalBlockReason(ctx) === null;
    if (autopilotSafe) {
      const assumption = recordFactoryAssumption(ctx, {
        gate: "sandbox_review",
        subject: `隔离沙箱审查 ${sbFp}`,
        value: "approve_read_only_sandbox",
        source: "safe_default",
        detail:
          "覆盖完整、无待处理授权、无外部写；仅批准本次隔离沙箱，不代表生产晋升授权。",
      });
      autopilotReview = {
        schema: "agent-factory-autopilot-sandbox-review/v1",
        fingerprint: sbFp,
        subjectDigest: reviewSubjectDigest,
        assumptionId: assumption.id,
        appliedAt: assumption.appliedAt,
        policy: "autopilot_safe",
        ...(ctx.conversationId
          ? { conversationId: ctx.conversationId }
          : {}),
      };
      ctx.sandboxDesignReview = undefined;
    } else if (!sandboxDesignReviewReceiptIsCurrent(ctx, sbFp, reviewSubjectDigest)) {
      const execution = ctx.conversationId ? factoryExecutionScope(ctx.conversationId) : undefined;
      if (!execution || !ctx.ports.authorizationChallenges) {
        const question = "当前 Agent 工厂没有接入可审计的一次性人工签核存储，因此不会创建 Inngest 沙箱 App。请让平台管理员接入 authorization challenge store 后重试。";
        return {
          ok: false,
          summary: question,
          output: { next: "ask_user", reason: "sandbox_design_review_store_missing", question, missing: ["authorization challenge store", "conversation scope"] },
        };
      }
      let challenge = pendingChallenge(ctx, "sandbox_design_review", reviewSubjectDigest);
      if (!challenge) {
        try {
          challenge = await ctx.ports.authorizationChallenges.issue(ctx.domain, {
            kind: "sandbox_design_review",
            subjectDigest: reviewSubjectDigest,
            ...execution,
            question: sandboxDesignReviewQuestion(ctx, sbFp),
            declineLabel: "需要修改，先别部署",
            confirmLabel: "批准这版进入沙箱",
          });
        } catch {
          const question = "暂时无法创建这版设计的人工审查任务，所以我没有创建 Inngest 沙箱 App。请确认 Agent Factory 的人工签核服务恢复后告诉我“已恢复，请重试”。";
          return {
            ok: false,
            summary: question,
            output: {
              next: "ask_user",
              reason: "sandbox_design_review_unavailable",
              question,
              missing: ["sandbox design review challenge"],
            },
          };
        }
      }
      if (exactSandboxDesignReviewDecline(ctx, challenge)) {
        delete ctx.pendingAuthorizationChallenges?.[challenge.context];
        ctx.sandboxDesignReview = undefined;
        const question = `返工意见 ${reviewSubjectDigest.slice(0, 12)}：你希望这版 Agent 具体修改哪些业务分支、字段、工具或测试数据？`;
        return {
          ok: false,
          summary: "你选择了先修改；没有创建 Inngest 沙箱 App。请把具体修改意见告诉我，我会按意见返工，不会自行猜。",
          output: {
            next: "ask_user",
            reason: "human_requested_design_rework",
            question,
            context: `当前待修改版本：${sbFp}`,
            fingerprint: sbFp,
          },
        };
      }
      const answer = exactChallengeAnswer(ctx, challenge);
      if (!answer) {
        parkAuthorizationChallenge(ctx, challenge);
        return {
          ok: false,
          summary: "当前设计尚未获得与这版代码、测试输入和执行版本精确绑定的人工签核；没有创建 Inngest 沙箱 App。",
          output: { authorizationRequired: true, fingerprint: sbFp, reviewSubjectDigest },
        };
      }
      try {
        const receipt = await consumeChallenge(ctx, challenge);
        ctx.sandboxDesignReview = { fingerprint: sbFp, subjectDigest: reviewSubjectDigest, receipt };
      } catch (error) {
        return {
          ok: false,
          summary: `这版设计没有获得可验证的一次性人工签核；没有创建 Inngest 沙箱 App（${String((error as Error).message ?? error).slice(0, 180)}）。`,
        };
      }
    }
    ctx.spent.sandboxRuns += 1;
    let res;
    try {
      res = await ctx.ports.sandbox.deployAndObserve(ctx.domain, ctx.specs, {
        dryRun: args.dry_run === true,
        candidateFingerprint: sbFp,
        fixtureConversationId: ctx.conversationId,
        signal: ctx.signal,
        testCases: (ctx.testCases ?? []).map((c) => ({ id: c.id, entryEvent: c.entryEvent, payload: applyTestDataOverrides(c.payload, ctx.testDataOverrides), kind: c.kind, expectedEvent: c.expectedEvent })), // #W3-FAULT + exact decision-table branch verdict
        // #D: thread the user's boundary classification so an external-handoff emit counts as a
        // legitimate terminal in the verdict — not a broken chain (matches validate_graph).
        boundaryEvents: (ctx.boundaryEvents ?? []).map((b) => ({ event: b.event, kind: b.kind })),
      });
    } catch (error) {
      if (error instanceof SandboxLifecycleBlockedError) {
        // A fresh sandbox attempt proved that the current lifecycle is not
        // usable. Do not let an older success receipt bypass that newer fact.
        ctx.lastSandbox = null;
        return {
          ok: false,
          summary: error.block.question,
          output: {
            next: "ask_user",
            reason: error.block.code,
            question: error.block.question,
            missing: error.block.missing,
          },
        };
      }
      // The deployer may have created an App before the unexpected failure.
      // Without an execution+cleanup receipt, prior evidence must not remain
      // eligible for finish/promotion.
      ctx.lastSandbox = null;
      const question = "隔离测试环境这次没有返回可验证的运行和清理结果。我不会把它当成测试成功，也不会直接重试或复用可能残留的 App。请先确认专用 Inngest 测试环境、App 注销和缺席回读都正常，再告诉我“已检查，可以创建新的沙箱 App”。";
      return {
        ok: false,
        summary: question,
        output: {
          next: "ask_user",
          reason: "sandbox_runtime_unavailable",
          question,
          missing: ["sandbox execution receipt", "sandbox cleanup receipt"],
        },
      };
    }
    // The API implementation stamps the exact pre-deploy evidence identity and
    // cleans the ephemeral app before returning. A custom/mock port may omit
    // these fields only in unit tests; real runs fail closed on any mismatch.
    const cleanupReceiptIssues = sandboxCleanupReceiptIssues(res.cleanupReceipt, {
      candidateFingerprint: sbFp,
      targetDomainId: ctx.domain,
    });
    const executionReceiptIssues = sandboxExecutionReceiptIssues(res.executionReceipt, {
      candidateFingerprint: sbFp,
      targetDomainId: ctx.domain,
      targetTenantId: ctx.ports?.factoryScope?.tenantId,
      targetTenantSlug: ctx.ports?.factoryScope?.tenantSlug,
      sandboxAttemptId: res.sandboxAttemptId,
      modelUsageHash: res.modelUsage?.evidenceHash,
    });
    if (
      process.env.NODE_ENV !== "test" &&
      (
        res.candidateFingerprint !== sbFp ||
        res.targetDomainId !== ctx.domain ||
        res.cleanupVerified !== true ||
        !res.sandboxAttemptId ||
        !res.sandboxTenantSlug ||
        cleanupReceiptIssues.length > 0 ||
        res.cleanupReceipt?.appId !== res.appId ||
        res.cleanupReceipt?.sandboxAttemptId !== res.sandboxAttemptId ||
        res.cleanupReceipt?.sandboxTenantSlug !== res.sandboxTenantSlug
      )
    ) {
      const question = "沙箱没有返回与当前代码指纹、目标 domain 和清理回执完全一致的证据，我已停止交付。请检查 Inngest 沙箱生命周期配置后重新测试；不要直接复用旧 App 或旧结果。";
      return {
        ok: false,
        summary: question,
        output: {
          next: "ask_user",
          reason: "sandbox_lifecycle_evidence_mismatch",
          question,
            missing: [
              "candidate fingerprint receipt",
              "target domain receipt",
              "verified cleanup receipt",
              ...cleanupReceiptIssues,
            ],
        },
      };
    }
    if ((process.env.NODE_ENV !== "test" || res.executionReceipt) && executionReceiptIssues.length > 0) {
      ctx.lastSandbox = null;
      const question = "这次函数代码没有返回由外部隔离执行环境签发、并与当前代码和测试 attempt 精确绑定的回执。我不会降级到 Agent Factory 主进程里运行，也不会把本地 worker 结果当成可晋升测试。请启动或修复 sandbox runner 后重新测试。";
      return {
        ok: false,
        summary: question,
        output: {
          next: "ask_user",
          reason: "external_execution_receipt_invalid",
          question,
          missing: executionReceiptIssues,
        },
      };
    }
    // #R3 — grade REAL execution fidelity: does each agent's ACTUAL emitted payload satisfy the
    // downstream field contract? Only for a real (non-simulated) run with captured agentRuns —
    // a simulated/mock run has nothing real to grade (→ undefined ⇒ acceptance stays lenient).
    const canonFields = canonicalEventFields(ctx.ontology);
    const fidelity =
      !res.simulated && Array.isArray(res.agentRuns) && res.agentRuns.length
        ? evaluateExecutionFidelity(res.agentRuns, expectedFieldsByEvent(deriveContractGraph(ctx.specs, ctx.domain, canonFields), canonFields))
        : null;
    const externalWritesRequired = ctx.specs.some((s) => [
      ...(s.tools ?? []),
      ...flattenPlanSteps(s.plan).filter((p) => p.kind === "tool" && p.tool).map((p) => p.tool as string),
    ].some((name) => requiresAttemptGrantPolicy(s.toolPolicies?.[name])));
    // Keep the immediate sandbox verdict aligned with the final acceptance gate. Factory
    // sandboxes never perform a live external write: T2 proves the integration separately and
    // records a cassette, while T3 must replay that exact evidence with a zero-live-call ledger.
    // An absent/unknown mode must never be treated as verified execution by default.
    const evidenceReplayProven =
      res.toolMode === "evidence_replay"
      && res.externalLiveCalls === 0
      && res.sandboxReplayEvidenceComplete === true;
    const toolExecutionProven = evidenceReplayProven;
    const failedTransportFires = (res.fires ?? []).filter((fire) => !fire.ok);
    const registrationIssues = sandboxRegistrationEvidenceIssues(
      {
        appId: res.appId,
        committedManifestFunctionIds: res.committedManifestFunctionIds,
        brokerRegistration: res.brokerRegistration,
      },
      ctx.specs.map((spec) => spec.slug),
    );
    const transportAccepted = res.appReady === false || registrationIssues.length > 0
      ? false
      : res.fires !== undefined
        ? res.fires.length > 0 && failedTransportFires.length === 0
        : undefined;
    const transportError = res.syncError
      ?? (registrationIssues.length ? registrationIssues.join("; ") : undefined)
      ?? (res.uncoveredExternalInputs?.length
        ? `missing approved external input cases: ${res.uncoveredExternalInputs.join(", ")}`
        : failedTransportFires.length
        ? failedTransportFires.map((fire) => `${fire.event}: ${fire.error ?? "dispatch failed"}`).join("; ")
        : res.fires !== undefined && res.fires.length === 0
          ? "no entry event was accepted by Inngest"
          : undefined);
    const fresh = {
      specsFingerprint: sbFp,
      deployed: res.functionsRegistered,
      agentsRan: res.ran,
      ranAgents: res.runs.map((r) => r.id),
      reachedTerminal: res.reachedSuccessTerminal || res.fullChainRan,
      reachedSuccessTerminal: res.reachedSuccessTerminal,
      fullChainRan: res.fullChainRan,
      caseVerdicts: res.caseVerdicts,
      expectedCaseIds: (ctx.testCases ?? []).map((testCase) => testCase.id),
      codeRanAgents: res.codeRanAgents ?? [],
      degradedAgents: res.degradedAgents,
      fidelityFailures: fidelity ? fidelity.failingShorts : undefined,
      functionTester: res.functionTester,
      toolMode: res.toolMode,
      externalWritesRequired,
      transportAccepted,
      transportError,
      appId: res.appId,
      committedManifestFunctionIds: res.committedManifestFunctionIds,
      brokerRegistration: res.brokerRegistration,
      cleanupReceipt: res.cleanupReceipt,
      executionReceipt: res.executionReceipt,
      modelUsage: res.modelUsage,
      candidateFingerprint: res.candidateFingerprint,
      targetDomainId: res.targetDomainId,
      sandboxAttemptId: res.sandboxAttemptId,
      sandboxTenantSlug: res.sandboxTenantSlug,
      designReviewReceipt: ctx.sandboxDesignReview?.receipt,
      designReviewSubjectDigest: ctx.sandboxDesignReview?.subjectDigest,
      autopilotReview,
      externalLiveCalls: res.externalLiveCalls,
      replayReceipts: res.replayReceipts,
      sandboxReplayEvidenceComplete: res.sandboxReplayEvidenceComplete,
      cassetteRefs: res.cassetteRefs,
      simulated: res.simulated ?? false,
      ts: Date.now(),
    };
    const prev = ctx.lastSandbox;
    // Evidence is attempt-atomic. Never OR/union complementary failures from
    // different Apps into a success that no single attempt achieved; the fresh
    // cleanup receipt belongs only to this exact execution tuple.
    ctx.lastSandbox = fresh;
    ctx.emit({
      t: "sandbox",
      ran: res.ran,
      reachedTerminal: res.reachedSuccessTerminal,
      reachedSuccessTerminal: res.reachedSuccessTerminal,
      agents: ctx.specs.map((s) => s.short),
      events: [],
      appId: res.appId,
      functionsRegistered: res.functionsRegistered,
      registeredIds: res.committedManifestFunctionIds ?? res.registeredIds ?? [],
      // #REDESIGN P1a — which agents' GENERATED CODE actually EXECUTED (真跑) vs fell back to
      // declarative. Surfaced as per-agent execution badges in the sandbox panel.
      codeRanAgents: res.codeRanAgents ?? [],
      deployed: res.deployed,
      fullChainRan: res.fullChainRan,
      deployFailed: res.functionsRegistered === 0,
      degradedAgents: res.degradedAgents,
      runUrls: res.runs.map((r) => ({ runId: r.id, url: `#run-${r.id}`, status: r.status, fn: r.id })),
      agentRuns: res.agentRuns ?? [],
      cases: (ctx.testCases ?? []).map((c) => ({ name: c.name, entryEvent: c.entryEvent, payload: c.payload })),
      // #W3-FAULT — per-kind verdicts (incl. fault: passed = chain refused a success terminal under
      // an injected fault). Dropped previously; now surfaced so the UI can prove error propagation.
      caseVerdicts: res.caseVerdicts,
      simulated: res.simulated,
      // #R3 — which agents' REAL emit payload violated the downstream contract (execution fidelity).
      fidelityFailures: fidelity?.failingShorts,
      // #D: how the chain closed — N internal chains + M legitimate external handoffs.
      internalChains: res.internalChains,
      externalTerminals: res.externalTerminals,
      uncoveredExternalInputs: res.uncoveredExternalInputs,
    });
    // #SCALE-TOOLS — record per-tool sandbox outcomes (empirical effectiveness): every tool bound to
    // an agent that RAN gets invoked++, succeeded++ when that agent's run status is ok. This evidence
    // drives ranking and supervision, so a persistence failure must make the sandbox verdict fail
    // visibly instead of silently publishing an untracked success.
    if (ctx.ports.toolStats && Array.isArray(res.agentRuns)) {
      try {
        for (const ar of res.agentRuns) {
          const sp = ctx.specs.find((x) => x.short === ar.agentShort || x.slug === ar.agentSlug);
          for (const tname of sp?.tools ?? []) {
            await ctx.ports.toolStats.record(tname, ar.status === "ok" || ar.status === "Completed");
          }
        }
      } catch {
        ctx.lastSandbox = null;
        const question = "这次临时沙箱已经返回，但工具效果统计没有保存成功，因此我不会把本次结果当成可晋升证据。请先恢复工具统计存储；恢复后需要创建一个新的临时 App 重新验证，不能复用这次不完整的证据。";
        return {
          ok: false,
          summary: question,
          output: {
            next: "ask_user",
            reason: "sandbox_tool_stats_unavailable",
            question,
            missing: ["tool effectiveness receipt"],
            sandboxExecuted: true,
            cleanupVerified: res.cleanupVerified === true,
          },
        };
      }
    }
    // #ATTRIB — 保真违约的结构化定位：join 契约图，产出"回哪个 agent、改什么"的定点指令。
    // 论据：LLM 事后读日志归因仅 53.5% 准——所以这里直接把答案算出来，别让大脑猜。
    const attribution = fidelity && !fidelity.ok
      ? attributeFidelityFailures(fidelity, deriveContractGraph(ctx.specs, ctx.domain, canonFields))
      : [];
    const attribNote = attribution.length ? `\n${attributionSummary(attribution)}` : "";
    // #P3 — 独立监督者审计:客观证据(保真违约归因)→ 版本锁定缺陷,结转+复验(证据消失且指纹已变才关闭)。
    // 证据指纹变 → sandboxSeq+1 作"版本"信号。finish 门读 ctx.defects 的阻塞数清零。
    if (!prev || prev.specsFingerprint !== sbFp) ctx.sandboxSeq = (ctx.sandboxSeq ?? 0) + 1;
    const sbSeq = ctx.sandboxSeq ?? 1;
    const sbVersions = Object.fromEntries(ctx.specs.map((s) => [s.slug, sbSeq]));
    // #FIX-REGRESS (P2, arXiv 2502.08788 诊断法) — 每轮沙箱同时记录【修复数 vs 新引入数】：
    // 激进修复策略常"纠错多但翻掉更多本来对的"。resolved = 上轮 open → 本轮 resolved；
    // introduced = 本轮新出现的 open 缺陷。回归 > 修复 = 越修越糟的硬信号，直接进摘要与遥测。
    const prevOpenIds = new Set((ctx.defects ?? []).filter((d) => d.status === "open").map((d) => d.id));
    ctx.defects = reconcileDefects(ctx.defects ?? [], supervisorAudit({ attribution, versions: sbVersions }), sbVersions);
    const nowById = new Map(ctx.defects.map((d) => [d.id, d] as const));
    const fixedCount = [...prevOpenIds].filter((id) => nowById.get(id)?.status === "resolved").length;
    const introducedCount = ctx.defects.filter((d) => d.status === "open" && !prevOpenIds.has(d.id)).length;
    const frNote = fixedCount || introducedCount ? `\n🧮 本轮缺陷账：修复 ${fixedCount} · 新引入 ${introducedCount}${introducedCount > fixedCount ? "（⚠ 回归多于修复——当前修法在越修越糟，停下换策略：verify_chain 定位真断点或回滚）" : ""}` : "";
    const openDefects = blockingDefects(ctx.defects);
    const supervisorNote = (ctx.defects.length ? `\n${supervisorSummary(ctx.defects)}` : "") + frNote;
    if (openDefects.length) ctx.emit({ t: "reflect", kind: "supervisor", lesson: supervisorSummary(ctx.defects) });
    // #REVISION — 本体漂移对账：真实载荷与 canonical 持续不一致 → 修订提案（提案不写回，
    // 大脑走 ask_user 确认）。只在真实（非模拟）运行上取证。
    const revisions = !res.simulated && Array.isArray(res.agentRuns) && res.agentRuns.length && canonFields
      ? proposeOntologyRevisions(res.agentRuns, canonFields)
      : [];
    if (revisions.length) ctx.emit({ t: "ontology.revision", proposals: revisions });
    const revisionNote = revisions.length ? `\n${revisionSummary(revisions)}` : "";
    const completeSuite = assessCompleteSuite(fresh);
    const ok =
      res.simulated !== true
      && registrationIssues.length === 0
      && completeSuite.complete
      && (fidelity?.ok ?? true)
      && toolExecutionProven
      && (process.env.NODE_ENV === "test" || executionReceiptIssues.length === 0);
    // Be honest: a simulated pass is graph-closure inference, NOT a real run. It is diagnostic-only
    // and can never satisfy finish; the operator must restore the real Inngest runtime and re-run.
    const simNote = res.simulated ? "（⚠ 仅完成事件图模拟诊断，未真实部署执行；不能交付。请恢复 Inngest 运行环境后重新验证）" : "（真实部署执行 ✓）";
    // R2: a swallowed fire used to look like a silent ran:0 — now surface which entry events failed to dispatch.
    const failedFires = (res.fires ?? []).filter((f) => !f.ok);
    const fireNote = failedFires.length ? ` · ⚠ ${failedFires.length} 个入口事件没发成功：${failedFires.map((f) => `${f.event}(${f.error ?? "失败"})`).join("；")}` : "";
    const externalInputNote = res.uncoveredExternalInputs?.length
      ? ` · 🛑 缺少外部平台输入的明确测试用例/真实载荷：${res.uncoveredExternalInputs.join("、")}（未发送空对象，已阻断验收）`
      : "";
    const toolExecutionNote = !toolExecutionProven
      ? externalWritesRequired
        ? " · 🛑 外部写缺少当前 attempt 绑定的 T2 probe/cassette + T3 精确回放回执，或检测到 external live call"
        : ` · 🛑 缺少可验证的工具执行模式（${res.toolMode ?? "unknown"}）`
      : "";
    // #AUDIT-FIX(H2) — 环境归因：app 没在 Inngest 完成注册时 ran:0 是【环境问题】，绝不能让
    // 大脑当成"事件名没对齐"去 refine agents（既往 finish-loop 死循环的同类根因）。
    const envNote = !res.simulated && res.appReady === false
      ? ` · 🛑 环境问题：沙箱 app 未在 Inngest dev server 完成注册${res.syncError ? `（${res.syncError.slice(0, 120)}）` : "（readiness 超时）"}——ran:0 与 agent 设计无关，检查 Inngest 是否在跑 / AGENTIC_SERVE_ORIGIN 配置，别去改 agent`
      : "";
    // Phase 5 — close the reflection loop: a non-passing sandbox run AUTO-records a failure
    // reflection (it never did before — the brain had to remember to analyze_failure), so the next
    // build for this domain learns from it without manual prompting.
    if (!ok) {
      const lesson = (!res.simulated && res.appReady === false)
        ? `环境问题：沙箱 app 未在 Inngest 注册成功${res.syncError ? `（${res.syncError.slice(0, 100)}）` : ""}——ran:0 不是 agent 设计问题；先修环境（Inngest dev server / serve URL），别 refine agent。`
        : res.uncoveredExternalInputs?.length
          ? `缺少外部平台输入 ${res.uncoveredExternalInputs.join("、")} 的明确批准用例/真实载荷；绝不能用空对象或模拟回调补链。先 generate_test_cases / supply_test_data 后重跑。`
        : !toolExecutionProven
          ? externalWritesRequired
            ? "本轮缺少与当前 sandbox attempt 绑定的 T2 probe/cassette 和 T3 精确回放证据，或回放账本显示发生了 external live call。"
            : `没有可验证的工具执行模式（${res.toolMode ?? "unknown"}），不能将结构跑通当成真实集成证据。`
        : attribution.length
        ? `保真违约（emit 载荷不满足下游契约）：${attribution.map((a) => `${a.agentShort}→${a.event}(${a.recommend})`).join("；")}。按定位指令定点修，别整链重造。`
        : res.degradedAgents.length
          ? `降级证据：${res.degradedAgents.join("、")}。请按具体的函数测试、回放或显式降级壳原因修复；不能仅凭工具数量归因。`
          : failedFires.length
            ? `入口事件没发成功：${failedFires.map((f) => f.event).join("、")} —— 检查事件名是否对齐本体、Inngest 是否在跑。`
            : "事件链没到成功终态——用 inspect_run 看断在哪个 agent，多半是 trigger/emit 没对齐本体事件名。";
      await ctx.ports.reflection.record(ctx.domain, { summary: `沙箱未跑通：部署${res.functionsRegistered}·跑${res.ran}·成功终态=${res.reachedSuccessTerminal}${fidelity && !fidelity.ok ? `·保真${Math.round(fidelity.fidelity * 100)}%` : ""}`, lesson, failedStep: fidelity && !fidelity.ok ? "execution_fidelity" : "sandbox_chain", kind: "failure" });
    }
    return { ok, summary: ok ? `沙箱已部署 ${res.functionsRegistered} 函数、跑 ${res.ran}、到成功终态 ✓${fidelity ? `、保真 ${Math.round(fidelity.fidelity * 100)}%` : ""}${simNote}${fireNote}${revisionNote}` : `沙箱未完全跑通：部署 ${res.functionsRegistered}、跑 ${res.ran}、成功终态=${res.reachedSuccessTerminal}${fidelity && !fidelity.ok ? `、保真违约 ${fidelity.failingShorts.join("、")}` : ""}${res.degradedAgents.length ? `、降级:${res.degradedAgents.join("、")}` : ""}${res.simulated ? "（模拟）" : ""}${fireNote}${externalInputNote}${toolExecutionNote}${envNote}${attribNote}${supervisorNote}${revisionNote}`, output: res };
  },
};

// #RUN-REGRESSION (P1-6) — one-click replay of the APPROVED test suite against the current specs, with
// a per-case verdict DIFF vs the previous replay. Without this, "修 A 坏 B" only surfaces on the next
// ad-hoc sandbox run. Delegates to the REAL sandbox_run (all gates/receipts intact), captures the
// emitted per-case verdicts, and reports fixed / regressed / still-failing by case.
const run_regression: BrainTool = {
  name: "run_regression",
  description:
    "把【已确认过的测试用例套件】对当前 specs 一键回归重放：委托真实 sandbox_run 跑（所有闸门/回执照旧），然后按【每个用例】与上一次回归对比，报告 修复了哪些/退步了哪些/仍失败哪些。refine 之后、finish 之前各跑一次——防止\"修 A 坏 B\"要等下次沙箱才发现。首次运行只建立基线。",
  parameters: params({ reasoning: { type: "string", description: "为什么现在回归（如「刚 refine 过 X」）" } }, []),
  async execute(args, ctx) {
    if (!ctx.specs.length) return { ok: false, summary: "还没有已设计的 agent。" };
    if (!ctx.testCases?.length) return { ok: false, summary: "还没有已确认的测试用例套件——先 generate_test_cases 并让用户确认。" };
    const baseline = ctx.regressionBaseline;

    // Capture the per-case verdicts from the sandbox EVENT (the tool's own emit), non-invasively.
    let capturedVerdicts: { results: Array<{ kind: string; pass: boolean; reason: string }> } | undefined;
    let capturedCases: Array<{ name: string }> | undefined;
    const priorEmit = ctx.emit;
    ctx.emit = (event) => {
      if (event.t === "sandbox") {
        capturedVerdicts = event.caseVerdicts;
        capturedCases = event.cases as Array<{ name: string }> | undefined;
      }
      priorEmit(event);
    };
    let result;
    try {
      result = await sandbox_run.execute({ reasoning: `回归重放：${String(args.reasoning ?? "验证套件仍全绿")}` }, ctx);
    } finally {
      ctx.emit = priorEmit;
    }
    if (!result.ok && !capturedVerdicts) {
      return { ok: false, summary: `回归重放没有跑起来：${result.summary.slice(0, 260)}`, output: result.output };
    }

    const verdicts = keyVerdictsByCase(capturedCases, capturedVerdicts?.results);
    const { fixed, regressed, stillFailing } = diffRegression(baseline?.verdicts, verdicts);
    const failingNow = Object.entries(verdicts).filter(([, v]) => !v.pass).map(([n]) => n);
    ctx.regressionBaseline = { fingerprint: ctx.lastSandbox?.specsFingerprint ?? "", at: Date.now(), verdicts };

    const passCount = Object.values(verdicts).filter((v) => v.pass).length;
    const total = Object.keys(verdicts).length;
    const diffNote = baseline
      ? `${fixed.length ? ` · ✅ 修复：${fixed.join("、")}` : ""}${regressed.length ? ` · 🔻 退步（上次过这次挂）：${regressed.join("、")}——先修这些` : ""}${stillFailing.length ? ` · 仍失败：${stillFailing.join("、")}` : ""}`
      : " ·（首次回归，已建立基线）";
    return {
      ok: regressed.length === 0 && (result.ok || failingNow.length === 0),
      summary: `回归重放：${passCount}/${total} 用例通过${diffNote}${failingNow.length && !baseline ? ` · 失败用例：${failingNow.join("、")}` : ""}`,
      output: { passCount, total, verdicts, fixed, regressed, stillFailing, baselineAt: baseline?.at ?? null },
    };
  },
};

const inspect_run: BrainTool = {
  name: "inspect_run",
  description: "看上次 sandbox_run 每个 agent 的执行结果（跑没跑、是否降级、断在哪），用来诊断链路为什么没跑通，而不是盲目重试。",
  parameters: params({ failed_only: { type: "boolean" } }),
  async execute(args, ctx) {
    if (!ctx.lastSandbox) return { ok: false, summary: "还没 sandbox_run，没有可诊断的运行。" };
    const ran = new Set(ctx.lastSandbox.ranAgents);
    const degraded = new Set(ctx.lastSandbox.degradedAgents);
    const rows = ctx.specs
      .map((s) => ({ agentSlug: s.slug, short: s.nameZh, status: ran.has(s.slug) ? (degraded.has(s.short) ? "degraded" : "ran") : "missed", degraded: degraded.has(s.short) }))
      .filter((r) => (args.failed_only ? r.status !== "ran" : true));
    for (const r of rows) ctx.emit({ t: "inspect", runId: "sandbox", agentSlug: r.agentSlug, status: r.status, degraded: r.degraded });
    const broken = rows.filter((r) => r.status !== "ran");
    return { ok: true, summary: broken.length ? `${broken.length} 个 agent 没正常跑：${broken.map((r) => `${r.short}(${r.status})`).join("、")}` : "上次运行每个 agent 都正常跑了 ✓", output: { rows } };
  },
};

const read_spec: BrainTool = {
  name: "read_spec",
  description: "读出某个已设计 agent 的完整规格（system prompt、工具、IO schema、精修历史、代码），修订前看清上次设计了什么，或做跨 agent 一致性检查。",
  parameters: params({ action: { type: "string" } }, ["action"]),
  async execute(args, ctx) {
    const name = String(args.action ?? "").trim();
    const spec = ctx.specs.find((s) => s.actionName === name);
    if (!spec) return { ok: false, summary: `还没设计过「${name}」。` };
    return { ok: true, summary: `「${spec.nameZh}」：工具 ${spec.tools.length} · 精修 ${(ctx.attemptHistory[name] ?? []).length} 次 · 代码 ${spec.codeSource ?? "无"}`, output: { spec: { actionName: spec.actionName, slug: spec.slug, systemPrompt: spec.systemPrompt, tools: spec.tools, unresolvedTools: spec.unresolvedTools, decisionLogic: spec.decisionLogic, inputSchema: spec.inputSchema, outputSchema: spec.outputSchema, codeSource: spec.codeSource, generatedCode: spec.generatedCode }, attemptHistory: ctx.attemptHistory[name] ?? [] } };
  },
};

const score_spec: BrainTool = {
  name: "score_spec",
  description: "给一个已设计 agent 打分（4 维 0-100：工具接地 / prompt 丰富度 / 分支覆盖 / 精修健康），返回总分 + 等级 + 最弱维度，帮你决定要不要再 refine。",
  parameters: params({ action: { type: "string" } }, ["action"]),
  async execute(args, ctx) {
    const name = String(args.action ?? "").trim();
    const spec = ctx.specs.find((s) => s.actionName === name);
    if (!spec) return { ok: false, summary: `还没设计过「${name}」。` };
    const dims = scoreSpec(spec, (ctx.attemptHistory[name] ?? []).length);
    const total = scoreTotal(dims);
    const weakest = (Object.entries(dims).sort((a, b) => a[1] - b[1])[0] ?? ["", 0]) as [string, number];
    return { ok: true, summary: `「${spec.nameZh}」总分 ${total}（${grade(total)}）· 最弱：${weakest[0]} ${weakest[1]}`, output: { total, grade: grade(total), dimensions: dims, weakest: weakest[0] } };
  },
};

const diff_spec: BrainTool = {
  name: "diff_spec",
  description: "对比一个 agent 当前版本 vs 上一次 refine 之前的快照（看这轮精修到底改了什么）。",
  parameters: params({ action: { type: "string" } }, ["action"]),
  async execute(args, ctx) {
    const name = String(args.action ?? "").trim();
    const spec = ctx.specs.find((s) => s.actionName === name);
    const history = ctx.attemptHistory[name];
    if (!spec || !history?.length) return { ok: false, summary: `「${name}」没有精修历史可对比。` };
    const prior = history[history.length - 1]!.priorSpecSnapshot;
    const added = spec.tools.filter((t) => !prior.tools.includes(t));
    const removed = prior.tools.filter((t) => !spec.tools.includes(t));
    return { ok: true, summary: `工具 +[${added.join("、") || "无"}] -[${removed.join("、") || "无"}] · prompt ${prior.systemPrompt === spec.systemPrompt ? "未变" : "已变"}`, output: { toolsAdded: added, toolsRemoved: removed, promptChanged: prior.systemPrompt !== spec.systemPrompt } };
  },
};

const review_agent: BrainTool = {
  name: "review_agent",
  description: "独立审查所有已设计 agent 是否合规：规则校验闸口是否绑了动态抓规则、prompt 是否为空、非校验 agent 是否误写了规则。返回需要修的清单。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.specs.length) {
      return {
        ok: false,
        summary: "还没设计 agent，无从执行设计与代码审查。",
        output: { verdict: "blocked", failure: "review_target_missing", findings: [], deterministic: [], judge: [], codeCritique: [], reviewFailures: ["没有待审查的 agent"], blocking: true },
      };
    }
    // Tier 1 — free deterministic set-membership checks (fast, certain).
    const findings: string[] = [];
    const ruleIds = ruleIdentifiers(ctx); // #9: ontology-driven, not RAAS's \d-\d scheme
    const ruleAssessments = new Map(ctx.specs.map((spec) => [
      spec,
      assessRuleGate(spec, {
        ontologyAction: ctx.ontology?.actions?.find((action) => action.name === spec.actionName),
        registeredTools: ctx.realTools ?? [],
      }),
    ]));
    for (const s of ctx.specs) {
      const ruleAssessment = ruleAssessments.get(s)!;
      if (!s.systemPrompt.trim()) findings.push(`「${s.nameZh}」prompt 为空`);
      if (ruleAssessment.isRuleGate && !ruleAssessment.readerBound) findings.push(`「${s.nameZh}」有结构化规则闸证据，但没有已绑定的规则读取能力；请在 Ontology integration 中解析 rulebase binding，或明确选择带 rulebase/read capability 的工具`);
      const txt = `${s.systemPrompt}\n${s.decisionLogic ?? ""}`;
      if (!ruleAssessment.isRuleGate && promptEmbedsRule(txt, ruleIds)) findings.push(`「${s.nameZh}」没有结构化规则闸证据，却写进了具体业务规则`);
      // #REDESIGN FU3 — surface reviewLoop PROBE downgrades: code that compiled+linted but didn't load
      // a callable handler, so it fell back to declarative. Legible instead of silent.
      if (s.probeReason) findings.push(`「${s.nameZh}」代码未过加载探针（已回退声明式执行）：${s.probeReason}`);
    }
    // Tier 2 — independent cite-the-span LLM JUDGE on the SEMANTIC question code can't decide:
    // does each rule-gate's prompt ACTUALLY fetch rules at runtime (vs hardcode), and does each
    // prompt truly fit the agent's responsibility? Layered on the deterministic pass; it must cite,
    // and an unavailable/invalid verdict leaves the whole review UNKNOWN rather than green.
    const gatewayConfigured = isGatewayConfigured();
    const reviewFailures: string[] = [];
    let judge: string[] = [];
    if (!gatewayConfigured && ctx.specs.length) {
      reviewFailures.push("设计裁判: LLM 网关未配置");
    } else if (gatewayConfigured && ctx.specs.length) {
      const digest = ctx.specs
        .map((s) => `## ${s.actionName}（${ruleAssessments.get(s)?.isRuleGate ? "规则闸口" : "普通"} · 工具:${s.tools.join(",") || "无"}）\nsystem_prompt:\n${(s.systemPrompt || "").slice(0, 1400)}\n决策逻辑: ${(s.decisionLogic || "").slice(0, 500)}`)
        .join("\n\n");
      const sys =
        "你是 agent 设计的【独立质检裁判】。对每个 agent 判断并【必须引用它 prompt 里的片段为证】：(1) 若是规则闸口，它的 prompt 是否让它【运行时按上下文动态抓规则核对】而不是把具体规则写死；(2) prompt 是否真的贴合该动作的职责、不是空泛套话或张冠李戴。只输出 JSON 数组：" +
        // #P1-12 (Self-Refine) — actionable+specific 双硬性要求：specific=evidence 引原文片段，
        // actionable=fix 给"改哪个字段/换什么写法"的具体动作（消融证据：specific 27.5 vs generic 26.0
        // vs 无反馈 24.8）。泛评("再优化一下")按无效反馈处理，refine 循环不采纳。
        '[{"agent":string,"issue":string,"evidence":string,"fix":string}]（evidence 必须是引用的 prompt 原文片段；fix 必须是具体动作——改哪个字段/prompt 的哪一段/换成什么写法，禁止"再优化一下"式泛评）。没问题就输出 []。不要任何其它文字。';
      try {
        const arr = parseReviewRows(
          await chatJson<Array<Record<string, unknown>>>(sys, digest, { temperature: 0.2, maxTokens: 4000, signal: ctx.signal, models: heterogeneousReviewChain("hard"), purpose: "review_agent.judge" }),
          ["agent", "issue", "evidence", "fix"],
        );
        judge = arr.map((x) => `🧠裁判·「${String(x.agent)}」: ${String(x.issue)}（证据「${String(x.evidence).slice(0, 70)}」）【修法】${String(x.fix).slice(0, 120)}`);
      } catch (error) {
        reviewFailures.push(reviewFailure("设计裁判", error));
      }
    }
    // Tier 3 (#REDESIGN FU3) — CODE critique for handlers with the exclusive CodeAct owner.
    // CodeAct is deliberately limited to deterministic computation plus collect-emits: anything
    // that needs reason/tool/memory/invoke/spawn stays under the declarative durable-step owner and
    // is judged by the plan/tool coverage checks above. One batched pass over ONLY executable specs
    // verifies useful deterministic work (rather than a compiling constant-return shell) and cites
    // the relevant code span.
    let codeCritique: string[] = [];
    const execSpecs = ctx.specs.filter((s) => s.codeExecuted && (s.generatedCode ?? "").trim());
    if (gatewayConfigured && execSpecs.length) {
      const digest = execSpecs
        .map((s) => `## ${s.actionName}（期望 emit:${(s.emit ?? []).join(",") || "—"} · 工具:${s.tools.join(",") || "无"}）\n决策逻辑: ${(s.decisionLogic || "").slice(0, 300)}\n代码:\n${(s.generatedCode || "").slice(0, 1500)}`)
        .join("\n\n");
      const sys =
        "你是【纯确定性 CodeAct 代码质检】。下列 handler 会在隔离沙箱里真实执行，但其唯一合法职责是纯确定性计算/校验并收集 emit；reason、tool/tools.run、memory、invoke、spawn 等 RPC 必须由声明式 durable plan 执行，Date.now/new Date/Math.random/crypto/performance 等时间或随机熵也必须由宿主捕获并通过 input 传入，绝不能在 CodeAct 内读取。逐个判断并引用代码原文为证：(1) 输入变换、校验或计算是否真实实现了给定决策逻辑；(2) 是否 emit 了它声明的产出事件；(3) 是否只是编译能过却直接返回常量或原样输入的空壳；(4) 若出现上述 RPC 或非确定性能力，必须报错并要求转交 declarative owner。只输出 JSON 数组：" +
        '[{"agent":string,"issue":string,"evidence":string}]（evidence 必须引用代码原文片段）。没问题就输出 []。不要任何其它文字。';
      try {
        const arr = parseReviewRows(
          await chatJson<Array<Record<string, unknown>>>(sys, digest, { temperature: 0.2, maxTokens: 4000, signal: ctx.signal, models: heterogeneousReviewChain("hard"), purpose: "review_agent.code" }),
          ["agent", "issue", "evidence"],
        );
        codeCritique = arr.map((x) => `⚙代码·「${String(x.agent)}」: ${String(x.issue)}（证据「${String(x.evidence).slice(0, 60)}」）`);
      } catch (error) {
        reviewFailures.push(reviewFailure("生成代码质检", error));
      }
    }
    const all = [...findings, ...judge, ...codeCritique];
    if (codeCritique.length) ctx.emit({ t: "reflect", kind: "code-critique", lesson: `生成代码质检 ${codeCritique.length} 处：${codeCritique.slice(0, 3).join("；")}` });
    if (reviewFailures.length) {
      return {
        ok: false,
        summary: `审查未完成，结论为 unknown：${reviewFailures.join("；")}${all.length ? `；已确认 ${all.length} 处问题：${all.slice(0, 3).join("；")}` : ""}`,
        output: { verdict: "unknown", failure: "llm_review_unavailable", findings: all, deterministic: findings, judge, codeCritique, reviewFailures, blocking: true },
      };
    }
    return { ok: all.length === 0, summary: all.length ? `审查发现 ${all.length} 处问题：${all.slice(0, 4).join("；")}` : "审查通过：确定性检查 + LLM 设计裁判 + 适用的生成代码质检均合规 ✓", output: { verdict: all.length ? "issues" : "pass", findings: all, deterministic: findings, judge, codeCritique, reviewFailures } };
  },
};

// #REVIEW 透镜② · 上下文审查 —— 生成期三重审查环的第二环:每个 agent 是否【读懂并契合了自己的上下文】。
// 确定性层查触发/产出事件是否存在于本体 + 契约图字段缺口;LLM 层对照 ontologyUnderstanding 查语义误读/张冠李戴。
const review_context: BrainTool = {
  name: "review_context",
  description:
    "上下文审查(生成期审查环·透镜②):对照本体理解 + 字段契约图,逐个 agent 判它是否【读懂并契合了自己的上下文】——触发事件的业务语义、上游产出、下游所需、I/O 是否对齐,有没有张冠李戴。发现问题就 refine 再审。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    if (!ctx.specs.length) return { ok: false, summary: "还没设计 agent，无从审查上下文。" };
    // Tier 1 — deterministic: trigger/emit events must exist in the ontology; field contract gaps.
    const findings: string[] = [];
    const knownEvents = new Set(ctx.ontology.actions.flatMap((a) => [...a.trigger, ...a.triggered_event]));
    for (const s of ctx.specs) {
      for (const t of s.trigger ?? []) if (t && !knownEvents.has(t)) findings.push(`「${s.nameZh}」触发事件「${t}」本体里不存在（张冠李戴?）`);
      for (const e of s.emit ?? []) if (e && e !== "—" && !knownEvents.has(e)) findings.push(`「${s.nameZh}」产出事件「${e}」本体里不存在`);
    }
    const contract = deriveContractGraph(ctx.specs, ctx.domain, canonicalEventFields(ctx.ontology));
    for (const line of contractIssueStringsBySeverity(contract).hard) findings.push(line); // #SIMPLIFY 结构化分级
    // Tier 2 — LLM: did each agent READ its context correctly (vs the ontology understanding)?
    let judge: string[] = [];
    const reviewFailures: string[] = [];
    if (!isGatewayConfigured()) {
      reviewFailures.push("上下文裁判: LLM 网关未配置");
    } else {
      const understanding = ctx.ontologyUnderstanding ? `【本体理解摘要】\n${ctx.ontologyUnderstanding.slice(0, 1500)}\n\n` : "";
      const digest =
        understanding +
        ctx.specs.map((s) => `## ${s.actionName}\n触发:${(s.trigger ?? []).join(",") || "—"} → 产出:${(s.emit ?? []).join(",") || "—"} · 工具:${s.tools.join(",") || "无"}\nsystem_prompt:${(s.systemPrompt || "").slice(0, 900)}`).join("\n\n");
      const sys =
        "你是【上下文审查】。对照本体理解,逐个 agent 判并【引用 prompt 片段为证】:(1) 是否读懂了它触发事件的业务语义;(2) 消费/产出的字段是否和上下游对齐;(3) 有没有把 A 动作的职责误当 B(张冠李戴)。只输出 JSON 数组:" +
        '[{"agent":string,"issue":string,"evidence":string}]。没问题就输出 []。不要任何其它文字。';
      try {
        const arr = parseReviewRows(
          await chatJson<Array<Record<string, unknown>>>(sys, digest, { temperature: 0.2, maxTokens: 4000, signal: ctx.signal, models: heterogeneousReviewChain("hard"), purpose: "review_context" }),
          ["agent", "issue", "evidence"],
        );
        judge = arr.map((x) => `🧭上下文·「${String(x.agent)}」: ${String(x.issue)}（证据「${String(x.evidence).slice(0, 60)}」）`);
      } catch (error) {
        reviewFailures.push(reviewFailure("上下文裁判", error));
      }
    }
    const all = [...findings, ...judge];
    if (reviewFailures.length) {
      ctx.emit({ t: "reflect", kind: "context-review", lesson: `上下文审查未完成（unknown）：${reviewFailures.join("；")}` });
      return {
        ok: false,
        summary: `上下文审查未完成，结论为 unknown：${reviewFailures.join("；")}${all.length ? `；已确认 ${all.length} 处问题` : ""}`,
        output: { verdict: "unknown", failure: "llm_review_unavailable", findings: all, deterministic: findings, judge, reviewFailures, blocking: true },
      };
    }
    ctx.emit({ t: "reflect", kind: "context-review", lesson: all.length ? `上下文审查 ${all.length} 处：${all.slice(0, 3).join("；")}` : "上下文审查:各 agent 读懂并契合上下文 ✓" });
    return { ok: all.length === 0, summary: all.length ? `上下文审查发现 ${all.length} 处：${all.slice(0, 4).join("；")}` : "上下文审查通过 ✓", output: { verdict: all.length ? "issues" : "pass", findings: all, deterministic: findings, judge, reviewFailures } };
  },
};

// #REVIEW 透镜③ · 完整性/元认知审查 —— 生成期三重审查环的第三环:【是否都思考全了】。
// 确定性层查覆盖/分支/规则绑定/执行能力证据；LLM 层做元认知"还有什么没想到"——运行时事实(错误分类/foreach/HITL/外部交接/边界)。
const review_completeness: BrainTool = {
  name: "review_completeness",
  description:
    "完整性/元认知审查(生成期审查环·透镜③):审查【是否都思考全了】——所有 Agent 动作覆盖了吗、多分支事件是否都分流、运行时事实(失败该 throw 还是 emit 失败事件/可恢复 vs 业务失败/集合入参 foreach/HITL/外部交接/边界)想到了吗、规则闸口是否都绑定。返回『还缺什么』清单。finish 前的元认知门。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    // Tier 1 — deterministic completeness checks.
    const gaps: string[] = [];
    const agentActions = generationScopedAgentActionNames(ctx);
    const done = new Set(ctx.specs.map((s) => s.actionName));
    const uncovered = agentActions.filter((n) => !done.has(n));
    if (uncovered.length) gaps.push(`漏了 ${uncovered.length} 个 Agent 动作没设计:${uncovered.join("、")}`);
    const integrationIssuesByAgent = new Map<string, ReturnType<typeof assessIntegrationBindings>["issues"]>();
    for (const issue of assessIntegrationBindings(ctx.specs, ctx.ontology, false).issues) {
      const list = integrationIssuesByAgent.get(issue.short) ?? [];
      list.push(issue);
      integrationIssuesByAgent.set(issue.short, list);
    }
    for (const s of ctx.specs) {
      const emits = (s.emit ?? []).filter((e) => e && e !== "—");
      if (emits.length >= 2 && !(s.plan && s.plan.some((p) => p.kind === "condition"))) gaps.push(`「${s.nameZh}」有 ${emits.length} 个分支产出(${emits.join("/")})但没有 condition 分支步——多结果未分流?`);
      const ruleAssessment = assessRuleGate(s, {
        ontologyAction: ctx.ontology.actions.find((action) => action.name === s.actionName),
        registeredTools: ctx.realTools ?? [],
      });
      if (ruleAssessment.isRuleGate && !ruleAssessment.readerBound) gaps.push(`「${s.nameZh}」有结构化规则闸证据，但未绑定 rulebase 读取能力`);
      if (s.degraded === true) gaps.push(`「${s.nameZh}」仍是生成失败后的降级壳，尚未成为完整 Function`);
      for (const issue of integrationIssuesByAgent.get(s.short) ?? []) {
        gaps.push(`「${s.nameZh}」的 ${issue.requirement.system}/${issue.requirement.role} 执行能力未就绪：${issue.status}（${issue.reason}）`);
      }
    }
    // Tier 2 — metacognitive LLM: given the understanding + designed specs, what's MISSING?
    let missing: string[] = [];
    const reviewFailures: string[] = [];
    if (!isGatewayConfigured() && ctx.specs.length) {
      reviewFailures.push("完整性裁判: LLM 网关未配置");
    } else if (ctx.specs.length) {
      const understanding = ctx.ontologyUnderstanding ? `【本体理解(含 ambiguities/risks/externalHandoffs)】\n${ctx.ontologyUnderstanding.slice(0, 1800)}\n\n` : "";
      const digest =
        understanding +
        `【本次验收 Action 范围】${agentActions.join("、") || "无"}\n` +
        `【已设计 ${ctx.specs.length} 个 agent】\n` +
        ctx.specs.map((s) => `· ${s.actionName}: 触发 ${(s.trigger ?? []).join(",") || "—"} → ${(s.emit ?? []).join(",") || "—"} · plan ${s.plan?.length || 0} 步`).join("\n");
      const sys =
        "你是【完整性/元认知审查】。别复述已做的——只找【还没想到的】。严格以材料里的【本次验收 Action 范围】为全集，不得要求补范围外 Action。逐条判断:(1) 本次范围内有没有 Agent 动作/事件分支被漏掉;(2) 运行时事实是否想全了:失败该 throw 还是 emit 失败事件、可恢复(infra)vs 业务失败、集合入参要不要 foreach、要不要 HITL、有没有外部交接终态被当断链;(3) 有没有边界/异常场景没处理;(4) 规则是否都绑定。只输出 JSON 数组:" +
        '[{"gap":string,"severity":"high"|"med"|"low"}]。都想全了就输出 []。不要任何其它文字。';
      try {
        const arr = parseReviewRows(
          await chatJson<Array<Record<string, unknown>>>(sys, digest, { temperature: 0.3, maxTokens: 4000, signal: ctx.signal, models: heterogeneousReviewChain("hard"), purpose: "review_completeness" }),
          ["gap", "severity"],
          { severity: ["high", "med", "low"] },
        );
        missing = arr.map((x) => `🧩[${String(x.severity)}] ${String(x.gap)}`);
      } catch (error) {
        reviewFailures.push(reviewFailure("完整性裁判", error));
      }
    }
    const all = [...gaps, ...missing];
    const high = gaps.length + missing.filter((m) => m.includes("[high]")).length;
    if (reviewFailures.length) {
      ctx.emit({ t: "reflect", kind: "completeness", lesson: `完整性审查未完成（unknown）：${reviewFailures.join("；")}` });
      return {
        ok: false,
        summary: `完整性审查未完成，结论为 unknown：${reviewFailures.join("；")}${all.length ? `；已确认 ${all.length} 处缺口(${high} 重要)` : ""}`,
        output: { verdict: "unknown", failure: "llm_review_unavailable", gaps: all, deterministic: gaps, missing, reviewFailures, blocking: true },
      };
    }
    ctx.emit({ t: "reflect", kind: "completeness", lesson: all.length ? `完整性审查 ${all.length} 处未想全(${high} 重要):${all.slice(0, 3).join("；")}` : "完整性审查:覆盖/分支/运行时事实/规则均已想全 ✓" });
    return {
      ok: all.length === 0,
      summary: all.length ? `完整性审查:还有 ${all.length} 处没想全(${high} 重要):${all.slice(0, 4).join("；")}` : "完整性审查通过:都想全了 ✓",
      output: { verdict: all.length ? "issues" : "pass", gaps: all, deterministic: gaps, missing, reviewFailures, blocking: high > 0 },
    };
  },
};

const list_agents: BrainTool = {
  name: "list_agents",
  description: "列出已设计的所有 agent + 本次 generation scope 内还没覆盖的 actor=Agent 动作，掌握进度。",
  parameters: params({}),
  async execute(_args, ctx) {
    const agentActions = generationScopedAgentActionNames(ctx);
    const done = new Set(ctx.specs.map((s) => s.actionName));
    const remaining = agentActions.filter((n) => !done.has(n));
    const designed = agentActions.filter((name) => done.has(name)).length;
    return { ok: true, summary: `本次范围已设计 ${designed}/${agentActions.length} · 还差 ${remaining.length}：${remaining.join("、") || "无"}`, output: { agents: ctx.specs.map(cardOf), remaining, designed, total: agentActions.length } };
  },
};

const list_domains: BrainTool = {
  name: "list_domains",
  description: "列出工厂可以生成的所有业务域（当用户问『有几个域』『都有哪些域』这类信息问题时用，不必跑生成流水线）。",
  parameters: params({}),
  async execute(_args, ctx) {
    const domains = await ctx.ports.ontology.listDomains();
    return { ok: true, summary: `共 ${domains.length} 个业务域：${domains.map((d) => d.name ?? d.id).join("、")}`, output: { domains } };
  },
};

const describe_domain: BrainTool = {
  name: "describe_domain",
  description: "概述一个业务域的规模（多少动作/事件/对象/规则、多少要造 agent），回答信息类问题用，不跑生成。",
  parameters: params({ domain: { type: "string", description: "域 id，省略=当前域" } }),
  async execute(args, ctx) {
    const id = String(args.domain ?? ctx.domain).trim();
    try {
      const ont = await ctx.ports.ontology.fetchOntology(id);
      const agentN = ont.actions.filter((a) => a.actor.includes("Agent")).length;
      return { ok: true, summary: `「${id}」：${ont.actions.length} 动作（${agentN} 个要造 agent）· ${ont.events.length} 事件 · ${ont.objects.length} 对象 · ${ont.rules.length} 规则`, output: { domain: id, actions: ont.actions.length, agentActions: agentN, events: ont.events.length, objects: ont.objects.length, rules: ont.rules.length } };
    } catch (e) {
      return { ok: false, summary: `读不到域「${id}」：${(e as Error).message}` };
    }
  },
};

const describe_object: BrainTool = {
  name: "describe_object",
  // #3/#4 (memory recall): targeted retrieval of ONE DataObject's full detail from the cached
  // ontology — so after context compaction, the brain can recover an object's exact field names
  // (to write input_schema/output_schema) WITHOUT a full, heavy read_ontology re-fetch.
  description: "取回某个数据对象(DataObject)的完整属性(主键 + 每个字段的 name/type/description)。压缩后忘了对象字段、要写 input_schema/output_schema 时用，避免重新全量 read_ontology。",
  parameters: params({ name: { type: "string", description: "对象 id 或显示名（read_ontology data_objects[].id/name）" } }, ["name"]),
  async execute(args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    const q = String(args.name ?? "").trim().toLowerCase();
    if (!q) return { ok: false, summary: "要给对象 id 或名字。" };
    const objs = ctx.ontology.objects;
    const o =
      objs.find((x) => x.id.toLowerCase() === q || (x.name ?? "").toLowerCase() === q) ??
      objs.find((x) => x.id.toLowerCase().includes(q) || (x.name ?? "").toLowerCase().includes(q));
    if (!o) return { ok: false, summary: `找不到对象「${args.name}」。现有对象：${objs.map((x) => x.name || x.id).slice(0, 40).join("、")}` };
    const props = o.properties ?? [];
    return {
      ok: true,
      summary: `对象「${o.name || o.id}」：主键 ${o.primary_key ?? "—"} · ${props.length} 个属性：${props.map((p) => p.name).slice(0, 30).join("、")}`,
      output: { id: o.id, name: o.name, description: o.description, primary_key: o.primary_key, properties: props },
    };
  },
};

const web_search: BrainTool = {
  name: "web_search",
  description: "联网搜索开发文档/行业规则/字段含义等外部知识，结果会作为 grounding 喂进后续 agent 设计。仅在确实需要外部事实时用。",
  parameters: params({ query: { type: "string" } }, ["query"]),
  async execute(args, ctx) {
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, summary: "联网搜索 query 不能为空。", output: { results: [], failure: "empty_query" } };
    if (!ctx.ports.web) {
      return {
        ok: false,
        summary: "联网搜索不可用：没有配置真实 WebSearch provider。该步骤未执行，不能按零结果继续。",
        output: { results: [], failure: "web_search_provider_not_configured" },
      };
    }
    let results: Awaited<ReturnType<NonNullable<BrainCtx["ports"]["web"]>["search"]>>;
    try {
      results = await ctx.ports.web.search(query);
    } catch (e) {
      const error = String((e as Error)?.message ?? e).slice(0, 240);
      return {
        ok: false,
        summary: `联网搜索失败：${error || "provider error"}。该调用没有被伪装成零结果。`,
        output: { results: [], failure: "web_search_provider_failed", error },
      };
    }
    if (results.length) {
      ctx.research.push({ query, findings: results.map((r) => `${r.title}: ${r.snippet}`).join("\n") });
      ctx.emit({ t: "web.result", query, results });
    }
    return { ok: true, summary: `搜「${query}」→ ${results.length} 条结果`, output: { results } };
  },
};

// #P2 — skills are woven RAW into every relevant agent's prompt, so a malicious/noisy skill fragment
// is a prompt-injection surface that poisons all downstream agents. Neutralize role markers +
// instruction-override patterns before storing/weaving. Returns the cleaned text + whether it tripped.
const SKILL_INJECTION =
  /(?:^|\n)[ \t]*(?:system|assistant|user)[ \t]*[:：]|ignore[ \t]+(?:all[ \t]+|the[ \t]+)?(?:previous|above|prior)[ \t]+(?:instructions?|rules?|prompts?)|disregard[ \t]+[^\n]{0,24}(?:instructions?|rules?)|you[ \t]+are[ \t]+now[ \t]|<\/?[ \t]*(?:system|instructions?)[ \t]*>/gi;
export function sanitizeSkillFragment(text: string): { clean: string; flagged: boolean } {
  let flagged = false;
  const clean = text.replace(SKILL_INJECTION, () => {
    flagged = true;
    return "[已移除可疑指令片段]";
  });
  return { clean, flagged };
}

const create_skill: BrainTool = {
  name: "create_skill",
  description: "把一段可复用的 know-how 沉淀成技能：织入 agent prompt 的指导片段 + 推荐工具 + 决策规则。会①本次运行织进 design_agent，②持久化到技能库供以后复用。general=true 则跨域可用。先 use_skill 看库里有没有现成的。",
  parameters: params({ name: { type: "string" }, purpose: { type: "string" }, prompt_fragment: { type: "string" }, tools: { type: "array", items: { type: "string" } }, decision_rule: { type: "string" }, general: { type: "boolean" } }, ["name", "purpose", "decision_rule"]),
  async execute(args, ctx) {
    const name = String(args.name ?? "").trim();
    const promptFragment = String(args.prompt_fragment ?? "").trim();
    const decisionRule = String(args.decision_rule ?? "").trim();
    // #REDESIGN P3 — lightweight review: a skill gets woven into EVERY relevant agent's prompt, so it
    // must carry SUBSTANTIVE, reusable know-how — reject an empty/trivial skill (noise), and reject one
    // that hardcodes a specific business rule (rules belong in the rule-gate, fetched at runtime).
    // A real skill needs a substantive prompt_fragment (the reusable guidance woven into agents) AND
    // a real decision_rule — trivial content just dilutes every prompt it touches.
    if (promptFragment.length < 24 || decisionRule.length < 8) {
      return { ok: false, summary: `技能「${name}」内容太空——prompt_fragment 需 ≥24 字的实质指导、decision_rule 需 ≥8 字，别把空话织进 agent。`, output: { rejected: "empty" } };
    }
    if (promptEmbedsRule(`${promptFragment}\n${decisionRule}`, ruleIdentifiers(ctx))) {
      return { ok: false, summary: `技能「${name}」把具体业务规则写死进了片段——规则应留给校验闸口在运行时动态抓，别织进通用技能。`, output: { rejected: "rule_leak" } };
    }
    // #P2 — sanitize prompt-injection out of the fragment before it's woven into every relevant agent.
    const san = sanitizeSkillFragment(promptFragment);
    if (san.flagged) ctx.emit({ t: "reflect", kind: "skill-sanitize", lesson: `技能「${name}」的片段含疑似 prompt 注入指令，已中和后再织入。` });
    const skill = { name, purpose: String(args.purpose ?? ""), promptFragment: san.clean, tools: (args.tools as string[]) ?? [], decisionRule };
    ctx.createdSkills.push(skill);
    ctx.emit({ t: "skill.created", name, purpose: skill.purpose });
    let persistError: string | null = null;
    if (ctx.ports.skills) {
      const slug = kebab(name);
      try {
        await ctx.ports.skills.save({ slug, name, purpose: skill.purpose, promptFragment: skill.promptFragment, tools: skill.tools, decisionRule: skill.decisionRule, domain: args.general ? null : ctx.domain });
      } catch (e) {
        persistError = (e as Error).message || String(e);
      }
    }
    // #W3-3 — RETROACTIVE weaving: agents designed BEFORE this skill existed never benefited (only
    // future design_agent calls wove skills). Weave the new skill into every existing spec that
    // doesn't carry it yet, and re-grade their rendered code. Sandbox evidence invalidates.
    const retroWove: string[] = [];
    for (const sp of ctx.specs ?? []) {
      const line = `· ${skill.name}：${skill.decisionRule}`;
      if (sp.systemPrompt.includes(line)) continue;
      sp.systemPrompt += sp.systemPrompt.includes("【可复用技能】") ? `\n${line}` : `\n\n【可复用技能】\n${line}`;
      if (sp.codeSource !== "ai") await renderExecutableCode(sp);
      retroWove.push(sp.short);
    }
    if (retroWove.length) ctx.lastSandbox = null;
    if (persistError) {
      return {
        ok: false,
        summary: `技能「${name}」已保留在本次运行${retroWove.length ? `并追溯织入 ${retroWove.length} 个 agent` : ""}，但持久化入库失败：${persistError}。后续运行不会自动看到它，请修复存储后重试。`,
        output: { name, retroWove, inMemory: true, persisted: false, error: persistError },
      };
    }
    return { ok: true, summary: `技能「${name}」已创建${ctx.ports.skills ? "并入库" : "（本次运行内）"}${retroWove.length ? `，并已【追溯织入】${retroWove.length} 个已设计 agent(${retroWove.slice(0, 4).join("、")})` : "，会织进相关 agent"}。`, output: { name, retroWove } };
  },
};

const use_skill: BrainTool = {
  name: "use_skill",
  description: "查看/复用技能库里已有的技能（以前运行沉淀的 know-how）。不传 name → 列出本域可用技能；传 name → 调入本次运行，design_agent 会织进对应 agent。设计前先看一眼能不能复用。",
  parameters: params({ name: { type: "string" } }),
  async execute(args, ctx) {
    if (!ctx.ports.skills) return { ok: true, summary: "技能库未配置。需要时用 create_skill 在本次运行内创建。", output: { skills: [] } };
    const available = await ctx.ports.skills.list(ctx.domain);
    const want = String(args.name ?? "").trim();
    if (!want) return { ok: true, summary: available.length ? `技能库有 ${available.length} 个：${available.map((s) => `${s.name}(用过${s.useCount}次)`).join("、")}` : "技能库为空。", output: { skills: available.map((s) => ({ slug: s.slug, name: s.name, purpose: s.purpose, useCount: s.useCount })) } };
    const found = available.find((s) => s.slug === kebab(want) || s.name === want);
    if (!found) return { ok: false, summary: `技能库里没有「${want}」。`, output: {} };
    ctx.createdSkills.push({ name: found.name, purpose: found.purpose, promptFragment: found.promptFragment, tools: found.tools, decisionRule: found.decisionRule });
    await ctx.ports.skills.bumpUse(found.slug);
    ctx.emit({ t: "skill.created", name: found.name, purpose: found.purpose });
    return { ok: true, summary: `已调入技能「${found.name}」，会织进相关 agent。`, output: { name: found.name } };
  },
};

// #P5 — 能力梯:发现"需要一个当前没有的能力"时,按六级从便宜到贵解析怎么获得它。这是【顾问式】
// 工具——它综合你已经用 search_tools/list_agents 查到的命中(经参数传入)+ 技能库现状,给出该走哪级
// + 下一步该调哪个工具。真正的实例化/锻造执行(instantiate_subagent / skill_forge)依赖站长工具面
// (P2.5),本工具先把决策与路由做对、可解释。
const resolve_capability_ladder: BrainTool = {
  name: "resolve_capability_ladder",
  description:
    "能力梯(#P5):当你或某 agent 需要一个当前没有的能力时,用它决定怎么获得——六级从便宜到贵:①复用已交付函数 ②工具库 ③MCP ④实例化 active 技能 ⑤锻造新技能(带 spawnSpec,落 draft,监督下首用)⑥造工具。传 need 描述;若你已用 search_tools/list_agents 查到命中,把 fleet_has/tool_hit/mcp_hit 传进来;能力本质是缺工具就传 is_missing_tool=true。返回推荐动作 + 下一步该调的工具。",
  parameters: params(
    {
      need: { type: "string", description: "缺什么能力(自然语言)" },
      fleet_has: { type: "boolean", description: "已交付函数是否覆盖(来自 list_agents/capability_resolve)" },
      tool_hit: { type: "string", description: "search_tools 命中的工具名(无则不传)" },
      mcp_hit: { type: "string", description: "命中的 MCP 工具名 <server>.<tool>(无则不传)" },
      is_missing_tool: { type: "boolean", description: "该能力本质是缺一个工具/集成(而非缺会推理的 sub-agent)" },
    },
    ["need"],
  ),
  async execute(args, ctx) {
    const need = String(args.need ?? "").trim();
    if (!need) return { ok: false, summary: "need 为空——描述你缺的能力。" };
    // 技能库:找一个 active 且带 spawnSpec(可实例化)、名称/用途与 need 相关的技能。
    const skills = ctx.ports.skills ? await ctx.ports.skills.list(ctx.domain) : [];
    const needWords = need.toLowerCase().split(/[\s，,、]+/).filter((w) => w.length >= 2);
    const spawnable = skills.filter((s) => s.spawnSpec && (s.lifecycle ?? "active") === "active");
    const skillHit = spawnable.find((s) => needWords.some((w) => `${s.name}${s.purpose}`.toLowerCase().includes(w)));
    const anySkillHit = skillHit ?? skills.find((s) => s.spawnSpec && needWords.some((w) => `${s.name}${s.purpose}`.toLowerCase().includes(w)));
    const res = resolveCapabilityLadder({
      description: need,
      fleetHas: !!args.fleet_has,
      toolHas: (args.tool_hit ? String(args.tool_hit) : null) || null,
      mcpHas: (args.mcp_hit ? String(args.mcp_hit) : null) || null,
      skillHas: anySkillHit ? { slug: anySkillHit.slug, lifecycle: anySkillHit.lifecycle ?? "active" } : null,
      isMissingTool: !!args.is_missing_tool,
    });
    const nextTool: Record<string, string> = {
      reuse_function: "list_agents / capability_resolve 拿到函数并复用/组合",
      call_tool: `直接把工具「${res.target}」绑进 design_agent 的 tool_use`,
      call_mcp: `调用 MCP 工具「${res.target}」`,
      instantiate_subagent: `use_skill「${res.target}」调入(实例化执行依赖 P2.5 站长工具面)`,
      forge_skill: "create_skill(写 promptFragment+决策规则,将来补 spawnSpec 落 draft)+ 需要调研就 spawn_subagent",
      create_tool: "create_tool 或 extract_api_schema(文档→工具)",
    };
    ctx.emit({ t: "reflect", kind: "capability", lesson: `能力梯:${need} → L${res.level} ${res.action}${res.target ? `(${res.target})` : ""}` });
    return { ok: true, summary: `能力梯 L${res.level}:${res.reason}。下一步 → ${nextTool[res.action]}`, output: { ...res, nextTool: nextTool[res.action] } };
  },
};

// #STRATEGY-COMBO — AI 自选推理方法【组合】。推理【不默认 ReAct】:你按当前子问题/意图,自己选一个
// 策略或一个【组合】(如 tot→debate→reflection),并给理由。不传 proposed → 返回一个【先验建议】(表 +
// 各策略说明)供你参考,你再决定。传 proposed → 记录你的选择并广播(UI 每张 agent 卡会显示它在用什么推理)。
const select_strategy: BrainTool = {
  name: "select_strategy",
  description:
    "为当前子问题【选择并真正执行】一种推理方法或【组合】(不默认 ReAct)。可选:react(工具循环)/reflection(产出→自评→重写)/debate(多方论证+评委)/tot(思维树 K 分叉打分剪枝)/cot(单链)。不传 proposed → 我给你先验建议+各方法适用场景;传 proposed(如「tot→debate→reflection」或「cot」)+ rationale → 我会【真的按这个方法/组合跑一遍推理】(组合按序把上一步产出喂给下一步),把推理结论回给你用。组合往往比单一更好;纯 react 表示直接在主工具循环里边做边探(不额外跑)。",
  parameters: params(
    {
      subproblem: { type: "string", description: "你正要推理的子问题/当前决策(一句话)" },
      context: { type: "string", description: "语境(可选):plan/design/code/review/arbitrate/finish/analyze/subproblem" },
      proposed: { type: "string", description: "你选的策略或组合(可选)。单个如「reflection」,组合如「tot→debate→reflection」。不传=让我先给建议。" },
      rationale: { type: "string", description: "为什么这么选(为什么这个任务适合/不适合某策略)" },
      // #KERNEL-TIER-AI / #BLUEPRINT-SCOPE 同源理念：这两项让【你】决定这次推理用多强的脑子、探多宽，
      // 而不是让角色名正则或本体规模阈值替你定。不传=沿用默认（explore=fast、synth=default、K=3）。
      tier: { type: "string", enum: ["fast", "default", "hard", "review"], description: "(可选)这次推理用多强的模型：难题/高风险裁决值得 hard/review，日常够用就 fast/default。会同时抬高发散(tot分叉/debate论证者)与收敛(merge/judge)两侧。" },
      branches: { type: "number", description: "(可选)tot/debate 的分叉数 K(2-5)。解空间大就多铺几条，二元裁决 2 条即可。默认 3。" },
    },
    ["subproblem"],
  ),
  async execute(args, ctx) {
    const subproblem = String(args.subproblem ?? "").trim();
    const ctxKind = (String(args.context ?? "subproblem").trim() || "subproblem") as StrategyContext;
    const forAgent = (ctx as unknown as { currentAgentSlug?: string }).currentAgentSlug;
    // 先验建议:确定性表按 意图+难度+语境 给一个默认——只作参考,不替 AI 选。
    const difficulty = estimateDifficulty(ctx.ontology ?? null);
    const suggestion = selectStrategy({ intentKind: classifyIntentKind(ctx.userIntent), difficulty, context: ctxKind });

    if (!args.proposed) {
      const menu = Object.entries(STRATEGY_DESC).map(([k, v]) => `  · ${k}:${v}`).join("\n");
      return {
        ok: true,
        summary: `先验建议:${suggestion.strategy}(${suggestion.reasons[suggestion.reasons.length - 1]})。你可采纳,或自选单个/组合。`,
        output: { subproblem, suggestion: suggestion.strategy, expensive: suggestion.expensive, why: suggestion.reasons, menu: STRATEGY_DESC, hint: `可选策略与适用场景:\n${menu}\n组合示例:复杂设计「tot→debate」;高风险落地「debate→reflection」;简单答疑「cot」。` },
      };
    }
    const plan = parseStrategyPlan(String(args.proposed), { rationale: String(args.rationale ?? ""), chosenBy: "ai" });
    ctx.emit({ t: "strategy", mode: plan.mode, steps: plan.steps.map((s) => String(s.strategy)), chosenBy: plan.chosenBy, rationale: plan.rationale, forAgent });
    const unknownNote = plan.unknown.length ? `(词表外策略「${plan.unknown.join("、")}」已按 cot 兜底执行)` : "";

    // #REASONING-KERNEL — the declared method/combo now ACTUALLY EXECUTES (was a label-only no-op).
    // A lone `react` = the ambient tool loop (no separate kernel run). Charge each kernel LLM call to
    // the shared tree budget and cap calls when the budget is nearly spent (fail-cheap, never runaway).
    const ledger = ctx.budgetLedger;
    const remaining = ledger?.maxTokens != null ? Math.max(0, ledger.maxTokens - ledger.tokens) : null;
    // "nearly spent" = headroom for ~5 kernel calls at the CONFIGURED per-call charge (scales with
    // FACTORY_KERNEL_MAX_TOKENS instead of assuming the old flat 1200-token calls).
    const maxLlmCalls = remaining != null && remaining < kernelTokenCharge() * 5 ? 2 : Math.max(2, Number(process.env.FACTORY_KERNEL_MAX_CALLS) || 10);
    const kernelContext = [
      ctx.ontologyUnderstanding ? `本体理解：${ctx.ontologyUnderstanding.slice(0, 1400)}` : "",
      ctx.userIntent ? `用户意图：${ctx.userIntent.slice(-320)}` : "",
      ctx.specs?.length ? `已设计 ${ctx.specs.length} 个 agent：${ctx.specs.map((s) => s.actionName).slice(0, 12).join("、")}` : "",
      String(args.rationale ?? "").trim() ? `选择理由：${String(args.rationale).trim()}` : "",
    ].filter(Boolean).join("\n");
    // #KERNEL-TIER-AI — AI 显式点的档位（tier）同时抬高发散与收敛两侧；不传则各自回落默认。
    const aiTier = asModelTier(args.tier);
    const aiBranches = Number.isFinite(Number(args.branches)) ? Number(args.branches) : undefined;
    const kernel = await runReasoning(
      { subproblem, context: kernelContext || undefined },
      plan,
      { emit: ctx.emit, signal: ctx.signal, forAgent, maxLlmCalls, ...(aiTier ? { exploreTier: aiTier, synthTier: aiTier } : {}), ...(aiBranches ? { branches: aiBranches } : {}), onLlmCall: () => { if (ctx.budgetLedger) ctx.budgetLedger.tokens += kernelTokenCharge(); } },
    );
    if (kernel.ambientReactOnly) {
      return { ok: true, summary: `策略=react：直接在主工具循环里边做边探即可（无需额外推理步）。`, output: { subproblem, plan: { mode: plan.mode, steps: ["react"], chosenBy: plan.chosenBy }, ambient: true, suggestion: suggestion.strategy } };
    }
    const chain = kernel.steps.map((s) => s.strategy).join(" → ");
    return {
      ok: true,
      summary: `已【真跑】推理${describeStrategyPlan(plan)}${unknownNote}（执行 ${chain}，${kernel.llmCalls} 次推理调用）。据此结论继续：${kernel.final.slice(0, 500)}`,
      output: {
        subproblem,
        plan: { mode: plan.mode, steps: plan.steps.map((s) => s.strategy), chosenBy: plan.chosenBy },
        reasoning: kernel.final,
        steps: kernel.steps.map((s) => ({ strategy: s.strategy, output: s.output.slice(0, 3500) })),
        suggestion: suggestion.strategy,
      },
    };
  },
};

const fetch_doc: BrainTool = {
  name: "fetch_doc",
  description: "Doc-Fetcher：抓取一个【公网】开发文档/API 说明页面的文本，作为造工具(create_tool)或设计 agent 的依据。走 SSRF 防护（拒绝内网/本机/元数据地址）。",
  parameters: params({ url: { type: "string", description: "公网 http(s) 文档地址" } }, ["url"]),
  async execute(args, ctx) {
    const url = String(args.url ?? "").trim();
    try {
      const res = await safeFetch(url, { headers: { accept: "text/html,text/plain,*/*" } });
      const text = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000);
      ctx.research.push({ query: url, findings: text.slice(0, 2000) });
      ctx.emit({ t: "web.result", query: url, results: [{ title: url, url, snippet: text.slice(0, 200) }] });
      return { ok: true, summary: `已抓取 ${url}（${text.length} 字，已截断喂给后续设计）`, output: { text } };
    } catch (e) {
      return { ok: false, summary: `抓取失败：${(e as Error).message}` };
    }
  },
};

const create_tool: BrainTool = {
  name: "create_tool",
  description:
    "Tool-Smith：当本体工具库缺一个 agent 真正需要的工具时，【声明式】造一个 HTTP adapter（契约+精确 capabilities+读写副作用）。它永不 eval，运行时由受防护的 fetch 执行。新建/编辑后状态一律 required，不能直接满足 integration；还要 probe_tool 取得与当前 definition 绑定的真实证据。敏感 header 只允许 {config_key} 占位符，禁止把 secret 写进定义。",
  parameters: params(
    {
      name: { type: "string", description: "工具名（带命名空间，如 acme.createTicket）" },
      description: { type: "string" },
      method: { type: "string", description: "GET / POST / PUT / PATCH / DELETE / HEAD" },
      url_template: { type: "string", description: "URL，可含 {placeholder}（运行时用事件 payload 填）" },
      headers: { type: "object", description: "请求头键值（可选）" },
      body_template: { type: "string", description: "请求体模板（可选，可含 {placeholder}）" },
      request_spec: DECLARATIVE_REQUEST_SPEC_SCHEMA,
      response_spec: DECLARATIVE_RESPONSE_SPEC_SCHEMA,
      examples: DECLARATIVE_EXAMPLES_SCHEMA,
      side_effect: { type: "string", enum: ["read", "write", "dual"], description: "旧目录展示标签；不再用于沙箱执行授权" },
      operation: { type: "string", enum: ["read", "compute", "write", "read_write"], description: "调用语义；必须来自已理解的 API/业务契约，不能按 HTTP method 猜" },
      effect_scope: { type: "string", enum: ["external"], description: "声明式 HTTP 工具固定跨越外部系统边界" },
      sandbox_policy: { type: "string", enum: ["live_external", "requires_attempt_grant"], description: "只读/纯计算外部调用用 live_external；会改变外部状态时必须 requires_attempt_grant" },
      params_schema: { type: "object", description: "（建议）入参契约：字段名→类型/说明。外部平台工具务必填，运行时据此校验。" },
      returns_schema: { type: "object", description: "（建议）返回契约：字段名→类型/说明（如 RoboHire 包在 data.data.* 下）。" },
      capabilities: {
        type: "array",
        description: "精确集成覆盖声明；要满足 read_ontology 的 integration_binding 时必填，字段必须与 requirement 一致，禁止按名字猜。",
        items: {
          type: "object",
          properties: {
            systems: { type: "array", items: { type: "string" } },
            kinds: { type: "array", items: { type: "string" } },
            roles: { type: "array", items: { type: "string" } },
            operations: { type: "array", items: { type: "string" } },
            objectTypes: { type: "array", items: { type: "string" } },
            probeRequired: { type: "boolean" },
          },
          required: ["systems", "kinds", "roles"],
          additionalProperties: false,
        },
      },
    },
    ["name", "description", "method", "url_template", "side_effect", "operation", "effect_scope", "sandbox_policy"],
  ),
  async execute(args, ctx) {
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, summary: "工具名不能为空。" };
    const description = typeof args.description === "string" ? args.description.trim() : "";
    if (!description) return { ok: false, summary: `工具「${name}」的 description 必须是非空字符串。` };
    const method = typeof args.method === "string" ? args.method.trim().toUpperCase() : "";
    if (!new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).has(method)) {
      return { ok: false, summary: `工具「${name}」的 method 无效；只允许 GET/POST/PUT/PATCH/DELETE/HEAD。` };
    }
    const urlTemplate = typeof args.url_template === "string" ? args.url_template.trim() : "";
    if (!/^https?:\/\//i.test(urlTemplate)) return { ok: false, summary: `工具「${name}」的 url_template 必须是绝对 http(s) URL。` };
    const bodyTemplate = args.body_template === undefined
      ? undefined
      : typeof args.body_template === "string" && args.body_template.length > 0
        ? args.body_template
        : null;
    if (bodyTemplate === null) return { ok: false, summary: `工具「${name}」的 body_template 必须是非空字符串。` };
    // Collision guard: a created tool must NOT reuse a real global tool's name (the runtime would
    // resolve the global one and silently shadow this). An existing declarative
    // definition is intentionally editable; save() replaces it in the same scope.
    if ((ctx.realTools ?? []).some((t) => t.name === name && !t.declarativeDefinition)) {
      return { ok: false, summary: `「${name}」与内置全局工具同名，会被运行时遮蔽。换个带命名空间的名字（如 ${ctx.domain.toLowerCase().replace(/[^a-z0-9]+/g, "")}.${name}）再造。` };
    }
    const parsedCapabilities = parseToolCapabilities(args.capabilities);
    if (!parsedCapabilities.ok) return { ok: false, summary: `工具「${name}」的 capability 契约无效：${parsedCapabilities.error}。` };
    let headers: Record<string, string> | undefined;
    if (args.headers !== undefined) {
      if (!args.headers || typeof args.headers !== "object" || Array.isArray(args.headers)) return { ok: false, summary: `工具「${name}」的 headers 必须是字符串映射对象。` };
      const entries = Object.entries(args.headers as Record<string, unknown>);
      const invalid = entries.find(([header, value]) => !header.trim() || typeof value !== "string");
      if (invalid) return { ok: false, summary: `工具「${name}」的 header ${invalid[0] || "(empty)"} 必须有非空名称和字符串值。` };
      headers = Object.fromEntries(entries) as Record<string, string>;
    }
    const unsafeHeader = Object.entries(headers ?? {}).find(([header, value]) =>
      /authorization|api[-_]?key|token|secret|password/i.test(header) && !/\{[\w.]+\}/.test(String(value)),
    );
    if (unsafeHeader) {
      return { ok: false, summary: `工具「${name}」的敏感 header ${unsafeHeader[0]} 含字面值。请改为占位符（如 Bearer {api_key}）；secret 只能由运行配置注入，禁止进入工具定义/对话。` };
    }
    const literalSecretPath = findSensitiveInputPath({
      url_template: urlTemplate,
      headers,
      body_template: bodyTemplate,
    }, "tool");
    if (literalSecretPath) {
      return { ok: false, summary: `工具「${name}」的 ${literalSecretPath} 含字面凭证。请只保留 {config_key} 占位符，并通过已确认的 *_env profile 注入。` };
    }
    const contract = parseDeclarativeHttpContract({
      method,
      bodyTemplate,
      requestSpec: args.request_spec,
      responseSpec: args.response_spec,
      examples: args.examples,
    });
    if (!contract.ok) return { ok: false, summary: `工具「${name}」的 HTTP manifest 无效：${contract.error}。` };
    const sideEffectPolicy = validateDeclarativeToolPolicy({
      method,
      declaredSideEffect: args.side_effect,
      bodyTemplate,
      requestSpec: contract.requestSpec,
      capabilities: parsedCapabilities.capabilities,
    });
    if (!sideEffectPolicy.ok) {
      return { ok: false, summary: `工具「${name}」的副作用契约无效：${sideEffectPolicy.error}。` };
    }
    const executionPolicy = {
      operation: args.operation,
      effectScope: args.effect_scope,
      sandboxPolicy: args.sandbox_policy,
    };
    if (!isGeneratedToolExecutionPolicy(executionPolicy) || executionPolicy.effectScope !== "external") {
      return {
        ok: false,
        summary: `工具「${name}」必须明确填写合法的 operation、effect_scope=external 和 sandbox_policy；我不会从 side_effect、HTTP method 或名字推断。若文档不足，请先 ask_user 确认这个 API 是否会改变外部状态。`,
        output: { next: "ask_user", reason: "tool_execution_policy_missing" },
      };
    }
    const objectSchema = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
    if (args.params_schema !== undefined && !objectSchema(args.params_schema)) return { ok: false, summary: `工具「${name}」的 params_schema 必须是对象。` };
    if (args.returns_schema !== undefined && !objectSchema(args.returns_schema)) return { ok: false, summary: `工具「${name}」的 returns_schema 必须是对象。` };
    const tool: DeclarativeTool = {
      name,
      description,
      method,
      urlTemplate,
      headers,
      bodyTemplate,
      requestSpec: contract.requestSpec,
      responseSpec: contract.responseSpec,
      examples: contract.examples,
      sideEffect: sideEffectPolicy.sideEffect,
      ...executionPolicy,
      domain: ctx.domain,
      paramsSchema: objectSchema(args.params_schema) ? args.params_schema : undefined,
      returnsSchema: objectSchema(args.returns_schema) ? args.returns_schema : undefined,
      capabilities: parsedCapabilities.capabilities,
      probeStatus: "required" as const,
    };
    // ground design_agent against it immediately
    if (!ctx.toolCatalog.includes(name)) ctx.toolCatalog.push(name);
    let persistError: string | null = null;
    if (ctx.ports.tools) {
      try {
        await ctx.ports.tools.save(tool);
      } catch (e) {
        persistError = (e as Error).message || String(e);
      }
    }
    ctx.emit({ t: "tool.created", name, description: tool.description });
    if (persistError) {
      return {
        ok: false,
        summary: `工具「${name}」已加入本次运行的工具目录，但持久化入库失败：${persistError}。它不会在后续运行或生产重启后可用，请修复存储后重试。`,
        output: { name, inMemory: true, persisted: false, error: persistError },
      };
    }
    ctx.realTools = [...(ctx.realTools ?? []).filter((candidate) => candidate.name !== name), persistedToolAsRealTool(tool)];
    return {
      ok: true,
      summary: `已造工具「${name}」(${tool.method} · ${tool.sideEffect})${ctx.ports.tools ? "并入库" : "（本次运行内）"}；capabilities ${tool.capabilities?.length ?? 0} 条，状态 required。它已可被发现，但在 probe_tool 成功前不会被当成可执行 integration。`,
      output: { name, capabilities: tool.capabilities, probeStatus: tool.probeStatus, next: "probe_tool" },
    };
  },
};

const probe_tool: BrainTool = {
  name: "probe_tool",
  description:
    "对真实 global/声明式工具做受保护 live probe：执行真实 handler、校验返回 schema、生成脱敏 cassette，并把证据绑定到 definition+运行 config hash。config 只能传 *_env 的环境变量名，不能传 secret。执行授权只看明确的 sandboxPolicy；requires_attempt_grant 由 probe_tool 自己让服务端渲染固定问题并暂停。缺少策略时拒绝执行，不会从旧 sideEffect、HTTP method 或名字猜。模型不得搬运 token 或再调用 generic ask_user 拼授权；用户本人选择后，才可用完全相同参数带 allow_side_effects:true 重调。参数、定义、配置或执行 scope 任一变化都必须重新授权。",
  parameters: params(
    {
      name: { type: "string", description: "工具真名" },
      args: { type: "object", additionalProperties: true, description: "符合工具 params schema 的真实/安全 probe 输入；禁止放 API key/token/password" },
      tool_config: { type: "object", additionalProperties: true, description: "非 secret 运行配置；凭证只写 api_key_env 等字段，其值为服务器环境变量名" },
      allow_side_effects: { type: "boolean", description: "只有本工具自己的服务端确认门已收到用户本人选择后才可 true；不得用 generic ask_user 或模型自填代替" },
    },
    ["name", "args"],
  ),
  async execute(args, ctx) {
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, summary: "probe_tool 需要工具 name。" };
    if (!ctx.ports.tools?.probe) return { ok: false, summary: "当前运行未接入 live probe port，不能伪造探测结果；请通过 /v1/tools/:name/probe 或接线后重试。" };
    const realTool = (ctx.realTools ?? []).find((tool) => tool.name === name);
    if (!realTool) return { ok: false, summary: `真实工具目录里没有「${name}」——先 search_tools/create_tool。` };
    const executionPolicy = realToolExecutionPolicy(realTool);
    if (!executionPolicy) {
      return {
        ok: false,
        summary: `工具「${name}」还没有完整、可审核的 operation/effectScope/sandboxPolicy，本次不会发出 I/O。请先补齐工具策略；我不会从 sideEffect、HTTP method 或名字推断。`,
        output: { status: "needs_config", next: "ask_user", missing: ["tool_execution_policy"] },
      };
    }
    const rawArgs = args.args && typeof args.args === "object" && !Array.isArray(args.args) ? args.args as Record<string, unknown> : {};
    const sensitiveInputPath = findSensitiveProbeInputPath(rawArgs);
    if (sensitiveInputPath) return { ok: false, summary: `${sensitiveInputPath} 看起来是凭证字段，禁止进入对话/证据。请在服务器配置环境变量，并通过 tool_config 的 *_env 字段只引用变量名。` };
    const configEnvelope = args.tool_config === undefined ? undefined : { [name]: args.tool_config };
    const parsedConfig = parseToolConfigs(configEnvelope, [name], ctx.realTools ?? []);
    if (!parsedConfig.ok) return { ok: false, summary: `probe 配置无效：${parsedConfig.error}。` };
    const toolConfig = parsedConfig.configs[name] ?? {};
    const requiresAttemptGrant = executionPolicy.sandboxPolicy === "requires_attempt_grant";
    const writeCapable = requiresAttemptGrant;
    const execution = ctx.conversationId ? factoryExecutionScope(ctx.conversationId) : undefined;
    let probeArgs = rawArgs;
    if (writeCapable) {
      if (!isWriteCapableSideEffect(realTool.sideEffect)) {
        return {
          ok: false,
          summary: `工具「${name}」的 sandboxPolicy 要求一次性写授权，但旧的写探针安全契约未标记为 write/dual。请人工修正工具定义，本次不会发出 I/O。`,
          output: { status: "needs_config", next: "ask_user", missing: ["write_probe_safety_contract"] },
        };
      }
      const safety = inspectWriteProbeSafety(
        realTool.sideEffect,
        realTool.catalogDefinition?.probeSafety ?? realTool.declarativeDefinition?.probeSafety,
      );
      if (safety.status === "needs_config") {
        return {
          ok: false,
          summary: `工具「${name}」还缺完整的写探针安全配置，本次不会发出 I/O。${safety.question}`,
          output: safety,
        };
      }
      if (safety.status !== "ready") {
        return {
          ok: false,
          summary: `工具「${name}」的 sideEffect 与写探针安全契约不一致，本次不会发出 I/O。`,
          output: { status: "needs_config", next: "ask_user", missing: ["side_effect_class"] },
        };
      }
      if (!execution) {
        return {
          ok: false,
          summary: `工具「${name}」需要当前 run/conversation 才能生成隔离 canary；本次不会发出 I/O。`,
          output: { status: "needs_config", next: "ask_user", missing: ["execution_scope"] },
        };
      }
      const seedBinding = createProbeAuthorizationBinding(realTool, rawArgs, toolConfig, process.env, {
        domainId: ctx.domain,
        ...execution,
      });
      if (!seedBinding) return { ok: false, summary: `工具「${name}」无法为 canary probe 计算稳定 definition identity。` };
      const prepared = prepareWriteProbeCanary({
        args: rawArgs,
        contract: safety.contract,
        seed: writeProbeCanarySeed({
          definitionHash: seedBinding.definitionHash,
          domainId: ctx.domain,
          ...execution,
        }),
      });
      if (!prepared.ok) {
        return {
          ok: false,
          summary: `工具「${name}」的 canary 参数无法安全注入：${prepared.reason}。本次不会发出 I/O。`,
          output: { status: "needs_config", next: "ask_user", missing: ["canary_arguments"] },
        };
      }
      probeArgs = prepared.canary.args;
    }
    const authorizationBinding = requiresAttemptGrant
      ? createProbeAuthorizationBinding(realTool, probeArgs, toolConfig, process.env, {
          domainId: ctx.domain,
          ...execution,
        })
      : undefined;
    let authorizationReceipt: FactoryHumanAuthorizationReceipt | undefined;
    if (requiresAttemptGrant) {
      if (!authorizationBinding) {
        return { ok: false, summary: `工具「${name}」没有可计算的 declarative/catalog definition，无法把用户授权绑定到精确执行内容；先修复 registry 定义。` };
      }
      if (args.allow_side_effects !== true) {
        const question = `是否允许执行这一次「${name}」真实写入 probe？（请求摘要 ${authorizationBinding.digest.slice(0, 12)}）`;
        if (!execution || !ctx.ports.authorizationChallenges) {
          return { ok: false, summary: "当前运行没有可审计的 conversation 或耐久授权存储，不能询问后执行真实写 probe。" };
        }
        let challenge = pendingChallenge(ctx, "probe", authorizationBinding.digest);
        if (!challenge) {
          challenge = await ctx.ports.authorizationChallenges.issue(ctx.domain, {
            kind: "probe",
            subjectDigest: authorizationBinding.digest,
            ...execution,
            question,
            declineLabel: "先不执行",
            confirmLabel: "确认只执行这一次",
          });
        }
        parkAuthorizationChallenge(ctx, challenge);
        return {
          ok: true,
          summary: `「${name}」会写真实系统。我已经用服务端固定问题暂停并等待用户本人确认；确认选项不是推荐项，超时也不会自动执行。`,
          output: {
            authorizationRequired: true,
            definitionHash: authorizationBinding.definitionHash,
            sideEffectSummary: authorizationBinding.sideEffectSummary,
          },
        };
      }
      if ((ctx.consumedProbeAuthorizationDigests ?? []).includes(authorizationBinding.digest)) {
        return { ok: false, summary: `这份真实 probe 授权已经使用过，不能重放。请按当前参数重新向用户确认。` };
      }
      const challenge = pendingChallenge(ctx, "probe", authorizationBinding.digest);
      if (!challenge) return { ok: false, summary: `没有找到与本次工具、参数、definition/config、run/conversation 完全一致的服务端 challenge；allow_side_effects 不能由模型自行断言。` };
      try {
        // Durable atomic consumption is intentionally the final operation
        // immediately before the external I/O port call below.
        authorizationReceipt = await consumeChallenge(ctx, challenge);
      } catch (error) {
        return { ok: false, summary: `这次真实 probe 没有获得可用的一次性人工授权：${String((error as Error).message ?? error).slice(0, 220)}。` };
      }
    }
    let result: Awaited<ReturnType<NonNullable<typeof ctx.ports.tools.probe>>>;
    try {
      result = await ctx.ports.tools.probe({
        domain: ctx.domain,
        name,
        args: probeArgs,
        config: toolConfig,
        actor: requiresAttemptGrant ? undefined : (ctx.conversationId ? `factory-profile:${ctx.conversationId}` : "agent-factory-profile"),
        authorization: authorizationReceipt,
        execution,
        expectedDefinitionHash: authorizationBinding?.definitionHash,
      });
    } catch (error) {
      return { ok: false, summary: `工具「${name}」probe 基础设施失败：${String((error as Error).message ?? error).slice(0, 240)}` };
    }
    if (authorizationBinding && authorizationReceipt) {
      (ctx.consumedProbeAuthorizationDigests ??= []).push(authorizationBinding.digest);
      ctx.consumedProbeAuthorizationDigests = ctx.consumedProbeAuthorizationDigests.slice(-200);
    }
    // Reload both catalogs so a successful receipt becomes immediately usable
    // by design_agent in this same conversation.
    const [globals, persisted] = await Promise.all([
      ctx.ports.toolRegistry?.list() ?? Promise.resolve([]),
      ctx.ports.tools.list(ctx.domain),
    ]);
    ctx.realTools = [
      ...globals,
      ...persisted.filter((tool) => !globals.some((global) => global.name === tool.name)).map(persistedToolAsRealTool),
    ];
    return {
      ok: result.verified,
      summary: result.verified
        ? `✅ 工具「${name}」live probe 通过：schema 合法${writeCapable ? "，canary 已清理并读回确认不存在" : ""}，definition/config hash=${result.definitionHash.slice(0, 12)}…，已保存脱敏 cassette；现在可重新 design_agent。`
        : result.next === "ask_user"
          ? `工具「${name}」还不能安全执行真实 probe，本次没有发出 I/O。请补齐：${(result.missing ?? []).join("、") || result.error || "写探针配置"}。`
          : `❌ 工具「${name}」probe 未通过：${result.classification}${result.status ? ` HTTP ${result.status}` : ""}${result.error ? ` · ${result.error.slice(0, 180)}` : ""}。证据状态已记为 failed，修契约/配置后重探。`,
      output: result,
    };
  },
};

function bindCommittedSandboxEvidencePlan(
  ctx: BrainCtx,
  receipt: SandboxEvidencePlanReceipt,
  realTools: RealTool[],
): { profilesBound: number; specsUpdated: number } {
  if (!ctx.ontology || !ctx.generationDirective) {
    throw new Error(
      "cannot bind sandbox evidence without the server-locked generation scope",
    );
  }
  const allowedActions = new Set(generationScopedAgentActionNames(ctx));
  const stagedSpecs = ctx.specs.map((spec) => ({
    ...spec,
    sandboxToolProfileRefs: {
      ...(spec.sandboxToolProfileRefs ?? {}),
    },
    sandboxToolConfigs: {
      ...(spec.sandboxToolConfigs ?? {}),
    },
  }));
  const updatedSpecIndexes = new Set<number>();
  let profilesBound = 0;

  const expectedProfiles = receipt.bindings.filter((binding) =>
    Boolean(binding.profileKey),
  );
  if (receipt.profiles.length !== expectedProfiles.length) {
    throw new Error(
      "sandbox evidence receipt profile count does not match its prepared bindings",
    );
  }

  for (const binding of receipt.bindings) {
    for (const use of binding.uses) {
      if (!allowedActions.has(use.actionName)) {
        throw new Error(
          `sandbox evidence receipt expanded outside generation scope: ${use.actionName}`,
        );
      }
      const action = ctx.ontology.actions.find(
        (candidate) => candidate.name === use.actionName,
      );
      if (!action || !action.actor.includes("Agent")) {
        throw new Error(
          `sandbox evidence receipt references a non-Agent Action: ${use.actionName}`,
        );
      }
      const spec = stagedSpecs.find(
        (candidate) => candidate.actionName === use.actionName,
      );
      if (!spec || !spec.tools.includes(binding.toolName)) {
        throw new Error(
          `sandbox evidence receipt no longer matches spec ${use.actionName}/${binding.toolName}`,
        );
      }
    }

    if (!binding.profileKey) continue;
    const committedProfiles = receipt.profiles.filter(
      (profile) =>
        profile.toolName === binding.toolName
        && profile.profileKey === binding.profileKey
        && profile.configHash === binding.configHash
        && profile.environment === "sandbox",
    );
    if (committedProfiles.length !== 1) {
      throw new Error(
        `sandbox evidence receipt does not identify exactly one committed profile for ${binding.toolName}/${binding.profileKey}`,
      );
    }
    const tool = realTools.find((candidate) =>
      candidate.name === binding.toolName,
    );
    if (!tool) {
      throw new Error(
        `committed sandbox tool ${binding.toolName} is missing from the refreshed registry`,
      );
    }
    const matchingProfiles = (tool.integrationProfiles ?? []).filter(
      (profile) =>
        profile.toolName === binding.toolName
        && profile.profileKey === binding.profileKey
        && profile.environment === "sandbox"
        && integrationProfileConfigDigest(profile.config) ===
          binding.configHash,
    );
    if (matchingProfiles.length !== 1) {
      throw new Error(
        `committed sandbox profile ${binding.toolName}/${binding.profileKey} is missing or ambiguous after refresh`,
      );
    }
    const profile = matchingProfiles[0]!;

    for (const use of binding.uses) {
      const specIndex = stagedSpecs.findIndex(
        (candidate) => candidate.actionName === use.actionName,
      );
      const spec = stagedSpecs[specIndex]!;
      spec.sandboxToolProfileRefs = {
        ...(spec.sandboxToolProfileRefs ?? {}),
        [binding.toolName]: profile.id,
      };
      spec.sandboxToolConfigs = {
        ...(spec.sandboxToolConfigs ?? {}),
        [binding.toolName]: structuredClone(profile.config),
      };
      const profileValidation = validateGeneratedSpecIntegrationProfiles({
        specs: [{
          ...spec,
          tools: [binding.toolName],
        }],
        tools: realTools,
        scope: {
          tenantId: ctx.ports?.factoryScope?.tenantId,
          tenantSlug: ctx.ports?.factoryScope?.tenantSlug,
          domainId: ctx.domain,
        },
        environments: ["sandbox"],
      });
      if (!profileValidation.ok) {
        throw new Error(
          profileValidation.issues
            .slice(0, 4)
            .map((issue) => issue.message)
            .join("；"),
        );
      }
      updatedSpecIndexes.add(specIndex);
      profilesBound += 1;
    }
  }

  // Apply only after every receipt binding, scope and current profile has
  // passed revalidation. Any stale sandbox/design evidence referred to the old
  // immutable spec fingerprint and must not survive this configuration change.
  ctx.specs = stagedSpecs;
  ctx.lastSandbox = null;
  ctx.sandboxDesignReview = undefined;
  return {
    profilesBound,
    specsUpdated: updatedSpecIndexes.size,
  };
}

/** Prepare every missing sandbox profile and replay cassette behind one exact
 * human confirmation. This is the preferred minimal-interaction path: the API
 * independently resolves all real definitions and commits the ready state as
 * one transaction without invoking a handler or contacting an external host. */
const prepare_sandbox_evidence_plan: BrainTool = {
  name: "prepare_sandbox_evidence_plan",
  description:
    "为一组真实工具一次性准备 sandbox profile + signed replay fixture。第一次调用会由服务端校验所有真实 definition/schema、非 secret config、Action scope 和 exact exchanges，再只提出一个固定确认问题；用户本人确认后，用完全相同参数带 confirmed:true 重调，整包原子落库。它绝不调用真实 handler/外部系统，所有证据 sandboxOnly=true、promotionAllowed=false，任何内容变化都会使确认失效。优先使用本工具，不要逐个调用 confirm_integration_profile/create_signed_fixture。",
  parameters: params(
    {
      bindings: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            tool_name: { type: "string", description: "真实 registry 工具名" },
            profile_key: { type: "string", description: "需要非 secret config 时的 sandbox profile key" },
            config: { type: "object", additionalProperties: true, description: "非 secret config；凭证只能用 *_env 引用服务器环境变量名" },
            uses: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  action_name: { type: "string" },
                  required_objects: { type: "array", items: { type: "string" } },
                },
                required: ["action_name"],
                additionalProperties: false,
              },
            },
            exchanges: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: {
                type: "object",
                properties: {
                  args: { type: "object", additionalProperties: true },
                  status: { type: "number" },
                  body: {},
                  headers: { type: "object", additionalProperties: { type: "string" } },
                },
                required: ["args", "status", "body"],
                additionalProperties: false,
              },
            },
          },
          required: ["tool_name", "uses", "exchanges"],
          additionalProperties: false,
        },
      },
      ttl_hours: { type: "number", description: "整包有效期小时数，默认 24，范围 1-168" },
      confirmed: { type: "boolean", description: "只有本工具自己的服务端确认门收到用户本人选择后才可 true" },
    },
    ["bindings"],
  ),
  async execute(args, ctx) {
    if (!ctx.ports.sandboxEvidencePlans || !ctx.ports.authorizationChallenges || !ctx.conversationId) {
      return { ok: false, summary: "当前运行没有接入 sandbox evidence plan 的服务端准备、原子提交或耐久确认端口。" };
    }
    if (!Array.isArray(args.bindings) || args.bindings.length < 1 || args.bindings.length > 50) {
      return { ok: false, summary: "bindings 需要 1-50 项，每项都要指定真实 tool、Action use 和 exact exchanges。" };
    }
    const bindings: SandboxEvidencePlanBindingRequest[] = [];
    for (const [index, raw] of args.bindings.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, summary: `binding ${index + 1} 不是对象。` };
      }
      const item = raw as Record<string, unknown>;
      const toolName = String(item.tool_name ?? "").trim();
      const uses = Array.isArray(item.uses) ? item.uses.map((use) => {
        const row = use && typeof use === "object" && !Array.isArray(use)
          ? use as Record<string, unknown>
          : {};
        return {
          actionName: String(row.action_name ?? "").trim(),
          ...(Array.isArray(row.required_objects)
            ? { requiredObjects: row.required_objects.map(String) }
            : {}),
        };
      }) : [];
      if (!toolName || uses.some((use) => !use.actionName)) {
        return { ok: false, summary: `binding ${index + 1} 缺少真实 tool_name 或 action_name。` };
      }
      const exchanges = Array.isArray(item.exchanges)
        ? item.exchanges as FactorySignedFixtureExchange[]
        : [];
      if (exchanges.length < 1 || exchanges.length > 50) {
        return { ok: false, summary: `binding ${toolName} 需要 1-50 条 exact exchanges。` };
      }
      const config = item.config && typeof item.config === "object" && !Array.isArray(item.config)
        ? item.config as Record<string, unknown>
        : {};
      const sensitivePath = findSensitiveInputPath(
        { config, exchanges },
        `prepare_sandbox_evidence_plan.bindings[${index}]`,
      );
      if (sensitivePath) {
        return { ok: false, summary: `${sensitivePath} 看起来包含字面凭证。请移除；这里只允许非 secret 配置和脱敏 fixture。` };
      }
      bindings.push({
        toolName,
        ...(typeof item.profile_key === "string" && item.profile_key.trim()
          ? { profileKey: item.profile_key.trim() }
          : {}),
        config,
        uses,
        exchanges,
      });
    }
    const totalExchanges = bindings.reduce((sum, binding) => sum + binding.exchanges.length, 0);
    if (totalExchanges > 200 || stableJson(bindings).length > 512_000) {
      return { ok: false, summary: "整包最多 200 条 exchange 且规范化内容不超过 512 KB；请缩小到本次最小 Action/tool 范围。" };
    }
    if (!ctx.ontology || !ctx.generationDirective) {
      return { ok: false, summary: "还没有服务端锁定的 Ontology Action 范围；请先 read_ontology/完成场景分析，不能凭工具参数扩大范围。" };
    }
    const allowedActions = new Set(ctx.generationDirective.requestedActionNames);
    for (const binding of bindings) {
      for (const use of binding.uses) {
        if (!allowedActions.has(use.actionName)) {
          return { ok: false, summary: `Action「${use.actionName}」不在本次服务端锁定范围内；整包确认不能扩大 generation scope。` };
        }
        const action = ctx.ontology.actions.find((candidate) => candidate.name === use.actionName);
        if (!action || !action.actor.includes("Agent")) {
          return { ok: false, summary: `Action「${use.actionName}」不是当前 authoritative/virtual scope 中的 Agent Action。` };
        }
        const authoritativeObjects = [...new Set(action.target_objects ?? [])].sort();
        const requestedObjects = [...new Set(use.requiredObjects ?? [])].sort();
        if (
          requestedObjects.length > 0
          && stableJson(requestedObjects) !== stableJson(authoritativeObjects)
        ) {
          return { ok: false, summary: `Action「${use.actionName}」的 required_objects 与 authoritative target_objects 不一致；不能用模型自报范围签 profile。` };
        }
        use.requiredObjects = authoritativeObjects;
        const spec = ctx.specs.find((candidate) => candidate.actionName === use.actionName);
        if (!spec || !spec.tools.includes(binding.toolName)) {
          return { ok: false, summary: `真实绑定「${binding.toolName} → ${use.actionName}」与当前生成 spec 的 tools 不一致；请先重新 design_agent，不能靠 evidence plan 注入新工具。` };
        }
      }
    }
    const ttlHours = args.ttl_hours === undefined ? 24 : Number(args.ttl_hours);
    if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 168) {
      return { ok: false, summary: "ttl_hours 必须是 1-168 的整数。" };
    }
    const proposalKey = createHash("sha256").update(stableJson({
      protocol: "agent-factory-sandbox-evidence-plan-brain/v1",
      domain: ctx.domain,
      conversationId: ctx.conversationId,
      bindings,
      ttlHours,
    })).digest("hex");
    let parked = ctx.pendingSandboxEvidencePlanProposals?.[proposalKey];
    if (parked && Date.parse(parked.preparation.expiresAt) <= Date.now()) {
      delete ctx.pendingSandboxEvidencePlanProposals?.[proposalKey];
      parked = undefined;
    }
    if (!parked) {
      if (args.confirmed === true) {
        return { ok: false, summary: "没有与当前整包内容完全一致的待确认 plan。confirmed 不能由模型自行填写；请先创建服务端确认。" };
      }
      const recordedAt = new Date().toISOString();
      const request = {
        domain: ctx.domain,
        bindings,
        recordedAt,
        expiresAt: new Date(Date.parse(recordedAt) + ttlHours * 60 * 60_000).toISOString(),
        execution: factoryExecutionScope(ctx.conversationId),
      };
      try {
        const preparation = await ctx.ports.sandboxEvidencePlans.prepare(request);
        parked = { request, preparation };
        (ctx.pendingSandboxEvidencePlanProposals ??= {})[proposalKey] = parked;
      } catch (error) {
        return { ok: false, summary: `sandbox evidence plan 校验失败：${String((error as Error).message ?? error).slice(0, 500)}。没有创建 profile、fixture，也没有执行外部 I/O。` };
      }
    }
    const { preparation } = parked;
    if (args.confirmed !== true) {
      const question = `是否一次性确认这份 sandbox-only evidence plan？共 ${preparation.bindings.length} 个真实工具绑定：${preparation.bindings.map((binding) => `${binding.toolName}${binding.profileKey ? `/${binding.profileKey}` : ""}`).join("、")}。内容摘要 ${preparation.subjectDigest.slice(0, 12)}，到期 ${preparation.expiresAt}。确认后只会原子保存 sandbox profile 与签名回放 fixture，不会访问外部系统，也不能用于 production promotion。`;
      let challenge = pendingChallenge(ctx, "sandbox_evidence_plan", preparation.subjectDigest);
      if (!challenge) {
        challenge = await ctx.ports.authorizationChallenges.issue(ctx.domain, {
          kind: "sandbox_evidence_plan",
          subjectDigest: preparation.subjectDigest,
          ...factoryExecutionScope(ctx.conversationId),
          question,
          declineLabel: "先不创建",
          confirmLabel: "确认整包仅用于沙箱",
        });
      }
      parkAuthorizationChallenge(ctx, challenge);
      return {
        ok: true,
        summary: "整包 definition/config/Action scope/exchanges 已由服务端校验，只等待一次人工确认。未确认、超时或任一内容变化都不会落库。",
        output: {
          authorizationRequired: true,
          subjectDigest: preparation.subjectDigest,
          bindings: preparation.bindings.map((binding) => ({
            toolName: binding.toolName,
            profileKey: binding.profileKey,
            definitionHash: binding.definitionHash,
            schemaHash: binding.schemaHash,
            configHash: binding.configHash,
            uses: binding.uses.map((use) => use.actionName),
            exchangeCount: binding.review.length,
          })),
          expiresAt: preparation.expiresAt,
          sandboxOnly: true,
          promotionAllowed: false,
        },
      };
    }
    const challenge = pendingChallenge(ctx, "sandbox_evidence_plan", preparation.subjectDigest);
    if (!challenge) {
      return { ok: false, summary: "没有与当前整包内容、run/conversation 和到期时间完全一致的服务端 challenge。" };
    }
    let authorization: FactoryHumanAuthorizationReceipt;
    try {
      authorization = await consumeChallenge(ctx, challenge);
    } catch (error) {
      return { ok: false, summary: `整包没有获得可用的一次性人工确认：${String((error as Error).message ?? error).slice(0, 300)}。` };
    }
    try {
      const receipt = await ctx.ports.sandboxEvidencePlans.commit({
        ...parked.request,
        expectedSubjectDigest: preparation.subjectDigest,
        authorization,
      });
      if (
        receipt.status !== "ready"
        || receipt.subjectDigest !== preparation.subjectDigest
        || stableJson(receipt.bindings) !== stableJson(preparation.bindings)
      ) {
        throw new Error(
          "committed receipt does not match the exact prepared evidence plan",
        );
      }
      const [globals, persisted] = await Promise.all([
        ctx.ports.toolRegistry?.list() ?? Promise.resolve([]),
        ctx.ports.tools?.list(ctx.domain) ?? Promise.resolve([]),
      ]);
      ctx.realTools = [
        ...globals,
        ...persisted.filter((tool) => !globals.some((global) => global.name === tool.name)).map(persistedToolAsRealTool),
      ];
      const bindingResult = bindCommittedSandboxEvidencePlan(
        ctx,
        receipt,
        ctx.realTools,
      );
      delete ctx.pendingSandboxEvidencePlanProposals?.[proposalKey];
      return {
        ok: true,
        summary: `已由「${receipt.confirmedBy}」一次确认并原子保存 ${receipt.profiles.length} 个 sandbox profile、${receipt.fixtures.length} 份独立可审计 fixture；已把 ${bindingResult.profilesBound} 个精确 profile/config 绑定回 ${bindingResult.specsUpdated} 个现有 Agent。现在可直接重新检查 readiness 并运行沙箱，无需重新 design_agent；这些证据仍不能用于 production promotion。`,
        output: {
          schema: receipt.schema,
          status: receipt.status,
          subjectDigest: receipt.subjectDigest,
          confirmedBy: receipt.confirmedBy,
          expiresAt: receipt.expiresAt,
          sandboxOnly: true,
          promotionAllowed: false,
          profileCount: receipt.profiles.length,
          fixtureCount: receipt.fixtures.length,
          profilesBound: bindingResult.profilesBound,
          specsUpdated: bindingResult.specsUpdated,
          bindings: receipt.bindings.map((binding) => ({
            toolName: binding.toolName,
            profileKey: binding.profileKey,
            definitionHash: binding.definitionHash,
            schemaHash: binding.schemaHash,
            configHash: binding.configHash,
            uses: binding.uses.map((use) => use.actionName),
            exchangeCount: binding.review.length,
          })),
        },
      };
    } catch (error) {
      delete ctx.pendingSandboxEvidencePlanProposals?.[proposalKey];
      return {
        ok: false,
        summary: `确认已一次性消费，但整包没有进入 ready 或当前 run 的精确 profile 回绑没有完成：${String((error as Error).message ?? error).slice(0, 400)}。事务内不会留下部分 ready 状态；若服务端已返回 ready 但资源刷新失败，已提交证据仍保留审计记录，恢复资源后重新检查 readiness。`,
      };
    }
  },
};

/** Sandbox-only escape hatch for an integration that cannot be probed yet.
 * The expected exchanges are not evidence that the vendor works: they are a
 * human-approved simulation cassette, cryptographically scoped by the API and
 * deliberately excluded from production promotion. */
const create_signed_fixture: BrainTool = {
  name: "create_signed_fixture",
  description:
    "外部平台暂时不可用、但用户希望先验证业务编排时，为一个真实 global、tenant-native 或声明式工具创建【仅限 sandbox 回放】的 signed-fixture。第一次调用会校验工具/config/输入输出契约，把 exact entries、definition、config 和 expiry 交给服务端形成一次性确认题并暂停；模型不能自行确认，也不能搬运 token。用户本人确认后，才可用完全相同参数带 confirmed:true 重调。signed-fixture 永远不能当 live probe，也不能通过 promotion。",
  parameters: params(
    {
      name: { type: "string", description: "真实 registry 工具名" },
      exchanges: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        description: "用户将要确认的精确模拟交换；禁止放任何字面 secret。2xx body 必须符合工具返回 schema。",
        items: {
          type: "object",
          properties: {
            args: { type: "object", additionalProperties: true, description: "一次工具调用参数" },
            status: { type: "number", description: "模拟 HTTP 状态码（100-599）" },
            body: { description: "模拟返回体；敏感字段只能写 [REDACTED]" },
            headers: { type: "object", additionalProperties: { type: "string" }, description: "可选的脱敏响应头" },
          },
          required: ["args", "status", "body"],
          additionalProperties: false,
        },
      },
      tool_config: { type: "object", additionalProperties: true, description: "非 secret 运行配置；凭证只能通过 *_env 字段引用服务器环境变量名" },
      ttl_hours: { type: "number", description: "fixture 有效小时数，默认 24，范围 1-168；确认题会显示精确到期时间" },
      confirmed: { type: "boolean", description: "只有本工具自己的服务端确认门收到用户本人选择后才可 true；模型不得自行填写" },
    },
    ["name", "exchanges"],
  ),
  async execute(args, ctx) {
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, summary: "请告诉我具体要为哪个真实工具准备 sandbox fixture。" };
    if (!ctx.ports.tools?.prepareSignedFixture || !ctx.ports.tools.createSignedFixture) {
      return { ok: false, summary: "当前 Agent Factory 没接入 signed-fixture 的签发和持久化端口，不能把普通 JSON 冒充成可信 sandbox 证据。" };
    }
    if (!ctx.conversationId || !ctx.ports.authorizationChallenges) {
      return { ok: false, summary: "当前运行没有可审计的 conversation 或耐久一次性确认存储，不能签发 sandbox fixture。" };
    }
    let resources: CurrentExecutionResources;
    try {
      resources = await currentExecutionResources(ctx);
    } catch {
      return executionResourcesUnavailable(`工具「${name}」的 sandbox fixture`);
    }
    ctx.realTools = resources.realTools;
    const realTool = resources.realTools.find((tool) => tool.name === name);
    if (!realTool) return { ok: false, summary: `真实工具目录里没有「${name}」；请先 search_tools，不要猜工具名。` };
    const executionPolicy = realToolExecutionPolicy(realTool);
    if (!executionPolicy || executionPolicy.effectScope !== "external") {
      return {
        ok: false,
        summary: `「${name}」没有明确声明 external execution policy。signed-fixture 只用于尚未就绪的外部平台，不会从名字、HTTP method 或 sideEffect 猜。`,
      };
    }
    if (!Array.isArray(args.exchanges) || args.exchanges.length < 1 || args.exchanges.length > 12) {
      return { ok: false, summary: "exchanges 需要 1-12 条；每条都要给 args、status 和脱敏 body。" };
    }
    const exchanges = args.exchanges as FactorySignedFixtureExchange[];
    const sensitivePath = findSensitiveInputPath(
      { exchanges, tool_config: args.tool_config },
      "create_signed_fixture",
    );
    if (sensitivePath) {
      return { ok: false, summary: `${sensitivePath} 看起来包含字面凭证。请删除它；凭证只能放服务器环境变量，fixture 里敏感返回字段写 [REDACTED]。` };
    }
    const configEnvelope = args.tool_config === undefined ? undefined : { [name]: args.tool_config };
    const parsedConfig = parseToolConfigs(configEnvelope, [name], resources.realTools);
    if (!parsedConfig.ok) return { ok: false, summary: `signed-fixture 配置无效：${parsedConfig.error}。` };
    const ttlHours = args.ttl_hours === undefined ? 24 : Number(args.ttl_hours);
    if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 168) {
      return { ok: false, summary: "ttl_hours 必须是 1-168 的整数；建议先用 24 小时，过期后按当前契约重新确认。" };
    }
    const proposalKey = createHash("sha256").update(stableJson({
      protocol: "agent-factory-signed-fixture-brain-proposal/v1",
      domain: ctx.domain,
      conversationId: ctx.conversationId,
      name,
      config: parsedConfig.configs[name] ?? {},
      exchanges,
      ttlHours,
    })).digest("hex");
    let parked = ctx.pendingSignedFixtureProposals?.[proposalKey];
    if (parked && (
      !Number.isFinite(Date.parse(parked.preparation.expiresAt))
      || Date.parse(parked.preparation.expiresAt) <= Date.now()
    )) {
      delete ctx.pendingSignedFixtureProposals?.[proposalKey];
      for (const [context, challenge] of Object.entries(ctx.pendingAuthorizationChallenges ?? {})) {
        if (challenge.kind === "probe" && challenge.subjectDigest === parked.preparation.subjectDigest) {
          delete ctx.pendingAuthorizationChallenges?.[context];
        }
      }
      parked = undefined;
    }
    if (!parked) {
      if (args.confirmed === true) {
        return { ok: false, summary: "没有找到与当前工具、config、entries、TTL 完全一致的待确认提案。confirmed 不能由模型自行填写；请先不带 confirmed 发起服务端确认。" };
      }
      const recordedAt = new Date().toISOString();
      const request = {
        domain: ctx.domain,
        name,
        config: parsedConfig.configs[name] ?? {},
        exchanges,
        recordedAt,
        expiresAt: new Date(Date.parse(recordedAt) + ttlHours * 60 * 60_000).toISOString(),
      };
      let preparation;
      try {
        preparation = await ctx.ports.tools.prepareSignedFixture(request);
      } catch (error) {
        return { ok: false, summary: `这份 sandbox fixture 还不能交给用户确认：${String((error as Error).message ?? error).slice(0, 400)}。我不会绕过真实工具契约。` };
      }
      parked = { request, preparation };
      (ctx.pendingSignedFixtureProposals ??= {})[proposalKey] = parked;
    }
    const { preparation } = parked;
    if (args.confirmed !== true) {
      const review = preparation.review.map((line) => line.slice(0, 150)).join("；");
      const question = `外部平台现在还不能实探。是否确认把「${name}」的这 ${exchanges.length} 条预期交换签成仅供 sandbox 回放的 fixture？${review}。到期时间 ${preparation.expiresAt}，精确内容摘要 ${preparation.subjectDigest.slice(0, 12)}。它不能证明平台可用，也不能用于 promotion。`;
      let challenge = pendingChallenge(ctx, "probe", preparation.subjectDigest);
      if (!challenge) {
        challenge = await ctx.ports.authorizationChallenges.issue(ctx.domain, {
          kind: "probe",
          subjectDigest: preparation.subjectDigest,
          ...factoryExecutionScope(ctx.conversationId),
          question,
          declineLabel: "先不创建",
          confirmLabel: "确认仅用于沙箱回放",
        });
      }
      parkAuthorizationChallenge(ctx, challenge);
      return {
        ok: true,
        summary: "我已经校验真实工具定义、配置和这些预期输入输出，并用服务端固定问题暂停等待用户本人确认。确认不是推荐项；未确认、超时或内容变化都不会签发。",
        output: {
          authorizationRequired: true,
          evidenceMode: "signed-fixture",
          sandboxOnly: true,
          promotionAllowed: false,
          definitionHash: preparation.definitionHash,
          configHash: preparation.configHash,
          subjectDigest: preparation.subjectDigest,
          expiresAt: preparation.expiresAt,
          review: preparation.review,
        },
      };
    }
    if ((ctx.consumedProbeAuthorizationDigests ?? []).includes(preparation.subjectDigest)) {
      return { ok: false, summary: "这份 signed-fixture 确认已经使用过，不能重放；要修改或续期，请按当前内容重新让用户确认。" };
    }
    const challenge = pendingChallenge(ctx, "probe", preparation.subjectDigest);
    if (!challenge) {
      return { ok: false, summary: "没有找到与当前 tenant/domain/tool/definition/config/entries/expiry 完全一致的服务端 challenge。confirmed 不能由模型自行断言。" };
    }
    let authorizationReceipt: FactoryHumanAuthorizationReceipt;
    try {
      authorizationReceipt = await consumeChallenge(ctx, challenge);
      (ctx.consumedProbeAuthorizationDigests ??= []).push(preparation.subjectDigest);
      ctx.consumedProbeAuthorizationDigests = ctx.consumedProbeAuthorizationDigests.slice(-200);
    } catch (error) {
      return { ok: false, summary: `这份 sandbox fixture 没有获得可用的一次性人工确认：${String((error as Error).message ?? error).slice(0, 260)}。` };
    }
    try {
      const receipt = await ctx.ports.tools.createSignedFixture({
        ...parked.request,
        expectedDefinitionHash: preparation.definitionHash,
        expectedSubjectDigest: preparation.subjectDigest,
        authorization: authorizationReceipt,
        execution: factoryExecutionScope(ctx.conversationId),
      });
      delete ctx.pendingSignedFixtureProposals?.[proposalKey];
      const [globals, persisted] = await Promise.all([
        ctx.ports.toolRegistry?.list() ?? Promise.resolve([]),
        ctx.ports.tools.list(ctx.domain),
      ]);
      ctx.realTools = [
        ...globals,
        ...persisted.filter((tool) => !globals.some((global) => global.name === tool.name)).map(persistedToolAsRealTool),
      ];
      return {
        ok: true,
        summary: `已由「${receipt.confirmedBy}」确认并签发「${name}」的 sandbox-only fixture，有效至 ${receipt.expiresAt}。现在可用于 sandbox 回放，跑通后可保存为待审查草稿；promotion 仍会硬拒绝，平台就绪后必须重新跑 live probe。`,
        output: receipt,
      };
    } catch (error) {
      delete ctx.pendingSignedFixtureProposals?.[proposalKey];
      return {
        ok: false,
        summary: `人工确认已一次性消费，但 fixture 没有落库：${String((error as Error).message ?? error).slice(0, 320)}。可能是工具定义或配置在确认后变化；请按当前内容重新发起确认，不能复用旧确认。`,
      };
    }
  },
};

const INTEGRATION_PROFILE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function pendingChallenge(
  ctx: BrainCtx,
  kind: FactoryAuthorizationChallenge["kind"],
  subjectDigest: string,
): FactoryAuthorizationChallenge | undefined {
  for (const [context, challenge] of Object.entries(ctx.pendingAuthorizationChallenges ?? {})) {
    if (
      challenge.kind !== kind
      || challenge.subjectDigest !== subjectDigest
      || challenge.conversationId !== ctx.conversationId
      || challenge.runId !== ctx.conversationId
    ) continue;
    if (!Number.isFinite(Date.parse(challenge.expiresAt)) || Date.parse(challenge.expiresAt) <= Date.now()) {
      // Expiry never selects a branch. Drop the stale server capability so a
      // later non-confirming call can issue a fresh fixed challenge.
      delete ctx.pendingAuthorizationChallenges?.[context];
      continue;
    }
    return challenge;
  }
  return undefined;
}

function parkAuthorizationChallenge(ctx: BrainCtx, challenge: FactoryAuthorizationChallenge): void {
  (ctx.pendingAuthorizationChallenges ??= {})[challenge.context] = challenge;
  (ctx.askedQuestions ??= {})[normalizeQuestion(challenge.question)] = "";
  ctx.clarifyPrompt = {
    question: challenge.question,
    options: challenge.options,
    context: challenge.context,
  };
  ctx.awaitingClarify = true;
  ctx.emit({
    t: "clarify",
    question: challenge.question,
    options: challenge.options,
    context: challenge.context,
    awaitingAnswer: true,
  });
}

function exactChallengeAnswer(
  ctx: BrainCtx,
  challenge: FactoryAuthorizationChallenge,
): {
  answer: string;
  actor: string;
  question: string;
  context: string;
  options: FactoryAuthorizationChallenge["options"];
} | null {
  const evidence = ctx.clarificationAnswerEvidence?.[normalizeQuestion(challenge.question)];
  if (
    !evidence
    || evidence.question !== challenge.question
    || evidence.context !== challenge.context
    || JSON.stringify(evidence.options ?? []) !== JSON.stringify(challenge.options)
    || evidence.answer !== challenge.token
    || !evidence.actor?.trim()
  ) return null;
  return {
    answer: evidence.answer,
    actor: evidence.actor.trim(),
    question: evidence.question,
    context: evidence.context,
    options: challenge.options,
  };
}

async function consumeChallenge(
  ctx: BrainCtx,
  challenge: FactoryAuthorizationChallenge,
): Promise<FactoryHumanAuthorizationReceipt> {
  if (!ctx.ports.authorizationChallenges) {
    throw new Error("当前工厂没有接入耐久的一次性授权存储，不能执行确认后的 I/O");
  }
  const evidence = exactChallengeAnswer(ctx, challenge);
  if (!evidence) {
    throw new Error("没有找到与服务端问题、context、token 和认证回答者完全一致的人工确认");
  }
  const receipt = await ctx.ports.authorizationChallenges.consume(ctx.domain, {
    challenge,
    ...evidence,
  });
  delete ctx.pendingAuthorizationChallenges?.[challenge.context];
  return receipt;
}

function integrationProfileReviewLines(config: Record<string, unknown>): string[] {
  return Object.entries(config).slice(0, 40).map(([key, value]) => {
    if (/_env$/i.test(key) && typeof value === "string") {
      return `${key}：使用服务器环境变量「${value}」（这里只保存变量名，不显示也不保存变量值）`;
    }
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    return `${key}：${String(rendered ?? "").slice(0, 240)}`;
  });
}

/** Human-confirm a non-secret integration profile before design_agent may use
 * it. Authorization is exact and one-shot, mirroring guarded write probes. */
const confirm_integration_profile: BrainTool = {
  name: "confirm_integration_profile",
  description:
    "为真实工具提议并保存一套明确属于 sandbox 或 production 的 tenant/domain integration profile。两套环境不能借用彼此的 endpoint、credential 或 namespace。第一次调用只做确定性校验和安全展示，然后由本工具让服务端渲染固定问题并暂停；模型不得搬运 token 或再调用 generic ask_user 拼授权。只有用户本人明确选择后，才能用完全相同参数并带 confirmed:true 重调保存。模型不能自行确认，environment、参数或执行 scope 变化都必须重新问人。",
  parameters: params(
    {
      tool_name: { type: "string", description: "真实 registry 工具名" },
      profile_key: { type: "string", description: "这套配置的人类可读短标识，如 primary 或 cn-production" },
      environment: {
        type: "string",
        enum: ["sandbox", "production"],
        description: "必填。sandbox 只能指向隔离测试 endpoint/credential/namespace；production 只用于正式运行。",
      },
      config: { type: "object", additionalProperties: true, description: "只允许非 secret 值和 *_env 环境变量名；字面凭证会被拒绝" },
      confirmed: { type: "boolean", description: "只有本工具自己的服务端确认门已收到用户本人选择后才可 true；不得用 generic ask_user 或模型自填代替" },
    },
    ["tool_name", "profile_key", "environment", "config"],
  ),
  async execute(args, ctx) {
    if (!ctx.ports.integrationProfiles) {
      return { ok: false, summary: "当前工厂没有接入 integration profile 持久化端口，不能把临时配置冒充成已确认配置。请让平台管理员先完成接线。" };
    }
    const toolName = String(args.tool_name ?? "").trim();
    const profileKey = String(args.profile_key ?? "").trim();
    const environment = args.environment;
    if (!toolName) return { ok: false, summary: "请告诉我具体要配置哪个真实工具（tool_name）。" };
    if (!INTEGRATION_PROFILE_KEY.test(profileKey)) {
      return { ok: false, summary: "profile_key 只能用字母、数字、点、下划线和短横线，最长 64 个字符。" };
    }
    if (!isIntegrationProfileEnvironment(environment)) {
      return { ok: false, summary: "请明确这套配置属于 sandbox 还是 production。沙箱不能借用生产配置。" };
    }
    if (!args.config || typeof args.config !== "object" || Array.isArray(args.config)) {
      return { ok: false, summary: "config 必须是对象；凭证请只填 *_env 对应的服务器环境变量名。" };
    }

    let resources: CurrentExecutionResources;
    try {
      resources = await currentExecutionResources(ctx);
    } catch {
      return executionResourcesUnavailable(`工具「${toolName}」的连接配置`);
    }
    const tool = resources.realTools.find((candidate) => candidate.name === toolName);
    if (!tool) return { ok: false, summary: `真实工具目录里没有「${toolName}」；先 search_tools，不要凭名字猜。` };
    if (!toolRequiresConfirmedIntegrationProfile(tool)) {
      return { ok: false, summary: `工具「${toolName}」没有声明 tenant/domain 配置面，按平台默认配置运行，不需要也不允许模型额外保存 profile。` };
    }
    const validation = validateIntegrationToolConfig(tool, args.config, { rejectUnknownKeys: true });
    if (!validation.valid) {
      return {
        ok: false,
        summary: `这套配置还不能交给用户确认：${validation.issues.map((issue) => issue.message).join("；")}。我不会猜字段，也不会保存字面凭证。`,
        output: {
          invalidConfigKeys: validation.invalidConfigKeys,
          missingConfigKeys: validation.missingConfigKeys,
        },
      };
    }
    if (!ctx.conversationId || !ctx.ports.authorizationChallenges) {
      return { ok: false, summary: "当前运行没有可审计的 execution/conversation 或耐久授权存储，不能保存 integration profile。" };
    }
    const execution = factoryExecutionScope(ctx.conversationId);
    const authorization = createIntegrationProfileAuthorizationBinding({
      tool,
      domainId: ctx.domain,
      profileKey,
      environment,
      config: validation.config,
      scope: execution,
    });
    const environmentNote = environment === "sandbox"
      ? "仅供隔离沙箱使用，不得连接生产数据或触达真人"
      : "仅供正式运行使用，沙箱不会借用它";
    const question = `是否确认把「${toolName} / ${profileKey}」保存为 ${environment} 集成配置？${environmentNote}。（本次确认 ${authorization.digest.slice(0, 12)}）`;
    if (args.confirmed !== true) {
      let challenge = pendingChallenge(ctx, "integration_profile", authorization.digest);
      if (!challenge) {
        challenge = await ctx.ports.authorizationChallenges.issue(ctx.domain, {
          kind: "integration_profile",
          subjectDigest: authorization.digest,
          ...execution,
          question,
          declineLabel: "暂不保存",
          confirmLabel: "确认保存这套配置",
        });
      }
      parkAuthorizationChallenge(ctx, challenge);
      const reviewLines = integrationProfileReviewLines(validation.config);
      return {
        ok: true,
        summary: `我已检查这套配置：没有字面凭证，并已用服务端固定问题暂停等待用户本人确认。确认保存永远不是推荐项；用户没明确选择前不会继续。${validation.missingEnvRefs.length ? ` 另外，服务器还缺环境变量 ${validation.missingEnvRefs.join("、")}，即使保存也暂时不能运行。` : ""}`,
        output: {
          authorizationRequired: true,
          environment,
          configDigest: authorization.configDigest,
          review: reviewLines,
          missingEnvRefs: validation.missingEnvRefs,
        },
      };
    }
    if ((ctx.consumedIntegrationProfileAuthorizationDigests ?? []).includes(authorization.digest)) {
      return { ok: false, summary: "这次 integration profile 确认已经使用过，不能重放；如需再次修改，请按当前配置重新让用户确认。" };
    }
    const challenge = pendingChallenge(ctx, "integration_profile", authorization.digest);
    if (!challenge) {
      return { ok: false, summary: "没有找到与当前工具、领域、profile、config、run/conversation 完全一致的服务端 challenge。confirmed 不能由模型自行填写。" };
    }

    let profile;
    try {
      // Consume durably and atomically before the profile write. The returned
      // actor is the authenticated answerer, never the run starter.
      const authorizationReceipt = await consumeChallenge(ctx, challenge);
      profile = await ctx.ports.integrationProfiles.save(ctx.domain, {
        profileKey,
        environment,
        tool,
        config: validation.config,
        authorization: authorizationReceipt,
        execution,
      });
      (ctx.consumedIntegrationProfileAuthorizationDigests ??= []).push(authorization.digest);
      ctx.consumedIntegrationProfileAuthorizationDigests = ctx.consumedIntegrationProfileAuthorizationDigests.slice(-200);
    } catch (error) {
      return { ok: false, summary: `integration profile 没有保存成功：${String((error as Error).message ?? error).slice(0, 240)}。为避免重复写入，本次确认已消费；修复后请重新向用户确认。` };
    }
    let refreshed: CurrentExecutionResources;
    try {
      refreshed = await currentExecutionResources(ctx);
    } catch {
      const question = `「${toolName} / ${profile.profileKey} / ${profile.environment}」已经保存并记录人工确认，但工具清单刷新失败。请先确认 Agent Factory 的工具目录和配置服务恢复，再告诉我“已恢复，请重读”；不要重复保存同一份配置。`;
      return {
        ok: true,
        summary: question,
        output: {
          committed: true,
          next: "ask_user",
          reason: "execution_resources_refresh_failed_after_profile_save",
          question,
          missing: ["execution_resources_snapshot"],
          profile: { id: profile.id, profileKey: profile.profileKey, environment: profile.environment, toolName: profile.toolName },
        },
      };
    }
    ctx.realTools = refreshed.realTools;
    ctx.toolCatalog = [...new Set([
      ...(ctx.ontology ? buildToolCatalog(ctx.ontology) : []),
      ...refreshed.realTools.map((candidate) => candidate.name),
    ])];
    return {
      ok: true,
      summary: `已保存并记录人工确认：「${toolName} / ${profile.profileKey} / ${profile.environment}」。design_agent 必须把它放进 ${profile.environment === "sandbox" ? "sandbox_tool_profiles" : "production_tool_profiles"}；另一环境仍需单独确认。配置变化会让旧证据失效。`,
      output: {
        profile: {
          id: profile.id,
          profileKey: profile.profileKey,
          environment: profile.environment,
          toolName: profile.toolName,
          domainId: profile.domainId,
          confirmedBy: profile.confirmedBy,
          confirmedAt: profile.confirmedAt,
          config: profile.config,
        },
      },
    };
  },
};

const search_tools: BrainTool = {
  name: "search_tools",
  description:
    "Tool-Finder（渐进式工具检索）：按自然语言意图在【真实工具库】里搜可用工具，而不是把整个目录一次性背下来。给某个 action 找工具时先 search_tools 看有没有现成的，再 design_agent 绑真名；真没有再 fetch_doc + extract_api_schema + create_tool 造。可按 category(robohire/fs/http/ontology) 或读写副作用过滤。",
  parameters: params(
    {
      query: { type: "string", description: "要找的能力，自然语言，如「解析简历PDF」「给候选人发面试邀请」「把HTML写进归档」" },
      category: { type: "string", description: "（可选）限定分类，如 robohire / fs / http / ontology" },
      side_effect: { type: "string", enum: ["read", "write", "dual", "call"], description: "（可选）只看读/写/双写/纯调用" },
      limit: { type: "number", description: "（可选）返回条数，默认 6" },
    },
    ["query"],
  ),
  async execute(args, ctx) {
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, summary: "search_tools 需要 query（要找什么能力）。" };
    let pool = ctx.realTools ?? [];
    if (!pool.length && ctx.ports.toolRegistry) pool = await ctx.ports.toolRegistry.list();
    // Also surface persisted 造工具 tools (create_tool / the library's standalone 造工具 entry) so the
    // brain rediscovers tools it (or a human) built earlier — not just the built-in global registry.
    if (ctx.ports.tools) {
      const created = await ctx.ports.tools.list(ctx.domain);
      const have = new Set(pool.map((t) => t.name));
      for (const dt of created) {
        if (have.has(dt.name)) continue;
        pool = [...pool, persistedToolAsRealTool(dt)];
      }
    }
    // #ACI (P1-8, SWE-agent) — refuse-and-refine on over-broad queries: summarized search with a
    // hard cap beats paginated results（分页式结果比没有搜索工具还差 -6.0pp）。先探全量命中数，
    // 超过硬上限就【什么都不给】并要求更具体的意图，绝不分页。
    const HARD_CAP = 24;
    const probe = searchRealTools(query, pool, {
      category: args.category ? String(args.category) : undefined,
      sideEffect: args.side_effect ? String(args.side_effect) : undefined,
      limit: HARD_CAP + 1,
    });
    if (probe.length > HARD_CAP) {
      return {
        ok: true,
        summary: `「${query}」命中超过 ${HARD_CAP} 个工具——查询太宽，不给列表（分页对你有害）。请用更具体的意图重搜：加上业务对象/动作词（如「解析简历 PDF」而非「解析」），或加 category / side_effect 过滤。`,
        output: { query, results: [], tooBroad: true, matched: probe.length },
      };
    }
    const hits = probe.slice(0, Number(args.limit) || 6);
    ctx.emit({ t: "tool.search", query, results: hits.map((h) => ({ name: h.name, summary: h.summary ?? "", sideEffect: h.sideEffect })) });
    if (!hits.length) {
      return { ok: true, summary: `工具库没搜到「${query}」相关工具。可 fetch_doc 看公网 API → extract_api_schema → create_tool 造，或 ask_user 让用户补真实集成。`, output: { query, results: [], none: true } };
    }
    return {
      ok: true,
      summary: `命中 ${hits.length} 个：${hits.map((h) => `${h.name}(${h.sideEffect})`).join("、")}。design_agent 用真名绑定；缺凭证看每个的 configKeys。`,
      output: { query, results: hits },
    };
  },
};

const extract_api_schema: BrainTool = {
  name: "extract_api_schema",
  description:
    "Schema-Extractor：把 API 文档与脱敏的真实 request/response examples 一起提炼成可执行 HTTP 契约（含 multipart/json request_spec、unwrap/mapping/assertion response_spec）。输出先经严格 manifest parser，再逐例确定性验证；文档与实拍报文冲突时不会生成可落地草稿。doc_text 不传则用最近一次 fetch_doc/web_search 的结果。",
  parameters: params(
    {
      tool_intent: { type: "string", description: "这个工具要干嘛，如「按 jobId 拉取职位详情」——帮助提炼聚焦到对的端点" },
      doc_text: { type: "string", description: "（可选）API 文档原文；不传则用 ctx.research 最近一条" },
      examples: DECLARATIVE_EXAMPLES_SCHEMA,
    },
    ["tool_intent"],
  ),
  async execute(args, ctx) {
    const intent = String(args.tool_intent ?? "").trim();
    const doc = String(args.doc_text ?? "").trim() || (ctx.research.length ? ctx.research[ctx.research.length - 1]!.findings : "");
    const parsedExamples = parseDeclarativeHttpContract({ method: "POST", examples: args.examples });
    if (!parsedExamples.ok) return { ok: false, summary: `提供的 request/response examples 无效：${parsedExamples.error}。` };
    if (!doc && !parsedExamples.examples?.length) return { ok: false, summary: "没有可接地证据——先 fetch_doc/传 doc_text，或提供至少一组脱敏 request/response examples。" };
    if (!isGatewayConfigured()) return { ok: false, summary: "未配置 LLM 网关，无法自动提炼 schema；请直接 create_tool 手写契约。" };
    const sys =
      "你是 API 契约提炼器。给你工具意图、API 文档和可选的脱敏真实 request/response examples，提炼【最贴合该意图的单个 HTTP 端点】。真实 examples 高于文档；两者冲突必须在 notes 明说，并让可执行契约匹配 examples。" +
      '只输出 JSON：{"name":string(带命名空间如 acme.getJob),"method":"GET|POST|PUT|PATCH|DELETE|HEAD","url_template":string(可含{placeholder}),"headers":object(敏感值只写{config_key}占位),"body_template":string(仅简单文本模板；与request_spec互斥),"request_spec":{"encoding":"json|multipart","body_path":string,"fields":object,"files":[{"field":string,"base64_path":string,"filename":string,"filename_path":string,"mime":string,"mime_path":string,"required":boolean}],"max_bytes":number},"response_spec":{"unwrap_path":string,"mappings":object(输出字段→原始响应路径),"assertions":[{"path":string,"op":"exists|non_empty|eq|neq|in|not_in","value":unknown,"values":unknown[],"failure":"retryable|terminal","code":string,"message":string}]},"examples":[{"request":object,"response":unknown,"source":"human|probe|documentation","note":string}],"side_effect":"read|write|dual","operation":"read|compute|write|read_write","effect_scope":"external","sandbox_policy":"live_external|requires_attempt_grant","params_schema":object,"returns_schema":object,"capabilities":[{"systems":string[],"kinds":string[],"roles":string[],"operations":string[],"objectTypes":string[],"probeRequired":boolean}],"auth_hint":string,"confidence":number(0-1),"notes":string}。operation/effect_scope/sandbox_policy 只能由文档、真实 examples 或用户明确说明的执行语义支撑；不得从 HTTP method、side_effect 或名字推断。证据不足时省略这三项并在 notes 中用人话说明需要向用户确认。省略不需要的其他可选字段，不要输出 null；capabilities 必须来自文档/意图中的真实系统边界；不要任何其它文字。';
    const exampleText = parsedExamples.examples?.length
      ? `\n\n脱敏真实/文档 examples（必须逐例对齐）：\n${JSON.stringify(parsedExamples.examples).slice(0, 10000)}`
      : "";
    const user = `工具意图：${intent}\n\nAPI 文档文本（截断）：\n${doc ? doc.slice(0, 5000) : "（无文档；以下 examples 是权威证据）"}${exampleText}`;
    try {
      const j = await chatJson<Record<string, unknown>>(sys, user, { temperature: 0.2, maxTokens: 4000, signal: ctx.signal, models: modelChain("review"), purpose: "extract_api_schema" });
      if (!j || !j.name) return { ok: false, summary: "没能从文档提炼出契约；可换更具体的 tool_intent，或直接 create_tool 手写。" };
      const extractedPolicy = {
        operation: j.operation,
        effectScope: j.effect_scope,
        sandboxPolicy: j.sandbox_policy,
      };
      if (!isGeneratedToolExecutionPolicy(extractedPolicy) || extractedPolicy.effectScope !== "external") {
        const notes = typeof j.notes === "string" && j.notes.trim() ? `。提炼器说：${j.notes.trim().slice(0, 240)}` : "";
        return {
          ok: false,
          summary: `这份 API 材料还不足以确定它会不会改变真实系统。请让用户确认该端点是纯读/计算，还是会新增、修改或删除数据${notes}。我不会根据 HTTP method、side_effect 或工具名替用户猜。`,
          output: { next: "ask_user", reason: "tool_execution_policy_missing", draft: j },
        };
      }
      const method = String(j.method ?? "GET").toUpperCase();
      const contract = parseDeclarativeHttpContract({
        method,
        bodyTemplate: typeof j.body_template === "string" && j.body_template.length ? j.body_template : undefined,
        requestSpec: j.request_spec,
        responseSpec: j.response_spec,
        examples: parsedExamples.examples?.length ? parsedExamples.examples : j.examples,
      });
      if (!contract.ok) return { ok: false, summary: `提炼出的 HTTP manifest 无法执行：${contract.error}。请根据 examples 修正文档/意图后重试。`, output: { invalidContract: true } };
      const reconciliation = validateDeclarativeExamplesAgainstContract(contract);
      if (!reconciliation.ok) {
        return {
          ok: false,
          summary: `提炼契约与 request/response examples 冲突：${reconciliation.errors.slice(0, 5).join("；")}。不会把冲突草稿交给 create_tool。`,
          output: { exampleConflicts: reconciliation.errors },
        };
      }
      j.method = method;
      if (contract.examples) j.examples = contract.examples;
      const fields = (j.params_schema && typeof j.params_schema === "object" ? Object.keys(j.params_schema as object).length : 0)
        + (j.returns_schema && typeof j.returns_schema === "object" ? Object.keys(j.returns_schema as object).length : 0);
      ctx.emit({ t: "tool.schema", name: String(j.name), method: String(j.method ?? "GET"), url: String(j.url_template ?? ""), fields });
      return {
        ok: true,
        summary: `提炼出契约「${String(j.name)}」(${String(j.method ?? "GET")} · 置信度${j.confidence ?? "?"})${j.auth_hint ? ` · 鉴权:${String(j.auth_hint).slice(0, 50)}` : ""}。核对后用 create_tool 落地。`,
        output: j,
      };
    } catch (e) {
      return { ok: false, summary: `提炼失败：${(e as Error).message}。可直接 create_tool 手写契约。` };
    }
  },
};

const analyze_failure: BrainTool = {
  name: "analyze_failure",
  description: "反复试仍跑不通、或确认是数据/环境/本体限制时，诚实记录一条反思（根因+下次经验）并据此收尾。比假装成功有价值。",
  parameters: params({ kind: { type: "string", enum: ["failure", "success", "caveat"] }, summary: { type: "string" }, root_cause: { type: "string" }, lesson: { type: "string" } }, ["kind", "summary", "lesson"]),
  async execute(args, ctx) {
    const kind = (args.kind === "success" || args.kind === "caveat" ? args.kind : "failure") as "failure" | "success" | "caveat";
    let rootCause = String(args.root_cause ?? "").trim();
    let lesson = String(args.lesson ?? "").trim();
    // Diagnostic reflexion (ported from old AO): if the brain left root_cause/lesson thin, DERIVE a
    // real diagnosis from the run state (validation issues, refine churn, sandbox outcome, explicit
    // capability gaps) so the stored reflection is actionable — not a restate. Best-effort; keeps the brain's
    // own words if they're already substantive.
    if (isGatewayConfigured() && (rootCause.length < 20 || lesson.length < 20)) {
      const sb = ctx.lastSandbox;
      const state = [
        `域:${ctx.domain} · 目标:${ctx.goal}`,
        `已设计 ${ctx.specs.length} 个 agent: ${ctx.specs.map((s) => `${s.actionName}(工具${s.tools.length}${(s.unresolvedTools ?? []).length ? `·未解析${s.unresolvedTools!.length}` : ""}${s.degraded ? "·降级" : ""})`).join("；") || "无"}`,
        ctx.lastValidation ? `上次校验: ${ctx.lastValidation.ok ? "闭合✓" : `未闭合，问题 agent: ${Object.keys(ctx.lastValidation.agentIssueMap).slice(0, 6).join("、")}`}` : "未校验",
        sb ? `上次沙箱: 部署${sb.deployed}·跑${sb.agentsRan}·${sb.fullChainRan ? "整链通" : "未通"}${sb.degradedAgents.length ? `·降级 ${sb.degradedAgents.join(",")}` : ""}${sb.simulated ? "（模拟）" : ""}` : "未沙箱",
        `精修历史: ${Object.entries(ctx.attemptHistory).map(([k, h]) => `${k}×${h.length}`).join(" ") || "无"}`,
        rootCause ? `大脑初判根因: ${rootCause}` : "",
      ].filter(Boolean).join("\n");
      const sys =
        "你是 Agent 工厂的【诊断专家】。给定一次「用本体生成 agents」运行的状态，找出它跑不通/降级的【真实根因】属于哪一层(数据缺失 / 本体不全 / 工具没接 / 设计错误 / 外部平台没对接)，并给一条【下次该怎么做】的具体经验。" +
        '只输出 JSON：{"root_cause":string,"lesson":string}，中文、具体到层与动作。不要任何其它文字。';
      try {
        const j = await chatJson<{ root_cause?: unknown; lesson?: unknown }>(sys, state, { temperature: 0.3, maxTokens: 2000, signal: ctx.signal, models: modelChain("review"), purpose: "diagnose_failure" });
        if (j) {
          if (j.root_cause && String(j.root_cause).length > rootCause.length) rootCause = String(j.root_cause);
          if (j.lesson && String(j.lesson).length > lesson.length) lesson = String(j.lesson);
        }
      } catch {
        /* best-effort — keep the brain's own words */
      }
    }
    await ctx.ports.reflection.record(ctx.domain, { summary: String(args.summary ?? ""), lesson, failedStep: rootCause || undefined, kind });
    ctx.emit({ t: "reflect", kind, lesson });
    return { ok: true, summary: `已记录一条 ${kind} 反思${rootCause ? `（根因: ${rootCause.slice(0, 40)}${rootCause.length > 40 ? "…" : ""}）` : ""}。`, output: { kind, rootCause, lesson } };
  },
};

// ---------------------------------------------------------------- save_draft (#SCOPE 部分交付)
// The user-scoped counterpart to finish: when the user only asked for SOME actions' functions,
// full-coverage finish is the wrong bar — this persists the designed specs into the SAME durable
// draft library (FsAgentDraftStore) WITHOUT regression evidence. Honesty invariants: the draft
// carries no evidenceFingerprint/sandbox receipts, so promotion stays fail-closed on it; the
// summary states that plainly. finish's full-coverage delivery semantics are untouched.
const save_draft: BrainTool = {
  name: "save_draft",
  description:
    "【部分交付】把当前已设计的 agents 作为设计稿草稿持久化到草稿库——用户只要求生成某个/部分动作的 function 时用这个，不需要全动作覆盖、不需要沙箱。前置：至少 1 个已设计 agent 且都有代码；建议先过完三重审查环（review_agent/review_context/review_completeness）。诚实边界：草稿【没有沙箱执行证据、不能晋升】；要可晋升的完整交付仍走 generate_test_cases→sandbox_run→finish。",
  parameters: params({ note: { type: "string", description: "（可选）给草稿的一句备注（如用户要求的范围）" } }),
  async execute(args, ctx) {
    if (!ctx.ports.drafts) {
      return { ok: false, summary: "草稿存储未接入，无法持久化设计稿。" };
    }
    if (!ctx.specs.length) {
      return { ok: false, summary: "还没有已设计的 agent——先 create_plan（可 scope:\"partial\"）→ design_agent，再存草稿。" };
    }
    const noCode = ctx.specs.filter((s) => !s.generatedCode).map((s) => s.nameZh || s.actionName);
    if (noCode.length) {
      return { ok: false, summary: `这些 agent 还没有代码：${noCode.join("、")}——design_agent 会自动渲染，或用 codegen_agent 补齐后再存草稿。` };
    }
    let persisted: number;
    try {
      persisted = await ctx.ports.drafts.save(ctx.domain, ctx.specs);
    } catch (e) {
      return { ok: false, summary: `草稿持久化失败：${String((e as Error).message ?? e).slice(0, 200)}` };
    }
    if (persisted <= 0) {
      return { ok: false, summary: "草稿库拒绝了本次写入（域不匹配或规格不属于当前域）——设计稿未持久化，本次不记为交付。" };
    }
    const scopedActionNames = ctx.ontology
      ? generationScopedAgentActionNames(ctx)
      : null;
    const coveredScopedActions = scopedActionNames
      ? scopedActionNames.filter((actionName) =>
          ctx.specs.some((spec) => spec.actionName === actionName),
        ).length
      : ctx.specs.length;
    const scopeBits = ctx.planScope?.kind === "partial"
      ? `部分交付（${ctx.planScope.reason ?? "用户指定范围"}）`
      : "设计稿";
    const coverageBits = scopedActionNames
      ? `覆盖 ${coveredScopedActions}/${scopedActionNames.length} 个本次范围 Agent 动作`
      : `${ctx.specs.length} 个 agent`;
    const note = typeof args.note === "string" && args.note.trim() ? ` · 备注：${args.note.trim()}` : "";
    ctx.emit({ t: "message", text: `📥 已把 ${persisted} 个设计稿存入草稿库（${scopeBits} · ${coverageBits}）${note}。诚实声明：这些草稿没有沙箱执行证据，不能晋升；需要完整交付时再 generate_test_cases → sandbox_run → finish。` });
    return {
      ok: true,
      summary: `已持久化 ${persisted} 个设计稿草稿（${scopeBits} · ${coverageBits}）。左栏「已生成·草稿」可查看/编辑；无沙箱证据、晋升门会拒绝——这是设计稿而非已验证交付。`,
      output: { persisted, scope: ctx.planScope?.kind ?? "full", coveredAgents: ctx.specs.map((s) => s.actionName), missedActions: ctx.planScope?.missedActions ?? [] },
    };
  },
};

/** The only Agent Actions that count toward this run's design, review and
 * acceptance. A server-issued generation directive is authoritative even when
 * it represents a session-local virtual Action; legacy conversations without a
 * directive retain the historical full-domain Agent scope. */
function generationScopedAgentActions(ctx: BrainCtx): OntologyAction[] {
  if (!ctx.ontology) return [];
  return factoryGenerationScopedAgentActions(
    ctx.ontology,
    ctx.generationDirective,
  );
}

function generationScopedAgentActionNames(ctx: BrainCtx): string[] {
  if (!ctx.ontology) return [];
  return factoryGenerationScopedAgentActionNames(
    ctx.ontology,
    ctx.generationDirective,
  );
}

function generationAcceptanceOntology(ctx: BrainCtx): DomainOntology {
  return factoryGenerationAcceptanceOntology(
    ctx.ontology!,
    ctx.generationDirective,
  );
}

function authoritativeBaseOntology(ctx: BrainCtx): DomainOntology {
  const ontology = ctx.ontology!;
  const directive = ctx.generationDirective;
  if (!directive?.virtualAction) return ontology;
  const virtualEvents = new Set(
    (directive.virtualEvents ?? []).map((event) => event.name),
  );
  const virtualLinks = new Set(
    (directive.virtualLinks ?? []).map((link) => link.id),
  );
  const { factorySessionOverlay: _overlay, ...base } = ontology;
  return {
    ...base,
    actions: ontology.actions.filter(
      (action) => action.id !== directive.virtualAction!.id,
    ),
    events: ontology.events.filter((event) => !virtualEvents.has(event.name)),
    ...(ontology.links === undefined
      ? {}
      : {
          links: ontology.links.filter((link) => !virtualLinks.has(link.id)),
        }),
  };
}

const finish: BrainTool = {
  name: "finish",
  description: "交付。仅当【本次验收范围内每个 actor=Agent Action 都已设计】【每个 agent 都有代码】【当前这套 agent 有一次匹配的 sandbox_run 成功证据】时通过；否则打回继续。服务端 actionIds/scenario generation scope 是完整验收全集，选中范围跑通后直接 finish；只有无 generation scope 的旧式临时部分设计才用 save_draft。",
  parameters: params({ summary: { type: "string" } }, ["summary"]),
  async execute(args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "还没 read_ontology，无法验收覆盖。" };
    const acceptanceOntology = generationAcceptanceOntology(ctx);
    const gap = coverageGap(
      acceptanceOntology.actions,
      ctx.specs.map((s) => s.actionName),
    );
    if (gap.length) {
      // #SCOPE — a user-scoped partial plan is INTENT: don't push the brain to design actions the
      // user never asked for; route the delivery to save_draft instead (finish semantics untouched).
      if (ctx.planScope?.kind === "partial") {
        return { ok: false, summary: `还有未覆盖的 Agent 动作：${gap.join("、")}。当前计划是【部分范围】（${ctx.planScope.reason ?? "用户指定"}）——finish 只用于全覆盖交付；部分交付请用 save_draft 把已设计的 agents 存为设计稿草稿，或先与用户确认扩大范围再继续 design_agent。` };
      }
      return { ok: false, summary: `还有未覆盖的 Agent 动作：${gap.join("、")}——继续 design_agent。` };
    }
    const noCode = ctx.specs.filter((s) => !s.generatedCode).map((s) => s.nameZh);
    if (noCode.length) return { ok: false, summary: `这些 agent 还没代码：${noCode.join("、")}——design_agent 会自动渲染，或用 codegen_agent。` };
    if (ctx.awaitingApproval || !ctx.testCases?.length) {
      return { ok: false, summary: "还没有用户批准的测试用例，不能生成可重放回归工件。请先 generate_test_cases，并由用户确认「执行」后再 sandbox_run。" };
    }
    const currentCoverage = ensureCoverage(ctx, ctx.testCases);
    ctx.testCoverage = currentCoverage.coverage;
    if (currentCoverage.coverage.backfilled.length) {
      return {
        ok: false,
        summary: `当前批准用例缺少 ${currentCoverage.coverage.backfilled.length} 个确定性覆盖格（${currentCoverage.coverage.backfilled.join("、")}），请重新生成并批准后再交付。`,
      };
    }
    const uncovered = normalizeCoverageCells(currentCoverage.coverage.uncoveredNeedingData);
    if (!coverageWaiverMatches(uncovered, ctx.testCoverageWaiver)) {
      return {
        ok: false,
        summary: `覆盖矩阵仍缺 ${uncovered.length} 个需真实数据的格（${uncovered.join("、")}），且没有与该精确格集合绑定的人工豁免，不能交付。`,
      };
    }
    if (!ctx.lastSandbox) return { ok: false, summary: "finish 前必须先 sandbox_run 真跑一次验证。" };
    let evidenceSnapshot: Awaited<ReturnType<typeof currentSandboxEvidenceSnapshot>>;
    try {
      // finish persists a reviewable DRAFT of the exact sandboxed version. It
      // revalidates current sandbox profiles/definitions here; production
      // profiles and live-probe-only evidence belong to the later promotion
      // gate and must not block a human-approved signed-fixture simulation.
      evidenceSnapshot = await currentSandboxEvidenceSnapshot(ctx, "sandbox");
    } catch (error) {
      if (error instanceof ToolPolicyDriftError) {
        const question = `工具库在上次沙箱后发生了读写权限变化，旧证据已作废。请重新审查这些工具并再跑沙箱：${error.issues.slice(0, 6).join("；")}。`;
        return { ok: false, summary: question, output: { next: "ask_user", reason: "tool_policy_drift", question, missing: error.missing } };
      }
      if (error instanceof ExecutionResourcesUnavailableError) {
        return executionResourcesUnavailable("交付前复验");
      }
      const detail = String((error as Error)?.message ?? error).slice(0, 220);
      const question = `交付前复验没有通过：${detail}。旧沙箱证据不能继续使用；请按这条原因修正 profile、probe 或工具策略，然后重新 sandbox_run（创建新的临时 App 重跑）。`;
      return {
        ok: false,
        summary: question,
        output: {
          next: "ask_user",
          reason: "sandbox_evidence_revalidation_failed",
          question,
          missing: ["current integration evidence", "fresh sandbox evidence"],
        },
      };
    }
    const fp = evidenceSnapshot.fingerprint;
    if (ctx.lastSandbox.specsFingerprint !== fp) return { ok: false, summary: "agent 在上次沙箱后又改过——证据过期，请重新 sandbox_run。" };
    if (
      ctx.lastSandbox.toolMode !== "evidence_replay"
      || ctx.lastSandbox.externalLiveCalls !== 0
      || ctx.lastSandbox.sandboxReplayEvidenceComplete !== true
    ) {
      return {
        ok: false,
        summary: `上次沙箱没有形成完整的 attempt-bound evidence replay 账本（toolMode=${ctx.lastSandbox.toolMode ?? "unknown"}，externalLiveCalls=${String(ctx.lastSandbox.externalLiveCalls ?? "unknown")}）。请补齐精确 cassette 后创建一个新的临时 App 重跑；不会把 live/gated 或未知证据写成可晋升工件。`,
      };
    }
    const expectedReviewSubjectDigest = sandboxDesignReviewSubjectDigest({ domain: ctx.domain, fingerprint: fp });
    const reviewReceipt = ctx.lastSandbox.designReviewReceipt;
    const humanReviewCurrent = Boolean(
      reviewReceipt
        && ctx.lastSandbox.designReviewSubjectDigest ===
          expectedReviewSubjectDigest
        && reviewReceipt.kind === "sandbox_design_review"
        && reviewReceipt.subjectDigest === expectedReviewSubjectDigest
        && reviewReceipt.actor?.trim()
        && (!ctx.conversationId ||
          (reviewReceipt.runId === ctx.conversationId &&
            reviewReceipt.conversationId === ctx.conversationId)),
    );
    const autopilotReview = ctx.lastSandbox.autopilotReview;
    const autopilotReviewCurrent = Boolean(
      ctx.interactionPolicy === "autopilot"
        && autopilotTestApprovalBlockReason(ctx) === null
        && ctx.lastSandbox.externalWritesRequired === false
        && autopilotReview?.schema ===
          "agent-factory-autopilot-sandbox-review/v1"
        && autopilotReview.policy === "autopilot_safe"
        && autopilotReview.fingerprint === fp
        && autopilotReview.subjectDigest === expectedReviewSubjectDigest
        && autopilotReview.assumptionId?.trim()
        && (!ctx.conversationId
          || autopilotReview.conversationId === ctx.conversationId),
    );
    if (!humanReviewCurrent && !autopilotReviewCurrent) {
      return {
        ok: false,
        summary: "上次沙箱既没有与当前证据精确绑定的人工设计签核，也没有满足覆盖完整、无授权待办、无外部写条件的 Autopilot 安全审查。请重新 sandbox_run；不会复用或伪造批准。",
      };
    }
    const cleanupIssues = sandboxCleanupReceiptIssues(ctx.lastSandbox.cleanupReceipt, {
      candidateFingerprint: fp,
      targetDomainId: ctx.domain,
    });
    const executionReceiptIssues = sandboxExecutionReceiptIssues(ctx.lastSandbox.executionReceipt, {
      candidateFingerprint: fp,
      targetDomainId: ctx.domain,
      targetTenantId: ctx.ports?.factoryScope?.tenantId,
      targetTenantSlug: ctx.ports?.factoryScope?.tenantSlug,
      sandboxAttemptId: ctx.lastSandbox.sandboxAttemptId,
      modelUsageHash: ctx.lastSandbox.modelUsage?.evidenceHash,
    });
    if (ctx.lastSandbox.transportAccepted === false) {
      return {
        ok: false,
        summary: `上次沙箱的 Inngest 注册/入口事件投递未被真实接受，旧的同指纹成功证据已失效${ctx.lastSandbox.transportError ? `（${ctx.lastSandbox.transportError.slice(0, 180)}）` : ""}。请恢复真实运行链路后重新 sandbox_run。`,
      };
    }
    if (ctx.lastSandbox.deployed === 0) return { ok: false, summary: "上次沙箱没真部署成功（0 函数）。" };
    const completeSuite = assessCompleteSuite({
      ...ctx.lastSandbox,
      expectedCaseIds: (ctx.testCases ?? []).map((testCase) => testCase.id),
    });
    if (!completeSuite.complete) {
      return { ok: false, summary: `上次沙箱没有证明完整批准套件跑通（${completeSuite.detail}）。请先定位真实断点；单个成功终态不能替代全量用例证据。` };
    }
    // R2: graph-closure inference is diagnostic evidence, never production delivery evidence. The
    // waiver exists only for isolated unit tests; a dev/production process cannot enable it by env.
    const simulatedWaiver =
      ctx.lastSandbox.simulated === true &&
      process.env.NODE_ENV === "test" &&
      process.env.FACTORY_ALLOW_SIMULATED_FINISH === "1";
    if (ctx.lastSandbox.simulated && !simulatedWaiver) {
      return { ok: false, summary: "上次沙箱只是【模拟诊断】（Inngest 未运行），不能作为交付证据。请恢复真实 Inngest 运行环境后重新 sandbox_run，完成真实部署与执行验证。" };
    }
    // Keep test-only waivers loud in transcripts so even a fixture cannot masquerade as real proof.
    if (simulatedWaiver) {
      ctx.emit({ t: "reflect", kind: "warning", lesson: "🧪 单元测试专用：模拟证据被测试开关放行；未经真实部署执行验证，不可作为生产就绪证明。" });
    }
    if ((process.env.NODE_ENV !== "test" || ctx.lastSandbox.executionReceipt) && executionReceiptIssues.length > 0) {
      return {
        ok: false,
        summary: "上次测试没有可验证的外部隔离执行回执，不能 finish。Agent Factory 不会把本地 worker/process 的绿色结果降格冒充为可晋升证据。请恢复 sandbox runner 后创建新的临时 App 重跑。",
        output: {
          next: "ask_user",
          reason: "external_execution_receipt_invalid",
          question: "请确认外部 sandbox runner 已启动且能签发与当前代码、domain 和 attempt 绑定的回执，然后回复“重新测试”。",
          missing: executionReceiptIssues,
        },
      };
    }
    if (process.env.NODE_ENV !== "test" && cleanupIssues.length > 0) {
      return {
        ok: false,
        summary: `上次临时 Inngest App 的删除回执不完整或不匹配（${cleanupIssues.join("；")}），不能交付。请重新 sandbox_run；我不会复用旧 App 或把 0 functions 当作已删除。`,
        output: {
          next: "ask_user",
          reason: "sandbox_cleanup_receipt_invalid",
          question: "请确认专用测试 Inngest 的 App 删除控制面与缺席回读可用，然后重新运行沙箱测试。",
          missing: cleanupIssues,
        },
      };
    }
    // Phase 0a — enforce the FULL documented acceptance bar, not just the inline checks above.
    // This catches the gaps finish ignored: an agent with an unresolved tool, a chain that ran
    // but DEGRADED, an unbound rule gate, or an agent with no typed I/O payload.
    // #P3 — 监督者的版本锁定缺陷进 finish 门:0 阻塞缺陷才放行(阻塞缺陷在 sandbox_run 审计+结转到
    // ctx.defects,须在【更新版本】上复验消失才关闭——防同版本重跑洗白)。
    const openBlocking = blockingDefects(ctx.defects ?? []);
    const gate = acceptanceGate(ctx.specs, acceptanceOntology, {
      ...ctx.lastSandbox,
      expectedCaseIds: (ctx.testCases ?? []).map((testCase) => testCase.id),
    }, {
      blockingDefects: openBlocking.length,
      // #CHECKLIST — per-agent defect attribution for the per-agent checklist view.
      blockingDefectSlugs: openBlocking.map((d) => d.agentSlug),
      registeredTools: ctx.realTools ?? [],
    });
    // #CHECKLIST — surface the harness-owned checklist on EVERY finish attempt (pass or fail):
    // the UI renders it as the acceptance scoreboard; the brain sees the same data in output but
    // cannot edit any item — green requires real evidence.
    ctx.emit({ t: "acceptance", allPass: gate.report.allPass, criteria: gate.report.criteria, perAgent: gate.report.perAgent });
    // #P1-6 — persist per-criterion verdicts (pass OR fail) so acceptance pass-rate is trendable
    // without replaying transcripts. A missing/broken recorder is a real supervision failure and
    // cannot be hidden behind a successful delivery verdict.
    if (ctx.conversationId) {
      if (!ctx.ports.acceptance) {
        return {
          ok: false,
          summary: "验收记录器未接入，无法持久化逐项验收证据；本次交付不记为成功。",
          output: { acceptance: gate.report },
        };
      }
      await ctx.ports.acceptance.record(ctx.conversationId, ctx.domain, undefined, gate.report.criteria);
    }
    if (!gate.pass) {
      return {
        ok: false,
        summary: `验收未达标：${gate.failing.map((c) => `${c.label}（${c.detail}）`).join("；")}——先修复再 finish。`,
        output: { acceptance: gate.report },
      };
    }
    // Persist the accepted agents as durable, reviewable DRAFTS. Delivery is only successful after
    // every accepted agent is durably stored; otherwise the UI would advertise a result that
    // disappears on restart.
    if (!ctx.ports.drafts) {
      return { ok: false, summary: "草稿存储未接入，验收通过但无法持久化交付物；本次交付不记为成功。" };
    }
    let persisted: number;
    try {
      const factoryScope = ctx.ports.factoryScope;
      if (!factoryScope) {
        return {
          ok: false,
          summary: "当前 Factory 运行缺少可验证的 tenant 身份，无法把权威 Ontology 摘要写入交付证据；请从已连接业务领域重新预检。",
        };
      }
      persisted = await ctx.ports.drafts.save(ctx.domain, ctx.specs, {
        evidenceFingerprint: fp,
        authoritativeOntology: {
          schema: "agent-factory-authoritative-ontology/v1",
          tenantId: factoryScope.tenantId,
          tenantSlug: factoryScope.tenantSlug,
          domainId: ctx.domain,
          source: ctx.ontology.source,
          contentHash: ontologyContentHash(authoritativeBaseOntology(ctx)),
          ...(ctx.generationDirective?.virtualAction
            ? {
                sessionOverlay: {
                  kind: "virtual_scenario" as const,
                  authoritative: false as const,
                  actionId: ctx.generationDirective.virtualAction.id,
                  actionName: ctx.generationDirective.virtualAction.name,
                  scenarioHash:
                    ctx.generationDirective.virtualAction.factoryProvenance
                      .scenarioHash,
                },
              }
            : {}),
        },
        cleanupReceipt: ctx.lastSandbox.cleanupReceipt,
        sandboxAppId: ctx.lastSandbox.appId,
        committedManifestFunctionIds: ctx.lastSandbox.committedManifestFunctionIds,
        brokerRegistration: ctx.lastSandbox.brokerRegistration,
        executionReceipt: ctx.lastSandbox.executionReceipt,
        modelUsage: ctx.lastSandbox.modelUsage,
        approvedTestCases: ctx.testCases ?? [],
        testCoverage: currentCoverage.coverage,
        testCoverageWaiver: ctx.testCoverageWaiver,
        testDataOverrides: ctx.testDataOverrides,
        boundaryEvents: ctx.boundaryEvents,
        functionTester: ctx.lastSandbox.functionTester,
        toolMode: ctx.lastSandbox.toolMode,
        externalLiveCalls: ctx.lastSandbox.externalLiveCalls,
        replayReceipts: ctx.lastSandbox.replayReceipts,
        sandboxReplayEvidenceComplete: ctx.lastSandbox.sandboxReplayEvidenceComplete,
        ...(humanReviewCurrent && reviewReceipt
          ? {
              sandboxDesignReview: {
                fingerprint: fp,
                subjectDigest: expectedReviewSubjectDigest,
                receipt: reviewReceipt,
              },
            }
          : {}),
        ...(autopilotReviewCurrent && autopilotReview
          ? { sandboxAutopilotReview: autopilotReview }
          : {}),
        // Preserve the exact remote-bundle references (including global,
        // tenant-native and multiple configs of one tool). The local snapshot
        // list is display-only and cannot safely reconstruct this identity.
        cassetteRefs: ctx.lastSandbox.cassetteRefs,
      });
    } catch (error) {
      return { ok: false, summary: `草稿持久化失败，本次交付不记为成功：${error instanceof Error ? error.message : String(error)}` };
    }
    if (persisted !== ctx.specs.length) {
      return { ok: false, summary: `草稿持久化不完整（${persisted}/${ctx.specs.length}），本次交付不记为成功。` };
    }
    await ctx.ports.reflection.record(ctx.domain, { summary: `交付 ${ctx.specs.length} 个 agent：${String(args.summary ?? "")}`.slice(0, 500), lesson: "该域已成功生成并沙箱验证通过的一套 agent 可作后续参考。", kind: "success" });
    ctx.emit({ t: "reflect", kind: "success", lesson: "交付成功，留下一条成功反思。" });
    if (persisted > 0) ctx.emit({ t: "message", text: `📦 已把 ${persisted} 个 agent 存为草稿（可复用 / 后续晋升为正式 Fleet agent）。` });
    return { ok: true, summary: `✅ 交付通过：${ctx.specs.length} 个 agent，覆盖全部 Agent 动作、都有代码、沙箱端到端跑通${persisted > 0 ? `；已存 ${persisted} 个草稿` : ""}。`, output: { delivered: ctx.specs.map((s) => s.short), persisted, summary: String(args.summary ?? "") } };
  },
};

/** The full tool set (the harness's action space). */
/** ask_user — the general HITL clarification. The brain calls it when it's uncertain or
 *  missing info (e.g. an external platform's API I/O isn't in the tool library, an ambiguous
 *  requirement, a test it can't diagnose) instead of guessing or silently degrading an agent.
 *  Parks the run (awaitingClarify) until the user answers — free text or an offered option
 *  (one may be the AI's recommendation). Mirrors the test-case / boundary HITL gates. */
const ask_user: BrainTool = {
  name: "ask_user",
  description:
    "拿不准 / 缺信息 / 测试卡住、且你自己判断不了时，直接问用户——不要瞎猜、也不要把 agent 默默降级。给一个清晰的问题 + 2-4 个具体可选项（其中标一个 recommended:true 作你的最佳推荐），用户可以选一个或补充文字。典型：某外部平台 API 的 input/output 工具库里查不到、需求歧义、某测试反复失败拿不准根因、是否要造模拟桩。问完【暂停等用户回答】再继续，别在等待时调别的工具。同一问题问过一次就不会再打断用户——会直接把上次的答案回放给你。",
  parameters: params(
    {
      question: { type: "string", description: "要问用户的具体问题（一句话说清你需要什么）" },
      options: {
        type: "array",
        description: "2-4 个具体可选项；标一个 recommended:true 作你的最佳推荐",
        items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" }, recommended: { type: "boolean" } }, required: ["label", "value"], additionalProperties: false },
      },
      context: { type: "string", description: "背景：你卡在哪、为什么需要这个信息" },
    },
    ["question"],
  ),
  async execute(args, ctx) {
    const question = String(args.question ?? "").trim();
    if (!question) return { ok: false, summary: "question 不能为空。" };
    const rawContext = args.context ? String(args.context) : "";
    const rawOptions = Array.isArray(args.options) ? args.options as Array<Record<string, unknown>> : [];
    if (
      /authorize_(?:probe|integration_profile|sandbox_evidence_plan|sandbox_design_review):v\d+:/i.test(question)
      ||
      /(?:probe|integration_profile|sandbox_evidence_plan|sandbox_design_review)_authorization:v\d+:/i.test(rawContext)
      || rawOptions.some((option) => /authorize_(?:probe|integration_profile|sandbox_evidence_plan|sandbox_design_review):v\d+:/i.test(String(option.value ?? "")))
    ) {
      return {
        ok: false,
        summary: "授权问题不能由模型通过通用 ask_user 拼装。请回到 probe_tool / create_signed_fixture / confirm_integration_profile；它们会直接渲染服务端固定的 question、context 和 options。",
      };
    }
    // #ASK-DEDUP（审查修复：同一问题跨轮重复问）— 问过且已有答案 → 直接回放，不再打断用户。
    const norm = normalizeQuestion(question);
    const prior = ctx.askedQuestions?.[norm];
    if (prior !== undefined && prior !== "") {
      return { ok: true, summary: `这个问题已经问过了，用户当时的答复是：「${prior}」——直接采用这个答案继续，别再重复问。`, output: { question, answer: prior, replayed: true } };
    }
    const normalizedOptions = normalizeClarificationOptions(args.options);
    if (!normalizedOptions.ok) {
      return { ok: false, summary: `这个问题的选项还不够清楚：${normalizedOptions.error}` };
    }
    const options = normalizedOptions.options;
    const context = rawContext || undefined;
    const automatic = resolveAutopilotClarification(ctx, {
      question,
      options,
      context,
    });
    if (automatic) {
      (ctx.askedQuestions ??= {})[norm] = automatic.answer;
      return {
        ok: true,
        summary: `Autopilot 已采用${automatic.source === "recommended" ? "推荐项" : "安全默认"}「${automatic.answer}」并记录假设 ${automatic.assumption.id}；继续执行，不挂起。`,
        output: {
          question,
          answer: automatic.answer,
          awaitingAnswer: false,
          assumptionId: automatic.assumption.id,
        },
      };
    }
    (ctx.askedQuestions ??= {})[norm] = ""; // pending 标记：答案由 conductor 的澄清门写入
    ctx.clarifyPrompt = { question, options, context };
    ctx.awaitingClarify = true;
    ctx.emit({ t: "clarify", question, options, context, awaitingAnswer: true });
    return { ok: true, summary: `已向用户提问并【暂停等待回答】：「${question}」。用户回答后我会把答案发给你，你再继续——别在等待时调别的工具。`, output: { question, options, awaitingAnswer: true } };
  },
};

// #ASK-BATCH (P2-7) — one park for a BATCH of decisions. Fleets aggregate their needsUser items;
// asking them one-by-one would park the run N times. This composes the items into a single清晰的
// decision card (numbered items, options starred with the recommendation) and parks ONCE. Same park
// machinery, same authorization firewall, same dedup registry as ask_user.
const ask_user_batch: BrainTool = {
  name: "ask_user_batch",
  description:
    "把【多个需要用户拍板的事项】合并成一次提问并挂起等待（不要连环 ask_user 打断用户 N 次）。每项给 question + 可选 2-4 个选项（标一个 recommended）。典型来源：design_fleet/refine_fleet 聚合出的 needsUser 清单、多个动作的集成选择。用户会按编号逐项作答（如「1 选A；2 用真实key；3 跳过」），答案回来后你逐项落实。单个问题请用 ask_user。",
  parameters: params(
    {
      items: {
        type: "array",
        description: "待拍板事项（2..8 项）",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "这一项要用户决定什么（一句话）" },
            context: { type: "string", description: "背景/后果（可选）" },
            options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" }, recommended: { type: "boolean" } }, required: ["label", "value"], additionalProperties: false }, description: "2-4 个选项，标一个 recommended（可选，不给=自由回答）" },
          },
          required: ["question"],
          additionalProperties: false,
        },
      },
    },
    ["items"],
  ),
  async execute(args, ctx) {
    const rawItems = Array.isArray(args.items) ? (args.items as Array<Record<string, unknown>>) : [];
    const items = rawItems.map((i) => ({
      question: String(i.question ?? "").trim(),
      context: String(i.context ?? "").trim(),
      options: i.options,
    })).filter((i) => i.question);
    if (items.length < 2) return { ok: false, summary: "少于 2 项——单个问题直接用 ask_user。" };
    if (items.length > 8) return { ok: false, summary: `一次最多 8 项（收到 ${items.length}）——分两批问。` };
    // Same authorization firewall as ask_user: server-issued challenges are never composed by the model.
    const flat = JSON.stringify(items);
    if (/(?:authorize_probe|authorize_integration_profile|authorize_sandbox_evidence_plan|authorize_sandbox_design_review):v\d+:/i.test(flat) || /(?:probe|integration_profile|sandbox_evidence_plan|sandbox_design_review)_authorization:v\d+:/i.test(flat)) {
      return { ok: false, summary: "授权问题不能由模型通过 ask_user_batch 拼装。请回到 probe_tool / create_signed_fixture / confirm_integration_profile / sandbox_run 的服务端确认门。" };
    }
    if (ctx.interactionPolicy === "autopilot") {
      const prompts = items.map((item) => {
        const normalized = normalizeClarificationOptions(item.options);
        return {
          normalized,
          prompt: {
            question: item.question,
            context: item.context || undefined,
            options: normalized.ok ? normalized.options : undefined,
          },
        };
      });
      const preflightBlocked = prompts.some(
        ({ normalized, prompt }) =>
          !normalized.ok ||
          autopilotClarificationHardBlockReason(ctx, prompt) !== null,
      );
      const answers: Array<{ index: number; question: string; answer: string; assumptionId: string }> = [];
      let hardBlock = preflightBlocked;
      for (let index = 0; index < items.length && !hardBlock; index++) {
        const item = items[index]!;
        const prompt = prompts[index]!.prompt;
        const resolution = resolveAutopilotClarification(ctx, {
          ...prompt,
        });
        if (!resolution) {
          hardBlock = true;
          break;
        }
        answers.push({
          index: index + 1,
          question: item.question,
          answer: resolution.answer,
          assumptionId: resolution.assumption.id,
        });
      }
      if (!hardBlock) {
        return {
          ok: true,
          summary: `Autopilot 已逐项采用 ${answers.length} 个推荐/安全默认并记录假设，不挂起：${answers.map((answer) => `${answer.index}. ${answer.answer}`).join("；")}`,
          output: { answers, awaitingAnswer: false },
        };
      }
    }
    const lines: string[] = ["以下几项需要你拍板（按编号逐项回答，如「1 选A；2 用真实key」）："];
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const normalized = normalizeClarificationOptions(it.options);
      const opts = normalized.ok ? normalized.options : undefined;
      lines.push(`\n**${i + 1}. ${it.question}**${it.context ? `\n   背景：${it.context.slice(0, 200)}` : ""}`);
      if (opts?.length) {
        const letters = ["A", "B", "C", "D"];
        for (let j = 0; j < opts.length; j++) lines.push(`   ${letters[j]}. ${opts[j]!.label}${opts[j]!.recommended ? " ★推荐" : ""}`);
      } else {
        lines.push("   （自由回答）");
      }
    }
    const question = lines.join("\n");
    const norm = normalizeQuestion(question);
    const prior = ctx.askedQuestions?.[norm];
    if (prior !== undefined && prior !== "") {
      return { ok: true, summary: `这批问题问过了，用户当时的答复是：「${prior}」——直接采用，别重复问。`, output: { question, answer: prior, replayed: true } };
    }
    (ctx.askedQuestions ??= {})[norm] = "";
    ctx.clarifyPrompt = { question, options: undefined, context: `批量决策 · ${items.length} 项` };
    ctx.awaitingClarify = true;
    ctx.emit({ t: "clarify", question, options: undefined, context: `批量决策 · ${items.length} 项`, awaitingAnswer: true });
    return { ok: true, summary: `已把 ${items.length} 项决策合并成一次提问并【暂停等待回答】。用户逐项作答后你再逐项落实——别在等待时调别的工具。`, output: { items: items.length, awaitingAnswer: true } };
  },
};

/** #ASK-DEDUP — 问题归一化键：去标点/空白、小写。同义改写不追求识别（那要语义比对，成本高
 *  且误伤风险大）——只拦"字面上基本相同的问题被反复问"这一最常见的泛化来源。 */
export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[\s，。？！,.?!、:："'（）()【】\[\]-]+/g, "").slice(0, 120);
}

// supply_test_data — contact / ID fields should use operator-approved, sandbox-safe probe values
// rather than demo placeholders. Credentials are deliberately excluded: they belong in a server
// integration profile as env references and must never travel through chat or an event fixture.
// The same tool also owns the atomic mutation boundary for complete JSON and binary fixtures.
const REAL_DATA_FIELD = /e?-?mail|邮箱|recipient|收件|notify|通知|webhook|callback|回调|\bphone\b|mobile|\btel\b|手机|账号|account_id|candidate_id|resume_id|job_requisition_id/i;
const SECRET_DATA_FIELD = /api[_-]?key|access[_-]?token|refresh[_-]?token|\bsecret\b|credential|凭证|password|passwd|authorization|cookie|private[_-]?key/i;
const DEMO_VALUE = /example\.com|_demo\b|^13800138000$|^Alex Chen$|^demo|占位/i;
const isDemoValue = (v: unknown): boolean => typeof v === "string" && DEMO_VALUE.test(v);

/** Fields across the designed agents' inputSchema (and the authored test payloads) that read like
 *  real contact/credential/id and aren't already user-overridden — the ones worth asking about. */
function scanRealDataNeeds(ctx: BrainCtx): Array<{ field: string; type: string; sample?: string; agents: string[] }> {
  const needs = new Map<string, { field: string; type: string; sample?: string; agents: Set<string> }>();
  for (const s of ctx.specs) {
    for (const io of s.inputSchema ?? []) {
      if (!REAL_DATA_FIELD.test(io.field)) continue;
      const cur = needs.get(io.field) ?? { field: io.field, type: io.type, agents: new Set<string>() };
      cur.agents.add(s.short || s.nameZh);
      needs.set(io.field, cur);
    }
  }
  for (const tc of ctx.testCases ?? []) {
    for (const [k, v] of Object.entries(tc.payload)) {
      const n = needs.get(k);
      if (n && isDemoValue(v)) n.sample = String(v);
    }
  }
  const overridden = ctx.testDataOverrides ?? {};
  return [...needs.values()].filter((n) => !(n.field in overridden)).map((n) => ({ field: n.field, type: n.type, sample: n.sample, agents: [...n.agents] }));
}

function scanSecretTestFields(ctx: BrainCtx): string[] {
  const schemaFields = ctx.specs.flatMap((spec) =>
    (spec.inputSchema ?? []).map((field) => field.field).filter((field) => SECRET_DATA_FIELD.test(field)));
  const fixturePaths = (ctx.testCases ?? []).flatMap((testCase) => {
    const sensitive = findSensitiveInputPath(testCase.payload, `case:${testCase.id}`);
    return sensitive ? [sensitive] : [];
  });
  return [...new Set([...schemaFields, ...fixturePaths])];
}

/** Apply the user's real values onto a test payload — only keys the payload already carries (so we
 *  never inject foreign fields the canonical event_data doesn't define). */
export function applyTestDataOverrides(payload: Record<string, unknown>, overrides?: Record<string, unknown>): Record<string, unknown> {
  if (!overrides || !Object.keys(overrides).length) return payload;
  const out = { ...payload };
  for (const k of Object.keys(overrides)) if (k in out) out[k] = overrides[k];
  return out;
}

const MAX_TEST_FIXTURE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_TEST_FIXTURE_BINARY_BYTES = 8 * 1024 * 1024;
const MAX_TEST_FIXTURE_TOTAL_JSON_BYTES = 8 * 1024 * 1024;
const MAX_TEST_FIXTURE_TOTAL_BINARY_BYTES = 16 * 1024 * 1024;
const MAX_TEST_FIXTURE_DEPTH = 64;
const UNSAFE_FIXTURE_KEY = new Set(["__proto__", "prototype", "constructor"]);

function cloneJsonFixture(value: unknown, label: string): unknown {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error(`${label} 不是可持久化的 JSON。`);
  }
  if (json === undefined) throw new Error(`${label} 不能是 undefined。`);
  if (Buffer.byteLength(json, "utf8") > MAX_TEST_FIXTURE_JSON_BYTES) {
    throw new Error(`${label} 超过 ${MAX_TEST_FIXTURE_JSON_BYTES / 1024 / 1024} MiB；请改用对象存储 cassette，而不是把大文件塞进事件 JSON。`);
  }
  const cloned = JSON.parse(json) as unknown;
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_TEST_FIXTURE_DEPTH) throw new Error(`${label}${path} 嵌套超过 ${MAX_TEST_FIXTURE_DEPTH} 层。`);
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (UNSAFE_FIXTURE_KEY.has(key)) throw new Error(`${label}${path}/${key} 使用了不安全的对象键。`);
      visit(child, `${path}/${key}`, depth + 1);
    }
  };
  visit(cloned, "", 0);
  return cloned;
}

function decodeJsonPointer(pointer: string): string[] {
  if (!pointer.startsWith("/") || pointer.length < 2) {
    throw new Error(`JSON Pointer「${pointer}」无效；请使用 /resume/experience/0/company 这种格式。`);
  }
  if (pointer.length > 1_024) throw new Error("JSON Pointer 超过 1024 个字符。");
  return pointer.slice(1).split("/").map((part) => {
    if (/~(?:[^01]|$)/.test(part)) throw new Error(`JSON Pointer「${pointer}」包含非法 ~ 转义。`);
    const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!decoded || UNSAFE_FIXTURE_KEY.has(decoded)) throw new Error(`JSON Pointer「${pointer}」包含不安全的路径段。`);
    return decoded;
  });
}

/** Replace only an already-present nested path. Whole-payload replacement is
 * the explicit channel for adding/removing fields; a typo must never silently
 * create a different test contract. */
function setExistingFixturePath(payload: Record<string, unknown>, pointer: string, value: unknown): void {
  const parts = decodeJsonPointer(pointer);
  let cursor: unknown = payload;
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index]!;
    if (!cursor || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, part)) {
      throw new Error(`测试数据路径「${pointer}」不存在（断在 /${parts.slice(0, index + 1).join("/")}）。`);
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  const leaf = parts.at(-1)!;
  if (Array.isArray(cursor) && leaf === "length") {
    throw new Error(`测试数据路径「${pointer}」不能修改数组 length。`);
  }
  if (!cursor || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, leaf)) {
    throw new Error(`测试数据路径「${pointer}」不存在；不会静默新增字段。`);
  }
  (cursor as Record<string, unknown>)[leaf] = cloneJsonFixture(value, `路径 ${pointer} 的值`);
}

function fixtureDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function jsonFixtureBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function fixtureCaseMap(cases: TestCase[]): Map<string, TestCase> {
  const map = new Map<string, TestCase>();
  for (const testCase of cases) {
    if (!testCase.id || map.has(testCase.id)) {
      throw new Error(`测试用例 ID「${testCase.id || "(空)"}」重复或为空，无法安全定向补数据。`);
    }
    map.set(testCase.id, testCase);
  }
  return map;
}

function fixtureRecord(value: unknown, label: string, allowedKeys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象。`);
  const row = value as Record<string, unknown>;
  const unknown = Object.keys(row).filter((key) => !allowedKeys.includes(key));
  if (unknown.length) throw new Error(`${label} 含未知字段：${unknown.join("、")}。`);
  return row;
}

function exactFixtureCase(map: Map<string, TestCase>, raw: unknown, label: string): TestCase {
  const caseId = typeof raw === "string" ? raw.trim() : "";
  const testCase = map.get(caseId);
  if (!testCase) throw new Error(`${label} 引用了不存在的测试用例「${caseId || "(空)"}」；case_id 必须精确匹配。`);
  return testCase;
}

function pointerPathsOverlap(left: string[], right: string[]): boolean {
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return shorter.every((part, index) => longer[index] === part);
}

function validateFixturePatchPath(
  seen: Map<string, Array<{ pointer: string; parts: string[] }>>,
  caseId: string,
  pointer: string,
): void {
  const parts = decodeJsonPointer(pointer);
  const prior = seen.get(caseId) ?? [];
  const conflict = prior.find((entry) => pointerPathsOverlap(entry.parts, parts));
  if (conflict) {
    throw new Error(`测试用例「${caseId}」的路径「${pointer}」与「${conflict.pointer}」重复或父子重叠，无法确定写入顺序。`);
  }
  prior.push({ pointer, parts });
  seen.set(caseId, prior);
}

function validatedFixtureMime(raw: unknown, required: boolean): string | undefined {
  const mime = typeof raw === "string" ? raw.trim() : "";
  if (!mime) {
    if (required) throw new Error("data_url 二进制 fixture 必须明确提供 mime_type，不能猜文件类型。");
    return undefined;
  }
  if (mime.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(mime)) {
    throw new Error(`二进制 fixture 的 mime_type「${mime.slice(0, 80)}」无效。`);
  }
  return mime;
}

function validatedFixtureFilename(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const filename = typeof raw === "string" ? raw.trim() : "";
  if (!filename || filename.length > 255 || /[\0-\x1f\x7f/\\]/.test(filename) || filename === "." || filename === "..") {
    throw new Error("二进制 fixture 的 filename 无效；只能提供普通文件名，不能包含路径或控制字符。");
  }
  return filename;
}

function redactedFixtureValue(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(redactedFixtureValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, redactedFixtureValue(child)]));
  }
  return `[${typeof value}; sha256:${fixtureDigest(value).slice(0, 12)}]`;
}

function redactedTestCasesForApproval(
  cases: TestCase[],
  wholeCases: Set<string>,
  valueKeys: string[],
  patchedPaths: Array<{ caseId: string; pointer: string; descriptor: unknown }>,
): TestCase[] {
  const display = cases.map((testCase) => ({
    ...testCase,
    payload: cloneJsonFixture(testCase.payload, `展示用例 ${testCase.id}`) as Record<string, unknown>,
  }));
  const byId = new Map(display.map((testCase) => [testCase.id, testCase] as const));
  for (const caseId of wholeCases) {
    const testCase = byId.get(caseId);
    if (testCase) testCase.payload = redactedFixtureValue(testCase.payload) as Record<string, unknown>;
  }
  for (const testCase of display) {
    for (const key of valueKeys) {
      if (Object.prototype.hasOwnProperty.call(testCase.payload, key)) {
        testCase.payload[key] = redactedFixtureValue(testCase.payload[key]);
      }
    }
  }
  for (const patch of patchedPaths) {
    const testCase = byId.get(patch.caseId);
    if (testCase) setExistingFixturePath(testCase.payload, patch.pointer, patch.descriptor);
  }
  return display;
}

const supply_test_data: BrainTool = {
  name: "supply_test_data",
  description:
    "原子补全已生成测试用例。支持：values 批量替换已存在的顶层字段；case_payloads 按 case_id 替换完整嵌套 JSON；path_values 用 JSON Pointer 修改已存在路径；binary_files 只接受当前任务预先上传的 asset_id；synthetic_resumes 由服务器生成当前 tenant/domain/conversation 隔离的合成 PDF 简历，优先用于无需真实个人资料的沙箱跑通。原文件和合成文件内容都不进入模型/聊天。values 不能和高级通道混用。任何成功修改都会作废旧沙箱/签核并要求重新批准。凭证禁止进入聊天或 fixture，只能在服务器 integration profile 中配置 *_env 引用；发现凭证字段时返回 next=ask_user。",
  parameters: params({
    values: { type: "object", minProperties: 1, additionalProperties: true, description: "用户批准的 sandbox-safe {顶层字段名:测试值}。只替换 payload 已有字段；不得包含凭证。" },
    case_payloads: {
      type: "array", minItems: 1, maxItems: 50,
      description: "按精确 case_id 替换完整嵌套 JSON payload；用于新增/删除字段。",
      items: {
        type: "object", additionalProperties: false,
        properties: { case_id: { type: "string", minLength: 1, maxLength: 128 }, payload: { type: "object", additionalProperties: true } },
        required: ["case_id", "payload"],
      },
    },
    path_values: {
      type: "array", minItems: 1, maxItems: 200,
      description: "按精确 case_id 和 JSON Pointer 替换已存在的嵌套值；不会静默创建路径。",
      items: {
        type: "object", additionalProperties: false,
        properties: { case_id: { type: "string", minLength: 1, maxLength: 128 }, path: { type: "string", minLength: 2, maxLength: 1024 }, value: {} },
        required: ["case_id", "path", "value"],
      },
    },
    binary_files: {
      type: "array", minItems: 1, maxItems: 16,
      description: "绑定当前任务中已上传的测试文件。只传 asset_id 和摘要，绝不能把 base64/文件内容放进工具参数。as 必须明确，避免猜目标契约。",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          case_id: { type: "string", minLength: 1, maxLength: 128 },
          path: { type: "string", minLength: 2, maxLength: 1024 },
          asset_id: { type: "string", minLength: 1, maxLength: 256 },
          mime_type: { type: "string", maxLength: 255 },
          filename: { type: "string", maxLength: 255 },
          sha256: { type: "string", pattern: "^[A-Fa-f0-9]{64}$" },
          as: { type: "string", enum: ["base64_string", "data_url", "object"] },
        },
        required: ["case_id", "path", "asset_id", "as"],
      },
    },
    synthetic_resumes: {
      type: "array", minItems: 1, maxItems: 16,
      description: "由服务器生成确定性的合成 PDF 简历并绑定到当前 tenant/domain/conversation/case/path。无需上传或复制租户文件；仅是 sandbox 测试输入，不是集成证据。",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          case_id: { type: "string", minLength: 1, maxLength: 128 },
          path: { type: "string", minLength: 2, maxLength: 1024 },
          as: { type: "string", enum: ["base64_string", "data_url", "object"] },
          persona: {
            type: "object", additionalProperties: false,
            properties: {
              name: { type: "string" },
              title: { type: "string" },
              skills: { type: "array", items: { type: "string" } },
              email: { type: "string" },
              years: { type: "number" },
            },
          },
        },
        required: ["case_id", "path", "as"],
      },
    },
  }),
  async execute(args, ctx) {
    if (!ctx.testCases?.length) return { ok: false, summary: "还没 generate_test_cases——先造测试用例，再补真实数据。" };
    const schemaSecrets = scanSecretTestFields(ctx);
    if (schemaSecrets.length) {
      const question = `测试契约里出现了凭证字段（${schemaSecrets.slice(0, 6).join("、")}）。请先在服务器的 sandbox integration profile 中配置对应的 *_env 引用，再重新预检；不要把 API key、token、密码或 Cookie 粘贴到聊天或测试数据里。`;
      return {
        ok: false,
        summary: question,
        output: {
          next: "ask_user",
          reason: "test_fixture_secret_requires_server_profile",
          question,
          missing: schemaSecrets,
          options: [
            { label: "已在服务器配置", value: "已配置 sandbox integration profile，请重新预检。", recommended: true },
            { label: "还没配置", value: "还没配置，先停在这里。" },
          ],
        },
      };
    }
    const values = args.values && typeof args.values === "object" && !Array.isArray(args.values) ? args.values as Record<string, unknown> : null;
    const casePayloads = args.case_payloads === undefined ? [] : args.case_payloads;
    const pathValues = args.path_values === undefined ? [] : args.path_values;
    const binaryFiles = args.binary_files === undefined ? [] : args.binary_files;
    const syntheticResumes = args.synthetic_resumes === undefined ? [] : args.synthetic_resumes;
    if (!Array.isArray(casePayloads) || !Array.isArray(pathValues) || !Array.isArray(binaryFiles) || !Array.isArray(syntheticResumes)) {
      return { ok: false, summary: "case_payloads、path_values、binary_files、synthetic_resumes 必须是数组；没有修改任何测试数据。" };
    }
    const hasValues = Boolean(values && Object.keys(values).length);
    const hasAdvanced = casePayloads.length > 0 || pathValues.length > 0 || binaryFiles.length > 0 || syntheticResumes.length > 0;
    if (hasValues && hasAdvanced) {
      return { ok: false, summary: "values 不能和 case_payloads/path_values/binary_files 混用；请拆成一次明确的原子修改，避免覆盖顺序含糊。" };
    }
    if (casePayloads.length > 50 || pathValues.length > 200 || binaryFiles.length + syntheticResumes.length > 16) {
      return { ok: false, summary: "本次 fixture 修改项目过多（完整 payload≤50、路径≤200、文件≤16）；没有修改任何测试数据。" };
    }
    if ((binaryFiles.length || syntheticResumes.length) && (!ctx.ports?.fixtureAssets || !ctx.conversationId)) {
      const question = "当前任务没有可用的隔离测试文件读取通道。我没有接收 base64，也没有修改用例。请在当前 Agent Factory 任务中重新上传文件，再选择目标用例和字段；不要把文件内容粘贴到聊天里。";
      return { ok: false, summary: question, output: { next: "ask_user", reason: "fixture_asset_reader_unavailable", question, missing: ["tenant/domain/conversation-scoped fixture asset reader"] } };
    }
    const suppliedSensitive = hasValues || hasAdvanced
      ? findSensitiveInputPath({ values, case_payloads: casePayloads, path_values: pathValues, binary_files: binaryFiles, synthetic_resumes: syntheticResumes }, "supply_test_data.args")
      : undefined;
    if (suppliedSensitive) {
      const question = `检测到测试数据里可能含有字面凭证（位置 ${suppliedSensitive}）。我没有保存或执行它。请把凭证改为服务器 sandbox integration profile 的 *_env 引用；不要在聊天里粘贴密钥。`;
      return { ok: false, summary: question, output: { next: "ask_user", reason: "literal_secret_in_test_fixture", question, missing: [suppliedSensitive] } };
    }
    // APPLY mode — clone the entire suite, validate/apply every operation, then commit once.
    if (hasValues || hasAdvanced) {
      try {
        const original = ctx.testCases;
        const working = original.map((testCase) => ({
          ...testCase,
          // Materialize legacy global overrides before any per-case edit. New successful writes clear
          // that legacy layer so sandbox/replay cannot silently overwrite the per-case fixture again.
          payload: applyTestDataOverrides(
            cloneJsonFixture(testCase.payload, `测试用例 ${testCase.id}`) as Record<string, unknown>,
            ctx.testDataOverrides,
          ),
        }));
        const byId = fixtureCaseMap(working);
        const wholeCases = new Set<string>();
        const valueKeys = Object.keys(values ?? {});
        const patchedPaths: Array<{ caseId: string; pointer: string; descriptor: unknown }> = [];
        const pathSeen = new Map<string, Array<{ pointer: string; parts: string[] }>>();

        for (const [index, raw] of casePayloads.entries()) {
          const row = fixtureRecord(raw, `case_payloads[${index}]`, ["case_id", "payload"]);
          const testCase = exactFixtureCase(byId, row.case_id, `case_payloads[${index}]`);
          if (wholeCases.has(testCase.id)) throw new Error(`测试用例「${testCase.id}」重复提供了完整 payload。`);
          if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) throw new Error(`测试用例「${testCase.id}」的完整 payload 必须是对象。`);
          testCase.payload = cloneJsonFixture(row.payload, `测试用例 ${testCase.id} 的完整 payload`) as Record<string, unknown>;
          wholeCases.add(testCase.id);
        }

        if (values) {
          const unknownKeys = Object.keys(values).filter((key) => !working.some((testCase) => Object.prototype.hasOwnProperty.call(testCase.payload, key)));
          if (unknownKeys.length) throw new Error(`values 中这些字段不在任何测试 payload 里：${unknownKeys.join("、")}；不会静默忽略拼写错误。`);
          const safeValues = cloneJsonFixture(values, "values") as Record<string, unknown>;
          for (const testCase of working) testCase.payload = applyTestDataOverrides(testCase.payload, safeValues);
        }

        for (const [index, raw] of pathValues.entries()) {
          const row = fixtureRecord(raw, `path_values[${index}]`, ["case_id", "path", "value"]);
          const testCase = exactFixtureCase(byId, row.case_id, `path_values[${index}]`);
          const pointer = typeof row.path === "string" ? row.path : "";
          validateFixturePatchPath(pathSeen, testCase.id, pointer);
          setExistingFixturePath(testCase.payload, pointer, row.value);
          patchedPaths.push({ caseId: testCase.id, pointer, descriptor: redactedFixtureValue(row.value) });
        }

        const effectiveBinaryFiles = [...binaryFiles];
        for (const [index, raw] of syntheticResumes.entries()) {
          const row = fixtureRecord(raw, `synthetic_resumes[${index}]`, ["case_id", "path", "as", "persona"]);
          const testCase = exactFixtureCase(byId, row.case_id, `synthetic_resumes[${index}]`);
          const pointer = typeof row.path === "string" ? row.path : "";
          // Validate the destination before creating a scoped asset. The same
          // path is validated again by the common binary binding loop.
          decodeJsonPointer(pointer);
          const as = typeof row.as === "string" ? row.as : "";
          if (!new Set(["base64_string", "data_url", "object"]).has(as)) {
            throw new Error(`synthetic_resumes[${index}].as 必须明确为 base64_string、data_url 或 object。`);
          }
          if (!ctx.ports.fixtureAssets?.createSyntheticResume) {
            throw new Error("当前服务端没有接入 syntheticResumePdf fixture 创建器；不会读取或复制任何租户简历文件。");
          }
          const persona = row.persona === undefined
            ? undefined
            : fixtureRecord(row.persona, `synthetic_resumes[${index}].persona`, ["name", "title", "skills", "email", "years"]);
          const asset = await ctx.ports.fixtureAssets.createSyntheticResume({
            domainId: ctx.domain,
            conversationId: ctx.conversationId!,
            caseId: testCase.id,
            path: pointer,
            persona: persona as Parameters<NonNullable<typeof ctx.ports.fixtureAssets.createSyntheticResume>>[0]["persona"],
          });
          if (!asset || asset.provenance !== "synthetic_resume_pdf") {
            throw new Error("服务端未返回 conversation-scoped synthetic_resume_pdf fixture。");
          }
          effectiveBinaryFiles.push({
            case_id: testCase.id,
            path: pointer,
            asset_id: asset.assetId,
            mime_type: "application/pdf",
            filename: asset.filename,
            sha256: asset.sha256,
            as,
          });
        }

        let totalBinaryBytes = 0;
        const binaryDescriptors: Array<{ caseId: string; path: string; sha256: string; bytes: number; mimeType?: string; filename?: string; provenance?: string; as: string }> = [];
        for (const [index, raw] of effectiveBinaryFiles.entries()) {
          const row = fixtureRecord(raw, `binary_files[${index}]`, ["case_id", "path", "asset_id", "mime_type", "filename", "sha256", "as"]);
          const testCase = exactFixtureCase(byId, row.case_id, `binary_files[${index}]`);
          const pointer = typeof row.path === "string" ? row.path : "";
          validateFixturePatchPath(pathSeen, testCase.id, pointer);
          const asRaw = typeof row.as === "string" ? row.as : "";
          if (!new Set(["base64_string", "data_url", "object"]).has(asRaw)) throw new Error(`binary_files[${index}].as 必须明确为 base64_string、data_url 或 object。`);
          const as = asRaw as FactoryTestFixtureAssetShape;
          const assetId = typeof row.asset_id === "string" ? row.asset_id.trim() : "";
          if (!assetId) throw new Error(`binary_files[${index}].asset_id 不能为空。`);
          const asset = await ctx.ports.fixtureAssets!.readExact({
            assetId,
            domainId: ctx.domain,
            conversationId: ctx.conversationId!,
          });
          if (!asset) throw new Error("测试文件不可用（不存在、已过期或不属于当前任务）；请在当前任务重新上传。");
          if (asset.caseId !== testCase.id || asset.path !== pointer) {
            throw new Error("测试文件的 case_id/path 与上传时绑定的位置不一致；不会把文件重定向到另一个用例或字段。 ");
          }
          if (!(asset.content instanceof Uint8Array)) throw new Error("测试文件读取器没有返回字节内容。 ");
          const bytes = asset.content.byteLength;
          if (bytes === 0 || bytes > MAX_TEST_FIXTURE_BINARY_BYTES || asset.bytes !== bytes) {
            throw new Error(`测试文件大小证据不一致，或不在 1 字节到 ${MAX_TEST_FIXTURE_BINARY_BYTES / 1024 / 1024} MiB 之间。`);
          }
          const sha256 = createHash("sha256").update(asset.content).digest("hex");
          if (asset.sha256.toLowerCase() !== sha256 || (typeof row.sha256 === "string" && row.sha256.toLowerCase() !== sha256)) {
            throw new Error(`测试文件 SHA-256 不匹配（实际 ${sha256.slice(0, 12)}…），不会使用可能损坏或串错任务的文件。`);
          }
          totalBinaryBytes += bytes;
          if (totalBinaryBytes > MAX_TEST_FIXTURE_TOTAL_BINARY_BYTES) throw new Error(`本次二进制 fixture 总量超过 ${MAX_TEST_FIXTURE_TOTAL_BINARY_BYTES / 1024 / 1024} MiB。`);
          const declaredMime = validatedFixtureMime(row.mime_type, false);
          const storedMime = validatedFixtureMime(asset.mimeType, false);
          if (declaredMime && storedMime && declaredMime !== storedMime) throw new Error("测试文件 mime_type 与上传回执不一致。 ");
          const mimeType = storedMime ?? declaredMime;
          if (as === "data_url" && !mimeType) throw new Error("data_url 二进制 fixture 的上传回执必须包含 mime_type，不能猜文件类型。 ");
          const declaredFilename = validatedFixtureFilename(row.filename);
          const storedFilename = validatedFixtureFilename(asset.filename);
          if (declaredFilename && storedFilename && declaredFilename !== storedFilename) throw new Error("测试文件 filename 与上传回执不一致。 ");
          const filename = storedFilename ?? declaredFilename;
          const value: FactoryTestFixtureAssetBinding = {
            schema: FACTORY_TEST_FIXTURE_ASSET_SCHEMA,
            assetId: asset.assetId,
            conversationId: ctx.conversationId!,
            sha256,
            bytes,
            expiresAt: asset.expiresAt,
            as,
            ...(mimeType ? { mimeType } : {}),
            ...(filename ? { filename } : {}),
            ...(asset.provenance ? { provenance: asset.provenance } : {}),
          };
          setExistingFixturePath(testCase.payload, pointer, value);
          const descriptor = { fixture: "binary_asset", sha256, bytes, ...(mimeType ? { mime_type: mimeType } : {}), ...(filename ? { filename } : {}), ...(asset.provenance ? { provenance: asset.provenance } : {}) };
          patchedPaths.push({ caseId: testCase.id, pointer, descriptor });
          binaryDescriptors.push({ caseId: testCase.id, path: pointer, sha256, bytes, ...(mimeType ? { mimeType } : {}), ...(filename ? { filename } : {}), ...(asset.provenance ? { provenance: asset.provenance } : {}), as });
        }

        const totalJsonBytes = working.reduce((sum, testCase) => sum + jsonFixtureBytes(testCase.payload), 0);
        if (totalJsonBytes > MAX_TEST_FIXTURE_TOTAL_JSON_BYTES + totalBinaryBytes * 2) {
          throw new Error(`本次测试 JSON（不含二进制额度）总量超过 ${MAX_TEST_FIXTURE_TOTAL_JSON_BYTES / 1024 / 1024} MiB。`);
        }
        const touchedCaseIds = working.filter((testCase, index) => JSON.stringify(testCase.payload) !== JSON.stringify(original[index]!.payload)).map((testCase) => testCase.id);
        if (!touchedCaseIds.length) throw new Error("提供的数据没有改变任何测试用例。请检查 case_id、路径和值。 ");
        const suiteDigest = fixtureDigest(working.map((testCase) => ({ id: testCase.id, payload: testCase.payload })));
        const displayCases = redactedTestCasesForApproval(working, wholeCases, valueKeys, patchedPaths);

        ctx.testCases = working;
        ctx.testDataOverrides = undefined;
        ctx.awaitingClarify = false;
        ctx.clarifyPrompt = undefined;
        ctx.awaitingApproval = true;
        ctx.testDataSupplementPending = false;
        ctx.testCoverageWaiver = undefined;
        ctx.lastSandbox = null;
        ctx.sandboxDesignReview = undefined;
        ctx.emit({ t: "test.cases", cases: displayCases, awaitingApproval: true, coverage: ctx.testCoverage });
        return {
          ok: true,
          summary: `已原子更新 ${touchedCaseIds.length} 条测试用例（测试集摘要 ${suiteDigest.slice(0, 12)}…）。原沙箱证据和设计签核已作废；请重新审查并批准这批用例，批准前不会创建 Inngest App。`,
          output: {
            touchedCaseIds,
            suiteDigest,
            valueKeys,
            wholePayloadCaseIds: [...wholeCases],
            patchedPaths: patchedPaths.map((patch) => ({ caseId: patch.caseId, path: patch.pointer })),
            binaryFiles: binaryDescriptors,
            awaitingApproval: true,
          },
        };
      } catch (error) {
        return { ok: false, summary: `测试数据未修改：${String((error as Error).message ?? error).slice(0, 500)}` };
      }
    }
    // SCAN + ASK mode — find real-data fields still on placeholders and park for the user's values.
    const needs = scanRealDataNeeds(ctx);
    if (!needs.length) {
      if (ctx.testDataSupplementPending) {
        ctx.testDataSupplementPending = false;
        ctx.awaitingApproval = true;
        ctx.emit({ t: "test.cases", cases: ctx.testCases, awaitingApproval: true, coverage: ctx.testCoverage });
      }
      return { ok: true, summary: "没有需要补充的联系/ID 类 sandbox 测试字段——可沿用当前用例，但仍需重新审查批准后才能运行沙箱。", output: { needs: [], awaitingApproval: ctx.awaitingApproval === true } };
    }
    const lines = needs.map((n) => `· ${n.field}${n.sample ? `（现为占位「${n.sample}」）` : ""} — 用于 ${n.agents.join("、")}`).join("\n");
    const question = `这些联系/ID 字段仍是占位值：\n${lines}\n如需覆盖，请只提供专用于 sandbox 的测试邮箱、回调地址或测试 ID，不要提供真实个人数据，更不要粘贴 API key/token/password；凭证应配置在服务器 integration profile。请按「字段: 值」逐行回复，或选择沿用占位。`;
    ctx.clarifyPrompt = { question, options: [{ label: "用占位值即可", value: "用占位" }], context: "补全 sandbox 安全测试数据；回答后必须显式调用 supply_test_data 并重新审批，禁止直接写入" };
    ctx.awaitingClarify = true;
    ctx.emit({ t: "clarify", question, options: ctx.clarifyPrompt.options, context: ctx.clarifyPrompt.context, awaitingAnswer: true });
    return { ok: true, summary: `已【暂停】请用户补 ${needs.length} 个 sandbox 安全测试字段：${needs.map((n) => n.field).join("、")}。回答后必须显式重调 supply_test_data，再让用户重新批准；不会由 conductor 静默写入。`, output: { needs, awaitingAnswer: true } };
  },
};

/** describe_design_constraints (R8) — lets the brain INTROSPECT its design envelope: the real
 *  Agent actions (designed vs remaining), the available tool library, reusable skills, and the
 *  event entry/terminal set. So it reasons over the actual legal symbols instead of guessing
 *  (constrained-decoding enums exist but the model can't otherwise see them). */
const describe_design_constraints: BrainTool = {
  name: "describe_design_constraints",
  description:
    "查看你当前的设计约束与可用资源：本次 generation scope 内 actor=Agent 的动作（哪些已设计 / 还差哪些）、可用工具库（真名）、可复用技能、范围入口 / 终态。设计或选工具前想确认自己有哪些『合法符号』可用时调它——避免脑补不存在或范围外的动作 / 工具 / 事件。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    const agentActions = generationScopedAgentActionNames(ctx);
    const done = new Set(ctx.specs.map((s) => s.actionName));
    const designed = agentActions.filter((name) => done.has(name)).length;
    const graph = compileGraph(
      generationAcceptanceOntology(ctx).actions,
      { domainId: ctx.domain },
    );
    return {
      ok: true,
      summary: `本次约束：${agentActions.length} 个 Agent 动作（已设计 ${designed}）· 工具库 ${ctx.toolCatalog?.length ?? 0} 个 · 范围入口事件 ${graph.entryEvents.length} · 技能 ${ctx.createdSkills.length}`,
      output: {
        agent_actions: agentActions.map((n) => ({ name: n, designed: done.has(n) })),
        available_tools: ctx.toolCatalog ?? [],
        created_skills: ctx.createdSkills.map((s) => ({ name: s.name, decisionRule: s.decisionRule })),
        entry_events: graph.entryEvents,
        terminal_events: graph.terminalEvents,
        note: "事件名 / 动作名 / 字段名 / 工具名只能用这里列出的真实符号，别发明；缺工具或缺信息就 ask_user。",
      },
    };
  },
};

/** create_mock_agent (R11) — when a real external platform's API isn't in the tool library (or
 *  has no key), generate a SYNTHETIC agent that SIMULATES it so the sandbox can run the chain
 *  end-to-end instead of degrading/stalling. Because the runtime is declarative (the agent
 *  reasons per its prompt), a mock is just an agent whose prompt says "simulate <platform>:
 *  produce a representative <emit> payload". Honestly named 模拟<platform>; not in the ontology,
 *  so it doesn't affect coverage and can be excluded from a production promote. */
const create_mock_agent: BrainTool = {
  name: "create_mock_agent",
  description:
    "为某个外部平台 / 服务造一个【模拟 agent】，让沙箱把链路跑通（真实外部 API 不在工具库、或没有真实 key 时）。它消费外发事件、产出该平台会回传的事件，prompt 写成『模拟 <平台>：按契约产出代表性 payload』。诚实标注为 mock，不算本体动作。",
  parameters: params(
    {
      user_confirmed: { type: "boolean", description: "【结构性前置】必须为 true 且【只有在用户明确同意用模拟桩之后】才允许传 true（先 ask_user 给出真实接入/模拟/去掉三选项）。未确认就调用会被拒绝。" },
      platform: { type: "string", description: "被模拟的外部平台 / 服务名（如 RoboHire、Email、企业微信）" },
      trigger: { type: "array", items: { type: "string" }, description: "它消费的事件（外发给该平台的事件）" },
      emit: { type: "array", items: { type: "string" }, description: "它产出的事件（该平台会回传的事件）" },
      system_prompt: { type: "string", description: "（可选）自定义模拟逻辑；不填则自动生成" },
    },
    ["platform", "trigger", "emit"],
  ),
  async execute(args, ctx) {
    if (process.env.NODE_ENV !== "test") {
      return {
        ok: false,
        summary: "create_mock_agent 仅供隔离单元测试使用。真实构建必须接入可调用的工具、接口与凭证；缺失时应明确阻断交付。",
      };
    }
    const platform = String(args.platform ?? "").trim();
    const trigger = Array.isArray(args.trigger) ? (args.trigger as string[]).map(String).filter(Boolean) : [];
    const emit = Array.isArray(args.emit) ? (args.emit as string[]).map(String).filter(Boolean) : [];
    if (!platform || !trigger.length || !emit.length) return { ok: false, summary: "platform / trigger / emit 都必填。" };
    // #AUDIT-FIX(L31) — 「先问用户再造桩」从 prompt 散文升级为结构闸（与 stageAdmission 同款
    // 原则：顺序由结构强制）。要求 user_confirmed=true 且 askedQuestions 里存在一条已答的、
    // 提及该平台的澄清记录——两个证据都在才放行。
    if (args.user_confirmed !== true) {
      return { ok: false, summary: `未经用户确认不能造模拟桩。先 ask_user 给出三选项（① 接入真实 ${platform} / ② 先用模拟桩跑通 / ③ 去掉该环节），用户明确选择模拟后，再带 user_confirmed:true 重新调用。` };
    }
    const platformAsked = Object.entries(ctx.askedQuestions ?? {}).some(([q, a]) => a && a !== "" && (q.includes(platform.toLowerCase().replace(/[^a-z0-9一-鿿]/g, "")) || q.includes("模拟") || q.includes("mock")));
    if (!platformAsked) {
      return { ok: false, summary: `没有找到与「${platform}」相关的已答澄清记录——user_confirmed 必须以真实的 ask_user 确认为前提，不能自行断言。先 ask_user 征求用户选择。` };
    }
    const actionName = `mock_${kebab(platform).replace(/-/g, "_")}`;
    const sp = String(args.system_prompt ?? "").trim() || `你在沙箱里【模拟外部平台「${platform}」】：收到 ${trigger.join(" / ")} 后，按事件契约产出代表性的 ${emit.join(" / ")} payload（真实感数据，字段对齐 event_data），让事件链能端到端跑通。这是模拟桩，不是真实集成。`;
    const spec: GeneratedAgentSpec = {
      key: actionName, actionName, slug: `${domainPrefix(ctx.domain)}-${kebab(actionName)}`, short: `Mock${pascal(platform)}Agent`, domainId: ctx.domain, nameZh: `模拟${platform}`, kind: "llm",
      trigger, emit, tools: [], unresolvedTools: [], objects: [], systemPrompt: sp, userPrompt: "",
      steps: [], ruleRefs: [], retries: 1, hitl: false, confidence: 0.6, promptSource: "llm",
      inputSchema: eventFieldsOf(trigger, ctx.ontology), outputSchema: eventFieldsOf(emit, ctx.ontology),
    };
    spec.generatedCode = specToAgentCode(spec);
    spec.codeSource = "render";
    ctx.specs = ctx.specs.filter((s) => s.actionName !== actionName);
    ctx.specs.push(spec);
    ctx.lastSandbox = null;
    ctx.emit({ t: "agent.created", spec: cardOf(spec), design: designOf(spec), forAgent: spec.actionName });
    // #C: record a "needs real integration" punch-list item — a mock closes the sandbox chain but
    // isn't deployable, so surface exactly what the FDE must wire post-generation.
    await ctx.ports.reflection.record(ctx.domain, { summary: `需要真实集成：${platform}（当前用模拟桩 ${spec.slug} 让链路跑通）`, lesson: `「${actionName}」依赖外部平台「${platform}」。晋升前需：① 在工具库接入 ${platform} 的真实工具（或 create_tool 包装其 HTTP API），② 提供其凭证/配置(env/config)，③ 把模拟桩 ${spec.slug} 换成真实 agent。`, failedStep: `external_integration_pending:${platform}`, kind: "caveat" });
    ctx.emit({ t: "reflect", kind: "caveat", lesson: `⚠ 待补真实集成：${platform}（${actionName} 现为模拟桩，晋升前需接入真实工具+凭证）` });
    return { ok: true, summary: `已造模拟外部平台 agent「模拟${platform}」(${trigger.join("/")} → ${emit.join("/")})——沙箱可借它跑通链路（标注 mock，可在晋升时排除）。⚠ 已记入待办：晋升前需为 ${platform} 接入真实工具+凭证。`, output: { slug: spec.slug, mock: true, needsRealIntegration: platform } };
  },
};

// ── 领域分析报告（正式产物，走 reportGenerator agent 管线，不在聊天里手写 HTML）──────────
const generate_report: BrainTool = {
  name: "generate_report",
  description:
    "为当前业务域生成一份正式的 Ontology 领域分析报告：走 reportGenerator agent 管线（结构化断链/规则覆盖/数据模型分析 + 确定性 SVG 图表），产出可下载的 HTML/PDF 文件（右上「后台任务」面板可见进度与下载）。用户在聊天里要「分析本体 / 生成分析报告」时用这个。绝不要自己在聊天里手写整份 HTML 报告；也不要调用 report.htmlToPdf / viz.svgChart / fs.writeHtmlToArchive——那些是给生成的 agent 绑定的运行时工具，不是你的工具。",
  parameters: params(
    {
      format: { type: "string", enum: ["html", "pdf", "both"], description: "产物格式；默认 html（pdf 需要本机 Chrome）" },
      focus: { type: "string", description: "分析重点（可选），如：事件链断点与规则覆盖" },
    },
    [],
  ),
  async execute(args, ctx) {
    const runner = ctx.ports.report;
    if (!runner) return { ok: false, summary: "报告管线未接入（ports.report 未配置）。告诉用户：可在右上「后台任务」面板手动点「报告」生成。不要手写 HTML 代替。" };
    let format = ["html", "pdf", "both"].includes(String(args.format)) ? (String(args.format) as "html" | "pdf" | "both") : "html";
    // 意图兜底：用户目标/意图门里提到 PDF，但模型没传 format=pdf/both（常见）——按意图升级为 both，
    // 免得"要 PDF 却只出 HTML"。（PDF 需要本机 Chrome；缺时 report-jobs 会诚实降级为 HTML + note。）
    if (format === "html") {
      const wantsPdf = /pdf|PDF/.test(`${ctx.userIntent ?? ""} ${ctx.goal ?? ""} ${String(args.focus ?? "")}`);
      if (wantsPdf) format = "both";
    }
    const focus = typeof args.focus === "string" && args.focus.trim() ? args.focus.trim().slice(0, 300) : undefined;
    // #BLUEPRINT — if a blueprint was built this run, ship it INSIDE the report (HTML/PDF) as an
    // appended ontology-grounded section, reusing its already-rendered deterministic SVGs.
    const extraHtml = ctx.lastBlueprint ? renderBlueprintReportSection(ctx.lastBlueprint) : undefined;
    let job: { id: string };
    try {
      job = await runner.start({ domain: ctx.domain, format, focus, ...(extraHtml ? { extraHtml } : {}) });
    } catch (e) {
      return { ok: false, summary: `报告任务启动失败：${(e as Error).message}` };
    }
    ctx.emit({ t: "message", text: `📊 领域分析报告开始生成（${format.toUpperCase()}${focus ? ` · 重点：${focus}` : ""}）——进度见右上「后台任务」面板。` });
    // Brief inline wait: a typical job lands in 30-60s, so fast runs hand back download links in
    // the same turn; slow ones degrade to "继续，后台完成后可下载" instead of blocking the brain.
    const deadline = Date.now() + 90_000;
    let lastPhase = "";
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const st = await runner.status(job.id);
      if (!st) return { ok: false, summary: `报告任务 ${job.id} 的持久化状态不存在，不能继续声称任务在运行。` };
      if (st.phase && st.phase !== lastPhase) {
        lastPhase = st.phase;
        ctx.emit({ t: "message", text: `⏳ ${st.phase}…` });
      }
      if (st.status === "error") return { ok: false, summary: `报告生成失败：${st.error ?? "未知错误"}` };
      if (st.status === "done") {
        const links = st.artifacts.map((a) => `${a.label} → /v1/artifacts/${a.id}`).join("；");
        return {
          ok: true,
          summary: `报告已生成${st.title ? `「${st.title}」` : ""}：${links}${st.note ? `（${st.note}）` : ""}。告诉用户：在右上「后台任务」面板点击下载即可，不必贴出报告全文。【重要】你没有读过报告正文——转述时只说标题/下载位置/审校状态，绝不要编造报告的章节目录或内容摘要（如"漏斗/图谱/热力图"这类正文里可能根本不存在的东西）。`,
          output: { jobId: job.id, title: st.title, artifacts: st.artifacts, note: st.note },
        };
      }
    }
    return { ok: true, summary: `报告仍在后台生成（任务 ${job.id}）——完成后出现在右上「后台任务」面板，用户可随时下载。你可以继续其它工作，不用等待。【重要】你没有也不会读到报告正文——之后向用户转述时只说任务状态与下载位置，绝不要编造报告内容/目录。`, output: { jobId: job.id, background: true } };
  },
};

type RevisionInputPatch = NonNullable<OntologyRevisionPatch["inputs"]>[number];
type RevisionOutputPatch = NonNullable<OntologyRevisionPatch["outputs"]>[number];
type RevisionObjectPatch = NonNullable<OntologyRevisionPatch["objects"]>[number];
type RevisionEventPatch = NonNullable<OntologyRevisionPatch["events"]>[number];
type RevisionApplied = ReturnType<typeof applyOntologyRevision>["applied"][number];
type RevisionRejected = ReturnType<typeof applyOntologyRevision>["rejected"][number];

interface OntologyRevisionAtom {
  key: string;
  target: string;
  patch: OntologyRevisionPatch;
}

interface OntologyRevisionNoop {
  key: string;
  target: string;
  reason: string;
}

/** Canonical JSON is used only to decide whether a validated patch changed the
 * working candidate. Object key insertion order must not turn an equal value
 * (for example lookup_args) into a fake repair. */
function canonicalRevisionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRevisionValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalRevisionValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function revisionValueKey(value: unknown): string {
  return JSON.stringify(canonicalRevisionValue(value)) ?? "undefined";
}

function sameRevisionValue(left: unknown, right: unknown): boolean {
  return revisionValueKey(left) === revisionValueKey(right);
}

/** Readiness prose can change without changing policy identity. The key uses
 * only the machine code plus every structured scope dimension. */
function ontologyReadinessIssueKey(issue: OntologyReadinessIssue): string {
  return JSON.stringify([
    "ontology-readiness/v1",
    issue.code,
    issue.domain ?? "",
    issue.action ?? "",
    issue.event ?? "",
    issue.object ?? "",
    issue.step ?? "",
    issue.rule ?? "",
    issue.field ?? "",
  ]);
}

function revisionAtomKey(parts: unknown[]): string {
  return JSON.stringify(["ontology-revision/v1", ...parts.map(canonicalRevisionValue)]);
}

/** Split a user patch into field-level atoms. This lets a mixed object/event
 * patch report an already-equal primary key as a no-op while still considering
 * an actually new property as a candidate change. */
function ontologyRevisionAtoms(patch: OntologyRevisionPatch): OntologyRevisionAtom[] {
  const atoms: OntologyRevisionAtom[] = [];
  for (const input of patch.inputs ?? []) {
    const entries = Object.entries(input.set ?? {});
    if (!entries.length) {
      atoms.push({
        key: revisionAtomKey(["input", input.action, input.field, "empty"]),
        target: `input ${input.action}.${input.field}`,
        patch: { inputs: [{ ...input, set: {} }] },
      });
    }
    for (const [field, value] of entries) {
      const atom: RevisionInputPatch = { ...input, set: { [field]: value } };
      atoms.push({
        key: revisionAtomKey(["input", input.action, input.field, field, revisionValueKey(value)]),
        target: `input ${input.action}.${input.field}.${field}`,
        patch: { inputs: [atom] },
      });
    }
  }
  for (const output of patch.outputs ?? []) {
    const atom: RevisionOutputPatch = { ...output };
    atoms.push({
      key: revisionAtomKey(["output", output.action, output.field, "type", output.type]),
      target: `output ${output.action}.${output.field}.type`,
      patch: { outputs: [atom] },
    });
  }
  for (const object of patch.objects ?? []) {
    let hasOperation = false;
    if (object.primary_key !== undefined) {
      hasOperation = true;
      const atom: RevisionObjectPatch = { object: object.object, primary_key: object.primary_key };
      atoms.push({
        key: revisionAtomKey(["object", object.object, "primary_key", object.primary_key]),
        target: `object ${object.object}.primary_key`,
        patch: { objects: [atom] },
      });
    }
    for (const property of object.add_properties ?? []) {
      hasOperation = true;
      const atom: RevisionObjectPatch = { object: object.object, add_properties: [property] };
      atoms.push({
        key: revisionAtomKey(["object", object.object, "property", property.name, property.type ?? ""]),
        target: `object ${object.object}.properties.${property.name}`,
        patch: { objects: [atom] },
      });
    }
    if (!hasOperation) {
      atoms.push({
        key: revisionAtomKey(["object", object.object, "empty"]),
        target: `object ${object.object}`,
        patch: { objects: [{ object: object.object }] },
      });
    }
  }
  for (const event of patch.events ?? []) {
    let hasOperation = false;
    for (const field of event.add_fields ?? []) {
      hasOperation = true;
      const atom: RevisionEventPatch = { event: event.event, add_fields: [field] };
      atoms.push({
        key: revisionAtomKey(["event", event.event, "field", field.name, field.type, field.target_object ?? "", field.required ?? null]),
        target: `event ${event.event}.event_data.${field.name}`,
        patch: { events: [atom] },
      });
    }
    for (const producer of event.add_producers ?? []) {
      hasOperation = true;
      const atom: RevisionEventPatch = { event: event.event, add_producers: [producer] };
      atoms.push({
        key: revisionAtomKey(["event", event.event, "producer", producer]),
        target: `event ${event.event}.producers.${producer}`,
        patch: { events: [atom] },
      });
    }
    for (const consumer of event.add_consumers ?? []) {
      hasOperation = true;
      const atom: RevisionEventPatch = { event: event.event, add_consumers: [consumer] };
      atoms.push({
        key: revisionAtomKey(["event", event.event, "consumer", consumer]),
        target: `event ${event.event}.consumers.${consumer}`,
        patch: { events: [atom] },
      });
    }
    if (!hasOperation) {
      atoms.push({
        key: revisionAtomKey(["event", event.event, "empty"]),
        target: `event ${event.event}`,
        patch: { events: [{ event: event.event }] },
      });
    }
  }
  return atoms;
}

function buildOntologyRevisionCandidate(
  input: DomainOntology,
  patch: OntologyRevisionPatch,
): {
  ontology: DomainOntology;
  applied: RevisionApplied[];
  rejected: RevisionRejected[];
  noops: OntologyRevisionNoop[];
} {
  let ontology = input;
  const applied: RevisionApplied[] = [];
  const rejected: RevisionRejected[] = [];
  const noops: OntologyRevisionNoop[] = [];
  for (const atom of ontologyRevisionAtoms(patch)) {
    const changesEventTopology = (atom.patch.events ?? []).some((event) =>
      Boolean(event.add_producers?.length || event.add_consumers?.length));
    if (changesEventTopology) {
      rejected.push({
        target: atom.target,
        reason: "Event 的 producer/consumer 会改变真实业务路由（可能绕过人工审批或删除失败恢复路径）。请先通过 ask_user 确认，再用 AllmetaOntology API 修改权威 Ontology；运行中的工作副本不会代填。",
      });
      continue;
    }
    const result = applyOntologyRevision(ontology, atom.patch);
    rejected.push(...result.rejected);
    if (!result.applied.length) {
      if (!result.rejected.length) {
        noops.push({ key: atom.key, target: atom.target, reason: "补丁没有产生任何值变化" });
      }
      continue;
    }
    if (sameRevisionValue(ontology, result.ontology)) {
      noops.push({ key: atom.key, target: atom.target, reason: "候选值与当前 Ontology 相同" });
      continue;
    }
    ontology = result.ontology;
    applied.push(...result.applied);
  }
  return { ontology, applied, rejected, noops };
}

/** revise_ontology — a read-only proposal builder for authoritative Ontology corrections. The brain
 * supplies grounded patches for execution-binding gaps reported by read_ontology. Every patch is
 * evaluated on an isolated candidate so we can show its exact blocker delta, but that candidate is
 * NEVER assigned to ctx.ontology. The authoritative source must be updated through AllmetaOntology
 * and re-read before any readiness gate can reopen. It never invents entities or infers topology. */
const revise_ontology: BrainTool = {
  name: "revise_ontology",
  description:
    "为权威 Ontology 的执行绑定缺口整理只读修订提案（read_ontology / design_agent 报的 binding_kind、object_lookup 的 lookup_args+result_path、输出→事件字段映射、缺失的 name/type、主键等）。提案必须 grounded 在真实实体上；工具只在隔离 candidate 上逐字段校验并计算 blocker 变化，绝不修改当前工作副本，也不写 Allmeta。有效提案会明确触发 ask_user：请用户先在 AllmetaOntology 更新并让工厂重新读取，或另行确认可审计的 Allmeta 写入授权。Event producer/consumer 属于业务路由，本工具不接受。真实外部值拿不准也先 ask_user，绝不要猜。",
  parameters: params(
    {
      reasoning: { type: "string", description: "为什么这样补（一句话，含依据的真实实体）" },
      inputs: {
        type: "array",
        description: "给 Action 输入补绑定字段。set 里可含 binding_kind(event/object_lookup/secret/config/human_input/step_output)、source_object(=Object.property)、event_field、lookup_args(参数名→安全路径)、result_path、lookup_tool/integration_ref、type、required 等。",
        items: { type: "object", properties: { action: { type: "string" }, field: { type: "string" }, set: { type: "object", additionalProperties: true } }, required: ["action", "field", "set"], additionalProperties: false },
      },
      outputs: {
        type: "array",
        description: "给 Action 输出补类型：[{action, field, type}]",
        items: { type: "object", properties: { action: { type: "string" }, field: { type: "string" }, type: { type: "string" } }, required: ["action", "field", "type"], additionalProperties: false },
      },
      objects: {
        type: "array",
        description: "补对象主键/属性：[{object, primary_key?, add_properties?:[{name,type?}]}]（primary_key 必须已在该对象 properties 中）",
        items: { type: "object", properties: { object: { type: "string" }, primary_key: { type: "string" }, add_properties: { type: "array", items: { type: "object", properties: { name: { type: "string" }, type: { type: "string" } }, required: ["name"], additionalProperties: false } } }, required: ["object"], additionalProperties: false },
      },
      events: {
        type: "array",
        description: "给已有事件补明确字段：[{event, add_fields?:[{name,type,target_object?,required?}]}]。producer/consumer 会改变业务路由，本工具不接受；请先 ask_user，再通过 AllmetaOntology API 修改权威 Ontology。",
        items: { type: "object", properties: { event: { type: "string" }, add_fields: { type: "array", items: { type: "object", properties: { name: { type: "string" }, type: { type: "string" }, target_object: { type: "string" }, required: { type: "boolean" } }, required: ["name", "type"], additionalProperties: false } } }, required: ["event"], additionalProperties: false },
      },
    },
    [],
  ),
  async execute(args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology 再 revise_ontology。" };
    const patch: OntologyRevisionPatch = {
      inputs: Array.isArray(args.inputs) ? (args.inputs as OntologyRevisionPatch["inputs"]) : undefined,
      outputs: Array.isArray(args.outputs) ? (args.outputs as OntologyRevisionPatch["outputs"]) : undefined,
      objects: Array.isArray(args.objects) ? (args.objects as OntologyRevisionPatch["objects"]) : undefined,
      events: Array.isArray(args.events) ? (args.events as OntologyRevisionPatch["events"]) : undefined,
    };
    if (!patch.inputs?.length && !patch.outputs?.length && !patch.objects?.length && !patch.events?.length) {
      return { ok: false, summary: "没有可应用的补丁：inputs/outputs/objects/events 至少给一项（且要 grounded 在真实实体上）。" };
    }
    const beforeReadiness = analyzeOntologyReadiness(ctx.ontology);
    const candidate = buildOntologyRevisionCandidate(ctx.ontology, patch);
    // This normalization is intentionally narrow (for example, an unambiguous existing id
    // property may fill a missing primary_key). It never unions producer/consumer topology.
    const candidateOntology = normalizeOntologySelfConsistency(candidate.ontology).ontology;
    const proposedReadiness = analyzeOntologyReadiness(candidateOntology);
    const beforeKeys = new Set(beforeReadiness.blocking.map(ontologyReadinessIssueKey));
    const proposedKeys = new Set(proposedReadiness.blocking.map(ontologyReadinessIssueKey));
    const newBlocking = proposedReadiness.blocking
      .filter((issue) => !beforeKeys.has(ontologyReadinessIssueKey(issue)))
      .map((issue) => ({ key: ontologyReadinessIssueKey(issue), ...issue }));
    const removedBlocking = beforeReadiness.blocking
      .filter((issue) => !proposedKeys.has(ontologyReadinessIssueKey(issue)))
      .map((issue) => ({ key: ontologyReadinessIssueKey(issue), ...issue }));
    const proposalReady = candidate.applied.length > 0
      && candidate.rejected.length === 0
      && newBlocking.length === 0
      && removedBlocking.length > 0;
    const rejNote = candidate.rejected.length
      ? ` · ⚠ ${candidate.rejected.length} 项被拒（引用不存在/非法值，未应用）：${candidate.rejected.slice(0, 3).map((r) => `${r.target}—${r.reason}`).join("；")}${candidate.rejected.length > 3 ? "…" : ""}`
      : "";
    const failureReasons = [
      candidate.applied.length === 0 ? "没有实际变化（相同值只记为 no-op）" : "",
      candidate.rejected.length ? `有 ${candidate.rejected.length} 个拒绝项，原子补丁整体回滚` : "",
      newBlocking.length ? `候选新增了 ${newBlocking.length} 个 blocker` : "",
      removedBlocking.length === 0 ? "候选没有移除任何旧 blocker" : "",
    ].filter(Boolean);
    const question =
      "我已经把建议修订和影响整理出来，但没有修改当前工作副本，也没有写入 Allmeta。" +
      "请先在 AllmetaOntology 更新后告诉我“已更新，请重读”；如果希望由 Agent 工厂提交，" +
      "需要先提供并确认可审计、限定 tenant/domain 的 Allmeta 写入授权。";
    return {
      ok: false,
      summary: proposalReady
        ? `已整理 ${candidate.applied.length} 处权威 Ontology 修订提案：预计移除 ${removedBlocking.length} 个 blocker，且不新增 blocker；候选阻塞 ${beforeReadiness.blocking.length} → ${proposedReadiness.blocking.length}。${question}`
        : `修订提案未通过校验：${failureReasons.join("；") || "未满足单调修复条件"}。当前工作副本和 readiness 保持不变，也没有发送 ontology.heal。${rejNote}`,
      output: {
        ...(proposalReady ? {
          next: "ask_user" as const,
          reason: "authoritative_ontology_update_required",
          question,
          missing: ["authoritative_ontology_corrections"],
        } : {
          reason: "ontology_revision_proposal_invalid",
        }),
        committed: false,
        proposalReady,
        applied: [],
        candidateChanges: candidate.applied,
        rejected: candidate.rejected,
        noops: candidate.noops,
        new: newBlocking,
        removed: removedBlocking,
        newBlocking,
        removedBlocking,
        blockingBefore: beforeReadiness.blocking.length,
        blockingAfter: beforeReadiness.blocking.length,
        proposedBlockingAfter: proposedReadiness.blocking.length,
        ready: beforeReadiness.ready,
        candidateReady: proposedReadiness.ready,
      },
    };
  },
};


// #DELIVERY-BUNDLE (P2-8) — pack the run's evidence into ONE inspectable markdown artifact.
const delivery_bundle: BrainTool = {
  name: "delivery_bundle",
  description:
    "把本次生成的交付证据打成【一份 markdown 交付包】：Agent 清单（触发/产出/工具/代码/子agent）、静态校验、真实沙箱运行回执、回归套件结果、对外交接契约、诚实声明（模拟运行/未解析工具等保留事项绝不隐瞒）。sandbox_run 之后、finish 前后都可打包给用户/下游团队核对。",
  parameters: params({ reasoning: { type: "string", description: "为什么现在打包（一句话）" } }, []),
  async execute(_args, ctx) {
    if (!ctx.specs.filter((s) => !s.isSubAgent).length) return { ok: false, summary: "还没有已设计的 agent，没有可打包的交付物。" };
    const bundle = buildDeliveryBundle(ctx);
    const capped = bundle.length > 24_000 ? bundle.slice(0, 24_000) + "\n…（超长截断）" : bundle;
    ctx.emit({ t: "message", text: "📦 交付包已生成（完整内容见本工具的输出面板）。" });
    return { ok: true, summary: "交付包已生成——完整 markdown 在 output 里；转述给用户时说明打包了哪几节即可，别整包贴进聊天。", output: { bundle: capped } };
  },
};

// ---------------------------------------------------------------- build_blueprint (#BLUEPRINT)
function anchorList(items: Array<{ id?: string; name?: string }> | undefined, cap = 80): string {
  return (items ?? []).slice(0, cap).map((i) => `${i.id ?? i.name}${i.name && i.name !== i.id ? `(${i.name})` : ""}`).join(" · ") || "（无）";
}

// #BLUEPRINT-SCOPE — scopeActions 非空 = 用户只要这几个动作的图。此时【动作清单按范围裁剪】：
// 模型看不到范围外的动作，就不会给它们出 phase。实体/规则/事件仍列全量——范围内的动作要读写
// 它们、要引上下游事件做上下文，裁掉会让蓝图缺证据（这也是为什么不能简单粗暴地整体过滤）。
// 注意 focus 只是【视角提示】，从来不裁剪任何东西；范围要靠 scopeActions 表达。
function buildOntologyDigestForBlueprint(ont: { objects?: Array<{ id?: string; name?: string }>; actions?: Array<{ id?: string; name?: string }>; rules?: Array<{ id?: string; name?: string }>; events?: Array<{ id?: string; name?: string }> }, focus?: unknown, understanding?: string, scopeActions?: string[]): string {
  const scoped = (scopeActions ?? []).filter(Boolean);
  const inScope = new Set(scoped);
  const actionsForDigest = scoped.length
    ? (ont.actions ?? []).filter((a) => inScope.has(String(a.name ?? a.id ?? "")))
    : ont.actions;
  const parts = [
    `实体(entity): ${anchorList(ont.objects)}`,
    `动作(action): ${anchorList(actionsForDigest)}`,
    `规则(rule): ${anchorList(ont.rules)}`,
    `事件(event): ${anchorList(ont.events)}`,
  ];
  // Reuse the four-dimension specialist digest (objects/rules/actions/events) as the
  // evidence base so the blueprint reasons FROM the already-grounded understanding,
  // not a cold read. Kept as prior context; anchors still bind to the id lists above.
  if (typeof understanding === "string" && understanding.trim()) parts.unshift(`【本体理解（四维分治结论，作为推理证据）】${understanding.slice(0, 1400)}`);
  if (typeof focus === "string" && focus.trim()) parts.unshift(`【重点视角】${focus.trim()}`);
  if (scoped.length) {
    parts.unshift(`【本次范围】只画这些动作：${scoped.join("、")}。上面的动作清单已按此范围裁剪——只为这些动作出 phase。其它动作不在本次范围内，不要为它们单独出 phase（可以在必要时把它们的事件当作上下游背景提一句）。`);
  }
  parts.push("锚点只能引用上面出现过的 id，逐字照抄，不得改写或编造。");
  return parts.join("\n");
}

function coerceAnchors(raw: unknown): OntologyAnchor[] {
  if (!Array.isArray(raw)) return [];
  const out: OntologyAnchor[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const kind = String((a as { kind?: unknown }).kind ?? "");
    const id = String((a as { id?: unknown }).id ?? "").trim();
    if (!id || !["entity", "action", "rule", "event"].includes(kind)) continue;
    out.push({ kind: kind as OntologyAnchor["kind"], id, evidence: typeof (a as { evidence?: unknown }).evidence === "string" ? (a as { evidence?: string }).evidence : undefined });
  }
  return out;
}

function normalizeProposedPhases(raw: unknown): BlueprintPhase[] {
  if (!Array.isArray(raw)) return [];
  const phases: BlueprintPhase[] = [];
  raw.forEach((p, i) => {
    if (!p || typeof p !== "object") return;
    const row = p as Record<string, unknown>;
    const title = String(row.title ?? row.name ?? `阶段 ${i + 1}`).trim();
    const id = String(row.id ?? title ?? `phase-${i + 1}`).trim() || `phase-${i + 1}`;
    const strArr = (v: unknown): string[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const out = v.map((x) => String(x).trim()).filter(Boolean);
      return out.length ? out : undefined;
    };
    const steps = Array.isArray(row.steps)
      ? row.steps.flatMap((s) => {
          if (!s || typeof s !== "object") return [];
          const sr = s as Record<string, unknown>;
          const label = String(sr.label ?? sr.name ?? "").trim();
          if (!label) return [];
          return [{ label, agent: typeof sr.agent === "string" ? sr.agent : undefined, reads: strArr(sr.reads), writes: strArr(sr.writes), emits: strArr(sr.emits), anchors: coerceAnchors(sr.anchors) }];
        })
      : [];
    phases.push({ id, title, intent: typeof row.intent === "string" ? row.intent : undefined, anchors: coerceAnchors(row.anchors), steps });
  });
  return phases;
}

const BLUEPRINT_KINDS = ["phase-flow", "sequence", "swimlane"] as const;
function dedupeKinds(raw: unknown): string[] {
  const wanted = (Array.isArray(raw) ? raw : []).map((k) => String(k).trim()).filter((k) => (BLUEPRINT_KINDS as readonly string[]).includes(k));
  const unique = [...new Set(wanted)];
  return unique.length ? unique : ["phase-flow"];
}

function renderBlueprintDiagrams(kinds: string[], model: BlueprintModel, ctx: BrainCtx): BlueprintDiagram[] {
  const out: BlueprintDiagram[] = [];
  for (const kind of kinds) {
    if (kind === "phase-flow") out.push({ kind: "phase-flow", title: `蓝图 · ${model.domain}`, svg: renderBlueprintSvg(model, "phase-flow"), rationale: "分阶段工作流总览" });
    else if (kind === "sequence") out.push({ kind: "sequence", title: `时序 · ${model.domain}`, svg: renderBlueprintSvg(model, "sequence"), rationale: "跨 agent 的事件时序" });
    else if (kind === "swimlane") {
      // Swimlane derives from the DESIGNED specs' business flow; skip (honestly) when no specs exist yet.
      const specs = (ctx as { specs?: unknown[] }).specs ?? [];
      if (!specs.length) continue;
      try {
        const flow = deriveBusinessFlow(specs as never, (ctx.ontology ?? null) as never);
        out.push({ kind: "swimlane", title: `业务流 · ${model.domain}`, svg: renderWorkflowSvg(flow), rationale: "已设计 agent 的端到端业务流泳道" });
      } catch { /* swimlane is best-effort; the grounded phases already carry the model */ }
    }
  }
  return out;
}

// #JSON-DIAG — 把 chatJson 的失败原因翻成【给大脑看的诚实说明】。三件事必须分开说，因为它们
// 的处置完全不同：①网关故障=重试（不是你的输入问题，更不该去问用户）②模型没吐 JSON=换个说法
// 重试 ③截断=收窄输入。旧版一律报成"网关空响应或格式错误"并写死 next=ask_user 强制挂起——
// 用户被问了一个自己根本答不了的问题（真实事故：build_blueprint 在 400k 上下文 + fast 档下失败）。
function describeChatJsonFailure(failure: ChatJsonFailure, what: string): { summary: string; retryable: boolean; reason: string } {
  switch (failure.kind) {
    case "llm_error":
      return {
        summary: failure.transient
          ? `${what}失败：AI 网关临时故障/过载（${failure.message.slice(0, 120)}）。这是上游波动，不是你的输入问题——可以直接原样重试。`
          : `${what}失败：调用 AI 网关出错（${failure.message.slice(0, 120)}）。这不是你的输入问题；若持续失败请如实告知用户是网关/配置问题。`,
        retryable: failure.transient,
        reason: failure.transient ? "gateway_transient" : "gateway_error",
      };
    case "empty_output":
      return { summary: `${what}失败：模型没有返回任何内容（空响应）。可以重试一次。`, retryable: true, reason: "empty_output" };
    case "no_json":
      return { summary: `${what}失败：模型返回了文字但没有可解析的 JSON（开头："${failure.sample.slice(0, 80)}"）。多半是它在解释而不是按格式输出——把要求说得更硬再试一次。`, retryable: true, reason: "no_json" };
    case "invalid_json":
      return { summary: `${what}失败：提取到的 JSON 解析不了，多半是被 max_tokens 截断（片段尾部："${failure.sample.slice(-80)}"）。缩小范围（少画点/收窄 focus）再试。`, retryable: true, reason: "invalid_json" };
  }
}

// #BLUEPRINT-DELIBERATE — per-phase kernel reasoning (cot) so the blueprint is a VISIBLE,
// step-by-step derivation FROM ontology evidence, not one hidden pass. Each phase streams a
// live reasoning.step (forAgent-labelled "蓝图·<title>") and its conclusion is kept on
// phase.deliberation for the diagram footnote + report. Budget-guarded: skipped wholesale
// when the shared tree budget is nearly spent (fail-cheap), capped to FACTORY_BLUEPRINT_MAX_DELIBERATE.
async function deliberateBlueprintPhases(model: BlueprintModel, ctx: BrainCtx, understanding?: string): Promise<number> {
  const ledger = ctx.budgetLedger;
  const remainingAt = (): number | null => (ledger?.maxTokens != null ? Math.max(0, ledger.maxTokens - ledger.tokens) : null);
  // Low-budget floor = headroom for ~5 kernel calls at the configured charge (tracks FACTORY_KERNEL_MAX_TOKENS).
  const lowBudgetFloor = kernelTokenCharge() * 5;
  const startRemaining = remainingAt();
  if (startRemaining != null && startRemaining < lowBudgetFloor) return 0; // fail-cheap: no budget for extra reasoning
  const maxPhases = Math.max(1, Number(process.env.FACTORY_BLUEPRINT_MAX_DELIBERATE) || 6);
  const cot = parseStrategyPlan("cot", { rationale: "逐阶段细化业务逻辑（从本体证据推导）", chosenBy: "ai" });
  let done = 0;
  for (const phase of model.phases) {
    if (done >= maxPhases) break;
    if (ctx.signal?.aborted) break;
    const rem = remainingAt();
    if (rem != null && rem < lowBudgetFloor) break; // budget dipped mid-loop → stop cleanly (fail-cheap)
    const phaseCtx = [
      understanding ? `本体理解（四维分治）：${understanding.slice(0, 900)}` : "",
      `本阶段锚点（只能引用这些本体真实 id）：${phase.anchors.map((a) => `${a.kind}:${a.id}`).join("、") || "（无）"}`,
      `本阶段步骤：${(phase.steps ?? []).map((s) => `${s.label}${s.agent ? `(${s.agent})` : ""}[读:${(s.reads ?? []).join(",") || "-"};写:${(s.writes ?? []).join(",") || "-"};发:${(s.emits ?? []).join(",") || "-"}]`).join(" → ") || "（无）"}`,
      ctx.userIntent ? `用户意图：${ctx.userIntent.slice(-240)}` : "",
    ].filter(Boolean).join("\n");
    const subproblem = `在上述本体证据下，逐步细化阶段「${phase.title}」的业务处理逻辑：每步读什么对象、写什么、触发哪些事件、受哪些规则约束、为什么这样安排先后。严格只引用给定锚点；本体没给的就明说“本体未提供”，绝不编造。`;
    try {
      const kernel = await runReasoning(
        { subproblem, context: phaseCtx },
        cot,
        { emit: ctx.emit, signal: ctx.signal, forAgent: `蓝图·${phase.title}`, maxLlmCalls: 2, onLlmCall: () => { if (ctx.budgetLedger) ctx.budgetLedger.tokens += kernelTokenCharge(); } },
      );
      if (kernel.final && !kernel.ambientReactOnly) { phase.deliberation = kernel.final.slice(0, 3500); done += 1; }
    } catch { /* one phase's deliberation failing must not sink the whole blueprint */ }
  }
  return done;
}

const build_blueprint: BrainTool = {
  name: "build_blueprint",
  description:
    "根据本体【逐阶段推理】梳理出分阶段(phase)的工作流/业务流/agent 蓝图：先出骨架，再对每个阶段跑一遍 cot 推理内核细化其业务逻辑（每步读什么/写什么/触发什么事件/受哪些规则约束），每阶段流一条可见 reasoning.step；最后渲染成可视化图（phase-flow 阶段流 / sequence 时序 / swimlane 业务泳道，由你按内容判断用哪种，可多张）。硬规则：每个 phase 和 step 都必须锚定本体的真实 entity/action/rule/event id，连 reads/writes/emits 明细也只保留本体真实 id；缺证据的元素进 unresolved 而【不编造】。产出内联事件 {t:'flow.blueprint'}，前端渲染；也可随后 generate_report 出蓝图报告。当用户只是想【分析/梳理/画出】本体的事件流或 agent 整体流程图（而非造可运行 agent）时，这就是该用的工具。【范围】默认画整域；用户只关心其中一部分动作时【传 actions 精确圈定】(如 [\"createJD\"])——focus 只是视角提示、不限定范围，别拿它当范围用。",
  parameters: params({
    focus: { type: "string", description: "（可选）想重点梳理的子流程或视角（自由文字，只是个视角提示，不限定范围）" },
    // #BLUEPRINT-SCOPE — 用户只要某几个动作的图时，之前【没有任何参数能表达这件事】：focus 只是
    // digest 顶部一句软提示，全量 id 清单照列，于是永远铺开整域（用户只要 createJD 却收到 6 个的
    // 来源之一）。这个参数是真的范围：动作清单按它裁剪，模型看不到范围外的动作。
    actions: { type: "array", items: { type: "string" }, description: "（可选）只画这些本体动作及其相关链路——用户只要其中一部分时【必须传】(如只要 createJD 就传 [\"createJD\"])。必须是本体里的真实动作名。不传=整域全画。" },
    diagram_kinds: { type: "array", description: "（可选）想要的图型子集：phase-flow / sequence / swimlane；不填则由你在推理里判断" },
  }),
  async execute(args, ctx) {
    if (!ctx.ontology) {
      return { ok: false, summary: "还没读本体，无法基于本体梳理蓝图。请先 read_ontology。", output: { next: "read_ontology" } };
    }
    // 网关【没配置】是真需要人去配的事 → 这才是合法的 ask_user。运行时故障不是（见下）。
    if (!isGatewayConfigured()) {
      const question = "LLM 网关未配置，无法推理蓝图。请先配置模型网关后再试。";
      return { ok: false, summary: question, output: { next: "ask_user", reason: "gateway_unconfigured", question } };
    }
    const ont = ctx.ontology as { objects?: Array<{ id?: string; name?: string }>; actions?: Array<{ id?: string; name?: string }>; rules?: Array<{ id?: string; name?: string }>; events?: Array<{ id?: string; name?: string }> };
    // #BLUEPRINT-SCOPE — 范围来源有二：① 大脑显式传的 actions ② 用户此前已声明的 partial 计划范围
    // （ctx.planScope，create_plan 设的）。②作兜底：用户都明说只要这些了，蓝图没理由再铺全域。
    const allActionNames = (ont.actions ?? []).map((a) => String(a.name ?? a.id ?? "")).filter(Boolean);
    const requested = Array.isArray(args.actions) ? args.actions.map((a) => String(a).trim()).filter(Boolean) : [];
    let scopeActions: string[] = [];
    if (requested.length) {
      const unknown = requested.filter((a) => !allActionNames.includes(a));
      // 名称对不上就【当场纠偏】（同 #3 名称纠偏范式），不静默忽略范围——静默忽略=用户又拿到全域图。
      if (unknown.length) {
        return {
          ok: false,
          summary: `actions 里有本体不存在的动作名：${unknown.join("、")}。本体真实动作只有：${allActionNames.join("、")}。用真名重试（别脑补）。`,
          output: { reason: "unknown_scope_actions", unknown, available: allActionNames },
        };
      }
      scopeActions = requested;
    } else if (ctx.planScope?.kind === "partial") {
      const missed = new Set(ctx.planScope.missedActions ?? []);
      const inScope = allActionNames.filter((a) => !missed.has(a));
      if (inScope.length && inScope.length < allActionNames.length) scopeActions = inScope;
    }
    const digest = buildOntologyDigestForBlueprint(ont, args.focus, ctx.ontologyUnderstanding, scopeActions);
    const sys =
      "你是业务流程架构师。基于给定的【权威本体】(实体/动作/规则/事件)与【本体理解】，把它梳理成分阶段(phase)的工作流蓝图【骨架】(后续每阶段还会被逐步细化推理)。" +
      "\n硬规则：" +
      "\n1) 每个 phase 和每个 step 都必须给出至少一个 ontology 锚点 anchors:[{kind,id}]，kind ∈ entity|action|rule|event，id 必须逐字取自下方本体清单里【真实存在】的 id，绝不编造。" +
      "\n2) 每个 step 尽量标注：执行它的 agent（动作名/agent 名）、reads(读哪些实体，用本体真实实体 id)、writes(写哪些实体)、emits(触发哪些事件，用本体真实事件 id)。这些明细也【只能引用本体真实 id】，编造的会被丢弃。" +
      "\n3) 每个 phase 给一句 intent 说明该阶段业务目的；按业务真实时序划分 phase——顺着本体动作/事件的真实触发链走（形如 接收→校验→处理→交付 的骨架，以本体为准，不套任何行业模板）。" +
      "\n4) 根据内容选择图型 diagram_kinds（phase-flow 适合阶段决策；sequence 适合明确事件时序；swimlane 适合已成型的多 agent 业务流）。" +
      '\n只输出 JSON：{"phases":[{"id","title","intent","anchors":[{"kind","id"}],"steps":[{"label","agent","reads":["实体id"],"writes":["实体id"],"emits":["事件id"],"anchors":[{"kind","id"}]}]}],"diagram_kinds":["phase-flow"],"reasoning":"一句话分阶段依据"}';
    // #JSON-DIAG — 失败要【说清是谁的问题】，并且【不再写死 next=ask_user】：网关过载、模型
    // 没吐 JSON、被截断，没有一个是用户能回答的问题。旧版把它们统统报成"网关空响应或格式错误"
    // 再强制挂起去问用户——用户只能干瞪眼。现在如实回报给大脑，让它自己决定重试/收窄/换路。
    let result: Awaited<ReturnType<typeof chatJsonResult<{ phases?: unknown; diagram_kinds?: unknown; reasoning?: string }>>>;
    try {
      result = await chatJsonResult<{ phases?: unknown; diagram_kinds?: unknown; reasoning?: string }>(sys, digest, { temperature: 0.3, maxTokens: 4000, signal: ctx.signal, models: modelChain("review"), purpose: "build_blueprint" });
    } catch (e) {
      // chatJsonResult 只在遥测durability故障时抛——那是真·基础设施问题，如实上报，不问用户。
      return { ok: false, summary: `蓝图推理中断（基础设施故障）：${String((e as Error).message ?? e).slice(0, 160)}。不是你的输入问题。`, output: { reason: "blueprint_infra_failure" } };
    }
    if (!result.ok) {
      const diag = describeChatJsonFailure(result.failure, "蓝图推理");
      return {
        ok: false,
        summary: `${diag.summary}${diag.retryable ? "" : " 若反复如此，请如实告诉用户这一步跑不通的原因，不要假装画出了图。"}`,
        output: { reason: `blueprint_${diag.reason}`, retryable: diag.retryable, scope: scopeActions.length ? scopeActions : "full" },
      };
    }
    const parsed = result.value;
    const index = buildOntologyAnchorIndex({ objects: ont.objects, actions: ont.actions, rules: ont.rules, events: ont.events });
    const proposal: BlueprintProposal = {
      domain: ctx.domain,
      ontologySig: (ctx as { ontologySig?: string }).ontologySig,
      phases: normalizeProposedPhases(parsed.phases),
    };
    const model = groundBlueprint(proposal, index);
    const gapNote = model.unresolved.length ? ` · ${model.unresolved.length} 项缺本体证据未接地（已如实标注，未编造）` : "";
    if (!model.phases.length) {
      ctx.lastBlueprint = model;
      ctx.emit({ t: "flow.blueprint", model: model as unknown as Record<string, unknown> });
      return { ok: false, summary: `未能生成可接地的蓝图：所有阶段都缺本体证据${gapNote}。可能是本体太稀疏或推理没锚对 id——可换 focus 再试，或先补本体。`, output: { phases: 0, unresolved: model.unresolved.length, reasoning: parsed.reasoning } };
    }
    // #BLUEPRINT-DELIBERATE — VISIBLE step-by-step reasoning: run a cot kernel per grounded phase
    // (streams a live reasoning.step each), deriving the per-step business logic FROM the ontology
    // evidence and stamping phase.deliberation. Budget-guarded; degrades to skeleton-only if spent.
    const deliberated = await deliberateBlueprintPhases(model, ctx, ctx.ontologyUnderstanding);
    const kinds = dedupeKinds(Array.isArray(args.diagram_kinds) ? args.diagram_kinds : parsed.diagram_kinds);
    model.diagrams = renderBlueprintDiagrams(kinds, model, ctx);
    ctx.lastBlueprint = model; // generate_report appends this as a blueprint section (HTML/PDF)
    ctx.emit({ t: "flow.blueprint", model: model as unknown as Record<string, unknown> });
    const delibNote = deliberated ? ` · 已逐阶段推理细化 ${deliberated} 个阶段（每阶段一条可见 reasoning.step）` : "";
    return {
      ok: true,
      summary: `蓝图已生成：${model.phases.length} 个阶段、${model.diagrams.length} 张图（${kinds.join("/")}）${delibNote}${gapNote}。前端已渲染；如需存档报告可 generate_report。`,
      output: { phases: model.phases.length, diagrams: kinds, deliberated, unresolved: model.unresolved.length, reasoning: parsed.reasoning },
    };
  },
};

export const FACTORY_TOOLS: BrainTool[] = [
  ask_user,
  ask_user_batch,
  generate_report,
  build_blueprint,
  describe_design_constraints,
  // Synthetic external-platform agents are fixture-only. Do not expose the tool to a real factory
  // brain: a mock spec must never enter an operator draft, sandbox acceptance, or promotion path.
  ...(process.env.NODE_ENV === "test" ? [create_mock_agent] : []),
  read_ontology,
  query_links,
  read_action_contract,
  inspect_action_readiness,
  inspect_all_action_readiness,
  revise_ontology,
  understand_ontology,
  capability_resolve,
  analyze_with_code,
  list_domains,
  describe_domain,
  describe_object,
  create_plan,
  critique_plan,
  design_agent,
  design_subagent,
  codegen_agent,
  refine_agent,
  revert_refine,
  validate_graph,
  propose_boundary_events,
  verify_chain,
  generate_test_cases,
  supply_test_data,
  sandbox_run,
  run_regression,
  delivery_bundle,
  inspect_run,
  read_spec,
  score_spec,
  diff_spec,
  recallConversationTool,
  review_agent,
  review_context,
  review_completeness,
  list_agents,
  web_search,
  search_tools,
  fetch_doc,
  extract_api_schema,
  create_tool,
  prepare_sandbox_evidence_plan,
  confirm_integration_profile,
  probe_tool,
  create_signed_fixture,
  create_skill,
  use_skill,
  resolve_capability_ladder,
  select_strategy,
  analyze_failure,
  save_draft,
  finish,
];

/** Test-only: the de-hardcoded rule-detection + design-time grounding helpers (#9/#B). */
export const __ruleTestHelpers = {
  ruleIdentifiers,
  promptEmbedsRule,
  ontologyActionIsRuleGate,
  resolveActionRuleReferences,
};

/** Read-only subset for sub-agents (no deploy / no mutation). */
// R9: subagents are still read-only for AGENT/tool authoring, but gain scoped SKILL authoring
// (create_skill persists to the shared store so the parent + future runs absorb it) and
// constraint introspection. spawn_subagent is added by the conductor under a depth cap.
export const SUBAGENT_TOOLS: BrainTool[] = [read_ontology, query_links, read_action_contract, list_domains, describe_domain, describe_object, list_agents, read_spec, inspect_run, web_search, search_tools, fetch_doc, extract_api_schema, analyze_failure, create_skill, resolve_capability_ladder, select_strategy, describe_design_constraints];
