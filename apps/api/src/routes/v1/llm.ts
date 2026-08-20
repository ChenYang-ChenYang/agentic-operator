/**
 * /v1/llm/* — gateway introspection + provider-key management + model fleet.
 *
 * GET    /v1/llm/providers                → ProviderInfo[]
 * GET    /v1/llm/models?provider=…        → string[] (or full catalog when omitted)
 * GET    /v1/llm/catalog                  → Record<ProviderId, CatalogModel[]> (full metadata)
 * GET    /v1/llm/providers/keys           → masked metadata for every provider
 * GET    /v1/llm/providers/:id/key        → masked key + metadata for one provider
 * POST   /v1/llm/providers/:id/key        → save & rotate (body: { apiKey, scope })
 * DELETE /v1/llm/providers/:id/key        → remove a vault-managed key
 * POST   /v1/llm/providers/:id/test       → probe upstream with a candidate key
 * GET    /v1/llm/fleet                    → tenant's model fleet
 * POST   /v1/llm/fleet                    → add an entry
 * PATCH  /v1/llm/fleet/:id                → update an entry
 * DELETE /v1/llm/fleet/:id                → remove an entry
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  catalogModelPolicy,
  classifyCatalogModelTier,
  GatewayInstanceSchema,
  LlmSettingsSchema,
  LlmRoutingResolutionError,
  ModelRouteIdSchema,
  ReasoningConfigSchema,
  PROVIDER_IDS,
  PROVIDER_MODEL_CATALOG,
  selectableModelsForProvider,
  resolveLlmRouting,
  TaskClassIdSchema,
  TextVerbositySchema,
  type CatalogModelStatus,
  type ModelTier,
  type ProviderId,
  type GatewayInstance,
  type ReasoningEffort,
  type ReasoningMode,
  type TemperatureRange,
  type TextVerbosity,
} from "@agentic/contracts";
import { isLLMError, type LLMErrorCode } from "@agentic/llm-gateway";
import { getLLMGateway, resetLLMGateway } from "../../services/llm";
import { requireAuth, requireTenantAdmin } from "../../plugins/auth";
import { writeAudit } from "../../plugins/audit";
import {
  deleteProviderKey,
  getGatewayCredential,
  getGatewayCredentialMeta,
  gatewayCredentialSlot,
  getProviderKey,
  getProviderKeyMeta,
  listProviderKeyMeta,
  setProviderKey,
  setGatewayCredential,
  type KeyScope,
} from "../../services/provider-keys";
import {
  testGatewayConnection,
  testProviderKey,
} from "../../services/provider-test";
import {
  addFleetEntry,
  deleteFleetEntry,
  FleetValidationError,
  listFleet,
  updateFleetEntry,
} from "../../services/model-fleet";
import {
  listAvailableModels,
  listGatewayModels,
} from "../../services/model-discovery";
import {
  getLlmSettings,
  LlmSettingsConflictError,
  resyncLlmSettings,
  saveLlmSettings,
} from "../../services/llm-settings-store";

function isProviderId(s: string): s is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(s);
}

function isKeyScope(s: unknown): s is KeyScope {
  return s === "workspace" || s === "tenant";
}

/** Providers that never serve real runtime traffic from this build. */
const NON_RUNTIME_PROVIDERS = new Set<ProviderId>(["mock", "bedrock", "vertex"]);

function providerAvailableInThisProcess(id: ProviderId): boolean {
  return process.env.NODE_ENV === "test" || !NON_RUNTIME_PROVIDERS.has(id);
}

/**
 * Whether a request naming this provider could actually be served. Mirrors the
 * exact conditions `resolveModel` rejects on (unregistered adapter, or a
 * registered adapter with no credential), so a caller that honours this never
 * gets a `provider is not configured` surprise at generation time.
 */
function providerConfiguredForTraffic(id: ProviderId): boolean {
  if (!providerAvailableInThisProcess(id)) return false;
  const info = getLLMGateway()
    .listProviders()
    .find((provider) => provider.id === id);
  if (!info) return false;
  return info.hasKey || id === "mock";
}

function requireRuntimeProvider(id: ProviderId) {
  if (providerAvailableInThisProcess(id)) return;
  const err: Error & { statusCode?: number; code?: string } = new Error(
    `Provider ${id} is not an operational real-model provider in this build`,
  );
  err.statusCode = 409;
  err.code = "provider_unavailable";
  throw err;
}

