import type { FastifyInstance } from "fastify";
import {
  ArchiveRuntimeProfileRequestSchema,
  BootstrapRecruitmentRuntimeProfilesRequestSchema,
  BootstrapRecruitmentRuntimeProfilesReceiptSchema,
  CreateRuntimeProfileRequestSchema,
  CreateRuntimeProfileVersionRequestSchema,
  ListRuntimeProfilesQuerySchema,
  RuntimeProfileListReceiptSchema,
  RuntimeProfileMutationReceiptSchema,
} from "@agentic/contracts";
import { requirePermission, writeAudit } from "../../plugins/rbac";
import {
  archiveRuntimeProfile,
  createRuntimeProfile,
  createRuntimeProfileVersion,
  listRuntimeProfiles,
  RuntimeProfileStoreError,
  type RuntimeProfileContext,
} from "../../services/runtime-profile-store";
import {
  bootstrapCanonicalRecruitmentRuntimeProfiles,
  CanonicalRecruitmentBootstrapError,
} from "../../services/canonical-recruitment-bootstrap";
import { withFactoryTenantLock } from "../../services/agent-factory/tenant-lock";

export async function runtimeProfileRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.setErrorHandler((error, _req, reply) => {
    if (
      error instanceof RuntimeProfileStoreError ||
      error instanceof CanonicalRecruitmentBootstrapError
    ) {
      return reply.fail(
        error.code,
        error.message,
        error.statusCode,
        undefined,
        error.details,
      );
    }
    throw error;
  });

  const context = (
    auth: ReturnType<typeof requirePermission>,
  ): RuntimeProfileContext => ({
    tenantId: auth.tenantId,
    tenantSlug: auth.tenantSlug,
    actorId: auth.userId ?? auth.credentialId ?? null,
  });

  app.get("/runtime-profiles", async (req, reply) => {
    const auth = requirePermission(req, "workflows.read");
    const query = ListRuntimeProfilesQuerySchema.parse(req.query);
    const items = listRuntimeProfiles(context(auth), query);
    reply.header("Cache-Control", "no-store");
    return reply.ok(
      RuntimeProfileListReceiptSchema.parse({
        items,
        count: items.length,
      }),
    );
  });

  app.post("/runtime-profiles", async (req, reply) => {
    // A compatibility profile deliberately changes another tenant's product
    // classification, so creation remains a platform operation.
    const auth = requirePermission(req, "platform.tenants.create");
    const input = CreateRuntimeProfileRequestSchema.parse(req.body);
    const receipt = await withFactoryTenantLock(auth.tenantId, async () =>
      RuntimeProfileMutationReceiptSchema.parse(
        createRuntimeProfile(context(auth), input),
      ),
    );
    writeAudit(auth, {
      action: "runtime_profile.create",
      targetType: "runtime_profile",
      targetId: receipt.profile.id,
      meta: {
        runtimeProfileVersionId: receipt.version?.id ?? null,
        adapterRegistrySlug:
          receipt.version?.adapter.adapterRegistrySlug ?? null,
        credentialScope: "business_domain",
      },
    });
    return reply.ok(receipt, 201);
  });

  app.post<{ Params: { profileId: string } }>(
    "/runtime-profiles/:profileId/versions",
    async (req, reply) => {
      const auth = requirePermission(req, "platform.tenants.create");
      const input = CreateRuntimeProfileVersionRequestSchema.parse(req.body);
      const receipt = await withFactoryTenantLock(auth.tenantId, async () =>
        RuntimeProfileMutationReceiptSchema.parse(
          createRuntimeProfileVersion(
            context(auth),
            req.params.profileId,
            input,
          ),
        ),
      );
      writeAudit(auth, {
        action: "runtime_profile.version.create",
        targetType: "runtime_profile",
        targetId: receipt.profile.id,
        meta: {
          runtimeProfileVersionId: receipt.version?.id ?? null,
          version: receipt.version?.version ?? null,
          credentialScope: "business_domain",
        },
      });
      return reply.ok(receipt, 201);
    },
  );

  app.delete<{ Params: { profileId: string } }>(
    "/runtime-profiles/:profileId",
    async (req, reply) => {
      const auth = requirePermission(req, "platform.tenants.archive");
      const input = ArchiveRuntimeProfileRequestSchema.parse(req.body);
      const receipt = await withFactoryTenantLock(auth.tenantId, async () =>
        RuntimeProfileMutationReceiptSchema.parse(
          archiveRuntimeProfile(
            context(auth),
            req.params.profileId,
            input.confirmName,
          ),
        ),
      );
      writeAudit(auth, {
        action: "runtime_profile.archive",
        targetType: "runtime_profile",
        targetId: receipt.profile.id,
        meta: { name: receipt.profile.name },
      });
      return reply.ok(receipt);
    },
  );

  app.post("/runtime-profiles/bootstrap-recruitment", async (req, reply) => {
    const auth = requirePermission(req, "platform.tenants.create");
    const input =
      BootstrapRecruitmentRuntimeProfilesRequestSchema.parse(req.body);
    const receipt =
      await bootstrapCanonicalRecruitmentRuntimeProfiles(
        input,
        auth.userId ?? auth.credentialId ?? null,
      );
    writeAudit(auth, {
      action: "runtime_profile.bootstrap_recruitment",
      targetType: "tenant",
      targetId: receipt.businessDomainTenantId,
      meta: {
        businessDomainSlug: receipt.businessDomainSlug,
        registrations: receipt.items.map((item) => ({
          ontologyDomainRegistrationId:
            item.ontologyDomainRegistrationId,
          runtimeProfileVersionId: item.runtimeProfileVersionId,
        })),
        credentialScope: "business_domain",
      },
    });
    return reply.ok(
      BootstrapRecruitmentRuntimeProfilesReceiptSchema.parse(receipt),
    );
  });
}

