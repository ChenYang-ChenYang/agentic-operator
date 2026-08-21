/**
 * POST /v1/admin/users — admin-provisioned accounts.
 *
 * Distinct from /v1/auth/register (self-service, always platformRole "none",
 * never a membership): this route lets a superadmin set the platform role AND
 * grant an initial tenant in one commit. The tests below pin the parts that are
 * easy to regress — the pre-transaction tenant check, and the guarantee that a
 * rejected request leaves no half-created account behind.
 *
 * Dev mode resolves every request to the seeded superadmin, which is exactly
 * the caller this route requires.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, memberships, users } from "@agentic/db";
import { buildTestEnv, type TestEnv } from "./harness";

const SUFFIX = `${process.pid}`;
const NEW_EMAIL = `admin-created-${SUFFIX}@agentic.invalid`;
const DUPE_EMAIL = `admin-dupe-${SUFFIX}@agentic.invalid`;
const ORPHAN_EMAIL = `admin-orphan-${SUFFIX}@agentic.invalid`;
const PASS = "admin-created-password";

let env: TestEnv;

async function createUser(body: unknown): Promise<Response> {
  return env.fetch("/v1/admin/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Remove a fixture account through the API's own delete route. Deleting the row
 * directly trips `audit_log.actor_user_id`'s FK (this route writes an audit
 * entry naming the actor), and hand-mirroring the six nullings that route does
 * would silently rot the moment another table gains a users FK.
 */
async function purge(email: string): Promise<void> {
  const row = getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .all()[0];
  if (!row) return;
  await env.fetch(`/v1/admin/users/${row.id}`, { method: "DELETE" });
}

describe("POST /v1/admin/users", () => {
  beforeAll(async () => {
    env = await buildTestEnv();
    for (const email of [NEW_EMAIL, DUPE_EMAIL, ORPHAN_EMAIL]) await purge(email);
  });

  afterAll(async () => {
    for (const email of [NEW_EMAIL, DUPE_EMAIL, ORPHAN_EMAIL]) await purge(email);
    await env.cleanup();
  });

  it("creates an account with a platform role and an initial membership", async () => {
    const res = await createUser({
      email: NEW_EMAIL,
      name: "Admin Created",
      password: PASS,
      platformRole: "none",
      membership: { tenantSlug: "raas", role: "operator" },
    });
    expect(res.status).toBe(201);

    const created = getDb()
      .select()
      .from(users)
      .where(eq(users.email, NEW_EMAIL))
      .all()[0];
    expect(created).toBeDefined();
    expect(created?.platformRole).toBe("none");
    expect(created?.status).toBe("active");

    // The grant must land in the SAME commit — an account with no membership
    // reads to the user as a broken login.
    const grants = getDb()
      .select()
      .from(memberships)
      .where(eq(memberships.userId, created!.id))
      .all();
    expect(grants).toHaveLength(1);
    expect(grants[0]?.role).toBe("operator");
  });

  it("issues a credential the new account can actually log in with", async () => {
    const res = await env.fetch("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: NEW_EMAIL, password: PASS }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects a duplicate email with 409 and does not touch the existing row", async () => {
    const first = await createUser({
      email: DUPE_EMAIL,
      name: "First",
      password: PASS,
    });
    expect(first.status).toBe(201);

    const second = await createUser({
      email: DUPE_EMAIL,
      name: "Second",
      password: PASS,
    });
    expect(second.status).toBe(409);

    const rows = getDb().select().from(users).where(eq(users.email, DUPE_EMAIL)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("First");
  });

  it("404s an unknown tenant WITHOUT leaving a half-created account behind", async () => {
    const res = await createUser({
      email: ORPHAN_EMAIL,
      name: "Orphan",
      password: PASS,
      membership: { tenantSlug: "no-such-tenant", role: "admin" },
    });
    expect(res.status).toBe(404);

    const rows = getDb().select().from(users).where(eq(users.email, ORPHAN_EMAIL)).all();
    expect(rows).toHaveLength(0);
  });

  it("enforces the shared password minimum", async () => {
    const res = await createUser({
      email: `admin-short-${SUFFIX}@agentic.invalid`,
      name: "Too Short",
      password: "short",
    });
    expect(res.status).toBe(400);
  });
});
