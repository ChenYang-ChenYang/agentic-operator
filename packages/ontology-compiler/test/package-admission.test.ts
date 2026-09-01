import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkflowManifestSchema,
  loadManifestFromDisk,
  migrate,
} from "@agentic/runtime";
import {
  ONTOLOGY_PACKAGE_FAMILIES,
  OntologyPackageAdmissionError,
  admitOntologyPackageForShadow,
  hashOntologyPackageJson,
  ontologyPackageHashPayload,
} from "../src/package-admission.ts";
import { runPackageCli } from "../src/package-cli.ts";
import {
  OntologyRuntimePlanError,
  compileOntologyPackageRuntimePlan,
} from "../src/package-runtime-plan.ts";

type JsonRecord = Record<string, any>;

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function identity(family: string, item: JsonRecord): string {
  return family === "events" ? item.name : item.id;
}

function sealPackage(pkg: JsonRecord): JsonRecord {
  for (const contract of pkg.manifest.extensions.agent_contracts) {
    const { content_hash: _promptHash, ...promptContent } =
      contract.prompt_profile;
    contract.prompt_profile.content_hash =
      hashOntologyPackageJson(promptContent);
    const { contract_hash: _contractHash, ...contractContent } = contract;
    contract.contract_hash = hashOntologyPackageJson(contractContent);
  }
  for (const family of ONTOLOGY_PACKAGE_FAMILIES) {
    const artifacts = pkg.artifacts[family];
    pkg.manifest.families[family] = {
      family,
      schema_id: `https://schemas.allmeta.ai/ontology/3.2.0/${family}.schema.json`,
      filename: `${family}_1.0.0.json`,
      artifact_count: artifacts.length,
      ordered_artifact_ids: artifacts.map((item: JsonRecord) =>
        identity(family, item),
      ),
      content_hash: hashOntologyPackageJson(artifacts),
    };
    pkg.manifest.coverage[family] = artifacts.length;
  }
  pkg.manifest.coverage.workflow_steps = pkg.artifacts.workflows.reduce(
    (count: number, workflow: JsonRecord) =>
      count + (Array.isArray(workflow.steps) ? workflow.steps.length : 0),
    0,
  );
  pkg.manifest.package_hash = hashOntologyPackageJson(
    ontologyPackageHashPayload(pkg),
  );
  return pkg;
}

function packageFixture(): JsonRecord {
  const canonicalFixturePath = fileURLToPath(
    new URL("./fixtures/ontology-package-3.2.0.json", import.meta.url),
  );
  const pkg = JSON.parse(readFileSync(canonicalFixturePath, "utf8"));
  const prompt = {
    id: "proposal-only",
    version: "1.0.0",
    system_instructions: ["Create a proposal only."],
    output_contract: {
      mode: "proposal_only",
      human_approval_required: true,
    },
    required_context_object_ids: ["Object-Plan"],
    content_hash: "",
  };
  const agentContract = {
    schema_version: "1.0.0",
    id: "candidate-agent",
    version: "1.0.0",
    activation_status: "specified_not_activated",
    deployment_status: "not_deployed",
    runtime_scope: "candidate_shadow_fixture_only",
    contract_hash: "",
    prompt_profile: prompt,
    grants: [
      {
        action_id: "Action-Propose",
        permission: "invoke_candidate_internal_action",
        effect: "internal_proposal_only",
        external: false,
        consequential_write: false,
      },
    ],
    subscriptions: [
      {
        workflow_id: "workflow-child",
        source_step_id: "step-source",
        target_step_id: "step-propose",
        event_id: "Event-Plan-Created",
        delivery: "workflow_bound_fixture",
        autonomous_start: false,
      },
    ],
    eval_cases: [
      { id: "eval-1", expected_outcome: "proposal" },
      { id: "eval-2", expected_outcome: "abstain" },
      { id: "eval-3", expected_outcome: "human-review" },
    ],
  };

  const actionTemplate = pkg.artifacts.actions[0];
  pkg.artifacts.actions = [
    ["Action-System", "System action"],
    ["Action-Propose", "Propose"],
    ["Action-Record", "Record decision"],
  ].map(([id, name]) => ({
    ...structuredClone(actionTemplate),
    id,
    name,
    implementation: { kind: "typescript", executable: false },
    extensions: { propose_only: id === "Action-Propose" },
  }));

  const workflowTemplate = pkg.artifacts.workflows[0];
  const mainWorkflow = {
    ...structuredClone(workflowTemplate),
    id: "workflow-main",
    workflow_version: "1.0.0",
    entry_step_ids: ["step-system"],
    triggers: [
      {
        id: "trigger-main",
        kind: "manual",
        entry_step_ids: ["step-system"],
        input_artifact_ids: [],
      },
    ],
    extensions: { activation_status: "specified_not_activated" },
    emitted_events: [],
    steps: [
      {
        id: "step-system",
        order: 1,
        name: "System action",
        description: "Run a non-executable system action.",
        node_kind: "action",
        action_id: "Action-System",
        execution: { mode: "system" },
        next: [],
      },
      {
        id: "step-child",
        order: 2,
        name: "Child workflow",
        description: "Reference the pinned child workflow.",
        node_kind: "subflow",
        workflow_id: "workflow-child",
        execution: { mode: "system" },
        next: [],
        extensions: {
          pinned_workflow_version: "1.0.0",
          artifact_bindings: { runtime_enforcement: false },
        },
      },
      {
        id: "step-wait",
        order: 3,
        name: "Wait",
        description: "Wait for evidence.",
        node_kind: "wait",
        execution: { mode: "system" },
        next: [],
      },
    ],
  };
  const childWorkflow = {
    ...structuredClone(workflowTemplate),
    id: "workflow-child",
    workflow_version: "1.0.0",
    entry_step_ids: ["step-source"],
    triggers: [
      {
        id: "trigger-child",
        kind: "event",
        event_id: "Event-Plan-Created",
        entry_step_ids: ["step-source"],
        input_artifact_ids: [],
      },
    ],
    extensions: { activation_status: "specified_not_activated" },
    emitted_events: [
      {
        id: "emission-source-plan-created",
        event_id: "Event-Plan-Created",
        source_step_id: "step-source",
        when: "success",
      },
    ],
    steps: [
      {
        id: "step-source",
        order: 1,
        name: "Prepare evidence",
        description: "Prepare the evidence that permits a proposal fixture.",
        node_kind: "action",
        action_id: "Action-System",
        execution: { mode: "system" },
        next: [
          {
            id: "edge-source-propose",
            to_step_id: "step-propose",
            edge_type: "sequence",
          },
        ],
      },
      {
        id: "step-propose",
        order: 2,
        name: "Propose",
        description: "Create a non-executable proposal.",
        node_kind: "action",
        action_id: "Action-Propose",
        execution: { mode: "agent" },
        next: [],
        extensions: { agent_contract_id: "candidate-agent@1.0.0" },
      },
      {
        id: "step-human",
        order: 3,
        name: "Human decision",
        description: "Record a human decision.",
        node_kind: "action",
        action_id: "Action-Record",
        execution: { mode: "human" },
        next: [],
      },
    ],
  };
  pkg.artifacts.workflows = [mainWorkflow, childWorkflow];

  Object.assign(pkg.manifest, {
    package_id: "test-purchase",
    release: "1.0.0",
    name: "Test Purchase",
    description: "Schema-valid package admission fixture.",
    package_hash: "",
    acceptance: [
      {
        gate: "production-agentic-operator-activation",
        status: "failed",
        checked_at: "2026-08-31T00:00:00.000Z",
        checked_by: "ontology-package-admission-test",
        evidence: ["runtime contracts not bound"],
      },
    ],
    extensions: {
      classification: {
        domain: "test-purchase",
        project: "Test-Purchase",
        scenario: "candidate-test",
      },
      package_kind: "domain",
      primary_workflow_id: "workflow-main",
      activation_policy: {
        agent: "propose-only",
        external_actions: "non-executable",
        internal_actions: "non-executable-until-bound",
      },
      agent_contracts: [agentContract],
    },
  });
  return sealPackage(pkg);
}

