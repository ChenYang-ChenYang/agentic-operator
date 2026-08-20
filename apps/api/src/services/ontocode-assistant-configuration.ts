/**
 * OntoCode assistant — carry a configuration change through, in band.
 *
 * Today the assistant can only *recommend* a deep link ("go configure it in
 * Settings"). This module lets it reason about WHICH system and WHICH declared
 * fields an FDE means, state an exact secret-free diff, take one explicit
 * in-band confirmation, and then apply the change through the SAME stores the
 * `/v1/system-profiles` and `/v1/integrations` routes use — under the real
 * human identity that owns the Session.
 *
 * Invariants this file exists to hold:
 *
 *  1. A secret VALUE never enters a plan, proposal, recommendation, assistant
 *     message, audit entry or profile row. Configuration records environment
 *     variable NAMES. A pasted secret is refused, the value is never echoed
 *     (not even truncated), and the refusal names the env var to set instead.
 *  2. Propose, then apply. `buildConfigurationProposal` never writes. Writing
 *     happens only in `applyConfigurationProposal`, and only for a proposal
 *     that a human confirmed with a server-minted directive.
 *  3. Applying records a real identity: the Session's `owner_user_id`. There is
 *     no synthesized, defaulted or borrowed confirmer — no owner means refuse.
 *  4. Only fields DECLARED by the resolved System Profile's `credential.fields`
 *     (plus the derived layers `requirementFor` already owns) are settable. An
 *     unknown or ambiguous system clarifies; it never guesses.
 *  5. A legacy env alias is a CHOICE, never a fix. Both names are presented
 *     with presence bits and the FDE picks one. Nothing is auto-migrated and no
 *     value is ever copied between names.
 *
 * Nothing here weakens an existing gate: deploy/promotion authorization is
 * untouched, and a secret field still degrades to the existing governed
 * Settings → Integrations deep link rather than accepting a value in chat.
 */

import { createHash } from "node:crypto";
import {
  isSecretField,
  type ConfigFieldSpec,
  type DerivedConfigField,
  type SystemConfigRequirement,
  type SystemProfileV1,
} from "@agentic/contracts";
import { canonicalEvidenceJson } from "@agentic/shared";
import { isSecretShapedString } from "@agentic/agent-factory";
import {
  summarizeFactoryDomainPreflight,
  type FactoryDomainPreflightReport,
  type PreflightBindingStatus,
} from "../../scripts/factory-domain-preflight";
import {
  buildSystemToolIndex,
  requirementFor,
  type IntegrationLite,
  type ToolEntryLite,
} from "./system-config-requirements";
import { norm } from "./system-coverage";
import type { IntegrationVerificationSnapshot } from "./integration-store";

export const ONTOCODE_CONFIGURATION_PROPOSAL_SCHEMA =
  "ontocode-configuration-proposal/v1" as const;
export const ONTOCODE_CONFIGURATION_APPLY_SCHEMA =
  "ontocode-configuration-apply/v1" as const;

/** Env var NAME grammar. A confirmed selection must match this exactly, which
 * is also why a pasted credential can never be mistaken for an env reference. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{2,127}$/;

/** Assignment separators an FDE actually types, EN + ZH. Used only to detect a
 * value being pasted next to a declared field name — never to read a secret. */
const ASSIGNMENT =
  "(?:[:=]|\\s*(?:是|为|改成|换成|改为|设为|设置为|更新为|轮换为|替换为)\\s*)";

// ─── Declared shape, current presence ────────────────────────────────────────

/** One declared field plus its CURRENT presence — booleans only, never a value. */
export interface ConfigurationFieldState {
  key: string;
  label: string;
  kind: string;
  required: boolean;
  secret: boolean;
  source: string;
  /** Environment variable NAME that can satisfy this field (never a value). */
  envRef: string | null;
  /** Whether that env var is set. `null` when the field declares no envRef. */
  envPresent: boolean | null;
  /** Whether a value is stored on the tenant integration row. Presence only. */
  storedValuePresent: boolean;
  satisfied: boolean;
}

export interface ConfigurationEnvOption {
  envRef: string;
  present: boolean;
  role: "preferred" | "legacy";
  note?: string;
}

export type ConfigurationChange =
  /** A DECLARED NON-SECRET field with a value the FDE stated in chat. The value
   * is echoed back because that is the reviewable diff, and it is only ever
   * reached for a field the profile declares non-secret AND whose value is not
   * secret-shaped. */
  | {
      fieldKey: string;
      action: "set_value";
      target: "integration";
      newValue: string;
    }
  /** Two or more env var NAMES could satisfy this field. The FDE picks one.
   * Nothing is auto-selected and no value is copied between names. */
  | {
      fieldKey: string;
      action: "select_env_ref";
      options: ConfigurationEnvOption[];
      selected: null;
    }
  /** A secret field. It is never settable from chat — the value belongs in the
   * deployment environment or the Settings form. */
  | {
      fieldKey: string;
      action: "requires_environment";
      envRef: string | null;
      reason: string;
    }
  /** A non-secret field the FDE named without stating a value. */
  | {
      fieldKey: string;
      action: "awaiting_value";
      reason: string;
    };

