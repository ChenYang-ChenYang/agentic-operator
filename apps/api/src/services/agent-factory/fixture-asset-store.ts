import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

export const FACTORY_FIXTURE_ASSET_MAX_BYTES = 8 * 1024 * 1024;
export const FACTORY_FIXTURE_ASSET_DEFAULT_TTL_SECONDS = 60 * 60;
export const FACTORY_FIXTURE_ASSET_MAX_TTL_SECONDS = 24 * 60 * 60;

const ASSET_SCHEMA = "factory-fixture-asset:v1";
const ASSET_ID_PATTERN = /^ffa-[0-9a-f]{32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MIME_TYPE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/;
const UNSAFE_JSON_POINTER_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

export type FactoryFixtureAssetErrorCode =
  | "invalid_fixture_request"
  | "invalid_fixture_scope"
  | "invalid_fixture_case"
  | "invalid_fixture_path"
  | "invalid_fixture_base64"
  | "fixture_too_large"
  | "fixture_hash_mismatch"
  | "invalid_fixture_mime_type"
  | "invalid_fixture_filename"
  | "invalid_fixture_asset_id"
  | "invalid_fixture_ttl"
  | "fixture_asset_corrupt";

export class FactoryFixtureAssetError extends Error {
  constructor(
    readonly code: FactoryFixtureAssetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FactoryFixtureAssetError";
  }
}

export interface FactoryFixtureAssetScope {
  tenantId: string;
  domain: string;
  conversationId: string;
}

export interface FactoryFixtureAssetPutInput {
  caseId: string;
  /** Existing test-case JSON Pointer at which the binary fixture is injected. */
  path: string;
  /** Strict RFC 4648 base64 without whitespace or data-URL prefixes. */
  base64: string;
  mimeType?: string;
  filename?: string;
  sha256?: string;
  /** Internal server provenance. HTTP uploads omit this and remain uploaded. */
  provenance?: "uploaded" | "synthetic_resume_pdf";
}

/** The only metadata safe to return through the HTTP API. */
export interface FactoryFixtureAssetMetadata {
  assetId: string;
  sha256: string;
  bytes: number;
  mimeType: string;
  filename: string;
  expiresAt: string;
  provenance?: "uploaded" | "synthetic_resume_pdf";
}

/** Internal-only read result used by the sandbox fixture resolver. */
export interface FactoryFixtureAssetReadResult extends FactoryFixtureAssetMetadata {
  caseId: string;
  path: string;
  base64: string;
}

interface StoredFactoryFixtureAsset extends FactoryFixtureAssetMetadata {
  schema: typeof ASSET_SCHEMA;
  scope: FactoryFixtureAssetScope;
  caseId: string;
  path: string;
  createdAt: string;
}

interface FactoryFixtureAssetStoreOptions {
  root?: string;
  ttlSeconds?: number;
  now?: () => Date;
}

function defaultRoot(): string {
  const configured = process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
  const dataRoot = path.isAbsolute(configured)
    ? configured
    : path.resolve(process.cwd(), configured);
  return path.join(dataRoot, "factory-fixture-assets");
}

function positiveTtl(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > FACTORY_FIXTURE_ASSET_MAX_TTL_SECONDS
  ) {
    throw new FactoryFixtureAssetError(
      "invalid_fixture_ttl",
      `fixture TTL must be an integer between 1 and ${FACTORY_FIXTURE_ASSET_MAX_TTL_SECONDS} seconds`,
    );
  }
  return value;
}

function configuredTtl(): number {
  const raw = process.env.FACTORY_FIXTURE_ASSET_TTL_SECONDS?.trim();
  if (!raw) return FACTORY_FIXTURE_ASSET_DEFAULT_TTL_SECONDS;
  return positiveTtl(Number(raw));
}

