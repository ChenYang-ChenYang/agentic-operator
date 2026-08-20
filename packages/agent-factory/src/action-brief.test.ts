import { describe, expect, it } from "vitest";
import { buildActionBrief } from "./action-brief";
import type { DomainOntology } from "./ontology-types";
import type { OntologyReadinessIssue } from "./ontology-readiness";

function ontology(): DomainOntology {
  return {
    domainId: "d", source: "snapshot", workflow: [], rules: [],
    objects: [{ id: "Ticket", name: "工单", primary_key: "ticket_id", properties: [{ name: "ticket_id", type: "String" }, { name: "content", type: "String" }, { name: "category", type: "String" }] }],
    events: [
      { name: "TICKET_LOGGED", description: "新工单", payload: { source_action: null, event_data: [{ name: "ticket_id", type: "String", target_object: "Ticket" }, { name: "content", type: "String", target_object: "Ticket", required: false }], state_mutations: [] } },
      { name: "TICKET_CLASSIFIED", payload: { source_action: "classifyTicket", event_data: [{ name: "category", type: "String", target_object: "Ticket" }], state_mutations: [] } },
    ],
    actions: [{
      id: "classifyTicket", name: "classifyTicket", description: "分类工单", actor: ["Agent"],
      trigger: ["TICKET_LOGGED"], triggered_event: ["TICKET_CLASSIFIED"], target_objects: ["Ticket"],
      tool_use: ["classify.helper"], system_prompt: "", user_prompt: "",
      inputs: [{ name: "content", type: "String", required: true, binding_kind: "event", event_field: "content" }],
      outputs: [{ name: "category", type: "String" }],
      action_steps: [{ id: "judge", name: "judge", type: "logic" }],
      integration: { systems: [{ name: "CRM", kind: "external_api", role: "reads" }] },
    }],
  } as unknown as DomainOntology;
}

