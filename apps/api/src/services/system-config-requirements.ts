/**
 * System config requirements — derive, for ONE external system, what an
 * operator must configure to connect it (the dynamic Settings→Integrations
 * form + OntoCode workbench step ③ both render this).
 *
 * Derivation layers (first hit per field key wins — every layer is real data,
 * nothing is hardcoded per provider):
 *   1. profile  — the System Profile's `credential.fields` specs (FDE/AI
 *                 drafted, human-confirmed) + legacy `credential.envRefs`
 *                 (surfaced as env_only fields).
 *   2. tool     — tools whose capability declares this system: their
 *                 `credentialEnv[]` (→ api_key field) and `configSchema`
 *                 base_url key (→ base_url field).
 *   3. catalog  — the static INTEGRATION_PROVIDERS entry, when one matches.
 *   4. default  — generic base_url + api_key so a provider with no richer
 *                 declaration still gets the classic two-field form.
 *
 * Satisfaction reads VALUE PRESENCE only: stored on the integration row
 * (first-class baseUrl/hasKey, plain config bag, secret-bag key names) or an
 * env var being set (boolean — the value itself never crosses this layer).
 *
 * Pure over an injected context; the route composes DB/env lookups.
 */

import {
  INTEGRATION_PROVIDERS,
  isSecretField,
  type ConfigFieldSpec,
  type DerivedConfigField,
  type SystemConfigRequirement,
  type SystemProfileV1,
} from "@agentic/contracts";
import { norm } from "./system-coverage";

/** The slice of a tool-catalog entry this derivation reads. */
export interface ToolEntryLite {
  name: string;
  category: string;
  credentialEnv?: string[];
  configSchema?: Record<string, unknown>;
  capabilities?: ReadonlyArray<{ systems?: string[] }>;
}

/** The slice of an integration row satisfaction checks read (secret-free). */
export interface IntegrationLite {
  baseUrl: string | null;
  hasKey: boolean;
  config: Record<string, string>;
  secretKeysStored: string[];
  enabled: boolean;
}

export interface RequirementContext {
  profile?: SystemProfileV1 | undefined;
  /** Platform runtime satisfies this system (LLM gateway / internal invoke). */
  runtimeProvided?: boolean;
  /** Tools whose capability declares this system. */
  toolEntries: ToolEntryLite[];
  /** Integration-row lookup by resolved provider id. */
  getIntegration: (provider: string) => IntegrationLite | null;
  /** Env var presence check (NAME → set?). Never returns the value. */
  envPresent: (name: string) => boolean;
  /** When the CALLER already knows the provider id (requirements?provider=x),
   *  use it if no profile/tool/catalog resolves one — the operator then still
   *  gets the generic form instead of "unsupported". Coverage rows do NOT set
   *  this, so unknown systems keep steering to 建档 first. */
  fallbackProvider?: string;
}

/** norm(system name) → tool entries declaring it. Build once per request. */
export function buildSystemToolIndex(
  entries: ReadonlyArray<ToolEntryLite>,
): Map<string, ToolEntryLite[]> {
  const map = new Map<string, ToolEntryLite[]>();
  for (const entry of entries) {
    const systems = new Set(
      (entry.capabilities ?? []).flatMap((c) => c.systems ?? []).filter(Boolean),
    );
    for (const system of systems) {
      const k = norm(system);
      if (!k || k === "*") continue;
      const list = map.get(k) ?? [];
      list.push(entry);
      map.set(k, list);
    }
  }
  return map;
}

/** Resolve the Settings→Integrations provider id for a system. */
function resolveProvider(
  systemName: string,
  profile: SystemProfileV1 | undefined,
  toolEntries: ToolEntryLite[],
): string | null {
  const fromProfile = profile?.credential?.provider?.trim();
  if (fromProfile) return fromProfile;
  // Tools that carry a credential imply their category IS the provider key
  // (gohire tools → "gohire" — that's the lookup ghFetch uses).
  const credentialed = toolEntries.find((t) => (t.credentialEnv ?? []).length > 0);
  if (credentialed) return credentialed.category;
  const k = norm(systemName);
  const catalogHit = INTEGRATION_PROVIDERS.find(
    (p) => norm(p.id) === k || norm(p.name) === k,
  );
  return catalogHit?.id ?? null;
}

function envKeyToFieldKey(envName: string): string {
  const key = envName.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(key) ? key : `env_${key}`;
}

