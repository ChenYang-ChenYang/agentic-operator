import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertNoAllmetaStorageMetadata,
  hashFullDomainArtifact,
  validateReleaseBundle,
} from "./allmeta-full-domain-release-client.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(repoRoot, "artifacts/ontology/Agents-generation/v0_4_001");
const bundle = JSON.parse(await readFile(join(artifactDir, "release_bundle_v0_4_001.json"), "utf8"));
const agentActions = bundle.actions.filter((action) => action.actor?.includes("Agent"));
const legacyTenantDecisionTools = new Set([
  "loadRaasRequirement", "loadRaasRuleContext", "candidateDedupLookup",
  "persistJd", "persistRaasEntities", "persistRuleCheckAudit",
  "routeResumeProcessed", "routeMatchOutcome", "routeInterviewInvitation",
]);
const supplementalRuleIds = ["4-2", "4-3", "4-4", "9-14", "9-15"];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
const stable = (value) => JSON.stringify(canonical(value));
function unique(values, label) {
  const seen = new Set();
  for (const value of values) {
    assert.ok(value, `${label} must not contain an empty identity`);
    assert.ok(!seen.has(value), `${label} contains duplicate '${value}'`);
    seen.add(value);
  }
}

test("compiler artifact is integrity-complete and its grounding state is enforced", () => {
  assert.equal(bundle.releaseGrounding.schema, "agents-generation-release-grounding/v1");
  assert.equal(
    bundle.releaseGrounding.liveRuleDigest,
    bundle.sourceDigests.live_rules_before_release,
  );
  if (bundle.releaseGrounding.mode === "live_allmeta_api") {
    assert.equal(bundle.releaseGrounding.allmetaRulesRead, true);
    assert.equal(bundle.releaseGrounding.releasable, true);
    assert.ok(bundle.releaseGrounding.liveRuleCount > 0);
    assert.doesNotThrow(() => validateReleaseBundle(bundle));
  } else {
    assert.deepEqual(bundle.releaseGrounding, {
      schema: "agents-generation-release-grounding/v1",
      allmetaRulesRead: false,
      liveRuleCount: 0,
      liveRuleDigest: bundle.sourceDigests.live_rules_before_release,
      mode: "offline_scaffold_test",
      releasable: false,
    });
    assert.throws(() => validateReleaseBundle(bundle), /not grounded in a non-empty live Allmeta Rules read/);
  }
  assert.equal(bundle.payloadDigest, hashFullDomainArtifact({
    objects: bundle.objects,
    rules: bundle.rules,
    actions: bundle.actions,
    actionSteps: bundle.actionSteps,
    events: bundle.events,
    policyScopes: bundle.policyScopes,
    links: bundle.links,
  }));
});

test("five live supplemental Rules contain logical definitions only", () => {
  assert.doesNotThrow(() => assertNoAllmetaStorageMetadata({
    objects: bundle.objects,
    rules: bundle.rules,
    actions: bundle.actions,
    actionSteps: bundle.actionSteps,
    events: bundle.events,
    policyScopes: bundle.policyScopes,
    links: bundle.links,
  }));
  assert.deepEqual(
    bundle.rules
      .filter((rule) => supplementalRuleIds.includes(rule.id))
      .map((rule) => rule.id)
      .sort(),
    [...supplementalRuleIds].sort(),
  );
  for (const id of supplementalRuleIds) {
    const rule = bundle.rules.find((candidate) => candidate.id === id);
    assert.equal(rule.sourceAuthority, "live_allmeta_required_by_old6_action_steps");
    for (const key of [
      "__allmeta_definition_json",
      "__allmeta_position",
      "source_file",
      "relatedEntities_json",
      "updatedAt_json",
    ]) {
      assert.ok(!Object.hasOwn(rule, key), `supplemental Rule ${id} leaked ${key}`);
    }
  }
});

test("six Agent Actions expose no old tenant business-decision capability", () => {
  assert.deepEqual(agentActions.map((action) => action.name).sort(), [
    "createJD", "inviteInternalInterview", "matchResume", "processResume",
    "ruleCheckForCandidateIdentity", "ruleCheckForMatchResume",
  ].sort());
  for (const action of agentActions) {
    for (const tool of action.tool_use ?? []) {
      assert.ok(!legacyTenantDecisionTools.has(tool), `${action.name} leaked ${tool}`);
      assert.ok(!tool.startsWith("raas."), `${action.name} leaked legacy tenant namespace ${tool}`);
    }
    assert.deepEqual(
      [...new Set(action.action_steps.map((step) => step.tool).filter(Boolean))],
      action.tool_use,
      `${action.name}.tool_use must be derived exactly from executable steps`,
    );
  }
  assert.ok(
    agentActions.some((action) => action.tool_use?.includes("facts.query")),
    "raw fact reads must use the domain-neutral canonical capability",
  );
});

