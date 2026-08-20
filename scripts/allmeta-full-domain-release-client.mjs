#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const TARGET_DOMAIN = "Agents-generation";
const DEFAULT_REVIEWED_VERSION = "v0_4_001";
const ZERO_HASH = `sha256:${"0".repeat(64)}`;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const REVIEWED_VERSION_RE = /^v[0-9]+_[0-9]+_[0-9]+$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_BUNDLE = join(
  REPO_ROOT,
  `artifacts/ontology/Agents-generation/${DEFAULT_REVIEWED_VERSION}/release_bundle_${DEFAULT_REVIEWED_VERSION}.json`,
);
const DEFAULT_ALLMETA_ENV = "/Users/yuhancheng/allmetaOntology/.env.local";
const DEFAULT_AUDIT_DIR = join(
  REPO_ROOT,
  `artifacts/ontology/Agents-generation/${DEFAULT_REVIEWED_VERSION}/release-audit`,
);

export const HELP_TEXT = `Usage:
  node scripts/allmeta-full-domain-release-client.mjs [options]

Safe default: dry-run. It captures a complete HTTP API before-image and asks
Allmeta for authoritative release evidence, but does not persist a ready
candidate, authorize it, or execute it.

Options:
  --execute                  Submit ready preview, one-time authorization, and execute
  --operator-id <identity>   Required with --execute (or ALLMETA_OPERATOR_ID)
  --confirmation-file <path> Reviewed domain-less ownership decisions, when required
  --bundle <path>            Reviewed ReleaseBundle JSON (default: ${DEFAULT_REVIEWED_VERSION} Agents-generation)
  --allmeta-env <path>       Allmeta env file (default: ${DEFAULT_ALLMETA_ENV})
  --base-url <url>           Allmeta origin (or ALLMETA_BASE_URL; localhost:3500 fallback)
  --audit-dir <path>         Private audit output directory
  --domain <domain>          Must be exactly ${TARGET_DOMAIN}
  --help                     Show this help

The client reads ONTOLOGY_API_TOKEN (ALLMETA_API_KEY fallback) and, only for
--execute, ONTOLOGY_RELEASE_OPERATOR_TOKEN. Tokens are never logged or saved.`;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  const source = record(value);
  if (!source) return value;
  const output = {};
  for (const key of Object.keys(source).sort(compareText)) {
    output[key] = canonicalValue(source[key]);
  }
  return output;
}

function digestJson(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function hashFullDomainArtifact(value) {
  return digestJson(canonicalValue(value));
}

export function hashActionCandidate(actions) {
  const canonical = [...actions]
    .sort((left, right) => compareText(
      `${text(left?.name)}\u0000${text(left?.id)}`,
      `${text(right?.name)}\u0000${text(right?.id)}`,
    ))
    .map(canonicalValue);
  return digestJson(canonical);
}

export function hashEventCandidate(events) {
  const canonical = [...events]
    .sort((left, right) => compareText(text(left?.name), text(right?.name)))
    .map(canonicalValue);
  return digestJson(canonical);
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requireUnique(values, identity, label) {
  const seen = new Set();
  for (const value of values) {
    const id = text(identity(value));
    if (!id) throw new Error(`${label} contains an empty identity.`);
    if (seen.has(id)) throw new Error(`${label} contains duplicate identity '${id}'.`);
    seen.add(id);
  }
}

function stableEqual(left, right) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function allmetaStorageMetadataKey(container, key) {
  if (key.startsWith("__allmeta_") || key === "source_file") return true;
  if (!key.endsWith("_json")) return false;
  return Object.hasOwn(container, key.slice(0, -"_json".length));
}

/**
 * Release definitions are logical ontology data. Graph persistence metadata
 * belongs exclusively to Allmeta and must never round-trip through a candidate:
 * a candidate `__allmeta_definition_json` can otherwise overwrite the writer's
 * newly generated exact definition and make independent graph readback diverge.
 */
export function assertNoAllmetaStorageMetadata(value, label = "ReleaseBundle definitions") {
  const visit = (current, path) => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    const source = record(current);
    if (!source) return;
    for (const [key, item] of Object.entries(source)) {
      const nextPath = `${path}.${key}`;
      if (allmetaStorageMetadataKey(source, key)) {
        throw new Error(
          `${label} contains server-owned Allmeta storage metadata at ${nextPath}.`,
        );
      }
      visit(item, nextPath);
    }
  };
  visit(value, "$");
}

function actionStepNameKey(actionId, stepName) {
  return JSON.stringify([text(actionId), text(stepName)]);
}

function localStepId(definition) {
  return text(definition?.step_id ?? definition?.stepId ?? definition?.id ?? definition?.name);
}

function actionStepIdKey(actionId, definition) {
  return JSON.stringify([text(actionId), localStepId(definition)]);
}

function nestedSteps(actions) {
  return actions.flatMap((action) =>
    requireArray(action.action_steps ?? [], `Action ${action.id ?? "(unknown)"}.action_steps`)
      .map((definition) => ({
        action_id: text(action.id),
        definition,
      })),
  );
}

function validateFlatStepManifest(bundle, steps) {
  const flat = requireArray(bundle.actionSteps, "ReleaseBundle.actionSteps");
  const expected = new Map(steps.map((step) => [
    actionStepIdKey(step.action_id, step.definition),
    step,
  ]));
  if (flat.length !== steps.length) {
    throw new Error(`ReleaseBundle.actionSteps count ${flat.length} does not match nested Action steps ${steps.length}.`);
  }
  for (const item of flat) {
    const key = actionStepIdKey(item?.action_id, item);
    const nested = expected.get(key);
    if (!nested) throw new Error(`ReleaseBundle.actionSteps contains unknown step ${key}.`);
    const { action_id: _actionId, action_name: _actionName, ...definition } = item;
    if (!stableEqual(definition, nested.definition)) {
      throw new Error(`ReleaseBundle.actionSteps disagrees with nested Action step ${key}.`);
    }
  }
}

export function validateReleaseBundle(raw, expectedDomain = TARGET_DOMAIN) {
  const bundle = record(raw);
  if (!bundle) throw new Error("ReleaseBundle must be a JSON object.");
  if (bundle.domainId !== expectedDomain || expectedDomain !== TARGET_DOMAIN) {
    throw new Error(`This client can release only domain '${TARGET_DOMAIN}'.`);
  }
  if (bundle.mode !== "exact-domain-replacement") {
    throw new Error("ReleaseBundle.mode must be exact-domain-replacement.");
  }
  if (bundle.schemaVersion !== 1) {
    throw new Error("ReleaseBundle.schemaVersion must be 1.");
  }
  if (!REVIEWED_VERSION_RE.test(text(bundle.version))) {
    throw new Error(
      "ReleaseBundle.version must be the reviewed bundle's canonical v<major>_<minor>_<patch> identifier.",
    );
  }
  if (!HASH_RE.test(text(bundle.payloadDigest))) {
    throw new Error("ReleaseBundle.payloadDigest must be a sha256 digest.");
  }
  const grounding = record(bundle.releaseGrounding);
  if (
    grounding?.schema !== "agents-generation-release-grounding/v1"
    || grounding.allmetaRulesRead !== true
    || grounding.releasable !== true
    || grounding.mode !== "live_allmeta_api"
    || !Number.isSafeInteger(grounding.liveRuleCount)
    || grounding.liveRuleCount <= 0
    || !HASH_RE.test(text(grounding.liveRuleDigest))
  ) {
    throw new Error(
      "ReleaseBundle is not grounded in a non-empty live Allmeta Rules read; rebuild without ALLOW_OFFLINE_LIVE_RULES before any preview or execute request.",
    );
  }
  if (text(bundle.sourceDigests?.live_rules_before_release) !== text(grounding.liveRuleDigest)) {
    throw new Error("ReleaseBundle live Rules grounding digest disagrees with sourceDigests.live_rules_before_release.");
  }
  const objects = requireArray(bundle.objects, "ReleaseBundle.objects");
  const rules = requireArray(bundle.rules, "ReleaseBundle.rules");
  const actions = requireArray(bundle.actions, "ReleaseBundle.actions");
  const events = requireArray(bundle.events, "ReleaseBundle.events");
  const policyScopes = requireArray(bundle.policyScopes, "ReleaseBundle.policyScopes");
  const links = requireArray(bundle.links, "ReleaseBundle.links");
  const steps = nestedSteps(actions);

  assertNoAllmetaStorageMetadata({
    objects,
    rules,
    actions,
    actionSteps: bundle.actionSteps,
    events,
    policyScopes,
    links,
  });

  requireUnique(objects, (item) => item?.id, "DataObjects");
  requireUnique(rules, (item) => item?.id, "Rules");
  requireUnique(actions, (item) => item?.id, "Actions");
  requireUnique(actions, (item) => item?.name, "Action names");
  requireUnique(events, (item) => item?.name, "Events");
  requireUnique(policyScopes, (item) => item?.id, "PolicyScopes");
  requireUnique(links, (item) => item?.id, "Links");
  requireUnique(steps, (item) => actionStepNameKey(item.action_id, item.definition?.name), "ActionStep names");
  requireUnique(steps, (item) => actionStepIdKey(item.action_id, item.definition), "ActionStep local ids");
  requireUnique(steps, (item) => item.definition?.id, "ActionStep global ids");
  validateFlatStepManifest(bundle, steps);

  const expectedPayloadDigest = hashFullDomainArtifact({
    objects,
    rules,
    actions,
    actionSteps: bundle.actionSteps,
    events,
    policyScopes,
    links,
  });
  if (bundle.payloadDigest !== expectedPayloadDigest) {
    throw new Error(
      `ReleaseBundle.payloadDigest mismatch: expected ${expectedPayloadDigest}, received ${bundle.payloadDigest}.`,
    );
  }

  for (const link of links) {
    if (link?.status !== "approved" || !text(link?.kind) || !record(link?.from) || !record(link?.to)) {
      throw new Error(`Link '${link?.id ?? "(unknown)"}' is not an approved managed Link.`);
    }
  }

  const hashes = {
    actions: hashActionCandidate(actions),
    events: hashEventCandidate(events),
    objects: hashFullDomainArtifact(objects),
    rules: hashFullDomainArtifact(rules),
    policy_scopes: hashFullDomainArtifact(policyScopes),
    links: hashFullDomainArtifact(links),
  };
  return {
    metadata: {
      schemaVersion: bundle.schemaVersion,
      domainId: bundle.domainId,
      version: bundle.version,
      payloadDigest: bundle.payloadDigest,
      releaseGrounding: grounding,
    },
    objects,
    rules,
    actions,
    steps,
    events,
    policyScopes,
    links,
    hashes,
  };
}

export function buildDiscoveryRequest(bundle) {
  return {
    mode: "preview",
    domain: bundle.metadata.domainId,
    candidate_objects: bundle.objects,
    candidate_rules: bundle.rules,
    candidate_policy_scopes: bundle.policyScopes,
    candidate_actions: bundle.actions,
    candidate_events: bundle.events,
    candidate_links: bundle.links,
    reviewed: {
      action_parent_version: 0,
      event_parent_version: 0,
      action_parent_hash: ZERO_HASH,
      event_parent_hash: ZERO_HASH,
      action_candidate_hash: bundle.hashes.actions,
      event_candidate_hash: bundle.hashes.events,
      object_candidate_hash: bundle.hashes.objects,
      rule_candidate_hash: bundle.hashes.rules,
      policy_scope_candidate_hash: bundle.hashes.policy_scopes,
      link_candidate_hash: bundle.hashes.links,
    },
    confirmations: {
      claimable_legacy_actions: [],
      claimable_legacy_step_keys: [],
      removed_action_ids: [],
      removed_step_keys: [],
      claimable_legacy_event_names: [],
      unclaimed_domainless_event_names: [],
      removed_event_names: [],
    },
  };
}

function requireHash(value, label) {
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    throw new Error(`${label} is not a lowercase sha256 digest.`);
  }
  return value;
}

