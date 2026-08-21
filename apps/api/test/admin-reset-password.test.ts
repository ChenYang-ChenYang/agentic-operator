/**
 * PATCH /v1/admin/users/:id { password } — admin password reset.
 *
 * Distinct from POST /v1/me/password (self-service, proves the current
 * password): this is a superadmin acting on someone else's account, so it
 * cannot know the old value. The tests below pin the three things that make
 * that safe — the new password actually authenticates, the length floor is
 * enforced, and the audit trail records that a reset happened without ever
 * storing the plaintext.
 *
 * Dev mode resolves every request to the seeded superadmin, which is exactly
 * the caller this route requires.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, getDb, users } from "@agentic/db";
import { buildTestEnv, type TestEnv } from "./harness";

const SUFFIX = `${process.pid}`;
const EMAIL = `admin-reset-${SUFFIX}@agentic.invalid`;
const OLD_PASS = "original-password-1";
const NEW_PASS = "rotated-password-2";

let env: TestEnv;
let userId: string;

async function purge(email: string): Promise<void> {
  const row = getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .all()[0];
  if (!row) return;
  await env.fetch(`/v1/admin/users/${row.id}`, { method: "DELETE" });
}

const login = (password: string) =>
  env.fetch("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password }),
  });

const reset = (password: unknown) =>
  env.fetch(`/v1/admin/users/${userId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });

describe("PATCH /v1/admin/users/:id { password }", () => {
  beforeAll(async () => {
    env = await buildTestEnv();
    await purge(EMAIL);
    const res = await env.fetch("/v1/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: EMAIL,
        name: "Reset Fixture",
        password: OLD_PASS,
      }),
    });
    expect(res.status).toBe(201);
    userId = getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, EMAIL))
      .all()[0]!.id;
  });

  afterAll(async () => {
    await purge(EMAIL);
    await env.cleanup();
  });

  it("replaces the password without knowing the old one", async () => {
    expect((await login(OLD_PASS)).status).toBe(200);

    const res = await reset(NEW_PASS);
    expect(res.status).toBe(200);

    expect((await login(NEW_PASS)).status).toBe(200);
    // The old credential must stop working the moment the new one lands.
    expect((await login(OLD_PASS)).status).toBe(401);
  });

  it("enforces the same length floor as the self-service path", async () => {
    const res = await reset("short");
    expect(res.status).toBe(400);
    // Rejected input must not have touched the stored hash.
    expect((await login(NEW_PASS)).status).toBe(200);
  });

  it("rejects a patch carrying no field at all", async () => {
    const res = await env.fetch(`/v1/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("audits the reset without recording the plaintext", async () => {
    const entries = getDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, userId))
      .all()
      .filter((e) => e.action === "platform.user.update");
    expect(entries.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(entries);
    expect(serialized).toContain("passwordReset");
    expect(serialized).not.toContain(NEW_PASS);
    expect(serialized).not.toContain(OLD_PASS);
  });
});