const DEFAULT_TEMPERATURE_RANGE: TemperatureRange = { min: 0, max: 2 };

const LlmTestCallBodySchema = z
  .object({
    route: ModelRouteIdSchema.optional(),
    taskClass: TaskClassIdSchema.optional(),
    prompt: z.string().trim().min(1).max(8_000),
    maxTokens: z.number().int().min(1).max(1_048_576).optional(),
    timeoutMs: z.number().int().min(1_000).max(7_200_000).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    reasoning: ReasoningConfigSchema.optional(),
    verbosity: TextVerbositySchema.optional(),
    store: z.boolean().optional(),
    jsonMode: z.boolean().optional(),
  })
  .strict();

type LlmTestCallBody = z.input<typeof LlmTestCallBodySchema>;

const PUBLIC_TEST_CALL_FAILURES: Record<
  LLMErrorCode,
  { message: string; statusCode: number }
> = {
  auth: {
    message: "Provider authentication failed. Check the configured credential.",
    statusCode: 401,
  },
  rate_limit: {
    message: "The provider rate limit was exceeded. Try again later.",
    statusCode: 429,
  },
  timeout: {
    message:
      "The model call timed out. Increase the route timeout or try again.",
    statusCode: 504,
  },
  model_not_found: {
    message: "The configured provider could not find the requested model.",
    statusCode: 404,
  },
  bad_request: {
    message: "The selected provider rejected the model-call parameters.",
    statusCode: 400,
  },
  provider_error: {
    message: "The provider returned an upstream error.",
    statusCode: 502,
  },
  network: {
    message: "The configured provider could not be reached.",
    statusCode: 502,
  },
  not_configured: {
    message: "The selected gateway credential or model is not configured.",
    statusCode: 503,
  },
  accounting_error: {
    message: "The model call completed, but usage accounting failed.",
    statusCode: 502,
  },
  cost_limit_exceeded: {
    message: "The billing account usage limit has been reached.",
    statusCode: 429,
  },
};

function testCallFailure(error: unknown): {
  code: LLMErrorCode;
  message: string;
  statusCode: number;
} {
  if (error instanceof LlmRoutingResolutionError) {
    return {
      code: "bad_request",
      message:
        "The requested model route is not available in these AI settings.",
      statusCode: 400,
    };
  }
  const code: LLMErrorCode = isLLMError(error) ? error.code : "provider_error";
  return { code, ...PUBLIC_TEST_CALL_FAILURES[code] };
}

function mergedTemperatureRange(
  liveSupported: boolean | undefined,
  catalogRange: TemperatureRange | null | undefined,
): TemperatureRange | null | undefined {
  if (liveSupported === false) return null;
  if (liveSupported === true) {
    return catalogRange && catalogRange !== null
      ? catalogRange
      : DEFAULT_TEMPERATURE_RANGE;
  }
  return catalogRange;
}

