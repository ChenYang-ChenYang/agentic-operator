import type { OntologyAction } from "./ontology-types";
import type { PlanStep } from "./spec-types";
import {
  normalizeConditionReferences,
  validateConditionSyntax,
} from "./plan-projection";

const SAFE_STEP_ID = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

export interface OntologyExecutionStep {
  /** Stable safe id that the generated plan must preserve for traceability/dataflow. */
  stepId: string;
  sourceName: string;
  kind?: string;
  /** Exact registry tool declared by this Ontology step. */
  tool?: string;
  /** Exact child Agent/function declared by this Ontology step. */
  invoke?: string;
  /** Exact event declared by this Ontology emit step. */
  emitEvent?: string;
  /** Authoritative upstream step identities that must remain dependencies. */
  dependsOn?: string[];
  /** Authoritative payload source for an explicit emit. */
  emitPayloadFrom?: string;
  condition?: string;
  description?: string;
}

export interface ExecutionPlanRequirement {
  required: boolean;
  ontologySteps: OntologyExecutionStep[];
  integrationSystems: Array<{
    name: string;
    role?: string;
    capability?: string;
  }>;
  /** Systems actually touched inside the handler. Pure trigger/consumer declarations do not
   * create an extra step.run boundary. */
  replayableIntegrationCount: number;
  dataChangeCount: number;
  notificationCount: number;
  /** Procedure prose exists without a structured execution contract. */
  unstructuredInstruction: boolean;
  reasons: string[];
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (row): row is Record<string, unknown> =>
          !!row && typeof row === "object" && !Array.isArray(row),
      )
    : [];
}

function safeStepId(raw: string, index: number): string {
  return SAFE_STEP_ID.test(raw) ? raw : `ontology-step-${index + 1}`;
}

function optionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  let candidate = value;
  if (typeof candidate === "string" && candidate.trim().startsWith("[")) {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(candidate)) return undefined;
  const values = candidate
    .map((entry) => optionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return values.length ? values : undefined;
}

function normalizedStepKind(value: string): string {
  return value.trim().toLocaleLowerCase();
}

const EXECUTABLE_PLAN_KINDS = new Set<PlanStep["kind"]>([
  "tool",
  "logic",
  "condition",
  "invoke",
  "foreach",
  "emit",
]);

/**
 * Re-apply the execution-bearing fields owned by Ontology action_steps.
 *
 * The model is allowed to fill implementation details (arguments, result maps,
 * timeouts, error policy), but it is not an authority for the identity or
 * routing semantics of a source step.  In particular, a source `logic` router
 * must stay `logic`; mutually-exclusive source emits carry their own exact DSL
 * guards; and natural-language source conditions remain provenance only and
 * are never translated into an invented predicate.
 *
 * Callers should pass the same action projection they use for validation (for
 * example, with registry aliases already canonicalized). Missing source steps
 * are intentionally not synthesized here: validation still rejects an
 * incomplete plan rather than fabricating its implementation.
 */
