/**
 * @agentic/tools/registry — the GLOBAL tool registry.
 *
 * Any tool exported here is callable by any agent in any tenant — the
 * tenant's manifest just lists the tool name in `tool_use[]`. The runtime
 * resolves names in this order ([packages/runtime/src/step-engine.ts]):
 *
 *   1. tenantRegistry.tools[name]   — tenant-native override (wins)
 *   2. globalToolRegistry.get(name) — this map
 *   3. MCP server tools             — namespaced "<server>.<tool>"
 *
 * That ordering lets a tenant ship a custom implementation that shadows
 * a global tool, while keeping the global as a known-good default for
 * everyone else.
 *
 * Per-tenant CONFIGURATION (no code change required) flows through the
 * manifest's `tool_use[i].config` blob into `ctx.config` on the handler.
 * Each tool documents its own config shape; see each tool's source file.
 *
 * To add a new global tool:
 *   1. Implement it under packages/tools/src/<category>/<name>.ts using
 *      `defineTool` from @agentic/agent-kit.
 *   2. Export it from `packages/tools/src/<category>/index.ts`.
 *   3. Add an entry to TOOL_DESCRIPTORS below — supply at least the
 *      descriptor + category + a one-line summary for the catalog UI.
 *   4. (Optional) Add config + usage examples in TOOL_METADATA so
 *      manifest authors can copy/paste working config blocks.
 *
 * Listing for the operator UI:
 *   `listGlobalTools()` returns the full catalog as plain JSON, consumed
 *   by GET /v1/tools and the portal's Tools view.
 */

import { createHash } from "node:crypto";
import { normalizeToolSchema } from "./declarative/schema-validation";
import type {
  ToolDescriptor,
  ToolWriteProbeLifecycle,
} from "@agentic/agent-kit";
import {
  inspectWriteProbeSafety,
  safeProbePath,
  type ToolConfigContract,
  type WriteProbeSafetyContract,
} from "@agentic/shared";

import {
  generateJdApi,
} from "./robohire";
import {
  gohireHealthApi,
  gohireMatchResumeApi,
  gohireParseResumeApi,
  gohireParseJdApi,
  gohireInviteCandidateApi,
} from "./gohire";
import { webSearch } from "./search";
import {
  readFromInbox,
  writeMarkdownToArchive,
  writeHtmlToArchive,
  appendToLog,
} from "./fs";
import { httpFetchTool } from "./http";
import { ping } from "./meta";
import {
  fetchActionRules,
  ontologyQuery,
  ontologyWriteInstance,
  ONTOLOGY_WRITE_INSTANCE_PROBE_SAFETY,
} from "./ontology";
import {
  persistRuleCheckAudit,
  recordsUpsert,
  RECORDS_UPSERT_PROBE_SAFETY,
} from "./records";
import { svgChart } from "./viz";
import { htmlToPdfTool } from "./report";
import { objectStoreGetObject } from "./object-store";
import {
  postgresExecuteStatement,
  postgresExecuteTransaction,
  POSTGRES_EXECUTE_STATEMENT_PROBE_SAFETY,
  POSTGRES_EXECUTE_TRANSACTION_PROBE_SAFETY,
} from "./postgres";
import { cryptoSha256 } from "./crypto";
import { documentConvert } from "./document";
import { inspectEnvironmentReferencesTool } from "./config";
import { metaerpInvoke } from "./metaerp";
import {
  browserOpenSession,
  browserNavigate,
  browserRead,
  browserClick,
  browserFill,
  browserScreenshot,
  browserCloseSession,
} from "./browser";
import { commsSendToAgent } from "./comms";

/** Per-field metadata used to render args / returns tables. */
export interface ToolFieldSchema {
  type: string;
  required?: boolean;
  description?: string;
  default?: unknown;
  /** Closed set of accepted JSON-primitive values. */
  allowedValues?: Array<string | number | boolean | null>;
}

/** What the handler does from the caller's point of view. `read_write` is
 * intentionally conservative for handlers whose exact operation is selected
 * by trusted runtime config (for example a statement catalog). */
export type ToolOperation = "read" | "compute" | "write" | "read_write";

/** Where a successful invocation can observe or mutate state. */
export type ToolEffectScope = "none" | "sandbox_local" | "external";

/** Reviewed sandbox dispatch posture. This is authorization metadata, unlike
 * the historical `sideEffect` documentation label below. */
export type ToolSandboxPolicy =
  | "pure"
  | "sandbox_local"
  | "live_external"
  | "requires_attempt_grant";

export interface ToolExecutionPolicy {
  operation: ToolOperation;
  effectScope: ToolEffectScope;
  sandboxPolicy: ToolSandboxPolicy;
}

/**
 * #EFFECT-READBACK (D6) — how a claimed write is CONFIRMED by reading it back.
 *
 * A tool that reports success while returning nothing usable is the exact
 * failure this exists for: RoboHire's `match-resume` wraps its analysis under
 * `data.data.*`, the normalizer read one level too shallow, and every candidate
 * came back `matchScore: null` while the call "succeeded" (see CLAUDE.md).
 * `is_error: false` is the tool's own word for it; a read-back is somebody
 * else's.
 *
 * The declaration lives with the TOOL — here, or on a manifest `tool_use[]`
 * entry when the confirming endpoint is tenant-specific. It is never a name
 * list in the runtime, and its absence is never a pass: an undeclared write
 * reconciles as `not_verified`, which qualifies the run's completion.
 *
 * Every path is a safe dotted path (`safeProbePath` in @agentic/shared).
 * `readArgs` values are read from the WRITE call (`input.*` / `output.*`);
 * `match[].claim` is read from the write's output and `match[].observed` from
 * the read tool's output. Values must be deep-equal.
 */
export interface ToolEffectVerificationContract {
  /** Read-only tool that observes the effect. Must be in the same
   * `tool_use[]` allow-list — the read-back does not widen the trust
   * boundary. */
  readTool: string;
  /** Read-tool argument name → dotted source path on the write call. */
  readArgs?: Record<string, string>;
  /** Field pairs that must agree between what was claimed and what is there. */
  match: Array<{ claim: string; observed: string }>;
}

/** Catalog metadata surfaced via GET /v1/tools and the Tools UI. */
export interface ToolCatalogEntry {
  /** Canonical name as used in workflow manifests. */
  name: string;
  /** Grouping label for the UI (e.g. "robohire", "fs", "http"). */
  category: string;
  /** One-line summary for the catalog index. */
  summary: string;
  /** Explicit probe/production side-effect class. Undefined is treated as
   * side-effecting by the probe API (fail closed). */
  sideEffect?: "read" | "write" | "dual" | "call";
  /** Whether Studio / workflow test runs may execute the real implementation
   * outside live mode. Undefined derives fail-closed from the execution
   * policy (write/dual/attempt-grant tools block). */
  testPolicy?: "allow" | "block";
  /** Explicit reviewed execution semantics. All first-party global tools must
   * declare all three fields; sandbox dispatch fails closed without them. */
  operation: ToolOperation;
  effectScope: ToolEffectScope;
  sandboxPolicy: ToolSandboxPolicy;
  /** Long-form description for the detail view. */
  description?: string;
  /**
   * Shape of the LLM-supplied arguments (what the model puts in tool_use.input,
   * or what a `type: "tool"` manifest action passes through ctx.event.data).
   * Empty when the tool takes no args (e.g. `meta.ping`, `robohireHealthApi`).
   */
  argsSchema?: Record<string, ToolFieldSchema>;
  /** A copy-paste-ready example of the args object. */
  argsExample?: Record<string, unknown>;
  /**
   * Per-tenant config keys the tool honours (manifest `tool_use[].config`).
   * These come from the MANIFEST, not from the LLM call.
   */
  configSchema?: Record<string, ToolFieldSchema>;
  /** Cross-field config rules executed generically by Agent Factory. */
  configContract?: ToolConfigContract;
  /** Copy-paste example of the manifest config block. */
  configExample?: Record<string, unknown>;
  /**
   * Global fallback env var name(s) the tool reads for its REQUIRED credential
   * when no per-tenant `config.api_key`/`api_key_env` is supplied — and WITHOUT
   * which the handler fails at runtime. Structured (not just prose) so the Agent
   * Factory can, at design time, check `process.env` for these and — when a
   * generated function BINDS this tool but none is set — let the brain reason
   * about it and `ask_user` to recommend the operator configure the key. Omit
   * for tools that need no credential or degrade gracefully without one. The
   * factory logic is fully generic over this list — no per-tool special-casing.
   */
  credentialEnv?: string[];
  /** Whether credentials are absent, resolved only through server env refs,
   * or managed by another trusted server mechanism. */
  credentialPosture?: "none" | "environment_reference_only" | "server_managed";
  /** Top-level probe posture for catalog consumers. Capability entries repeat
   * this where binding is capability-specific. */
  probeRequired?: boolean;
  /** Machine-readable integration coverage. Agent Factory may recommend by
   * semantics, but it may only mark an Ontology integration resolved when one
   * of these descriptors matches system/kind/role/operation/objectTypes. */
  capabilities?: Array<{
    systems: string[];
    /** For systems:["*"], exact profile config key holding the bound system. */
    systemConfigKey?: string;
    kinds: string[];
    roles: string[];
    operations?: string[];
    requiresOperation?: boolean;
    objectTypes?: string[];
    probeRequired?: boolean;
  }>;
  /** Config→runtime scope mapping consumed generically by Agent Factory. */
  profileScope?: {
    exact?: Array<{
      configKey: string;
      source: "tenantId" | "tenantSlug" | "domain" | "action";
    }>;
    allowlists?: Array<{
      configKey: string;
      source: "tenant" | "domain" | "action" | "objects";
      match: "any" | "all";
    }>;
  };
  /** A write/dual probe is disabled until the complete disposable-canary
   * lifecycle (create, cleanup, absence proof) is declared. */
  probeSafety?: WriteProbeSafetyContract;
  /**
   * #EFFECT-READBACK (D6) — declared confirmation route for this tool's write.
   * Undefined means this tool declares no read-back; the runtime then records
   * `not_verified` on every one of its calls rather than assuming success.
   * A manifest `tool_use[].effect_verification` entry overrides this, because
   * the confirming endpoint is frequently tenant-bound.
   */
  effectVerification?: ToolEffectVerificationContract;
  /** Shape of the success return value (what handler resolves with under .data). */
  returnsSchema?: Record<string, ToolFieldSchema>;
  /** A worked example of the return value. */
  returnsExample?: unknown;
  /**
   * Other tools this one chains with via ctx.lastResult (the runtime carries
   * the previous tool's output through automatically so the LLM doesn't have
   * to re-quote it). Surfaced in the docs as a "Pairs well with" hint.
   */
  chainsWith?: string[];
  /** Other names this tool answers to (back-compat aliases). */
  aliases?: string[];
  /** Where in the repo the implementation lives. */
  sourcePath: string;
  /** Immutable implementation/build identity used by Factory probe,
   * sandbox and promotion hashes. Metadata-only changes are not enough: a
   * handler/helper build change invalidates old cassettes too. */
  sourceIdentity?: Record<string, unknown> & {
    provider: string;
    handlerSha256: string;
    buildId?: string;
  };
}

interface ToolRegistration {
  descriptor: ToolDescriptor;
  catalog: ToolCatalogEntry;
}

function requiredLifecycleCoordinate(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500) {
    throw new Error(`global write-probe lifecycle ${field} is invalid`);
  }
  return value.trim();
}

/** Fingerprint the trusted executable lifecycle without publishing callback
 * source. This object is embedded in sourceIdentity, so add/remove/code drift
 * changes the normal catalog definition hash and invalidates old cassettes. */
export function globalWriteProbeLifecycleSourceIdentity(
  lifecycle: ToolWriteProbeLifecycle | undefined,
): Record<string, unknown> | null {
  if (!lifecycle) return null;
  const digest = (handler: Function): string => createHash("sha256")
    .update(Function.prototype.toString.call(handler), "utf8")
    .digest("hex");
  return {
    schema: "agentic-write-probe-lifecycle/v1",
    id: requiredLifecycleCoordinate(lifecycle.identity?.id, "identity.id"),
    revision: requiredLifecycleCoordinate(
      lifecycle.identity?.revision,
      "identity.revision",
    ),
    cleanupHandlerSha256: digest(lifecycle.cleanup),
    readbackHandlerSha256: digest(lifecycle.readback),
  };
}

const TOOL_OPERATIONS = new Set<ToolOperation>(["read", "compute", "write", "read_write"]);
const TOOL_EFFECT_SCOPES = new Set<ToolEffectScope>(["none", "sandbox_local", "external"]);
const TOOL_SANDBOX_POLICIES = new Set<ToolSandboxPolicy>([
  "pure",
  "sandbox_local",
  "live_external",
  "requires_attempt_grant",
]);

/** Runtime guard for manifest/DB JSON. TypeScript types alone do not protect
 * policy metadata after it crosses a persistence boundary. */
export function isToolExecutionPolicy(value: unknown): value is ToolExecutionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Partial<ToolExecutionPolicy>;
  if (
    !TOOL_OPERATIONS.has(policy.operation as ToolOperation)
    || !TOOL_EFFECT_SCOPES.has(policy.effectScope as ToolEffectScope)
    || !TOOL_SANDBOX_POLICIES.has(policy.sandboxPolicy as ToolSandboxPolicy)
  ) return false;

  switch (policy.sandboxPolicy) {
    case "pure":
      return policy.effectScope === "none"
        && (policy.operation === "read" || policy.operation === "compute");
    case "sandbox_local":
      return policy.effectScope === "sandbox_local";
    case "live_external":
      return policy.effectScope === "external"
        && (policy.operation === "read" || policy.operation === "compute");
    case "requires_attempt_grant":
      return policy.effectScope === "external"
        && (policy.operation === "write" || policy.operation === "read_write");
  }
  return false;
}

export function toolExecutionPoliciesEqual(
  left: ToolExecutionPolicy,
  right: ToolExecutionPolicy,
): boolean {
  return left.operation === right.operation
    && left.effectScope === right.effectScope
    && left.sandboxPolicy === right.sandboxPolicy;
}

function executionPolicy(catalog: ToolCatalogEntry): ToolExecutionPolicy {
  return {
    operation: catalog.operation,
    effectScope: catalog.effectScope,
    sandboxPolicy: catalog.sandboxPolicy,
  };
}

// Shared config block for every RoboHire wrapper — all five honour the
// same auth + base-url + timeout knobs via rest-helper.ts.
const ROBOHIRE_CONFIG_SCHEMA: Record<string, ToolFieldSchema> = {
  api_key_env: {
    type: "string",
    required: true,
    description:
      "Required env-var name holding the per-tenant API key; literal keys are forbidden.",
  },
  base_url_env: {
    type: "string",
    required: true,
    description: "Required env-var name holding the trusted absolute GoHire (RoboHire-compatible) API base URL; no endpoint is hardcoded.",
  },
  timeout_ms: { type: "number", default: 30000 },
};

const ROBOHIRE_CONFIG_EXAMPLE = {
  // GoHire (gohire.top) is the live vendor host; ROBOHIRE_* env names remain
  // valid for older manifests (both point at the same RoboHire-compatible API).
  api_key_env: "GOHIRE_API_KEY",
  base_url_env: "GOHIRE_API_BASE_URL",
};