function requireVersion(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is not a non-negative safe integer.`);
  }
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => !text(item))) {
    throw new Error(`${label} is not an array of non-empty strings.`);
  }
  return [...value].map(text);
}

function identityArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array.`);
  return value.map((item) => {
    if (!text(item?.id) || !text(item?.name)) {
      throw new Error(`${label} contains an invalid Action identity.`);
    }
    return { id: text(item.id), name: text(item.name) };
  });
}

function sortedUnique(values) {
  return [...new Set(values.map(text).filter(Boolean))].sort(compareText);
}

function sortIdentities(values) {
  return [...values]
    .map((item) => ({ id: text(item.id), name: text(item.name) }))
    .sort((left, right) => compareText(JSON.stringify([left.id, left.name]), JSON.stringify([right.id, right.name])));
}

function exactStrings(left, right) {
  const a = [...left].sort(compareText);
  const b = [...right].sort(compareText);
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function managedLinkInventoryKey(item) {
  const props = record(item?.props) ?? item ?? {};
  return JSON.stringify([
    text(item?.fromLabel),
    text(item?.fromId),
    text(item?.type),
    text(item?.toLabel),
    text(item?.toId),
    text(props?.linkId ?? props?.link_id ?? item?.linkId ?? item?.link_id),
  ]);
}

export function compareManagedLinkCoverage(typedLinks, managedLinkRows) {
  const typedKeys = typedLinks.map(managedLinkInventoryKey).sort(compareText);
  const managedKeys = managedLinkRows.map(managedLinkInventoryKey).sort(compareText);
  return {
    ready: exactStrings(typedKeys, managedKeys),
    typed_count: typedLinks.length,
    managed_count: managedLinkRows.length,
    typed_keys: typedKeys,
    managed_keys: managedKeys,
  };
}

function exactIdentities(left, right) {
  return exactStrings(
    sortIdentities(left).map((item) => JSON.stringify([item.id, item.name])),
    sortIdentities(right).map((item) => JSON.stringify([item.id, item.name])),
  );
}

/**
 * Extracts only server-owned evidence. The dependency source identity is not
 * exposed by the HTTP evidence object, so it is reconstructed from Allmeta's
 * immutable artifact contract: <domain>/<identity>. The next preview remains
 * the authority and rejects any mismatch.
 */
export function extractDiscoveryEvidence(response, bundle) {
  const body = record(response);
  if (!body || body.domain !== bundle.metadata.domainId) {
    throw new Error("Allmeta discovery preview returned another domain or an invalid body.");
  }
  if (body.ready === true || body.candidate !== null && body.candidate !== undefined) {
    throw new Error("Safety invariant failed: evidence discovery unexpectedly created a ready candidate.");
  }
  const evidence = record(body.evidence);
  const snapshots = record(evidence?.authoritative_snapshots);
  const action = record(snapshots?.action);
  const event = record(snapshots?.event);
  const fullDomain = record(snapshots?.full_domain_graph);
  if (action?.ready !== true || event?.ready !== true || fullDomain?.ready !== true) {
    throw new Error("Allmeta did not return ready Action, Event, and full-domain parent evidence.");
  }
  const preview = record(body.preview);
  const actionPreview = record(preview?.action);
  const eventPreview = record(preview?.event);
  if (!preview || !actionPreview || !eventPreview) {
    throw new Error("Allmeta discovery response has no structured preview details.");
  }
  if (preview.action_candidate_hash !== bundle.hashes.actions ||
      preview.event_candidate_hash !== bundle.hashes.events) {
    throw new Error("Allmeta and the client disagree on Action/Event candidate hashes.");
  }
  const fullDomainPreview = record(preview.full_domain);
  for (const [field, expected] of [
    ["object_candidate_hash", bundle.hashes.objects],
    ["rule_candidate_hash", bundle.hashes.rules],
    ["policy_scope_candidate_hash", bundle.hashes.policy_scopes],
    ["link_candidate_hash", bundle.hashes.links],
  ]) {
    if (fullDomainPreview?.[field] !== expected) {
      throw new Error(`Allmeta and the client disagree on ${field}.`);
    }
  }
  const dependencyEvidence = record(evidence?.dependency_pins);
  const observed = requireArray(dependencyEvidence?.observed, "Allmeta observed dependency pins");
  const dependencyPins = observed.map((pin) => {
    const artifact = text(pin?.artifact);
    const domain = text(pin?.domain);
    const identity = text(pin?.identity);
    if (!["objects", "rules", "links"].includes(artifact) || domain !== bundle.metadata.domainId || !identity) {
      throw new Error("Allmeta returned an invalid dependency pin identity.");
    }
    return {
      artifact,
      domain,
      source_identity: `${domain}/${identity}`,
      identity,
      version: requireVersion(pin.version, `${artifact} dependency version`),
      hash: requireHash(pin.hash, `${artifact} dependency hash`),
    };
  });
  if (!exactStrings(dependencyPins.map((pin) => pin.artifact), ["objects", "rules", "links"])) {
    throw new Error("Allmeta dependency evidence is not exactly objects/rules/links.");
  }
  return {
    parent: {
      action_version: requireVersion(action.version, "Action parent version"),
      action_hash: requireHash(action.hash, "Action parent hash"),
      event_version: requireVersion(event.version, "Event parent version"),
      event_hash: requireHash(event.hash, "Event parent hash"),
      full_domain_graph_hash: requireHash(fullDomain.hash, "full-domain graph parent hash"),
      full_domain_node_count: requireVersion(fullDomain.node_count, "full-domain graph node count"),
      full_domain_relationship_count: requireVersion(
        fullDomain.relationship_count,
        "full-domain graph relationship count",
      ),
    },
    dependency_pins: dependencyPins,
    dependency_source_identity_strategy: "contract-derived:<domain>/<identity>",
    preview: {
      action: actionPreview,
      event: eventPreview,
    },
  };
}

const DISCOVERY_ONLY_BLOCKER_CODES = new Set([
  "parent_version_conflict",
  "parent_hash_conflict",
  "event_parent_hash_conflict",
  "removal_confirmation_mismatch",
  "step_removal_confirmation_mismatch",
  "event_removal_confirmation_mismatch",
  "dependency_pin_required",
  "dependency_pin_key_set_mismatch",
]);

const OWNERSHIP_BLOCKER_CODES = new Set([
  "domainless_ownership_unresolved",
  "domainless_step_ownership_unresolved",
]);

const CURRENT_STATE_BLOCKER_CODES = new Set([
  "dependency_pin_changed",
  "dependency_pin_missing",
  "graph_inventory_unavailable",
  "graph_snapshot_unavailable",
  "graph_snapshot_hash_mismatch",
  "graph_definition_mismatch",
  "graph_action_id_missing",
  "graph_action_name_missing",
  "graph_step_identity_missing",
  "graph_duplicate_action_id",
  "graph_duplicate_action_name",
  "graph_duplicate_step_key",
  "graph_duplicate_event_name",
]);

const INTEGRATION_BLOCKER_CODES = new Set([
  "release_executor_unavailable",
  "evidence_domain_mismatch",
  "evidence_source_identity_missing",
  "dependency_pin_domain_mismatch",
  "dependency_pin_source_identity_missing",
  "full_domain_graph_evidence_unavailable",
  "distributed_cas_unavailable",
  "relationship_before_image_unavailable",
  "saga_journal_unavailable",
  "combined_graph_commit_unavailable",
]);

function publicBlocker(blocker) {
  return {
    code: text(blocker?.source_code) || text(blocker?.code) || "unknown_blocker",
    envelope_code: text(blocker?.code) || "unknown_blocker",
    message: text(blocker?.message) || "Allmeta returned an unexplained blocker.",
    ...(text(blocker?.action_name) ? { action_name: text(blocker.action_name) } : {}),
    ...(text(blocker?.event_name) ? { event_name: text(blocker.event_name) } : {}),
    ...(text(blocker?.path) ? { path: text(blocker.path) } : {}),
  };
}

/**
 * Discovery intentionally produces parent/pin/removal blockers. Every other
 * blocker is real and must prevent the client from calling a candidate ready.
 * Unknown codes default to candidate blockers (fail closed).
 */
export function classifyDiscoveryBlockers(response) {
  const top = Array.isArray(response?.blockers) ? response.blockers : [];
  const fallback = Array.isArray(response?.preview?.blockers) ? response.preview.blockers : [];
  const seen = new Set();
  const result = {
    discovery_only: [],
    ownership_review: [],
    candidate: [],
    current_state: [],
    integration: [],
  };
  for (const raw of top.length > 0 ? top : fallback) {
    const blocker = publicBlocker(raw);
    const key = JSON.stringify([blocker.code, blocker.message]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (DISCOVERY_ONLY_BLOCKER_CODES.has(blocker.code)) result.discovery_only.push(blocker);
    else if (OWNERSHIP_BLOCKER_CODES.has(blocker.code)) result.ownership_review.push(blocker);
    else if (CURRENT_STATE_BLOCKER_CODES.has(blocker.code)) result.current_state.push(blocker);
    else if (INTEGRATION_BLOCKER_CODES.has(blocker.code)) result.integration.push(blocker);
    else result.candidate.push(blocker);
  }
  return {
    ...result,
    has_real_blockers:
      result.candidate.length > 0 || result.current_state.length > 0 || result.integration.length > 0,
    next: result.candidate.length > 0
      ? "fix_candidate"
      : result.current_state.length > 0
        ? "repair_current_ontology"
        : result.integration.length > 0
          ? "configure_allmeta"
          : result.ownership_review.length > 0
            ? "review_ownership"
            : "prepare_reviewed_preview",
  };
}

function parseStepKey(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string"
      ? [text(parsed[0]), text(parsed[1])]
      : ["", ""];
  } catch {
    return ["", ""];
  }
}

export function deriveRequiredConfirmations(evidence, beforeImage, bundle) {
  const action = evidence.preview.action;
  const event = evidence.preview.event;
  const domainActions = requireArray(beforeImage?.resources?.actions, "before-image Actions");
  const authoritativeIds = new Set([
    ...domainActions.map((item) => text(item?.id)),
    ...bundle.actions.map((item) => text(item?.id)),
  ].filter(Boolean));
  const authoritativeNames = new Set([
    ...domainActions.map((item) => text(item?.name)),
    ...bundle.actions.map((item) => text(item?.name)),
  ].filter(Boolean));
  const unclaimedActions = identityArray(
    action.unclaimed_domainless_actions ?? [],
    "preview.action.unclaimed_domainless_actions",
  );
  const requiredLegacyActions = sortIdentities(unclaimedActions.filter((item) =>
    authoritativeIds.has(item.id) || authoritativeNames.has(item.name),
  ));
  for (const item of requiredLegacyActions) authoritativeIds.add(item.id);
  const unclaimedSteps = stringArray(
    action.unclaimed_domainless_step_keys ?? [],
    "preview.action.unclaimed_domainless_step_keys",
  );
  const requiredLegacySteps = sortedUnique(unclaimedSteps.filter((key) => {
    const [actionId, stepName] = parseStepKey(key);
    if (!actionId || !stepName) throw new Error(`Allmeta returned malformed ActionStep key '${key}'.`);
    return authoritativeIds.has(actionId);
  }));
  return {
    claimable_legacy_actions: requiredLegacyActions,
    claimable_legacy_step_keys: requiredLegacySteps,
    observed_domainless_event_names: sortedUnique(stringArray(
      event.graph_domainless_event_names_before_claim ?? [],
      "preview.event.graph_domainless_event_names_before_claim",
    )),
    removed_action_ids: sortedUnique(stringArray(
      action.removed_action_ids ?? [],
      "preview.action.removed_action_ids",
    )),
    removed_step_keys: sortedUnique(stringArray(
      action.removed_step_keys ?? [],
      "preview.action.removed_step_keys",
    )),
    removed_event_names: sortedUnique(stringArray(
      event.removed_event_names ?? [],
      "preview.event.removed_event_names",
    )),
  };
}

export function resolveOwnershipConfirmations(required, reviewed) {
  const ownershipRequired = required.claimable_legacy_actions.length > 0 ||
    required.claimable_legacy_step_keys.length > 0 ||
    required.observed_domainless_event_names.length > 0;
  if (!ownershipRequired) {
    return {
      ready: true,
      confirmations: {
        claimable_legacy_actions: [],
        claimable_legacy_step_keys: [],
        claimable_legacy_event_names: [],
        unclaimed_domainless_event_names: [],
      },
      reasons: [],
    };
  }
  const input = record(reviewed);
  if (!input) {
    return {
      ready: false,
      confirmations: null,
      reasons: ["Domain-less Action/ActionStep/Event ownership needs an explicit reviewed confirmation file."],
    };
  }
  if (input.domain !== TARGET_DOMAIN) {
    return { ready: false, confirmations: null, reasons: [`confirmation file domain must be '${TARGET_DOMAIN}'.`] };
  }
  const actions = identityArray(input.claimable_legacy_actions ?? [], "claimable_legacy_actions");
  const steps = sortedUnique(stringArray(input.claimable_legacy_step_keys ?? [], "claimable_legacy_step_keys"));
  const claimedEvents = sortedUnique(stringArray(input.claimable_legacy_event_names ?? [], "claimable_legacy_event_names"));
  const unclaimedEvents = sortedUnique(stringArray(input.unclaimed_domainless_event_names ?? [], "unclaimed_domainless_event_names"));
  const reasons = [];
  if (!exactIdentities(actions, required.claimable_legacy_actions)) {
    reasons.push("claimable_legacy_actions must exactly match Allmeta's relevant domain-less Action identities.");
  }
  if (!exactStrings(steps, required.claimable_legacy_step_keys)) {
    reasons.push("claimable_legacy_step_keys must exactly match Allmeta's relevant domain-less ActionSteps.");
  }
  const overlap = claimedEvents.filter((name) => unclaimedEvents.includes(name));
  const partition = sortedUnique([...claimedEvents, ...unclaimedEvents]);
  if (overlap.length > 0 || !exactStrings(partition, required.observed_domainless_event_names)) {
    reasons.push("Event ownership choices must be disjoint and exactly partition every observed domain-less Event.");
  }
  return {
    ready: reasons.length === 0,
    confirmations: reasons.length === 0 ? {
      claimable_legacy_actions: sortIdentities(actions),
      claimable_legacy_step_keys: steps,
      claimable_legacy_event_names: claimedEvents,
      unclaimed_domainless_event_names: unclaimedEvents,
    } : null,
    reasons,
  };
}

export function buildReviewedPreviewRequest(bundle, evidence, required, ownership) {
  if (!ownership?.ready || !ownership.confirmations) {
    throw new Error("Reviewed ownership confirmations are incomplete.");
  }
  const candidateActionIds = new Set(bundle.actions.map((action) => text(action.id)));
  const candidateStepKeys = new Set(bundle.steps.map((step) =>
    actionStepNameKey(step.action_id, step.definition?.name)));
  const candidateEventNames = new Set(bundle.events.map((event) => text(event.name)));
  // The discovery preview deliberately confirms no domain-less ownership. Once
  // the operator confirms ownership, claimed legacy definitions that are not
  // retained by the candidate become removals and must be added explicitly.
  const removedActionIds = sortedUnique([
    ...required.removed_action_ids,
    ...ownership.confirmations.claimable_legacy_actions
      .map((action) => action.id)
      .filter((id) => !candidateActionIds.has(id)),
  ]);
  const removedStepKeys = sortedUnique([
    ...required.removed_step_keys,
    ...ownership.confirmations.claimable_legacy_step_keys
      .filter((key) => !candidateStepKeys.has(key)),
  ]);
  const removedEventNames = sortedUnique([
    ...required.removed_event_names,
    ...ownership.confirmations.claimable_legacy_event_names
      .filter((name) => !candidateEventNames.has(name)),
  ]);
  return {
    mode: "preview",
    domain: bundle.metadata.domainId,
    candidate_objects: bundle.objects,
    candidate_rules: bundle.rules,
    candidate_policy_scopes: bundle.policyScopes,
    candidate_actions: bundle.actions,
    candidate_events: bundle.events,
    candidate_links: bundle.links,
    reviewed: {
      action_parent_version: evidence.parent.action_version,
      event_parent_version: evidence.parent.event_version,
      action_parent_hash: evidence.parent.action_hash,
      event_parent_hash: evidence.parent.event_hash,
      action_candidate_hash: bundle.hashes.actions,
      event_candidate_hash: bundle.hashes.events,
      object_candidate_hash: bundle.hashes.objects,
      rule_candidate_hash: bundle.hashes.rules,
      policy_scope_candidate_hash: bundle.hashes.policy_scopes,
      link_candidate_hash: bundle.hashes.links,
      dependency_pins: evidence.dependency_pins,
    },
    confirmations: {
      ...ownership.confirmations,
      removed_action_ids: removedActionIds,
      removed_step_keys: removedStepKeys,
      removed_event_names: removedEventNames,
    },
  };
}

export function parseDotEnv(content) {
  const values = {};
  for (const rawLine of String(content).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2] ?? "";
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\([nrt\\"])/gu, (_whole, escaped) => ({
        n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"',
      })[escaped]);
    } else {
      value = value.replace(/\s+#.*$/u, "").trim();
    }
    values[match[1]] = value;
  }
  return values;
}

