import { describe, expect, it } from "vitest";
import { translate } from "@/lib/i18n";
import {
  buildGeneratedToolDeactivationPath,
  buildHumanInteractionSubmission,
  decodeFactoryResponse,
  factoryNetworkFailure,
} from "./factory-api";

const t = (key: string, vars?: Record<string, string | number>) => translate("zh", key, vars);

function response(input: {
  httpOk: boolean;
  status: number;
  body?: unknown;
  jsonError?: boolean;
  statusText?: string;
}) {
  return {
    ok: input.httpOk,
    status: input.status,
    statusText: input.statusText ?? "",
    json: async () => {
      if (input.jsonError) throw new SyntaxError("bad json");
      return input.body;
    },
  };
}

describe("decodeFactoryResponse", () => {
  it("accepts only a successful HTTP response with an ok envelope", async () => {
    await expect(decodeFactoryResponse<{ id: string }>(t, response({
      httpOk: true,
      status: 200,
      body: { ok: true, data: { id: "real-run" } },
    }))).resolves.toEqual({ ok: true, status: 200, data: { id: "real-run" } });
  });

  it("rejects a deceptive ok envelope on an HTTP failure", async () => {
    await expect(decodeFactoryResponse(t, response({
      httpOk: false,
      status: 503,
      body: { ok: true, data: { restored: true } },
    }))).resolves.toEqual({ ok: false, status: 503, message: "HTTP 503" });
  });

  it("surfaces an API error even when HTTP is 200", async () => {
    await expect(decodeFactoryResponse(t, response({
      httpOk: true,
      status: 200,
      body: { ok: false, error: { message: "run is still active" } },
    }))).resolves.toEqual({ ok: false, status: 200, message: "run is still active" });
  });

  it("preserves the server error code for an explicit body-size failure", async () => {
    await expect(decodeFactoryResponse(t, response({
      httpOk: false,
      status: 413,
      body: { ok: false, error: { code: "FST_ERR_CTP_BODY_TOO_LARGE", message: "Request body is too large" } },
    }))).resolves.toEqual({
      ok: false,
      status: 413,
      code: "FST_ERR_CTP_BODY_TOO_LARGE",
      message: "Request body is too large",
    });
  });

  it("rejects malformed JSON instead of reporting a mutation as successful", async () => {
    await expect(decodeFactoryResponse(t, response({
      httpOk: true,
      status: 204,
      jsonError: true,
    }))).resolves.toEqual({ ok: false, status: 204, message: "HTTP 204 返回了无效 JSON" });
  });

  it("turns a non-JSON proxy 5xx into an actionable API restart error", async () => {
    await expect(decodeFactoryResponse(t, response({
      httpOk: false,
      status: 500,
      jsonError: true,
    }))).resolves.toEqual({
      ok: false,
      status: 500,
      code: "api_restarting",
      message: "OntoCode 服务正在重启，请稍候重试",
    });
  });

  it("rejects an incomplete success envelope with no data", async () => {
    await expect(decodeFactoryResponse(t, response({
      httpOk: true,
      status: 200,
      body: { ok: true },
    }))).resolves.toEqual({ ok: false, status: 200, message: "接口成功响应缺少 data" });
  });
});

describe("factoryNetworkFailure", () => {
  it("preserves a real network error for the UI", () => {
    expect(factoryNetworkFailure(t, new Error("connection refused"))).toEqual({
      ok: false,
      status: 0,
      message: "connection refused",
    });
  });
});

describe("buildHumanInteractionSubmission", () => {
  it("keeps the exact card id and kind beside the tagged answer", () => {
    expect(buildHumanInteractionSubmission(t, {
      conversation: " run-1 ",
      interactionId: " hitl_exact ",
      kind: "clarify",
      text: " [澄清回答] A ",
    })).toEqual({
      conversation: "run-1",
      interactionId: "hitl_exact",
      kind: "clarify",
      text: "[澄清回答] A",
    });
  });

  it("refuses a text-only legacy submission", () => {
    expect(() => buildHumanInteractionSubmission(t, {
      conversation: "run-1",
      interactionId: "",
      kind: "boundary",
      text: "[边界事件决策] []",
    })).toThrow(/不能安全提交/);
  });
});

describe("buildGeneratedToolDeactivationPath", () => {
  it("carries the exact active revision and revision domain for CAS", () => {
    expect(
      buildGeneratedToolDeactivationPath({
        name: "gohire.generate/jd",
        expectedActiveRevisionId: "ftr-active-7",
        revisionDomainId: "Agents-generation",
      }),
    ).toBe(
      "/v1/agent-factory/generated-tools/gohire.generate%2Fjd?expectedActiveRevisionId=ftr-active-7&revisionDomainId=Agents-generation",
    );
  });

  it("uses the explicit unbound sentinel but rejects a legacy projection", () => {
    expect(
      buildGeneratedToolDeactivationPath({
        name: "gohire.generateJd",
        expectedActiveRevisionId: "ftr-1",
        revisionDomainId: null,
      }),
    ).toContain("revisionDomainId=__unbound__");
    expect(() =>
      buildGeneratedToolDeactivationPath({
        name: "gohire.generateJd",
        expectedActiveRevisionId: "",
        revisionDomainId: null,
      }),
    ).toThrow(/exact tool name and active revision/);
  });
});
