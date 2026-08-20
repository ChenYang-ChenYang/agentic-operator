import { factorySourceOntologyHash } from "@agentic/agent-factory";
import { FsUploadedOntologyStore } from "../src/services/agent-factory/uploaded-ontology-store";

const store = new FsUploadedOntologyStore();

export async function installOntoCodeTestOntology(input: {
  tenantSlug: string;
  domainId: string;
  name?: string;
  actionName?: string;
}): Promise<{ ontologyHash: string; remove: () => Promise<void> }> {
  await store.save(
    input.tenantSlug,
    input.name ?? input.domainId,
    {
      actions: [
        {
          id: `action-${input.domainId}`,
          name: input.actionName ?? "testAction",
          actor: ["Agent"],
          trigger: [],
          triggered_event: [],
          target_objects: [],
          tool_use: [],
        },
      ],
      events: [],
      objects: [],
      rules: [],
      workflow: [],
    },
    input.domainId,
  );
  const ontology = await store.get(input.tenantSlug, input.domainId);
  if (!ontology) {
    throw new Error(
      `failed to install OntoCode test ontology ${input.domainId}`,
    );
  }
  return {
    ontologyHash: factorySourceOntologyHash(ontology),
    remove: async () => {
      await store.delete(input.tenantSlug, input.domainId);
    },
  };
}