export function normalizePlanAgainstOntology(
  action: OntologyAction,
  plan: PlanStep[],
): PlanStep[] {
  const requirement = analyzeExecutionPlanRequirement(action);
  if (!requirement.ontologySteps.length) {
    return plan.map((step) => ({
      ...step,
      ...(step.body
        ? { body: normalizePlanAgainstOntology(action, step.body) }
        : {}),
    }));
  }

  const expectedById = new Map(
    requirement.ontologySteps.map((step) => [step.stepId, step] as const),
  );
  const priorIdsByStep = new Map<string, string[]>();
  for (let index = 0; index < requirement.ontologySteps.length; index++) {
    priorIdsByStep.set(
      requirement.ontologySteps[index]!.stepId,
      requirement.ontologySteps.slice(0, index).map((step) => step.stepId),
    );
  }

  const normalizeRows = (rows: PlanStep[]): PlanStep[] =>
    rows.map((row) => {
      const normalized: PlanStep = {
        ...row,
        ...(row.body ? { body: normalizeRows(row.body) } : {}),
      };
      const expected = expectedById.get(row.stepId);
      if (!expected) return normalized;

      const sourceKind = expected.kind
        ? normalizedStepKind(expected.kind)
        : undefined;
      if (
        sourceKind &&
        EXECUTABLE_PLAN_KINDS.has(sourceKind as PlanStep["kind"])
      ) {
        normalized.kind = sourceKind as PlanStep["kind"];
      }

      if (expected.tool !== undefined) normalized.tool = expected.tool;
      else if (normalized.kind !== "tool") delete normalized.tool;

      if (expected.invoke !== undefined) normalized.invoke = expected.invoke;
      else if (normalized.kind !== "invoke") delete normalized.invoke;

      if (expected.emitEvent !== undefined)
        normalized.emitEvent = expected.emitEvent;
      else if (normalized.kind !== "emit") delete normalized.emitEvent;

      if (expected.dependsOn !== undefined)
        normalized.dependsOn = [...expected.dependsOn];
      else delete normalized.dependsOn;

      if (expected.emitPayloadFrom !== undefined)
        normalized.emitPayloadFrom = expected.emitPayloadFrom;
      else delete normalized.emitPayloadFrom;

      if (
        expected.condition &&
        validateConditionSyntax(expected.condition) === null
      ) {
        normalized.condition = normalizeConditionReferences(
          expected.condition,
          priorIdsByStep.get(expected.stepId) ?? [],
        );
      } else {
        // No executable predicate exists in the source. This includes prose
        // such as “job_posting_id 已返回”; retaining a model-authored condition
        // here would manufacture a business threshold or branch.
        delete normalized.condition;
      }

      // Source route selectors in this contract are ordinary logic steps whose
      // selected_event is consumed by guarded emit steps. A model-proposed
      // condition.routes rewrite would change that execution contract.
      if (normalized.kind !== "condition") delete normalized.routes;

      return normalized;
    });

  return normalizeRows(plan);
}

/** Derive execution requirements only from ontology facts. There are no domain/action-name
 * allowlists here: any declared workflow steps, system boundary, mutation, or notification makes
 * a single opaque logic action an invalid production projection. */