function exactScope(scope: FactoryFixtureAssetScope): FactoryFixtureAssetScope {
  const checked = (value: unknown, field: string, max: number): string => {
    if (
      typeof value !== "string" ||
      !value ||
      value.length > max ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new FactoryFixtureAssetError(
        "invalid_fixture_scope",
        `${field} must be a non-empty string of at most ${max} characters`,
      );
    }
    return value;
  };
  return {
    tenantId: checked(scope.tenantId, "tenantId", 128),
    domain: checked(scope.domain, "domain", 256),
    conversationId: checked(scope.conversationId, "conversationId", 128),
  };
}

function exactCaseId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new FactoryFixtureAssetError(
      "invalid_fixture_case",
      "caseId must be a non-empty string of at most 128 characters",
    );
  }
  return value;
}

function exactJsonPointer(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    !value.startsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new FactoryFixtureAssetError(
      "invalid_fixture_path",
      "path must be a non-empty JSON Pointer of at most 1024 characters",
    );
  }
  const segments = value.slice(1).split("/");
  for (const raw of segments) {
    if (/~(?:[^01]|$)/.test(raw)) {
      throw new FactoryFixtureAssetError(
        "invalid_fixture_path",
        "path contains an invalid JSON Pointer escape",
      );
    }
    const decoded = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (UNSAFE_JSON_POINTER_SEGMENTS.has(decoded)) {
      throw new FactoryFixtureAssetError(
        "invalid_fixture_path",
        "path contains a reserved object-property segment",
      );
    }
  }
  return value;
}

function exactMimeType(value: unknown): string {
  if (value === undefined) return "application/octet-stream";
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !MIME_TYPE_PATTERN.test(value)
  ) {
    throw new FactoryFixtureAssetError(
      "invalid_fixture_mime_type",
      "mimeType must be a single valid media type without parameters",
    );
  }
  return value.toLowerCase();
}

function exactFilename(value: unknown): string {
  if (value === undefined) return "fixture.bin";
  if (typeof value !== "string") {
    throw new FactoryFixtureAssetError(
      "invalid_fixture_filename",
      "filename must be a string",
    );
  }
  const normalized = value.normalize("NFC");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized !== path.basename(normalized) ||
    /[\\/\u0000-\u001f\u007f]/.test(normalized) ||
    Buffer.byteLength(normalized, "utf8") > 255
  ) {
    throw new FactoryFixtureAssetError(
      "invalid_fixture_filename",
      "filename must be a single safe basename of at most 255 UTF-8 bytes",
    );
  }
  return normalized;
}

function decodeCanonicalBase64(value: unknown): Buffer {
  if (typeof value !== "string") {
    throw new FactoryFixtureAssetError(
      "invalid_fixture_base64",
      "base64 must be a string",
    );
  }
  const maxEncodedBytes = 4 * Math.ceil(FACTORY_FIXTURE_ASSET_MAX_BYTES / 3);
  if (value.length > maxEncodedBytes) {
    throw new FactoryFixtureAssetError(
      "fixture_too_large",
      `fixture content exceeds ${FACTORY_FIXTURE_ASSET_MAX_BYTES} bytes`,
    );
  }
  if (value.length % 4 !== 0) {
    throw new FactoryFixtureAssetError(
      "invalid_fixture_base64",
      "base64 must use canonical RFC 4648 encoding without whitespace or a data-URL prefix",
    );
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const alphabetEnd = value.length - padding;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const alphabet =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (
      (index < alphabetEnd && !alphabet) ||
      (index >= alphabetEnd && code !== 61)
    ) {
      throw new FactoryFixtureAssetError(
        "invalid_fixture_base64",
        "base64 must use canonical RFC 4648 encoding without whitespace or a data-URL prefix",
      );
    }
  }
  const decodedBytes = (value.length / 4) * 3 - padding;
  if (decodedBytes > FACTORY_FIXTURE_ASSET_MAX_BYTES) {
    throw new FactoryFixtureAssetError(
      "fixture_too_large",
      `fixture content exceeds ${FACTORY_FIXTURE_ASSET_MAX_BYTES} bytes`,
    );
  }
  const content = Buffer.from(value, "base64");
  if (content.length === 0) {
    throw new FactoryFixtureAssetError(
      "invalid_fixture_base64",
      "base64 must encode at least one byte",
    );
  }
  if (content.length > FACTORY_FIXTURE_ASSET_MAX_BYTES) {
    throw new FactoryFixtureAssetError(
      "fixture_too_large",
      `fixture content exceeds ${FACTORY_FIXTURE_ASSET_MAX_BYTES} bytes`,
    );
  }
  if (content.toString("base64") !== value) {
    throw new FactoryFixtureAssetError(
      "invalid_fixture_base64",
      "base64 is not canonical RFC 4648 encoding",
    );
  }
  return content;
}

