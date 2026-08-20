import { z } from "zod";

/**
 * External System Profile v1 — the tenant-level, machine-readable declaration
 * of ONE external platform: who it is (canonical id + aliases), what it
 * offers (api / events / data capabilities), how it authenticates, and its
 * governance posture. This is the single authority for system-name aliases;
 * tool-registry `systems[]` arrays are only bootstrap hints.
 *
 * Profiles are proposed (AI-drafted or imported) and only become effective
 * after a human confirms them — provenance records that decision.
 */

export const SYSTEM_PROFILE_SCHEMA_VERSION = 1 as const;

export const SystemProfileIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9-]*$/, "profile id must be kebab-case (a-z, 0-9, -)");
export type SystemProfileId = z.infer<typeof SystemProfileIdSchema>;

const NameSchema = z.string().trim().min(1).max(200);

export const SystemApiCapabilitySchema = z
  .object({
    /** Operation name in the platform's own vocabulary, e.g. "parse-resume". */
    operation: z.string().trim().min(1).max(160),
    description: z.string().max(2_000).optional(),
    /** Implementation mapping into the tool registry (empty = not yet built). */
    toolName: z.string().trim().min(1).max(160).optional(),
    objectTypes: z.array(z.string().trim().min(1).max(160)).max(50).default([]),
  })
  .passthrough();
export type SystemApiCapability = z.infer<typeof SystemApiCapabilitySchema>;

export const SystemEventCapabilitySchema = z
  .object({
    /** inbound = the platform emits, we consume; outbound = we emit to it. */
    direction: z.enum(["inbound", "outbound"]),
    eventName: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).optional(),
    /** Free-form payload contract note (allow-list fields, lookup protocol…). */
    payloadContract: z.string().max(4_000).optional(),
  })
  .passthrough();
export type SystemEventCapability = z.infer<typeof SystemEventCapabilitySchema>;

export const SystemDataCapabilitySchema = z
  .object({
    objectType: z.string().trim().min(1).max(160),
    mode: z.enum(["read", "write", "readwrite"]),
    /** Statement-catalog / tool route that realizes the access, e.g. "entities.write". */
    via: z.string().trim().max(160).optional(),
  })
  .passthrough();
export type SystemDataCapability = z.infer<typeof SystemDataCapabilitySchema>;

export const SystemProfileProvenanceSchema = z
  .object({
    mode: z.enum(["manual", "ai-drafted", "imported"]),
    confirmedBy: z.string().max(200).optional(),
    confirmedAt: z.number().int().nonnegative().optional(),
    sourceNote: z.string().max(1_000).optional(),
  })
  .passthrough();
export type SystemProfileProvenance = z.infer<typeof SystemProfileProvenanceSchema>;

// ─── Config field specs (动态凭证/配置表单的单一来源) ─────────────────────────
//
// A profile may DECLARE what an operator must configure to connect the system
// (`credential.fields`). The Settings → Integrations form renders these specs
// deterministically — the "dynamic" comes from profile DATA, never from ad-hoc
// AI page generation. Specs describe field SHAPES only: envRef is an env var
// NAME, never a value; secret values never live in a profile.

export const ConfigFieldKindSchema = z.enum([
  /** The provider endpoint (stored first-class on the integration row). */
  "base_url",
  /** The primary API credential (stored encrypted first-class). */
  "api_key",
  /** Any additional secret (client_secret, webhook secret…) — encrypted bag. */
  "secret",
  /** Non-secret free text (region, org id, project id…) — plain config bag. */
  "text",
  /** Non-secret enumerated choice. */
  "select",
  /** Value lives ONLY in the deployment environment — UI shows the env var
   *  name + present/missing, never stores or displays the value. */
  "env_only",
]);
export type ConfigFieldKind = z.infer<typeof ConfigFieldKindSchema>;

export const ConfigFieldSpecSchema = z
  .object({
    /** Storage/lookup key, snake_case (e.g. "base_url", "client_secret"). */
    key: z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().trim().min(1).max(200),
    kind: ConfigFieldKindSchema.default("text"),
    required: z.boolean().default(false),
    /** Explicit secrecy override; defaults from kind via isSecretField(). */
    secret: z.boolean().optional(),
    /** Env var NAME (never a value) that can satisfy this field at runtime. */
    envRef: z.string().trim().min(1).max(160).optional(),
    placeholder: z.string().max(400).optional(),
    hint: z.string().max(1_000).optional(),
    /** For kind "select". */
    options: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  })
  .passthrough();
export type ConfigFieldSpec = z.infer<typeof ConfigFieldSpecSchema>;

/** Secrecy is explicit when declared, else derived from the field kind. */
export function isSecretField(spec: Pick<ConfigFieldSpec, "kind" | "secret">): boolean {
  return spec.secret ?? (spec.kind === "api_key" || spec.kind === "secret" || spec.kind === "env_only");
}

/** Which derivation layer produced a field (provenance for the UI/audit). */
export const ConfigFieldSourceSchema = z.enum(["profile", "tool", "catalog", "default"]);
export type ConfigFieldSource = z.infer<typeof ConfigFieldSourceSchema>;

