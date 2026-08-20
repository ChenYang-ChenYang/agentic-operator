import type {
  DeclarativeExchangeExample,
  DeclarativeRequestSpec,
  DeclarativeResponseAssertion,
  DeclarativeResponseSpec,
} from "./ports";

type ParsedContract = {
  requestSpec?: DeclarativeRequestSpec;
  responseSpec?: DeclarativeResponseSpec;
  examples?: DeclarativeExchangeExample[];
};

export type DeclarativeContractParseResult =
  | ({ ok: true } & ParsedContract)
  | { ok: false; error: string };

export interface DeclarativeExampleValidationResult {
  ok: boolean;
  errors: string[];
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_EXAMPLES = 20;
const MAX_EXAMPLE_BYTES = 256 * 1024;
const SENSITIVE_KEY = /(?:api[_-]?key|access[_-]?token|token|authorization|secret|password|cookie|credential)/i;
const DOTTED_PATH = /^(?:\$|\$?\.?[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function readPath(value: unknown, rawPath: string): unknown {
  const path = rawPath.trim().replace(/^\$\.?/, "");
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(key)) return current[Number(key)];
    return typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
  }, value);
}

function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function assertionPass(value: unknown, assertion: DeclarativeResponseAssertion): boolean {
  const values = assertion.values ?? (Array.isArray(assertion.value) ? assertion.value : []);
  switch (assertion.op) {
    case "exists": return value !== undefined;
    case "non_empty": return nonEmpty(value);
    case "eq": return equalValue(value, assertion.value);
    case "neq": return !equalValue(value, assertion.value);
    case "in": return values.some((candidate) => equalValue(value, candidate));
    case "not_in": return !values.some((candidate) => equalValue(value, candidate));
  }
}

/**
 * Deterministically reconcile a proposed executable HTTP contract with the
 * captured/documented exchanges used to teach it.  This is deliberately kept
 * in the factory package (instead of trusting an LLM's prose confidence): a
 * response mapping/assertion that contradicts an example cannot be persisted
 * as a green draft and later surprise the live probe.
 */
