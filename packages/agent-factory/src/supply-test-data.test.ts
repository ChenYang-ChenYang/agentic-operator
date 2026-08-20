import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS, applyTestDataOverrides } from "./tools";
import type { BrainCtx } from "./brain-types";
import type { GeneratedAgentSpec } from "./spec-types";
import type { TestCase } from "./brain-types";

// supply_test_data: real contact/credential/id fields (e.g. an interview email) must be collectable
// from the user and threaded into the fired test payloads instead of demo placeholders.

const supply = FACTORY_TOOLS.find((t) => t.name === "supply_test_data")!;

function spec(
  actionName: string,
  inputSchema: Array<{ field: string; type: string }>,
): GeneratedAgentSpec {
  return {
    key: actionName,
    actionName,
    slug: `d-${actionName}`,
    short: actionName,
    domainId: "rec",
    nameZh: actionName,
    kind: "llm",
    trigger: [],
    emit: [],
    tools: ["x"],
    unresolvedTools: [],
    objects: [],
    systemPrompt: "p",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
    inputSchema,
  } as unknown as GeneratedAgentSpec;
}

function ctx(
  specs: GeneratedAgentSpec[],
  testCases: TestCase[],
  emitted: unknown[] = [],
): BrainCtx {
  return {
    specs,
    testCases,
    emit: (event: unknown) => emitted.push(event),
  } as unknown as BrainCtx;
}

const tc = (payload: Record<string, unknown>, id = "tc1"): TestCase => ({
  id,
  name: "case",
  scenario: "s",
  kind: "pass",
  entryEvent: "E",
  payload,
  expectedOutcome: "ok",
});

