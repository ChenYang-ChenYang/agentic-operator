/**
 * #ASSISTANT-INQUIRY —— 对话路径的只读查证层与本轮预算。
 *
 * ── 为什么存在 ───────────────────────────────────────────────────────────
 *
 * 对话路径此前只有【一次】JSON 调用：facts 进去，plan 出来。那次调用实测 5–7
 * 秒，期间屏幕上一帧都没有——不是因为没做事，而是因为**一次调用没有中间态可
 * 报**。同一轮里的 Ontology 分析看起来「在思考」，靠的不是更好的 UI，而是它
 * 是多回合的：每次工具调用都是一次真实的模型返回，于是每次都能发一帧。
 *
 * 所以修法不是给对话路径加动画，是让它**真的多回合**：把只读本体工具接到对话
 * 的模型调用上，大脑要查什么就查什么，每一次调用/返回各发一帧。
 *
 * ── 自适应：判断权在大脑，不在这里 ────────────────────────────────────
 *
 * 这个模块**没有**任何「什么样的问题需要查证」的规则。工具是【广告】出去的，
 * 用不用、用几次、要不要另外声明一种推理方法，全部由模型在它自己的回合里决定：
 *   · 一句「下一步做什么」它可以直接给 plan —— 一次调用，和改动前完全一样，
 *     没有任何延迟回归；
 *   · 一句「这个域里 X 和 Y 有关系吗」它会去 read_links 核实 —— 于是屏幕上
 *     先出现「调用工具 · read_links · 核实两者之间是否真有边」，再出现结果。
 * 把「问号结尾 = 简单模式」这类规则写进服务端，就是把判断从大脑手里拿走。
 *
 * 给它**代价**不等于替它做判断。实测的过度调查（全新会话里问「刚才那步是什么
 * 意思」，无任何历史可查，仍花了 5 次调用去读工作流）说明只写「不要为了看起来
 * 在工作而调用工具」不够——模型看不到查一次要多久、还剩几次，也不知道这些工具
 * 读的是静态定义而非运行历史。所以这里补的是**事实与代价**（剩余额度进事实块、
 * 工具自陈它答不出运行历史、`reasoning` 改问反事实），判断仍然是它自己做的。
 *
 * ── 边界 ────────────────────────────────────────────────────────────────
 *
 * 工具闭包在**调用方已经解析好的那一个 DomainOntology** 上（复用
 * `@agentic/agent-factory` 的 `createOntologyReadToolHandlers`，与分析路径同一
 * 份实现）。没有任何工具接受 domain / tenant 参数，所以这条路读不到它没被交给
 * 的东西。这一层里没有任何非只读的工具。
 */

import {
  buildOntologyReadToolSchemas,
  createOntologyReadToolHandlers,
  type DomainOntology,
  type OntologyReadToolResult,
} from "@agentic/agent-factory";
import type { ToolDef } from "@agentic/llm-gateway";

/* ── 预算 ──────────────────────────────────────────────────────────────────
 *
 * 与 `ONTOCODE_COMMAND_POLICY` 里的分析预算**分账**：那些是 Harness 作业的
 * 额度（analyze_ontology 是 300s / 12 次模型调用），一次交互式对话不能按那个
 * 尺度跑——FDE 在等着这一句话回来。这里的默认值是为「问一句、必要时查两三个
 * 事实、答一句」定的，operator 可以按部署改，改不动的是纪律：耗尽时如实收尾，
 * 不假装完成。
 * ---------------------------------------------------------------------- */

export const ONTOCODE_ASSISTANT_MAX_MODEL_CALLS_ENV =
  "ONTOCODE_ASSISTANT_MAX_MODEL_CALLS";