describe("buildActionBrief — deterministic member briefing", () => {
  it("packs the action's full slice: event contracts, bindings, objects, steps, integrations, declared tools", () => {
    const brief = buildActionBrief({ ontology: ontology(), actionName: "classifyTicket" });
    expect(brief).toContain("【动作简报 · classifyTicket】");
    // trigger event WITH payload contract (optional field marked ?)
    expect(brief).toContain("TICKET_LOGGED — {ticket_id:String, content:String?}");
    // emit target contract — outputs must map here
    expect(brief).toContain("TICKET_CLASSIFIED — {category:String}");
    // input with its binding
    expect(brief).toContain("content:String 必填 [event:content]");
    // object with primary key + fields
    expect(brief).toContain("Ticket（主键 ticket_id）");
    // source declarations remain visible but are explicitly canonicalized
    // through registry/integration evidence instead of blindly prioritized.
    expect(brief).toContain("本体源声明工具");
    expect(brief).toContain("classify.helper");
    // action_steps → plan stepId requirement surfaced
    expect(brief).toContain("judge(logic)");
    expect(brief).toContain("CRM（external_api/reads）");
  });

  it("surfaces per-slice readiness blockers, pinned rules and real-tool credential posture", () => {
    const blocking: OntologyReadinessIssue[] = [
      { severity: "blocking", code: "action_input_binding_kind_missing", message: "缺 binding", action: "classifyTicket", field: "content" },
      { severity: "blocking", code: "other_action_issue", message: "别人的问题", action: "someoneElse" },
    ];
    const brief = buildActionBrief({
      ontology: ontology(), actionName: "classifyTicket",
      rules: [{ id: "r1", name: "分类规则", summary: "金融类工单必须标记" }],
      realTools: [{ name: "crm.classify", summary: "CRM 分类接口", credentialEnv: ["CRM_KEY"], capabilities: [{ systems: ["CRM"], kinds: ["external_api"], roles: ["reads"] }] } as never],
      blocking,
    });
    expect(brief).toContain("[r1] 分类规则");
    expect(brief).toContain("action_input_binding_kind_missing(content)");
    expect(brief).not.toContain("other_action_issue"); // someone else's blocker never leaks into this slice
    expect(brief).toContain("crm.classify");
    expect(brief).toContain("需凭证 CRM_KEY");
    expect(brief).toContain("结构化 integration 的 authoring 执行面");
    expect(brief).toContain("CRM/external_api/reads => crm.classify");
  });

  it("includes the execution-bearing fields for every ontology action step", () => {
    const ont = ontology();
    (ont.actions[0] as { action_steps: unknown[] }).action_steps = [{
      id: "load-ticket",
      step_id: "load-ticket",
      object_type: "tool",
      tool: "crm.classify",
      tool_arguments: {
        ticket_id: { from: "input.ticket_id" },
        mode: { const: "reviewed" },
      },
      condition: "input.ticket_id != null",
      description: "读取并分类当前工单，不得读取其它租户数据。",
    }];
    const brief = buildActionBrief({ ontology: ont, actionName: "classifyTicket" });
    expect(brief).toContain("load-ticket(tool)");
    expect(brief).toContain("tool=crm.classify");
    expect(brief).toContain("ticket_id");
    expect(brief).toContain("if=input.ticket_id != null");
    expect(brief).toContain("不得读取其它租户数据");
  });

  it("uses the final bounded projection for the live processResume shape and never replaces exact fs with objectStore", () => {
    const ont = ontology();
    const action = ont.actions[0]!;
    action.id = "processResume";
    action.name = "processResume";
    action.tool_use = [
      "fs.readFromInbox",
      "parseResumeApi",
      "sourceOnlyAuditWriter",
    ];
    action.action_steps = [
      {
        order: 0,
        step_id: "download_resume",
        object_type: "tool",
        tool: "fs.readFromInbox",
      },
      {
        order: 1,
        step_id: "parse_resume",
        object_type: "tool",
        tool: "parseResumeApi",
      },
    ];
    action.integration = {
      systems: [
        {
          call_order: 1,
          name: "Resume_Object_Store",
          kind: "object_store",
          role: "reads",
          capability: "resume.object.read",
          objects: ["Ticket"],
        },
        {
          call_order: 2,
          name: "GoHire_System",
          kind: "external_api",
          role: "execute",
          capability: "resume.parse",
          objects: ["Ticket"],
        },
      ],
    };
    const realTools = [
      {
        name: "fs.readFromInbox",
        capabilities: [
          {
            systems: ["Resume_Object_Store"],
            kinds: ["object_store"],
            roles: ["reads"],
            operations: ["resume.object.read"],
            objectTypes: ["Ticket"],
          },
        ],
      },
      {
        name: "objectStore.getObject",
        capabilities: [
          {
            systems: ["Resume_Object_Store"],
            kinds: ["object_store"],
            roles: ["reads"],
            operations: ["resume.object.read"],
            objectTypes: ["Ticket"],
          },
        ],
      },
      {
        name: "gohireParseResumeApi",
        aliases: ["parseResumeApi"],
        capabilities: [
          {
            systems: ["GoHire_System"],
            kinds: ["external_api"],
            roles: ["execute"],
            operations: ["resume.parse"],
            objectTypes: ["Ticket"],
          },
        ],
      },
    ] as unknown as import("./tool-catalog").RealTool[];

    const brief = buildActionBrief({
      ontology: ont,
      actionName: "processResume",
      realTools,
    });

    expect(brief).toContain(
      "fs.readFromInbox → fs.readFromInbox [registered canonical]",
    );
    expect(brief).toContain(
      "parseResumeApi → gohireParseResumeApi [registry alias]",
    );
    expect(brief).toContain(
      "BLOCKER sourceOnlyAuditWriter → 不可投影",
    );
    expect(brief).toContain(
      "Resume_Object_Store/object_store/reads => fs.readFromInbox",
    );
    expect(brief).not.toContain("fs.readFromInbox → objectStore.getObject");
    expect(brief).not.toContain(
      "Resume_Object_Store/object_store/reads => objectStore.getObject",
    );
  });

  it("tells simple actions to omit the plan, caps output, and fails plainly on unknown actions", () => {
    const ont = ontology();
    (ont.actions[0] as { action_steps: unknown[] }).action_steps = [];
    const brief = buildActionBrief({ ontology: ont, actionName: "classifyTicket" });
    expect(brief).toContain("无 action_steps：简单动作可整体省略 plan");

    const capped = buildActionBrief({ ontology: ontology(), actionName: "classifyTicket", maxChars: 200 });
    expect(capped.length).toBeLessThan(320);
    expect(capped).toContain("截断");

    expect(buildActionBrief({ ontology: ontology(), actionName: "ghost" })).toContain("未找到动作");
  });
});
