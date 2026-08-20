export const FACTORY_TEST_FIXTURE_ASSET_SCHEMA = "agent-factory-test-fixture-asset/v1" as const;

export type FactoryTestFixtureAssetShape = "base64_string" | "data_url" | "object";
export type FactoryTestFixtureAssetProvenance = "uploaded" | "synthetic_resume_pdf";

/** Secret-free metadata returned by the tenant/run-scoped fixture store. */
export interface FactoryTestFixtureAssetMetadata {
  assetId: string;
  sha256: string;
  bytes: number;
  mimeType?: string;
  filename?: string;
  expiresAt: string;
  provenance?: FactoryTestFixtureAssetProvenance;
}

/** The only binary value persisted in a Factory conversation/regression suite.
 * Raw bytes stay in the scoped asset store and are materialized only inside the
 * disposable sandbox or immutable regression replay adapter. */
export interface FactoryTestFixtureAssetBinding extends FactoryTestFixtureAssetMetadata {
  schema: typeof FACTORY_TEST_FIXTURE_ASSET_SCHEMA;
  conversationId: string;
  as: FactoryTestFixtureAssetShape;
}

export interface FactoryTestFixtureAsset extends FactoryTestFixtureAssetMetadata {
  caseId: string;
  path: string;
  /** Returned only to trusted server code. This field must never be copied to
   * a BrainTool result, BrainEvent, conversation checkpoint or regression JSON. */
  content: Uint8Array;
}

export interface FactoryTestFixtureAssetReader {
  /** The adapter is already tenant-bound. Missing, expired, deleted and
   * scope-mismatched assets all return null so the call cannot enumerate them. */
  readExact(input: {
    domainId: string;
    conversationId: string;
    assetId: string;
  }): Promise<FactoryTestFixtureAsset | null>;
  /** Server-side deterministic fixture creation. This is sandbox test input,
   * never integration evidence, and stays tenant/domain/conversation scoped. */
  createSyntheticResume?(input: {
    domainId: string;
    conversationId: string;
    caseId: string;
    path: string;
    persona?: {
      name?: string;
      title?: string;
      skills?: string[];
      email?: string;
      years?: number;
    };
  }): Promise<FactoryTestFixtureAsset | null>;
}

export function isFactoryTestFixtureAssetBinding(value: unknown): value is FactoryTestFixtureAssetBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.schema === FACTORY_TEST_FIXTURE_ASSET_SCHEMA
    && typeof item.assetId === "string" && item.assetId.length > 0
    && typeof item.conversationId === "string" && item.conversationId.length > 0
    && typeof item.sha256 === "string" && /^[a-f0-9]{64}$/i.test(item.sha256)
    && typeof item.bytes === "number" && Number.isSafeInteger(item.bytes) && item.bytes > 0
    && typeof item.expiresAt === "string" && Number.isFinite(Date.parse(item.expiresAt))
    && (item.as === "base64_string" || item.as === "data_url" || item.as === "object")
    && (item.mimeType === undefined || typeof item.mimeType === "string")
    && (item.filename === undefined || typeof item.filename === "string")
    && (item.provenance === undefined || item.provenance === "uploaded" || item.provenance === "synthetic_resume_pdf");
}