// Shared config block for the canonical GoHire wrappers. The NORMAL
// credential source is the DB-backed integration configured in Settings →
// Integrations (provider="gohire", resolved through the injected
// resolveIntegrationCreds seam); explicit env references in the manifest
// override it and fail closed when the named variable is unset — which is
// how legacy RoboHire-named manifests ({api_key_env, base_url_env}) keep
// working unchanged. See gohire/rest-helper.ts for the full order.
const GOHIRE_CONFIG_SCHEMA: Record<string, ToolFieldSchema> = {
  api_key_env: {
    type: "string",
    description:
      "Env-var name holding the per-tenant API key. Fail-closed override of the Settings → Integrations credential; if named but unset the call throws.",
  },
  base_url_env: {
    type: "string",
    description:
      "Env-var name holding the API base URL. Fail-closed override; legacy manifests bind ROBOHIRE_API_BASE_URL / GOHIRE_API_BASE_URL here.",
  },
  base_url: {
    type: "string",
    description:
      "Literal endpoint override. Normally omitted — the Settings → Integrations row (then GOHIRE_BASE_URL / GOHIRE_API_BASE_URL) supplies it. A custom value requires an explicit api_key_env.",
  },
  timeout_ms: { type: "number", default: 30000 },
};

const GOHIRE_CONFIG_EXAMPLE = {
  api_key_env: "GOHIRE_API_KEY",
  base_url_env: "GOHIRE_API_BASE_URL",
};