test("object-storage execution never falls back to a local tenant inbox", () => {
  const action = agentActions.find((item) => item.name === "processResume");
  const reader = action.action_steps.find((step) => step.tool === "objectStore.getObject");
  assert.ok(reader, "processResume must bind its declared object-storage read");
  assert.deepEqual(reader.tool_arguments, {
    bucket: { from: "input.bucket", required: false },
    object_key: { from: "input.object_key", required: true },
  });
  assert.ok(!action.tool_use.includes("fs.readFromInbox"));
  const parser = action.action_steps.find((step) => step.tool === "parseResumeApi");
  assert.deepEqual(parser.tool_arguments, {
    resume_base64: { from: "results.download_resume_object.base64", required: true },
    filename: { from: "results.download_resume_object.filename", required: false },
    mime: { from: "results.download_resume_object.mime", required: false },
  });
});

test("reviewed external tools receive explicit field-level dataflow", () => {
  const createJd = agentActions.find((action) => action.name === "createJD");
  assert.deepEqual(
    createJd.action_steps.find((step) => step.tool === "generateJdApi")?.tool_arguments,
    { prompt: { from: "results.build_jd_prompt.prompt", required: true } },
  );
  const match = agentActions.find((action) => action.name === "matchResume");
  assert.deepEqual(
    match.action_steps.find((step) => step.tool === "matchResumeApi")?.tool_arguments,
    {
      resume: { from: "results.build_match_payload.resume", required: true },
      jd: { from: "results.build_match_payload.jd", required: true },
    },
  );
  const invite = agentActions.find((action) => action.name === "inviteInternalInterview");
  const inviteArgs = invite.action_steps.find((step) => step.tool === "inviteCandidateApi")?.tool_arguments;
  assert.equal(inviteArgs?.hiring_request_id?.from, "results.resolve_resume_and_jd_text.invitation_request.hiring_request_id");
  assert.equal(inviteArgs?.resume?.from, "results.resolve_resume_and_jd_text.invitation_request.resume");
  assert.equal(inviteArgs?.jd?.from, "results.resolve_resume_and_jd_text.invitation_request.jd");
});

test("generic local, entities.write, and ontology writes have explicit one-boundary contracts", () => {
  const allowedRecordTypes = new Set([
    "candidate", "resume", "job_posting", "candidate_match_result",
    "candidate_identity_result", "communication_log",
  ]);
  const expectedDatabaseOperation = new Map([
    ["4", "job_posting.sync"],
    ["9-1", "candidate.save"],
    ["10-1", "cmr.write_fail"],
    ["10-2", "match_result.save"],
    ["11-1", "invitation.mark_sent"],
  ]);
  for (const action of agentActions) {
    for (const step of action.action_steps.filter((item) => item.tool === "records.upsert")) {
      assert.ok(allowedRecordTypes.has(step.config?.record_type), `${action.name}/${step.step_id} has invalid record_type`);
    }
    const declaredGraphObjects = [...new Set((action.integration?.systems ?? [])
      .filter((system) => system.kind === "graph_db" && system.role === "write")
      .flatMap((system) => system.objects ?? []))].sort();
    const objectWriteSteps = action.action_steps.filter((step) => step.tool === "ontology.writeInstance");
    assert.deepEqual(
      objectWriteSteps.map((step) => step.tool_arguments?.object_type?.const).sort(),
      declaredGraphObjects,
      `${action.name} must materialize one ontology.writeInstance step per declared object`,
    );
    for (const step of objectWriteSteps) {
      assert.equal(typeof step.tool_arguments?.properties?.from, "string");
      assert.equal(step.tool_arguments.properties.required, true);
      assert.equal(typeof step.idempotency_key_from, "string");
    }
    assert.ok(
      !action.action_steps.some((item) => item.tool === "postgres.executeTransaction"),
      `${action.name} must not expose the generic transaction executor`,
    );
    const entityWrites = action.action_steps.filter((item) => item.tool === "entities.write");
    const expectedOperation = expectedDatabaseOperation.get(action.id);
    assert.equal(
      entityWrites.length,
      expectedOperation ? 1 : 0,
      `${action.name} must have exactly the reviewed number of external database writes`,
    );
    for (const step of entityWrites) {
      assert.deepEqual(step.tool_arguments, {
        operation: { const: expectedOperation },
        values: { from: "results.prepare_external_database_write.values", required: true },
      });
      assert.equal(step.idempotency_key_from, "results.prepare_external_database_write.idempotency_key");
    }
  }
  const matchRuleCheck = agentActions.find((action) => action.id === "10-1");
  assert.ok(matchRuleCheck.integration.systems
    .some((system) => system.kind === "graph_db" && system.role === "write" && system.objects.includes("Rule_Check_Audit")));
  assert.ok(!matchRuleCheck.action_steps
    .some((step) => step.tool === "records.upsert" && step.config?.record_type === "rule_check_audit"));
});

