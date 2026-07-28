// Golden-domain capability-equivalence assertions.
//
// Source of truth: the six battle-tested RAAS-v1 production agents. Each entry
// states one guarantee those agents make, expressed as a check against what the
// GENERATOR produces from the Agents-generation Ontology for the same Action.
//
// This table is not a wish list. Every id came from reading a real production
// agent and its real tests, and every gap in it was adversarially re-verified
// against the generated side (prompts, error policies, downstream tools, tenant
// adapters, sibling agents) before being recorded — 22 of 22 survived, so none
// of these are "different but equivalent".
//
// The suite is ratcheted, not aspirational: `baseline.json` records what passes
// today, and the run fails only on regression. Fixing a generator defect flips
// rows and requires an explicit baseline bump, which is what makes progress
// reviewable rather than assertable.

export type AssertionCategory =
  | "WIRING"
  | "ORDERING"
  | "RULE_BINDING"
  | "SIDE_EFFECT_GUARD"
  | "IDEMPOTENCY"
  | "FAILURE_HANDLING"
  | "OBSERVABILITY"
  | "DATA_CONTRACT";

export type AssertionLayer = "spec" | "render";

export interface GoldenAssertion {
  id: string;
  /** Fixture spec basename (without .json). */
  agent: string;
  category: AssertionCategory;
  severity: "blocker" | "major" | "minor";
  layer: AssertionLayer;
  /** The production guarantee, stated so a failure is self-explanatory. */
  guarantee: string;
  /** Confirmed generator defect this assertion pins, when it currently fails. */
  gap?: string;
}

export const CREATE_JD = "agents-gener-create-jd";
export const PROCESS_RESUME = "agents-gener-process-resume";
export const MATCH_RESUME = "agents-gener-match-resume";
export const INVITE_INTERVIEW = "agents-gener-invite-internal-interview";
export const RULE_CHECK_MATCH = "agents-gener-rule-check-for-match-resume";
export const CANDIDATE_IDENTITY = "agents-gener-rule-check-for-candidate-identity";

export const ALL_AGENTS = [
  CREATE_JD,
  PROCESS_RESUME,
  MATCH_RESUME,
  INVITE_INTERVIEW,
  RULE_CHECK_MATCH,
  CANDIDATE_IDENTITY,
] as const;

/** Assertions that apply identically to every generated agent. */
const UNIVERSAL: Array<Omit<GoldenAssertion, "agent" | "id"> & { key: string }> =
  [
    {
      key: "trigger-events-are-ontology-events",
      category: "WIRING",
      severity: "blocker",
      layer: "spec",
      guarantee:
        "每个 agent 的 trigger 事件名必须来自本体，不能是模型编出来的名字。",
    },
    {
      key: "retries-are-declared",
      category: "FAILURE_HANDLING",
      severity: "major",
      layer: "spec",
      guarantee: "Inngest function 必须声明 retries，不能靠默认值。",
    },
    {
      key: "plan-passes-generator-validator",
      category: "WIRING",
      severity: "blocker",
      layer: "spec",
      guarantee:
        "生成的计划必须通过生成器自己的 validatePlan：计划里调用的每个工具都要在这个 agent 的 tools 允许列表内，否则运行时会被信任边界挡下，那一步永远执行不了。",
      gap: "G24",
    },
    {
      key: "no-unresolved-template-literal-on-the-wire",
      category: "DATA_CONTRACT",
      severity: "blocker",
      layer: "render",
      guarantee:
        "渲染出来的代码里不能出现未解析的 {{...}} 占位符——那意味着字面量被当作真实值发到了下游。",
      gap: "G3",
    },
    {
      key: "durable-step-ids-are-distinct",
      category: "IDEMPOTENCY",
      severity: "blocker",
      layer: "render",
      guarantee:
        "同一个 handler 里每个 step.run/step.invoke/step.sendEvent 的持久化 id 必须互不相同，否则 Inngest 会把不同的步骤当成同一步重放。",
      gap: "G6",
    },
    {
      key: "invoke-payload-descriptors-resolved",
      category: "DATA_CONTRACT",
      severity: "blocker",
      layer: "render",
      guarantee:
        "step.invoke 的入参必须是解析后的值，不能把 {from:...} 描述符原样传给被调用方。",
      gap: "G4",
    },
    {
      key: "required-inputs-guarded-before-side-effects",
      category: "SIDE_EFFECT_GUARD",
      severity: "blocker",
      layer: "render",
      guarantee:
        "required 的输入锚点必须在第一个副作用步骤之前校验；缺锚点要立刻 NonRetriable 失败，不能先花钱调用外部 API 再发现。",
      gap: "G8",
    },
    {
      key: "declared-failure-emit-is-reachable",
      category: "FAILURE_HANDLING",
      severity: "blocker",
      layer: "render",
      guarantee:
        "errorPolicy 里声明的 emitEvent 在 terminal 分支上必须真的能发出去，不能是 throw 之后的死代码。",
      gap: "G16",
    },
    {
      key: "quota-failures-park-not-terminal",
      category: "FAILURE_HANDLING",
      severity: "major",
      layer: "render",
      guarantee:
        "402/额度用尽属于充值后可自愈的故障，必须 park 等重试，不能判成 terminal 永久杀死。",
      gap: "G18",
    },
    {
      key: "failure-event-never-reuses-a-business-verdict",
      category: "FAILURE_HANDLING",
      severity: "blocker",
      layer: "render",
      guarantee:
        "运行时错误不能复用某个业务终态事件（否则一次 HTTP 401 会变成对候选人的永久拒绝），也不能发 spec.emit 里没声明的事件。",
      gap: "G19",
    },
  ];

