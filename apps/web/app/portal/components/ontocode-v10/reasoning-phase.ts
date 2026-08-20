/**
 * 推理子步的角色 → 人话。
 *
 * 服务端的推理内核现在在**每一次内部调用真的返回时**就发一帧（`onSubStep`），
 * 帧上多了一个 `phase`：一次 reflection 内部是 draft→critique→rewrite，一次
 * debate 是 N 个论证者加一次裁决。没有这一层，三次真实的模型调用在屏幕上是
 * 三行一模一样的「reflection 1/3、2/3、3/3」——帧多了，信息没多。
 *
 * `phase` 的值直接来自内核的 `purpose: "kernel:<方法>.<角色>"`，是引擎内部标识
 * （`draft` / `p0` / `merge`）。它一个都不许原样示人，而内核多一个角色时这里
 * 必须当场变红——`reasoning-phase.test.ts` 直接扫内核源码交叉校验。
 */

/** 角色 → 人话。认不出返回 null：这一格宁可缺席，也不把内部标识印出去。 */
export function reasoningPhaseName(phase: string): string | null {
  const named = FIXED_PHASE_NAMES[phase];
  if (named) return named;
  // 分叉角色带下标（debate 的论证者、tot 的分支）。内核下标从 0 起，给人看的
  // 序数从 1 起——`论证 0` 是内部编号，不是读者的读法。
  const indexed = /^([a-z]+)(\d+)$/.exec(phase);
  if (indexed) {
    const family = INDEXED_PHASE_NAMES[indexed[1]!];
    if (family) return `${family} ${Number(indexed[2]!) + 1}`;
  }
  return null;
}

const FIXED_PHASE_NAMES: Record<string, string> = {
  draft: "起草",
  critique: "自审",
  rewrite: "重写",
  judge: "裁决",
  merge: "归并",
  plan: "拟定步骤",
};

const INDEXED_PHASE_NAMES: Record<string, string> = {
  /** debate 的第 i 个论证者。 */
  p: "论证",
  /** tot 的第 i 条分支。 */
  b: "分支",
};

/**
 * 内核 `purpose` 里的角色段，按源码里写的形态原样返回（模板形保留 `${…}`）。
 *
 * 只收有角色段的（`kernel:<方法>.<角色>`）。`kernel:cot` 这种没有角色段的，
 * 内核把 phase 填成方法名本身，而服务端的帧构造器只在 `phase !== strategy`
 * 时才写这个字段——它到不了前端，不该被算进这条不变量。
 */
export function extractKernelSubStepPhases(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*(?:\/\/|\*).*$/gm, "");
  const phases = new Set<string>();
  for (const match of code.matchAll(
    /purpose: *[`"]kernel:[a-z_]+\.([^`"]+)[`"]/g,
  )) {
    phases.add(match[1]!);
  }
  return [...phases].sort();
}

/**
 * 内核分叉数被 clamp 成 `max(2, min(branches ?? 3, 5))`，所以模板下标最大到 4。
 * 判定必须逐个展开：只判模板字面量会漏掉整整一族真实会出现的值。
 */
const MAX_KERNEL_BRANCHES = 5;

export function expandKernelPhaseToken(token: string): string[] {
  if (!token.includes("${")) return [token];
  const stem = token.replace(/\$\{[^}]*\}/g, "");
  return Array.from(
    { length: MAX_KERNEL_BRANCHES },
    (_value, index) => `${stem}${index}`,
  );
}

/** 内核会发、而前端没有人话名字的角色。空数组 = 覆盖完整。 */
export function unnamedKernelPhases(tokens: readonly string[]): string[] {
  const missing: string[] = [];
  for (const token of tokens) {
    for (const phase of expandKernelPhaseToken(token)) {
      if (reasoningPhaseName(phase) === null) missing.push(phase);
    }
  }
  return missing;
}
