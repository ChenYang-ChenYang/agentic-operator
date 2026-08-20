import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS, matchBuiltinSkills, matchLearnedSkills, renderSkillRecall } from "./builtin-skills";

describe("builtin skills — seeded library + deterministic recall", () => {
  it("ships a curated library with unique slugs and actionable fragments", () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThanOrEqual(6);
    const slugs = BUILTIN_SKILLS.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of BUILTIN_SKILLS) {
      expect(s.promptFragment.length).toBeGreaterThan(80);
      expect(s.triggers.length).toBeGreaterThan(0);
    }
  });

  it("recalls the API-onboarding skill for an integration goal, boosted by the generate phase", () => {
    const m = matchBuiltinSkills("为本域生成 agent，需要接入第三方 REST API 拿简历数据", { pipeline: "full" });
    expect(m.map((x) => x.slug)).toContain("rest-api-tool-onboarding");
    expect(m.length).toBeLessThanOrEqual(2); // capped
  });

  it("recalls non-blocking authoring guidance when an external API is temporarily unavailable", () => {
    const matches = matchBuiltinSkills(
      "GoHire API 暂时不通，但请继续生成 function 代码，最后列出缺失 profile 和 probe",
      { pipeline: "full" },
    );
    expect(matches.map((match) => match.slug)).toContain(
      "external-api-resilient-authoring",
    );
  });

  it("recalls evidence-grounded Analyst guidance for an Allmeta Ontology analysis", () => {
    const matches = matchBuiltinSkills(
      "深入分析 Allmeta Ontology 的关系图、事件链，并把实例数据用表格展现",
      { pipeline: "analyze" },
    );
    expect(matches.map((match) => match.slug)).toContain(
      "ontology-evidence-analyst",
    );
  });

  it("recalls the rule-gate pattern for a 规则校验 goal and the chain playbook for 断链", () => {
    expect(matchBuiltinSkills("生成规则校验 agent 做合规审核", { pipeline: "full" }).map((x) => x.slug)).toContain("rule-gate-agent-pattern");
    expect(matchBuiltinSkills("事件链不通，好像断链了帮我看看", { pipeline: "analyze" }).map((x) => x.slug)).toContain("broken-chain-diagnosis");
  });

  it("returns nothing for an unrelated greeting — recall never spams", () => {
    expect(matchBuiltinSkills("你好", { pipeline: "analyze" })).toEqual([]);
  });

  it("matches learned skills by keyword overlap and requires a promptFragment", () => {
    const learned = [
      { slug: "zhaopin-resume-flow", name: "简历解析流程", purpose: "招聘域简历解析与匹配的流程要点", promptFragment: "解析用 multipart 上传…", decisionRule: "涉及简历解析时" },
      { slug: "no-fragment", name: "简历相关", purpose: "简历流程", decisionRule: "简历" }, // no fragment → never recalled
    ];
    const m = matchLearnedSkills("为招聘域生成简历解析 agent，走简历匹配流程", learned);
    expect(m.map((x) => x.slug)).toEqual(["zhaopin-resume-flow"]);
    expect(m[0]!.source).toBe("learned");
  });

  it("renders a provenance-tagged background frame, capped", () => {
    const frame = renderSkillRecall(matchBuiltinSkills("接入外部 API 集成并处理规则校验", { pipeline: "full" }));
    expect(frame).toContain("[技能召回");
    expect(frame).toContain("背景参考，不覆盖用户要求");
    expect(frame).toContain("（内置）");
    expect(frame.length).toBeLessThanOrEqual(4000);
    expect(renderSkillRecall([])).toBe("");
  });
});
