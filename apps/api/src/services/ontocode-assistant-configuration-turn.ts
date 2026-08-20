/**
 * Turn-facing half of the in-band configuration flow: the production ports
 * (real stores, real preflight evidence) plus the secret-free rendering that
 * puts a proposal or an applied result in front of the FDE the same way every
 * other assistant result arrives — assistant text plus validated
 * recommendation cards.
 *
 * The pure decision logic lives in `ontocode-assistant-configuration.ts`; this
 * file only wires it to the existing routes' stores. There is deliberately no
 * second write path: env-reference decisions go through `upsertSystemProfile`
 * (the reviewed `PUT /v1/system-profiles` commit, which stamps the confirmer)
 * and declared non-secret values go through `upsertIntegration` (the store
 * behind `PUT /v1/integrations`).
 */

import { integrationContractForDomain } from "./integration-contract-registry";
import type { SystemProfileV1 } from "@agentic/contracts";
import type { RealTool } from "@agentic/agent-factory";
import {
  credentialPresence,
  mergeFactoryPreflightTools,
  preflightProfileHashKey,
} from "../../scripts/factory-domain-preflight";
import { getIntegrationVerificationSnapshot, upsertIntegration } from "./integration-store";
import { listSystemProfiles, upsertSystemProfile } from "./system-profile-store";
import { currentFactoryExecutionTools } from "./agent-factory/execution-resource-snapshot";
import type { ToolEntryLite } from "./system-config-requirements";
import { norm } from "./system-coverage";
import {
  summarizeConfigurationReadiness,
  type ConfigurationApplyOutcome,
  type ConfigurationApplyPorts,
  type ConfigurationChange,
  type ConfigurationProposalOutcome,
  type ConfigurationReadinessDelta,
  type ConfigurationReadinessSnapshot,
  type LegacyEnvAlternative,
} from "./ontocode-assistant-configuration";

// ─── Ports ───────────────────────────────────────────────────────────────────

function safeListSystemProfiles(tenantId: string): SystemProfileV1[] {
  try {
    return listSystemProfiles(tenantId);
  } catch (error) {
    // Pre-migration DBs degrade to "no profiles" — the flow then clarifies
    // instead of guessing, which is the correct posture either way.
    if (String((error as Error).message).includes("no such table")) return [];
    throw error;
  }
}

function toolEntry(tool: RealTool): ToolEntryLite {
  const configSchema = tool.catalogDefinition?.configSchema;
  return {
    name: tool.name,
    category: tool.category ?? tool.name.split(".")[0] ?? tool.name,
    ...(tool.credentialEnv ? { credentialEnv: tool.credentialEnv } : {}),
    ...(configSchema && typeof configSchema === "object" && !Array.isArray(configSchema)
      ? { configSchema: configSchema as Record<string, unknown> }
      : {}),
    ...(tool.capabilities ? { capabilities: tool.capabilities } : {}),
  };
}

/**
 * Declared migration candidates, per Ontology domain.
 *
 * These are AUTHORED contracts, not inferences: the entries state, in their own
 * `migrationNote`, that tooling must present both names and let the FDE choose,
 * and must never copy a value between them. New domains register their own
 * contract here; nothing is derived from a name pattern.
 */
export function declaredLegacyEnvAlternatives(input: {
  domain: string;
  systemNames: string[];
}): LegacyEnvAlternative[] {
  // Registered data, not a compile-time customer branch: any domain whose
  // tenant package registered a contract at bootstrap gets its migration
  // guidance. An unregistered domain has declared nothing — [] is honest there
  // (the contract itself is the declaration, so absence means "not declared").
  const lookup = integrationContractForDomain(input.domain);
  if (lookup.status !== "declared") return [];
  const wanted = new Set(input.systemNames.map(norm).filter(Boolean));
  return lookup.contract.profiles
    .filter((profile) => wanted.has(norm(profile.systemName)))
    .flatMap((profile) =>
      profile.legacyEnvAlternatives.map((entry) => ({
        preferredEnv: entry.preferredEnv,
        alternatives: [...entry.alternatives],
        migrationNote: entry.migrationNote,
      })),
    );
}

