// Durable HITL mailbox. Messages injected through POST /v1/agent-factory/inject
// must survive an API restart: acknowledging an in-memory-only queue as "saved
// for next continue" was a false-success path.  The single-process Factory
// driver still drains synchronously, but every enqueue/drain is first committed
// through an atomic, fsynced sidecar under AGENTIC_DATA_ROOT.

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { FactoryHumanInteractionKind } from "@agentic/agent-factory";

interface QueuedMsg {
  text: string;
  ts: number;
  /** Authenticated request actor captured at ingress. */
  actor?: string;
  interactionId?: string;
  gateKind?: FactoryHumanInteractionKind;
  /** Server-owned idempotency key for an ordinary durable continuation. */
  deliveryKey?: string;
}

interface Box {
  msgs: QueuedMsg[];
  /** Tenant that owns this conversation. */
  tenantId?: string;
  /** At-least-once lease. It remains deliverable until the conductor explicitly acks it. */
  inflight?: {
    deliveryId: string;
    ownerBootId: string;
    deliveredAt: number;
    msgs: QueuedMsg[];
  };
  /** Makes a retried acknowledgement idempotent after the inflight batch was cleared. */
  lastAckedDeliveryId?: string;
}

interface StoredBox {
  schema: 1 | 2 | 3 | 4 | 5;
  conversationId: string;
  tenantId: string | null;
  msgs: QueuedMsg[];
  /** `deliveryId` is optional only while reading legacy schema-2 sidecars. */
  inflight?: {
    deliveryId?: string;
    ownerBootId: string;
    deliveredAt: number;
    msgs: QueuedMsg[];
  };
  lastAckedDeliveryId?: string;
}

const boxes = new Map<string, Box>();

/** Per-conversation queue cap — far above real usage; guards inject spam. */
const MAX_QUEUE = 200;
const BOOT_ID = randomUUID();

function dataRoot(): string {
  const root = process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
  return path.isAbsolute(root) ? root : path.resolve(process.cwd(), root);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function ownerKey(tenantId?: string): string {
  return tenantId ? `tenant-${digest(tenantId).slice(0, 24)}` : "unscoped";
}

function cacheKey(conversationId: string, tenantId?: string): string {
  return `${tenantId ?? ""}\u0000${conversationId}`;
}

function mailboxDir(tenantId?: string): string {
  return path.join(dataRoot(), "factory-mailboxes", ownerKey(tenantId));
}

function mailboxFile(conversationId: string, tenantId?: string): string {
  return path.join(mailboxDir(tenantId), `${digest(conversationId)}.json`);
}

function validMessages(value: unknown): value is QueuedMsg[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as QueuedMsg).text === "string" &&
        Number.isFinite((entry as QueuedMsg).ts) &&
        ((entry as QueuedMsg).actor === undefined ||
          typeof (entry as QueuedMsg).actor === "string") &&
        ((entry as QueuedMsg).interactionId === undefined ||
          typeof (entry as QueuedMsg).interactionId === "string") &&
        ((entry as QueuedMsg).gateKind === undefined ||
          ["clarify", "test_approval", "boundary"].includes(
            String((entry as QueuedMsg).gateKind),
          )) &&
        ((entry as QueuedMsg).deliveryKey === undefined ||
          (typeof (entry as QueuedMsg).deliveryKey === "string" &&
            (entry as QueuedMsg).deliveryKey!.length > 0)) &&
        ((entry as QueuedMsg).interactionId === undefined) ===
          ((entry as QueuedMsg).gateKind === undefined),
    )
  );
}

