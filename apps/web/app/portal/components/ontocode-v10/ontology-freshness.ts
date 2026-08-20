import type { OntoCodeOntologyFreshness } from "@agentic/contracts";

/**
 * 把服务端【测量】出的本体新鲜度，映射成左栏那一枚常驻芯片。
 *
 * 两条不许违反的规矩：
 *  1. 读不到的源永远不能显示成「最新」——`unavailable` 有自己的标签，
 *     真实原因逐字进 HelpTip，不允许被兜底成一句好看的话。
 *  2. `shadowed`（上传件在可用线上源之上作答，且没有显式绑定选中它）
 *     必须写在标签上。这是 FDE 今天在界面上完全看不见的一格，藏进
 *     tooltip 等于没说。
 *
 * 标签是常驻 UI：只给短词，不写句子，永不带哈希。需要解释的一律进 HelpTip。
 */

export type OntologyFreshnessTone = "ok" | "warn" | "bad";

export interface OntologyFreshnessChipVM {
  /** 常驻短标签。 */
  label: string;
  tone: OntologyFreshnessTone;
  /** 需要展开说明时的 HelpTip 文案；没有可说的就是 null。 */
  helpText: string | null;
  /** 芯片可执行的既有恢复路径；没有就是 null。 */
  action: "createSession" | null;
}

/** servedBy 是「谁真的作答了」，不是配置里写了谁。 */
const SOURCE_LABEL: Record<
  NonNullable<OntoCodeOntologyFreshness["servedBy"]>,
  string
> = {
  allmeta: "Allmeta",
  upload: "上传件",
  manifest: "本地清单",
};

const UNKNOWN_SOURCE_LABEL = "未知源";

const SHADOW_HELP =
  "这个域的本体由上传件作答，而线上源本来也能提供；没有任何显式绑定选中它";

const CHANGED_HELP =
  "本体源现在提供的内容已经和这个会话锁定的快照不同；要基于新内容工作请新建会话";

export function describeOntologyFreshness(
  freshness: OntoCodeOntologyFreshness | null | undefined,
): OntologyFreshnessChipVM | null {
  // 还没测量过 ≠ 一切正常。调用方保留原来的「已锁定/待锁定」，不冒充核对结果。
  if (!freshness) return null;

  if (freshness.status === "unavailable") {
    // 原因逐字放最前面，HelpTip 的 aria-label 就是它。
    const reason =
      freshness.reason?.trim() || "本体源没有给出失败原因";
    return {
      label: "无法核对",
      tone: "bad",
      helpText: freshness.shadowed ? `${reason}（此前由上传件作答）` : reason,
      action: null,
    };
  }

  if (freshness.status === "changed") {
    return freshness.shadowed
      ? {
          label: "上传件已变",
          tone: "warn",
          helpText: `${SHADOW_HELP}；${CHANGED_HELP}`,
          action: "createSession",
        }
      : {
          label: "本体已更新",
          tone: "warn",
          helpText: CHANGED_HELP,
          action: "createSession",
        };
  }

  if (freshness.shadowed) {
    return {
      label: "上传件覆盖",
      tone: "warn",
      helpText: SHADOW_HELP,
      action: null,
    };
  }

  if (freshness.servedBy === null) {
    return {
      label: `${UNKNOWN_SOURCE_LABEL} · 最新`,
      tone: "ok",
      helpText: "内容与锁定快照一致，但服务端没有说明是哪个源提供的本体",
      action: null,
    };
  }

  return {
    label: `${SOURCE_LABEL[freshness.servedBy]} · 最新`,
    tone: "ok",
    helpText: null,
    action: null,
  };
}
