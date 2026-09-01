/**
 * Immutable Ontology Package -> Agentic Operator shadow-candidate admission.
 *
 * This boundary intentionally does not compile an AO workflow manifest.  An
 * OntoPlanet package can carry stronger workflow, artifact, policy and
 * activation contracts than the AO manifest runtime currently enforces.  The
 * only safe first step is therefore to verify the immutable package and emit a
 * transport-neutral, explicitly non-deployable inspection receipt.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import actionsSchemaV32 from "../schemas/3.2.0/actions.schema.json" with { type: "json" };
import commonSchemaV32 from "../schemas/3.2.0/common.schema.json" with { type: "json" };
import eventsSchemaV32 from "../schemas/3.2.0/events.schema.json" with { type: "json" };
import linksSchemaV32 from "../schemas/3.2.0/links.schema.json" with { type: "json" };
import manifestSchemaV32 from "../schemas/3.2.0/ontology-template-package-manifest.schema.json" with { type: "json" };
import packageSchemaV32 from "../schemas/3.2.0/ontology-template-package.schema.json" with { type: "json" };
import objectsSchemaV32 from "../schemas/3.2.0/objects.schema.json" with { type: "json" };
import rulesSchemaV32 from "../schemas/3.2.0/rules.schema.json" with { type: "json" };
import workflowsSchemaV32 from "../schemas/3.2.0/workflows.schema.json" with { type: "json" };

export const ONTOLOGY_PACKAGE_SHADOW_CANDIDATE_SCHEMA =
  "agentic-operator.ontology-package-shadow-candidate/v1" as const;

export const ONTOLOGY_PACKAGE_FAMILIES = [
  "objects",
  "rules",
  "actions",
  "events",
  "links",
  "workflows",
] as const;

export type OntologyPackageFamily = (typeof ONTOLOGY_PACKAGE_FAMILIES)[number];
export type Sha256Digest = `sha256:${string}`;

/**
 * Pinned from OntoPlanet's immutable 3.2.0 schema bundle.
 *
 * Source of truth:
 * `packages/ontology-core/schemas/3.2.0/manifest.json`
 * bundle SHA-256: 0c7ee809a0049c2ae4baabbf672bcb412ed49a8380ab42ab1ecace32658b0d86
 *
 * Admission options may restrict this set, but must never make an unknown
 * bundle executable merely by naming it.
 */
const ONTOLOGY_PACKAGE_SCHEMA_CONTRACTS = {
  "3.2.0": {
    bundleSha256:
      "0c7ee809a0049c2ae4baabbf672bcb412ed49a8380ab42ab1ecace32658b0d86",
    manifestSchemaVersion: "1.0.0",
    packageSchemaId:
      "https://schemas.allmeta.ai/ontology/3.2.0/ontology-template-package.schema.json",
    familySchemaIds: Object.fromEntries(
      ONTOLOGY_PACKAGE_FAMILIES.map((family) => [
        family,
        `https://schemas.allmeta.ai/ontology/3.2.0/${family}.schema.json`,
      ]),
    ) as Record<OntologyPackageFamily, string>,
  },
} as const;

type SupportedOntologyPackageSchemaBundle =
  keyof typeof ONTOLOGY_PACKAGE_SCHEMA_CONTRACTS;

type JsonRecord = Record<string, unknown>;

export interface OntologyPackageAdmissionOptions {
  expectedPackageId?: string;
  expectedRelease?: string;
  expectedPackageHash?: Sha256Digest;
  supportedSchemaBundles?: readonly string[];
}

export interface OperatorShadowWorkflowEdge {
  parent_workflow_id: string;
  parent_workflow_version: string;
  step_id: string;
  child_workflow_id: string;
  child_workflow_version: string;
  runtime_enforcement: boolean;
}

export interface OperatorShadowWorkflowSummary {
  id: string;
  version: string;
  activation_status: string;
  entry_step_ids: string[];
  trigger_kinds: string[];
  trigger_events: string[];
  step_count: number;
  step_kinds: Record<string, number>;
  execution_modes: Record<string, number>;
  action_ids: string[];
  agent_step_ids: string[];
  wait_step_ids: string[];
  child_workflows: Array<{
    workflow_id: string;
    workflow_version: string;
    step_id: string;
    runtime_enforcement: boolean;
  }>;
}

export interface OperatorShadowAgentContractSummary {
  id: string;
  version: string;
  contract_hash: Sha256Digest;
  activation_status: "specified_not_activated";
  deployment_status: "not_deployed";
  runtime_scope: "candidate_shadow_fixture_only";
  prompt_profile: {
    id: string;
    version: string;
    content_hash: Sha256Digest;
  };
  grants: Array<{
    action_id: string;
    permission: string;
    effect: string;
    external: false;
    consequential_write: false;
  }>;
  subscriptions: unknown[];
  eval_cases: unknown[];
}

export interface OperatorShadowCandidate {
  schema: typeof ONTOLOGY_PACKAGE_SHADOW_CANDIDATE_SCHEMA;
  source_package: {
    package_id: string;
    release: string;
    package_hash: Sha256Digest;
    schema_version: string;
    schema_bundle_version: string;
    immutable: true;
    domain_id: string;
    project_id: string | null;
    package_kind: string;
    primary_workflow_id: string;
  };
  admission: {
    status: "verified_shadow_candidate";
    deployable: false;
    runtime_import_allowed: false;
    runtime_scope: "candidate_shadow_fixture_only";
    checks: Array<{
      id: string;
      status: "passed";
      evidence: string[];
    }>;
    activation_blockers: Array<{
      code: string;
      count: number;
      evidence: string[];
    }>;
  };
  artifact_counts: Record<OntologyPackageFamily, number> & {
    workflow_steps: number;
  };
  family_hashes: Record<OntologyPackageFamily, Sha256Digest>;
  capabilities: {
    action_count: number;
    internal_action_count: number;
    external_action_count: number;
    executable_action_count: 0;
    executable_external_action_count: 0;
    agent_step_count: number;
    human_step_count: number;
    wait_step_count: number;
    subflow_step_count: number;
  };
  workflows: OperatorShadowWorkflowSummary[];
  workflow_graph: {
    primary_workflow_id: string;
    workflow_ids: string[];
    child_edges: OperatorShadowWorkflowEdge[];
  };
  agent_contracts: OperatorShadowAgentContractSummary[];
  receipt_hash: Sha256Digest;
}

export class OntologyPackageAdmissionError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message: string) {
    super(`[ontology-package:${code}] ${path}: ${message}`);
    this.name = "OntologyPackageAdmissionError";
    this.code = code;
    this.path = path;
  }
}

