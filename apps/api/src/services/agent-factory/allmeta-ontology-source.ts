// AllmetaOntologySource — the LIVE OntologySource port backed by AllmetaOntology
// Studio's HTTP API (the "Neo4j 唯一入口" at :3500).
//
// The new monorepo originally dropped Neo4j/Allmeta and read ontology from JSON
// under models/<slug>/ (see ManifestOntologySource). This source restores the OLD
// operator's live read: a domain's objects/events/actions/rules are fetched from
// Allmeta over HTTP on every call, so every explicitly bound domain is grounded
// in the REAL ontology rather than a stale local snapshot.
//
// Ported from the old operator's lib/ontology-generator/ontology-source.ts
// (allmetaList / resolveAllmetaDomainId / normalizeAllmeta* / fetchLiveOntologyStrict).
// STRICT by contract: fetchOntology throws when Allmeta is unreachable or returns
// an empty graph — the factory must not hallucinate against a stub (live-only, no
// snapshot fallback). DomainOntology.source is "allmeta".

import { createHash } from "node:crypto";

import type {
  OntologySource,
  DomainOntology,
  OntologyAction,
  OntologyObject,
  OntologyEvent,
  OntologyLink,
  OntologyRule,
  OntologyInstancePage,
} from "@agentic/agent-factory";
import type { OntologyTransportDescriptor } from "./ontology-transport-descriptor";
import {
  classifyFetchRejection,
  findOntologyTransportError,
  OntologyTransportError,
} from "./ontology-transport-error";

export interface AllmetaConfig {
  /** Studio base URL, e.g. http://localhost:3500. Empty = unconfigured. */
  baseUrl: string;
  /** Bearer token (Studio's ONTOLOGY_API_TOKEN). Empty = no auth header. */
  apiKey: string;
  /** Request timeout — generous, Studio lazy-compiles on first hit. */
  timeoutMs: number;
}

export interface AllmetaOntologySourceOptions {
  /**
   * `alias` is retained for unscoped/legacy callers that accept a
   * user-entered spelling. `exact` is required once a tenant has persisted an
   * Allmeta catalog id: a missing id must fail closed instead of resolving a
   * different domain whose display name happens to look similar.
   */
  domainIdentity?: "alias" | "exact";
}

export function allmetaConfigFromEnv(): AllmetaConfig {
  return {
    baseUrl: (process.env.ALLMETA_BASE_URL ?? "").replace(/\/+$/, ""),
    apiKey: process.env.ALLMETA_API_KEY ?? "",
    timeoutMs: Number(process.env.ALLMETA_TIMEOUT_MS ?? 8000) || 8000,
  };
}

type Node = Record<string, unknown>;
export type AllmetaDomain = { id: string; name?: string };

interface AllmetaRawSnapshot {
  actions: Node[];
  events: Node[];
  objects: Node[];
  rules: Node[];
  links: Node[];
  actionSteps: Array<{ actionRef: string; items: Node[] }>;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Allmeta snapshot contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(
    `Allmeta snapshot contains unsupported ${typeof value} value`,
  );
}

function canonicalRows(rows: Node[]): string[] {
  return rows.map(canonicalJson).sort();
}

function rawSnapshotHash(snapshot: AllmetaRawSnapshot): string {
  const body = {
    actions: canonicalRows(snapshot.actions),
    events: canonicalRows(snapshot.events),
    objects: canonicalRows(snapshot.objects),
    rules: canonicalRows(snapshot.rules),
    links: canonicalRows(snapshot.links),
    actionSteps: snapshot.actionSteps
      .map((entry) => ({
        actionRef: entry.actionRef,
        items: canonicalRows(entry.items),
      }))
      .sort((left, right) => {
        const byRef = left.actionRef.localeCompare(right.actionRef);
        return (
          byRef ||
          canonicalJson(left.items).localeCompare(canonicalJson(right.items))
        );
      }),
  };
  return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}

// ── pure normalizers (exported for unit tests) ─────────────────────────────────
//
// Allmeta stores ontology data as graph NODES whose shape differs from the local
// JSON: stringified `*_json` fields, `uid`/`action_id` instead of `id`,
// `trigger_json` (consumed) on the action and no plain emitted field. These map an
// Allmeta node back to our OntologyObject/Event/Action shape.

export function parseJsonField<T>(v: unknown, fallback: T): T {
  let parsed: unknown;
  if (v == null) return fallback;
  if (typeof v === "object") parsed = v;
  else if (typeof v === "string") {
    try {
      parsed = JSON.parse(v);
    } catch (error) {
      throw new Error(`Allmeta JSON field is malformed: ${v.slice(0, 120)}`, {
        cause: error,
      });
    }
  } else {
    throw new TypeError(`Allmeta JSON field has unsupported type ${typeof v}`);
  }
  if (Array.isArray(fallback) && !Array.isArray(parsed)) {
    throw new TypeError("Allmeta JSON field must be an array");
  }
  if (
    fallback !== null &&
    typeof fallback === "object" &&
    !Array.isArray(fallback) &&
    (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
  ) {
    throw new TypeError("Allmeta JSON field must be an object");
  }
  return parsed as T;
}

function asArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new TypeError(`${field} must be an array`);
  return v.map((value, index) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError(`${field}[${index}] must be a non-empty string`);
    }
    return value.trim();
  });
}

