import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = resolve(import.meta.dirname, "../..");

function read(path: string): string {
  return readFileSync(resolve(webRoot, path), "utf8");
}

describe("OntoCode production entry", () => {
  const sidebar = read("app/portal/components/shell/sidebar.tsx");
  const nextConfig = read("next.config.mjs");
  const hubPage = read(
    "app/portal/[tenant]/(views)/ontocode-workspace/page.tsx",
  );
  const sessionPage = read(
    "app/portal/[tenant]/(views)/ontocode-workspace/[sessionId]/page.tsx",
  );

  it("opens the connected Session Hub from the production sidebar", () => {
    expect(sidebar).toContain('href={`${base}/ontocode-workspace`}');
    expect(sidebar).not.toContain('href={`${base}/ontocode`}');
    expect(sidebar).toContain('label={t("nav.ontocode")}');
    expect(sidebar).toContain("matchPrefix");
    expect(hubPage).toContain("<OntoCodeWorkspaceHubConnected />");
  });

  it("serves the v10 workbench as the default session experience", () => {
    expect(sessionPage).toContain("<WorkbenchSessionConnected />");
    // 并行期逃生门：旧工作台仅在 ?legacy=1 下可达，M3 退役批次删除。
    expect(sessionPage).toContain('searchParams?.get("legacy")');
    expect(sessionPage).toContain("<OntoCodeWorkspaceSessionConnected />");
  });

  it("redirects legacy OntoCode bookmarks to the canonical workspace", () => {
    expect(nextConfig).toContain(
      'source: "/portal/:tenant/ontocode"',
    );
    expect(nextConfig).toContain(
      'destination: "/portal/:tenant/ontocode-workspace"',
    );
    // Next.js forwards query parameters that are not consumed by a redirect
    // pattern, so old links such as `?runId=…` remain non-breaking.
    expect(nextConfig).toContain("permanent: false");
  });
});
