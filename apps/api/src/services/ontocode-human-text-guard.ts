/**
 * #HUMAN-TEXT-GUARD — internal identifiers stay in the backend and the
 * reasoning trace; they never reach the FDE's screen.
 *
 * The workspace projection layer already enforces that on everything IT
 * renders (`FORBIDDEN_VOCABULARY` in the web's ontocode-v10 projection). Chat
 * message TEXT, however, is composed on the SERVER and shipped verbatim into
 * the conversation, where no guard existed. A scan of live session messages
 * found leaks from several producers at once: raw command-type tokens, Command
 * and Harness Job ids, HITL interaction ids, content hashes, and the engine's
 * own product names.
 *
 * This module is a DETECTOR, not a scrubber, and that is deliberate. Filtering
 * the string at runtime would repair the symptom while leaving the producer
 * free to keep composing machine text — the bug would become invisible instead
 * of impossible. It is therefore applied as a test over the real producers, so
 * a regression fails the build at the place that wrote it.
 *
 * Scope: text THIS SERVER composes. An FDE's own pasted words and a model's
 * authored answer body are not in scope — the server neither invents nor owns
 * those, and scanning them would flag the human for quoting their own data.
 */

export type OntoCodeHumanTextLeakKind =
  | "internal_id"
  | "content_hash"
  | "engine_vocabulary"
  | "internal_state_token"
  /** A machine identifier for an action or a read-only tool, spelled into prose. */
  | "engine_tool_name"
  /** The engine's own object nouns used as nouns in an FDE-facing sentence. */
  | "engine_object_noun"
  /** Our own turn machinery (budget, allowance, tool loop) described to a human. */
  | "internal_mechanism";

export interface OntoCodeHumanTextLeak {
  kind: OntoCodeHumanTextLeakKind;
  /** The exact offending substring, so a failure names what leaked. */
  match: string;
}

/**
 * Prefixed OntoCode identifiers followed by a hex/uuid body:
 * Artifact (`oca-`), Artifact Version (`ocav-`), Harness Job (`ocj-`),
 * Command (`occ-`), Session (`ocs-`), Message (`ocm-`), Event (`ocev-`).
 * Longer prefixes lead the alternation so `ocav-` is not read as `oca` + `v`.
 */
const PREFIXED_ID_PATTERN = /\boc(?:av|ev|a|c|j|m|s)-[0-9a-f][0-9a-f-]{5,}/gi;

/** HITL interaction ids, which routed answers and were printed into prose. */
const HITL_ID_PATTERN = /\bhitl_[0-9a-f][0-9a-f-]{5,}/gi;

/**
 * Bare hex runs — content hashes, ontology digests, truncated uuids — which the
 * projection guard does not cover because they carry no prefix to key on.
 *
 * Pure-decimal runs are excluded: an 8+ digit number in FDE-facing text is far
 * more likely to be a real quantity or a date than a hash, and flagging those
 * would make the guard something people route around. A run must contain at
 * least one hex letter to count. Runs of only a–f letters that long do not
 * occur in real prose, so requiring a digit as well would only create a hole.
 */
const CONTENT_HASH_PATTERN =
  /\b(?=[0-9a-f]{8,}\b)[0-9a-f]*[a-f][0-9a-f]*\b/gi;

/**
 * The engine's names for itself and for its own objects. `Command` and `Job`
 * are matched capitalised only — that is the object-noun use ("a Command was
 * created"); the ordinary lowercase English words are legitimate prose.
 */
const ENGINE_VOCABULARY_PATTERNS: RegExp[] = [
  /Agent\s+Factory/gi,
  /\bharness\b/gi,
  /\bCommands?\b/g,
  /\bJobs?\b/g,
];

/**
 * Raw state-machine tokens. Same class of defect and the same ban list the
 * projection layer already applies — mirrored here because the server is the
 * producer, and a state token spelled into chat is an internal identifier by
 * another name.
 */
const INTERNAL_STATE_TOKEN_PATTERN =
  /\b(?:activityState|needs_user|failed_recoverable|review_required|waiting_user)\b/g;

function collect(
  text: string,
  pattern: RegExp,
  kind: OntoCodeHumanTextLeakKind,
  into: OntoCodeHumanTextLeak[],
): void {
  // Fresh lastIndex each call: these are module-level /g regexes.
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    into.push({ kind, match: match[0] });
  }
}

/**
 * Every internal identifier or engine noun found in one piece of
 * server-composed, FDE-facing text. Empty array means clean.
 */
export function findOntoCodeHumanTextLeaks(
  text: string,
): OntoCodeHumanTextLeak[] {
  const leaks: OntoCodeHumanTextLeak[] = [];
  collect(text, PREFIXED_ID_PATTERN, "internal_id", leaks);
  collect(text, HITL_ID_PATTERN, "internal_id", leaks);
  collect(text, CONTENT_HASH_PATTERN, "content_hash", leaks);
  for (const pattern of ENGINE_VOCABULARY_PATTERNS) {
    collect(text, pattern, "engine_vocabulary", leaks);
  }
  collect(text, INTERNAL_STATE_TOKEN_PATTERN, "internal_state_token", leaks);
  return leaks;
}