function expectAdmissionError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("expected admission to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(OntologyPackageAdmissionError);
    expect((error as OntologyPackageAdmissionError).code).toBe(code);
  }
}

function expectRuntimePlanError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("expected runtime planning to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(OntologyRuntimePlanError);
    expect((error as OntologyRuntimePlanError).code).toBe(code);
  }
}

function connectRuntimePlanFixture(pkg: JsonRecord): JsonRecord {
  pkg.artifacts.workflows[0].steps[0].next = [
    {
      id: "edge-system-child",
      to_step_id: "step-child",
      edge_type: "sequence",
    },
  ];
  pkg.artifacts.workflows[0].steps[1].next = [
    {
      id: "edge-child-wait",
      to_step_id: "step-wait",
      edge_type: "sequence",
    },
  ];
  pkg.artifacts.workflows[1].steps[1].next = [
    {
      id: "edge-propose-human",
      to_step_id: "step-human",
      edge_type: "sequence",
    },
  ];
  return sealPackage(pkg);
}

function addCompleteSubflowContract(pkg: JsonRecord): JsonRecord {
  const objectType = pkg.artifacts.objects[0];
  objectType.properties.push({
    name: "status",
    type: "Enum",
    description: "Synthetic context-patch target.",
    enum_values: ["ready", "blocked"],
  });
  const parentWorkflow = pkg.artifacts.workflows[0];
  const childWorkflow = pkg.artifacts.workflows[1];
  parentWorkflow.steps[1].input_artifact_ids = ["Artifact-Plan"];
  childWorkflow.artifacts.push(
    {
      id: "Artifact-Child-Input",
      name: "Child input",
      direction: "input",
      format: "application/json",
      object_type_id: "Object-Plan",
      required: true,
    },
    {
      id: "Artifact-Patch",
      name: "Context patch",
      direction: "output",
      format: "application/json",
      object_type_id: "Object-Plan",
      required: true,
    },
  );
  childWorkflow.steps[2].output_artifact_ids = ["Artifact-Patch"];
  childWorkflow.output_contracts = [
    {
      id: "Output-Status-Patch",
      name: "Status context patch",
      description: "Patch the synthetic status property.",
      format: "application/vnd.allmeta.context-patch+json",
      artifact_id: "Artifact-Patch",
      required: true,
      source_step_ids: ["step-human"],
      terminal_outcome_mapping: [
        { source_step_id: "step-human", values: ["ready"] },
      ],
      delivery_channel: "parent-context-patch",
      contents: [
        { name: "target_object", data_type: "String", required: true },
        { name: "target_property", data_type: "String", required: true },
        { name: "value", data_type: "Enum", required: true },
        {
          name: "source_evidence_hash",
          data_type: "String",
          required: true,
        },
      ],
      content_schema: {
        type: "object",
        additionalProperties: false,
        "x-allmeta-context-patch": {
          target_artifact_id: "Artifact-Plan",
          producer_outcomes: [
            { source_step_id: "step-human", values: ["ready"] },
          ],
        },
        required: [
          "target_object",
          "target_property",
          "value",
          "source_evidence_hash",
        ],
        properties: {
          target_object: { const: "Object-Plan" },
          target_property: { const: "status" },
          value: { type: "string", enum: ["ready"] },
          source_evidence_hash: {
            type: "string",
            pattern: "^sha256:[a-f0-9]{64}$",
          },
        },
      },
    },
  ];
  parentWorkflow.steps[1].extensions = {
    pinned_workflow_version: "1.0.0",
    invocation_mode: "synchronous_active_segment_with_durable_child_resume",
    failure_policy: "halt_and_preserve_audit_evidence",
    timeout_policy: "fail_parent",
    timeout_semantics: {
      kind: "active_execution_only",
      active_execution_timeout_ms: 120_000,
      excludes_child_human_and_wait_pauses: true,
      parent_checkpoint_required_on_child_pause: true,
      runtime_enforcement_required_before_activation: true,
    },
    artifact_bindings: {
      runtime_enforcement: false,
      parent_context_artifact_id: "Artifact-Plan",
      case_key_path: "Object-Plan.plan_id",
      input_resolution: [
        {
          child_artifact_id: "Artifact-Child-Input",
          object_type_id: "Object-Plan",
          required: true,
          resolver: "parent-context-pass-through",
        },
      ],
      output_merge: {
        child_output_contract_id: "Output-Status-Patch",
        parent_artifact_id: "Artifact-Plan",
        merge_policy:
          "validate-target-property-enum-and-source-evidence-hash-then-merge",
      },
    },
  };
  return sealPackage(pkg);
}

