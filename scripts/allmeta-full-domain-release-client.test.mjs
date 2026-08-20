import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  HELP_TEXT,
  assertNoAllmetaStorageMetadata,
  buildDiscoveryRequest,
  buildReviewedPreviewRequest,
  classifyDiscoveryBlockers,
  compareManagedLinkCoverage,
  deriveRequiredConfirmations,
  exitCodeForSummary,
  extractDiscoveryEvidence,
  hashActionCandidate,
  hashEventCandidate,
  hashFullDomainArtifact,
  parseCli,
  parseDotEnv,
  resolveOwnershipConfirmations,
  run,
  validateReleaseBundle,
  verifyReleaseReadback,
} from "./allmeta-full-domain-release-client.mjs";

// Unit tests must not depend on an operator's untracked release artifact.
// The real client still defaults to that reviewed file, while this fixture
// exercises the exact schema/hash/readback protocol in a fresh checkout.
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "allmeta-release-bundle-"));
const BUNDLE_PATH = join(FIXTURE_DIR, "release-bundle.json");
const step = { id: "step-reviewed", name: "reviewed-step", type: "logic" };
const RAW_BUNDLE = {
  schemaVersion: 1,
  domainId: "Agents-generation",
  version: "v0_4_001",
  generatedAt: "2026-07-15T00:00:00.000Z",
  mode: "exact-domain-replacement",
  payloadDigest: "",
  releaseGrounding: {
    schema: "agents-generation-release-grounding/v1",
    allmetaRulesRead: true,
    liveRuleCount: 1,
    liveRuleDigest: `sha256:${"e".repeat(64)}`,
    mode: "live_allmeta_api",
    releasable: true,
  },
  sourceDigests: { live_rules_before_release: `sha256:${"e".repeat(64)}` },
  objects: [{ id: "Candidate", name: "Candidate" }],
  rules: [{ id: "rule-1", name: "Reviewed rule" }],
  actions: [{ id: "4", name: "createJD", action_steps: [step] }],
  actionSteps: [{ ...step, action_id: "4", action_name: "createJD" }],
  events: [{ name: "REVIEWED_EVENT", payload: { event_data: [], state_mutations: [] } }],
  policyScopes: [{ id: "scope-1", name: "Reviewed scope" }],
  links: [{
    id: "link-1",
    kind: "READS",
    status: "approved",
    from: { label: "Action", id: "4" },
    to: { label: "DataObject", id: "Candidate" },
  }],
};
RAW_BUNDLE.payloadDigest = hashFullDomainArtifact({
  objects: RAW_BUNDLE.objects,
  rules: RAW_BUNDLE.rules,
  actions: RAW_BUNDLE.actions,
  actionSteps: RAW_BUNDLE.actionSteps,
  events: RAW_BUNDLE.events,
  policyScopes: RAW_BUNDLE.policyScopes,
  links: RAW_BUNDLE.links,
});
writeFileSync(BUNDLE_PATH, `${JSON.stringify(RAW_BUNDLE)}\n`, { mode: 0o600 });
after(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }));
const BUNDLE = validateReleaseBundle(RAW_BUNDLE);
const hash = (character) => `sha256:${character.repeat(64)}`;

function discoveryResponse(overrides = {}) {
  return {
    schema_version: 1,
    mode: "preview_only",
    domain: "Agents-generation",
    ready: false,
    next: "ask_user",
    blockers: [],
    candidate: null,
    preview: {
      action_candidate_hash: BUNDLE.hashes.actions,
      event_candidate_hash: BUNDLE.hashes.events,
      full_domain: {
        object_candidate_hash: BUNDLE.hashes.objects,
        rule_candidate_hash: BUNDLE.hashes.rules,
        policy_scope_candidate_hash: BUNDLE.hashes.policy_scopes,
        link_candidate_hash: BUNDLE.hashes.links,
      },
      action: {
        removed_action_ids: [],
        removed_step_keys: [],
        unclaimed_domainless_actions: [],
        unclaimed_domainless_step_keys: [],
      },
      event: {
        removed_event_names: [],
        graph_domainless_event_names_before_claim: [],
      },
    },
    evidence: {
      authoritative_snapshots: {
        action: { ready: true, version: 4, hash: hash("a") },
        event: { ready: true, version: 7, hash: hash("b") },
        full_domain_graph: { ready: true, hash: hash("c"), node_count: 1, relationship_count: 0 },
      },
      dependency_pins: {
        ready: true,
        observed: ["objects", "rules", "links"].map((artifact, index) => ({
          artifact,
          domain: "Agents-generation",
          identity: `${artifact}_v0_2_00${index + 1}.json`,
          version: index + 1,
          hash: hash(String(index + 1)),
        })),
      },
    },
    ...overrides,
  };
}

