import type { Translate } from "@/app/portal/lib/preferences-context";

export type FactoryApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; message: string; code?: string };

type JsonResponse = Pick<Response, "ok" | "status" | "statusText" | "json">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  return typeof body.error.message === "string" && body.error.message.trim()
    ? body.error.message
    : undefined;
}

function apiErrorCode(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  return typeof body.error.code === "string" && body.error.code.trim()
    ? body.error.code
    : undefined;
}

/**
 * Decode the factory API envelope without ever treating a JSON `{ ok: true }`
 * body as success when the HTTP request itself failed (or vice versa).
 */
export async function decodeFactoryResponse<T>(t: Translate, response: JsonResponse): Promise<FactoryApiResult<T>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if ([500, 502, 503, 504].includes(response.status)) {
      return {
        ok: false,
        status: response.status,
        code: "api_restarting",
        message: t("factory.api.serviceRestarting"),
      };
    }
    return {
      ok: false,
      status: response.status,
      message: t("factory.api.invalidJson", { status: response.status }),
    };
  }

  if (!response.ok) {
    const code = apiErrorCode(body);
    return {
      ok: false,
      status: response.status,
      message: apiErrorMessage(body) ?? (response.statusText || `HTTP ${response.status}`),
      ...(code ? { code } : {}),
    };
  }

  if (!isRecord(body) || body.ok !== true) {
    const code = apiErrorCode(body);
    return {
      ok: false,
      status: response.status,
      message: apiErrorMessage(body) ?? t("factory.api.noSuccessStatus"),
      ...(code ? { code } : {}),
    };
  }

  if (!("data" in body)) {
    return {
      ok: false,
      status: response.status,
      message: t("factory.api.missingData"),
    };
  }

  return { ok: true, status: response.status, data: body.data as T };
}

export function factoryNetworkFailure(t: Translate, error: unknown): FactoryApiResult<never> {
  return {
    ok: false,
    status: 0,
    message: error instanceof Error && error.message ? error.message : t("factory.api.networkFailure"),
  };
}

export type HumanInteractionKind = "clarify" | "test_approval" | "boundary";

/** Build the exact managed-revision CAS deactivation endpoint. A legacy
 * projection with no active revision is intentionally not representable. */
export function buildGeneratedToolDeactivationPath(input: {
  name: string;
  expectedActiveRevisionId: string;
  revisionDomainId: string | null;
}): string {
  const name = input.name.trim();
  const expectedActiveRevisionId = input.expectedActiveRevisionId.trim();
  const revisionDomainId =
    input.revisionDomainId?.trim() || "__unbound__";
  if (!name || !expectedActiveRevisionId) {
    throw new Error(
      "managed tool deactivation requires an exact tool name and active revision",
    );
  }
  const query = new URLSearchParams({
    expectedActiveRevisionId,
    revisionDomainId,
  });
  return `/v1/agent-factory/generated-tools/${encodeURIComponent(name)}?${query.toString()}`;
}

/** Keep the exact one-shot interaction coordinates in one tested transport
 * builder. Callers cannot accidentally fall back to the old text-only body. */
export function buildHumanInteractionSubmission(t: Translate, input: {
  conversation: string;
  interactionId: string;
  kind: HumanInteractionKind;
  text: string;
}): { conversation: string; interactionId: string; kind: HumanInteractionKind; text: string } {
  const conversation = input.conversation.trim();
  const interactionId = input.interactionId.trim();
  const text = input.text.trim();
  if (!conversation || !interactionId || !text) {
    throw new Error(t("factory.api.interactionIncomplete"));
  }
  return { conversation, interactionId, kind: input.kind, text };
}