function objectArray<T extends Record<string, unknown>>(
  value: unknown,
  field: string,
): T[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  if (
    value.some(
      (entry) => !entry || typeof entry !== "object" || Array.isArray(entry),
    )
  ) {
    throw new TypeError(`${field} entries must be objects`);
  }
  return value as T[];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(`${field} is required`);
  return value.trim();
}

function optionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  const parsed = parseJsonField(value, {} as Record<string, unknown>);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`${field} must be an object`);
  }
  return parsed;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function managedLinkFlag(value: unknown): boolean {
  return (
    value === true ||
    (typeof value === "string" && value.trim().toLowerCase() === "true")
  );
}

/** Normalize only the central, Links-Builder-managed relationship shape. The
 * legacy `/ontology/links` resource also returns historical `:Link` rows; those
 * are not reviewed execution evidence and must never satisfy Factory gates. */
export function normalizeAllmetaManagedLink(n: Node): OntologyLink | null {
  const managedBy = textValue(n.managedBy ?? n.managed_by);
  const managed =
    managedBy.toLowerCase() === "links-builder" ||
    managedLinkFlag(n.allmetaLink ?? n.allmeta_link);
  if (!managed) return null;

  const embeddedFrom = record(n.from);
  const embeddedTo = record(n.to);
  const id = requiredString(
    n.id ?? n.linkId ?? n.link_id,
    "Allmeta managed link id",
  );
  const kind = requiredString(n.kind, `Allmeta managed link ${id} kind`);
  const fromId = requiredString(
    n.fromId ?? n.sourceId ?? n.source_id ?? embeddedFrom?.id,
    `Allmeta managed link ${id} from id`,
  );
  const toId = requiredString(
    n.toId ?? n.targetId ?? n.target_id ?? embeddedTo?.id,
    `Allmeta managed link ${id} to id`,
  );
  const fromType = requiredString(
    n.fromLabel ?? n.sourceType ?? n.source_type ?? embeddedFrom?.type,
    `Allmeta managed link ${id} from type`,
  );
  const toType = requiredString(
    n.toLabel ?? n.targetType ?? n.target_type ?? embeddedTo?.type,
    `Allmeta managed link ${id} to type`,
  );
  return {
    ...n,
    id,
    kind,
    from: {
      ...embeddedFrom,
      id: fromId,
      type: fromType,
    },
    to: {
      ...embeddedTo,
      id: toId,
      type: toType,
    },
    ...(typeof n.status === "string" ? { status: n.status } : {}),
    ...(managedBy ? { managedBy } : {}),
    allmetaLink: true,
  } as OntologyLink;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Normalize an AO domain id to a comparison key (case/space/_/- insensitive). */
export const normDomainId = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\s_-]+/g, "");

/** Resolve user-entered spelling without weakening a persisted exact id.
 * Exact catalog id always wins. A normalized id/name is accepted only when it
 * identifies exactly one catalog row; ambiguous aliases stay unresolved. */
export function resolveAllmetaDomainId(
  list: AllmetaDomain[],
  domainId: string,
): string {
  const exact = list.find((domain) => domain.id === domainId);
  if (exact) return exact.id;
  const want = normDomainId(domainId);
  const matches = list.filter(
    (domain) =>
      normDomainId(domain.id) === want ||
      (domain.name ? normDomainId(domain.name) === want : false),
  );
  return matches.length === 1 ? matches[0]!.id : domainId;
}

export function normalizeAllmetaObject(n: Node): OntologyObject {
  const id = requiredString(n.id ?? n.uid, "Allmeta object id/uid");
  const name = requiredString(n.name, `Allmeta object ${id} name`);
  const properties = objectArray<{
    name: string;
    type?: string;
    description?: string;
  }>(
    parseJsonField(
      n.properties ?? n.properties_json,
      [] as OntologyObject["properties"],
    ),
    `Allmeta object ${id} properties`,
  );
  for (const [index, property] of properties.entries()) {
    requiredString(
      property.name,
      `Allmeta object ${id} properties[${index}].name`,
    );
  }
  return {
    id,
    name,
    description: typeof n.description === "string" ? n.description : undefined,
    type: typeof n.type === "string" ? n.type : undefined,
    primary_key: typeof n.primary_key === "string" ? n.primary_key : undefined,
    // Live Allmeta serializes properties as a stringified `properties` field;
    // older exports used `properties_json`. Accept either.
    properties,
  };
}