export function parseCli(argv) {
  const options = {
    execute: false,
    bundle: DEFAULT_BUNDLE,
    allmetaEnv: DEFAULT_ALLMETA_ENV,
    auditDir: DEFAULT_AUDIT_DIR,
    domain: TARGET_DOMAIN,
    baseUrl: "",
    operatorId: "",
    confirmationFile: "",
    help: false,
  };
  const valueOptions = new Map([
    ["--bundle", "bundle"],
    ["--allmeta-env", "allmetaEnv"],
    ["--audit-dir", "auditDir"],
    ["--domain", "domain"],
    ["--base-url", "baseUrl"],
    ["--operator-id", "operatorId"],
    ["--confirmation-file", "confirmationFile"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") options.execute = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (valueOptions.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      options[valueOptions.get(arg)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown option '${arg}'. Use --help.`);
    }
  }
  if (options.domain !== TARGET_DOMAIN) {
    throw new Error(`This client can release only domain '${TARGET_DOMAIN}'.`);
  }
  return options;
}

export function exitCodeForSummary(summary) {
  return summary?.ready_for_execute === false ? 2 : 0;
}

function safeBaseUrl(value) {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Allmeta base URL cannot contain credentials, query parameters, or a fragment.");
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("Allmeta bearer tokens require HTTPS, except for an explicit loopback HTTP server.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.toString().replace(/\/+$/u, "");
}

function ensurePrivateDirectory(path) {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  if (lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isDirectory()) {
    throw new Error(`Audit directory '${absolute}' must be a real directory, not a symlink.`);
  }
  return absolute;
}

function atomicPrivateJson(path, value) {
  const target = resolve(path);
  const directory = ensurePrivateDirectory(dirname(target));
  if (directory !== dirname(target)) throw new Error("Audit path resolution failed.");
  const temporary = join(directory, `.${target.split("/").at(-1)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, target);
    const dirFd = openSync(directory, "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}

function responseError(status, body, path) {
  const code = text(body?.error) || "http-error";
  const message = text(body?.message) || `Allmeta returned HTTP ${status}.`;
  return new Error(`${path}: ${code}: ${message}`);
}

export function createAllmetaHttpClient({ baseUrl, apiToken, operatorToken = "", fetchImpl = fetch }) {
  if (!text(apiToken)) throw new Error("ONTOLOGY_API_TOKEN/ALLMETA_API_KEY is required.");
  const origin = safeBaseUrl(baseUrl);
  async function request(path, { method = "GET", token = apiToken, body, timeoutMs = 30_000, acceptError = false, headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${path}: Allmeta HTTP request failed (${reason}).`);
    } finally {
      clearTimeout(timer);
    }
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      throw new Error(`${path}: Allmeta returned non-JSON HTTP ${response.status}.`);
    }
    if (!response.ok && !acceptError) throw responseError(response.status, parsed, path);
    return { status: response.status, ok: response.ok, body: parsed };
  }

  async function nodeCollection(resource, domain) {
    const items = [];
    let cursor = "";
    do {
      const query = new URLSearchParams({ domain, limit: "1000" });
      if (cursor) query.set("cursor", cursor);
      const result = await request(`/api/v1/ontology/${resource}?${query}`);
      const page = record(result.body);
      items.push(...requireArray(page?.items, `${resource} API items`));
      cursor = text(page?.nextCursor);
    } while (cursor);
    return items;
  }

  async function fixedCypher(domain, cypher, purpose) {
    const result = await request("/api/v1/ontology/cypher/query", {
      method: "POST",
      body: {
        domainId: domain,
        cypher,
        params: {},
        limit: 10_000,
        purpose,
        agentId: "allmeta-full-domain-release-client",
      },
    });
    return requireArray(result.body?.records, `${purpose} records`);
  }

  return {
    origin,
    async configuration() {
      return (await request("/api/v1/ontology/release-bundles/full-domain/configuration")).body;
    },
    async captureDomain(domain) {
      const [
        objects,
        rules,
        actions,
        events,
        links,
        actionSteps,
        policyScopes,
        managedLinkRows,
        fullDomainRelationships,
      ] = await Promise.all([
        nodeCollection("objects", domain),
        nodeCollection("rules", domain),
        nodeCollection("actions", domain),
        nodeCollection("events", domain),
        request(`/api/v1/ontology/links?${new URLSearchParams({ domain })}`).then((result) =>
          requireArray(result.body?.items, "links API items")),
        fixedCypher(
          domain,
          "MATCH (n:ActionStep {domainId: $domain}) RETURN n.id AS id, coalesce(n.action_id, n.actionId, n.parentActionId) AS action_id, n.name AS name, n.__allmeta_definition_json AS definition ORDER BY action_id, name",
          "full-domain-release-before-after-action-step-readback",
        ),
        fixedCypher(
          domain,
          "MATCH (n:PolicyScope {domainId: $domain}) RETURN n.id AS id, n.__allmeta_definition_json AS definition ORDER BY id",
          "full-domain-release-before-after-policy-scope-readback",
        ),
        fixedCypher(
          domain,
          "MATCH (a)-[r]->(b) WHERE coalesce(r.domainId, a.domainId, b.domainId) = $domain AND any(label IN labels(a) WHERE label IN ['DataObject','Rule','PolicyScope','Action','ActionStep','Event']) AND any(label IN labels(b) WHERE label IN ['DataObject','Rule','PolicyScope','Action','ActionStep','Event']) AND (type(r) = 'Link' OR (coalesce(r.managedBy, r.managed_by) IN ['ontology-api','links-builder','ontology-release-bundle'] AND coalesce(r.linkId, r.link_id) IS NOT NULL)) RETURN coalesce(a.id, r.source_object) AS fromId, head([label IN labels(a) WHERE label IN ['DataObject','Rule','PolicyScope','Action','ActionStep','Event']]) AS fromLabel, coalesce(r.link_name, type(r)) AS type, coalesce(b.id, r.target_object) AS toId, head([label IN labels(b) WHERE label IN ['DataObject','Rule','PolicyScope','Action','ActionStep','Event']]) AS toLabel, properties(r) AS props ORDER BY fromLabel, fromId, type, toLabel, toId",
          "full-domain-release-before-after-managed-link-readback",
        ),
        fixedCypher(
          domain,
          "MATCH (from)-[relationship]->(to) WHERE coalesce(relationship.domainId, from.domainId, to.domainId) = $domain AND (type(relationship) IN ['HAS_FIELD','HAS_MUTATION'] OR coalesce(relationship.managedBy, relationship.managed_by) IN ['ontology-api','links-builder','ontology-release-bundle'] OR type(relationship) = 'Link') RETURN elementId(relationship) AS element_id, type(relationship) AS type, properties(relationship) AS props, elementId(from) AS from_id, elementId(to) AS to_id ORDER BY element_id",
          "full-domain-release-before-after-full-domain-raw-relationship-readback",
        ),
      ]);
      const managedCoverage = compareManagedLinkCoverage(links, managedLinkRows);
      const resources = {
        objects,
        rules,
        actions,
        actionSteps,
        events,
        policyScopes,
        links,
        managedLinkRows,
        fullDomainRelationships,
      };
      return {
        schema_version: 1,
        source: "AllmetaOntology HTTP API",
        domain,
        captured_at: new Date().toISOString(),
        counts: {
          objects: objects.length,
          rules: rules.length,
          actions: actions.length,
          actionSteps: actionSteps.length,
          events: events.length,
          policyScopes: policyScopes.length,
          // Never present a typed endpoint coverage failure as a true zero.
          links: managedCoverage.ready ? links.length : null,
          typedLinks: links.length,
          managedLinks: managedLinkRows.length,
          fullDomainRelationships: fullDomainRelationships.length,
          structuralOrNonLinkRelationships:
            Math.max(0, fullDomainRelationships.length - managedLinkRows.length),
        },
        link_readback: {
          typed_endpoint_count: links.length,
          managed_link_count: managedLinkRows.length,
          full_domain_relationship_count: fullDomainRelationships.length,
          structural_or_non_link_relationship_count:
            Math.max(0, fullDomainRelationships.length - managedLinkRows.length),
          typed_coverage_ready: managedCoverage.ready,
          typed_identity_match: managedCoverage.ready,
          source: "AllmetaOntology HTTP API",
          managed_inventory_semantics: "Allmeta buildListLinks",
          fallback: "fixed read-only /api/v1/ontology/cypher/query",
        },
        digest: hashFullDomainArtifact(resources),
        resources,
      };
    },
    async preview(body) {
      return (await request("/api/v1/ontology/release-bundles/full-domain/preview", {
        method: "POST",
        body,
        timeoutMs: 60_000,
      })).body;
    },
    async authorize(candidateId, reviewBindingHash, operatorId) {
      if (!text(operatorToken)) throw new Error("ONTOLOGY_RELEASE_OPERATOR_TOKEN is required for --execute.");
      return (await request("/api/v1/ontology/release-bundles/full-domain/authorize", {
        method: "POST",
        token: operatorToken,
        headers: { "x-allmeta-operator-id": operatorId },
        body: { candidate_id: candidateId, review_binding_hash: reviewBindingHash },
      })).body;
    },
    async execute(candidateId, reviewBindingHash, authorizationId, oneTimeToken, operatorId) {
      return request("/api/v1/ontology/release-bundles/full-domain/execute", {
        method: "POST",
        token: oneTimeToken,
        headers: { "x-allmeta-operator-id": operatorId },
        body: {
          candidate_id: candidateId,
          review_binding_hash: reviewBindingHash,
          authorization_id: authorizationId,
        },
        timeoutMs: 180_000,
        acceptError: true,
      });
    },
  };
}

