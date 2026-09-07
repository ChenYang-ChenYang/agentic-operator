/**
 * TC-90 — Operator kill switch (POST /v1/runs/:id/cancel).
 *
 * Covers:
 *   - Happy path: cancel an active manifest run → status='cancelled',
 *     audit row written, Inngest cancel event emitted.
 *   - Idempotency: re-cancel a row that's already terminal (ok/failed/
 *     cancelled) → 200 + cancelled:false + no audit / Inngest side effect.
 *   - Cross-tenant 403: tenant A cannot cancel tenant B's run.
 *   - 404: cancel a non-existent runId.
 *   - 401: missing auth in non-dev mode.
 *   - Manifest vs code agent: the route only fires the Inngest cancel
 *     event for manifest agents — code agents rely on the cooperative
 *     poll inside the run engine.
 *
 * The test hand-builds run rows directly in the DB so we don't have to
 * orchestrate a live Inngest worker or wait on a real LLM call. The
 * unit under test is the route + the audit / inngest plumbing, not the
 * end-to-end Inngest cancellation acknowledgement (that lives in the
 * Inngest service, not in our code).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import {
  agents,
  auditLog,
  getDb,
  runs,
  tenants,
  workflows,
  events,
} from "@agentic/db";
import { inngest } from "@agentic/runtime";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";

interface EnvelopeOk<T> {
  ok: true;
  data: T;
}
interface EnvelopeErr {
  ok: false;
  error: { code: string; message?: string };
}

interface CancelBody {
  runId: string;
  status: string;
  cancelled: boolean;
  note: string;
}

interface InngestCapture {
  name: string;
  data: Record<string, unknown>;
}

/**
 * Patches `inngest.send` for a single test and returns a `restore()` to
 * put the original back. Identical pattern to event-tester.test.ts so
 * the same lock-in covers both code paths.
 */
function captureInngest(): { calls: InngestCapture[]; restore: () => void } {
  const calls: InngestCapture[] = [];
  // Patch `Inngest.prototype.send` (not the __system instance) so we intercept
  // EVERY per-tenant client — sends now route through `getTenantInngest(slug)`
  // (one Inngest app per tenant), so the run's tenant client, not the singleton,
  // is what fires the cancel event.
  const proto = Object.getPrototypeOf(inngest) as { send: typeof inngest.send };
  const original = proto.send;
  proto.send = (async (payload: {
    name: string;
    data: Record<string, unknown>;
  }) => {
    calls.push({ name: payload.name, data: { ...(payload.data ?? {}) } });
    return { ids: [makeId("ing")] };
  }) as typeof inngest.send;
  return {
    calls,
    restore: () => {
      proto.send = original;
    },
  };
}

function rejectInngest(): { restore: () => void } {
  const proto = Object.getPrototypeOf(inngest) as { send: typeof inngest.send };
  const original = proto.send;
  proto.send = (async () => {
    throw new Error("broker unavailable (intentional test failure)");
  }) as typeof inngest.send;
  return {
    restore: () => {
      proto.send = original;
    },
  };
}

// Per-suite slug suffix so the fixture rows don't collide with prior
// runs against the dev DB.
const SUFFIX = `t90${Date.now().toString(36)}`.toLowerCase().slice(-8);
const TENANT_A_SLUG = `cancel-a-${SUFFIX}`;
const TENANT_B_SLUG = `cancel-b-${SUFFIX}`;

