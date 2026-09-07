#!/usr/bin/env node
/**
 * Load an immutable Ontology Package archive (schema bundle 3.2.0:
 * `{artifacts:{objects,rules,actions,events,links,workflows}, manifest}`) into
 * the AllmetaOntology Neo4j graph as ONE domain, next to the domains already
 * there (RAAS-v1 / Agents-generation / 采购计划-v1 / 费控-v1 / 能源调度-v1 …).
 *
 *   node scripts/load-ontology-package-neo4j.mjs \
 *     --package ontology-packages/procurement-hc-formal/source/package.json \
 *     --domain 采购-HC-Formal --tenant-slug procurement-hc-formal [--dry]
 *
 * Environment (same names the runtime `ontology.query` tool reads, see
 * .env.example): NEO4J_QUERY_API_URL (origin or full /db/<db>/query/v2 URL,
 * default http://localhost:7474), NEO4J_DATABASE (default neo4j),
 * NEO4J_USERNAME (default neo4j), NEO4J_PASSWORD (required unless --dry).
 *
 * Transport: Neo4j Query API v2 over HTTP — no driver dependency, and the
 * same endpoint/credentials the agents' read-only tool uses, so what this
 * loads is exactly what `ontology.query` can retrieve.
 *
 * Graph vocabulary matches the loaders already used for this graph
 * (ontology-agents-demo/scripts/load-neo4j.mjs and the Studio release path):
 *   nodes  DataObject / Action / ActionStep / Event / EventField /
 *          EventMutation / Rule / Workflow / WorkflowStep
 *   rels   TRIGGERS EMITS TARGETS READS MUTATES CARRIES APPLIES_TO GOVERNS
 *          HAS_STEP HAS_FIELD HAS_MUTATION REFERENCES INCLUDES WORKFLOW_STEP
 *          NEXT_STEP RUNS
 * Every node carries `domainId` (graph partition, like the existing domains),
 * plus `tenant_slug` + `id` (what ontology.query's server-owned predicates
 * key on: NEO4J_TENANT_PROPERTY=tenant_slug, NEO4J_ID_PROPERTY=id) and the
 * package provenance (package_id / release / package_hash).
 *
 * Idempotent: the target domainId is deleted first and rewritten in full;
 * no other domain is touched. Fails closed on hash mismatch or any statement
 * error (a half-loaded domain is worse than none, so the delete + writes run
 * in one implicit-transaction request each and the final counts are checked
 * against the archive).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg, index) => !(arg === "--" && index === 0)),
  options: {
    package: { type: "string" },
    domain: { type: "string" },
    "tenant-slug": { type: "string" },
    dry: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

const USAGE =
  "usage: load-ontology-package-neo4j --package <package.json> --domain <domainId> --tenant-slug <slug> [--dry]";

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

function fail(message) {
  console.error(`[load-ontology-package-neo4j] ${message}`);
  process.exit(1);
}

if (!values.package || !values.domain || !values["tenant-slug"]) {
  console.error(USAGE);
  process.exit(2);
}
if (!/^[a-z][a-z0-9-]{1,31}$/.test(values["tenant-slug"])) {
  fail(`--tenant-slug must be a tenant slug (lowercase, ${values["tenant-slug"]} given)`);
}

// ── read + verify the archive ────────────────────────────────────────────────
const packagePath = path.resolve(values.package);
const bytes = readFileSync(packagePath);
const archive = JSON.parse(bytes.toString("utf8"));
const manifest = archive?.manifest;
const artifacts = archive?.artifacts;
if (!manifest || !artifacts) fail(`${packagePath} is not an ontology package archive`);
try {
  const sidecar = JSON.parse(readFileSync(path.join(path.dirname(packagePath), "manifest.json"), "utf8"));
  const sha = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (sidecar.file?.sha256 && sidecar.file.sha256 !== sha) {
    fail(`archive sha256 ${sha} != manifest.json file.sha256 ${sidecar.file.sha256}`);
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
for (const family of ["objects", "rules", "actions", "events", "links", "workflows"]) {
  if (!Array.isArray(artifacts[family])) fail(`artifacts.${family} must be an array`);
}

const DOMAIN = values.domain;
const TENANT_SLUG = values["tenant-slug"];
const SOURCE = `${manifest.package_id}@${manifest.release}`;
const now = new Date().toISOString();
const J = (value) => JSON.stringify(value ?? null);
const provenance = {
  domainId: DOMAIN,
  tenant_slug: TENANT_SLUG,
  source: SOURCE,
  package_id: manifest.package_id,
  release: manifest.release,
  package_hash: manifest.package_hash,
  schema_bundle_version: manifest.schema_bundle_version,
  updated_at: now,
};

// ── node rows (property values must be primitives or arrays of primitives) ──
const { objects, rules, actions, events, links, workflows } = artifacts;

const objRows = objects.map((o) => ({
  id: o.id,
  uid: o.id,
  name: o.name ?? o.id,
  description: o.description ?? "",
  type: o.type ?? "data",
  primary_key: o.primary_key ?? "",
  property_count: (o.properties ?? []).length,
  property_names: (o.properties ?? []).map((p) => p.name),
  properties_json: J(o.properties),
  lifecycle_json: J({
    state_property: o.lifecycle_state_property,
    initial: o.lifecycle_initial_state,
    states: o.lifecycle_states,
    transitions: o.lifecycle_transitions,
  }),
  relationship_description: o.relationship_description ?? "",
  synonyms: o.synonyms ?? [],
  extensions_json: J(o.extensions),
  agent_facets_json: J(o.agent_facets),
  raw_json: J(o),
}));

const actRows = actions.map((a) => ({
  id: a.id,
  action_id: a.id,
  name: a.name ?? a.id,
  description: a.description ?? "",
  category: a.category ?? "",
  actor: a.actor ?? [],
  trigger_events: a.trigger ?? [],
  triggered_events: a.triggered_event ?? [],
  target_objects: a.target_objects ?? [],
  tool_use: (a.tool_use ?? []).map((tool) => (typeof tool === "string" ? tool : tool?.name ?? "")),
  implementation_kind: a.implementation?.kind ?? "",
  implementation_json: J(a.implementation),
  inputs_json: J(a.inputs),
  outputs_json: J(a.outputs),
  steps_json: J(a.action_steps),
  rule_bindings_json: J(a.rule_bindings),
  side_effects_json: J(a.side_effects),
  submission_criteria: a.submission_criteria ?? "",
  object_type: a.object_type ?? "",
  provenance_json: J(a.provenance),
  raw_json: J(a),
}));

const stepRows = actions.flatMap((a) =>
  (a.action_steps ?? []).map((s, i) => ({
    id: s.id ?? `${a.id}#${s.order ?? i + 1}`,
    step_id: s.id ?? `${a.id}#${s.order ?? i + 1}`,
    action_id: a.id,
    name: s.name ?? "",
    description: s.description ?? "",
    object_type: s.object_type ?? "manual",
    step_order: String(s.order ?? i + 1),
    submission_criteria: s.submission_criteria ?? "",
  })),
);

const evtRows = events.map((e) => ({
  id: e.name,
  event_id: e.name,
  name: e.name,
  description: e.description ?? "",
  source_action: e.payload?.source_action ?? "",
  event_version: e.event_version ?? "1.0.0",
  field_names: (e.payload?.event_data ?? []).map((f) => f.name),
  event_data_json: J(e.payload?.event_data),
  mutations_json: J(e.payload?.state_mutations),
  mutation_targets: (e.payload?.state_mutations ?? []).map((m) => m.target_object),
  producers_json: J(e.producers),
  subscribers_json: J(e.subscribers),
  status: "published",
  raw_json: J(e),
}));

const fieldRows = events.flatMap((e) =>
  (e.payload?.event_data ?? []).map((f, i) => ({
    id: `${e.name}#f${i}`,
    field_id: `${e.name}#f${i}`,
    event_id: e.name,
    name: f.name,
    type: f.type ?? "String",
    description: f.description ?? "",
    target_object: f.target_object ?? "",
    required: f.required === true,
  })),
);

const mutRows = events.flatMap((e) =>
  (e.payload?.state_mutations ?? []).map((m, i) => ({
    id: `${e.name}#m${i}`,
    mutation_id: `${e.name}#m${i}`,
    event_id: e.name,
    target_object: m.target_object ?? "",
    mutation_type: m.mutation_type ?? "update",
    impacted: m.impacted_properties ?? [],
  })),
);

const ruleRows = rules.map((r) => ({
  id: r.id,
  rule_id: r.id,
  name: r.name ?? r.id,
  rule_name: r.name ?? r.id,
  description: r.description ?? "",
  category: r.category ?? "",
  rule_kind: r.kind ?? "",
  phase: r.phase ?? "",
  executor: r.executor ?? "System",
  priority: r.priority ?? null,
  machine_expression: r.machine_expression?.source ?? "",
  machine_expression_json: J(r.machine_expression),
  outcome_json: J(r.outcome),
  related_entities: r.scope?.objectTypeIds ?? [],
  scope_json: J(r.scope),
  provenance_json: J(r.provenance),
  raw_json: J(r),
}));

const wfRows = workflows.map((w) => ({
  id: w.id,
  workflow_id: w.id,
  name: w.name ?? w.id,
  name_zh: w.nameZh ?? w.name ?? w.id,
  description: w.descriptionZh ?? w.description ?? "",
  workflow_version: w.workflow_version ?? "",
  actor: w.actor ?? [],
  trigger_events: (w.triggers ?? []).filter((t) => t.kind === "event").map((t) => t.event_id),
  trigger_texts: w.trigger ?? [],
  triggered_events: w.triggered_event ?? [],
  entry_step_ids: w.entry_step_ids ?? [],
  action_ids: (w.actions ?? []).map((a) => a.name).filter(Boolean),
  rule_refs: w.rule_refs ?? [],
  object_refs: w.object_refs ?? [],
  roles_json: J(w.roles),
  triggers_json: J(w.triggers),
  steps_json: J(w.steps),
  orchestration_json: J(w.orchestration),
  extensions_json: J(w.extensions),
  raw_json: J(w),
}));

const wfStepRows = workflows.flatMap((w) =>
  (w.steps ?? []).map((s, i) => ({
    id: `${w.id}#${s.id ?? i}`,
    workflow_step_id: `${w.id}#${s.id ?? i}`,
    workflow_id: w.id,
    step_id: s.id ?? String(i),
    name: s.name ?? s.id ?? "",
    description: s.description ?? "",
    action_id: s.action_id ?? "",
    node_kind: s.node_kind ?? "",
    step_order: String(s.order ?? i + 1),
    emitted_event_ids: s.emitted_event_ids ?? [],
    guard_rule_ids: s.guard_rule_ids ?? [],
    next_step_ids: (s.next ?? []).map((n) => n.to_step_id).filter(Boolean),
    next_json: J(s.next),
    api_bindings_json: J(s.api_bindings),
    raw_json: J(s),
  })),
);

// ── relationship rows ────────────────────────────────────────────────────────
const RELMAP = {
  "action-trigger": { t: "TRIGGERS", fl: "Event", tl: "Action" },
  "action-emission": { t: "EMITS", fl: "Action", tl: "Event" },
  "action-targets-object": { t: "TARGETS", fl: "Action", tl: "DataObject" },
  "action-reads": { t: "READS", fl: "Action", tl: "DataObject" },
  "action-mutates": { t: "MUTATES", fl: "Action", tl: "DataObject" },
  "event-carries-object": { t: "CARRIES", fl: "Event", tl: "DataObject" },
  "event-mutates-object": { t: "MUTATES", fl: "Event", tl: "DataObject" },
  "rule-references-object": { t: "APPLIES_TO", fl: "Rule", tl: "DataObject" },
  "rule-governs-action": { t: "GOVERNS", fl: "Rule", tl: "Action" },
  "object-fk": { t: "REFERENCES", fl: "DataObject", tl: "DataObject" },
  "object-composition": { t: "REFERENCES", fl: "DataObject", tl: "DataObject" },
  "workflow-includes": { t: "INCLUDES", fl: "Workflow", tl: "Action" },
  "workflow-step-action": { t: "RUNS", fl: "WorkflowStep", tl: "Action" },
};
const LABEL_BY_LINK_TYPE = {
  Object: "DataObject",
  DataObject: "DataObject",
  Action: "Action",
  Event: "Event",
  Rule: "Rule",
  Workflow: "Workflow",
  WorkflowStep: "WorkflowStep",
};

const relGroups = new Map();
const unmappedKinds = new Map();
for (const l of links) {
  const mapping = RELMAP[l.kind];
  if (!mapping) {
    unmappedKinds.set(l.kind, (unmappedKinds.get(l.kind) ?? 0) + 1);
    continue;
  }
  const fromLabel = LABEL_BY_LINK_TYPE[l.from?.type] ?? mapping.fl;
  const toLabel = LABEL_BY_LINK_TYPE[l.to?.type] ?? mapping.tl;
  const key = `${mapping.t}|${fromLabel}|${toLabel}`;
  if (!relGroups.has(key)) relGroups.set(key, { t: mapping.t, fl: fromLabel, tl: toLabel, rows: [] });
  relGroups.get(key).rows.push({
    from: l.from?.id,
    to: l.to?.id,
    link_id: l.id ?? "",
    name: l.name ?? "",
    kind: l.kind,
    cardinality: l.cardinality ?? "",
    inverse_name: l.inverse_name ?? "",
    link_extensions_json: J(l.extensions),
    display_name_json: J({ from: l.from?.displayName, to: l.to?.displayName }),
  });
}

// Structural relationships derived from the artifacts themselves. The links
// family is the authority for business relationships: a TRIGGERS / EMITS /
// TARGETS pair it already declares is NOT derived again (a MERGE on a
// relationship carrying different properties creates a second edge, which is
// exactly the duplication the first load of this domain produced).
const linked = new Set();
for (const group of relGroups.values()) {
  for (const row of group.rows) linked.add(`${group.t}|${row.from}|${row.to}`);
}
const notLinked = (type, from, to) => !linked.has(`${type}|${from}|${to}`);
const governRows = actions.flatMap((a) =>
  (a.rule_bindings ?? []).map((b) => ({
    from: b.rule_id,
    to: a.id,
    phase: b.phase ?? "",
    enforcement: b.enforcement ?? "",
    failure_policy: b.failure_policy ?? "",
    binding_id: b.id ?? "",
  })),
);
const triggerRows = actions.flatMap((a) =>
  (a.trigger ?? [])
    .filter((event) => events.some((e) => e.name === event) && notLinked("TRIGGERS", event, a.id))
    .map((event) => ({ from: event, to: a.id })),
);
const emitRows = actions.flatMap((a) =>
  (a.triggered_event ?? [])
    .filter((event) => events.some((e) => e.name === event) && notLinked("EMITS", a.id, event))
    .map((event) => ({ from: a.id, to: event })),
);
const targetRows = actions.flatMap((a) =>
  (a.target_objects ?? [])
    .filter((object) => objects.some((o) => o.id === object) && notLinked("TARGETS", a.id, object))
    .map((object) => ({ from: a.id, to: object })),
);
const wfNextRows = wfStepRows.flatMap((s) =>
  s.next_step_ids.map((next) => ({ from: s.workflow_step_id, to: `${s.workflow_id}#${next}` })),
);

// ── transport: Neo4j Query API v2 ────────────────────────────────────────────
function endpoint() {
  const raw = process.env.NEO4J_QUERY_API_URL?.trim() || "http://localhost:7474";
  const database = process.env.NEO4J_DATABASE?.trim() || "neo4j";
  const url = new URL(raw);
  if (!/\/db\/[^/]+\/query\/v2\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/db/${encodeURIComponent(database)}/query/v2`;
  }
  return url;
}

async function cypher(statement, parameters = {}) {
  const username = process.env.NEO4J_USERNAME?.trim() || "neo4j";
  const password = process.env.NEO4J_PASSWORD ?? "";
  if (!password) fail("NEO4J_PASSWORD is not set (refusing to guess a graph credential)");
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    },
    body: JSON.stringify({ statement, parameters }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) {
    const detail = body.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? `HTTP ${response.status}`;
    throw new Error(`${detail}\n  statement: ${statement.split("\n")[0]}`);
  }
  return {
    values: body.data?.values ?? [],
    fields: body.data?.fields ?? [],
    counters: body.counters ?? {},
  };
}

async function main() {
  const relTotal = [...relGroups.values()].reduce((sum, group) => sum + group.rows.length, 0);
  console.log(`[load-ontology-package-neo4j] ${SOURCE} → domainId="${DOMAIN}" tenant_slug="${TENANT_SLUG}"${values.dry ? "  [dry-run]" : ""}`);
  console.log(
    `  nodes: DataObject ${objRows.length} · Action ${actRows.length} · ActionStep ${stepRows.length} · Event ${evtRows.length} · EventField ${fieldRows.length} · EventMutation ${mutRows.length} · Rule ${ruleRows.length} · Workflow ${wfRows.length} · WorkflowStep ${wfStepRows.length}`,
  );
  console.log(
    `  rels: links ${relTotal} (of ${links.length}) · GOVERNS ${governRows.length} · TRIGGERS ${triggerRows.length} · EMITS ${emitRows.length} · TARGETS ${targetRows.length} · HAS_STEP ${stepRows.length} · HAS_FIELD ${fieldRows.length} · HAS_MUTATION ${mutRows.length} · WORKFLOW_STEP ${wfStepRows.length} · NEXT_STEP ${wfNextRows.length}`,
  );
  if (unmappedKinds.size) {
    console.log(`  unmapped link kinds (skipped): ${[...unmappedKinds].map(([k, c]) => `${k}×${c}`).join(", ")}`);
  }
  if (values.dry) return;

  const del = await cypher("MATCH (n {domainId:$d}) DETACH DELETE n", { d: DOMAIN });
  console.log(`  cleared previous domain nodes: ${del.counters?.nodesDeleted ?? 0}`);

  const nodeBatches = [
    ["DataObject", objRows],
    ["Action", actRows],
    ["ActionStep", stepRows],
    ["Event", evtRows],
    ["EventField", fieldRows],
    ["EventMutation", mutRows],
    ["Rule", ruleRows],
    ["Workflow", wfRows],
    ["WorkflowStep", wfStepRows],
  ];
  for (const [label, rows] of nodeBatches) {
    if (!rows.length) continue;
    await cypher(`UNWIND $rows AS r CREATE (n:${label}) SET n = r, n += $prov`, { rows, prov: provenance });
  }
  console.log("  nodes written");

  const rel = (statement, rows) => (rows.length ? cypher(statement, { rows, d: DOMAIN }) : Promise.resolve());
  await rel(
    `UNWIND $rows AS r MATCH (a:Action {domainId:$d, action_id:r.action_id}), (s:ActionStep {domainId:$d, step_id:r.step_id}) CREATE (a)-[:HAS_STEP {order:r.step_order}]->(s)`,
    stepRows,
  );
  await rel(
    `UNWIND $rows AS r MATCH (e:Event {domainId:$d, event_id:r.event_id}), (f:EventField {domainId:$d, field_id:r.field_id}) CREATE (e)-[:HAS_FIELD]->(f)`,
    fieldRows,
  );
  await rel(
    `UNWIND $rows AS r MATCH (e:Event {domainId:$d, event_id:r.event_id}), (m:EventMutation {domainId:$d, mutation_id:r.mutation_id}) CREATE (e)-[:HAS_MUTATION]->(m)`,
    mutRows,
  );
  await rel(
    `UNWIND $rows AS r MATCH (ru:Rule {domainId:$d, rule_id:r.from}), (a:Action {domainId:$d, action_id:r.to}) CREATE (ru)-[:GOVERNS {phase:r.phase, enforcement:r.enforcement, failure_policy:r.failure_policy, binding_id:r.binding_id}]->(a)`,
    governRows,
  );
  await rel(
    `UNWIND $rows AS r MATCH (e:Event {domainId:$d, event_id:r.from}), (a:Action {domainId:$d, action_id:r.to}) MERGE (e)-[:TRIGGERS]->(a)`,
    triggerRows,
  );
  await rel(
    `UNWIND $rows AS r MATCH (a:Action {domainId:$d, action_id:r.from}), (e:Event {domainId:$d, event_id:r.to}) MERGE (a)-[:EMITS]->(e)`,
    emitRows,
  );
  await rel(
    `UNWIND $rows AS r MATCH (a:Action {domainId:$d, action_id:r.from}), (o:DataObject {domainId:$d, uid:r.to}) MERGE (a)-[:TARGETS]->(o)`,
    targetRows,
  );
  await rel(
    `UNWIND $rows AS r MATCH (w:Workflow {domainId:$d, workflow_id:r.workflow_id}), (s:WorkflowStep {domainId:$d, workflow_step_id:r.workflow_step_id}) CREATE (w)-[:WORKFLOW_STEP {order:r.step_order}]->(s)`,
    wfStepRows,
  );
  await rel(
    `UNWIND $rows AS r MATCH (s:WorkflowStep {domainId:$d, workflow_step_id:r.workflow_step_id}), (a:Action {domainId:$d, action_id:r.action_id}) WHERE r.action_id <> '' MERGE (s)-[:RUNS]->(a)`,
    wfStepRows,
  );
  await rel(
    `UNWIND $rows AS r MATCH (a:WorkflowStep {domainId:$d, workflow_step_id:r.from}), (b:WorkflowStep {domainId:$d, workflow_step_id:r.to}) MERGE (a)-[:NEXT_STEP]->(b)`,
    wfNextRows,
  );
  for (const group of relGroups.values()) {
    await cypher(
      `UNWIND $rows AS r
       MATCH (a:${group.fl} {domainId:$d, id:r.from}), (b:${group.tl} {domainId:$d, id:r.to})
       MERGE (a)-[rel:${group.t} {link_id:r.link_id}]->(b)
       SET rel.name = r.name, rel.kind = r.kind, rel.cardinality = r.cardinality,
           rel.inverse_name = r.inverse_name, rel.link_extensions_json = r.link_extensions_json,
           rel.display_name_json = r.display_name_json`,
      { rows: group.rows, d: DOMAIN },
    );
  }
  console.log("  relationships written");

  const labelCounts = await cypher(
    "MATCH (n {domainId:$d}) WITH labels(n)[0] AS l, count(n) AS c RETURN l, c ORDER BY l",
    { d: DOMAIN },
  );
  const expected = {
    DataObject: objRows.length,
    Action: actRows.length,
    ActionStep: stepRows.length,
    Event: evtRows.length,
    EventField: fieldRows.length,
    EventMutation: mutRows.length,
    Rule: ruleRows.length,
    Workflow: wfRows.length,
    WorkflowStep: wfStepRows.length,
  };
  let mismatch = false;
  for (const [label, count] of labelCounts.values) {
    const ok = expected[label] === count;
    if (!ok) mismatch = true;
    console.log(`  ${ok ? "✓" : "✗"} ${String(label).padEnd(14)} ${count}${ok ? "" : ` (expected ${expected[label]})`}`);
  }
  const relCounts = await cypher(
    "MATCH ({domainId:$d})-[r]->({domainId:$d}) RETURN type(r) AS t, count(*) AS c ORDER BY t",
    { d: DOMAIN },
  );
  for (const [type, count] of relCounts.values) console.log(`  ✓ [${String(type).padEnd(14)}] ${count}`);
  const tenantScoped = await cypher(
    "MATCH (n {tenant_slug:$slug, domainId:$d}) RETURN count(n) AS c",
    { slug: TENANT_SLUG, d: DOMAIN },
  );
  console.log(`  tenant_slug="${TENANT_SLUG}" nodes: ${tenantScoped.values[0]?.[0] ?? 0}`);
  if (mismatch) fail("node counts do not match the archive — domain left in place for inspection, rerun after fixing");
}

main().catch((error) => {
  console.error("[load-ontology-package-neo4j] failed:", error.message);
  process.exit(1);
});