test("validates a self-contained reviewed Agents-generation bundle", () => {
  assert.deepEqual(
    {
      objects: BUNDLE.objects.length,
      rules: BUNDLE.rules.length,
      actions: BUNDLE.actions.length,
      actionSteps: BUNDLE.steps.length,
      events: BUNDLE.events.length,
      policyScopes: BUNDLE.policyScopes.length,
      links: BUNDLE.links.length,
    },
    { objects: 1, rules: 1, actions: 1, actionSteps: 1, events: 1, policyScopes: 1, links: 1 },
  );
  assert.match(BUNDLE.hashes.actions, /^sha256:[0-9a-f]{64}$/);
});

test("rejects Allmeta graph-storage metadata before any HTTP request", async () => {
  const polluted = structuredClone(RAW_BUNDLE);
  Object.assign(polluted.rules[0], {
    __allmeta_definition_json: JSON.stringify({ id: "rule-1", name: "stale graph definition" }),
    __allmeta_position: 9,
    source_file: "rules_v0_1_005.json",
    relatedEntities: ["Candidate"],
    relatedEntities_json: JSON.stringify(["Candidate"]),
  });
  polluted.payloadDigest = hashFullDomainArtifact({
    objects: polluted.objects,
    rules: polluted.rules,
    actions: polluted.actions,
    actionSteps: polluted.actionSteps,
    events: polluted.events,
    policyScopes: polluted.policyScopes,
    links: polluted.links,
  });
  assert.throws(
    () => validateReleaseBundle(polluted),
    /server-owned Allmeta storage metadata.*__allmeta_definition_json/,
  );
  assert.throws(
    () => assertNoAllmetaStorageMetadata({
      action: { action_steps: [{ id: "step-1", __allmeta_position: 0 }] },
    }),
    /server-owned Allmeta storage metadata.*__allmeta_position/,
  );

  const pollutedPath = join(FIXTURE_DIR, "polluted-release-bundle.json");
  writeFileSync(pollutedPath, `${JSON.stringify(polluted)}\n`, { mode: 0o600 });
  let httpCalls = 0;
  await assert.rejects(
    () => run({
      ...parseCli([]),
      bundle: pollutedPath,
      auditDir: join(FIXTURE_DIR, "polluted-audit"),
      baseUrl: "http://localhost:3500",
    }, {
      env: { ONTOLOGY_API_TOKEN: "ordinary-test-token" },
      fetchImpl: async () => {
        httpCalls += 1;
        throw new Error("HTTP must not be reached");
      },
    }),
    /server-owned Allmeta storage metadata/,
  );
  assert.equal(httpCalls, 0);
});

test("refuses an offline-scaffold bundle before any Allmeta request", () => {
  assert.throws(
    () => validateReleaseBundle({
      ...RAW_BUNDLE,
      releaseGrounding: {
        ...RAW_BUNDLE.releaseGrounding,
        allmetaRulesRead: false,
        liveRuleCount: 0,
        mode: "offline_scaffold_test",
        releasable: false,
      },
    }),
    /not grounded in a non-empty live Allmeta Rules read/,
  );
});