function fail(code: string, path: string, message: string): never {
  throw new OntologyPackageAdmissionError(code, path, message);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) fail("invalid-shape", path, "must be a JSON object");
  return value;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value))
    fail("invalid-shape", path, "must be a JSON array");
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail("invalid-shape", path, "must be a non-empty string");
  }
  return value.trim();
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean")
    fail("invalid-shape", path, "must be a boolean");
  return value;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail("invalid-shape", path, "must be a non-negative safe integer");
  }
  return Number(value);
}

function digest(value: unknown, path: string): Sha256Digest {
  const parsed = string(value, path);
  if (!/^sha256:[0-9a-f]{64}$/u.test(parsed)) {
    fail("invalid-digest", path, "must be a lowercase sha256 digest");
  }
  return parsed as Sha256Digest;
}

function stringArray(value: unknown, path: string): string[] {
  return array(value, path).map((entry, index) =>
    string(entry, `${path}[${index}]`),
  );
}

function createPackageSchemaValidator(): ValidateFunction {
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: true,
    strictRequired: false,
    strictTypes: false,
  });
  addFormats(ajv);
  const schemas = [
    commonSchemaV32,
    objectsSchemaV32,
    rulesSchemaV32,
    actionsSchemaV32,
    eventsSchemaV32,
    linksSchemaV32,
    workflowsSchemaV32,
    manifestSchemaV32,
    packageSchemaV32,
  ] as AnySchema[];
  for (const schema of schemas) ajv.addSchema(schema);
  const schemaId = ONTOLOGY_PACKAGE_SCHEMA_CONTRACTS["3.2.0"].packageSchemaId;
  const validator = ajv.getSchema(schemaId);
  if (!validator) {
    throw new Error(`Missing vendored ontology package schema ${schemaId}`);
  }
  return validator;
}

const PACKAGE_SCHEMA_VALIDATORS: Record<
  SupportedOntologyPackageSchemaBundle,
  ValidateFunction
> = {
  "3.2.0": createPackageSchemaValidator(),
};

function schemaIssuePath(issue: ErrorObject): string {
  const suffix =
    issue.keyword === "required" &&
    typeof (issue.params as { missingProperty?: unknown }).missingProperty ===
      "string"
      ? `/${(issue.params as { missingProperty: string }).missingProperty}`
      : "";
  const pointer = `${issue.instancePath}${suffix}`;
  if (!pointer) return "$";
  return `$${pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"))
    .map((segment) => (/^\d+$/u.test(segment) ? `[${segment}]` : `.${segment}`))
    .join("")}`;
}

function validateShippedPackageSchema(
  value: unknown,
): SupportedOntologyPackageSchemaBundle {
  const root = record(value, "$");
  const manifest = record(root.manifest, "$.manifest");
  const bundleVersion = string(
    manifest.schema_bundle_version,
    "$.manifest.schema_bundle_version",
  );
  if (
    !Object.prototype.hasOwnProperty.call(
      ONTOLOGY_PACKAGE_SCHEMA_CONTRACTS,
      bundleVersion,
    )
  ) {
    fail(
      "unsupported-schema-bundle",
      "$.manifest.schema_bundle_version",
      `${bundleVersion}; shipped: ${Object.keys(ONTOLOGY_PACKAGE_SCHEMA_CONTRACTS).join(", ")}`,
    );
  }
  const supportedVersion =
    bundleVersion as SupportedOntologyPackageSchemaBundle;
  const manifestVersion = manifest.schema_version;
  if (
    typeof manifestVersion === "string" &&
    manifestVersion !==
      ONTOLOGY_PACKAGE_SCHEMA_CONTRACTS[supportedVersion].manifestSchemaVersion
  ) {
    fail(
      "unsupported-manifest-schema",
      "$.manifest.schema_version",
      `${manifestVersion}; expected ${ONTOLOGY_PACKAGE_SCHEMA_CONTRACTS[supportedVersion].manifestSchemaVersion}`,
    );
  }
  if (isRecord(manifest.families)) {
    for (const family of ONTOLOGY_PACKAGE_FAMILIES) {
      const familyManifest = manifest.families[family];
      if (!isRecord(familyManifest)) continue;
      const schemaId = familyManifest.schema_id;
      const expectedSchemaId =
        ONTOLOGY_PACKAGE_SCHEMA_CONTRACTS[supportedVersion].familySchemaIds[
          family
        ];
      if (typeof schemaId === "string" && schemaId !== expectedSchemaId) {
        fail(
          "family-schema-id-mismatch",
          `$.manifest.families.${family}.schema_id`,
          `must equal ${expectedSchemaId}`,
        );
      }
      const filename = familyManifest.filename;
      if (
        typeof filename === "string" &&
        (filename === "." ||
          filename === ".." ||
          filename.includes("/") ||
          filename.includes("\\") ||
          filename.includes("\0"))
      ) {
        fail(
          "family-filename-invalid",
          `$.manifest.families.${family}.filename`,
          "must be a basename, not a path",
        );
      }
    }
  }
  const validator = PACKAGE_SCHEMA_VALIDATORS[supportedVersion];
  if (validator(value)) return supportedVersion;
  const allIssues = validator.errors ?? [];
  const issues = allIssues.slice(0, 20);
  const first = issues[0];
  const suffix =
    allIssues.length > issues.length
      ? `; plus ${allIssues.length - issues.length} more issue(s)`
      : "";
  fail(
    "package-schema-invalid",
    first ? schemaIssuePath(first) : "$",
    `does not conform to the vendored ${supportedVersion} envelope and six-family schemas: ${issues
      .map(
        (issue) =>
          `${schemaIssuePath(issue)} ${issue.message ?? "does not conform"}`,
      )
      .join("; ")}${suffix}`,
  );
}

function sortJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortJson(entry, seen));
  if (!value || typeof value !== "object") return value;
  if (seen.has(value))
    fail("invalid-json", "$", "cyclic JSON is not supported");
  seen.add(value);
  const source = value as JsonRecord;
  const output: JsonRecord = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (
      entry === undefined ||
      typeof entry === "function" ||
      typeof entry === "symbol"
    )
      continue;
    output[key] = sortJson(entry, seen);
  }
  seen.delete(value);
  return output;
}

/** OntoPlanet's hash contract: compact JSON with recursively sorted object keys. */
export function ontologyPackageCanonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function hashOntologyPackageJson(value: unknown): Sha256Digest {
  return `sha256:${createHash("sha256").update(ontologyPackageCanonicalJson(value)).digest("hex")}`;
}