/** Assertions tied to one agent's specific production contract. */
const PER_AGENT: GoldenAssertion[] = [
  {
    id: "createjd-no-client-org-name-outbound",
    agent: CREATE_JD,
    category: "RULE_BINDING",
    severity: "blocker",
    layer: "spec",
    guarantee:
      "规则 4-2：JD 全文不得出现客户公司名称。任何出站工具参数都不允许绑定到客户机构名字段。",
    gap: "G22",
  },
  {
    id: "createjd-rulerefs-are-fetched-before-use",
    agent: CREATE_JD,
    category: "RULE_BINDING",
    severity: "blocker",
    layer: "spec",
    guarantee:
      "声明了 ruleRefs 就必须有一个取规则的步骤，排在使用它的步骤之前并把结果传下去；不能只在 prompt 里声称规则已在运行时抓取。",
    gap: "G10",
  },
  {
    id: "processresume-rulerefs-are-fetched-before-use",
    agent: PROCESS_RESUME,
    category: "RULE_BINDING",
    severity: "blocker",
    layer: "spec",
    guarantee: "同上：规则必须真的被取用，而不是当标签挂着。",
    gap: "G10",
  },
  {
    id: "rulecheck-rulerefs-are-fetched-before-use",
    agent: RULE_CHECK_MATCH,
    category: "RULE_BINDING",
    severity: "blocker",
    layer: "spec",
    guarantee:
      "规则闸口 agent 必须先取规则再评估再落库；取规则排在评估和持久化之后等于没取。",
    gap: "G10",
  },
  {
    id: "identity-rulerefs-are-fetched-before-use",
    agent: CANDIDATE_IDENTITY,
    category: "RULE_BINDING",
    severity: "blocker",
    layer: "spec",
    guarantee: "身份判定的规则必须在写审计之前取到。",
    gap: "G10",
  },
  {
    id: "match-routing-is-deterministic",
    agent: MATCH_RESUME,
    category: "WIRING",
    severity: "blocker",
    layer: "render",
    guarantee:
      "分数阈值决定终态事件。终态必须由计算出的判定推导，不能被 LLM 的自由文本 decision.emit 覆盖。",
    gap: "G1",
  },
  {
    id: "rulecheck-routing-is-deterministic",
    agent: RULE_CHECK_MATCH,
    category: "WIRING",
    severity: "blocker",
    layer: "render",
    guarantee: "规则判定结果决定 PASSED/FAILED，不能由 LLM 挑事件。",
    gap: "G1",
  },
  {
    id: "invite-routing-is-deterministic",
    agent: INVITE_INTERVIEW,
    category: "WIRING",
    severity: "blocker",
    layer: "render",
    guarantee:
      "只有真的拿到 invitationId 才能宣布邀请已发出；这个判断不能交给 LLM。",
    gap: "G1",
  },
  {
    id: "processresume-routing-is-deterministic",
    agent: PROCESS_RESUME,
    category: "WIRING",
    severity: "blocker",
    layer: "render",
    guarantee: "锁冲突与正常处理的分流必须是确定的。",
    gap: "G1",
  },
  {
    id: "match-condition-steps-are-consumed",
    agent: MATCH_RESUME,
    category: "WIRING",
    severity: "blocker",
    layer: "render",
    guarantee:
      "计划里的 condition 步骤必须被真正读取；算完就丢弃等于这段路由逻辑不存在。",
    gap: "G2",
  },
  {
    id: "rulecheck-condition-steps-are-consumed",
    agent: RULE_CHECK_MATCH,
    category: "WIRING",
    severity: "blocker",
    layer: "render",
    guarantee: "同上。",
    gap: "G2",
  },
  {
    id: "identity-returns-business-verdict",
    agent: CANDIDATE_IDENTITY,
    category: "DATA_CONTRACT",
    severity: "blocker",
    layer: "render",
    guarantee:
      "被 step.invoke 调用的 agent 必须能把业务判定返回给调用方；只返回 {ok:boolean} 会让整条去重链路失效。",
    gap: "G5",
  },
  {
    id: "createjd-emit-projects-declared-outputs",
    agent: CREATE_JD,
    category: "DATA_CONTRACT",
    severity: "blocker",
    layer: "render",
    guarantee:
      "发出的事件必须按 outputSchema 投影声明字段，不能把整个作用域（含 _raw 供应商原始响应）泼到线上。",
    gap: "G3",
  },
  {
    id: "match-emit-projects-declared-outputs",
    agent: MATCH_RESUME,
    category: "DATA_CONTRACT",
    severity: "blocker",
    layer: "render",
    guarantee: "同上。",
    gap: "G3",
  },
  {
    id: "invite-emit-projects-declared-outputs",
    agent: INVITE_INTERVIEW,
    category: "DATA_CONTRACT",
    severity: "blocker",
    layer: "render",
    guarantee: "同上。",
    gap: "G3",
  },
  {
    id: "createjd-anchor-reads-envelope-positions",
    agent: CREATE_JD,
    category: "DATA_CONTRACT",
    severity: "blocker",
    layer: "spec",
    guarantee:
      "真实事件把业务字段放在 payload 下、锚点放在同级 entity_id。required 锚点必须声明它在信封里的读取位置，否则每次都解析成 undefined。",
    gap: "G7",
  },
  {
    id: "invite-anchor-reads-envelope-positions",
    agent: INVITE_INTERVIEW,
    category: "DATA_CONTRACT",
    severity: "blocker",
    layer: "spec",
    guarantee: "同上。",
    gap: "G7",
  },
  {
    id: "processresume-compensates-on-terminal",
    agent: PROCESS_RESUME,
    category: "SIDE_EFFECT_GUARD",
    severity: "blocker",
    layer: "spec",
    guarantee:
      "解析不了或落库失败时，必须尽力把伙伴系统的状态行标成终态失败再抛原错，否则那行永远停在 pending 被反复重推。",
    gap: "G14",
  },
  {
    id: "processresume-ontology-step-conditions-materialised",
    agent: PROCESS_RESUME,
    category: "ORDERING",
    severity: "major",
    layer: "spec",
    guarantee:
      "本体 action_steps 上写明的 condition 必须落到计划里；否则事件已带解析结果时仍会再付费解析一次。",
    gap: "G11",
  },
  {
    id: "rulecheck-per-item-verdict",
    agent: RULE_CHECK_MATCH,
    category: "WIRING",
    severity: "blocker",
    layer: "spec",
    guarantee:
      "每个可匹配职位要产出一条独立判定。持久化与 emit 必须在 foreach 内按项发生，且零个可匹配项不能落到无条件的成功 emit。",
    gap: "G23",
  },
  {
    id: "processresume-tool-args-match-tool-contract",
    agent: PROCESS_RESUME,
    category: "DATA_CONTRACT",
    severity: "blocker",
    layer: "spec",
    guarantee:
      "计划里的工具参数必须对得上被绑定工具真实的 argsSchema；漏掉对象存储的 bucket 等于每份真实简历都会终态失败。",
    gap: "G21",
  },
  {
    id: "rulecheck-result-paths-match-tool-contract",
    agent: RULE_CHECK_MATCH,
    category: "DATA_CONTRACT",
    severity: "blocker",
    layer: "spec",
    guarantee:
      "resultMap 的取值路径必须能被工具真实返回结构满足；对不上就是第一次真实调用即死。",
    gap: "G21",
  },
  {
    id: "invite-killswitch-before-irreversible-send",
    agent: INVITE_INTERVIEW,
    category: "SIDE_EFFECT_GUARD",
    severity: "major",
    layer: "render",
    guarantee:
      "给真人发面试邀请这种不可逆副作用之前，必须先过运行暂停/开关检查。",
    gap: "G20",
  },
  {
    id: "identity-killswitch-before-write",
    agent: CANDIDATE_IDENTITY,
    category: "SIDE_EFFECT_GUARD",
    severity: "major",
    layer: "render",
    guarantee: "身份判定关闭时必须可跳过且不写任何库。",
    gap: "G20",
  },
  {
    id: "createjd-deterministic-derivation-not-llm",
    agent: CREATE_JD,
    category: "WIRING",
    severity: "blocker",
    layer: "spec",
    guarantee:
      "纯确定性的字段推导（技能拆分、prompt 组装）不能渲染成 LLM 回合——那是不可审计也不可复现的。",
    gap: "G9",
  },
  {
    id: "match-deterministic-derivation-not-llm",
    agent: MATCH_RESUME,
    category: "WIRING",
    severity: "blocker",
    layer: "spec",
    guarantee: "反伪造五项校验必须是确定性代码，不是 LLM 判断。",
    gap: "G9",
  },
  {
    id: "match-dependency-health-attribution",
    agent: MATCH_RESUME,
    category: "OBSERVABILITY",
    severity: "major",
    layer: "render",
    guarantee:
      "供应商的 401/429/5xx 必须记到供应商头上，而我们自己发的 400 不能记；这种不对称本身就是那条保证。",
    gap: "G17",
  },
  {
    id: "processresume-dependency-health-attribution",
    agent: PROCESS_RESUME,
    category: "OBSERVABILITY",
    severity: "major",
    layer: "render",
    guarantee: "同上。",
    gap: "G17",
  },
  {
    id: "match-resultmap-tolerates-optional-fields",
    agent: MATCH_RESUME,
    category: "DATA_CONTRACT",
    severity: "major",
    layer: "spec",
    guarantee:
      "供应商 200 但缺可选字段不应该杀掉正常路径；resultMap 需要可选/默认值的表达能力。",
    gap: "G12",
  },
  {
    id: "processresume-dedup-key-has-content-fallback",
    agent: PROCESS_RESUME,
    category: "IDEMPOTENCY",
    severity: "major",
    layer: "spec",
    guarantee:
      "去重键绑定到可空的事件字段时，必须声明一个内容派生的回退（如内容哈希），否则手工上传场景会产生重复行。",
    gap: "G13",
  },
  {
    id: "createjd-success-path-health-check",
    agent: CREATE_JD,
    category: "FAILURE_HANDLING",
    severity: "major",
    layer: "spec",
    guarantee:
      "「200 但正文为空」这类成功路径异常必须能被识别；错误策略只在 catch 里跑等于这些规则永远不触发。",
    gap: "G15",
  },
];

export const GOLDEN_ASSERTIONS: GoldenAssertion[] = [
  ...ALL_AGENTS.flatMap((agent) =>
    UNIVERSAL.map(({ key, ...rest }) => ({
      ...rest,
      id: `${agent.replace("agents-gener-", "")}/${key}`,
      agent,
    })),
  ),
  ...PER_AGENT,
];