/**
 * 首轮 + 至多一轮查证 + 一次收尾 + 一次重整。
 *
 * 2026-08-04 实测先把它从 5 降到 3：真实模型 + 真实 RAAS 本体上，5 次调用的一轮
 * 均值 22 秒、最坏 42 秒，而 FDE 在聊天框里等着。每多一次调用就是一次完整的
 * provider 往返（实测中位 5.4 秒），所以「多留一次以防万一」不是保险，是把每一轮
 * 都变慢。
 *
 * 同日改回 4，理由不是「再留一次以防万一」，而是**3 从来就不是真数字**：重整调用
 * 此前直接打 provider、不受这个上限管，所以一轮实际最多发 4 次（3 + 重整）。上限
 * 接上重整之后，3 意味着「查了两轮就再也没有重整的余地」——真实通道当场复现：
 * 收尾那次回复不合规、重整无额度、整轮报错，FDE 一个字都没拿到。
 *
 * 所以 4 不是放宽，是把一直在发生的事如实写出来。常见路径仍然是 1–3 次（实测
 * 8 轮平均 2.0），第 4 次只有在收尾回复真的不合规时才发生。
 */
export const ONTOCODE_ASSISTANT_MAX_MODEL_CALLS_DEFAULT = 4;
export const ONTOCODE_ASSISTANT_MAX_TOOL_CALLS_ENV =
  "ONTOCODE_ASSISTANT_MAX_TOOL_CALLS";
export const ONTOCODE_ASSISTANT_MAX_TOOL_CALLS_DEFAULT = 6;
export const ONTOCODE_ASSISTANT_MAX_TOKENS_ENV = "ONTOCODE_ASSISTANT_MAX_TOKENS";
/**
 * 本轮全部 provider 回执上报的 token 之和（输入 + 输出）的硬上限。
 *
 * 此前 `assistant.run.accepted` 帧和 run 行上写着 `maxTokens: 8000`，而同一轮
 * 实测烧掉 96_507 —— 没有任何代码读过那个数字。8_000 也不可能是真上限：光是
 * 事实前缀就有约 18_000 token。这里的默认值是按【真实测得的一轮】定的：首轮
 * 完整事实约 18k，后续回合走精简事实约 5k，加上工具结果与输出，一轮正常在
 * 25k–35k 之间。60_000 因此是「异常膨胀时兜住」的天花板，不是日常会碰到的墙。
 */
export const ONTOCODE_ASSISTANT_MAX_TOKENS_DEFAULT = 60_000;
export const ONTOCODE_ASSISTANT_MAX_WALL_CLOCK_MS_ENV =
  "ONTOCODE_ASSISTANT_MAX_WALL_CLOCK_MS";
/** 一次对话的耐心上限。超过这个数，人已经在想是不是卡住了。 */
export const ONTOCODE_ASSISTANT_MAX_WALL_CLOCK_MS_DEFAULT = 60_000;
/** 一次工具返回喂回模型的序列化上限。unclipped 的整契约读走下面那个。 */
export const ONTOCODE_ASSISTANT_TOOL_RESULT_CHARS_ENV =
  "ONTOCODE_ASSISTANT_TOOL_RESULT_CHARS";
export const ONTOCODE_ASSISTANT_TOOL_RESULT_CHARS_DEFAULT = 12_000;
export const ONTOCODE_ASSISTANT_UNCLIPPED_RESULT_CHARS_ENV =
  "ONTOCODE_ASSISTANT_UNCLIPPED_RESULT_CHARS";
export const ONTOCODE_ASSISTANT_UNCLIPPED_RESULT_CHARS_DEFAULT = 40_000;

export interface OntoCodeAssistantTurnBudget {
  maxModelCalls: number;
  maxToolCalls: number;
  /** 本轮 provider 回执上报的 token 之和（输入 + 输出）的上限。 */
  maxTokens: number;
  maxWallClockMs: number;
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min ? Math.floor(raw) : fallback;
}

