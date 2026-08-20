// #ROLE（定稿）— 角色属于【生成过程中的 agents】（系统 A 的流水线工作者），不属于最终交付的
// functions（交付物只有显示名，不承载"角色设定"）。
//
// 两类过程角色：
//   1. 固定流水线工作者 —— 每个工厂工具对应一位过程角色（业务分析师/方案架构师/沙箱工程师…），
//      注册表在此（显示元数据，#OPEN-VOCAB：未登记的新工具 → undefined，UI 优雅省略，不阻断）。
//   2. 动态派生的 sub-agents —— 角色由 AI 在 spawn 时【自动设定】（spawn_subagent 的 role 参数，
//      如「证据调查员」「规则考古学家」），完全开放词汇；认知专家（对象/规则/动作/事件）与
//      内联分析专家的角色随任务文本自带。
//
// 事件流携带角色（tool.call.role / stage.role / subagent.start.role）→ UI 的活动叙事、后台任务卡、
// 系统全景都能以角色称呼"现在是谁在干活"。

export const ROLE_OF_TOOL: Record<string, string> = {
  // 读业务
  read_ontology: "业务分析师",
  query_links: "业务分析师",
  read_action_contract: "业务分析师",
  inspect_action_readiness: "就绪检查员",
  inspect_all_action_readiness: "就绪检查员",
  revise_ontology: "本体修订提案员",
  list_domains: "业务分析师",
  describe_domain: "业务分析师",
  describe_object: "业务分析师",
  // 理解
  understand_ontology: "本体分析师",
  capability_resolve: "能力规划师",
  analyze_with_code: "数据分析师",
  // 规划
  create_plan: "方案架构师",
  critique_plan: "方案评审",
  propose_boundary_events: "方案架构师",
  // 设计
  design_agent: "Agent 设计师",
  design_subagent: "Agent 设计师",
  design_fleet: "设计舰队协调员",
  review_fleet: "审查舰队协调员",
  refine_fleet: "修复舰队协调员",
  create_mock_agent: "模拟桩工程师",
  describe_design_constraints: "Agent 设计师",
  codegen_agent: "代码工程师",
  refine_agent: "修复工程师",
  revert_refine: "修复工程师",
  // 校验 / 评审
  validate_graph: "QA 工程师",
  verify_chain: "QA 工程师",
  read_spec: "QA 工程师",
  recall_conversation: "档案管理员",
  diff_spec: "QA 工程师",
  review_agent: "质量评审",
  review_context: "质量评审",
  review_completeness: "质量评审",
  score_spec: "质量评审",
  // 测试 / 沙箱
  generate_test_cases: "测试设计师",
  sandbox_run: "沙箱工程师",
  run_regression: "回归测试员",
  inspect_run: "沙箱工程师",
  // #RUN-EVIDENCE — 只读盘上真源、给可引用位置的取证工位（与「故障诊断师」分工：取证不下结论）。
  read_run_evidence: "运行取证员",
  analyze_failure: "故障诊断师",
  // 交付
  finish: "交付负责人",
  delivery_bundle: "交付负责人",
  list_agents: "交付负责人",
  // 人机协作
  ask_user: "协调员",
  ask_user_batch: "协调员",
  supply_test_data: "协调员",
  spawn_subagent: "协调员",
  spawn_subagent_group: "协调员",
  // 自造能力 / 调研
  web_search: "调研员",
  fetch_doc: "调研员",
  create_tool: "工具工程师",
  confirm_integration_profile: "集成配置协调员",
  probe_tool: "集成验证工程师",
  create_signed_fixture: "沙箱证据协调员",
  prepare_sandbox_evidence_plan: "沙箱证据协调员",
  search_tools: "工具工程师",
  describe_tool: "工具工程师",
  extract_api_schema: "工具工程师",
  create_skill: "技能工程师",
  use_skill: "技能工程师",
  resolve_capability_ladder: "能力规划师",
  select_strategy: "推理策略师",
  generate_report: "报告撰写人",
  build_blueprint: "蓝图架构师",
  save_draft: "交付负责人",
};

/** 过程角色查询：未登记（新工具/开放词汇）→ undefined，消费端优雅省略。 */
export function roleOfTool(toolName: string): string | undefined {
  return ROLE_OF_TOOL[toolName];
}