export function analyzeExecutionPlanRequirement(
  action: OntologyAction,
): ExecutionPlanRequirement {
  const seenStepIds = new Set<string>();
  const ontologySteps = asRecords(action.action_steps).map((row, index) => {
    const sourceName = String(
      row.step_id ??
        row.stepId ??
        row.id ??
        row.name ??
        `ontology-step-${index + 1}`,
    ).trim();
    const baseId = safeStepId(sourceName, index);
    const stepId = seenStepIds.has(baseId) ? `${baseId}-${index + 1}` : baseId;
    seenStepIds.add(stepId);
    return {
      stepId,
      sourceName,
      kind: optionalString(row.type ?? row.object_type),
      tool: optionalString(row.tool),
      invoke: optionalString(row.invoke),
      emitEvent: optionalString(row.emitEvent ?? row.emit_event ?? row.event),
      dependsOn: optionalStringArray(
        row.dependsOn ?? row.depends_on ?? row.depends_on_json,
      ),
      emitPayloadFrom: optionalString(
        row.emitPayloadFrom ?? row.emit_payload_from,
      ),
      condition: optionalString(row.condition),
      description: optionalString(row.description),
    };
  });
  const integration =
    action.integration && typeof action.integration === "object"
      ? (action.integration as Record<string, unknown>)
      : {};
  const integrationSystems = asRecords(integration.systems).map((row) => ({
    name: String(row.name ?? row.system ?? "unknown"),
    role: row.role != null ? String(row.role) : undefined,
    capability: row.capability != null ? String(row.capability) : undefined,
  }));
  const sideEffects =
    action.side_effects && typeof action.side_effects === "object"
      ? (action.side_effects as Record<string, unknown>)
      : {};
  const dataChangeCount = asRecords(sideEffects.data_changes).length;
  const notificationCount = asRecords(sideEffects.notifications).length;
  const replayableIntegrationCount = integrationSystems.filter(
    (system) => !/^(triggers?|consumes?)$/i.test(system.role ?? ""),
  ).length;
  const unstructuredInstruction =
    action.actor.includes("Agent") &&
    !!action.instruction?.trim() &&
    ontologySteps.length === 0 &&
    integrationSystems.length === 0 &&
    dataChangeCount === 0 &&
    notificationCount === 0 &&
    (action.tool_use ?? []).length === 0;
  const reasons: string[] = [];
  if (ontologySteps.length > 1)
    reasons.push(
      `ontology declares ${ontologySteps.length} ordered action_steps`,
    );
  else if (
    ontologySteps.some((step) =>
      /tool|invoke|external|write|notify/i.test(step.kind ?? ""),
    )
  )
    reasons.push("ontology declares an effectful action_step");
  if (replayableIntegrationCount)
    reasons.push(
      `ontology declares ${replayableIntegrationCount} integration system boundary(s)`,
    );
  if (dataChangeCount)
    reasons.push(`ontology declares ${dataChangeCount} data mutation(s)`);
  if (notificationCount)
    reasons.push(
      `ontology declares ${notificationCount} notification side effect(s)`,
    );
  if (unstructuredInstruction)
    reasons.push(
      "action carries business instruction without structured action_steps/integration/side_effects",
    );
  return {
    required: reasons.length > 0,
    ontologySteps,
    integrationSystems,
    replayableIntegrationCount,
    dataChangeCount,
    notificationCount,
    unstructuredInstruction,
    reasons,
  };
}

/** Validate that a generated plan does not erase ontology-declared operations. Additional
 * implementation steps are allowed; the ontology step ids are the minimum traceability floor. */
