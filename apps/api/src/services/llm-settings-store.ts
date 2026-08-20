/**
 * Authoritative, revisioned AI settings store.
 *
 * Secrets are intentionally excluded by @agentic/contracts. The complete
 * non-secret store is atomically persisted to data/llm-settings.json and
 * mirrored as base64 plus a checksum inside a managed block in
 * apps/api/.env.local. API keys remain in the encrypted provider-key vault.
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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

/**
 * A non-test API must never persist operator-owned routing state beneath the
 * disposable test-run tree.  A leaked managed env block previously made a
 * real NewAPI revision disappear as soon as that test directory was cleaned.
 */
export function assertDurableLlmSettingsPath(
  path: string,
  runtime: { nodeEnv?: string; workspaceRoot?: string } = {},
): string {
  if ((runtime.nodeEnv ?? process.env.NODE_ENV) === "test") return path;
  const root = resolve(runtime.workspaceRoot ?? workspaceRoot());
  const ephemeralRoot = join(root, "data", "test-runs");
  const candidate = resolve(path);
  const fromEphemeralRoot = relative(ephemeralRoot, candidate);
  const isEphemeral =
    fromEphemeralRoot === "" ||
    (!fromEphemeralRoot.startsWith("..") && !isAbsolute(fromEphemeralRoot));
  if (isEphemeral) {
    throw new Error(
      `AGENTIC_LLM_SETTINGS_PATH must not use the disposable test-run tree outside NODE_ENV=test: ${candidate}`,
    );
  }
  return candidate;
}

export function llmSettingsPath(): string {
  const explicit = process.env.AGENTIC_LLM_SETTINGS_PATH?.trim();
  if (explicit) return assertDurableLlmSettingsPath(resolve(explicit));
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl?.startsWith("file:")) {
    return assertDurableLlmSettingsPath(
      resolve(dirname(dbUrl.slice(5)), "llm-settings.json"),
    );
  }
  return assertDurableLlmSettingsPath(
    join(workspaceRoot(), "data", "llm-settings.json"),
  );
}

/**
 * The JSON store and its env mirror are one persistence unit. In particular,
 * a test-owned JSON path must never be mirrored into the operator's real
 * `apps/api/.env.local`; that was the write-side hole left by guarding only
 * `AGENTIC_LLM_SETTINGS_PATH`.
 */
export function assertSafeLlmSettingsEnvMirrorPath(
  path: string,
  runtime: { nodeEnv?: string; workspaceRoot?: string } = {},
): string {
  const root = resolve(runtime.workspaceRoot ?? workspaceRoot());
  const candidate = resolve(path);
  const operatorMirror = join(root, "apps", "api", ".env.local");
  const ephemeralRoot = join(root, "data", "test-runs");
  const fromEphemeralRoot = relative(ephemeralRoot, candidate);
  const isEphemeral =
    fromEphemeralRoot === "" ||
    (!fromEphemeralRoot.startsWith("..") && !isAbsolute(fromEphemeralRoot));
  const nodeEnv = runtime.nodeEnv ?? process.env.NODE_ENV;

  if (nodeEnv === "test" && candidate === operatorMirror) {
    throw new Error(
      `test processes must not mirror AI settings into the operator env file: ${candidate}`,
    );
  }
  if (nodeEnv !== "test" && isEphemeral) {
    throw new Error(
      `AGENTIC_LLM_ENV_MIRROR_PATH must not use the disposable test-run tree outside NODE_ENV=test: ${candidate}`,
    );
  }
  return candidate;
}

export function llmSettingsEnvMirrorPath(): string {
  const explicit = process.env.AGENTIC_LLM_ENV_MIRROR_PATH?.trim();
  if (explicit) {
    return assertSafeLlmSettingsEnvMirrorPath(resolve(explicit));
  }
  if (process.env.NODE_ENV === "test") {
    // Default to the same invocation-scoped directory as the JSON store.
    // Tests that need a different mirror can still provide an explicit safe
    // path, but omission can no longer mutate a developer's live env file.
    return assertSafeLlmSettingsEnvMirrorPath(
      join(dirname(llmSettingsPath()), "llm-settings.env.local"),
    );
  }
  return assertSafeLlmSettingsEnvMirrorPath(
    join(workspaceRoot(), "apps", "api", ".env.local"),
  );
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

function revisionZeroEnvironmentFingerprint(settings: LlmSettings): string {
  return JSON.stringify(settings, (key, value) =>
    key === "updatedAt" ? undefined : value,
  );
}

/**
 * Revision zero is reserved for the auto-generated environment projection.
 * Keep that projection current without mutating any operator-owned revision.
 * Once settings are explicitly saved they become revision >= 1 and remain
 * pinned until another explicit save.
 */
function refreshRevisionZeroSettings(settings: LlmSettings): LlmSettings {
  if (settings.revision !== 0) return settings;
  const currentEnvironment = defaultLlmSettings();
  return revisionZeroEnvironmentFingerprint(settings) ===
    revisionZeroEnvironmentFingerprint(currentEnvironment)
    ? settings
    : currentEnvironment;
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
    const refreshed = refreshRevisionZeroSettings(settings);
    if (refreshed !== settings) {
      settings = refreshed;
      const next = {
        ...file,
        workspaces: { ...file.workspaces, [workspaceSlug]: settings },
      };
      sync = persistFile(next);
    } else {
      const content = canonicalJson(file);
      const envPath = llmSettingsEnvMirrorPath();
      const mirrorMessage = existsSync(envPath)
        ? envMirrorDriftMessage(readFileSync(envPath, "utf8"), content)
        : "the .env.local mirror is missing";
      sync = {
        status: mirrorMessage === null ? "synced" : "drift",
        jsonPath: llmSettingsPath(),
        envPath,
        checksum: checksum(content),
        message: mirrorMessage,
      };
    }
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