export const DerivedConfigFieldSchema = ConfigFieldSpecSchema.extend({
  source: ConfigFieldSourceSchema,
  /** Value present (store or env) OR the field is optional. */
  satisfied: z.boolean(),
  /** When envRef declared: whether the env var is set (boolean only — never the value). */
  envPresent: z.boolean().optional(),
});
export type DerivedConfigField = z.infer<typeof DerivedConfigFieldSchema>;

/** The full derived configuration posture of ONE system — what (if anything)
 *  an operator must configure, rendered by Settings and the OntoCode workbench. */
export const SystemConfigRequirementSchema = z.object({
  /** Resolved Settings→Integrations provider key, when one exists. */
  provider: z.string().nullable(),
  posture: z.enum([
    /** Operator-configurable fields exist (the normal case). */
    "fields",
    /** Declared credential-free (public API / pure-event system). */
    "none",
    /** All fields live only in the deployment environment. */
    "env_only",
    /** Platform runtime provides it (LLM gateway / internal invoke) — nothing to configure. */
    "server_managed",
    /** Ontology plans it but the system is not built yet. */
    "planned",
    /** No known configuration channel — profile the system first. */
    "unsupported",
  ]),
  fields: z.array(DerivedConfigFieldSchema),
  /** True when every required field is satisfied (and posture is configurable). */
  satisfied: z.boolean(),
  note: z.string().optional(),
});
export type SystemConfigRequirement = z.infer<typeof SystemConfigRequirementSchema>;

export const SystemProfileV1Schema = z
  .object({
    $schemaVersion: z.literal(SYSTEM_PROFILE_SCHEMA_VERSION).default(SYSTEM_PROFILE_SCHEMA_VERSION),
    id: SystemProfileIdSchema,
    name: NameSchema,
    /** Every business/ontology name this system answers to (RAAS_System, 招聘平台…). */
    aliases: z.array(NameSchema).max(50).default([]),
    description: z.string().max(4_000).optional(),
    capabilities: z
      .object({
        api: z.array(SystemApiCapabilitySchema).max(200).default([]),
        events: z.array(SystemEventCapabilitySchema).max(200).default([]),
        data: z.array(SystemDataCapabilitySchema).max(200).default([]),
      })
      .default({ api: [], events: [], data: [] }),
    credential: z
      .object({
        /** Settings→Integrations provider key, e.g. "gohire". */
        provider: z.string().trim().max(120).optional(),
        /** Env var NAMES (never values) that must exist at runtime. */
        envRefs: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
        /** Operator-configurable field SPECS (shapes only, never values) —
         *  the authoritative layer the dynamic Settings form renders. */
        fields: z.array(ConfigFieldSpecSchema).max(40).default([]),
        /** Relative health-check path for the GENERIC connection probe (e.g.
         *  "/api/v1/health"). Defaults to "/health". Must be a same-origin
         *  relative path — never a full URL. */
        healthPath: z
          .string()
          .trim()
          .max(300)
          .regex(/^\/[^\s]*$/, "healthPath must start with '/'")
          .refine((p) => !p.includes(".."), "healthPath must not contain '..'")
          .optional(),
      })
      .passthrough()
      .optional(),
    /** Lifecycle: "planned" = the ontology references it but the platform is
     *  not built yet — no connection can exist; binding follows plannedFallback. */
    availability: z.enum(["live", "planned"]).default("live"),
    /** What generated agents do with actions touching a planned system:
     *  human_boundary = deploy with those actions routed to humans;
     *  block = keep the system in the deploy-readiness pending list. */
    plannedFallback: z.enum(["human_boundary", "block"]).default("block"),
    governance: z
      .object({
        /** True = deliberately handled by humans; binding treats it as a confirmed boundary. */
        humanBoundary: z.boolean().default(false),
        notes: z.string().max(2_000).optional(),
      })
      .passthrough()
      .optional(),
    /** Last connection-probe result — a real credentialed health call to this
     * system's provider (NOT a business-agent run). Written by the probe route,
     * separate from provenance so it never masquerades as human confirmation. */
    lastProbe: z
      .object({
        ok: z.boolean(),
        at: z.number().int().nonnegative(),
        provider: z.string().max(120).optional(),
        detail: z.string().max(2_000).optional(),
      })
      .passthrough()
      .optional(),
    provenance: SystemProfileProvenanceSchema,
  })
  .passthrough();
export type SystemProfileV1 = z.infer<typeof SystemProfileV1Schema>;
export type SystemProfileV1Input = z.input<typeof SystemProfileV1Schema>;

/** All identifying names of one profile (canonical id + display name + aliases). */
export function systemProfileNames(profile: Pick<SystemProfileV1, "id" | "name" | "aliases">): string[] {
  return [...new Set([profile.id, profile.name, ...profile.aliases].map((n) => n.trim()).filter(Boolean))];
}

/** One alias group per profile — the matching engines' input: any two names in
 *  the same group refer to the same external system. */
export function systemAliasGroups(
  profiles: ReadonlyArray<Pick<SystemProfileV1, "id" | "name" | "aliases">>,
): string[][] {
  return profiles.map(systemProfileNames).filter((group) => group.length > 1);
}
