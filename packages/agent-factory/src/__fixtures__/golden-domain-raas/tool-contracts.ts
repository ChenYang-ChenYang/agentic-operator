// Real argument/return contracts for the tools the generated RAAS agents bind.
//
// Transcribed from the actual tool sources so this package (which does not and
// should not depend on @agentic/tools or the tenant capability packs) can check
// wiring statically. Each entry names its source file — if a tool's contract
// changes, that file is where to reconcile.
//
// Three of these are TENANT tools registered by the agents-generation capability
// pack, not global registry entries; they resolve at dispatch through
// `tenantRegistry.tools[name] ?? globalToolRegistry.get(name)`.

export interface ToolContract {
  source: string;
  /** Argument names the handler actually reads, with required-ness. */
  args: Record<string, { required: boolean }>;
  /**
   * Result paths a plan may address, relative to the tool's return value.
   * A `resultMap` path outside this set cannot resolve at run time.
   */
  resultRoots: string[];
}

export const TOOL_CONTRACTS: Record<string, ToolContract> = {
  // ── tenant capability pack (@agentic/recruitment-capabilities) ───────────
  "facts.query": {
    source: "packages/recruitment-capabilities/src/tools/raas-facts.ts",
    args: { operation: { required: true } },
    // handler returns { data: {operation,row_count,rows,source}, meta }
    resultRoots: [
      "data.operation",
      "data.row_count",
      "data.rows",
      "data.source",
      "meta",
    ],
  },
  "reasoning.evaluateRules": {
    source:
      "packages/recruitment-capabilities/src/tools/reasoning-rule-engine.ts",
    args: { subject: { required: true } },
    // handler returns { data: {rule_decision,rule_results,rule_bundle_id,...}, meta }
    resultRoots: [
      "data.reasoning_rule_engine",
      "data.rule_decision",
      "data.rule_bundle_id",
      "data.rule_count",
      "data.rule_results",
      "meta",
    ],
  },
  "entities.write": {
    source: "packages/recruitment-capabilities/src/tools/raas-write.ts",
    args: { entity: { required: true }, values: { required: true } },
    resultRoots: ["data", "meta"],
  },

  // ── global registry (packages/tools/src/registry.ts) ─────────────────────
  "fs.readFromInbox": {
    source: "packages/tools/src/fs/read-from-inbox.ts",
    // `subdir` is CONFIG, not an argument — passing it as an argument is a
    // wiring error, and there is no bucket/object-key addressing at all.
    args: { filename: { required: true } },
    resultRoots: ["filename", "mime", "base64", "sha256", "bytes", "path"],
  },
  "ontology.writeInstance": {
    source: "packages/tools/src/ontology/write-instance.ts",
    args: { objectType: { required: true }, values: { required: true } },
    resultRoots: ["data", "meta"],
  },
  "ontology.fetchActionRules": {
    source: "packages/tools/src/ontology/fetch-action-rules.ts",
    args: { action: { required: true } },
    resultRoots: ["rules", "data", "meta"],
  },
};

/** Tools whose invocation costs money or touches a real external system. */
export const PAID_OR_EXTERNAL_TOOLS = new Set([
  "parseResumeApi",
  "gohireParseResumeApi",
  "generateJdApi",
  "matchResumeApi",
  "gohireMatchResumeApi",
  "inviteCandidateApi",
  "gohireInviteCandidateApi",
]);

/**
 * Fields that carry the client's real identity. Rule 4-2 of the Agents-generation
 * Ontology forbids these from reaching a JD-generation vendor; the real
 * production agent substitutes an anonymised descriptor.
 */
export const CLIENT_IDENTITY_FIELDS = [
  "sd_org_name",
  "client_name",
  "company_name",
  "org_name",
  "customer_name",
];