export function resolveOntoCodeAssistantTurnBudget(): OntoCodeAssistantTurnBudget {
  return {
    maxModelCalls: envInt(
      ONTOCODE_ASSISTANT_MAX_MODEL_CALLS_ENV,
      ONTOCODE_ASSISTANT_MAX_MODEL_CALLS_DEFAULT,
      1,
    ),
    maxToolCalls: envInt(
      ONTOCODE_ASSISTANT_MAX_TOOL_CALLS_ENV,
      ONTOCODE_ASSISTANT_MAX_TOOL_CALLS_DEFAULT,
      0,
    ),
    maxTokens: envInt(
      ONTOCODE_ASSISTANT_MAX_TOKENS_ENV,
      ONTOCODE_ASSISTANT_MAX_TOKENS_DEFAULT,
      1_000,
    ),
    maxWallClockMs: envInt(
      ONTOCODE_ASSISTANT_MAX_WALL_CLOCK_MS_ENV,
      ONTOCODE_ASSISTANT_MAX_WALL_CLOCK_MS_DEFAULT,
      1_000,
    ),
  };
}

/* ── 大脑登记判断的方式：这条路整条不在了 ─────────────────────────────────
 *
 * 两代机制都已删除，按同一把尺子：
 *
 * 1. `declare_approach` 工具（一整个 provider 往返只为登记「我打算怎么推理」）。
 *    实测 7 轮里调了 6 轮、一次都没选出 react 以外的方法、内核一帧没跑；而且它
 *    什么都没驱动——循环里没有任何分支读它。
 * 2. 折叠进回复契约的 `deliberation` 字段 + 真跑推理内核。实测同样判了死刑：
 *    出厂 `maxModelCalls` 下审议额度恒为 1（永远给收尾留一次），reflection 要 2、
 *    debate/tot 要 branches+1=4 ⇒ 除 cot 外全部 refused，而 cot 的子步帧与方法级
 *    帧内容重合；33 轮真实对话（上一轮 25 + 本轮 8）里模型一次都没声明过非
 *    react。让它可达就得加预算，而单次 provider 往返实测中位 5.4 秒。
 *
 * 所以这里不再有方法词表、先验建议、分叉数旋钮——它们只有那条路会读。留一份
 * 「谁都不读的配置」比删掉它更贵：它会让下一个人以为这条路还在。
 * 分析路径（ontology_analysis / blueprint / scope）的推理内核完全不受影响，
 * 那边是后台作业，没有人在聊天框前面等。
 * ---------------------------------------------------------------------- */

/**
 * 只读工具，转成中央网关的 ToolDef 形状。
 *
 * 名字里没有点号：网关会把点号编码成 `__` 再解码，能用，但对话这条路没有命名
 * 空间冲突，多一层编解码只会让帧上的工具名与模型看到的名字对不上。
 */
/**
 * 每个只读工具都要说清它**答不出**什么。
 *
 * 实测的过度调查里，模型的自陈理由是「需要查看工作流历史来确定他指代的是哪一
 * 步」——它把 `read_workflow` 当成了运行历史。这不是它不守规矩，是我们没告诉它
 * 这些工具读的是**静态定义**：本体里没有「刚才」「上一次」「谁在什么时候跑过
 * 什么」。补上这句事实之后它自己就不去查了。这是澄清事实，不是加一条分支规则。
 */
const READ_ONLY_SCOPE_NOTE =
  "（本工具读的是业务模型的静态定义。它不包含任何运行历史与时间信息：谁在什么时候做过什么、「刚才那一步」是哪一步，这里一概查不到。）";

/**
 * #ASSISTANT-FACTS-FIRST —— 按需取一个运行时工具的字段级契约。
 *
 * 首轮事实块里 87% 是这些契约（实测 57_988 / 66_493 字符），而它们回答的是
 * 「**这一个**工具的入参叫什么」——一轮里最多问到一两个的按需事实。首轮改成
 * 只给名字/摘要/能力标签 + 字段数量（够判断「我们有没有这个能力」），完整契约
 * 挪到这里现取。
 *
 * 它读的是本轮**已经**为这个租户/域解析好的那份目录，与只读本体工具同一条
 * 闭包边界：不接受域或租户参数，也没有第二个数据源可指。
 */
export const ONTOCODE_ASSISTANT_TOOL_CONTRACT_TOOL = "read_tool_contract";

