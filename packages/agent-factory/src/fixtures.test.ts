import { describe, it, expect } from "vitest";
import {
  isFileField,
  isResumeField,
  synthesizeField,
  syntheticResumePdf,
} from "./fixtures";

// Phase 4 — real test-input fabrication. The factory's test cases used typed placeholder strings
// (`<field>_demo`), so a file-consuming agent (resume parser) could never be exercised. The
// fixtures generator produces realistic, type/name-aware values + a VALID synthetic PDF for
// file-typed fields. Deterministic (no RNG) so test cases are reproducible.

describe("synthesizeField — realistic, name/type-aware values", () => {
  it("emails look like emails", () => {
    expect(String(synthesizeField("contact_email", "string"))).toMatch(
      /^[^@]+@[^@]+\.[a-z]+$/,
    );
  });
  it("phones are digit strings", () => {
    expect(String(synthesizeField("mobile", "string"))).toMatch(/^\d{11}$/);
    expect(String(synthesizeField("phone_number", "string"))).toMatch(
      /^\d{11}$/,
    );
  });
  it("dates are ISO calendar days", () => {
    expect(String(synthesizeField("deadline", "string"))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    expect(String(synthesizeField("created_at", "string"))).toMatch(
      /^\d{4}-\d{2}-\d{2}/,
    );
  });
  it("typed primitives keep their type", () => {
    expect(synthesizeField("headcount", "number")).toBe(1);
    expect(synthesizeField("is_urgent", "boolean")).toBe(true);
    expect(synthesizeField("tags", "array")).toEqual([]);
    expect(synthesizeField("meta", "object")).toEqual({});
  });
  it("file/binary fields get a base64 PDF, not a placeholder string", () => {
    const v = synthesizeField("resume_file", "file");
    expect(typeof v).toBe("string");
    // base64 of a PDF decodes to bytes starting with %PDF
    expect(
      Buffer.from(String(v), "base64").toString("latin1").startsWith("%PDF-"),
    ).toBe(true);
  });
  it("falls back to a typed demo string for an unknown plain field", () => {
    expect(synthesizeField("widget_label", "string")).toBe("widget_label_demo");
  });
});

/**
 * #NO-DOMAIN-LEAK — `synthesizeField` is the production seed generator: it fills
 * every canonical `event_data` field before `sandbox_run` fires, and the sandbox
 * receipt is the delivery evidence.
 *
 * `test-cases.ts` states the invariant plainly — "No per-domain hardcoded
 * recruitment/energy/费控 values, so a brand-new domain (logistics, insurance, …)
 * never gets foreign seed data leaking in" — and this generator broke it: an
 * insurance claim PDF, a shipping manifest and a signed contract all received a
 * synthetic RÉSUMÉ, a freight `location` became "Shanghai" and a logistics
 * `title` became "Senior Engineer". An agent fed foreign data either passes on
 * garbage or fails for a reason that has nothing to do with the agent — and the
 * receipt is signed either way.
 *
 * Format-driven values stay (an email must parse as an email). Content-driven
 * ones must not: an obviously synthetic placeholder that fails loudly beats a
 * plausible value that passes quietly.
 */
describe("#NO-DOMAIN-LEAK synthesizeField carries no domain's business content", () => {
  it("does not hand a résumé to a field that is not a résumé", () => {
    const claim = String(synthesizeField("claim_document", "file"));
    const decoded = Buffer.from(claim, "base64").toString("latin1");
    expect(decoded.startsWith("%PDF-")).toBe(true);
    expect(decoded).not.toMatch(/resume|Skills|Experience/i);
  });

  it.each([
    ["recv_document", "file"],
    ["recv_warehouse_file", "file"],
    ["cv_score", "number"],
    ["cv_folds", "number"],
  ])("does not hand %s a résumé", (field, type) => {
    const value = synthesizeField(field, type);
    if (typeof value !== "string") return; // typed primitive, nothing to decode
    const decoded = Buffer.from(value, "base64").toString("latin1");
    expect(decoded).not.toMatch(/Skills:|Experience:/);
  });

  it.each(["recv_qty", "recv_date", "recv_warehouse_id"])(
    "does not read %s as a résumé field",
    (field) => {
      /**
       * The `\bcv_` anchor keeps warehouse-receiving vocabulary (`recv_*`) out:
       * inside `recv_qty` the `cv_` run is preceded by a word character, so the
       * boundary fails. NOTE the anchor does NOT protect `cv_score` — string
       * start IS a word boundary, so isResumeField("cv_score") is true; what
       * keeps cv_score numeric is the isFileField-first ordering in
       * synthesizeField (a number-typed field never reaches the résumé branch).
       * That ordering is pinned separately below.
       */
      expect(isResumeField(field)).toBe(false);
    },
  );

  it("anchors `resume_` at a word boundary so presume_flag is not a résumé field", () => {
    // Reproduced: the unanchored `resume_` alternative matched inside
    // `presume_flag` (p-RESUME_...). The docstring claimed every alternative
    // was boundary-anchored; this pins the tightened regex honestly.
    expect(isResumeField("presume_flag")).toBe(false);
    expect(isResumeField("resume_file")).toBe(true);
  });

  it("pins the TRUE mechanism protecting cv_score: file-likeness first, then résumé-ness", () => {
    // `\bcv_` DOES match cv_score (string start is a boundary) — the regex is
    // NOT what protects it. synthesizeField checks isFileField first, and a
    // number-typed field is not file-like, so it stays numeric.
    expect(isResumeField("cv_score")).toBe(true);
    expect(synthesizeField("cv_score", "number")).toBe(1);
  });

  it.each(["resume", "resume_file", "cv", "cv_attachment", "candidate_cv"])(
    "still reads %s as a résumé field",
    (field) => {
      expect(isResumeField(field)).toBe(true);
    },
  );

  it("still gives a résumé field a résumé — the name is the declaration", () => {
    const decoded = Buffer.from(
      String(synthesizeField("resume_file", "file")),
      "base64",
    ).toString("latin1");
    expect(decoded).toMatch(/resume/i);
  });

  it("does not invent a person, a city, a job title or a salary band", () => {
    for (const field of [
      "owner_name",
      "city",
      "location",
      "title",
      "position",
      "salary",
      "compensation",
    ]) {
      expect(String(synthesizeField(field, "string"))).toBe(`${field}_demo`);
    }
  });

  it("keeps format-driven values valid, but domain-neutral", () => {
    const email = String(synthesizeField("contact_email", "string"));
    expect(email).toMatch(/^[^@]+@[^@]+\.[a-z]+$/);
    expect(email).not.toMatch(/candidate/i);
  });

  it("never emits a fixed calendar date — a frozen literal silently ages", () => {
    // The old value was 2026-06-30. Once that date passed, every generated agent
    // with an expiry or SLA guard started taking the EXPIRED branch in the
    // sandbox, with no code change and nothing in the receipt saying so.
    const deadline = String(synthesizeField("deadline", "string"));
    expect(deadline).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(deadline).not.toBe("2026-06-30");
    expect(new Date(`${deadline}T00:00:00Z`).getTime()).toBeGreaterThan(
      Date.now(),
    );
    const created = String(synthesizeField("created_at", "string"));
    expect(new Date(`${created}T00:00:00Z`).getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
  });

  it("is deterministic for a given clock so a replay reproduces the run", () => {
    const at = Date.UTC(2030, 0, 15);
    expect(synthesizeField("deadline", "string", { now: at })).toBe(
      synthesizeField("deadline", "string", { now: at }),
    );
  });
});

describe("isFileField", () => {
  it("accepts explicit file types and unambiguous string payload names", () => {
    expect(isFileField("x", "file")).toBe(true);
    expect(isFileField("payload", "Binary")).toBe(true);
    expect(isFileField("body", "PDF")).toBe(true);
    expect(isFileField("resume_pdf", "string")).toBe(true);
    expect(isFileField("resumeFile", "String")).toBe(true);
    expect(isFileField("cv_attachment", "")).toBe(true);
    expect(isFileField("title", "string")).toBe(false);
  });

  it.each([
    ["resume_match_score_threshold", "Float"],
    ["resume_id", "String"],
    ["object_key", "String"],
    ["document_type", "String"],
    ["resume_file_path", "String"],
    ["resume_url", "String"],
    ["parsed_resume", "Object"],
    ["resume_files", "Array<String>"],
  ])(
    "does not reinterpret scalar/reference metadata %s:%s as PDF bytes",
    (field, type) => {
      expect(isFileField(field, type)).toBe(false);
      const value = synthesizeField(field, type);
      if (typeof value === "string") {
        expect(Buffer.from(value, "base64").toString("latin1")).not.toMatch(
          /^%PDF-/,
        );
      }
    },
  );
});

describe("syntheticResumePdf — a real, parseable minimal PDF", () => {
  const pdf = syntheticResumePdf({
    name: "Alex Chen",
    title: "Senior Engineer",
    skills: ["TypeScript", "Go"],
  });
  it("is a structurally valid PDF (header + EOF + xref + trailer)", () => {
    const s = pdf.text;
    expect(s.startsWith("%PDF-1.")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(s).toContain("xref");
    expect(s).toContain("trailer");
    expect(s).toContain("startxref");
  });
  it("embeds the persona text so a parser extracts real content", () => {
    expect(pdf.text).toContain("Alex Chen");
    expect(pdf.text).toContain("Senior Engineer");
  });
  it("round-trips through base64", () => {
    expect(Buffer.from(pdf.base64, "base64").toString("latin1")).toBe(pdf.text);
  });
  it("xref offsets point at real object positions", () => {
    // each "N 0 obj" must begin exactly at the byte offset recorded in the xref table
    const s = pdf.text;
    const startxref = Number(
      s
        .slice(s.lastIndexOf("startxref") + "startxref".length)
        .trim()
        .split(/\s/)[0],
    );
    expect(s.slice(startxref, startxref + 4)).toBe("xref");
  });
});
