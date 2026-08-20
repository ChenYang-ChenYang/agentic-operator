// @agentic/agent-factory — the autonomous agent-generation factory, migrated from
// the OLD single-app repo into the new monorepo (see migration-report).
//
// Migration status (M1-b in progress): pure, dependency-free logic is ported first.
// Done so far:
//   - egress-guard       SSRF / egress guard for AI-reachable outbound HTTP
//   - spec-types         GeneratedAgentSpec / IoField / ValidationReport / GenEvent …
//   - ontology-types     OntologyAction / OntologyEvent / DomainOntology …
//   - graph              compile + statically verify the event-orchestration graph
//   - contract           assemble Agent/Event contracts + reconcile payload fields
//   - ports              the 4 injected ports (the migration keystone — DI surface)
// Next (M1-c): port the brain (conductor + stream-gateway + tools) against `ports`,
// then M2 implements the ports for the new apps/api + wires the SSE route + UI tab.
// Until then the fully-working factory still runs in the OLD repo.

export * from "./egress-guard";
export * from "./conversation-archive";
export * from "./spec-types";
export * from "./ontology-types";
export * from "./graph";
export * from "./contract";
export * from "./execution-fidelity";
export * from "./execution-ownership";
export * from "./acceptance";
export * from "./verification";
export * from "./sandbox-harness";
export * from "./fixtures";
export * from "./run-analysis";
export * from "./model-router";
export * from "./codegen";
export * from "./code-lint";
export * from "./plan-projection";
export * from "./ontology-execution";
export * from "./rule-gate-authoring";
export * from "./ontology-readiness";
export * from "./ontology-references";
export * from "./input-bindings";
export * from "./declarative-tool-hash";
export * from "./declarative-tool-spec";
export * from "./declarative-tool-policy";
export * from "./decision-tables";
export * from "./coverage-waiver";
export * from "./test-case-decision";
export * from "./integration-binding";
export * from "./integration-profile";
export * from "./integration-profile-authorization";
export * from "./probe-authorization";
export * from "./authorization-challenge";
export * from "./sandbox-evidence-plan";
export * from "./human-interaction";
export * from "./generation-directive";
export * from "./action-recommendation";
export * from "./interaction-policy";
export * from "./sandbox-design-review";
export * from "./test-fixture-assets";
export * from "./sensitive-input";
export * from "./evidence-fingerprint";
export * from "./sandbox-execution-plane";
export * from "./sandbox-platform-attestation";
export * from "./sandbox-model-usage";
export * from "./sandbox-registration";
export * from "./tool-catalog";
export * from "./tool-execution-policy";
export * from "./ports";
// M1-c — the brain:
export * from "./brain-types";
export * from "./stream-gateway";
export * from "./system-prompt";
export * from "./tools";
export * from "./test-cases";
export * from "./report-verify";
export * from "./conductor";
export * from "./ontology-analysis";
export * from "./ontology-tool-requirements";
// Deterministic chart aggregates + table derivations, and the bounded
// read-only ReAct analysis loop that presents them:
export * from "./ontology-aggregates";
export * from "./ontology-tables";
// deterministic graph READS the inquiry loop dispatches: relationship edges,
// rule bodies + their step bindings, workflow entries, coverage gaps, action
// diffs. Pure functions of ONE ontology.
export * from "./ontology-graph-reads";
// The READ-ONLY tool layer (schemas + handlers closed over ONE ontology),
// shared by the prose analysis loop and by the conversation path. Exported so a
// host can build the same closure without reaching into either consumer.
export * from "./ontology-read-tools";
export * from "./ontology-inquiry";
// #INQUIRY-COMPACT — the analysis loop's fold + its conversation-bound archive
// port. Exported so a host can construct the port (bindOntologyInquiryArchive)
// without reaching into the package's internals.
export * from "./ontology-inquiry-compaction";
// #ONTOCODE-COMPREHEND — the understanding layer: per-entity content digests +
// the anchor index built from them, and the anchored-annotation pack that lets
// a prior reading of an ontology be inherited one anchor at a time.
export * from "./ontology-entity-digest";
export * from "./ontology-comprehension";
// #READINESS-LEDGER — 交付就绪账本（纯派生；持久化在 apps/api 侧）:
export * from "./delivery-readiness-ledger";
// business-flow SVG renderer (融合蓝图 P1.5 — pure swimlane visual):
export * from "./business-flow-svg";
// ontology-grounded blueprint model + deterministic SVG renderers (phase-flow / sequence):
export * from "./blueprint";
export * from "./blueprint-svg";
// #BLUEPRINT-REASON — the reasoning half of that blueprint: per-phase kernel
// derivation of what each step reads/writes/emits and which rules constrain it,
// re-grounded through `blueprint.ts` so nothing unanchored can ship.
export * from "./blueprint-reasoning";
// #P5 — capability ladder + spawnable-skill model (融合蓝图 §06):
export * from "./capability-ladder";
// #P1 — ts_function_module renderer (inngest.createFunction 形态,对标旧 AO 六文件):
export * from "./ts-function-module";
// #P2.5-Tester — 把交付形态变成可跑测试模块 + 验收判据(纯变换,执行在 apps/api):
export * from "./function-tester";
export * from "./function-test-contract";
// #P3 — 独立监督者审计 + 版本锁定缺陷(finish 门清零):
export * from "./supervisor";
// #P7 — 治理闭环纯核心(生产回归从责任工位重入,融合蓝图 §08):
export * from "./fleet-governance";
// #P0-5 — Mem0 式记忆整合(extract→ADD/UPDATE/DELETE/NOOP,复活零调用方的写路径):
export * from "./memory-consolidation";
// Human-confirmed, pin-capable domain memory (kept out of LLM consolidation):
export * from "./human-memory";
// Shared conservative STOP classifier.  API-side eager HITL persistence uses
// the same rule as the conductor so a stop command can never become a stored
// business answer merely because it arrived through a different transport.
export * from "./intent";
// #P0-6 — AWM 式技能归纳(从真实验收通过的运行沉淀可复用技能):
export * from "./skill-induction";
// #SKILL-PROMOTE (P2) — 跨域通用道晋升判定核(P7 治理巡检挂载):
export * from "./skill-promotion";
// #P1-6 — 技能导出为 Agent Skills 开放标准(SKILL.md,可带出工厂被任意 harness 复用):
export * from "./skill-export";
// #RUN-EVIDENCE (P1-1) — 大脑读【持久运行转录】的有界读路径(read_run_evidence / inspect_run 用它):
export * from "./run-evidence";
// #REASONING-KERNEL / #STRATEGY — the reasoning METHOD layer, exported narrowly
// rather than with `export *` because both modules define short, collision-prone
// names. A host (today: the OntoCode conversation path) needs exactly this much:
// the method catalogue the model is shown, the parser for what it declared, the
// server's PRIOR suggestion, and the kernel that really executes the plan.
export {
  STRATEGY_DESC,
  estimateDifficulty,
  parseStrategyPlan,
  selectStrategy,
  type Difficulty,
  type IntentKind,
  type ReasoningStrategy,
  type StrategyContext,
  type StrategyPlan,
  type StrategyStep,
} from "./reasoning-policy";
export {
  runReasoning,
  type ReasoningInput,
  type ReasoningResult,
  type ReasoningStepResult,
} from "./reasoning-kernel";
