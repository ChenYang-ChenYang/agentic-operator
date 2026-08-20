import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { GatewayInstanceSchema } from "@agentic/contracts";
import { assertSafeGatewayBaseUrl } from "../src/services/gateway-network-safety";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

type SettingsStore = typeof import("../src/services/llm-settings-store");
type ProviderKeys = typeof import("../src/services/provider-keys");
type LlmService = typeof import("../src/services/llm");
type DbPackage = typeof import("@agentic/db");

interface CapturedGatewayRequest {
  url: string;
  authorization: string | null;
  model: string | null;
}

interface RoutingEnvelope {
  ok: true;
  data: {
    matchType: "explicit" | "exact" | "alias" | "parent" | "default";
    matchedTaskClass: string | null;
    selectedCandidate: { route: string };
    explanation: string;
    trace: Array<{ stage: string; outcome: string }>;
  };
}

const NEWAPI_CASES = [
  {
    id: "newapi",
    credentialRef: "newapi",
    credentialScope: "workspace",
    baseUrl: "https://localhost:4101",
    route: "newapi/kimi-k3",
    model: "kimi-k3",
    apiKey: "sk-newapi-primary-111111111111",
    expectedUrl: "https://localhost:4101/v1/chat/completions",
  },
  {
    id: "newapi-csi",
    credentialRef: "vault:newapi-csi",
    credentialScope: "tenant",
    baseUrl: "https://localhost:4102/api/v1",
    route: "newapi-csi/moonshotai/kimi-k3",
    model: "moonshotai/kimi-k3",
    apiKey: "sk-newapi-csi-222222222222222",
    expectedUrl: "https://localhost:4102/api/v1/chat/completions",
  },
  {
    id: "newapi2",
    credentialRef: "newapi2.credentials",
    credentialScope: "workspace",
    baseUrl: "https://localhost:4103/v1/",
    route: "newapi2/z-ai/glm-5.2",
    model: "z-ai/glm-5.2",
    apiKey: "sk-newapi-two-333333333333333",
    expectedUrl: "https://localhost:4103/v1/chat/completions",
  },
] as const;

