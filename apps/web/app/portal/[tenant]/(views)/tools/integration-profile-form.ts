export const INTEGRATION_PROFILE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SAFE_AUTH_MODE =
  /^(?:anonymous|none|sigv4|oauth2?|basic|bearer|service_account)$/i;
const SECRET_KEY =
  /^(?:api_key|access_key|private_key|secret_key|client_key|key|access_token|refresh_token|token|authorization|authorization_header|auth|auth_header|bearer|bearer_token|password|passwd|secret|cookie|credential|credentials|session|session_id)$/i;
const SECRET_KEY_PART =
  /(?:^|_)(?:api_key|access_key|private_key|secret_key|client_key|access_token|refresh_token|authorization|auth|password|passwd|secret|cookie|credential|credentials|session_id|token)(?:$|_)/i;
const SECRET_VALUE_PATTERNS = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]{4,}\b/i,
  /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:sk|rk|pk|api)[-_][A-Za-z0-9_-]{8,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/:@]+:[^\s/@]+@/i,
] as const;

type JsonRecord = Record<string, unknown>;

export type IntegrationProfileDraftResult =
  | { ok: true; profileKey: string; config: JsonRecord }
  | { ok: false; errors: string[] };

export function integrationProfileTruth(validation?: { ready: boolean }): {
  saved: "已保存";
  environment: "环境引用就绪 · 非探针" | "环境引用未就绪" | "待读取环境校验";
  probe: "探针未验证";
} {
  return {
    saved: "已保存",
    environment:
      validation?.ready === true
        ? "环境引用就绪 · 非探针"
        : validation
          ? "环境引用未就绪"
          : "待读取环境校验",
    probe: "探针未验证",
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function isEnvReferenceField(key: string): boolean {
  return canonicalKey(key).endsWith("_env");
}

function isSensitiveKey(key: string): boolean {
  const canonical = canonicalKey(key);
  return SECRET_KEY.test(canonical) || SECRET_KEY_PART.test(canonical);
}

function secretShaped(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

/**
 * Browser-side guardrail only. The API remains authoritative and repeats the
 * full schema/security validation before writing a profile.
 */
export function integrationProfileSecretIssues(config: JsonRecord): string[] {
  const issues: string[] = [];

  const visit = (value: unknown, path: string, key: string): void => {
    if (typeof value === "string") {
      const text = value.trim();
      if (isEnvReferenceField(key)) {
        if (!ENV_NAME.test(text)) {
          issues.push(`${path} 必须是环境变量名，不能填写 secret 值`);
        }
        return;
      }
      if (
        isSensitiveKey(key) &&
        !(canonicalKey(key) === "auth" && SAFE_AUTH_MODE.test(text))
      ) {
        issues.push(
          `${path} 禁止保存凭证；请在服务端将 env/Vault 绑定映射为 *_env 引用`,
        );
        return;
      }
      if (secretShaped(text)) {
        issues.push(`${path} 看起来包含明文凭证，不能保存到 profile`);
      }
      return;
    }

    if (
      value !== undefined &&
      value !== null &&
      isSensitiveKey(key) &&
      !isEnvReferenceField(key)
    ) {
      issues.push(`${path} 禁止保存明文凭证；请改用引用字段`);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`, ""));
      return;
    }
    if (!isRecord(value)) return;
    for (const [childKey, childValue] of Object.entries(value)) {
      visit(childValue, `${path}.${childKey}`, childKey);
    }
  };

  for (const [key, value] of Object.entries(config)) {
    visit(value, `config.${key}`, key);
  }
  return [...new Set(issues)];
}

export function parseIntegrationProfileDraft(
  profileKeyInput: string,
  configText: string,
): IntegrationProfileDraftResult {
  const profileKey = profileKeyInput.trim();
  const errors: string[] = [];
  if (!INTEGRATION_PROFILE_KEY.test(profileKey)) {
    errors.push(
      "Profile key 只能包含字母、数字、点、下划线和短横线，最长 64 个字符",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    errors.push("配置不是合法 JSON");
    return { ok: false, errors };
  }
  if (!isRecord(parsed)) {
    errors.push("配置根节点必须是 JSON object");
    return { ok: false, errors };
  }
  errors.push(...integrationProfileSecretIssues(parsed));
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, profileKey, config: parsed };
}

export function formatIntegrationProfileConfig(
  config: Record<string, unknown> | undefined,
): string {
  return JSON.stringify(config ?? {}, null, 2);
}
