import path from "node:path";
import { existsSync } from "node:fs";

export interface CanonicalDataPaths {
  dataRoot: string;
  tenantsRoot: string;
  source: "AGENTIC_DATA_ROOT" | "DATABASE_URL" | "workspace";
}

function fileDatabaseDirectory(
  env: Record<string, string | undefined>,
  cwd: string,
): string | null {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl?.startsWith("file:")) return null;
  const rawPath = databaseUrl.slice("file:".length).split("?", 1)[0]?.trim();
  if (!rawPath || rawPath === ":memory:") return null;
  return path.dirname(path.resolve(cwd, rawPath));
}

function workspaceDataDirectory(cwd: string): string {
  let cursor = path.resolve(cwd);
  while (true) {
    if (existsSync(path.join(cursor, "pnpm-workspace.yaml"))) {
      return path.join(cursor, "data");
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return path.resolve(cwd, "data");
    cursor = parent;
  }
}

/**
 * Resolve the data root the way every OTHER filesystem surface in the repo does
 * (`packages/tools/src/fs/_shared.ts`): the env var when set (absolute, or
 * relative to cwd), otherwise the workspace root's `data/`, otherwise
 * `<cwd>/data`.
 *
 * `ensureCanonicalDataPaths` normalises `AGENTIC_DATA_ROOT` at api bootstrap,
 * so in a live server the two agree. This is the resolver for stores that can
 * also be reached OUTSIDE that bootstrap (tests, CLIs, workers): a bare
 * `"./data"` default there resolves against whatever cwd the process happens to
 * have, which strands files in `apps/api/data/` — the exact split
 * `ensureCanonicalDataPaths` exists to prevent. Read-side and delete-side of the
 * same store MUST share this one function, or a purge looks in a directory
 * nothing was ever written to.
 */
export function resolveDataRootPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const configured = env.AGENTIC_DATA_ROOT?.trim();
  if (configured) return path.resolve(cwd, configured);
  return workspaceDataDirectory(cwd);
}

/**
 * Make every API-owned file store share the SQLite data directory.
 *
 * pnpm runs a filtered workspace script with `apps/api` as cwd. Historical
 * `./data` defaults therefore split durable state between `<repo>/data` and
 * `apps/api/data`, depending on which package happened to open the file. The
 * database location is already the canonical deployment input, so derive the
 * remaining roots from it unless an operator explicitly supplied a root.
 */
export function ensureCanonicalDataPaths(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): CanonicalDataPaths {
  const configuredRoot = env.AGENTIC_DATA_ROOT?.trim();
  const databaseRoot = fileDatabaseDirectory(env, cwd);
  const dataRoot = configuredRoot
    ? path.resolve(cwd, configuredRoot)
    : databaseRoot ?? workspaceDataDirectory(cwd);
  const source: CanonicalDataPaths["source"] = configuredRoot
    ? "AGENTIC_DATA_ROOT"
    : databaseRoot
      ? "DATABASE_URL"
      : "workspace";

  env.AGENTIC_DATA_ROOT = dataRoot;
  env.AGENTIC_DATA_DIR ||= dataRoot;
  env.AGENTIC_TENANTS_DIR ||= path.join(dataRoot, "tenants");

  return {
    dataRoot,
    tenantsRoot: path.resolve(cwd, env.AGENTIC_TENANTS_DIR),
    source,
  };
}