/** Value-presence check for one field against the store + env. */
function fieldSatisfied(
  spec: ConfigFieldSpec,
  integration: IntegrationLite | null,
  envPresent: (name: string) => boolean,
): { satisfied: boolean; envPresent?: boolean } {
  const envHit = spec.envRef ? envPresent(spec.envRef) : undefined;
  let hasValue = false;
  if (integration) {
    if (spec.key === "base_url") hasValue = Boolean(integration.baseUrl?.trim());
    else if (spec.key === "api_key") hasValue = integration.hasKey;
    else if (isSecretField(spec)) hasValue = integration.secretKeysStored.includes(spec.key);
    else hasValue = Boolean(integration.config[spec.key]?.trim());
  }
  if (spec.kind === "env_only") hasValue = false; // env-only never reads the store
  const satisfied = hasValue || envHit === true || !spec.required;
  return { satisfied, ...(envHit !== undefined ? { envPresent: envHit } : {}) };
}

export function deriveConfigRequirement(
  systemName: string,
  ctx: RequirementContext,
): SystemConfigRequirement {
  const { profile, toolEntries } = ctx;

  if (ctx.runtimeProvided) {
    return {
      provider: null,
      posture: "server_managed",
      fields: [],
      satisfied: true,
      note: "平台运行时提供（LLM 网关 / 内部调用）——无需外部配置。",
    };
  }

  const provider =
    resolveProvider(systemName, profile, toolEntries) ?? ctx.fallbackProvider?.trim() ?? null;

  if (profile?.availability === "planned") {
    return {
      provider,
      posture: "planned",
      fields: [],
      satisfied: false,
      note:
        profile.plannedFallback === "human_boundary"
          ? "本体已规划、系统未建成——相关动作按人工边界处理，建成后翻回 live 再配置。"
          : "本体已规划、系统未建成——保持在部署待办中，建成后翻回 live 再配置。",
    };
  }

  // ── Layered field derivation (first spec per key wins) ────────────────────
  const byKey = new Map<string, ConfigFieldSpec & { source: DerivedConfigField["source"] }>();
  const add = (spec: ConfigFieldSpec, source: DerivedConfigField["source"]): void => {
    if (!byKey.has(spec.key)) byKey.set(spec.key, { ...spec, source });
  };

  // 1a. Profile-declared field specs — the authoritative layer.
  for (const spec of profile?.credential?.fields ?? []) add(spec, "profile");
  // 1b. Legacy profile envRefs → env_only fields (value lives in deployment env).
  for (const envName of profile?.credential?.envRefs ?? []) {
    add(
      {
        key: envKeyToFieldKey(envName),
        label: envName,
        kind: "env_only",
        required: true,
        envRef: envName,
      } as ConfigFieldSpec,
      "profile",
    );
  }

  // 2. Tool-declared credentials for this system.
  if (provider) {
    const credEnvs = [...new Set(toolEntries.flatMap((t) => t.credentialEnv ?? []))];
    if (credEnvs.length > 0) {
      add(
        {
          key: "api_key",
          label: "API Key",
          kind: "api_key",
          required: true,
          envRef: credEnvs[0],
          hint: `工具声明的凭证；也可通过环境变量 ${credEnvs.join(" / ")} 提供。`,
        } as ConfigFieldSpec,
        "tool",
      );
    }
    if (toolEntries.some((t) => t.configSchema && "base_url" in t.configSchema)) {
      add(
        { key: "base_url", label: "Base URL", kind: "base_url", required: false } as ConfigFieldSpec,
        "tool",
      );
    }
  }

  // 3. Static catalog entry.
  const catalogEntry = provider
    ? INTEGRATION_PROVIDERS.find((p) => p.id === provider)
    : undefined;
  if (catalogEntry) {
    add(
      {
        key: "base_url",
        label: "Base URL",
        kind: "base_url",
        required: false,
        placeholder: catalogEntry.defaultBaseUrl,
      } as ConfigFieldSpec,
      "catalog",
    );
    add(
      { key: "api_key", label: "API Key", kind: "api_key", required: true } as ConfigFieldSpec,
      "catalog",
    );
  }

  // 4. Generic default — any resolved provider still gets the classic form.
  if (provider) {
    add(
      { key: "base_url", label: "Base URL", kind: "base_url", required: false } as ConfigFieldSpec,
      "default",
    );
    add(
      { key: "api_key", label: "API Key", kind: "api_key", required: true } as ConfigFieldSpec,
      "default",
    );
  }

  const integration = provider ? ctx.getIntegration(provider) : null;
  const fields: DerivedConfigField[] = [...byKey.values()].map((spec) => {
    const { source, ...rest } = spec;
    const state = fieldSatisfied(rest as ConfigFieldSpec, integration, ctx.envPresent);
    return { ...(rest as ConfigFieldSpec), source, ...state };
  });

  if (fields.length === 0) {
    // A confirmed profile with nothing to configure = declared credential-free;
    // no profile and no channel = we genuinely don't know how to connect it.
    return profile
      ? {
          provider,
          posture: "none",
          fields: [],
          satisfied: true,
          note: "档案未声明任何凭证/配置——按无凭证系统处理（公开 API 或纯事件型）。",
        }
      : {
          provider,
          posture: "unsupported",
          fields: [],
          satisfied: false,
          note: "无已知配置通道——先为该系统建档（可用 AI 起草），档案里声明 credential.fields。",
        };
  }

  const posture = fields.every((f) => f.kind === "env_only") ? "env_only" : "fields";
  const satisfied = fields.every((f) => f.satisfied);
  return { provider, posture, fields, satisfied };
}

