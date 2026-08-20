// OntoCode v10 · 执行方式（autonomy mode）的共享文案。
// Composer 与 CreateSessionPanel 各自维护过一份措辞不同的边界说明；
// 现在合并成唯一权威，常驻界面只留 label，边界事实收进 HelpTip。
import type { OntoCodeAutonomyMode } from "@agentic/contracts";

export interface AutonomyModeCopy {
  value: OntoCodeAutonomyMode;
  label: string;
  /** 该模式的能力边界事实——必须原样保留，不得弱化。 */
  description: string;
}

export const AUTONOMY_MODE_COPY: AutonomyModeCopy[] = [
  {
    value: "sandbox_autopilot",
    label: "自主执行",
    description:
      "自主执行仅限已授权的本机沙箱与无外部副作用步骤；外部写入、生产晋级和部署仍需显式授权。",
  },
  {
    value: "copilot",
    label: "每步确认",
    description: "每个有副作用或会改变代码生成状态的步骤都会先请你确认。",
  },
  {
    value: "guide",
    label: "仅分析",
    description: "仅分析只读取与解释，不生成、测试、写入、晋级或部署。",
  },
];

export function autonomyModeDescription(mode: string): string | null {
  return (
    AUTONOMY_MODE_COPY.find((option) => option.value === mode)?.description ??
    null
  );
}
