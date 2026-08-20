import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configuredApiUrl = process.env.AGENTIC_API_URL?.trim();
if (!configuredApiUrl && process.env.NODE_ENV === "production") {
  throw new Error(
    "AGENTIC_API_URL is required for a production web build; refusing a localhost API fallback",
  );
}
const API_URL = configuredApiUrl || "http://localhost:3540";
const parsedApiUrl = new URL(API_URL);
if (parsedApiUrl.protocol !== "http:" && parsedApiUrl.protocol !== "https:") {
  throw new Error("AGENTIC_API_URL must be an absolute http(s) URL");
}

/**
 * Next 16 ships Turbopack as default for dev. The web workspace has no
 * native module deps (better-sqlite3 lives in apps/api only), so Turbopack
 * is safe here. The api still runs on Node 26 + better-sqlite3 12 directly.
 *
 * Web is UI-only. All data calls go through /v1/* which Next rewrites to
 * apps/api on :3540. Same-origin in dev; in prod a reverse proxy serves the
 * same paths.
 *
 * Routing decisions:
 *   - `/v1/*`, `/health`            → proxied to apps/api on :3540.
 *   - everything else               → Next.js App Router. `/portal/*` is the
 *                                     real production UI (TypeScript +
 *                                     react-query); `/` redirects there via
 *                                     `apps/web/app/page.tsx`.
 */
/**
 * BUILD NOTE — the `build` script passes `--experimental-build-mode compile`.
 * Next.js 16 (every version through 16.3.0 stable — re-verified on the 16.3.0
 * upgrade) crashes while statically
 * prerendering its internal `/_not-found` and `/_global-error` pages with
 * "Cannot read properties of null (reading 'useContext')" inside the framework's
 * OuterLayoutRouter — an unresolved upstream bug (vercel/next.js #85668, #86178,
 * #84994) that is bundler-, React-version- and config-independent and cannot be
 * worked around from application code. `compile` mode skips the static-generate
 * phase; this portal is 100% dynamic (every route is `ƒ` server-rendered on
 * demand, all data flows through /v1), so nothing is lost. Revisit once Next
 * ships a fix and drop the flag to restore the standard build.
 */
/** @type {import("next").NextConfig} */
const nextConfig = {
  // Emit a self-contained server bundle at .next/standalone — the web Dockerfile
  // COPYs it (runtime stage) + runs `node apps/web/server.js`. Without this Next
  // never produces the standalone folder and the container build fails on COPY.
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: ["@agentic/contracts"],
  typedRoutes: true,
  reactStrictMode: true,
  async redirects() {
    return [
      {
        // `/ontocode` was the original single-screen factory facade. Keep
        // bookmarks and query-string deep links working while making the
        // connected Session Hub the one canonical product entry.
        source: "/portal/:tenant/ontocode",
        destination: "/portal/:tenant/ontocode-workspace",
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/v1/:path*", destination: `${API_URL}/v1/:path*` },
        { source: "/health", destination: `${API_URL}/health` },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
