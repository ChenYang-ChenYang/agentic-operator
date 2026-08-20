/**
 * TC-61 — Model fleet CRUD endpoints.
 *
 * Exercises:
 *   GET    /v1/llm/catalog            — full metadata catalog
 *   GET    /v1/llm/fleet              — list tenant fleet
 *   POST   /v1/llm/fleet              — add entry (validation, dedupe)
 *   PATCH  /v1/llm/fleet/:id          — partial update (alias, role, cap)
 *   DELETE /v1/llm/fleet/:id          — remove entry
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { buildTestEnv, type TestEnv } from "./harness";

const FLEET_PATH = path.join(
  process.cwd().endsWith("apps/api") ? "../.." : ".",
  "data",
  "test-model-fleet.json",
);

describe("TC-61: /v1/llm/fleet model-fleet CRUD", () => {
  let env: TestEnv;

  beforeAll(async () => {
    process.env.AGENTIC_MODEL_FLEET_PATH = FLEET_PATH;
    if (existsSync(FLEET_PATH)) rmSync(FLEET_PATH);
    env = await buildTestEnv();
  });

  beforeEach(() => {
    // Deterministic live-discovery upstream: any residual provider /models
    // probe sees this fixed inventory instead of the network (env.fetch is
    // app.inject-based, so route requests are unaffected by this mock).
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: [
        "anthropic/claude-sonnet-4-5",
        "openai/gpt-4.1-mini",
        "openai/gpt-5.4-mini-future",
        "openai/gpt-oss-120b",
        "google/gemini-3-flash-preview",
        "deepseek/deepseek-v4-pro",
        "deepseek/deepseek-v4-flash",
        "minimax/minimax-m2.7",
      ].map((id) => ({ id })),
    }), { status: 200, headers: { "content-type": "application/json" } }));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (existsSync(FLEET_PATH)) rmSync(FLEET_PATH);
    delete process.env.AGENTIC_MODEL_FLEET_PATH;
    await env.cleanup();
  });

  it("GET /catalog returns per-provider model metadata", async () => {
    const res = await env.fetch("/v1/llm/catalog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: Record<
        string,
        Array<{
          name: string;
          ctx: number;
          inP: number;
          outP: number;
          status: string;
          selectable: boolean;
        }>
      >;
    };
    expect(body.ok).toBe(true);
    expect(body.data.openrouter.length).toBeGreaterThan(0);
    const first = body.data.openrouter[0];
    expect(typeof first.name).toBe("string");
    expect(typeof first.ctx).toBe("number");
    expect(
      body.data.anthropic.find((model) => model.name === "claude-opus-4"),
    ).toMatchObject({ status: "legacy", selectable: false });
  });

  it("GET /models exposes only models eligible for new selection", async () => {
    const res = await env.fetch("/v1/llm/models?provider=anthropic");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: string[] };
    expect(body.data).toContain("claude-sonnet-5");
    expect(body.data).not.toContain("claude-opus-4");
    expect(body.data).not.toContain("claude-mythos-5");
  });

  it("GET /fleet initially returns empty array", async () => {
    const res = await env.fetch("/v1/llm/fleet");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it("POST /fleet adds an entry with defaults", async () => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        modelName: "anthropic/claude-sonnet-4-5",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: {
        id: string;
        provider: string;
        modelName: string;
        alias: string;
        role: string;
        dailyCapUsd: number;
        maxOutTokens: number;
        temperature: number | null;
        availability: string;
        availabilityCheckedAt: number | null;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.id).toMatch(/^mdl-/);
    expect(body.data.provider).toBe("openrouter");
    expect(body.data.alias).toBe("anthropic/claude-sonnet-4-5");
    expect(body.data.role).toBe("primary");
    expect(body.data.dailyCapUsd).toBe(30);
    expect(body.data.maxOutTokens).toBe(2048);
    expect(body.data.temperature).toBeNull();
    // The merged add route does not live-confirm at add time: entries start
    // explicitly unverified until a provider listing proves the exact id.
    expect(body.data.availability).toBe("unverified");
    expect(body.data.availabilityCheckedAt).toBeNull();
  });

  it("GET /fleet reports whether each entry's provider is usable here", async () => {
    // A fleet entry outlives its provider's credentials. Listing must say so,
    // or the authoring UI auto-selects an entry that cannot run and the first
    // click fails with `provider is not configured`.
    const res = await env.fetch("/v1/llm/fleet");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ provider: string; providerConfigured: boolean }>;
    };
    expect(body.data.length).toBeGreaterThan(0);
    for (const entry of body.data) {
      expect(typeof entry.providerConfigured).toBe("boolean");
    }
    // openrouter carries no key in the test process.
    expect(
      body.data
        .filter((entry) => entry.provider === "openrouter")
        .every((entry) => entry.providerConfigured === false),
    ).toBe(true);
  });

  it("omits temperature by default and rejects it for unsupported models", async () => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        modelName: "gpt-5.6-sol",
        temperature: 0.2,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/does not support temperature/i);
  });

  it("POST /fleet honors alias, role, cap, params", async () => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        modelName: "openai/gpt-4.1-mini",
        alias: "fast-fallback",
        role: "fallback",
        dailyCapUsd: 5,
        maxOutTokens: 4096,
        temperature: 0.5,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { alias: string; role: string; dailyCapUsd: number };
    };
    expect(body.data.alias).toBe("fast-fallback");
    expect(body.data.role).toBe("fallback");
    expect(body.data.dailyCapUsd).toBe(5);
  });

  it("POST /fleet rejects duplicate provider+modelName", async () => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        modelName: "anthropic/claude-sonnet-4-5",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/already in/);
  });

  it("POST /fleet rejects unknown provider id", async () => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "bogus", modelName: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /fleet accepts any non-empty model name (live discovery is the source of truth)", async () => {
    // The static catalog was historically a gate that rejected anything not
    // in PROVIDER_MODEL_CATALOG, but the picker shows live-discovered models
    // (OpenRouter alone returns ~360). A live model the catalog hasn't been
    // updated for must still be addable. Bad names surface at invocation
    // time when the upstream returns 404.
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        modelName: "openai/gpt-5.4-mini-future",
      }),
    });
    expect(res.status).toBe(200);
    // Clean up so later tests still see only the two seeded entries.
    const body = (await res.json()) as { data: { id: string } };
    await env.fetch(`/v1/llm/fleet/${body.data.id}`, { method: "DELETE" });
  });

  it("POST /fleet rejects a known legacy catalog model", async () => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        modelName: "claude-opus-4",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/not selectable.*older_than_365_days/i);
  });

  it("persists unsupported-provider entries as explicitly unverified", async () => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "azure",
        modelName: "tenant-deployment-name",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; availability: string; availabilityCheckedAt: number | null };
    };
    expect(body.data.availability).toBe("unverified");
    expect(body.data.availabilityCheckedAt).toBeNull();
    await env.fetch(`/v1/llm/fleet/${body.data.id}`, { method: "DELETE" });
  });

  it("PATCH /fleet/:id rejects an out-of-range temperature", async () => {
    const list = (await (await env.fetch("/v1/llm/fleet")).json()) as {
      data: Array<{ id: string }>;
    };
    const id = list.data[0]!.id;
    const res = await env.fetch(`/v1/llm/fleet/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ temperature: 3 }),
    });
    expect(res.status).toBe(400);
    // Message is either the range error or, for models whose catalog row pins
    // temperatureRange=null, the does-not-support error — both reject.
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/temperature/i);
  });

  it("POST /fleet rejects empty modelName", async () => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openrouter", modelName: "  " }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /fleet lists added entries newest first", async () => {
    const res = await env.fetch("/v1/llm/fleet");
    const body = (await res.json()) as { data: Array<{ modelName: string }> };
    expect(body.data.length).toBe(2);
    // Newest first → openai/gpt-4.1-mini was added last
    expect(body.data[0].modelName).toBe("openai/gpt-4.1-mini");
  });

  it("PATCH /fleet/:id updates fields and rejects bad role", async () => {
    const list = (await (await env.fetch("/v1/llm/fleet")).json()) as {
      data: Array<{ id: string }>;
    };
    const id = list.data[0].id;

    const ok = await env.fetch(`/v1/llm/fleet/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias: "renamed", dailyCapUsd: 12 }),
    });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as {
      data: { alias: string; dailyCapUsd: number };
    };
    expect(okBody.data.alias).toBe("renamed");
    expect(okBody.data.dailyCapUsd).toBe(12);

    const bad = await env.fetch(`/v1/llm/fleet/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "invalid-role" }),
    });
    expect(bad.status).toBe(400);
  });

  it("PATCH /fleet/:id 404 on unknown id", async () => {
    const res = await env.fetch("/v1/llm/fleet/mdl-doesnotexist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /fleet/:id removes the entry", async () => {
    const before = (await (await env.fetch("/v1/llm/fleet")).json()) as {
      data: Array<{ id: string }>;
    };
    const id = before.data[0].id;

    const res = await env.fetch(`/v1/llm/fleet/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const after = (await (await env.fetch("/v1/llm/fleet")).json()) as {
      data: Array<{ id: string }>;
    };
    expect(after.data.find((e) => e.id === id)).toBeUndefined();
    expect(after.data.length).toBe(before.data.length - 1);
  });

  it("DELETE /fleet/:id 404 on unknown id", async () => {
    const res = await env.fetch("/v1/llm/fleet/mdl-nosuch", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  // The catalog was extended with five model IDs that the live OpenRouter
  // /models endpoint returns but the curated list previously rejected — the
  // user saw `bad_request — model … not in openrouter catalog` when trying
  // to add them through the Settings picker. Guard the catalog so the
  // entries don't get pruned by a future cleanup.
  // Assert exactly the invariant the bug above was about: adding one of these
  // must never fail for a CATALOG-MEMBERSHIP reason. It may legitimately fail
  // for the AGE policy — a catalog entry stops being selectable
  // CURRENT_MODEL_MAX_AGE_DAYS (365) after its releaseDate — which is what
  // silently turned this block red on 2026-08-05, with no code change at all,
  // when openai/gpt-oss-120b (released 2025-08-05) aged out. A flat
  // `expect(200)` here is a calendar bomb, not a test.
  //
  // Worth knowing: google/gemini-3-flash-preview and minimax/minimax-m2.7 are
  // no longer in PROVIDER_MODEL_CATALOG.openrouter at all. The old flat-200
  // assertion passed for them regardless, because addFleetEntry deliberately
  // lets IDs it does not know through (the live provider list may lead the
  // checked-in catalog). So the "guard against a future cleanup" above was
  // already vacuous for 2 of its 5 entries: it could not detect the very
  // pruning it was written to detect.
  it.each([
    // NOTE: catalogModelPolicy retires models older than 365 days from
    // selectable status — pick entries with runway, or this list rots with
    // the calendar (openai/gpt-oss-120b aged out on 2026-08-05).
    "openai/gpt-5.6-sol",
    "google/gemini-3-flash-preview",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "minimax/minimax-m2.7",
  ])("POST /fleet never rejects %s for catalog membership", async (modelName) => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openrouter", modelName }),
    });
    if (res.status === 200) {
      const body = (await res.json()) as {
        ok: boolean;
        data: { modelName: string };
      };
      expect(body.ok).toBe(true);
      expect(body.data.modelName).toBe(modelName);
      return;
    }
    // The only tolerated rejection is the age policy — never "not in catalog".
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/is not selectable \(/);
  });
});
