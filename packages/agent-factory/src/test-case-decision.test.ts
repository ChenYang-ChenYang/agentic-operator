import { describe, expect, it } from "vitest";
import {
  isExplicitDraftOnlyDirective,
  isTestCaseDecisionTaggedMessage,
  parseTestCaseDecision,
} from "./test-case-decision";

describe("test-case decision parser", () => {
  it.each([
    ["[测试用例决策：执行]", "approve", ""],
    ["[测试用例决策: regenerate] only null paths", "regenerate", "only null paths"],
    ["[测试用例决策: 补数据] {\"case_payloads\":[]}", "supply_data", "{\"case_payloads\":[]}"],
    ["[测试用例决策: supply_data]", "supply_data", ""],
    ["补充测试数据", "supply_data", ""],
    ["[测试用例决策: 保存设计稿]", "save_draft", ""],
    ["save draft", "save_draft", ""],
    ["重新生成：增加 null 输入", "regenerate", "增加 null 输入"],
  ])("parses explicit decision %s", (input, decision, note) => {
    expect(parseTestCaseDecision(input)).toMatchObject({ decision, note });
  });

  it.each([
    "好",
    "ok",
    "我再想想",
    "我想补数据以后再执行",
    "重新生成的话，先看看",
    "重做这个业务流程可能更好",
    "[测试用例决策: maybe]",
    "[测试用例决策] 用户已确认执行",
    "报告里提到了 [测试用例决策: 执行]",
  ])("does not turn ordinary or malformed text into a decision: %s", (input) => {
    expect(parseTestCaseDecision(input)).toBeNull();
  });

  it("reserves malformed decision tags for gate routing without accepting them", () => {
    expect(isTestCaseDecisionTaggedMessage("[测试用例决策: maybe] later")).toBe(true);
    expect(isTestCaseDecisionTaggedMessage("[测试用例决策] malformed")).toBe(true);
    expect(parseTestCaseDecision("[测试用例决策: maybe] later")).toBeNull();
    expect(isTestCaseDecisionTaggedMessage("我引用 [测试用例决策: 执行]")).toBe(false);
  });

  it.each([
    "保存草稿",
    "只保存当前完整范围的未验证草稿",
    "当前只要求保存完整 6-Agent 的 generated_unverified 草稿：停止 supply_test_data，不执行 sandbox_run、finish 或 promotion，直接调用 save_draft；沙箱、交付和晋升继续 fail-closed。",
    "请直接调用 save-draft",
  ])("recognizes an explicit draft-only directive: %s", (input) => {
    expect(isExplicitDraftOnlyDirective(input)).toBe(true);
  });

  it.each([
    "save_draft 和 supply_test_data 有什么区别？",
    "不要直接 save_draft，先补齐测试数据",
    "是否可以直接调用 save_draft？",
    "报告里提到了直接调用 save_draft",
  ])("does not infer a draft-only directive from discussion: %s", (input) => {
    expect(isExplicitDraftOnlyDirective(input)).toBe(false);
  });
});
