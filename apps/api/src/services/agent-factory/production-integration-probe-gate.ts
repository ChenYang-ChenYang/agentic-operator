import { promises as fs } from "node:fs";
import path from "node:path";
import {
  probeDefinitionHash,
  type GeneratedAgentSpec,
  type RealTool,
} from "@agentic/agent-factory";
import {
  type CanonicalCassetteDocument,
} from "@agentic/shared/cassette";
import { validateToolSchema } from "@agentic/tools";
import {
  cassetteConfigHash,
  completeWriteProbeProofIssues,
  verifyCassetteEvidenceAttestation,
} from "./cassette-evidence-attestation";
import {
  findVerifiedToolProbeReceipt,
  listGlobalToolProbeReceipts,
  type GlobalToolProbeReceipt,
} from "./tool-probe-store";
import { UNVERIFIED_WRITE_PROBE_IDEMPOTENCY_HASH } from "./integration-probe";

export type ProductionIntegrationProbeIssue = {
  code:
    | "tool_missing"
    | "definition_identity_missing"
    | "production_live_probe_missing"
    | "production_cassette_invalid"
    | "production_write_probe_incomplete";
  tool: string;
  specSlugs: string[];
  expectedDefinitionHash?: string;
};

function risky(tool: RealTool): boolean {
  return tool.effectScope === "external"
    || tool.operation === "write"
    || tool.operation === "read_write"
    || tool.sideEffect === "write"
    || tool.sideEffect === "dual"
    || tool.capabilities?.some((capability) => capability.probeRequired === true) === true;
}

function selectedToolNames(spec: GeneratedAgentSpec): string[] {
  const names = new Set(spec.tools ?? []);
  const visit = (steps: GeneratedAgentSpec["plan"]): void => {
    for (const step of steps ?? []) {
      if (step.kind === "tool" && step.tool) names.add(step.tool);
      if (step.body?.length) visit(step.body);
    }
  };
  visit(spec.plan);
  return [...names].sort();
}

/**
 * Production mutation must be bound to the exact production profile, not the
 * sandbox profile that produced the regression cassette.  The registry view
 * exposes only API-attested, unexpired live-probe hashes in
 * productionVerifiedDefinitionHashes; signed fixtures/runtime recordings are
 * deliberately absent.
 */
export function productionIntegrationProbeIssues(
  specs: readonly GeneratedAgentSpec[],
  tools: readonly RealTool[],
  env: Record<string, string | undefined> = process.env,
): ProductionIntegrationProbeIssue[] {
  const grouped = new Map<string, {
    tool: string;
    expectedDefinitionHash?: string;
    specSlugs: Set<string>;
    code: ProductionIntegrationProbeIssue["code"];
  }>();
  for (const spec of specs) {
    for (const selectedName of selectedToolNames(spec)) {
      const tool = tools.find((candidate) =>
        candidate.name === selectedName || candidate.aliases?.includes(selectedName));
      if (!tool) {
        const key = `missing\u0000${selectedName}`;
        const row = grouped.get(key) ?? {
          tool: selectedName,
          specSlugs: new Set<string>(),
          code: "tool_missing" as const,
        };
        row.specSlugs.add(spec.slug);
        grouped.set(key, row);
        continue;
      }
      if (!risky(tool)) continue;
      const config = spec.toolConfigs?.[tool.name]
        ?? spec.toolConfigs?.[selectedName]
        ?? {};
      const expectedDefinitionHash = probeDefinitionHash(tool, config, env);
      if (expectedDefinitionHash
        && (tool.productionVerifiedDefinitionHashes ?? []).includes(expectedDefinitionHash)) {
        continue;
      }
      const code: ProductionIntegrationProbeIssue["code"] = expectedDefinitionHash
        ? "production_live_probe_missing"
        : "definition_identity_missing";
      const key = `${code}\u0000${tool.name}\u0000${expectedDefinitionHash ?? "missing"}`;
      const row = grouped.get(key) ?? {
        tool: tool.name,
        expectedDefinitionHash,
        specSlugs: new Set<string>(),
        code,
      };
      row.specSlugs.add(spec.slug);
      grouped.set(key, row);
    }
  }
  return [...grouped.values()]
    .map((row) => ({
      code: row.code,
      tool: row.tool,
      specSlugs: [...row.specSlugs].sort(),
      ...(row.expectedDefinitionHash
        ? { expectedDefinitionHash: row.expectedDefinitionHash }
        : {}),
    }))
    .sort((left, right) =>
      left.tool.localeCompare(right.tool)
      || left.code.localeCompare(right.code)
      || left.specSlugs.join("\u0000").localeCompare(right.specSlugs.join("\u0000")));
}