test("v0.4 gate rejects stale payload digests, malformed bundle versions, and duplicate stable step ids", () => {
  assert.throws(
    () => validateReleaseBundle({ ...RAW_BUNDLE, payloadDigest: `sha256:${"f".repeat(64)}` }),
    /payloadDigest mismatch/,
  );
  assert.doesNotThrow(
    () => validateReleaseBundle({ ...RAW_BUNDLE, version: "v0_4_002" }),
    "the client validates the reviewed version carried by the bundle instead of a hard-coded release",
  );
  assert.throws(
    () => validateReleaseBundle({ ...RAW_BUNDLE, version: "0.4.1" }),
    /canonical v<major>_<minor>_<patch>/,
  );
  const duplicateStep = structuredClone(RAW_BUNDLE);
  duplicateStep.actions[0].action_steps.push({ ...step, name: "another-name" });
  duplicateStep.actionSteps.push({ ...step, name: "another-name", action_id: "4", action_name: "createJD" });
  duplicateStep.payloadDigest = hashFullDomainArtifact({
    objects: duplicateStep.objects,
    rules: duplicateStep.rules,
    actions: duplicateStep.actions,
    actionSteps: duplicateStep.actionSteps,
    events: duplicateStep.events,
    policyScopes: duplicateStep.policyScopes,
    links: duplicateStep.links,
  });
  assert.throws(() => validateReleaseBundle(duplicateStep), /duplicate identity/);
});

test("candidate hash functions match the server's documented ordering contracts", () => {
  const actions = [{ id: "2", name: "b", value: { z: 1, a: 2 } }, { id: "1", name: "a" }];
  const events = [{ name: "z", payload: { b: 1, a: 2 } }, { name: "a" }];
  assert.equal(hashActionCandidate(actions), hashActionCandidate([...actions].reverse()));
  assert.equal(hashEventCandidate(events), hashEventCandidate([...events].reverse()));
  assert.notEqual(hashFullDomainArtifact(actions), hashFullDomainArtifact([...actions].reverse()));
});

test("discovery preview is deliberately unable to persist a ready candidate", () => {
  const request = buildDiscoveryRequest(BUNDLE);
  assert.equal(request.reviewed.action_parent_hash, hash("0"));
  assert.equal(request.reviewed.event_parent_hash, hash("0"));
  assert.equal("dependency_pins" in request.reviewed, false);
  assert.deepEqual(request.confirmations, {
    claimable_legacy_actions: [],
    claimable_legacy_step_keys: [],
    removed_action_ids: [],
    removed_step_keys: [],
    claimable_legacy_event_names: [],
    unclaimed_domainless_event_names: [],
    removed_event_names: [],
  });
});

test("extracts structured server evidence and reconstructs immutable pin source identities", () => {
  const evidence = extractDiscoveryEvidence(discoveryResponse(), BUNDLE);
  assert.equal(evidence.parent.action_version, 4);
  assert.equal(evidence.parent.event_version, 7);
  assert.deepEqual(
    evidence.dependency_pins.map((pin) => pin.source_identity),
    evidence.dependency_pins.map((pin) => `Agents-generation/${pin.identity}`),
  );
});

test("requires explicit domain-less ownership review and accepts only an exact partition", () => {
  const response = discoveryResponse();
  response.preview.action.unclaimed_domainless_actions = [
    { id: "4", name: "legacy-createJD" },
    { id: "foreign", name: "foreign" },
  ];
  response.preview.action.unclaimed_domainless_step_keys = [
    JSON.stringify(["4", "legacy-step"]),
    JSON.stringify(["foreign", "foreign-step"]),
  ];
  response.preview.event.graph_domainless_event_names_before_claim = ["OWNED", "FOREIGN"];
  const evidence = extractDiscoveryEvidence(response, BUNDLE);
  const before = { resources: { actions: [{ id: "4", name: "createJD" }] } };
  const required = deriveRequiredConfirmations(evidence, before, BUNDLE);
  assert.deepEqual(required.claimable_legacy_actions, [{ id: "4", name: "legacy-createJD" }]);
  assert.deepEqual(required.claimable_legacy_step_keys, [JSON.stringify(["4", "legacy-step"])]);
  assert.equal(resolveOwnershipConfirmations(required, null).ready, false);
  const resolved = resolveOwnershipConfirmations(required, {
    domain: "Agents-generation",
    claimable_legacy_actions: required.claimable_legacy_actions,
    claimable_legacy_step_keys: required.claimable_legacy_step_keys,
    claimable_legacy_event_names: ["OWNED"],
    unclaimed_domainless_event_names: ["FOREIGN"],
  });
  assert.equal(resolved.ready, true);
  const request = buildReviewedPreviewRequest(BUNDLE, evidence, required, resolved);
  assert.equal(request.reviewed.dependency_pins.length, 3);
  assert.deepEqual(request.confirmations.claimable_legacy_event_names, ["OWNED"]);
  assert.deepEqual(request.confirmations.removed_step_keys, [JSON.stringify(["4", "legacy-step"])]);
  assert.deepEqual(request.confirmations.removed_event_names, ["OWNED"]);
});