export function buildOntoCodeAssistantInquiryToolDefs(input?: {
  /** 目录缺席时这个工具不广告出去：一个答不出东西的工具比没有更糟。 */
  hasToolCatalog?: boolean;
}): ToolDef[] {
  const defs = buildOntologyReadToolSchemas().map((schema) => ({
    name: schema.function.name,
    description: `${schema.function.description ?? ""}${READ_ONLY_SCOPE_NOTE}`,
    input_schema: withConversationalReasoningPrompt(schema.function.parameters),
  }));
  if (!input?.hasToolCatalog) return defs;
  defs.push({
    name: ONTOCODE_ASSISTANT_TOOL_CONTRACT_TOOL,
    description:
      "读一个运行时工具的完整字段级契约（入参 / 返回 / 配置项，含每个字段的键名、类型、是否必填与说明）。" +
      "facts 里的 runtime_tool_catalog 已经给了每个工具的名字、摘要、能力标签与各段字段的**数量**——" +
      "判断「我们有没有能干这件事的工具」用那些就够了，不需要调用本工具。" +
      "只有当你要说出某个具体工具的参数名/返回字段名时才调用它。" +
      "（本工具读的是当前运行时工具目录，不是业务模型快照，所以它的结果没有可引用的 cite_as。）",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "工具名，从 runtime_tool_catalog 里逐字复制。不要猜一个名字。",
        },
        reasoning: {
          type: "string",
          description:
            "一句中文说清：不查这一条，你接下来那句话会说错什么。只是想「确认一下」不是理由。",
        },
      },
      required: ["name", "reasoning"],
      additionalProperties: false,
    },
  });
  return defs;
}

/**
 * 对话这条路上，`reasoning` 问的不是「你要查什么」而是**反事实**：不查的话你会
 * 说错什么。
 *
 * 分析路径是后台作业，多查一次只是慢一点；对话路径每查一次都是 FDE 在聊天框前
 * 多等一个往返。实测的过度调查（全新会话里问「刚才那步是什么意思」，无任何历史
 * 可查，仍去读了工作流和一个动作）说明「不要为了看起来在工作而调用工具」这句
 * 提示不够——它没有逼模型把**代价的正当性**说出来。schema 强制的字段能。
 *
 * 这不是一条「什么该查」的规则：判断仍然完全是模型做的，我们只是要求它把判断
 * 的依据写下来。分析路径的同一个字段不受影响（那边的预算尺度完全不同）。
 */
function withConversationalReasoningPrompt(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = parameters.properties as
    | Record<string, { description?: string }>
    | undefined;
  const reasoning = properties?.reasoning;
  if (!reasoning) return parameters;
  return {
    ...parameters,
    properties: {
      ...properties,
      reasoning: {
        ...reasoning,
        description:
          "一句中文说清：不查这一条，你接下来那句话会说错什么。查证只能核实一个【已经确定】的对象，说不出会说错什么就不要调用它——直接回答，或者用 clarify 问清楚。",
      },
    },
  };
}

/* ── 执行器 ──────────────────────────────────────────────────────────────── */

export interface OntoCodeAssistantInquiryCall {
  tool: string;
  /** 模型自陈的这一步为什么。schema 强制必填，缺席时如实标注为「未说明」。 */
  reasoning: string;
  /** 除 reasoning 之外的参数的一行摘要，用于帧正文。 */
  argsSummary: string;
}

export interface OntoCodeAssistantInquiryOutcome {
  result: OntologyReadToolResult;
  /** 喂回模型的序列化正文，已按上限截断且截断会自陈。 */
  serialized: string;
  /**
   * #ASSISTANT-CITE —— 这一次读出来的事实的规范引用。
   *
   * 实测 4/4 轮的校验帧都是 `citationValid 0 / citationUnverified 0`：查证读到的
   * 东西一条都没有进引用契约，因为 `suppliedRefs` 只装编译上下文里的引用，模型
   * 想引用刚读到的动作契约也无从引起。引用锚在**本 Session 的快照哈希**上，
   * 片段说明读的是什么——所以它可被核验，不是一个自造的字符串。
   * 读失败（`ok:false`）不产生引用：引用的前提是真的读到了。
   */
  citableRef: string | null;
}