describe("AI settings persistence, routing API, and NewAPI aliases", () => {
  const temporaryDirectory = mkdtempSync(
    join(
      process.env.AGENTIC_API_TEST_RUN_ROOT ?? tmpdir(),
      "agentic-llm-settings-routing-",
    ),
  );
  const settingsPath = join(temporaryDirectory, "llm-settings.json");
  // 系统临时目录，刻意【不】在 data/test-runs/ 下——生产姿态的用例要用它。
  const durableSettingsDirectory = mkdtempSync(
    join(tmpdir(), "agentic-llm-settings-durable-"),
  );
  const durableSettingsPath = join(
    durableSettingsDirectory,
    "llm-settings.json",
  );
  const durableEnvMirrorPath = join(
    durableSettingsDirectory,
    "llm-settings.env.local",
  );
  const envMirrorPath = join(temporaryDirectory, ".env.local");
  const vaultPath = join(temporaryDirectory, "provider-keys.json");
  const databasePath = join(temporaryDirectory, "agentic.db");
  const migrationsFolder = fileURLToPath(
    new URL("../../../packages/db/drizzle", import.meta.url),
  );
  const previousEnvironment = new Map<string, string | undefined>();
  const originalFetch = globalThis.fetch;
  const capturedRequests: CapturedGatewayRequest[] = [];

  let app: FastifyInstance;
  let settingsStore: SettingsStore;
  let providerKeys: ProviderKeys;
  let llmService: LlmService;
  let dbPackage: DbPackage;
  let systemTenantId: string;

  beforeAll(async () => {
    for (const name of [
      "AGENTIC_LLM_SETTINGS_PATH",
      "AGENTIC_LLM_ENV_MIRROR_PATH",
      "AGENTIC_KEY_VAULT_PATH",
      "AGENTIC_KEY_VAULT_SECRET",
      "DATABASE_URL",
      "LLM_DEFAULT_PROVIDER",
      "LLM_DEFAULT_MODEL",
      "CUSTOM_LLM_BASE_URL",
      "CUSTOM_LLM_API_KEY",
      "LLM_ALLOW_INSECURE_GATEWAYS",
      "LLM_GATEWAY_ALLOWED_HOSTS",
      "AUTH_MODE",
      "NODE_ENV",
    ]) {
      previousEnvironment.set(name, process.env[name]);
    }
    process.env.AGENTIC_LLM_SETTINGS_PATH = settingsPath;
    process.env.AGENTIC_LLM_ENV_MIRROR_PATH = envMirrorPath;
    process.env.AGENTIC_KEY_VAULT_PATH = vaultPath;
    process.env.AGENTIC_KEY_VAULT_SECRET =
      "llm-settings-routing-test-vault-secret";
    process.env.LLM_DEFAULT_PROVIDER = "mock";
    process.env.LLM_DEFAULT_MODEL = "mock-model-v1";
    process.env.DATABASE_URL = `file:${databasePath}`;
    process.env.AUTH_MODE = "dev";
    process.env.NODE_ENV = "test";

    vi.resetModules();
    [settingsStore, providerKeys, llmService, dbPackage] = await Promise.all([
      import("../src/services/llm-settings-store"),
      import("../src/services/provider-keys"),
      import("../src/services/llm"),
      import("@agentic/db"),
    ]);
    const [{ registerEnvelope }, { registerAuth }, { llmRoutes }] =
      await Promise.all([
        import("../src/plugins/error"),
        import("../src/plugins/auth"),
        import("../src/routes/v1/llm"),
      ]);

    dbPackage.runMigrations(migrationsFolder);
    systemTenantId = `ten-llm-settings-${randomUUID()}`;
    dbPackage
      .getDb()
      .insert(dbPackage.tenants)
      .values({
        id: systemTenantId,
        slug: "__system",
        name: "LLM settings test tenant",
      })
      .run();
    // This suite talks to a fresh temp DB (DATABASE_URL above), so the shared
    // worker-snapshot dev principal is absent. Seed the AUTH_MODE=dev operator
    // the harness expects (AGENTIC_DEV_USER_EMAIL, set in test/setup.ts) as an
    // active superadmin so authenticated settings/routing calls resolve.
    dbPackage
      .getDb()
      .insert(dbPackage.users)
      .values({
        id: `usr-llm-settings-${randomUUID()}`,
        email: (
          process.env.AGENTIC_DEV_USER_EMAIL ??
          "test-platform-admin@agentic.invalid"
        ).toLowerCase(),
        name: "LLM settings test admin",
        platformRole: "superadmin",
        status: "active",
      })
      .run();

    app = Fastify({ logger: false });
    await registerEnvelope(app);
    await registerAuth(app);
    await app.register(llmRoutes, { prefix: "/v1" });
    await app.ready();
  });

  /**
   * 进入「生产姿态」——SSRF / 私网拦截只在 NODE_ENV=production 下生效。
   *
   * 但 NODE_ENV=production 同时会武装 assertDurableLlmSettingsPath：本套件的
   * 设置文件落在 data/test-runs/ 这棵一次性目录树下，而那正是该守卫存在的
   * 理由（生产不许把运营方的路由配置写进用完即删的目录）。守卫是对的，是这
   * 两个用例的环境自相矛盾。所以进入生产姿态时把设置文件挪到一个【持久】的
   * 系统临时目录，而不是放宽守卫。
   */
  const enterProductionPosture = (): void => {
    process.env.NODE_ENV = "production";
    process.env.AGENTIC_LLM_SETTINGS_PATH = durableSettingsPath;
    process.env.AGENTIC_LLM_ENV_MIRROR_PATH = durableEnvMirrorPath;
  };

  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.AGENTIC_LLM_SETTINGS_PATH = settingsPath;
    process.env.AGENTIC_LLM_ENV_MIRROR_PATH = envMirrorPath;
    rmSync(durableSettingsPath, { force: true });
    rmSync(durableEnvMirrorPath, { force: true });
    process.env.LLM_DEFAULT_PROVIDER = "mock";
    process.env.LLM_DEFAULT_MODEL = "mock-model-v1";
    delete process.env.CUSTOM_LLM_BASE_URL;
    delete process.env.CUSTOM_LLM_API_KEY;
    delete process.env.LLM_ALLOW_INSECURE_GATEWAYS;
    delete process.env.LLM_GATEWAY_ALLOWED_HOSTS;
    rmSync(settingsPath, { force: true });
    rmSync(vaultPath, { force: true });
    writeFileSync(envMirrorPath, "EXISTING_SETTING=preserved\n", {
      mode: 0o600,
    });
    settingsStore._resetLlmSettingsCache();
    providerKeys._resetProviderKeyVaultCache();
    llmService.resetLLMGateway();
    capturedRequests.length = 0;
    globalThis.fetch = originalFetch;
  });

  afterAll(async () => {
    try {
      globalThis.fetch = originalFetch;
      llmService?._setLLMGatewayForTests(null);
      llmService?.resetLLMGateway();
      await app?.close();
      dbPackage?.closeDb();
    } finally {
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(temporaryDirectory, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it("mirrors non-secret JSON, detects drift, and rejects stale or secret-bearing saves", () => {
    const initial = settingsStore.getLlmSettings("__system");
    expect(initial.settings.revision).toBe(0);
    expect(initial.sync.status).toBe("synced");
    expect(existsSync(settingsPath)).toBe(true);
    expect(existsSync(envMirrorPath)).toBe(true);

    const saved = settingsStore.saveLlmSettings(
      "__system",
      settingsDocument({
        defaultRoute: "newapi-csi/moonshotai/kimi-k3",
        gateways: [
          {
            id: "newapi-csi",
            displayName: "CSI NewAPI",
            kind: "newapi",
            baseUrl: "https://newapi.example.test/v1",
            credentialRef: "newapi-csi",
            dialect: "moonshot",
          },
        ],
      }),
      0,
    );
    expect(saved.settings.revision).toBe(1);
    expect(saved.sync.status).toBe("synced");

    const jsonContent = readFileSync(settingsPath, "utf8");
    const envContent = readFileSync(envMirrorPath, "utf8");
    const persisted = JSON.parse(jsonContent) as {
      fileVersion: number;
      workspaces: Record<string, { revision: number }>;
    };
    expect(persisted.fileVersion).toBe(1);
    expect(persisted.workspaces.__system?.revision).toBe(1);
    expect(envContent).toContain("EXISTING_SETTING=preserved");
    expect(envContent).toContain(
      `AGENTIC_LLM_SETTINGS_SHA256=${createHash("sha256").update(jsonContent).digest("hex")}`,
    );
    const mirror = envContent.match(/^AGENTIC_LLM_SETTINGS_B64=(.+)$/m)?.[1];
    expect(mirror).toBeDefined();
    expect(Buffer.from(mirror!, "base64").toString("utf8")).toBe(jsonContent);

    writeFileSync(
      envMirrorPath,
      envContent.replace(
        /^AGENTIC_LLM_SETTINGS_B64=.+$/m,
        "AGENTIC_LLM_SETTINGS_B64=dGFtcGVyZWQ=",
      ),
      { mode: 0o600 },
    );
    settingsStore._resetLlmSettingsCache();
    expect(settingsStore.getLlmSettings("__system").sync).toMatchObject({
      status: "drift",
      message: expect.stringMatching(/payload is stale/i),
    });
    expect(settingsStore.resyncLlmSettings("__system").sync.status).toBe(
      "synced",
    );

    expect(() =>
      settingsStore.saveLlmSettings("__system", saved.settings, 0),
    ).toThrowError(
      expect.objectContaining({
        name: "LlmSettingsConflictError",
        expectedRevision: 0,
        actualRevision: 1,
      }),
    );

    const plaintextSecret = "sk-must-never-enter-settings-999999999";
    const secretBearing = structuredClone(saved.settings) as Record<
      string,
      unknown
    > & {
      gatewayInstances: Array<Record<string, unknown>>;
    };
    secretBearing.gatewayInstances[0]!.apiKey = plaintextSecret;
    expect(() =>
      settingsStore.saveLlmSettings("__system", secretBearing, 1),
    ).toThrow(/apiKey|unrecognized/i);
    expect(readFileSync(settingsPath, "utf8")).not.toContain(plaintextSecret);
    expect(readFileSync(envMirrorPath, "utf8")).not.toContain(plaintextSecret);
  });

  it("rejects catalog-known legacy routes in newly saved settings", () => {
    settingsStore.getLlmSettings("__system");
    expect(() =>
      settingsStore.saveLlmSettings(
        "__system",
        settingsDocument({
          defaultRoute: "anthropic/claude-opus-4",
          gateways: [
            {
              id: "anthropic",
              displayName: "Anthropic",
              kind: "direct",
              providerId: "anthropic",
            },
          ],
        }),
        0,
      ),
    ).toThrow(/older_than_365_days/);
  });

  it("returns exact, nearest-parent, and default route decisions through the API", async () => {
    settingsStore.getLlmSettings("__system");
    const saved = settingsStore.saveLlmSettings(
      "__system",
      settingsDocument({
        defaultRoute: "mock/mock-model-v1",
        gateways: [
          {
            id: "mock",
            displayName: "Mock",
            kind: "mock",
          },
          {
            id: "newapi-csi",
            displayName: "CSI NewAPI",
            kind: "newapi",
            baseUrl: "https://newapi.example.test/v1",
            credentialRef: "newapi-csi",
          },
        ],
        taskProfiles: [
          {
            taskClass: "ontology.generate",
            candidates: [{ route: "newapi-csi/openai/gpt-5.6-sol" }],
          },
        ],
      }),
      0,
    );

    const exact = await resolveThroughApi("ontology.generate");
    expect(exact).toMatchObject({
      matchType: "exact",
      matchedTaskClass: "ontology.generate",
      selectedCandidate: { route: "newapi-csi/openai/gpt-5.6-sol" },
    });

    const nearest = await resolveThroughApi("ontogene.generate.schema");
    expect(nearest).toMatchObject({
      matchType: "parent",
      matchedTaskClass: "ontology.generate",
      selectedCandidate: { route: "newapi-csi/openai/gpt-5.6-sol" },
    });
    expect(nearest.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "parent", outcome: "selected" }),
      ]),
    );

    const fallback = await resolveThroughApi("unmapped.customer.task");
    expect(fallback).toMatchObject({
      matchType: "default",
      matchedTaskClass: null,
      selectedCandidate: { route: "mock/mock-model-v1" },
    });
  });

  it.each([null, false, "0"])(
    "rejects non-numeric settings revision %j instead of coercing it",
    async (expectedRevision) => {
      const response = await app.inject({
        method: "PUT",
        url: "/v1/llm/settings",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": "__system",
        },
        payload: {
          expectedRevision,
          settings: settingsStore.getLlmSettings("__system").settings,
        },
      });

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({
        ok: false,
        error: {
          code: "bad_request",
          message: expect.stringMatching(/non-negative integer/i),
        },
      });
    },
  );

  it.each(NEWAPI_CASES)(
    "routes $route through its own NewAPI URL and credential with the exact upstream model id",
    async (testCase) => {
      configureNewApiAliases();
      installGatewayFetchMock();

      const response = await callRoute(testCase.route);
      expect(response.routing).toMatchObject({
        effectiveRoute: testCase.route,
        gatewayInstanceId: testCase.id,
        gatewayKind: "newapi",
      });
      expect(capturedRequests).toEqual([
        {
          url: testCase.expectedUrl,
          authorization: `Bearer ${testCase.apiKey}`,
          model: testCase.model,
        },
      ]);
    },
  );

  it("enforces Kimi K3's route-specific context ceiling before NewAPI dispatch", async () => {
    configureNewApiAliases();
    installGatewayFetchMock();

    await expect(callRoute("newapi/kimi-k3", 1_048_577)).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringMatching(/catalog maximum of 1048576/i),
    });
    expect(capturedRequests).toEqual([]);

    await expect(callRoute("newapi/kimi-k3", 1_048_576)).resolves.toMatchObject(
      {
        routing: { effectiveRoute: "newapi/kimi-k3" },
      },
    );
    expect(capturedRequests.at(-1)?.model).toBe("kimi-k3");
  });

  it("keeps three concurrently used NewAPI aliases isolated", async () => {
    configureNewApiAliases();
    installGatewayFetchMock();

    const settingsResponse = await app.inject({
      method: "GET",
      url: "/v1/llm/settings",
      headers: { "x-agentic-tenant": "__system" },
    });
    expect(settingsResponse.statusCode, settingsResponse.body).toBe(200);
    for (const testCase of NEWAPI_CASES) {
      expect(settingsResponse.body).not.toContain(testCase.apiKey);
    }
    const settingsEnvelope = settingsResponse.json<{
      ok: true;
      data: {
        credentials: Record<
          string,
          { hasKey: boolean; keyMasked: string | null }
        >;
      };
    }>();
    for (const testCase of NEWAPI_CASES) {
      expect(settingsEnvelope.data.credentials[testCase.id]).toMatchObject({
        hasKey: true,
        keyMasked: expect.stringContaining("…"),
      });
    }

    await Promise.all(
      NEWAPI_CASES.map((testCase) => callRoute(testCase.route)),
    );

    const byModel = new Map(
      capturedRequests.map((request) => [request.model, request]),
    );
    for (const testCase of NEWAPI_CASES) {
      expect(byModel.get(testCase.model)).toEqual({
        url: testCase.expectedUrl,
        authorization: `Bearer ${testCase.apiKey}`,
        model: testCase.model,
      });
    }
  });

  it("uses each named direct and OpenRouter instance credential for real chat routing", async () => {
    const directKey = "sk-direct-csi-888888888888888888";
    const openRouterKey = "sk-openrouter-csi-999999999999999";
    settingsStore.getLlmSettings("__system");
    settingsStore.saveLlmSettings(
      "__system",
      settingsDocument({
        defaultRoute: "deepseek-csi/deepseek-v4-flash",
        gateways: [
          {
            id: "deepseek-csi",
            displayName: "CSI DeepSeek",
            kind: "direct",
            providerId: "deepseek",
            credentialRef: "direct.deepseek-csi",
            credentialScope: "tenant",
          },
          {
            id: "openrouter-csi",
            displayName: "CSI OpenRouter",
            kind: "openrouter",
            credentialRef: "gateway:openrouter-csi",
            credentialScope: "workspace",
          },
        ],
      }),
      0,
    );
    providerKeys.setGatewayCredential("direct.deepseek-csi", {
      apiKey: directKey,
      scope: "tenant",
      tenantId: systemTenantId,
      setBy: "test",
    });
    providerKeys.setGatewayCredential("gateway:openrouter-csi", {
      apiKey: openRouterKey,
      scope: "workspace",
      setBy: "test",
    });
    llmService.resetLLMGateway();
    installGatewayFetchMock();

    await Promise.all([
      callRoute("deepseek-csi/deepseek-v4-flash"),
      callRoute("openrouter-csi/openai/gpt-5.6-terra"),
    ]);

    expect(capturedRequests).toEqual(
      expect.arrayContaining([
        {
          url: "https://api.deepseek.com/chat/completions",
          authorization: `Bearer ${directKey}`,
          model: "deepseek-v4-flash",
        },
        {
          url: "https://openrouter.ai/api/v1/chat/completions",
          authorization: `Bearer ${openRouterKey}`,
          model: "openai/gpt-5.6-terra",
        },
      ]),
    );
  });

  it("does not apply task-profile defaults to an explicit route", async () => {
    const apiKey = "sk-explicit-route-parameters-101010101010";
    settingsStore.getLlmSettings("__system");
    const saved = settingsStore.saveLlmSettings(
      "__system",
      settingsDocument({
        defaultRoute: "explicit-gateway/vendor/model-alpha",
        gateways: [
          {
            id: "explicit-gateway",
            displayName: "Explicit gateway",
            kind: "newapi",
            baseUrl: "https://localhost:4120",
            credentialRef: "explicit-gateway",
            credentialScope: "workspace",
            dialect: "openai-chat",
          },
        ],
        taskProfiles: [
          {
            taskClass: "ontology.generate",
            parameters: {
              maxTokens: 11,
              temperature: 1.7,
              reasoning: { effort: "max" },
            },
            candidates: [{ route: "explicit-gateway/vendor/model-alpha" }],
          },
        ],
      }),
      0,
    );
    const instance = saved.settings.gatewayInstances[0];
    if (!instance) throw new Error("missing explicit gateway");
    providerKeys.setGatewayCredential(
      providerKeys.gatewayCredentialSlot(instance, systemTenantId),
      {
        apiKey,
        scope: "workspace",
        setBy: "test",
      },
    );
    llmService.resetLLMGateway();

    let wireBody: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        wireBody = (await request.json()) as Record<string, unknown>;
        return completionResponse("vendor/model-alpha");
      },
    ) as typeof fetch;

    const response = await llmService.getLLMGateway().chat({
      tenantId: systemTenantId,
      purpose: "test.explicit-parameter-precedence",
      messages: [{ role: "user", content: "use only request controls" }],
      maxTokens: 73,
      temperature: 0.4,
      reasoning: { effort: "low" },
      routing: {
        taskType: "ontology.generate",
        requestedRoute: "explicit-gateway/vendor/model-alpha",
      },
    });

    expect(response.routing).toMatchObject({
      resolutionReason: "explicit",
      effectiveRoute: "explicit-gateway/vendor/model-alpha",
    });
    expect(wireBody).toMatchObject({
      max_tokens: 73,
      temperature: 0.4,
      reasoning_effort: "low",
    });
  });

  it("normalizes ordinary request controls across a heterogeneous fallback", async () => {
    const firstKey = "sk-fallback-openai-3030303030303030";
    const secondKey = "sk-fallback-anthropic-404040404040";
    settingsStore.getLlmSettings("__system");
    const saved = settingsStore.saveLlmSettings(
      "__system",
      settingsDocument({
        defaultRoute: "newapi-openai/openai/gpt-5.6-sol",
        gateways: [
          {
            id: "newapi-openai",
            displayName: "NewAPI OpenAI",
            kind: "newapi",
            baseUrl: "https://localhost:4130",
            credentialRef: "fallback-openai",
            capabilities: { responses: true, chatCompletions: true },
          },
          {
            id: "newapi-anthropic",
            displayName: "NewAPI Anthropic",
            kind: "newapi",
            baseUrl: "https://localhost:4131",
            credentialRef: "fallback-anthropic",
            capabilities: { chatCompletions: true },
          },
        ],
        taskProfiles: [
          {
            taskClass: "chat.respond",
            candidates: [
              {
                route: "newapi-openai/openai/gpt-5.6-sol",
                modelFamily: "openai.gpt",
              },
              {
                route: "newapi-anthropic/anthropic/claude-opus-4-8",
                modelFamily: "anthropic.claude",
              },
            ],
          },
        ],
      }),
      0,
    );
    for (const [id, key] of [
      ["newapi-openai", firstKey],
      ["newapi-anthropic", secondKey],
    ] as const) {
      const instance = saved.settings.gatewayInstances.find(
        (gateway) => gateway.id === id,
      );
      if (!instance) throw new Error(`missing ${id}`);
      providerKeys.setGatewayCredential(
        providerKeys.gatewayCredentialSlot(instance, systemTenantId),
        { apiKey: key, scope: "workspace", setBy: "test" },
      );
    }
    llmService.resetLLMGateway();

    const wireRequests: Array<{
      url: string;
      body: Record<string, unknown>;
    }> = [];
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        const body = (await request.json()) as Record<string, unknown>;
        wireRequests.push({ url: request.url, body });
        if (request.url.includes(":4130/")) {
          return new Response(
            JSON.stringify({ error: { message: "temporary unavailable" } }),
            {
              status: 503,
              headers: {
                "content-type": "application/json",
                "x-should-retry": "false",
              },
            },
          );
        }
        return completionResponse("anthropic/claude-opus-4-8");
      },
    ) as typeof fetch;

    const response = await llmService.getLLMGateway().chat({
      tenantId: systemTenantId,
      purpose: "test.heterogeneous-fallback",
      messages: [{ role: "user", content: "fallback safely" }],
      reasoning: { mode: "pro", effort: "high", summary: "auto" },
      verbosity: "high",
      temperature: 0.2,
      store: false,
      routing: { taskType: "chat.respond" },
    });

    expect(response.routing).toMatchObject({
      effectiveRoute: "newapi-anthropic/anthropic/claude-opus-4-8",
      fallbackIndex: 1,
    });
    const fallbackWire = wireRequests.find((request) =>
      request.url.includes(":4131/"),
    );
    expect(fallbackWire?.url).toContain("/v1/chat/completions");
    expect(fallbackWire?.body).toMatchObject({
      model: "anthropic/claude-opus-4-8",
      reasoning_effort: "high",
    });
    expect(fallbackWire?.body).not.toHaveProperty("reasoning");
    expect(fallbackWire?.body).not.toHaveProperty("temperature");
    expect(fallbackWire?.body).not.toHaveProperty("verbosity");
    expect(fallbackWire?.body).not.toHaveProperty("store");
    const recordedFallback = dbPackage
      .getDb()
      .select()
      .from(dbPackage.llmCalls)
      .all()
      .find(
        (call) =>
          call.purpose === "test.heterogeneous-fallback" &&
          call.effectiveRoute === "newapi-anthropic/anthropic/claude-opus-4-8",
      );
    expect(recordedFallback).toMatchObject({
      transport: "chat",
      fallbackIndex: 1,
    });
  });

  it("refreshes revision-zero custom settings from the environment and uses its credential only at the exact endpoint", async () => {
    const firstBaseUrl = "https://localhost:4140/v1";
    const currentBaseUrl = "https://localhost:4141/v1/";
    const currentApiKey = "sk-env-custom-current-414141414141";
    process.env.LLM_DEFAULT_PROVIDER = "custom";
    process.env.LLM_DEFAULT_MODEL = "vendor/env-model";
    process.env.CUSTOM_LLM_BASE_URL = firstBaseUrl;
    process.env.CUSTOM_LLM_API_KEY = "sk-env-custom-first-404040404040";

    const initial = settingsStore.getLlmSettings("__system");
    expect(initial.settings).toMatchObject({
      revision: 0,
      defaultProfile: {
        candidates: [{ route: "custom/vendor/env-model", enabled: true }],
      },
    });
    expect(
      initial.settings.gatewayInstances.find(
        (instance) => instance.id === "custom",
      )?.baseUrl,
    ).toBe(firstBaseUrl);

    process.env.CUSTOM_LLM_BASE_URL = currentBaseUrl;
    process.env.CUSTOM_LLM_API_KEY = currentApiKey;
    const refreshed = settingsStore.getLlmSettings("__system");
    expect(refreshed.settings.revision).toBe(0);
    expect(
      refreshed.settings.gatewayInstances.find(
        (instance) => instance.id === "custom",
      )?.baseUrl,
    ).toBe(currentBaseUrl);
    expect(readFileSync(settingsPath, "utf8")).not.toContain(currentApiKey);
    expect(readFileSync(envMirrorPath, "utf8")).not.toContain(currentApiKey);

    installGatewayFetchMock();
    llmService.resetLLMGateway();
    await expect(callRoute("custom/vendor/env-model")).resolves.toMatchObject({
      routing: {
        effectiveRoute: "custom/vendor/env-model",
        gatewayInstanceId: "custom",
      },
    });
    expect(capturedRequests).toEqual([
      {
        url: "https://localhost:4141/v1/chat/completions",
        authorization: `Bearer ${currentApiKey}`,
        model: "vendor/env-model",
      },
    ]);
  });

  it("keeps revision-one custom settings pinned and refuses the env credential after the configured endpoint changes", async () => {
    const pinnedBaseUrl = "https://localhost:4142/v1";
    process.env.LLM_DEFAULT_PROVIDER = "custom";
    process.env.LLM_DEFAULT_MODEL = "vendor/pinned-model";
    process.env.CUSTOM_LLM_BASE_URL = pinnedBaseUrl;
    process.env.CUSTOM_LLM_API_KEY = "sk-env-custom-pinned-424242424242";

    const generated = settingsStore.getLlmSettings("__system");
    const saved = settingsStore.saveLlmSettings(
      "__system",
      generated.settings,
      0,
    );
    expect(saved.settings.revision).toBe(1);

    process.env.CUSTOM_LLM_BASE_URL = "https://localhost:4143/v1";
    process.env.CUSTOM_LLM_API_KEY = "sk-env-custom-other-434343434343";
    const reread = settingsStore.getLlmSettings("__system");
    expect(reread.settings.revision).toBe(1);
    expect(
      reread.settings.gatewayInstances.find(
        (instance) => instance.id === "custom",
      )?.baseUrl,
    ).toBe(pinnedBaseUrl);

    llmService.resetLLMGateway();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    await expect(callRoute("custom/vendor/pinned-model")).rejects.toMatchObject(
      { code: "not_configured" },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not use the workspace custom env credential for a tenant-scoped canonical instance", async () => {
    const baseUrl = "https://localhost:4144/v1";
    process.env.CUSTOM_LLM_BASE_URL = baseUrl;
    process.env.CUSTOM_LLM_API_KEY = "sk-env-custom-workspace-444444444444";
    settingsStore.getLlmSettings("__system");
    settingsStore.saveLlmSettings(
      "__system",
      settingsDocument({
        defaultRoute: "custom/vendor/tenant-model",
        gateways: [
          {
            id: "custom",
            displayName: "Custom",
            kind: "openai-compatible",
            baseUrl,
            credentialRef: "custom",
            credentialScope: "tenant",
          },
        ],
      }),
      0,
    );

    llmService.resetLLMGateway();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    await expect(callRoute("custom/vendor/tenant-model")).rejects.toMatchObject(
      { code: "not_configured" },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never resolves a dynamic credentialRef named openai to the static OpenAI secret", async () => {
    const staticOpenAiSecret = "sk-static-openai-must-not-forward-202020202020";
    providerKeys.setGatewayCredential("openai", {
      apiKey: staticOpenAiSecret,
      scope: "workspace",
      setBy: "test",
    });
    settingsStore.getLlmSettings("__system");
    const saved = settingsStore.saveLlmSettings(
      "__system",
      settingsDocument({
        defaultRoute: "untrusted-gateway/vendor/model-alpha",
        gateways: [
          {
            id: "untrusted-gateway",
            displayName: "Untrusted gateway",
            kind: "newapi",
            baseUrl: "https://localhost:4121",
            credentialRef: "openai",
            credentialScope: "workspace",
            dialect: "openai-chat",
          },
        ],
      }),
      0,
    );
    const instance = saved.settings.gatewayInstances[0];
    if (!instance) throw new Error("missing untrusted gateway");
    const dynamicSlot = providerKeys.gatewayCredentialSlot(
      instance,
      systemTenantId,
    );
    expect(dynamicSlot).not.toBe("openai");
    expect(
      providerKeys.getGatewayCredential(
        dynamicSlot,
        systemTenantId,
        "workspace",
      ),
    ).toBeNull();
    llmService.resetLLMGateway();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;

    await expect(
      callRoute("untrusted-gateway/vendor/model-alpha"),
    ).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks a production private-network connection test before fetch", async () => {
    enterProductionPosture();
    process.env.LLM_ALLOW_INSECURE_GATEWAYS = "true";
    delete process.env.LLM_GATEWAY_ALLOWED_HOSTS;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    const instance = GatewayInstanceSchema.parse({
      id: "newapi-private",
      displayName: "Private NewAPI",
      kind: "newapi",
      baseUrl: "http://127.0.0.1:3000",
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/llm/gateways/newapi-private/test-connection",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": "__system",
      },
      payload: {
        apiKey: "sk-private-should-not-be-sent",
        instance,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<{
      ok: true;
      data: {
        ok: boolean;
        statusCode: number | null;
        endpoint: string | null;
        message: string;
      };
    }>().data;

    expect(result).toMatchObject({
      ok: false,
      statusCode: null,
      endpoint: "http://127.0.0.1:3000",
    });
    expect(result.message).toMatch(/private gateway hosts require/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    "https://[::ffff:127.0.0.1]:4444",
    "https://[::1]:4444",
    "https://100.64.0.1:4444",
    "https://198.18.0.1:4444",
  ])("blocks non-public special address %s in production", async (baseUrl) => {
    enterProductionPosture();
    delete process.env.LLM_GATEWAY_ALLOWED_HOSTS;
    await expect(assertSafeGatewayBaseUrl(baseUrl)).rejects.toThrow(
      /private gateway hosts require/i,
    );
  });

  it("never hydrates a stored credential into a draft connection test", async () => {
    const storedSecret = "sk-victim-workspace-secret-444444444";
    providerKeys.setGatewayCredential("victim-key", {
      apiKey: storedSecret,
      scope: "workspace",
      setBy: "test",
    });
    const requests: Array<{
      authorization: string | null;
      redirect: RequestRedirect;
      url: string;
    }> = [];
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        requests.push({
          authorization: request.headers.get("authorization"),
          redirect: request.redirect,
          url: request.url,
        });
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    ) as typeof fetch;

    const response = await app.inject({
      method: "POST",
      url: "/v1/llm/gateways/draft-newapi/test-connection",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": "__system",
      },
      payload: {
        instance: {
          id: "draft-newapi",
          displayName: "Draft NewAPI",
          kind: "newapi",
          baseUrl: "https://localhost:4555",
          credentialRef: "victim-key",
        },
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain(storedSecret);
    expect(requests).toEqual([
      {
        authorization: null,
        redirect: "error",
        url: "https://localhost:4555/v1/models",
      },
    ]);
  });

  it("enforces tenant and workspace credential scopes without fallback", () => {
    providerKeys.setGatewayCredential("scope-test", {
      apiKey: "sk-workspace-scope-55555555555555",
      scope: "workspace",
      setBy: "test",
    });
    providerKeys.setGatewayCredential("scope-test", {
      apiKey: "sk-tenant-scope-666666666666666",
      scope: "tenant",
      tenantId: systemTenantId,
      setBy: "test",
    });
    expect(
      providerKeys.getGatewayCredential(
        "scope-test",
        systemTenantId,
        "workspace",
      )?.apiKey,
    ).toBe("sk-workspace-scope-55555555555555");
    expect(
      providerKeys.getGatewayCredential("scope-test", systemTenantId, "tenant")
        ?.apiKey,
    ).toBe("sk-tenant-scope-666666666666666");
    expect(
      providerKeys.getGatewayCredential(
        "scope-test",
        "tenant-without-key",
        "tenant",
      ),
    ).toBeNull();
  });

  it.each([
    ["missing prompt", {}],
    ["invalid route", { prompt: "hello", route: "openai" }],
    ["invalid task class", { prompt: "hello", taskClass: "Bad Task" }],
    ["zero maxTokens", { prompt: "hello", maxTokens: 0 }],
    ["sub-second timeout", { prompt: "hello", timeoutMs: 999 }],
    ["out-of-range temperature", { prompt: "hello", temperature: 2.1 }],
    ["empty reasoning controls", { prompt: "hello", reasoning: {} }],
    ["invalid verbosity", { prompt: "hello", verbosity: "verbose" }],
    ["non-boolean store", { prompt: "hello", store: "false" }],
    ["non-boolean jsonMode", { prompt: "hello", jsonMode: 1 }],
    ["unknown property", { prompt: "hello", apiKey: "must-not-be-accepted" }],
  ])("strictly validates test-call body: %s", async (_label, payload) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/llm/test-call",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": "__system",
      },
      payload,
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
  });

  it("returns a categorical test-call error without upstream secret text", async () => {
    const apiKey = "sk-test-call-error-secret-303030303030";
    settingsStore.getLlmSettings("__system");
    const saved = settingsStore.saveLlmSettings(
      "__system",
      settingsDocument({
        defaultRoute: "error-gateway/vendor/model-alpha",
        gateways: [
          {
            id: "error-gateway",
            displayName: "Error gateway",
            kind: "newapi",
            baseUrl: "https://localhost:4122",
            credentialRef: "error-gateway",
            credentialScope: "workspace",
            dialect: "openai-chat",
          },
        ],
      }),
      0,
    );
    const instance = saved.settings.gatewayInstances[0];
    if (!instance) throw new Error("missing error gateway");
    providerKeys.setGatewayCredential(
      providerKeys.gatewayCredentialSlot(instance, systemTenantId),
      { apiKey, scope: "workspace", setBy: "test" },
    );
    llmService.resetLLMGateway();
    const upstreamDetail = `credential ${apiKey} was rejected upstream`;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: upstreamDetail } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;

    const response = await app.inject({
      method: "POST",
      url: "/v1/llm/test-call",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": "__system",
      },
      payload: {
        prompt: "test this route",
        route: "error-gateway/vendor/model-alpha",
      },
    });

    expect(response.statusCode, response.body).toBe(401);
    expect(response.body).not.toContain(apiKey);
    expect(response.body).not.toContain(upstreamDetail);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "auth",
        message:
          "Provider authentication failed. Check the configured credential.",
      },
    });
  });

  // ── Caller difficulty preference vs. workspace policy ───────────────────
  // The Agent Factory routes by task difficulty. Workspace policy stays the
  // boundary (only its candidates may serve); the preference orders WITHIN it.
  function configurePreferenceProfile(): void {
    settingsStore.getLlmSettings("__system");
    const saved = settingsStore.saveLlmSettings(
      "__system",
      {
        schemaVersion: 1,
        revision: 0,
        gatewayInstances: [
          {
            id: "pref-gateway",
            displayName: "Preference gateway",
            kind: "newapi",
            baseUrl: "https://localhost:4130",
            credentialRef: "pref-gateway",
            credentialScope: "workspace",
            dialect: "openai-chat",
          },
        ],
        defaultProfile: {
          candidates: [{ route: "pref-gateway/vendor/cheap-flash" }],
        },
        taskProfiles: [
          {
            taskClass: "agent.author",
            candidates: [
              { route: "pref-gateway/vendor/cheap-flash" },
              { route: "pref-gateway/vendor/strong-reasoner" },
            ],
          },
        ],
      },
      0,
    );
    const instance = saved.settings.gatewayInstances[0];
    if (!instance) throw new Error("missing preference gateway");
    providerKeys.setGatewayCredential(
      providerKeys.gatewayCredentialSlot(instance, systemTenantId),
      {
        apiKey: "sk-preference-gateway-9090909090909090",
        scope: "workspace",
        setBy: "test",
      },
    );
    llmService.resetLLMGateway();
  }

  it("serves the difficulty-preferred model when workspace policy allows it", async () => {
    configurePreferenceProfile();
    installGatewayFetchMock();

    const purpose = `test.preference-satisfied.${randomUUID()}`;
    const response = await llmService.getLLMGateway().chat({
      tenantId: systemTenantId,
      purpose,
      messages: [{ role: "user", content: "design the agent" }],
      routing: {
        taskType: "agent.author",
        modelPreference: ["strong-reasoner", "mid-pro"],
        modelPreferenceTier: "hard",
      },
    });

    // The policy's own first candidate is the flash model; the difficulty
    // preference moved the allowed strong model to the front.
    expect(capturedRequests.at(-1)?.model).toBe("vendor/strong-reasoner");
    expect(response.routing).toMatchObject({
      effectiveRoute: "pref-gateway/vendor/strong-reasoner",
      modelPreferenceSatisfied: true,
      modelPreferenceTier: "hard",
    });

    const telemetry = dbPackage
      .getDb()
      .select()
      .from(dbPackage.llmCallTelemetry)
      .all()
      .filter((row) => row.purpose === purpose);
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({
      requestedTier: "hard",
      modelPreference: ["strong-reasoner", "mid-pro"],
      preferenceSatisfied: true,
      servedModel: "vendor/strong-reasoner",
    });
  });

  it("says so instead of pretending when no allowed model matches the difficulty preference", async () => {
    configurePreferenceProfile();
    installGatewayFetchMock();

    const purpose = `test.preference-unmet.${randomUUID()}`;
    const response = await llmService.getLLMGateway().chat({
      tenantId: systemTenantId,
      purpose,
      messages: [{ role: "user", content: "design the agent" }],
      routing: {
        taskType: "agent.author",
        modelPreference: ["frontier-model-not-enabled-here"],
        modelPreferenceTier: "hard",
      },
    });

    // Fails honest, not silent: policy order stands, and the receipt records
    // that the requested difficulty was not available.
    expect(capturedRequests.at(-1)?.model).toBe("vendor/cheap-flash");
    expect(response.routing).toMatchObject({
      effectiveRoute: "pref-gateway/vendor/cheap-flash",
      modelPreferenceSatisfied: false,
    });
    expect(response.routing?.modelPreferenceReason).toMatch(/cheap-flash/);

    const telemetry = dbPackage
      .getDb()
      .select()
      .from(dbPackage.llmCallTelemetry)
      .all()
      .filter((row) => row.purpose === purpose);
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toMatchObject({
      requestedTier: "hard",
      preferenceSatisfied: false,
      servedModel: "vendor/cheap-flash",
    });
    expect(telemetry[0]?.preferenceReason).toBeTruthy();
  });

  it("cannot widen the workspace policy: an unlisted model stays unreachable", async () => {
    configurePreferenceProfile();
    installGatewayFetchMock();

    await llmService.getLLMGateway().chat({
      tenantId: systemTenantId,
      purpose: `test.preference-boundary.${randomUUID()}`,
      messages: [{ role: "user", content: "design the agent" }],
      routing: {
        taskType: "agent.author",
        modelPreference: ["vendor/some-other-frontier-model"],
        modelPreferenceTier: "review",
      },
    });

    const served = capturedRequests.map((request) => request.model);
    expect(served).not.toContain("vendor/some-other-frontier-model");
    expect(served.at(-1)).toBe("vendor/cheap-flash");
  });

  function settingsDocument(args: {
    defaultRoute: string;
    gateways: Array<Record<string, unknown>>;
    taskProfiles?: Array<Record<string, unknown>>;
  }): Record<string, unknown> {
    return {
      schemaVersion: 1,
      revision: 0,
      gatewayInstances: args.gateways,
      defaultProfile: {
        candidates: [{ route: args.defaultRoute }],
      },
      taskProfiles: args.taskProfiles ?? [],
    };
  }

  async function resolveThroughApi(taskClass: string) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/llm/routing/resolve",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": "__system",
      },
      payload: { taskClass },
    });
    expect(response.statusCode, response.body).toBe(200);
    const envelope = response.json<RoutingEnvelope>();
    expect(envelope.ok).toBe(true);
    return envelope.data;
  }

  function configureNewApiAliases(): void {
    settingsStore.getLlmSettings("__system");
    const saved = settingsStore.saveLlmSettings(
      "__system",
      settingsDocument({
        defaultRoute: NEWAPI_CASES[0].route,
        gateways: NEWAPI_CASES.map((testCase) => ({
          id: testCase.id,
          displayName: testCase.id,
          kind: "newapi",
          baseUrl: testCase.baseUrl,
          credentialRef: testCase.credentialRef,
          credentialScope: testCase.credentialScope,
          dialect: "openai-chat",
        })),
      }),
      0,
    );
    for (const testCase of NEWAPI_CASES) {
      const instance = saved.settings.gatewayInstances.find(
        (candidate) => candidate.id === testCase.id,
      );
      if (!instance) throw new Error(`missing test gateway ${testCase.id}`);
      providerKeys.setGatewayCredential(
        providerKeys.gatewayCredentialSlot(instance, systemTenantId),
        {
          apiKey: testCase.apiKey,
          scope: testCase.credentialScope,
          tenantId:
            testCase.credentialScope === "tenant" ? systemTenantId : undefined,
          setBy: "test",
        },
      );
    }
    const firstInstance = saved.settings.gatewayInstances.find(
      (candidate) => candidate.id === NEWAPI_CASES[0].id,
    );
    if (!firstInstance) throw new Error("missing primary NewAPI gateway");
    providerKeys.setGatewayCredential(
      providerKeys.gatewayCredentialSlot(firstInstance, systemTenantId),
      {
        apiKey: "sk-decoy-tenant-key-must-not-win-7777777",
        scope: "tenant",
        tenantId: systemTenantId,
        setBy: "test",
      },
    );
    llmService.resetLLMGateway();
  }

  function installGatewayFetchMock(): void {
    globalThis.fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        const body = (await request.json()) as { model?: unknown };
        const model = typeof body.model === "string" ? body.model : null;
        capturedRequests.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          model,
        });
        return new Response(
          JSON.stringify({
            id: `newapi-request-${capturedRequests.length}`,
            object: "chat.completion",
            created: 1_790_000_000,
            model: model ?? "unknown",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: `ok:${model}` },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 2,
              total_tokens: 5,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    ) as typeof fetch;
  }

  function completionResponse(model: string): Response {
    return new Response(
      JSON.stringify({
        id: `newapi-request-${randomUUID()}`,
        object: "chat.completion",
        created: 1_790_000_000,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `ok:${model}` },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }

  async function callRoute(route: string, maxTokens?: number) {
    return llmService.getLLMGateway().chat({
      tenantId: systemTenantId,
      purpose: `test.newapi-routing.${randomUUID()}`,
      messages: [{ role: "user", content: "route this request" }],
      maxTokens,
      routing: {
        taskType: "default",
        requestedRoute: route,
      },
    });
  }
});
