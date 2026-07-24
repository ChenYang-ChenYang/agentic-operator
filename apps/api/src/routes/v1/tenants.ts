/**
 * Tenant CRUD (P5-TEN-01).
 *
 *   GET    /v1/tenants                     list (membership-filtered for non-admins)
 *   GET    /v1/tenants/:slug               detail + counts
 *   POST   /v1/tenants                     create (transactional provisioning)
 *   PUT    /v1/tenants/:slug               update name/subtitle/color
 *   DELETE /v1/tenants/:slug               soft-archive (requires `confirm: <slug>`)
 *   POST   /v1/tenants/:slug/restore       lift archive
 *
 * Provisioning transaction (POST):
 *   1. Reserve slug (409 on collision)
 *   2. Insert tenants row
 *   3. Insert tenant_budgets defaults
 *   4. Insert membership (calling user → admin)
 *   5. Mint bootstrap api_token (returned plaintext ONCE)
 *   6. Audit row in the same transaction
 *   7. Provision durable filesystem roots and register the tenant app
 *
 * Inngest re-registration happens AFTER the transaction commits so we never
 * register a tenant whose row failed to land. Failure in either filesystem or
 * registration provisioning compensates the committed database transaction.
 *
 * Slug rules: see TENANT_SLUG_REGEX + RESERVED_TENANT_SLUGS in
 * @agentic/contracts/tenants. Slug is immutable — PUT rejects any body
 * field other than name/subtitle/color (via `.strict()` on the Zod schema).
 *
 * Authorization: platform-wide mutations require a superadmin permission;
 * tenant reads/updates are membership-scoped. The authenticated user id is
 * also the audit actor — no seeded-user fallback is used.
 */

import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import {
  apiTokens,
  auditLog,
  deployments,
  getDb,
  isTenantInngestDeploymentEnabled,
  memberships,
  TENANT_INNGEST_DEPLOYMENT_NOTE,
  TENANT_INNGEST_DISABLED_VERSION,
  tenantBudgets,
  tenantInngestDeploymentMarkerId,
  tenants,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import {
  TENANT_SLUG_REGEX,
  TenantArchiveBody,
  TenantCreateBody,
  TenantInngestDeploymentBody,
  TenantRestoreBody,
  TenantUpdateBody,
  isReservedSlug,
} from "@agentic/contracts";
import { requireAuth } from "../../plugins/auth";
import { requirePermission } from "../../plugins/rbac";
import {
  TenantLifecycleError,
  transitionTenantLifecycle,
} from "../../services/tenant-lifecycle";
import {
  getTenantDetail,
  listTenantsWithCounts,
  tenantHasActiveWork,
} from "../../queries/tenants";
import {
  claimIdempotency,
  completeIdempotency,
  idempotencyFingerprint,
  readIdempotencyKey,
  releaseIdempotency,
} from "../../services/idempotency";
import {
  TenantInngestDeploymentError,
  transitionTenantInngestDeployment,
  type TenantInngestRuntimeReceipt,
} from "../../services/tenant-inngest-deployment";
import { isTenantInProcessDeploymentScope } from "../../services/tenant-deployment-scope";
// P5-TEN-01 — a tenant mutation is not complete until its rebuilt app has been
// accepted by the real Inngest control plane. Never report a deferred success.
async function reregisterInngestRequired(slug: string): Promise<number> {
  const [{ reregisterInngest }, { syncTenantApp }] = await Promise.all([
    import("../../services/inngest-registry"),
    import("../../services/inngest-sync"),
  ]);
  const out = await reregisterInngest({ tenantSlug: slug, scope: "tenant" });
  const sync = await syncTenantApp(slug);
  if (!sync.ok) {
    throw new Error(
      `Inngest app registration failed for ${slug}: ${sync.error ?? `HTTP ${sync.status ?? "unknown"}`}`,
    );
  }
  if (out.appFnCount === undefined) {
    throw new Error(
      `Inngest registry did not return a scoped function count for ${slug}`,
    );
  }
  return out.appFnCount;
}

async function synchronizeTenantInngestDeployment(
  slug: string,
): Promise<TenantInngestRuntimeReceipt> {
  const [
    { appIdForTenant },
    { reregisterInngest, servePathForSlug },
    { syncTenantApp, verifyTenantAppRegistration },
  ] = await Promise.all([
    import("@agentic/runtime"),
    import("../../services/inngest-registry"),
    import("../../services/inngest-sync"),
  ]);
  const registered = await reregisterInngest({
    tenantSlug: slug,
    scope: "tenant",
  });
  if (registered.appFnCount === undefined) {
    throw new Error(
      `Inngest registry did not return a scoped function count for ${slug}`,
    );
  }
  const sync = await syncTenantApp(slug);
  if (!sync.ok) {
    throw new Error(
      `Inngest app registration failed for ${slug}: ${sync.error ?? `HTTP ${sync.status ?? "unknown"}`}`,
    );
  }

  // Empty apps intentionally have no dispatch connection; the accepted PUT is
  // the broker receipt that removes all functions. Non-empty deployments also
  // require the independent function-count probe to converge exactly.
  if (registered.appFnCount > 0) {
    const verification = await verifyTenantAppRegistration(
      slug,
      registered.appFnCount,
    );
    if (!verification.verified) {
      throw new Error(
        `Inngest function count verification failed for ${slug}: ${verification.error ?? `expected ${registered.appFnCount}, observed ${verification.observedFunctionCount ?? "unknown"}`}`,
      );
    }
  }

  return {
    appId: registered.appId ?? appIdForTenant(slug),
    servePath: servePathForSlug(slug),
    functionCount: registered.appFnCount,
    brokerVerified: true,
  };
}

/**
 * Resolve the on-disk root where tenant code packages get extracted. Matches
 * `@agentic/runtime#dataTenantsRoot()` when that helper is available; falls
 * back to `${cwd}/data/tenants` otherwise. Kept inline so this route file
 * compiles against any version of @agentic/runtime.
 */
function tenantsCodeRoot(): string {
  const env = process.env.AGENTIC_TENANTS_DIR;
  if (env && env.length > 0) return env;
  return path.join(process.cwd(), "data", "tenants");
}

function canReadTenant(
  auth: ReturnType<typeof requireAuth>,
  tenantId: string,
): boolean {
  if (auth.platformRole === "superadmin") return true;
  if (!auth.userId) return auth.tenantId === tenantId;
  return !!getDb()
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, auth.userId),
        eq(memberships.tenantId, tenantId),
      ),
    )
    .all()[0];
}

