/** Safe, read-only-by-default CLI for immutable Ontology Package admission. */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { canonicalJson } from "./canonical-json.ts";
import {
  loadOntologyPackageForShadow,
  type Sha256Digest,
} from "./package-admission.ts";
import { loadOntologyPackageRuntimePlan } from "./package-runtime-plan.ts";

const USAGE = `usage: ontology-package-inspect --package <package.json> [options]

Verifies an immutable OntoPlanet Ontology Package and builds a hash-bound,
explicitly non-deployable shadow receipt and optional runtime-plan candidate.

  --package          immutable package.json to inspect
  --expected-id      exact package_id pin (required with persistent output/check)
  --expected-release exact release pin (required with persistent output/check)
  --expected-hash    exact sha256 package hash pin (required with persistent output/check)
  --out              optional receipt path; omitted = validate/print summary only
  --runtime-plan-out optional non-deployable runtime-plan candidate path
  --check            compare computed artifacts with supplied output paths; never write
  --help             show this help

This command refuses every Agentic Operator runtime models root. It never
imports a runtime manifest, changes the database, registers Inngest, or enables
an Ontology Action.
`;

export interface PackageCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

function findAgenticOperatorRoot(): string | null {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifestPath = path.join(current, "package.json");
    const workspacePath = path.join(current, "pnpm-workspace.yaml");
    if (existsSync(manifestPath) && existsSync(workspacePath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          name?: unknown;
        };
        if (manifest.name === "agentic-operator") {
          return realpathSync.native(current);
        }
      } catch {
        // Keep walking. A nested, malformed manifest is not the workspace root.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolve symlinks in the longest existing prefix while retaining a not-yet-
 * created suffix. This lets output policy checks cover symlinked parents
 * without requiring the receipt to exist already.
 */
function canonicalPotentialPath(input: string): string {
  let existing = path.resolve(input);
  const missingSegments: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalPrefix = existsSync(existing)
    ? realpathSync.native(existing)
    : existing;
  return path.resolve(canonicalPrefix, ...missingSegments);
}

function isAtOrWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function pathsReferToSameFile(left: string, right: string): boolean {
  if (canonicalPotentialPath(left) === canonicalPotentialPath(right)) {
    return true;
  }
  if (!existsSync(left) || !existsSync(right)) return false;
  const leftStat = statSync(left);
  const rightStat = statSync(right);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

function runtimeModelsRoots(): string[] {
  const projectRoot = findAgenticOperatorRoot();
  if (!projectRoot) {
    throw new Error(
      "cannot establish the Agentic Operator project boundary for persistent output",
    );
  }
  const roots = [canonicalPotentialPath(path.join(projectRoot, "models"))];
  const configured = process.env.AGENTIC_MODELS_DIR?.trim();
  if (configured) {
    roots.push(
      canonicalPotentialPath(
        path.isAbsolute(configured)
          ? configured
          : path.resolve(process.cwd(), configured),
      ),
    );
  }
  return [...new Set(roots)];
}

function assertSafePersistentTarget(
  packagePath: string,
  target: string,
  optionName = "--out",
): void {
  if (pathsReferToSameFile(packagePath, target)) {
    throw new Error(`${optionName} must not resolve to the input --package`);
  }
  const canonicalTarget = canonicalPotentialPath(target);
  const blockedRoot = runtimeModelsRoots().find((root) =>
    isAtOrWithin(canonicalTarget, root),
  );
  if (blockedRoot) {
    throw new Error(
      `${optionName} must not target an Agentic Operator runtime models root (${blockedRoot})`,
    );
  }
}

function writeAtomically(target: string, contents: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export async function runPackageCli(
  argv: string[],
  io: PackageCliIo = { log: console.log, error: console.error },
): Promise<number> {
  let values: {
    package?: string;
    "expected-id"?: string;
    "expected-release"?: string;
    "expected-hash"?: string;
    out?: string;
    "runtime-plan-out"?: string;
    check?: boolean;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        package: { type: "string" },
        "expected-id": { type: "string" },
        "expected-release": { type: "string" },
        "expected-hash": { type: "string" },
        out: { type: "string" },
        "runtime-plan-out": { type: "string" },
        check: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    io.error(`ontology-package-inspect: ${(error as Error).message}`);
    io.error(USAGE);
    return 2;
  }

  if (values.help) {
    io.log(USAGE);
    return 0;
  }
  if (!values.package?.trim()) {
    io.error("ontology-package-inspect: --package is required");
    io.error(USAGE);
    return 2;
  }
  if (values.out !== undefined && !values.out.trim()) {
    io.error("ontology-package-inspect: --out must not be empty");
    return 2;
  }
  if (
    values["runtime-plan-out"] !== undefined &&
    !values["runtime-plan-out"].trim()
  ) {
    io.error("ontology-package-inspect: --runtime-plan-out must not be empty");
    return 2;
  }
  if (
    values.check &&
    values.out === undefined &&
    values["runtime-plan-out"] === undefined
  ) {
    io.error(
      "ontology-package-inspect: --check requires --out or --runtime-plan-out",
    );
    return 2;
  }
  if (values.out !== undefined || values["runtime-plan-out"] !== undefined) {
    const missingPins = [
      ["--expected-id", values["expected-id"]],
      ["--expected-release", values["expected-release"]],
      ["--expected-hash", values["expected-hash"]],
    ]
      .filter(([, value]) => !value?.trim())
      .map(([name]) => name);
    if (missingPins.length > 0) {
      io.error(
        `ontology-package-inspect: persistent output/check requires ${missingPins.join(
          ", ",
        )}`,
      );
      return 2;
    }
  }
  if (
    values["expected-hash"] &&
    !/^sha256:[0-9a-f]{64}$/u.test(values["expected-hash"])
  ) {
    io.error(
      "ontology-package-inspect: --expected-hash must be a lowercase sha256 digest",
    );
    return 2;
  }

  try {
    const packagePath = path.resolve(values.package);
    const target = values.out === undefined ? null : path.resolve(values.out);
    const runtimePlanTarget =
      values["runtime-plan-out"] === undefined
        ? null
        : path.resolve(values["runtime-plan-out"]);
    if (target) assertSafePersistentTarget(packagePath, target);
    if (runtimePlanTarget) {
      assertSafePersistentTarget(
        packagePath,
        runtimePlanTarget,
        "--runtime-plan-out",
      );
    }
    if (
      target &&
      runtimePlanTarget &&
      pathsReferToSameFile(target, runtimePlanTarget)
    ) {
      throw new Error(
        "--out and --runtime-plan-out must resolve to different files",
      );
    }
    const candidate = loadOntologyPackageForShadow(packagePath, {
      expectedPackageId: values["expected-id"],
      expectedRelease: values["expected-release"],
      expectedPackageHash: values["expected-hash"] as Sha256Digest | undefined,
    });
    const serialized = canonicalJson(candidate);
    const runtimePlan = runtimePlanTarget
      ? loadOntologyPackageRuntimePlan(packagePath, {
          expectedPackageId: values["expected-id"],
          expectedRelease: values["expected-release"],
          expectedPackageHash: values["expected-hash"] as Sha256Digest,
        })
      : null;
    const serializedRuntimePlan = runtimePlan
      ? canonicalJson(runtimePlan)
      : null;
    if (values.check && target) {
      if (!existsSync(target)) {
        io.error(`MISSING  ${target}`);
        return 1;
      }
      if (readFileSync(target, "utf8") !== serialized) {
        io.error(`DIFFERS  ${target}`);
        return 1;
      }
      io.log(`OK       ${target}`);
    } else if (target) {
      writeAtomically(target, serialized);
      io.log(`WROTE    ${target}`);
    }
    if (runtimePlanTarget && runtimePlan && serializedRuntimePlan) {
      if (values.check) {
        if (!existsSync(runtimePlanTarget)) {
          io.error(`MISSING  ${runtimePlanTarget}`);
          return 1;
        }
        if (readFileSync(runtimePlanTarget, "utf8") !== serializedRuntimePlan) {
          io.error(`DIFFERS  ${runtimePlanTarget}`);
          return 1;
        }
        io.log(`OK       ${runtimePlanTarget}`);
      } else {
        writeAtomically(runtimePlanTarget, serializedRuntimePlan);
        io.log(`WROTE    ${runtimePlanTarget}`);
      }
    }
    io.log(
      [
        `ontology-package-inspect: ${candidate.source_package.package_id}@${candidate.source_package.release}`,
        candidate.source_package.package_hash,
        `${candidate.artifact_counts.workflows} workflows/${candidate.artifact_counts.workflow_steps} steps`,
        `${candidate.capabilities.subflow_step_count} subflows`,
        `${candidate.agent_contracts.length} inactive Agent contract(s)`,
        "deployable=false",
      ].join(" | "),
    );
    io.log(`receipt_hash=${candidate.receipt_hash}`);
    if (runtimePlan) io.log(`runtime_plan_hash=${runtimePlan.plan_hash}`);
    return 0;
  } catch (error) {
    io.error(`ontology-package-inspect: ${(error as Error).message}`);
    return 1;
  }
}

export { USAGE as ONTOLOGY_PACKAGE_INSPECT_USAGE };
