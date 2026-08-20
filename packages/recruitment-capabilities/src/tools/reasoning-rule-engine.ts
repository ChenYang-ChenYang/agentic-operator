import {
  defineTool,
  type TenantReasoningConfigLike,
  type ToolContext,
} from "@agentic/agent-kit";
import {
  agentRegistry,
  ensureCodeAgentBinding,
  type BaseAgent,
} from "@agentic/agents";
import "@agentic/agents/system";
import type {
  ReasoningAgentInput,
  ReasoningAgentOutput,
} from "@agentic/agents/system";
import { z } from "zod";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(text).filter(Boolean).slice(0, 30)
    : [];
}

function config(ctx: ToolContext, reasoningConfig: TenantReasoningConfigLike) {
  const raw = ctx.config ?? {};
  const domainId = reasoningConfig.ontology.domainId.trim();
  if (!domainId) {
    throw new Error(
      "reasoning.evaluateRules: trusted tenant Reasoning domain is not configured",
    );
  }
  const requestedDomain = text(raw.domainId) || text(raw.domain);
  const action = text(raw.action) || ctx.agentName;
  if (requestedDomain && requestedDomain !== domainId) {
    throw new Error(
      `reasoning.evaluateRules: domain '${requestedDomain}' is not permitted by the standalone tenant Reasoning configuration`,
    );
  }
  const scenario = text(raw.scenario) || action;
  if (!action) {
    throw new Error("reasoning.evaluateRules: config.action is required");
  }
  return {
    domainId,
    action,
    scenario,
    prompt:
      text(raw.prompt) ||
      `请针对业务场景 ${scenario} 和动作 ${action}，基于当前输入证据筛选适用规则并逐条判定。`,
    objectTypes: strings(raw.objectTypes),
    keywords: strings(raw.keywords),
    executor: text(raw.executor) || "Agent",
    ruleLimit:
      typeof raw.ruleLimit === "number"
        ? Math.min(100, Math.max(1, Math.floor(raw.ruleLimit)))
        : 40,
    passEvent: text(raw.passEvent) || "RULE_CHECK_PASSED",
    failEvent: text(raw.failEvent) || "RULE_CHECK_FAILED",
  };
}

function workflowEvidence(ctx: ToolContext): Record<string, unknown> {
  return {
    ...(ctx.event?.data ?? {}),
    ...record(ctx.lastResult),
  };
}

