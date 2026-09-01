/**
 * Immutable Ontology Package -> non-deployable Agentic Operator runtime plan.
 *
 * This is deliberately a planning contract, not a WorkflowManifest. It proves
 * that the package graph and authored bindings were preserved, identifies the
 * runtime guarantees that still need implementations, and cannot be imported
 * by the existing runtime/bootstrap paths.
 */

import { readFileSync } from "node:fs";
import {
  admitOntologyPackageForShadow,
  hashOntologyPackageJson,
  type OntologyPackageAdmissionOptions,
  type OperatorShadowCandidate,
  type Sha256Digest,
} from "./package-admission.ts";

export const ONTOLOGY_PACKAGE_RUNTIME_PLAN_SCHEMA =
  "agentic-operator.ontology-package-runtime-plan-candidate/v1" as const;

type JsonRecord = Record<string, unknown>;

export interface OperatorRuntimePlanBlocker {
  code: string;
  count: number;
  evidence: string[];
}

export interface OperatorRuntimePlanAction {
  id: string;
  source_pointer: string;
  source_hash: Sha256Digest;
  actors: string[];
  implementation_kind: string;
  executable: false;
  effective_executable: false;
  runtime_binding_status: "unbound";
  used_by: Array<{ workflow_id: string; step_id: string }>;
  blocker_codes: string[];
}

export interface OperatorRuntimePlanAgent {
  id: string;
  version: string;
  source_pointer: string;
  contract_hash: Sha256Digest;
  prompt_profile: {
    id: string;
    version: string;
    content_hash: Sha256Digest;
  };
  activation_status: "specified_not_activated";
  deployment_status: "not_deployed";
  runtime_scope: "candidate_shadow_fixture_only";
  granted_action_ids: string[];
  subscription_count: number;
  subscription_contract_hash: Sha256Digest;
  eval_case_count: number;
  eval_contract_hash: Sha256Digest;
  eval_status: "declared_not_run";
  runtime_binding_status: "unbound";
  blocker_codes: string[];
}

export interface OperatorRuntimePlanStep {
  id: string;
  order: number;
  source_pointer: string;
  source_hash: Sha256Digest;
  node_kind: string;
  execution_mode: string;
  actor_ids: string[];
  input_artifact_ids: string[];
  output_artifact_ids: string[];
  guard_rule_ids: string[];
  action_id: string | null;
  action_hash: Sha256Digest | null;
  action_io_binding: {
    status: "verified" | "missing";
    id: string | null;
    source_hash: Sha256Digest | null;
  };
  child_workflow: {
    id: string;
    version: string;
    source_hash: Sha256Digest;
    artifact_binding_hash: Sha256Digest;
    runtime_enforcement: boolean;
    contract_status: "verified" | "missing";
    invocation_mode: string | null;
    failure_policy: string | null;
    timeout_policy: string | null;
    active_execution_timeout_ms: number | null;
    parent_checkpoint_required_on_child_pause: boolean | null;
    parent_context_artifact_id: string | null;
    case_key_path: string | null;
    input_resolution: Array<{
      child_artifact_id: string;
      object_type_id: string;
      required: boolean;
      resolver: string;
      pin_paths: string[];
      source_hash: Sha256Digest;
    }>;
    output_merge: {
      child_output_contract_id: string;
      child_output_contract_hash: Sha256Digest;
      parent_artifact_id: string;
      merge_policy: string;
      target_object_id: string;
      target_property: string;
      target_property_contract_hash: Sha256Digest;
    } | null;
  } | null;
  next: Array<{
    id: string;
    to_step_id: string;
    edge_type: string;
    label: string | null;
    transition: string | null;
    is_default: boolean;
    condition_hash: Sha256Digest | null;
    source_hash: Sha256Digest;
  }>;
  wait_contract: {
    timeout_ms: number | null;
    clock_source: string | null;
    deadline_property: string | null;
    wake_transitions: string[];
    wake_event_binding_status: "unbound";
  } | null;
  runtime_status: "blocked";
  blocker_codes: string[];
}

export interface OperatorRuntimePlanWorkflow {
  id: string;
  version: string;
  source_pointer: string;
  source_hash: Sha256Digest;
  activation_status: string;
  role_ids: string[];
  entry_step_ids: string[];
  trigger_kinds: string[];
  step_ids: string[];
  steps: OperatorRuntimePlanStep[];
}

export interface OperatorRuntimePlanCandidate {
  schema: typeof ONTOLOGY_PACKAGE_RUNTIME_PLAN_SCHEMA;
  source: {
    package_id: string;
    release: string;
    package_hash: Sha256Digest;
    admission_receipt_hash: Sha256Digest;
    schema_bundle_version: string;
    family_hashes: OperatorShadowCandidate["family_hashes"];
    domain_id: string;
    primary_workflow_id: string;
  };
  status: {
    phase: "runtime_contract_planning";
    deployable: false;
    runtime_import_allowed: false;
    execution_manifest_generated: false;
    trusted_production_authorization_present: false;
    external_dispatch: "forbidden";
  };
  membership: {
    workflow_count: number;
    action_count: number;
    agent_count: number;
    step_count: number;
    child_edge_count: number;
    workflow_ids: string[];
    action_ids: string[];
    agent_ids: string[];
    workflow_membership_hash: Sha256Digest;
    action_membership_hash: Sha256Digest;
    agent_membership_hash: Sha256Digest;
    step_membership_hash: Sha256Digest;
  };
  coverage: {
    step_kinds: Record<string, number>;
    execution_modes: Record<string, number>;
    human_gate_count: number;
    condition_count: number;
    condition_test_count: number;
    default_edge_count: number;
    workflow_artifact_count: number;
    output_contract_count: number;
    artifact_equality_constraint_count: number;
    emitted_event_count: number;
  };
  verification: {
    admission_recomputed: true;
    workflow_graph_references_closed: true;
    workflow_versions_pinned: true;
    source_contract_hashes_recorded: true;
    workflow_contract_membership_verified: boolean;
    action_io_bindings_verified: number;
    action_io_bindings_missing: number;
    subflow_contracts_verified: number;
    subflow_contracts_missing: number;
  };
  actions: OperatorRuntimePlanAction[];
  agent_contracts: OperatorRuntimePlanAgent[];
  workflows: OperatorRuntimePlanWorkflow[];
  activation_blockers: OperatorRuntimePlanBlocker[];
  plan_hash: Sha256Digest;
}

export class OntologyRuntimePlanError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, detail: string) {
    super(`[ontology-runtime-plan:${code}] ${path}: ${detail}`);
    this.name = "OntologyRuntimePlanError";
    this.code = code;
    this.path = path;
  }
}

function fail(code: string, path: string, detail: string): never {
  throw new OntologyRuntimePlanError(code, path, detail);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) fail("record-required", path, "expected an object");
  return value;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail("array-required", path, "expected an array");
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail("string-required", path, "expected a non-empty string");
  }
  return value.trim();
}

function integer(value: unknown, path: string): number {
  if (!Number.isInteger(value))
    fail("integer-required", path, "expected an integer");
  return value as number;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean")
    fail("boolean-required", path, "expected a boolean");
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  return array(value, path).map((entry, index) =>
    string(entry, `${path}[${index}]`),
  );
}

function optionalStringArray(value: unknown, path: string): string[] {
  return value === undefined ? [] : stringArray(value, path);
}

