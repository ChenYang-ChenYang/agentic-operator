// Phase 4 — real test-input fabrication. The factory's test cases used typed placeholder strings
// (`<field>_demo`), so a file-consuming agent (resume parser, whose first step needs an actual
// PDF) could never be exercised meaningfully. This generates realistic, name/type-aware values
// and a VALID synthetic PDF (byte-offset-correct xref) for file-typed fields. Deterministic (no
// RNG) so the cases are reproducible; pure (returns base64 — no fs needed).

export interface ResumePersona {
  name?: string;
  title?: string;
  skills?: string[];
  email?: string;
  years?: number;
}

const DEFAULT_PERSONA: Required<ResumePersona> = {
  name: "Alex Chen",
  title: "Senior Engineer",
  skills: ["TypeScript", "Go", "PostgreSQL"],
  email: "candidate@example.com",
  years: 5,
};

/** Keep the synthetic PDF ASCII so byte offsets == string indices (the xref table is exact). */
function toAscii(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[^\x20-\x7e]/g, "?");
}

function escPdf(t: string): string {
  return toAscii(t)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** Build a minimal, structurally-valid single-page PDF with the persona text drawn on it. The
 *  xref byte offsets are computed from the actual assembled bytes, so a strict parser accepts it. */
export function syntheticResumePdf(persona: ResumePersona = {}): {
  base64: string;
  bytes: Uint8Array;
  text: string;
} {
  const p = { ...DEFAULT_PERSONA, ...persona };
  return syntheticPdf([
    p.name,
    p.title,
    p.skills?.length ? `Skills: ${p.skills.join(", ")}` : "Skills: —",
    `Experience: ${p.years} years`,
    `Email: ${p.email}`,
    "Synthetic resume — test fixture, not a real person.",
  ]);
}

/**
 * A structurally-valid PDF carrying exactly the lines given. Domain-neutral: a
 * file-typed field that is not declared to be a résumé gets a document that says
 * what it is instead of impersonating someone else's business object.
 */
export function syntheticPdf(textLines: readonly string[]): {
  base64: string;
  bytes: Uint8Array;
  text: string;
} {
  let content = "BT /F1 14 Tf 72 760 Td 16 TL\n";
  for (const tl of textLines) content += `(${escPdf(String(tl))}) Tj T*\n`;
  content += "ET";

  const objs: Record<number, string> = {
    1: "<</Type/Catalog/Pages 2 0 R>>",
    2: "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    3: "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
    4: "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    5: `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
  };

  let body = "%PDF-1.4\n";
  const offsets: Record<number, number> = {};
  for (let i = 1; i <= 5; i++) {
    offsets[i] = body.length; // ASCII ⇒ char index == byte offset
    body += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = body.length;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++)
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  const text = body + xref + trailer;
  const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
  const base64 = Buffer.from(bytes).toString("base64");
  return { base64, bytes, text };
}

function normalizedFieldName(field: string): string {
  return (field || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const EXPLICIT_FILE_TYPE =
  /(?:^|[^a-z0-9])(?:file|binary|pdf|blob|buffer|bytes?)(?:[^a-z0-9]|$)/;
const STRING_LIKE_TYPE =
  /^(?:string|str|text|varchar|nvarchar|char)\??(?:\s*\|\s*(?:null|undefined))*$/;
const FILE_PAYLOAD_NAME =
  /(?:^|_)(?:file|files|pdf|attachment|attachments|upload|uploads|blob|binary|buffer|bytes?|base64)(?:_|$)/;
const FILE_REFERENCE_METADATA =
  /(?:^|_)(?:id|ids|key|keys|path|paths|url|urls|uri|uris|name|names|filename|filenames|type|types|mime|etag|hash|checksum|size|score|threshold|status|text|json|parsed|template|profile|format|extension|bucket|reference|ref)(?:_|$)/;

/**
 * A field is file-like only when the declared type is explicitly binary/file,
 * or an absent/string-like type is paired with an unambiguous payload name.
 *
 * Names such as `object_key`, `document_type`, `resume_id` and
 * `resume_match_score_threshold` describe metadata or references, not bytes.
 * A semantic word like "resume" must never override an authoritative numeric,
 * object or array type: doing so used to put base64 PDFs into Float fields.
 */
export function isFileField(field: string, type: string): boolean {
  const t = (type || "").trim().toLowerCase();
  if (EXPLICIT_FILE_TYPE.test(t)) return true;
  // A non-empty authoritative type that is not string-like is a hard veto. In
  // particular Float/Object/List fields cannot be reinterpreted from the name.
  if (t && !STRING_LIKE_TYPE.test(t)) return false;

  const f = normalizedFieldName(field);
  if (!f || FILE_REFERENCE_METADATA.test(f)) return false;
  return FILE_PAYLOAD_NAME.test(f);
}

/** Produce a realistic value for a (field, type), name- and type-aware. File-typed fields get a
 *  base64 synthetic PDF; emails/phones/dates/names get plausible values; primitives keep their
 *  type; everything else falls back to the legacy `<field>_demo` (back-compat). */
export function synthesizeField(
  field: string,
  type: string,
  opts?: { persona?: ResumePersona; now?: number },
): unknown {
  const f = (field || "").toLowerCase();
  const t = (type || "").toLowerCase();

  // A file-typed field needs a parseable document. WHICH document is a business
  // question, and only the field name declares it: a field named resume/cv gets
  // a résumé, everything else gets a document that says it is a test fixture.
  // Handing every claim, manifest and contract a synthetic résumé made foreign
  // business content look like real sandbox evidence.
  if (isFileField(field, type)) {
    // File-likeness first: a résumé is a KIND of document, so the résumé
    // predicate only has meaning once we already know a document is wanted.
    // Checking the name first meant a numeric `cv_score` (cross-validation, or a
    // match score) was answered with a base64 PDF.
    return isResumeField(field)
      ? syntheticResumePdf(opts?.persona).base64
      : syntheticPdf([
          `Synthetic test document for field "${field}".`,
          "Generated by the Agent Factory sandbox fixture builder.",
          "It carries no business content of any domain.",
        ]).base64;
  }

  if (
    t.startsWith("num") ||
    t === "int" ||
    t === "integer" ||
    t === "float" ||
    t === "double"
  )
    return 1;
  if (t.startsWith("bool")) return true;
  if (t.startsWith("arr") || t.endsWith("[]")) return [];
  if (t.startsWith("obj") || t.startsWith("map") || t.startsWith("json"))
    return {};

  // FORMAT-driven values only. An email must parse as an email and a phone as a
  // phone, so a plausible shape is the point — but the shape is all it may say.
  if (/email/.test(f)) return "fixture@example.com";
  if (/phone|mobile|tel\b/.test(f)) return "13800138000";
  if (/(_at$|_on$|date|deadline|time)/.test(f))
    return fixtureDate(f, opts?.now);

  // Everything below used to be CONTENT — a person, a city, a job title, a
  // salary band. Those belong to whoever's domain the generator happened to be
  // written for. An obviously synthetic placeholder fails loudly; a plausible
  // foreign value passes quietly and gets signed into the receipt.
  return `${field}_demo`;
}

/**
 * Only a field that names itself a résumé gets résumé content.
 *
 * Every alternative carries a LEADING word-boundary anchor. That keeps
 * warehouse-receiving vocabulary out (`recv_qty` cannot match `\bcv_` — the
 * `cv_` run is preceded by a word character) and keeps `presume_flag` out of
 * `\bresume_` for the same reason. Be precise about what the anchors do NOT
 * do: string start IS a word boundary, so `\bcv_` DOES match `cv_score` and
 * `cv_folds` — this predicate reads them as résumé-ish. What actually keeps a
 * numeric `cv_score` numeric is the isFileField-FIRST ordering in
 * `synthesizeField`: the résumé predicate only runs once a field is already
 * known to want a document, and a number-typed field never is. (Both facts are
 * pinned in fixtures.test.ts.)
 */
export function isResumeField(field: string): boolean {
  return /\bresume\b|\brésumé\b|\bresume_|_resume\b|\bcv\b|\bcv_|_cv\b/.test(
    (field || "").toLowerCase(),
  );
}

/**
 * A calendar day whose SIDE of "now" matches what the field name means, so a
 * deadline guard takes the live branch and a creation timestamp takes the past
 * one. `now` is injectable so a replay reproduces the run exactly — the previous
 * fixed literal (2026-06-30) silently flipped every expiry check the day it
 * passed, with no code change and nothing in the receipt to say so.
 */
export function fixtureDate(field: string, now = Date.now()): string {
  const f = (field || "").toLowerCase();
  const day = 86_400_000;
  const future = /deadline|expir|due|valid_until|ends?_|closes?_/.test(f);
  const past = /created|_at$|_on$|started|issued|received|submitted/.test(f);
  const at = future ? now + 30 * day : past ? now - day : now;
  return new Date(at).toISOString().slice(0, 10);
}
