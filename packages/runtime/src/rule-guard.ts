/**
 * #RULE-GATE — the runtime rule obligation guard.
 *
 * WHY THIS SHAPE, and not the `validate_action(state, action)` predicate
 * evaluator the literature describes: the authored ontology rules in this
 * product are PROSE. Measured across the two live corpora — 17 rows in
 * `models/zhaopin-v1/rules_v1.json` and 248 in `models/RAAS-v1/rules_v1.json`
 * — there is not one machine-evaluable condition field. `submissionCriteria`
 * ("系统已配置客户需求系统的登录凭证") and `standardizedLogicRule` are natural
 * language. Only a handful of fields are machine-readable: `executor`,
 * `enforcementLevel`, `failurePolicy`, `applicableClient`,
 * `applicableDepartment`, `specificScenarioStage`, `relatedEntities`.
 *
 * So this module does NOT evaluate rule semantics. It enforces the OBLIGATION
 * STRUCTURE around a guarded tool call: which rules apply here (deterministic,
 * from the rule rows' own scope fields), whether a verdict for each applicable
 * rule actually exists, and whether that verdict permits the call. Semantics
 * stay where they already are — the per-rule evaluators a tenant writes and the
 * fold that turns them into a decision.
 *
 * The trust split that makes this non-bypassable:
 *   - the rule CORPUS is server-authored (loaded from the domain's rules file at
 *     bootstrap, never from the agent's own manifest), so an agent cannot shrink
 *     the rule set that governs it;
 *   - SEVERITY is read only from the rule row (`failurePolicy` /
 *     `enforcementLevel`), never from the manifest and never defaulted, so an
 *     agent cannot downgrade a `block` rule to a warning;
 *   - the manifest declares only BINDINGS and EVIDENCE LOCATIONS — where the
 *     verdict for this call lives in the run's carried state.
 *
 * Where the ontology is silent we stay silent: a rule with neither
 * `enforcementLevel` nor `failurePolicy` is reported as `undeclared`, never
 * quietly downgraded to "harmless". That is the same honesty rule the factory's
 * ontology analysis already enforces (`rules_without_enforcement`).
 */

import { z } from "zod";

/** Severity is derived ONLY from the rule row. `undeclared` is a real state. */
export type RuleSeverity = "block" | "warn" | "undeclared";
export type RuleExecutor = "Agent" | "Human";

export interface RuleFacts {
  /** `""` when the row carries no usable identity — such a row can never be
   * selected by id, which is itself a visible authoring defect. */
  id: string;
  name?: string;
  /** `null` for a missing or malformed value. Never assumed to be "Agent":
   * assuming would hand an agent a rule a human was supposed to own. */
  executor: RuleExecutor | null;
  /** `null` means the ontology did not declare it. */
  mandatory: boolean | null;
  severity: RuleSeverity;
  stage?: string;
  client?: string;
  department?: string;
  entities?: string[];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read the machine-readable facts off one authored rule row. Tolerant by
 * design — a malformed row must stay visible as malformed rather than throw and
 * take a whole run down, because the corpus is authored by humans in a
 * spreadsheet-shaped tool.
 */
export function readRuleFacts(raw: unknown): RuleFacts {
  const rule = asRecord(raw) ?? {};
  const executor =
    rule.executor === "Agent" || rule.executor === "Human" ? rule.executor : null;

  const mandatory =
    rule.enforcementLevel === "mandatory"
      ? true
      : rule.enforcementLevel === "optional"
        ? false
        : typeof rule.mandatory === "boolean"
          ? rule.mandatory
          : null;

  // An explicit failurePolicy wins. Otherwise `mandatory` is itself a
  // declaration of strength — honouring it as blocking is reading the ontology,
  // not guessing past it. Only genuine silence yields `undeclared`.
  const severity: RuleSeverity =
    rule.failurePolicy === "block"
      ? "block"
      : rule.failurePolicy === "warn"
        ? "warn"
        : mandatory === true
          ? "block"
          : mandatory === false
            ? "warn"
            : "undeclared";

  const entities = Array.isArray(rule.relatedEntities)
    ? rule.relatedEntities.filter((e): e is string => typeof e === "string")
    : undefined;

  return {
    id: str(rule.id) ?? str(rule.uid) ?? "",
    name: str(rule.businessLogicRuleName) ?? str(rule.name),
    executor,
    mandatory,
    severity,
    stage: str(rule.specificScenarioStage) ?? str(rule.stage),
    client: str(rule.applicableClient),
    department: str(rule.applicableDepartment),
    ...(entities && entities.length > 0 ? { entities } : {}),
  };
}

/** At least one selector must be present: a gate that selects nothing is not a
 * gate, and silently matching everything would be worse. */
const RuleSelectorSchema = z
  .object({
    ids: z.array(z.string().min(1)).optional(),
    stages: z.array(z.string().min(1)).optional(),
    entities: z.array(z.string().min(1)).optional(),
  })
  .superRefine((value, ctx) => {
    const total =
      (value.ids?.length ?? 0) + (value.stages?.length ?? 0) + (value.entities?.length ?? 0);
    if (total === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "rule_gate.rules must select at least one rule by ids, stages, or entities; an empty selector is refused",
      });
    }
  });