/**
 * Real readiness evidence, scored by `summarizeFactoryDomainPreflight` — the
 * same pure binding logic `preflight:factory-domain` runs. This composes the
 * production factory ports directly (the CLI's read-only DB enforcement is
 * deliberately NOT applied: inside the API the writer is already this process).
 * Any failure returns null so a delta is reported as unavailable rather than
 * invented.
 */
export async function collectConfigurationReadiness(input: {
  tenantId: string;
  tenantSlug: string;
  domain: string;
}): Promise<ConfigurationReadinessSnapshot | null> {
  try {
    const [{ makeFactoryPorts }, { resolveOntologyReferences, probeDefinitionHash }] =
      await Promise.all([
        import("./agent-factory/index"),
        import("@agentic/agent-factory"),
      ]);
    const ports = makeFactoryPorts(input.tenantSlug, input.tenantId, input.domain);
    const [rootOntology, globalTools, declarativeTools, runtimeProviders, aliasGroups] =
      await Promise.all([
        ports.ontology.fetchOntology(input.domain),
        ports.toolRegistry?.list() ?? Promise.resolve([]),
        ports.tools?.list(input.domain) ?? Promise.resolve([]),
        ports.integrationCapabilities?.list() ?? Promise.resolve([]),
        ports.systemAliases?.list() ?? Promise.resolve([]),
      ]);
    const ontology = await resolveOntologyReferences(rootOntology, ports.ontology);
    const merged = mergeFactoryPreflightTools(globalTools, declarativeTools);
    const profileDefinitionHashes: Record<string, string> = {};
    for (const tool of merged.executableTools) {
      for (const profile of tool.integrationProfiles ?? []) {
        const hash = probeDefinitionHash(tool, profile.config, process.env);
        if (hash) {
          profileDefinitionHashes[preflightProfileHashKey(tool.name, profile.id)] = hash;
        }
      }
    }
    return summarizeConfigurationReadiness({
      scope: {
        tenantId: input.tenantId,
        tenantSlug: input.tenantSlug,
        domain: input.domain,
      },
      ontology,
      globalTools,
      declarativeTools,
      runtimeProviders,
      systemAliasGroups: aliasGroups,
      envPresence: credentialPresence(merged.executableTools, process.env),
      profileDefinitionHashes,
    });
  } catch {
    return null;
  }
}

export function defaultConfigurationPorts(): ConfigurationApplyPorts {
  return {
    listSystemProfiles: safeListSystemProfiles,
    listToolEntries: async ({ tenantId, tenantSlug, domain }) => {
      try {
        const tools = await currentFactoryExecutionTools({
          tenantId,
          tenantSlug,
          domainId: domain,
        });
        return tools.map(toolEntry);
      } catch {
        return [];
      }
    },
    getIntegrationSnapshot: getIntegrationVerificationSnapshot,
    envPresent: (name) => Boolean(process.env[name]?.trim()),
    legacyEnvAlternatives: declaredLegacyEnvAlternatives,
    upsertSystemProfile: (tenantId, profile, opts) =>
      upsertSystemProfile(tenantId, profile, opts),
    upsertIntegration: (input) => {
      const saved = upsertIntegration(input);
      return { provider: saved.provider };
    },
    readiness: collectConfigurationReadiness,
    audit: async (entry) => {
      try {
        const audit = await import("../plugins/audit");
        audit.writeAudit(entry);
      } catch {
        /* audit is best-effort, exactly like the routes' own writes */
      }
    },
  };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/** A recommendation card shaped exactly as the workspace projection accepts:
 * only the seven declared keys, and an action whose type matches the kind. */
export interface ConfigurationRecommendation {
  id: string;
  kind: "configuration" | "decision";
  title: string;
  reason: string;
  impact?: string;
  recommended: boolean;
  action:
    | { type: "reply"; label: string; value: string }
    | {
        type: "configure";
        label: string;
        destination: "integrations" | "system_profiles";
        providerId?: string;
        systemName?: string;
      };
}

export interface ConfigurationTurnRendering {
  text: string;
  recommendations: ConfigurationRecommendation[];
}

/**
 * The turn store persists assistant recommendations as opaque JSON. The shape
 * is pinned above (and by what the workspace projection will accept); this is
 * the single place the typed view and the JSON view meet.
 */
export function assistantRecommendationRecords(
  recommendations: ConfigurationRecommendation[],
): Array<Record<string, unknown>> {
  return recommendations as unknown as Array<Record<string, unknown>>;
}

function safeId(prefix: string, value: string): string {
  const slug = value.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80) || "x";
  return `${prefix}-${slug}`.slice(0, 120);
}