export async function llmRoutes(app: FastifyInstance): Promise<void> {
  // ── AI settings, routing policies, and dynamic gateway instances ───────
  app.get("/llm/settings", async (req, reply) => {
    const auth = requireTenantAdmin(req);
    const snapshot = getLlmSettings(auth.tenantSlug);
    return reply.ok({
      ...snapshot,
      credentials: Object.fromEntries(
        snapshot.settings.gatewayInstances.map((instance) => [
          instance.id,
          getGatewayCredentialMeta(
            gatewayCredentialSlot(instance, auth.tenantId),
            auth.tenantId,
            instance.credentialScope,
          ),
        ]),
      ),
    });
  });

  app.put<{
    Body: { expectedRevision?: number; settings?: unknown };
  }>("/llm/settings", async (req, reply) => {
    const auth = requireTenantAdmin(req);
    const expected = req.body?.expectedRevision;
    if (
      typeof expected !== "number" ||
      !Number.isInteger(expected) ||
      expected < 0
    ) {
      return reply.fail(
        "bad_request",
        "expectedRevision must be a non-negative integer",
        400,
      );
    }
    const parsed = LlmSettingsSchema.safeParse(req.body?.settings);
    if (!parsed.success) {
      return reply.fail(
        "bad_request",
        parsed.error.issues
          .map(
            (issue) =>
              `${issue.path.join(".") || "settings"}: ${issue.message}`,
          )
          .join("; "),
        400,
      );
    }
    try {
      const snapshot = saveLlmSettings(auth.tenantSlug, parsed.data, expected);
      resetLLMGateway();
      writeAudit({
        tenantId: auth.tenantId,
        action: "llm.settings.update",
        targetType: "workspace",
        targetId: auth.tenantSlug,
        meta: {
          revision: snapshot.settings.revision,
          syncStatus: snapshot.sync.status,
          gateways: snapshot.settings.gatewayInstances.map(({ id, kind }) => ({
            id,
            kind,
          })),
          taskProfiles: snapshot.settings.taskProfiles.map(
            ({ taskClass }) => taskClass,
          ),
        },
      });
      return reply.ok(snapshot);
    } catch (error) {
      if (error instanceof LlmSettingsConflictError) {
        return reply.fail("conflict", error.message, 409);
      }
      return reply.fail(
        "bad_request",
        error instanceof Error ? error.message : String(error),
        400,
      );
    }
  });

  app.post("/llm/settings/resync", async (req, reply) => {
    const auth = requireTenantAdmin(req);
    const snapshot = resyncLlmSettings(auth.tenantSlug);
    resetLLMGateway();
    writeAudit({
      tenantId: auth.tenantId,
      action: "llm.settings.resync",
      targetType: "workspace",
      targetId: auth.tenantSlug,
      meta: {
        revision: snapshot.settings.revision,
        sync: snapshot.sync.status,
      },
    });
    return reply.ok(snapshot);
  });

  app.post<{
    Body: { taskClass?: string; explicitRoute?: string };
  }>("/llm/routing/resolve", async (req, reply) => {
    const auth = requireAuth(req);
    try {
      const snapshot = getLlmSettings(auth.tenantSlug);
      return reply.ok(
        resolveLlmRouting(snapshot.settings, {
          taskClass: req.body?.taskClass ?? "default",
          ...(req.body?.explicitRoute
            ? { explicitRoute: req.body.explicitRoute }
            : {}),
        }),
      );
    } catch (error) {
      return reply.fail(
        "bad_request",
        error instanceof Error ? error.message : String(error),
        400,
      );
    }
  });

  app.post<{
    Params: { id: string };
    Body: { apiKey?: string; scope?: string };
  }>("/llm/gateways/:id/key", async (req, reply) => {
    const auth = requireTenantAdmin(req);
    const snapshot = getLlmSettings(auth.tenantSlug);
    const instance = snapshot.settings.gatewayInstances.find(
      (candidate) => candidate.id === req.params.id,
    );
    if (!instance) {
      return reply.fail("not_found", "gateway instance not found", 404);
    }
    const scope = req.body?.scope;
    const apiKey = req.body?.apiKey?.trim() ?? "";
    if (!isKeyScope(scope) || apiKey.length < 8) {
      return reply.fail(
        "bad_request",
        "apiKey (min 8 chars) and scope (workspace|tenant) are required",
        400,
      );
    }
    if (instance.credentialScope && scope !== instance.credentialScope) {
      return reply.fail(
        "bad_request",
        `scope must match gateway credentialScope (${instance.credentialScope})`,
        400,
      );
    }
    const credentialRef = gatewayCredentialSlot(instance, auth.tenantId);
    const meta = setGatewayCredential(credentialRef, {
      apiKey,
      scope,
      tenantId: scope === "tenant" ? auth.tenantId : undefined,
      setBy: auth.userId ?? auth.tenantSlug,
    });
    resetLLMGateway();
    writeAudit({
      tenantId: auth.tenantId,
      action: "llm.gateway.key.rotate",
      targetType: "gateway",
      targetId: instance.id,
      meta: {
        scope,
        credentialId: meta.credentialId,
        keyMasked: meta.keyMasked,
      },
    });
    return reply.ok(meta);
  });

  app.post<{
    Params: { id: string };
    Body: { apiKey?: string; instance?: unknown; timeoutMs?: number };
  }>("/llm/gateways/:id/test-connection", async (req, reply) => {
    const auth = requireTenantAdmin(req);
    const hasDraftInstance = Object.prototype.hasOwnProperty.call(
      req.body ?? {},
      "instance",
    );
    const saved = getLlmSettings(
      auth.tenantSlug,
    ).settings.gatewayInstances.find(
      (candidate) => candidate.id === req.params.id,
    );
    const candidate = hasDraftInstance
      ? GatewayInstanceSchema.safeParse(req.body.instance)
      : null;
    if (candidate && !candidate.success) {
      return reply.fail(
        "bad_request",
        candidate.error.issues.map((issue) => issue.message).join("; "),
        400,
      );
    }
    const instance: GatewayInstance | undefined = candidate?.success
      ? candidate.data
      : saved;
    if (!instance || instance.id !== req.params.id) {
      return reply.fail("not_found", "gateway instance not found", 404);
    }
    // A draft can change both baseUrl and credentialRef. Hydrating its ref
    // from the vault would let a malicious endpoint receive an unrelated
    // stored provider key. Only persisted instances may auto-load secrets;
    // drafts must use the explicit, non-persisted key supplied in this body.
    const credential = hasDraftInstance
      ? null
      : getGatewayCredential(
          gatewayCredentialSlot(instance, auth.tenantId),
          auth.tenantId,
          instance.credentialScope,
        );
    const key = req.body?.apiKey?.trim() || credential?.apiKey || "";
    const result =
      instance.kind === "direct" && instance.providerId
        ? {
            ...(await testProviderKey(instance.providerId, key)),
            endpoint: null,
            testedAt: Date.now(),
          }
        : instance.kind === "openrouter"
          ? {
              ...(await testProviderKey("openrouter", key)),
              endpoint: "https://openrouter.ai/api/v1/models",
              testedAt: Date.now(),
            }
          : await testGatewayConnection({
              instance,
              apiKey: key,
              timeoutMs: req.body?.timeoutMs,
            });
    writeAudit({
      tenantId: auth.tenantId,
      action: "llm.gateway.test-connection",
      targetType: "gateway",
      targetId: instance.id,
      meta: {
        ok: result.ok,
        statusCode: result.statusCode,
        latencyMs: result.latencyMs,
        modelCount: result.modelCount,
      },
    });
    return reply.ok(result);
  });

  app.get<{ Params: { id: string } }>(
    "/llm/gateways/:id/models",
    async (req, reply) => {
      const auth = requireTenantAdmin(req);
      const instance = getLlmSettings(
        auth.tenantSlug,
      ).settings.gatewayInstances.find(
        (candidate) => candidate.id === req.params.id,
      );
      if (!instance) {
        return reply.fail("not_found", "gateway instance not found", 404);
      }
      const credential = getGatewayCredential(
        gatewayCredentialSlot(instance, auth.tenantId),
        auth.tenantId,
        instance.credentialScope,
      );
      const result = await listGatewayModels(
        instance,
        credential?.apiKey ?? "",
      );
      return reply.ok({ gatewayInstanceId: instance.id, ...result });
    },
  );

  app.post<{ Body: LlmTestCallBody }>("/llm/test-call", async (req, reply) => {
    const auth = requireTenantAdmin(req);
    const parsed = LlmTestCallBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.fail(
        "bad_request",
        parsed.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "request"}: ${issue.message}`,
          )
          .join("; "),
        400,
      );
    }
    const body = parsed.data;
    try {
      const response = await getLLMGateway().chat({
        messages: [{ role: "user", content: body.prompt }],
        tenantId: auth.tenantId,
        purpose: "llm-settings.test-call",
        maxTokens: body.maxTokens ?? 256,
        timeoutMs: body.timeoutMs,
        temperature: body.temperature,
        reasoning: body.reasoning,
        verbosity: body.verbosity,
        store: body.store,
        jsonMode: body.jsonMode,
        routing: {
          taskType: body.taskClass ?? "default",
          requestedRoute: body.route,
          parameterPrecedence: "request",
        },
        attribution: {
          productSurface: "llm-settings",
          productAction: "test-call",
          functionName: "llm.test-call",
          invocationSource: "settings",
        },
      });
      writeAudit({
        tenantId: auth.tenantId,
        action: "llm.gateway.test-call",
        targetType: "model-route",
        targetId: response.routing?.effectiveRoute ?? body.route ?? "default",
        meta: {
          provider: response.provider,
          model: response.model,
          latencyMs: response.latencyMs,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          costUsdNanos: response.cost?.totalUsdNanos ?? null,
        },
      });
      return reply.ok({
        text: response.text,
        provider: response.provider,
        model: response.model,
        routing: response.routing,
        latencyMs: response.latencyMs,
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        usage: response.usage
          ? { ...response.usage, raw: undefined }
          : undefined,
        cost: response.cost,
        finishReason: response.finishReason,
        providerRequestId: response.providerRequestId,
        reasoning: response.reasoning,
        verbosity: response.verbosity,
        toolCalls: response.toolCalls,
      });
    } catch (error) {
      const failure = testCallFailure(error);
      return reply.fail(failure.code, failure.message, failure.statusCode);
    }
  });

  app.get("/llm/providers", async (req, reply) => {
    requireAuth(req);
    const gateway = getLLMGateway();
    // Discovery must not advertise providers this build never runs real
    // inference through (mock/bedrock/vertex outside a test process). A portal
    // that lists them would let an operator "configure" a provider that can
    // never serve traffic.
    return reply.ok(
      gateway
        .listProviders()
        .filter((provider) => providerAvailableInThisProcess(provider.id)),
    );
  });

  app.get<{ Querystring: { provider?: string } }>(
    "/llm/models",
    async (req, reply) => {
      const q = req.query.provider;
      if (q !== undefined && q !== "") {
        if (!isProviderId(q)) {
          return reply.fail("bad_request", `Unknown provider: ${q}`, 400);
        }
        return reply.ok(selectableModelsForProvider(q).map((m) => m.name));
      }

      const fullCatalog: Record<string, string[]> = {};
      for (const id of PROVIDER_IDS) {
        fullCatalog[id] = selectableModelsForProvider(id).map((m) => m.name);
      }
      return reply.ok(fullCatalog);
    },
  );

  // Full catalog with metadata (context, prices, capabilities). The plain
  // /llm/models endpoint returns names only for backwards-compat; this
  // endpoint is what the Settings UI uses to render the "Add model" picker.
  app.get("/llm/catalog", async (_req, reply) => {
    const governed = Object.fromEntries(
      PROVIDER_IDS.map((provider) => [
        provider,
        PROVIDER_MODEL_CATALOG[provider].map((model) => {
          const policy = catalogModelPolicy(model);
          return {
            ...model,
            status: policy.status,
            selectable: policy.selectable,
            unavailableReason: policy.selectable ? null : policy.reason,
          };
        }),
      ]),
    );
    return reply.ok(governed);
  });

  // ── Provider key vault ──────────────────────────────────────────────────
  // List masked key metadata for every provider — used by the Settings UI
  // to populate the credentials grid without fetching plaintext keys.
  app.get("/llm/providers/keys", async (req, reply) => {
    const auth = requireTenantAdmin(req);
    return reply.ok(listProviderKeyMeta(auth.tenantId));
  });

  app.get<{ Params: { id: string } }>(
    "/llm/providers/:id/key",
    async (req, reply) => {
      const auth = requireTenantAdmin(req);
      if (!isProviderId(req.params.id)) {
        return reply.fail(
          "bad_request",
          `Unknown provider: ${req.params.id}`,
          400,
        );
      }
      return reply.ok(getProviderKeyMeta(req.params.id, auth.tenantId));
    },
  );

  app.post<{
    Params: { id: string };
    Body: { apiKey?: string; scope?: string };
  }>("/llm/providers/:id/key", async (req, reply) => {
    const auth = requireTenantAdmin(req);
    const id = req.params.id;
    if (!isProviderId(id)) {
      return reply.fail("bad_request", `Unknown provider: ${id}`, 400);
    }
    requireRuntimeProvider(id);
    const { apiKey, scope } = req.body ?? {};
    if (typeof apiKey !== "string" || apiKey.trim().length < 8) {
      return reply.fail("bad_request", "apiKey is required (min 8 chars)", 400);
    }
    if (!isKeyScope(scope)) {
      return reply.fail(
        "bad_request",
        `scope must be "workspace" or "tenant"`,
        400,
      );
    }
    if (scope === "tenant") {
      // The process-wide provider vault feeds a singleton adapter set; a
      // tenant-scoped provider key would be accepted here but never actually
      // reach runtime routing, so a caller could believe a per-tenant key is
      // live when it is not. Fail closed until that scope is wired end-to-end.
      return reply.fail(
        "tenant_key_scope_unavailable",
        "Tenant-scoped provider keys are not wired into the singleton runtime gateway; use workspace scope instead.",
        409,
      );
    }
    try {
      // Only workspace scope reaches here — tenant scope is rejected above
      // because it never affects the singleton runtime gateway.
      const meta = setProviderKey(id, {
        apiKey: apiKey.trim(),
        scope,
        setBy: auth.tenantSlug,
      });
      resetLLMGateway();
      writeAudit({
        tenantId: auth.tenantId,
        action: "llm.key.rotate",
        targetType: "provider",
        targetId: id,
        meta: { scope, keyMasked: meta.keyMasked },
      });
      return reply.ok(meta);
    } catch (err) {
      return reply.fail("bad_request", (err as Error).message, 400);
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/llm/providers/:id/key",
    async (req, reply) => {
      const auth = requireTenantAdmin(req);
      const id = req.params.id;
      if (!isProviderId(id)) {
        return reply.fail("bad_request", `Unknown provider: ${id}`, 400);
      }
      requireRuntimeProvider(id);
      try {
        const before = getProviderKeyMeta(id);
        if (before.source === "env") {
          return reply.fail(
            "provider_key_env_managed",
            `Provider ${id} is configured by environment and cannot be removed through the API`,
            409,
          );
        }
        if (!deleteProviderKey(id)) {
          return reply.fail(
            "not_found",
            "provider key not found in vault",
            404,
          );
        }
        // The gateway host captures an env overlay per credential scope. Drop
        // every cached adapter set immediately so no subsequent call can keep
        // using deleted material.
        resetLLMGateway();
        const effective = getProviderKeyMeta(id);
        writeAudit({
          tenantId: auth.tenantId,
          actorUserId: auth.userId ?? undefined,
          action: "llm.key.delete",
          targetType: "provider",
          targetId: id,
          meta: {
            priorScope: before.scope,
            priorKeyMasked: before.keyMasked,
            effectiveSource: effective.source,
            hasEffectiveKey: effective.hasKey,
          },
        });
        return reply.ok({
          provider: id,
          deleted: true,
          effective,
        });
      } catch (error) {
        return reply.fail(
          "provider_key_delete_failed",
          error instanceof Error ? error.message : String(error),
          500,
        );
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { apiKey?: string };
  }>("/llm/providers/:id/test", async (req, reply) => {
    const auth = requireAuth(req);
    const id = req.params.id;
    if (!isProviderId(id)) {
      return reply.fail("bad_request", `Unknown provider: ${id}`, 400);
    }
    requireRuntimeProvider(id);
    // Candidate key from body wins; fall back to whatever the vault/env has
    // for the caller's tenant. The vault is tenant-scoped (P5-TEN-01) so we
    // pass the auth's tenantId to honor tenant-specific keys.
    const candidate = req.body?.apiKey?.trim();
    const key =
      candidate && candidate.length > 0
        ? candidate
        : (getProviderKey(id, auth.tenantId) ?? "");
    if (!key) {
      return reply.ok({
        ok: false,
        statusCode: null,
        latencyMs: 0,
        modelCount: null,
        message: "No key configured for this provider",
      });
    }
    const result = await testProviderKey(id, key);
    return reply.ok(result);
  });

  // ── Live model discovery ────────────────────────────────────────────────
  // The Settings "browse models" picker calls this to populate the checkbox
  // list. Merges three sources:
  //   1. live: provider's /models endpoint (when supported + key present)
  //   2. catalog: PROVIDER_MODEL_CATALOG (provides ctx + pricing metadata)
  //   3. fleet:  this tenant's already-added entries (so the UI can disable
  //              checkboxes for models already in the fleet)
  // When discovery fails or isn't supported, falls back to the catalog so
  // the user can still pick something.
  app.get<{ Params: { id: string } }>(
    "/llm/providers/:id/available-models",
    async (req, reply) => {
      const auth = requireAuth(req);
      const id = req.params.id;
      if (!isProviderId(id)) {
        return reply.fail("bad_request", `Unknown provider: ${id}`, 400);
      }
      requireRuntimeProvider(id);
      const key = getProviderKey(id, auth.tenantId) ?? "";
      const live = await listAvailableModels(id, key);
      const catalog = PROVIDER_MODEL_CATALOG[id];
      const catalogByName = new Map(catalog.map((m) => [m.name, m]));
      const fleetSet = new Set(
        listFleet(auth.tenantSlug)
          .filter((e) => e.provider === id)
          .map((e) => e.modelName),
      );

      type Merged = {
        id: string;
        contextLength: number | null;
        inputPricePerMTok: number | null;
        outputPricePerMTok: number | null;
        vision: boolean;
        tools: boolean;
        reasoning: boolean;
        reasoningEfforts: ReasoningEffort[];
        reasoningModes: ReasoningMode[];
        defaultReasoningEffort: ReasoningEffort | null;
        defaultReasoningMode: ReasoningMode | null;
        reasoningMandatory: boolean;
        reasoningDefaultEnabled: boolean;
        textVerbosities: TextVerbosity[];
        /**
         * `null` means unsupported, an object is the accepted range, and an
         * omitted property means the provider/catalog does not say.
         */
        temperatureRange?: TemperatureRange | null;
        tier: ModelTier | null;
        status: CatalogModelStatus;
        selectable: boolean;
        unavailableReason: string | null;
        releaseDate: string | null;
        providerCatalogCreatedAt: string | null;
        expiresAt: string | null;
        inFleet: boolean;
        /** Where this row came from. */
        origin: "live" | "catalog";
      };

      const merged: Merged[] = [];
      const seen = new Set<string>();

      // First pass: every live-discovered model (origin=live), with live
      // values taking precedence over catalog (the upstream is authoritative
      // for pricing/capabilities). Catalog only fills holes where live
      // didn't return the field — e.g. plain OpenAI /models has no pricing.
      for (const m of live.models) {
        seen.add(m.id);
        const cat = catalogByName.get(m.id);
        const inputPrice = m.inputPricePerMTok ?? cat?.inP ?? null;
        const outputPrice = m.outputPricePerMTok ?? cat?.outP ?? null;
        const policy = catalogModelPolicy({
          releaseDate: cat?.releaseDate,
          releaseDateSource: cat?.releaseDateSource,
          releaseDateConfidence: cat?.releaseDateConfidence,
          providerCatalogCreatedAt:
            m.providerCatalogCreatedAt ?? cat?.providerCatalogCreatedAt,
          deprecatedAt: cat?.deprecatedAt,
          sunsetAt: cat?.sunsetAt,
          expiresAt: m.expiresAt ?? cat?.expiresAt,
          restricted: cat?.restricted,
          restrictionReason: cat?.restrictionReason,
        });
        const tier = classifyCatalogModelTier({
          tier: cat?.tier,
          inP: inputPrice ?? Number.NaN,
          outP: outputPrice ?? Number.NaN,
        });
        merged.push({
          id: m.id,
          contextLength: m.contextLength ?? cat?.ctx ?? null,
          inputPricePerMTok: inputPrice,
          outputPricePerMTok: outputPrice,
          vision: m.vision ?? cat?.vision ?? false,
          tools: m.tools ?? cat?.tools ?? false,
          reasoning: m.reasoning ?? cat?.reasoning ?? false,
          reasoningEfforts: m.reasoningEfforts ?? cat?.reasoningEfforts ?? [],
          reasoningModes: cat?.reasoningModes ?? [],
          defaultReasoningEffort:
            m.defaultReasoningEffort ?? cat?.defaultReasoningEffort ?? null,
          defaultReasoningMode: cat?.defaultReasoningMode ?? null,
          reasoningMandatory:
            m.reasoningMandatory ?? cat?.reasoningMandatory ?? false,
          reasoningDefaultEnabled:
            m.reasoningDefaultEnabled ?? cat?.reasoningDefaultEnabled ?? false,
          textVerbosities: cat?.textVerbosities ?? [],
          temperatureRange: mergedTemperatureRange(
            m.temperatureSupported,
            cat?.temperatureRange,
          ),
          tier,
          status: policy.status,
          selectable: policy.selectable,
          unavailableReason: policy.selectable ? null : policy.reason,
          releaseDate: cat?.releaseDate ?? null,
          providerCatalogCreatedAt:
            m.providerCatalogCreatedAt ?? cat?.providerCatalogCreatedAt ?? null,
          expiresAt: m.expiresAt ?? cat?.expiresAt ?? null,
          inFleet: fleetSet.has(m.id),
          origin: "live",
        });
      }

      // Second pass: catalog entries that the live list didn't cover. This
      // ensures we always show at least the curated models even when the
      // provider can't be queried (no key, network error, unsupported).
      for (const cat of catalog) {
        if (seen.has(cat.name)) continue;
        const policy = catalogModelPolicy(cat);
        merged.push({
          id: cat.name,
          contextLength: cat.ctx,
          inputPricePerMTok: cat.inP,
          outputPricePerMTok: cat.outP,
          vision: cat.vision,
          tools: cat.tools,
          reasoning: cat.reasoning,
          reasoningEfforts: cat.reasoningEfforts ?? [],
          reasoningModes: cat.reasoningModes ?? [],
          defaultReasoningEffort: cat.defaultReasoningEffort ?? null,
          defaultReasoningMode: cat.defaultReasoningMode ?? null,
          reasoningMandatory: cat.reasoningMandatory ?? false,
          reasoningDefaultEnabled: cat.reasoningDefaultEnabled ?? false,
          textVerbosities: cat.textVerbosities ?? [],
          temperatureRange: cat.temperatureRange,
          tier: classifyCatalogModelTier(cat),
          status: policy.status,
          selectable: policy.selectable,
          unavailableReason: policy.selectable ? null : policy.reason,
          releaseDate: cat.releaseDate ?? null,
          providerCatalogCreatedAt: cat.providerCatalogCreatedAt ?? null,
          expiresAt: cat.expiresAt ?? null,
          inFleet: fleetSet.has(cat.name),
          origin: "catalog",
        });
      }

      merged.sort((a, b) => a.id.localeCompare(b.id));

      return reply.ok({
        provider: id,
        source: live.source,
        message: live.message,
        models: merged,
      });
    },
  );

  // ── Model fleet ─────────────────────────────────────────────────────────
  app.get("/llm/fleet", async (req, reply) => {
    const auth = requireAuth(req);
    // A fleet entry records intent; credentials can be removed afterwards.
    // Report usability alongside each entry so callers can avoid selecting a
    // model whose provider would be rejected at request time.
    return reply.ok(
      listFleet(auth.tenantSlug).map((entry) => ({
        ...entry,
        providerConfigured: providerConfiguredForTraffic(entry.provider),
      })),
    );
  });

  app.post<{
    Body: {
      provider?: string;
      modelName?: string;
      alias?: string;
      role?: string;
      dailyCapUsd?: number;
      maxOutTokens?: number;
      temperature?: number | null;
    };
  }>("/llm/fleet", async (req, reply) => {
    const auth = requireTenantAdmin(req);
    try {
      // Every other provider-scoped mutation gates on this; without it the
      // fleet becomes a side door for adding a non-runtime provider (mock,
      // bedrock, vertex) that the model picker would then offer.
      const requested = req.body?.provider ?? "";
      if (isProviderId(requested)) requireRuntimeProvider(requested);
      const entry = addFleetEntry({
        tenantSlug: auth.tenantSlug,
        provider: req.body?.provider ?? "",
        modelName: req.body?.modelName ?? "",
        alias: req.body?.alias,
        role: req.body?.role,
        dailyCapUsd: req.body?.dailyCapUsd,
        maxOutTokens: req.body?.maxOutTokens,
        temperature: req.body?.temperature,
        addedBy: auth.tenantSlug,
      });
      writeAudit({
        tenantId: auth.tenantId,
        action: "llm.fleet.add",
        targetType: "model",
        targetId: entry.id,
        meta: {
          provider: entry.provider,
          modelName: entry.modelName,
          alias: entry.alias,
          role: entry.role,
        },
      });
      return reply.ok(entry);
    } catch (err) {
      if (err instanceof FleetValidationError) {
        return reply.fail("bad_request", err.message, 400);
      }
      throw err;
    }
  });

  app.patch<{
    Params: { id: string };
    Body: {
      alias?: string;
      role?: string;
      dailyCapUsd?: number;
      maxOutTokens?: number;
      temperature?: number | null;
    };
  }>("/llm/fleet/:id", async (req, reply) => {
    const auth = requireTenantAdmin(req);
    try {
      const entry = updateFleetEntry(
        auth.tenantSlug,
        req.params.id,
        req.body ?? {},
      );
      if (!entry) return reply.fail("not_found", "fleet entry not found", 404);
      writeAudit({
        tenantId: auth.tenantId,
        action: "llm.fleet.update",
        targetType: "model",
        targetId: entry.id,
        meta: req.body as Record<string, unknown>,
      });
      return reply.ok(entry);
    } catch (err) {
      if (err instanceof FleetValidationError) {
        return reply.fail("bad_request", err.message, 400);
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/llm/fleet/:id",
    async (req, reply) => {
      const auth = requireTenantAdmin(req);
      const ok = deleteFleetEntry(auth.tenantSlug, req.params.id);
      if (!ok) return reply.fail("not_found", "fleet entry not found", 404);
      writeAudit({
        tenantId: auth.tenantId,
        action: "llm.fleet.remove",
        targetType: "model",
        targetId: req.params.id,
      });
      return reply.ok({ id: req.params.id, deleted: true });
    },
  );
}
