// #BUILTIN-SKILLS (P1-5) — the factory's seeded skill library + automatic recall.
//
// The skill MACHINERY existed (create_skill / use_skill / AWM induction) but shipped with an EMPTY
// library, and recall was passive (the brain had to remember to call use_skill). This module fixes
// both: a small curated library of skills distilled from lessons this codebase actually paid for
// (CLAUDE.md conventions + factory reflections), plus a deterministic matcher the conductor runs at
// goal time to inject the 1-2 most relevant fragments automatically.
//
// Design constraints:
//   · Fragments are ACTIONABLE checklists, not essays — capped, written for the brain, in Chinese.
//   · Matching is deterministic keyword/regex scoring (pure function, unit-testable, no LLM).
//   · Injection is BACKGROUND guidance (a system frame) — it never overrides the user's ask.

export interface BuiltinSkill {
  slug: string;
  name: string;
  purpose: string;
  /** the injected guidance — concise, imperative, grounded in real incidents. */
  promptFragment: string;
  /** recall triggers, matched against goal + intent + pipeline signals. */
  triggers: RegExp[];
  /** coarse phase hint (recall boosts when the pipeline matches). */
  phase?: "generate" | "modify" | "analyze" | "any";
}

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    slug: "rest-api-tool-onboarding",
    name: "REST API 工具接入流程",
    purpose: "为动作接入外部 REST API 工具时的标准阶梯，避免凭空造工具或轻信文档",
    promptFragment:
      "接外部 API 工具按阶梯走：①先用本体 suggested_tools/tool_hints；②不够 search_tools 搜真实库；③还没有→fetch_doc 拿公网文档 + 用户提供的【脱敏 request/response 例子】一起 extract_api_schema（例子优先于文档）；④create_tool 落地后必须 probe_tool 真实探测；⑤write/dual 副作用由 probe_tool 的服务端确认门走，不许 generic ask_user 拼授权。三个真实教训：vendor 常把结果嵌套两层（data.data.*，先 curl 验证真实信封再写 result_path）；上传类接口常是 multipart-only 且字段名固定（JSON body 会 400）；HTTP 200 也可能是静默失败（断言关键输出字段非空）。",
    triggers: [/api|接口|外部系统|集成|工具接入|http|rest|webhook|第三方/i],
    phase: "generate",
  },
  {
    slug: "external-api-resilient-authoring",
    name: "外部 API 非阻断代码生成",
    purpose:
      "外部平台暂时离线或尚未配 profile 时继续生成可审阅代码，同时保持运行与上线证据严格",
    promptFragment:
      "外部 API 暂不可用时把【作者就绪】和【运行就绪】分开：①只要工具身份、I/O 契约、operation/sideEffect/effectScope 已唯一且可核查，就继续生成 draft/function；使用符号化 env 引用和可注入 transport，绝不把 key 写进代码；②生成代码在缺配置/超时/无效信封时必须 fail-closed，返回结构化错误，不得静默 mock 或伪造成功；③把每个未决依赖写进交付摘要：系统、工具、缺 profile/env/probe 的哪一层、影响哪些 Action、FDE 下一步；④明确标注「代码已生成 ≠ 已连接/已测试/可上线」；⑤sandbox、真实 probe、promotion 仍严格阻断。只有工具身份或契约本身缺失/并列歧义时才暂停 authoring 请人拍板，不能凭动作名猜接口。",
    triggers: [
      /api.*(?:不可用|不通|离线|暂时|失败)|(?:不可用|不通|离线).*api/i,
      /缺.*(?:profile|凭证|连接|探针)|(?:profile|凭证|连接|探针).*缺/i,
      /继续.*(?:生成|代码)|不阻断|fail[- ]?closed|unavailable|offline/i,
    ],
    phase: "generate",
  },
  {
    slug: "ontology-evidence-analyst",
    name: "Ontology 证据化分析",
    purpose:
      "像分析工作台一样深读对象、关系、事件、规则与实例，并选择合适的结构化呈现",
    promptFragment:
      "分析 Ontology 时按证据层工作：①先读对象/属性、真实关系边、ActionStep/Rule、事件生产消费链与外部系统，结论引用真实 id；②能读实例时只做有界采样/聚合，敏感列脱敏，0 行要写「真实为空」，读不到要写「来源不支持」，两者不能混；③把结构事实与 LLM 解释分开，引用不存在的结论降级为未验证；④按数据形态选视图：指标→metric，重复字段→table，依赖/流转→relationship/flow，风险与缺口→list；不要把所有内容塞成 Markdown；⑤同时对照真实工具目录，逐 Action 说明已覆盖、待配置、待探针、歧义或真缺工具。",
    triggers: [
      /ontology|本体|allmeta|对象|关系图|事件链|action.*rule/i,
      /分析|洞察|analyst|表格|可视化|数据展现/i,
    ],
    phase: "analyze",
  },
  {
    slug: "rule-gate-agent-pattern",
    name: "规则闸门 agent 设计模式",
    purpose: "设计规则校验类动作（ruleCheck/审核/合规）时的固定模式",
    promptFragment:
      "规则校验类 agent 的铁律：①system_prompt 必须写成【运行时动态抓取规则】再逐条评估——绝不把具体规则文本写死进 prompt（规则会变，写死=悄悄过期）；②规则引用只认 action_steps 里的精确 rule id/名称，模糊引用先 ask_user 别语义猜；③输出必须结构化（每条规则 命中/未命中/证据），下游事件字段带上违规明细；④默认 fail-closed：规则取不到=拒绝放行并 emit 拒绝事件，不是默认通过。",
    triggers: [/规则|rule|合规|审核|校验|check|风控|准入|闸门/i],
    phase: "generate",
  },
  {
    slug: "broken-chain-diagnosis",
    name: "事件链断链诊断 playbook",
    purpose: "validate_graph/sandbox 报断链或运行卡住时的定位顺序",
    promptFragment:
      "断链诊断顺序（别上来就改 prompt）：①verify_chain 看具体断在哪条边；②分清三类悬空：外部交接(external)/合法终态(terminal)/真断点(break)——前两类走 propose_boundary_events 让用户分类，只有 break 才需要修 agent；③检查 emit 事件名与下游 trigger 是否逐字一致（大小写/下划线差异=断链）；④检查 payload 契约：上游 emit 的字段是否覆盖下游 required 输入（fidelityFailures 看真实载荷）；⑤修复优先级：补事件字段映射 > 改 emit 选择 > 最后才动 prompt。",
    triggers: [/断链|断点|链路|不通|卡住|没触发|validate|悬空|事件链|chain/i],
    phase: "any",
  },
  {
    slug: "vendor-envelope-checklist",
    name: "vendor 响应信封核对清单",
    purpose: "包装第三方 API 为工具、或写 result_path 时的防坑核对",
    promptFragment:
      "第三方响应信封五连查（每条都是真实事故）：①真实结构 curl 验证过了吗（别信文档）？②结果是否嵌套（data.data.*、result.payload.*）——result_path 读浅一层会静默返回 null；③成败判定字段在哪（success:true 但真错误藏在 meta.stages 里）？④关键业务字段（score/id/url）的真实路径与命名（overallMatchScore.score ≠ matchScore）；⑤空/占位响应算失败吗——对关键字段加非空断言，空=失败上报，绝不伪装成功。",
    triggers: [/vendor|第三方|响应|信封|result_path|解析|null|字段.*(取不到|为空)|match.*score/i],
    phase: "any",
  },
  {
    slug: "durable-plan-design",
    name: "多步 plan 可重放设计",
    purpose: "给有外部副作用/多步骤的动作写 plan 时的 durability 纪律",
    promptFragment:
      "可重放 plan 六条：①每个外部调用/写入=独立 plan 步（一步一个可重放边界，绝不把两次写塞一步）；②每个副作用步都要 idempotencyKeyFrom（业务键，不是数组下标）；③错误分类——不可恢复(缺必填/明确拒绝)→terminal+emit 失败事件不重试；可恢复(超时/5xx/限流)→park 重试；④emit 步必须写 emitEvent（事件真名）；⑤循环用 foreach+每层稳定业务键，循环内 invoke 要有 timeout+错误策略；⑥简单单步判断型动作【整体省略 plan】——运行时按 prompt 直跑并自动 emit，手写空 plan 反而过不了校验。",
    triggers: [/plan|多步|重放|幂等|副作用|durable|step|foreach|invoke|补偿|saga/i],
    phase: "generate",
  },
  {
    slug: "sandbox-test-discipline",
    name: "沙箱验证与测试数据纪律",
    purpose: "generate_test_cases/sandbox_run 阶段的取证纪律",
    promptFragment:
      "沙箱纪律：①用例先给用户确认再发射（approval 门），fault 用例的\"通过\"=链路拒绝到达成功终态（证明错误传播），别把 fault 通过当 bug；②联系方式/凭证/真实 id 类字段不许用占位数据（candidate@example.com 跑通≠集成通）——supply_test_data 问真实值；③只认真实回执：code_ran、agentRuns 的真实 I/O、reachedSuccessTerminal，模拟通过永远不算交付证据；④改过任何 spec 后沙箱证据全部失效，必须重跑。",
    triggers: [/测试|沙箱|sandbox|test|用例|验证|试运行|fixture|数据/i],
    phase: "any",
  },
  {
    slug: "hitl-decision-aggregation",
    name: "HITL 决策聚合",
    purpose: "一次运行里出现多个需用户拍板的事项时的提问纪律",
    promptFragment:
      "问用户的纪律：①攒批——多个待拍板事项（选集成/补凭证/边界分类）合并成一次 ask_user，别连环打断；②每项给 2-4 个具体选项并标一个 recommended（推荐是建议不是授权，超时不得自动生效）；③问题里带上下文与后果（选 A 则…选 B 则…）；④授权类（probe/profile 确认）绝不用 generic ask_user 拼装——走各自的服务端确认门；⑤问完真挂起等答复，不要边等边干别的写操作。",
    triggers: [/ask_user|拍板|确认|授权|选集成|凭证|profile|决策/i],
    phase: "any",
  },
];