test("multi-outcome Actions compile exactly-one selection and immutable emit targets", () => {
  for (const action of agentActions.filter((item) => item.triggered_event.length > 1)) {
    const decision = action.action_steps.find((step) => step.outcome_cardinality === "exactly_one");
    assert.ok(decision, `${action.name} needs one exactly-one decision step`);
    const emits = action.action_steps.filter((step) => step.object_type === "emit");
    assert.deepEqual(emits.map((step) => step.event).sort(), [...action.triggered_event].sort());
    for (const step of emits) {
      assert.equal(step.emit_event, step.event);
      assert.equal(step.condition, `results.${decision.step_id}.selected_event == "${step.event}"`);
      assert.deepEqual(step.depends_on, [decision.step_id]);
      assert.equal(step.emit_payload_from, `results.${decision.step_id}.payload`);
    }
  }
  const match = agentActions.find((action) => action.name === "matchResume");
  assert.equal(
    match.action_steps.find((step) => step.outcome_cardinality === "exactly_one")?.step_id,
    "route_match_outcome",
    "matchResume must decide from the reviewed routing boundary, not a persistence preparation step",
  );
});

test("fail-closed contracts contain no hidden legacy switches or dual terminal invitation", () => {
  const executableSlice = JSON.stringify({ actions: agentActions, events: bundle.events });
  for (const forbidden of [
    "fs.readFromInbox",
    "CANDIDATE_IDENTITY_ENABLED",
    "LOCK_CHECK_ENABLED",
    "LOCK_CHECK_ENFORCE",
    "RULE_CHECK_BYPASS",
    "MATCH_ATTACH_RULECHECK",
    "PERSISTENCE_WARNING",
    "persistenceWarning",
    "解包 RAAS",
  ]) {
    assert.ok(!executableSlice.includes(forbidden), `executable ontology leaked '${forbidden}'`);
  }
  const sent = bundle.events.find((event) => event.name === "INTERVIEW_INVITATION_SENT");
  const failed = bundle.events.find((event) => event.name === "INTERVIEW_INVITATION_FAILED");
  assert.match(sent.description, /一个执行项只能选择一个终态事件/);
  assert.match(failed.description, /结果未知情形必须停靠重试/);
  const errorCode = failed.payload.event_data.find((field) => field.name === "error_code");
  assert.ok(!errorCode.enum.includes("PERSISTENCE_WARNING"));
});

test("10-1 encodes a replay-stable foreach and scopes every per-JR effect", () => {
  const action = agentActions.find((item) => item.id === "10-1");
  const parent = action.action_steps.find((step) => step.step_id === "foreach_requisition");
  assert.deepEqual({
    kind: parent.object_type,
    items: parent.items_from,
    itemAs: parent.item_as,
    key: parent.item_key_from,
    mode: parent.foreach_mode,
  }, {
    kind: "foreach",
    items: "results.resolve_matchable_requirements.rows",
    itemAs: "requisition",
    key: "locals.requisition.job_requisition_id",
    mode: "sequential",
  });
  const children = action.action_steps.filter((step) => step.parent_step === parent.step_id);
  assert.ok(children.some((step) => step.step_id === "evaluate_rules_per_requisition"));
  assert.ok(children.some((step) => step.tool === "entities.write"));
  assert.ok(children.some((step) => step.tool === "ontology.writeInstance"));
  assert.deepEqual(
    children.filter((step) => step.object_type === "emit").map((step) => step.event).sort(),
    [...action.triggered_event].sort(),
  );
});

test("flat ActionSteps and approved Links exactly cover nested definitions", () => {
  unique(bundle.actions.map((action) => action.id), "Action ids");
  unique(bundle.events.map((event) => event.name), "Event names");
  unique(bundle.links.map((link) => link.id), "Link ids");
  unique(bundle.actions.flatMap((action) => action.action_steps.map((step) => step.id)), "ActionStep global ids");
  for (const action of bundle.actions) {
    unique(action.action_steps.map((step) => step.step_id), `${action.name} local step ids`);
    assert.deepEqual(action.action_steps.map((step) => step.order), action.action_steps.map((_, index) => index + 1));
  }
  assert.deepEqual(
    bundle.actionSteps.map(stable).sort(),
    bundle.actions.flatMap((action) => action.action_steps.map((step) => stable({
      ...step, action_id: action.id, action_name: action.name,
    }))).sort(),
  );
  const stepLinks = new Set(bundle.links
    .filter((link) => link.kind === "action-includes-step" && link.status === "approved")
    .map((link) => `${link.from.id}\u0000${link.to.id}`));
  for (const action of bundle.actions) {
    for (const step of action.action_steps) {
      assert.ok(stepLinks.has(`${action.id}\u0000${step.id}`), `missing Action→ActionStep Link ${action.id}/${step.id}`);
    }
  }
  assert.equal(stepLinks.size, bundle.actionSteps.length);
});
