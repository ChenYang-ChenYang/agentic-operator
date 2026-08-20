import type {
  TenantReasoningConfigLike,
  TenantRegistry,
  ToolContext,
  ToolDescriptor,
} from "@agentic/agent-kit";
import { candidateDedupLookup } from "./tools/candidate-dedup";
import { persistJdTool } from "./tools/jd-store";
import { persistRaasEntities } from "./tools/raas-persistence";
import { loadRaasRequirement } from "./tools/raas-requirement";
import { loadRaasRuleContext } from "./tools/raas-rule-context";
import { createEvaluateRulesWithReasoningAgent } from "./tools/reasoning-rule-engine";
import { queryFacts } from "./tools/raas-facts";
import { writeEntities } from "./tools/raas-write";
import { inspectEnvironmentReferencesTool } from "@agentic/tools/config";
import { routeInterviewInvitation } from "./tools/route-interview-invitation";
import { routeMatchOutcome } from "./tools/route-match-outcome";
import { routeResumeProcessed } from "./tools/route-resume-processed";

export const RECRUITMENT_RAAS_CAPABILITY_NAMES = [
  "loadRaasRequirement",
  "persistJd",
  "persistRaasEntities",
  "routeResumeProcessed",
  "candidateDedupLookup",
  "loadRaasRuleContext",
  "reasoning.evaluateRules",
  "routeMatchOutcome",
  "routeInterviewInvitation",
] as const;

/**
 * Capabilities safe for an ontology-authored recruitment tenant.  Unlike the
 * legacy pack above, this set contains no candidate precedence, owner-lock,
 * threshold or event-routing implementation.
 *
 * `facts.query` / `entities.write` are the decision-free read/write
 * transports: both defer all SQL and business meaning to a reviewed,
 * server-owned named-statement catalog. Their explicit system wildcard is
 * constrained by exact database kind/role, tenant-scoped profile, operation
 * allow-list and required probe; it is not permission inferred from prose.
 * Allmeta mirroring still binds separately to `ontology.writeInstance`.
 */
export const RECRUITMENT_ONTOLOGY_CAPABILITY_NAMES = [
  "facts.query",
  "entities.write",
  "reasoning.evaluateRules",
  // Diagnostic only: it intentionally carries no business-system capability
  // and therefore cannot satisfy an integration binding or production probe.
  "config.inspectEnvironmentReferences",
] as const;

type RecruitmentCapabilityName =
  | (typeof RECRUITMENT_RAAS_CAPABILITY_NAMES)[number]
  | (typeof RECRUITMENT_ONTOLOGY_CAPABILITY_NAMES)[number];

export interface RecruitmentCapabilityProfile {
  /** Signed registry identity. This is authority; Action prose is not. */
  tenantSlug: string;
  reasoning: TenantReasoningConfigLike;
  /**
   * Compatibility defaults for a reviewed, hand-authored tenant package.
   * Newly generated tenants omit these and must carry a confirmed integration
   * profile in tool_use[].config.
   */
  trustedDefaults?: Partial<
    Record<RecruitmentCapabilityName, Record<string, unknown>>
  >;
  requireExplicitProfile?: boolean;
}

export type RecruitmentRaasCapabilityProfile = RecruitmentCapabilityProfile;

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/**
 * Bind a shared implementation to one signed tenant registry without copying
 * business logic. The wrapper only supplies/rechecks reviewed configuration;
 * it never chooses a tool from an Action description.
 */
function bindTool<T>(
  descriptor: ToolDescriptor<T>,
  profile: RecruitmentCapabilityProfile,
): ToolDescriptor<T> {
  const defaults =
    profile.trustedDefaults?.[descriptor.name as RecruitmentCapabilityName] ??
    {};
  return Object.freeze({
    ...descriptor,
    async handler(ctx: ToolContext) {
      const config = { ...defaults, ...(ctx.config ?? {}) };
      const declaredTenant =
        typeof config.tenant_slug === "string" ? config.tenant_slug.trim() : "";
      if (descriptor.factory?.configSchema?.tenant_slug) {
        if (!declaredTenant) {
          throw new Error(`${descriptor.name}: config.tenant_slug is required`);
        }
        if (declaredTenant !== profile.tenantSlug) {
          throw new Error(
            `${descriptor.name}: integration profile tenant '${declaredTenant}' does not match registry tenant '${profile.tenantSlug}'`,
          );
        }
      }
      if (profile.requireExplicitProfile) {
        for (const [key, field] of Object.entries(
          descriptor.factory?.configSchema ?? {},
        )) {
          if (field.required && !present(config[key])) {
            throw new Error(`${descriptor.name}: config.${key} is required`);
          }
        }
      }
      return descriptor.handler({ ...ctx, config });
    },
  });
}

export function createRecruitmentRaasCapabilityPack(
  profile: RecruitmentCapabilityProfile,
): NonNullable<TenantRegistry["tools"]> {
  if (!profile.tenantSlug.trim()) {
    throw new Error("recruitment capability profile requires tenantSlug");
  }
  if (!profile.reasoning.ontology.domainId.trim()) {
    throw new Error(
      "recruitment capability profile requires reasoning domainId",
    );
  }
  const descriptors: ToolDescriptor[] = [
    loadRaasRequirement,
    persistJdTool,
    persistRaasEntities,
    routeResumeProcessed,
    candidateDedupLookup,
    loadRaasRuleContext,
    createEvaluateRulesWithReasoningAgent(profile.reasoning),
    routeMatchOutcome,
    routeInterviewInvitation,
  ];
  return Object.fromEntries(
    descriptors.map((descriptor) => [
      descriptor.name,
      bindTool(descriptor, profile),
    ]),
  );
}

/**
 * Build the decision-free/ontology-driven recruitment surface used by newly
 * generated tenants. Legacy RAAS decisions intentionally stay in
 * createRecruitmentRaasCapabilityPack for reviewed compatibility tenants.
 */
export function createRecruitmentOntologyCapabilityPack(
  profile: RecruitmentCapabilityProfile,
): NonNullable<TenantRegistry["tools"]> {
  if (!profile.tenantSlug.trim()) {
    throw new Error("recruitment capability profile requires tenantSlug");
  }
  if (!profile.reasoning.ontology.domainId.trim()) {
    throw new Error(
      "recruitment capability profile requires reasoning domainId",
    );
  }
  const descriptors: ToolDescriptor[] = [
    queryFacts,
    writeEntities,
    createEvaluateRulesWithReasoningAgent(profile.reasoning),
    inspectEnvironmentReferencesTool,
  ];
  return Object.fromEntries(
    descriptors.map((descriptor) => [
      descriptor.name,
      bindTool(descriptor, profile),
    ]),
  );
}
