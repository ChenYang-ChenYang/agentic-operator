import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetTenantEventAdaptersForTests,
  bareTenantEventName,
  bootstrapTenant,
  commitTenantEventAdapter,
  registerAgent,
  registerCronTriggers,
  tenantEventName,
  tenantFunctionId,
} from "@agentic/runtime";
import type { TenantEventAdapter } from "@agentic/agent-kit";
import { zhaopinLegacyRaasEventAdapter } from "@tenants/zhaopin";

afterEach(() => {
  __resetTenantEventAdaptersForTests();
});

describe("tenantEventName", () => {
  it("namespaces normal tenants", () => {
    expect(tenantEventName("zhaopin", "RESUME_DOWNLOADED")).toBe(
      "zhaopin/RESUME_DOWNLOADED",
    );
    expect(tenantEventName("zhaopin", "zhaopin/RESUME_DOWNLOADED")).toBe(
      "zhaopin/RESUME_DOWNLOADED",
    );
  });

  it("uses a committed tenant adapter for HTTP/runtime producers", () => {
    commitTenantEventAdapter("zhaopin", zhaopinLegacyRaasEventAdapter);
    expect(tenantEventName("zhaopin", "RESUME_DOWNLOADED")).toBe(
      "RESUME_DOWNLOADED",
    );
    expect(tenantEventName("zhaopin", "zhaopin/RESUME_DOWNLOADED")).toBe(
      "RESUME_DOWNLOADED",
    );
    expect(tenantEventName("northwind", "RESUME_DOWNLOADED")).toBe(
      "northwind/RESUME_DOWNLOADED",
    );
  });

  it("keeps the last-good adapter until a candidate is explicitly committed", () => {
    commitTenantEventAdapter("zhaopin", zhaopinLegacyRaasEventAdapter);
    const candidate: TenantEventAdapter = {
      name: "candidate",
      wireEventName: ({ eventName }) => `candidate/${eventName}`,
      inbound: ({ data }) => data,
      outbound: ({ payload }) => payload,
    };

    // Function construction can use the candidate directly, while unrelated
    // HTTP producers continue to see the last-good committed transport.
    expect(tenantEventName("zhaopin", "READY", candidate)).toBe(
      "candidate/READY",
    );
    expect(tenantEventName("zhaopin", "READY")).toBe("READY");

    commitTenantEventAdapter("zhaopin", candidate);
    expect(tenantEventName("zhaopin", "READY")).toBe("candidate/READY");
  });

  it("does not publish a candidate adapter when tenant bootstrap fails", async () => {
    commitTenantEventAdapter("zhaopin", zhaopinLegacyRaasEventAdapter);
    const candidate: TenantEventAdapter = {
      name: "broken-hot-load",
      wireEventName: ({ eventName }) => `candidate/${eventName}`,
      inbound: ({ data }) => data,
      outbound: ({ payload }) => payload,
    };
    const modelDir = path.join(
      process.env.AGENTIC_MODELS_DIR
        ?? path.resolve(__dirname, "../../../models"),
      "zhaopin-v1",
    );

    // The deliberately incomplete registry is rejected because the zhaopin
    // manifest's logic steps require its tenant prompts. The adapter commit is
    // after that validation, so API producers retain the live bare contract.
    await expect(
      bootstrapTenant({
        tenantSlug: "zhaopin",
        modelDir,
        tenantRegistry: { eventAdapter: candidate },
      }),
    ).rejects.toThrow(/no tenant definePrompt/i);
    expect(tenantEventName("zhaopin", "RESUME_DOWNLOADED")).toBe(
      "RESUME_DOWNLOADED",
    );
  });

  it("rejects an empty tenant-owned wire name", () => {
    const invalid: TenantEventAdapter = {
      name: "invalid",
      wireEventName: () => " ",
      inbound: ({ data }) => data,
      outbound: ({ payload }) => payload,
    };
    expect(() => tenantEventName("acme", "READY", invalid)).toThrow(
      "returned an empty wire event name",
    );
  });

  it("does not strip another tenant's prefix", () => {
    expect(bareTenantEventName("zhaopin", "other/RESUME_DOWNLOADED")).toBe(
      "other/RESUME_DOWNLOADED",
    );
  });

  it("registers the zhaopin function on the same bare names old RAAS emits", () => {
    const fn = registerAgent(
      {
        id: "9-1",
        name: "processResume",
        actor: ["Agent"],
        trigger: ["RESUME_DOWNLOADED"],
        actions: [],
        triggered_event: ["RESUME_PROCESSED"],
      },
      {
        tenantId: "ten-zhaopin-test",
        tenantSlug: "zhaopin",
        workflowVersionId: "wfv-zhaopin-test",
        tenantRegistry: { eventAdapter: zhaopinLegacyRaasEventAdapter },
      },
    );
    const opts = (
      fn as unknown as {
        opts: {
          triggers: Array<{ event: string }>;
          concurrency: { key: string };
          cancelOn: Array<{ event: string; if: string }>;
        };
      }
    ).opts;
    expect(opts.triggers).toEqual([{ event: "RESUME_DOWNLOADED" }]);
    expect(opts.concurrency.key).toBe('"zhaopin:" + event.data.entity_id');
    expect(opts.cancelOn[0]?.event).toBe("run.cancel");
    // Precise trigger-id match first; the adapter's entity_id subject stays
    // as the legacy fallback, guarded against a null subject matching every
    // in-flight run (2026-09-07).
    expect(opts.cancelOn[0]?.if).toContain(
      "async.data.triggerEventId != null && async.data.triggerEventId == event.data.__triggerEventId && async.data.agent == ",
    );
    expect(opts.cancelOn[0]?.if).toContain(
      "async.data.triggerEventId == null && async.data.entity_id != null && async.data.entity_id == event.data.entity_id",
    );
  });

  it("uses the same tenant-owned wire name for cron producers", async () => {
    const scheduled = registerCronTriggers({
      tenantSlug: "zhaopin",
      eventAdapter: zhaopinLegacyRaasEventAdapter,
      manifest: [
        {
          id: "scheduled",
          name: "scheduled",
          actor: ["Agent"],
          trigger: ["RESUME_DOWNLOADED"],
          actions: [],
          triggered_event: [],
          cron: "@hourly",
        } as never,
      ],
    });
    let emittedName: string | undefined;
    const producer = scheduled.functions[0] as unknown as {
      fn(input: {
        step: {
          sendEvent(id: string, event: { name: string }): Promise<void>;
        };
      }): Promise<unknown>;
    };
    await producer.fn({
      step: {
        sendEvent: async (_id, event) => {
          emittedName = event.name;
        },
      },
    });
    expect(emittedName).toBe("RESUME_DOWNLOADED");
  });

  it("gets legacy function ids from the tenant adapter, never from a generic tenant-name branch", () => {
    expect(tenantFunctionId("zhaopin", "processResume")).toBe("zhaopin.processResume");
    expect(tenantFunctionId("any-recruiting-tenant", "processResume", zhaopinLegacyRaasEventAdapter)).toBe("resume-parser-agent");
    expect(tenantFunctionId("zhaopin", "newAction", zhaopinLegacyRaasEventAdapter)).toBe("zhaopin.newAction");
  });
});