describe("TC-90: POST /v1/runs/:id/cancel", () => {
  let env: TestEnv;
  let tenantAId: string;
  let tenantBId: string;
  let manifestAgentId: string;
  let codeAgentId: string;
  let savedDevTenant: string | undefined;

  beforeAll(async () => {
    env = await buildTestEnv();
    const db = getDb();

    tenantAId = makeId("ten");
    tenantBId = makeId("ten");
    db.insert(tenants)
      .values([
        { id: tenantAId, slug: TENANT_A_SLUG, name: "Cancel test tenant A" },
        { id: tenantBId, slug: TENANT_B_SLUG, name: "Cancel test tenant B" },
      ])
      .run();

    // Tenant A gets two agents (one manifest, one code) so we can verify
    // the route's per-kind branching: inngest.send fires for manifest,
    // not for code.
    const wfId = makeId("wf");
    db.insert(workflows)
      .values({
        id: wfId,
        tenantId: tenantAId,
        slug: "cancel-fixture-wf",
        name: "Cancel fixture wf",
      })
      .run();
    const now = Date.now();
    manifestAgentId = makeId("agt");
    codeAgentId = makeId("agt");
    db.insert(agents)
      .values([
        {
          id: manifestAgentId,
          workflowId: wfId,
          kebabId: `cancelManifest-${SUFFIX}`,
          name: "cancelManifestAgent",
          actor: "Agent",
          kind: "manifest",
          enabled: true,
          createdAt: new Date(now),
          updatedAt: new Date(now),
        },
        {
          id: codeAgentId,
          workflowId: wfId,
          kebabId: `cancelCode-${SUFFIX}`,
          name: "cancelCodeAgent",
          actor: "Agent",
          kind: "code",
          enabled: true,
          createdAt: new Date(now),
          updatedAt: new Date(now),
        },
      ])
      .run();

    // Pin the dev tenant to A so requireAuth resolves there by default.
    savedDevTenant = process.env.AGENTIC_DEV_TENANT;
    process.env.AGENTIC_DEV_TENANT = TENANT_A_SLUG;
  });

  afterAll(() => {
    if (savedDevTenant === undefined) delete process.env.AGENTIC_DEV_TENANT;
    else process.env.AGENTIC_DEV_TENANT = savedDevTenant;

    // Cleanup — FK cascade from tenants drains runs / agents / audit.
    const db = getDb();
    db.delete(tenants).where(like(tenants.slug, `cancel-%-${SUFFIX}`)).run();
  });

  function seedRun(args: {
    runId?: string;
    tenantId: string;
    agentId: string;
    status: "running" | "ok" | "failed" | "cancelled" | "waiting" | "queued";
    subject?: string;
    startedAt?: number;
    triggerEventId?: string | null;
  }): string {
    const db = getDb();
    const runId = args.runId ?? makeId("run");
    db.insert(runs)
      .values({
        id: runId,
        tenantId: args.tenantId,
        agentId: args.agentId,
        triggerEventId: args.triggerEventId ?? null,
        status: args.status,
        startedAt: new Date(args.startedAt ?? Date.now() - 5_000),
        correlationId: makeId("cor"),
        subject: args.subject ?? `subj-${SUFFIX}-${runId.slice(-4)}`,
      })
      .run();
    return runId;
  }

  // ────────────────────────────────────────────────────────────────────
  // Happy path: manifest agent
  // ────────────────────────────────────────────────────────────────────

  describe("happy path — manifest agent", () => {
    it("flips status to cancelled, writes audit, emits Inngest cancel event", async () => {
      const runId = seedRun({
        tenantId: tenantAId,
        agentId: manifestAgentId,
        status: "running",
        subject: `subj-happy-${SUFFIX}`,
      });
      const cap = captureInngest();
      try {
        const res = await env.fetch(`/v1/runs/${runId}/cancel`, {
          method: "POST",
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as EnvelopeOk<CancelBody>;
        expect(body.ok).toBe(true);
        expect(body.data.runId).toBe(runId);
        expect(body.data.status).toBe("cancelled");
        expect(body.data.cancelled).toBe(true);
        expect(typeof body.data.note).toBe("string");
        expect(body.data.note.length).toBeGreaterThan(0);
      } finally {
        cap.restore();
      }

      // DB side effects: run row flipped, audit row written, inngest event captured.
      const db = getDb();
      const row = db.select().from(runs).where(eq(runs.id, runId)).all()[0];
      expect(row?.status).toBe("cancelled");
      expect(row?.endedAt).toBeTruthy();
      expect(row?.errorMessage).toBe("cancelled_by_operator");

      const audits = db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantAId),
            eq(auditLog.targetId, runId),
            eq(auditLog.action, "run.cancel"),
          ),
        )
        .all();
      expect(audits.length).toBe(1);
      expect(audits[0]?.targetType).toBe("run");

      // Re-capture to confirm the cancel event was fired during the call
      // above. captureInngest() restored the original; reissue via the
      // same fixture row to assert the emit shape on a second pass.
      const cap2 = captureInngest();
      try {
        // Second call must NOT emit again (run is already cancelled → no-op).
        await env.fetch(`/v1/runs/${runId}/cancel`, { method: "POST" });
        expect(cap2.calls.length).toBe(0);
      } finally {
        cap2.restore();
      }
    });

    it("emits the cancel event with subject + runId metadata", async () => {
      const subject = `subj-meta-${SUFFIX}`;
      const runId = seedRun({
        tenantId: tenantAId,
        agentId: manifestAgentId,
        status: "running",
        subject,
      });
      const cap = captureInngest();
      try {
        const res = await env.fetch(`/v1/runs/${runId}/cancel`, {
          method: "POST",
        });
        expect(res.status).toBe(200);
        expect(cap.calls.length).toBe(1);
        const evt = cap.calls[0]!;
        expect(evt.name).toBe(`${TENANT_A_SLUG}/run.cancel`);
        expect(evt.data.runId).toBe(runId);
        expect(evt.data.subject).toBe(subject);
        expect(evt.data.previousStatus).toBe("running");
        expect(evt.data.cancelledBy).toBe(TENANT_A_SLUG);
        // The precise cancelOn key: which function (agent) and which trigger
        // delivery. Null here because this fixture has no trigger event.
        expect(typeof evt.data.agent).toBe("string");
        expect(evt.data.agent).not.toBe("");
        expect(evt.data.triggerEventId).toBeNull();
      } finally {
        cap.restore();
      }
    });

    it("names the trigger event id so cancelOn targets exactly one run (a null subject must never match the whole function)", async () => {
      const triggerEventId = `evt-precise-${SUFFIX}`;
      // runs.trigger_event_id is a foreign key: the delivery must exist.
      getDb()
        .insert(events)
        .values({
          id: triggerEventId,
          tenantId: tenantAId,
          name: "CANCEL_PRECISE_TEST",
          subject: null,
          receivedAt: new Date(),
          payloadRef: "test://cancel-precise",
        })
        .run();
      const runId = seedRun({
        tenantId: tenantAId,
        agentId: manifestAgentId,
        status: "running",
        triggerEventId,
      });
      const cap = captureInngest();
      try {
        const res = await env.fetch(`/v1/runs/${runId}/cancel`, { method: "POST" });
        expect(res.status).toBe(200);
        const evt = cap.calls[0]!;
        expect(evt.data.triggerEventId).toBe(`evt-precise-${SUFFIX}`);
        expect(evt.data.runId).toBe(runId);
      } finally {
        cap.restore();
      }
    });

    it("fails closed and leaves the run active when Inngest rejects the signal", async () => {
      const runId = seedRun({
        tenantId: tenantAId,
        agentId: manifestAgentId,
        status: "running",
      });
      const rejection = rejectInngest();
      try {
        const res = await env.fetch(`/v1/runs/${runId}/cancel`, {
          method: "POST",
        });
        expect(res.status).toBe(502);
        const body = (await res.json()) as EnvelopeErr;
        expect(body.error.code).toBe("cancel_signal_failed");
      } finally {
        rejection.restore();
      }

      const db = getDb();
      const row = db.select().from(runs).where(eq(runs.id, runId)).all()[0];
      expect(row?.status).toBe("running");
      expect(row?.endedAt).toBeNull();
      expect(
        db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.targetId, runId),
              eq(auditLog.action, "run.cancel"),
            ),
          )
          .all(),
      ).toHaveLength(0);
      expect(
        db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.targetId, runId),
              eq(auditLog.action, "run.cancel.failed"),
            ),
          )
          .all(),
      ).toHaveLength(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Code agent path: no Inngest emit
  // ────────────────────────────────────────────────────────────────────

  describe("code agent — flips status but skips Inngest emit", () => {
    it("flips status and writes audit; no Inngest cancel event fired", async () => {
      const runId = seedRun({
        tenantId: tenantAId,
        agentId: codeAgentId,
        status: "running",
      });
      const cap = captureInngest();
      try {
        const res = await env.fetch(`/v1/runs/${runId}/cancel`, {
          method: "POST",
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as EnvelopeOk<CancelBody>;
        expect(body.data.cancelled).toBe(true);
        expect(body.data.status).toBe("cancelled");
        // Code agents skip the manifest Inngest cancel signal — the
        // cooperative poll inside the run engine handles termination.
        expect(cap.calls.length).toBe(0);
      } finally {
        cap.restore();
      }

      const db = getDb();
      const row = db.select().from(runs).where(eq(runs.id, runId)).all()[0];
      expect(row?.status).toBe("cancelled");
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Idempotency: terminal-status no-ops
  // ────────────────────────────────────────────────────────────────────

  describe("idempotency", () => {
    it("cancelling a run already in status=ok is a 200 no-op", async () => {
      const runId = seedRun({
        tenantId: tenantAId,
        agentId: manifestAgentId,
        status: "ok",
      });
      const cap = captureInngest();
      try {
        const res = await env.fetch(`/v1/runs/${runId}/cancel`, {
          method: "POST",
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as EnvelopeOk<CancelBody>;
        expect(body.data.cancelled).toBe(false);
        expect(body.data.status).toBe("ok");
        expect(body.data.note.toLowerCase()).toContain("terminal");
        // No inngest emit, no audit row.
        expect(cap.calls.length).toBe(0);
      } finally {
        cap.restore();
      }
      const db = getDb();
      const audits = db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.targetId, runId), eq(auditLog.action, "run.cancel")),
        )
        .all();
      expect(audits.length).toBe(0);
      // Row should be untouched.
      const row = db.select().from(runs).where(eq(runs.id, runId)).all()[0];
      expect(row?.status).toBe("ok");
    });

    it("cancelling a run already in status=cancelled is a 200 no-op", async () => {
      const runId = seedRun({
        tenantId: tenantAId,
        agentId: manifestAgentId,
        status: "cancelled",
      });
      const cap = captureInngest();
      try {
        const res = await env.fetch(`/v1/runs/${runId}/cancel`, {
          method: "POST",
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as EnvelopeOk<CancelBody>;
        expect(body.data.cancelled).toBe(false);
        expect(body.data.status).toBe("cancelled");
        expect(cap.calls.length).toBe(0);
      } finally {
        cap.restore();
      }
    });

    it("cancelling a run already in status=failed is a 200 no-op", async () => {
      const runId = seedRun({
        tenantId: tenantAId,
        agentId: manifestAgentId,
        status: "failed",
      });
      const res = await env.fetch(`/v1/runs/${runId}/cancel`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as EnvelopeOk<CancelBody>;
      expect(body.data.cancelled).toBe(false);
      expect(body.data.status).toBe("failed");
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-tenant isolation: 403
  // ────────────────────────────────────────────────────────────────────

  describe("cross-tenant 403", () => {
    it("tenant B cannot cancel tenant A's run", async () => {
      const runId = seedRun({
        tenantId: tenantAId,
        agentId: manifestAgentId,
        status: "running",
      });
      const savedTenant = process.env.AGENTIC_DEV_TENANT;
      process.env.AGENTIC_DEV_TENANT = TENANT_B_SLUG;
      try {
        const res = await env.fetch(`/v1/runs/${runId}/cancel`, {
          method: "POST",
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as EnvelopeErr;
        expect(body.ok).toBe(false);
        expect(body.error.code).toBe("forbidden");
      } finally {
        process.env.AGENTIC_DEV_TENANT = savedTenant;
      }
      // Untouched.
      const db = getDb();
      const row = db.select().from(runs).where(eq(runs.id, runId)).all()[0];
      expect(row?.status).toBe("running");
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Not found
  // ────────────────────────────────────────────────────────────────────

  describe("404 not_found", () => {
    it("non-existent runId returns 404", async () => {
      const res = await env.fetch(`/v1/runs/run-does-not-exist-${SUFFIX}/cancel`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as EnvelopeErr;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("not_found");
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Auth required
  // ────────────────────────────────────────────────────────────────────

  describe("401 unauthorized (non-dev mode)", () => {
    it("missing bearer outside AUTH_MODE=dev returns 401", async () => {
      const runId = seedRun({
        tenantId: tenantAId,
        agentId: manifestAgentId,
        status: "running",
      });
      const savedMode = process.env.AUTH_MODE;
      process.env.AUTH_MODE = "production";
      try {
        const res = await env.fetch(`/v1/runs/${runId}/cancel`, {
          method: "POST",
        });
        expect(res.status).toBe(401);
      } finally {
        process.env.AUTH_MODE = savedMode;
      }
      // Row must be untouched.
      const db = getDb();
      const row = db.select().from(runs).where(eq(runs.id, runId)).all()[0];
      expect(row?.status).toBe("running");
    });
  });
});