function exactPostImage() {
  return {
    domain: "Agents-generation",
    link_readback: {
      typed_endpoint_count: BUNDLE.links.length,
      managed_link_count: BUNDLE.links.length,
      full_domain_relationship_count: BUNDLE.links.length,
      typed_coverage_ready: true,
    },
    resources: {
      objects: BUNDLE.objects.map((definition) => ({ id: definition.id, __allmeta_definition_json: JSON.stringify(definition) })),
      rules: BUNDLE.rules.map((definition) => ({ id: definition.id, __allmeta_definition_json: JSON.stringify(definition) })),
      actions: BUNDLE.actions.map((definition) => ({ id: definition.id, __allmeta_definition_json: JSON.stringify(definition) })),
      actionSteps: BUNDLE.steps.map((step) => ({
        id: step.definition.id,
        action_id: step.action_id,
        name: step.definition.name,
        definition: JSON.stringify(step.definition),
      })),
      events: BUNDLE.events.map((definition) => ({ name: definition.name, __allmeta_definition_json: JSON.stringify(definition) })),
      policyScopes: BUNDLE.policyScopes.map((definition) => ({ id: definition.id, definition: JSON.stringify(definition) })),
      links: BUNDLE.links.map((definition) => ({ id: definition.id, __allmeta_link_json: JSON.stringify(definition) })),
    },
  };
}

test("strict readback verifies every count, identity, reviewed definition, and Link", () => {
  const verified = verifyReleaseReadback(BUNDLE, exactPostImage());
  assert.equal(verified.verified, true);
  assert.equal(verified.counts.links, BUNDLE.links.length);
  const incompleteManagedInventory = exactPostImage();
  incompleteManagedInventory.link_readback.managed_link_count = 579;
  assert.throws(
    () => verifyReleaseReadback(BUNDLE, incompleteManagedInventory),
    new RegExp(`must be exactly ${BUNDLE.links.length} typed and managed Links`),
  );
  const corrupted = exactPostImage();
  corrupted.resources.links[0].__allmeta_link_json = JSON.stringify({
    ...BUNDLE.links[0],
    status: "corrupt",
  });
  assert.throws(() => verifyReleaseReadback(BUNDLE, corrupted), /Link readback definition differs/);
});

test("discovery classification ignores only synthetic discovery blockers and fails closed on candidate contracts", () => {
  const response = discoveryResponse({
    blockers: [
      {
        code: "action_preview_blocked",
        source_code: "parent_version_conflict",
        message: "Expected parent version 0, current is 1004.",
      },
      {
        code: "dependency_pin_required",
        message: "Reviewed release is missing objects.",
      },
      {
        code: "event_preview_blocked",
        source_code: "action_contract_blocker",
        message: "Output needs emitted_on.",
      },
      {
        code: "event_preview_blocked",
        source_code: "action_event_topology_mismatch",
        message: "Candidate Event topology differs.",
      },
      {
        code: "event_preview_blocked",
        source_code: "graph_definition_mismatch",
        message: "Current Event graph differs from parent.",
      },
    ],
  });
  const classified = classifyDiscoveryBlockers(response);
  assert.equal(classified.discovery_only.length, 2);
  assert.deepEqual(
    classified.candidate.map((item) => item.code),
    ["action_contract_blocker", "action_event_topology_mismatch"],
  );
  assert.deepEqual(classified.current_state.map((item) => item.code), ["graph_definition_mismatch"]);
  assert.equal(classified.has_real_blockers, true);
  assert.equal(classified.next, "fix_candidate");
});

