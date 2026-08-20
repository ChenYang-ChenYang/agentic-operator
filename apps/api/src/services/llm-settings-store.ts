/**
 * Authoritative, revisioned AI settings store.
 *
 * Secrets are intentionally excluded by @agentic/contracts. The complete
 * non-secret store is atomically persisted to data/llm-settings.json and
 * mirrored as base64 plus a checksum inside a managed block in
 * apps/api/.env.local. API keys remain in the encrypted provider-key vault.
 *
 * Test processes must never touch the developer's real .env.local: a Vitest
 * run that resolves its settings JSON under data/test-runs/ used to leave a
 * managed block behind whose AGENTIC_LLM_SETTINGS_PATH silently rerouted the
 * next dev boot to test scratch. The mirror is therefore written only to an
 * explicit AGENTIC_LLM_ENV_MIRROR_PATH while under test, and non-test boots
 * ignore a persisted settings path that points into test-run scratch.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CORE_LLM_TASK_TAXONOMY,
  LlmSettingsSchema,
  PROVIDER_IDS,
  catalogModelForCandidate,
  catalogModelPolicy,
  defaultModelFor,
  findCatalogModel,
  parseModelRouteId,
  type LlmSettings,
  type ProviderId,
} from "@agentic/contracts";

const FILE_VERSION = 1 as const;
const ENV_BEGIN = "# BEGIN AGENTIC LLM SETTINGS (managed)";
const ENV_END = "# END AGENTIC LLM SETTINGS (managed)";

interface LlmSettingsFile {
  fileVersion: typeof FILE_VERSION;
  workspaces: Record<string, LlmSettings>;
}

export type SettingsSyncStatus = "synced" | "drift";

export interface LlmSettingsSnapshot {
  settings: LlmSettings;
  sync: {
    status: SettingsSyncStatus;
    jsonPath: string;
    envPath: string;
    checksum: string;
    message: string | null;
  };
}

export class LlmSettingsConflictError extends Error {
  override readonly name = "LlmSettingsConflictError";
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `AI settings revision conflict: expected ${expectedRevision}, current ${actualRevision}`,
    );
  }
}

let cache: LlmSettingsFile | null = null;
let cachePath: string | null = null;

function workspaceRoot(start = process.cwd()): string {
  let cursor = resolve(start);
  while (true) {
    if (existsSync(join(cursor, "pnpm-workspace.yaml"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(start);
    cursor = parent;
  }
}

function isTestProcess(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST !== undefined;
}

function isTestRunScratchPath(path: string): boolean {
  const resolved = resolve(path);
  const scratchRoots = [
    process.env.AGENTIC_API_TEST_RUN_ROOT?.trim(),
    join(workspaceRoot(), "data", "test-runs"),
  ];
  for (const root of scratchRoots) {
    if (!root) continue;
    const relativeToRoot = relative(resolve(root), resolved);
    if (
      relativeToRoot === "" ||
      (!relativeToRoot.startsWith("..") && !isAbsolute(relativeToRoot))
    ) {
      return true;
    }
  }
  // A managed block persisted from another checkout resolves outside this
  // workspace root; the conventional segment pair still identifies scratch.
  return resolved.includes(`${sep}data${sep}test-runs${sep}`);
}

const settingsPathWarnings = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (settingsPathWarnings.has(key)) return;
  settingsPathWarnings.add(key);
  console.warn(`[llm-settings] ${message}`);
}

export function llmSettingsPath(): string {
  const explicit = process.env.AGENTIC_LLM_SETTINGS_PATH?.trim();
  if (explicit) {
    const resolved = resolve(explicit);
    if (!isTestProcess()) {
      if (isTestRunScratchPath(resolved)) {
        warnOnce(
          `scratch:${resolved}`,
          `ignoring AGENTIC_LLM_SETTINGS_PATH=${explicit}: it points into test-run scratch (data/test-runs), most likely a stale managed block in apps/api/.env.local left behind by a test run. Remove that block; falling back to the default settings location.`,
        );
        return fallbackLlmSettingsPath();
      }
      if (!existsSync(resolved)) {
        const fallback = fallbackLlmSettingsPath();
        if (fallback !== resolved && existsSync(fallback)) {
          warnOnce(
            `missing:${resolved}`,
            `AGENTIC_LLM_SETTINGS_PATH=${explicit} does not exist yet while ${fallback} does; the explicit path is honored, but verify it is not a stale override.`,
          );
        }
      }
    }
    return resolved;
  }
  return fallbackLlmSettingsPath();
}

function fallbackLlmSettingsPath(): string {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl?.startsWith("file:")) {
    return resolve(dirname(dbUrl.slice(5)), "llm-settings.json");
  }
  return join(workspaceRoot(), "data", "llm-settings.json");
}

export function llmSettingsEnvMirrorPath(): string {
  const explicit = process.env.AGENTIC_LLM_ENV_MIRROR_PATH?.trim();
  if (explicit) return resolve(explicit);
  return join(workspaceRoot(), "apps", "api", ".env.local");
}

/**
 * Non-null when the .env.local mirror must not be written. An explicit
 * AGENTIC_LLM_ENV_MIRROR_PATH is always honored (tests point it at their
 * scratch dir); without one, the default target is the developer's real
 * apps/api/.env.local, which a test process must never rewrite.
 */