export function assertReleaseConfiguration(configuration) {
  const config = record(configuration);
  const probes = record(config?.probes);
  if (!config || config.enabled !== true || config.full_domain_enabled !== true || config.configured !== true) {
    throw new Error(`Allmeta full-domain release is not enabled/configured (missing: ${
      Array.isArray(config?.missing) ? config.missing.join(", ") || "unknown" : "unknown"
    }).`);
  }
  const requiredTrue = [
    "default_closed",
    "separate_operator_token",
    "state_outside_models",
    "explicit_neo4j_identity",
    "one_time_authorization",
  ];
  if (!probes || requiredTrue.some((key) => probes[key] !== true) || probes.raw_driver_or_cypher_http_input !== false) {
    throw new Error("Allmeta release safety probes are incomplete or inconsistent.");
  }
}

function parseReviewedDefinition(item, field, label) {
  const raw = item?.[field];
  if (typeof raw !== "string") throw new Error(`${label} has no exact reviewed definition.`);
  try {
    const parsed = JSON.parse(raw);
    if (!record(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error(`${label} exact reviewed definition is invalid JSON.`);
  }
}

function compareDefinitionSet(label, expected, actual, identity) {
  const expectedById = new Map();
  const actualById = new Map();
  for (const item of expected) {
    const id = identity(item);
    if (!id || expectedById.has(id)) throw new Error(`${label} expected identity '${id}' is invalid or duplicated.`);
    expectedById.set(id, item);
  }
  for (const item of actual) {
    const id = identity(item);
    if (!id || actualById.has(id)) throw new Error(`${label} readback identity '${id}' is invalid or duplicated.`);
    actualById.set(id, item);
  }
  const expectedIds = [...expectedById.keys()].sort(compareText);
  const actualIds = [...actualById.keys()].sort(compareText);
  if (!exactStrings(expectedIds, actualIds)) {
    const missing = expectedIds.filter((id) => !actualById.has(id));
    const extra = actualIds.filter((id) => !expectedById.has(id));
    throw new Error(`${label} readback IDs differ (missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}).`);
  }
  for (const id of expectedIds) {
    if (!stableEqual(expectedById.get(id), actualById.get(id))) {
      throw new Error(`${label} readback definition differs for '${id}'.`);
    }
  }
  return expectedIds;
}

export function verifyReleaseReadback(bundle, snapshot) {
  const resources = record(snapshot?.resources);
  if (!resources || snapshot.domain !== bundle.metadata.domainId) {
    throw new Error("Readback snapshot is invalid or belongs to another domain.");
  }
  if (snapshot?.link_readback?.typed_coverage_ready !== true) {
    throw new Error(
      "Managed Link typed readback does not cover the full schema relationship inventory; exact Link verification is unavailable.",
    );
  }
  if (snapshot.link_readback.typed_endpoint_count !== bundle.links.length ||
      snapshot.link_readback.managed_link_count !== bundle.links.length) {
    throw new Error(
      `Post-release managed Link readback must be exactly ${bundle.links.length} typed and managed Links.`,
    );
  }
  const objects = requireArray(resources.objects, "readback objects").map((item) =>
    parseReviewedDefinition(item, "__allmeta_definition_json", `DataObject ${item?.id ?? "(unknown)"}`));
  const rules = requireArray(resources.rules, "readback rules").map((item) =>
    parseReviewedDefinition(item, "__allmeta_definition_json", `Rule ${item?.id ?? "(unknown)"}`));
  const actions = requireArray(resources.actions, "readback actions").map((item) =>
    parseReviewedDefinition(item, "__allmeta_definition_json", `Action ${item?.id ?? "(unknown)"}`));
  const events = requireArray(resources.events, "readback events").map((item) =>
    parseReviewedDefinition(item, "__allmeta_definition_json", `Event ${item?.name ?? "(unknown)"}`));
  const policyScopes = requireArray(resources.policyScopes, "readback PolicyScopes").map((item) =>
    parseReviewedDefinition(item, "definition", `PolicyScope ${item?.id ?? "(unknown)"}`));
  const links = requireArray(resources.links, "readback Links").map((item) =>
    parseReviewedDefinition(item, "__allmeta_link_json", `Link ${item?.id ?? item?.linkId ?? "(unknown)"}`));
  const steps = requireArray(resources.actionSteps, "readback ActionSteps").map((item) => ({
    action_id: text(item?.action_id),
    definition: parseReviewedDefinition(item, "definition", `ActionStep ${item?.id ?? "(unknown)"}`),
  }));

  const ids = {
    objects: compareDefinitionSet("DataObject", bundle.objects, objects, (item) => text(item.id)),
    rules: compareDefinitionSet("Rule", bundle.rules, rules, (item) => text(item.id)),
    actions: compareDefinitionSet("Action", bundle.actions, actions, (item) => text(item.id)),
    actionSteps: compareDefinitionSet(
      "ActionStep",
      bundle.steps,
      steps,
      (item) => actionStepNameKey(item.action_id, item.definition?.name),
    ),
    events: compareDefinitionSet("Event", bundle.events, events, (item) => text(item.name)),
    policyScopes: compareDefinitionSet("PolicyScope", bundle.policyScopes, policyScopes, (item) => text(item.id)),
    links: compareDefinitionSet("Link", bundle.links, links, (item) => text(item.id)),
  };
  const counts = Object.fromEntries(Object.entries(ids).map(([key, value]) => [key, value.length]));
  const hashes = {
    actions: hashActionCandidate(bundle.actions.map((item) => actions.find((actual) => actual.id === item.id))),
    events: hashEventCandidate(bundle.events.map((item) => events.find((actual) => actual.name === item.name))),
    objects: hashFullDomainArtifact(bundle.objects.map((item) => objects.find((actual) => actual.id === item.id))),
    rules: hashFullDomainArtifact(bundle.rules.map((item) => rules.find((actual) => actual.id === item.id))),
    policy_scopes: hashFullDomainArtifact(bundle.policyScopes.map((item) => policyScopes.find((actual) => actual.id === item.id))),
    links: hashFullDomainArtifact(bundle.links.map((item) => links.find((actual) => actual.id === item.id))),
  };
  for (const [key, expected] of Object.entries(bundle.hashes)) {
    if (hashes[key] !== expected) throw new Error(`${key} strict readback hash differs from the reviewed candidate.`);
  }
  return {
    schema_version: 1,
    verified: true,
    domain: bundle.metadata.domainId,
    counts,
    ids,
    hashes,
    links_verified_exactly: true,
    policy_scope_readback: "Allmeta HTTP cypher/query fixed read-only query",
    action_step_readback: "Allmeta HTTP cypher/query fixed read-only query",
  };
}

function loadJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} '${path}' cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function loadEnvironment(path) {
  const fileValues = existsSync(path) ? parseDotEnv(readFileSync(path, "utf8")) : {};
  return { ...fileValues, ...process.env };
}

function publicConfiguration(configuration) {
  const config = record(configuration) ?? {};
  return {
    enabled: config.enabled === true,
    full_domain_enabled: config.full_domain_enabled === true,
    configured: config.configured === true,
    missing: Array.isArray(config.missing) ? config.missing : [],
    probes: config.probes,
    integrations: config.integrations,
  };
}

function confirmationTemplate(required) {
  return {
    schema_version: 1,
    domain: TARGET_DOMAIN,
    review_required: true,
    claimable_legacy_actions: required.claimable_legacy_actions,
    claimable_legacy_step_keys: required.claimable_legacy_step_keys,
    observed_domainless_event_names: required.observed_domainless_event_names,
    claimable_legacy_event_names: [],
    unclaimed_domainless_event_names: [],
    instructions: "Review Action/ActionStep ownership. Partition every observed domain-less Event into exactly one of claimable_legacy_event_names or unclaimed_domainless_event_names, then pass this file with --confirmation-file.",
  };
}

function validateOperator(value) {
  const operator = text(value);
  if (!operator || operator.length > 200 || /[\u0000-\u001f\u007f]/u.test(operator)) {
    throw new Error("--execute requires a printable --operator-id (or ALLMETA_OPERATOR_ID), max 200 characters.");
  }
  return operator;
}

export async function run(options, dependencies = {}) {
  const env = dependencies.env ?? loadEnvironment(resolve(options.allmetaEnv));
  const apiToken = text(env.ONTOLOGY_API_TOKEN || env.ALLMETA_API_KEY);
  const operatorToken = text(env.ONTOLOGY_RELEASE_OPERATOR_TOKEN);
  const baseUrl = options.baseUrl || text(env.ALLMETA_BASE_URL) || "http://localhost:3500";
  if (!apiToken) throw new Error("ONTOLOGY_API_TOKEN/ALLMETA_API_KEY is missing.");
  if (options.execute && (!operatorToken || operatorToken === apiToken)) {
    throw new Error("--execute requires a separate ONTOLOGY_RELEASE_OPERATOR_TOKEN.");
  }
  const operatorId = options.execute
    ? validateOperator(options.operatorId || env.ALLMETA_OPERATOR_ID)
    : "";
  const bundlePath = resolve(options.bundle);
  const bundle = validateReleaseBundle(loadJson(bundlePath, "ReleaseBundle"), options.domain);
  const auditDir = ensurePrivateDirectory(resolve(options.auditDir));
  const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomBytes(5).toString("hex")}`;
  const auditPath = (suffix) => join(auditDir, `${runId}-${suffix}.json`);
  const client = createAllmetaHttpClient({
    baseUrl,
    apiToken,
    operatorToken,
    fetchImpl: dependencies.fetchImpl ?? fetch,
  });

  const configuration = await client.configuration();
  assertReleaseConfiguration(configuration);
  const beforeImage = await client.captureDomain(options.domain);
  const beforePath = atomicPrivateJson(auditPath("before-image"), {
    ...beforeImage,
    release_target: bundle.metadata,
    allmeta_origin: client.origin,
    configuration: publicConfiguration(configuration),
  });

  const discoveryRequest = buildDiscoveryRequest(bundle);
  const discovery = await client.preview(discoveryRequest);
  const discoveryPath = atomicPrivateJson(auditPath("evidence-discovery"), {
    request_hash: hashFullDomainArtifact(discoveryRequest),
    response: discovery,
  });
  const evidence = extractDiscoveryEvidence(discovery, bundle);
  const blockerAssessment = classifyDiscoveryBlockers(discovery);
  if (beforeImage.link_readback.typed_coverage_ready !== true) {
    blockerAssessment.integration.push({
      code: "managed_link_typed_readback_incomplete",
      envelope_code: "managed_link_typed_readback_incomplete",
      message: `Typed Links GET returned ${beforeImage.link_readback.typed_endpoint_count}, while the fixed Allmeta buildListLinks-equivalent inventory found ${beforeImage.link_readback.managed_link_count} managed Links with different identities. Structural/full-domain raw relationships are audit-only and are not counted as Links.`,
    });
  }
  if (beforeImage.link_readback.full_domain_relationship_count !==
      evidence.parent.full_domain_relationship_count) {
    blockerAssessment.current_state.push({
      code: "api_before_image_graph_relationship_count_mismatch",
      envelope_code: "api_before_image_graph_relationship_count_mismatch",
      message: `Allmeta graph relationship inventory changed between before-image (${beforeImage.link_readback.full_domain_relationship_count}) and discovery (${evidence.parent.full_domain_relationship_count}).`,
    });
  }
  const hasRealBlockers = blockerAssessment.candidate.length > 0 ||
    blockerAssessment.current_state.length > 0 ||
    blockerAssessment.integration.length > 0;
  const blockerNext = blockerAssessment.candidate.length > 0
    ? "fix_candidate"
    : blockerAssessment.current_state.length > 0
      ? "repair_current_ontology"
      : blockerAssessment.integration.length > 0
        ? "configure_allmeta"
        : blockerAssessment.next;
  blockerAssessment.has_real_blockers = hasRealBlockers;
  blockerAssessment.next = blockerNext;
  const assessmentPath = atomicPrivateJson(auditPath("candidate-assessment"), {
    schema_version: 1,
    domain: options.domain,
    ready_for_execute: !hasRealBlockers,
    next: blockerNext,
    blockers: blockerAssessment,
    link_readback: beforeImage.link_readback,
    authoritative_full_domain_relationship_count: evidence.parent.full_domain_relationship_count,
  });
  if (hasRealBlockers) {
    const summary = {
      mode: options.execute ? "execute_blocked" : "dry_run",
      domain: options.domain,
      ready_for_execute: false,
      mutation_performed: false,
      next: blockerNext,
      candidate_blockers: blockerAssessment.candidate,
      current_ontology_blockers: blockerAssessment.current_state,
      integration_blockers: blockerAssessment.integration,
      expected_discovery_only_blockers: blockerAssessment.discovery_only,
      audit: {
        before_image: beforePath,
        evidence_discovery: discoveryPath,
        candidate_assessment: assessmentPath,
      },
      current_counts: beforeImage.counts,
      link_readback: beforeImage.link_readback,
    };
    if (options.execute) {
      throw new Error(`Release candidate is not ready; next=${blockerNext}. Audit: ${assessmentPath}`);
    }
    return summary;
  }
  const required = deriveRequiredConfirmations(evidence, beforeImage, bundle);
  const reviewedOwnership = options.confirmationFile
    ? loadJson(resolve(options.confirmationFile), "Ownership confirmation")
    : null;
  const ownership = resolveOwnershipConfirmations(required, reviewedOwnership);
  if (!ownership.ready) {
    const confirmationPath = atomicPrivateJson(auditPath("ownership-confirmation-required"), confirmationTemplate(required));
    const summary = {
      mode: options.execute ? "execute_blocked" : "dry_run",
      domain: options.domain,
      ready_for_execute: false,
      next: "ask_user",
      reasons: ownership.reasons,
      audit: {
        before_image: beforePath,
        evidence_discovery: discoveryPath,
        candidate_assessment: assessmentPath,
        confirmation_template: confirmationPath,
      },
      planned_counts: {
        objects: bundle.objects.length,
        rules: bundle.rules.length,
        actions: bundle.actions.length,
        actionSteps: bundle.steps.length,
        events: bundle.events.length,
        policyScopes: bundle.policyScopes.length,
        links: bundle.links.length,
      },
    };
    if (options.execute) throw new Error(`${summary.reasons.join(" ")} Template: ${confirmationPath}`);
    return summary;
  }

  const reviewedRequest = buildReviewedPreviewRequest(bundle, evidence, required, ownership);
  const preparedPath = atomicPrivateJson(auditPath("reviewed-request"), {
    request: reviewedRequest,
    source_identity_note: evidence.dependency_source_identity_strategy,
  });
  if (!options.execute) {
    return {
      mode: "dry_run",
      domain: options.domain,
      ready_for_execute: true,
      mutation_performed: false,
      next: "rerun_with_--execute_and_--operator-id",
      audit: {
        before_image: beforePath,
        evidence_discovery: discoveryPath,
        candidate_assessment: assessmentPath,
        reviewed_request: preparedPath,
      },
      current_counts: beforeImage.counts,
      link_readback: beforeImage.link_readback,
      planned_counts: {
        objects: bundle.objects.length,
        rules: bundle.rules.length,
        actions: bundle.actions.length,
        actionSteps: bundle.steps.length,
        events: bundle.events.length,
        policyScopes: bundle.policyScopes.length,
        links: bundle.links.length,
      },
      removal_confirmations: {
        actions: required.removed_action_ids,
        actionSteps: required.removed_step_keys,
        events: required.removed_event_names,
      },
    };
  }

  const previewResponse = await client.preview(reviewedRequest);
  const previewPath = atomicPrivateJson(auditPath("ready-preview"), previewResponse);
  const candidate = record(previewResponse?.candidate);
  const preview = record(previewResponse?.preview);
  const candidateId = text(candidate?.candidate_id);
  const bindingHash = text(preview?.review_binding_hash);
  if (previewResponse?.ready !== true || previewResponse?.next !== "authorize" ||
      !UUID_RE.test(candidateId) || !HASH_RE.test(bindingHash) ||
      (Array.isArray(previewResponse?.blockers) && previewResponse.blockers.length > 0)) {
    throw new Error(`Reviewed preview is not ready. Audit: ${previewPath}`);
  }

  const authorization = await client.authorize(candidateId, bindingHash, operatorId);
  const authorizationId = text(authorization?.authorization_id);
  const oneTimeToken = text(authorization?.authorization_token);
  if (!UUID_RE.test(authorizationId) || !oneTimeToken ||
      authorization?.candidate_id !== candidateId || authorization?.review_binding_hash !== bindingHash) {
    throw new Error("Allmeta returned an invalid one-time authorization grant.");
  }
  const authorizationPath = atomicPrivateJson(auditPath("authorization-receipt"), {
    schema_version: authorization.schema_version,
    authorization_id: authorizationId,
    candidate_id: candidateId,
    review_binding_hash: bindingHash,
    actor: authorization.actor,
    expires_at: authorization.expires_at,
    one_time_token_persisted: false,
  });

  let execution;
  try {
    execution = await client.execute(candidateId, bindingHash, authorizationId, oneTimeToken, operatorId);
  } catch (error) {
    throw new Error(`Execute outcome is unknown; do not retry authorization automatically. Inspect Allmeta release journal and readback. ${error instanceof Error ? error.message : String(error)}`);
  }
  const executionPath = atomicPrivateJson(auditPath("execution-receipt"), {
    http_status: execution.status,
    response: execution.body,
  });
  if (!execution.ok || execution.body?.ok !== true || execution.body?.outcome !== "published" ||
      execution.body?.candidate_id !== candidateId || execution.body?.review_binding_hash !== bindingHash) {
    throw new Error(`Release execution did not publish consistently. Audit: ${executionPath}`);
  }

  const postImage = await client.captureDomain(options.domain);
  const postPath = atomicPrivateJson(auditPath("post-image"), postImage);
  const verification = verifyReleaseReadback(bundle, postImage);
  const verificationPath = atomicPrivateJson(auditPath("readback-verification"), {
    ...verification,
    release_id: execution.body.release_id,
    candidate_id: candidateId,
    review_binding_hash: bindingHash,
  });
  return {
    mode: "execute",
    domain: options.domain,
    published: true,
    release_id: execution.body.release_id,
    candidate_id: candidateId,
    review_binding_hash: bindingHash,
    counts: verification.counts,
    audit: {
      before_image: beforePath,
      evidence_discovery: discoveryPath,
      candidate_assessment: assessmentPath,
      reviewed_request: preparedPath,
      ready_preview: previewPath,
      authorization_receipt: authorizationPath,
      execution_receipt: executionPath,
      post_image: postPath,
      readback_verification: verificationPath,
    },
  };
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  const summary = await run(options);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = exitCodeForSummary(summary);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`Allmeta full-domain release client stopped safely: ${
      error instanceof Error ? error.message : String(error)
    }\n`);
    process.exitCode = 1;
  });
}