export function productionIntegrationProbeIssueMessage(
  issue: ProductionIntegrationProbeIssue,
): string {
  const scope = `${issue.tool}（Agent: ${issue.specSlugs.join("、")}）`;
  if (issue.code === "tool_missing") return `${scope} 已不在当前真实工具目录`;
  if (issue.code === "definition_identity_missing") {
    return `${scope} 无法计算当前实现与 production profile 的稳定身份`;
  }
  if (issue.code === "production_cassette_invalid") {
    return `${scope} 的 production live probe cassette 无法验签或已过期`;
  }
  if (issue.code === "production_write_probe_incomplete") {
    return `${scope} 的 production 写探针没有完整证明创建、幂等、清理和缺席回读`;
  }
  return `${scope} 没有命中当前 production profile/凭证的未过期 live probe`;
}

async function containedCassettePath(dataRoot: string, value: unknown): Promise<string | undefined> {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const root = path.resolve(dataRoot, "factory-cassettes");
  const candidate = path.resolve(value.trim());
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  try {
    // Lexical containment alone permits a symlink inside factory-cassettes to
    // escape the evidence volume. Resolve both ends before reading; the HMAC
    // remains the authorization check, while this prevents arbitrary host-file
    // reads through a forged/stale receipt path.
    const [realRoot, realCandidate] = await Promise.all([
      fs.realpath(root),
      fs.realpath(candidate),
    ]);
    const realRelative = path.relative(realRoot, realCandidate);
    if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      return undefined;
    }
    return realCandidate;
  } catch {
    return undefined;
  }
}

export type ToolRevisionActivationEvidenceResult =
  | {
      ok: true;
      receipt: GlobalToolProbeReceipt;
      definitionHash: string;
      attestationKeyId: string;
      attestationExpiresAt: string;
    }
  | {
      ok: false;
      code:
        | "production_live_probe_missing"
        | "production_cassette_invalid"
        | "production_write_probe_incomplete";
      message: string;
    };

/**
 * Activation boundary for a managed tool revision.
 *
 * `factory_tool_probes` is deliberately treated as a search index only. Every
 * candidate is resolved to a contained cassette, re-read, HMAC-verified, and
 * checked for a signed exact revision identity, successful HTTP exchange,
 * return schema, and (for writes) complete canary cleanup proof.
 */
