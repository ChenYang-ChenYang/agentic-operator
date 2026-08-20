import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  mutationOptions: [] as unknown[],
  client: {
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: vi.fn((options: unknown) => {
    queryMocks.mutationOptions.push(options);
    return options;
  }),
  useQuery: vi.fn(),
  useQueryClient: vi.fn(() => queryMocks.client),
}));

import {
  AGENT_FACTORY_DOMAIN_KEYS,
  useBindAgentFactoryDomain,
} from "./useAgentFactoryDomains";

interface CapturedMutation<TInput, TReceipt> {
  mutationFn(input: TInput): Promise<TReceipt>;
  onSuccess(receipt: TReceipt): Promise<unknown>;
}

function capturedMutation<TInput, TReceipt>(): CapturedMutation<
  TInput,
  TReceipt
> {
  const options = queryMocks.mutationOptions.at(-1);
  if (!options) throw new Error("The hook did not register a mutation");
  return options as CapturedMutation<TInput, TReceipt>;
}

function apiResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("agent factory domain query keys", () => {
  beforeEach(() => {
    queryMocks.mutationOptions.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("isolates persisted bindings in the React Query cache by runtime tenant", () => {
    expect(AGENT_FACTORY_DOMAIN_KEYS.tenant("tenant-a")).not.toEqual(
      AGENT_FACTORY_DOMAIN_KEYS.tenant("tenant-b"),
    );
    expect(AGENT_FACTORY_DOMAIN_KEYS.tenant("tenant-a").slice(0, 1)).toEqual(
      AGENT_FACTORY_DOMAIN_KEYS.all,
    );
  });

  it("binds an exact Allmeta identity and invalidates only that tenant snapshot", async () => {
    const receipt = {
      binding: {
        tenantId: "ten-zhaopin",
        ontologyDomainId: "RAAS-v1",
        ontologyDomainName: "RAAS-v1",
        source: "explicit",
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
      },
      boundDomain: {
        id: "RAAS-v1",
        name: "RAAS-v1",
        source: "allmeta",
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(apiResponse(receipt));
    vi.stubGlobal("fetch", fetchMock);

    useBindAgentFactoryDomain("zhaopin");
    const mutation = capturedMutation<
      {
        ontologyDomainId: string;
        source: "allmeta";
        confirmRebind: boolean;
      },
      typeof receipt
    >();

    await expect(
      mutation.mutationFn({
        ontologyDomainId: "RAAS-v1",
        source: "allmeta",
        confirmRebind: true,
      }),
    ).resolves.toEqual(receipt);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/v1/agent-factory/domain-binding");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      ontologyDomainId: "RAAS-v1",
      source: "allmeta",
      confirmRebind: true,
    });

    await mutation.onSuccess(receipt);
    expect(queryMocks.client.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(queryMocks.client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: AGENT_FACTORY_DOMAIN_KEYS.tenant("zhaopin"),
      exact: true,
    });
  });
});