const REGISTRATIONS: ToolRegistration[] = [
  // ── config.* — non-secret profile diagnostics. These entries never
  //    declare business-system capabilities: presence is not a live probe. ─
  {
    descriptor: inspectEnvironmentReferencesTool,
    catalog: {
      name: "config.inspectEnvironmentReferences",
      category: "config",
      summary:
        "Check whether reviewed environment references are populated without exposing their values; code generation may continue with a warning, but runtime remains probe-gated.",
      sideEffect: "read",
      testPolicy: "allow",
      operation: "compute",
      effectScope: "none",
      sandboxPolicy: "pure",
      description:
        "Reads only the environment-variable names supplied by a reviewed tool profile and reports configured/missing names. It never returns values and never claims connectivity. The result explicitly separates code-generation disposition from runtime readiness so OntoCode can keep drafting while giving the FDE an actionable dependency warning.",
      argsSchema: {},
      argsExample: {},
      configSchema: {
        profile_name: {
          type: "string",
          required: true,
          description: "Stable non-secret integration-profile label.",
        },
        system_name: {
          type: "string",
          required: true,
          description:
            "Exact Ontology integration system represented by the profile.",
        },
        required_env: {
          type: "string[]",
          required: true,
          description:
            "Reviewed required environment-variable names; values are never returned.",
        },
        optional_env: {
          type: "string[]",
          description:
            "Reviewed optional environment-variable names; values are never returned.",
        },
        legacy_env_alternatives: {
          type: "Record<string,string[]>",
          description:
            "Migration-only preferred→legacy env-name candidates. The tool reports configured alternatives but never selects one or copies a value.",
        },
        probe_tool: {
          type: "string",
          description:
            "Real connectivity/probe tool the FDE should run next; informational only.",
        },
      },
      configExample: {
        profile_name: "agents-generation-gohire",
        system_name: "GoHire_System",
        required_env: [
          "GOHIRE_API_BASE_URL",
          "GOHIRE_API_KEY",
        ],
        probe_tool: "gohireHealthApi",
      },
      returnsSchema: {
        status: {
          type:
            "'needs_configuration'|'needs_profile_selection'|'configured_unverified'",
        },
        configured_env: { type: "string[]" },
        missing_env: { type: "string[]" },
        unresolved_missing_env: { type: "string[]" },
        legacy_configured_alternatives: {
          type:
            "Array<{required_env:string,configured_alternatives:string[]}>",
        },
        code_generation_disposition: {
          type: "'continue_with_warning'",
        },
        runtime_disposition: {
          type:
            "'blocked_until_configured_and_probed'|'blocked_until_profile_selected_and_probed'|'blocked_until_probed'",
        },
        warning: { type: "string" },
      },
      returnsExample: {
        profile_name: "agents-generation-gohire",
        system_name: "GoHire_System",
        status: "configured_unverified",
        configured_env: [
          "GOHIRE_API_BASE_URL",
          "GOHIRE_API_KEY",
        ],
        missing_env: [],
        unresolved_missing_env: [],
        optional_configured_env: [],
        optional_missing_env: [],
        legacy_configured_alternatives: [],
        probe_tool: "gohireHealthApi",
        code_generation_disposition: "continue_with_warning",
        runtime_disposition: "blocked_until_probed",
        warning:
          "Environment references are present; a real probe is still required.",
      },
      // Intentionally no capabilities: this diagnostic cannot satisfy a
      // GoHire/Allmeta/Postgres/object-store integration binding.
      sourcePath:
        "packages/tools/src/config/inspect-environment-references.ts",
    },
  },

  // ── gohire.* — the CANONICAL recruitment tool family (live vendor:
  //    GoHire / gohire.top, RoboHire-compatible contract). Credentials come
  //    from Settings → Integrations (DB-backed, via resolveIntegrationCreds)
  //    with fail-closed manifest env-reference overrides and a global-env
  //    fallback. Every legacy RoboHire tool name aliases to these
  //    implementations, so existing manifests keep working unchanged. ──────
  {
    descriptor: gohireHealthApi,
    catalog: {
      name: "gohireHealthApi",
      aliases: ["robohireHealthApi", "gohire.health"],
      category: "gohire",
      summary:
        "GET {configured GoHire base}/health — smoke-test reachability + credentials. Also backs the Settings → Integrations 'Test connection' affordance.",
      sideEffect: "read",
      operation: "read",
      effectScope: "external",
      sandboxPolicy: "live_external",
      description:
        "Cheap canary call to confirm the API is reachable and the configured key is accepted before invoking write endpoints. Returns the upstream response under .data so the LLM can branch on `status === 'ok'`.",
      argsSchema: {},
      argsExample: {},
      configSchema: GOHIRE_CONFIG_SCHEMA,
      capabilities: [{ systems: ["RoboHire", "GoHire", "RoboHire_System", "GoHire_System"], kinds: ["external_api"], roles: ["read", "reads", "calls"], operations: ["health"], probeRequired: true }],
      configExample: GOHIRE_CONFIG_EXAMPLE,
      returnsSchema: {
        data: { type: "object", description: "Upstream JSON, e.g. { status: 'ok' }" },
      },
      returnsExample: { data: { status: "ok", uptime_s: 482931 } },
      sourcePath: "packages/tools/src/gohire/health.ts",
    },
  },
  {
    descriptor: gohireParseJdApi,
    catalog: {
      name: "gohireParseJdApi",
      aliases: ["parseJdApi", "gohire.parseJd"],
      category: "gohire",
      summary:
        "POST /api/v1/parse-jd — structures a job description (text, URL, or base64 PDF).",
      sideEffect: "call",
      operation: "compute",
      effectScope: "external",
      sandboxPolicy: "live_external",
      description:
        "Forwards the request body to the upstream verbatim, so the LLM can pass any of the three documented shapes. Upstream validation errors surface as `tool_result: is_error` so the model can self-correct.",
      argsSchema: {
        jd_text: {
          type: "string",
          description: "Plain-text JD body. Provide this OR jd_url OR jd_base64.",
        },
        jd_url: {
          type: "string",
          description: "Fetchable URL to a PDF. Upstream downloads it.",
        },
        jd_base64: {
          type: "string",
          description: "Base64-encoded PDF bytes.",
        },
      },
      argsExample: {
        jd_text:
          "Senior Backend Engineer\n\nResponsibilities: design and own production services in Go/TypeScript ...",
      },
      configSchema: GOHIRE_CONFIG_SCHEMA,
      capabilities: [{ systems: ["RoboHire", "GoHire", "RoboHire_System", "GoHire_System"], kinds: ["external_api"], roles: ["calls"], operations: ["parse-jd"], objectTypes: ["Job_Posting", "Job_Requisition"], probeRequired: true }],
      returnsSchema: {
        data: {
          type: "object",
          description:
            "Upstream JSON — structured requirements, skills, must-haves, etc.",
        },
      },
      returnsExample: {
        data: {
          title: "Senior Backend Engineer",
          must_have: ["Postgres", "Distributed systems"],
          nice_to_have: ["Go", "Kubernetes"],
        },
      },
      sourcePath: "packages/tools/src/gohire/parse-jd.ts",
    },
  },
  {
    descriptor: generateJdApi,
    catalog: {
      name: "generateJdApi",
      aliases: ["gohire.generateJd"],
      category: "robohire",
      summary:
        "POST /api/v1/jobs/generate-jd — generate a verified JD from a recruitment prompt.",
      sideEffect: "call",
      operation: "compute",
      effectScope: "external",
      sandboxPolicy: "live_external",
      description:
        "Calls the combined RoboHire parse+generate endpoint. It validates the 4-4000 character prompt, checks meta.stages instead of trusting HTTP 200, and rejects empty/Untitled degraded output with typed retry semantics.",
      argsSchema: {
        prompt: { type: "string", required: true, description: "Free-text recruitment requirement, 4-4000 characters." },
        language: { type: "'en'|'zh'|'zh-TW'|'ja'|'es'|'fr'|'pt'|'de'", description: "Requested output language." },
        companyName: { type: "string", description: "Optional company context." },
        department: { type: "string", description: "Optional department context." },
      },
      argsExample: {
        prompt: "上海高级后端工程师，5 年以上 TypeScript/PostgreSQL 经验，负责核心招聘平台服务",
        language: "zh",
      },
      configSchema: ROBOHIRE_CONFIG_SCHEMA,
      configExample: ROBOHIRE_CONFIG_EXAMPLE,
      credentialPosture: "environment_reference_only",
      probeRequired: true,
      capabilities: [{
        systems: ["RoboHire", "GoHire", "RoboHire_System", "GoHire_System"],
        kinds: ["external_api"],
        roles: ["calls", "call", "execute"],
        operations: ["generate-jd", "jobs/generate-jd", "jd.generate"],
        objectTypes: ["Job_Posting", "Job_Requisition"],
        probeRequired: true,
      }],
      returnsSchema: {
        title: { type: "string" },
        description: { type: "string" },
        qualifications: { type: "string" },
        hardRequirements: { type: "string" },
        niceToHave: { type: "string" },
        request_id: { type: "string | null" },
        stages: { type: "object", description: "Verified upstream parse/generate stage statuses." },
        raw: { type: "object", description: "Full upstream response envelope for audit." },
      },
      returnsExample: {
        title: "高级后端工程师",
        description: "负责招聘平台核心服务设计与交付",
        qualifications: "5 年以上后端经验",
        hardRequirements: "TypeScript、PostgreSQL",
        request_id: "req_jd_123",
        stages: { parse: "success", generate: "success" },
      },
      chainsWith: ["postgres.executeStatement"],
      sourcePath: "packages/tools/src/robohire/generate-jd.ts",
    },
  },
  {
    descriptor: gohireParseResumeApi,
    catalog: {
      name: "gohireParseResumeApi",
      aliases: ["parseResumeApi", "gohire.parseResume"],
      category: "gohire",
      summary:
        "POST /api/v1/parse-resume — validated multipart resume parsing with typed failure semantics.",
      sideEffect: "call",
      operation: "compute",
      effectScope: "external",
      sandboxPolicy: "live_external",
      description:
        "Wraps the multipart-only upstream endpoint. Pass `{resume_base64, filename, mime}`, `{resume_url}`, OR call with no args after a trusted byte-source such as `objectStore.getObject` or `fs.readFromInbox` — the tool picks up `{base64,filename,mime}` from `ctx.lastResult` server-side and avoids round-tripping base64 through the model. A 2xx response succeeds only when it contains usable raw text, identity/contact data, experience, education, or skills. Common envelopes are unwrapped; empty/malformed responses are retryable dependency degradation, while explicit unsupported/unparseable document evidence is terminal.",
      argsSchema: {
        resume_base64: {
          type: "string",
          description:
            "Base64-encoded PDF bytes. Omit to chain from ctx.lastResult.",
        },
        filename: {
          type: "string",
          default: "resume.pdf",
          description: "Surfaced in multipart Content-Disposition.",
        },
        mime: {
          type: "string",
          default: "application/pdf",
        },
        resume_url: {
          type: "string",
          description: "Alternative to resume_base64 — wrapper fetches the URL first.",
        },
      },
      argsExample: {},
      configSchema: GOHIRE_CONFIG_SCHEMA,
      capabilities: [{ systems: ["RoboHire", "GoHire", "RoboHire_System", "GoHire_System"], kinds: ["external_api"], roles: ["calls", "call", "execute"], operations: ["parse-resume", "resume.parse"], objectTypes: ["Resume", "Candidate"], probeRequired: true }],
      returnsSchema: {
        data: {
          type: "object",
          description:
            "Validated, unwrapped `{ name, email, skills, experience[], education[], rawText, ... }` payload.",
        },
      },
      returnsExample: {
        data: {
          name: "Wei Zhang",
          email: "wei.zhang@example.com",
          skills: { languages: ["TypeScript", "Go"], tools: ["React"] },
          experience: [
            { role: "Staff Engineer", company: "AgentForge.ai", startDate: "2023" },
          ],
        },
      },
      chainsWith: ["objectStore.getObject", "fs.readFromInbox"],
      sourcePath: "packages/tools/src/gohire/parse-resume.ts",
    },
  },
  {
    descriptor: gohireMatchResumeApi,
    catalog: {
      name: "gohireMatchResumeApi",
      aliases: ["matchResumeApi", "gohire.matchResume"],
      category: "gohire",
      summary:
        "POST /api/v1/match-resume — score a resume vs. a JD. REQUIRES {resume, jd} as plain-text strings.",
      sideEffect: "call",
      operation: "compute",
      effectScope: "external",
      sandboxPolicy: "live_external",
      description:
        "Returns a normalised envelope `{matchScore, verdict, hiringRecommendation, summary, raw}` so downstream agents don't need to spelunk the upstream nested shape. The wrapper also coerces common LLM-emitted variants (`resume_text`, `jd_text`, `candidate_resume`, `job_description`) into the canonical names before sending — saves a tool-use turn on a schema-fix retry.",
      argsSchema: {
        resume: {
          type: "string",
          required: true,
          description:
            "Full plain-text resume body (NOT a URL, NOT a field reference).",
        },
        jd: {
          type: "string",
          required: true,
          description: "Full plain-text JD body.",
        },
      },
      argsExample: {
        resume: "Wei Zhang — Staff Engineer with 8 years backend experience ...",
        jd: "Senior Backend Engineer — Must have Postgres OLTP expertise ...",
      },
      configSchema: GOHIRE_CONFIG_SCHEMA,
      capabilities: [{ systems: ["RoboHire", "GoHire", "RoboHire_System", "GoHire_System"], kinds: ["external_api"], roles: ["calls", "call", "execute"], operations: ["match-resume", "resume.match"], objectTypes: ["Resume", "Job_Posting", "Job_Requisition", "Candidate_Match_Result"], probeRequired: true }],
      returnsSchema: {
        matchScore: {
          type: "number | null",
          description: "0-100 or null if the upstream omitted a score.",
        },
        verdict: {
          type: "string | null",
          description: '"Strong Match" / "Moderate Match" / "Weak Match" / "Not Qualified".',
        },
        hiringRecommendation: {
          type: "string | null",
          description: '"Strongly Recommend" / "Recommend" / "Do Not Recommend".',
        },
        summary: { type: "string | null", description: "One-line verdict rationale." },
        raw: { type: "object", description: "Full upstream body for detailed breakdowns." },
      },
      returnsExample: {
        matchScore: 96,
        verdict: "Strong Match",
        hiringRecommendation: "Strongly Recommend",
        summary: "Direct expertise in the platform's full tech stack.",
        raw: { overallMatchScore: { score: 96 } },
      },
      sourcePath: "packages/tools/src/gohire/match-resume.ts",
    },
  },
  {
    descriptor: gohireInviteCandidateApi,
    catalog: {
      name: "gohireInviteCandidateApi",
      aliases: ["inviteCandidateApi", "gohire.inviteCandidate"],
      category: "gohire",
      summary:
        "POST /api/v1/invite-candidate — send a real interview invitation and return its receipt.",
      sideEffect: "write",
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      description:
        "Side-effecting delivery adapter. It accepts only RoboHire's canonical request and never queries or updates a business database. Resolve business records in explicit upstream data-tool steps, then pass either resume or RoboHire resume_id and either jd or RoboHire job_id. A 2xx without login_url (unless reused=true) is reported as success:false. Automatic live probing stays disabled because a real invitation cannot be rolled back; execution requires an attempt grant.",
      argsSchema: {
        resume: {
          type: "string",
          description: "Full resume text. Required unless resume_id is supplied.",
        },
        resume_id: {
          type: "string",
          description: "RoboHire Resume resource id. Required unless resume is supplied; never pass a business-system resume id implicitly.",
        },
        jd: {
          type: "string",
          description: "Full JD text. Required unless job_id is supplied.",
        },
        job_id: {
          type: "string",
          description: "RoboHire Job resource id. Required unless jd is supplied; never pass a business-system job id implicitly.",
        },
        hiring_request_id: {
          type: "string",
          description: "Stable RoboHire hiring-request id; preserve it across retries so the provider can deduplicate delivery.",
        },
        candidate_email: { type: "string" },
        recruiter_email: { type: "string" },
        interviewer_requirement: { type: "string" },
        job_title: { type: "string" },
        company_name: { type: "string" },
        interview_language: {
          type: "string",
          allowedValues: ["en", "zh", "ja"],
        },
        interview_duration: {
          type: "number",
          description: "Interview duration in minutes; must be greater than zero.",
        },
        interview_mode: { type: "string" },
        passing_score: {
          type: "number",
          description: "RoboHire post-interview threshold from 0 through 100.",
        },
        linked_assessment_id: {
          type: "string",
          description: "RoboHire assessment id. Use the literal string 'null' only when the vendor contract should clear its default binding.",
        },
      },
      argsExample: {
        resume: "Wei Zhang — 8 years of backend engineering experience ...",
        jd: "Senior Backend Engineer — distributed systems, TypeScript ...",
        candidate_email: "wei.zhang@example.test",
        job_title: "Senior Backend Engineer",
        interview_language: "zh",
        interview_duration: 30,
      },
      configSchema: GOHIRE_CONFIG_SCHEMA,
      credentialPosture: "server_managed",
      probeRequired: true,
      capabilities: [{ systems: ["RoboHire", "GoHire", "RoboHire_System", "GoHire_System"], kinds: ["external_api"], roles: ["write", "writes", "calls", "call", "execute"], operations: ["invite-candidate", "interview.invite"], objectTypes: ["Candidate", "Job_Requisition", "Interview_Record", "Communication_Log"], probeRequired: true }],
      returnsSchema: {
        success: { type: "boolean", description: "True only when RoboHire issued/reused a real invitation." },
        error_code: { type: "string | null", description: "Stable terminal business-failure classification; null on success." },
        http_status: { type: "number", description: "Upstream HTTP status on a terminal 4xx response." },
        login_url: { type: "string | null", description: "Issued candidate interview/login URL." },
        qrcode_url: { type: "string | null", description: "Issued QR-code URL when provided." },
        user_id: { type: "unknown | null", description: "RoboHire user id when provided." },
        request_introduction_id: { type: "string | null", description: "RoboHire invitation/request-introduction id." },
        request_id: { type: "string | null", description: "Upstream request id for audit and support." },
        error_message: { type: "string | null", description: "Explicit business failure reason; null on success." },
        persistence_warning: { type: "string | null", description: "Invitation delivered but RoboHire could not persist its own receipt, when reported." },
        raw: { type: "object", description: "Full upstream response envelope for audit." },
      },
      returnsExample: {
        success: true,
        login_url: "https://app.robohire.io/interview/real-issued-id",
        qrcode_url: "https://app.robohire.io/qrcode/real-issued-id",
        user_id: "usr_123",
        request_introduction_id: "ri_123",
        request_id: "req_123",
        error_message: null,
        raw: { success: true, login_url: "https://app.robohire.io/interview/real-issued-id" },
      },
      sourcePath: "packages/tools/src/gohire/invite-candidate.ts",
    },
  },

  // ── fs.* ────────────────────────────────────────────────────────────────
  {
    descriptor: readFromInbox,
    catalog: {
      name: "fs.readFromInbox",
      category: "fs",
      summary:
        "Read a file from data/<subdir>/<tenant>/inbox/<filename> and return it as base64 + sha256.",
      sideEffect: "read",
      operation: "read",
      effectScope: "sandbox_local",
      sandboxPolicy: "sandbox_local",
      description:
        "Use this as the first tool in any 'pick up a file → upload to an API' chain. Tenant-scoped path. Flat filenames only (rejects '..' / leading dots / path separators). Size + extension allow-list enforced before the file is read.",
      argsSchema: {
        filename: {
          type: "string",
          required: true,
          description: "Flat filename (no slashes, no '..', no leading dot).",
        },
      },
      argsExample: { filename: "wei-zhang.pdf" },
      configSchema: {
        subdir: {
          type: "string",
          default: "resumes",
          description:
            "Sub-directory under data/. The tenant slug + 'inbox' are appended.",
        },
        max_bytes: { type: "number", default: 10485760 },
        allowed_exts: {
          type: "string[]",
          default: [".pdf", ".txt", ".md", ".doc", ".docx"],
        },
      },
      configExample: { subdir: "resumes", max_bytes: 5242880 },
      capabilities: [{ systems: ["local filesystem", "Object_Storage_System"], kinds: ["file_store", "object_storage"], roles: ["reads"], operations: ["read-file"], objectTypes: ["Resume", "Resume_Upload"] }],
      returnsSchema: {
        filename: { type: "string" },
        mime: { type: "string" },
        base64: { type: "string", description: "Base64-encoded file body." },
        sha256: { type: "string", description: "Hex-encoded SHA-256 of the raw bytes." },
        bytes: { type: "number" },
        path: { type: "string", description: "Absolute path the file was read from." },
      },
      returnsExample: {
        filename: "wei-zhang.pdf",
        mime: "application/pdf",
        base64: "JVBERi0xLjQK...",
        sha256: "424ed41387578546f86a4774ce597cc06dd859a1cdf17a353a016120a727b9b9",
        bytes: 3057,
        path: "/abs/data/resumes/northwind/inbox/wei-zhang.pdf",
      },
      chainsWith: ["parseResumeApi"],
      aliases: ["readResumeFromDisk"],
      sourcePath: "packages/tools/src/fs/read-from-inbox.ts",
    },
  },
  {
    descriptor: writeMarkdownToArchive,
    catalog: {
      name: "fs.writeMarkdownToArchive",
      category: "fs",
      summary:
        "Persist a markdown body to data/<subdir>/<tenant>/<id>.md. Returns the path + a stable id.",
      sideEffect: "write",
      operation: "write",
      effectScope: "sandbox_local",
      sandboxPolicy: "sandbox_local",
      description:
        "Writes a header comment with the synthetic id + tenant + ISO timestamp, then a `# <title>` line, then the body. Also appends one line to `_archive.log` for tail-following.",
      argsSchema: {
        text: {
          type: "string",
          required: true,
          description: "Markdown body. Aliases: `jd_text`, `body`.",
        },
        title: {
          type: "string",
          description: "Rendered as `# <title>` at the top. Aliases: `jd_title`.",
        },
      },
      argsExample: { text: "## Job description\n\nResponsibilities:\n- ...", title: "Senior Backend Engineer" },
      configSchema: {
        subdir: { type: "string", default: "archive" },
        id_prefix: { type: "string", default: "doc" },
        default_title: { type: "string" },
      },
      configExample: { subdir: "jd-archive", id_prefix: "jd" },
      returnsSchema: {
        id: {
          type: "string",
          description: "`{id_prefix}-{yyyymmddHHMMSS}-{6hex}`.",
        },
        path: { type: "string", description: "Absolute path on disk." },
        bytesWritten: { type: "number" },
      },
      returnsExample: {
        id: "jd-20260526193743-599dda",
        path: "/abs/data/jd-archive/northwind/jd-20260526193743-599dda.md",
        bytesWritten: 1247,
      },
      aliases: ["writeJdToDisk"],
      // 本地容器磁盘写入。刻意【不】声明 Object_Storage_System：这些工具写的是
      // 容器盘，谎称覆盖对象存储会让能力匹配用一次本地写去满足 S3/MinIO 需求，
      // 生成的 agent 会静默地写错地方。当前没有 Agent 动作需要它，属预防性声明。
      capabilities: [{
        systems: ["local filesystem"],
        kinds: ["file_store"],
        roles: ["write", "writes"],
        operations: ["write-file"],
        objectTypes: ["*"],
      }],
      sourcePath: "packages/tools/src/fs/write-markdown-to-archive.ts",
    },
  },
  {
    descriptor: writeHtmlToArchive,
    catalog: {
      name: "fs.writeHtmlToArchive",
      category: "fs",
      sideEffect: "write",
      operation: "write",
      effectScope: "sandbox_local",
      sandboxPolicy: "sandbox_local",
      summary:
        "Persist an HTML document to data/<subdir>/<tenant>/<id>.html. Auto-wraps if no DOCTYPE.",
      description:
        "If the supplied html doesn't start with `<!DOCTYPE`, the tool wraps it in a minimal document shell so the file still renders in a browser. The wrap is skipped when the LLM sends a complete doctyped document.",
      argsSchema: {
        html: {
          type: "string",
          required: true,
          description: "HTML body or full document. Aliases: `body`, `report`.",
        },
        title: {
          type: "string",
          description: "Used in the auto-wrapped <title>. Aliases: `report_title`.",
        },
      },
      argsExample: {
        html: "<h1>Match report</h1>\n<table>...</table>",
        title: "Hiring report — JR-NW-2026-007",
      },
      configSchema: {
        subdir: { type: "string", default: "reports" },
        id_prefix: { type: "string", default: "report" },
        lang: { type: "string", default: "zh-CN" },
      },
      configExample: { subdir: "reports", id_prefix: "report", lang: "zh-CN" },
      returnsSchema: {
        id: { type: "string" },
        path: { type: "string" },
        bytesWritten: { type: "number" },
      },
      returnsExample: {
        id: "report-20260527094643-a23868",
        path: "/abs/data/reports/northwind/report-20260527094643-a23868.html",
        bytesWritten: 2762,
      },
      aliases: ["writeReportToDisk", "writeBriefToDisk"],
      // 本地容器磁盘写入。刻意【不】声明 Object_Storage_System：这些工具写的是
      // 容器盘，谎称覆盖对象存储会让能力匹配用一次本地写去满足 S3/MinIO 需求，
      // 生成的 agent 会静默地写错地方。当前没有 Agent 动作需要它，属预防性声明。
      capabilities: [{
        systems: ["local filesystem"],
        kinds: ["file_store"],
        roles: ["write", "writes"],
        operations: ["write-file"],
        objectTypes: ["*"],
      }],
      sourcePath: "packages/tools/src/fs/write-html-to-archive.ts",
    },
  },
  {
    descriptor: appendToLog,
    catalog: {
      name: "fs.appendToLog",
      category: "fs",
      sideEffect: "write",
      operation: "write",
      effectScope: "sandbox_local",
      sandboxPolicy: "sandbox_local",
      summary:
        "Append a line to data/<subdir>/<tenant>/<filename>. Pass { line } verbatim or { data } for auto-formatted k=v.",
      description:
        "Use as a `type: \"tool\"` step at the end of a workflow leg to drop a grep-friendly trace of the upstream event. The auto-format mode (any non-empty arg object becomes `key=value  key=value`) means an agent can pipe a payload straight in without quoting.",
      argsSchema: {
        line: {
          type: "string",
          description: "Literal line to append (no formatting).",
        },
        data: {
          type: "object",
          description:
            "Auto-formatted as `key=value  key=value`. Any non-empty arg object also triggers auto-format.",
        },
      },
      argsExample: { data: { event: "AGENT_TEST1_DONE", agent: "agent-test2", subject: "REQ-123" } },
      configSchema: {
        subdir: { type: "string", default: "logs" },
        filename: { type: "string", default: "workflow.log" },
        prefix_ts: {
          type: "boolean",
          default: true,
          description: "Prepend ISO timestamp + 2 spaces to each line.",
        },
      },
      configExample: { subdir: "logs", filename: "workflow-test1.log" },
      returnsSchema: {
        logFile: { type: "string", description: "Absolute path of the log file." },
        bytesAppended: { type: "number" },
        line: { type: "string", description: "The line that was written (trimmed)." },
      },
      returnsExample: {
        logFile: "/abs/data/logs/tenant-test1/workflow-test1.log",
        bytesAppended: 132,
        line: "2026-05-27T17:46:48.591Z  event=AGENT_TEST1_DONE  agent=agent-test2  subject=REQ-123",
      },
      aliases: ["writeWorkflowLog"],
      // 本地容器磁盘写入。刻意【不】声明 Object_Storage_System：这些工具写的是
      // 容器盘，谎称覆盖对象存储会让能力匹配用一次本地写去满足 S3/MinIO 需求，
      // 生成的 agent 会静默地写错地方。当前没有 Agent 动作需要它，属预防性声明。
      capabilities: [{
        systems: ["local filesystem"],
        kinds: ["file_store"],
        roles: ["write", "writes"],
        operations: ["write-file"],
        objectTypes: ["*"],
      }],
      sourcePath: "packages/tools/src/fs/append-to-log.ts",
    },
  },

  // ── metaerp.* ───────────────────────────────────────────────────────────
  {
    descriptor: metaerpInvoke,
    catalog: {
      name: "metaerp.invoke",
      category: "metaerp",
      summary:
        "Invoke one Meta ERP OpenAPI operation from the tenant's compiled erp-operations.json catalog; unknown ops, unset base-URL env, and non-2xx/non-JSON responses fail closed.",
      // Statement-catalog idiom (like postgres.executeStatement): the exact
      // operation is selected by trusted manifest config / the catalog file,
      // and the catalog mixes read (`query`) and mutating (`write`) ops, so
      // the reviewed policy is conservatively read_write + attempt-grant.
      // Per-call kind is surfaced in the result meta (`kind: query|write`).
      sideEffect: "dual",
      operation: "read_write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      credentialPosture: "none",
      description:
        "The ontology compiler emits models/<tenant>-v1/erp-operations.json listing every Meta ERP operation an agent may call (name, POST path, kind: query|write). The model supplies only { operation, payload } — never a URL. Trusted config names the catalog file and the base-URL env var (default METAERP_BASE_URL), and compiled external actions pin config.operation so a drifted call cannot invoke a different ERP op. Requests POST JSON with a 15s default timeout; non-2xx and non-JSON responses throw so the runtime sees a real tool error.",
      argsSchema: {
        operation: {
          type: "string",
          description:
            "Catalog operation name (e.g. 'queryInventoryLots', 'createTransferOrder'). Optional when config.operation pins it; when both are present they must match.",
        },
        payload: {
          type: "object",
          description:
            "JSON body for the operation — query filters for query ops, the write payload for write ops. Defaults to {}.",
        },
      },
      argsExample: {
        operation: "queryInventoryLots",
        payload: { REGION_NAME: "华东" },
      },
      configSchema: {
        catalog_path: {
          type: "string",
          required: true,
          description:
            "Repo-relative path to the compiled erp-operations.json (e.g. 'models/power-scm-v1/erp-operations.json').",
        },
        base_url_env: {
          type: "string",
          default: "METAERP_BASE_URL",
          description:
            "Env var NAME holding the Meta ERP origin (e.g. http://localhost:3620). Fail-closed when unset; literal URLs are never accepted.",
        },
        operation: {
          type: "string",
          description:
            "Pin this binding to one catalog operation. Overrides args.operation; a conflicting args.operation throws.",
        },
        timeout_ms: { type: "number", default: 15000 },
      },
      configExample: {
        catalog_path: "models/power-scm-v1/erp-operations.json",
        base_url_env: "METAERP_BASE_URL",
        operation: "createTransferOrder",
      },
      credentialEnv: ["METAERP_BASE_URL"],
      capabilities: [{
        systems: ["Meta ERP", "MetaERP", "Meta_ERP_System"],
        kinds: ["external_api", "erp"],
        roles: ["reads", "calls", "write", "writes"],
        operations: ["*"],
        objectTypes: ["*"],
      }],
      returnsSchema: {
        data: {
          type: "object",
          description:
            "Parsed upstream JSON — `{rows}` for query ops, `{ok, id}`-style receipts for write ops.",
        },
      },
      returnsExample: {
        data: { rows: [{ LOT_ID: "LOT-2026-0001", STATUS: "AVAILABLE" }] },
      },
      sourcePath: "packages/tools/src/metaerp/invoke.ts",
    },
  },

  // ── http.* ──────────────────────────────────────────────────────────────
  {
    descriptor: httpFetchTool,
    catalog: {
      name: "http.fetch",
      category: "http",
      sideEffect: "dual",
      operation: "read_write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      summary:
        "Generic JSON HTTP client. Per-tenant base_url + auth + allow-lists via config; per-call { method, path, body, query, headers }.",
      description:
        "SSRF-hardened client for one manifest-bound public HTTPS origin. Returns `{ status, ok, headers, body }` for 2xx; 4xx/5xx THROW with a bounded response diagnostic, so direct workflow steps fail and the LLM tool loop can self-correct from an explicit tool error. The server must authorize `base_url` (AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST); `allow_host` must pin its exact public host; per-call paths stay inside that origin/base path. DNS answers and redirects are revalidated and pinned. Authentication comes only from a populated tenant-owned `api_key_env` (bearer, named header, or query) — never literal model input.",
      argsSchema: {
        method: {
          type: "'GET'|'POST'|'PUT'|'PATCH'|'DELETE'",
          default: "GET",
        },
        path: {
          type: "string",
          required: true,
          description:
            "Relative path joined inside config.base_url. Absolute URLs, protocol-relative values, fragments, and parent-path escapes are rejected.",
        },
        query: {
          type: "Record<string,string|number|boolean>",
          description:
            "Appended as URL search params. Credential-bearing names are rejected.",
        },
        body: {
          type: "unknown",
          description:
            "JSON-encoded automatically. Pass a string to send a raw body.",
        },
        headers: {
          type: "Record<string,string>",
          description:
            "Merged on top of config.default_headers. Auth, cookie, host, and connection-controlled names are rejected.",
        },
      },
      argsExample: {
        method: "POST",
        path: "/repos/{owner}/{repo}/issues",
        body: { title: "Bug: ...", labels: ["triage"] },
      },
      configSchema: {
        base_url: {
          type: "string",
          required: true,
          description:
            "Public HTTPS origin/base path authorized by AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST. Development localhost additionally requires AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST=1.",
        },
        timeout_ms: { type: "number", default: 30000 },
        default_headers: {
          type: "Record<string,string>",
          description:
            "Non-sensitive defaults only; credentials and connection-controlled headers are rejected.",
        },
        api_key_env: {
          type: "string",
          description:
            "Populated tenant-owned environment variable name (or an exact server-shared reference). Missing/empty values fail closed; literal config.api_key is forbidden.",
        },
        auth_scheme: {
          type: "'bearer'|'header'|'query'|'none'",
          description:
            "Defaults to bearer when api_key_env is configured, otherwise none.",
        },
        auth_header_name: { type: "string", default: "X-API-Key" },
        auth_query_name: { type: "string", default: "api_key" },
        allow_methods: {
          type: "HttpMethod[]",
          description: "Safety allow-list. Default: any method.",
        },
        allow_host: {
          type: "string|string[]",
          required: true,
          description:
            "Exact base_url hostname only; schemes, ports, paths, and wildcards are rejected.",
        },
      },
      configExample: {
        base_url: "https://api.example.com/v1",
        api_key_env: "TENANT_X_EXAMPLE_KEY",
        auth_scheme: "bearer",
        allow_host: "api.example.com",
        allow_methods: ["GET", "POST"],
      },
      returnsSchema: {
        status: { type: "number" },
        ok: {
          type: "boolean",
          description: "True for the accepted 2xx response; non-2xx responses throw.",
        },
        headers: { type: "Record<string,string>" },
        body: {
          type: "unknown",
          description: "Parsed JSON when Content-Type indicates json; else raw text.",
        },
      },
      returnsExample: {
        status: 201,
        ok: true,
        headers: { "content-type": "application/json" },
        body: { id: 4892, url: "https://api.example.com/v1/issues/4892" },
      },
      // 【刻意不声明 capabilities】通用 HTTP 传输。给它声明能力，就等于让一个通用
      // 取数器宣称覆盖任意 external_api 需求——绑定门就此失效。需要真实外部集成时，
      // 走 fetch_doc → extract_api_schema → create_tool 造具名适配器。
      sourcePath: "packages/tools/src/http/fetch.ts",
    },
  },

  // ── meta.* ──────────────────────────────────────────────────────────────
  {
    descriptor: ping,
    catalog: {
      name: "meta.ping",
      category: "meta",
      sideEffect: "read",
      operation: "read",
      effectScope: "none",
      sandboxPolicy: "pure",
      summary:
        "Context-introspection smoke test. Returns the ToolContext snapshot so the operator can verify manifest wiring.",
      description:
        "Drop `{ \"name\": \"meta.ping\" }` into a new tenant's first agent to confirm Inngest dispatch → tenant resolver → tool handler is wired. Also useful for debugging ctx.subject / ctx.lastResult propagation when a downstream tool isn't seeing what you expect.",
      argsSchema: {},
      argsExample: {},
      configSchema: {},
      returnsSchema: {
        pong: { type: "true" },
        agentName: { type: "string" },
        actionName: { type: "string" },
        tenantSlug: { type: "string" },
        subject: { type: "string | null" },
        seenEvent: { type: "string | null" },
        hasLastResult: { type: "boolean" },
        hasConfig: { type: "boolean" },
        ts: { type: "string", description: "ISO timestamp the ping fired." },
      },
      returnsExample: {
        pong: true,
        agentName: "agentTest1",
        actionName: "meta.ping",
        tenantSlug: "northwind",
        subject: "JR-NW-2026-007",
        seenEvent: "HIRING_REQUIREMENT_SUBMITTED",
        hasLastResult: false,
        hasConfig: false,
        ts: "2026-05-27T17:46:48.591Z",
      },
      // `monitorAndFetchRequirement` is a real RAAS integration and must never
      // silently degrade to this diagnostic probe when a tenant registration
      // is missing. Keep only the semantically equivalent legacy probe name.
      aliases: ["pingProbe"],
      // 【刻意不声明 capabilities】诊断探针。绝不让诊断工具满足真实业务操作——
      // 缺集成必须 fail closed（把真实业务操作别名到探针上曾是本仓明令禁止的事）。
      sourcePath: "packages/tools/src/meta/ping.ts",
    },
  },
  // ── viz.* ───────────────────────────────────────────────────────────────
  {
    descriptor: svgChart,
    catalog: {
      name: "viz.svgChart",
      category: "viz",
      sideEffect: "read",
      operation: "compute",
      effectScope: "none",
      sandboxPolicy: "pure",
      summary:
        "Deterministic inline-SVG chart renderer (bar / donut / line / flow) — embed the returned svg verbatim in HTML reports.",
      description:
        "The numbers→geometry step is computed server-side so axes and proportions are always correct (LLM-freehand SVG charts routinely are not). Pure + deterministic: same spec, same SVG. Pairs with fs.writeHtmlToArchive / report.htmlToPdf for report generation.",
      argsSchema: {
        kind: { type: "'bar'|'donut'|'line'|'flow'", required: true },
        title: { type: "string" },
        data: {
          type: "Array<{label: string, value: number}>",
          description: "Required for bar/donut/line.",
        },
        steps: {
          type: "string[]",
          description: "Required for flow — the ordered step labels.",
        },
        width: { type: "number", description: "SVG width in px (default 480–640 by kind)." },
        palette: { type: "string[]", description: "Override the default color palette." },
      },
      argsExample: {
        kind: "bar",
        title: "各动作绑定工具数",
        data: [
          { label: "简历解析", value: 3 },
          { label: "简历匹配", value: 2 },
        ],
      },
      configSchema: {},
      returnsSchema: {
        svg: { type: "string", description: "Self-contained <svg>…</svg> markup." },
        width: { type: "number" },
        height: { type: "number" },
      },
      returnsExample: { svg: "<svg xmlns=…></svg>", width: 640, height: 94 },
      chainsWith: ["fs.writeHtmlToArchive", "report.htmlToPdf"],
      // 【刻意不声明 capabilities】纯渲染，不触达任何外部系统。
      sourcePath: "packages/tools/src/viz/svg-chart.ts",
    },
  },

  // ── report.* ────────────────────────────────────────────────────────────
  {
    descriptor: htmlToPdfTool,
    catalog: {
      name: "report.htmlToPdf",
      category: "report",
      sideEffect: "write",
      operation: "write",
      effectScope: "sandbox_local",
      sandboxPolicy: "sandbox_local",
      summary:
        "Render an HTML document to data/<subdir>/<tenant>/<id>.{html,pdf} via local headless Chrome (no bundled Chromium).",
      description:
        "Persists the HTML alongside the printed PDF so a missing Chrome degrades to 'HTML only', never data loss. Chrome discovery: CHROME_PATH env → common macOS/Linux install paths. Errors carry the fix instruction verbatim.",
      argsSchema: {
        html: {
          type: "string",
          required: true,
          description: "HTML body or full document. Aliases: `body`, `report`.",
        },
        title: { type: "string", description: "Used in the auto-wrapped <title>." },
      },
      argsExample: { html: "<h1>领域分析</h1><p>…</p>", title: "Ontology 分析报告" },
      configSchema: {
        subdir: { type: "string", default: "reports" },
        id_prefix: { type: "string", default: "report" },
        lang: { type: "string", default: "zh-CN" },
        timeout_ms: { type: "number", default: 60000 },
      },
      configExample: { subdir: "reports", id_prefix: "ontology" },
      returnsSchema: {
        id: { type: "string" },
        htmlPath: { type: "string" },
        pdfPath: { type: "string" },
        bytes: { type: "number", description: "PDF size in bytes." },
      },
      returnsExample: {
        id: "report-20260702120000-a1b2c3",
        htmlPath: "/abs/data/reports/raas/report-20260702120000-a1b2c3.html",
        pdfPath: "/abs/data/reports/raas/report-20260702120000-a1b2c3.pdf",
        bytes: 48213,
      },
      chainsWith: ["viz.svgChart"],
      // 本地容器磁盘写入。刻意【不】声明 Object_Storage_System：这些工具写的是
      // 容器盘，谎称覆盖对象存储会让能力匹配用一次本地写去满足 S3/MinIO 需求，
      // 生成的 agent 会静默地写错地方。当前没有 Agent 动作需要它，属预防性声明。
      capabilities: [{
        systems: ["local filesystem"],
        kinds: ["file_store"],
        roles: ["write", "writes"],
        operations: ["write-file"],
        objectTypes: ["*"],
      }],
      sourcePath: "packages/tools/src/report/pdf.ts",
    },
  },

  {
    descriptor: fetchActionRules,
    catalog: {
      name: "ontology.fetchActionRules",
      category: "ontology",
      summary: "Runtime: fetch the executor=Agent rules governing this action from the live ontology, so a rule-check agent folds against real, current rules.",
      sideEffect: "read",
      operation: "read",
      effectScope: "external",
      sandboxPolicy: "live_external",
      credentialPosture: "environment_reference_only",
      probeRequired: true,
      description:
        "Bound to a user-confirmed integration profile by the Agent Factory. The profile names env refs for the trusted Allmeta origin/key and pins the exact domain/action. Runtime compares that action with immutable factory provenance, accepts only the canonical Agent/Human executor enum, flags mandatory only from an explicit enum/boolean, and fails closed on drift or outage.",
      argsSchema: {},
      argsExample: {},
      configSchema: {
        base_url_env: { type: "string", required: true, description: "Env var name containing the trusted Allmeta origin." },
        api_key_env: { type: "string", required: true, description: "Env var name containing the Allmeta bearer credential." },
        domain: { type: "string", required: true, description: "Exact ontology domain id authorized by this profile." },
        action: { type: "string", required: true, description: "Exact ontology business action authorized by this profile." },
        timeout_ms: { type: "number", default: 8000 },
      },
      configExample: {
        base_url_env: "ONTOLOGY_GATEWAY_BASE_URL",
        api_key_env: "ONTOLOGY_GATEWAY_API_KEY",
        domain: "RAAS-v1",
        action: "ruleCheckForMatchResume",
      },
      // MIGRATION-DEBT(system-profiles 2026-07-22): "Allmeta_Ontology_System" 同上——档案跑通后移除。
      capabilities: [
        {
          systems: ["Allmeta", "Allmeta_Ontology_System", "本体/规则库"],
          kinds: ["rulebase", "datastore"],
          roles: ["read", "reads", "query"],
          operations: ["fetch-action-rules", "rules.fetch", "rules.select"],
          objectTypes: ["Rule"],
          probeRequired: true,
        },
        {
          // Allmeta's Action integration contract describes the same HTTP rule
          // endpoint as a graph_db read and associates it with the Action's
          // result object. The wildcard object remains narrow because Factory
          // requires the exact rules.fetch/rules.select operation for graph
          // requirements; this cannot satisfy an instance read or graph query.
          systems: ["Allmeta", "Allmeta_Ontology_System"],
          kinds: ["graph_db", "graph_database", "ontology"],
          roles: ["read", "reads", "query"],
          operations: ["rules.fetch", "rules.select"],
          requiresOperation: true,
          objectTypes: ["*"],
          probeRequired: true,
        },
      ],
      profileScope: {
        exact: [
          { configKey: "domain", source: "domain" },
          { configKey: "action", source: "action" },
        ],
      },
      returnsSchema: {
        rules: { type: "object[]", description: "executor=Agent rules for this action." },
        mandatory: { type: "object[]", description: "the mandatory subset — fail-close on any of these." },
        count: { type: "number" },
        source: { type: "string", description: "allmeta; integration failures throw and fail closed." },
      },
      returnsExample: { rules: [], mandatory: [], count: 0, source: "allmeta" },
      sourcePath: "packages/tools/src/ontology/fetch-action-rules.ts",
    },
  },

  {
    descriptor: ontologyWriteInstance,
    catalog: {
      name: "ontology.writeInstance",
      category: "ontology",
      summary:
        "Schema-validate and idempotently write one instance through an env-referenced, allowlisted Allmeta API boundary.",
      sideEffect: "write",
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      probeSafety: ONTOLOGY_WRITE_INSTANCE_PROBE_SAFETY,
      credentialPosture: "environment_reference_only",
      probeRequired: true,
      description:
        "The model supplies only object_type + properties. Trusted manifest config selects env refs for the Allmeta origin/token and pins tenant, domain, object and ontology-action allowlists. The tool fetches the live DataObject schema, validates exact fields/types/required primary key, then POSTs validate=strict with a deterministic Idempotency-Key. Redirects, malformed receipts and unconfigured dependencies fail closed.",
      argsSchema: {
        object_type: {
          type: "string",
          required: true,
          description: "Exact Allmeta DataObject label; must appear in config.allowed_objects.",
        },
        properties: {
          type: "Record<string, JSON value>",
          required: true,
          description: "Exact live-schema properties. URL/token/domain/action fields are not tool parameters.",
        },
      },
      argsExample: {
        object_type: "Candidate",
        properties: { candidate_id: "cand-123", name: "Wei Zhang", status: "active" },
      },
      configSchema: {
        base_url_env: { type: "string", required: true, description: "Env var name containing the trusted Allmeta origin." },
        api_key_env: { type: "string", required: true, description: "Env var name containing the Allmeta bearer credential." },
        domain: { type: "string", required: true, description: "Exact target ontology domain." },
        action: { type: "string", required: true, description: "Exact ontology business action authorizing this write." },
        allowed_tenants: { type: "string[]", required: true, description: "Exact tenant slugs/ids allowed to invoke this binding." },
        allowed_domains: { type: "string[]", required: true },
        allowed_objects: { type: "string[]", required: true },
        allowed_actions: { type: "string[]", required: true },
        probe_domain: {
          type: "string",
          required: true,
          description:
            "Dedicated Allmeta test domain, distinct from domain and outside allowed_domains.",
        },
        probe_action: {
          type: "string",
          required: true,
          description:
            "Dedicated test action coordinate, distinct from action and outside allowed_actions.",
        },
        probe_object: {
          type: "string",
          required: true,
          description:
            "Dedicated test-only DataObject inside probe_domain (never the business domain). It must not appear in allowed_objects and must be safe to DELETE after every probe.",
        },
        probe_namespace: {
          type: "string",
          required: true,
          description:
            "Operator-approved test namespace stored on every disposable canary; never a business tenant/entity namespace.",
        },
        probe_primary_key_field: {
          type: "string",
          required: true,
          description: "Primary-key field of probe_object; receives the generated canary target.",
        },
        probe_marker_field: {
          type: "string",
          required: true,
          description: "String field on probe_object reserved for the generated canary marker.",
        },
        probe_namespace_field: {
          type: "string",
          required: true,
          description: "String field on probe_object reserved for the approved namespace plus unique canary namespace.",
        },
        probe_idempotency_field: {
          type: "string",
          required: true,
          description: "String field on probe_object reserved for the generated idempotency identity.",
        },
        max_payload_bytes: { type: "number", default: 1048576 },
        timeout_ms: { type: "number", default: 15000 },
      },
      configExample: {
        base_url_env: "ALLMETA_BASE_URL",
        api_key_env: "ALLMETA_API_KEY",
        domain: "Agents-generation",
        action: "processResume",
        allowed_tenants: ["agents-generation"],
        allowed_domains: ["Agents-generation"],
        allowed_objects: ["Candidate", "Resume"],
        allowed_actions: ["processResume"],
        probe_domain: "Agent-Factory-Canary",
        probe_action: "verifyOntologyWriteIntegration",
        probe_object: "Agent_Factory_Write_Probe",
        probe_namespace: "agent-factory-production-canary",
        probe_primary_key_field: "probe_id",
        probe_marker_field: "probe_marker",
        probe_namespace_field: "probe_namespace",
        probe_idempotency_field: "idempotency_key",
      },
      capabilities: [{
        systems: ["Allmeta", "AllmetaOntology", "Allmeta_Ontology_System", "Neo4j ontology gateway"],
        kinds: ["ontology", "datastore", "graph_database", "graph_db"],
        roles: ["write", "writes", "persist", "upsert"],
        operations: [
          "write-instance",
          "upsert-instance",
          "persist-object",
          "instance.mirror",
          "instance.write",
          "cmr.mirror",
          "cmr.merge_overall",
        ],
        objectTypes: ["*"],
        probeRequired: true,
      }],
      profileScope: {
        exact: [
          { configKey: "domain", source: "domain" },
          { configKey: "action", source: "action" },
        ],
        allowlists: [
          { configKey: "allowed_tenants", source: "tenant", match: "any" },
          { configKey: "allowed_domains", source: "domain", match: "all" },
          { configKey: "allowed_actions", source: "action", match: "all" },
          { configKey: "allowed_objects", source: "objects", match: "all" },
        ],
      },
      returnsSchema: {
        domain: { type: "string" },
        object_type: { type: "string" },
        primary_key: { type: "string" },
        primary_value: { type: "string" },
        idempotency_key: { type: "string" },
        payload_sha256: { type: "string" },
        schema_sha256: { type: "string" },
        upserted: { type: "string[]" },
        count: { type: "number" },
      },
      returnsExample: {
        domain: "Agents-generation",
        object_type: "Candidate",
        primary_key: "candidate_id",
        primary_value: "cand-123",
        idempotency_key: "allmeta-9f5a7e...",
        payload_sha256: "62d79a...",
        schema_sha256: "f40cc1...",
        upserted: ["cand-123"],
        count: 1,
      },
      sourcePath: "packages/tools/src/ontology/write-instance.ts",
    },
  },

  {
    descriptor: persistRuleCheckAudit,
    catalog: {
      name: "persistRuleCheckAudit",
      aliases: ["records.persistRuleCheckAudit"],
      category: "records",
      summary:
        "Verify and durably persist one ontology rule-check audit plus per-rule evidence before any business event is emitted.",
      sideEffect: "write",
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      credentialPosture: "environment_reference_only",
      probeRequired: true,
      description:
        "Consumes the structured output of reasoning.evaluateRules, recomputes its mandatory/optional fold, and rejects inconsistent or incomplete verdicts. Atomically upserts the legacy RAAS RuleCheckAudit + RuleCheckFlag rows through configured PostgreSQL. Optional Allmeta mirroring uses only the strict HTTP instance API. PostgreSQL is mandatory and every configured target is fail-closed. The stable audit id makes retries idempotent.",
      argsSchema: {},
      argsExample: {},
      configSchema: {
        tenant: {
          type: "string",
          required: true,
          description: "Exact tenant slug authorized by the reviewed integration profile.",
        },
        domain: {
          type: "string",
          required: true,
          description: "Exact ontology domain that owns Rule_Check_Audit.",
        },
        action: {
          type: "string",
          required: true,
          description: "Exact ontology action authorized to produce this audit.",
        },
        postgres_url_env: {
          type: "string",
          required: true,
          description: "Server env ref containing the configured RAAS PostgreSQL URL.",
        },
        allmeta_base_url_env: {
          type: "string",
          description: "Optional server env ref for Allmeta base URL; must be paired with allmeta_api_key_env.",
        },
        allmeta_api_key_env: {
          type: "string",
          description: "Optional server env ref for the Allmeta bearer key; must be paired with allmeta_base_url_env.",
        },
        timeout_ms: { type: "number", default: 8000 },
      },
      configExample: {
        tenant: "zhaopin",
        domain: "Agents-generation",
        action: "ruleCheckForMatchResume",
        postgres_url_env: "RAAS_POSTGRES_URL",
        allmeta_base_url_env: "ALLMETA_BASE_URL",
        allmeta_api_key_env: "ALLMETA_API_KEY",
        timeout_ms: 8000,
      },
      capabilities: [
        {
          systems: ["RAAS_System", "PostgreSQL", "Postgres"],
          kinds: ["database", "datastore", "relational_database"],
          roles: ["write", "writes", "persist", "upsert"],
          operations: ["persist-rule-audit", "upsert-audit-evidence"],
          objectTypes: ["Rule_Check_Audit", "RuleCheckFlag"],
          probeRequired: true,
        },
        {
          systems: ["Allmeta", "AllmetaOntology", "Allmeta_Ontology_System"],
          kinds: ["ontology", "datastore", "graph_database"],
          roles: ["write", "writes", "persist", "upsert"],
          operations: ["write-instance", "persist-rule-audit"],
          objectTypes: ["Rule_Check_Audit"],
          probeRequired: true,
        },
      ],
      profileScope: {
        exact: [
          { configKey: "tenant", source: "tenantSlug" },
          { configKey: "domain", source: "domain" },
          { configKey: "action", source: "action" },
        ],
      },
      // No probeSafety declaration: this writer consumes a completed rule
      // evaluation and cannot truthfully manufacture/delete one without a
      // deployment-specific PG + Allmeta cleanup/readback lifecycle. The
      // generic probe boundary therefore remains fail-closed and asks the
      // operator for that lifecycle instead of leaving canary audit rows.
      returnsSchema: {
        audit_id: { type: "string" },
        audit: { type: "object" },
        rule_check_result: { type: "'通过'|'未通过'" },
        rule_check_reason: { type: "string" },
        rule_check_rules: { type: "object[]" },
        _rule_audit_persistence: {
          type: "object",
          description: "PostgreSQL/Allmeta write receipt and exact scope.",
        },
      },
      returnsExample: {
        audit_id: "rca_7f0c…",
        rule_check_result: "通过",
        rule_check_reason: "",
        rule_check_rules: [],
        _rule_audit_persistence: {
          postgres: "written",
          allmeta: "written",
          domain: "Agents-generation",
          action: "ruleCheckForMatchResume",
        },
      },
      sourcePath: "packages/tools/src/records/persist-rule-check-audit.ts",
    },
  },
  {
    descriptor: recordsUpsert,
    catalog: {
      name: "records.upsert",
      category: "records",
      summary: "Persist a durable business record (candidate / resume / job_posting / candidate_match_result / candidate_identity_result / communication_log) that outlives the run; pass-through so it can sit mid-pipeline.",
      sideEffect: "write",
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      probeSafety: RECORDS_UPSERT_PROBE_SAFETY,
      description:
        "New-arch-native durable record store. Reads the current step's data (ctx.event.data + ctx.lastResult), upserts a row into business_records keyed by (tenant, record_type, record_key), and tags it with run/correlation/candidate. candidate_identity_result uses its explicit result id or the real candidate+resume composite identity; it never invents a hash key. PASS-THROUGH: echoes the upstream result so it never starves the next step or hijacks _emit — place it non-terminally. Fail-closed: invalid identity, tenant, or persistence aborts the tool step.",
      argsSchema: {},
      argsExample: {},
      configSchema: {
        record_type: {
          type: "string",
          required: true,
          allowedValues: [
            "candidate",
            "resume",
            "job_posting",
            "candidate_match_result",
            "candidate_identity_result",
            "communication_log",
          ],
          description:
            "Exact business-record kind. This is execution configuration, not a value inferred from the Action description.",
        },
        key_field: { type: "string", description: "Override the field used as the business identity (record_key)." },
        candidate_field: { type: "string", description: "Field holding the candidate id (default candidate_id)." },
        append: { type: "boolean", description: "For communication_log: always insert a fresh row instead of upserting." },
      },
      configExample: { record_type: "candidate", candidate_field: "candidate_id" },
      capabilities: [{ systems: ["local records"], kinds: ["datastore"], roles: ["writes"], operations: ["upsert"], objectTypes: ["Candidate", "Resume", "Job_Posting", "Candidate_Match_Result", "Candidate_Identity_Result", "Communication_Log"] }],
      returnsSchema: {
        _record: {
          type: "object",
          required: true,
          description:
            "Persistence receipt: {record_id, record_type, record_key, upserted:true}. Other top-level fields are the pass-through business payload.",
        },
        candidate_identity_result_id: {
          type: "string",
          description: "Present for candidate_identity_result writes.",
        },
      },
      returnsExample: {
        candidate_id: "cand-1",
        _record: {
          record_id: "rec-abc123",
          record_type: "candidate",
          record_key: "cand-1",
          upserted: true,
        },
      },
      sourcePath: "packages/tools/src/records/upsert.ts",
    },
  },

  // ── generic data plane ─────────────────────────────────────────────────
  {
    descriptor: documentConvert,
    catalog: {
      name: "document.convert",
      category: "document",
      summary:
        "Convert magic-byte-verified PDF/DOCX/TXT/MD bytes to a real PDF, isolated and bounded for downstream multipart upload.",
      sideEffect: "read",
      operation: "compute",
      effectScope: "none",
      sandboxPolicy: "pure",
      credentialPosture: "none",
      probeRequired: false,
      description:
        "Preferred usage is no args immediately after objectStore.getObject or fs.readFromInbox. PDF bytes pass through; DOCX extraction runs in a memory-limited child process and TXT/MD/DOCX text renders through a separate system Chromium process. Inputs, outputs, extracted text and wall time are bounded; temporary files are always removed. OLE2 .doc and missing dependencies fail closed with typed errors.",
      argsSchema: {
        document_base64: {
          type: "string",
          description: "Canonical base64 bytes; omit when chaining from lastResult (preferred).",
        },
        base64: {
          type: "string",
          description: "Alias for document_base64; mutually exclusive.",
        },
        filename: { type: "string", description: "Name hint only; bytes determine the real format." },
        mime: { type: "string", description: "Non-authoritative content-type hint." },
      },
      argsExample: {},
      configSchema: {
        chromium_path_env: { type: "string", description: "Optional env var name containing an absolute Chromium executable path." },
        allowed_formats: { type: "string[]", default: ["pdf", "docx", "text", "markdown"] },
        max_input_bytes: { type: "number", default: 10485760 },
        max_output_bytes: { type: "number", default: 20971520 },
        max_text_bytes: { type: "number", default: 5242880 },
        timeout_ms: { type: "number", default: 45000 },
        worker_memory_mb: { type: "number", default: 192 },
      },
      configExample: { allowed_formats: ["pdf", "docx", "text", "markdown"], max_input_bytes: 10485760 },
      capabilities: [{
        systems: ["local", "runtime", "document processing"],
        kinds: ["document", "file_transform", "document_conversion"],
        roles: ["convert", "converts", "normalize", "compute"],
        operations: ["convert-to-pdf", "normalize-document", "prepare-multipart-pdf"],
        objectTypes: ["Document", "Resume", "Job_Posting"],
        probeRequired: false,
      }],
      returnsSchema: {
        filename: { type: "string" },
        mime: { type: "'application/pdf'" },
        base64: { type: "string", description: "Real PDF bytes for parseResumeApi multipart upload." },
        sha256: { type: "string" },
        input_sha256: { type: "string" },
        bytes: { type: "number" },
        input_bytes: { type: "number" },
        source_format: { type: "'pdf'|'docx'|'text'|'markdown'" },
        converted: { type: "boolean" },
      },
      returnsExample: {
        filename: "resume.pdf",
        mime: "application/pdf",
        base64: "JVBERi0xLjcK...",
        sha256: "d2c2bfe6...",
        input_sha256: "f69be4d9...",
        bytes: 48211,
        input_bytes: 21743,
        source_format: "docx",
        converted: true,
      },
      chainsWith: ["objectStore.getObject", "fs.readFromInbox", "parseResumeApi"],
      sourcePath: "packages/tools/src/document/convert.ts",
    },
  },
  {
    descriptor: objectStoreGetObject,
    catalog: {
      name: "objectStore.getObject",
      category: "object-store",
      summary:
        "Read a bounded S3/MinIO object through a trusted endpoint with SigV4 credentials referenced only from server environment variables.",
      sideEffect: "read",
      operation: "read",
      effectScope: "external",
      sandboxPolicy: "live_external",
      credentialPosture: "environment_reference_only",
      probeRequired: true,
      description:
        "The call supplies only bucket/object_key. endpoint is trusted manifest config or endpoint_env; access/secret/session credentials are env references. Bucket/key validation, redirect rejection, timeout and streaming size limits are enforced before base64 is returned.",
      argsSchema: {
        bucket: {
          type: "string",
          description: "Validated S3/MinIO bucket. Optional when config.default_bucket is fixed.",
        },
        object_key: {
          type: "string",
          required: true,
          description: "Relative object key; traversal, empty segments, controls and malformed encoding are rejected.",
        },
      },
      argsExample: { bucket: "documents", object_key: "incoming/contract.pdf" },
      configSchema: {
        endpoint: {
          type: "string",
          description: "Trusted server/manifest http(s) origin. Mutually exclusive with endpoint_env.",
        },
        endpoint_env: {
          type: "string",
          description: "Server env var containing the trusted object-store origin.",
        },
        access_key_env: { type: "string", description: "Server env ref; required for auth=sigv4." },
        secret_key_env: { type: "string", description: "Server env ref; required for auth=sigv4." },
        session_token_env: { type: "string", description: "Optional server env ref for temporary credentials." },
        auth: { type: "string", allowedValues: ["sigv4", "anonymous"], default: "sigv4" },
        region: { type: "string", default: "us-east-1" },
        force_path_style: { type: "boolean", default: true },
        default_bucket: { type: "string" },
        allowed_buckets: { type: "string[]" },
        max_bytes: { type: "number", default: 10485760 },
        timeout_ms: { type: "number", default: 30000 },
      },
      configContract: {
        atLeastOne: [{ keys: ["endpoint", "endpoint_env"] }],
        mutuallyExclusive: [{ keys: ["endpoint", "endpoint_env"] }],
        requiredUnless: [{
          keys: ["access_key_env", "secret_key_env"],
          unless: { key: "auth", equals: "anonymous" },
        }],
      },
      configExample: {
        endpoint_env: "TENANT_OBJECT_STORE_ENDPOINT",
        access_key_env: "TENANT_OBJECT_STORE_ACCESS_KEY",
        secret_key_env: "TENANT_OBJECT_STORE_SECRET_KEY",
        default_bucket: "documents",
        max_bytes: 10485760,
      },
      capabilities: [
        {
          systems: ["S3", "Amazon S3", "MinIO", "object storage", "Object_Storage_System"],
          kinds: ["object_store", "object storage", "object_storage", "file_store", "datastore"],
          roles: ["read", "reads", "fetch"],
          operations: ["get-object", "read-object", "download"],
          objectTypes: ["*"],
          probeRequired: true,
        },
      ],
      returnsSchema: {
        bucket: { type: "string" },
        object_key: { type: "string" },
        filename: { type: "string" },
        mime: { type: "string" },
        base64: { type: "string" },
        sha256: { type: "string", description: "Lowercase SHA-256 hex of the downloaded bytes." },
        bytes: { type: "number" },
        etag: { type: "string|null" },
        last_modified: { type: "string|null" },
      },
      returnsExample: {
        bucket: "documents",
        object_key: "incoming/contract.pdf",
        filename: "contract.pdf",
        mime: "application/pdf",
        base64: "JVBERi0xLjQK...",
        sha256: "b7c36c1c3d6c4a9e508a8f407e7f302e2b66ab874c95cc132b4b8d88ba4c5f4d",
        bytes: 42816,
        etag: "\"3b83ef96387f14655fc854ddc3c6bd57\"",
        last_modified: "Mon, 13 Jul 2026 08:00:00 GMT",
      },
      sourcePath: "packages/tools/src/object-store/get-object.ts",
    },
  },
  {
    descriptor: postgresExecuteStatement,
    catalog: {
      name: "postgres.executeStatement",
      category: "postgres",
      summary:
        "Execute a named parameterized PostgreSQL operation from a server environment statement catalog; raw SQL and connection URLs are never accepted from the model.",
      sideEffect: "dual",
      operation: "read_write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      credentialPosture: "environment_reference_only",
      probeRequired: true,
      description:
        "Trusted config names the connection URL env var and JSON statement-catalog env var. Each catalog entry declares sql, ordered params, read/write mode and optional row cap. Reads run in a READ ONLY transaction; writes additionally require config.allow_write=true.",
      argsSchema: {
        operation: { type: "string", required: true, description: "Named operation present in the server catalog." },
        values: {
          type: "Record<string, JSON value>",
          required: true,
          description: "Must contain exactly the catalog entry's named params. Values are sent through pg parameter binding.",
        },
      },
      argsExample: { operation: "candidate.findById", values: { candidate_id: "cand-123" } },
      configSchema: {
        connection_url_env: { type: "string", required: true, description: "Server env ref containing a postgres:// URL." },
        statement_catalog_env: {
          type: "string",
          required: true,
          description: "Server env ref containing JSON: {operation:{sql,params:string[],mode:'read'|'write',max_rows?}}.",
        },
        allowed_operations: { type: "string[]", description: "Optional tenant-level subset of catalog operations." },
        allow_write: { type: "boolean", default: false },
        write_probe_connection_url_env: {
          type: "string",
          required: true,
          description:
            "Dedicated server env ref for the disposable canary database role/connection. It must differ from connection_url_env and must be limited to the probe namespace.",
        },
        write_probe_statement_catalog_env: {
          type: "string",
          required: true,
          description:
            "Dedicated env ref containing exactly the code-owned create/readback/cleanup canary catalog; it must differ from statement_catalog_env.",
        },
        write_probe_namespace: {
          type: "string",
          required: true,
          description:
            "Pre-provisioned PostgreSQL schema named agent_factory_probe or prefixed agent_factory_probe_; contains only agent_factory_write_probe_canaries.",
        },
        write_probe_create_operation: {
          type: "string",
          required: true,
          description: "Dedicated idempotent canary create operation name.",
        },
        write_probe_readback_operation: {
          type: "string",
          required: true,
          description: "Dedicated exact canary readback operation name.",
        },
        write_probe_cleanup_operation: {
          type: "string",
          required: true,
          description: "Dedicated exact canary delete operation name.",
        },
        max_rows: { type: "number", default: 1000 },
        max_values_bytes: { type: "number", default: 1048576 },
        timeout_ms: { type: "number", default: 30000 },
      },
      configExample: {
        connection_url_env: "TENANT_POSTGRES_URL",
        statement_catalog_env: "TENANT_POSTGRES_STATEMENTS",
        allowed_operations: ["candidate.findById"],
        allow_write: false,
        write_probe_connection_url_env: "TENANT_POSTGRES_PROBE_URL",
        write_probe_statement_catalog_env: "TENANT_POSTGRES_PROBE_STATEMENTS",
        write_probe_namespace: "agent_factory_probe_tenant",
        write_probe_create_operation: "agentFactoryProbe.create",
        write_probe_readback_operation: "agentFactoryProbe.readback",
        write_probe_cleanup_operation: "agentFactoryProbe.cleanup",
      },
      probeSafety: POSTGRES_EXECUTE_STATEMENT_PROBE_SAFETY,
      capabilities: [
        {
          systems: ["PostgreSQL", "Postgres"],
          kinds: ["database", "datastore", "relational_database"],
          roles: ["read", "reads", "query"],
          operations: ["execute-statement", "query", "select"],
          objectTypes: ["*"],
          probeRequired: true,
        },
        {
          systems: ["PostgreSQL", "Postgres"],
          kinds: ["database", "datastore", "relational_database"],
          roles: ["write", "writes", "persist"],
          operations: ["execute-statement", "insert", "update", "delete", "upsert"],
          objectTypes: ["*"],
          probeRequired: true,
        },
      ],
      returnsSchema: {
        operation: { type: "string" },
        mode: { type: "'read'|'write'" },
        command: { type: "string" },
        row_count: { type: "number" },
        rows: { type: "unknown[]", description: "SELECT rows or write RETURNING rows, bounded by max_rows." },
      },
      returnsExample: {
        operation: "candidate.findById",
        mode: "read",
        command: "SELECT",
        row_count: 1,
        rows: [{ candidate_id: "cand-123", status: "active" }],
      },
      sourcePath: "packages/tools/src/postgres/execute-statement.ts",
    },
  },
  {
    descriptor: postgresExecuteTransaction,
    catalog: {
      name: "postgres.executeTransaction",
      category: "postgres",
      summary:
        "Atomically execute an ordered batch of unique named PostgreSQL catalog operations on one connection; any failure rolls back the complete batch.",
      sideEffect: "dual",
      operation: "read_write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      credentialPosture: "environment_reference_only",
      probeRequired: true,
      description:
        "The caller supplies exactly operations:[{operation,values}]. SQL, modes, parameter order, and row caps come from an environment-backed server catalog; raw SQL and connection URLs are rejected. A batch containing any write requires trusted config.allow_write=true.",
      argsSchema: {
        operations: {
          type: "Array<{operation:string,values:Record<string, JSON value>}>",
          required: true,
          description:
            "Non-empty ordered batch. Operation names must be unique and present in the server catalog; each values object must exactly match that entry's named params.",
        },
      },
      argsExample: {
        operations: [
          {
            operation: "application.updateStatus",
            values: { application_id: "app-123", status: "screened" },
          },
          {
            operation: "audit.insert",
            values: {
              application_id: "app-123",
              action: "screened",
            },
          },
        ],
      },
      configSchema: {
        connection_url_env: {
          type: "string",
          required: true,
          description: "Server env ref containing a postgres:// URL.",
        },
        statement_catalog_env: {
          type: "string",
          required: true,
          description:
            "Server env ref containing JSON: {operation:{sql,params:string[],mode:'read'|'write',max_rows?}}.",
        },
        allowed_operations: {
          type: "string[]",
          description: "Optional exact tenant-level subset of catalog operations.",
        },
        allow_write: {
          type: "boolean",
          default: false,
          description:
            "Trusted opt-in required when at least one catalog operation has mode:'write'.",
        },
        write_probe_connection_url_env: {
          type: "string",
          required: true,
          description:
            "Dedicated server env ref for the disposable canary database role/connection. It must differ from connection_url_env and must be limited to the probe namespace.",
        },
        write_probe_statement_catalog_env: {
          type: "string",
          required: true,
          description:
            "Dedicated env ref containing exactly the code-owned create/readback/cleanup canary catalog; it must differ from statement_catalog_env.",
        },
        write_probe_namespace: {
          type: "string",
          required: true,
          description:
            "Pre-provisioned PostgreSQL schema named agent_factory_probe or prefixed agent_factory_probe_; contains only agent_factory_write_probe_canaries.",
        },
        write_probe_create_operation: {
          type: "string",
          required: true,
          description: "Dedicated idempotent canary create operation name.",
        },
        write_probe_readback_operation: {
          type: "string",
          required: true,
          description: "Dedicated exact canary readback operation name.",
        },
        write_probe_cleanup_operation: {
          type: "string",
          required: true,
          description: "Dedicated exact canary delete operation name.",
        },
        max_operations: { type: "number", default: 20 },
        max_batch_bytes: { type: "number", default: 1048576 },
        max_rows: {
          type: "number",
          default: 1000,
          description: "Global per-operation affected/result-row cap, also bounded by each catalog entry's max_rows.",
        },
        timeout_ms: {
          type: "number",
          default: 30000,
          description: "Total transaction deadline and query timeout budget.",
        },
      },
      configExample: {
        connection_url_env: "TENANT_POSTGRES_URL",
        statement_catalog_env: "TENANT_POSTGRES_STATEMENTS",
        allowed_operations: [
          "application.updateStatus",
          "audit.insert",
        ],
        allow_write: true,
        write_probe_connection_url_env: "TENANT_POSTGRES_PROBE_URL",
        write_probe_statement_catalog_env: "TENANT_POSTGRES_PROBE_STATEMENTS",
        write_probe_namespace: "agent_factory_probe_tenant",
        write_probe_create_operation: "agentFactoryProbe.create",
        write_probe_readback_operation: "agentFactoryProbe.readback",
        write_probe_cleanup_operation: "agentFactoryProbe.cleanup",
        max_operations: 10,
        max_batch_bytes: 262144,
        max_rows: 100,
        timeout_ms: 15000,
      },
      probeSafety: POSTGRES_EXECUTE_TRANSACTION_PROBE_SAFETY,
      capabilities: [
        {
          systems: ["PostgreSQL", "Postgres"],
          kinds: ["database", "datastore", "relational_database"],
          roles: ["read", "reads", "query"],
          operations: [
            "transaction",
            "execute-transaction",
            "atomic-batch",
            "transactional-query",
          ],
          objectTypes: ["*"],
          probeRequired: true,
        },
        {
          systems: ["PostgreSQL", "Postgres"],
          kinds: ["database", "datastore", "relational_database"],
          roles: ["write", "writes", "persist"],
          operations: [
            "transaction",
            "execute-transaction",
            "atomic-batch",
            "transactional-write",
          ],
          objectTypes: ["*"],
          probeRequired: true,
        },
      ],
      returnsSchema: {
        mode: { type: "'read'|'write'" },
        committed: { type: "true" },
        operation_count: { type: "number" },
        operation_order: {
          type: "string[]",
          description: "Catalog operation names in execution order.",
        },
        operation_results: {
          type: "Record<string,{index,operation,mode,command,row_count,rows}>",
          description:
            "Each committed step result keyed by its exact operation name for deterministic downstream mapping.",
        },
      },
      returnsExample: {
        mode: "write",
        committed: true,
        operation_count: 2,
        operation_order: ["application.updateStatus", "audit.insert"],
        operation_results: {
          "application.updateStatus": {
            index: 0,
            operation: "application.updateStatus",
            mode: "write",
            command: "UPDATE",
            row_count: 1,
            rows: [{ application_id: "app-123", status: "screened" }],
          },
          "audit.insert": {
            index: 1,
            operation: "audit.insert",
            mode: "write",
            command: "INSERT",
            row_count: 1,
            rows: [{ audit_id: "audit-456" }],
          },
        },
      },
      sourcePath: "packages/tools/src/postgres/execute-transaction.ts",
    },
  },
  {
    descriptor: cryptoSha256,
    catalog: {
      name: "crypto.sha256",
      category: "crypto",
      summary: "Pure deterministic SHA-256 over utf8 text, strict base64/hex bytes, or canonical JSON.",
      sideEffect: "read",
      operation: "compute",
      effectScope: "none",
      sandboxPolicy: "pure",
      credentialPosture: "none",
      probeRequired: false,
      description:
        "Exactly one input representation is accepted. Canonical JSON recursively sorts object keys; no clock, randomness, network, filesystem or credential is involved.",
      argsSchema: {
        text: { type: "string", description: "UTF-8 text; mutually exclusive with base64/hex/json." },
        base64: { type: "string", description: "Canonical padded standard base64." },
        hex: { type: "string", description: "Even-length hexadecimal bytes." },
        json: { type: "unknown", description: "JSON value canonicalized before hashing." },
      },
      argsExample: { text: "hello" },
      configSchema: {
        max_bytes: { type: "number", default: 10485760 },
      },
      configExample: { max_bytes: 10485760 },
      capabilities: [
        {
          systems: ["local", "runtime", "cryptography"],
          kinds: ["crypto", "utility", "computation"],
          roles: ["compute", "computes", "hash"],
          operations: ["sha256", "hash"],
          objectTypes: ["*"],
          probeRequired: false,
        },
      ],
      returnsSchema: {
        sha256: { type: "string" },
        bytes: { type: "number" },
        input_type: { type: "'text'|'base64'|'hex'|'json'" },
      },
      returnsExample: {
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        bytes: 5,
        input_type: "text",
      },
      sourcePath: "packages/tools/src/crypto/sha256.ts",
    },
  },
  // ── search.* ────────────────────────────────────────────────────────────
  {
    descriptor: webSearch,
    catalog: {
      name: "search.web",
      category: "search",
      operation: "read",
      effectScope: "external",
      sandboxPolicy: "live_external",
      summary:
        "Read-only public web search with normalized sources for Deep Search agents.",
      description:
        "Supports Tavily (default), Brave Search, Serper, or a compatible custom endpoint. Advanced Tavily searches request cleaned source Markdown and return it under strict per-result and aggregate size limits, letting the agent inspect source evidence while owning its citations.",
      argsSchema: {
        query: {
          type: "string",
          required: true,
          description:
            "One focused search query. Issue multiple varied queries for broad research.",
        },
        max_results: { type: "number", default: 8, description: "1-20." },
        search_depth: { type: "'basic'|'advanced'", default: "basic" },
        include_raw_content: {
          type: "boolean",
          description:
            "Tavily only. Requests cleaned source Markdown; defaults to true for advanced searches and false for basic searches.",
        },
        include_domains: { type: "string[]" },
        exclude_domains: { type: "string[]" },
        time_range: {
          type: "string",
          description: "Provider-native freshness filter when supported.",
        },
      },
      argsExample: {
        query: "durable agent workflow runtime primary source",
        max_results: 8,
        search_depth: "advanced",
      },
      configSchema: {
        provider: {
          type: "'tavily'|'brave'|'serper'|'custom'",
          default: "tavily",
        },
        api_key_env: {
          type: "string",
          description:
            "Tenant-scoped env name. Defaults to the selected provider's standard env var.",
        },
        base_url: {
          type: "string",
          description:
            "Optional endpoint override. It must be provider-owned or server-allowlisted and requires an explicit tenant-scoped api_key_env.",
        },
        timeout_ms: { type: "number", default: 30000 },
        max_content_chars_per_result: {
          type: "number",
          default: 12000,
          description: "Server-capped at 30,000 characters.",
        },
        max_content_chars_total: {
          type: "number",
          default: 48000,
          description: "Server-capped at 100,000 characters.",
        },
        max_content_bytes_per_result: {
          type: "number",
          default: 48000,
          description: "Server-capped at 120,000 UTF-8 bytes.",
        },
        max_content_bytes_total: {
          type: "number",
          default: 192000,
          description: "Server-capped at 400,000 UTF-8 bytes.",
        },
      },
      configExample: {
        provider: "tavily",
        api_key_env: "TENANT_X_TAVILY_API_KEY",
      },
      returnsSchema: {
        query: { type: "string" },
        provider: { type: "string" },
        results: {
          type: "Array<{title,url,snippet,publishedAt,score,content,contentCharacters,contentBytes,contentTruncated}>",
          description:
            "Normalized evidence candidates with citeable URLs and optional bounded source Markdown.",
        },
        contentRequested: { type: "boolean" },
        contentCharacters: { type: "number" },
        contentBytes: { type: "number" },
        contentTruncated: {
          type: "boolean",
          description:
            "True when any returned source content exceeded a per-result or aggregate content budget.",
        },
      },
      // 【刻意不声明 capabilities】通用检索传输，理由同 http.fetch。
      sourcePath: "packages/tools/src/search/web.ts",
      sideEffect: "read",
      testPolicy: "allow",
    },
  },

  // ── ontology.* ──────────────────────────────────────────────────────────
  {
    descriptor: ontologyQuery,
    catalog: {
      name: "ontology.query",
      category: "ontology",
      operation: "read",
      effectScope: "external",
      sandboxPolicy: "live_external",
      summary:
        "Tenant-scoped, read-only Neo4j Query API SDK with generated parameterized Cypher.",
      description:
        "The model chooses a bounded retrieval operation and values, never raw Cypher. The SDK generates the statement, requests Query API accessMode Read, projects only server-allowlisted properties, and applies the tenant predicate to every matched node (including all nodes in a path). The Neo4j principal must also be read-only because accessMode controls routing, not authorization.",
      argsSchema: {
        operation: {
          type: "'search_nodes'|'get_node'|'neighbors'|'find_paths'|'schema'",
          required: true,
        },
        query: {
          type: "string",
          description: "Required by search_nodes.",
        },
        id: {
          type: "string",
          description: "Required by get_node and neighbors.",
        },
        start_id: { type: "string", description: "Required by find_paths." },
        end_id: { type: "string", description: "Required by find_paths." },
        max_depth: {
          type: "number",
          default: 3,
          description: "find_paths only; clamped to 1-4.",
        },
        labels: { type: "string[]" },
        properties: { type: "string[]" },
        relationship_types: { type: "string[]" },
        neighbor_labels: { type: "string[]" },
        limit: {
          type: "number",
          default: 20,
          description: "Clamped to 1-100.",
        },
      },
      argsExample: {
        operation: "neighbors",
        id: "customer-42",
        relationship_types: ["OWNS", "USES"],
        limit: 20,
      },
      configSchema: {
        base_url: {
          type: "string",
          description:
            "Neo4j Query API origin or full /db/<database>/query/v2 URL. Defaults to the server-pinned NEO4J_QUERY_API_URL. An override must be server-allowlisted and use explicit tenant-scoped credential env names.",
        },
        database: { type: "string", default: "neo4j" },
        username_env: { type: "string", default: "NEO4J_USERNAME" },
        password_env: { type: "string", default: "NEO4J_PASSWORD" },
        tenant_property: {
          type: "string",
          default: "tenant_slug",
          description:
            "Server-owned isolation key; an agent may only repeat the configured NEO4J_TENANT_PROPERTY value.",
        },
        id_property: {
          type: "string",
          default: "id",
          description:
            "Server-owned identifier key; an agent may only repeat the configured NEO4J_ID_PROPERTY value.",
        },
        search_properties: {
          type: "string[]",
          default: ["name", "title", "description", "summary", "content"],
        },
        timeout_ms: { type: "number", default: 20000 },
        max_execution_time_ms: { type: "number", default: 15000 },
      },
      configExample: {
        username_env: "TENANT_X_NEO4J_USERNAME",
        password_env: "TENANT_X_NEO4J_PASSWORD",
      },
      returnsSchema: {
        operation: { type: "string" },
        fields: { type: "string[]" },
        records: { type: "Record<string,unknown>[]" },
        count: { type: "number" },
        truncated: { type: "boolean" },
      },
      // A declared capability is the ONLY thing that can satisfy an Ontology
      // integration requirement — semantic similarity may recommend a tool, but
      // it can never bind one. This entry had none, so a domain declaring
      // `Allmeta_Ontology_System / graph_db / read` (the rule-gate actions do)
      // could not bind the read-only Neo4j Query API tool we already ship: the
      // action blocked, and the FDE was told to go build a tool that exists.
      // `ontology.fetchActionRules` does not cover it (kinds rulebase/datastore)
      // and `ontology.writeInstance` is write-only; kind matching is exact.
      //
      // `operations` are taken verbatim from this entry's own argsSchema union —
      // an invented spelling would simply fail to match. `systems` mirrors
      // ontology.writeInstance: same Allmeta boundary, opposite direction.
      capabilities: [{
        systems: ["Allmeta", "AllmetaOntology", "Allmeta_Ontology_System", "Neo4j ontology gateway"],
        kinds: ["graph_db", "graph_database", "ontology", "datastore"],
        roles: ["read", "reads", "query"],
        operations: [
          "query",
          "search_nodes",
          "get_node",
          "neighbors",
          "find_paths",
          "schema",
          "graph.verify",
        ],
        objectTypes: ["*"],
        probeRequired: true,
      }],
      sourcePath: "packages/tools/src/ontology/query.ts",
      sideEffect: "read",
      testPolicy: "allow",
    },
  },

  // ── browser.* — session-based computer-use over system Chrome/Chromium ──
  // (design §G5). One shared config vocabulary: sessions are created by
  // browser.openSession and addressed by sessionId. Read-only page inspection
  // is live_external; anything that can trigger state change on the visited
  // site (opening/navigating INTO a workflow, clicking, filling) is treated
  // as an external write behind requires_attempt_grant so sandbox mode
  // records instead of firing.
  {
    descriptor: browserOpenSession,
    catalog: {
      name: "browser.openSession",
      category: "browser",
      summary:
        "Open a headless Chrome/Chromium session (optionally at {url}); returns the sessionId for subsequent browser.* calls.",
      sideEffect: "dual",
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      credentialPosture: "none",
      description:
        "Launches the SYSTEM Chrome/Chromium via playwright-core (no bundled browser). Executable resolution: BROWSER_TOOLS_EXECUTABLE env → Playwright channel 'chrome' → /Applications/Google Chrome.app → /usr/bin/chromium*; fails closed with a fix instruction when none exists. Max 4 concurrent sessions; idle sessions are reaped after 5 minutes.",
      argsSchema: {
        url: {
          type: "string",
          description: "Optional http/https URL to open immediately.",
        },
      },
      argsExample: { url: "http://localhost:3620/ui/transfers" },
      configSchema: {},
      returnsSchema: {
        sessionId: { type: "string", description: "Opaque handle for subsequent calls." },
        title: { type: "string" },
        url: { type: "string" },
      },
      returnsExample: {
        sessionId: "bses-9f2c1a0b4d6e8a01",
        title: "调拨单 · Meta ERP",
        url: "http://localhost:3620/ui/transfers",
      },
      chainsWith: ["browser.read", "browser.fill", "browser.click"],
      sourcePath: "packages/tools/src/browser/tools.ts",
    },
  },
  {
    descriptor: browserNavigate,
    catalog: {
      name: "browser.navigate",
      category: "browser",
      summary: "Navigate an open browser session to a new http/https URL.",
      sideEffect: "read",
      operation: "read",
      effectScope: "external",
      sandboxPolicy: "live_external",
      description:
        "GET-semantics navigation of an existing session; waits for DOMContentLoaded (10s timeout) and returns the landed {title,url}.",
      argsSchema: {
        sessionId: { type: "string", required: true },
        url: { type: "string", required: true },
      },
      argsExample: { sessionId: "bses-9f2c1a0b4d6e8a01", url: "http://localhost:3620/ui/requisitions" },
      configSchema: {},
      returnsSchema: {
        sessionId: { type: "string" },
        title: { type: "string" },
        url: { type: "string" },
      },
      returnsExample: {
        sessionId: "bses-9f2c1a0b4d6e8a01",
        title: "采购需求 · Meta ERP",
        url: "http://localhost:3620/ui/requisitions",
      },
      chainsWith: ["browser.read"],
      sourcePath: "packages/tools/src/browser/tools.ts",
    },
  },
  {
    descriptor: browserRead,
    catalog: {
      name: "browser.read",
      category: "browser",
      summary:
        "Read the session's current page: rendered text (mode 'text') or ARIA snapshot (mode 'a11y'). Capped at 30KB.",
      sideEffect: "read",
      operation: "read",
      effectScope: "external",
      sandboxPolicy: "live_external",
      description:
        "mode 'a11y' returns the accessibility tree (roles + accessible names) — the stable way to discover click/fill targets before acting; mode 'text' returns document.body.innerText. Both are truncated at 30KB with truncated:true.",
      argsSchema: {
        sessionId: { type: "string", required: true },
        mode: { type: "'text'|'a11y'", default: "text" },
      },
      argsExample: { sessionId: "bses-9f2c1a0b4d6e8a01", mode: "a11y" },
      configSchema: {},
      returnsSchema: {
        sessionId: { type: "string" },
        mode: { type: "string" },
        title: { type: "string" },
        url: { type: "string" },
        content: { type: "string", description: "Page text or ARIA snapshot, ≤30KB." },
        truncated: { type: "boolean" },
      },
      returnsExample: {
        sessionId: "bses-9f2c1a0b4d6e8a01",
        mode: "a11y",
        title: "调拨单 · Meta ERP",
        url: "http://localhost:3620/ui/transfers",
        content: "- heading \"跨仓调拨单\" [level=2]\n- table: …",
        truncated: false,
      },
      chainsWith: ["browser.click", "browser.fill"],
      sourcePath: "packages/tools/src/browser/tools.ts",
    },
  },
  {
    descriptor: browserClick,
    catalog: {
      name: "browser.click",
      category: "browser",
      summary:
        "Click an element by CSS {selector} or ARIA {role,name} in an open session.",
      sideEffect: "write",
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      description:
        "A click can submit forms / trigger business writes on the visited system, so it is an external write behind an attempt grant. Waits for actionability (10s timeout); prefer role+name targets discovered via browser.read mode 'a11y'.",
      argsSchema: {
        sessionId: { type: "string", required: true },
        selector: { type: "string", description: "CSS selector. Provide this OR role." },
        role: { type: "string", description: "ARIA role (e.g. 'button')." },
        name: { type: "string", description: "Accessible name filter used with role." },
      },
      argsExample: { sessionId: "bses-9f2c1a0b4d6e8a01", role: "button", name: "创建调拨单" },
      configSchema: {},
      returnsSchema: {
        sessionId: { type: "string" },
        clicked: { type: "true" },
        title: { type: "string" },
        url: { type: "string" },
      },
      returnsExample: {
        sessionId: "bses-9f2c1a0b4d6e8a01",
        clicked: true,
        title: "调拨单 · Meta ERP",
        url: "http://localhost:3620/ui/transfers",
      },
      chainsWith: ["browser.read", "browser.screenshot"],
      sourcePath: "packages/tools/src/browser/tools.ts",
    },
  },
  {
    descriptor: browserFill,
    catalog: {
      name: "browser.fill",
      category: "browser",
      summary: "Fill a form control (CSS {selector}) with {value} in an open session.",
      sideEffect: "write",
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      description:
        "Playwright fill semantics: clears the control, then types the value. Form mutation on an external system ⇒ attempt-grant write policy.",
      argsSchema: {
        sessionId: { type: "string", required: true },
        selector: { type: "string", required: true },
        value: { type: "string", required: true },
      },
      argsExample: {
        sessionId: "bses-9f2c1a0b4d6e8a01",
        selector: "#create-transfer input[name='material_id']",
        value: "MAT-ST-P12",
      },
      configSchema: {},
      returnsSchema: {
        sessionId: { type: "string" },
        filled: { type: "true" },
        selector: { type: "string" },
      },
      returnsExample: {
        sessionId: "bses-9f2c1a0b4d6e8a01",
        filled: true,
        selector: "#create-transfer input[name='material_id']",
      },
      chainsWith: ["browser.click"],
      sourcePath: "packages/tools/src/browser/tools.ts",
    },
  },
  {
    descriptor: browserScreenshot,
    catalog: {
      name: "browser.screenshot",
      category: "browser",
      summary:
        "Capture a PNG of the session's current viewport to data/browser-shots/<tenant>/ and return the file path.",
      sideEffect: "read",
      operation: "read",
      effectScope: "external",
      sandboxPolicy: "live_external",
      description:
        "Captures pixels only (no page mutation); the PNG is persisted server-side as an artifact sidecar and returned as an absolute path so the image never round-trips through the model as base64.",
      argsSchema: {
        sessionId: { type: "string", required: true },
      },
      argsExample: { sessionId: "bses-9f2c1a0b4d6e8a01" },
      configSchema: {},
      returnsSchema: {
        sessionId: { type: "string" },
        path: { type: "string", description: "Absolute PNG path on the api host." },
        bytes: { type: "number" },
        url: { type: "string", description: "Page URL at capture time." },
      },
      returnsExample: {
        sessionId: "bses-9f2c1a0b4d6e8a01",
        path: "/abs/data/browser-shots/power-scm/shot-2026-08-20T09-00-00-000Z-a1b2c3.png",
        bytes: 48213,
        url: "http://localhost:3620/ui/transfers",
      },
      sourcePath: "packages/tools/src/browser/tools.ts",
    },
  },
  {
    descriptor: browserCloseSession,
    catalog: {
      name: "browser.closeSession",
      category: "browser",
      summary: "Close a browser session and release its Chrome process (idempotent).",
      sideEffect: "read",
      operation: "compute",
      effectScope: "none",
      sandboxPolicy: "pure",
      description:
        "Releases the local browser process for the given sessionId. Closing an unknown or already-reaped session returns {closed:false} rather than throwing, so cleanup steps are safe to retry.",
      argsSchema: {
        sessionId: { type: "string", required: true },
      },
      argsExample: { sessionId: "bses-9f2c1a0b4d6e8a01" },
      configSchema: {},
      returnsSchema: {
        sessionId: { type: "string" },
        closed: { type: "boolean" },
      },
      returnsExample: { sessionId: "bses-9f2c1a0b4d6e8a01", closed: true },
      sourcePath: "packages/tools/src/browser/tools.ts",
    },
  },

  // ── comms.* — agent-to-agent messaging ──────────────────────────────────
  {
    descriptor: commsSendToAgent,
    catalog: {
      name: "comms.sendToAgent",
      category: "comms",
      summary:
        "Durable A2A message: publish a tenant event through the operator's own POST /v1/events, scoped to one live target agent.",
      sideEffect: "write",
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      credentialPosture: "environment_reference_only",
      description:
        "Loopback-HTTP into the API's durable ingest: the events row + event ledger + audit are persisted before the idempotent broker enqueue, and targetAgent is verified against the LIVE manifest registry (unknown/disabled agents fail closed). The origin and bearer credential come only from env vars named in trusted config (defaults AGENTIC_SELF_BASE_URL / AGENTIC_SELF_API_TOKEN — a tenant-scoped Settings → Tokens API token). A deterministic Idempotency-Key derived from the correlationId makes step retries replay instead of duplicate.",
      argsSchema: {
        agent: {
          type: "string",
          required: true,
          description: "Manifest agent name in the SAME tenant (e.g. 'action-create-stock-transfer').",
        },
        event: {
          type: "string",
          description:
            "Event name to publish. Defaults to the synthetic manual trigger MANUAL_<AGENT_UPPER_SNAKE> (compiler convention).",
        },
        payload: {
          type: "object",
          description: "Event payload (keys starting with '__' are rejected). Defaults to {}.",
        },
        subject: {
          type: "string",
          description: "Subject/correlation key. Defaults to the current run's subject.",
        },
        idempotency_key: {
          type: "string",
          description: "Override the deterministic Idempotency-Key when the caller manages dedup itself.",
        },
      },
      argsExample: {
        agent: "action-create-stock-transfer",
        event: "PSCM_STOCK_GAP_CONFIRMED",
        payload: { material_id: "MAT-ST-P12", gap_qty: 1200 },
        subject: "WO-2026-0812",
      },
      configSchema: {
        base_url_env: {
          type: "string",
          default: "AGENTIC_SELF_BASE_URL",
          description: "Env var NAME holding this API's own origin (e.g. http://localhost:3540). Fail-closed when unset.",
        },
        api_key_env: {
          type: "string",
          default: "AGENTIC_SELF_API_TOKEN",
          description: "Env var NAME holding a tenant-scoped API token with events.publish permission. Fail-closed when unset.",
        },
        timeout_ms: { type: "number", default: 15000 },
      },
      configExample: {
        base_url_env: "AGENTIC_SELF_BASE_URL",
        api_key_env: "AGENTIC_SELF_API_TOKEN",
      },
      credentialEnv: ["AGENTIC_SELF_BASE_URL", "AGENTIC_SELF_API_TOKEN"],
      returnsSchema: {
        eventId: { type: "string", description: "Durably persisted event id (evt-…)." },
        name: { type: "string", description: "Wire event name as accepted by the ingest." },
        agent: { type: "string" },
        subject: { type: "string | null" },
      },
      returnsExample: {
        eventId: "evt-01J9ZC0YV3",
        name: "PSCM_STOCK_GAP_CONFIRMED",
        agent: "action-create-stock-transfer",
        subject: "WO-2026-0812",
      },
      sourcePath: "packages/tools/src/comms/send-to-agent.ts",
    },
  },

];