/**
 * Hash an opaque token the same way auth.ts does, so the mint flow stays
 * compatible with the existing bearer-token lookup.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mintBootstrapToken(): { plaintext: string; hash: string } {
  // 32 bytes of entropy is overkill but free; the `agentic_` prefix lets us
  // recognize our own tokens in operator logs.
  const raw = crypto.randomBytes(32).toString("base64url");
  const plaintext = `agentic_${raw}`;
  return { plaintext, hash: hashToken(plaintext) };
}

/**
 * mkdir -p the per-tenant data directories. Filesystem provisioning is part
 * of tenant creation: a tenant is not reported as ready when its durable
 * storage roots could not be created.
 */
function tenantProvisionRoots(slug: string): string[] {
  const repoRoot = process.cwd();
  // Walk up to find the data/ directory the same way db/client.ts does.
  // For correctness we use process.env.AGENTIC_DATA_ROOT when set.
  const dataRoot = process.env.AGENTIC_DATA_ROOT ?? path.join(repoRoot, "data");
  return [
    path.join(dataRoot, "logs", slug),
    path.join(dataRoot, "artifacts", slug),
    path.join(tenantsCodeRoot(), slug),
  ];
}

async function ensureTenantDirs(roots: string[]): Promise<void> {
  await Promise.all([
    fs.mkdir(path.join(roots[0]!, "runs"), { recursive: true }),
    fs.mkdir(path.join(roots[0]!, "events"), { recursive: true }),
    fs.mkdir(roots[1]!, { recursive: true }),
    fs.mkdir(roots[2]!, { recursive: true }),
  ]);
}

/**
 * Creation spans SQLite, the filesystem, and the in-memory/Inngest registry.
 * Compensate the committed SQLite transaction if a later provisioning step
 * fails so a retry never encounters a tenant that was previously reported as
 * failed but is actually half-created.
 */