export function normalizeAllmetaEvent(n: Node): OntologyEvent {
  // Live Allmeta nests the payload as a stringified `payload` field
  // ({source_action, event_data, state_mutations}); older exports carried bare
  // `event_data_json` / `mutations_json`. Parse the envelope, fall back to bare.
  const name = requiredString(n.name, "Allmeta event name");
  const payload = parseJsonField(n.payload, {} as Record<string, unknown>);
  const source = n.source_action ?? payload.source_action;
  const sourceDomain = n.source_domain ?? payload.source_domain;
  if (source != null && typeof source !== "string") {
    throw new TypeError(
      `Allmeta event ${name} source_action must be a string or null`,
    );
  }
  if (sourceDomain != null && typeof sourceDomain !== "string") {
    throw new TypeError(
      `Allmeta event ${name} source_domain must be a string or null`,
    );
  }
  // Allmeta's published RAAS graph represents events without a modeled
  // producer as an empty source_action string.  The AO contract represents the
  // same absence as null.  Normalize only blank strings; non-string values
  // still fail closed instead of being coerced.
  const normalizedSource =
    typeof source === "string" && source.trim() ? source.trim() : null;
  const normalizedSourceDomain =
    typeof sourceDomain === "string" && sourceDomain.trim()
      ? sourceDomain.trim()
      : null;
  const eventDataRaw =
    payload.event_data !== undefined
      ? payload.event_data
      : parseJsonField(
          n.event_data_json,
          [] as OntologyEvent["payload"]["event_data"],
        );
  const mutationsRaw =
    payload.state_mutations !== undefined
      ? payload.state_mutations
      : parseJsonField(
          n.mutations_json,
          [] as OntologyEvent["payload"]["state_mutations"],
        );
  const eventData = objectArray<OntologyEvent["payload"]["event_data"][number]>(
    eventDataRaw,
    `Allmeta event ${name} event_data`,
  );
  const stateMutations = objectArray<
    OntologyEvent["payload"]["state_mutations"][number]
  >(mutationsRaw, `Allmeta event ${name} state_mutations`);
  const producers = asArray(
    parseJsonField(n.producers_json ?? n.producers, [] as string[]),
    `Allmeta event ${name} producers`,
  );
  const consumers = asArray(
    parseJsonField(n.consumers_json ?? n.consumers, [] as string[]),
    `Allmeta event ${name} consumers`,
  );
  for (const [index, field] of eventData.entries()) {
    requiredString(
      field.name,
      `Allmeta event ${name} event_data[${index}].name`,
    );
    requiredString(
      field.type,
      `Allmeta event ${name} event_data[${index}].type`,
    );
  }
  for (const [index, mutation] of stateMutations.entries()) {
    requiredString(
      mutation.target_object,
      `Allmeta event ${name} state_mutations[${index}].target_object`,
    );
    requiredString(
      mutation.mutation_type,
      `Allmeta event ${name} state_mutations[${index}].mutation_type`,
    );
    asArray(
      mutation.impacted_properties,
      `Allmeta event ${name} state_mutations[${index}].impacted_properties`,
    );
  }
  return {
    name,
    description: typeof n.description === "string" ? n.description : undefined,
    ...(producers.length ? { producers } : {}),
    ...(consumers.length ? { consumers } : {}),
    payload: {
      source_action: normalizedSource,
      ...(normalizedSourceDomain == null
        ? {}
        : { source_domain: normalizedSourceDomain }),
      event_data: eventData,
      state_mutations: stateMutations,
    },
  };
}

