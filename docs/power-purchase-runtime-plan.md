# Power-Purchase package runtime-plan candidate

Date: 2026-09-01
Scope: `power-purchase@1.0.3` → deterministic, non-deployable Operator plan

## Result

Agentic Operator can now derive a closed-world runtime planning artifact directly
from the immutable OntoPlanet package. The planner is deliberately separate from
the legacy ontology compiler and from the executable `WorkflowManifest` schema.
It does not write `models/`, update the database, register a workflow or event,
start a timer, deploy an Agent, bind a tool, or call metaERP.

The reference artifact is
`artifacts/ontology/power-purchase/v1_0_3/runtime_plan_candidate_v1_0_3.json`.

| Identity                 | Value                                                                             |
| ------------------------ | --------------------------------------------------------------------------------- |
| Package                  | `power-purchase@1.0.3`                                                            |
| Package hash             | `sha256:893a26cf8c65b4194023301269f246d43f74fc75a181d78731cc9dd273b8ca1c`         |
| Admission receipt hash   | `sha256:84a6164c9c791503bb960cd3f78d7701178c84ef6b644a15d78ac42708f1e6af`         |
| Runtime-plan hash        | `sha256:c57260728814d87b416a2b065b31a387a4c155f6d1c1faa539fb6d2c469a0ace`         |
| Runtime-plan raw SHA-256 | `8ca270a1436d04da517d8e5d7b3c5d8635ffc61391f77f5d21cf07648746c68a`                |
| Schema                   | `agentic-operator.ontology-package-runtime-plan-candidate/v1`                     |
| Status                   | `deployable=false`; `runtime_import_allowed=false`; `external_dispatch=forbidden` |

## What the planner proves

The planner always re-reads the original package and reruns package admission. It
requires externally supplied package ID, release and package-hash pins; the shadow
receipt is integrity evidence, never an authority token or an input shortcut.

It then proves and hash-records:

- exact membership for 11 Workflows, 52 Actions, one inactive Agent contract and
  all 84 workflow steps;
- all entry, trigger, sequence, emitted-event, role, Rule, workflow artifact,
  event payload and output-contract source references are closed inside their
  declared package/workflow boundary;
- every workflow step is reachable from an authored entry and the seven-child
  call graph is acyclic;
- all child versions equal `1.0.3` and each child contract preserves its exact
  source hash;
- 53 Action steps resolve to the exact 53 named Action I/O variants, with no
  missing binding and no loss of the Action that is used in two distinct steps;
- all seven subflow contracts exactly cover every required child input; each
  parent context is an authored input of the calling step, has the same Data
  Type as the context-patch target, and resolves the output contract, merge
  target, active-time timeout and durable parent-checkpoint declaration;
- all seven context-patch schemas are closed four-field objects with constant
  target object/property, enumerated values and a SHA-256 evidence field;
- both Wait steps preserve timeout/clock/deadline and semantic wake-transition
  declarations while leaving their runtime event binding unbound;
- the Agent contract remains not deployed, its three eval cases remain
  `declared_not_run`, and its only grant remains the internal proposal Action;
- each source Action remains `executable=false`, each effective runtime Action
  remains false, and every one of the 84 runtime steps remains blocked.

Coverage is deterministic: 53 Action, 22 decision, seven subflow and two Wait
steps; 80 system, one Agent, two human and one hybrid modes; three human gates;
49 CEL conditions with 100 declared tests; 16 default edges; 68 artifacts; seven
output contracts; 52 artifact equality constraints; and 34 event emissions.

## Why this is not an execution manifest

The plan records authored contracts and unresolved runtime obligations. It does
not claim that Agentic Operator currently implements equivalent semantics. In
particular, the existing Operator `subflow` behavior is asynchronous fan-out,
whereas this package requires synchronous version-pinned children, durable
parent/child checkpoints and typed context-patch merge.

Production remains blocked until a separately reviewed activation design binds
and verifies at least:

- all 52 Action implementations and all 15 external metaERP contracts;
- exact CEL compiler/runtime attestation;
- synchronous child execution, durable pause/resume and context merge;
- durable Wait scheduling and trusted wake-event ingress;
- server-computed principal, role and separation-of-duties checks;
- evidence-hash recomputation, artifact storage and transactional event outbox;
- compiler/runtime build identity and an external, durable production approval.

The current runtime plan cannot be passed to manifest import or bootstrap. Its
Agent evidence field is deliberately named `agent_contracts`, not the legacy
manifest envelope's `agents`; the shared compatibility normalizer, runtime
migration and disk bootstrap also explicitly reject every version of the
candidate schema, including an attacker-added `agents` alias. The CLI separately
refuses the source package, receipt/plan path aliasing, and every default or
configured Operator runtime `models` root, including symlink and hard-link
aliases.

## Reproduce

Use this repository's pinned Node and pnpm versions:

```bash
pnpm ontology-package:inspect -- \
  --package /path/to/power-purchase/1.0.3/package.json \
  --expected-id power-purchase \
  --expected-release 1.0.3 \
  --expected-hash sha256:893a26cf8c65b4194023301269f246d43f74fc75a181d78731cc9dd273b8ca1c \
  --out artifacts/ontology/power-purchase/v1_0_3/shadow_candidate_v1_0_3.json \
  --runtime-plan-out artifacts/ontology/power-purchase/v1_0_3/runtime_plan_candidate_v1_0_3.json

pnpm ontology-package:inspect -- \
  --package /path/to/power-purchase/1.0.3/package.json \
  --expected-id power-purchase \
  --expected-release 1.0.3 \
  --expected-hash sha256:893a26cf8c65b4194023301269f246d43f74fc75a181d78731cc9dd273b8ca1c \
  --out artifacts/ontology/power-purchase/v1_0_3/shadow_candidate_v1_0_3.json \
  --runtime-plan-out artifacts/ontology/power-purchase/v1_0_3/runtime_plan_candidate_v1_0_3.json \
  --check
```

The second command must report both artifacts as `OK` and reproduce both content
hashes exactly.

## Verification and bounded sign-off

- Compiler: 56/56 tests passed (29 admission/planner/CLI, one schema-bundle
  integrity test and 26 existing compiler tests).
- Contracts: 72/72 tests passed. Runtime: 233 Vitest tests passed with six
  environment-dependent skips, plus 51/51 Node tests. Monorepo typecheck passed
  in all 28 workspaces.
- Architecture/security review: **SIGN-OFF** for this Phase A non-deployable
  runtime-plan candidate and its fail-closed import boundary.
- Ontology/product contract review: **SIGN-OFF** for the immutable package to
  candidate-plan mapping, including the seven typed parent/child context
  contracts.
- Production activation, executable-manifest generation, metaERP dispatch and
  Gate C/D remain **BLOCKED** and are outside both sign-offs.