/**
 * Build the runtime map. Each tool is registered under its canonical name
 * AND every alias declared in its catalog entry. Aliases all resolve to
 * the same descriptor, so an older manifest that still says
 * `writeJdToDisk` keeps working without code changes.
 */
function buildRegistry(regs: ToolRegistration[]): Map<string, ToolDescriptor> {
  const map = new Map<string, ToolDescriptor>();
  for (const { descriptor, catalog } of regs) {
    if (!isToolExecutionPolicy(executionPolicy(catalog))) {
      throw new Error(
        `globalToolRegistry: invalid execution policy for '${catalog.name}'`,
      );
    }
    if (descriptor.factoryWriteProbeLifecycle) {
      const safety = inspectWriteProbeSafety(
        catalog.sideEffect,
        catalog.probeSafety,
      );
      if (
        catalog.sandboxPolicy !== "requires_attempt_grant"
        || safety.status !== "ready"
      ) {
        throw new Error(
          `globalToolRegistry: '${catalog.name}' lifecycle requires a complete write/dual probeSafety contract and requires_attempt_grant policy`,
        );
      }
      // Validate code-owned identity at boot rather than discovering malformed
      // lifecycle wiring only after a human authorizes a write canary.
      globalWriteProbeLifecycleSourceIdentity(
        descriptor.factoryWriteProbeLifecycle,
      );
    }
    // #ARG-CONTRACT (D3) — publish the catalog's argument contract on the
    // EXECUTABLE descriptor. Every registration here declares a full
    // `argsSchema`, but the runtime could not see it: with no argument slot on
    // the descriptor, `step-engine` advertised `{additionalProperties:true}` to
    // the model for any tool a manifest had not re-described. Normalized to
    // JSON Schema so a consumer can hand it to a provider unchanged. Absent
    // stays absent — a fabricated permissive schema reads as "anything goes".
    const declaredArgs = normalizeToolSchema(catalog.argsSchema);
    const published: ToolDescriptor = declaredArgs
      ? { ...descriptor, inputSchema: declaredArgs }
      : descriptor;
    map.set(catalog.name, published);
    for (const alias of catalog.aliases ?? []) {
      if (map.has(alias)) {
        throw new Error(
          `globalToolRegistry: alias collision on '${alias}' (already registered).`,
        );
      }
      // The same object, so an alias and its canonical name cannot drift.
      map.set(alias, published);
    }
  }
  return map;
}

