import { createHash } from "node:crypto";
import { canonicalEvidenceJson } from "@agentic/shared";
import type {
  DomainOntology,
  OntologyAction,
  OntologyEvent,
  OntologyLink,
} from "./ontology-types";

export type FactoryInteractionPolicy = "strict" | "autopilot";

export const FACTORY_GENERATION_DIRECTIVE_SCHEMA =
  "agent-factory-generation-directive/v1" as const;

export interface FactoryVirtualActionProvenance {
  schema: "agent-factory-virtual-action/v1";
  kind: "virtual_scenario";
  source: "factory_session_overlay";
  authoritative: false;
  scenarioHash: string;
}

export interface FactoryGenerationDirective {
  schema: typeof FACTORY_GENERATION_DIRECTIVE_SCHEMA;
  mode: "action_selection" | "scenario_match" | "virtual_scenario";
  requestedActionIds: string[];
  requestedActionNames: string[];
  /** Exact identity pairs from the authoritative start snapshot. Names remain
   * model-facing, but ids are revalidated before every read to prevent a
   * same-name Action replacement from changing the target mid-run. */
  requestedActions: Array<{ id: string; name: string }>;
  /** Hash of the authoritative base Ontology (never the virtual overlay). */
  sourceOntologyHash: string;
  /** Human-authored business scenario. It is context, never an executable
   * event/tool/permission declaration. */
  scenario?: string;
  /** Present only when the server created an in-memory Action overlay. */
  virtualAction?: OntologyAction & {
    factoryProvenance: FactoryVirtualActionProvenance;
  };
  virtualEvents?: Array<
    OntologyEvent & { factoryProvenance: FactoryVirtualActionProvenance }
  >;
  virtualLinks?: OntologyLink[];
}

/** Authoritative Agent Action universe for one Factory run. The server-issued
 * directive is already bound to an Ontology hash and may name a session-local
 * virtual Action; callers must not fall back to the full domain merely because
 * the selected set is smaller than the catalog. */
export function factoryGenerationScopedAgentActions(
  ontology: DomainOntology,
  directive?: FactoryGenerationDirective,
): OntologyAction[] {
  const agentActions = ontology.actions.filter((action) =>
    action.actor.includes("Agent"),
  );
  if (!directive) return agentActions;
  const allowed = new Set(directive.requestedActionNames);
  return agentActions.filter((action) => allowed.has(action.name));
}

export function factoryGenerationScopedAgentActionNames(
  ontology: DomainOntology,
  directive?: FactoryGenerationDirective,
): string[] {
  return factoryGenerationScopedAgentActions(ontology, directive).map(
    (action) => action.name,
  );
}

/** Graph/acceptance projection for the current generation boundary. Legacy
 * conversations without a directive preserve the complete Ontology,
 * including Human/System nodes; structured runs expose only selected Agent
 * Actions so crossings to excluded nodes become explicit external edges. */
export function factoryGenerationAcceptanceOntology(
  ontology: DomainOntology,
  directive?: FactoryGenerationDirective,
): DomainOntology {
  if (!directive) return ontology;
  return {
    ...ontology,
    actions: factoryGenerationScopedAgentActions(ontology, directive),
  };
}

export class FactoryGenerationDirectiveError extends Error {
  constructor(
    readonly code:
      | "action_not_found"
      | "action_not_agent"
      | "action_name_ambiguous"
      | "scenario_too_large"
      | "generation_source_required",
    message: string,
  ) {
    super(message);
  }
}

const normalizedRef = (value: string): string =>
  value.normalize("NFKC").trim().toLocaleLowerCase();

const normalizedScenario = (value: string): string =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ");

const scenarioDigest = (domain: string, scenario: string): string =>
  createHash("sha256")
    .update(`${normalizedRef(domain)}\0${normalizedScenario(scenario)}`, "utf8")
    .digest("hex");

export function factorySourceOntologyHash(
  ontology: DomainOntology,
): string {
  return createHash("sha256")
    .update(
      canonicalEvidenceJson({
        domainId: ontology.domainId,
        source: ontology.source,
        objects: ontology.objects,
        rules: ontology.rules,
        actions: ontology.actions,
        events: ontology.events,
        links: ontology.links,
        workflow: ontology.workflow,
      }),
      "utf8",
    )
    .digest("hex");
}