export async function verifyToolRevisionActivationEvidence(input: {
  tenantId: string;
  tenantSlug: string;
  domainId: string;
  revisionId: string;
  revisionDefinitionHash: string;
  tool: RealTool;
  dataRoot?: string;
}): Promise<ToolRevisionActivationEvidenceResult> {
  const dataRoot = path.resolve(
    input.dataRoot?.trim() ||
      process.env.AGENTIC_DATA_ROOT?.trim() ||
      "./data",
  );
  const candidates = listGlobalToolProbeReceipts(
    input.tenantId,
    input.domainId,
  )
    .filter(
      (receipt) =>
        receipt.toolName === input.tool.name &&
        Boolean(
          findVerifiedToolProbeReceipt([receipt], {
            toolName: input.tool.name,
            definitionHash: receipt.definitionHash,
            productionOnly: true,
          }),
        ),
    )
    .sort((left, right) =>
      (right.verifiedAt ?? "").localeCompare(left.verifiedAt ?? ""),
    );
  if (candidates.length === 0) {
    return {
      ok: false,
      code: "production_live_probe_missing",
      message:
        "这个 exact revision 没有未过期的 API-attested live probe。",
    };
  }

  let sawIncompleteWriteProof = false;
  for (const receipt of candidates) {
    const cassettePath = await containedCassettePath(
      dataRoot,
      receipt.evidence?.cassettePath,
    );
    if (!cassettePath) continue;
    try {
      const stat = await fs.stat(cassettePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 * 1024) {
        continue;
      }
      const document = JSON.parse(
        await fs.readFile(cassettePath, "utf8"),
      ) as CanonicalCassetteDocument;
      const configHash =
        document.evidence?.attestation?.binding.configHash ?? "";
      const verification = verifyCassetteEvidenceAttestation(
        document,
        {
          tenantId: input.tenantId,
          tenantSlug: input.tenantSlug,
          domainId: input.domainId,
          toolName: input.tool.name,
          definitionHash: receipt.definitionHash,
          configHash,
          allowedModes: ["live-probe"],
        },
        { dataRoot },
      );
      if (!verification.valid) continue;
      if (
        document.evidence?.toolRevision?.id !== input.revisionId ||
        document.evidence.toolRevision.definitionHash !==
          input.revisionDefinitionHash
      ) {
        continue;
      }
      if (
        document.entries.length !== 1 ||
        document.entries[0]!.response.status < 200 ||
        document.entries[0]!.response.status >= 300
      ) {
        continue;
      }
      const returnsSchema =
        input.tool.declarativeDefinition?.returnsSchema ??
        input.tool.catalogDefinition?.returnsSchema;
      if (
        validateToolSchema(
          document.entries[0]!.response.body,
          returnsSchema as Record<string, unknown> | undefined,
        ).length
      ) {
        continue;
      }
      const write =
        input.tool.operation === "write" ||
        input.tool.operation === "read_write" ||
        input.tool.sideEffect === "write" ||
        input.tool.sideEffect === "dual";
      if (write) {
        const proof = document.evidence?.writeProbe;
        const proofIssues = completeWriteProbeProofIssues(proof);
        for (const value of [
          proof?.markerHash,
          proof?.namespaceHash,
          proof?.targetHash,
          proof?.idempotencyKeyHash,
        ]) {
          if (!/^[a-f0-9]{64}$/i.test(value ?? "")) {
            proofIssues.push(
              "production write probe identities must use SHA-256",
            );
            break;
          }
        }
        if (
          proof?.idempotencyKeyHash ===
          UNVERIFIED_WRITE_PROBE_IDEMPOTENCY_HASH
        ) {
          proofIssues.push(
            "production write probe did not verify its declared idempotency key",
          );
        }
        if (proofIssues.length) {
          sawIncompleteWriteProof = true;
          continue;
        }
      }
      return {
        ok: true,
        receipt,
        definitionHash: receipt.definitionHash,
        attestationKeyId: verification.summary!.attestationKeyId,
        attestationExpiresAt:
          verification.summary!.attestationExpiresAt,
      };
    } catch {
      // Keep trying older still-valid receipts. No unverified file detail is
      // returned to the caller.
    }
  }
  if (sawIncompleteWriteProof) {
    return {
      ok: false,
      code: "production_write_probe_incomplete",
      message:
        "写工具的已签名 live probe 没有完整证明 create、cleanup、absence readback 和幂等性。",
    };
  }
  return {
    ok: false,
    code: "production_cassette_invalid",
    message:
      "live probe 索引存在，但 exact cassette 无法通过路径、HMAC、revision、2xx 或返回契约校验。",
  };
}

/** Commit-boundary proof: re-read the exact durable receipt and HMAC-verify its
 * cassette bytes. Hash summaries are a fast readiness index, never the final
 * production authorization boundary. */