export const globalToolRegistry: ReadonlyMap<string, ToolDescriptor> =
  buildRegistry(REGISTRATIONS);

/** Names that must never auto-run in Studio / workflow test mode even if a
 * future edit forgets an explicit `testPolicy`. Kept alongside the derived
 * policy below for exactness with the original review. */
const TEST_BLOCKED_TOOLS = new Set([
  "inviteCandidateApi",
  "gohireInviteCandidateApi",
  "fs.writeMarkdownToArchive",
  "fs.writeHtmlToArchive",
  "fs.appendToLog",
  "http.fetch",
]);

/** Fail-closed Studio test gate: only reviewed read/compute tools without
 * write semantics may execute for real outside live mode. Anything that can
 * mutate state — write/read_write operation, write/dual side-effect class,
 * or an attempt-grant sandbox policy — blocks unless explicitly allowed. */
function derivedTestPolicy(catalog: ToolCatalogEntry): "allow" | "block" {
  if (catalog.testPolicy) return catalog.testPolicy;
  if (TEST_BLOCKED_TOOLS.has(catalog.name)) return "block";
  if (catalog.operation === "write" || catalog.operation === "read_write") {
    return "block";
  }
  if (catalog.sideEffect === "write" || catalog.sideEffect === "dual") {
    return "block";
  }
  if (catalog.sandboxPolicy === "requires_attempt_grant") return "block";
  return "allow";
}