function loadBox(conversationId: string, tenantId?: string): Box {
  const key = cacheKey(conversationId, tenantId);
  const cached = boxes.get(key);
  if (cached) return cached;
  const file = mailboxFile(conversationId, tenantId);
  let parsed: StoredBox;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StoredBox;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const empty: Box = { msgs: [], ...(tenantId ? { tenantId } : {}) };
      boxes.set(key, empty);
      return empty;
    }
    throw new Error(`cannot read durable factory mailbox ${conversationId}`, {
      cause: error,
    });
  }
  if (
    (parsed?.schema !== 1 &&
      parsed?.schema !== 2 &&
      parsed?.schema !== 3 &&
      parsed?.schema !== 4 &&
      parsed?.schema !== 5) ||
    parsed.conversationId !== conversationId ||
    parsed.tenantId !== (tenantId ?? null) ||
    !validMessages(parsed.msgs) ||
    (parsed.inflight != null &&
      (typeof parsed.inflight.ownerBootId !== "string" ||
        !Number.isFinite(parsed.inflight.deliveredAt) ||
        !validMessages(parsed.inflight.msgs) ||
        ((parsed.schema === 3 || parsed.schema === 4 || parsed.schema === 5) &&
          typeof parsed.inflight.deliveryId !== "string"))) ||
    (parsed.lastAckedDeliveryId !== undefined &&
      typeof parsed.lastAckedDeliveryId !== "string")
  ) {
    throw new Error(
      `durable factory mailbox ${conversationId} failed identity/schema validation`,
    );
  }
  const box: Box = {
    msgs: parsed.msgs,
    ...(parsed.inflight
      ? {
          inflight: {
            deliveryId: parsed.inflight.deliveryId ?? randomUUID(),
            ownerBootId: parsed.inflight.ownerBootId,
            deliveredAt: parsed.inflight.deliveredAt,
            msgs: parsed.inflight.msgs,
          },
        }
      : {}),
    ...(parsed.lastAckedDeliveryId
      ? { lastAckedDeliveryId: parsed.lastAckedDeliveryId }
      : {}),
    ...(tenantId ? { tenantId } : {}),
  };
  boxes.set(key, box);
  // Upgrade legacy sidecars before returning a generated delivery id. Otherwise a
  // second restart could assign another id and defeat conductor-side de-duplication.
  if (parsed.schema !== 5) persistBox(conversationId, tenantId, box);
  return box;
}

function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function persistBox(
  conversationId: string,
  tenantId: string | undefined,
  box: Box,
): void {
  const dir = mailboxDir(tenantId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = mailboxFile(conversationId, tenantId);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const document: StoredBox = {
    schema: 5,
    conversationId,
    tenantId: tenantId ?? null,
    msgs: box.msgs,
    ...(box.inflight ? { inflight: box.inflight } : {}),
    ...(box.lastAckedDeliveryId
      ? { lastAckedDeliveryId: box.lastAckedDeliveryId }
      : {}),
  };
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(document)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    syncDirectory(dir);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* original failure is authoritative */
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError(
          [error, cleanupError],
          `cannot persist durable factory mailbox ${conversationId}`,
        );
      }
    }
    throw error;
  }
}

function recoverInterruptedDelivery(
  conversationId: string,
  tenantId: string | undefined,
  current: Box,
): Box {
  if (!current.inflight || current.inflight.ownerBootId === BOOT_ID)
    return current;
  // Keep the SAME delivery id across a process restart. The durable conversation
  // checkpoint may already contain this batch while its ack was interrupted; a
  // stable id lets the conductor recognize that case without duplicating it.
  const recovered: Box = {
    msgs: current.msgs,
    inflight: {
      ...current.inflight,
      ownerBootId: BOOT_ID,
      deliveredAt: Date.now(),
    },
    ...(current.lastAckedDeliveryId
      ? { lastAckedDeliveryId: current.lastAckedDeliveryId }
      : {}),
    ...(tenantId ? { tenantId } : {}),
  };
  persistBox(conversationId, tenantId, recovered);
  boxes.set(cacheKey(conversationId, tenantId), recovered);
  return recovered;
}

export type HumanMessageEnqueueResult =
  | "queued"
  | "duplicate_interaction"
  | "rejected";

