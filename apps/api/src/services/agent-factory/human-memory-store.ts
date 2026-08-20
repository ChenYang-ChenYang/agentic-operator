import {
  and,
  desc,
  eq,
  factoryHumanMemories,
  getDb,
} from "@agentic/db";
import { randomUUID } from "node:crypto";
import type {
  FactoryHumanMemory,
  FactoryHumanMemoryKind,
  FactoryHumanMemoryStore,
} from "@agentic/agent-factory";
import {
  isStopIntent,
  isTestCaseDecisionTaggedMessage,
  parseTestCaseDecision,
} from "@agentic/agent-factory";

const KINDS = new Set<FactoryHumanMemoryKind>([
  "clarify",
  "boundary",
  "test_approval",
  "directive",
]);

const iso = (value: Date | string | number): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export interface InjectedHumanMemoryCandidate {
  kind: Extract<FactoryHumanMemoryKind, "clarify" | "boundary" | "test_approval" | "directive">;
  question: string;
  answer: string;
  context?: string;
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/**
 * Classify an injected mailbox message against the durable gate snapshot.
 *
 * This is deliberately stricter than "save every chat message": only an
 * answer that the conductor itself can consume as the currently-open gate is
 * durable business knowledge.  Wrong-gate tags, malformed boundary JSON,
 * arbitrary chatter at an approval gate, and STOP commands return null.
 * The conductor keeps its own idempotent write as the race-safe fallback when
 * a gate was opened but its checkpoint was not yet visible to the API route.
 */
export function humanMemoryFromInjectedMessage(
  ctx: Record<string, unknown>,
  injectedText: string,
): InjectedHumanMemoryCandidate | null {
  const text = injectedText.trim();
  if (!text || isStopIntent(text)) return null;

  const approvalTag = isTestCaseDecisionTaggedMessage;
  const boundaryTag = /^\[边界事件决策\]/;
  const clarifyTag = /^\[澄清回答\]/;

  // Mirrors conductor ordering: an approval gate gets first refusal over an
  // untagged short reply such as "执行".
  if (ctx.awaitingApproval === true && !boundaryTag.test(text) && !clarifyTag.test(text)) {
    const parsedDecision = parseTestCaseDecision(text);
    if (parsedDecision) {
      const ids = Array.isArray(ctx.testCases)
        ? ctx.testCases
            .map(asObject)
            .map((entry) => typeof entry?.id === "string" ? entry.id : "")
            .filter(Boolean)
            .join(",")
        : "";
      return {
        kind: parsedDecision.decision === "supply_data" ? "directive" : "test_approval",
        question: parsedDecision.decision === "supply_data"
          ? `为测试用例集 ${ids || "current-suite"} 补数据`
          : `是否执行测试用例集 ${ids || "current-suite"}？`,
        answer: text,
        context: `decision=${parsedDecision.decision}${parsedDecision.note ? `; note=${parsedDecision.note}` : ""}`,
      };
    }
    // An arbitrary intervention is not an approval and must not fall through
    // into a simultaneously stale clarification flag.
    if (!approvalTag(text)) return null;
  }

  if (ctx.awaitingBoundary === true) {
    if (boundaryTag.test(text)) {
      const match = text.match(/^\[边界事件决策\]\s*([\s\S]+)$/);
      if (!match) return null;
      try {
        const raw = JSON.parse(match[1]!.trim()) as unknown;
        if (!Array.isArray(raw)) return null;
        const decided = raw
          .map(asObject)
          .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry.event === "string")
          .map((entry) => ({
            event: String(entry.event),
            kind: ["external", "terminal", "break"].includes(String(entry.kind)) ? String(entry.kind) : "external",
            ...(typeof entry.consumer === "string" ? { consumer: entry.consumer } : {}),
            ...(typeof entry.payloadContract === "string" ? { payloadContract: entry.payloadContract } : {}),
            ...(typeof entry.note === "string" ? { note: entry.note } : {}),
          }));
        return {
          kind: "boundary",
          question: `边界事件分类：${decided.map((entry) => entry.event).sort().join(",")}`,
          answer: text,
          context: JSON.stringify(decided),
        };
      } catch {
        return null;
      }
    }
    // The boundary gate consumes arbitrary untagged intervention text.  A
    // clarification tag alone is re-queued for the later clarification gate.
    if (!clarifyTag.test(text)) return null;
  }

  if (ctx.awaitingClarify === true) {
    // Tagged messages for other gates are re-queued by the conductor, never
    // interpreted as free-form clarification answers.
    if (approvalTag(text) || boundaryTag.test(text)) return null;
    const prompt = asObject(ctx.clarifyPrompt);
    const question = typeof prompt?.question === "string" ? prompt.question.trim() : "";
    if (!question) return null;
    const promptContext = typeof prompt?.context === "string" ? prompt.context.trim() : "";
    // Authorization is a one-shot DB challenge, never reusable domain memory.
    // Match any protocol version so an upgrade cannot accidentally persist an
    // older/newer token as a durable human fact.
    if (/^(?:probe|integration_profile|sandbox_evidence_plan|sandbox_design_review)_authorization:v\d+:/i.test(promptContext)) return null;
    const tagged = text.match(/^\[澄清回答\]\s*([\s\S]+)$/);
    const answer = (tagged?.[1] ?? text).trim();
    if (!answer) return null;
    return {
      kind: "clarify",
      question,
      answer,
      ...(promptContext
        ? { context: promptContext }
        : {}),
    };
  }

  return null;
}

