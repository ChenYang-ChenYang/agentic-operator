import { describe, expect, it } from "vitest";
import { agentDisplayTitle } from "./agent-title";

const compiled = {
  name: "verifyInventoryAvailability",
  title: "库存校验",
  titleI18n: { zh: "库存校验", en: "Verify Inventory Availability" },
};

describe("agentDisplayTitle", () => {
  it("picks the portal language from title_i18n", () => {
    expect(agentDisplayTitle(compiled, "zh")).toBe("库存校验");
    expect(agentDisplayTitle(compiled, "en")).toBe("Verify Inventory Availability");
  });

  it("falls back from a regional tag to its base language", () => {
    expect(agentDisplayTitle(compiled, "zh-CN")).toBe("库存校验");
    expect(agentDisplayTitle(compiled, "en-US")).toBe("Verify Inventory Availability");
  });

  it("falls back to the manifest title, then the technical name", () => {
    expect(agentDisplayTitle({ name: "x", title: "手写标题", titleI18n: null }, "en")).toBe("手写标题");
    expect(agentDisplayTitle({ name: "matcher-agent", title: "  " }, "zh")).toBe("matcher-agent");
    expect(agentDisplayTitle(compiled, "fr")).toBe("库存校验");
  });
});