function effectiveCatalogMetadata(catalog: ToolCatalogEntry): ToolCatalogEntry {
  return { ...catalog, testPolicy: derivedTestPolicy(catalog) };
}

/** Resolve canonical catalog policy from either a canonical name or alias. */
export function getGlobalToolCatalogEntry(
  name: string,
): ToolCatalogEntry | undefined {
  const normalized = name.trim();
  if (!normalized) return undefined;
  const registration = REGISTRATIONS.find(
    ({ catalog }) =>
      catalog.name === normalized ||
      (catalog.aliases ?? []).includes(normalized),
  );
  return registration
    ? effectiveCatalogMetadata(registration.catalog)
    : undefined;
}

/**
 * #EFFECT-READBACK — structural guard for a read-back declaration.
 *
 * TypeScript types stop at the persistence boundary; a manifest carries this
 * shape as JSON, so both sides validate here and there is one semantics. A
 * malformed declaration is NOT silently ignored: callers report it as an
 * unverified effect, never as a verified one.
 */
const EFFECT_READBACK_ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isToolEffectVerificationContract(
  value: unknown,
): value is ToolEffectVerificationContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<ToolEffectVerificationContract>;
  if (typeof row.readTool !== "string" || !row.readTool.trim()) return false;
  if (row.readArgs !== undefined) {
    if (!row.readArgs || typeof row.readArgs !== "object" || Array.isArray(row.readArgs)) {
      return false;
    }
    for (const [name, path] of Object.entries(row.readArgs)) {
      if (!EFFECT_READBACK_ARG_NAME.test(name)) return false;
      // A read-back argument may only be sourced from THIS call: the write's
      // own input or its own output. Anything else would let a declaration
      // reach into ambient state and confirm something it did not observe.
      if (typeof path !== "string") return false;
      if (!path.startsWith("input.") && !path.startsWith("output.")) return false;
      if (!safeProbePath(path)) return false;
    }
  }
  if (!Array.isArray(row.match) || row.match.length === 0) return false;
  return row.match.every(
    (pair) =>
      !!pair
      && typeof pair === "object"
      && safeProbePath((pair as { claim?: unknown }).claim)
      && safeProbePath((pair as { observed?: unknown }).observed),
  );
}

