// #DESCRIBE-TOOL —— 大脑读工具契约。
//
// 这个工具存在的理由是三处「只能猜」里最贵的一处：plan 的 toolArguments 只校验
// 形状不校验字段名，于是把 {file: …} 绑到只认扁平 filename 的工具上，能渲染、
// 能过类型、能部署，到沙箱才炸——而 inspect_run 只报 degraded，refine_agent 于是
// 去改系统提示词，修错地方，下一次沙箱以同样方式失败。
//
// 所以本测试盯的不是「能返回点什么」，而是三条不能破的性质：
//   1. 命中就给原文契约（字段名必须是真的）；
//   2. 未命中给最接近的【真名】，绝不编一个契约；
//   3. 契约里缺什么就说缺什么——没有 schema 时「照着猜」依然是错的。
import { describe, expect, it } from "vitest";
import { FACTORY_TOOLS, SUBAGENT_TOOLS } from "./tools";
import type { BrainCtx } from "./brain-types";
import type { DomainOntology } from "./ontology-types";
import type { RealTool } from "./tool-catalog";

const INBOX_TOOL: RealTool = {
  name: "fs.readFromInbox",
  aliases: ["readResumeFromDisk"],
  category: "fs",
  sideEffect: "read",
  summary: "读取租户收件箱里的文件",
  credentialEnv: [],
  capabilities: [
    {
      systems: ["local filesystem"],
      kinds: ["file_store"],
      roles: ["read"],
      objectTypes: ["*"],
    },
  ],
  probeStatus: "verified",
  catalogDefinition: {
    name: "fs.readFromInbox",
    // 真正的字段名——正是「照摘要猜会猜错」的那个。
    argsSchema: { filename: { type: "string", description: "扁平文件名，不接受斜杠" } },
    returnsSchema: { path: { type: "string" }, base64: { type: "string" } },
    configSchema: { subdir: { type: "string" } },
  },
} as unknown as RealTool;

const UNDOCUMENTED_TOOL: RealTool = {
  name: "acme.mystery",
  category: "acme",
  sideEffect: "call",
} as unknown as RealTool;

function ctxWith(tools: RealTool[]): BrainCtx {
  return {
    domain: "dom",
    realTools: tools,
    ports: {},
    emit: () => undefined,
  } as unknown as BrainCtx;
}

const describeTool = FACTORY_TOOLS.find((t) => t.name === "describe_tool")!;
const describeDesignConstraints = FACTORY_TOOLS.find(
  (t) => t.name === "describe_design_constraints",
)!;

describe("describe_tool", () => {
  it("is available to the brain and to sub-agents", () => {
    expect(describeTool).toBeTruthy();
    expect(SUBAGENT_TOOLS.some((t) => t.name === "describe_tool")).toBe(true);
  });

  it("returns the real argument field names, which is the whole point", async () => {
    const result = await describeTool.execute(
      { name: "fs.readFromInbox", reasoning: "要给 plan 写 toolArguments" },
      ctxWith([INBOX_TOOL]),
    );
    expect(result.ok).toBe(true);
    const out = result.output as Record<string, unknown>;
    expect(out.argsSchema).toEqual({
      filename: { type: "string", description: "扁平文件名，不接受斜杠" },
    });
    expect(out.returnsSchema).toBeTruthy();
    expect(out.capabilities).toHaveLength(1);
  });

  it("resolves an alias to the same contract", async () => {
    const result = await describeTool.execute(
      { name: "readResumeFromDisk", reasoning: "老 manifest 用的是别名" },
      ctxWith([INBOX_TOOL]),
    );
    expect(result.ok).toBe(true);
    expect((result.output as { name: string }).name).toBe("fs.readFromInbox");
  });

  it("on a miss gives the nearest REAL names and refuses to invent a contract", async () => {
    const result = await describeTool.execute(
      { name: "fs.readInbox", reasoning: "我以为是这个名字" },
      ctxWith([INBOX_TOOL]),
    );
    expect(result.ok).toBe(false);
    const out = result.output as { found: boolean; nearest: string[] };
    expect(out.found).toBe(false);
    expect(out.nearest).toContain("fs.readFromInbox");
    // 没有编出来的 schema。
    expect(result.output).not.toHaveProperty("argsSchema");
  });

  it("says what the contract is MISSING instead of letting the brain guess", async () => {
    const result = await describeTool.execute(
      { name: "acme.mystery", reasoning: "这个工具能用吗" },
      ctxWith([UNDOCUMENTED_TOOL]),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("参数 schema");
    expect(result.summary).toContain("参数仍不可猜");
    expect((result.output as { argsSchema: unknown }).argsSchema).toBeNull();
  });

  it("never surfaces a secret value — config schemas name env vars, not values", async () => {
    const result = await describeTool.execute(
      { name: "fs.readFromInbox", reasoning: "检查配置项" },
      ctxWith([INBOX_TOOL]),
    );
    const serialized = JSON.stringify(result.output);
    expect(serialized).not.toMatch(/password|secret|api[_-]?key["']?\s*:\s*["'][^"']{8,}/i);
  });

  it("keeps processResume source symbols out of available_tools and makes every available canonical name describable", async () => {
    const ontology = {
      domainId: "dom",
      source: "allmeta",
      objects: [],
      rules: [],
      events: [
        {
          name: "RESUME_READY",
          payload: { source_action: null, event_data: [], state_mutations: [] },
        },
        {
          name: "RESUME_PROCESSED",
          payload: {
            source_action: "processResume",
            event_data: [],
            state_mutations: [],
          },
        },
      ],
      actions: [
        {
          id: "processResume",
          name: "processResume",
          actor: ["Agent"],
          trigger: ["RESUME_READY"],
          triggered_event: ["RESUME_PROCESSED"],
          target_objects: [],
          tool_use: ["readResumeFromDisk", "source.only"],
          system_prompt: "",
          user_prompt: "",
          inputs: [],
          outputs: [],
          action_steps: [
            {
              step_id: "read",
              object_type: "tool",
              tool: "readResumeFromDisk",
            },
          ],
          integration: { systems: [] },
        },
      ],
      workflow: [],
    } as unknown as DomainOntology;
    const ctx = {
      ...ctxWith([]),
      ontology,
      specs: [],
      createdSkills: [],
      ports: {
        toolRegistry: { list: async () => [INBOX_TOOL] },
      },
    } as unknown as BrainCtx;

    const result = await describeDesignConstraints.execute({}, ctx);
    expect(result.ok).toBe(true);
    const output = result.output as {
      available_tools: string[];
      ontology_tool_symbols: Array<{
        symbol: string;
        status: string;
        canonical_tool: string | null;
        available: boolean;
      }>;
      source_declarations: { status: string; unresolved: number };
    };
    expect(output.available_tools).toEqual(["fs.readFromInbox"]);
    expect(output.available_tools).not.toContain("readResumeFromDisk");
    expect(output.available_tools).not.toContain("source.only");
    expect(output.ontology_tool_symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: "readResumeFromDisk",
          status: "registry_alias",
          canonical_tool: "fs.readFromInbox",
          available: true,
        }),
        expect.objectContaining({
          symbol: "source.only",
          status: "source_only_unresolved",
          canonical_tool: null,
          available: false,
        }),
      ]),
    );
    expect(output.source_declarations).toMatchObject({
      status: "has_unresolved_source_symbols",
      unresolved: 1,
    });
    for (const name of output.available_tools) {
      const described = await describeTool.execute({ name }, ctx);
      expect(described.ok, name).toBe(true);
      expect(described.output).toMatchObject({ name });
    }
  });
});