/** Convenience predicate for call sites that only need pass/fail. */
export function isOntoCodeHumanTextClean(text: string): boolean {
  return findOntoCodeHumanTextLeaks(text).length === 0;
}

/* ── #HUMAN-TEXT-GUARD-REPLY —— 对话正文那一段 ────────────────────────────
 *
 * 上面那两道守卫（这里的检测器 + web 投影层的 FORBIDDEN_VOCABULARY）都**抓不到**
 * 实测漏出去的这一类：`analyze_ontology`、`read_action`、`list_events` 这样的机器
 * 标识符，`Action / Event / Ontology / Scope / Blueprint` 这些引擎名词当名词用，
 * 以及「本轮查证额度已用尽」这种把我们自己的回合机制讲给业务方听的句子。原因很
 * 直白：上面的模块把「模型自己写的回答正文」明确排除在范围外。
 *
 * 但回答正文**是服务端教出来的**——提示词里的 few-shot 写什么，模型就写什么
 * （`ontoCodeAssistantSystemPrompt` 上的注释已经记过一次同样的教训）。所以这一
 * 段的第一用途是扫**我们自己组装的提示词**：只要提示词里还有这些词，回归就在源头
 * 被拦下。第二用途是扫模型这一轮的回答，把泄漏**如实计数**报到校验帧上——不做
 * 运行时改写：改写会把缺陷变得不可见，而多花一次重整调用去修一个措辞问题，代价
 * 正好是这一轮要消灭的那种延迟。
 *
 * 领域自己的名字（createJD、RESUME_PROCESSED）不在此列：它们是业务名，不是引擎
 * 词汇，模型应当照原样使用。
 */

/** 内部动作名与只读工具名。全是 snake_case 机器标识符，业务正文里不该出现。 */
export const ONTOCODE_ENGINE_TOOL_NAMES = [
  "analyze_ontology",
  "analyze_scope",
  "propose_blueprint",
  "generate_package",
  "patch_artifact",
  "generate_tests",
  "run_tests",
  "debug_failure",
  "compare_candidate",
  "configure_integration",
  "verify_configuration",
  "declare_approach",
  "list_events",
  "read_action",
  "read_object",
  "read_links",
  "read_rule",
  "read_workflow",
  "coverage_gaps",
  "compare_actions",
  "table_data",
  "chart_data",
  "read_tool_contract",
] as const;

const ENGINE_TOOL_NAME_PATTERN = new RegExp(
  `\\b(?:${ONTOCODE_ENGINE_TOOL_NAMES.join("|")})\\b`,
  "g",
);

/**
 * 引擎名词。只匹配**首字母大写的独立单词**——那是「把它当对象名在用」的写法，
 * 也正是实测漏出去的写法。中文正文里出现它们没有任何业务读者受益。
 * `Command` / `Job` 已由上面的 ENGINE_VOCABULARY_PATTERNS 覆盖，不在这里重复。
 */
const ENGINE_OBJECT_NOUN_PATTERN =
  /\b(?:Actions?|Events?|Ontology|Scopes?|Blueprints?|Candidates?|Sessions?)\b/g;

/** 我们自己的回合机制。业务方不该从回答里读到我们的额度与循环。 */
const INTERNAL_MECHANISM_PATTERNS: RegExp[] = [
  /查证额度/g,
  /额度已用尽/g,
  /工具循环/g,
  /模型调用/g,
  /工具调用/g,
];

/**
 * FDE 会读到的**对话正文**里的引擎词汇。空数组 = 干净。
 *
 * 与 `findOntoCodeHumanTextLeaks` 是叠加关系而非替代：那一个管标识符与哈希，
 * 这一个管词汇。扫提示词时两个都该跑。
 */
export function findOntoCodeAssistantReplyLeaks(
  text: string,
): OntoCodeHumanTextLeak[] {
  const leaks: OntoCodeHumanTextLeak[] = [];
  collect(text, ENGINE_TOOL_NAME_PATTERN, "engine_tool_name", leaks);
  collect(text, ENGINE_OBJECT_NOUN_PATTERN, "engine_object_noun", leaks);
  for (const pattern of INTERNAL_MECHANISM_PATTERNS) {
    collect(text, pattern, "internal_mechanism", leaks);
  }
  return leaks;
}

/** 同上，人读的一行。 */
export function describeOntoCodeAssistantReplyLeaks(text: string): string {
  return findOntoCodeAssistantReplyLeaks(text)
    .map((leak) => `${leak.kind}:${leak.match}`)
    .join(", ");
}

/** Human-readable failure detail: what leaked, and of which kind. */
export function describeOntoCodeHumanTextLeaks(text: string): string {
  return findOntoCodeHumanTextLeaks(text)
    .map((leak) => `${leak.kind}:${leak.match}`)
    .join(", ");
}