/**
 * Route-facing composer: derive the requirement for a system NAME given plain
 * data (profiles + tool index + integration rows). Still pure — the route
 * supplies DB reads and the env checker.
 */
export function requirementFor(
  systemName: string,
  opts: {
    profiles: ReadonlyArray<SystemProfileV1>;
    toolIndex: Map<string, ToolEntryLite[]>;
    integrationsByProvider: Map<string, IntegrationLite>;
    runtimeProvided?: boolean;
    envPresent?: (name: string) => boolean;
    fallbackProvider?: string;
  },
): SystemConfigRequirement {
  const k = norm(systemName);
  const profile = opts.profiles.find((p) =>
    [p.id, p.name, ...p.aliases].some((n) => norm(n) === k),
  );
  const nameSet = new Set([systemName, ...(profile ? [profile.id, profile.name, ...profile.aliases] : [])]);
  const toolEntries = [
    ...new Set([...nameSet].flatMap((n) => opts.toolIndex.get(norm(n)) ?? [])),
  ];
  return deriveConfigRequirement(systemName, {
    profile,
    runtimeProvided: opts.runtimeProvided,
    toolEntries,
    getIntegration: (provider) => opts.integrationsByProvider.get(provider) ?? null,
    envPresent: opts.envPresent ?? ((name) => Boolean(process.env[name]?.trim())),
    fallbackProvider: opts.fallbackProvider,
  });
}

/** Locate the profile that OWNS a provider id (credential.provider match, then
 * profile-id match) — how the Settings page maps a provider back to a system. */
export function profileForProvider(
  provider: string,
  profiles: ReadonlyArray<SystemProfileV1>,
): SystemProfileV1 | undefined {
  const k = norm(provider);
  return (
    profiles.find((p) => norm(p.credential?.provider ?? "") === k) ??
    profiles.find((p) => norm(p.id) === k)
  );
}

/**
 * Route dynamic PUT `fields{}` values into store slots by their specs:
 * base_url/api_key → first-class columns; declared secret → encrypted bag;
 * declared non-secret → plain bag; UNKNOWN key → encrypted bag (fail closed —
 * a value we can't classify must never land in plaintext).
 */
export function splitDynamicFields(
  values: Record<string, string>,
  specs: ReadonlyArray<Pick<ConfigFieldSpec, "key" | "kind" | "secret">>,
): {
  baseUrl?: string;
  apiKey?: string;
  plainFields: Record<string, string>;
  secretFields: Record<string, string>;
} {
  const specByKey = new Map(specs.map((s) => [s.key, s]));
  const out: {
    baseUrl?: string;
    apiKey?: string;
    plainFields: Record<string, string>;
    secretFields: Record<string, string>;
  } = { plainFields: {}, secretFields: {} };
  for (const [rawKey, value] of Object.entries(values)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (key === "base_url") out.baseUrl = value;
    else if (key === "api_key") out.apiKey = value;
    else {
      const spec = specByKey.get(key);
      const secret = spec ? isSecretField(spec) : true; // unknown → secret, fail closed
      if (secret) out.secretFields[key] = value;
      else out.plainFields[key] = value;
    }
  }
  return out;
}
