/**
 * comms.sendToAgent — durable agent-to-agent message (design §0 A2A + P4).
 *
 * WHY HTTP to the API's own POST /v1/events (and not an in-process emit):
 * durable event publication in this codebase is owned by two seams only —
 * (a) `step.sendEvent` inside an Inngest handler (packages/runtime/register.ts
 * finalize outbox), which a tool handler cannot reach because it executes
 * INSIDE a step.run body where introducing a nested Inngest send would break
 * the replay/durability discipline, and (b) apps/api's POST /v1/events ingest,
 * which persists the events row + event ledger + audit, honors Idempotency-Key
 * replay, verifies `targetAgent` against the LIVE manifest registry, and only
 * then enqueues to the tenant's Inngest app. `packages/tools` cannot import
 * the api's Inngest clients (dependency direction: apps/api → tools, never
 * the reverse), so the loopback HTTP call IS the cleanest existing seam: one
 * durable write path for operator-, webhook-, and now agent-originated events.
 *
 * Trust boundary: the model supplies {agent, event?, payload, subject?}; the
 * ORIGIN and CREDENTIAL come only from env vars named by trusted manifest
 * config (base_url_env, default AGENTIC_SELF_BASE_URL; api_key_env, default
 * AGENTIC_SELF_API_TOKEN — a tenant-scoped API token minted in Settings →
 * Tokens). Both fail closed when unset. Payload keys starting with "__" are
 * rejected by the ingest contract (reserved runtime metadata), so a model
 * cannot smuggle suppress/test flags.
 */

import { z } from "zod";
import { defineTool, type ToolContext } from "@agentic/agent-kit";

import { readEnvironmentReference } from "../config/env-ref";

type JsonRecord = Record<string, unknown>;

const DEFAULT_BASE_URL_ENV = "AGENTIC_SELF_BASE_URL";
const DEFAULT_API_KEY_ENV = "AGENTIC_SELF_API_TOKEN";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_DIAGNOSTIC_CHARS = 1_000;

export interface SendToAgentResult {
  eventId: string;
  name: string;
  agent: string;
  subject: string | null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`comms.sendToAgent: '${field}' must be a non-empty string`);
  }
  return value.trim();
}

/** Default event name for agents that are invoked point-to-point without a
 * declared business event — mirrors the ontology compiler's synthetic
 * MANUAL_<ACTION_ID_UPPER_SNAKE> trigger convention (design §G1.1). */
export function defaultEventNameForAgent(agent: string): string {
  return `MANUAL_${agent.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

export async function sendToAgent(
  input: JsonRecord,
  ctx: Pick<ToolContext, "subject" | "correlationId">,
  config: JsonRecord = {},
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<SendToAgentResult> {
  const agent = requiredString(input.agent, "agent");
  const event =
    input.event === undefined || input.event === null || input.event === ""
      ? defaultEventNameForAgent(agent)
      : requiredString(input.event, "event");
  const subject =
    input.subject === undefined || input.subject === null || input.subject === ""
      ? typeof ctx.subject === "string" && ctx.subject
        ? ctx.subject
        : undefined
      : requiredString(input.subject, "subject");
  const payload = input.payload ?? {};
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("comms.sendToAgent: 'payload' must be a JSON object");
  }

  const baseUrl = readEnvironmentReference(
    env,
    (config.base_url_env as string | undefined) ?? DEFAULT_BASE_URL_ENV,
    "comms.sendToAgent config.base_url_env",
  ).replace(/\/+$/, "");
  const apiKey = readEnvironmentReference(
    env,
    (config.api_key_env as string | undefined) ?? DEFAULT_API_KEY_ENV,
    "comms.sendToAgent config.api_key_env",
  );
  const timeoutMs =
    typeof config.timeout_ms === "number" &&
    Number.isSafeInteger(config.timeout_ms) &&
    config.timeout_ms > 0
      ? config.timeout_ms
      : DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  // Retries with the same correlation replay durably instead of duplicating:
  // POST /v1/events dedupes on (tenant, Idempotency-Key).
  const idempotencyKey =
    typeof input.idempotency_key === "string" && input.idempotency_key.trim()
      ? input.idempotency_key.trim()
      : `a2a-${ctx.correlationId}-${agent}-${event}-${subject ?? ""}`;
  headers["idempotency-key"] = idempotencyKey.slice(0, 200);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  let bodyText: string;
  try {
    response = await fetchImpl(`${baseUrl}/v1/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: event,
        ...(subject ? { subject } : {}),
        payload,
        source: "system",
        targetAgent: agent,
      }),
      signal: controller.signal,
    });
    bodyText = await response.text();
  } catch (cause) {
    throw new Error(
      `comms.sendToAgent: POST ${baseUrl}/v1/events failed (${(cause as Error).message})`,
      { cause },
    );
  } finally {
    clearTimeout(timer);
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    /* handled below */
  }
  if (!response.ok || parsed === null || typeof parsed !== "object") {
    throw new Error(
      `comms.sendToAgent: event ingest rejected (HTTP ${response.status}): ` +
        bodyText.slice(0, MAX_DIAGNOSTIC_CHARS),
    );
  }
  // Accept both the reply.ok envelope ({ok:true,data:{event_id,name}}) and a
  // bare IngestEventResponse for forward compatibility.
  const record = parsed as JsonRecord;
  const data = (record.data ?? record) as JsonRecord;
  const eventId = typeof data.event_id === "string" ? data.event_id : null;
  const name = typeof data.name === "string" ? data.name : event;
  if (!eventId) {
    throw new Error(
      "comms.sendToAgent: ingest response carried no event_id: " +
        bodyText.slice(0, MAX_DIAGNOSTIC_CHARS),
    );
  }
  return { eventId, name, agent, subject: subject ?? null };
}

export const commsSendToAgent = defineTool({
  name: "comms.sendToAgent",
  description:
    "Send a durable agent-to-agent message: publishes a tenant event through the " +
    "operator's own POST /v1/events ingest (persisted events row + ledger + audit + " +
    "idempotent broker enqueue) scoped to exactly one live target agent. " +
    "{agent} is the manifest agent name; {event} defaults to MANUAL_<AGENT>; {payload} " +
    "is the event body; {subject} defaults to the current run's subject.",
  output: z.object({
    eventId: z.string(),
    name: z.string(),
    agent: z.string(),
    subject: z.string().nullable(),
  }),
  async handler(ctx) {
    return {
      data: await sendToAgent(
        (ctx.event?.data ?? {}) as JsonRecord,
        ctx,
        (ctx.config ?? {}) as JsonRecord,
      ),
      meta: { transport: "loopback-http:/v1/events" },
    };
  },
});