export function validateDeclarativeExamplesAgainstContract(input: ParsedContract): DeclarativeExampleValidationResult {
  const errors: string[] = [];
  for (const [index, example] of (input.examples ?? []).entries()) {
    const label = `examples[${index}]`;
    const request = example.request;
    if (input.requestSpec?.encoding === "json" && input.requestSpec.bodyPath) {
      if (readPath(request, input.requestSpec.bodyPath) === undefined) {
        errors.push(`${label}.request 缺少 request_spec.body_path ${input.requestSpec.bodyPath}`);
      }
    }
    if (input.requestSpec?.encoding === "multipart") {
      for (const file of input.requestSpec.files ?? []) {
        if (file.required !== false && readPath(request, file.base64Path) === undefined) {
          errors.push(`${label}.request 缺少 multipart file path ${file.base64Path}`);
        }
      }
    }

    const response = example.response;
    for (const assertion of input.responseSpec?.assertions ?? []) {
      if (!assertionPass(readPath(response, assertion.path), assertion)) {
        errors.push(`${label}.response 不满足 assertion ${assertion.code} (${assertion.path} ${assertion.op})`);
      }
    }
    if (input.responseSpec?.unwrapPath && readPath(response, input.responseSpec.unwrapPath) === undefined) {
      errors.push(`${label}.response 缺少 unwrap_path ${input.responseSpec.unwrapPath}`);
    }
    for (const [field, path] of Object.entries(input.responseSpec?.mappings ?? {})) {
      if (readPath(response, path) === undefined) errors.push(`${label}.response mapping ${field} 缺少路径 ${path}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function unknownKey(row: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  const set = new Set(allowed);
  return Object.keys(row).find((key) => !set.has(key));
}

function nonEmptyString(value: unknown, label: string, max = 500): string | { error: string } {
  if (typeof value !== "string" || !value.trim()) return { error: `${label} 必须是非空字符串` };
  const normalized = value.trim();
  if (normalized.length > max) return { error: `${label} 不能超过 ${max} 字符` };
  return normalized;
}

function parsePath(value: unknown, label: string): string | { error: string } {
  const parsed = nonEmptyString(value, label, 300);
  if (typeof parsed !== "string") return parsed;
  if (!DOTTED_PATH.test(parsed)) return { error: `${label} 必须是运行时支持的点分路径（如 data.items.0.id 或 $）` };
  return parsed;
}

function parseStringMap(value: unknown, label: string, valuesArePaths: boolean): Record<string, string> | { error: string } {
  if (!isRecord(value)) return { error: `${label} 必须是字符串映射对象` };
  const entries = Object.entries(value);
  if (!entries.length) return { error: `${label} 不能为空对象` };
  if (entries.length > 100) return { error: `${label} 最多 100 项` };
  const result: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!key.trim() || key.length > 120) return { error: `${label} 包含无效字段名` };
    const parsed = valuesArePaths ? parsePath(raw, `${label}.${key}`) : nonEmptyString(raw, `${label}.${key}`, 4_000);
    if (typeof parsed !== "string") return parsed;
    result[key] = parsed;
  }
  return result;
}

function secretLikeValueIsSafe(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text === "[REDACTED]" || /^(?:Bearer\s+)?\{[\w.]+\}$/i.test(text) || /^<[^>]+>$/.test(text) || /^(?:example|dummy|placeholder)(?:[-_].*)?$/i.test(text);
}

function findLiteralSecret(value: unknown, path = "examples", depth = 0): string | undefined {
  if (depth > 10) return `${path} 嵌套过深`;
  if (typeof value === "string" && /\bBearer\s+(?!\{)[^\s,"'}]+/i.test(value)) return `${path} 含 Bearer 字面凭证`;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findLiteralSecret(value[index], `${path}[${index}]`, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) && !secretLikeValueIsSafe(item)) return `${path}.${key} 含字面凭证`;
    const found = findLiteralSecret(item, `${path}.${key}`, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function parseRequestSpec(value: unknown): DeclarativeContractParseResult {
  if (value === undefined) return { ok: true };
  if (!isRecord(value)) return { ok: false, error: "request_spec 必须是对象" };
  const extra = unknownKey(value, ["encoding", "body_path", "fields", "files", "max_bytes"]);
  if (extra) return { ok: false, error: `request_spec.${extra} 不是允许字段` };
  if (value.encoding !== "json" && value.encoding !== "multipart") {
    return { ok: false, error: "request_spec.encoding 只能是 json 或 multipart" };
  }
  if (value.encoding === "json") {
    if (value.fields !== undefined || value.files !== undefined || value.max_bytes !== undefined) {
      return { ok: false, error: "json request_spec 只能声明 body_path，不能声明 multipart fields/files/max_bytes" };
    }
    const bodyPath = value.body_path === undefined ? undefined : parsePath(value.body_path, "request_spec.body_path");
    if (bodyPath !== undefined && typeof bodyPath !== "string") return { ok: false, error: bodyPath.error };
    return { ok: true, requestSpec: { encoding: "json", ...(bodyPath ? { bodyPath } : {}) } };
  }

  if (value.body_path !== undefined) return { ok: false, error: "multipart request_spec 不能声明 body_path" };
  let fields: Record<string, string> | undefined;
  if (value.fields !== undefined) {
    const parsed = parseStringMap(value.fields, "request_spec.fields", false);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    fields = parsed;
  }
  let files: NonNullable<DeclarativeRequestSpec["files"]> | undefined;
  if (value.files !== undefined) {
    if (!Array.isArray(value.files) || !value.files.length) return { ok: false, error: "request_spec.files 必须是非空数组" };
    if (value.files.length > 20) return { ok: false, error: "request_spec.files 最多 20 项" };
    files = [];
    for (let index = 0; index < value.files.length; index++) {
      const raw = value.files[index];
      if (!isRecord(raw)) return { ok: false, error: `request_spec.files[${index}] 必须是对象` };
      const fileExtra = unknownKey(raw, ["field", "base64_path", "filename", "filename_path", "mime", "mime_path", "required"]);
      if (fileExtra) return { ok: false, error: `request_spec.files[${index}].${fileExtra} 不是允许字段` };
      const field = nonEmptyString(raw.field, `request_spec.files[${index}].field`, 120);
      if (typeof field !== "string") return { ok: false, error: field.error };
      const base64Path = parsePath(raw.base64_path, `request_spec.files[${index}].base64_path`);
      if (typeof base64Path !== "string") return { ok: false, error: base64Path.error };
      const filename = raw.filename === undefined ? undefined : nonEmptyString(raw.filename, `request_spec.files[${index}].filename`, 255);
      if (filename !== undefined && typeof filename !== "string") return { ok: false, error: filename.error };
      if (typeof filename === "string" && /[\\/]/.test(filename)) return { ok: false, error: `request_spec.files[${index}].filename 只能是文件名，不能含路径` };
      const filenamePath = raw.filename_path === undefined ? undefined : parsePath(raw.filename_path, `request_spec.files[${index}].filename_path`);
      if (filenamePath !== undefined && typeof filenamePath !== "string") return { ok: false, error: filenamePath.error };
      const mime = raw.mime === undefined ? undefined : nonEmptyString(raw.mime, `request_spec.files[${index}].mime`, 120);
      if (mime !== undefined && typeof mime !== "string") return { ok: false, error: mime.error };
      if (typeof mime === "string" && !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(mime)) return { ok: false, error: `request_spec.files[${index}].mime 不是合法 MIME type` };
      const mimePath = raw.mime_path === undefined ? undefined : parsePath(raw.mime_path, `request_spec.files[${index}].mime_path`);
      if (mimePath !== undefined && typeof mimePath !== "string") return { ok: false, error: mimePath.error };
      if (raw.required !== undefined && typeof raw.required !== "boolean") return { ok: false, error: `request_spec.files[${index}].required 必须是 boolean` };
      files.push({ field, base64Path, ...(filename ? { filename } : {}), ...(filenamePath ? { filenamePath } : {}), ...(mime ? { mime } : {}), ...(mimePath ? { mimePath } : {}), ...(raw.required !== undefined ? { required: raw.required } : {}) });
    }
  }
  if (!fields && !files) return { ok: false, error: "multipart request_spec 至少需要 fields 或 files" };
  let maxBytes: number | undefined;
  if (value.max_bytes !== undefined) {
    if (!Number.isInteger(value.max_bytes) || (value.max_bytes as number) < 1 || (value.max_bytes as number) > MAX_UPLOAD_BYTES) {
      return { ok: false, error: `request_spec.max_bytes 必须是 1..${MAX_UPLOAD_BYTES} 的整数` };
    }
    maxBytes = value.max_bytes as number;
  }
  return { ok: true, requestSpec: { encoding: "multipart", ...(fields ? { fields } : {}), ...(files ? { files } : {}), ...(maxBytes ? { maxBytes } : {}) } };
}

function parseResponseSpec(value: unknown): DeclarativeContractParseResult {
  if (value === undefined) return { ok: true };
  if (!isRecord(value)) return { ok: false, error: "response_spec 必须是对象" };
  const extra = unknownKey(value, ["unwrap_path", "mappings", "assertions"]);
  if (extra) return { ok: false, error: `response_spec.${extra} 不是允许字段` };
  if (value.unwrap_path !== undefined && value.mappings !== undefined) return { ok: false, error: "response_spec.unwrap_path 与 mappings 互斥" };
  const unwrapPath = value.unwrap_path === undefined ? undefined : parsePath(value.unwrap_path, "response_spec.unwrap_path");
  if (unwrapPath !== undefined && typeof unwrapPath !== "string") return { ok: false, error: unwrapPath.error };
  let mappings: Record<string, string> | undefined;
  if (value.mappings !== undefined) {
    const parsed = parseStringMap(value.mappings, "response_spec.mappings", true);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    mappings = parsed;
  }
  let assertions: DeclarativeResponseAssertion[] | undefined;
  if (value.assertions !== undefined) {
    if (!Array.isArray(value.assertions) || !value.assertions.length) return { ok: false, error: "response_spec.assertions 必须是非空数组" };
    if (value.assertions.length > 50) return { ok: false, error: "response_spec.assertions 最多 50 项" };
    assertions = [];
    const codes = new Set<string>();
    for (let index = 0; index < value.assertions.length; index++) {
      const raw = value.assertions[index];
      if (!isRecord(raw)) return { ok: false, error: `response_spec.assertions[${index}] 必须是对象` };
      const assertionExtra = unknownKey(raw, ["path", "op", "value", "values", "failure", "code", "message"]);
      if (assertionExtra) return { ok: false, error: `response_spec.assertions[${index}].${assertionExtra} 不是允许字段` };
      const path = parsePath(raw.path, `response_spec.assertions[${index}].path`);
      if (typeof path !== "string") return { ok: false, error: path.error };
      if (!new Set(["exists", "non_empty", "eq", "neq", "in", "not_in"]).has(String(raw.op))) return { ok: false, error: `response_spec.assertions[${index}].op 无效` };
      const op = raw.op as DeclarativeResponseAssertion["op"];
      if (raw.failure !== "retryable" && raw.failure !== "terminal") return { ok: false, error: `response_spec.assertions[${index}].failure 只能是 retryable 或 terminal` };
      const code = nonEmptyString(raw.code, `response_spec.assertions[${index}].code`, 64);
      if (typeof code !== "string") return { ok: false, error: code.error };
      if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(code)) return { ok: false, error: `response_spec.assertions[${index}].code 格式无效` };
      if (codes.has(code)) return { ok: false, error: `response_spec.assertions code ${code} 重复` };
      codes.add(code);
      const hasValue = Object.prototype.hasOwnProperty.call(raw, "value");
      const hasValues = Object.prototype.hasOwnProperty.call(raw, "values");
      if ((op === "exists" || op === "non_empty") && (hasValue || hasValues)) return { ok: false, error: `${op} assertion 不能声明 value/values` };
      if ((op === "eq" || op === "neq") && (!hasValue || hasValues)) return { ok: false, error: `${op} assertion 必须且只能声明 value` };
      if ((op === "in" || op === "not_in") && (!Array.isArray(raw.values) || !raw.values.length || hasValue)) return { ok: false, error: `${op} assertion 必须且只能声明非空 values` };
      const message = raw.message === undefined ? undefined : nonEmptyString(raw.message, `response_spec.assertions[${index}].message`, 500);
      if (message !== undefined && typeof message !== "string") return { ok: false, error: message.error };
      assertions.push({ path, op, ...(hasValue ? { value: raw.value } : {}), ...(hasValues ? { values: raw.values as unknown[] } : {}), failure: raw.failure, code, ...(message ? { message } : {}) });
    }
  }
  if (!unwrapPath && !mappings && !assertions) return { ok: false, error: "response_spec 至少需要 unwrap_path、mappings 或 assertions" };
  return { ok: true, responseSpec: { ...(unwrapPath ? { unwrapPath } : {}), ...(mappings ? { mappings } : {}), ...(assertions ? { assertions } : {}) } };
}

function parseExamples(value: unknown): DeclarativeContractParseResult {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value) || !value.length) return { ok: false, error: "examples 必须是非空数组" };
  if (value.length > MAX_EXAMPLES) return { ok: false, error: `examples 最多 ${MAX_EXAMPLES} 项` };
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false, error: "examples 必须可 JSON 序列化" };
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_EXAMPLE_BYTES) return { ok: false, error: `examples 总大小不能超过 ${MAX_EXAMPLE_BYTES} bytes` };
  const secret = findLiteralSecret(value);
  if (secret) return { ok: false, error: `${secret}；请改用占位符或 [REDACTED]` };
  const examples: DeclarativeExchangeExample[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    if (!isRecord(raw)) return { ok: false, error: `examples[${index}] 必须是对象` };
    const extra = unknownKey(raw, ["request", "response", "note", "source"]);
    if (extra) return { ok: false, error: `examples[${index}].${extra} 不是允许字段` };
    if (!isRecord(raw.request)) return { ok: false, error: `examples[${index}].request 必须是对象` };
    if (!Object.prototype.hasOwnProperty.call(raw, "response")) return { ok: false, error: `examples[${index}].response 必填` };
    const note = raw.note === undefined ? undefined : nonEmptyString(raw.note, `examples[${index}].note`, 1_000);
    if (note !== undefined && typeof note !== "string") return { ok: false, error: note.error };
    if (raw.source !== undefined && !new Set(["human", "probe", "documentation"]).has(String(raw.source))) return { ok: false, error: `examples[${index}].source 无效` };
    examples.push({ request: raw.request, response: raw.response, ...(note ? { note } : {}), ...(raw.source ? { source: raw.source as DeclarativeExchangeExample["source"] } : {}) });
  }
  return { ok: true, examples };
}

/** Parse the model-facing snake_case create_tool contract into the persisted
 * camelCase runtime manifest. This is deliberately stricter than JSON Schema:
 * it rejects ambiguous combinations that would otherwise be silently ignored. */
export function parseDeclarativeHttpContract(input: {
  method: string;
  bodyTemplate?: string;
  requestSpec?: unknown;
  responseSpec?: unknown;
  examples?: unknown;
}): DeclarativeContractParseResult {
  const request = parseRequestSpec(input.requestSpec);
  if (!request.ok) return request;
  const response = parseResponseSpec(input.responseSpec);
  if (!response.ok) return response;
  const examples = parseExamples(input.examples);
  if (!examples.ok) return examples;
  if (input.bodyTemplate !== undefined && request.requestSpec !== undefined) return { ok: false, error: "body_template 与 request_spec 互斥；请只保留一个可执行请求定义" };
  if ((input.method === "GET" || input.method === "HEAD") && (input.bodyTemplate !== undefined || request.requestSpec !== undefined)) {
    return { ok: false, error: `${input.method} 工具不能声明请求 body` };
  }
  return {
    ok: true,
    ...(request.requestSpec ? { requestSpec: request.requestSpec } : {}),
    ...(response.responseSpec ? { responseSpec: response.responseSpec } : {}),
    ...(examples.examples ? { examples: examples.examples } : {}),
  };
}

const MULTIPART_FILE_SCHEMA = {
  type: "object",
  properties: {
    field: { type: "string" },
    base64_path: { type: "string", description: "args/config/lastResult 中 canonical base64 的点分路径" },
    filename: { type: "string" },
    filename_path: { type: "string" },
    mime: { type: "string" },
    mime_path: { type: "string" },
    required: { type: "boolean" },
  },
  required: ["field", "base64_path"],
  additionalProperties: false,
};

export const DECLARATIVE_REQUEST_SPEC_SCHEMA: Record<string, unknown> = {
  type: "object",
  description: "可执行请求编码。json 使用 body_path（省略则发送 args）；multipart 使用 fields/files。与 body_template 互斥。",
  properties: {
    encoding: { type: "string", enum: ["json", "multipart"] },
    body_path: { type: "string" },
    fields: { type: "object", additionalProperties: { type: "string" } },
    files: { type: "array", minItems: 1, maxItems: 20, items: MULTIPART_FILE_SCHEMA },
    max_bytes: { type: "integer", minimum: 1, maximum: MAX_UPLOAD_BYTES },
  },
  required: ["encoding"],
  additionalProperties: false,
};

export const DECLARATIVE_RESPONSE_SPEC_SCHEMA: Record<string, unknown> = {
  type: "object",
  description: "先 assertions 校验原始响应，再用 unwrap_path 或 mappings（互斥）归一化。",
  properties: {
    unwrap_path: { type: "string" },
    mappings: { type: "object", additionalProperties: { type: "string" } },
    assertions: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          op: { type: "string", enum: ["exists", "non_empty", "eq", "neq", "in", "not_in"] },
          value: {},
          // `items` is REQUIRED by strict provider validators (Google AI Studio
          // rejects the whole tool list with 400 INVALID_ARGUMENT on a bare
          // `type:"array"`). The element type is deliberately unconstrained —
          // an `in`/`not_in` assertion compares against whatever the response
          // field holds — so the loosest legal item schema is the honest one.
          values: { type: "array", items: {} },
          failure: { type: "string", enum: ["retryable", "terminal"] },
          code: { type: "string" },
          message: { type: "string" },
        },
        required: ["path", "op", "failure", "code"],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

export const DECLARATIVE_EXAMPLES_SCHEMA: Record<string, unknown> = {
  type: "array",
  minItems: 1,
  maxItems: MAX_EXAMPLES,
  description: "用于 grounding/hash 的脱敏请求响应样例；凭证只能写占位符或 [REDACTED]。",
  items: {
    type: "object",
    properties: {
      request: { type: "object", additionalProperties: true },
      response: {},
      note: { type: "string" },
      source: { type: "string", enum: ["human", "probe", "documentation"] },
    },
    required: ["request", "response"],
    additionalProperties: false,
  },
};