/**
 * Resolve the declared read-back contract for a first-party tool name or
 * alias. Absent stays absent — an undeclared effect must read as unverified,
 * never as verified.
 */
export function globalToolEffectVerification(
  name: string,
): ToolEffectVerificationContract | undefined {
  const contract = getGlobalToolCatalogEntry(name)?.effectVerification;
  return isToolEffectVerificationContract(contract) ? contract : undefined;
}

/**
 * Resolve the reviewed side-effect class for a first-party tool name or alias.
 *
 * Runtime sandbox policy must never infer this from verbs in the tool name:
 * aliases, vendor terminology and tenant-local names make that both brittle
 * and unsafe.  An absent value intentionally stays absent so callers can fail
 * closed instead of silently treating an unknown tool as read-only.
 */
export function globalToolSideEffect(
  name: string,
): ToolCatalogEntry["sideEffect"] | undefined {
  const normalized = name.trim();
  if (!normalized) return undefined;
  for (const { catalog } of REGISTRATIONS) {
    if (catalog.name === normalized || catalog.aliases?.includes(normalized)) {
      return catalog.sideEffect;
    }
  }
  return undefined;
}

/** Resolve reviewed execution policy for a canonical first-party tool or
 * alias. Missing names stay missing so sandbox callers can reject them. */
