import { describe, expect, it } from "vitest";
import {
  resolveIntegrationBindings,
  type IntegrationBindingStatus,
  type OntologyAction,
  type RealTool,
} from "@agentic/agent-factory";
import { listGlobalTools } from "@agentic/tools";

const tools = (): RealTool[] => listGlobalTools().map((tool) => ({
  name: tool.name,
  aliases: tool.aliases,
  category: tool.category,
  sideEffect: tool.sideEffect,
  operation: tool.operation,
  effectScope: tool.effectScope,
  sandboxPolicy: tool.sandboxPolicy,
  configKeys: tool.configSchema ? Object.keys(tool.configSchema) : [],
  credentialEnv: tool.credentialEnv ?? [],
  capabilities: tool.capabilities ?? [],
  probeStatus: tool.probeRequired ? "required" : "verified",
  catalogDefinition: {
    name: tool.name,
    category: tool.category,
    sourcePath: tool.sourcePath,
    sideEffect: tool.sideEffect,
    operation: tool.operation,
    effectScope: tool.effectScope,
    sandboxPolicy: tool.sandboxPolicy,
    argsSchema: tool.argsSchema,
    returnsSchema: tool.returnsSchema,
    configSchema: tool.configSchema,
    ...(tool.configContract !== undefined ? { configContract: tool.configContract } : {}),
    capabilities: tool.capabilities,
    profileScope: tool.profileScope,
    probeSafety: tool.probeSafety,
  },
}));

function action(input: {
  name: string;
  tool: string;
  system: string;
  kind: string;
  role: string;
  capability?: string;
  objects: string[];
}): OntologyAction {
  return {
    id: input.name,
    name: input.name,
    actor: ["Agent"],
    trigger: [],
    triggered_event: [],
    target_objects: [],
    tool_use: [input.tool],
    system_prompt: "",
    user_prompt: "",
    integration: {
      systems: [{
        name: input.system,
        kind: input.kind,
        role: input.role,
        ...(input.capability ? { capability: input.capability } : {}),
        objects: input.objects,
      }],
    },
  };
}

function bindingStatus(input: Parameters<typeof action>[0]): IntegrationBindingStatus {
  return resolveIntegrationBindings(action(input), tools(), {
    boundToolNames: [input.tool],
    toolConfigs: {},
    env: {},
  }).bindings[0]!.status;
}

describe("reviewed Ontology to real global tool capability alignment", () => {
  it.each([
    {
      name: "createJD",
      tool: "generateJdApi",
      system: "GoHire_System",
      kind: "external_api",
      role: "execute",
      capability: "jd.generate — POST /api/v1/jobs/generate-jd",
      objects: ["Job_Posting"],
    },
    {
      name: "processResume",
      tool: "parseResumeApi",
      system: "GoHire_System",
      kind: "external_api",
      role: "execute",
      capability: "resume.parse — POST /api/v1/parse-resume",
      objects: ["Resume", "Candidate"],
    },
    {
      name: "matchResume",
      tool: "matchResumeApi",
      system: "GoHire_System",
      kind: "external_api",
      role: "execute",
      capability: "resume.match — POST /match-resume",
      objects: ["Candidate_Match_Result"],
    },
    {
      name: "inviteInternalInterview",
      tool: "inviteCandidateApi",
      system: "GoHire_System",
      kind: "external_api",
      role: "execute",
      capability: "interview.invite — POST /api/v1/invite-candidate",
      objects: ["Interview_Record", "Communication_Log"],
    },
  ])("recognizes $tool without treating missing evidence as success", (input) => {
    // parse-resume and match-resume carry probeRequired=true in the catalog, so
    // with no verified probe they resolve to the stricter `needs_probe`; the
    // others (no probe requirement) resolve to `needs_config`. Both are
    // evidence-gated — the point of this test is that neither is treated as a
    // resolved/success binding when the supporting evidence is absent.
    const expected =
      input.tool === "parseResumeApi" || input.tool === "matchResumeApi"
        ? "needs_probe"
        : "needs_config";
    expect(bindingStatus(input)).toBe(expected);
  });

  it("recognizes the ontology-selected tenant inbox as a Resume_Upload reader", () => {
    expect(bindingStatus({
      name: "processResume",
      tool: "fs.readFromInbox",
      system: "Object_Storage_System",
      kind: "object_storage",
      role: "read",
      objects: ["Resume_Upload"],
    })).toBe("resolved");
  });

  it("recognizes remote object-store and Allmeta writers but keeps them evidence-gated", () => {
    expect(bindingStatus({
      name: "processResumeRemote",
      tool: "objectStore.getObject",
      system: "Object_Storage_System",
      kind: "object_storage",
      role: "read",
      objects: ["Resume_Upload"],
    })).toBe("needs_config");
    expect(bindingStatus({
      name: "persistCandidate",
      tool: "ontology.writeInstance",
      system: "Allmeta_Ontology_System",
      kind: "graph_db",
      role: "write",
      objects: ["Candidate", "Resume"],
    })).toBe("needs_config");
  });

  it("binds the exact Allmeta graph rule operation without turning it into an instance reader", () => {
    expect(bindingStatus({
      name: "identityRules",
      tool: "ontology.fetchActionRules",
      system: "Allmeta_Ontology_System",
      kind: "graph_db",
      role: "read",
      capability: "rules.fetch — 拉取身份/查重现行规则补充审计依据",
      objects: ["Candidate_Identity_Result"],
    })).toBe("needs_config");

    expect(bindingStatus({
      name: "identityCheck",
      tool: "ontology.fetchActionRules",
      system: "Allmeta_Ontology_System",
      kind: "graph_db",
      role: "read",
      objects: ["Candidate_Identity_Result"],
    })).toBe("missing");

    expect(bindingStatus({
      name: "identityRules",
      tool: "ontology.query",
      system: "Allmeta_Ontology_System",
      kind: "graph_db",
      role: "read",
      capability: "rules.fetch — 拉取身份/查重现行规则补充审计依据",
      objects: ["Candidate_Identity_Result"],
    })).toBe("missing");
  });

  it("still requires exact system, kind, operation and object coverage", () => {
    const base = {
      name: "createJD",
      tool: "generateJdApi",
      system: "GoHire_System",
      kind: "external_api",
      role: "execute",
      capability: "POST /api/v1/jobs/generate-jd",
      objects: ["Job_Posting"],
    };
    expect(bindingStatus({ ...base, system: "Unknown_GoHire_Alias" })).toBe("missing");
    expect(bindingStatus({ ...base, kind: "database" })).toBe("missing");
    expect(bindingStatus({ ...base, capability: "POST /api/v1/delete-everything" })).toBe("missing");
    expect(bindingStatus({ ...base, objects: ["Unknown_Object"] })).toBe("missing");
  });
});