export function ontologyPackageHashPayload(value: unknown): unknown {
  const root = record(value, "$");
  const manifest = record(root.manifest, "$.manifest");
  const { package_hash: _packageHash, ...manifestWithoutHash } = manifest;
  return {
    manifest: manifestWithoutHash,
    artifacts: root.artifacts,
  };
}

function artifactIdentity(
  family: OntologyPackageFamily,
  value: unknown,
  path: string,
): string {
  const item = record(value, path);
  return string(
    family === "events" ? item.name : item.id,
    `${path}.${family === "events" ? "name" : "id"}`,
  );
}

function exactArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) =>
      left.localeCompare(right, "en"),
    ),
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
}

function optionalExtensions(value: JsonRecord): JsonRecord {
  return isRecord(value.extensions) ? value.extensions : {};
}

function validateFamily(
  family: OntologyPackageFamily,
  familyManifestValue: unknown,
  artifactsValue: unknown,
  schemaBundleVersion: SupportedOntologyPackageSchemaBundle,
): { artifacts: JsonRecord[]; hash: Sha256Digest } {
  const familyPath = `$.manifest.families.${family}`;
  const familyManifest = record(familyManifestValue, familyPath);
  if (string(familyManifest.family, `${familyPath}.family`) !== family) {
    fail(
      "family-identity-mismatch",
      `${familyPath}.family`,
      `must equal ${family}`,
    );
  }
  const schemaId = string(familyManifest.schema_id, `${familyPath}.schema_id`);
  const canonicalSchemaId =
    ONTOLOGY_PACKAGE_SCHEMA_CONTRACTS[schemaBundleVersion].familySchemaIds[
      family
    ];
  if (schemaId !== canonicalSchemaId) {
    fail(
      "family-schema-id-mismatch",
      `${familyPath}.schema_id`,
      `must equal ${canonicalSchemaId}`,
    );
  }
  const filename = string(familyManifest.filename, `${familyPath}.filename`);
  if (
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0")
  ) {
    fail(
      "family-filename-invalid",
      `${familyPath}.filename`,
      "must be a basename, not a path",
    );
  }
  const artifacts = array(artifactsValue, `$.artifacts.${family}`).map(
    (entry, index) => record(entry, `$.artifacts.${family}[${index}]`),
  );
  const declaredCount = integer(
    familyManifest.artifact_count,
    `${familyPath}.artifact_count`,
  );
  if (declaredCount !== artifacts.length) {
    fail(
      "family-count-mismatch",
      `${familyPath}.artifact_count`,
      `declares ${declaredCount}, actual ${artifacts.length}`,
    );
  }
  const actualIds = artifacts.map((entry, index) =>
    artifactIdentity(family, entry, `$.artifacts.${family}[${index}]`),
  );
  if (new Set(actualIds).size !== actualIds.length) {
    fail(
      "duplicate-artifact-identity",
      `$.artifacts.${family}`,
      "contains duplicate identities",
    );
  }
  const declaredIds = stringArray(
    familyManifest.ordered_artifact_ids,
    `${familyPath}.ordered_artifact_ids`,
  );
  if (!exactArray(declaredIds, actualIds)) {
    fail(
      "family-order-mismatch",
      `${familyPath}.ordered_artifact_ids`,
      "does not exactly match authored artifact order",
    );
  }
  const declaredHash = digest(
    familyManifest.content_hash,
    `${familyPath}.content_hash`,
  );
  const actualHash = hashOntologyPackageJson(artifacts);
  if (declaredHash !== actualHash) {
    fail(
      "family-hash-mismatch",
      `${familyPath}.content_hash`,
      `declares ${declaredHash}, actual ${actualHash}`,
    );
  }
  return { artifacts, hash: actualHash };
}

function validateCoverageCounts(
  coverageValue: unknown,
  artifacts: Record<OntologyPackageFamily, JsonRecord[]>,
): JsonRecord {
  const coverage = record(coverageValue, "$.manifest.coverage");
  for (const family of ONTOLOGY_PACKAGE_FAMILIES) {
    const declared = integer(coverage[family], `$.manifest.coverage.${family}`);
    if (declared !== artifacts[family].length) {
      fail(
        "coverage-count-mismatch",
        `$.manifest.coverage.${family}`,
        `declares ${declared}, actual ${artifacts[family].length}`,
      );
    }
  }
  if (
    coverage.source_requirements !== undefined &&
    coverage.represented_source_requirements !== undefined
  ) {
    const sourceRequirements = integer(
      coverage.source_requirements,
      "$.manifest.coverage.source_requirements",
    );
    const representedSourceRequirements = integer(
      coverage.represented_source_requirements,
      "$.manifest.coverage.represented_source_requirements",
    );
    if (representedSourceRequirements > sourceRequirements) {
      fail(
        "coverage-source-overflow",
        "$.manifest.coverage.represented_source_requirements",
        `${representedSourceRequirements} exceeds source_requirements ${sourceRequirements}`,
      );
    }
  }
  return coverage;
}

interface ShadowActionContract {
  implementationKind: string;
  actors: string[];
  proposeOnly: boolean;
  externalCapabilityCount: number;
  notificationCount: number;
  dataChangeCount: number;
}