function envMirrorSkipReason(): string | null {
  if (process.env.AGENTIC_LLM_ENV_MIRROR_PATH?.trim()) return null;
  if (isTestProcess()) {
    return "env mirror skipped: test processes never write apps/api/.env.local (set AGENTIC_LLM_ENV_MIRROR_PATH to mirror into test scratch)";
  }
  if (isTestRunScratchPath(llmSettingsPath())) {
    return "env mirror skipped: AI settings resolve into test-run scratch (data/test-runs)";
  }
  return null;
}

function providerKind(provider: ProviderId) {
  if (provider === "openrouter") return "openrouter" as const;
  if (provider === "custom") return "openai-compatible" as const;
  if (provider === "mock") return "mock" as const;
  return "direct" as const;
}

function configuredDefault(): { provider: ProviderId; model: string } {
  const raw = process.env.LLM_DEFAULT_PROVIDER ?? process.env.LLM_PROVIDER;
  const provider = (PROVIDER_IDS as readonly string[]).includes(raw ?? "")
    ? (raw as ProviderId)
    : "mock";
  const configuredModel =
    (process.env.LLM_DEFAULT_MODEL ?? process.env.LLM_MODEL)?.trim() ||
    (provider === "mock" ? "mock-model-v1" : "default");
  const catalogModel = findCatalogModel(provider, configuredModel);
  const model =
    catalogModel && !catalogModelPolicy(catalogModel).selectable
      ? (defaultModelFor(provider) ?? configuredModel)
      : configuredModel;
  return { provider, model };
}

export function defaultLlmSettings(): LlmSettings {
  const selected = configuredDefault();
  const now = new Date().toISOString();
  return LlmSettingsSchema.parse({
    schemaVersion: 1,
    revision: 0,
    updatedAt: now,
    gatewayInstances: PROVIDER_IDS.map((provider) => ({
      id: provider,
      displayName:
        provider === "openrouter"
          ? "OpenRouter"
          : provider === "mock"
            ? "Mock (local)"
            : provider,
      kind: providerKind(provider),
      ...(providerKind(provider) === "direct" ? { providerId: provider } : {}),
      ...(provider === "custom"
        ? {
            baseUrl:
              process.env.CUSTOM_LLM_BASE_URL?.trim() ||
              "https://invalid.local/v1",
          }
        : {}),
      credentialRef: provider === "mock" ? undefined : provider,
      enabled:
        provider === "mock" ||
        provider === selected.provider ||
        Boolean(process.env[providerEnvName(provider)]),
      apiMode: "auto",
      timeouts:
        provider === "moonshot"
          ? { requestTimeoutMs: 7_200_000, maxRequestTimeoutMs: 7_200_000 }
          : provider === "openai" || provider === "anthropic"
            ? { requestTimeoutMs: 900_000, maxRequestTimeoutMs: 3_600_000 }
            : { requestTimeoutMs: 120_000, maxRequestTimeoutMs: 900_000 },
    })),
    taxonomy: CORE_LLM_TASK_TAXONOMY,
    defaultProfile: {
      workload: "balanced",
      candidates: [
        { route: `${selected.provider}/${selected.model}`, enabled: true },
      ],
    },
    taskProfiles: [],
  });
}

function providerEnvName(provider: ProviderId): string {
  const names: Partial<Record<ProviderId, string>> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    moonshot: "MOONSHOT_API_KEY",
    zai: "ZAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    gemini: "GOOGLE_API_KEY",
    groq: "GROQ_API_KEY",
    together: "TOGETHER_API_KEY",
    mistral: "MISTRAL_API_KEY",
    qwen: "QWEN_API_KEY",
    azure: "AZURE_OPENAI_API_KEY",
    custom: "CUSTOM_LLM_API_KEY",
  };
  return names[provider] ?? `LLM_${provider.toUpperCase()}_API_KEY`;
}