export function normalizeAllmetaAction(
  n: Node,
  emitByAction: Map<string, string[]>,
): OntologyAction {
  const name = requiredString(n.name, "Allmeta action name");
  const id = n.id ?? n.action_id;
  const canonicalId =
    id === undefined ? name : requiredString(id, `Allmeta action ${name} id`);
  // Live Allmeta serializes list/object fields as stringified `*_json` and uses
  // `trigger_json` (consumed) + `triggered_event_json` (emitted) + `actor_json`.
  // Older exports carried bare fields. Parse `*_json` first, fall back. The actor
  // parse is load-bearing: the brain filters Agent actions via actor.includes("Agent").
  const actor = asArray(
    parseJsonField(n.actor_json ?? n.actor, [] as string[]),
    `Allmeta action ${name} actor`,
  );
  if (!actor.length)
    throw new TypeError(`Allmeta action ${name} actor is required`);
  const trigger = asArray(
    parseJsonField(
      n.trigger_json ?? n.trigger_events ?? n.trigger,
      [] as string[],
    ),
    `Allmeta action ${name} trigger`,
  );
  const emittedKeys = [
    "triggered_event_json",
    "triggered_event",
    "triggered_events",
    "emit_json",
    "emit",
  ] as const;
  const hasExplicitEmitted = emittedKeys.some((key) =>
    Object.prototype.hasOwnProperty.call(n, key),
  );
  const emitted = asArray(
    parseJsonField(
      n.triggered_event_json ??
        n.triggered_event ??
        n.triggered_events ??
        n.emit_json ??
        n.emit,
      [] as string[],
    ),
    `Allmeta action ${name} triggered_event`,
  );
  const inputs = objectArray<Record<string, unknown>>(
    parseJsonField(
      n.inputs_json ?? n.inputs,
      [] as NonNullable<OntologyAction["inputs"]>,
    ),
    `Allmeta action ${name} inputs`,
  );
  const outputs = objectArray<Record<string, unknown>>(
    parseJsonField(
      n.outputs_json ?? n.outputs,
      [] as NonNullable<OntologyAction["outputs"]>,
    ),
    `Allmeta action ${name} outputs`,
  );
  const embeddedSteps = objectArray<Record<string, unknown>>(
    parseJsonField(
      n.action_steps_json ?? n.action_steps,
      [] as NonNullable<OntologyAction["action_steps"]>,
    ),
    `Allmeta action ${name} action_steps`,
  );
  return {
    id: canonicalId,
    name,
    description: typeof n.description === "string" ? n.description : undefined,
    category: typeof n.category === "string" ? n.category : undefined,
    actor,
    trigger,
    // An explicit [] is meaningful: this Action emits nothing and readiness
    // must be allowed to surface any contradictory Event producer. Derive from
    // Event.source_action only when no emitted field exists at all.
    triggered_event: hasExplicitEmitted
      ? emitted
      : (emitByAction.get(name) ?? []),
    target_objects: asArray(
      parseJsonField(n.target_objects_json ?? n.target_objects, [] as string[]),
      `Allmeta action ${name} target_objects`,
    ),
    // Allmeta nodes don't carry prompts/tools (only needed to RUN, not to infer);
    // tool_use is usually empty live — the factory binds tools from the registry.
    tool_use: asArray(
      parseJsonField(n.tool_use_json ?? n.tool_use, [] as string[]),
      `Allmeta action ${name} tool_use`,
    ),
    system_prompt: typeof n.system_prompt === "string" ? n.system_prompt : "",
    user_prompt: typeof n.user_prompt === "string" ? n.user_prompt : "",
    inputs,
    outputs,
    submission_criteria:
      typeof n.submission_criteria === "string"
        ? n.submission_criteria
        : undefined,
    instruction: typeof n.instruction === "string" ? n.instruction : undefined,
    on_success: typeof n.on_success === "string" ? n.on_success : undefined,
    on_failure: typeof n.on_failure === "string" ? n.on_failure : undefined,
    side_effects: optionalRecord(
      n.side_effects_json ?? n.side_effects,
      `Allmeta action ${name} side_effects`,
    ),
    // Live Allmeta may expose these as JSON strings or already-decoded values. They are
    // execution-bearing: action_steps drives plan/rule derivation; integration declares the
    // external systems and data stores that capability grounding must satisfy.
    action_steps: embeddedSteps,
    integration: optionalRecord(
      n.integration_json ?? n.integration,
      `Allmeta action ${name} integration`,
    ),
  };
}

/** Normalize the dedicated ActionStep sub-resource. Allmeta stores the step's
 * inputs/outputs/rules as JSON strings on the graph node, while callers of the
 * Agent Factory need decoded structures in order to compile an executable plan. */
export function normalizeAllmetaActionStep(n: Node): Record<string, unknown> {
  const order =
    typeof n.order === "string" || typeof n.order === "number"
      ? n.order
      : typeof n.index === "string" || typeof n.index === "number"
        ? n.index
        : undefined;
  const id = requiredString(n.id, "Allmeta action step id");
  const name = requiredString(n.name, `Allmeta action step ${id} name`);
  return {
    ...n,
    id,
    name,
    ...(typeof n.description === "string"
      ? { description: n.description }
      : {}),
    ...(order !== undefined ? { order } : {}),
    ...(typeof n.condition === "string" ? { condition: n.condition } : {}),
    ...(typeof n.object_type === "string"
      ? { object_type: n.object_type }
      : {}),
    inputs: objectArray(
      parseJsonField(
        n.inputs_json ?? n.inputs,
        [] as Array<Record<string, unknown>>,
      ),
      `Allmeta action step ${id} inputs`,
    ),
    outputs: objectArray(
      parseJsonField(
        n.outputs_json ?? n.outputs,
        [] as Array<Record<string, unknown>>,
      ),
      `Allmeta action step ${id} outputs`,
    ),
    rules: objectArray(
      parseJsonField(
        n.rules_json ?? n.rules,
        [] as Array<Record<string, unknown>>,
      ),
      `Allmeta action step ${id} rules`,
    ),
  };
}

/** Action names are executable identities (React key + Inngest slug). A duplicate is an
 * authoritative-source integrity error; silently keeping one would hide live ontology data. */
export function assertUniqueActionsByName(
  actions: OntologyAction[],
): OntologyAction[] {
  const seen = new Set<string>();
  for (const a of actions) {
    if (seen.has(a.name))
      throw new Error(`Allmeta returned duplicate action name ${a.name}`);
    seen.add(a.name);
  }
  return actions;
}

