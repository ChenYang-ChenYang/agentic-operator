import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayInstanceSchema } from "@agentic/contracts";
import {
  testGatewayConnection,
  testProviderKey,
} from "../src/services/provider-test";

describe("custom provider connectivity probe", () => {
  const previousBaseUrl = process.env.CUSTOM_LLM_BASE_URL;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousBaseUrl === undefined) delete process.env.CUSTOM_LLM_BASE_URL;
    else process.env.CUSTOM_LLM_BASE_URL = previousBaseUrl;
  });

  it("probes the configured OpenAI-compatible /models endpoint", async () => {
    process.env.CUSTOM_LLM_BASE_URL = "https://gateway.example.test/v1/";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await testProviderKey("custom", "sk-custom-probe-key");

    expect(result).toMatchObject({ ok: true, statusCode: 200, modelCount: 2 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://gateway.example.test/v1/models");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer sk-custom-probe-key",
      Accept: "application/json",
    });
  });

  it("fails clearly when the custom base URL is absent", async () => {
    delete process.env.CUSTOM_LLM_BASE_URL;
    const result = await testProviderKey("custom", "sk-custom-probe-key");
    expect(result).toMatchObject({
      ok: false,
      statusCode: null,
      message: "CUSTOM_LLM_BASE_URL is not configured",
    });
  });

  it.each([
    {
      label: "an HTML application shell",
      body: "<!doctype html><html><body>NewAPI</body></html>",
      contentType: "text/html",
    },
    {
      label: "non-OpenAI-compatible JSON",
      body: JSON.stringify({ ok: true, service: "gateway" }),
      contentType: "application/json",
    },
    {
      label: "malformed JSON",
      body: '{"data":',
      contentType: "application/json",
    },
  ])(
    "rejects HTTP 200 from a NewAPI /models endpoint when it returns $label",
    async ({ body, contentType }) => {
      const fetchMock = vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { "Content-Type": contentType },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const instance = GatewayInstanceSchema.parse({
        id: "newapi-regression",
        displayName: "Regression NewAPI",
        kind: "newapi",
        baseUrl: "https://1.1.1.1",
      });

      const result = await testGatewayConnection({
        instance,
        apiKey: "sk-custom-probe-key",
      });

      expect(result).toMatchObject({
        ok: false,
        statusCode: 200,
        modelCount: null,
        endpoint: "https://1.1.1.1/v1/models",
      });
      expect(result.message).toMatch(
        /not a valid OpenAI-compatible model catalog/i,
      );
      expect(result.message).toContain("/v1");
    },
  );

  it("keeps the compatible models-array envelope working for NewAPI gateways", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            models: [{ id: "model-a" }, { name: "model-b" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const instance = GatewayInstanceSchema.parse({
      id: "newapi-compatible",
      displayName: "Compatible NewAPI",
      kind: "newapi",
      baseUrl: "https://1.1.1.1/v1",
    });

    const result = await testGatewayConnection({
      instance,
      apiKey: "sk-custom-probe-key",
    });

    expect(result).toMatchObject({
      ok: true,
      statusCode: 200,
      modelCount: 2,
      endpoint: "https://1.1.1.1/v1/models",
    });
  });
});
