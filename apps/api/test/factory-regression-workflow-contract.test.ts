import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const workflowUrl = (name: string): URL =>
  new URL(`../../../.github/workflows/${name}`, import.meta.url);

describe("Factory regression GitHub workflow contracts", () => {
  it("binds a manual release tag, checkout, evidence, replay and release to one resolved commit", async () => {
    const release = await readFile(workflowUrl("release.yml"), "utf8");

    expect(release).toContain('release_ref="refs/tags/$REQUESTED_TAG"');
    expect(release).toContain("ref: ${{ steps.tag.outputs.ref }}");
    expect(release).toContain('release_sha="$(git rev-parse HEAD)"');
    expect(release).toContain("RELEASE_SHA: ${{ steps.source.outputs.sha }}");
    expect(release).toContain("run.head_sha === process.env.RELEASE_SHA");
    expect(release).toContain("createWorkflowDispatch");
    expect(release).toContain("request_nonce: nonce");
    expect(release).toContain("run.display_title === requestedRunName");
    expect(release).toContain(
      '--consumer-run-attempt "${{ github.run_attempt }}"',
    );
    expect(release).toContain(
      '--expected-high-watermark-state-hash "${{ steps.regression-checkpoint.outputs.state_hash }}"',
    );
    expect(release).toContain(
      "agent-factory-promoted-regressions-${process.env.RELEASE_SHA}",
    );
    expect(release).toContain(
      '--expected-sha "${{ steps.source.outputs.sha }}"',
    );
    expect(release).toContain(
      "target_commitish: ${{ needs['build-push'].outputs.release_sha }}",
    );
    expect(release).not.toContain("run.head_sha === context.sha");
  });

  it("keeps production evidence out of pull requests and mandatory on main", async () => {
    const ci = await readFile(workflowUrl("ci.yml"), "utf8");
    const exporter = await readFile(
      workflowUrl("factory-regression-export.yml"),
      "utf8",
    );

    // The factory-regression job runs only on main (never on PRs) AND is gated
    // behind the `ENABLE_FACTORY_REGRESSION` repo variable — the self-hosted
    // `agentic-production-evidence` runner is not connected to this repository,
    // so the signed live-inventory replay is opt-in and re-armable (set the
    // variable once the runner is registered) rather than a permanently-red
    // required check.
    expect(ci).toContain(
      "github.event_name != 'pull_request' && github.ref == 'refs/heads/main'",
    );
    expect(ci).toContain("vars.ENABLE_FACTORY_REGRESSION == 'true'");
    // The meta gate still blocks on a real factory-regression FAILURE, but
    // treats a `skipped` run (variable off) as passing so CI is green by default.
    expect(ci).toContain(
      "needs.factory-regression.result != 'success' && needs.factory-regression.result != 'skipped'",
    );
    expect(ci).toContain('--expected-sha "${{ github.sha }}"');
    // NO hourly `schedule:` trigger. It used to be `- cron: "17 * * * *"`,
    // added so this freshness gate would re-run hourly. It was removed because
    // it delivered none of that: with `ENABLE_FACTORY_REGRESSION` unset, the
    // factory-regression job asserted above is skipped in EVERY scheduled run,
    // so the only thing the cron ever produced was a failed run — and a failure
    // notification e-mail to whoever last edited the cron line — 24x a day, per
    // repo, for as long as `main` stays red. Re-arm it only TOGETHER WITH the
    // gate; these assertions are what force that pairing.
    expect(ci).not.toContain('- cron: "17 * * * *"');
    expect(ci).not.toMatch(/^\s+schedule:\s*$/m);
    expect(ci).toContain("ENABLE_FACTORY_REGRESSION=true");
    expect(ci).toContain("createWorkflowDispatch");
    expect(ci).toContain("request_nonce: nonce");
    expect(ci).toContain("run.display_title === requestedRunName");
    expect(ci).toContain(
      '--expected-high-watermark-state-hash "${{ steps.checkpoint.outputs.state_hash }}"',
    );
    expect(exporter).toContain(
      "runs-on: [self-hosted, agentic-production-evidence]",
    );
    expect(exporter).toContain("AGENTIC_FACTORY_PRODUCTION_DATA_ROOT");
    expect(exporter).toContain("AGENTIC_FACTORY_PRODUCTION_DATABASE_URL");
    expect(exporter).toContain("FACTORY_REGRESSION_EXPORT_SIGNING_KEY");
    expect(exporter).toContain("FACTORY_REGRESSION_EXPORT_CONSUMER_RUN_ID");
    expect(exporter).toContain("FACTORY_REGRESSION_EXPORT_REQUEST_NONCE");
  });
});
