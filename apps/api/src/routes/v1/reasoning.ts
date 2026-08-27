/**
 * W3 — reads for the 推理审计 (reasoning / rule-audit) page.
 *   - GET /v1/reasoning        — recent LLM-response turns across the tenant's
 *                                runs (the live "推理流" feed). ?limit= ?agent=
 *   - GET /v1/reasoning/audit  — recent rule-check / gate decisions with a
 *                                derived verdict + payload. ?limit=
 */

import type { FastifyInstance } from "fastify";
import { requirePermission } from "../../plugins/rbac";
import { listRecentTurns, listRuleAudit } from "../../queries/reasoning-feed";

export async function reasoningRoutes(app: FastifyInstance) {
  app.get("/reasoning", async (req, reply) => {
    const auth = requirePermission(req, "runs.read");
    const q = req.query as { limit?: string; agent?: string; run?: string };
    const limit = q.limit ? Number(q.limit) : undefined;
    return reply.ok(
      listRecentTurns(auth.tenantSlug, {
        limit: Number.isFinite(limit) ? limit : undefined,
        agent: q.agent,
        run: q.run,
      }),
    );
  });

  app.get("/reasoning/audit", async (req, reply) => {
    const auth = requirePermission(req, "runs.read");
    const q = req.query as { limit?: string };
    const limit = q.limit ? Number(q.limit) : undefined;
    return reply.ok(
      await listRuleAudit(auth.tenantSlug, {
        limit: Number.isFinite(limit) ? limit : undefined,
      }),
    );
  });
}