export const RuleGateDeclarationSchema = z.object({
  /** WHICH ontology rules guard this call. Declarative — no rule id ever
   * appears in runtime code. */
  rules: RuleSelectorSchema,
  /** WHERE the verdict for those rules lives in the run's carried state, in
   * priority order (e.g. `results.ruleCheck`, `lastResult`, `event.data.x`). */
  verdict_from: z.array(z.string().min(1)).min(1),
  /** WHERE evidence of a resolved human decision lives, for `executor: "Human"`
   * rules. Absent means the agent has no way to prove it, so such a rule is
   * refused rather than self-served. */
  human_boundary_from: z.array(z.string().min(1)).optional(),
  scope: z
    .object({
      client_from: z.string().min(1).optional(),
      department_from: z.string().min(1).optional(),
      /** The corpus marks domain-wide rules with a sentinel in the same field
       * that otherwise names a client (live data uses "通用", and "N/A" for
       * department). That vocabulary is DATA, so it is declared here rather
       * than compiled into this file. With no declaration we refuse to guess:
       * an unmatched scope becomes `indeterminate`, not `excluded`. */
      universal_values: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  /**
   * `report` records findings without blocking; `enforce` blocks.
   *
   * The default is `report` deliberately. Turning a gate to `enforce` requires
   * the discharge evidence to actually be declared and produced — an authoring
   * act with business consequences. Defaulting to `enforce` would break every
   * already-deployed agent the moment this code ships, which is not a decision
   * a runtime upgrade gets to make. `report` is not silence: every finding is
   * returned and recorded, and `wouldRefuse` states plainly what an enforcing
   * gate would have stopped.
   */
  mode: z.enum(["enforce", "report"]).default("report"),
  /** What to do about a rule whose enforcement the ontology never declared.
   * Reported by default; `refuse` is available for domains that want silence
   * treated as a hard stop. */
  undeclared_enforcement: z.enum(["report", "refuse"]).default("report"),
});

export type RuleGateDeclaration = z.infer<typeof RuleGateDeclarationSchema>;
export type RuleGateMode = RuleGateDeclaration["mode"];

export type RuleScopeMatch = "applies" | "excluded" | "indeterminate";

type AxisMatch = RuleScopeMatch | "unconstrained";

function axisMatch(
  ruleValue: string | undefined,
  contextValue: string | undefined,
  universal: string[] | undefined,
): AxisMatch {
  if (!ruleValue) return "unconstrained";
  if (universal) {
    if (universal.includes(ruleValue)) return "applies";
    if (contextValue === undefined) return "indeterminate";
    return contextValue === ruleValue ? "applies" : "excluded";
  }
  // No declared universal vocabulary: a mismatch is genuinely ambiguous —
  // "腾讯" vs "通用" is a different client, but we were not told which values
  // mean "everyone". Excluding here would silently drop a governing rule.
  if (contextValue === undefined) return "indeterminate";
  return contextValue === ruleValue ? "applies" : "indeterminate";
}

export interface RuleGateContext {
  client?: string;
  department?: string;
}

/**
 * Deterministic applicability. Only axes the declaration tells us how to read
 * are evaluated — an undeclared axis is not a scoping constraint, and which
 * axes were evaluated is reported on the decision so the audit shows it.
 */
export function ruleScopeMatch(
  facts: RuleFacts,
  context: RuleGateContext,
  declaration: RuleGateDeclaration,
): RuleScopeMatch {
  const universal = declaration.scope?.universal_values;
  const axes: AxisMatch[] = [];
  if (declaration.scope?.client_from) {
    axes.push(axisMatch(facts.client, context.client, universal));
  }
  if (declaration.scope?.department_from) {
    axes.push(axisMatch(facts.department, context.department, universal));
  }
  if (axes.includes("excluded")) return "excluded";
  if (axes.includes("indeterminate")) return "indeterminate";
  return "applies";
}

/** Selection by the declaration's selectors. Pure data matching. */
export function selectApplicableRules(
  corpus: readonly unknown[],
  declaration: RuleGateDeclaration,
): RuleFacts[] {
  return selectApplicableRulesDetailed(corpus, declaration).selected;
}

/**
 * Selection, plus the selectors that matched NOTHING.
 *
 * A gate that selects zero rows out of a non-empty corpus is an authoring defect
 * — a typo, or an upstream renumber of positional-looking ids like `9-14` — and
 * reading it as "no rule governs this call" is how a gate switches itself off
 * while its record still says `applicable: []`.
 */
export function selectApplicableRulesDetailed(
  corpus: readonly unknown[],
  declaration: RuleGateDeclaration,
): { selected: RuleFacts[]; unmatchedSelectors: string[] } {
  const { ids, stages, entities } = declaration.rules;
  const selected: RuleFacts[] = [];
  const matchedIds = new Set<string>();
  const matchedStages = new Set<string>();
  const matchedEntities = new Set<string>();
  for (const raw of corpus) {
    const facts = readRuleFacts(raw);
    const byId = !!ids?.length && !!facts.id && ids.includes(facts.id);
    const byStage = !!stages?.length && !!facts.stage && stages.includes(facts.stage);
    const matchedEntity = entities?.length
      ? facts.entities?.find((e) => entities.includes(e))
      : undefined;
    if (byId) matchedIds.add(facts.id);
    if (byStage && facts.stage) matchedStages.add(facts.stage);
    if (matchedEntity) matchedEntities.add(matchedEntity);
    if (byId || byStage || matchedEntity) selected.push(facts);
  }
  const unmatchedSelectors = [
    ...(ids ?? []).filter((id) => !matchedIds.has(id)).map((id) => `id:${id}`),
    ...(stages ?? []).filter((v) => !matchedStages.has(v)).map((v) => `stage:${v}`),
    ...(entities ?? []).filter((v) => !matchedEntities.has(v)).map((v) => `entity:${v}`),
  ];
  return { selected, unmatchedSelectors };
}

export type RuleObligationStatus =
  | "satisfied"
  | "violated"
  | "not_applicable"
  | "insufficient_evidence";

export interface RuleVerdictEntry {
  ruleId: string;
  status: RuleObligationStatus;
  blocking: boolean;
  reason?: string;
}

export interface NormalizedRuleVerdict {
  entries: RuleVerdictEntry[];
  decision?: "PASS" | "FAIL";
  infraDegraded: boolean;
  /** Which producer shape this came from — useful in the audit record. */
  source: "canonical" | "audit_flags" | "fold_decision";
}

function normalizeStatus(value: unknown): RuleObligationStatus {
  switch (value) {
    case "satisfied":
      return "satisfied";
    case "violated":
      // `optional_unmet` is an unmet rule too; severity decides what that costs.
      return "violated";
    case "optional_unmet":
      return "violated";
    case "not_applicable":
      return "not_applicable";
    case "insufficient_evidence":
      return "insufficient_evidence";
    default:
      // An unrecognised status is not evidence of compliance.
      return "insufficient_evidence";
  }
}

/**
 * Accept the verdict shapes this codebase ALREADY produces, rather than
 * inventing a third vocabulary:
 *   - `persistRuleCheckAudit`'s `flags[]` (`rule_id` / `status` / `next_action`)
 *   - `foldRuleDecision`'s `{ decision, failed_rules, reason, infra_degraded }`
 *   - the canonical `{ entries[] }` shape, for a producer written against this.
 */
export function normalizeRuleVerdict(raw: unknown): NormalizedRuleVerdict | null {
  const record = asRecord(raw);
  if (!record) return null;
  const infraDegraded = record.infra_degraded === true || record.infraDegraded === true;

  if (Array.isArray(record.flags)) {
    const entries: RuleVerdictEntry[] = [];
    for (const flag of record.flags) {
      const f = asRecord(flag);
      const ruleId = f ? (str(f.rule_id) ?? str(f.ruleId)) : undefined;
      if (!f || !ruleId) continue;
      entries.push({
        ruleId,
        status: normalizeStatus(f.status),
        blocking: f.next_action === "block",
        reason: str(f.reason),
      });
    }
    return { entries, infraDegraded, source: "audit_flags" };
  }

  if (Array.isArray(record.entries)) {
    const entries: RuleVerdictEntry[] = [];
    for (const item of record.entries) {
      const e = asRecord(item);
      const ruleId = e ? str(e.ruleId) : undefined;
      if (!e || !ruleId) continue;
      entries.push({
        ruleId,
        status: normalizeStatus(e.status),
        blocking: e.blocking === true,
        reason: str(e.reason),
      });
    }
    const decision = record.decision === "PASS" || record.decision === "FAIL" ? record.decision : undefined;
    return { entries, ...(decision ? { decision } : {}), infraDegraded, source: "canonical" };
  }

  const isFold =
    record.decision === "PASS" ||
    record.decision === "FAIL" ||
    Array.isArray(record.failed_rules);
  if (isFold) {
    const reason = str(record.reason);
    const failed = Array.isArray(record.failed_rules) ? record.failed_rules : [];
    const entries: RuleVerdictEntry[] = failed
      .map((id) => str(id))
      .filter((id): id is string => !!id)
      .map((ruleId) => ({
        ruleId,
        status: "violated" as const,
        blocking: true,
        reason,
      }));
    return {
      entries,
      ...(record.decision === "PASS" || record.decision === "FAIL"
        ? { decision: record.decision }
        : {}),
      infraDegraded,
      source: "fold_decision",
    };
  }

  return null;
}

/**
 * Is this evidence of a POSITIVELY RESOLVED human decision?
 *
 * Presence at a declared path is not approval. The evidence path is read out of
 * run state that a producer or even the trigger event can populate, so `false`,
 * `0`, `""`, `"pending"`, `{resolved:false}` and `{decision:"REJECTED"}` all
 * arrive as "a value exists" — and an explicit rejection discharging a Human
 * rule is the worst possible reading. Mirrors `normalizeRuleVerdict`'s
 * strictness: an unrecognised shape is not evidence.
 */
export function isResolvedHumanBoundary(raw: unknown): boolean {
  const record = asRecord(raw);
  if (!record) return false;
  const rejected = new Set(["rejected", "denied", "declined", "refused", "no"]);
  const approved = new Set(["approved", "approve", "allow", "allowed", "yes", "ok"]);

  const decision = str(record.decision)?.toLowerCase();
  if (decision && rejected.has(decision)) return false;
  if (record.approved === false) return false;
  const status = str(record.status)?.toLowerCase();
  if (status && rejected.has(status)) return false;
  if (record.resolved === false) return false;

  // Positive signals: an explicit approval, or a resolved task attributable to a
  // person. A task id alone is not enough — a task can exist and be unresolved.
  if (record.approved === true) return true;
  if (decision && approved.has(decision)) return true;
  if (status === "resolved" || status === "approved") return true;
  if (str(record.resolvedBy) && record.resolved !== false) return true;
  return false;
}

export type RuleGateFindingKind =
  | "violated"
  | "insufficient_evidence"
  | "undeclared_enforcement"
  | "human_boundary_required"
  | "indeterminate_scope"
  | "infra_degraded"
  /** A gate is declared but the rule corpus it needs never reached the runtime. */
  | "corpus_unavailable"
  /** A declared selector matched no rule in the corpus — an authoring defect,
   * not a permission. */
  | "unresolved_rule_reference";

export interface RuleGateFinding {
  ruleId: string;
  kind: RuleGateFindingKind;
  severity: RuleSeverity;
  ruleName?: string;
  detail?: string;
}

export interface RuleGateDecision {
  allowed: boolean;
  mode: RuleGateMode;
  /** True when findings exist that an enforcing gate would have blocked on.
   * In `report` mode this is the whole point: it says what WOULD have stopped. */
  wouldRefuse: boolean;
  refusals: RuleGateFinding[];
  warnings: RuleGateFinding[];
  /** Rule ids judged applicable to this call. */
  applicable: string[];
  /** Scope axes actually evaluated, so an unscoped axis is visible in the audit. */
  scopeAxes: string[];
  verdictSource?: NormalizedRuleVerdict["source"];
  steer?: string;
}

export interface RuleGateInput {
  declaration: RuleGateDeclaration;
  /** Server-authored rule corpus for the domain. Never taken from the manifest. */
  corpus: readonly unknown[];
  context: RuleGateContext;
  /** Raw verdict payload resolved from `declaration.verdict_from`. */
  verdict?: unknown;
  /** Raw human-decision evidence resolved from `declaration.human_boundary_from`. */
  humanBoundary?: unknown;
}

const ALL_RULES = "*";

export function evaluateRuleGate(input: RuleGateInput): RuleGateDecision {
  const { declaration, corpus, context } = input;
  const verdict = normalizeRuleVerdict(input.verdict);
  const refusals: RuleGateFinding[] = [];
  const warnings: RuleGateFinding[] = [];
  const applicable: string[] = [];

  const scopeAxes: string[] = [];
  if (declaration.scope?.client_from) scopeAxes.push("client");
  if (declaration.scope?.department_from) scopeAxes.push("department");

  // A degraded rule-check pipeline that still reported PASS is exactly the
  // shape a fail-open bug takes. The tenant's own fold already fails closed on
  // this; the gate must not be more permissive than the producer.
  if (verdict?.infraDegraded) {
    refusals.push({
      ruleId: ALL_RULES,
      kind: "infra_degraded",
      severity: "block",
      detail:
        "规则检查链路已降级（infra_degraded），降级状态下的 PASS 不能作为放行依据",
    });
  }

  // A declared gate whose corpus never arrived is UNRESOLVABLE, which is not the
  // same thing as ungoverned. Returning "no gate" here is what let a declared
  // mode:"enforce" allow a blocked write in the 5 of 7 shipped model dirs that
  // ship no rules file at all.
  if (corpus.length === 0) {
    refusals.push({
      ruleId: ALL_RULES,
      kind: "corpus_unavailable",
      severity: "block",
      detail:
        "本次调用声明了规则闸门，但该域的规则语料没有到达运行时——无法判定即不放行（缺语料不等于没规则）",
    });
  }

  const { selected, unmatchedSelectors } = selectApplicableRulesDetailed(corpus, declaration);
  if (corpus.length > 0 && unmatchedSelectors.length > 0) {
    refusals.push({
      ruleId: ALL_RULES,
      kind: "unresolved_rule_reference",
      severity: "block",
      detail: `闸门声明的选择器在语料里匹配不到任何规则：${unmatchedSelectors.join("、")}——这是接线错误，不是「无规则适用」`,
    });
  }

  for (const facts of selected) {
    const scope = ruleScopeMatch(facts, context, declaration);
    if (scope === "excluded") continue;
    if (scope === "indeterminate") {
      // Undecidable applicability is graded by the rule's OWN severity: a
      // blocking rule we cannot rule out must stop the call, but a warn-level one
      // becoming a hard block would make enforce mode unusable.
      const finding: RuleGateFinding = {
        ruleId: facts.id,
        kind: "indeterminate_scope",
        severity: facts.severity,
        ruleName: facts.name,
        detail:
          "无法判定该规则是否适用于本次运行（作用域取值或运行上下文缺失）——不确定不等于不适用",
      };
      if (facts.severity === "block") refusals.push(finding);
      else warnings.push(finding);
      continue;
    }
    applicable.push(facts.id);

    // A rule the ontology assigns to a HUMAN needs human evidence — but that
    // evidence proves a person was INVOLVED, never that they said yes. So it is
    // an ADDITIONAL requirement on top of the verdict, not a replacement for it:
    // discharging on "some non-null value exists at the declared path" would let
    // an explicitly rejected human decision through with no finding at all.
    if (facts.executor === "Human" && !isResolvedHumanBoundary(input.humanBoundary)) {
      refusals.push({
        ruleId: facts.id,
        kind: "human_boundary_required",
        severity: facts.severity,
        ruleName: facts.name,
        detail:
          "该规则的 executor 是 Human——证据必须是「已解决且同意」的人工决定；仅仅在声明路径上存在一个值（false/0/空串/待处理/已驳回）都不算放行",
      });
      continue;
    }

    if (facts.severity === "undeclared") {
      const finding: RuleGateFinding = {
        ruleId: facts.id,
        kind: "undeclared_enforcement",
        severity: "undeclared",
        ruleName: facts.name,
        detail:
          "本体既没声明 enforcementLevel 也没声明 failurePolicy——按「未声明」上报，不当作无害",
      };
      if (declaration.undeclared_enforcement === "refuse") refusals.push(finding);
      else warnings.push(finding);
      continue;
    }

    const entry = verdict?.entries.find((e) => e.ruleId === facts.id);
    // Two independent authorities can say "stop", and neither may downgrade the
    // other. The ROW states the standing policy; the PRODUCER
    // (`reasoning.evaluateRules` → `persistRuleCheckAudit`) decides per case with
    // context the row does not have. zhaopin 9-15 is the live proof this matters:
    // `enforcementLevel: mandatory` + `failurePolicy: warn` yields row severity
    // `warn`, so honouring the row alone would let a computed `next_action:"block"`
    // through. A manifest still cannot downgrade either signal.
    const blocking = facts.severity === "block" || entry?.blocking === true;
    const bucket = blocking ? refusals : warnings;

    if (!entry || entry.status === "insufficient_evidence") {
      bucket.push({
        ruleId: facts.id,
        kind: "insufficient_evidence",
        severity: facts.severity,
        ruleName: facts.name,
        detail: "该规则适用于本次调用，但运行中不存在对应的规则裁决证据",
      });
      continue;
    }
    if (entry.status === "violated") {
      bucket.push({
        ruleId: facts.id,
        kind: "violated",
        severity: facts.severity,
        ruleName: facts.name,
        detail: entry.reason,
      });
    }
  }

  const wouldRefuse = refusals.length > 0;
  const allowed = declaration.mode === "enforce" ? !wouldRefuse : true;

  return {
    allowed,
    mode: declaration.mode,
    wouldRefuse,
    refusals,
    warnings,
    applicable,
    scopeAxes,
    ...(verdict ? { verdictSource: verdict.source } : {}),
    ...(wouldRefuse ? { steer: buildSteer(refusals) } : {}),
  };
}

/**
 * The refusal the model sees. It must name the rule and what is missing, so the
 * next attempt can differ — a bare "denied" produces a retry loop.
 */
function buildSteer(refusals: readonly RuleGateFinding[]): string {
  const lines = refusals.map((f) => {
    const label = f.ruleId === ALL_RULES ? "全部适用规则" : `规则 ${f.ruleId}`;
    const name = f.ruleName ? `「${f.ruleName}」` : "";
    return `- ${label}${name}：${f.kind}${f.detail ? ` — ${f.detail}` : ""}`;
  });
  return [
    "[规则闸门] 本次调用被拒绝——适用的本体规则没有得到满足的裁决证据：",
    ...lines,
    "请先完成对应的规则检查并把裁决带到本次调用的证据位置，再重试；不要绕开规则直接重复调用。",
  ].join("\n");
}

export interface OntologyRuleBindings {
  /** tool name → the rule ids the ontology attached to a step driving it. */
  byTool: Record<string, string[]>;
  /**
   * step name → rule ids, for rules-bearing steps that name NO tool.
   *
   * Measured need: RAAS `action_steps` carry no `tool` field at all (their
   * discriminator is `object_type`), so a tool-name-only derivation returns `{}`
   * for the entire domain and its rule references look orphaned. The manifest's
   * action `name` equals the ontology step's `name`, and a `type:"tool"`
   * action's dispatched tool name defaults to that action name — so this is the
   * join that makes those rules reachable at the boundary that already exists.
   * Kept separate from `byTool` because it is a name join, not a claim that the
   * ontology named a tool.
   */
  byStepName: Record<string, string[]>;
  /**
   * Rule ids the ontology attached to a step that names NO tool (a `logic`,
   * `invoke`, or manual step). No tool boundary can enforce these, so they are
   * reported rather than quietly counted as covered — in the live zhaopin
   * corpus 2 of 6 rule-bearing steps are in this state.
   */
  withoutTool: string[];
}

/**
 * Derive tool → rule bindings from the ontology's own `actions.json`.
 *
 * This is the load-bearing trust property of the whole gate: the ontology
 * ALREADY states which rules govern which tool step (`action_steps[].rules[]`
 * beside `action_steps[].tool`), and that statement is server-authored. Reading
 * it here means an agent cannot exempt itself by declining to declare a gate —
 * which it could if bindings only ever came from its own manifest.
 *
 * Tolerant of malformed input: a broken row yields no binding rather than an
 * invented one, and never throws (this runs during boot for every tenant).
 */
export function ruleBindingsFromActions(
  actions: readonly unknown[],
): OntologyRuleBindings {
  const byTool: Record<string, string[]> = {};
  const byStepName: Record<string, string[]> = {};
  const withoutTool: string[] = [];
  const seenWithoutTool = new Set<string>();

  for (const rawAction of actions) {
    const action = asRecord(rawAction);
    if (!action || !Array.isArray(action.action_steps)) continue;
    for (const rawStep of action.action_steps) {
      const step = asRecord(rawStep);
      if (!step || !Array.isArray(step.rules) || step.rules.length === 0) continue;
      const ids: string[] = [];
      for (const rawRef of step.rules) {
        const ref = asRecord(rawRef);
        const id = ref ? str(ref.id) : str(rawRef);
        if (id) ids.push(id);
      }
      if (ids.length === 0) continue;
      const tool = str(step.tool);
      if (!tool) {
        for (const id of ids) {
          if (!seenWithoutTool.has(id)) {
            seenWithoutTool.add(id);
            withoutTool.push(id);
          }
        }
        const stepName = str(step.name);
        if (stepName) {
          const named = (byStepName[stepName] ??= []);
          for (const id of ids) if (!named.includes(id)) named.push(id);
        }
        continue;
      }
      const bucket = (byTool[tool] ??= []);
      for (const id of ids) if (!bucket.includes(id)) bucket.push(id);
    }
  }
  return { byTool, byStepName, withoutTool };
}

/**
 * Coverage honesty: which mandatory/blocking rules in the corpus are bound by
 * NO declaration at all. Without this, an agent could self-exempt simply by
 * declaring no gate, and the omission would be invisible. This is the runtime
 * counterpart of the factory's `rules_without_actions` gap report.
 */
export function unboundMandatoryRules(
  corpus: readonly unknown[],
  declarations: readonly RuleGateDeclaration[],
): RuleFacts[] {
  const bound = new Set<string>();
  for (const declaration of declarations) {
    for (const facts of selectApplicableRules(corpus, declaration)) {
      if (facts.id) bound.add(facts.id);
    }
  }
  const out: RuleFacts[] = [];
  for (const raw of corpus) {
    const facts = readRuleFacts(raw);
    if (facts.severity !== "block") continue;
    if (facts.id && bound.has(facts.id)) continue;
    out.push(facts);
  }
  return out;
}