function exactAssetId(value: unknown): string {
  if (typeof value !== "string" || !ASSET_ID_PATTERN.test(value)) {
    throw new FactoryFixtureAssetError(
      "invalid_fixture_asset_id",
      "invalid fixture asset id",
    );
  }
  return value;
}

function digestSegment(kind: string, value: string): string {
  return createHash("sha256")
    .update(`${kind}\0${Buffer.byteLength(value, "utf8")}\0${value}`, "utf8")
    .digest("hex");
}

function publicMetadata(
  stored: StoredFactoryFixtureAsset,
): FactoryFixtureAssetMetadata {
  return {
    assetId: stored.assetId,
    sha256: stored.sha256,
    bytes: stored.bytes,
    mimeType: stored.mimeType,
    filename: stored.filename,
    expiresAt: stored.expiresAt,
    ...(stored.provenance ? { provenance: stored.provenance } : {}),
  };
}

/**
 * Short-lived, filesystem-backed fixture asset store.
 *
 * Scope values never become path segments: each level uses a typed SHA-256
 * digest and every metadata read re-checks the exact immutable values.  The
 * store is entirely API-local and never reads Allmeta, Neo4j, or tenant RAAS
 * state.
 */
export class FsFactoryFixtureAssetStore {
  private readonly root: string;
  private readonly ttlSeconds: number;
  private readonly now: () => Date;

  constructor(options: FactoryFixtureAssetStoreOptions = {}) {
    this.root = path.resolve(options.root ?? defaultRoot());
    this.ttlSeconds = positiveTtl(options.ttlSeconds ?? configuredTtl());
    this.now = options.now ?? (() => new Date());
  }

  private scopeDirectories(scope: FactoryFixtureAssetScope): string[] {
    const tenantDir = path.join(
      this.root,
      digestSegment("tenant", scope.tenantId),
    );
    const domainDir = path.join(
      tenantDir,
      digestSegment("domain", scope.domain),
    );
    return [
      this.root,
      tenantDir,
      domainDir,
      path.join(domainDir, digestSegment("conversation", scope.conversationId)),
    ];
  }

  private scopeDirectory(scope: FactoryFixtureAssetScope): string {
    return this.scopeDirectories(scope)[3]!;
  }

  private paths(scope: FactoryFixtureAssetScope, assetId: string) {
    const directory = this.scopeDirectory(scope);
    return {
      directory,
      content: path.join(directory, `${assetId}.bin`),
      metadata: path.join(directory, `${assetId}.json`),
    };
  }