export function globalToolExecutionPolicy(
  name: string,
): ToolExecutionPolicy | undefined {
  const normalized = name.trim();
  if (!normalized) return undefined;
  for (const { catalog } of REGISTRATIONS) {
    if (catalog.name === normalized || catalog.aliases?.includes(normalized)) {
      return executionPolicy(catalog);
    }
  }
  return undefined;
}

/**
 * Catalog snapshot consumed by GET /v1/tools and the Tools view in the
 * portal. Stable across boots; no I/O. Each entry includes the canonical
 * name, category, summary, and (where authored) a config example operators
 * can paste straight into a manifest's `tool_use[]`.
 */
export function listGlobalTools(): ToolCatalogEntry[] {
  const buildId = process.env.AGENTIC_BUILD_ID?.trim()
    || process.env.GIT_SHA?.trim()
    || (process.env.NODE_ENV === "production" ? "" : "unverified-development-build");
  if (!buildId) {
    throw new Error("AGENTIC_BUILD_ID or GIT_SHA is required to identify global tool implementations");
  }
  return REGISTRATIONS.map(({ catalog, descriptor }) => ({
    ...effectiveCatalogMetadata(catalog),
    sourceIdentity: {
      provider: "global_registry" as const,
      buildId,
      handlerSha256: createHash("sha256")
        .update(Function.prototype.toString.call(descriptor.handler), "utf8")
        .digest("hex"),
      ...(descriptor.factoryWriteProbeLifecycle
        ? {
            writeProbeLifecycle: globalWriteProbeLifecycleSourceIdentity(
              descriptor.factoryWriteProbeLifecycle,
            ),
          }
        : {}),
    },
  })).sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.name.localeCompare(b.name);
  });
}