export function validatePlanAgainstOntology(
  action: OntologyAction,
  plan: PlanStep[],
): string[] {
  const requirement = analyzeExecutionPlanRequirement(action);
  if (!requirement.required) return [];
  if (!plan.length) {
    return [`structured plan required: ${requirement.reasons.join("; ")}`];
  }
  const flattened = plan.flatMap(function walk(step: PlanStep): PlanStep[] {
    return [step, ...(step.body ?? []).flatMap(walk)];
  });
  const actual = new Set(flattened.map((step) => step.stepId));
  const missing = requirement.ontologySteps.filter(
    (step) => !actual.has(step.stepId),
  );
  const errors: string[] = [];
  if (missing.length)
    errors.push(
      `plan does not cover ontology action_steps: ${missing.map((step) => `${step.sourceName}→${step.stepId}`).join(", ")}`,
    );
  const actualByStepId = new Map(
    flattened.map((step) => [step.stepId, step] as const),
  );
  for (const expected of requirement.ontologySteps) {
    const projected = actualByStepId.get(expected.stepId);
    if (!projected) continue;
    if (
      expected.kind &&
      normalizedStepKind(projected.kind) !== normalizedStepKind(expected.kind)
    ) {
      errors.push(
        `ontology step ${expected.sourceName}→${expected.stepId} kind mismatch: expected ${expected.kind}, got ${projected.kind}`,
      );
    }
    if (expected.tool && projected.tool !== expected.tool) {
      errors.push(
        `ontology step ${expected.sourceName}→${expected.stepId} tool mismatch: expected ${expected.tool}, got ${projected.tool ?? "missing"}`,
      );
    }
    if (expected.invoke && projected.invoke !== expected.invoke) {
      errors.push(
        `ontology step ${expected.sourceName}→${expected.stepId} invoke mismatch: expected ${expected.invoke}, got ${projected.invoke ?? "missing"}`,
      );
    }
    if (expected.emitEvent && projected.emitEvent !== expected.emitEvent) {
      errors.push(
        `ontology step ${expected.sourceName}→${expected.stepId} emitEvent mismatch: expected ${expected.emitEvent}, got ${projected.emitEvent ?? "missing"}`,
      );
    }
    if (expected.dependsOn?.length) {
      const projectedDependencies = new Set(projected.dependsOn ?? []);
      const missingDependencies = expected.dependsOn.filter(
        (dependency) => !projectedDependencies.has(dependency),
      );
      if (missingDependencies.length) {
        errors.push(
          `ontology step ${expected.sourceName}→${expected.stepId} dependsOn mismatch: missing ${missingDependencies.join(", ")}`,
        );
      }
    }
    if (
      expected.emitPayloadFrom &&
      projected.emitPayloadFrom !== expected.emitPayloadFrom
    ) {
      errors.push(
        `ontology step ${expected.sourceName}→${expected.stepId} emitPayloadFrom mismatch: expected ${expected.emitPayloadFrom}, got ${projected.emitPayloadFrom ?? "missing"}`,
      );
    }
    if (
      expected.condition &&
      validateConditionSyntax(expected.condition) === null
    ) {
      if (!projected.condition) {
        errors.push(
          `ontology step ${expected.sourceName}→${expected.stepId} condition guard is missing`,
        );
      } else {
        const projectedSyntaxError = validateConditionSyntax(
          projected.condition,
        );
        if (projectedSyntaxError) {
          errors.push(
            `ontology step ${expected.sourceName}→${expected.stepId} condition guard is not executable: ${projectedSyntaxError}`,
          );
        }
        // Executable source predicates are authoritative runtime DSL, so
        // changing them would silently change the branch. Prose-only source
        // conditions remain readiness/review evidence; this deterministic
        // gate must not pretend it can compile equivalent code for them.
        const priorStepIds = requirement.ontologySteps
          .slice(0, requirement.ontologySteps.indexOf(expected))
          .map((step) => step.stepId);
        const canonicalExpected = normalizeConditionReferences(
          expected.condition,
          priorStepIds,
        );
        const canonicalProjected = normalizeConditionReferences(
          projected.condition,
          priorStepIds,
        );
        if (canonicalProjected !== canonicalExpected) {
          errors.push(
            `ontology step ${expected.sourceName}→${expected.stepId} condition mismatch: expected ${canonicalExpected}, got ${canonicalProjected}`,
          );
        }
      }
    } else if (
      expected.condition &&
      projected.condition &&
      validateConditionSyntax(expected.condition) !== null &&
      validateConditionSyntax(projected.condition) === null
    ) {
      // A prose-only source condition is review/provenance evidence, not a
      // predicate the generator may reinterpret. Omitting a guard is honest;
      // inventing executable DSL silently changes the Ontology's business
      // branch and must fail before codegen/runtime can compile it.
      errors.push(
        `ontology step ${expected.sourceName}→${expected.stepId} condition guard is invented/untrusted: source condition is non-executable prose (${expected.condition}), but plan supplied ${projected.condition}`,
      );
    }
  }
  const boundarySteps = flattened.filter(
    (step) => step.kind === "tool" || step.kind === "invoke",
  ).length;
  if (requirement.replayableIntegrationCount && boundarySteps === 0) {
    // This is only the early structural floor. Exact requirement→tool/runtime
    // step references are established by integration binding and rechecked by
    // acceptance; step counts are never treated as execution evidence.
    errors.push(
      `plan has no external boundary step, but ontology declares ${requirement.replayableIntegrationCount} integration system boundary(s)`,
    );
  } else if (
    !requirement.replayableIntegrationCount &&
    (requirement.dataChangeCount || requirement.notificationCount) &&
    boundarySteps === 0
  ) {
    errors.push(
      "plan declares data/notification side effects but has no tool/invoke boundary step",
    );
  }
  return errors;
}