function attachAssetReader(
  c: BrainCtx,
  input: {
    content?: Uint8Array;
    sha256?: string;
    bytes?: number;
    mimeType?: string;
    filename?: string;
    missing?: boolean;
    caseId?: string;
    path?: string;
  } = {},
): void {
  const content = input.content ?? Buffer.from("hello");
  const digest = createHash("sha256").update(content).digest("hex");
  c.domain = "rec";
  c.conversationId = "fixture-run";
  c.ports = {
    fixtureAssets: {
      readExact: async ({
        assetId,
        domainId,
        conversationId,
      }: {
        assetId: string;
        domainId: string;
        conversationId: string;
      }) => {
        if (
          input.missing ||
          assetId !== "asset-1" ||
          domainId !== "rec" ||
          conversationId !== "fixture-run"
        )
          return null;
        return {
          assetId,
          caseId: input.caseId ?? "tc1",
          path: input.path ?? "/resume_file",
          content,
          sha256: input.sha256 ?? digest,
          bytes: input.bytes ?? content.byteLength,
          mimeType: input.mimeType,
          filename: input.filename,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    },
  } as unknown as BrainCtx["ports"];
}

describe("applyTestDataOverrides", () => {
  it("overrides only keys already present in the payload (never injects foreign fields)", () => {
    const out = applyTestDataOverrides(
      { candidate_email: "talent@example.com", other: 1 },
      { candidate_email: "real@me.com", ghost: "x" },
    );
    expect(out.candidate_email).toBe("real@me.com");
    expect(out.other).toBe(1);
    expect("ghost" in out).toBe(false);
  });
  it("is a no-op when there are no overrides", () => {
    const p = { a: 1 };
    expect(applyTestDataOverrides(p, undefined)).toBe(p);
  });
});

describe("supply_test_data — scan/ask mode", () => {
  it("detects a real contact field on a placeholder and PARKS for the user's value", async () => {
    const c = ctx(
      [spec("invite", [{ field: "candidate_email", type: "string" }])],
      [tc({ candidate_email: "talent@example.com" })],
    );
    const r = await supply.execute({}, c);
    expect(r.ok).toBe(true);
    expect((r.output as { needs: unknown[] }).needs.length).toBe(1);
    expect(c.awaitingClarify).toBe(true); // parked waiting for the user
    expect(c.clarifyPrompt?.question).toContain("candidate_email");
  });

  it("returns cleanly (no park) when there are no real-data fields", async () => {
    const c = ctx(
      [spec("createJD", [{ field: "title", type: "string" }])],
      [tc({ title: "Senior Engineer" })],
    );
    const r = await supply.execute({}, c);
    expect(r.ok).toBe(true);
    expect((r.output as { needs: unknown[] }).needs.length).toBe(0);
    expect(c.awaitingClarify).toBeFalsy();
  });
});

describe("supply_test_data — apply mode", () => {
  it("atomically materializes a sandbox-safe value, redacts output, and requires re-approval", async () => {
    const emitted: unknown[] = [];
    const c = ctx(
      [spec("invite", [{ field: "candidate_email", type: "string" }])],
      [tc({ candidate_email: "talent@example.com", role: "eng" })],
      emitted,
    );
    c.awaitingApproval = false;
    c.lastSandbox = { specsFingerprint: "stale" } as unknown as NonNullable<
      BrainCtx["lastSandbox"]
    >;
    c.sandboxDesignReview = { fingerprint: "old" } as unknown as NonNullable<
      BrainCtx["sandboxDesignReview"]
    >;
    c.testCoverageWaiver = { cells: ["old"], confirmedAt: 1 };
    const r = await supply.execute(
      { values: { candidate_email: "stevenchengxy19@gmail.com" } },
      c,
    );
    expect(r.ok).toBe(true);
    expect(c.testCases![0]!.payload.candidate_email).toBe(
      "stevenchengxy19@gmail.com",
    );
    expect(c.testCases![0]!.payload.role).toBe("eng"); // untouched
    expect(c.testDataOverrides).toBeUndefined();
    expect(c.awaitingClarify).toBe(false);
    expect(c.awaitingApproval).toBe(true);
    expect(c.lastSandbox).toBeNull();
    expect(c.sandboxDesignReview).toBeUndefined();
    expect(c.testCoverageWaiver).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("stevenchengxy19@gmail.com");
    expect(JSON.stringify(emitted)).not.toContain("stevenchengxy19@gmail.com");
    expect(JSON.stringify(emitted)).toContain("sha256");
  });

  it("requires test cases to exist first", async () => {
    const c = { specs: [], emit: () => {} } as unknown as BrainCtx;
    const r = await supply.execute({ values: { x: 1 } }, c);
    expect(r.ok).toBe(false);
  });
});

describe("supply_test_data — complete nested fixtures", () => {
  it("replaces one exact case payload with a complete nested JSON object", async () => {
    const c = ctx(
      [],
      [
        tc(
          { resume: { experience: [{ company: "old" }] }, keep: true },
          "nested",
        ),
        tc({ untouched: true }, "other"),
      ],
    );
    const r = await supply.execute(
      {
        case_payloads: [
          {
            case_id: "nested",
            payload: {
              resume: { experience: [{ company: "新公司", years: 3 }] },
              added: [1, 2],
            },
          },
        ],
      },
      c,
    );
    expect(r.ok).toBe(true);
    expect(c.testCases![0]!.payload).toEqual({
      resume: { experience: [{ company: "新公司", years: 3 }] },
      added: [1, 2],
    });
    expect(c.testCases![1]!.payload).toEqual({ untouched: true });
    expect(c.awaitingApproval).toBe(true);
    expect(JSON.stringify(r)).not.toContain("新公司");
  });

  it("patches an existing array path and decodes JSON Pointer escapes", async () => {
    const c = ctx(
      [],
      [
        tc({
          resume: { experience: [{ company: "old" }] },
          "a/b": { "~key": "before" },
        }),
      ],
    );
    const r = await supply.execute(
      {
        path_values: [
          {
            case_id: "tc1",
            path: "/resume/experience/0/company",
            value: "new",
          },
          { case_id: "tc1", path: "/a~1b/~0key", value: "after" },
        ],
      },
      c,
    );
    expect(r.ok).toBe(true);
    expect(
      (
        c.testCases![0]!.payload.resume as {
          experience: Array<{ company: string }>;
        }
      ).experience[0]!.company,
    ).toBe("new");
    expect(
      (c.testCases![0]!.payload["a/b"] as Record<string, unknown>)["~key"],
    ).toBe("after");
  });

  it("fails atomically on a missing path after an earlier valid patch", async () => {
    const c = ctx([], [tc({ nested: { value: "before" } })]);
    const staleSandbox = { specsFingerprint: "keep" } as unknown as NonNullable<
      BrainCtx["lastSandbox"]
    >;
    const staleReview = { fingerprint: "keep" } as unknown as NonNullable<
      BrainCtx["sandboxDesignReview"]
    >;
    c.lastSandbox = staleSandbox;
    c.sandboxDesignReview = staleReview;
    c.awaitingApproval = false;
    const before = JSON.stringify(c.testCases);
    const r = await supply.execute(
      {
        path_values: [
          { case_id: "tc1", path: "/nested/value", value: "would-change" },
          { case_id: "tc1", path: "/nested/missing", value: "bad" },
        ],
      },
      c,
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(c.testCases)).toBe(before);
    expect(c.lastSandbox).toBe(staleSandbox);
    expect(c.sandboxDesignReview).toBe(staleReview);
    expect(c.awaitingApproval).toBe(false);
  });

  it("rejects unknown cases, duplicate/overlapping paths, and unsafe payload keys", async () => {
    const unknown = ctx([], [tc({ nested: { value: 1 } })]);
    expect(
      (
        await supply.execute(
          { case_payloads: [{ case_id: "TC1", payload: { ok: true } }] },
          unknown,
        )
      ).ok,
    ).toBe(false);

    const overlap = ctx([], [tc({ nested: { value: 1 } })]);
    expect(
      (
        await supply.execute(
          {
            path_values: [
              { case_id: "tc1", path: "/nested", value: { value: 2 } },
              { case_id: "tc1", path: "/nested/value", value: 3 },
            ],
          },
          overlap,
        )
      ).ok,
    ).toBe(false);

    const unsafe = ctx([], [tc({ ok: true })]);
    const payload = JSON.parse('{"__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;
    expect(
      (
        await supply.execute(
          { case_payloads: [{ case_id: "tc1", payload }] },
          unsafe,
        )
      ).ok,
    ).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("materializes legacy overrides before advanced edits and removes the second override layer", async () => {
    const c = ctx([], [tc({ email: "old", nested: { value: 1 } })]);
    c.testDataOverrides = { email: "legacy@test.invalid" };
    const r = await supply.execute(
      { path_values: [{ case_id: "tc1", path: "/nested/value", value: 2 }] },
      c,
    );
    expect(r.ok).toBe(true);
    expect(c.testCases![0]!.payload.email).toBe("legacy@test.invalid");
    expect(c.testDataOverrides).toBeUndefined();
  });
});

describe("supply_test_data — binary fixtures", () => {
  const sha256 = createHash("sha256").update("hello").digest("hex");

  it("validates the scoped asset and persists only a content-addressed binding", async () => {
    const emitted: unknown[] = [];
    const c = ctx([], [tc({ resume_file: null })], emitted);
    attachAssetReader(c, {
      mimeType: "application/pdf",
      filename: "resume.pdf",
    });
    const r = await supply.execute(
      {
        binary_files: [
          {
            case_id: "tc1",
            path: "/resume_file",
            asset_id: "asset-1",
            sha256,
            as: "object",
            mime_type: "application/pdf",
            filename: "resume.pdf",
          },
        ],
      },
      c,
    );
    expect(r.ok).toBe(true);
    expect(c.testCases![0]!.payload.resume_file).toEqual(
      expect.objectContaining({
        schema: "agent-factory-test-fixture-asset/v1",
        assetId: "asset-1",
        conversationId: "fixture-run",
        as: "object",
        sha256,
        bytes: 5,
        mimeType: "application/pdf",
        filename: "resume.pdf",
      }),
    );
    expect(JSON.stringify(r)).not.toContain("asset-1");
    expect(JSON.stringify(emitted)).not.toContain("asset-1");
    expect(JSON.stringify(r)).toContain(sha256);
  });

  it("supports explicit base64 string and data URL shapes", async () => {
    for (const fixture of [
      { path: "/raw", as: "base64_string", mimeType: undefined },
      { path: "/url", as: "data_url", mimeType: "text/plain" },
    ] as const) {
      const c = ctx([], [tc({ raw: null, url: null })]);
      attachAssetReader(c, { path: fixture.path, mimeType: fixture.mimeType });
      const r = await supply.execute(
        {
          binary_files: [
            {
              case_id: "tc1",
              path: fixture.path,
              asset_id: "asset-1",
              as: fixture.as,
              ...(fixture.mimeType ? { mime_type: fixture.mimeType } : {}),
            },
          ],
        },
        c,
      );
      expect(r.ok).toBe(true);
      expect(c.testCases![0]!.payload[fixture.path.slice(1)]).toEqual(
        expect.objectContaining({ as: fixture.as, assetId: "asset-1" }),
      );
    }
  });

  it("rejects hash/size drift, missing MIME, expired assets, and metadata mismatch atomically", async () => {
    for (const fixture of [
      {
        reader: { sha256: "0".repeat(64) },
        binary: {
          case_id: "tc1",
          path: "/file",
          asset_id: "asset-1",
          as: "object",
        },
      },
      {
        reader: { bytes: 99 },
        binary: {
          case_id: "tc1",
          path: "/file",
          asset_id: "asset-1",
          as: "object",
        },
      },
      {
        reader: {},
        binary: {
          case_id: "tc1",
          path: "/file",
          asset_id: "asset-1",
          as: "data_url",
        },
      },
      {
        reader: { filename: "stored.pdf" },
        binary: {
          case_id: "tc1",
          path: "/file",
          asset_id: "asset-1",
          as: "object",
          filename: "different.pdf",
        },
      },
      {
        reader: { missing: true },
        binary: {
          case_id: "tc1",
          path: "/file",
          asset_id: "asset-1",
          as: "object",
        },
      },
    ] as const) {
      const c = ctx([], [tc({ file: null })]);
      attachAssetReader(c, { ...fixture.reader, path: "/file" });
      const before = JSON.stringify(c.testCases);
      const r = await supply.execute({ binary_files: [fixture.binary] }, c);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(c.testCases)).toBe(before);
    }
  });

  it("asks the user to upload instead of accepting inline content when the reader is unavailable", async () => {
    const c = ctx([], [tc({ file: null })]);
    const r = await supply.execute(
      {
        binary_files: [
          { case_id: "tc1", path: "/file", asset_id: "asset-1", as: "object" },
        ],
      },
      c,
    );
    expect(r.ok).toBe(false);
    expect(r.output).toMatchObject({
      next: "ask_user",
      reason: "fixture_asset_reader_unavailable",
    });
    expect(r.summary).toContain("不要把文件内容粘贴到聊天里");
  });

  it.each([
    ["resume_match_score_threshold", "Float", 0.8],
    ["object_key", "String", "incoming/resume.pdf"],
    ["document_type", "String", "application/pdf"],
    ["resume_file_path", "String", "/tenant/incoming/resume.pdf"],
  ])(
    "rejects synthetic PDF binding to scalar/reference field %s:%s before creating an asset",
    async (field, type, value) => {
      const c = ctx([], [tc({ [field]: value })]);
      c.domain = "rec";
      c.conversationId = "fixture-run";
      c.ontology = {
        actions: [],
        objects: [],
        rules: [],
        workflow: [],
        source: "allmeta",
        domainId: "rec",
        events: [
          {
            name: "E",
            payload: {
              source_action: null,
              event_data: [{ name: field, type, target_object: null }],
              state_mutations: [],
            },
          },
        ],
      } as NonNullable<BrainCtx["ontology"]>;
      let created = 0;
      c.ports = {
        fixtureAssets: {
          createSyntheticResume: async () => {
            created += 1;
            return null;
          },
          readExact: async () => null,
        },
      } as unknown as BrainCtx["ports"];
      const before = JSON.stringify(c.testCases);
      const result = await supply.execute(
        {
          synthetic_resumes: [
            {
              case_id: "tc1",
              path: `/${field}`,
              as: "object",
            },
          ],
        },
        c,
      );
      expect(result.ok).toBe(false);
      expect(result.summary).toContain("不是已声明的简历文件字段");
      expect(created).toBe(0);
      expect(JSON.stringify(c.testCases)).toBe(before);
    },
  );

  it("allows a nested, existing resume-file destination without a flattened leaf schema", async () => {
    const c = ctx(
      [],
      [tc({ candidate: { documents: { resume_file: null } } })],
    );
    const content = Buffer.from("%PDF-1.4\nnested synthetic\n%%EOF");
    const sha256 = createHash("sha256").update(content).digest("hex");
    c.domain = "rec";
    c.conversationId = "fixture-run";
    const asset = {
      assetId: "nested-synthetic-asset",
      caseId: "tc1",
      path: "/candidate/documents/resume_file",
      content,
      sha256,
      bytes: content.byteLength,
      mimeType: "application/pdf",
      filename: "synthetic-resume-tc1.pdf",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      provenance: "synthetic_resume_pdf" as const,
    };
    c.ports = {
      fixtureAssets: {
        createSyntheticResume: async () => asset,
        readExact: async () => asset,
      },
    } as unknown as BrainCtx["ports"];
    const result = await supply.execute(
      {
        synthetic_resumes: [
          {
            case_id: "tc1",
            path: "/candidate/documents/resume_file",
            as: "object",
          },
        ],
      },
      c,
    );
    expect(result.ok).toBe(true);
    expect(
      (
        c.testCases![0]!.payload.candidate as {
          documents: { resume_file: unknown };
        }
      ).documents.resume_file,
    ).toEqual(
      expect.objectContaining({
        schema: "agent-factory-test-fixture-asset/v1",
        provenance: "synthetic_resume_pdf",
        sha256,
      }),
    );
  });

  it("creates a tenant/conversation-scoped synthetic resume PDF without copying a tenant file", async () => {
    const c = ctx([], [tc({ resume_file: null })]);
    const content = Buffer.from("%PDF-1.4\nsynthetic\n%%EOF");
    const sha256 = createHash("sha256").update(content).digest("hex");
    c.domain = "rec";
    c.conversationId = "fixture-run";
    const asset = {
      assetId: "synthetic-asset-1",
      caseId: "tc1",
      path: "/resume_file",
      content,
      sha256,
      bytes: content.byteLength,
      mimeType: "application/pdf",
      filename: "synthetic-resume-tc1.pdf",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      provenance: "synthetic_resume_pdf" as const,
    };
    c.ports = {
      fixtureAssets: {
        createSyntheticResume: async (input: {
          domainId: string;
          conversationId: string;
          caseId: string;
          path: string;
        }) =>
          input.domainId === "rec" &&
          input.conversationId === "fixture-run" &&
          input.caseId === "tc1" &&
          input.path === "/resume_file"
            ? asset
            : null,
        readExact: async (input: {
          domainId: string;
          conversationId: string;
          assetId: string;
        }) =>
          input.domainId === "rec" &&
          input.conversationId === "fixture-run" &&
          input.assetId === asset.assetId
            ? asset
            : null,
      },
    } as unknown as BrainCtx["ports"];
    const result = await supply.execute(
      {
        synthetic_resumes: [
          {
            case_id: "tc1",
            path: "/resume_file",
            as: "object",
            persona: { name: "Synthetic Candidate", skills: ["TypeScript"] },
          },
        ],
      },
      c,
    );
    expect(result.ok).toBe(true);
    expect(c.testCases![0]!.payload.resume_file).toEqual(
      expect.objectContaining({
        schema: "agent-factory-test-fixture-asset/v1",
        provenance: "synthetic_resume_pdf",
        mimeType: "application/pdf",
        sha256,
      }),
    );
    expect(JSON.stringify(result)).not.toContain("%PDF");
    expect(JSON.stringify(c.testCases)).not.toContain("%PDF");
  });
});

describe("supply_test_data — credentials stay out of chat fixtures", () => {
  it.each(["compliance_credential", "Application.compliance_credential"])(
    "accepts the exact Ontology business field %s as ordinary test data",
    async (field) => {
      const c = ctx(
        [spec("verifyApplication", [{ field, type: "string" }])],
        [tc({ [field]: "ISO-27001" })],
      );
      const r = await supply.execute(
        { values: { [field]: "SOC-2-TYPE-II" } },
        c,
      );

      expect(r.ok).toBe(true);
      expect(c.testCases![0]!.payload[field]).toBe("SOC-2-TYPE-II");
      expect(r.output).not.toMatchObject({
        reason: "test_fixture_secret_requires_server_profile",
      });
    },
  );

  it("accepts credential_type as non-secret authentication-method metadata", async () => {
    const c = ctx(
      [
        spec("readSystemMetadata", [
          { field: "credential_type", type: "string" },
        ]),
      ],
      [tc({ credential_type: "SSO" })],
    );
    const r = await supply.execute(
      { values: { credential_type: "API Key" } },
      c,
    );

    expect(r.ok).toBe(true);
    expect(c.testCases![0]!.payload.credential_type).toBe("API Key");
  });

  it("continues scanning after credential_type and blocks the sibling credentials value", async () => {
    const c = ctx(
      [],
      [tc({ credential_type: "SSO", credentials: "credentials_demo" })],
    );
    const r = await supply.execute({}, c);

    expect(r.ok).toBe(false);
    expect(r.output).toMatchObject({
      next: "ask_user",
      reason: "test_fixture_secret_requires_server_profile",
      missing: ["case:tc1.credentials"],
    });
  });

  it("rejects a secret-shaped credential_type value without mutation or echo", async () => {
    const secret = "sk-live-credential-type-secret";
    const c = ctx(
      [
        spec("readSystemMetadata", [
          { field: "credential_type", type: "string" },
        ]),
      ],
      [tc({ credential_type: "SSO" })],
    );
    const before = JSON.stringify(c.testCases);
    const r = await supply.execute({ values: { credential_type: secret } }, c);

    expect(r.ok).toBe(false);
    expect(r.output).toMatchObject({
      next: "ask_user",
      reason: "literal_secret_in_test_fixture",
    });
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(JSON.stringify(c.testCases)).toBe(before);
  });

  it.each([
    "api_key",
    "token",
    "password",
    "credentials",
    "api_credentials",
    "compliance_credential_token",
  ])(
    "continues to treat the real secret contract field %s as a credential",
    async (field) => {
      const c = ctx(
        [spec("vendor", [{ field, type: "string" }])],
        [tc({ title: "safe" })],
      );
      const r = await supply.execute({}, c);

      expect(r.ok).toBe(false);
      expect(r.output).toMatchObject({
        next: "ask_user",
        reason: "test_fixture_secret_requires_server_profile",
      });
    },
  );

  it.each([
    "sk-live-secret-value",
    "Bearer live-token-value",
    "password=hunter2",
  ])(
    "rejects a secret-shaped value in compliance_credential: %s",
    async (secret) => {
      const c = ctx(
        [
          spec("verifyApplication", [
            { field: "compliance_credential", type: "string" },
          ]),
        ],
        [tc({ compliance_credential: "ISO-27001" })],
      );
      const before = JSON.stringify(c.testCases);
      const r = await supply.execute(
        {
          values: { compliance_credential: secret },
        },
        c,
      );

      expect(r.ok).toBe(false);
      expect(r.output).toMatchObject({
        next: "ask_user",
        reason: "literal_secret_in_test_fixture",
      });
      expect(JSON.stringify(r)).not.toContain(secret);
      expect(JSON.stringify(c.testCases)).toBe(before);
    },
  );

  it("returns a natural ask_user handoff when the contract contains a secret field", async () => {
    const c = ctx(
      [spec("vendor", [{ field: "api_key", type: "string" }])],
      [tc({ title: "safe" })],
    );
    const r = await supply.execute({}, c);
    expect(r.ok).toBe(false);
    expect(r.output).toMatchObject({
      next: "ask_user",
      reason: "test_fixture_secret_requires_server_profile",
    });
    expect(r.summary).toContain("服务器");
    expect(r.summary).toContain("不要");
    expect(r.summary).toContain("integration profile");
  });

  it("rejects a literal nested secret without mutating state or echoing its value", async () => {
    const c = ctx([], [tc({ config: { region: "cn" } })]);
    const secret = "sk-this-must-not-appear";
    const before = JSON.stringify(c.testCases);
    const r = await supply.execute(
      {
        case_payloads: [
          { case_id: "tc1", payload: { config: { api_key: secret } } },
        ],
      },
      c,
    );
    expect(r.ok).toBe(false);
    expect(r.output).toMatchObject({
      next: "ask_user",
      reason: "literal_secret_in_test_fixture",
    });
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(JSON.stringify(c.testCases)).toBe(before);
  });
});
