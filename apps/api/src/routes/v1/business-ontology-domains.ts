import type { FastifyInstance } from "fastify";
import {
  ArchiveBusinessOntologyDomainRequestSchema,
  BindBusinessOntologyDomainRuntimeProfileRequestSchema,
  BusinessOntologyDomainCatalogReceiptSchema,
  BusinessOntologyDomainListReceiptSchema,
  BusinessOntologyDomainMutationReceiptSchema,
  BusinessOntologyDomainOntologyReceiptSchema,
  CreateBusinessOntologyDomainRequestSchema,
  ListBusinessOntologyDomainsQuerySchema,
  UpdateBusinessOntologyDomainRequestSchema,
} from "@agentic/contracts";
import { requirePermission, writeAudit } from "../../plugins/rbac";
import {
  archiveBusinessOntologyDomain,
  bindBusinessOntologyDomainRuntimeProfile,
  BusinessOntologyDomainStoreError,
  getBusinessOntologyDomain,
  listBusinessOntologyDomainCatalog,
  listBusinessOntologyDomains,
  readBusinessOntologyDomainOntology,
  registerBusinessOntologyDomain,
  updateBusinessOntologyDomain,
  verifyBusinessOntologyDomain,
  type BusinessOntologyDomainContext,
} from "../../services/business-ontology-domain-store";
import { withFactoryTenantLock } from "../../services/agent-factory/tenant-lock";

