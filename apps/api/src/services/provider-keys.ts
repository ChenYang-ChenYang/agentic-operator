/**
 * Provider key vault — persists per-provider API keys outside of `.env`.
 *
 * Keys live at `data/provider-keys.json` (gitignored) encrypted with
 * AES-256-GCM. A master key is derived from `AGENTIC_KEY_VAULT_SECRET` (or
 * the already-required session secret). Only test processes have a fixed
 * fallback; real processes fail closed rather than deriving a predictable key.
 *
 * `getProviderKeyEnvOverlay()` returns a tenant-aware env-shaped map so
 * `services/llm.ts` can construct credential-isolated adapter sets while
 * `resolveConfig()` remains the single provider-env parser.
 */
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { tmpdir } from "node:os";
import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  PROVIDER_IDS,
  type GatewayInstance,
  type ProviderId,
} from "@agentic/contracts";
import { deriveVaultKey } from "./secret-vault";

function defaultVaultPath(): string {
  if (process.env.AGENTIC_KEY_VAULT_PATH)
    return process.env.AGENTIC_KEY_VAULT_PATH;
  if (process.env.NODE_ENV === "test") {
    return join(
      tmpdir(),
      "agentic-operator-tests",
      `provider-keys-${process.pid}.json`,
    );
  }
  // Co-locate with the SQLite db. `DATABASE_URL` is `file:<path>` per
  // packages/db/client.ts; strip the prefix and use the same directory so
  // logs/db/vault all live under one `data/` tree regardless of cwd.
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl && dbUrl.startsWith("file:")) {
    return join(dirname(dbUrl.slice(5)), "provider-keys.json");
  }
  return join(process.cwd(), "data", "provider-keys.json");
}

const ENV_VAR_BY_PROVIDER: Partial<Record<ProviderId, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  together: "TOGETHER_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  zai: "ZAI_API_KEY",
  qwen: "QWEN_API_KEY",
  azure: "AZURE_OPENAI_API_KEY",
  custom: "CUSTOM_LLM_API_KEY",
};

/** Environment slot consumed by the built-in adapter for a provider. */
export function providerApiKeyEnvName(id: ProviderId): string | undefined {
  return ENV_VAR_BY_PROVIDER[id];
}

/**
 * Resolve the private vault slot owned by one configured gateway instance.
 * Dynamic endpoint credentials are namespaced by authenticated tenant and
 * instance before lookup, so an arbitrary public `credentialRef` can never
 * alias a built-in provider key or another tenant's compatible gateway.
 */
export function gatewayCredentialSlot(
  instance: GatewayInstance,
  tenantId: string,
): string {
  if (instance.kind !== "newapi" && instance.kind !== "openai-compatible") {
    return instance.credentialRef ?? instance.id;
  }
  const binding = [
    tenantId,
    instance.id,
    instance.credentialRef ?? instance.id,
  ].join("\0");
  const digest = createHash("sha256")
    .update(binding)
    .digest("hex")
    .slice(0, 32);
  return `gateway:${instance.id}:${digest}`;
}

export type KeyScope = "workspace" | "tenant";

export interface ProviderKeyRecord {
  /** Stable, public-safe identity for usage attribution. Never derived from the key. */
  credentialId: string;
  /** Static provider id or a dynamic gateway-instance id (for example newapi-csi). */
  provider: string;
  scope: KeyScope;
  tenantId?: string;
  setBy: string | null;
  setAt: number;
  keyMasked: string;
  /** AES-256-GCM ciphertext. Stored as hex. */
  cipherHex: string;
  /** 12-byte IV. Stored as hex. */
  ivHex: string;
  /** 16-byte auth tag. Stored as hex. */
  tagHex: string;
}

interface VaultFile {
  /** 16-byte salt for scrypt KDF. Generated on first write. */
  saltHex: string;
  records: ProviderKeyRecord[];
}

type LegacyProviderKeyRecord = Omit<ProviderKeyRecord, "credentialId"> & {
  credentialId?: string;
};

interface LegacyVaultFile {
  saltHex: string;
  records: LegacyProviderKeyRecord[];
}

let cache: VaultFile | null = null;
let cachePath: string | null = null;
let masterKey: Buffer | null = null;

function isProviderId(s: string): s is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(s);
}

function deriveMasterKey(salt: Buffer): Buffer {
  // Fail-closed master secret resolution (AGENTIC_KEY_VAULT_SECRET → session
  // secret → test-only fallback). Shared with the versioned inline envelope
  // vault so the whole process derives every secret key the same way; no
  // hostname-derived predictable key outside the test process.
  return deriveVaultKey(salt);
}

function newCredentialId(): string {
  return `cred-${randomUUID()}`;
}

