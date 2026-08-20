import { describe, it, expect } from "vitest";
import { systemPrompt, rankLessons } from "./system-prompt";
import type { ReflectionLite } from "./brain-types";

// Phase 0(b): the brain carries zero production-discipline knowledge today. Inject a
// "production patterns" module (durability, failure taxonomy, timezone, vendor-envelope
// quirks) + a multi-step plan exemplar, in BOTH languages.

describe("system prompt carries production-discipline knowledge (Phase 0b)", () => {
  for (const lang of ["zh", "en"] as const) {
    describe(lang, () => {
      const p = systemPrompt("recruitment", [], lang);
      it("teaches per-write durability (step.run)", () => {
        expect(p).toContain("step.run");
      });
      it("teaches the vendor failure taxonomy (UNPARSEABLE vs server)", () => {
        expect(p).toContain("UNPARSEABLE");
      });
      it("teaches timezone discipline (Asia/Shanghai)", () => {
        expect(p).toContain("Asia/Shanghai");
      });
      it("includes a multi-step plan exemplar (not a single decision)", () => {
        // the exemplar lists several ordered steps for one agent
        expect(p.toLowerCase()).toContain("idempot");
      });
      it("never treats a recommendation or timeout as human authorization", () => {
        expect(p).toContain(
          lang === "zh"
            ? "recommended 只是你的建议，不是用户授权"
            : "A recommendation is advice, never authorization",
        );
        expect(p).toContain(
          lang === "zh" ? "不许替用户自动选择" : "must not auto-select",
        );
      });
      it("keeps the FDE experience concise and uses isolated synthetic test data", () => {
        expect(p).toContain("supply_test_data.synthetic_resumes");
        expect(p).toContain(
          lang === "zh" ? "不展开思考" : "not chain-of-thought",
        );
        expect(p).toContain(
          lang === "zh"
            ? "不要为普通沙箱测试索要真实邮箱"
            : "Never put API keys",
        );
      });
      it("keeps Ontology logic routers intact and prose conditions non-executable", () => {
        expect(p).toContain(
          lang === "zh"
            ? "源 kind=logic 的路由选择步保持 logic"
            : "A source kind=logic route selector stays logic",
        );
        expect(p).toContain(
          lang === "zh"
            ? "自然语言，只作证据并省略 plan.condition"
            : "natural-language source condition is evidence only",
        );
      });
    });
  }
});

describe("rankLessons (Phase 5 — dedup + relevance ranking for the lessons block)", () => {
  const r = (kind: ReflectionLite["kind"], lesson: string): ReflectionLite => ({
    kind,
    summary: lesson,
    lesson,
    createdAt: "2026-06-30",
  });
  it("dedupes identical lessons", () => {
    const out = rankLessons([
      r("failure", "wire the real tool"),
      r("failure", "wire the real tool"),
      r("success", "reuse this set"),
    ]);
    expect(out).toHaveLength(2);
  });
  it("ranks failures above caveats above successes (most actionable first)", () => {
    const out = rankLessons([
      r("success", "s"),
      r("caveat", "c"),
      r("failure", "f"),
    ]);
    expect(out.map((x) => x.kind)).toEqual(["failure", "caveat", "success"]);
  });
  it("preserves input (newest-first) order within the same kind", () => {
    const out = rankLessons([r("failure", "newer"), r("failure", "older")]);
    expect(out.map((x) => x.lesson)).toEqual(["newer", "older"]);
  });
  it("caps to the limit", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      r("failure", `lesson ${i}`),
    );
    expect(rankLessons(many, 5)).toHaveLength(5);
  });
});
