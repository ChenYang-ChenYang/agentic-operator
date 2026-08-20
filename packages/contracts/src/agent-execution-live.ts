import { z } from "zod";

/**
 * §G2 — Agent-execution LIVE window wire contract (contractVersion "1.0").
 *
 * Vendored VERBATIM from allmetaOntology
 * `apps/studio/src/builders/eval-test/lib/test-runner/ao-live-contract.ts`
 * (the consumer Studio's eval-test runner codes against). The zod schemas
 * below must stay wire-compatible with that file; Studio's
 * `scripts/verify-ao-sandbox.mjs` is the conformance client.
 *
 * Eval owns the requested model id. AO owns gateway credentials and routing.
 * The request therefore carries only a non-secret route hint; it never
 * carries a gateway URL or API key.
 */
export const AO_LIVE_CONTRACT_VERSION = "1.0";
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;

export const AoLiveModelChannelSchema = z.enum(["ao-office", "kimi-dedicated"]);
export type AoLiveModelChannel = z.infer<typeof AoLiveModelChannelSchema>;

export const AoLiveModelRouteSchema = z
  .object({
    requestedModel: z.string().min(1),
    channel: AoLiveModelChannelSchema,
    wireModel: z.string().min(1),
  })
  .strict();
export type AoLiveModelRoute = z.infer<typeof AoLiveModelRouteSchema>;

export const AoLiveAgentSpecSchema = z
  .object({
    agent: z.string(),
    wsId: z.string(),
    inngestId: z.string(),
    functionSlug: z.string(),
    triggerEvent: z.string(),
    emitsEvents: z.array(z.string()).default([]),
    auditOnly: z.boolean().default(false),
    displayName: z.string().default(""),
    requiredInputs: z.array(z.string()).default([]),
  })
  .passthrough();
export type AoLiveAgentSpec = z.infer<typeof AoLiveAgentSpecSchema>;

export const AoLiveModelCapabilitySchema = z
  .object({
    requestedModel: z.string().min(1),
    available: z.boolean(),
    channel: AoLiveModelChannelSchema,
    wireModel: z.string().min(1),
    agents: z.array(z.string()).default([]),
    reasoningEfforts: z
      .array(z.enum(["off", "low", "medium", "high", "xhigh", "max"]))
      .default([]),
    reason: z.string().optional(),
  })
  .passthrough();
export type AoLiveModelCapability = z.infer<typeof AoLiveModelCapabilitySchema>;

export const AoLiveCapabilitiesSchema = z
  .object({
    contractVersion: z.string().optional(),
    mode: z.literal("live"),
    agents: z.array(AoLiveAgentSpecSchema),
    /**
     * Optional for backward compatibility with the current AO deployment.
     * New/self-hosted AO deployments should always publish this list so Eval
     * can reject an unavailable model before producing a failed run.
     */
    modelCapabilities: z.array(AoLiveModelCapabilitySchema).optional(),
  })
  .passthrough();
export type AoLiveCapabilities = z.infer<typeof AoLiveCapabilitiesSchema>;