function requireShadowActionBoundary(actions: readonly JsonRecord[]): {
  internal: number;
  external: number;
  actionContracts: ReadonlyMap<string, ShadowActionContract>;
} {
  let internal = 0;
  let external = 0;
  const actionContracts = new Map<string, ShadowActionContract>();
  for (const [index, action] of actions.entries()) {
    const path = `$.artifacts.actions[${index}]`;
    const actionId = string(action.id, `${path}.id`);
    const implementation = record(
      action.implementation,
      `${path}.implementation`,
    );
    const kind = string(implementation.kind, `${path}.implementation.kind`);
    const executable = boolean(
      implementation.executable,
      `${path}.implementation.executable`,
    );
    if (executable) {
      fail(
        "executable-action-forbidden",
        `${path}.implementation.executable`,
        `${actionId} is executable; the shadow admission boundary accepts only executable:false`,
      );
    }
    if (kind === "external") external += 1;
    else internal += 1;
    const actionExtensions = optionalExtensions(action);
    const sideEffects =
      action.side_effects === undefined
        ? {}
        : record(action.side_effects, `${path}.side_effects`);
    const actionSteps = array(
      action.action_steps ?? [],
      `${path}.action_steps`,
    );
    let actionStepToolCount = 0;
    let actionStepNotificationCount = 0;
    let actionStepDataChangeCount = 0;
    for (const [stepIndex, stepValue] of actionSteps.entries()) {
      const stepPath = `${path}.action_steps[${stepIndex}]`;
      const step = record(stepValue, stepPath);
      if (string(step.object_type, `${stepPath}.object_type`) === "tool") {
        actionStepToolCount += 1;
      }
      actionStepNotificationCount += array(
        step.notifications ?? [],
        `${stepPath}.notifications`,
      ).length;
      actionStepDataChangeCount += array(
        step.data_changes ?? [],
        `${stepPath}.data_changes`,
      ).length;
    }
    const implementationCapabilityCount = [
      "operation_id",
      "endpoint",
      "method",
      "credential_ref",
      "request_mapping",
      "response_mapping",
      "mcp_tool_name",
      "command",
    ].filter((key) => implementation[key] !== undefined).length;
    actionContracts.set(actionId, {
      implementationKind: kind,
      actors: stringArray(action.actor, `${path}.actor`),
      proposeOnly: actionExtensions.propose_only === true,
      externalCapabilityCount:
        array(
          sideEffects.external_calls ?? [],
          `${path}.side_effects.external_calls`,
        ).length +
        array(action.tool_use ?? [], `${path}.tool_use`).length +
        actionStepToolCount +
        implementationCapabilityCount,
      notificationCount:
        array(
          sideEffects.notifications ?? [],
          `${path}.side_effects.notifications`,
        ).length +
        array(action.notifications ?? [], `${path}.notifications`).length +
        actionStepNotificationCount,
      dataChangeCount:
        array(
          sideEffects.data_changes ?? [],
          `${path}.side_effects.data_changes`,
        ).length + actionStepDataChangeCount,
    });
  }
  return { internal, external, actionContracts };
}

function summarizeAgentContracts(
  extensions: JsonRecord,
  actionContracts: ReadonlyMap<string, ShadowActionContract>,
): OperatorShadowAgentContractSummary[] {
  const raw = extensions.agent_contracts ?? [];
  const contracts = array(raw, "$.manifest.extensions.agent_contracts");
  const summaries = contracts.map(
    (entry, index): OperatorShadowAgentContractSummary => {
      const path = `$.manifest.extensions.agent_contracts[${index}]`;
      const contract = record(entry, path);
      const id = string(contract.id, `${path}.id`);
      const version = string(contract.version, `${path}.version`);
      const activationStatus = string(
        contract.activation_status,
        `${path}.activation_status`,
      );
      const deploymentStatus = string(
        contract.deployment_status,
        `${path}.deployment_status`,
      );
      const runtimeScope = string(
        contract.runtime_scope,
        `${path}.runtime_scope`,
      );
      if (
        activationStatus !== "specified_not_activated" ||
        deploymentStatus !== "not_deployed" ||
        runtimeScope !== "candidate_shadow_fixture_only"
      ) {
        fail(
          "agent-contract-not-shadow-only",
          path,
          `${id}@${version} must remain specified_not_activated, not_deployed and candidate_shadow_fixture_only`,
        );
      }
      const prompt = record(contract.prompt_profile, `${path}.prompt_profile`);
      const declaredPromptHash = digest(
        prompt.content_hash,
        `${path}.prompt_profile.content_hash`,
      );
      const { content_hash: _promptHash, ...promptContent } = prompt;
      const actualPromptHash = hashOntologyPackageJson(promptContent);
      if (declaredPromptHash !== actualPromptHash) {
        fail(
          "prompt-profile-hash-mismatch",
          `${path}.prompt_profile.content_hash`,
          `declares ${declaredPromptHash}, actual ${actualPromptHash}`,
        );
      }
      const outputContract = record(
        prompt.output_contract,
        `${path}.prompt_profile.output_contract`,
      );
      const outputMode = string(
        outputContract.mode,
        `${path}.prompt_profile.output_contract.mode`,
      );
      const humanApprovalRequired = boolean(
        outputContract.human_approval_required,
        `${path}.prompt_profile.output_contract.human_approval_required`,
      );
      if (outputMode !== "proposal_only" || !humanApprovalRequired) {
        fail(
          "unsafe-agent-prompt-contract",
          `${path}.prompt_profile.output_contract`,
          `${id}@${version} must require mode=proposal_only and human_approval_required=true`,
        );
      }
      const declaredContractHash = digest(
        contract.contract_hash,
        `${path}.contract_hash`,
      );
      const { contract_hash: _contractHash, ...contractContent } = contract;
      const actualContractHash = hashOntologyPackageJson(contractContent);
      if (declaredContractHash !== actualContractHash) {
        fail(
          "agent-contract-hash-mismatch",
          `${path}.contract_hash`,
          `declares ${declaredContractHash}, actual ${actualContractHash}`,
        );
      }
      const grants = array(contract.grants, `${path}.grants`).map(
        (grantValue, grantIndex) => {
          const grantPath = `${path}.grants[${grantIndex}]`;
          const grant = record(grantValue, grantPath);
          const actionId = string(grant.action_id, `${grantPath}.action_id`);
          const actionContract = actionContracts.get(actionId);
          if (!actionContract) {
            fail(
              "unknown-agent-grant-action",
              `${grantPath}.action_id`,
              actionId,
            );
          }
          const permission = string(
            grant.permission,
            `${grantPath}.permission`,
          );
          const effect = string(grant.effect, `${grantPath}.effect`);
          if (
            permission !== "invoke_candidate_internal_action" ||
            effect !== "internal_proposal_only" ||
            grant.external !== false ||
            grant.consequential_write !== false ||
            !["typescript", "prompt"].includes(
              actionContract.implementationKind,
            ) ||
            !actionContract.actors.includes("Agent") ||
            !actionContract.proposeOnly ||
            actionContract.externalCapabilityCount > 0 ||
            actionContract.notificationCount > 0 ||
            actionContract.dataChangeCount > 0
          ) {
            fail(
              "unsafe-agent-grant",
              grantPath,
              `${actionId} must grant invoke_candidate_internal_action/internal_proposal_only to a proposal-only Agent Action with no external/tool capabilities, notifications, or data changes and remain external:false/consequential_write:false; implementation.kind=${actionContract.implementationKind}, actors=${actionContract.actors.join(",") || "none"}, propose_only=${actionContract.proposeOnly}, external_capabilities=${actionContract.externalCapabilityCount}, notifications=${actionContract.notificationCount}, data_changes=${actionContract.dataChangeCount}`,
            );
          }
          return {
            action_id: actionId,
            permission,
            effect,
            external: false as const,
            consequential_write: false as const,
          };
        },
      );
      const grantedActionIds = grants.map((grant) => grant.action_id);
      if (new Set(grantedActionIds).size !== grantedActionIds.length) {
        fail(
          "duplicate-agent-grant",
          `${path}.grants`,
          `${id}@${version} contains duplicate Action grants`,
        );
      }
      return {
        id,
        version,
        contract_hash: declaredContractHash,
        activation_status: "specified_not_activated",
        deployment_status: "not_deployed",
        runtime_scope: "candidate_shadow_fixture_only",
        prompt_profile: {
          id: string(prompt.id, `${path}.prompt_profile.id`),
          version: string(prompt.version, `${path}.prompt_profile.version`),
          content_hash: declaredPromptHash,
        },
        grants,
        subscriptions: structuredClone(
          array(contract.subscriptions ?? [], `${path}.subscriptions`),
        ),
        eval_cases: structuredClone(
          array(contract.eval_cases ?? [], `${path}.eval_cases`),
        ),
      };
    },
  );
  const identities = summaries.map(
    (contract) => `${contract.id}@${contract.version}`,
  );
  if (new Set(identities).size !== identities.length) {
    fail(
      "duplicate-agent-contract",
      "$.manifest.extensions.agent_contracts",
      "contains duplicate identities",
    );
  }
  return summaries.sort((left, right) =>
    `${left.id}@${left.version}`.localeCompare(
      `${right.id}@${right.version}`,
      "en",
    ),
  );
}