export function createEvaluateRulesWithReasoningAgent(
  reasoningConfig: TenantReasoningConfigLike,
) {
  return defineTool({
    name: "reasoning.evaluateRules",
    description:
      "Universal stage-independent rule engine. Nests ReasoningAgent to select rules from Allmeta, compile a scenario prompt, run QualifiedAgent assessment, and deterministically fold mandatory/optional verdicts.",
    factory: {
      category: "reasoning",
      sideEffect: "call",
      operation: "compute",
      effectScope: "external",
      sandboxPolicy: "live_external",
      argsSchema: {
        context: {
          type: "object",
          description:
            "Business object or iteration-local context to evaluate.",
        },
        facts: {
          type: "object|array",
          description:
            "Authoritative facts already loaded by an allowlisted read tool.",
        },
        rules: {
          type: "array",
          description: "Current rules fetched from the authoritative Ontology.",
        },
      },
      returnsSchema: {
        data: {
          type: "object",
          required: true,
          description:
            "Structured rule decision, per-rule results, flags, missing evidence, and terminal event.",
        },
        meta: {
          type: "object",
          required: true,
          description:
            "Nested ReasoningAgent run identity and deterministic decision metadata.",
        },
      },
      configSchema: {
        tenant_slug: { type: "string", required: true },
        domainId: { type: "string", required: true },
        action: { type: "string", required: true },
        scenario: { type: "string" },
        prompt: { type: "string" },
        objectTypes: { type: "string[]" },
        keywords: { type: "string[]" },
        executor: { type: "string" },
        ruleLimit: { type: "integer", default: 40 },
        passEvent: { type: "string", required: true },
        failEvent: { type: "string", required: true },
      },
      capabilities: [
        {
          systems: ["Allmeta_Ontology_System"],
          kinds: ["graph_db", "ontology"],
          roles: ["read", "evaluate"],
          operations: [
            "rules.select",
            "rules.evaluate",
            "graph.verify",
            "read",
          ],
          objectTypes: ["Rule", "*"],
          probeRequired: true,
        },
        {
          systems: ["LLM Gateway", "LLM 网关", "model gateway", "模型网关"],
          kinds: ["external_api", "llm", "llm_gateway", "model_gateway"],
          roles: ["call", "execute", "reason"],
          operations: [
            "reason",
            "rules.evaluate",
            "rules.judge",
            "field.semantic_equivalence",
            "invoke",
          ],
          objectTypes: ["*"],
          probeRequired: true,
        },
      ],
      profileScope: {
        exact: [
          { configKey: "tenant_slug", source: "tenantSlug" },
          { configKey: "action", source: "action" },
        ],
      },
      source: {
        modulePath:
          "packages/recruitment-capabilities/src/tools/reasoning-rule-engine.ts",
        exportName: "createEvaluateRulesWithReasoningAgent",
      },
    },
    output: z.record(z.string(), z.unknown()),
    async handler(ctx) {
      const bound = config(ctx, reasoningConfig);
      const evidence = workflowEvidence(ctx);
      const untyped = agentRegistry.get("reasoningAgent");
      if (!untyped) {
        throw new Error(
          "reasoning.evaluateRules: reasoningAgent is not registered in this process",
        );
      }
      const agent = untyped as BaseAgent<
        ReasoningAgentInput,
        ReasoningAgentOutput
      >;
      ensureCodeAgentBinding(ctx.tenantSlug, untyped);

      const input: ReasoningAgentInput = {
        prompt: bound.prompt,
        domainId: bound.domainId,
        action: bound.action,
        scenario: bound.scenario,
        inputs: evidence,
        objectTypes: bound.objectTypes,
        keywords: bound.keywords,
        executor: bound.executor,
        ruleLimit: bound.ruleLimit,
      };
      let result;
      try {
        result = await agent.run(input, {
          tenantSlug: ctx.tenantSlug,
          correlationId: `${ctx.correlationId}:reasoning:${ctx.actionName}`,
          invocationId: ctx.runId,
        });
      } catch (error) {
        const message =
          (error instanceof Error ? error.message : String(error)).slice(
            0,
            500,
          ) || "ReasoningAgent threw without an error message";
        // Infrastructure failure is not a candidate verdict. Throw so Inngest
        // applies the function's retry/park policy; emitting the business
        // failEvent here would permanently record an outage as a rejection.
        throw new Error(
          `reasoning.evaluateRules infrastructure failure: ${message}`,
          {
            cause: error,
          },
        );
      }
      if (result.status !== "ok" || !result.output) {
        throw new Error(
          `reasoning.evaluateRules nested run ${result.runId} failed: ${result.error || "ReasoningAgent returned no output"}`,
        );
      }

      const output = result.output;
      const passed =
        output.decision === "eligible" ||
        output.decision === "eligible_with_flags";
      return {
        data: {
          reasoning_rule_engine: output,
          rule_decision: output.decision,
          rule_bundle_id: output.ruleBundleId,
          rule_count: output.ruleCount,
          rule_results: output.assessments.map((assessment) => ({
            rule_id: assessment.ruleId,
            rule_name: assessment.ruleName,
            enforcement_level: assessment.enforcementLevel,
            failure_policy: assessment.failurePolicy,
            status: assessment.status,
            reason: assessment.reason,
            evidence: assessment.evidence,
            flag_only: assessment.enforcementLevel === "optional",
          })),
          rule_flags: output.flags,
          rule_missing_evidence: output.missingEvidence,
          nested_reasoning_run_id: result.runId,
          _emit: passed ? bound.passEvent : bound.failEvent,
        },
        meta: {
          nestedRunId: result.runId,
          nestedStatus: result.status,
          decision: output.decision,
          ruleBundleId: output.ruleBundleId,
        },
      };
    },
  });
}