test("managed Link coverage compares buildListLinks identities, not unrelated relationship counts", () => {
  const typed = [{
    fromLabel: "Action",
    fromId: "4",
    type: "READS",
    toLabel: "DataObject",
    toId: "Job_Requisition",
    linkId: "link-1",
  }];
  const managed = [{
    fromLabel: "Action",
    fromId: "4",
    type: "READS",
    toLabel: "DataObject",
    toId: "Job_Requisition",
    props: { linkId: "link-1", managedBy: "ontology-release-bundle" },
  }];
  assert.equal(compareManagedLinkCoverage(typed, managed).ready, true);
  assert.equal(compareManagedLinkCoverage([], managed).ready, false);
});

test("CLI help and env parser never require placing tokens on the command line", () => {
  assert.match(HELP_TEXT, /Safe default: dry-run/);
  assert.match(HELP_TEXT, /default: v0_4_001 Agents-generation/);
  assert.doesNotMatch(HELP_TEXT, /--token/);
  assert.equal(parseCli([]).execute, false);
  assert.match(parseCli([]).bundle, /v0_4_001\/release_bundle_v0_4_001\.json$/);
  assert.equal(parseCli([]).domain, "Agents-generation");
  assert.equal(exitCodeForSummary({ ready_for_execute: false }), 2);
  assert.equal(exitCodeForSummary({ ready_for_execute: true }), 0);
  assert.throws(() => parseCli(["--domain", "RAAS-v1"]), /only domain 'Agents-generation'/);
  assert.deepEqual(parseDotEnv("A=one\nB='two # literal'\nC=three # comment\n"), {
    A: "one",
    B: "two # literal",
    C: "three",
  });
});