async function rollbackProvisioning(
  tenantId: string,
  slug: string,
  provisionedRoots: string[],
  cause: unknown,
): Promise<never> {
  const original = cause instanceof Error ? cause : new Error(String(cause));
  const cleanupErrors: Error[] = [];
  let databaseRemoved = false;

  try {
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
    databaseRemoved = true;
  } catch (error) {
    cleanupErrors.push(
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  if (databaseRemoved) {
    try {
      const [{ appIdForTenant }, { unregisterApp }] = await Promise.all([
        import("@agentic/runtime"),
        import("../../services/inngest-registry"),
      ]);
      unregisterApp(appIdForTenant(slug));
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    const settled = await Promise.allSettled(
      provisionedRoots.map((root) =>
        fs.rm(root, { recursive: true, force: true }),
      ),
    );
    for (const result of settled) {
      if (result.status === "rejected") {
        cleanupErrors.push(
          result.reason instanceof Error
            ? result.reason
            : new Error(String(result.reason)),
        );
      }
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [original, ...cleanupErrors],
      `tenant ${slug} provisioning failed and compensation was incomplete`,
    );
  }
  throw original;
}

interface CreateResult {
  body: {
    ok: true;
    data: unknown;
  };
  status: 201;
}

interface TenantCreateOperation {
  tenantId: string;
  tokenId: string;
  auditId: string;
  createdAt: number;
  tokenMaterial: { plaintext: string; hash: string } | null;
  operatorUserId: string | null;
  callerSlug: string;
}

function createOperation(
  body: TenantCreateBody,
  operatorUserId: string | null,
  callerSlug: string,
): TenantCreateOperation {
  return {
    tenantId: makeId("ten"),
    tokenId: makeId("tok"),
    auditId: makeId("aud"),
    createdAt: Date.now(),
    tokenMaterial: body.mintToken ? mintBootstrapToken() : null,
    operatorUserId,
    callerSlug,
  };
}

async function performCreate(
  body: TenantCreateBody,
  operation: TenantCreateOperation,
): Promise<CreateResult> {
  const db = getDb();

  const existing = db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, body.slug))
    .all()[0];
  if (existing && existing.id !== operation.tenantId) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      `tenant slug "${body.slug}" already exists`,
    );
    err.statusCode = 409;
    err.code = "slug_taken";
    throw err;
  }

  const tenantId = operation.tenantId;
  const now = new Date(operation.createdAt);
  const tokenMaterial = operation.tokenMaterial;
  const tokenId = operation.tokenId;
  const auditId = operation.auditId;
  const operatorUserId = operation.operatorUserId;

  // Single transaction: tenant row + budget + membership + token + audit. If
  // any step throws, none persist and the slug remains available. Recovery of
  // a durable idempotency claim may find this exact tenant already committed;
  // in that case the transaction is known to have completed atomically and we
  // resume only filesystem/broker provisioning with the original stable ids.
  if (!existing)
    db.transaction((tx) => {
      tx.insert(tenants)
        .values({
          id: tenantId,
          slug: body.slug,
          name: body.name,
          subtitle: body.subtitle ?? null,
          color: body.color ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      // New empty tenants start stopped. Legacy tenants without a runtime
      // marker remain enabled for upgrade compatibility.
      tx.insert(deployments)
        .values({
          id: tenantInngestDeploymentMarkerId(tenantId),
          tenantId,
          target: "runtime",
          versionId: TENANT_INNGEST_DISABLED_VERSION,
          status: "live",
          deployedBy: operatorUserId,
          deployedAt: now,
          note: TENANT_INNGEST_DEPLOYMENT_NOTE,
        })
        .run();

      tx.insert(tenantBudgets)
        .values({
          tenantId,
          monthlyTokenCap: body.budget?.monthlyTokenCap ?? null,
          monthlyUsdCap: body.budget?.monthlyUsdCap ?? null,
          usedTokensMonth: 0,
          usedUsdMonth: 0,
          periodStart: now,
          updatedAt: now,
        })
        .run();

      if (operatorUserId) {
        tx.insert(memberships)
          .values({
            userId: operatorUserId,
            tenantId,
            role: "admin",
          })
          .onConflictDoNothing({
            target: [memberships.userId, memberships.tenantId],
          })
          .run();
      }

      if (tokenMaterial) {
        tx.insert(apiTokens)
          .values({
            id: tokenId,
            tenantId,
            hash: tokenMaterial.hash,
            name: "bootstrap",
            scopes: [
              "tenant:read",
              "tenant:write",
              "agents:invoke",
              "runs:read",
            ],
            createdAt: now,
          })
          .run();
      }

      tx.insert(auditLog)
        .values({
          id: auditId,
          tenantId,
          actorUserId: operatorUserId ?? null,
          action: "tenant.create",
          targetType: "tenant",
          targetId: tenantId,
          at: now,
          metaJson: {
            slug: body.slug,
            name: body.name,
            starter: body.starter,
            mintToken: body.mintToken,
            by_tenant: operation.callerSlug,
          } as never,
        })
        .run();
    });

  const provisionedRoots = tenantProvisionRoots(body.slug);
  let inngestFnCount: number;
  let detail: Awaited<ReturnType<typeof getTenantDetail>>;
  try {
    await ensureTenantDirs(provisionedRoots);
    inngestFnCount = await reregisterInngestRequired(body.slug);
    detail = await getTenantDetail(body.slug, { forUserId: operatorUserId });
    if (!detail)
      throw new Error(`tenant ${body.slug} disappeared after provisioning`);
  } catch (error) {
    return rollbackProvisioning(tenantId, body.slug, provisionedRoots, error);
  }

  const responseData = {
    tenant: detail,
    membership: { role: "admin" as const },
    token: tokenMaterial
      ? {
          id: tokenId,
          name: "bootstrap",
          plaintext: tokenMaterial.plaintext,
          scopes: ["tenant:read", "tenant:write", "agents:invoke", "runs:read"],
        }
      : null,
    starter: null,
    inngestFns: inngestFnCount,
  };

  return {
    body: { ok: true, data: responseData },
    status: 201,
  };
}

export async function tenantsRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /v1/tenants ────────────────────────────────────────────────────
  app.get<{ Querystring: { include_archived?: string } }>(
    "/tenants",
    async (req, reply) => {
      const auth = requireAuth(req);
      const includeArchived =
        req.query?.include_archived === "1" ||
        req.query?.include_archived === "true";

      const allItems = await listTenantsWithCounts({
        includeArchived,
        forUserId: auth.platformRole === "superadmin" ? null : auth.userId,
      });
      const items =
        auth.platformRole === "superadmin" || auth.userId
          ? allItems
          : allItems.filter((item) => item.slug === auth.tenantSlug);

      return reply.ok({
        items,
        count: items.length,
        viewer: {
          tenantId: auth.tenantId,
          tenantSlug: auth.tenantSlug,
          userId: auth.userId,
        },
      });
    },
  );

  // ── GET /v1/tenants/:slug/inngest-app ──────────────────────────────────
  // Per-tenant Inngest app status for the SaaS-ops view: the app id + serve
  // path this api serves locally, plus a live probe of how the Inngest server
  // sees it (connected / functionCount / error). `online` = the local app
  // serves ≥1 function; an archived / all-disabled tenant reads `offline`.
  app.get<{ Params: { slug: string } }>(
    "/tenants/:slug/inngest-app",
    async (req, reply) => {
      const auth = requireAuth(req);
      const slug = req.params.slug;
      if (!TENANT_SLUG_REGEX.test(slug)) {
        return reply.fail("invalid_slug", `slug "${slug}" is malformed`, 400);
      }
      const { appIdForTenant, tenantInngestConfigStatus } =
        await import("@agentic/runtime");
      const reg = await import("../../services/inngest-registry");
      const sync = await import("../../services/inngest-sync");
      const appId = appIdForTenant(slug);
      const tenant = getDb()
        .select()
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .all()[0];
      if (!tenant)
        return reply.fail(
          "tenant_not_found",
          `no tenant with slug "${slug}"`,
          404,
        );
      if (!canReadTenant(auth, tenant.id))
        return reply.fail("forbidden", "not a member of this tenant", 403);
      const inngestEnabled = isTenantInngestDeploymentEnabled(tenant.id);
      const local = reg.listRegisteredApps().find((a) => a.appId === appId);
      const probe = local ? await sync.probeApp(appId, slug) : null;
      const config = tenantInngestConfigStatus(slug);
      return reply.ok({
        slug,
        appId,
        enabled: inngestEnabled,
        processScoped: isTenantInProcessDeploymentScope(slug),
        servePath: local?.servePath ?? reg.servePathForSlug(slug),
        serveOrigin: config.serveOrigin,
        localFnCount: local?.fnCount ?? 0,
        status:
          config.readiness === "blocked"
            ? "blocked"
            : inngestEnabled && (local?.fnCount ?? 0) > 0
              ? "online"
              : "offline",
        config,
        inngest: probe,
      });
    },
  );

  // ── PUT /v1/tenants/:slug/inngest-deployment ─────────────────────────
  // Select whether this tenant's live manifest workflow is served to Inngest.
  // The state transition is durable, lease-serialized, broker-verified, and
  // compensated back to the previous state on any synchronization failure.
  app.put<{
    Params: { slug: string };
    Body: { enabled?: unknown };
  }>("/tenants/:slug/inngest-deployment", async (req, reply) => {
    const auth = requireAuth(req);
    const slug = req.params.slug;
    if (!TENANT_SLUG_REGEX.test(slug)) {
      return reply.fail("invalid_slug", `slug "${slug}" is malformed`, 400);
    }
    if (slug === "__system" || isReservedSlug(slug)) {
      return reply.fail(
        "system_app_managed_separately",
        "the platform Inngest app is managed separately from tenant workflows",
        400,
      );
    }
    const body = TenantInngestDeploymentBody.parse(req.body ?? {});

    const db = getDb();
    const row = db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .all()[0];
    if (!row) {
      return reply.fail(
        "tenant_not_found",
        `no tenant with slug "${slug}"`,
        404,
      );
    }

    let canManage = auth.platformRole === "superadmin";
    if (!canManage && auth.tenantId === row.id && auth.role === "admin") {
      canManage = true;
    }
    if (!canManage && auth.userId) {
      canManage =
        db
          .select({ role: memberships.role })
          .from(memberships)
          .where(
            and(
              eq(memberships.userId, auth.userId),
              eq(memberships.tenantId, row.id),
              eq(memberships.role, "admin"),
            ),
          )
          .all().length > 0;
    }
    if (!canManage) {
      return reply.fail(
        "forbidden",
        "must be an admin of this tenant to change its Inngest deployment",
        403,
      );
    }
    if (!isTenantInProcessDeploymentScope(slug)) {
      return reply.fail(
        "tenant_outside_process_scope",
        `tenant "${slug}" is assigned outside this API process by AGENTIC_ENABLED_TENANTS`,
        409,
      );
    }

    try {
      const result = await transitionTenantInngestDeployment(
        {
          tenantId: row.id,
          slug,
          enabled: body.enabled,
          actorUserId: auth.userId,
          callerSlug: auth.tenantSlug,
        },
        synchronizeTenantInngestDeployment,
      );
      return reply.ok({
        slug,
        enabled: body.enabled,
        changed: result.changed,
        appId: result.receipt.appId,
        servePath: result.receipt.servePath,
        functionCount: result.receipt.functionCount,
        status: body.enabled
          ? result.receipt.functionCount > 0
            ? "deployed"
            : "empty"
          : "stopped",
        brokerVerified: result.receipt.brokerVerified,
      });
    } catch (error) {
      if (error instanceof TenantInngestDeploymentError) {
        return reply.fail(error.code, error.message, error.statusCode);
      }
      throw error;
    }
  });

  // ── GET /v1/tenants/:slug ──────────────────────────────────────────────
  app.get<{ Params: { slug: string } }>(
    "/tenants/:slug",
    async (req, reply) => {
      const auth = requireAuth(req);
      const slug = req.params.slug;
      if (!TENANT_SLUG_REGEX.test(slug)) {
        return reply.fail("invalid_slug", `slug "${slug}" is malformed`, 400);
      }
      const row = getDb()
        .select()
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .all()[0];
      if (row && !canReadTenant(auth, row.id)) {
        return reply.fail("forbidden", "not a member of this tenant", 403);
      }
      const detail = await getTenantDetail(slug, { forUserId: auth.userId });
      if (!detail) {
        return reply.fail(
          "tenant_not_found",
          `no tenant with slug "${slug}"`,
          404,
        );
      }
      return reply.ok(detail);
    },
  );

  // ── POST /v1/tenants ───────────────────────────────────────────────────
  app.post("/tenants", async (req, reply) => {
    // P6-AUTH — creating a tenant is a platform-superadmin operation.
    const auth = requirePermission(req, "platform.tenants.create");
    const body = TenantCreateBody.parse(req.body);

    // Defense in depth: the Zod superRefine catches reserved slugs, but we
    // also guard against prefix/suffix patterns and direct-string matches.
    if (isReservedSlug(body.slug)) {
      return reply.fail(
        "reserved_slug",
        `slug "${body.slug}" is reserved and cannot be created`,
        400,
      );
    }

    const operatorUserId = auth.userId;
    const scope = "tenants.create";
    const fingerprint = idempotencyFingerprint(body);
    let idemKey: string | null;
    let operation = createOperation(body, operatorUserId, auth.tenantSlug);
    let claimOwnerToken: string | null = null;
    try {
      idemKey = readIdempotencyKey(req);
      if (idemKey) {
        const claim = claimIdempotency<TenantCreateOperation>({
          tenantId: auth.tenantId,
          key: idemKey,
          scope,
          fingerprint,
          operation,
        });
        if (claim.state === "replay") {
          return reply.status(claim.response.status).send(claim.response.body);
        }
        if (claim.state === "pending") {
          reply.header(
            "retry-after",
            String(Math.max(1, Math.ceil(claim.retryAfterMs / 1000))),
          );
          return reply.fail(
            "idempotency_in_progress",
            "an identical tenant creation is still in progress; retry with the same key",
            409,
          );
        }
        operation = claim.operation;
        claimOwnerToken = claim.ownerToken;
      }
    } catch (error) {
      const known = error as Error & { statusCode?: number; code?: string };
      if (known.statusCode && known.code) {
        return reply.fail(known.code, known.message, known.statusCode);
      }
      throw error;
    }

    let result: CreateResult;
    try {
      result = await performCreate(body, operation);
    } catch (err) {
      if (idemKey && claimOwnerToken) {
        try {
          releaseIdempotency({
            tenantId: auth.tenantId,
            key: idemKey,
            scope,
            fingerprint,
            ownerToken: claimOwnerToken,
          });
        } catch (releaseError) {
          req.log.error(
            { err: releaseError, slug: body.slug },
            "tenant.create: failed operation claim could not be released",
          );
          return reply.fail(
            "idempotency_release_failed",
            "tenant creation failed and its durable retry claim could not be released",
            503,
          );
        }
      }
      const e = err as Error & { statusCode?: number; code?: string };
      if (e.statusCode && e.code) {
        return reply.fail(e.code, e.message, e.statusCode);
      }
      throw err;
    }

    if (idemKey && claimOwnerToken) {
      try {
        completeIdempotency({
          tenantId: auth.tenantId,
          key: idemKey,
          scope,
          fingerprint,
          ownerToken: claimOwnerToken,
          response: { body: result.body, status: result.status },
        });
      } catch (error) {
        req.log.error(
          { err: error, slug: body.slug },
          "tenant.create: side effects completed but idempotency completion failed",
        );
        try {
          releaseIdempotency({
            tenantId: auth.tenantId,
            key: idemKey,
            scope,
            fingerprint,
            ownerToken: claimOwnerToken,
          });
        } catch (releaseError) {
          req.log.error(
            { err: releaseError, slug: body.slug },
            "tenant.create: incomplete idempotency claim could not be released",
          );
        }
        return reply.fail(
          "idempotency_store_failed",
          "tenant was provisioned, but its durable retry response could not be finalized; retry with the same key",
          503,
        );
      }
    }

    return reply.status(result.status).send(result.body);
  });

  // ── PUT /v1/tenants/:slug ──────────────────────────────────────────────
  app.put<{ Params: { slug: string } }>(
    "/tenants/:slug",
    async (req, reply) => {
      const auth = requireAuth(req);
      const slug = req.params.slug;
      const body = TenantUpdateBody.parse(req.body ?? {});

      const db = getDb();
      const row = db
        .select()
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .all()[0];
      if (!row) {
        return reply.fail(
          "tenant_not_found",
          `no tenant with slug "${slug}"`,
          404,
        );
      }

      // P6-AUTH — updating tenant attributes requires admin of THIS tenant or
      // a platform superadmin. (requirePermission checks the *active* tenant,
      // but the tenants page edits arbitrary rows, so we check :slug directly.)
      if (auth.platformRole !== "superadmin") {
        const m = db
          .select({ role: memberships.role })
          .from(memberships)
          .where(
            and(
              eq(memberships.userId, auth.userId ?? ""),
              eq(memberships.tenantId, row.id),
            ),
          )
          .all()[0];
        if (m?.role !== "admin") {
          return reply.fail(
            "forbidden",
            "must be an admin of this tenant",
            403,
          );
        }
      }

      const now = new Date();
      const update: Partial<typeof tenants.$inferInsert> = { updatedAt: now };
      if (body.name !== undefined) update.name = body.name;
      if (body.subtitle !== undefined) update.subtitle = body.subtitle;
      if (body.color !== undefined) update.color = body.color;

      db.transaction(() => {
        db.update(tenants).set(update).where(eq(tenants.id, row.id)).run();
        db.insert(auditLog)
          .values({
            id: makeId("aud"),
            tenantId: row.id,
            actorUserId: auth.userId,
            action: "tenant.update",
            targetType: "tenant",
            targetId: row.id,
            at: now,
            metaJson: {
              changed: Object.keys(update).filter((k) => k !== "updatedAt"),
              before: {
                name: row.name,
                subtitle: row.subtitle,
                color: row.color,
              },
              by_tenant: auth.tenantSlug,
            } as never,
          })
          .run();
      });

      const detail = await getTenantDetail(slug, {
        forUserId: auth.userId,
      });
      return reply.ok(detail);
    },
  );

  // ── DELETE /v1/tenants/:slug (soft-archive) ────────────────────────────
  app.delete<{ Params: { slug: string } }>(
    "/tenants/:slug",
    async (req, reply) => {
      // P6-AUTH — archiving a tenant is a platform-superadmin operation.
      const auth = requirePermission(req, "platform.tenants.archive");
      const slug = req.params.slug;
      const body = TenantArchiveBody.parse(req.body ?? {});

      if (body.confirm !== slug) {
        return reply.fail(
          "confirm_mismatch",
          `confirm must equal the slug ("${slug}")`,
          400,
        );
      }
      if (slug === "__system" || isReservedSlug(slug)) {
        return reply.fail(
          "cannot_archive_system",
          `system domain "${slug}" cannot be deleted`,
          400,
        );
      }

      const db = getDb();
      const row = db
        .select()
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .all()[0];
      if (!row) {
        return reply.fail(
          "tenant_not_found",
          `no tenant with slug "${slug}"`,
          404,
        );
      }
      if (row.archivedAt) {
        return reply.fail(
          "already_archived",
          `domain "${slug}" is already deleted`,
          409,
        );
      }

      const active = tenantHasActiveWork(row.id);
      if (active.runs > 0 || active.tasks > 0) {
        return reply.fail(
          "has_active_work",
          `domain has ${active.runs} active runs and ${active.tasks} open tasks; resolve them before deleting`,
          409,
        );
      }

      let changedAt: Date;
      try {
        ({ changedAt } = await transitionTenantLifecycle(
          {
            tenantId: row.id,
            slug,
            action: "archive",
            actorUserId: auth.userId,
            callerSlug: auth.tenantSlug,
            reason: body.reason ?? null,
          },
          reregisterInngestRequired,
        ));
      } catch (error) {
        if (error instanceof TenantLifecycleError) {
          return reply.fail(error.code, error.message, error.statusCode);
        }
        throw error;
      }

      return reply.ok({
        slug,
        archivedAt: changedAt.getTime(),
      });
    },
  );

  // ── POST /v1/tenants/:slug/restore ─────────────────────────────────────
  app.post<{ Params: { slug: string } }>(
    "/tenants/:slug/restore",
    async (req, reply) => {
      // P6-AUTH — restoring a tenant is a platform-superadmin operation.
      const auth = requirePermission(req, "platform.tenants.archive");
      const slug = req.params.slug;
      const body = TenantRestoreBody.parse(req.body ?? {});

      const db = getDb();
      const row = db
        .select()
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .all()[0];
      if (!row) {
        return reply.fail(
          "tenant_not_found",
          `no tenant with slug "${slug}"`,
          404,
        );
      }
      if (!row.archivedAt) {
        return reply.fail(
          "not_archived",
          `tenant "${slug}" is not archived`,
          409,
        );
      }

      try {
        await transitionTenantLifecycle(
          {
            tenantId: row.id,
            slug,
            action: "restore",
            actorUserId: auth.userId,
            callerSlug: auth.tenantSlug,
            reason: body.reason ?? null,
          },
          reregisterInngestRequired,
        );
      } catch (error) {
        if (error instanceof TenantLifecycleError) {
          return reply.fail(error.code, error.message, error.statusCode);
        }
        throw error;
      }

      const detail = await getTenantDetail(slug, {
        forUserId: auth.userId,
      });
      return reply.ok(detail);
    },
  );

  // Defensive: a poller hitting GET /tenants/active (very-common SPA mistake)
  // returns a useful 404 rather than 500 from Drizzle.
  void and;
  void isNull;
}