function presenceWord(present: boolean | null): string {
  if (present === null) return "未声明环境变量";
  return present ? "已设置" : "未设置";
}

function renderChange(change: ConfigurationChange): string {
  switch (change.action) {
    case "set_value":
      return `· ${change.fieldKey}：写入集成记录 → ${change.newValue}`;
    case "select_env_ref":
      return (
        `· ${change.fieldKey}：需要你选一个环境变量名 —— ` +
        change.options
          .map(
            (option) =>
              `${option.envRef}（${option.role === "preferred" ? "推荐" : "历史"}，${option.present ? "已设置" : "未设置"}）`,
          )
          .join(" 或 ")
      );
    case "requires_environment":
      return `· ${change.fieldKey}：密钥字段，不接受对话里的值${change.envRef ? `——请设置环境变量 ${change.envRef}` : ""}`;
    case "awaiting_value":
      return `· ${change.fieldKey}：还缺你要写入的值`;
  }
}

export function renderConfigurationProposal(
  outcome: ConfigurationProposalOutcome,
): ConfigurationTurnRendering {
  if (outcome.kind === "secret_in_chat") {
    return {
      text: outcome.message,
      recommendations: [
        {
          id: "configuration-secret-refused",
          kind: "configuration",
          title: "改用受控表单或部署环境变量",
          reason:
            "密钥值不能出现在对话、计划、提案或档案里；配置只记录环境变量名字。",
          impact: "本次没有任何写入发生。",
          recommended: true,
          action: {
            type: "configure",
            label: "打开 Integrations 配置",
            destination: "integrations",
          },
        },
      ],
    };
  }

  if (outcome.kind === "clarify") {
    return {
      text: outcome.question,
      recommendations: outcome.candidates.slice(0, 5).map((candidate) => ({
        id: safeId("configuration-target", candidate.profileId ?? candidate.system),
        kind: "decision" as const,
        title: `改 ${candidate.system} 的配置`,
        reason: `该系统已建档${candidate.provider ? `（provider=${candidate.provider}）` : ""}，我会按它声明的字段给出确切改动。`,
        recommended: false,
        action: {
          type: "reply" as const,
          label: candidate.system,
          value: `我要改 ${candidate.system} 的配置`,
        },
      })),
    };
  }

  const { proposal, confirmations } = outcome;
  const lines: string[] = [
    `配置提案 · ${proposal.system}${proposal.provider ? `（provider=${proposal.provider}）` : ""} · 域 ${proposal.ontologyDomain}`,
    `声明字段（当前状态，只报有无，不报值）：`,
    ...proposal.fields.map(
      (field) =>
        `· ${field.key}（${field.kind}${field.required ? "，必填" : ""}${field.secret ? "，密钥" : ""}）：` +
        `存储${field.storedValuePresent ? "已有值" : "无值"}；` +
        `环境变量 ${field.envRef ?? "—"} ${presenceWord(field.envPresent)}`,
    ),
  ];
  if (proposal.changes.length > 0) {
    lines.push("本次改动：", ...proposal.changes.map(renderChange));
  } else {
    lines.push("本次没有识别出要改的字段——请点名字段并说明要写入什么。");
  }
  if (proposal.notes.length > 0) lines.push(...proposal.notes.map((note) => `注：${note}`));
  lines.push(
    confirmations.length > 0
      ? "确认之前我不会写入任何东西。确认后我会用本 Session 的归属人身份签署这次变更，并重新跑一次就绪度告诉你解开了什么。"
      : "现在还没有我能落库的改动。",
  );

  const recommendations: ConfigurationRecommendation[] = confirmations
    .slice(0, 4)
    .map((confirmation, index) => ({
      id: safeId(
        "configuration-confirm",
        `${proposal.digest}-${confirmation.pick ?? index}`,
      ),
      kind: "decision" as const,
      title: confirmation.label,
      reason: `按上面列出的确切改动写入 ${proposal.system} 的配置，由本 Session 的归属人签署。`,
      impact: "写入后会自动重跑就绪度并报告差异。",
      recommended: index === 0 && confirmations.length === 1,
      action: {
        type: "reply" as const,
        label: confirmation.label,
        value: confirmation.value,
      },
    }));

  const secretFields = proposal.changes.filter(
    (change) => change.action === "requires_environment",
  );
  if (secretFields.length > 0 && recommendations.length < 5) {
    recommendations.push({
      id: safeId("configuration-secret-field", proposal.digest),
      kind: "configuration",
      title: "密钥字段请走受控表单",
      reason: `${secretFields.map((change) => change.fieldKey).join("、")} 声明为密钥，值不能进对话。`,
      recommended: false,
      action: {
        type: "configure",
        label: "打开 Integrations 配置",
        destination: "integrations",
        ...(proposal.provider ? { providerId: proposal.provider } : {}),
        systemName: proposal.system,
      },
    });
  }
  return { text: lines.join("\n"), recommendations };
}

