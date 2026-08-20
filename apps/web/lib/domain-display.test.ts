import { describe, expect, it } from "vitest";
import {
  domainLabel,
  isVisibleRuntimeDomain,
} from "./domain-display";

describe("domain display helpers", () => {
  it("keeps ontology labels independent from runtime tenant identity", () => {
    expect(domainLabel({ id: "RAAS-v1", name: "招聘本体" })).toBe("招聘本体");
    expect(domainLabel({ id: "RAAS-v1" })).toBe("RAAS-v1");
  });

  it("shows empty runtime tenants and hides only internal tenants", () => {
    expect(isVisibleRuntimeDomain({ slug: "raas", name: "RAAS", agentCount: 0 })).toBe(true);
    expect(isVisibleRuntimeDomain({ slug: "pgvec-e2e", name: "pgvec e2e", agentCount: 0 })).toBe(true);
    expect(
      isVisibleRuntimeDomain({
        slug: "agents-generation",
        name: "Agents Generation legacy runtime",
        productKind: "runtime_namespace",
        agentCount: 6,
      }),
    ).toBe(false);
    expect(isVisibleRuntimeDomain({ slug: "raas-sb", name: "raas sandbox", agentCount: 6 })).toBe(false);
    expect(isVisibleRuntimeDomain({ slug: "__system", name: "system", agentCount: 2 })).toBe(false);
  });
});
