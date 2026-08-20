import { describe, expect, it } from "vitest";
import { calculateCost, type TokenUsage } from "@agentic/llm-gateway";
import {
  defaultModelFor,
  PROVIDER_MODEL_CATALOG,
  PROVIDER_PRESETS,
  selectableModelsForProvider,
} from "@agentic/contracts";

function usage(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens: 0,
    cacheWrite5mInputTokens: 0,
    cacheWrite1hInputTokens: 0,
    reasoningTokens: 0,
    inputAudioTokens: 0,
    outputAudioTokens: 0,
  };
}

describe("model catalog pricing", () => {
  it("prices uncached, cached, and output tokens without cent rounding", () => {
    const cost = calculateCost({
      provider: "openai",
      model: "gpt-5.6-sol",
      usage: usage(1_000, 100, 100),
      at: new Date("2026-07-15T00:00:00Z"),
    });
    expect(cost.source).toBe("catalog");
    expect(cost.inputUsdNanos).toBe(4_500_000);
    expect(cost.cachedInputUsdNanos).toBe(50_000);
    expect(cost.outputUsdNanos).toBe(3_000_000);
    expect(cost.totalUsdNanos).toBe(7_550_000);
  });

  it("applies whole-request long-context pricing", () => {
    const cost = calculateCost({
      provider: "openai",
      model: "gpt-5.6-sol",
      usage: usage(300_000, 1_000),
      at: new Date("2026-07-15T00:00:00Z"),
    });
    expect(cost.inputUsdNanos).toBe(3_000_000_000);
    expect(cost.outputUsdNanos).toBe(45_000_000);
  });

  it("selects the effective Claude Sonnet 5 price schedule", () => {
    const promotional = calculateCost({
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage: usage(1_000_000, 1_000_000),
      at: new Date("2026-08-31T12:00:00Z"),
    });
    const standard = calculateCost({
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage: usage(1_000_000, 1_000_000),
      at: new Date("2026-09-01T12:00:00Z"),
    });
    expect(promotional.totalUsdNanos).toBe(12_000_000_000);
    expect(standard.totalUsdNanos).toBe(18_000_000_000);
  });

  it("prefers provider-reported routed cost", () => {
    const cost = calculateCost({
      provider: "openrouter",
      model: "vendor/dynamic-model",
      usage: usage(500, 100),
      providerReportedCostUsd: 0.00123,
    });
    expect(cost.source).toBe("provider");
    expect(cost.totalUsdNanos).toBe(1_230_000);
  });

  it("marks unknown pricing as unpriced instead of guessing zero", () => {
    const cost = calculateCost({
      provider: "custom",
      model: "private-model",
      usage: usage(1_000, 1_000),
    });
    expect(cost.source).toBe("unpriced");
    expect(cost.totalUsdNanos).toBeNull();
  });

  it("does not price a response whose provider omitted usage", () => {
    const missing = { ...usage(0, 0), available: false };
    const cost = calculateCost({
      provider: "openai",
      model: "gpt-5.6-sol",
      usage: missing,
    });
    expect(cost).toMatchObject({ source: "unpriced", totalUsdNanos: null });
  });

  it("catalogs the new primary providers and requested model families", () => {
    expect(PROVIDER_PRESETS.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(["moonshot", "zai"]),
    );
    expect(PROVIDER_MODEL_CATALOG.openai.map((model) => model.name)).toContain(
      "gpt-5.6-sol",
    );
    expect(
      PROVIDER_MODEL_CATALOG.anthropic.map((model) => model.name),
    ).toContain("claude-opus-4-8");
    expect(
      PROVIDER_MODEL_CATALOG.deepseek.map((model) => model.name),
    ).toContain("deepseek-v4-pro");
    expect(PROVIDER_MODEL_CATALOG.moonshot.map((model) => model.name)).toEqual(
      expect.arrayContaining([
        "kimi-k2.7-code",
        "kimi-k2.7-code-highspeed",
        "kimi-k2.6",
      ]),
    );
    expect(PROVIDER_MODEL_CATALOG.zai.map((model) => model.name)).toContain(
      "glm-5.2",
    );
    expect(
      PROVIDER_MODEL_CATALOG.openrouter.map((model) => model.name),
    ).toEqual(
      expect.arrayContaining([
        "openai/gpt-5.6-sol-pro",
        "anthropic/claude-opus-4.8",
        "moonshotai/kimi-k2.7-code",
        "z-ai/glm-5.2",
        "deepseek/deepseek-v4-flash",
        "nvidia/nemotron-3-ultra-550b-a55b:free",
      ]),
    );
  });

  it("records provider-native reasoning controls without inventing effort tiers", () => {
    const kimiCode = PROVIDER_MODEL_CATALOG.moonshot.find(
      (model) => model.name === "kimi-k2.7-code",
    );
    const kimiGeneral = PROVIDER_MODEL_CATALOG.moonshot.find(
      (model) => model.name === "kimi-k2.6",
    );
    const glm = PROVIDER_MODEL_CATALOG.zai.find(
      (model) => model.name === "glm-5.2",
    );
    const deepseek = PROVIDER_MODEL_CATALOG.deepseek.find(
      (model) => model.name === "deepseek-v4-pro",
    );

    expect(kimiCode).toMatchObject({
      reasoningMandatory: true,
      inP: 0.95,
      outP: 4,
      pricing: [{ input: 0.95, cachedInput: 0.19, output: 4 }],
    });
    expect(kimiCode?.reasoningEfforts).toBeUndefined();
    expect(kimiGeneral).toMatchObject({
      reasoningDefaultEnabled: true,
      reasoningEfforts: ["none"],
    });
    expect(glm).toMatchObject({
      ctx: 1_000_000,
      reasoningDefaultEnabled: true,
      reasoningEfforts: ["none", "high", "max"],
      defaultReasoningEffort: "max",
      pricing: [{ input: 1.4, cachedInput: 0.26, output: 4.4 }],
    });
    expect(deepseek).toMatchObject({
      reasoningDefaultEnabled: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
    });
  });

  it("selects current general-purpose defaults while retaining specialist models", () => {
    // Do NOT assert bare model names here. A catalog entry stops being
    // selectable CURRENT_MODEL_MAX_AGE_DAYS (365) after its releaseDate, so a
    // hard-coded name is a time bomb rather than a test: this assertion went
    // red on 2026-08-05 with NO code change at all, when openai/gpt-oss-120b
    // (released 2025-08-05) aged out and the openrouter default moved on to
    // the next selectable entry. The invariant that actually matters — and
    // that the test name claims — is that every provider default is a model
    // which is CURRENTLY selectable.
    for (const provider of [
      "openrouter",
      "moonshot",
      "zai",
      "deepseek",
    ] as const) {
      const selectable = selectableModelsForProvider(provider);
      expect(selectable.length).toBeGreaterThan(0);
      const chosen = defaultModelFor(provider);
      expect(chosen).not.toBeNull();
      expect(selectable.map((m) => m.name)).toContain(chosen);
    }
  });
});