/** Build the action→emitted-events map from normalized events (an event names the
 *  action that emits it via payload.source_action). */
export function buildEmitByAction(
  events: OntologyEvent[],
): Map<string, string[]> {
  const emitByAction = new Map<string, string[]>();
  for (const e of events) {
    const producers = e.producers?.length
      ? e.producers
      : e.payload.source_action
        ? [e.payload.source_action]
        : [];
    for (const producer of producers) {
      const arr = emitByAction.get(producer) ?? [];
      if (!arr.includes(e.name)) arr.push(e.name);
      emitByAction.set(producer, arr);
    }
  }
  return emitByAction;
}

// ── the live source ────────────────────────────────────────────────────────────

export class AllmetaOntologySource implements OntologySource {
  private readonly cfg: AllmetaConfig;
  private readonly domainIdentity: "alias" | "exact";
  private domainCache: { at: number; list: AllmetaDomain[] } | null = null;
  /** Successful catalog reads are cached briefly. Failures are never disguised
   * as an empty or stale catalog. */
  private static readonly DOMAIN_TTL_OK_MS = 60_000;
  /** Allmeta clamps resource pages to 1,000 rows. Keep the client page size at
   * that public contract and fail closed before an unexpectedly large graph can
   * consume unbounded memory. The cap is a transport safety limit, not a
   * business/domain limit. */
  private static readonly RESOURCE_PAGE_LIMIT = 1_000;
  private static readonly RESOURCE_ITEM_LIMIT = 100_000;
  private static readonly RESOURCE_PAGE_LIMIT_TOTAL = 10_000;
  private static readonly ACTION_STEP_CONCURRENCY = 8;

  constructor(
    cfg: AllmetaConfig = allmetaConfigFromEnv(),
    options: AllmetaOntologySourceOptions = {},
  ) {
    this.cfg = cfg;
    this.domainIdentity = options.domainIdentity ?? "alias";
  }

  /** True when a base URL is configured — lets the composite skip this source. */
  get configured(): boolean {
    return !!this.cfg.baseUrl;
  }

  /** Self-description for resolution provenance (see ontology-transport-descriptor). */
  async describeTransport(): Promise<OntologyTransportDescriptor> {
    return { kind: "allmeta", configured: this.configured };
  }

