import type {
  SaveToolBody,
  ToolCapabilityDescriptor,
  ToolEffectScope,
  ToolOperation,
  ToolSandboxPolicy,
  ToolSideEffect,
} from "@/lib/hooks/useTools";

export interface ToolDraftFormValues {
  name: string;
  description: string;
  method: string;
  urlTemplate: string;
  headers: string;
  bodyTemplate: string;
  requestSpec?: string;
  responseSpec?: string;
  examples?: string;
  sideEffect: string;
  operation: string;
  effectScope: string;
  sandboxPolicy: string;
  paramsSchema: string;
  returnsSchema: string;
  capabilities: string;
}

export type ToolDraftPayloadResult =
  | { ok: true; payload: SaveToolBody }
  | { ok: false; message: string };

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} 不是合法 JSON`);
  }
}

function nonEmptyRecord(
  text: string,
  label: string,
): Record<string, unknown> {
  const value = parseJson(text, label);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    throw new Error(`${label} 必须是非空 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function optionalStringRecord(
  text: string,
  label: string,
): Record<string, string> | undefined {
  if (!text.trim()) return undefined;
  const value = nonEmptyRecord(text, label);
  const invalid = Object.entries(value).find(
    ([key, item]) => !key.trim() || typeof item !== "string",
  );
  if (invalid) {
    throw new Error(`${label}.${invalid[0] || "(empty)"} 必须是字符串`);
  }
  return value as Record<string, string>;
}

function optionalRecord(
  text: string | undefined,
  label: string,
): Record<string, unknown> | undefined {
  if (!text?.trim()) return undefined;
  return nonEmptyRecord(text, label);
}

function optionalExamples(
  text: string | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!text?.trim()) return undefined;
  const value = parseJson(text, "examples");
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry) =>
        !entry || typeof entry !== "object" || Array.isArray(entry),
    )
  ) {
    throw new Error("examples 必须是非空 JSON 对象数组");
  }
  return value as Array<Record<string, unknown>>;
}

function stringList(
  value: unknown,
  path: string,
  required: boolean,
): string[] {
  if (value === undefined && !required) return [];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(`${path} 必须是仅含非空字符串的数组`);
  }
  const normalized = [...new Set(value.map((item) => String(item).trim()))];
  if (required && normalized.length === 0) {
    throw new Error(`${path} 不能为空`);
  }
  return normalized;
}

function capabilityContract(text: string): ToolCapabilityDescriptor[] {
  if (!text.trim()) {
    throw new Error("capabilities 不能为空；请明确系统、kind、role 与 operation");
  }
  const value = parseJson(text, "capabilities");
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("capabilities 必须是非空 JSON 数组");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`capabilities[${index}] 必须是对象`);
    }
    const row = item as Record<string, unknown>;
    const allowed = new Set([
      "systems",
      "kinds",
      "roles",
      "operations",
      "objectTypes",
      "probeRequired",
    ]);
    const extra = Object.keys(row).find((key) => !allowed.has(key));
    if (extra) {
      throw new Error(`capabilities[${index}].${extra} 不是允许字段`);
    }
    if (
      row.probeRequired !== undefined &&
      typeof row.probeRequired !== "boolean"
    ) {
      throw new Error(
        `capabilities[${index}].probeRequired 必须是 boolean`,
      );
    }
    const operations = stringList(
      row.operations,
      `capabilities[${index}].operations`,
      false,
    );
    const objectTypes = stringList(
      row.objectTypes,
      `capabilities[${index}].objectTypes`,
      false,
    );
    return {
      systems: stringList(
        row.systems,
        `capabilities[${index}].systems`,
        true,
      ),
      kinds: stringList(
        row.kinds,
        `capabilities[${index}].kinds`,
        true,
      ),
      roles: stringList(
        row.roles,
        `capabilities[${index}].roles`,
        true,
      ),
      ...(operations.length ? { operations } : {}),
      ...(objectTypes.length ? { objectTypes } : {}),
      ...(row.probeRequired !== undefined
        ? { probeRequired: row.probeRequired }
        : {}),
    };
  });
}

/** Build the exact governed POST /v1/tools body. Missing execution policy is
 * never inferred from the HTTP verb, tool name, or side-effect label. */
export function buildToolDraftPayload(
  input: ToolDraftFormValues,
): ToolDraftPayloadResult {
  try {
    const name = input.name.trim();
    if (
      !/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/.test(name)
    ) {
      throw new Error(
        "工具名必须带命名空间，例如 gohire.generateJobDescription",
      );
    }
    const description = input.description.trim();
    if (!description) throw new Error("描述不能为空");

    const method = input.method.trim().toUpperCase();
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw new Error("请明确选择 HTTP method");
    }

    const urlTemplate = input.urlTemplate.trim();
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlTemplate);
    } catch {
      throw new Error("URL 模板必须是绝对 http(s) URL");
    }
    if (
      !["http:", "https:"].includes(parsedUrl.protocol) ||
      parsedUrl.username ||
      parsedUrl.password
    ) {
      throw new Error("URL 模板必须是不含用户名/密码的绝对 http(s) URL");
    }

    if (!["read", "write", "dual"].includes(input.sideEffect)) {
      throw new Error("请明确选择 side_effect");
    }
    if (!["read", "compute", "write", "read_write"].includes(input.operation)) {
      throw new Error("请明确选择 operation；系统不会替你推断");
    }
    if (input.effectScope !== "external") {
      throw new Error("请明确确认 effect_scope=external");
    }
    if (
      !["live_external", "requires_attempt_grant"].includes(
        input.sandboxPolicy,
      )
    ) {
      throw new Error("请明确选择 sandbox_policy；系统不会替你推断");
    }
    const readPolicy =
      (input.operation === "read" || input.operation === "compute") &&
      input.sandboxPolicy === "live_external";
    const writePolicy =
      (input.operation === "write" || input.operation === "read_write") &&
      input.sandboxPolicy === "requires_attempt_grant";
    if (!readPolicy && !writePolicy) {
      throw new Error(
        "执行策略不一致：外部只读/计算只能用 live_external，外部写入只能用 requires_attempt_grant",
      );
    }
    if (
      (input.sideEffect === "read" && !readPolicy) ||
      (input.sideEffect !== "read" && !writePolicy)
    ) {
      throw new Error("side_effect 与 operation/sandbox_policy 不一致");
    }
    const requestSpec = optionalRecord(input.requestSpec, "request_spec");
    const responseSpec = optionalRecord(input.responseSpec, "response_spec");
    const examples = optionalExamples(input.examples);
    if (input.bodyTemplate.trim() && requestSpec) {
      throw new Error(
        "body_template 与 request_spec 互斥；请只保留一个请求编码定义",
      );
    }

    return {
      ok: true,
      payload: {
        name,
        description,
        method,
        url_template: urlTemplate,
        headers: optionalStringRecord(input.headers, "headers"),
        body_template: input.bodyTemplate.trim() || undefined,
        request_spec: requestSpec,
        response_spec: responseSpec,
        examples,
        side_effect: input.sideEffect as ToolSideEffect,
        operation: input.operation as ToolOperation,
        effect_scope: input.effectScope as ToolEffectScope,
        sandbox_policy: input.sandboxPolicy as ToolSandboxPolicy,
        params_schema: nonEmptyRecord(input.paramsSchema, "入参 schema"),
        returns_schema: nonEmptyRecord(input.returnsSchema, "返回 schema"),
        capabilities: capabilityContract(input.capabilities),
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