export const AoLiveEnvelopeSchema = z
  .object({
    executionId: z.string(),
    status: z.enum([
      "pending",
      "running",
      "succeeded",
      "failed",
      "timeout",
      "cancelled",
    ]),
    result: z
      .object({
        decision: z.enum(["matched", "not_matched", "needs_review"]).nullable(),
        summary: z.string().default(""),
        output: z.unknown(),
      })
      .nullable()
      .optional(),
    trace: z
      .object({
        runId: z.string(),
        functionSlug: z.string(),
        steps: z
          .array(
            z
              .object({
                name: z.string(),
                status: z.string().nullable().optional(),
                durationMs: z.number().nullable().optional(),
              })
              .passthrough(),
          )
          .default([]),
        emittedEvents: z.array(z.string()).default([]),
        ruleEvaluations: z
          .array(
            z
              .object({
                ruleId: z.string(),
                status: z.string(),
                reason: z.string().nullable().optional(),
                ruleTextSnapshot: z
                  .object({
                    field: z.string().optional(),
                    // Strictly validated when a Suite-backed run requires
                    // runtime proof; legacy evidence remains parse-compatible.
                    sha256: z.string().optional(),
                    version: z.string().optional(),
                  })
                  .passthrough()
                  .optional(),
                interpretationSource: z.string().nullable().optional(),
              })
              .passthrough(),
          )
          .default([]),
      })
      .nullable()
      .optional(),
    meta: z
      .object({
        agent: z.string().optional(),
        triggerEvent: z.string().optional(),
        eventIds: z.array(z.string()).default([]),
        startedAt: z.string().nullable().optional(),
        finishedAt: z.string().nullable().optional(),
        durationMs: z.number().nullable().optional(),
        ontologyLoaded: z
          .object({
            domain: z.string().optional(),
            version: z.string().optional(),
            ruleCount: z.number().int().nonnegative().optional(),
            // Strict format/equality enforcement lives at the Suite boundary.
            snapshotDigest: z.string().optional(),
            liveConsistency: z
              .union([
                z.null(),
                z
                  .object({
                    pinned: z.number().int().nonnegative().optional(),
                    live: z.number().int().nonnegative().optional(),
                  })
                  .passthrough(),
              ])
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string().default(""),
        retryable: z.boolean().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type AoLiveEnvelope = z.infer<typeof AoLiveEnvelopeSchema>;

export const AoLiveExecutionRequestSchema = z
  .object({
    contractVersion: z.literal(AO_LIVE_CONTRACT_VERSION),
    clientRequestId: z.string().min(1),
    correlation: z.object({
      runId: z.string().min(1),
      testCaseId: z.string().min(1),
    }),
    agent: z.string().min(1),
    inputs: z.object({ eventData: z.record(z.string(), z.unknown()) }),
    config: z.object({
      timeoutMs: z.number().int().positive(),
      model: z.string().min(1).optional(),
      modelRoute: AoLiveModelRouteSchema.optional(),
      reasoningEffort: z
        .enum(["off", "low", "medium", "high", "xhigh", "max"])
        .optional(),
      suppressDownstream: z.boolean().optional(),
      /** Canonical Studio ontology snapshot that AO must load and attest in its response. */
      ontologySnapshotDigest: z.string().regex(SHA256_DIGEST).optional(),
    }),
  })
  .strict();
export type AoLiveExecutionRequest = z.infer<
  typeof AoLiveExecutionRequestSchema
>;

/**
 * Kimi/Moonshot dedicated-channel detection, mirrored from Studio's
 * `eval-test/lib/kimi-channel.ts` so route hints resolve identically on both
 * ends of the wire.
 */
function isKimiModel(model: string): boolean {
  return /kimi|moonshot/i.test(model);
}

function toKimiWireModel(model: string): string {
  return model
    .trim()
    .replace(/^openrouter\//i, "")
    .replace(/^moonshot(ai)?\//i, "");
}

export function canonicalAoModelId(
  modelId: string | null | undefined,
): string | null {
  if (!modelId) return null;
  const canonical = modelId.trim().replace(/^openrouter\//i, "");
  return canonical || null;
}

/** Resolve routing metadata without exposing any gateway secret. */
export function resolveAoModelRoute(
  modelId: string | null | undefined,
): AoLiveModelRoute | null {
  const requestedModel = canonicalAoModelId(modelId);
  if (!requestedModel) return null;
  if (isKimiModel(requestedModel)) {
    return {
      requestedModel,
      channel: "kimi-dedicated",
      wireModel: toKimiWireModel(requestedModel),
    };
  }
  return {
    requestedModel,
    channel: "ao-office",
    wireModel: requestedModel,
  };
}

export function findAdvertisedModelCapability(
  capabilities: AoLiveCapabilities,
  route: AoLiveModelRoute,
  agent: string,
): AoLiveModelCapability | null | undefined {
  if (!capabilities.modelCapabilities) return undefined;
  const found = capabilities.modelCapabilities.find(
    (entry) => canonicalAoModelId(entry.requestedModel) === route.requestedModel,
  );
  if (!found || !found.available) return null;
  if (found.agents.length > 0 && !found.agents.includes(agent)) return null;
  if (found.channel !== route.channel || found.wireModel !== route.wireModel)
    return null;
  return found;
}
