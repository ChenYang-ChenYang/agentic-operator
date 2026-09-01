# OntoPlanet Ontology Package → Agentic Operator handoff

## Outcome

Agentic Operator now has a first-class admission and runtime-planning boundary
for immutable OntoPlanet Ontology Packages. It verifies the package, produces a
transport-neutral shadow inspection receipt and derives a closed-world runtime
plan candidate. It deliberately does **not** compile or publish an executable
Agentic Operator `WorkflowManifest`.

The reference receipt for `power-purchase@1.0.3` is:

`artifacts/ontology/power-purchase/v1_0_3/shadow_candidate_v1_0_3.json`

The reference runtime plan is:

`artifacts/ontology/power-purchase/v1_0_3/runtime_plan_candidate_v1_0_3.json`

It is bound to package hash
`sha256:893a26cf8c65b4194023301269f246d43f74fc75a181d78731cc9dd273b8ca1c`
and receipt hash
`sha256:84a6164c9c791503bb960cd3f78d7701178c84ef6b644a15d78ac42708f1e6af`
(raw file SHA-256
`c469af2f21710fd9209b68bfe774c6342ab24d2064bd3e54f3860d01448d4179`).
The runtime plan has content hash
`sha256:c57260728814d87b416a2b065b31a387a4c155f6d1c1faa539fb6d2c469a0ace`
and raw file SHA-256
`8ca270a1436d04da517d8e5d7b3c5d8635ffc61391f77f5d21cf07648746c68a`.

## What admission proves

The package reader independently verifies:

- the complete envelope, manifest and all six artifact families against the
  byte-identical vendored OntoPlanet 3.2.0 schemas, pinned to upstream bundle
  SHA-256 `0c7ee809a0049c2ae4baabbf672bcb412ed49a8380ab42ab1ecace32658b0d86`;
- immutable package identity, release, canonical family schema IDs, safe
  filenames, coverage and all three externally supplied trust pins;
- all six artifact families, their counts, authored order and canonical hashes;
- the whole-package canonical hash over `{manifest without package_hash, artifacts}`;
- workflow Action references and pinned child-workflow versions;
- inner prompt-profile and candidate Agent-contract hashes;
- every candidate Agent prompt requires `mode=proposal_only` and
  `human_approval_required=true`;
- Agent grants use the exact candidate-internal/proposal-only semantics, target
  `Agent` Actions whose own `propose_only` flag is true, and reject every
  canonical external/tool, notification, and data-change carrier, including
  top-level, `side_effects`, `action_steps`, and implementation fields; grants
  form a bidirectional closure with agent-mode steps (no ungranted step and no
  unused grant);
- Agent subscriptions are non-autonomous workflow-bound fixtures whose source
  emission and target Agent binding both resolve exactly;
- every Action remains `implementation.executable=false`;
- every Agent contract remains `specified_not_activated`, `not_deployed` and
  `candidate_shadow_fixture_only`.

The generated Power-Purchase receipt records 65 Objects, 24 Rules, 52 Actions,
29 Events, 490 Links, 11 Workflows, 84 workflow steps and seven pinned subflow
edges. It also preserves the single proposal-only candidate Agent contract and
its three package-contained eval cases.

## Why the receipt is not deployable

OntoPlanet's workflow contract is currently stronger than Agentic Operator's
runtime manifest contract. In particular, Power-Purchase requires synchronous
version-pinned child workflows, parent checkpoints across durable child pauses,
contract-aware artifact/context-patch merge, source-evidence hash validation,
role/SoD enforcement and scheduler-backed Wait semantics.

Those guarantees are not inferred from similar-looking AO steps. The receipt
therefore hash-covers all of the following:

- `deployable=false`;
- `runtime_import_allowed=false`;
- all 52 Actions are not runtime-bound;
- all 11 Workflows are not activated;
- the candidate Agent is not deployed;
- all seven child edges still declare runtime enforcement disabled;
- the package's production Agentic Operator activation gate has not passed.