export interface SkillMatch {
  slug: string;
  name: string;
  promptFragment: string;
  score: number;
  source: "builtin" | "learned";
}

/** Deterministic recall: regex-hit scoring over goal+intent text, phase-boosted. Returns the top K. */
export function matchBuiltinSkills(text: string, opts: { pipeline?: string; limit?: number } = {}): SkillMatch[] {
  const limit = opts.limit ?? 2;
  const hay = (text ?? "").slice(0, 4000);
  if (!hay.trim()) return [];
  const phaseOf = (pipeline?: string): BuiltinSkill["phase"] =>
    pipeline === "full" ? "generate" : pipeline === "skinny" ? "modify" : pipeline === "analyze" ? "analyze" : "any";
  const runPhase = phaseOf(opts.pipeline);
  const matches: SkillMatch[] = [];
  for (const s of BUILTIN_SKILLS) {
    const hits = s.triggers.reduce((n, re) => n + (re.test(hay) ? 1 : 0), 0);
    if (!hits) continue;
    const phaseBoost = s.phase === "any" || runPhase === "any" || s.phase === runPhase ? 1 : 0.5;
    const score = hits * phaseBoost;
    if (score >= 1) matches.push({ slug: s.slug, name: s.name, promptFragment: s.promptFragment, score, source: "builtin" });
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Keyword-overlap recall for LEARNED (stored) skills — no LLM, tolerant of sparse metadata. */
export function matchLearnedSkills(
  text: string,
  learned: Array<{ slug: string; name: string; purpose: string; promptFragment?: string; decisionRule?: string }>,
  limit = 1,
): SkillMatch[] {
  const hay = (text ?? "").toLowerCase();
  if (!hay.trim() || !learned.length) return [];
  // CJK has no word separators — whole phrases would become single unmatchable tokens. Mix latin word
  // tokens with CJK character BIGRAMS; bigrams are noisier, so the recall threshold is higher (>=3).
  const tokens = (s: string): string[] => {
    const out: string[] = [];
    for (const part of (s ?? "").toLowerCase().split(/[^a-z0-9一-鿿]+/)) {
      if (!part) continue;
      if (/^[a-z0-9]+$/.test(part)) { if (part.length >= 3) out.push(part); continue; }
      for (let i = 0; i + 2 <= part.length; i++) out.push(part.slice(i, i + 2));
    }
    return out;
  };
  const matches: SkillMatch[] = [];
  for (const s of learned) {
    const keys = new Set([...tokens(s.name), ...tokens(s.purpose), ...tokens(s.decisionRule ?? "")]);
    let score = 0;
    for (const k of keys) if (hay.includes(k)) score += 1;
    if (score >= 3 && s.promptFragment) {
      matches.push({ slug: s.slug, name: s.name, promptFragment: s.promptFragment.slice(0, 800), score, source: "learned" });
    }
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Render the recall frame injected as a system message (capped, provenance-tagged). */
export function renderSkillRecall(matches: SkillMatch[]): string {
  if (!matches.length) return "";
  return [
    "[技能召回｜按当前目标自动匹配｜背景参考，不覆盖用户要求]",
    ...matches.map((m) => `◆ ${m.name}（${m.source === "builtin" ? "内置" : "习得"}）\n${m.promptFragment}`),
  ].join("\n\n").slice(0, 4000);
}