const ARGS_SUMMARY_CHARS = 200;

function clip(value: string, max: number): string {
  const text = value.trim().replace(/\s+/gu, " ");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** 参数摘要。`reasoning` 单独成帧字段，不在这里重复。 */
export function summariseInquiryArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (key === "reasoning") continue;
    if (value === undefined || value === null || value === "") continue;
    parts.push(
      `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
    );
  }
  return clip(parts.join(" · "), ARGS_SUMMARY_CHARS);
}

/**
 * 一次读的规范引用。锚是本 Session 的快照哈希（与编译上下文里的 `ontology:<hash>`
 * 同一个锚），片段说明这一次读的是什么——所以引用可被核验回同一份快照。
 * 没有快照哈希就不生成引用：编不出可核验的锚时，缺席比造一个好。
 */
export function ontoCodeAssistantReadRef(input: {
  snapshotHash: string | null;
  tool: string;
  args: Record<string, unknown>;
}): string | null {
  const hash = input.snapshotHash?.trim().replace(/^sha256:/u, "");
  if (!hash) return null;
  const subject = ["name", "query", "anchor", "filter", "table", "metric"]
    .map((key) => input.args[key])
    .find((value) => typeof value === "string" && value.trim().length > 0);
  const fragment =
    typeof subject === "string"
      ? `${input.tool}(${clip(subject, 120)})`
      : input.tool;
  return `ontology:${hash}#${fragment}`;
}

export interface OntoCodeAssistantInquiryExecutor {
  /** 这一轮向模型广告出去的只读工具名。 */
  readonly toolNames: readonly string[];
  /** 把一次模型工具调用解读成一次可发帧的调用意图。 */
  describe(name: string, args: Record<string, unknown>): OntoCodeAssistantInquiryCall;
  /** 真的执行它。未知工具名不抛——如实返回一条失败结果让模型自纠。 */
  execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<OntoCodeAssistantInquiryOutcome>;
}

/** 首轮事实里被折成计数的那一段，按需在这里还原成完整契约。 */
export interface OntoCodeAssistantCatalogTool {
  name: string;
  summary: string;
  contract: {
    args: unknown[];
    returns: unknown[];
    config: unknown[];
    truncated: boolean;
  } | null;
}

export function createOntoCodeAssistantInquiryExecutor(input: {
  ontology: DomainOntology;
  /** 本 Session 绑定快照的哈希。缺席 = 这一轮的读不产生可引用的引用。 */
  snapshotHash?: string | null;
  /**
   * 本轮已经解析好的运行时工具目录。缺席 = `read_tool_contract` 不存在，
   * 而不是「目录是空的」——后者会让模型据此断言这个租户没有任何工具。
   */
  toolCatalog?: readonly OntoCodeAssistantCatalogTool[];
}): OntoCodeAssistantInquiryExecutor {
  const handlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<OntologyReadToolResult> | OntologyReadToolResult
  > = createOntologyReadToolHandlers({ ontology: input.ontology });
  if (input.toolCatalog) {
    const catalog = input.toolCatalog;
    handlers[ONTOCODE_ASSISTANT_TOOL_CONTRACT_TOOL] = (args) => {
      const wanted = typeof args.name === "string" ? args.name.trim() : "";
      const tool = catalog.find((entry) => entry.name === wanted);
      if (!tool) {
        // 不做模糊匹配：拿一个名字相近的工具的契约回答，比答不出更危险。
        const near = catalog
          .filter((entry) =>
            wanted.length >= 3
              ? entry.name.toLowerCase().includes(wanted.toLowerCase())
              : false,
          )
          .slice(0, 8)
          .map((entry) => entry.name);
        return {
          ok: false,
          summary:
            `工具目录里没有名为「${clip(wanted || "(空)", 120)}」的工具。` +
            (near.length > 0
              ? `名字里含这段的有：${near.join("、")}。请逐字复制其中一个。`
              : "请从 runtime_tool_catalog 里逐字复制一个工具名。"),
        };
      }
      if (!tool.contract) {
        return {
          ok: true,
          summary: `「${tool.name}」在目录里没有登记字段级契约——不是它没有参数，是这一项我们没有。`,
          output: { name: tool.name, summary: tool.summary, contract: null },
        };
      }
      return {
        ok: true,
        summary:
          `「${tool.name}」的契约：入参 ${tool.contract.args.length} 项、` +
          `返回 ${tool.contract.returns.length} 项、配置 ${tool.contract.config.length} 项` +
          (tool.contract.truncated ? "（目录侧已自陈截断）" : ""),
        // 契约整段可能不小，但它是被**点名要来的**——这里不再二次折叠。
        unclipped: true,
        output: {
          name: tool.name,
          summary: tool.summary,
          contract: tool.contract,
        },
      };
    };
  }
  const resultCap = envInt(
    ONTOCODE_ASSISTANT_TOOL_RESULT_CHARS_ENV,
    ONTOCODE_ASSISTANT_TOOL_RESULT_CHARS_DEFAULT,
    500,
  );
  const unclippedCap = envInt(
    ONTOCODE_ASSISTANT_UNCLIPPED_RESULT_CHARS_ENV,
    ONTOCODE_ASSISTANT_UNCLIPPED_RESULT_CHARS_DEFAULT,
    500,
  );
  const toolNames = Object.keys(handlers);

  const serialize = (
    result: OntologyReadToolResult,
    citableRef: string | null,
  ): string => {
    const body = JSON.stringify({
      ok: result.ok,
      summary: result.summary,
      ...(result.output === undefined ? {} : { output: result.output }),
      // 模型必须能看到「这条事实怎么引用」，否则引用契约对查证读到的东西永远是空的。
      ...(citableRef ? { cite_as: citableRef } : {}),
    });
    const cap = result.unclipped ? unclippedCap : resultCap;
    if (body.length <= cap) return body;
    // 截断绝不沉默：模型必须知道它读到的是开头一段，否则它会把片段当全文引用。
    return `${body.slice(0, cap)}\n……〔本条结果共 ${body.length} 字符，此处为前 ${cap} 字符；需要完整内容请缩小查询范围后重读〕`;
  };

  return {
    toolNames,
    describe: (name, args) => ({
      tool: name,
      reasoning:
        typeof args.reasoning === "string" && args.reasoning.trim()
          ? args.reasoning.trim()
          : "（模型未说明这一步的理由）",
      argsSummary: summariseInquiryArgs(args),
    }),
    execute: async (name, args) => {
      const handler = handlers[name as keyof typeof handlers];
      if (!handler) {
        const result: OntologyReadToolResult = {
          ok: false,
          summary: `没有名为「${clip(name, 80)}」的工具。可用的只读工具：${Object.keys(handlers).join("、")}`,
        };
        return { result, serialized: serialize(result, null), citableRef: null };
      }
      try {
        const result = await handler(args);
        // 只有真的读到了才给引用。失败的读不产生可引用的事实。
        //
        // 工具契约是个例外：它来自**运行时工具目录**，不是本 Session 绑定的本体
        // 快照。给它一个 `ontology:<hash>#…` 的引用等于宣称它能核验回那份快照，
        // 而它核验不回去。缺席是这里唯一诚实的选项。
        const citableRef =
          result.ok && name !== ONTOCODE_ASSISTANT_TOOL_CONTRACT_TOOL
            ? ontoCodeAssistantReadRef({
                snapshotHash: input.snapshotHash ?? null,
                tool: name,
                args,
              })
            : null;
        return { result, serialized: serialize(result, citableRef), citableRef };
      } catch (error) {
        // 工具自身抛了。如实回给模型让它换个查法，不要把一次对话整轮打死。
        const result: OntologyReadToolResult = {
          ok: false,
          summary: `工具执行失败：${clip(
            error instanceof Error ? error.message : String(error),
            240,
          )}`,
        };
        return { result, serialized: serialize(result, null), citableRef: null };
      }
    },
  };
}