  private async ensureScopeDirectory(scope: FactoryFixtureAssetScope) {
    const directories = this.scopeDirectories(scope);
    for (const directory of directories) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new FactoryFixtureAssetError(
          "fixture_asset_corrupt",
          "fixture asset directory is not a real directory",
        );
      }
      await fs.chmod(directory, 0o700);
    }
    return directories[directories.length - 1]!;
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async unlinkIfPresent(file: string): Promise<boolean> {
    try {
      await fs.unlink(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private validateStored(
    value: unknown,
    scope: FactoryFixtureAssetScope,
    assetId: string,
  ): StoredFactoryFixtureAsset {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new FactoryFixtureAssetError(
        "fixture_asset_corrupt",
        "fixture asset metadata is corrupt",
      );
    }
    const stored = value as StoredFactoryFixtureAsset;
    if (
      stored.schema !== ASSET_SCHEMA ||
      stored.assetId !== assetId ||
      stored.scope?.tenantId !== scope.tenantId ||
      stored.scope?.domain !== scope.domain ||
      stored.scope?.conversationId !== scope.conversationId ||
      !SHA256_PATTERN.test(stored.sha256) ||
      !Number.isSafeInteger(stored.bytes) ||
      stored.bytes < 0 ||
      stored.bytes > FACTORY_FIXTURE_ASSET_MAX_BYTES ||
      !MIME_TYPE_PATTERN.test(stored.mimeType) ||
      typeof stored.filename !== "string" ||
      typeof stored.caseId !== "string" ||
      typeof stored.path !== "string" ||
      (stored.provenance !== undefined
        && stored.provenance !== "uploaded"
        && stored.provenance !== "synthetic_resume_pdf") ||
      !Number.isFinite(Date.parse(stored.createdAt)) ||
      !Number.isFinite(Date.parse(stored.expiresAt))
    ) {
      throw new FactoryFixtureAssetError(
        "fixture_asset_corrupt",
        "fixture asset metadata does not match its storage scope",
      );
    }
    // Reuse the input validators so on-disk metadata can never smuggle an
    // unsafe filename or JSON Pointer into the sandbox resolver.
    exactFilename(stored.filename);
    exactCaseId(stored.caseId);
    exactJsonPointer(stored.path);
    return stored;
  }

  private async loadStored(
    scopeInput: FactoryFixtureAssetScope,
    assetIdInput: string,
  ): Promise<StoredFactoryFixtureAsset | null> {
    const scope = exactScope(scopeInput);
    const assetId = exactAssetId(assetIdInput);
    const target = this.paths(scope, assetId);
    let raw: string;
    try {
      raw = await fs.readFile(target.metadata, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new FactoryFixtureAssetError(
        "fixture_asset_corrupt",
        `fixture asset metadata is not valid JSON: ${(error as Error).message}`,
      );
    }
    return this.validateStored(parsed, scope, assetId);
  }

  private async removeFiles(
    scope: FactoryFixtureAssetScope,
    assetId: string,
  ): Promise<void> {
    const target = this.paths(scope, assetId);
    const [removedMetadata, removedContent] = await Promise.all([
      this.unlinkIfPresent(target.metadata),
      this.unlinkIfPresent(target.content),
    ]);
    if (removedMetadata || removedContent) {
      await this.syncDirectory(target.directory);
    }
  }

  private async materializeStored(
    scope: FactoryFixtureAssetScope,
    assetId: string,
    stored: StoredFactoryFixtureAsset,
  ): Promise<FactoryFixtureAssetReadResult> {
    const target = this.paths(scope, assetId);
    let content: Buffer;
    try {
      content = await fs.readFile(target.content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FactoryFixtureAssetError(
          "fixture_asset_corrupt",
          "fixture asset content is missing",
        );
      }
      throw error;
    }
    const digest = createHash("sha256").update(content).digest("hex");
    if (content.length !== stored.bytes || digest !== stored.sha256) {
      throw new FactoryFixtureAssetError(
        "fixture_asset_corrupt",
        "fixture asset content no longer matches its immutable metadata",
      );
    }
    return {
      ...publicMetadata(stored),
      caseId: stored.caseId,
      path: stored.path,
      base64: content.toString("base64"),
    };
  }

  async put(
    scopeInput: FactoryFixtureAssetScope,
    input: FactoryFixtureAssetPutInput,
  ): Promise<FactoryFixtureAssetMetadata> {
    const scope = exactScope(scopeInput);
    const caseId = exactCaseId(input.caseId);
    const jsonPointer = exactJsonPointer(input.path);
    const mimeType = exactMimeType(input.mimeType);
    const filename = exactFilename(input.filename);
    const content = decodeCanonicalBase64(input.base64);
    const actualSha256 = createHash("sha256").update(content).digest("hex");
    if (input.sha256 !== undefined) {
      if (
        typeof input.sha256 !== "string" ||
        !SHA256_PATTERN.test(input.sha256)
      ) {
        throw new FactoryFixtureAssetError(
          "fixture_hash_mismatch",
          "sha256 must be a 64-character hexadecimal digest",
        );
      }
      if (input.sha256.toLowerCase() !== actualSha256) {
        throw new FactoryFixtureAssetError(
          "fixture_hash_mismatch",
          "fixture sha256 does not match the uploaded bytes",
        );
      }
    }

    const directory = await this.ensureScopeDirectory(scope);
    const assetId = `ffa-${randomBytes(16).toString("hex")}`;
    const target = this.paths(scope, assetId);
    const now = this.now();
    const stored: StoredFactoryFixtureAsset = {
      schema: ASSET_SCHEMA,
      scope,
      assetId,
      caseId,
      path: jsonPointer,
      sha256: actualSha256,
      bytes: content.length,
      mimeType,
      filename,
      ...(input.provenance === "synthetic_resume_pdf"
        ? { provenance: "synthetic_resume_pdf" as const }
        : {}),
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.ttlSeconds * 1_000,
      ).toISOString(),
    };
    const metadataTemp = `${target.metadata}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let contentHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let metadataHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      contentHandle = await fs.open(
        target.content,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      await contentHandle.writeFile(content);
      await contentHandle.sync();
      await contentHandle.close();
      contentHandle = undefined;

      metadataHandle = await fs.open(
        metadataTemp,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      await metadataHandle.writeFile(JSON.stringify(stored), "utf8");
      await metadataHandle.sync();
      await metadataHandle.close();
      metadataHandle = undefined;
      await fs.rename(metadataTemp, target.metadata);
      await this.syncDirectory(directory);
      return publicMetadata(stored);
    } catch (error) {
      if (contentHandle) await contentHandle.close().catch(() => undefined);
      if (metadataHandle) await metadataHandle.close().catch(() => undefined);
      await Promise.all([
        this.unlinkIfPresent(metadataTemp).catch(() => false),
        this.unlinkIfPresent(target.metadata).catch(() => false),
        this.unlinkIfPresent(target.content).catch(() => false),
      ]);
      throw error;
    }
  }

  async inspect(
    scopeInput: FactoryFixtureAssetScope,
    assetIdInput: string,
  ): Promise<FactoryFixtureAssetMetadata | null> {
    const scope = exactScope(scopeInput);
    const assetId = exactAssetId(assetIdInput);
    const stored = await this.loadStored(scope, assetId);
    if (!stored) return null;
    if (Date.parse(stored.expiresAt) <= this.now().getTime()) {
      await this.removeFiles(scope, assetId);
      return null;
    }
    return publicMetadata(stored);
  }

  async read(
    scopeInput: FactoryFixtureAssetScope,
    assetIdInput: string,
  ): Promise<FactoryFixtureAssetReadResult | null> {
    const scope = exactScope(scopeInput);
    const assetId = exactAssetId(assetIdInput);
    const stored = await this.loadStored(scope, assetId);
    if (!stored) return null;
    if (Date.parse(stored.expiresAt) <= this.now().getTime()) {
      await this.removeFiles(scope, assetId);
      return null;
    }
    return this.materializeStored(scope, assetId, stored);
  }

  /** Read-only evidence-export path. Unlike normal sandbox reads, an expired
   * asset is reported as absent without attempting retention cleanup. */
  async readForEvidenceExport(
    scopeInput: FactoryFixtureAssetScope,
    assetIdInput: string,
  ): Promise<FactoryFixtureAssetReadResult | null> {
    const scope = exactScope(scopeInput);
    const assetId = exactAssetId(assetIdInput);
    const stored = await this.loadStored(scope, assetId);
    if (!stored || Date.parse(stored.expiresAt) <= this.now().getTime()) {
      return null;
    }
    return this.materializeStored(scope, assetId, stored);
  }

  async delete(
    scopeInput: FactoryFixtureAssetScope,
    assetIdInput: string,
  ): Promise<boolean> {
    const scope = exactScope(scopeInput);
    const assetId = exactAssetId(assetIdInput);
    const stored = await this.loadStored(scope, assetId);
    if (!stored) return false;
    await this.removeFiles(scope, assetId);
    return true;
  }
}