  private async http(pathAndQuery: string): Promise<unknown> {
    if (!this.cfg.baseUrl)
      throw new OntologyTransportError("ALLMETA_BASE_URL is not configured", {
        failure: "unconfigured",
        transport: "allmeta",
      });
    const controller = new AbortController();
    // The abort is OUR deadline, not the server's answer. Recording it lets a
    // rejected fetch be reported as a timeout instead of "cannot connect".
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.cfg.timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(`${this.cfg.baseUrl}${pathAndQuery}`, {
          headers: this.cfg.apiKey
            ? { Authorization: `Bearer ${this.cfg.apiKey}` }
            : {},
          signal: controller.signal,
          cache: "no-store",
        });
      } catch (error) {
        const failure = classifyFetchRejection(error, timedOut);
        throw new OntologyTransportError(
          failure === "timeout"
            ? `Allmeta ${pathAndQuery} did not answer within ${this.cfg.timeoutMs}ms`
            : (error as Error).message,
          { failure, transport: "allmeta", cause: error },
        );
      }
      if (!res.ok) {
        throw new OntologyTransportError(
          `Allmeta ${pathAndQuery} returned HTTP ${res.status}`,
          {
            failure: "rejected",
            transport: "allmeta",
            upstreamStatus: res.status,
          },
        );
      }
      try {
        return await res.json();
      } catch (error) {
        throw new OntologyTransportError(
          `Allmeta ${pathAndQuery} returned a body that is not valid JSON`,
          { failure: "payload_contract", transport: "allmeta", cause: error },
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read a complete cursor-paginated ontology resource. Allmeta silently
   * clamps oversized `limit` values, so a single request can never prove a
   * complete graph. Exact duplicate rows at a page boundary are collapsed;
   * conflicting duplicate identities remain visible to the normalizers/readiness
   * checks instead of being hidden here. */
  private async list(resource: string, domainId: string): Promise<Node[]> {
    const rows: Node[] = [];
    const exactRows = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;

    for (
      let page = 0;
      page < AllmetaOntologySource.RESOURCE_PAGE_LIMIT_TOTAL;
      page++
    ) {
      const query = new URLSearchParams({
        domain: domainId,
        limit: String(AllmetaOntologySource.RESOURCE_PAGE_LIMIT),
      });
      if (cursor) query.set("cursor", cursor);
      const body = (await this.http(
        `/api/v1/ontology/${resource}?${query.toString()}`,
      )) as { items?: unknown[]; nextCursor?: unknown };
      if (!Array.isArray(body?.items)) {
        throw new Error(`Allmeta ${resource} payload is missing items[]`);
      }
      const pageRows = objectArray<Node>(
        body.items,
        `Allmeta ${resource} items`,
      );
      for (const row of pageRows) {
        const exact = JSON.stringify(row);
        if (exactRows.has(exact)) continue;
        exactRows.add(exact);
        rows.push(row);
        if (rows.length > AllmetaOntologySource.RESOURCE_ITEM_LIMIT) {
          throw new Error(
            `Allmeta ${resource} exceeded the safe ${AllmetaOntologySource.RESOURCE_ITEM_LIMIT}-item read limit`,
          );
        }
      }

      const next = body.nextCursor;
      if (next === undefined || next === null) return rows;
      if (typeof next !== "string" || !next.trim()) {
        throw new Error(`Allmeta ${resource} returned an invalid nextCursor`);
      }
      cursor = next.trim();
      if (cursors.has(cursor)) {
        throw new Error(`Allmeta ${resource} returned a repeated nextCursor`);
      }
      cursors.add(cursor);
      if (rows.length >= AllmetaOntologySource.RESOURCE_ITEM_LIMIT) {
        throw new Error(
          `Allmeta ${resource} has more than the safe ${AllmetaOntologySource.RESOURCE_ITEM_LIMIT}-item read limit`,
        );
      }
    }
    throw new Error(
      `Allmeta ${resource} exceeded the safe ${AllmetaOntologySource.RESOURCE_PAGE_LIMIT_TOTAL}-page read limit`,
    );
  }

  /** ActionStep is intentionally exposed as a per-action sub-resource rather
   * than in the action catalog. Hydrate it explicitly so the live source is not
   * lossy compared with an uploaded ontology bundle. */
  private async actionSteps(
    actionRef: string,
    domainId: string,
  ): Promise<Node[]> {
    const body = (await this.http(
      `/api/v1/ontology/actions/${encodeURIComponent(actionRef)}/steps?domain=${encodeURIComponent(domainId)}`,
    )) as { action_steps?: unknown[]; nextCursor?: unknown };
    if (!Array.isArray(body?.action_steps)) {
      throw new Error(`Allmeta action steps payload is missing action_steps[]`);
    }
    // The current Allmeta action-step endpoint returns one aggregate Action
    // object and has no limit/cursor request contract. Never invent pagination
    // parameters: if the server starts advertising a cursor, fail closed until
    // both sides implement that public contract.
    if (body.nextCursor !== undefined && body.nextCursor !== null) {
      throw new Error(
        "Allmeta action steps endpoint advertised pagination that this client cannot safely complete",
      );
    }
    const items = objectArray<Node>(body.action_steps, "Allmeta action_steps");
    if (items.length > AllmetaOntologySource.RESOURCE_ITEM_LIMIT) {
      throw new Error(
        `Allmeta action steps exceeded the safe ${AllmetaOntologySource.RESOURCE_ITEM_LIMIT}-item read limit`,
      );
    }
    return items;
  }

  private async mapWithConcurrency<T, R>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const output = new Array<R>(items.length);
    let nextIndex = 0;
    const run = async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        output[index] = await worker(items[index]!, index);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () => run()),
    );
    return output;
  }

  private actionRef(node: Node): string {
    return requiredString(
      node.id ?? node.action_id ?? node.name,
      "Allmeta action id/action_id/name for ActionStep hydration",
    );
  }

  private async readRawSnapshot(domainId: string): Promise<AllmetaRawSnapshot> {
    // These five requests are a fixed-size fan-out. The action-dependent fan-
    // out below is separately bounded so a large domain cannot create an
    // unbounded number of simultaneous HTTP requests.
    const [actions, events, objects, rules, links] = await Promise.all([
      this.list("actions", domainId),
      this.list("events", domainId),
      this.list("objects", domainId),
      this.list("rules", domainId),
      this.list("links", domainId),
    ]);
    const actionSteps = await this.mapWithConcurrency(
      actions,
      AllmetaOntologySource.ACTION_STEP_CONCURRENCY,
      async (action) => {
        const actionRef = this.actionRef(action);
        return {
          actionRef,
          items: await this.actionSteps(actionRef, domainId),
        };
      },
    );
    return { actions, events, objects, rules, links, actionSteps };
  }

  /** All business domains Allmeta knows about (id + display name), cached. */
  private async domains(): Promise<AllmetaDomain[]> {
    if (!this.cfg.baseUrl) {
      throw new OntologyTransportError("ALLMETA_BASE_URL is not configured", {
        failure: "unconfigured",
        transport: "allmeta",
      });
    }
    const now = Date.now();
    if (
      this.domainCache &&
      now - this.domainCache.at < AllmetaOntologySource.DOMAIN_TTL_OK_MS
    ) {
      return this.domainCache.list;
    }
    const body = (await this.http(`/api/domains`)) as {
      domains?: AllmetaDomain[];
    };
    if (!Array.isArray(body?.domains)) {
      throw new Error("Allmeta domain payload is missing domains[]");
    }
    const seen = new Set<string>();
    const domains = body.domains.map((domain, index) => {
      if (!domain || typeof domain !== "object" || Array.isArray(domain)) {
        throw new TypeError(`Allmeta domains[${index}] must be an object`);
      }
      const id = requiredString(domain.id, `Allmeta domains[${index}].id`);
      if (seen.has(id))
        throw new Error(`Allmeta returned duplicate domain id ${id}`);
      seen.add(id);
      if (
        domain.name !== undefined &&
        (typeof domain.name !== "string" || !domain.name.trim())
      ) {
        throw new TypeError(
          `Allmeta domains[${index}].name must be a non-empty string`,
        );
      }
      return { id, ...(domain.name ? { name: domain.name.trim() } : {}) };
    });
    this.domainCache = { at: now, list: domains };
    return domains;
  }

  /** Resolve an AO domain id to the canonical Allmeta id (the resource endpoints
   *  match `?domain=` case-sensitively). Returns the input unchanged when no list
   *  is available or nothing matches (fail-safe). */
  private async resolveDomainId(domainId: string): Promise<string> {
    const list = await this.domains();
    if (this.domainIdentity === "exact") {
      if (!list.some((domain) => domain.id === domainId)) {
        throw new OntologyTransportError(
          `Allmeta catalog does not contain the exact persisted domain id "${domainId}"`,
          {
            failure: "domain_not_in_catalog",
            transport: "allmeta",
            domainId,
          },
        );
      }
      return domainId;
    }
    if (!list.length) return domainId;
    return resolveAllmetaDomainId(list, domainId);
  }

  async listDomains(): Promise<
    Array<{ id: string; name?: string; counts?: Record<string, number> }>
  > {
    // No per-domain counts here: that would mean N extra round-trips. The picker
    // tolerates absent counts; the manifest source still supplies them for local
    // domains via the composite.
    return (await this.domains()).map((d) => ({
      id: d.id,
      name: d.name,
      source: "allmeta" as const,
    }));
  }

  /** Fetch + normalize a domain's ontology from Allmeta. Returns null when the
   *  domain isn't served / the graph is empty (no actions) — fetchOntology turns
   *  that into a strict throw. */
  private async fetchLive(aoDomainId: string): Promise<DomainOntology | null> {
    const domainId = await this.resolveDomainId(aoDomainId);
    // Allmeta currently exposes no graph revision or snapshot token. A single
    // multi-request read could therefore combine Actions from one version with
    // Events/Rules/Steps from another. Read the complete raw graph twice and
    // accept it only when canonical, order-insensitive hashes agree.
    const first = await this.readRawSnapshot(domainId);
    const second = await this.readRawSnapshot(domainId);
    if (rawSnapshotHash(first) !== rawSnapshotHash(second)) {
      throw new OntologyTransportError(
        `Allmeta 域「${domainId}」在读取期间发生变化，无法获得同一版本的完整本体；请稍后重试。`,
        { failure: "domain_unstable", transport: "allmeta", domainId },
      );
    }
    if (second.actions.length === 0) return null;

    const events = second.events.map(normalizeAllmetaEvent);
    const emitByAction = buildEmitByAction(events);
    const normalizedActions = second.actions.map((node) =>
      normalizeAllmetaAction(node, emitByAction),
    );
    const hydratedActions = normalizedActions.map((action, index) => ({
      ...action,
      // A successful dedicated endpoint response is authoritative even when
      // it is explicitly empty. Reusing embedded steps here would resurrect
      // deleted/stale execution logic.
      action_steps: second.actionSteps[index]!.items.map(
        normalizeAllmetaActionStep,
      ),
    }));
    const links = second.links
      .map(normalizeAllmetaManagedLink)
      .filter((link): link is OntologyLink => link !== null);
    return {
      domainId: aoDomainId, // keep the AO-facing id so downstream keying stays stable
      objects: second.objects.map(normalizeAllmetaObject),
      rules: second.rules as OntologyRule[],
      actions: assertUniqueActionsByName(hydratedActions),
      events,
      // Empty means this is an old/no-links domain. Omit the field so legacy
      // ontologies keep their previous readiness semantics.
      ...(links.length ? { links } : {}),
      workflow: [], // Allmeta has no workflow resource (the factory generates it)
      source: "allmeta",
    };
  }

  /** STRICT live read — throws when Allmeta is unreachable / the domain id is
   *  wrong / the graph is empty. No snapshot fallback (the user chose live-only). */
  async fetchOntology(domainId: string): Promise<DomainOntology> {
    if (!this.cfg.baseUrl) {
      throw new OntologyTransportError(
        `本体读取失败：ALLMETA_BASE_URL 未配置，无法从 Allmeta 读取域「${domainId}」。`,
        { failure: "unconfigured", transport: "allmeta", domainId },
      );
    }
    let live: DomainOntology | null;
    try {
      live = await this.fetchLive(domainId);
    } catch (e) {
      // The domain-level sentence stays the same, but the transport reason that
      // produced it is carried forward instead of being flattened into prose.
      //
      // When the cause carries NO typed reason, this read does not know what
      // went wrong, and it says so. It used to claim `payload_contract` —
      // "the ontology service returned content that does not satisfy the read
      // contract" — for every untyped cause, including a TypeError in our own
      // normalizers. That named the wrong party: the FDE was sent to audit
      // their ontology data for a defect that lived here.
      const observed = findOntologyTransportError(e);
      throw new OntologyTransportError(
        `本体读取失败：无法从 Allmeta 读取域「${domainId}」(${(e as Error).message})。已阻断生成——不回退 snapshot。请检查 ALLMETA_BASE_URL 是否可达、域 id 是否正确、Neo4j 是否有该域本体。`,
        {
          failure: observed?.failure ?? "internal",
          transport: "allmeta",
          domainId,
          ...(observed?.upstreamStatus !== undefined
            ? { upstreamStatus: observed.upstreamStatus }
            : {}),
          cause: e,
        },
      );
    }
    if (!live || live.actions.length === 0) {
      throw new OntologyTransportError(
        `本体读取失败：Allmeta 未返回域「${domainId}」的可用本体(actions=${live?.actions.length ?? 0})。已阻断生成——不回退 snapshot。请确认 ALLMETA_BASE_URL 可达、域 id 正确、Neo4j 里灌了该域本体。`,
        { failure: "domain_empty", transport: "allmeta", domainId },
      );
    }
    return live;
  }

  /** Action→step→Rule edges, fetched live so rule-check binds rules at run time. */
  async fetchActionRules(
    domainId: string,
    actionName: string,
  ): Promise<unknown[]> {
    if (!this.cfg.baseUrl) {
      throw new Error("ALLMETA_BASE_URL is required for live action rules");
    }
    const id = await this.resolveDomainId(domainId);
    const body = (await this.http(
      `/api/v1/ontology/actions/${encodeURIComponent(actionName)}/rules?domain=${encodeURIComponent(id)}`,
    )) as { rules?: unknown[]; nextCursor?: unknown } | null;
    if (!body || !Array.isArray(body.rules)) {
      throw new Error(
        `Allmeta returned an invalid rules payload for ${domainId}/${actionName}`,
      );
    }
    // Like /steps, the current Allmeta /rules handler returns one aggregate
    // action response and defines no pagination request parameters. Refuse a
    // future cursor rather than silently treating the first aggregate as full.
    if (body.nextCursor !== undefined && body.nextCursor !== null) {
      throw new Error(
        "Allmeta action rules endpoint advertised pagination that this client cannot safely complete",
      );
    }
    if (body.rules.length > AllmetaOntologySource.RESOURCE_ITEM_LIMIT) {
      throw new Error(
        `Allmeta action rules exceeded the safe ${AllmetaOntologySource.RESOURCE_ITEM_LIMIT}-item read limit`,
      );
    }
    return body.rules;
  }

  /**
   * Bounded, read-only instance sampling for OntoCode Analyst. This is not a
   * general query escape hatch: the object label comes from the already-read
   * ontology and callers may only request a small explicit page. Sensitive
   * values are redacted by the Analyst before persistence or model use.
   */
  async listInstances(
    domainId: string,
    objectType: string,
    opts: { limit: number },
  ): Promise<OntologyInstancePage> {
    if (!this.cfg.baseUrl) {
      throw new Error("ALLMETA_BASE_URL is required for live instances");
    }
    const label = requiredString(objectType, "Allmeta instance object type");
    if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 20) {
      throw new RangeError("Allmeta instance sample limit must be an integer from 1 to 20");
    }
    const id = await this.resolveDomainId(domainId);
    const query = new URLSearchParams({
      domain: id,
      limit: String(opts.limit),
    });
    const body = (await this.http(
      `/api/v1/ontology/instances/${encodeURIComponent(label)}?${query.toString()}`,
    )) as { items?: unknown[]; nextCursor?: unknown } | null;
    if (!body || !Array.isArray(body.items)) {
      throw new Error(
        `Allmeta returned an invalid instances payload for ${domainId}/${label}`,
      );
    }
    const items = objectArray<Record<string, unknown>>(
      body.items,
      `Allmeta ${label} instances`,
    );
    if (items.length > opts.limit) {
      throw new Error(
        `Allmeta ${label} returned ${items.length} rows for a bounded ${opts.limit}-row sample`,
      );
    }
    const nextCursor = body.nextCursor;
    if (
      nextCursor !== undefined &&
      nextCursor !== null &&
      (typeof nextCursor !== "string" || !nextCursor.trim())
    ) {
      throw new Error(`Allmeta ${label} returned an invalid nextCursor`);
    }
    return {
      items,
      nextCursor:
        typeof nextCursor === "string" ? nextCursor.trim() : null,
    };
  }
}