export async function businessOntologyDomainRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof BusinessOntologyDomainStoreError) {
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
  ): BusinessOntologyDomainContext => ({
    tenantId: auth.tenantId,
    tenantSlug: auth.tenantSlug,
    actorId: auth.userId ?? auth.credentialId ?? null,
  });

  app.get("/business-ontology-domains", async (req, reply) => {
    const auth = requirePermission(req, "workflows.read");
    const query = ListBusinessOntologyDomainsQuerySchema.parse(req.query);
    reply.header("Cache-Control", "no-store");
    return reply.ok(
      BusinessOntologyDomainListReceiptSchema.parse(
        listBusinessOntologyDomains(context(auth), query),
      ),
    );
  });

  app.get("/business-ontology-domains/catalog", async (req, reply) => {
    const auth = requirePermission(req, "workflows.read");
    reply.header("Cache-Control", "no-store");
    return reply.ok(
      BusinessOntologyDomainCatalogReceiptSchema.parse(
        await listBusinessOntologyDomainCatalog(context(auth)),
      ),
    );
  });

  app.get<{ Params: { registrationId: string } }>(
    "/business-ontology-domains/:registrationId",
    async (req, reply) => {
      const auth = requirePermission(req, "workflows.read");
      reply.header("Cache-Control", "no-store");
      return reply.ok({
        domain: getBusinessOntologyDomain(
          context(auth),
          req.params.registrationId,
        ),
      });
    },
  );

  app.get<{ Params: { registrationId: string } }>(
    "/business-ontology-domains/:registrationId/ontology",
    async (req, reply) => {
      const auth = requirePermission(req, "workflows.read");
      reply.header("Cache-Control", "no-store");
      return reply.ok(
        BusinessOntologyDomainOntologyReceiptSchema.parse(
          await readBusinessOntologyDomainOntology(
            context(auth),
            req.params.registrationId,
          ),
        ),
      );
    },
  );

  app.post("/business-ontology-domains", async (req, reply) => {
    const auth = requirePermission(req, "workflows.write");
    const input = CreateBusinessOntologyDomainRequestSchema.parse(req.body);
    return withFactoryTenantLock(auth.tenantId, async () => {
      const receipt = BusinessOntologyDomainMutationReceiptSchema.parse(
        await registerBusinessOntologyDomain(context(auth), input),
      );
      writeAudit(auth, {
        action: "business_ontology_domain.register",
        targetType: "ontology_domain_registration",
        targetId: receipt.domain.id,
        meta: {
          ontologyDomainId: receipt.domain.ontologyDomainId,
          source: receipt.domain.source,
          mode: receipt.mode,
        },
      });
      return reply.ok(receipt, receipt.mode === "created" ? 201 : 200);
    });
  });

  app.patch<{ Params: { registrationId: string } }>(
    "/business-ontology-domains/:registrationId",
    async (req, reply) => {
      const auth = requirePermission(req, "workflows.write");
      const input = UpdateBusinessOntologyDomainRequestSchema.parse(req.body);
      return withFactoryTenantLock(auth.tenantId, async () => {
        const receipt = BusinessOntologyDomainMutationReceiptSchema.parse(
          updateBusinessOntologyDomain(
            context(auth),
            req.params.registrationId,
            input,
          ),
        );
        writeAudit(auth, {
          action: "business_ontology_domain.update",
          targetType: "ontology_domain_registration",
          targetId: receipt.domain.id,
          meta: {
            ontologyDomainId: receipt.domain.ontologyDomainId,
            makeDefault: input.makeDefault === true,
          },
        });
        return reply.ok(receipt);
      });
    },
  );

  app.post<{ Params: { registrationId: string } }>(
    "/business-ontology-domains/:registrationId/verify",
    async (req, reply) => {
      const auth = requirePermission(req, "workflows.write");
      return withFactoryTenantLock(auth.tenantId, async () => {
        const receipt = BusinessOntologyDomainMutationReceiptSchema.parse(
          await verifyBusinessOntologyDomain(
            context(auth),
            req.params.registrationId,
          ),
        );
        writeAudit(auth, {
          action: "business_ontology_domain.verify",
          targetType: "ontology_domain_registration",
          targetId: receipt.domain.id,
          meta: {
            ontologyDomainId: receipt.domain.ontologyDomainId,
            ontologySnapshotHash: receipt.domain.ontologySnapshotHash,
          },
        });
        return reply.ok(receipt);
      });
    },
  );

  app.put<{ Params: { registrationId: string } }>(
    "/business-ontology-domains/:registrationId/runtime-profile",
    async (req, reply) => {
      const auth = requirePermission(req, "workflows.write");
      const input =
        BindBusinessOntologyDomainRuntimeProfileRequestSchema.parse(req.body);
      return withFactoryTenantLock(auth.tenantId, async () => {
        const receipt = BusinessOntologyDomainMutationReceiptSchema.parse(
          bindBusinessOntologyDomainRuntimeProfile(
            context(auth),
            req.params.registrationId,
            input.runtimeProfileVersionId,
          ),
        );
        writeAudit(auth, {
          action: "business_ontology_domain.runtime_profile.bind",
          targetType: "ontology_domain_registration",
          targetId: receipt.domain.id,
          meta: {
            ontologyDomainId: receipt.domain.ontologyDomainId,
            runtimeProfileVersionId: input.runtimeProfileVersionId,
          },
        });
        return reply.ok(receipt);
      });
    },
  );

  app.delete<{ Params: { registrationId: string } }>(
    "/business-ontology-domains/:registrationId",
    async (req, reply) => {
      const auth = requirePermission(req, "workflows.write");
      const input = ArchiveBusinessOntologyDomainRequestSchema.parse(req.body);
      return withFactoryTenantLock(auth.tenantId, async () => {
        const receipt = BusinessOntologyDomainMutationReceiptSchema.parse(
          archiveBusinessOntologyDomain(
            context(auth),
            req.params.registrationId,
            input.confirmOntologyDomainId,
          ),
        );
        writeAudit(auth, {
          action: "business_ontology_domain.archive",
          targetType: "ontology_domain_registration",
          targetId: receipt.domain.id,
          meta: {
            ontologyDomainId: receipt.domain.ontologyDomainId,
          },
        });
        return reply.ok(receipt);
      });
    },
  );
}