/** Do not turn the memory table into a credential vault.  Non-secret human
 * wording stays byte-for-byte unchanged (apart from surrounding trim), while
 * common credential forms are replaced before persistence or API echo. */
export function redactHumanMemorySecrets(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]{8,}/gi, "$1 [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{12,})\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie|credential)\s*[:=：]\s*)([^\s,;\n]+)/gi, "$1[REDACTED]");
}

function bounded(value: string | undefined, label: string, max: number, required = true): string | undefined {
  const text = value?.trim();
  if (required && !text) throw new Error(`${label} is required`);
  if (text && text.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return text || undefined;
}

function mapRow(row: typeof factoryHumanMemories.$inferSelect): FactoryHumanMemory {
  if (row.source !== "human" || !KINDS.has(row.kind)) {
    throw new Error(`invalid factory human memory provenance for ${row.id}`);
  }
  return {
    id: row.id,
    domain: row.domain,
    questionKey: row.questionKey,
    kind: row.kind,
    question: row.question,
    answer: row.answer,
    context: row.context ?? undefined,
    source: "human",
    conversationId: row.conversationId ?? undefined,
    confirmed: row.confirmed,
    pinned: row.pinned,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** Tenant + ontology exact store.  There is no unscoped/shared mode for
 * human decisions: a fact confirmed for one customer's domain must never
 * leak into another customer or a similarly named ontology. */
export class DrizzleHumanMemoryStore implements FactoryHumanMemoryStore {
  constructor(
    private readonly tenantId: string,
    private readonly expectedDomain: string,
  ) {
    if (!tenantId || !expectedDomain) throw new Error("human memory requires tenant and ontology domain scope");
  }

  private assertDomain(domain: string): void {
    if (domain !== this.expectedDomain) {
      throw new Error(`human memory domain mismatch: expected ${this.expectedDomain}, got ${domain}`);
    }
  }

  async list(
    domain: string,
    opts: { confirmedOnly?: boolean; pinnedOnly?: boolean; limit?: number } = {},
  ): Promise<FactoryHumanMemory[]> {
    this.assertDomain(domain);
    const clauses = [
      eq(factoryHumanMemories.tenantId, this.tenantId),
      eq(factoryHumanMemories.domain, domain),
    ];
    if (opts.confirmedOnly) clauses.push(eq(factoryHumanMemories.confirmed, true));
    if (opts.pinnedOnly) clauses.push(eq(factoryHumanMemories.pinned, true));
    const limit = Math.min(200, Math.max(1, Math.trunc(opts.limit ?? 100)));
    return getDb()
      .select()
      .from(factoryHumanMemories)
      .where(and(...clauses))
      .orderBy(desc(factoryHumanMemories.pinned), desc(factoryHumanMemories.updatedAt))
      .limit(limit)
      .all()
      .map(mapRow);
  }

  async upsert(
    domain: string,
    input: {
      questionKey: string;
      kind: FactoryHumanMemoryKind;
      question: string;
      answer: string;
      context?: string;
      source: "human";
      conversationId?: string;
      confirmed?: boolean;
      pinned?: boolean;
    },
  ): Promise<FactoryHumanMemory> {
    this.assertDomain(domain);
    // Runtime guard is intentional: callers crossing a JSON/JS boundary can
    // bypass the TypeScript literal type.  AI output is never provenance.
    if ((input as { source?: unknown }).source !== "human") {
      throw new Error("factory human memory can only be written from a human-confirmed path");
    }
    if (!KINDS.has(input.kind)) throw new Error("invalid human memory kind");
    const questionKey = bounded(input.questionKey, "questionKey", 160)!;
    if (/[^\x20-\x7e]/.test(questionKey)) throw new Error("questionKey must contain printable ASCII only");
    const question = bounded(input.question, "question", 2_000)!;
    const answer = redactHumanMemorySecrets(bounded(input.answer, "answer", 12_000)!);
    const rawContext = bounded(input.context, "context", 4_000, false);
    const context = rawContext ? redactHumanMemorySecrets(rawContext) : undefined;
    const conversationId = bounded(input.conversationId, "conversationId", 160, false);
    const db = getDb();
    const existing = db
      .select()
      .from(factoryHumanMemories)
      .where(and(
        eq(factoryHumanMemories.tenantId, this.tenantId),
        eq(factoryHumanMemories.domain, domain),
        eq(factoryHumanMemories.questionKey, questionKey),
      ))
      .all()[0];
    if (existing && existing.source !== "human") {
      throw new Error("non-human memory cannot overwrite a human memory key");
    }
    const now = new Date();
    const id = existing?.id ?? `fhm-${randomUUID()}`;
    const values = {
      tenantId: this.tenantId,
      domain,
      questionKey,
      kind: input.kind,
      question,
      answer,
      context: context ?? null,
      source: "human" as const,
      conversationId: conversationId ?? null,
      confirmed: input.confirmed ?? true,
      // Omission never unpins an existing record.  Only the explicit pin API
      // or an explicit human `pinned:false` can do that.
      pinned: input.pinned ?? existing?.pinned ?? false,
      updatedAt: now,
    };
    db.insert(factoryHumanMemories)
      .values({ id, ...values, createdAt: existing?.createdAt ?? now })
      .onConflictDoUpdate({
        target: [
          factoryHumanMemories.tenantId,
          factoryHumanMemories.domain,
          factoryHumanMemories.questionKey,
        ],
        set: values,
      })
      .run();
    const row = db.select().from(factoryHumanMemories).where(eq(factoryHumanMemories.id, id)).all()[0];
    if (!row) throw new Error("human memory upsert did not persist");
    return mapRow(row);
  }

  async pin(domain: string, id: string, pinned: boolean): Promise<boolean> {
    this.assertDomain(domain);
    const result = getDb().update(factoryHumanMemories)
      .set({ pinned, updatedAt: new Date() })
      .where(and(
        eq(factoryHumanMemories.id, id),
        eq(factoryHumanMemories.tenantId, this.tenantId),
        eq(factoryHumanMemories.domain, domain),
        eq(factoryHumanMemories.source, "human"),
      ))
      .run() as { changes?: number };
    return (result.changes ?? 0) === 1;
  }

  /** Correct a human teaching without changing its stable semantic question
   * key/provenance.  `undefined` preserves a field; `context:null` explicitly
   * clears it. */
  async edit(
    domain: string,
    id: string,
    input: { answer?: string; context?: string | null; pinned?: boolean },
  ): Promise<FactoryHumanMemory | null> {
    this.assertDomain(domain);
    const db = getDb();
    const where = and(
      eq(factoryHumanMemories.id, id),
      eq(factoryHumanMemories.tenantId, this.tenantId),
      eq(factoryHumanMemories.domain, domain),
      eq(factoryHumanMemories.source, "human"),
    );
    const existing = db.select().from(factoryHumanMemories).where(where).all()[0];
    if (!existing) return null;
    const set: Partial<typeof factoryHumanMemories.$inferInsert> = { updatedAt: new Date() };
    if (input.answer !== undefined) {
      set.answer = redactHumanMemorySecrets(bounded(input.answer, "answer", 12_000)!);
    }
    if (input.context !== undefined) {
      const raw = input.context == null ? undefined : bounded(input.context, "context", 4_000, false);
      set.context = raw ? redactHumanMemorySecrets(raw) : null;
    }
    if (input.pinned !== undefined) set.pinned = input.pinned;
    db.update(factoryHumanMemories).set(set).where(where).run();
    const row = db.select().from(factoryHumanMemories).where(where).all()[0];
    return row ? mapRow(row) : null;
  }

  async del(domain: string, id: string): Promise<boolean> {
    this.assertDomain(domain);
    const result = getDb().delete(factoryHumanMemories)
      .where(and(
        eq(factoryHumanMemories.id, id),
        eq(factoryHumanMemories.tenantId, this.tenantId),
        eq(factoryHumanMemories.domain, domain),
        eq(factoryHumanMemories.source, "human"),
      ))
      .run() as { changes?: number };
    return (result.changes ?? 0) === 1;
  }
}