function emptyFile(): LlmSettingsFile {
  return { fileVersion: FILE_VERSION, workspaces: {} };
}

function normalizeFile(value: unknown): LlmSettingsFile {
  if (!value || typeof value !== "object") {
    throw new Error("AI settings file must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.fileVersion !== FILE_VERSION) {
    throw new Error(
      `unsupported AI settings file version: ${String(raw.fileVersion)}`,
    );
  }
  if (!raw.workspaces || typeof raw.workspaces !== "object") {
    throw new Error("AI settings file is missing workspaces");
  }
  const workspaces: Record<string, LlmSettings> = {};
  for (const [slug, settings] of Object.entries(
    raw.workspaces as Record<string, unknown>,
  )) {
    if (!/^[a-z0-9_-]{1,64}$/.test(slug)) {
      throw new Error(`invalid workspace slug in AI settings: ${slug}`);
    }
    workspaces[slug] = LlmSettingsSchema.parse(settings);
  }
  return { fileVersion: FILE_VERSION, workspaces };
}

function loadFile(): LlmSettingsFile {
  const path = llmSettingsPath();
  if (cache && cachePath === path) return cache;
  cachePath = path;
  if (!existsSync(path)) {
    cache = emptyFile();
    return cache;
  }
  try {
    cache = normalizeFile(JSON.parse(readFileSync(path, "utf8")));
    return cache;
  } catch (error) {
    throw new Error(
      `AI settings at ${path} are unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function canonicalJson(file: LlmSettingsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertSafeTarget(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`refusing to replace symlink: ${path}`);
  }
}

function atomicWrite(path: string, content: string): void {
  assertSafeTarget(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  const fd = openSync(temporary, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function managedEnvContent(existing: string, fileContent: string): string {
  const begin = existing.indexOf(ENV_BEGIN);
  const end = existing.indexOf(ENV_END);
  let preserved = existing;
  if (begin >= 0 || end >= 0) {
    if (
      begin < 0 ||
      end < begin ||
      existing.indexOf(ENV_BEGIN, begin + ENV_BEGIN.length) >= 0 ||
      existing.indexOf(ENV_END, end + ENV_END.length) >= 0
    ) {
      throw new Error(
        ".env.local contains a malformed managed AI settings block",
      );
    }
    preserved = `${existing.slice(0, begin)}${existing.slice(end + ENV_END.length)}`;
  }
  const jsonPath = llmSettingsPath();
  const envPath = llmSettingsEnvMirrorPath();
  const relativePath = relative(dirname(envPath), jsonPath) || jsonPath;
  const block = [
    ENV_BEGIN,
    `AGENTIC_LLM_SETTINGS_PATH=${relativePath}`,
    `AGENTIC_LLM_SETTINGS_SHA256=${checksum(fileContent)}`,
    `AGENTIC_LLM_SETTINGS_B64=${Buffer.from(fileContent, "utf8").toString("base64")}`,
    ENV_END,
  ].join("\n");
  const prefix = preserved.trimEnd();
  return `${prefix ? `${prefix}\n\n` : ""}${block}\n`;
}

function envMirrorDriftMessage(
  existing: string,
  fileContent: string,
): string | null {
  const begin = existing.indexOf(ENV_BEGIN);
  const end = existing.indexOf(ENV_END);
  if (begin < 0 || end < begin) {
    return "the .env.local mirror is missing its managed AI settings block";
  }
  if (
    existing.indexOf(ENV_BEGIN, begin + ENV_BEGIN.length) >= 0 ||
    existing.indexOf(ENV_END, end + ENV_END.length) >= 0
  ) {
    return "the .env.local mirror contains duplicate managed AI settings blocks";
  }

  const entries = new Map<string, string>();
  for (const line of existing
    .slice(begin + ENV_BEGIN.length, end)
    .split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      return "the .env.local managed AI settings block is malformed";
    }
    const key = trimmed.slice(0, separator);
    if (entries.has(key)) {
      return `the .env.local managed AI settings block repeats ${key}`;
    }
    entries.set(key, trimmed.slice(separator + 1));
  }

  const expectedPath =
    relative(dirname(llmSettingsEnvMirrorPath()), llmSettingsPath()) ||
    llmSettingsPath();
  if (entries.get("AGENTIC_LLM_SETTINGS_PATH") !== expectedPath) {
    return "the .env.local mirror points to a different AI settings file";
  }
  if (entries.get("AGENTIC_LLM_SETTINGS_SHA256") !== checksum(fileContent)) {
    return "the .env.local AI settings checksum is stale";
  }
  const encoded = entries.get("AGENTIC_LLM_SETTINGS_B64");
  if (!encoded) return "the .env.local AI settings payload is missing";
  try {
    if (Buffer.from(encoded, "base64").toString("utf8") !== fileContent) {
      return "the .env.local AI settings payload is stale";
    }
  } catch {
    return "the .env.local AI settings payload is invalid";
  }
  return null;
}

function persistFile(file: LlmSettingsFile): LlmSettingsSnapshot["sync"] {
  const jsonPath = llmSettingsPath();
  const envPath = llmSettingsEnvMirrorPath();
  const content = canonicalJson(file);
  atomicWrite(jsonPath, content);
  cache = file;
  cachePath = jsonPath;
  const skipReason = envMirrorSkipReason();
  if (skipReason) {
    return {
      status: "synced",
      jsonPath,
      envPath,
      checksum: checksum(content),
      message: skipReason,
    };
  }
  try {
    const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    atomicWrite(envPath, managedEnvContent(existing, content));
    return {
      status: "synced",
      jsonPath,
      envPath,
      checksum: checksum(content),
      message: null,
    };
  } catch (error) {
    return {
      status: "drift",
      jsonPath,
      envPath,
      checksum: checksum(content),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getLlmSettings(workspaceSlug: string): LlmSettingsSnapshot {
  if (!/^[a-z0-9_-]{1,64}$/.test(workspaceSlug)) {
    throw new Error("invalid workspace slug");
  }
  const file = loadFile();
  let settings = file.workspaces[workspaceSlug];
  let sync: LlmSettingsSnapshot["sync"];
  if (!settings) {
    settings = defaultLlmSettings();
    const next = {
      ...file,
      workspaces: { ...file.workspaces, [workspaceSlug]: settings },
    };
    sync = persistFile(next);
  } else {
    const content = canonicalJson(file);
    const envPath = llmSettingsEnvMirrorPath();
    const skipReason = envMirrorSkipReason();
    const mirrorMessage =
      skipReason ??
      (existsSync(envPath)
        ? envMirrorDriftMessage(readFileSync(envPath, "utf8"), content)
        : "the .env.local mirror is missing");
    sync = {
      status: skipReason || mirrorMessage === null ? "synced" : "drift",
      jsonPath: llmSettingsPath(),
      envPath,
      checksum: checksum(content),
      message: mirrorMessage,
    };
  }
  return { settings, sync };
}

export function saveLlmSettings(
  workspaceSlug: string,
  input: unknown,
  expectedRevision: number,
): LlmSettingsSnapshot {
  const current = getLlmSettings(workspaceSlug).settings;
  if (current.revision !== expectedRevision) {
    throw new LlmSettingsConflictError(expectedRevision, current.revision);
  }
  const parsed = LlmSettingsSchema.parse(input);
  assertSelectableTaskRoutes(parsed);
  const settings = LlmSettingsSchema.parse({
    ...parsed,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  });
  const file = loadFile();
  const next = {
    ...file,
    workspaces: { ...file.workspaces, [workspaceSlug]: settings },
  };
  return { settings, sync: persistFile(next) };
}

function assertSelectableTaskRoutes(settings: LlmSettings): void {
  const gateways = new Map(
    settings.gatewayInstances.map((gateway) => [gateway.id, gateway]),
  );
  const profiles = [settings.defaultProfile, ...settings.taskProfiles];
  for (const profile of profiles) {
    for (const candidate of profile.candidates) {
      const parsed = parseModelRouteId(candidate.route);
      const gateway = gateways.get(parsed.gatewayInstanceId);
      if (!gateway) continue;
      const model = catalogModelForCandidate(gateway, candidate);
      if (!model) continue;
      const policy = catalogModelPolicy(model);
      if (!policy.selectable) {
        throw new Error(
          `AI settings route ${candidate.route} is not selectable under model lifecycle policy (${policy.reason})`,
        );
      }
    }
  }
}

export function resyncLlmSettings(workspaceSlug: string): LlmSettingsSnapshot {
  const file = loadFile();
  const settings = file.workspaces[workspaceSlug] ?? defaultLlmSettings();
  const next = file.workspaces[workspaceSlug]
    ? file
    : {
        ...file,
        workspaces: { ...file.workspaces, [workspaceSlug]: settings },
      };
  return { settings, sync: persistFile(next) };
}

/** Test-only: force the next read to reload from the active path. */
export function _resetLlmSettingsCache(): void {
  cache = null;
  cachePath = null;
}