export function enqueueHumanMessage(
  conversationId: string,
  text: string,
  tenantId?: string,
  actor?: string,
  interaction?: {
    interactionId: string;
    gateKind: FactoryHumanInteractionKind;
  },
  delivery?: { deliveryKey: string },
): HumanMessageEnqueueResult {
  if (!conversationId || !text.trim()) return "rejected";
  if (
    interaction &&
    (!interaction.interactionId.trim() ||
      !["clarify", "test_approval", "boundary"].includes(interaction.gateKind))
  ) {
    return "rejected";
  }
  if (delivery && !delivery.deliveryKey.trim()) return "rejected";
  const current = recoverInterruptedDelivery(
    conversationId,
    tenantId,
    loadBox(conversationId, tenantId),
  );
  if (tenantId && current.tenantId && current.tenantId !== tenantId)
    return "rejected";
  if (interaction) {
    const alreadyQueued = [
      ...(current.inflight?.msgs ?? []),
      ...current.msgs,
    ].some((message) => message.interactionId === interaction.interactionId);
    if (alreadyQueued) return "duplicate_interaction";
  }
  if (delivery) {
    const alreadyQueued = [
      ...(current.inflight?.msgs ?? []),
      ...current.msgs,
    ].some((message) => message.deliveryKey === delivery.deliveryKey);
    if (alreadyQueued) return "duplicate_interaction";
  }
  // Validate with trim, but retain the exact payload. Factory continuations can
  // carry full source/attachment text where indentation is data.
  const next: Box = {
    msgs: [
      ...current.msgs,
      {
        text,
        ts: Date.now(),
        ...(actor?.trim() ? { actor: actor.trim() } : {}),
        ...(interaction
          ? {
              interactionId: interaction.interactionId,
              gateKind: interaction.gateKind,
            }
          : {}),
        ...(delivery ? { deliveryKey: delivery.deliveryKey } : {}),
      },
    ].slice(-MAX_QUEUE),
    ...(current.inflight ? { inflight: current.inflight } : {}),
    ...(current.lastAckedDeliveryId
      ? { lastAckedDeliveryId: current.lastAckedDeliveryId }
      : {}),
    ...(tenantId ? { tenantId } : {}),
  };
  persistBox(conversationId, tenantId, next);
  boxes.set(cacheKey(conversationId, tenantId), next);
  return "queued";
}

export function pushHumanMessage(
  conversationId: string,
  text: string,
  tenantId?: string,
  actor?: string,
): boolean {
  return (
    enqueueHumanMessage(conversationId, text, tenantId, actor) === "queued"
  );
}

export function drainHumanMessages(
  conversationId: string,
  tenantId?: string,
): Array<{
  text: string;
  actor?: string;
  receivedAt: number;
  deliveryId: string;
  interactionId?: string;
  gateKind?: FactoryHumanInteractionKind;
}> {
  const current = recoverInterruptedDelivery(
    conversationId,
    tenantId,
    loadBox(conversationId, tenantId),
  );
  if (tenantId && current.tenantId && current.tenantId !== tenantId) return [];
  if (current.inflight) {
    // Redelivery is intentional. A caller crash/throw after drain but before a
    // durable conversation checkpoint must not turn the next drain into an ack.
    return current.inflight.msgs.map((message) => ({
      text: message.text,
      ...(message.actor ? { actor: message.actor } : {}),
      ...(message.interactionId
        ? { interactionId: message.interactionId, gateKind: message.gateKind }
        : {}),
      receivedAt: message.ts,
      deliveryId: current.inflight!.deliveryId,
    }));
  }
  if (!current.msgs.length) return [];
  const deliveryId = randomUUID();
  const messages = current.msgs.map((message) => ({
    text: message.text,
    ...(message.actor ? { actor: message.actor } : {}),
    ...(message.interactionId
      ? { interactionId: message.interactionId, gateKind: message.gateKind }
      : {}),
    receivedAt: message.ts,
    deliveryId,
  }));
  const leased: Box = {
    msgs: [],
    inflight: {
      deliveryId,
      ownerBootId: BOOT_ID,
      deliveredAt: Date.now(),
      msgs: current.msgs,
    },
    ...(current.lastAckedDeliveryId
      ? { lastAckedDeliveryId: current.lastAckedDeliveryId }
      : {}),
    ...(tenantId ? { tenantId } : {}),
  };
  // Commit the lease before returning messages to the conductor. If storage
  // is unavailable, throw and leave the cached queue intact.
  persistBox(conversationId, tenantId, leased);
  boxes.set(cacheKey(conversationId, tenantId), leased);
  return messages;
}