test("default run performs one non-ready discovery preview and never calls authorize/execute", async () => {
  const auditDir = mkdtempSync(join(tmpdir(), "allmeta-release-client-"));
  const calls = [];
  const secret = "ordinary-test-secret-not-for-audit";
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, method: init.method ?? "GET" });
    if (parsed.pathname.endsWith("/configuration")) {
      return json({
        enabled: true,
        full_domain_enabled: true,
        configured: true,
        missing: [],
        probes: {
          default_closed: true,
          separate_operator_token: true,
          state_outside_models: true,
          explicit_neo4j_identity: true,
          raw_driver_or_cypher_http_input: false,
          one_time_authorization: true,
        },
      });
    }
    if (parsed.pathname.endsWith("/cypher/query")) return json({ records: [], summary: { rowCount: 0 } });
    if (parsed.pathname.endsWith("/links")) return json({ items: [], nextCursor: null });
    if (["/objects", "/rules", "/actions", "/events"].some((suffix) => parsed.pathname.endsWith(suffix))) {
      return json({ items: [], nextCursor: null });
    }
    if (parsed.pathname.endsWith("/preview")) return json(discoveryResponse());
    throw new Error(`unexpected fake endpoint ${parsed.pathname}`);
  };
  try {
    const summary = await run({
      ...parseCli([]),
      auditDir,
      bundle: BUNDLE_PATH,
      baseUrl: "http://localhost:3500",
    }, {
      env: { ONTOLOGY_API_TOKEN: secret },
      fetchImpl,
    });
    assert.equal(summary.mode, "dry_run");
    assert.equal(summary.mutation_performed, false);
    assert.equal(calls.filter((call) => call.path.endsWith("/preview")).length, 1);
    assert.equal(calls.some((call) => /\/(authorize|execute)$/u.test(call.path)), false);
    const auditText = readdirSync(auditDir)
      .map((name) => readFileSync(join(auditDir, name), "utf8"))
      .join("\n");
    assert.equal(auditText.includes(secret), false);
  } finally {
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test("dry-run reports real action contract/topology blockers as fix_candidate and never prepares execution", async () => {
  const auditDir = mkdtempSync(join(tmpdir(), "allmeta-release-client-blocked-"));
  const calls = [];
  const blocked = discoveryResponse({
    blockers: [
      {
        code: "action_preview_blocked",
        source_code: "parent_hash_conflict",
        message: "Expected discovery parent hash differs.",
      },
      {
        code: "event_preview_blocked",
        source_code: "action_contract_blocker",
        message: "Output audit_id needs emitted_on.",
      },
      {
        code: "event_preview_blocked",
        source_code: "action_event_topology_mismatch",
        message: "Candidate Event topology differs.",
      },
    ],
  });
  const json = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname);
    if (parsed.pathname.endsWith("/configuration")) {
      return json({
        enabled: true,
        full_domain_enabled: true,
        configured: true,
        missing: [],
        probes: {
          default_closed: true,
          separate_operator_token: true,
          state_outside_models: true,
          explicit_neo4j_identity: true,
          raw_driver_or_cypher_http_input: false,
          one_time_authorization: true,
        },
      });
    }
    if (parsed.pathname.endsWith("/cypher/query")) return json({ records: [] });
    if (parsed.pathname.endsWith("/links")) return json({ items: [], nextCursor: null });
    if (["/objects", "/rules", "/actions", "/events"].some((suffix) => parsed.pathname.endsWith(suffix))) {
      return json({ items: [], nextCursor: null });
    }
    if (parsed.pathname.endsWith("/preview")) return json(blocked);
    throw new Error(`unexpected fake endpoint ${parsed.pathname}`);
  };
  try {
    const summary = await run({
      ...parseCli([]),
      auditDir,
      bundle: BUNDLE_PATH,
      baseUrl: "http://localhost:3500",
    }, {
      env: { ONTOLOGY_API_TOKEN: "ordinary" },
      fetchImpl,
    });
    assert.equal(summary.ready_for_execute, false);
    assert.equal(summary.next, "fix_candidate");
    assert.deepEqual(
      summary.candidate_blockers.map((item) => item.code),
      ["action_contract_blocker", "action_event_topology_mismatch"],
    );
    assert.equal(calls.filter((path) => path.endsWith("/preview")).length, 1);
    assert.equal(readdirSync(auditDir).some((name) => name.includes("reviewed-request")), false);
  } finally {
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test("typed Links zero is valid when buildListLinks-equivalent managed inventory is zero despite structural edges", async () => {
  const auditDir = mkdtempSync(join(tmpdir(), "allmeta-release-client-links-"));
  const response = discoveryResponse();
  response.evidence.authoritative_snapshots.full_domain_graph.relationship_count = 2;
  const json = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/configuration")) {
      return json({
        enabled: true,
        full_domain_enabled: true,
        configured: true,
        missing: [],
        probes: {
          default_closed: true,
          separate_operator_token: true,
          state_outside_models: true,
          explicit_neo4j_identity: true,
          raw_driver_or_cypher_http_input: false,
          one_time_authorization: true,
        },
      });
    }
    if (parsed.pathname.endsWith("/cypher/query")) {
      const request = JSON.parse(init.body);
      if (request.purpose.includes("full-domain-raw-relationship")) {
        return json({
          records: [
            { element_id: "r1", type: "HAS_FIELD", props: {}, from_id: "a", to_id: "b" },
            { element_id: "r2", type: "READS", props: { managedBy: "links-builder" }, from_id: "c", to_id: "d" },
          ],
        });
      }
      return json({ records: [] });
    }
    if (parsed.pathname.endsWith("/links")) return json({ items: [], nextCursor: null });
    if (["/objects", "/rules", "/actions", "/events"].some((suffix) => parsed.pathname.endsWith(suffix))) {
      return json({ items: [], nextCursor: null });
    }
    if (parsed.pathname.endsWith("/preview")) return json(response);
    throw new Error(`unexpected fake endpoint ${parsed.pathname}`);
  };
  try {
    const summary = await run({
      ...parseCli([]),
      auditDir,
      bundle: BUNDLE_PATH,
      baseUrl: "http://localhost:3500",
    }, {
      env: { ONTOLOGY_API_TOKEN: "ordinary" },
      fetchImpl,
    });
    assert.equal(summary.ready_for_execute, true);
    assert.equal(summary.next, "rerun_with_--execute_and_--operator-id");
    assert.equal(summary.current_counts.links, 0);
    assert.equal(summary.current_counts.typedLinks, 0);
    assert.equal(summary.current_counts.managedLinks, 0);
    assert.equal(summary.current_counts.fullDomainRelationships, 2);
    assert.equal(summary.current_counts.structuralOrNonLinkRelationships, 2);
    assert.equal(summary.link_readback.typed_coverage_ready, true);
  } finally {
    rmSync(auditDir, { recursive: true, force: true });
  }
});