export async function verifyProductionIntegrationProbeEvidence(input: {
  tenantId: string;
  tenantSlug: string;
  domainId: string;
  specs: readonly GeneratedAgentSpec[];
  tools: readonly RealTool[];
  env?: Record<string, string | undefined>;
  dataRoot?: string;
}): Promise<ProductionIntegrationProbeIssue[]> {
  const env = input.env ?? process.env;
  const structural = productionIntegrationProbeIssues(input.specs, input.tools, env);
  if (structural.length) return structural;
  const receipts = listGlobalToolProbeReceipts(input.tenantId, input.domainId);
  const dataRoot = path.resolve(
    input.dataRoot?.trim() || process.env.AGENTIC_DATA_ROOT?.trim() || "./data",
  );
  const grouped = new Map<string, {
    tool: RealTool;
    config: Record<string, unknown>;
    definitionHash: string;
    specSlugs: Set<string>;
  }>();
  for (const spec of input.specs) {
    for (const selectedName of selectedToolNames(spec)) {
      const tool = input.tools.find((candidate) =>
        candidate.name === selectedName || candidate.aliases?.includes(selectedName));
      if (!tool || !risky(tool)) continue;
      const config = spec.toolConfigs?.[tool.name]
        ?? spec.toolConfigs?.[selectedName]
        ?? {};
      const definitionHash = probeDefinitionHash(tool, config, env);
      if (!definitionHash) continue; // returned by the structural gate above
      const key = `${tool.name}\u0000${definitionHash}`;
      const row = grouped.get(key) ?? {
        tool,
        config,
        definitionHash,
        specSlugs: new Set<string>(),
      };
      row.specSlugs.add(spec.slug);
      grouped.set(key, row);
    }
  }

  const issues: ProductionIntegrationProbeIssue[] = [];
  for (const row of grouped.values()) {
    const base = {
      tool: row.tool.name,
      specSlugs: [...row.specSlugs].sort(),
      expectedDefinitionHash: row.definitionHash,
    };
    const receipt = findVerifiedToolProbeReceipt(receipts, {
      toolName: row.tool.name,
      definitionHash: row.definitionHash,
      productionOnly: true,
    });
    if (!receipt) {
      issues.push({ code: "production_live_probe_missing", ...base });
      continue;
    }
    const cassettePath = await containedCassettePath(
      dataRoot,
      receipt.evidence?.cassettePath,
    );
    if (!cassettePath) {
      issues.push({ code: "production_cassette_invalid", ...base });
      continue;
    }
    let document: CanonicalCassetteDocument;
    try {
      const stat = await fs.stat(cassettePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 * 1024) {
        throw new Error("cassette file size is invalid");
      }
      document = JSON.parse(await fs.readFile(cassettePath, "utf8")) as CanonicalCassetteDocument;
      const verification = verifyCassetteEvidenceAttestation(document, {
        tenantId: input.tenantId,
        tenantSlug: input.tenantSlug,
        domainId: input.domainId,
        toolName: row.tool.name,
        definitionHash: row.definitionHash,
        configHash: cassetteConfigHash(row.config),
        allowedModes: ["live-probe"],
      }, { dataRoot });
      if (!verification.valid) throw new Error(verification.issues.join("; "));
      // `factory_tool_probes.status` is a searchable index, not signed proof.
      // Re-derive probe success from the HMAC-covered exchange so a stale or
      // corrupted `verified` row cannot bless a failed HTTP/schema response.
      if (
        document.entries.length !== 1
        || document.entries[0]!.response.status < 200
        || document.entries[0]!.response.status >= 300
      ) {
        throw new Error("production live probe did not record exactly one successful exchange");
      }
      const returnsSchema = row.tool.declarativeDefinition?.returnsSchema
        ?? row.tool.catalogDefinition?.returnsSchema;
      if (validateToolSchema(
        document.entries[0]!.response.body,
        returnsSchema as Record<string, unknown> | undefined,
      ).length) {
        throw new Error("production live probe response no longer matches the current return schema");
      }
    } catch {
      issues.push({ code: "production_cassette_invalid", ...base });
      continue;
    }
    const write = row.tool.operation === "write"
      || row.tool.operation === "read_write"
      || row.tool.sideEffect === "write"
      || row.tool.sideEffect === "dual";
    if (write) {
      const proof = document.evidence?.writeProbe;
      const proofIssues = completeWriteProbeProofIssues(proof);
      // Eight-hex legacy/FNV summaries remain readable for old sandbox
      // artifacts, but are too collision-prone to authorize a production
      // mutation. Every current write lifecycle emits SHA-256 identities.
      for (const value of [
        proof?.markerHash,
        proof?.namespaceHash,
        proof?.targetHash,
        proof?.idempotencyKeyHash,
      ]) {
        if (!/^[a-f0-9]{64}$/i.test(value ?? "")) {
          proofIssues.push("production write probe identities must use SHA-256");
          break;
        }
      }
      if (proof?.idempotencyKeyHash === UNVERIFIED_WRITE_PROBE_IDEMPOTENCY_HASH) {
        proofIssues.push("production write probe did not verify its declared idempotency key");
      }
      if (proofIssues.length) {
        issues.push({ code: "production_write_probe_incomplete", ...base });
      }
    }
  }
  return issues.sort((left, right) =>
    left.tool.localeCompare(right.tool)
    || left.code.localeCompare(right.code)
    || left.specSlugs.join("\u0000").localeCompare(right.specSlugs.join("\u0000")));
}