function renderReadinessDelta(delta: ConfigurationReadinessDelta): string {
  if (!delta.available) {
    return "就绪度差异：这次拿不到权威的 preflight 证据，我不编造——请到工作台重跑一次就绪度检查。";
  }
  if (!delta.changed) {
    return `就绪度差异：无变化（仍为 ${delta.after?.ready ? "ready" : "blocked"}）。`;
  }
  const parts = [
    `就绪度：${delta.before?.ready ? "ready" : "blocked"} → ${delta.after?.ready ? "ready" : "blocked"}`,
  ];
  if (delta.unblockedActions.length > 0) {
    parts.push(`已解开的动作：${delta.unblockedActions.join("、")}`);
  }
  if (delta.newlyBlockedActions.length > 0) {
    parts.push(`新增受阻的动作：${delta.newlyBlockedActions.join("、")}`);
  }
  const counts = Object.entries(delta.countDelta)
    .map(([status, value]) => `${status} ${value > 0 ? "+" : ""}${value}`)
    .join("，");
  if (counts) parts.push(`绑定计数变化：${counts}`);
  return `就绪度差异：${parts.join("；")}。`;
}

export function renderConfigurationApply(
  outcome: ConfigurationApplyOutcome,
): ConfigurationTurnRendering {
  if (outcome.kind === "refused") {
    return {
      text: outcome.message,
      recommendations:
        outcome.code === "no_owner_identity"
          ? []
          : [
              {
                id: safeId("configuration-retry", outcome.code),
                kind: "decision",
                title: "重新给出配置改动",
                reason: "这次确认没有落库；重新描述后我会重新给出确切改动。",
                recommended: false,
                action: {
                  type: "reply",
                  label: "重新提出配置改动",
                  value: "重新给我这个系统的配置改动提案",
                },
              },
            ],
    };
  }

  const lines = [
    `已应用配置变更 · ${outcome.system}${outcome.provider ? `（provider=${outcome.provider}）` : ""}`,
    `签署人（Session 归属人）：${outcome.confirmedBy}`,
    ...outcome.applied.map((entry) =>
      entry.action === "select_env_ref"
        ? `· ${entry.fieldKey}：环境变量名记为 ${entry.envRef}（只记名字，没有读取或复制任何值）`
        : `· ${entry.fieldKey}：写入集成记录 → ${entry.newValue}`,
    ),
    renderReadinessDelta(outcome.readiness),
  ];
  if (outcome.probeInvalidated) {
    lines.push(
      "注：这次是一次人审提交，之前的连接探针结论已随之作废——请重新跑一次连接测试再据此判断。",
    );
  }
  return {
    text: lines.join("\n"),
    recommendations: [
      {
        id: safeId("configuration-probe", outcome.digest),
        kind: "configuration",
        title: "重跑连接测试",
        reason: "配置刚变过，之前的连接结论不再是证据。",
        recommended: true,
        action: {
          type: "configure",
          label: "打开 Integrations 配置",
          destination: "integrations",
          ...(outcome.provider ? { providerId: outcome.provider } : {}),
          systemName: outcome.system,
        },
      },
    ],
  };
}