The receipt uses its own schema,
`agentic-operator.ontology-package-shadow-candidate/v1`, so it cannot be passed
to the normal manifest-import path by mistake.

## Non-deployable runtime plan

The independently derived
`agentic-operator.ontology-package-runtime-plan-candidate/v1` artifact requires
the same three exact external trust pins and reruns admission against the source
package. It closes every workflow-local graph reference, rejects unreachable
steps and child cycles, verifies all 53 named Action I/O bindings, validates all
seven synchronous child/context-patch contracts, records Wait semantics and
preserves the one inactive Agent contract with its eval status
`declared_not_run`.

The plan uses `agent_contracts` rather than the legacy manifest envelope's
`agents`. Shared compatibility normalization, migration and disk bootstrap also
reject the candidate schema explicitly, including a forged `agents` alias, so
copying or renaming the artifact into `models/` cannot activate it.

The verified real-package coverage is 11 Workflows, 84 steps, 52 Actions, one
Agent, seven child edges, 49 CEL conditions/100 declared tests, 68 workflow
artifacts, seven context-patch output contracts, 52 equality constraints and 34
event emissions. All 52 Actions remain effectively non-executable, all 84 steps
remain blocked and external dispatch remains forbidden. See
[the runtime-plan contract](power-purchase-runtime-plan.md).

## Reproduce and verify

Use the exact Node and pnpm versions pinned by this repository, then run:

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

Omitting `--out` performs a read-only validation and prints only the package and
receipt summary. Supplying `--out` or `--check` requires all three exact pins.
The CLI rejects the source package itself (including symlink/hard-link aliases)
and every configured Agentic Operator runtime `models` root as an output path.

## Verification

- `@agentic/ontology-compiler`: 56/56 tests passed (29 admission/planner/CLI, one
  vendored-schema integrity test, and 26 existing compiler tests).
- `@agentic/contracts`: 72/72 tests passed; `@agentic/runtime`: 233 Vitest tests
  passed with six environment-dependent skips, plus 51/51 Node tests passed.
- Agentic Operator monorepo typecheck: 28/28 workspaces passed.
- The real package `--check` deterministically reproduces receipt hash
  `sha256:84a6164c9c791503bb960cd3f78d7701178c84ef6b644a15d78ac42708f1e6af`.
- The same `--check` reproduces runtime-plan hash
  `sha256:c57260728814d87b416a2b065b31a387a4c155f6d1c1faa539fb6d2c469a0ace`.
- The root test command remains blocked before Turbo suites by the repository's
  pre-existing missing
  `artifacts/ontology/Agents-generation/v0_4_001/release_bundle_v0_4_001.json`
  fixture; this handoff does not fabricate it or claim that suite passed.

## Internal sign-off

- Agentic Operator security/architecture review: **SIGN-OFF** for immutable
  package admission, the shadow receipt and the Phase A non-deployable runtime
  plan. The reviewer verified fail-closed manifest normalization, migration and
  disk bootstrap; asynchronous-subflow/runtime gaps remain explicit blockers.
- Cross-repository Ontology/Product Owner review: **SIGN-OFF** for the bounded
  candidate scope, with package counts, hashes, 53/53 Action I/O bindings and
  all seven typed parent/child context contracts reconciled across repositories.
- Production Agentic Operator activation, metaERP execution and Gate C/D remain
  **BLOCKED** and are not part of either sign-off.

## Next activation milestone

The planning compiler now supplies the immutable membership and contract pins,
but activation remains a separate future milestone. Agentic Operator must
implement and test the missing runtime guarantees, bind real internal modules
separately from the source `executable` flag, and keep external metaERP
capabilities disabled until their individual contracts and sandbox evidence are
approved. Activation requires an externally authorized, reviewed record bound
to the exact plan and runtime build; it does not mutate
`power-purchase@1.0.3`.