function exactScenarioAction(
  ontology: DomainOntology,
  scenario: string,
): OntologyAction | undefined {
  const exact = normalizedRef(scenario);
  const direct = ontology.actions.filter(
    (action) =>
      normalizedRef(action.id) === exact || normalizedRef(action.name) === exact,
  );
  if (direct.length === 1) return direct[0];

  // A deliberately explicit @ActionName reference is also safe to resolve.
  // Do not fuzzy-match descriptions: a semantic guess would silently turn a
  // new business scenario into the wrong authoritative Action.
  const mentions = ontology.actions.filter((action) => {
    const escaped = action.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\s)@${escaped}(?=$|\\s|[，。！？,.!?])`, "iu").test(
      scenario,
    );
  });
  return mentions.length === 1 ? mentions[0] : undefined;
}

function virtualIdentity(
  ontology: DomainOntology,
  scenario: string,
): {
  hash: string;
  id: string;
  name: string;
  requestedEvent: string;
  completedEvent: string;
} {
  const hash = scenarioDigest(ontology.domainId, scenario);
  for (const width of [12, 16, 20, 24, 32, 64]) {
    const token = hash.slice(0, width);
    const upper = token.toUpperCase();
    const candidate = {
      hash,
      id: `virtual-action-${token}`,
      name: `virtualScenario_${token}`,
      requestedEvent: `ONTOCODE_SCENARIO_${upper}_REQUESTED`,
      completedEvent: `ONTOCODE_SCENARIO_${upper}_COMPLETED`,
    };
    const actionCollision = ontology.actions.some(
      (action) =>
        action.id === candidate.id || action.name === candidate.name,
    );
    const eventCollision = ontology.events.some(
      (event) =>
        event.name === candidate.requestedEvent ||
        event.name === candidate.completedEvent,
    );
    if (!actionCollision && !eventCollision) return candidate;
  }
  throw new Error("unable to allocate a collision-free virtual Action identity");
}

function makeVirtualDirective(
  ontology: DomainOntology,
  scenario: string,
): FactoryGenerationDirective {
  const identity = virtualIdentity(ontology, scenario);
  const provenance: FactoryVirtualActionProvenance = {
    schema: "agent-factory-virtual-action/v1",
    kind: "virtual_scenario",
    source: "factory_session_overlay",
    authoritative: false,
    scenarioHash: identity.hash,
  };
  const virtualAction: FactoryGenerationDirective["virtualAction"] = {
    id: identity.id,
    name: identity.name,
    description: `会话内场景 Action：${scenario}`,
    category: "virtual_scenario",
    actor: ["Agent"],
    trigger: [identity.requestedEvent],
    triggered_event: [identity.completedEvent],
    target_objects: [],
    // Security boundary: a client scenario never grants tools, integrations,
    // side effects, credentials, or production authority.
    tool_use: [],
    system_prompt: "",
    user_prompt: "",
    inputs: [
      {
        name: "request",
        type: "object",
        required: true,
        binding_kind: "event",
        source_event: identity.requestedEvent,
        event_field: "request",
      },
    ],
    outputs: [
      {
        name: "result",
        type: "object",
        required: true,
        delivery: "event",
        emitted_on: [identity.completedEvent],
        event_field: "result",
      },
    ],
    instruction:
      `${scenario}\n\n` +
      "这是 Agent Factory 的会话内设计覆盖层，不是权威 Ontology 写入。" +
      "不得从场景文本推导工具权限、凭证、外部写入或生产授权；这些能力只能经过平台现有的独立安全门。",
    factoryProvenance: provenance,
  };
  const requestedEvent: NonNullable<
    FactoryGenerationDirective["virtualEvents"]
  >[number] = {
    name: identity.requestedEvent,
    description: "OntoCode 会话内场景请求入口",
    consumers: [identity.name],
    payload: {
      source_action: null,
      source_domain: null,
      event_data: [
        {
          name: "request",
          type: "object",
          target_object: null,
          required: true,
          description: "调用方提供的场景请求数据",
        },
      ],
      state_mutations: [],
    },
    factoryProvenance: provenance,
  };
  const completedEvent: NonNullable<
    FactoryGenerationDirective["virtualEvents"]
  >[number] = {
    name: identity.completedEvent,
    description: "OntoCode 会话内场景执行结果",
    producers: [identity.name],
    payload: {
      source_action: identity.name,
      source_domain: null,
      event_data: [
        {
          name: "result",
          type: "object",
          target_object: null,
          required: true,
          description: "场景 Agent 的结构化结果",
        },
      ],
      state_mutations: [],
    },
    factoryProvenance: provenance,
  };
  const virtualLinks: OntologyLink[] = [
    {
      id: `virtual-link-${identity.hash.slice(0, 16)}-trigger`,
      kind: "action-trigger",
      from: { type: "event", id: identity.requestedEvent },
      to: { type: "action", id: identity.id },
      status: "approved",
      managedBy: "agent-factory-session-overlay",
    },
    {
      id: `virtual-link-${identity.hash.slice(0, 16)}-emission`,
      kind: "action-emission",
      from: { type: "action", id: identity.id },
      to: { type: "event", id: identity.completedEvent },
      status: "approved",
      managedBy: "agent-factory-session-overlay",
    },
  ];
  return {
    schema: FACTORY_GENERATION_DIRECTIVE_SCHEMA,
    mode: "virtual_scenario",
    requestedActionIds: [identity.id],
    requestedActionNames: [identity.name],
    requestedActions: [{ id: identity.id, name: identity.name }],
    sourceOntologyHash: factorySourceOntologyHash(ontology),
    scenario,
    virtualAction,
    virtualEvents: [requestedEvent, completedEvent],
    virtualLinks,
  };
}

export function createFactoryGenerationDirective(input: {
  ontology: DomainOntology;
  actionIds?: readonly string[];
  scenario?: string;
  /** Trusted server-side decision from a validated scope recommendation.
   * This never grants tools or side effects; it only skips exact-name matching
   * so an intentionally new scenario receives a deterministic session overlay. */
  forceVirtual?: boolean;
}): FactoryGenerationDirective {
  const actionIds = [
    ...new Set(
      (input.actionIds ?? []).map((id) => id.trim()).filter(Boolean),
    ),
  ];
  const scenario = normalizedScenario(input.scenario ?? "");
  if (scenario.length > 20_000) {
    throw new FactoryGenerationDirectiveError(
      "scenario_too_large",
      "scenario 不能超过 20000 个字符",
    );
  }
  const actions = actionIds.map((id) => {
    const action = input.ontology.actions.find((candidate) => candidate.id === id);
    if (!action) {
      throw new FactoryGenerationDirectiveError(
        "action_not_found",
        `Action id「${id}」不属于当前绑定 Ontology domain`,
      );
    }
    if (!action.actor.includes("Agent")) {
      throw new FactoryGenerationDirectiveError(
        "action_not_agent",
        `Action「${action.name}」的 actor 不是 Agent，不能由 OntoCode 直接生成`,
      );
    }
    if (
      input.ontology.actions.filter(
        (candidate) => candidate.name === action.name,
      ).length !== 1
    ) {
      throw new FactoryGenerationDirectiveError(
        "action_name_ambiguous",
        `Action id「${id}」对应的 name「${action.name}」在当前 Ontology 中不唯一；请先修正权威 Ontology`,
      );
    }
    return action;
  });
  if (actions.length) {
    return {
      schema: FACTORY_GENERATION_DIRECTIVE_SCHEMA,
      mode: "action_selection",
      requestedActionIds: actions.map((action) => action.id),
      requestedActionNames: actions.map((action) => action.name),
      requestedActions: actions.map((action) => ({
        id: action.id,
        name: action.name,
      })),
      sourceOntologyHash: factorySourceOntologyHash(input.ontology),
      ...(scenario ? { scenario } : {}),
    };
  }
  if (!scenario) {
    throw new FactoryGenerationDirectiveError(
      "generation_source_required",
      "actionIds 或 scenario 至少需要一个",
    );
  }
  if (input.forceVirtual) {
    return makeVirtualDirective(input.ontology, scenario);
  }
  const exactScenarioCandidates = input.ontology.actions.filter(
    (action) =>
      normalizedRef(action.id) === normalizedRef(scenario) ||
      normalizedRef(action.name) === normalizedRef(scenario),
  );
  if (exactScenarioCandidates.length > 1) {
    throw new FactoryGenerationDirectiveError(
      "action_name_ambiguous",
      `场景精确引用「${scenario}」匹配到多个 Action；请先修正权威 Ontology`,
    );
  }
  const matched = exactScenarioAction(input.ontology, scenario);
  if (matched) {
    if (!matched.actor.includes("Agent")) {
      throw new FactoryGenerationDirectiveError(
        "action_not_agent",
        `场景精确匹配到 Action「${matched.name}」，但它的 actor 不是 Agent`,
      );
    }
    return {
      schema: FACTORY_GENERATION_DIRECTIVE_SCHEMA,
      mode: "scenario_match",
      requestedActionIds: [matched.id],
      requestedActionNames: [matched.name],
      requestedActions: [{ id: matched.id, name: matched.name }],
      sourceOntologyHash: factorySourceOntologyHash(input.ontology),
      scenario,
    };
  }
  return makeVirtualDirective(input.ontology, scenario);
}

/** Apply a trusted, per-conversation overlay without mutating the authoritative
 * Ontology object returned by its source. */
export function applyFactoryGenerationOverlay(
  ontology: DomainOntology,
  directive: FactoryGenerationDirective | undefined,
): DomainOntology {
  if (!directive) {
    return ontology;
  }
  if (factorySourceOntologyHash(ontology) !== directive.sourceOntologyHash) {
    throw new FactoryGenerationDirectiveError(
      "action_not_found",
      "绑定 Ontology 自任务启动后已变化；为避免 Action 身份漂移，请新建 OntoCode 任务并重新选择",
    );
  }
  if (!directive.virtualAction || !directive.virtualEvents?.length) {
    for (const requested of directive.requestedActions) {
      const exact = ontology.actions.filter(
        (action) =>
          action.id === requested.id && action.name === requested.name,
      );
      if (exact.length !== 1) {
        throw new FactoryGenerationDirectiveError(
          "action_not_found",
          `Action「${requested.id}/${requested.name}」已不存在或身份发生变化；请重新选择`,
        );
      }
    }
    return ontology;
  }
  const actionCollision = ontology.actions.some(
    (action) =>
      action.id === directive.virtualAction!.id ||
      action.name === directive.virtualAction!.name,
  );
  const eventCollision = directive.virtualEvents.some((virtualEvent) =>
    ontology.events.some((event) => event.name === virtualEvent.name),
  );
  const linkCollision =
    ontology.links !== undefined &&
    (directive.virtualLinks ?? []).some((virtualLink) =>
      ontology.links!.some((link) => link.id === virtualLink.id),
    );
  if (actionCollision || eventCollision || linkCollision) {
    throw new FactoryGenerationDirectiveError(
      "action_name_ambiguous",
      "会话 Virtual Action 与当前权威 Ontology 的 Action/Event/Link 身份冲突；不会静默复用，请新建任务重试",
    );
  }
  const eventNames = new Set(ontology.events.map((event) => event.name));
  const links = ontology.links;
  return {
    ...ontology,
    actions: [...ontology.actions, directive.virtualAction],
    events: [
      ...ontology.events,
      ...directive.virtualEvents.filter((event) => !eventNames.has(event.name)),
    ],
    ...(links === undefined
      ? {}
      : {
          links: [
            ...links,
            ...(directive.virtualLinks ?? []),
          ],
        }),
    factorySessionOverlay: {
      schema: "agent-factory-session-overlay/v1",
      authoritative: false,
      mode: "virtual_scenario",
      actionIds: directive.requestedActionIds,
      scenarioHash: directive.virtualAction.factoryProvenance.scenarioHash,
    },
  };
}

export function factoryGenerationDirectiveFingerprint(
  directive: FactoryGenerationDirective | undefined,
): string | null {
  if (!directive) return null;
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema: directive.schema,
        mode: directive.mode,
        actionIds: directive.requestedActionIds,
        actionNames: directive.requestedActionNames,
        actionPairs: directive.requestedActions,
        sourceOntologyHash: directive.sourceOntologyHash,
        scenario: directive.scenario ?? null,
        virtualHash:
          directive.virtualAction?.factoryProvenance.scenarioHash ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}

export function factoryGenerationGoal(
  directive: FactoryGenerationDirective,
  operatorGoal?: string,
): string {
  const source =
    directive.mode === "virtual_scenario"
      ? `根据 FDE 描述的场景生成会话内 Agent：${directive.scenario}`
      : `把当前 Ontology 中选定的 Action 转成 Agent code 并完成验证：${directive.requestedActionNames.join("、")}`;
  const scenario =
    directive.mode !== "virtual_scenario" && directive.scenario
      ? `\n本次业务场景：${directive.scenario}`
      : "";
  const goal = operatorGoal?.trim();
  return (
    `[服务端生成范围]\n${source}${scenario}\n` +
    `只生成这些 Action：${directive.requestedActionNames.join("、")}。` +
    "场景文本不授予事件名、工具、凭证、外部写入或生产权限；只能使用服务端从绑定 Ontology 与工具目录解析出的能力。" +
    (goal ? `\n\nFDE 补充目标：${goal}` : "")
  );
}