/**
 * Acknowledge one exact leased delivery after its effects are represented in a
 * durable conversation checkpoint. The last id is retained so an ack retry is
 * idempotent; a stale/wrong id can never clear another batch.
 */
export function ackHumanMessages(
  conversationId: string,
  deliveryId: string,
  tenantId?: string,
): boolean {
  if (!conversationId || !deliveryId) return false;
  const current = recoverInterruptedDelivery(
    conversationId,
    tenantId,
    loadBox(conversationId, tenantId),
  );
  if (tenantId && current.tenantId && current.tenantId !== tenantId)
    return false;
  if (!current.inflight) return current.lastAckedDeliveryId === deliveryId;
  if (current.inflight.deliveryId !== deliveryId) return false;
  const acknowledged: Box = {
    msgs: current.msgs,
    lastAckedDeliveryId: deliveryId,
    ...(tenantId ? { tenantId } : {}),
  };
  persistBox(conversationId, tenantId, acknowledged);
  boxes.set(cacheKey(conversationId, tenantId), acknowledged);
  return true;
}

/** Return an exact leased batch to the head of the queue after a failed checkpoint. */
export function nackHumanMessages(
  conversationId: string,
  deliveryId: string,
  tenantId?: string,
): boolean {
  if (!conversationId || !deliveryId) return false;
  const current = recoverInterruptedDelivery(
    conversationId,
    tenantId,
    loadBox(conversationId, tenantId),
  );
  if (tenantId && current.tenantId && current.tenantId !== tenantId)
    return false;
  if (!current.inflight || current.inflight.deliveryId !== deliveryId)
    return false;
  const requeued: Box = {
    // Never cap during recovery: every item here was already accepted durably.
    msgs: [...current.inflight.msgs, ...current.msgs],
    ...(current.lastAckedDeliveryId
      ? { lastAckedDeliveryId: current.lastAckedDeliveryId }
      : {}),
    ...(tenantId ? { tenantId } : {}),
  };
  persistBox(conversationId, tenantId, requeued);
  boxes.set(cacheKey(conversationId, tenantId), requeued);
  return true;
}

/** Non-consuming look at the queue. */
export function peekHumanMessages(
  conversationId: string,
  tenantId?: string,
): { pending: number; oldestTs: number | null } {
  const box = recoverInterruptedDelivery(
    conversationId,
    tenantId,
    loadBox(conversationId, tenantId),
  );
  if (tenantId && box.tenantId && box.tenantId !== tenantId)
    return { pending: 0, oldestTs: null };
  const pending = [...(box.inflight?.msgs ?? []), ...box.msgs];
  if (!pending.length) return { pending: 0, oldestTs: null };
  return {
    pending: pending.length,
    oldestTs: Math.min(...pending.map((message) => message.ts)),
  };
}

/** Non-consuming proof that the exact persisted human gate already has an
 * accepted answer. Generic chat or an answer for another interaction must not
 * wake this gate during crash recovery. */
export function hasPendingHumanInteraction(
  conversationId: string,
  interactionId: string,
  gateKind: FactoryHumanInteractionKind,
  tenantId?: string,
): boolean {
  if (!conversationId || !interactionId) return false;
  const box = recoverInterruptedDelivery(
    conversationId,
    tenantId,
    loadBox(conversationId, tenantId),
  );
  if (tenantId && box.tenantId && box.tenantId !== tenantId) return false;
  return [...(box.inflight?.msgs ?? []), ...box.msgs].some(
    (message) =>
      message.interactionId === interactionId && message.gateKind === gateKind,
  );
}

/** Test/maintenance cleanup. Production run history does not call this. */
export function disposeMailbox(
  conversationId: string,
  tenantId?: string,
): void {
  boxes.delete(cacheKey(conversationId, tenantId));
  const file = mailboxFile(conversationId, tenantId);
  try {
    fs.unlinkSync(file);
    syncDirectory(path.dirname(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