export interface ConfigurationProposal {
  schema: typeof ONTOCODE_CONFIGURATION_PROPOSAL_SCHEMA;
  /** Content digest over the exact proposal body; the confirmation carries it. */
  digest: string;
  sessionId: string;
  ontologyDomain: string;
  system: string;
  profileId: string | null;
  provider: string | null;
  posture: SystemConfigRequirement["posture"];
  fields: ConfigurationFieldState[];
  changes: ConfigurationChange[];
  /** True when at least one change can actually be written after confirmation. */
  applicable: boolean;
  notes: string[];
}

// ─── Outcomes ────────────────────────────────────────────────────────────────

export interface ConfigurationSystemCandidate {
  system: string;
  profileId: string | null;
  provider: string | null;
  posture: SystemConfigRequirement["posture"];
}

export type ConfigurationProposalOutcome =
  | {
      kind: "secret_in_chat";
      /** Env var NAMES to set instead. Never a value, never a prefix. */
      envRefs: string[];
      fieldKeys: string[];
      message: string;
    }
  | {
      kind: "clarify";
      code:
        | "system_not_named"
        | "system_unknown"
        | "system_ambiguous"
        | "no_configurable_fields";
      question: string;
      candidates: ConfigurationSystemCandidate[];
    }
  | {
      kind: "proposal";
      proposal: ConfigurationProposal;
      /** Server-minted in-band confirmations. One per resolvable decision. */
      confirmations: ConfigurationConfirmationOption[];
    };

export interface ConfigurationConfirmationOption {
  /** Exact text the FDE sends back to authorize this change. */
  value: string;
  label: string;
  digest: string;
  pick: string | null;
}

// ─── Ports ───────────────────────────────────────────────────────────────────

export interface LegacyEnvAlternative {
  preferredEnv: string;
  alternatives: string[];
  migrationNote: string;
}

export interface ConfigurationProposalPorts {
  listSystemProfiles(tenantId: string): SystemProfileV1[];
  listToolEntries(input: {
    tenantId: string;
    tenantSlug: string;
    domain: string;
  }): Promise<ToolEntryLite[]>;
  getIntegrationSnapshot(
    tenantId: string,
    provider: string,
  ): IntegrationVerificationSnapshot | null;
  envPresent(name: string): boolean;
  /** Declared migration candidates for a domain/system. Data, never a default. */
  legacyEnvAlternatives(input: {
    domain: string;
    systemNames: string[];
  }): LegacyEnvAlternative[];
}

export interface ConfigurationApplyPorts extends ConfigurationProposalPorts {
  upsertSystemProfile(
    tenantId: string,
    profile: SystemProfileV1,
    opts: { confirmedBy: string },
  ): SystemProfileV1;
  upsertIntegration(input: {
    tenantId: string;
    provider: string;
    baseUrl?: string;
    plainFields?: Record<string, string>;
    createdBy?: string | null;
  }): { provider: string };
  readiness(input: {
    tenantId: string;
    tenantSlug: string;
    domain: string;
  }): Promise<ConfigurationReadinessSnapshot | null>;
  audit(entry: {
    tenantId: string;
    action: string;
    targetType: string;
    targetId: string;
    meta: Record<string, unknown>;
  }): void | Promise<void>;
}

// ─── Secret gate ─────────────────────────────────────────────────────────────