function optionalRecord(value: unknown, path: string): JsonRecord {
  return value === undefined ? {} : record(value, path);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sorted(values: readonly string[]): string[] {
  return unique(values).sort((left, right) => left.localeCompare(right, "en"));
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

class BlockerCollector {
  readonly #entries = new Map<
    string,
    { evidence: Set<string>; declaredCount?: number }
  >();

  add(code: string, evidence: string): void {
    const entry = this.#entries.get(code) ?? { evidence: new Set<string>() };
    entry.evidence.add(evidence);
    this.#entries.set(code, entry);
  }

  addReceipt(receipt: OperatorShadowCandidate): void {
    for (const blocker of receipt.admission.activation_blockers) {
      const entry = this.#entries.get(blocker.code) ?? {
        evidence: new Set<string>(),
      };
      for (const evidence of blocker.evidence) entry.evidence.add(evidence);
      entry.declaredCount = blocker.count;
      this.#entries.set(blocker.code, entry);
    }
  }

  list(): OperatorRuntimePlanBlocker[] {
    return [...this.#entries.entries()]
      .map(([code, entry]) => ({
        code,
        count: entry.declaredCount ?? entry.evidence.size,
        evidence: [...entry.evidence].sort((left, right) =>
          left.localeCompare(right, "en"),
        ),
      }))
      .sort((left, right) => left.code.localeCompare(right.code, "en"));
  }
}

function artifactMap(
  workflow: JsonRecord,
  path: string,
): Map<string, JsonRecord> {
  const out = new Map<string, JsonRecord>();
  for (const [index, value] of array(
    workflow.artifacts ?? [],
    `${path}.artifacts`,
  ).entries()) {
    const artifactPath = `${path}.artifacts[${index}]`;
    const artifact = record(value, artifactPath);
    const id = string(artifact.id, `${artifactPath}.id`);
    if (out.has(id))
      fail("duplicate-workflow-artifact", `${artifactPath}.id`, id);
    out.set(id, artifact);
  }
  return out;
}

function artifactFormats(
  workflow: JsonRecord,
  path: string,
  artifacts: ReadonlyMap<string, JsonRecord>,
): Map<string, ReadonlySet<string>> {
  const formats = new Map<string, Set<string>>();
  for (const [artifactId, artifact] of artifacts) {
    formats.set(
      artifactId,
      new Set([
        string(artifact.format, `${path}.artifacts(${artifactId}).format`),
      ]),
    );
  }
  for (const [index, value] of array(
    workflow.output_contracts ?? [],
    `${path}.output_contracts`,
  ).entries()) {
    const contractPath = `${path}.output_contracts[${index}]`;
    const contract = record(value, contractPath);
    const artifactId = string(
      contract.artifact_id,
      `${contractPath}.artifact_id`,
    );
    const accepted = formats.get(artifactId);
    if (!accepted) {
      fail(
        "unknown-output-contract-artifact",
        `${contractPath}.artifact_id`,
        artifactId,
      );
    }
    accepted.add(string(contract.format, `${contractPath}.format`));
  }
  return formats;
}

type RuntimeSubflowContract = Pick<
  NonNullable<OperatorRuntimePlanStep["child_workflow"]>,
  | "contract_status"
  | "invocation_mode"
  | "failure_policy"
  | "timeout_policy"
  | "active_execution_timeout_ms"
  | "parent_checkpoint_required_on_child_pause"
  | "parent_context_artifact_id"
  | "case_key_path"
  | "input_resolution"
  | "output_merge"
>;

function validateContextPatchOutputContract(
  contract: JsonRecord,
  contractPath: string,
  childArtifacts: ReadonlyMap<string, JsonRecord>,
  objectsById: ReadonlyMap<string, JsonRecord>,
  childWorkflow: JsonRecord,
  childPath: string,
): {
  targetObjectId: string;
  targetPropertyName: string;
  targetPropertyHash: Sha256Digest;
  parentTargetArtifactId: string;
} {
  if (contract.format !== "application/vnd.allmeta.context-patch+json") {
    fail(
      "unsupported-subflow-output-contract-format",
      `${contractPath}.format`,
      String(contract.format),
    );
  }
  const artifactId = string(
    contract.artifact_id,
    `${contractPath}.artifact_id`,
  );
  const artifact = childArtifacts.get(artifactId);
  if (!artifact) {
    fail(
      "unknown-output-contract-artifact",
      `${contractPath}.artifact_id`,
      artifactId,
    );
  }
  if (artifact.direction !== "output") {
    fail(
      "subflow-output-contract-artifact-not-output",
      `${contractPath}.artifact_id`,
      artifactId,
    );
  }
  const schema = record(
    contract.content_schema,
    `${contractPath}.content_schema`,
  );
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    fail(
      "unsafe-context-patch-schema",
      `${contractPath}.content_schema`,
      "must be a closed object schema",
    );
  }
  const requiredFields = sorted(
    stringArray(schema.required, `${contractPath}.content_schema.required`),
  );
  const expectedFields = [
    "source_evidence_hash",
    "target_object",
    "target_property",
    "value",
  ];
  const properties = record(
    schema.properties,
    `${contractPath}.content_schema.properties`,
  );
  if (
    !sameStrings(requiredFields, expectedFields) ||
    !sameStrings(sorted(Object.keys(properties)), expectedFields)
  ) {
    fail(
      "unsafe-context-patch-schema",
      `${contractPath}.content_schema`,
      "must contain exactly the four required context-patch fields",
    );
  }
  const targetObject = record(
    properties.target_object,
    `${contractPath}.content_schema.properties.target_object`,
  );
  const targetProperty = record(
    properties.target_property,
    `${contractPath}.content_schema.properties.target_property`,
  );
  const value = record(
    properties.value,
    `${contractPath}.content_schema.properties.value`,
  );
  const sourceEvidenceHash = record(
    properties.source_evidence_hash,
    `${contractPath}.content_schema.properties.source_evidence_hash`,
  );
  const targetObjectId = string(
    targetObject.const,
    `${contractPath}.content_schema.properties.target_object.const`,
  );
  const targetPropertyName = string(
    targetProperty.const,
    `${contractPath}.content_schema.properties.target_property.const`,
  );
  const patchValues = stringArray(
    value.enum,
    `${contractPath}.content_schema.properties.value.enum`,
  );
  if (
    targetObjectId !== artifact.object_type_id ||
    patchValues.length === 0 ||
    sourceEvidenceHash.type !== "string" ||
    sourceEvidenceHash.pattern !== "^sha256:[a-f0-9]{64}$"
  ) {
    fail(
      "unsafe-context-patch-schema",
      `${contractPath}.content_schema.properties`,
      "target, enum, or evidence hash contract is not fail-closed",
    );
  }
  const stepsById = new Map(
    array(childWorkflow.steps, `${childPath}.steps`).map((stepValue, index) => {
      const stepPath = `${childPath}.steps[${index}]`;
      const step = record(stepValue, stepPath);
      return [string(step.id, `${stepPath}.id`), { step, stepPath }] as const;
    }),
  );
  const sourceStepIds = stringArray(
    contract.source_step_ids,
    `${contractPath}.source_step_ids`,
  );
  if (
    sourceStepIds.length === 0 ||
    new Set(sourceStepIds).size !== sourceStepIds.length
  ) {
    fail(
      "invalid-context-patch-producer-set",
      `${contractPath}.source_step_ids`,
      "must contain unique producer steps",
    );
  }
  for (const sourceStepId of sourceStepIds) {
    const producer = stepsById.get(sourceStepId);
    if (!producer) {
      fail(
        "unknown-output-contract-source-step",
        `${contractPath}.source_step_ids`,
        sourceStepId,
      );
    }
    const outputIds = optionalStringArray(
      producer.step.output_artifact_ids,
      `${producer.stepPath}.output_artifact_ids`,
    );
    if (!outputIds.includes(artifactId)) {
      fail(
        "context-patch-artifact-not-produced-by-source-step",
        producer.stepPath,
        `${sourceStepId} does not output ${artifactId}`,
      );
    }
  }
  const parseOutcomeMap = (
    outcomeValues: unknown,
    outcomePath: string,
  ): Map<string, string[]> => {
    const outcomes = new Map<string, string[]>();
    for (const [index, outcomeValue] of array(
      outcomeValues,
      outcomePath,
    ).entries()) {
      const itemPath = `${outcomePath}[${index}]`;
      const item = record(outcomeValue, itemPath);
      const sourceStepId = string(
        item.source_step_id,
        `${itemPath}.source_step_id`,
      );
      const values = stringArray(item.values, `${itemPath}.values`);
      if (
        outcomes.has(sourceStepId) ||
        values.length === 0 ||
        new Set(values).size !== values.length ||
        values.some((entry) => !patchValues.includes(entry))
      ) {
        fail("invalid-context-patch-producer-outcome", itemPath, sourceStepId);
      }
      outcomes.set(sourceStepId, values);
    }
    if (!sameStrings(sorted([...outcomes.keys()]), sorted(sourceStepIds))) {
      fail(
        "context-patch-producer-set-mismatch",
        outcomePath,
        "producer outcome steps must equal source_step_ids",
      );
    }
    return outcomes;
  };
  const terminalOutcomes = parseOutcomeMap(
    contract.terminal_outcome_mapping,
    `${contractPath}.terminal_outcome_mapping`,
  );
  const contextPatchExtensions = record(
    schema["x-allmeta-context-patch"],
    `${contractPath}.content_schema.x-allmeta-context-patch`,
  );
  const producerOutcomes = parseOutcomeMap(
    contextPatchExtensions.producer_outcomes,
    `${contractPath}.content_schema.x-allmeta-context-patch.producer_outcomes`,
  );
  for (const sourceStepId of sourceStepIds) {
    if (
      !sameStrings(
        sorted(terminalOutcomes.get(sourceStepId)!),
        sorted(producerOutcomes.get(sourceStepId)!),
      )
    ) {
      fail(
        "context-patch-producer-outcome-mismatch",
        contractPath,
        sourceStepId,
      );
    }
  }
  const mappedValues = sorted([...terminalOutcomes.values()].flat());
  if (!sameStrings(mappedValues, sorted(patchValues))) {
    fail(
      "context-patch-outcome-enum-coverage-mismatch",
      `${contractPath}.terminal_outcome_mapping`,
      "producer outcome union must equal the patch enum",
    );
  }
  const targetObjectType = objectsById.get(targetObjectId);
  if (!targetObjectType) {
    fail(
      "unknown-context-patch-target-object",
      `${contractPath}.content_schema.properties.target_object.const`,
      targetObjectId,
    );
  }
  const targetProperties = array(
    targetObjectType.properties,
    `$.artifacts.objects(${targetObjectId}).properties`,
  ).flatMap((propertyValue, index) => {
    const propertyPath = `$.artifacts.objects(${targetObjectId}).properties[${index}]`;
    const property = record(propertyValue, propertyPath);
    return property.name === targetPropertyName
      ? [{ property, propertyPath }]
      : [];
  });
  if (targetProperties.length !== 1) {
    fail(
      "context-patch-target-property-resolution-failed",
      `${contractPath}.content_schema.properties.target_property.const`,
      `${targetObjectId}.${targetPropertyName} resolved ${targetProperties.length} properties`,
    );
  }
  const targetPropertyContract = targetProperties[0]!.property;
  const targetEnumValues = stringArray(
    targetPropertyContract.enum_values,
    `${targetProperties[0]!.propertyPath}.enum_values`,
  );
  if (
    targetPropertyContract.type !== "Enum" ||
    new Set(patchValues).size !== patchValues.length ||
    new Set(targetEnumValues).size !== targetEnumValues.length ||
    patchValues.some((entry) => !targetEnumValues.includes(entry))
  ) {
    fail(
      "context-patch-target-enum-mismatch",
      `${contractPath}.content_schema.properties.value.enum`,
      `${targetObjectId}.${targetPropertyName}`,
    );
  }
  return {
    targetObjectId,
    targetPropertyName,
    targetPropertyHash: hashOntologyPackageJson(targetPropertyContract),
    parentTargetArtifactId: string(
      contextPatchExtensions.target_artifact_id,
      `${contractPath}.content_schema.x-allmeta-context-patch.target_artifact_id`,
    ),
  };
}

function resolveSubflowContract(input: {
  stepExtensions: JsonRecord;
  stepPath: string;
  stepInputArtifactIds: readonly string[];
  bindings: JsonRecord;
  parentArtifacts: ReadonlyMap<string, JsonRecord>;
  objectsById: ReadonlyMap<string, JsonRecord>;
  childWorkflow: JsonRecord;
  childPath: string;
}): RuntimeSubflowContract {
  const requiredBindingFields = [
    "parent_context_artifact_id",
    "case_key_path",
    "input_resolution",
    "output_merge",
  ];
  const requiredStepFields = [
    "invocation_mode",
    "failure_policy",
    "timeout_policy",
    "timeout_semantics",
  ];
  if (
    requiredBindingFields.some(
      (field) => input.bindings[field] === undefined,
    ) ||
    requiredStepFields.some(
      (field) => input.stepExtensions[field] === undefined,
    )
  ) {
    return {
      contract_status: "missing",
      invocation_mode: null,
      failure_policy: null,
      timeout_policy: null,
      active_execution_timeout_ms: null,
      parent_checkpoint_required_on_child_pause: null,
      parent_context_artifact_id: null,
      case_key_path: null,
      input_resolution: [],
      output_merge: null,
    };
  }

  const parentContextArtifactId = string(
    input.bindings.parent_context_artifact_id,
    `${input.stepPath}.extensions.artifact_bindings.parent_context_artifact_id`,
  );
  const parentContextArtifact = input.parentArtifacts.get(
    parentContextArtifactId,
  );
  if (!parentContextArtifact) {
    fail(
      "unknown-parent-context-artifact",
      `${input.stepPath}.extensions.artifact_bindings.parent_context_artifact_id`,
      parentContextArtifactId,
    );
  }
  if (!input.stepInputArtifactIds.includes(parentContextArtifactId)) {
    fail(
      "parent-context-artifact-not-step-input",
      `${input.stepPath}.input_artifact_ids`,
      parentContextArtifactId,
    );
  }
  const childArtifacts = artifactMap(input.childWorkflow, input.childPath);
  const seenChildInputs = new Set<string>();
  const inputResolution = array(
    input.bindings.input_resolution,
    `${input.stepPath}.extensions.artifact_bindings.input_resolution`,
  ).map((value, index) => {
    const resolutionPath = `${input.stepPath}.extensions.artifact_bindings.input_resolution[${index}]`;
    const resolution = record(value, resolutionPath);
    const childArtifactId = string(
      resolution.child_artifact_id,
      `${resolutionPath}.child_artifact_id`,
    );
    if (seenChildInputs.has(childArtifactId)) {
      fail("duplicate-subflow-input-binding", resolutionPath, childArtifactId);
    }
    seenChildInputs.add(childArtifactId);
    const childArtifact = childArtifacts.get(childArtifactId);
    if (!childArtifact) {
      fail("unknown-child-input-artifact", resolutionPath, childArtifactId);
    }
    const objectTypeId = string(
      resolution.object_type_id,
      `${resolutionPath}.object_type_id`,
    );
    const required = boolean(resolution.required, `${resolutionPath}.required`);
    if (
      childArtifact.object_type_id !== objectTypeId ||
      childArtifact.required !== required ||
      childArtifact.direction !== "input"
    ) {
      fail(
        "subflow-input-artifact-contract-mismatch",
        resolutionPath,
        childArtifactId,
      );
    }
    return {
      child_artifact_id: childArtifactId,
      object_type_id: objectTypeId,
      required,
      resolver: string(resolution.resolver, `${resolutionPath}.resolver`),
      pin_paths: optionalStringArray(
        resolution.pin_paths,
        `${resolutionPath}.pin_paths`,
      ),
      source_hash: hashOntologyPackageJson(resolution),
    };
  });
  const requiredChildInputIds = sorted(
    [...childArtifacts.entries()].flatMap(([artifactId, artifact]) =>
      artifact.direction === "input" && artifact.required === true
        ? [artifactId]
        : [],
    ),
  );
  const resolvedRequiredChildInputIds = sorted(
    inputResolution.flatMap((resolution) =>
      resolution.required ? [resolution.child_artifact_id] : [],
    ),
  );
  if (!sameStrings(requiredChildInputIds, resolvedRequiredChildInputIds)) {
    fail(
      "required-child-input-binding-mismatch",
      `${input.stepPath}.extensions.artifact_bindings.input_resolution`,
      `required child inputs [${requiredChildInputIds.join(", ")}] != resolved required inputs [${resolvedRequiredChildInputIds.join(", ")}]`,
    );
  }

  const outputMergePath = `${input.stepPath}.extensions.artifact_bindings.output_merge`;
  const outputMerge = record(input.bindings.output_merge, outputMergePath);
  const childOutputContractId = string(
    outputMerge.child_output_contract_id,
    `${outputMergePath}.child_output_contract_id`,
  );
  const childOutputContracts = array(
    input.childWorkflow.output_contracts ?? [],
    `${input.childPath}.output_contracts`,
  ).flatMap((value, index) => {
    const contractPath = `${input.childPath}.output_contracts[${index}]`;
    const contract = record(value, contractPath);
    return contract.id === childOutputContractId
      ? [{ contract, contractPath }]
      : [];
  });
  if (childOutputContracts.length !== 1) {
    fail(
      "subflow-output-contract-resolution-failed",
      `${outputMergePath}.child_output_contract_id`,
      `${childOutputContractId} resolved ${childOutputContracts.length} contracts`,
    );
  }
  const childOutput = childOutputContracts[0]!;
  const contextPatchTarget = validateContextPatchOutputContract(
    childOutput.contract,
    childOutput.contractPath,
    childArtifacts,
    input.objectsById,
    input.childWorkflow,
    input.childPath,
  );
  const parentArtifactId = string(
    outputMerge.parent_artifact_id,
    `${outputMergePath}.parent_artifact_id`,
  );
  if (!input.parentArtifacts.has(parentArtifactId)) {
    fail(
      "unknown-parent-merge-artifact",
      `${outputMergePath}.parent_artifact_id`,
      parentArtifactId,
    );
  }
  if (parentArtifactId !== parentContextArtifactId) {
    fail(
      "parent-context-merge-artifact-mismatch",
      outputMergePath,
      `${parentArtifactId} != ${parentContextArtifactId}`,
    );
  }
  if (contextPatchTarget.parentTargetArtifactId !== parentArtifactId) {
    fail(
      "context-patch-parent-target-artifact-mismatch",
      childOutput.contractPath,
      `${contextPatchTarget.parentTargetArtifactId} != ${parentArtifactId}`,
    );
  }
  const parentContextObjectTypeId = string(
    parentContextArtifact.object_type_id,
    `${input.stepPath}.extensions.artifact_bindings.parent_context_artifact_id`,
  );
  if (parentContextObjectTypeId !== contextPatchTarget.targetObjectId) {
    fail(
      "context-patch-parent-object-type-mismatch",
      `${input.stepPath}.extensions.artifact_bindings.parent_context_artifact_id`,
      `${parentContextObjectTypeId} != ${contextPatchTarget.targetObjectId}`,
    );
  }
  const timeout = record(
    input.stepExtensions.timeout_semantics,
    `${input.stepPath}.extensions.timeout_semantics`,
  );
  const activeExecutionTimeoutMs = integer(
    timeout.active_execution_timeout_ms,
    `${input.stepPath}.extensions.timeout_semantics.active_execution_timeout_ms`,
  );
  if (activeExecutionTimeoutMs <= 0) {
    fail(
      "invalid-active-execution-timeout",
      `${input.stepPath}.extensions.timeout_semantics.active_execution_timeout_ms`,
      String(activeExecutionTimeoutMs),
    );
  }
  const invocationMode = string(
    input.stepExtensions.invocation_mode,
    `${input.stepPath}.extensions.invocation_mode`,
  );
  if (
    invocationMode !== "synchronous_active_segment_with_durable_child_resume"
  ) {
    fail(
      "unsupported-subflow-invocation-mode",
      `${input.stepPath}.extensions.invocation_mode`,
      invocationMode,
    );
  }
  const parentCheckpointRequired = boolean(
    timeout.parent_checkpoint_required_on_child_pause,
    `${input.stepPath}.extensions.timeout_semantics.parent_checkpoint_required_on_child_pause`,
  );
  const excludesPausedTime = boolean(
    timeout.excludes_child_human_and_wait_pauses,
    `${input.stepPath}.extensions.timeout_semantics.excludes_child_human_and_wait_pauses`,
  );
  const enforcementRequired = boolean(
    timeout.runtime_enforcement_required_before_activation,
    `${input.stepPath}.extensions.timeout_semantics.runtime_enforcement_required_before_activation`,
  );
  if (
    timeout.kind !== "active_execution_only" ||
    !parentCheckpointRequired ||
    !excludesPausedTime ||
    !enforcementRequired
  ) {
    fail(
      "unsafe-subflow-timeout-semantics",
      `${input.stepPath}.extensions.timeout_semantics`,
      "must require active-time timeout, durable parent checkpoint, pause exclusion, and pre-activation enforcement",
    );
  }
  return {
    contract_status: "verified",
    invocation_mode: invocationMode,
    failure_policy: string(
      input.stepExtensions.failure_policy,
      `${input.stepPath}.extensions.failure_policy`,
    ),
    timeout_policy: string(
      input.stepExtensions.timeout_policy,
      `${input.stepPath}.extensions.timeout_policy`,
    ),
    active_execution_timeout_ms: activeExecutionTimeoutMs,
    parent_checkpoint_required_on_child_pause: parentCheckpointRequired,
    parent_context_artifact_id: parentContextArtifactId,
    case_key_path: string(
      input.bindings.case_key_path,
      `${input.stepPath}.extensions.artifact_bindings.case_key_path`,
    ),
    input_resolution: inputResolution,
    output_merge: {
      child_output_contract_id: childOutputContractId,
      child_output_contract_hash: hashOntologyPackageJson(childOutput.contract),
      parent_artifact_id: parentArtifactId,
      merge_policy: string(
        outputMerge.merge_policy,
        `${outputMergePath}.merge_policy`,
      ),
      target_object_id: contextPatchTarget.targetObjectId,
      target_property: contextPatchTarget.targetPropertyName,
      target_property_contract_hash: contextPatchTarget.targetPropertyHash,
    },
  };
}

function validateBindingItem(
  value: unknown,
  path: string,
  actionPorts: ReadonlyMap<string, JsonRecord>,
  workflowArtifacts: ReadonlyMap<string, JsonRecord>,
  workflowArtifactFormats: ReadonlyMap<string, ReadonlySet<string>>,
): string {
  const item = record(value, path);
  const actionIoName = string(item.action_io_name, `${path}.action_io_name`);
  const artifactId = string(item.artifact_id, `${path}.artifact_id`);
  const format = string(item.format, `${path}.format`);
  const objectTypeId = string(item.object_type_id, `${path}.object_type_id`);
  const required = boolean(item.required, `${path}.required`);
  const port = actionPorts.get(actionIoName);
  if (!port)
    fail("unknown-action-io-port", `${path}.action_io_name`, actionIoName);
  // Action ports are the union across every workflow/step variant. A port used
  // by only one variant is intentionally optional on that union, while the
  // selected variant can require it. Requiredness is checked against the
  // workflow-local artifact below, not the aggregate Action port.
  if (port.type !== format || port.source_object !== objectTypeId) {
    fail(
      "action-io-port-contract-mismatch",
      path,
      `${actionIoName} does not match Action type/source_object`,
    );
  }
  const artifact = workflowArtifacts.get(artifactId);
  if (!artifact)
    fail("unknown-workflow-artifact", `${path}.artifact_id`, artifactId);
  if (
    !workflowArtifactFormats.get(artifactId)?.has(format) ||
    artifact.object_type_id !== objectTypeId ||
    artifact.required !== required
  ) {
    fail(
      "workflow-artifact-contract-mismatch",
      path,
      `${artifactId} does not match format/object_type_id/required`,
    );
  }
  return artifactId;
}

function resolveActionIoBinding(input: {
  action: JsonRecord;
  actionPath: string;
  workflowId: string;
  workflowArtifacts: ReadonlyMap<string, JsonRecord>;
  workflowArtifactFormats: ReadonlyMap<string, ReadonlySet<string>>;
  step: JsonRecord;
  stepPath: string;
  stepId: string;
}): OperatorRuntimePlanStep["action_io_binding"] {
  const stepExtensions = optionalRecord(
    input.step.extensions,
    `${input.stepPath}.extensions`,
  );
  if (stepExtensions.action_io_binding_id === undefined) {
    return { status: "missing", id: null, source_hash: null };
  }
  const bindingId = string(
    stepExtensions.action_io_binding_id,
    `${input.stepPath}.extensions.action_io_binding_id`,
  );
  const actionExtensions = optionalRecord(
    input.action.extensions,
    `${input.actionPath}.extensions`,
  );
  const contract = record(
    actionExtensions.workflow_artifact_io_contract,
    `${input.actionPath}.extensions.workflow_artifact_io_contract`,
  );
  if (contract.mode !== "named_step_bindings") {
    fail(
      "unsupported-action-io-binding-mode",
      `${input.actionPath}.extensions.workflow_artifact_io_contract.mode`,
      String(contract.mode),
    );
  }
  const variants = array(
    contract.variants,
    `${input.actionPath}.extensions.workflow_artifact_io_contract.variants`,
  );
  const matches = variants.flatMap((value, index) => {
    const variant = record(
      value,
      `${input.actionPath}.extensions.workflow_artifact_io_contract.variants[${index}]`,
    );
    return variant.id === bindingId ? [{ variant, index }] : [];
  });
  if (matches.length !== 1) {
    fail(
      "action-io-binding-resolution-failed",
      `${input.stepPath}.extensions.action_io_binding_id`,
      `${bindingId} resolved ${matches.length} variants`,
    );
  }
  const { variant, index } = matches[0]!;
  const variantPath = `${input.actionPath}.extensions.workflow_artifact_io_contract.variants[${index}]`;
  if (
    variant.workflow_id !== input.workflowId ||
    variant.step_id !== input.stepId
  ) {
    fail(
      "action-io-binding-target-mismatch",
      variantPath,
      `${bindingId} must target ${input.workflowId}:${input.stepId}`,
    );
  }
  const actionInputs = new Map(
    array(input.action.inputs ?? [], `${input.actionPath}.inputs`).map(
      (value, portIndex) => {
        const port = record(value, `${input.actionPath}.inputs[${portIndex}]`);
        return [
          string(port.name, `${input.actionPath}.inputs[${portIndex}].name`),
          port,
        ] as const;
      },
    ),
  );
  const actionOutputs = new Map(
    array(input.action.outputs ?? [], `${input.actionPath}.outputs`).map(
      (value, portIndex) => {
        const port = record(value, `${input.actionPath}.outputs[${portIndex}]`);
        return [
          string(port.name, `${input.actionPath}.outputs[${portIndex}].name`),
          port,
        ] as const;
      },
    ),
  );
  const variantInputs = array(variant.inputs, `${variantPath}.inputs`).map(
    (value, itemIndex) =>
      validateBindingItem(
        value,
        `${variantPath}.inputs[${itemIndex}]`,
        actionInputs,
        input.workflowArtifacts,
        input.workflowArtifactFormats,
      ),
  );
  const variantOutputs = array(variant.outputs, `${variantPath}.outputs`).map(
    (value, itemIndex) =>
      validateBindingItem(
        value,
        `${variantPath}.outputs[${itemIndex}]`,
        actionOutputs,
        input.workflowArtifacts,
        input.workflowArtifactFormats,
      ),
  );
  const stepInputs = optionalStringArray(
    input.step.input_artifact_ids,
    `${input.stepPath}.input_artifact_ids`,
  );
  const stepOutputs = optionalStringArray(
    input.step.output_artifact_ids,
    `${input.stepPath}.output_artifact_ids`,
  );
  if (
    !sameStrings(stepInputs, variantInputs) ||
    !sameStrings(stepOutputs, variantOutputs)
  ) {
    fail(
      "action-step-artifact-binding-mismatch",
      input.stepPath,
      `${bindingId} does not exactly match authored step input/output artifact order`,
    );
  }
  return {
    status: "verified",
    id: bindingId,
    source_hash: hashOntologyPackageJson(variant),
  };
}

function validateEventPayloadBindings(
  value: unknown,
  path: string,
  artifacts: ReadonlyMap<string, JsonRecord>,
): Array<{ artifactId: string; resolution: string }> {
  const extensions = optionalRecord(value, path);
  const bindingValues = array(
    extensions.event_payload_bindings ?? [],
    `${path}.event_payload_bindings`,
  );
  const seenFields = new Set<string>();
  return bindingValues.map((bindingValue, index) => {
    const bindingPath = `${path}.event_payload_bindings[${index}]`;
    const binding = record(bindingValue, bindingPath);
    const artifactId = string(
      binding.artifact_id,
      `${bindingPath}.artifact_id`,
    );
    const artifact = artifacts.get(artifactId);
    if (!artifact) {
      fail(
        "unknown-event-payload-artifact",
        `${bindingPath}.artifact_id`,
        artifactId,
      );
    }
    const objectTypeId = string(
      binding.object_type_id,
      `${bindingPath}.object_type_id`,
    );
    if (artifact.object_type_id !== objectTypeId) {
      fail(
        "event-payload-object-type-mismatch",
        bindingPath,
        `${artifactId} does not have object type ${objectTypeId}`,
      );
    }
    const eventField = string(
      binding.event_field,
      `${bindingPath}.event_field`,
    );
    if (seenFields.has(eventField)) {
      fail(
        "duplicate-event-payload-field",
        `${bindingPath}.event_field`,
        eventField,
      );
    }
    seenFields.add(eventField);
    return {
      artifactId,
      resolution: string(binding.resolution, `${bindingPath}.resolution`),
    };
  });
}

function assertWorkflowGraph(input: {
  workflow: JsonRecord;
  workflowPath: string;
  stepIds: ReadonlySet<string>;
  artifacts: ReadonlyMap<string, JsonRecord>;
  eventIds: ReadonlySet<string>;
  roleIds: ReadonlySet<string>;
}): void {
  const entryStepIds = stringArray(
    input.workflow.entry_step_ids,
    `${input.workflowPath}.entry_step_ids`,
  );
  const triggerEntries: string[] = [];
  for (const [index, value] of array(
    input.workflow.triggers,
    `${input.workflowPath}.triggers`,
  ).entries()) {
    const triggerPath = `${input.workflowPath}.triggers[${index}]`;
    const trigger = record(value, triggerPath);
    triggerEntries.push(
      ...stringArray(trigger.entry_step_ids, `${triggerPath}.entry_step_ids`),
    );
    if (trigger.actor_id !== undefined) {
      const actorId = string(trigger.actor_id, `${triggerPath}.actor_id`);
      if (!input.roleIds.has(actorId)) {
        fail("unknown-trigger-role", `${triggerPath}.actor_id`, actorId);
      }
    }
    if (trigger.event_id !== undefined) {
      const eventId = string(trigger.event_id, `${triggerPath}.event_id`);
      if (!input.eventIds.has(eventId)) {
        fail(
          "unknown-workflow-trigger-event",
          `${triggerPath}.event_id`,
          eventId,
        );
      }
    }
    for (const artifactId of optionalStringArray(
      trigger.input_artifact_ids,
      `${triggerPath}.input_artifact_ids`,
    )) {
      if (!input.artifacts.has(artifactId)) {
        fail(
          "unknown-trigger-artifact",
          `${triggerPath}.input_artifact_ids`,
          artifactId,
        );
      }
    }
    validateEventPayloadBindings(
      trigger.extensions,
      `${triggerPath}.extensions`,
      input.artifacts,
    );
  }
  for (const [index, stepId] of [
    ...entryStepIds,
    ...triggerEntries,
  ].entries()) {
    if (!input.stepIds.has(stepId)) {
      fail(
        "unknown-entry-step",
        `${input.workflowPath}.entry_step_ids[${index}]`,
        stepId,
      );
    }
  }
  const reachable = new Set<string>();
  const pending = [...new Set([...entryStepIds, ...triggerEntries])];
  const steps = array(input.workflow.steps, `${input.workflowPath}.steps`).map(
    (value, index) => record(value, `${input.workflowPath}.steps[${index}]`),
  );
  const stepsById = new Map(
    steps.map((step, index) => [
      string(step.id, `${input.workflowPath}.steps[${index}].id`),
      step,
    ]),
  );
  while (pending.length > 0) {
    const stepId = pending.pop()!;
    if (reachable.has(stepId)) continue;
    reachable.add(stepId);
    const step = stepsById.get(stepId)!;
    for (const edgeValue of array(
      step.next,
      `${input.workflowPath}.steps(${stepId}).next`,
    )) {
      const edge = record(
        edgeValue,
        `${input.workflowPath}.steps(${stepId}).next[]`,
      );
      const target = string(
        edge.to_step_id,
        `${input.workflowPath}.steps(${stepId}).next[].to_step_id`,
      );
      if (!input.stepIds.has(target)) {
        fail(
          "unknown-next-step",
          `${input.workflowPath}.steps(${stepId}).next`,
          target,
        );
      }
      pending.push(target);
    }
  }
  const unreachable = [...input.stepIds].filter(
    (stepId) => !reachable.has(stepId),
  );
  if (unreachable.length > 0) {
    fail(
      "unreachable-workflow-step",
      `${input.workflowPath}.steps`,
      unreachable.join(", "),
    );
  }
  for (const [index, value] of array(
    input.workflow.emitted_events ?? [],
    `${input.workflowPath}.emitted_events`,
  ).entries()) {
    const emissionPath = `${input.workflowPath}.emitted_events[${index}]`;
    const emission = record(value, emissionPath);
    const sourceStepId = string(
      emission.source_step_id,
      `${emissionPath}.source_step_id`,
    );
    const eventId = string(emission.event_id, `${emissionPath}.event_id`);
    if (!input.stepIds.has(sourceStepId)) {
      fail(
        "unknown-emission-source-step",
        `${emissionPath}.source_step_id`,
        sourceStepId,
      );
    }
    if (!input.eventIds.has(eventId)) {
      fail(
        "unknown-workflow-emission-event",
        `${emissionPath}.event_id`,
        eventId,
      );
    }
    const bindings = validateEventPayloadBindings(
      emission.extensions,
      `${emissionPath}.extensions`,
      input.artifacts,
    );
    const sourceStep = stepsById.get(sourceStepId)!;
    const sourceOutputs = new Set(
      optionalStringArray(
        sourceStep.output_artifact_ids,
        `${input.workflowPath}.steps(${sourceStepId}).output_artifact_ids`,
      ),
    );
    for (const binding of bindings) {
      if (
        binding.resolution === "direct-source-step-output" &&
        !sourceOutputs.has(binding.artifactId)
      ) {
        fail(
          "emission-artifact-not-produced-by-source-step",
          emissionPath,
          `${sourceStepId} does not output ${binding.artifactId}`,
        );
      }
    }
  }
  for (const [index, value] of array(
    input.workflow.output_contracts ?? [],
    `${input.workflowPath}.output_contracts`,
  ).entries()) {
    const contractPath = `${input.workflowPath}.output_contracts[${index}]`;
    const contract = record(value, contractPath);
    for (const sourceStepId of optionalStringArray(
      contract.source_step_ids,
      `${contractPath}.source_step_ids`,
    )) {
      if (!input.stepIds.has(sourceStepId)) {
        fail(
          "unknown-output-contract-source-step",
          `${contractPath}.source_step_ids`,
          sourceStepId,
        );
      }
    }
    for (const [mappingIndex, mappingValue] of array(
      contract.terminal_outcome_mapping ?? [],
      `${contractPath}.terminal_outcome_mapping`,
    ).entries()) {
      const mappingPath = `${contractPath}.terminal_outcome_mapping[${mappingIndex}]`;
      const sourceStepId = string(
        record(mappingValue, mappingPath).source_step_id,
        `${mappingPath}.source_step_id`,
      );
      if (!input.stepIds.has(sourceStepId)) {
        fail(
          "unknown-output-contract-source-step",
          `${mappingPath}.source_step_id`,
          sourceStepId,
        );
      }
    }
  }
}

function assertAcyclicSubflowGraph(
  workflowsById: ReadonlyMap<
    string,
    { workflow: JsonRecord; path: string; hash: Sha256Digest }
  >,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (workflowId: string, lineage: string[]): void => {
    if (visiting.has(workflowId)) {
      fail(
        "cyclic-subflow-graph",
        `$.artifacts.workflows(${workflowId})`,
        [...lineage, workflowId].join(" -> "),
      );
    }
    if (visited.has(workflowId)) return;
    visiting.add(workflowId);
    const entry = workflowsById.get(workflowId)!;
    for (const [index, stepValue] of array(
      entry.workflow.steps,
      `${entry.path}.steps`,
    ).entries()) {
      const step = record(stepValue, `${entry.path}.steps[${index}]`);
      if (step.node_kind !== "subflow") continue;
      const childId = string(
        step.workflow_id,
        `${entry.path}.steps[${index}].workflow_id`,
      );
      if (!workflowsById.has(childId)) {
        fail(
          "unknown-child-workflow",
          `${entry.path}.steps[${index}].workflow_id`,
          childId,
        );
      }
      visit(childId, [...lineage, workflowId]);
    }
    visiting.delete(workflowId);
    visited.add(workflowId);
  };
  for (const workflowId of workflowsById.keys()) visit(workflowId, []);
}

export function compileOntologyPackageRuntimePlan(
  value: unknown,
  options: OntologyPackageAdmissionOptions = {},
): OperatorRuntimePlanCandidate {
  const missingPins = [
    ["expectedPackageId", options.expectedPackageId],
    ["expectedRelease", options.expectedRelease],
    ["expectedPackageHash", options.expectedPackageHash],
  ]
    .filter(([, pin]) => !pin)
    .map(([name]) => name);
  if (missingPins.length > 0) {
    fail(
      "trusted-package-pins-required",
      "$",
      `runtime planning requires ${missingPins.join(", ")}`,
    );
  }
  const receipt = admitOntologyPackageForShadow(value, options);
  const root = record(value, "$");
  const manifest = record(root.manifest, "$.manifest");
  const artifacts = record(root.artifacts, "$.artifacts");
  const objectsById = new Map<string, JsonRecord>();
  for (const [index, value] of array(
    artifacts.objects,
    "$.artifacts.objects",
  ).entries()) {
    const objectPath = `$.artifacts.objects[${index}]`;
    const objectType = record(value, objectPath);
    const objectId = string(objectType.id, `${objectPath}.id`);
    if (objectsById.has(objectId)) {
      fail("duplicate-object", `${objectPath}.id`, objectId);
    }
    objectsById.set(objectId, objectType);
  }
  const actionValues = array(artifacts.actions, "$.artifacts.actions");
  const workflowValues = array(artifacts.workflows, "$.artifacts.workflows");
  const eventIds = new Set(
    array(artifacts.events, "$.artifacts.events").map((value, index) =>
      string(
        record(value, `$.artifacts.events[${index}]`).name,
        `$.artifacts.events[${index}].name`,
      ),
    ),
  );
  const ruleIds = new Set(
    array(artifacts.rules, "$.artifacts.rules").map((value, index) =>
      string(
        record(value, `$.artifacts.rules[${index}]`).id,
        `$.artifacts.rules[${index}].id`,
      ),
    ),
  );
  const blockers = new BlockerCollector();
  blockers.addReceipt(receipt);
  blockers.add(
    "trusted-production-authorization-required",
    "package hashes and acceptance rows are integrity evidence, not server-authored production authority",
  );
  blockers.add(
    "runtime-plan-import-path-disabled",
    "this schema is not accepted by WorkflowManifest import or runtime bootstrap",
  );
  blockers.add(
    "compiler-build-attestation-required",
    "a future activation record must pin the exact planner and runtime build identities",
  );

  const actionsById = new Map<string, { action: JsonRecord; path: string }>();
  const planActions = actionValues.map(
    (value, index): OperatorRuntimePlanAction => {
      const path = `$.artifacts.actions[${index}]`;
      const action = record(value, path);
      const id = string(action.id, `${path}.id`);
      if (actionsById.has(id)) fail("duplicate-action", `${path}.id`, id);
      actionsById.set(id, { action, path });
      const implementation = record(
        action.implementation,
        `${path}.implementation`,
      );
      const kind = string(implementation.kind, `${path}.implementation.kind`);
      const executable = boolean(
        implementation.executable,
        `${path}.implementation.executable`,
      );
      if (executable)
        fail(
          "executable-action-forbidden",
          `${path}.implementation.executable`,
          id,
        );
      const actionBlockers = ["action-runtime-binding-required"];
      blockers.add("action-runtime-binding-required", id);
      if (["external", "http", "mcp", "subprocess"].includes(kind)) {
        actionBlockers.push("external-action-contract-required");
        blockers.add("external-action-contract-required", id);
      }
      return {
        id,
        source_pointer: path,
        source_hash: hashOntologyPackageJson(action),
        actors: stringArray(action.actor, `${path}.actor`),
        implementation_kind: kind,
        executable: false,
        effective_executable: false,
        runtime_binding_status: "unbound",
        used_by: [],
        blocker_codes: sorted(actionBlockers),
      };
    },
  );
  const planActionsById = new Map(
    planActions.map((action) => [action.id, action]),
  );
  const planAgents = receipt.agent_contracts.map(
    (contract): OperatorRuntimePlanAgent => ({
      id: contract.id,
      version: contract.version,
      source_pointer: `$.manifest.extensions.agent_contracts(${contract.id}@${contract.version})`,
      contract_hash: contract.contract_hash,
      prompt_profile: contract.prompt_profile,
      activation_status: contract.activation_status,
      deployment_status: contract.deployment_status,
      runtime_scope: contract.runtime_scope,
      granted_action_ids: sorted(
        contract.grants.map((grant) => grant.action_id),
      ),
      subscription_count: contract.subscriptions.length,
      subscription_contract_hash: hashOntologyPackageJson(
        contract.subscriptions,
      ),
      eval_case_count: contract.eval_cases.length,
      eval_contract_hash: hashOntologyPackageJson(contract.eval_cases),
      eval_status: "declared_not_run",
      runtime_binding_status: "unbound",
      blocker_codes: ["agent-contract-deployment-required"],
    }),
  );

  const workflowsById = new Map<
    string,
    { workflow: JsonRecord; path: string; hash: Sha256Digest }
  >();
  for (const [index, value] of workflowValues.entries()) {
    const path = `$.artifacts.workflows[${index}]`;
    const workflow = record(value, path);
    const id = string(workflow.id, `${path}.id`);
    if (workflowsById.has(id)) fail("duplicate-workflow", `${path}.id`, id);
    workflowsById.set(id, {
      workflow,
      path,
      hash: hashOntologyPackageJson(workflow),
    });
  }
  assertAcyclicSubflowGraph(workflowsById);

  const manifestExtensions = record(
    manifest.extensions,
    "$.manifest.extensions",
  );
  let workflowContractMembershipVerified = false;
  if (manifestExtensions.workflow_contract === undefined) {
    blockers.add(
      "workflow-membership-declaration-required",
      "$.manifest.extensions.workflow_contract.workflow_ids is absent",
    );
  } else {
    const workflowContract = record(
      manifestExtensions.workflow_contract,
      "$.manifest.extensions.workflow_contract",
    );
    const declaredWorkflowIds = stringArray(
      workflowContract.workflow_ids,
      "$.manifest.extensions.workflow_contract.workflow_ids",
    );
    const actualWorkflowIds = [...workflowsById.keys()];
    if (
      !sameStrings(sorted(declaredWorkflowIds), sorted(actualWorkflowIds)) ||
      new Set(declaredWorkflowIds).size !== declaredWorkflowIds.length
    ) {
      fail(
        "workflow-membership-declaration-mismatch",
        "$.manifest.extensions.workflow_contract.workflow_ids",
        "must equal the workflow family membership exactly",
      );
    }
    workflowContractMembershipVerified = true;
  }

  let verifiedBindings = 0;
  let missingBindings = 0;
  let childEdgeCount = 0;
  let verifiedSubflowContracts = 0;
  let missingSubflowContracts = 0;
  let humanGateCount = 0;
  let conditionCount = 0;
  let conditionTestCount = 0;
  let defaultEdgeCount = 0;
  let workflowArtifactCount = 0;
  let outputContractCount = 0;
  let artifactEqualityConstraintCount = 0;
  let emittedEventCount = 0;
  const stepKindCounts: Record<string, number> = {};
  const executionModeCounts: Record<string, number> = {};
  const allStepMembership: Array<{
    workflow_id: string;
    step_id: string;
    source_hash: Sha256Digest;
  }> = [];
  const planWorkflows = workflowValues.map(
    (value, workflowIndex): OperatorRuntimePlanWorkflow => {
      const workflowPath = `$.artifacts.workflows[${workflowIndex}]`;
      const workflow = record(value, workflowPath);
      const workflowId = string(workflow.id, `${workflowPath}.id`);
      const version = string(
        workflow.workflow_version,
        `${workflowPath}.workflow_version`,
      );
      const workflowExtensions = optionalRecord(
        workflow.extensions,
        `${workflowPath}.extensions`,
      );
      const activationStatus = string(
        workflowExtensions.activation_status,
        `${workflowPath}.extensions.activation_status`,
      );
      blockers.add(
        "workflow-runtime-activation-required",
        `${workflowId}@${version}`,
      );
      const roles = array(workflow.roles ?? [], `${workflowPath}.roles`).map(
        (roleValue, roleIndex) => {
          const rolePath = `${workflowPath}.roles[${roleIndex}]`;
          return string(record(roleValue, rolePath).id, `${rolePath}.id`);
        },
      );
      const roleIds = new Set(roles);
      const workflowArtifacts = artifactMap(workflow, workflowPath);
      workflowArtifactCount += workflowArtifacts.size;
      outputContractCount += array(
        workflow.output_contracts ?? [],
        `${workflowPath}.output_contracts`,
      ).length;
      artifactEqualityConstraintCount += array(
        workflowExtensions.artifact_equality_constraints ?? [],
        `${workflowPath}.extensions.artifact_equality_constraints`,
      ).length;
      emittedEventCount += array(
        workflow.emitted_events ?? [],
        `${workflowPath}.emitted_events`,
      ).length;
      const workflowArtifactFormats = artifactFormats(
        workflow,
        workflowPath,
        workflowArtifacts,
      );
      const stepValues = array(workflow.steps, `${workflowPath}.steps`);
      const stepIds = stepValues.map((stepValue, stepIndex) =>
        string(
          record(stepValue, `${workflowPath}.steps[${stepIndex}]`).id,
          `${workflowPath}.steps[${stepIndex}].id`,
        ),
      );
      if (new Set(stepIds).size !== stepIds.length) {
        fail("duplicate-workflow-step", `${workflowPath}.steps`, workflowId);
      }
      const orders = new Set<number>();
      const edgeIds = new Set<string>();
      const planSteps = stepValues.map(
        (stepValue, stepIndex): OperatorRuntimePlanStep => {
          const stepPath = `${workflowPath}.steps[${stepIndex}]`;
          const step = record(stepValue, stepPath);
          const stepId = string(step.id, `${stepPath}.id`);
          const order = integer(step.order, `${stepPath}.order`);
          if (orders.has(order))
            fail(
              "duplicate-workflow-step-order",
              `${stepPath}.order`,
              String(order),
            );
          orders.add(order);
          const nodeKind = string(step.node_kind, `${stepPath}.node_kind`);
          const execution = record(step.execution, `${stepPath}.execution`);
          const executionMode = string(
            execution.mode,
            `${stepPath}.execution.mode`,
          );
          increment(stepKindCounts, nodeKind);
          increment(executionModeCounts, executionMode);
          const actorIds = optionalStringArray(
            execution.actor_ids,
            `${stepPath}.execution.actor_ids`,
          );
          for (const actorId of actorIds) {
            if (!roleIds.has(actorId))
              fail(
                "unknown-step-role",
                `${stepPath}.execution.actor_ids`,
                actorId,
              );
          }
          const inputArtifactIds = optionalStringArray(
            step.input_artifact_ids,
            `${stepPath}.input_artifact_ids`,
          );
          const outputArtifactIds = optionalStringArray(
            step.output_artifact_ids,
            `${stepPath}.output_artifact_ids`,
          );
          for (const artifactId of [
            ...inputArtifactIds,
            ...outputArtifactIds,
          ]) {
            if (!workflowArtifacts.has(artifactId)) {
              fail("unknown-step-artifact", stepPath, artifactId);
            }
          }
          const guardRuleIds = optionalStringArray(
            step.guard_rule_ids,
            `${stepPath}.guard_rule_ids`,
          );
          for (const ruleId of guardRuleIds) {
            if (!ruleIds.has(ruleId))
              fail("unknown-step-rule", `${stepPath}.guard_rule_ids`, ruleId);
          }
          const stepBlockers: string[] = [];
          let actionId: string | null = null;
          let actionHash: Sha256Digest | null = null;
          let actionIoBinding: OperatorRuntimePlanStep["action_io_binding"] = {
            status: "missing",
            id: null,
            source_hash: null,
          };
          if (nodeKind === "action") {
            actionId = string(step.action_id, `${stepPath}.action_id`);
            const actionEntry = actionsById.get(actionId);
            const planAction = planActionsById.get(actionId);
            if (!actionEntry || !planAction)
              fail(
                "unknown-workflow-action",
                `${stepPath}.action_id`,
                actionId,
              );
            actionHash = planAction.source_hash;
            planAction.used_by.push({
              workflow_id: workflowId,
              step_id: stepId,
            });
            stepBlockers.push("action-runtime-binding-required");
            actionIoBinding = resolveActionIoBinding({
              action: actionEntry.action,
              actionPath: actionEntry.path,
              workflowId,
              workflowArtifacts,
              workflowArtifactFormats,
              step,
              stepPath,
              stepId,
            });
            if (actionIoBinding.status === "verified") verifiedBindings += 1;
            else {
              missingBindings += 1;
              stepBlockers.push("action-artifact-binding-required");
              blockers.add(
                "action-artifact-binding-required",
                `${workflowId}:${stepId}`,
              );
            }
          }
          let childWorkflow: OperatorRuntimePlanStep["child_workflow"] = null;
          if (nodeKind === "subflow") {
            childEdgeCount += 1;
            const childId = string(step.workflow_id, `${stepPath}.workflow_id`);
            const child = workflowsById.get(childId);
            if (!child)
              fail(
                "unknown-child-workflow",
                `${stepPath}.workflow_id`,
                childId,
              );
            const stepExtensions = record(
              step.extensions,
              `${stepPath}.extensions`,
            );
            const pinnedVersion = string(
              stepExtensions.pinned_workflow_version,
              `${stepPath}.extensions.pinned_workflow_version`,
            );
            if (pinnedVersion !== child.workflow.workflow_version) {
              fail(
                "child-workflow-version-mismatch",
                stepPath,
                `${pinnedVersion} != ${String(child.workflow.workflow_version)}`,
              );
            }
            const bindings = record(
              stepExtensions.artifact_bindings,
              `${stepPath}.extensions.artifact_bindings`,
            );
            const subflowContract = resolveSubflowContract({
              stepExtensions,
              stepPath,
              stepInputArtifactIds: inputArtifactIds,
              bindings,
              parentArtifacts: workflowArtifacts,
              objectsById,
              childWorkflow: child.workflow,
              childPath: child.path,
            });
            if (subflowContract.contract_status === "verified") {
              verifiedSubflowContracts += 1;
            } else {
              missingSubflowContracts += 1;
              stepBlockers.push("subflow-contract-declaration-required");
              blockers.add(
                "subflow-contract-declaration-required",
                `${workflowId}:${stepId}->${childId}@${pinnedVersion}`,
              );
            }
            childWorkflow = {
              id: childId,
              version: pinnedVersion,
              source_hash: child.hash,
              artifact_binding_hash: hashOntologyPackageJson(bindings),
              runtime_enforcement: boolean(
                bindings.runtime_enforcement,
                `${stepPath}.extensions.artifact_bindings.runtime_enforcement`,
              ),
              ...subflowContract,
            };
            for (const code of [
              "synchronous-versioned-subflow-runtime-required",
              "parent-child-checkpoint-runtime-required",
              "artifact-context-merge-runtime-required",
            ]) {
              stepBlockers.push(code);
              blockers.add(
                code,
                `${workflowId}:${stepId}->${childId}@${pinnedVersion}`,
              );
            }
          }
          if (nodeKind === "decision") {
            stepBlockers.push("cel-decision-runtime-required");
            blockers.add(
              "cel-decision-runtime-required",
              `${workflowId}:${stepId}`,
            );
          }
          if (nodeKind === "wait") {
            stepBlockers.push("durable-wait-scheduler-required");
            blockers.add(
              "durable-wait-scheduler-required",
              `${workflowId}:${stepId}`,
            );
          }
          if (executionMode === "human" || executionMode === "hybrid") {
            humanGateCount += 1;
            stepBlockers.push("principal-role-sod-enforcement-required");
            blockers.add(
              "principal-role-sod-enforcement-required",
              `${workflowId}:${stepId}`,
            );
          }
          if (executionMode === "agent") {
            stepBlockers.push("agent-contract-deployment-required");
            blockers.add(
              "agent-contract-deployment-required",
              `${workflowId}:${stepId}`,
            );
          }
          const next = array(step.next, `${stepPath}.next`).map(
            (edgeValue, edgeIndex) => {
              const edgePath = `${stepPath}.next[${edgeIndex}]`;
              const edge = record(edgeValue, edgePath);
              const id = string(edge.id, `${edgePath}.id`);
              if (edgeIds.has(id))
                fail("duplicate-workflow-edge", `${edgePath}.id`, id);
              edgeIds.add(id);
              const target = string(edge.to_step_id, `${edgePath}.to_step_id`);
              if (!stepIds.includes(target))
                fail("unknown-next-step", `${edgePath}.to_step_id`, target);
              const condition = edge.condition;
              const conditionHash =
                condition === undefined
                  ? null
                  : hashOntologyPackageJson(
                      record(condition, `${edgePath}.condition`),
                    );
              if (conditionHash) {
                conditionCount += 1;
                const conditionRecord = record(
                  condition,
                  `${edgePath}.condition`,
                );
                conditionTestCount += array(
                  conditionRecord.test_cases ?? [],
                  `${edgePath}.condition.test_cases`,
                ).length;
              }
              const isDefault = edge.is_default === true;
              if (isDefault) defaultEdgeCount += 1;
              const edgeExtensions = optionalRecord(
                edge.extensions,
                `${edgePath}.extensions`,
              );
              return {
                id,
                to_step_id: target,
                edge_type: string(edge.edge_type, `${edgePath}.edge_type`),
                label:
                  typeof edge.label === "string" && edge.label.trim()
                    ? edge.label.trim()
                    : null,
                transition:
                  typeof edgeExtensions.transition === "string" &&
                  edgeExtensions.transition.trim()
                    ? edgeExtensions.transition.trim()
                    : null,
                is_default: isDefault,
                condition_hash: conditionHash,
                source_hash: hashOntologyPackageJson(edge),
              };
            },
          );
          let waitContract: OperatorRuntimePlanStep["wait_contract"] = null;
          if (nodeKind === "wait") {
            const stepExtensions = optionalRecord(
              step.extensions,
              `${stepPath}.extensions`,
            );
            const timeoutSemantics = optionalRecord(
              stepExtensions.timeout_semantics,
              `${stepPath}.extensions.timeout_semantics`,
            );
            waitContract = {
              timeout_ms:
                step.timeout_ms === undefined
                  ? null
                  : integer(step.timeout_ms, `${stepPath}.timeout_ms`),
              clock_source:
                typeof timeoutSemantics.clock_source === "string"
                  ? timeoutSemantics.clock_source
                  : null,
              deadline_property:
                typeof timeoutSemantics.deadline_property === "string"
                  ? timeoutSemantics.deadline_property
                  : null,
              wake_transitions: sorted(
                next.flatMap((edge) =>
                  edge.transition ? [edge.transition] : [],
                ),
              ),
              wake_event_binding_status: "unbound",
            };
            blockers.add(
              "wait-wake-event-binding-required",
              `${workflowId}:${stepId}`,
            );
            stepBlockers.push("wait-wake-event-binding-required");
            if (step.timeout_ms === undefined) {
              blockers.add(
                "wait-deadline-contract-required",
                `${workflowId}:${stepId}`,
              );
              stepBlockers.push("wait-deadline-contract-required");
            }
          }
          const sourceHash = hashOntologyPackageJson(step);
          allStepMembership.push({
            workflow_id: workflowId,
            step_id: stepId,
            source_hash: sourceHash,
          });
          return {
            id: stepId,
            order,
            source_pointer: stepPath,
            source_hash: sourceHash,
            node_kind: nodeKind,
            execution_mode: executionMode,
            actor_ids: actorIds,
            input_artifact_ids: inputArtifactIds,
            output_artifact_ids: outputArtifactIds,
            guard_rule_ids: guardRuleIds,
            action_id: actionId,
            action_hash: actionHash,
            action_io_binding: actionIoBinding,
            child_workflow: childWorkflow,
            next,
            wait_contract: waitContract,
            runtime_status: "blocked",
            blocker_codes: sorted(stepBlockers),
          };
        },
      );
      assertWorkflowGraph({
        workflow,
        workflowPath,
        stepIds: new Set(stepIds),
        artifacts: workflowArtifacts,
        eventIds,
        roleIds,
      });
      const triggers = array(workflow.triggers, `${workflowPath}.triggers`).map(
        (triggerValue, triggerIndex) =>
          string(
            record(triggerValue, `${workflowPath}.triggers[${triggerIndex}]`)
              .kind,
            `${workflowPath}.triggers[${triggerIndex}].kind`,
          ),
      );
      return {
        id: workflowId,
        version,
        source_pointer: workflowPath,
        source_hash: hashOntologyPackageJson(workflow),
        activation_status: activationStatus,
        role_ids: roles,
        entry_step_ids: stringArray(
          workflow.entry_step_ids,
          `${workflowPath}.entry_step_ids`,
        ),
        trigger_kinds: sorted(triggers),
        step_ids: stepIds,
        steps: planSteps,
      };
    },
  );

  for (const action of planActions) {
    action.used_by.sort((left, right) =>
      `${left.workflow_id}\u0000${left.step_id}`.localeCompare(
        `${right.workflow_id}\u0000${right.step_id}`,
        "en",
      ),
    );
    if (action.used_by.length === 0) {
      action.blocker_codes = sorted([
        ...action.blocker_codes,
        "unused-action-membership-review-required",
      ]);
      blockers.add("unused-action-membership-review-required", action.id);
    }
  }

  const workflowMembership = planWorkflows.map((workflow) => ({
    id: workflow.id,
    version: workflow.version,
    source_hash: workflow.source_hash,
    step_ids: workflow.step_ids,
  }));
  const actionMembership = planActions.map((action) => ({
    id: action.id,
    source_hash: action.source_hash,
  }));
  const agentMembership = planAgents.map((agent) => ({
    id: agent.id,
    version: agent.version,
    contract_hash: agent.contract_hash,
  }));
  const candidateWithoutHash: Omit<OperatorRuntimePlanCandidate, "plan_hash"> =
    {
      schema: ONTOLOGY_PACKAGE_RUNTIME_PLAN_SCHEMA,
      source: {
        package_id: receipt.source_package.package_id,
        release: receipt.source_package.release,
        package_hash: receipt.source_package.package_hash,
        admission_receipt_hash: receipt.receipt_hash,
        schema_bundle_version: receipt.source_package.schema_bundle_version,
        family_hashes: receipt.family_hashes,
        domain_id: receipt.source_package.domain_id,
        primary_workflow_id: receipt.source_package.primary_workflow_id,
      },
      status: {
        phase: "runtime_contract_planning",
        deployable: false,
        runtime_import_allowed: false,
        execution_manifest_generated: false,
        trusted_production_authorization_present: false,
        external_dispatch: "forbidden",
      },
      membership: {
        workflow_count: planWorkflows.length,
        action_count: planActions.length,
        agent_count: planAgents.length,
        step_count: allStepMembership.length,
        child_edge_count: childEdgeCount,
        workflow_ids: planWorkflows.map((workflow) => workflow.id),
        action_ids: planActions.map((action) => action.id),
        agent_ids: planAgents.map((agent) => `${agent.id}@${agent.version}`),
        workflow_membership_hash: hashOntologyPackageJson(workflowMembership),
        action_membership_hash: hashOntologyPackageJson(actionMembership),
        agent_membership_hash: hashOntologyPackageJson(agentMembership),
        step_membership_hash: hashOntologyPackageJson(allStepMembership),
      },
      coverage: {
        step_kinds: stepKindCounts,
        execution_modes: executionModeCounts,
        human_gate_count: humanGateCount,
        condition_count: conditionCount,
        condition_test_count: conditionTestCount,
        default_edge_count: defaultEdgeCount,
        workflow_artifact_count: workflowArtifactCount,
        output_contract_count: outputContractCount,
        artifact_equality_constraint_count: artifactEqualityConstraintCount,
        emitted_event_count: emittedEventCount,
      },
      verification: {
        admission_recomputed: true,
        workflow_graph_references_closed: true,
        workflow_versions_pinned: true,
        source_contract_hashes_recorded: true,
        workflow_contract_membership_verified:
          workflowContractMembershipVerified,
        action_io_bindings_verified: verifiedBindings,
        action_io_bindings_missing: missingBindings,
        subflow_contracts_verified: verifiedSubflowContracts,
        subflow_contracts_missing: missingSubflowContracts,
      },
      actions: planActions,
      agent_contracts: planAgents,
      workflows: planWorkflows,
      activation_blockers: blockers.list(),
    };
  return {
    ...candidateWithoutHash,
    plan_hash: hashOntologyPackageJson(candidateWithoutHash),
  };
}

export function loadOntologyPackageRuntimePlan(
  packagePath: string,
  options: OntologyPackageAdmissionOptions = {},
): OperatorRuntimePlanCandidate {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    fail("package-read-failed", packagePath, (error as Error).message);
  }
  return compileOntologyPackageRuntimePlan(value, options);
}
