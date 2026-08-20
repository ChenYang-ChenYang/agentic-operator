import { z } from "zod";

export const FactoryInteractionPolicySchema = z.enum(["strict", "autopilot"]);
export type FactoryInteractionPolicy = z.infer<
  typeof FactoryInteractionPolicySchema
>;

/** Canonical JSON transport for both the legacy Factory composer and OntoCode.
 * Legacy callers send domain+goal. OntoCode may instead select authoritative
 * Action ids or describe a scenario. */
export const FactoryRunStartRequestSchema = z
  .object({
    domain: z.string().trim().min(1),
    goal: z.string().optional(),
    conversation: z.string().trim().min(1).optional(),
    actionIds: z.array(z.string().trim().min(1)).max(100).optional(),
    scenario: z.string().trim().max(20_000).optional(),
    interactionPolicy: FactoryInteractionPolicySchema.optional(),
    recommendationId: z.string().regex(/^rec_[a-f0-9]{32}$/).optional(),
    ontologyHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      !value.goal?.trim() &&
      !value.scenario?.trim() &&
      !value.actionIds?.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["goal"],
        message: "goal/actionIds/scenario 至少一个非空",
      });
    }
    if (Boolean(value.recommendationId) !== Boolean(value.ontologyHash)) {
      ctx.addIssue({
        code: "custom",
        path: ["recommendationId"],
        message: "recommendationId 与 ontologyHash 必须同时提供",
      });
    }
    if (value.recommendationId && !value.scenario?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["scenario"],
        message: "使用 Action 范围推荐时 scenario 必填",
      });
    }
  });

export type FactoryRunStartRequest = z.infer<
  typeof FactoryRunStartRequestSchema
>;

export const FactoryRunStartReceiptSchema = z.object({
  runId: z.string().min(1),
  mode: z.enum(["started", "attached"]),
  interactionPolicy: FactoryInteractionPolicySchema,
  generation: z
    .object({
      mode: z.enum([
        "action_selection",
        "scenario_match",
        "virtual_scenario",
      ]),
      actionIds: z.array(z.string()),
      actionNames: z.array(z.string()),
      virtualAction: z
        .object({
          id: z.string(),
          name: z.string(),
          trigger: z.array(z.string()),
          emit: z.array(z.string()),
          provenance: z.object({
            schema: z.literal("agent-factory-virtual-action/v1"),
            kind: z.literal("virtual_scenario"),
            source: z.literal("factory_session_overlay"),
            authoritative: z.literal(false),
            scenarioHash: z.string().regex(/^[a-f0-9]{64}$/),
          }),
        })
        .nullable(),
    })
    .optional(),
});

export type FactoryRunStartReceipt = z.infer<
  typeof FactoryRunStartReceiptSchema
>;

export const FactoryScopeRecommendationRequestSchema = z
  .object({
    domain: z.string().trim().min(1),
    scenario: z.string().trim().min(1).max(20_000),
  })
  .strict();

export const FactoryScopeRecommendationReceiptSchema = z
  .object({
    recommendationId: z.string().regex(/^rec_[a-f0-9]{32}$/),
    ontologyHash: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.enum([
      "action_selection",
      "scenario_match",
      "virtual_scenario",
    ]),
    scenario: z.string().trim().min(1),
    actionIds: z.array(z.string().trim().min(1)).max(100),
    actions: z.array(
      z.object({
        id: z.string().trim().min(1),
        name: z.string().trim().min(1),
        reason: z.string().trim().min(1),
      }),
    ),
    virtualAction: z
      .object({
        id: z.string().trim().min(1),
        name: z.string().trim().min(1),
        reason: z.string().trim().min(1),
      })
      .optional(),
    reasoningSummary: z.string().trim().min(1),
    confidence: z.number().min(0).max(1),
    unresolved: z.array(z.string().trim().min(1)).max(20).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set(value.actionIds);
    const actionIds = new Set(value.actions.map((action) => action.id));
    if (
      ids.size !== value.actionIds.length ||
      actionIds.size !== value.actions.length ||
      ids.size !== actionIds.size ||
      [...ids].some((id) => !actionIds.has(id))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["actions"],
        message: "actions 必须与唯一 actionIds 精确对应",
      });
    }
    if (value.mode === "virtual_scenario") {
      if (value.actionIds.length || !value.virtualAction) {
        ctx.addIssue({
          code: "custom",
          path: ["virtualAction"],
          message: "virtual_scenario 必须返回空 actionIds 和 virtualAction",
        });
      }
    } else if (!value.actionIds.length || value.virtualAction) {
      ctx.addIssue({
        code: "custom",
        path: ["actionIds"],
        message: "Action 推荐必须返回非空 actionIds 且不能包含 virtualAction",
      });
    }
  });

export type FactoryScopeRecommendationRequest = z.infer<
  typeof FactoryScopeRecommendationRequestSchema
>;
export type FactoryScopeRecommendationReceipt = z.infer<
  typeof FactoryScopeRecommendationReceiptSchema
>;