/**
 * Old vaults predate credential IDs. Deriving the migration ID from public
 * slot metadata (plus the vault salt) makes it stable even when the vault is
 * temporarily read-only; the API key is deliberately not part of the hash.
 */
function legacyCredentialId(
  record: LegacyProviderKeyRecord,
  saltHex: string,
): string {
  const slot = [
    saltHex,
    record.provider,
    record.scope,
    record.scope === "tenant" ? (record.tenantId ?? "") : "",
  ].join("\0");
  return `cred-legacy-${createHash("sha256").update(slot).digest("hex").slice(0, 24)}`;
}

function normalizeVault(parsed: LegacyVaultFile): {
  vault: VaultFile;
  migrated: boolean;
} {
  let migrated = false;
  const records = parsed.records.map((record): ProviderKeyRecord => {
    if (
      typeof record.credentialId === "string" &&
      record.credentialId.length > 0
    ) {
      return record as ProviderKeyRecord;
    }
    migrated = true;
    return {
      ...record,
      credentialId: legacyCredentialId(record, parsed.saltHex),
    };
  });
  return {
    vault: { saltHex: parsed.saltHex, records },
    migrated,
  };
}

function loadVault(): VaultFile {
  const vaultPath = defaultVaultPath();
  if (cache && cachePath === vaultPath) return cache;
  if (cachePath !== vaultPath) {
    cache = null;
    cachePath = vaultPath;
    masterKey = null;
  }
  if (!existsSync(vaultPath)) {
    const v: VaultFile = {
      saltHex: randomBytes(16).toString("hex"),
      records: [],
    };
    cache = v;
    return v;
  }
  try {
    const vaultStat = lstatSync(vaultPath);
    if (vaultStat.isSymbolicLink() || !vaultStat.isFile()) {
      throw new Error("vault path must be a regular file, not a symlink");
    }
    // O_NOFOLLOW closes the swap window between the lstat above and open.
    // Repair a checkout/restore's broad mode on the opened inode before any
    // secret bytes are read.
    const fd = openSync(vaultPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: string;
    try {
      fchmodSync(fd, 0o600);
      raw = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    const parsed = JSON.parse(raw) as LegacyVaultFile;
    if (!parsed.saltHex || !Array.isArray(parsed.records)) {
      throw new Error("malformed vault file");
    }
    const { vault, migrated } = normalizeVault(parsed);
    cache = vault;
    if (migrated) {
      // Credential IDs are metadata only. A read-only legacy vault must still
      // remain usable; deterministic IDs keep attribution stable until a
      // later process can persist the migration.
      try {
        persist(vault);
      } catch {
        cache = vault;
      }
    }
    return vault;
  } catch (err) {
    throw new Error(
      `provider-keys vault at ${vaultPath} is unreadable: ${(err as Error).message}`,
    );
  }
}

function getMasterKey(vault: VaultFile): Buffer {
  if (masterKey) return masterKey;
  masterKey = deriveMasterKey(Buffer.from(vault.saltHex, "hex"));
  return masterKey;
}

function persist(vault: VaultFile): void {
  const vaultPath = cachePath ?? defaultVaultPath();
  const vaultDirectory = dirname(vaultPath);
  mkdirSync(vaultDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(vaultDirectory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("provider-keys vault directory must not be a symlink");
  }
  chmodSync(vaultDirectory, 0o700);
  const temporary = `${vaultPath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(vault, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const fd = openSync(temporary, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, vaultPath);
  cache = vault;
  cachePath = vaultPath;
}

function encrypt(
  plain: string,
  vault: VaultFile,
): Pick<ProviderKeyRecord, "cipherHex" | "ivHex" | "tagHex"> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getMasterKey(vault), iv);
  const cipherBuf = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    cipherHex: cipherBuf.toString("hex"),
    ivHex: iv.toString("hex"),
    tagHex: tag.toString("hex"),
  };
}

function decrypt(rec: ProviderKeyRecord, vault: VaultFile): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getMasterKey(vault),
    Buffer.from(rec.ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(rec.tagHex, "hex"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(rec.cipherHex, "hex")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

function maskKey(plain: string): string {
  const trimmed = plain.trim();
  if (trimmed.length <= 8) return "***";
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

function sameCredentialSlot(
  record: ProviderKeyRecord,
  provider: string,
  scope: KeyScope,
  tenantId?: string,
): boolean {
  if (record.provider !== provider || record.scope !== scope) return false;
  if (scope === "workspace") return true;
  return record.tenantId === tenantId;
}

function findVaultRecord(
  vault: VaultFile,
  id: string,
  tenantId?: string,
  requiredScope?: KeyScope,
): ProviderKeyRecord | undefined {
  if (requiredScope === "tenant") {
    if (!tenantId) return undefined;
    return vault.records.find((record) =>
      sameCredentialSlot(record, id, "tenant", tenantId),
    );
  }
  if (requiredScope === "workspace") {
    return vault.records.find((record) =>
      sameCredentialSlot(record, id, "workspace"),
    );
  }
  if (tenantId) {
    const tenantRecord = vault.records.find((record) =>
      sameCredentialSlot(record, id, "tenant", tenantId),
    );
    if (tenantRecord) return tenantRecord;
  }
  return vault.records.find((record) =>
    sameCredentialSlot(record, id, "workspace"),
  );
}

export interface ResolvedProviderCredential {
  apiKey: string;
  credentialId: string;
  provider: string;
  source: "vault" | "env";
  scope: KeyScope;
  tenantId: string | null;
}

/**
 * Resolve only the process environment credential for a built-in provider.
 *
 * This deliberately bypasses the vault. Compatible gateway routing uses it
 * only after proving that the canonical built-in endpoint still matches the
 * process-configured endpoint, so an arbitrary persisted URL cannot inherit a
 * platform credential through a public credentialRef.
 */
export function getProviderEnvironmentCredential(
  id: ProviderId,
): ResolvedProviderCredential | null {
  const envVar = ENV_VAR_BY_PROVIDER[id];
  if (!envVar) return null;
  const apiKey = process.env[envVar];
  if (!apiKey || apiKey.trim().length === 0) return null;
  return {
    apiKey,
    credentialId: `cred-env-${id}`,
    provider: id,
    source: "env",
    scope: "workspace",
    tenantId: null,
  };
}

/**
 * Resolves both the secret and its public-safe identity. Consumers that
 * account for provider usage should retain `credentialId` and discard the
 * plaintext key once the provider adapter is configured.
 */
export function getProviderCredential(
  id: ProviderId,
  tenantId?: string,
): ResolvedProviderCredential | null {
  return getGatewayCredential(id, tenantId);
}

/** Mirrors the non-secret credentialRef grammar in @agentic/contracts. */
function isCredentialReference(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(id);
}

/** Resolve a credential for an arbitrary configured gateway instance. */
export function getGatewayCredential(
  id: string,
  tenantId?: string,
  requiredScope?: KeyScope,
): ResolvedProviderCredential | null {
  if (!isCredentialReference(id)) return null;
  const vault = loadVault();
  const record = findVaultRecord(vault, id, tenantId, requiredScope);
  if (record) {
    try {
      return {
        apiKey: decrypt(record, vault),
        credentialId: record.credentialId,
        provider: id,
        source: "vault",
        scope: record.scope,
        tenantId: record.scope === "tenant" ? (record.tenantId ?? null) : null,
      };
    } catch {
      return null;
    }
  }

  if (isProviderId(id) && requiredScope !== "tenant") {
    return getProviderEnvironmentCredential(id);
  }
  return null;
}

/**
 * Returns the plaintext key for a provider, preferring the vault over env.
 *
 * P5-TEN-01 — tenant-aware lookup. Precedence:
 *   1. vault record with `scope='tenant'` AND matching `tenantId`
 *   2. vault record with `scope='workspace'` (platform-wide override)
 *   3. environment variable
 *
 * Prior implementation returned the FIRST record matching `provider`, which
 * silently let a tenant-scoped record from tenant A become the de-facto
 * workspace default — a cross-tenant credentials bleed. The new precedence
 * requires an explicit tenant match before tenant-scoped records apply, and
 * never falls through to a different tenant's key.
 */
export function getProviderKey(
  id: ProviderId,
  tenantId?: string,
): string | null {
  return getProviderCredential(id, tenantId)?.apiKey ?? null;
}

/** Public-safe view: masked key + metadata, no plaintext. */
export interface ProviderKeyMeta {
  provider: string;
  credentialId: string | null;
  hasKey: boolean;
  source: "vault" | "env" | "none";
  keyMasked: string | null;
  scope: KeyScope | null;
  setBy: string | null;
  setAt: number | null;
}

export function getProviderKeyMeta(
  id: ProviderId,
  tenantId?: string,
): ProviderKeyMeta {
  return getGatewayCredentialMeta(id, tenantId);
}

/** Public-safe credential metadata for a static or dynamic gateway instance. */
export function getGatewayCredentialMeta(
  id: string,
  tenantId?: string,
  requiredScope?: KeyScope,
): ProviderKeyMeta {
  if (!isCredentialReference(id)) {
    return {
      provider: id,
      credentialId: null,
      hasKey: false,
      source: "none",
      keyMasked: null,
      scope: null,
      setBy: null,
      setAt: null,
    };
  }
  const vault = loadVault();
  const rec = findVaultRecord(vault, id, tenantId, requiredScope);
  if (rec) {
    return {
      provider: id,
      credentialId: rec.credentialId,
      hasKey: true,
      source: "vault",
      keyMasked: rec.keyMasked,
      scope: rec.scope,
      setBy: rec.setBy,
      setAt: rec.setAt,
    };
  }
  const envVar = isProviderId(id) ? ENV_VAR_BY_PROVIDER[id] : undefined;
  if (envVar && requiredScope !== "tenant") {
    const v = process.env[envVar];
    if (v && v.trim().length > 0) {
      return {
        provider: id,
        credentialId: `cred-env-${id}`,
        hasKey: true,
        source: "env",
        keyMasked: maskKey(v),
        scope: "workspace",
        setBy: null,
        setAt: null,
      };
    }
  }
  return {
    provider: id,
    credentialId: null,
    hasKey: false,
    source: "none",
    keyMasked: null,
    scope: null,
    setBy: null,
    setAt: null,
  };
}

export function listProviderKeyMeta(tenantId?: string): ProviderKeyMeta[] {
  return PROVIDER_IDS.map((id) => getProviderKeyMeta(id, tenantId));
}

export interface SetProviderKeyInput {
  apiKey: string;
  scope: KeyScope;
  tenantId?: string;
  setBy: string | null;
}

export function setProviderKey(
  id: ProviderId,
  input: SetProviderKeyInput,
): ProviderKeyMeta {
  if (!isProviderId(id)) {
    throw new Error(`unknown provider: ${id}`);
  }
  return setGatewayCredential(id, input);
}

/** Save/rotate a credential slot for a dynamic gateway instance. */
export function setGatewayCredential(
  id: string,
  input: SetProviderKeyInput,
): ProviderKeyMeta {
  if (!isCredentialReference(id)) {
    throw new Error(`invalid gateway credential reference: ${id}`);
  }
  const key = (input.apiKey ?? "").trim();
  if (key.length < 8) {
    throw new Error("API key is too short");
  }
  const tenantId =
    input.scope === "tenant" ? input.tenantId?.trim() : undefined;
  if (input.scope === "tenant" && !tenantId) {
    throw new Error("tenantId is required for tenant-scoped API keys");
  }
  const vault = loadVault();
  const enc = encrypt(key, vault);
  const current = vault.records.find((record) =>
    sameCredentialSlot(record, id, input.scope, tenantId),
  );
  const next: ProviderKeyRecord = {
    credentialId: current?.credentialId ?? newCredentialId(),
    provider: id,
    scope: input.scope,
    tenantId,
    setBy: input.setBy,
    setAt: Date.now(),
    keyMasked: maskKey(key),
    ...enc,
  };
  const others = vault.records.filter(
    (record) => !sameCredentialSlot(record, id, input.scope, tenantId),
  );
  persist({ saltHex: vault.saltHex, records: [...others, next] });
  return {
    provider: id,
    credentialId: next.credentialId,
    hasKey: true,
    source: "vault",
    keyMasked: next.keyMasked,
    scope: next.scope,
    setBy: next.setBy,
    setAt: next.setAt,
  };
}

export function deleteProviderKey(
  id: ProviderId,
  scope: KeyScope = "workspace",
  tenantId?: string,
): boolean {
  return deleteGatewayCredential(id, scope, tenantId);
}

export function deleteGatewayCredential(
  id: string,
  scope: KeyScope = "workspace",
  tenantId?: string,
): boolean {
  if (!isCredentialReference(id)) {
    throw new Error(`invalid gateway credential reference: ${id}`);
  }
  if (scope === "tenant" && !tenantId?.trim()) {
    throw new Error("tenantId is required for tenant-scoped API keys");
  }
  const vault = loadVault();
  const before = vault.records.length;
  const after = vault.records.filter(
    (record) => !sameCredentialSlot(record, id, scope, tenantId?.trim()),
  );
  if (after.length === before) return false;
  persist({ saltHex: vault.saltHex, records: after });
  return true;
}

/**
 * Env-shaped overlay merging vault contents on top of `process.env`. Pass
 * to `resolveConfig()` so the gateway sees vault keys without us mutating
 * `process.env` (which would leak across tests).
 */
export function getProviderKeyEnvOverlay(
  tenantId?: string,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const id of PROVIDER_IDS) {
    const envVar = ENV_VAR_BY_PROVIDER[id];
    if (!envVar) continue;
    const meta = getProviderKeyMeta(id, tenantId);
    const key = getProviderKey(id, tenantId);
    if (key) out[envVar] = key;
    // A corrupt/unreadable vault record must fail closed instead of silently
    // falling back to a process environment credential for another account.
    else if (meta.source === "vault") out[envVar] = undefined;
  }
  return out;
}

/** Test-only — drop the in-memory cache so the next read re-loads from disk. */
export function _resetProviderKeyVaultCache(): void {
  cache = null;
  cachePath = null;
  masterKey = null;
}