describe("immutable Ontology Package shadow admission", () => {
  it("verifies all hashes and emits a non-deployable workflow/subflow receipt", () => {
    const pkg = packageFixture();
    const result = admitOntologyPackageForShadow(pkg, {
      expectedPackageId: "test-purchase",
      expectedRelease: "1.0.0",
      expectedPackageHash: pkg.manifest.package_hash,
    });

    expect(result).toMatchObject({
      schema: "agentic-operator.ontology-package-shadow-candidate/v1",
      source_package: {
        package_id: "test-purchase",
        release: "1.0.0",
        immutable: true,
        domain_id: "test-purchase",
        primary_workflow_id: "workflow-main",
      },
      admission: {
        status: "verified_shadow_candidate",
        deployable: false,
        runtime_import_allowed: false,
        runtime_scope: "candidate_shadow_fixture_only",
      },
      artifact_counts: {
        objects: 1,
        rules: 1,
        actions: 3,
        events: 1,
        links: 7,
        workflows: 2,
        workflow_steps: 6,
      },
      capabilities: {
        action_count: 3,
        executable_action_count: 0,
        agent_step_count: 1,
        human_step_count: 1,
        wait_step_count: 1,
        subflow_step_count: 1,
      },
    });
    expect(result.workflow_graph.child_edges).toEqual([
      {
        parent_workflow_id: "workflow-main",
        parent_workflow_version: "1.0.0",
        step_id: "step-child",
        child_workflow_id: "workflow-child",
        child_workflow_version: "1.0.0",
        runtime_enforcement: false,
      },
    ]);
    expect(result.agent_contracts[0]!.eval_cases).toHaveLength(3);
    expect(result.agent_contracts[0]!.grants).toEqual([
      expect.objectContaining({
        action_id: "Action-Propose",
        effect: "internal_proposal_only",
        external: false,
        consequential_write: false,
      }),
    ]);
    expect(result.receipt_hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("rejects family content tampering before trusting the package digest", () => {
    const pkg = packageFixture();
    pkg.artifacts.objects[0].name = "Tampered";
    expectAdmissionError(
      () => admitOntologyPackageForShadow(pkg),
      "family-hash-mismatch",
    );
  });

  it("rejects family count and authored-order drift", () => {
    const countDrift = packageFixture();
    countDrift.manifest.families.actions.artifact_count += 1;
    expectAdmissionError(
      () => admitOntologyPackageForShadow(countDrift),
      "family-count-mismatch",
    );

    const orderDrift = packageFixture();
    orderDrift.manifest.families.actions.ordered_artifact_ids.reverse();
    expectAdmissionError(
      () => admitOntologyPackageForShadow(orderDrift),
      "family-order-mismatch",
    );
  });

  it("rejects a whole-package hash mismatch independently of family integrity", () => {
    const pkg = packageFixture();
    pkg.manifest.name = "Changed after sealing";
    expectAdmissionError(
      () => admitOntologyPackageForShadow(pkg),
      "package-hash-mismatch",
    );
  });

  it("enforces package identity, release, digest and schema-bundle pins", () => {
    const pkg = packageFixture();
    expectAdmissionError(
      () =>
        admitOntologyPackageForShadow(pkg, { expectedPackageId: "another" }),
      "package-identity-mismatch",
    );
    expectAdmissionError(
      () => admitOntologyPackageForShadow(pkg, { expectedRelease: "2.0.0" }),
      "package-release-mismatch",
    );
    expectAdmissionError(
      () =>
        admitOntologyPackageForShadow(pkg, {
          expectedPackageHash: `sha256:${"0".repeat(64)}`,
        }),
      "package-pin-mismatch",
    );
    const unsupported = packageFixture();
    unsupported.manifest.schema_bundle_version = "4.0.0";
    expectAdmissionError(
      () => admitOntologyPackageForShadow(unsupported),
      "unsupported-schema-bundle",
    );
  });

  it("fails closed on an unknown manifest schema version", () => {
    const pkg = packageFixture();
    pkg.manifest.schema_version = "2.0.0";
    expectAdmissionError(
      () => admitOntologyPackageForShadow(pkg),
      "unsupported-manifest-schema",
    );
  });

  it("validates the complete envelope and all six artifact families with the vendored schemas", () => {
    const missingManifestField = packageFixture();
    delete missingManifestField.manifest.description;
    expectAdmissionError(
      () => admitOntologyPackageForShadow(missingManifestField),
      "package-schema-invalid",
    );

    const invalidArtifact = packageFixture();
    delete invalidArtifact.artifacts.actions[0].description;
    expectAdmissionError(
      () => admitOntologyPackageForShadow(invalidArtifact),
      "package-schema-invalid",
    );
  });

  it("requires canonical family schema ids and basename-only filenames", () => {
    const wrongSchema = packageFixture();
    wrongSchema.manifest.families.objects.schema_id =
      "https://schemas.example.test/3.2.0/objects.schema.json";
    expectAdmissionError(
      () => admitOntologyPackageForShadow(wrongSchema),
      "family-schema-id-mismatch",
    );

    for (const filename of [
      "../objects.json",
      "nested/objects.json",
      "..\\objects.json",
    ]) {
      const unsafeFilename = packageFixture();
      unsafeFilename.manifest.families.objects.filename = filename;
      expectAdmissionError(
        () => admitOntologyPackageForShadow(unsafeFilename),
        "family-filename-invalid",
      );
    }
  });

  it("reconciles manifest coverage with the admitted artifact payload", () => {
    const pkg = packageFixture();
    pkg.manifest.coverage.objects += 1;
    expectAdmissionError(
      () => admitOntologyPackageForShadow(pkg),
      "coverage-count-mismatch",
    );
  });

  it("rejects any executable Action even when every package hash is internally consistent", () => {
    const pkg = packageFixture();
    pkg.artifacts.actions[0].implementation.executable = true;
    sealPackage(pkg);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(pkg),
      "executable-action-forbidden",
    );
  });

  it("rejects activated Agent contracts, unsafe grants and inner hash drift", () => {
    const activated = packageFixture();
    activated.manifest.extensions.agent_contracts[0].deployment_status =
      "deployed";
    sealPackage(activated);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(activated),
      "agent-contract-not-shadow-only",
    );

    const unsafeGrant = packageFixture();
    unsafeGrant.manifest.extensions.agent_contracts[0].grants[0].external = true;
    sealPackage(unsafeGrant);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(unsafeGrant),
      "unsafe-agent-grant",
    );

    const promptDrift = packageFixture();
    promptDrift.manifest.extensions.agent_contracts[0].prompt_profile.system_instructions.push(
      "tampered",
    );
    promptDrift.manifest.package_hash = hashOntologyPackageJson(
      ontologyPackageHashPayload(promptDrift),
    );
    expectAdmissionError(
      () => admitOntologyPackageForShadow(promptDrift),
      "prompt-profile-hash-mismatch",
    );
  });

  it("cross-checks Agent grant semantics, Action kind and step authorization", () => {
    const wrongPermission = packageFixture();
    wrongPermission.manifest.extensions.agent_contracts[0].grants[0].permission =
      "execute_production_write";
    sealPackage(wrongPermission);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(wrongPermission),
      "unsafe-agent-grant",
    );

    const wrongEffect = packageFixture();
    wrongEffect.manifest.extensions.agent_contracts[0].grants[0].effect =
      "change_external_system";
    sealPackage(wrongEffect);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(wrongEffect),
      "unsafe-agent-grant",
    );

    const externalAction = packageFixture();
    externalAction.artifacts.actions[1].implementation = {
      kind: "external",
      operation_id: "changeExternalSystem",
      endpoint: "/external/change",
      executable: false,
    };
    sealPackage(externalAction);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(externalAction),
      "unsafe-agent-grant",
    );

    const humanAction = packageFixture();
    humanAction.artifacts.actions[1].actor = ["Human"];
    sealPackage(humanAction);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(humanAction),
      "unsafe-agent-grant",
    );

    const notProposalOnly = packageFixture();
    notProposalOnly.artifacts.actions[1].extensions.propose_only = false;
    sealPackage(notProposalOnly);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(notProposalOnly),
      "unsafe-agent-grant",
    );

    const externalSideEffect = packageFixture();
    externalSideEffect.artifacts.actions[1].side_effects = {
      external_calls: [
        {
          system: "metaERP",
          endpoint: "/external/change",
          method: "POST",
        },
      ],
    };
    sealPackage(externalSideEffect);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(externalSideEffect),
      "unsafe-agent-grant",
    );

    const notificationSideEffect = packageFixture();
    notificationSideEffect.artifacts.actions[1].side_effects = {
      notifications: [{ channel: "email" }],
    };
    sealPackage(notificationSideEffect);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(notificationSideEffect),
      "unsafe-agent-grant",
    );

    const dataChangeSideEffect = packageFixture();
    dataChangeSideEffect.artifacts.actions[1].side_effects = {
      data_changes: [
        {
          object_type: "Object-Plan",
          action: "MODIFY",
          property_impacted: ["status"],
        },
      ],
    };
    sealPackage(dataChangeSideEffect);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(dataChangeSideEffect),
      "unsafe-agent-grant",
    );

    const topLevelNotification = packageFixture();
    topLevelNotification.artifacts.actions[1].notifications = [
      { channel: "email" },
    ];
    sealPackage(topLevelNotification);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(topLevelNotification),
      "unsafe-agent-grant",
    );

    const toolUse = packageFixture();
    toolUse.artifacts.actions[1].tool_use = ["metaerp.write"];
    sealPackage(toolUse);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(toolUse),
      "unsafe-agent-grant",
    );

    const stepNotification = packageFixture();
    stepNotification.artifacts.actions[1].action_steps = [
      {
        order: "1",
        name: "Notify",
        description: "Notify a recipient.",
        object_type: "logic",
        notifications: [{ channel: "email" }],
      },
    ];
    sealPackage(stepNotification);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(stepNotification),
      "unsafe-agent-grant",
    );

    const stepDataChange = packageFixture();
    stepDataChange.artifacts.actions[1].action_steps = [
      {
        order: "1",
        name: "Modify",
        description: "Modify an object.",
        object_type: "logic",
        data_changes: [
          {
            object_type: "Object-Plan",
            action: "MODIFY",
            property_impacted: ["status"],
          },
        ],
      },
    ];
    sealPackage(stepDataChange);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(stepDataChange),
      "unsafe-agent-grant",
    );

    const toolStep = packageFixture();
    toolStep.artifacts.actions[1].action_steps = [
      {
        order: "1",
        name: "Call a tool",
        description: "Invoke a tool.",
        object_type: "tool",
      },
    ];
    sealPackage(toolStep);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(toolStep),
      "unsafe-agent-grant",
    );

    const disguisedExternalImplementation = packageFixture();
    disguisedExternalImplementation.artifacts.actions[1].implementation.endpoint =
      "/external/change";
    sealPackage(disguisedExternalImplementation);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(disguisedExternalImplementation),
      "unsafe-agent-grant",
    );

    const ungrantedStep = packageFixture();
    ungrantedStep.artifacts.workflows[1].steps[1].action_id = "Action-Record";
    sealPackage(ungrantedStep);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(ungrantedStep),
      "agent-step-action-not-granted",
    );

    const unusedGrant = packageFixture();
    unusedGrant.artifacts.actions[2].actor = ["Agent"];
    unusedGrant.artifacts.actions[2].extensions.propose_only = true;
    unusedGrant.manifest.extensions.agent_contracts[0].grants.push({
      ...structuredClone(
        unusedGrant.manifest.extensions.agent_contracts[0].grants[0],
      ),
      action_id: "Action-Record",
    });
    sealPackage(unusedGrant);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(unusedGrant),
      "unused-agent-grant",
    );
  });

  it("requires every candidate Agent prompt to be human-approved proposal-only", () => {
    const executionPrompt = packageFixture();
    executionPrompt.manifest.extensions.agent_contracts[0].prompt_profile.output_contract.mode =
      "execute_external";
    sealPackage(executionPrompt);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(executionPrompt),
      "unsafe-agent-prompt-contract",
    );

    const approvalBypass = packageFixture();
    approvalBypass.manifest.extensions.agent_contracts[0].prompt_profile.output_contract.human_approval_required = false;
    sealPackage(approvalBypass);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(approvalBypass),
      "unsafe-agent-prompt-contract",
    );
  });

  it("requires non-autonomous Agent subscriptions to match source emissions and target bindings", () => {
    const autonomous = packageFixture();
    autonomous.manifest.extensions.agent_contracts[0].subscriptions[0].autonomous_start = true;
    sealPackage(autonomous);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(autonomous),
      "unsafe-agent-subscription",
    );

    const sourceMismatch = packageFixture();
    sourceMismatch.manifest.extensions.agent_contracts[0].subscriptions[0].source_step_id =
      "step-human";
    sealPackage(sourceMismatch);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(sourceMismatch),
      "agent-subscription-emission-mismatch",
    );

    const missing = packageFixture();
    missing.manifest.extensions.agent_contracts[0].subscriptions = [];
    sealPackage(missing);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(missing),
      "agent-step-subscription-missing",
    );
  });

  it("rejects an unresolvable or version-drifting child workflow", () => {
    const pkg = packageFixture();
    pkg.artifacts.workflows[0].steps[1].extensions.pinned_workflow_version =
      "1.0.1";
    sealPackage(pkg);
    expectAdmissionError(
      () => admitOntologyPackageForShadow(pkg),
      "child-workflow-version-mismatch",
    );
  });

  it("builds a deterministic, closed-world and permanently non-deployable runtime plan", () => {
    const pkg = connectRuntimePlanFixture(packageFixture());
    const before = JSON.stringify(pkg);
    const options = {
      expectedPackageId: "test-purchase",
      expectedRelease: "1.0.0",
      expectedPackageHash: pkg.manifest.package_hash,
    };
    const plan = compileOntologyPackageRuntimePlan(pkg, options);

    expect(plan).toMatchObject({
      schema: "agentic-operator.ontology-package-runtime-plan-candidate/v1",
      source: {
        package_id: "test-purchase",
        release: "1.0.0",
        package_hash: pkg.manifest.package_hash,
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
        workflow_count: 2,
        action_count: 3,
        agent_count: 1,
        step_count: 6,
        child_edge_count: 1,
      },
      verification: {
        admission_recomputed: true,
        workflow_graph_references_closed: true,
        workflow_versions_pinned: true,
      },
    });
    expect(plan.actions.every((action) => !action.effective_executable)).toBe(
      true,
    );
    expect(plan.agent_contracts).toEqual([
      expect.objectContaining({
        id: "candidate-agent",
        deployment_status: "not_deployed",
        eval_status: "declared_not_run",
        runtime_binding_status: "unbound",
      }),
    ]);
    expect(plan.workflows.flatMap((workflow) => workflow.steps)).toHaveLength(
      6,
    );
    expect(plan.activation_blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining([
        "action-runtime-binding-required",
        "runtime-plan-import-path-disabled",
        "trusted-production-authorization-required",
        "synchronous-versioned-subflow-runtime-required",
        "durable-wait-scheduler-required",
      ]),
    );
    expect(compileOntologyPackageRuntimePlan(pkg, options)).toEqual(plan);
    expect(JSON.stringify(pkg)).toBe(before);
    expect(plan.plan_hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("requires exact external package pins and rejects dangling or cyclic workflow graphs", () => {
    const unpinned = connectRuntimePlanFixture(packageFixture());
    expectRuntimePlanError(
      () => compileOntologyPackageRuntimePlan(unpinned),
      "trusted-package-pins-required",
    );

    const dangling = connectRuntimePlanFixture(packageFixture());
    dangling.artifacts.workflows[0].steps[0].next[0].to_step_id =
      "step-not-in-workflow";
    sealPackage(dangling);
    expectRuntimePlanError(
      () =>
        compileOntologyPackageRuntimePlan(dangling, {
          expectedPackageId: "test-purchase",
          expectedRelease: "1.0.0",
          expectedPackageHash: dangling.manifest.package_hash,
        }),
      "unknown-next-step",
    );

    const cyclic = connectRuntimePlanFixture(packageFixture());
    cyclic.artifacts.workflows[0].steps[1].workflow_id = "workflow-main";
    sealPackage(cyclic);
    expectRuntimePlanError(
      () =>
        compileOntologyPackageRuntimePlan(cyclic, {
          expectedPackageId: "test-purchase",
          expectedRelease: "1.0.0",
          expectedPackageHash: cyclic.manifest.package_hash,
        }),
      "cyclic-subflow-graph",
    );
  });

  it("requires subflow bindings to cover every required child input artifact", () => {
    const pkg = addCompleteSubflowContract(
      connectRuntimePlanFixture(packageFixture()),
    );
    const options = {
      expectedPackageId: "test-purchase",
      expectedRelease: "1.0.0",
      expectedPackageHash: pkg.manifest.package_hash,
    };
    expect(
      compileOntologyPackageRuntimePlan(pkg, options).verification,
    ).toMatchObject({
      subflow_contracts_verified: 1,
      subflow_contracts_missing: 0,
    });

    const missingRequiredInput = structuredClone(pkg);
    missingRequiredInput.artifacts.workflows[0].steps[1].extensions.artifact_bindings.input_resolution =
      [];
    sealPackage(missingRequiredInput);
    expectRuntimePlanError(
      () =>
        compileOntologyPackageRuntimePlan(missingRequiredInput, {
          ...options,
          expectedPackageHash: missingRequiredInput.manifest.package_hash,
        }),
      "required-child-input-binding-mismatch",
    );
  });

  it("binds a subflow parent context to an authored step input of the patch target object type", () => {
    const missingStepInput = addCompleteSubflowContract(
      connectRuntimePlanFixture(packageFixture()),
    );
    missingStepInput.artifacts.workflows[0].steps[1].input_artifact_ids = [];
    sealPackage(missingStepInput);
    expectRuntimePlanError(
      () =>
        compileOntologyPackageRuntimePlan(missingStepInput, {
          expectedPackageId: "test-purchase",
          expectedRelease: "1.0.0",
          expectedPackageHash: missingStepInput.manifest.package_hash,
        }),
      "parent-context-artifact-not-step-input",
    );

    const mismatchedParentType = addCompleteSubflowContract(
      connectRuntimePlanFixture(packageFixture()),
    );
    const parentWorkflow = mismatchedParentType.artifacts.workflows[0];
    const otherObject = structuredClone(
      mismatchedParentType.artifacts.objects[0],
    );
    otherObject.id = "Object-Other";
    otherObject.name = "Other object";
    mismatchedParentType.artifacts.objects.push(otherObject);
    parentWorkflow.object_refs.push("Object-Other");
    parentWorkflow.artifacts.push({
      id: "Artifact-Other",
      name: "Other context",
      direction: "input",
      format: "application/json",
      object_type_id: "Object-Other",
      required: true,
    });
    const subflowStep = parentWorkflow.steps[1];
    subflowStep.input_artifact_ids = ["Artifact-Other"];
    subflowStep.extensions.artifact_bindings.parent_context_artifact_id =
      "Artifact-Other";
    subflowStep.extensions.artifact_bindings.output_merge.parent_artifact_id =
      "Artifact-Other";
    mismatchedParentType.artifacts.workflows[1].output_contracts[0].content_schema[
      "x-allmeta-context-patch"
    ].target_artifact_id = "Artifact-Other";
    sealPackage(mismatchedParentType);
    expectRuntimePlanError(
      () =>
        compileOntologyPackageRuntimePlan(mismatchedParentType, {
          expectedPackageId: "test-purchase",
          expectedRelease: "1.0.0",
          expectedPackageHash: mismatchedParentType.manifest.package_hash,
        }),
      "context-patch-parent-object-type-mismatch",
    );
  });

  it("rejects context patches whose target property or enum escapes the Data Type", () => {
    const invalidEnum = addCompleteSubflowContract(
      connectRuntimePlanFixture(packageFixture()),
    );
    invalidEnum.artifacts.workflows[1].output_contracts[0].content_schema.properties.value.enum =
      ["not-in-object-enum"];
    invalidEnum.artifacts.workflows[1].output_contracts[0].terminal_outcome_mapping[0].values =
      ["not-in-object-enum"];
    invalidEnum.artifacts.workflows[1].output_contracts[0].content_schema[
      "x-allmeta-context-patch"
    ].producer_outcomes[0].values = ["not-in-object-enum"];
    sealPackage(invalidEnum);
    expectRuntimePlanError(
      () =>
        compileOntologyPackageRuntimePlan(invalidEnum, {
          expectedPackageId: "test-purchase",
          expectedRelease: "1.0.0",
          expectedPackageHash: invalidEnum.manifest.package_hash,
        }),
      "context-patch-target-enum-mismatch",
    );

    const unknownProperty = addCompleteSubflowContract(
      connectRuntimePlanFixture(packageFixture()),
    );
    unknownProperty.artifacts.workflows[1].output_contracts[0].content_schema.properties.target_property.const =
      "missing-property";
    sealPackage(unknownProperty);
    expectRuntimePlanError(
      () =>
        compileOntologyPackageRuntimePlan(unknownProperty, {
          expectedPackageId: "test-purchase",
          expectedRelease: "1.0.0",
          expectedPackageHash: unknownProperty.manifest.package_hash,
        }),
      "context-patch-target-property-resolution-failed",
    );
  });

  it("requires every context-patch producer to output the patch artifact with matching outcomes", () => {
    const missingProducerOutput = addCompleteSubflowContract(
      connectRuntimePlanFixture(packageFixture()),
    );
    missingProducerOutput.artifacts.workflows[1].steps[2].output_artifact_ids =
      [];
    sealPackage(missingProducerOutput);
    expectRuntimePlanError(
      () =>
        compileOntologyPackageRuntimePlan(missingProducerOutput, {
          expectedPackageId: "test-purchase",
          expectedRelease: "1.0.0",
          expectedPackageHash: missingProducerOutput.manifest.package_hash,
        }),
      "context-patch-artifact-not-produced-by-source-step",
    );

    const outcomeDrift = addCompleteSubflowContract(
      connectRuntimePlanFixture(packageFixture()),
    );
    outcomeDrift.artifacts.workflows[1].output_contracts[0].content_schema.properties.value.enum =
      ["ready", "blocked"];
    outcomeDrift.artifacts.workflows[1].output_contracts[0].terminal_outcome_mapping[0].values =
      ["ready", "blocked"];
    outcomeDrift.artifacts.workflows[1].output_contracts[0].content_schema[
      "x-allmeta-context-patch"
    ].producer_outcomes[0].values = ["ready"];
    sealPackage(outcomeDrift);
    expectRuntimePlanError(
      () =>
        compileOntologyPackageRuntimePlan(outcomeDrift, {
          expectedPackageId: "test-purchase",
          expectedRelease: "1.0.0",
          expectedPackageHash: outcomeDrift.manifest.package_hash,
        }),
      "context-patch-producer-outcome-mismatch",
    );
  });

  it("cannot be migrated or bootstrapped as an executable WorkflowManifest", async () => {
    const pkg = connectRuntimePlanFixture(packageFixture());
    const plan = compileOntologyPackageRuntimePlan(pkg, {
      expectedPackageId: "test-purchase",
      expectedRelease: "1.0.0",
      expectedPackageHash: pkg.manifest.package_hash,
    });
    expect(WorkflowManifestSchema.safeParse(plan).success).toBe(false);
    expect(() => migrate(plan)).toThrow(
      "[workflow-manifest:non-runtime-candidate]",
    );

    const directory = mkdtempSync(
      path.join(tmpdir(), "ontology-runtime-plan-bootstrap-"),
    );
    temporaryDirectories.push(directory);
    writeFileSync(
      path.join(directory, "workflow.json"),
      JSON.stringify(plan),
      "utf8",
    );
    await expect(loadManifestFromDisk(directory)).rejects.toThrow(
      "[workflow-manifest:non-runtime-candidate]",
    );

    const compatibilityAttack = {
      ...plan,
      agents: plan.agent_contracts,
    };
    writeFileSync(
      path.join(directory, "workflow.json"),
      JSON.stringify(compatibilityAttack),
      "utf8",
    );
    await expect(loadManifestFromDisk(directory)).rejects.toThrow(
      "[workflow-manifest:non-runtime-candidate]",
    );

    const receiptAttack = {
      ...admitOntologyPackageForShadow(pkg, {
        expectedPackageId: "test-purchase",
        expectedRelease: "1.0.0",
        expectedPackageHash: pkg.manifest.package_hash,
      }),
      agents: plan.agent_contracts,
    };
    expect(() => migrate(receiptAttack)).toThrow(
      "[workflow-manifest:non-runtime-candidate]",
    );
    writeFileSync(
      path.join(directory, "workflow.json"),
      JSON.stringify(receiptAttack),
      "utf8",
    );
    await expect(loadManifestFromDisk(directory)).rejects.toThrow(
      "[workflow-manifest:non-runtime-candidate]",
    );
  });

  it("CLI writes and deterministically checks the shadow receipt and runtime plan without importing either", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "ontology-package-admission-"),
    );
    temporaryDirectories.push(directory);
    const source = path.join(directory, "package.json");
    const output = path.join(directory, "shadow-candidate.json");
    const runtimePlanOutput = path.join(directory, "runtime-plan.json");
    const pkg = connectRuntimePlanFixture(packageFixture());
    writeFileSync(source, JSON.stringify(pkg), "utf8");
    const lines: string[] = [];
    const io = {
      log: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
    };

    expect(
      await runPackageCli(
        [
          "--package",
          source,
          "--expected-id",
          "test-purchase",
          "--expected-release",
          "1.0.0",
          "--expected-hash",
          pkg.manifest.package_hash,
          "--out",
          output,
          "--runtime-plan-out",
          runtimePlanOutput,
        ],
        io,
      ),
    ).toBe(0);
    const written = JSON.parse(readFileSync(output, "utf8"));
    expect(written.admission.deployable).toBe(false);
    expect(written.schema).toBe(
      "agentic-operator.ontology-package-shadow-candidate/v1",
    );
    expect(lines.some((line) => line.includes("deployable=false"))).toBe(true);
    const writtenRuntimePlan = JSON.parse(
      readFileSync(runtimePlanOutput, "utf8"),
    );
    expect(writtenRuntimePlan).toMatchObject({
      schema: "agentic-operator.ontology-package-runtime-plan-candidate/v1",
      status: {
        deployable: false,
        runtime_import_allowed: false,
        external_dispatch: "forbidden",
      },
    });
    expect(lines.some((line) => line.startsWith("runtime_plan_hash="))).toBe(
      true,
    );

    expect(
      await runPackageCli(
        [
          "--package",
          source,
          "--expected-id",
          "test-purchase",
          "--expected-release",
          "1.0.0",
          "--expected-hash",
          pkg.manifest.package_hash,
          "--out",
          output,
          "--runtime-plan-out",
          runtimePlanOutput,
          "--check",
        ],
        io,
      ),
    ).toBe(0);
  });

  it("CLI requires all identity pins before persisting or checking a receipt", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "ontology-package-cli-pins-"),
    );
    temporaryDirectories.push(directory);
    const source = path.join(directory, "package.json");
    const output = path.join(directory, "shadow-candidate.json");
    const pkg = packageFixture();
    writeFileSync(source, JSON.stringify(pkg), "utf8");
    const errors: string[] = [];
    const io = { log: vi.fn(), error: (line: string) => errors.push(line) };

    expect(
      await runPackageCli(
        [
          "--package",
          source,
          "--expected-id",
          "test-purchase",
          "--expected-release",
          "1.0.0",
          "--out",
          output,
        ],
        io,
      ),
    ).toBe(2);
    expect(existsSync(output)).toBe(false);
    expect(errors.join("\n")).toContain("--expected-hash");

    expect(
      await runPackageCli(
        ["--package", source, "--out", output, "--check"],
        io,
      ),
    ).toBe(2);
    expect(errors.join("\n")).toContain("--expected-id");
    expect(errors.join("\n")).toContain("--expected-release");
  });

  it("CLI refuses direct and symlink aliases of the input package as --out", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "ontology-package-cli-alias-"),
    );
    temporaryDirectories.push(directory);
    const source = path.join(directory, "package.json");
    const alias = path.join(directory, "package-alias.json");
    const pkg = packageFixture();
    writeFileSync(source, JSON.stringify(pkg), "utf8");
    symlinkSync(source, alias);
    const errors: string[] = [];
    const io = { log: vi.fn(), error: (line: string) => errors.push(line) };
    const pinnedArgs = [
      "--package",
      source,
      "--expected-id",
      "test-purchase",
      "--expected-release",
      "1.0.0",
      "--expected-hash",
      pkg.manifest.package_hash,
      "--out",
    ];

    expect(await runPackageCli([...pinnedArgs, source], io)).toBe(1);
    expect(await runPackageCli([...pinnedArgs, alias], io)).toBe(1);
    expect(errors.join("\n")).toContain(
      "--out must not resolve to the input --package",
    );
    expect(JSON.parse(readFileSync(source, "utf8")).manifest.package_id).toBe(
      "test-purchase",
    );
  });

  it("CLI applies input-alias and output-separation guards to runtime-plan targets", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "ontology-runtime-plan-cli-alias-"),
    );
    temporaryDirectories.push(directory);
    const source = path.join(directory, "package.json");
    const symlinkAlias = path.join(directory, "package-symlink.json");
    const hardlinkAlias = path.join(directory, "package-hardlink.json");
    const sharedOutput = path.join(directory, "shared-output.json");
    const pkg = connectRuntimePlanFixture(packageFixture());
    writeFileSync(source, JSON.stringify(pkg), "utf8");
    symlinkSync(source, symlinkAlias);
    linkSync(source, hardlinkAlias);
    const errors: string[] = [];
    const io = { log: vi.fn(), error: (line: string) => errors.push(line) };
    const pinnedArgs = [
      "--package",
      source,
      "--expected-id",
      "test-purchase",
      "--expected-release",
      "1.0.0",
      "--expected-hash",
      pkg.manifest.package_hash,
    ];

    for (const unsafeTarget of [source, symlinkAlias, hardlinkAlias]) {
      expect(
        await runPackageCli(
          [...pinnedArgs, "--runtime-plan-out", unsafeTarget],
          io,
        ),
      ).toBe(1);
    }
    expect(
      await runPackageCli(
        [
          ...pinnedArgs,
          "--out",
          sharedOutput,
          "--runtime-plan-out",
          sharedOutput,
        ],
        io,
      ),
    ).toBe(1);
    expect(errors.join("\n")).toContain(
      "--runtime-plan-out must not resolve to the input --package",
    );
    expect(errors.join("\n")).toContain(
      "--out and --runtime-plan-out must resolve to different files",
    );
    expect(existsSync(sharedOutput)).toBe(false);
  });

  it("CLI refuses the project and configured runtime models roots, including symlinked parents", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "ontology-package-cli-models-"),
    );
    temporaryDirectories.push(directory);
    const source = path.join(directory, "package.json");
    const pkg = packageFixture();
    writeFileSync(source, JSON.stringify(pkg), "utf8");
    const errors: string[] = [];
    const io = { log: vi.fn(), error: (line: string) => errors.push(line) };
    const pinnedArgs = [
      "--package",
      source,
      "--expected-id",
      "test-purchase",
      "--expected-release",
      "1.0.0",
      "--expected-hash",
      pkg.manifest.package_hash,
      "--out",
    ];
    const projectModelsOutput = path.join(
      REPOSITORY_ROOT,
      "models",
      `.ontology-package-receipt-${process.pid}.json`,
    );
    const modelsAlias = path.join(directory, "models-alias");
    symlinkSync(path.join(REPOSITORY_ROOT, "models"), modelsAlias, "dir");

    expect(await runPackageCli([...pinnedArgs, projectModelsOutput], io)).toBe(
      1,
    );
    expect(
      await runPackageCli(
        [...pinnedArgs, path.join(modelsAlias, "receipt.json")],
        io,
      ),
    ).toBe(1);
    expect(existsSync(projectModelsOutput)).toBe(false);

    const configuredModels = path.join(directory, "configured-runtime-root");
    vi.stubEnv("AGENTIC_MODELS_DIR", configuredModels);
    expect(
      await runPackageCli(
        [...pinnedArgs, path.join(configuredModels, "nested", "receipt.json")],
        io,
      ),
    ).toBe(1);
    expect(errors.join("\n")).toContain(
      "must not target an Agentic Operator runtime models root",
    );
  });

  it("CLI refuses runtime-plan output in project or configured runtime models roots", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "ontology-runtime-plan-cli-models-"),
    );
    temporaryDirectories.push(directory);
    const source = path.join(directory, "package.json");
    const pkg = connectRuntimePlanFixture(packageFixture());
    writeFileSync(source, JSON.stringify(pkg), "utf8");
    const errors: string[] = [];
    const io = { log: vi.fn(), error: (line: string) => errors.push(line) };
    const pinnedArgs = [
      "--package",
      source,
      "--expected-id",
      "test-purchase",
      "--expected-release",
      "1.0.0",
      "--expected-hash",
      pkg.manifest.package_hash,
      "--runtime-plan-out",
    ];
    const projectModelsTarget = path.join(
      REPOSITORY_ROOT,
      "models",
      `.ontology-runtime-plan-${process.pid}.json`,
    );
    const modelsAlias = path.join(directory, "models-alias");
    symlinkSync(path.join(REPOSITORY_ROOT, "models"), modelsAlias, "dir");

    expect(await runPackageCli([...pinnedArgs, projectModelsTarget], io)).toBe(
      1,
    );
    expect(
      await runPackageCli(
        [...pinnedArgs, path.join(modelsAlias, "runtime-plan.json")],
        io,
      ),
    ).toBe(1);
    expect(existsSync(projectModelsTarget)).toBe(false);

    const configuredModels = path.join(directory, "configured-runtime-root");
    vi.stubEnv("AGENTIC_MODELS_DIR", configuredModels);
    expect(
      await runPackageCli(
        [
          ...pinnedArgs,
          path.join(configuredModels, "nested", "runtime-plan.json"),
        ],
        io,
      ),
    ).toBe(1);
    expect(errors.join("\n")).toContain(
      "--runtime-plan-out must not target an Agentic Operator runtime models root",
    );
  });

  it("CLI does not reject an unrelated directory merely because it is named models", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "ontology-package-cli-unrelated-models-"),
    );
    temporaryDirectories.push(directory);
    const source = path.join(directory, "package.json");
    const output = path.join(directory, "models", "shadow-candidate.json");
    const pkg = packageFixture();
    writeFileSync(source, JSON.stringify(pkg), "utf8");
    const io = { log: vi.fn(), error: vi.fn() };

    expect(
      await runPackageCli(
        [
          "--package",
          source,
          "--expected-id",
          "test-purchase",
          "--expected-release",
          "1.0.0",
          "--expected-hash",
          pkg.manifest.package_hash,
          "--out",
          output,
        ],
        io,
      ),
    ).toBe(0);
    expect(existsSync(output)).toBe(true);
  });
});
