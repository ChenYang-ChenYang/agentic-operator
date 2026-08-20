// Ontology shape the factory reads (objects / actions / events / rules / workflow).
//
// Ported from the OLD repo's lib/ontology-generator/ontology-source.ts — ONLY the
// pure type declarations. The loaders that fetch these from Neo4j/Allmeta become the
// injected `OntologySource` port in M1-b (the new monorepo dropped Neo4j/Allmeta, so
// the live implementation reads from manifest JSON under models/<tenant>/ instead).

export type OntologyObject = {
  id: string; // label id, e.g. "Power_Station"
  name: string; // CJK display, e.g. "电站"
  description?: string;
  type?: string;
  primary_key?: string;
  properties?: Array<{
    name: string;
    type?: string;
    description?: string;
    /** Machine-readable relationship evidence used by modern Ontology links. */
    is_foreign_key?: boolean;
    references?: string;
    required?: boolean;
    nullable?: boolean;
  }>;
};

/** A canonical schema-level relationship authored and reviewed in Allmeta's
 * Links Builder. `kind` is the stable semantic identity; graph relationship
 * names such as HAS_STEP/GOVERNS are transport details. */
export type OntologyLinkEndpoint = {
  type: string;
  id: string;
  displayName?: { zh?: string; en?: string };
};

export type OntologyLink = {
  id: string;
  kind: string;
  from: OntologyLinkEndpoint;
  to: OntologyLinkEndpoint;
  status?: string;
  managedBy?: string;
  allmetaLink?: boolean;
  [key: string]: unknown;
};

/** Where an Action input is obtained. Keeping this explicit prevents the
 * factory from pretending every required value must be present on every
 * trigger Event. */
export type OntologyInputBindingKind =
  | "event"
  | "object_lookup"
  | "secret"
  | "config"
  | "human_input"
  | "step_output";

export type OntologyAction = {
  id: string;
  name: string; // camelCase, e.g. "forecastOutput"
  description?: string;
  category?: string;
  actor: string[]; // ["Agent"] | ["Human"] | ...
  trigger: string[]; // consumed event names
  triggered_event: string[]; // emitted event names
  target_objects: string[];
  tool_use: string[];
  system_prompt: string;
  user_prompt: string;
  /** BUSINESS input schema (DataObject-grounded: name/type/description/source_object/
   *  required). The agent's inputs at the event level — NOT a tool's I/O (that lives
   *  in the tool library). */
  inputs?: Array<Record<string, unknown>>;
  outputs?: Array<Record<string, unknown>>;
  /** preconditions that must hold before the action runs (numbered prose). */
  submission_criteria?: string;
  /** Authoritative business procedure text carried by newer Allmeta exports.
   * It informs design, but never substitutes for structured action_steps or
   * integration bindings at sandbox/promotion time. */
  instruction?: string;
  /** Named outcome policies from the business model. These remain review
   * evidence; the factory does not translate arbitrary prose into executable
   * error handling without a structured plan. */
  on_success?: string;
  on_failure?: string;
  side_effects?: Record<string, unknown>;
  /** OPTIONAL nested steps (order/name/condition/rules[]) — preserved verbatim from the
   *  source ontology. fetchActionRules reads embedded per-step rules from here; dropping
   *  it silently orphans every rule a bundle nests under its actions. */
  action_steps?: Array<Record<string, unknown>>;
  /** OPTIONAL declared integration block (systems[] / event_sources) — business-flow's
   *  DECLARED source of truth for external-system edges; preserved verbatim. */
  integration?: Record<string, unknown>;
  /** A server-created session overlay is explicitly non-authoritative. It is
   * never persisted back into Allmeta/uploaded Ontology storage. */
  factoryProvenance?: {
    schema: "agent-factory-virtual-action/v1";
    kind: "virtual_scenario";
    source: "factory_session_overlay";
    authoritative: false;
    scenarioHash: string;
  };
};

export type OntologyEvent = {
  name: string;
  description?: string;
  /** Complete producer/consumer topology. `payload.source_action` is retained
   * for backwards compatibility, but cannot represent events emitted by more
   * than one Action. When present, these arrays are authoritative. */
  producers?: string[];
  consumers?: string[];
  payload: {
    source_action: string | null;
    /** Domain that owns source_action. Omit/null for an Action in this Event's
     * own domain. External domains are resolved and verified before generation. */
    source_domain?: string | null;
    event_data: Array<{
      name: string;
      type: string;
      target_object: string | null;
      /** Defaults to required for backwards compatibility. */
      required?: boolean;
      description?: string;
    }>;
    state_mutations: Array<{
      target_object: string;
      mutation_type: string;
      impacted_properties: string[];
    }>;
  };
  factoryProvenance?: OntologyAction["factoryProvenance"];
};

export type OntologyRule = Record<string, unknown>;
export type OntologyWorkflowItem = Record<string, unknown>;
/** A domain's workflow definitions. Modeled as a LIST (like objects/rules/
 *  actions/events) so it's counted by length, not by mere presence. */
export type OntologyWorkflow = OntologyWorkflowItem[];

/** Strictly resolved Action catalog for a domain referenced by an Event.
 * A failed resolution is retained as `resolved:false` so readiness can expose
 * a blocking, evidence-backed issue instead of silently dropping provenance. */
export type OntologyReferencedDomain = {
  domainId: string;
  source: "allmeta" | "snapshot";
  resolved: boolean;
  actions: OntologyAction[];
  error?: string;
};

export type DomainOntology = {
  domainId: string;
  objects: OntologyObject[];
  rules: OntologyRule[];
  actions: OntologyAction[];
  events: OntologyEvent[];
  /** Optional by design. Domains created before Links Builder remain readable;
   * once a source supplies this collection, readiness verifies its executable
   * graph coverage instead of silently deriving relationships from prose. */
  links?: OntologyLink[];
  workflow: OntologyWorkflow;
  source: "allmeta" | "snapshot";
  /** Populated by the ontology reader for every external source_domain used by
   * Events. analyzeOntologyReadiness never treats an absent/unresolved entry as
   * verified. */
  referencedDomains?: OntologyReferencedDomain[];
  /** #AUDIT-FIX(P2-04) — 严格源(Allmeta)失败后退化到薄 manifest artifact 的标记。set 时说明
   *  本体不完整（可能缺 events/objects/rules），read_ontology 会向 AI/用户明示，禁止据此自动 publish。 */
  degraded?: { from: string; reason: string };
  /** Trusted in-memory overlay metadata. Source adapters never write this. */
  factorySessionOverlay?: {
    schema: "agent-factory-session-overlay/v1";
    authoritative: false;
    mode: "virtual_scenario";
    actionIds: string[];
    scenarioHash: string;
  };
};
