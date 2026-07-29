// 「删除 Session 点了没反应」的真实根因。
//
// jsonHeaders 无条件加 Content-Type: application/json，而删除是无 body 的
// DELETE —— Fastify 对「声明了 json 却没有 body」一律 400
// (FST_ERR_CTP_EMPTY_JSON_BODY)，请求在进路由之前就被拒了。加上删除 mutation
// 当时没有 onError，界面上就是：点一下，什么也没发生。
//
// 仓库里其它 hook（useModelFleet / useApiTokens / useIntegrations /
// useBusinessOntologyDomains）都做了这个判断，只有 OntoCode 这一处没有。
import { describe, expect, it } from "vitest";
import { ontocodeRequestHeaders } from "./useOntoCodeWorkspace";

describe("ontocodeRequestHeaders", () => {
  it("does NOT declare a JSON body on a bodyless request", () => {
    const headers = ontocodeRequestHeaders("acme", {});
    expect(headers["Content-Type"]).toBeUndefined();
    // 其余的头照旧——租户路由和 Accept 与有没有 body 无关。
    expect(headers["x-agentic-tenant"]).toBe("acme");
    expect(headers.Accept).toBe("application/json");
  });

  it("declares it when there actually is a body", () => {
    const headers = ontocodeRequestHeaders("acme", {
      body: JSON.stringify({ a: 1 }),
    });
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("keeps caller-supplied headers, and still drops the type when bodyless", () => {
    const headers = ontocodeRequestHeaders("acme", {
      headers: { "Idempotency-Key": "k-1" },
    });
    expect(headers["Idempotency-Key"]).toBe("k-1");
    expect(headers["Content-Type"]).toBeUndefined();
  });
});
