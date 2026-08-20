/**
 * Production bootstrap — inserts the deployable tenant domains and exactly one
 * operator-supplied bootstrap administrator. Run via `pnpm db:seed`.
 *
 * No identity or credential is embedded in source. All three administrator
 * fields are mandatory: AGENTIC_BOOTSTRAP_ADMIN_EMAIL,
 * AGENTIC_BOOTSTRAP_ADMIN_NAME, and AGENTIC_BOOTSTRAP_ADMIN_PASSWORD.
 *
 * Idempotent: tenants are keyed by slug and the administrator is keyed by its
 * normalized email. Re-running refreshes that account's name, credential,
 * active/superadmin status, and admin membership in every deployable tenant.
 * Role-specific sample users belong in isolated tests, never production seed.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeId } from "@agentic/shared";
import { and, eq } from "drizzle-orm";
import { closeDb, getDb } from "./client";
import { hashPassword } from "./password";
import { memberships, tenants, users } from "./schema";

/**
 * Compatibility execution namespaces, not the target Business Domain
 * taxonomy. Runtime manifests, event names, credentials and tenant-native
 * adapters are still keyed by these slugs. In particular, `zhaopin` and
 * `agents-generation` must not be presented as proof that RAAS-v1 and
 * Agents-generation are separate business categories; consolidating them
 * under a canonical Recruitment Business Domain requires an explicit runtime
 * and data migration (see docs/design/business-domain-runtime-migration-decision.md).
 */
const DEPLOYABLE_TENANTS = [
  {
    slug: "__system",
    name: "System",
    subtitle: "Code-defined agents (cross-tenant)",
    color: "#6f7178",
  },
  {
    slug: "raas",
    name: "RAAS",
    subtitle: "Recruitment-as-a-Service",
    color: "#d0ff00",
  },
  {
    // Compatibility execution namespace for the faithful 1:1 migration of the
    // old AO recruitment flow (models/zhaopin-v1/). It is not an Ontology
    // Domain registration and must not be auto-merged into another tenant row.
    slug: "zhaopin",
    name: "RAAS-v1",
    subtitle: "招聘 6-agent 流水线 · JD/简历/查重/规则/匹配/面试邀约",
    color: "#65e0a3",
  },
  {
    // Compatibility execution namespace for the historical Agent Factory
    // deployment. The exact Allmeta identity now belongs in
    // business_ontology_domains under a selected Business Domain.
    slug: "agents-generation",
    name: "Agents-generation",
    subtitle: "Agent factory · live AllmetaOntology 本体",
    color: "#c4b5fd",
  },
] as const;

export interface BootstrapAdminConfig {
  email: string;
  name: string;
  password: string;
}

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required when running pnpm db:seed.`);
  }
  return value;
}

/** Parse and validate bootstrap identity without opening or mutating the DB. */
export function loadBootstrapAdminConfig(
  env: Record<string, string | undefined> = process.env,
): BootstrapAdminConfig {
  const email = requireEnv(env, "AGENTIC_BOOTSTRAP_ADMIN_EMAIL").toLowerCase();
  const name = requireEnv(env, "AGENTIC_BOOTSTRAP_ADMIN_NAME");
  const password = env.AGENTIC_BOOTSTRAP_ADMIN_PASSWORD ?? "";

  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("AGENTIC_BOOTSTRAP_ADMIN_EMAIL must be a valid email address.");
  }
  if (Buffer.byteLength(name, "utf8") > 200) {
    throw new Error("AGENTIC_BOOTSTRAP_ADMIN_NAME must be at most 200 bytes long.");
  }
  if (!password.trim()) {
    throw new Error("AGENTIC_BOOTSTRAP_ADMIN_PASSWORD is required when running pnpm db:seed.");
  }
  if (Buffer.byteLength(password, "utf8") < 12) {
    throw new Error("AGENTIC_BOOTSTRAP_ADMIN_PASSWORD must be at least 12 bytes long.");
  }

  return { email, name, password };
}

async function main() {
  // Validate all operator input before the first database access.
  const bootstrapAdmin = loadBootstrapAdminConfig();
  const passwordHash = hashPassword(bootstrapAdmin.password);
  const db = getDb();
  db.transaction((tx) => {
    const now = new Date();

    const tenantIds: Record<string, string> = {};
    for (const tenant of DEPLOYABLE_TENANTS) {
      const existing = tx
        .select()
        .from(tenants)
        .where(eq(tenants.slug, tenant.slug))
        .all()[0];
      if (existing) {
        tenantIds[tenant.slug] = existing.id;
        console.log(`[seed] tenant ${tenant.slug} exists → ${existing.id}`);
        continue;
      }
      const id = makeId("ten");
      tx.insert(tenants).values({ id, ...tenant }).run();
      tenantIds[tenant.slug] = id;
      console.log(`[seed] tenant ${tenant.slug} → ${id}`);
    }

    let userId: string;
    const existingAdmin = tx
      .select()
      .from(users)
      .where(eq(users.email, bootstrapAdmin.email))
      .all()[0];

    if (existingAdmin) {
      userId = existingAdmin.id;
      tx.update(users)
        .set({
          name: bootstrapAdmin.name,
          passwordHash,
          platformRole: "superadmin",
          status: "active",
          updatedAt: now,
        })
        .where(eq(users.id, userId))
        .run();
      console.log(
        `[seed] bootstrap admin ${bootstrapAdmin.email} exists → ${userId} (credential refreshed)`,
      );
    } else {
      userId = makeId("usr");
      tx.insert(users)
        .values({
          id: userId,
          email: bootstrapAdmin.email,
          name: bootstrapAdmin.name,
          passwordHash,
          platformRole: "superadmin",
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      console.log(`[seed] bootstrap admin ${bootstrapAdmin.email} → ${userId}`);
    }

    for (const [slug, tenantId] of Object.entries(tenantIds)) {
      const existingMembership = tx
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, userId),
            eq(memberships.tenantId, tenantId),
          ),
        )
        .all()[0];
      if (existingMembership) {
        if (existingMembership.role !== "admin") {
          tx.update(memberships)
            .set({ role: "admin" })
            .where(
              and(
                eq(memberships.userId, userId),
                eq(memberships.tenantId, tenantId),
              ),
            )
            .run();
          console.log(
            `[seed] ${bootstrapAdmin.email} → ${slug} (role refreshed to admin)`,
          );
        }
        continue;
      }
      tx.insert(memberships)
        .values({ userId, tenantId, role: "admin", createdAt: now })
        .run();
      console.log(`[seed] ${bootstrapAdmin.email} → ${slug} (admin)`);
    }
  });

  console.log("[seed] done — deployable tenants and one explicit bootstrap administrator are ready");
  closeDb();
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error("[seed] failed", error);
    closeDb();
    process.exit(1);
  });
}