function summarizeWorkflows(
  workflows: readonly JsonRecord[],
  actionIds: ReadonlySet<string>,
  eventIds: ReadonlySet<string>,
  agentContracts: readonly OperatorShadowAgentContractSummary[],
): {
  summaries: OperatorShadowWorkflowSummary[];
  edges: OperatorShadowWorkflowEdge[];
} {
  const workflowsById = new Map<
    string,
    { workflow: JsonRecord; version: string; index: number }
  >();
  for (const [index, workflow] of workflows.entries()) {
    const path = `$.artifacts.workflows[${index}]`;
    const id = string(workflow.id, `${path}.id`);
    const version = string(
      workflow.workflow_version,
      `${path}.workflow_version`,
    );
    if (workflowsById.has(id)) fail("duplicate-workflow", `${path}.id`, id);
    workflowsById.set(id, { workflow, version, index });
  }
  const contractsById = new Map(
    agentContracts.map((contract) => [
      `${contract.id}@${contract.version}`,
      contract,
    ]),
  );
  const summaries: OperatorShadowWorkflowSummary[] = [];
  const edges: OperatorShadowWorkflowEdge[] = [];
  const agentStepBindings = new Set<string>();
  const usedAgentGrants = new Set<string>();

  for (const [index, workflow] of workflows.entries()) {
    const path = `$.artifacts.workflows[${index}]`;
    const id = string(workflow.id, `${path}.id`);
    const version = string(
      workflow.workflow_version,
      `${path}.workflow_version`,
    );
    const extensions = optionalExtensions(workflow);
    const activationStatus = string(
      extensions.activation_status,
      `${path}.extensions.activation_status`,
    );
    if (/^(active|activated|deployed|production)/iu.test(activationStatus)) {
      fail(
        "workflow-activation-forbidden",
        `${path}.extensions.activation_status`,
        `${id}@${version} is ${activationStatus}`,
      );
    }
    const steps = array(workflow.steps, `${path}.steps`).map(
      (entry, stepIndex) => record(entry, `${path}.steps[${stepIndex}]`),
    );
    const stepIds = steps.map((step, stepIndex) =>
      string(step.id, `${path}.steps[${stepIndex}].id`),
    );
    if (new Set(stepIds).size !== stepIds.length) {
      fail(
        "duplicate-workflow-step",
        `${path}.steps`,
        `${id} contains duplicate step ids`,
      );
    }
    const actionIdsForWorkflow: string[] = [];
    const agentStepIds: string[] = [];
    const waitStepIds: string[] = [];
    const childWorkflows: OperatorShadowWorkflowSummary["child_workflows"] = [];
    const stepKinds: string[] = [];
    const executionModes: string[] = [];

    for (const [stepIndex, step] of steps.entries()) {
      const stepPath = `${path}.steps[${stepIndex}]`;
      const stepId = string(step.id, `${stepPath}.id`);
      const kind = string(step.node_kind, `${stepPath}.node_kind`);
      stepKinds.push(kind);
      const execution = record(step.execution, `${stepPath}.execution`);
      const mode = string(execution.mode, `${stepPath}.execution.mode`);
      executionModes.push(mode);
      let stepActionId: string | null = null;
      if (kind === "action") {
        const actionId = string(step.action_id, `${stepPath}.action_id`);
        if (!actionIds.has(actionId)) {
          fail("unknown-workflow-action", `${stepPath}.action_id`, actionId);
        }
        stepActionId = actionId;
        actionIdsForWorkflow.push(actionId);
      }
      if (mode === "agent") {
        agentStepIds.push(stepId);
        if (kind !== "action" || !stepActionId) {
          fail(
            "agent-step-not-action",
            stepPath,
            `${id}:${stepId} uses execution.mode=agent but is not an Action step`,
          );
        }
        const stepExtensions = optionalExtensions(step);
        const contractId = string(
          stepExtensions.agent_contract_id,
          `${stepPath}.extensions.agent_contract_id`,
        );
        const contract = contractsById.get(contractId);
        if (!contract) {
          fail(
            "unknown-agent-contract",
            `${stepPath}.extensions.agent_contract_id`,
            contractId,
          );
        }
        if (
          !contract.grants.some((grant) => grant.action_id === stepActionId)
        ) {
          fail(
            "agent-step-action-not-granted",
            `${stepPath}.action_id`,
            `${contractId} does not grant ${stepActionId}`,
          );
        }
        usedAgentGrants.add(`${contractId}\u0000${stepActionId}`);
        agentStepBindings.add(`${contractId}\u0000${id}\u0000${stepId}`);
      }
      if (kind === "wait") waitStepIds.push(stepId);
      if (kind === "subflow") {
        const childWorkflowId = string(
          step.workflow_id,
          `${stepPath}.workflow_id`,
        );
        const child = workflowsById.get(childWorkflowId);
        if (!child)
          fail(
            "unknown-child-workflow",
            `${stepPath}.workflow_id`,
            childWorkflowId,
          );
        const stepExtensions = optionalExtensions(step);
        const pinnedVersion = string(
          stepExtensions.pinned_workflow_version,
          `${stepPath}.extensions.pinned_workflow_version`,
        );
        if (pinnedVersion !== child.version) {
          fail(
            "child-workflow-version-mismatch",
            `${stepPath}.extensions.pinned_workflow_version`,
            `pins ${pinnedVersion}, child ${childWorkflowId} is ${child.version}`,
          );
        }
        const bindings = record(
          stepExtensions.artifact_bindings,
          `${stepPath}.extensions.artifact_bindings`,
        );
        const runtimeEnforcement = boolean(
          bindings.runtime_enforcement,
          `${stepPath}.extensions.artifact_bindings.runtime_enforcement`,
        );
        const edge = {
          parent_workflow_id: id,
          parent_workflow_version: version,
          step_id: stepId,
          child_workflow_id: childWorkflowId,
          child_workflow_version: pinnedVersion,
          runtime_enforcement: runtimeEnforcement,
        };
        edges.push(edge);
        childWorkflows.push({
          workflow_id: childWorkflowId,
          workflow_version: pinnedVersion,
          step_id: stepId,
          runtime_enforcement: runtimeEnforcement,
        });
      }
    }
    const triggers = array(workflow.triggers, `${path}.triggers`).map(
      (entry, triggerIndex) =>
        record(entry, `${path}.triggers[${triggerIndex}]`),
    );
    summaries.push({
      id,
      version,
      activation_status: activationStatus,
      entry_step_ids: stringArray(
        workflow.entry_step_ids,
        `${path}.entry_step_ids`,
      ),
      trigger_kinds: uniqueSorted(
        triggers.map((trigger, triggerIndex) =>
          string(trigger.kind, `${path}.triggers[${triggerIndex}].kind`),
        ),
      ),
      trigger_events: uniqueSorted(
        triggers.flatMap((trigger) =>
          typeof trigger.event_id === "string" && trigger.event_id.trim()
            ? [trigger.event_id.trim()]
            : [],
        ),
      ),
      step_count: steps.length,
      step_kinds: countBy(stepKinds),
      execution_modes: countBy(executionModes),
      action_ids: uniqueSorted(actionIdsForWorkflow),
      agent_step_ids: uniqueSorted(agentStepIds),
      wait_step_ids: uniqueSorted(waitStepIds),
      child_workflows: childWorkflows.sort((left, right) =>
        `${left.step_id}\u0000${left.workflow_id}`.localeCompare(
          `${right.step_id}\u0000${right.workflow_id}`,
          "en",
        ),
      ),
    });
  }

  for (const contract of agentContracts) {
    const contractId = `${contract.id}@${contract.version}`;
    for (const grant of contract.grants) {
      if (!usedAgentGrants.has(`${contractId}\u0000${grant.action_id}`)) {
        fail(
          "unused-agent-grant",
          `$.manifest.extensions.agent_contracts(${contractId}).grants`,
          `${grant.action_id} is not used by an agent-mode step bound to ${contractId}`,
        );
      }
    }
  }

  const subscribedAgentBindings = new Set<string>();
  for (const contract of agentContracts) {
    const contractId = `${contract.id}@${contract.version}`;
    for (const [
      subscriptionIndex,
      subscriptionValue,
    ] of contract.subscriptions.entries()) {
      const subscriptionPath = `$.manifest.extensions.agent_contracts(${contractId}).subscriptions[${subscriptionIndex}]`;
      const subscription = record(subscriptionValue, subscriptionPath);
      const workflowId = string(
        subscription.workflow_id,
        `${subscriptionPath}.workflow_id`,
      );
      const sourceStepId = string(
        subscription.source_step_id,
        `${subscriptionPath}.source_step_id`,
      );
      const targetStepId = string(
        subscription.target_step_id,
        `${subscriptionPath}.target_step_id`,
      );
      const eventId = string(
        subscription.event_id,
        `${subscriptionPath}.event_id`,
      );
      const delivery = string(
        subscription.delivery,
        `${subscriptionPath}.delivery`,
      );
      const autonomousStart = boolean(
        subscription.autonomous_start,
        `${subscriptionPath}.autonomous_start`,
      );
      if (delivery !== "workflow_bound_fixture" || autonomousStart) {
        fail(
          "unsafe-agent-subscription",
          subscriptionPath,
          `${contractId} subscriptions must use delivery=workflow_bound_fixture and autonomous_start=false`,
        );
      }
      if (!eventIds.has(eventId)) {
        fail(
          "unknown-agent-subscription-event",
          `${subscriptionPath}.event_id`,
          eventId,
        );
      }
      const indexedWorkflow = workflowsById.get(workflowId);
      if (!indexedWorkflow) {
        fail(
          "unknown-agent-subscription-workflow",
          `${subscriptionPath}.workflow_id`,
          workflowId,
        );
      }
      const workflowPath = `$.artifacts.workflows[${indexedWorkflow.index}]`;
      const workflowSteps = array(
        indexedWorkflow.workflow.steps,
        `${workflowPath}.steps`,
      ).map((entry, index) => record(entry, `${workflowPath}.steps[${index}]`));
      const sourceStep = workflowSteps.find((step) => step.id === sourceStepId);
      const targetStep = workflowSteps.find((step) => step.id === targetStepId);
      if (!sourceStep || !targetStep) {
        fail(
          "unknown-agent-subscription-step",
          subscriptionPath,
          `${workflowId} must contain source ${sourceStepId} and target ${targetStepId}`,
        );
      }
      const targetExecution = record(
        targetStep.execution,
        `${workflowPath}.steps(${targetStepId}).execution`,
      );
      const targetExtensions = optionalExtensions(targetStep);
      if (
        targetExecution.mode !== "agent" ||
        targetExtensions.agent_contract_id !== contractId
      ) {
        fail(
          "agent-subscription-target-mismatch",
          `${subscriptionPath}.target_step_id`,
          `${workflowId}:${targetStepId} is not bound to ${contractId}`,
        );
      }
      const emittedEvents = array(
        indexedWorkflow.workflow.emitted_events ?? [],
        `${workflowPath}.emitted_events`,
      );
      const exactEmission = emittedEvents.some(
        (emissionValue, emissionIndex) => {
          const emission = record(
            emissionValue,
            `${workflowPath}.emitted_events[${emissionIndex}]`,
          );
          return (
            emission.source_step_id === sourceStepId &&
            emission.event_id === eventId
          );
        },
      );
      if (!exactEmission) {
        fail(
          "agent-subscription-emission-mismatch",
          subscriptionPath,
          `${workflowId}:${sourceStepId} does not emit ${eventId}`,
        );
      }
      subscribedAgentBindings.add(
        `${contractId}\u0000${workflowId}\u0000${targetStepId}`,
      );
    }
  }
  for (const binding of agentStepBindings) {
    if (!subscribedAgentBindings.has(binding)) {
      const [contractId, workflowId, stepId] = binding.split("\u0000");
      fail(
        "agent-step-subscription-missing",
        `$.artifacts.workflows(${workflowId}).steps(${stepId})`,
        `${contractId} has no non-autonomous workflow-bound subscription for ${workflowId}:${stepId}`,
      );
    }
  }

  return {
    summaries: summaries.sort((left, right) =>
      left.id.localeCompare(right.id, "en"),
    ),
    edges: edges.sort((left, right) =>
      `${left.parent_workflow_id}\u0000${left.step_id}`.localeCompare(
        `${right.parent_workflow_id}\u0000${right.step_id}`,
        "en",
      ),
    ),
  };
}

