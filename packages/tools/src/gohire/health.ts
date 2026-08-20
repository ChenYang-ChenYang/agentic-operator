/**
 * gohireHealthApi — GET {base}/health on the GoHire ATS API.
 *
 * The cheap canary the Settings → Integrations "Test connection" button
 * (and any agent) can call to confirm the configured base URL + API key are
 * reachable + accepted before invoking heavier endpoints.
 *
 * Credential / base-URL resolution: see rest-helper.ts (manifest config →
 * DB integration store → env).
 */

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

import { ghFetch } from "./rest-helper";

export const gohireHealthApi = defineTool({
  name: "gohireHealthApi",
  description:
    "Call GoHire GET /health. Returns the upstream status body. " +
    "Use to verify connectivity + credentials before invoking write endpoints.",
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const res = await ghFetch<Record<string, unknown>>(ctx, "GET", "/health");
    if (!res.ok) {
      const err = new Error(
        `gohireHealthApi: ${res.message} — body=${JSON.stringify(res.errorBody)}`,
      );
      // Structured props so probe callers can classify (e.g. "reachable but
      // this deployment has no /health route") without parsing the message.
      Object.assign(err, { status: res.status, errorBody: res.errorBody });
      throw err;
    }
    return {
      data: res.data,
      meta: {
        provider: "gohire",
        endpoint: "GET /health",
        upstreamStatus: res.status,
      },
    };
  },
});
