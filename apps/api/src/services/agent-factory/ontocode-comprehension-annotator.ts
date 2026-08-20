// #ONTOCODE-COMPREHEND — the production annotator: the model pass that turns a
// batch of ontology declarations into anchored propositions.
//
// There is deliberately NO deterministic fallback. A "role" is a reading of what
// an entity does in a business, and a hand-rolled template that concatenates
// field names is not a reading — it is a restatement of the declaration the
// model was going to be shown anyway, wearing an understanding's clothes. If the
// gateway cannot run, `produceOntologyComprehension` records `batch_failed` with
// the real transport reason and the analysis proceeds with a smaller
// understanding.

import {
  buildComprehensionPrompt,
  chatJsonResult,
  type ComprehensionAnnotator,
  type ComprehensionAnnotatorResult,
  type OntologyComprehensionPack,
} from "@agentic/agent-factory";
import { getLLMGateway } from "../llm";
import {
  readLatestOntologyComprehension,
  readOntologyComprehension,
  writeOntologyComprehension,
} from "./ontocode-comprehension-store";

/** Model-visible instruction for the response shape. Exported so the vocabulary
 *  gate scans the exact text that is sent. */
export const ONTOLOGY_COMPREHENSION_RESPONSE_CONTRACT = [
  "只输出 JSON，形如：",
  '{"annotations":[{"id":"<实体 id，逐字照抄>","role":"<一句自洽的陈述>","dependsOn":["<本体里真实存在的实体 id>"]}]}',
  "每个给定实体各一条；不要增补没有给出的实体。",
].join("\n");

export function makeOntoCodeComprehensionAnnotator(identity: {
  tenantId?: string;
  tenantSlug?: string;
  signal?: AbortSignal;
}): ComprehensionAnnotator {
  return async (batch, context) => {
    const user = buildComprehensionPrompt({
      domainId: context.domainId,
      entities: batch,
      ...(context.attempt === 2 ? { rewriteCount: batch.length } : {}),
    });
    const result = await chatJsonResult<unknown>(
      ONTOLOGY_COMPREHENSION_RESPONSE_CONTRACT,
      user,
      {
        temperature: 0.2,
        maxTokens: 4_000,
        ...(identity.signal ? { signal: identity.signal } : {}),
        purpose: "ontocode.ontology_comprehension",
        callFn: async (system, prompt, callOptions) => {
          const response = await getLLMGateway().chat({
            tenantId: identity.tenantId,
            tenantSlug: identity.tenantSlug,
            purpose: callOptions.purpose ?? "ontocode.ontology_comprehension",
            routing: { taskType: "ontology.query" },
            jsonMode: true,
            temperature: callOptions.temperature,
            maxTokens: callOptions.maxTokens,
            signal: callOptions.signal,
            store: false,
            messages: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
          });
          if (
            response.provider === "mock" ||
            /(^|[\s/_-])mock([\s/_-]|$)/iu.test(response.model)
          ) {
            // Same bar as the analysis itself: a mock reading persisted as the
            // domain's understanding would be recalled later as real.
            throw new Error(
              "OntoCode 拒绝把 mock 模型的输出当作对本体的理解；请为该租户配置真实模型路由",
            );
          }
          return response.text;
        },
      },
    );
    if (!result.ok) {
      // The real failure reason travels; it is not flattened into one code.
      throw new Error(
        `理解本体的模型调用失败：${result.failure.kind}${
          "detail" in result.failure && result.failure.detail
            ? `（${String(result.failure.detail).slice(0, 200)}）`
            : ""
        }`,
      );
    }
    const value = result.value as { annotations?: unknown } | null;
    const rows = Array.isArray(value?.annotations) ? value.annotations : [];
    const parsed: ComprehensionAnnotatorResult[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const role = typeof record.role === "string" ? record.role.trim() : "";
      if (!id || !role) continue;
      parsed.push({
        id,
        role,
        dependsOn: Array.isArray(record.dependsOn)
          ? record.dependsOn.filter(
              (entry): entry is string =>
                typeof entry === "string" && entry.trim().length > 0,
            )
          : [],
      });
    }
    return parsed;
  };
}

/** The production seam handed to `analyzeOntology`: real store + real model. */
export function makeOntoCodeComprehensionSeam(identity: {
  tenantId?: string;
  tenantSlug?: string;
  signal?: AbortSignal;
}):
  | {
      read: (
        domain: string,
        ontologyHash: string,
      ) => Promise<OntologyComprehensionPack | null>;
      readLatest: (domain: string) => Promise<OntologyComprehensionPack | null>;
      write: (
        pack: OntologyComprehensionPack,
        sourceJobId: string | null,
      ) => Promise<void>;
      annotate: ComprehensionAnnotator;
    }
  | undefined {
  const tenantId = (identity.tenantId ?? "").trim();
  // No tenant ⇒ no partition. The layer stays off rather than writing into a
  // store it cannot scope, exactly as the long-term lane does.
  if (!tenantId) return undefined;
  const ctx = { tenantId };
  return {
    read: (domain, ontologyHash) =>
      readOntologyComprehension(ctx, domain, ontologyHash),
    readLatest: (domain) => readLatestOntologyComprehension(ctx, domain),
    write: (pack, sourceJobId) =>
      writeOntologyComprehension(ctx, pack, sourceJobId),
    annotate: makeOntoCodeComprehensionAnnotator(identity),
  };
}