function productionActivationGate(
  manifest: JsonRecord,
): { status: string; evidence: string[] } | null {
  const acceptance = manifest.acceptance;
  if (!Array.isArray(acceptance)) return null;
  const gate = acceptance.find(
    (entry) =>
      isRecord(entry) &&
      entry.gate === "production-agentic-operator-activation",
  );
  if (!isRecord(gate)) return null;
  return {
    status: typeof gate.status === "string" ? gate.status : "unknown",
    evidence: Array.isArray(gate.evidence)
      ? gate.evidence.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  };
}

/**
 * Verify and classify one immutable OntoPlanet package for shadow inspection.
 * The returned receipt can never be passed to AO manifest import: it is a
 * different schema and carries `deployable:false` as a hash-covered field.
 */
export function admitOntologyPackageForShadow(
  value: unknown,
  options: OntologyPackageAdmissionOptions = {},
): OperatorShadowCandidate {
  const shippedSchemaBundleVersion = validateShippedPackageSchema(value);
  const root = record(value, "$");
  const manifest = record(root.manifest, "$.manifest");
  const artifactsRoot = record(root.artifacts, "$.artifacts");
  const packageId = string(manifest.package_id, "$.manifest.package_id");
  const release = string(manifest.release, "$.manifest.release");
  const schemaVersion = string(
    manifest.schema_version,
    "$.manifest.schema_version",
  );
  const schemaBundleVersion = string(
    manifest.schema_bundle_version,
    "$.manifest.schema_bundle_version",
  );
  if (schemaBundleVersion !== shippedSchemaBundleVersion) {
    fail(
      "schema-bundle-race",
      "$.manifest.schema_bundle_version",
      "changed during admission",
    );
  }
  const immutable = boolean(manifest.immutable, "$.manifest.immutable");
  if (!immutable)
    fail("mutable-package-forbidden", "$.manifest.immutable", "must be true");
  const packageHash = digest(manifest.package_hash, "$.manifest.package_hash");
  const supportedSchemaBundles =
    options.supportedSchemaBundles ??
    Object.keys(ONTOLOGY_PACKAGE_SCHEMA_CONTRACTS);
  if (!supportedSchemaBundles.includes(schemaBundleVersion)) {
    fail(
      "unsupported-schema-bundle",
      "$.manifest.schema_bundle_version",
      `${schemaBundleVersion}; supported: ${supportedSchemaBundles.join(", ")}`,
    );
  }
  if (release.includes("..")) {
    fail(
      "unsafe-package-release",
      "$.manifest.release",
      "must not contain a parent-directory segment",
    );
  }
  if (options.expectedPackageId && packageId !== options.expectedPackageId) {
    fail(
      "package-identity-mismatch",
      "$.manifest.package_id",
      `expected ${options.expectedPackageId}, received ${packageId}`,
    );
  }
  if (options.expectedRelease && release !== options.expectedRelease) {
    fail(
      "package-release-mismatch",
      "$.manifest.release",
      `expected ${options.expectedRelease}, received ${release}`,
    );
  }
  if (
    options.expectedPackageHash &&
    packageHash !== options.expectedPackageHash
  ) {
    fail(
      "package-pin-mismatch",
      "$.manifest.package_hash",
      `expected ${options.expectedPackageHash}, received ${packageHash}`,
    );
  }

  const families = record(manifest.families, "$.manifest.families");
  const artifacts = {} as Record<OntologyPackageFamily, JsonRecord[]>;
  const familyHashes = {} as Record<OntologyPackageFamily, Sha256Digest>;
  for (const family of ONTOLOGY_PACKAGE_FAMILIES) {
    const verified = validateFamily(
      family,
      families[family],
      artifactsRoot[family],
      shippedSchemaBundleVersion,
    );
    artifacts[family] = verified.artifacts;
    familyHashes[family] = verified.hash;
  }
  const coverage = validateCoverageCounts(manifest.coverage, artifacts);
  const actualPackageHash = hashOntologyPackageJson(
    ontologyPackageHashPayload(root),
  );
  if (packageHash !== actualPackageHash) {
    fail(
      "package-hash-mismatch",
      "$.manifest.package_hash",
      `declares ${packageHash}, actual ${actualPackageHash}`,
    );
  }

  const manifestExtensions = record(
    manifest.extensions,
    "$.manifest.extensions",
  );
  const classification = record(
    manifestExtensions.classification,
    "$.manifest.extensions.classification",
  );
  const domainId = string(
    classification.domain,
    "$.manifest.extensions.classification.domain",
  );
  const projectId =
    typeof classification.project === "string" && classification.project.trim()
      ? classification.project.trim()
      : null;
  const packageKind = string(
    manifestExtensions.package_kind,
    "$.manifest.extensions.package_kind",
  );
  const primaryWorkflowId = string(
    manifestExtensions.primary_workflow_id,
    "$.manifest.extensions.primary_workflow_id",
  );
  const actionIds = new Set(
    artifacts.actions.map((action) =>
      string(action.id, "$.artifacts.actions[].id"),
    ),
  );
  const eventIds = new Set(
    artifacts.events.map((event) =>
      string(event.name, "$.artifacts.events[].name"),
    ),
  );
  const actionBoundary = requireShadowActionBoundary(artifacts.actions);
  const agentContracts = summarizeAgentContracts(
    manifestExtensions,
    actionBoundary.actionContracts,
  );
  const workflowResult = summarizeWorkflows(
    artifacts.workflows,
    actionIds,
    eventIds,
    agentContracts,
  );
  const workflowIds = workflowResult.summaries.map((workflow) => workflow.id);
  if (!workflowIds.includes(primaryWorkflowId)) {
    fail(
      "unknown-primary-workflow",
      "$.manifest.extensions.primary_workflow_id",
      primaryWorkflowId,
    );
  }

  const workflowSteps = workflowResult.summaries.reduce(
    (sum, workflow) => sum + workflow.step_count,
    0,
  );
  const declaredWorkflowSteps = integer(
    coverage.workflow_steps,
    "$.manifest.coverage.workflow_steps",
  );
  if (declaredWorkflowSteps !== workflowSteps) {
    fail(
      "coverage-workflow-step-mismatch",
      "$.manifest.coverage.workflow_steps",
      `declares ${declaredWorkflowSteps}, actual ${workflowSteps}`,
    );
  }
  const agentStepCount = workflowResult.summaries.reduce(
    (sum, workflow) => sum + workflow.agent_step_ids.length,
    0,
  );
  const waitStepCount = workflowResult.summaries.reduce(
    (sum, workflow) => sum + workflow.wait_step_ids.length,
    0,
  );
  const humanStepCount = workflowResult.summaries.reduce(
    (sum, workflow) => sum + (workflow.execution_modes.human ?? 0),
    0,
  );
  const activationGate = productionActivationGate(manifest);
  const disabledSubflowEnforcement = workflowResult.edges.filter(
    (edge) => !edge.runtime_enforcement,
  );
  const notActivatedWorkflows = workflowResult.summaries.filter(
    (workflow) => workflow.activation_status !== "activated",
  );
  const activationBlockers: OperatorShadowCandidate["admission"]["activation_blockers"] =
    [
      {
        code: "actions-not-runtime-bound",
        count: artifacts.actions.length,
        evidence: [
          "every Action is hash-verified with implementation.executable=false",
        ],
      },
      {
        code: "workflows-not-activated",
        count: notActivatedWorkflows.length,
        evidence: uniqueSorted(
          notActivatedWorkflows.map(
            (workflow) =>
              `${workflow.id}@${workflow.version}:${workflow.activation_status}`,
          ),
        ),
      },
      {
        code: "agent-contracts-not-deployed",
        count: agentContracts.length,
        evidence: agentContracts.map(
          (contract) =>
            `${contract.id}@${contract.version}:${contract.activation_status}/${contract.deployment_status}/${contract.runtime_scope}`,
        ),
      },
      {
        code: "subflow-runtime-enforcement-disabled",
        count: disabledSubflowEnforcement.length,
        evidence: disabledSubflowEnforcement.map(
          (edge) =>
            `${edge.parent_workflow_id}@${edge.parent_workflow_version}:${edge.step_id}->${edge.child_workflow_id}@${edge.child_workflow_version}`,
        ),
      },
      {
        code: "production-agentic-operator-activation-not-passed",
        count: activationGate?.status === "passed" ? 0 : 1,
        evidence: activationGate
          ? [`status=${activationGate.status}`, ...activationGate.evidence]
          : [
              "package has no production-agentic-operator-activation acceptance gate",
            ],
      },
    ];

  const candidateWithoutHash: Omit<OperatorShadowCandidate, "receipt_hash"> = {
    schema: ONTOLOGY_PACKAGE_SHADOW_CANDIDATE_SCHEMA,
    source_package: {
      package_id: packageId,
      release,
      package_hash: packageHash,
      schema_version: schemaVersion,
      schema_bundle_version: schemaBundleVersion,
      immutable: true,
      domain_id: domainId,
      project_id: projectId,
      package_kind: packageKind,
      primary_workflow_id: primaryWorkflowId,
    },
    admission: {
      status: "verified_shadow_candidate",
      deployable: false,
      runtime_import_allowed: false,
      runtime_scope: "candidate_shadow_fixture_only",
      checks: [
        {
          id: "vendored-ontology-package-schema",
          status: "passed",
          evidence: [
            `${schemaBundleVersion}:bundle_sha256=${ONTOLOGY_PACKAGE_SCHEMA_CONTRACTS[shippedSchemaBundleVersion].bundleSha256}`,
            "Ajv 2020 envelope, manifest and six-family schemas validated",
          ],
        },
        {
          id: "immutable-package-digest",
          status: "passed",
          evidence: [packageHash],
        },
        {
          id: "six-family-integrity",
          status: "passed",
          evidence: ONTOLOGY_PACKAGE_FAMILIES.map(
            (family) =>
              `${family}:${artifacts[family].length}:${familyHashes[family]}`,
          ),
        },
        {
          id: "workflow-reference-and-version-pin-integrity",
          status: "passed",
          evidence: [
            `${workflowResult.summaries.length} workflows`,
            `${workflowSteps} steps`,
            `${workflowResult.edges.length} child workflow edges`,
          ],
        },
        {
          id: "shadow-capability-boundary",
          status: "passed",
          evidence: [
            "0 executable Actions",
            "0 executable external Actions",
            `${agentContracts.length} inactive candidate Agent contract(s)`,
            "Agent grants are human-approved proposal-only, target Agent-authored Actions with no external/tool capabilities, notifications, or data changes, and form a bidirectional closure with agent-mode steps",
            "Agent subscriptions are non-autonomous workflow-bound fixtures with exact source emissions and target bindings",
          ],
        },
      ],
      activation_blockers: activationBlockers,
    },
    artifact_counts: {
      objects: artifacts.objects.length,
      rules: artifacts.rules.length,
      actions: artifacts.actions.length,
      events: artifacts.events.length,
      links: artifacts.links.length,
      workflows: artifacts.workflows.length,
      workflow_steps: workflowSteps,
    },
    family_hashes: familyHashes,
    capabilities: {
      action_count: artifacts.actions.length,
      internal_action_count: actionBoundary.internal,
      external_action_count: actionBoundary.external,
      executable_action_count: 0,
      executable_external_action_count: 0,
      agent_step_count: agentStepCount,
      human_step_count: humanStepCount,
      wait_step_count: waitStepCount,
      subflow_step_count: workflowResult.edges.length,
    },
    workflows: workflowResult.summaries,
    workflow_graph: {
      primary_workflow_id: primaryWorkflowId,
      workflow_ids: uniqueSorted(workflowIds),
      child_edges: workflowResult.edges,
    },
    agent_contracts: agentContracts,
  };
  return {
    ...candidateWithoutHash,
    receipt_hash: hashOntologyPackageJson(candidateWithoutHash),
  };
}

export function loadOntologyPackageForShadow(
  packagePath: string,
  options: OntologyPackageAdmissionOptions = {},
): OperatorShadowCandidate {
  let raw: string;
  try {
    raw = readFileSync(packagePath, "utf8");
  } catch (error) {
    fail("package-read-failed", packagePath, (error as Error).message);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail("package-json-invalid", packagePath, (error as Error).message);
  }
  return admitOntologyPackageForShadow(value, options);
}