function fieldNameAliases(field: ConfigurationFieldState): string[] {
  return [...new Set([field.key, field.label, field.envRef ?? ""])]
    .map((name) => name.trim())
    .filter((name) => name.length >= 3);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Refuse a credential pasted into chat.
 *
 * Two independent detectors, both value-blind by construction — neither ever
 * returns, logs or echoes the matched text:
 *   · the shared `isSecretShapedString` scanner (bearer tokens, JWTs, sk-*
 *     keys, DSNs with inline credentials, `api_key=…` pairs);
 *   · an assignment next to a field the resolved profile DECLARES secret, where
 *     the assigned token is not itself a valid environment variable name.
 *
 * The second detector is derived from the profile — there is no hardcoded field
 * list — so a system with an unusual secret field is covered automatically.
 */
export function detectChatSecretExposure(
  userText: string,
  fields: ConfigurationFieldState[],
): { exposed: boolean; envRefs: string[]; fieldKeys: string[] } {
  const secretFields = fields.filter((field) => field.secret);
  const envRefs = [
    ...new Set(
      (secretFields.length > 0 ? secretFields : fields)
        .map((field) => field.envRef)
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort();

  if (isSecretShapedString(userText)) {
    return {
      exposed: true,
      envRefs,
      fieldKeys: secretFields.map((field) => field.key).sort(),
    };
  }

  const hitKeys: string[] = [];
  for (const field of secretFields) {
    for (const alias of fieldNameAliases(field)) {
      const pattern = new RegExp(
        `${escapeRegExp(alias)}\\s*${ASSIGNMENT}\\s*["'\`]?([^\\s"'\`，,；;。]{6,})`,
        "i",
      );
      const match = pattern.exec(userText);
      if (!match) continue;
      const token = match[1]!.trim();
      // An env var NAME is exactly what configuration is allowed to record.
      if (ENV_NAME.test(token)) continue;
      hitKeys.push(field.key);
      break;
    }
  }
  if (hitKeys.length > 0) {
    return { exposed: true, envRefs, fieldKeys: [...new Set(hitKeys)].sort() };
  }
  return { exposed: false, envRefs: [], fieldKeys: [] };
}

function secretRefusalMessage(envRefs: string[], fieldKeys: string[]): string {
  const named = envRefs.length
    ? `请把值写入部署环境变量 ${envRefs.join(" / ")}`
    : "请把值写入该系统档案声明的部署环境变量";
  const fields = fieldKeys.length ? `（对应字段 ${fieldKeys.join("、")}）` : "";
  return (
    `我没有读取、也没有保存你贴的这个值——密钥不能进入对话、计划、提案或档案。` +
    `${named}${fields}，或在 Settings → Integrations 的表单里填写；配置只记录环境变量的名字，不记录值。` +
    `你贴出的那条消息建议尽快作废并轮换该凭证。`
  );
}

// ─── Target resolution ───────────────────────────────────────────────────────

function profileMatches(profile: SystemProfileV1, wanted: string): boolean {
  const target = norm(wanted);
  if (!target) return false;
  return [profile.id, profile.name, ...profile.aliases].some(
    (name) => norm(name) === target,
  );
}

function profileContains(profile: SystemProfileV1, wanted: string): boolean {
  const target = norm(wanted);
  if (target.length < 3) return false;
  return [profile.id, profile.name, ...profile.aliases].some((name) => {
    const candidate = norm(name);
    return candidate.includes(target) || target.includes(candidate);
  });
}

export interface ConfigurationTargetResolution {
  state: "exact" | "ambiguous" | "unknown";
  profile?: SystemProfileV1;
  candidates: SystemProfileV1[];
}

/** Resolve a requested system name against the tenant's confirmed profiles.
 * Exact alias match wins; otherwise a bounded fuzzy pass that must land on
 * exactly one profile. Anything else is reported, never guessed. */
export function resolveConfigurationTarget(
  requested: string | undefined,
  profiles: SystemProfileV1[],
): ConfigurationTargetResolution {
  const wanted = requested?.trim() ?? "";
  if (!wanted) return { state: "unknown", candidates: profiles };
  const exact = profiles.filter((profile) => profileMatches(profile, wanted));
  if (exact.length === 1) return { state: "exact", profile: exact[0]!, candidates: exact };
  if (exact.length > 1) return { state: "ambiguous", candidates: exact };
  const fuzzy = profiles.filter((profile) => profileContains(profile, wanted));
  if (fuzzy.length === 1) return { state: "exact", profile: fuzzy[0]!, candidates: fuzzy };
  if (fuzzy.length > 1) return { state: "ambiguous", candidates: fuzzy };
  return { state: "unknown", candidates: profiles };
}

function systemCandidates(
  profiles: SystemProfileV1[],
): ConfigurationSystemCandidate[] {
  return profiles.slice(0, 12).map((profile) => ({
    system: profile.name,
    profileId: profile.id,
    provider: profile.credential?.provider?.trim() || null,
    posture: (profile.availability === "planned"
      ? "planned"
      : "fields") as SystemConfigRequirement["posture"],
  }));
}

// ─── Declared-field derivation ───────────────────────────────────────────────

function integrationLite(
  snapshot: IntegrationVerificationSnapshot | null,
): IntegrationLite | null {
  if (!snapshot) return null;
  return {
    // Presence sentinels only — the store's real values never reach this layer.
    baseUrl: snapshot.baseUrlPresent ? "configured" : null,
    hasKey: snapshot.apiKeyPresent,
    config: Object.fromEntries(
      snapshot.plainFieldKeys.map((key) => [key, "configured"]),
    ),
    secretKeysStored: [],
    enabled: snapshot.enabled,
  };
}

function fieldState(field: DerivedConfigField): ConfigurationFieldState {
  return {
    key: field.key,
    label: field.label,
    kind: field.kind,
    required: field.required,
    secret: isSecretField(field),
    source: field.source,
    envRef: field.envRef ?? null,
    envPresent: field.envPresent ?? null,
    storedValuePresent:
      field.kind !== "env_only" && field.satisfied && field.envPresent !== true,
    satisfied: field.satisfied,
  };
}

/** Derive the authoritative configurable surface of ONE system. Always goes
 * through `requirementFor`, so the field list is exactly what the profile (and
 * the tool/catalog layers it already owns) declares — never a hardcoded set. */
export function deriveConfigurationSurface(input: {
  system: string;
  profiles: SystemProfileV1[];
  toolEntries: ToolEntryLite[];
  integration: IntegrationVerificationSnapshot | null;
  envPresent(name: string): boolean;
}): { requirement: SystemConfigRequirement; fields: ConfigurationFieldState[] } {
  const integrationsByProvider = new Map<string, IntegrationLite>();
  const lite = integrationLite(input.integration);
  if (input.integration && lite) {
    integrationsByProvider.set(input.integration.provider, lite);
  }
  const requirement = requirementFor(input.system, {
    profiles: input.profiles,
    toolIndex: buildSystemToolIndex(input.toolEntries),
    integrationsByProvider,
    envPresent: input.envPresent,
  });
  return { requirement, fields: requirement.fields.map(fieldState) };
}

// ─── Value extraction (declared NON-SECRET fields only) ──────────────────────

/**
 * Pull the value an FDE stated for a DECLARED NON-SECRET field.
 *
 * Secret fields are excluded before this function is reached, and any candidate
 * that is itself secret-shaped is dropped, so this can never lift a credential
 * out of chat. `select` fields must match a declared option; `base_url` must
 * parse as an absolute http(s) URL — the same validation `PUT /v1/integrations`
 * performs.
 */
const SOURCE_PRIORITY: Record<string, number> = {
  profile: 0,
  tool: 1,
  catalog: 2,
  default: 3,
};

function acceptableFieldValue(
  field: ConfigurationFieldState,
  raw: string,
  specByKey: Map<string, ConfigFieldSpec>,
): string | null {
  const value = raw.replace(/[.,;:，。；]+$/u, "").trim();
  if (!value || isSecretShapedString(value)) return null;
  if (field.kind === "base_url") {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    } catch {
      return null;
    }
  }
  if (field.kind === "select") {
    const options = specByKey.get(field.key)?.options ?? [];
    if (!options.includes(value)) return null;
  }
  return value;
}

export function extractDeclaredFieldValues(
  userText: string,
  fields: ConfigurationFieldState[],
  specs: ReadonlyArray<ConfigFieldSpec>,
): Map<string, string> {
  const found = new Map<string, string>();
  const specByKey = new Map(specs.map((spec) => [spec.key, spec]));
  const settable = fields.filter(
    (field) => !field.secret && field.kind !== "env_only",
  );

  // Pass 1 — anchored on a name the field itself declares (key, label, envRef).
  for (const field of settable) {
    for (const alias of fieldNameAliases(field)) {
      const match = new RegExp(
        `${escapeRegExp(alias)}\\s*${ASSIGNMENT}\\s*["'\`]?([^\\s"'\`，,；;。]{1,400})`,
        "i",
      ).exec(userText);
      if (!match) continue;
      const value = acceptableFieldValue(field, match[1]!, specByKey);
      if (value !== null) {
        found.set(field.key, value);
        break;
      }
    }
  }

  // Pass 2 — a bare absolute URL ("把 endpoint 换成 https://…") satisfies at
  // most ONE endpoint field: the highest-priority DECLARED one pass 1 missed.
  // Without this bound a generic catalog/default `base_url` would silently
  // shadow the profile's own endpoint field.
  const endpointFields = settable
    .filter((field) => field.kind === "base_url")
    .sort(
      (left, right) =>
        (SOURCE_PRIORITY[left.source] ?? 9) - (SOURCE_PRIORITY[right.source] ?? 9),
    );
  if (endpointFields.length > 0 && !endpointFields.some((f) => found.has(f.key))) {
    const url = /\bhttps?:\/\/[^\s"'，,；;。)】]+/i.exec(userText)?.[0];
    const target = endpointFields[0]!;
    const value = url ? acceptableFieldValue(target, url, specByKey) : null;
    if (value !== null) found.set(target.key, value);
  }
  return found;
}

// ─── Confirmation directive ──────────────────────────────────────────────────

const CONFIRMATION_MARKER =
  /\[OCFG:1\s+digest=([a-f0-9]{16})(?:\s+pick=([A-Za-z_][A-Za-z0-9_]{0,127}))?\]/;

export interface ConfigurationConfirmationDirective {
  digest: string;
  pick: string | null;
}

/** Parse a server-minted in-band confirmation out of a user turn. Returns null
 * for ordinary chat, which is what keeps this path opt-in and explicit. */
export function parseConfigurationConfirmation(
  text: string,
): ConfigurationConfirmationDirective | null {
  const match = CONFIRMATION_MARKER.exec(text);
  if (!match) return null;
  return { digest: match[1]!, pick: match[2] ?? null };
}

function mintConfirmation(digest: string, pick: string | null): string {
  return pick
    ? `确认使用环境变量 ${pick} [OCFG:1 digest=${digest} pick=${pick}]`
    : `确认应用配置变更 [OCFG:1 digest=${digest}]`;
}

// ─── Proposal ────────────────────────────────────────────────────────────────

function proposalDigest(body: Omit<ConfigurationProposal, "digest">): string {
  return createHash("sha256")
    .update(canonicalEvidenceJson(body), "utf8")
    .digest("hex")
    .slice(0, 16);
}

export interface BuildConfigurationProposalInput {
  tenantId: string;
  tenantSlug: string;
  sessionId: string;
  domain: string;
  /** Raw FDE turn. Read for declared non-secret values and scanned for secrets. */
  userText: string;
  /** System the planner named. Never trusted — resolved against real profiles. */
  requestedSystem?: string | undefined;
  /** Field keys the planner named. Filtered against the declared surface. */
  requestedFieldKeys?: string[] | undefined;
}

export async function buildConfigurationProposal(
  input: BuildConfigurationProposalInput,
  ports: ConfigurationProposalPorts,
): Promise<ConfigurationProposalOutcome> {
  const profiles = ports.listSystemProfiles(input.tenantId);
  const resolution = resolveConfigurationTarget(input.requestedSystem, profiles);

  if (resolution.state !== "exact" || !resolution.profile) {
    // An unknown or ambiguous system must never be guessed. Still run the
    // secret scan first: a pasted credential is refused even when we cannot
    // tell which system it belongs to.
    const bare = detectChatSecretExposure(input.userText, []);
    if (bare.exposed) {
      return {
        kind: "secret_in_chat",
        envRefs: [],
        fieldKeys: [],
        message: secretRefusalMessage([], []),
      };
    }
    const candidates = systemCandidates(
      resolution.state === "ambiguous" ? resolution.candidates : profiles,
    );
    const names = candidates.map((candidate) => candidate.system);
    return {
      kind: "clarify",
      code: !input.requestedSystem?.trim()
        ? "system_not_named"
        : resolution.state === "ambiguous"
          ? "system_ambiguous"
          : "system_unknown",
      question: names.length
        ? `你要改哪个外部系统的配置？当前租户已建档的是：${names.join("、")}。请点名其中一个——我不会替你猜。`
        : "这个租户还没有任何外部系统档案，我没有可配置的字段可以依据。请先为该系统建档（Settings → 系统档案），再回来改配置。",
      candidates,
    };
  }

  const profile = resolution.profile;
  const toolEntries = await ports.listToolEntries({
    tenantId: input.tenantId,
    tenantSlug: input.tenantSlug,
    domain: input.domain,
  });
  const provider = profile.credential?.provider?.trim() || null;
  const surface = deriveConfigurationSurface({
    system: profile.name,
    profiles,
    toolEntries,
    integration: provider
      ? ports.getIntegrationSnapshot(input.tenantId, provider)
      : null,
    envPresent: ports.envPresent,
  });

  const secret = detectChatSecretExposure(input.userText, surface.fields);
  if (secret.exposed) {
    return {
      kind: "secret_in_chat",
      envRefs: secret.envRefs,
      fieldKeys: secret.fieldKeys,
      message: secretRefusalMessage(secret.envRefs, secret.fieldKeys),
    };
  }

  if (surface.fields.length === 0) {
    return {
      kind: "clarify",
      code: "no_configurable_fields",
      question: `${profile.name} 的系统档案没有声明任何可配置字段（posture=${surface.requirement.posture}）。要我改什么，得先在档案的 credential.fields 里声明它——我不会发明字段。`,
      candidates: systemCandidates([profile]),
    };
  }

  // ── Which declared fields are in scope for this turn ──────────────────────
  const declaredKeys = new Set(surface.fields.map((field) => field.key));
  const requested = (input.requestedFieldKeys ?? [])
    .map((key) => key.trim())
    .filter((key) => declaredKeys.has(key));
  const values = extractDeclaredFieldValues(
    input.userText,
    surface.fields,
    profile.credential?.fields ?? [],
  );

  const legacy = ports.legacyEnvAlternatives({
    domain: input.domain,
    systemNames: [profile.id, profile.name, ...profile.aliases],
  });
  const legacyByPreferred = new Map(
    legacy.map((entry) => [entry.preferredEnv, entry]),
  );

  const changes: ConfigurationChange[] = [];
  const notes: string[] = [];

  for (const field of surface.fields) {
    const stated = values.get(field.key);
    const alternative = field.envRef
      ? legacyByPreferred.get(field.envRef)
      : undefined;
    const inScope =
      requested.includes(field.key) ||
      stated !== undefined ||
      alternative !== undefined ||
      (requested.length === 0 && field.required && !field.satisfied);
    if (!inScope) continue;

    if (alternative) {
      // #5 — a legacy alias is a decision an operator signs, not a migration a
      // tool performs. Both names are offered with presence bits; no value is
      // read, copied or compared.
      const options: ConfigurationEnvOption[] = [
        {
          envRef: alternative.preferredEnv,
          present: ports.envPresent(alternative.preferredEnv),
          role: "preferred",
          note: alternative.migrationNote,
        },
        ...alternative.alternatives.map((envRef) => ({
          envRef,
          present: ports.envPresent(envRef),
          role: "legacy" as const,
          note: alternative.migrationNote,
        })),
      ];
      changes.push({
        fieldKey: field.key,
        action: "select_env_ref",
        options,
        selected: null,
      });
      notes.push(
        `${field.key}：存在多个可满足的环境变量名，必须由你明确选一个；我不会自动迁移，也不会复制任何值。`,
      );
      continue;
    }

    if (field.secret) {
      changes.push({
        fieldKey: field.key,
        action: "requires_environment",
        envRef: field.envRef,
        reason: field.envRef
          ? `这是声明为密钥的字段——值只能写进部署环境变量 ${field.envRef}，或在 Settings → Integrations 的表单里填写，绝不进对话。`
          : "这是声明为密钥的字段——值只能在 Settings → Integrations 的表单里填写，绝不进对话。",
      });
      continue;
    }

    if (stated !== undefined) {
      changes.push({
        fieldKey: field.key,
        action: "set_value",
        target: "integration",
        newValue: stated,
      });
      continue;
    }

    changes.push({
      fieldKey: field.key,
      action: "awaiting_value",
      reason: `这是非密钥字段（${field.kind}）——把你要写入的值直接说出来，我会先给你看确切的改动再落库。`,
    });
  }

  const applicableChanges = changes.filter(
    (change) => change.action === "set_value" || change.action === "select_env_ref",
  );
  const choices = changes.filter(
    (change): change is Extract<ConfigurationChange, { action: "select_env_ref" }> =>
      change.action === "select_env_ref",
  );
  // Every note must be settled BEFORE the digest is taken: the confirmation
  // carries that digest, and the apply path re-checks it against the persisted
  // body. A note appended afterwards would silently break that binding.
  if (choices.length > 1) {
    notes.push(
      "这次涉及多个环境变量名的选择，我一次只处理一个——先告诉我要先定哪个字段。",
    );
  }
  const body: Omit<ConfigurationProposal, "digest"> = {
    schema: ONTOCODE_CONFIGURATION_PROPOSAL_SCHEMA,
    sessionId: input.sessionId,
    ontologyDomain: input.domain,
    system: profile.name,
    profileId: profile.id,
    provider: surface.requirement.provider,
    posture: surface.requirement.posture,
    fields: surface.fields,
    changes,
    applicable: applicableChanges.length > 0,
    notes,
  };
  const proposal: ConfigurationProposal = { ...body, digest: proposalDigest(body) };

  const confirmations: ConfigurationConfirmationOption[] = [];
  if (choices.length === 1) {
    for (const option of choices[0]!.options) {
      confirmations.push({
        value: mintConfirmation(proposal.digest, option.envRef),
        label: `${option.role === "preferred" ? "用推荐名" : "用历史名"} ${option.envRef}`,
        digest: proposal.digest,
        pick: option.envRef,
      });
    }
  } else if (choices.length === 0 && applicableChanges.length > 0) {
    confirmations.push({
      value: mintConfirmation(proposal.digest, null),
      label: "确认并应用",
      digest: proposal.digest,
      pick: null,
    });
  }

  return { kind: "proposal", proposal, confirmations };
}

// ─── Apply ───────────────────────────────────────────────────────────────────

export type ConfigurationApplyOutcome =
  | {
      kind: "refused";
      code:
        | "no_owner_identity"
        | "proposal_not_found"
        | "proposal_drifted"
        | "nothing_applicable"
        | "choice_unresolved"
        | "pick_not_offered"
        | "autonomy_analysis_only"
        | "write_failed";
      message: string;
    }
  | {
      kind: "applied";
      schema: typeof ONTOCODE_CONFIGURATION_APPLY_SCHEMA;
      digest: string;
      system: string;
      profileId: string | null;
      provider: string | null;
      confirmedBy: string;
      confirmedAt: number;
      /** Field keys written and HOW — never a value except a declared
       * non-secret one the FDE stated and already reviewed in the proposal. */
      applied: Array<
        | { fieldKey: string; action: "set_value"; target: "integration"; newValue: string }
        | { fieldKey: string; action: "select_env_ref"; envRef: string }
      >;
      probeInvalidated: boolean;
      readiness: ConfigurationReadinessDelta;
    };

export interface ApplyConfigurationProposalInput {
  tenantId: string;
  tenantSlug: string;
  domain: string;
  sessionId: string;
  /** The Session's real owner. Empty/absent refuses — never synthesized. */
  ownerUserId: string | null;
  directive: ConfigurationConfirmationDirective;
  proposal: ConfigurationProposal | null;
}

/** Declared shape the apply path re-checks. A drift here means the profile
 * changed after the FDE reviewed the diff — refuse rather than write blind. */
function shapeKey(field: ConfigurationFieldState): string {
  return [
    field.key,
    field.kind,
    field.required ? "1" : "0",
    field.secret ? "1" : "0",
    field.source,
    field.envRef ?? "",
  ].join(" ");
}

export async function applyConfigurationProposal(
  input: ApplyConfigurationProposalInput,
  ports: ConfigurationApplyPorts,
): Promise<ConfigurationApplyOutcome> {
  const confirmedBy = input.ownerUserId?.trim() ?? "";
  if (!confirmedBy) {
    // #3 — no borrowed identity, no `auth.via` fallback, no "system".
    return {
      kind: "refused",
      code: "no_owner_identity",
      message:
        "这个 Session 没有可解析的归属人（owner_user_id 为空），我不能用任何替身身份签署配置变更。请由真实登录用户新开或接管该 Session 后再确认。",
    };
  }
  const proposal = input.proposal;
  if (!proposal || proposal.digest !== input.directive.digest) {
    return {
      kind: "refused",
      code: "proposal_not_found",
      message:
        "找不到与这次确认对应的配置提案（可能已过期或不属于本 Session）。请重新描述你要改的配置，我会重新给出确切改动再确认。",
    };
  }

  const profiles = ports.listSystemProfiles(input.tenantId);
  const resolution = resolveConfigurationTarget(proposal.system, profiles);
  if (resolution.state !== "exact" || !resolution.profile) {
    return {
      kind: "refused",
      code: "proposal_drifted",
      message: `系统档案 ${proposal.system} 在你确认之后发生了变化，我不会照旧提案落库。请重新发起这次配置修改。`,
    };
  }
  const profile = resolution.profile;
  const provider = profile.credential?.provider?.trim() || null;
  const toolEntries = await ports.listToolEntries({
    tenantId: input.tenantId,
    tenantSlug: input.tenantSlug,
    domain: input.domain,
  });
  const surface = deriveConfigurationSurface({
    system: profile.name,
    profiles,
    toolEntries,
    integration: provider
      ? ports.getIntegrationSnapshot(input.tenantId, provider)
      : null,
    envPresent: ports.envPresent,
  });
  const currentShapes = new Set(surface.fields.map(shapeKey));
  const touched = new Set(proposal.changes.map((change) => change.fieldKey));
  const drifted = proposal.fields
    .filter((field) => touched.has(field.key) && !currentShapes.has(shapeKey(field)))
    .map((field) => field.key);
  if (drifted.length > 0) {
    return {
      kind: "refused",
      code: "proposal_drifted",
      message: `字段 ${drifted.join("、")} 的声明在你确认之后变了（类型/必填/密钥性/环境变量名之一）。我不会按过期的提案写入——请重新发起。`,
    };
  }

  // ── Resolve the confirmed decisions ───────────────────────────────────────
  const setValues = proposal.changes.filter(
    (change): change is Extract<ConfigurationChange, { action: "set_value" }> =>
      change.action === "set_value",
  );
  const choices = proposal.changes.filter(
    (change): change is Extract<ConfigurationChange, { action: "select_env_ref" }> =>
      change.action === "select_env_ref",
  );
  if (setValues.length === 0 && choices.length === 0) {
    return {
      kind: "refused",
      code: "nothing_applicable",
      message:
        "这份提案里没有可由我落库的改动——密钥字段只能走部署环境变量或 Settings 表单。",
    };
  }
  let pickedEnv: { fieldKey: string; envRef: string } | null = null;
  if (choices.length > 0) {
    if (choices.length > 1) {
      return {
        kind: "refused",
        code: "choice_unresolved",
        message:
          "这次涉及多个环境变量名的选择，我一次只落一个。请先明确其中一个字段要用哪个环境变量名。",
      };
    }
    const choice = choices[0]!;
    const offered = choice.options.map((option) => option.envRef);
    if (!input.directive.pick || !offered.includes(input.directive.pick)) {
      return {
        kind: "refused",
        code: "pick_not_offered",
        message: `请从这两个环境变量名里明确选一个：${offered.join(" / ")}。我不会自动迁移，也不会把任何一个的值复制到另一个。`,
      };
    }
    pickedEnv = { fieldKey: choice.fieldKey, envRef: input.directive.pick };
  }

  const before = await ports.readiness({
    tenantId: input.tenantId,
    tenantSlug: input.tenantSlug,
    domain: input.domain,
  });

  const applied: Extract<ConfigurationApplyOutcome, { kind: "applied" }>["applied"] = [];
  let nextProfile = profile;

  try {
    if (pickedEnv) {
      // The env-reference decision lives on the System Profile: it is the
      // tenant's authoritative record of WHICH env var satisfies a field, and
      // `upsertSystemProfile` is the same write the reviewed
      // `PUT /v1/system-profiles` performs — including the confirmation stamp.
      const fields = (profile.credential?.fields ?? []).map((spec) =>
        spec.key === pickedEnv!.fieldKey
          ? { ...spec, envRef: pickedEnv!.envRef }
          : spec,
      );
      const previousEnvRef =
        proposal.fields.find((field) => field.key === pickedEnv!.fieldKey)?.envRef ??
        null;
      const envRefs = [
        ...new Set(
          [...(profile.credential?.envRefs ?? [])]
            .filter((name) => name !== previousEnvRef)
            .concat(pickedEnv.envRef),
        ),
      ];
      nextProfile = ports.upsertSystemProfile(
        input.tenantId,
        {
          ...profile,
          credential: { ...(profile.credential ?? {}), envRefs, fields },
        },
        { confirmedBy },
      );
      applied.push({
        fieldKey: pickedEnv.fieldKey,
        action: "select_env_ref",
        envRef: pickedEnv.envRef,
      });
    }

    if (setValues.length > 0) {
      if (!provider) {
        return {
          kind: "refused",
          code: "write_failed",
          message: `${profile.name} 的档案没有声明 credential.provider，没有可写入的集成记录。请先在系统档案里补上 provider。`,
        };
      }
      const plainFields: Record<string, string> = {};
      let baseUrl: string | undefined;
      for (const change of setValues) {
        if (change.fieldKey === "base_url") baseUrl = change.newValue;
        else plainFields[change.fieldKey] = change.newValue;
        applied.push({
          fieldKey: change.fieldKey,
          action: "set_value",
          target: "integration",
          newValue: change.newValue,
        });
      }
      ports.upsertIntegration({
        tenantId: input.tenantId,
        provider,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(Object.keys(plainFields).length > 0 ? { plainFields } : {}),
        createdBy: confirmedBy,
      });
    }
  } catch (error) {
    return {
      kind: "refused",
      code: "write_failed",
      message: `写入配置失败：${error instanceof Error ? error.message.slice(0, 400) : "unknown error"}`,
    };
  }

  const after = await ports.readiness({
    tenantId: input.tenantId,
    tenantSlug: input.tenantSlug,
    domain: input.domain,
  });

  const confirmedAt = nextProfile.provenance.confirmedAt ?? Date.now();
  // Awaited so the audit row is written before the FDE sees the receipt.
  await ports.audit({
    tenantId: input.tenantId,
    action: "ontocode.configuration.apply",
    targetType: "system_profile",
    targetId: profile.id,
    // Field NAMES, env var NAMES and presence only. No secret ever reaches an
    // audit row, and non-secret values are recorded as "changed", not echoed.
    meta: {
      system: profile.name,
      provider,
      sessionId: input.sessionId,
      confirmedBy,
      digest: proposal.digest,
      setValueFieldKeys: setValues.map((change) => change.fieldKey).sort(),
      selectedEnvRef: pickedEnv?.envRef ?? null,
      selectedFieldKey: pickedEnv?.fieldKey ?? null,
    },
  });

  return {
    kind: "applied",
    schema: ONTOCODE_CONFIGURATION_APPLY_SCHEMA,
    digest: proposal.digest,
    system: profile.name,
    profileId: profile.id,
    provider,
    confirmedBy,
    confirmedAt,
    applied,
    // Both write channels invalidate the previous connection verdict on
    // purpose: `upsertSystemProfile` strips `lastProbe` on a reviewed commit,
    // and `upsertIntegration` resets the row's health when a config field
    // changes. Configuration moved, so the old probe is no longer evidence.
    probeInvalidated:
      (pickedEnv !== null && Boolean(profile.lastProbe)) || setValues.length > 0,
    readiness: diffConfigurationReadiness(before, after),
  };
}

// ─── Readiness delta (real preflight binding logic) ──────────────────────────

export interface ConfigurationReadinessSnapshot {
  ready: boolean;
  counts: Record<PreflightBindingStatus, number>;
  blockedReasons: string[];
  blockedActions: string[];
}

export interface ConfigurationReadinessDelta {
  available: boolean;
  before: ConfigurationReadinessSnapshot | null;
  after: ConfigurationReadinessSnapshot | null;
  changed: boolean;
  unblockedActions: string[];
  newlyBlockedActions: string[];
  countDelta: Partial<Record<PreflightBindingStatus, number>>;
}

/**
 * Project a preflight report into the delta shape. The verdict itself comes
 * from `summarizeFactoryDomainPreflight` — the same pure binding logic the
 * `preflight:factory-domain` CLI and the deploy gate use. Nothing here
 * re-derives readiness by hand.
 */
export function configurationReadinessSnapshot(
  report: FactoryDomainPreflightReport,
): ConfigurationReadinessSnapshot {
  const blocked = [
    ...report.missing.config,
    ...report.missing.profileSelection,
    ...report.missing.probe,
    ...report.missing.binding,
  ].map((row) => row.action);
  return {
    ready: report.ready,
    counts: report.integrationBindings.counts,
    blockedReasons: [...report.blockedReasons].sort(),
    blockedActions: [...new Set(blocked)].sort(),
  };
}

export function summarizeConfigurationReadiness(
  evidence: Parameters<typeof summarizeFactoryDomainPreflight>[0],
): ConfigurationReadinessSnapshot {
  return configurationReadinessSnapshot(summarizeFactoryDomainPreflight(evidence));
}

export function diffConfigurationReadiness(
  before: ConfigurationReadinessSnapshot | null,
  after: ConfigurationReadinessSnapshot | null,
): ConfigurationReadinessDelta {
  if (!before || !after) {
    return {
      available: false,
      before,
      after,
      changed: false,
      unblockedActions: [],
      newlyBlockedActions: [],
      countDelta: {},
    };
  }
  const beforeBlocked = new Set(before.blockedActions);
  const afterBlocked = new Set(after.blockedActions);
  const countDelta: Partial<Record<PreflightBindingStatus, number>> = {};
  for (const status of new Set([
    ...Object.keys(before.counts),
    ...Object.keys(after.counts),
  ]) as Set<PreflightBindingStatus>) {
    const delta = (after.counts[status] ?? 0) - (before.counts[status] ?? 0);
    if (delta !== 0) countDelta[status] = delta;
  }
  const unblockedActions = [...beforeBlocked]
    .filter((action) => !afterBlocked.has(action))
    .sort();
  const newlyBlockedActions = [...afterBlocked]
    .filter((action) => !beforeBlocked.has(action))
    .sort();
  return {
    available: true,
    before,
    after,
    changed:
      before.ready !== after.ready ||
      unblockedActions.length > 0 ||
      newlyBlockedActions.length > 0 ||
      Object.keys(countDelta).length > 0,
    unblockedActions,
    newlyBlockedActions,
    countDelta,
  };
}
