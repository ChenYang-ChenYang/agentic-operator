import fs from "node:fs";
import path from "node:path";

/** A single ERP table row — flat JSON object keyed by UPPER_SNAKE column names. */
export type Row = Record<string, unknown>;

export interface StubIndexEntry {
  operation: string;
  endpoint: string;
  entity: string;
  object_id: string;
  file: string;
  rows: number;
}

interface StubIndexFile {
  system: string;
  base_path: string;
  endpoints: StubIndexEntry[];
}

interface TransformMapsFile {
  action_maps?: Array<{
    action_id: string;
    action_name: string;
    kind: string;
    operation_id?: string;
    endpoint?: string;
    data_changes?: Array<{
      target_object: string;
      mutation_type: string;
      impacted_properties: string[];
    }>;
  }>;
}

export interface WriteOpSpec {
  operationId: string;
  actionId: string;
  actionName: string;
  /** ERP object ids touched, per transform-map data_changes (may be empty). */
  targetObjects: string[];
}

export interface JournalEntry {
  ts: string;
  op: string;
  payload: unknown;
  result: unknown;
}

export interface StoreOptions {
  /** Directory holding _index.json + per-entity stub files. */
  dataDir: string;
  /** Path to transform-maps.json (source of the write-op catalog). */
  transformMapsPath: string;
  /** Directory for mutable state (journal). Created if missing. */
  stateDir: string;
}

export const DEFAULT_DATA_DIR =
  "/Users/kenny/CSI-AICOE/allmetaOntology/demo-packages/power-scm/dist/mock-erp";
export const DEFAULT_TRANSFORM_MAPS =
  "/Users/kenny/CSI-AICOE/allmetaOntology/demo-packages/power-scm/dist/transform-maps/transform-maps.json";

/**
 * In-memory Meta ERP state: tables keyed by ERP entity name, a query-op
 * catalog from the stub index, a write-op catalog from transform-maps, and
 * an append-only NDJSON journal of every write.
 */
export class MockErpStore {
  readonly dataDir: string;
  readonly transformMapsPath: string;
  readonly stateDir: string;
  readonly journalPath: string;

  basePath = "/metaerp/openapi/v1";
  /** entity name (e.g. wm_transfer_order_t) → live rows */
  tables = new Map<string, Row[]>();
  /** query operation (e.g. queryTransferOrders) → entity name */
  queryOps = new Map<string, string>();
  /** entity name → stub index entry (for object_id metadata) */
  entityIndex = new Map<string, StubIndexEntry>();
  /** ERP object_id (e.g. StockTransferOrder) → entity name */
  objectToEntity = new Map<string, string>();
  /** write operation id → spec from transform-maps action_maps */
  writeOps = new Map<string, WriteOpSpec>();

  constructor(opts: StoreOptions) {
    this.dataDir = opts.dataDir;
    this.transformMapsPath = opts.transformMapsPath;
    this.stateDir = opts.stateDir;
    this.journalPath = path.join(this.stateDir, "mock-erp-journal.ndjson");
    this.loadStubs();
    this.loadTransformMaps();
    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  private loadStubs(): void {
    const indexPath = path.join(this.dataDir, "_index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as StubIndexFile;
    if (typeof index.base_path === "string" && index.base_path.length > 0) {
      this.basePath = index.base_path;
    }
    this.tables = new Map();
    this.queryOps = new Map();
    this.entityIndex = new Map();
    this.objectToEntity = new Map();
    for (const entry of index.endpoints) {
      const stub = JSON.parse(
        fs.readFileSync(path.join(this.dataDir, entry.file), "utf8"),
      ) as { rows?: Row[] } | Row[];
      const rows = Array.isArray(stub) ? stub : (stub.rows ?? []);
      // structuredClone so /__reset can re-read pristine data from disk while
      // writes freely mutate the in-memory copy.
      this.tables.set(entry.entity, structuredClone(rows));
      this.queryOps.set(entry.operation, entry.entity);
      this.entityIndex.set(entry.entity, entry);
      this.objectToEntity.set(entry.object_id, entry.entity);
    }
  }

  private loadTransformMaps(): void {
    const maps = JSON.parse(
      fs.readFileSync(this.transformMapsPath, "utf8"),
    ) as TransformMapsFile;
    this.writeOps = new Map();
    for (const am of maps.action_maps ?? []) {
      if (!am.operation_id) continue;
      this.writeOps.set(am.operation_id, {
        operationId: am.operation_id,
        actionId: am.action_id,
        actionName: am.action_name,
        targetObjects: (am.data_changes ?? []).map((c) => c.target_object),
      });
    }
  }

  rows(entity: string): Row[] {
    const rows = this.tables.get(entity);
    if (!rows) throw new Error(`unknown ERP entity: ${entity}`);
    return rows;
  }

  async journal(entry: JournalEntry): Promise<void> {
    await fs.promises.appendFile(
      this.journalPath,
      `${JSON.stringify(entry)}\n`,
      "utf8",
    );
  }

  readJournal(): JournalEntry[] {
    if (!fs.existsSync(this.journalPath)) return [];
    return fs
      .readFileSync(this.journalPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as JournalEntry);
  }

  /** Reload pristine stubs from disk and truncate the journal. */
  reset(): void {
    this.loadStubs();
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.writeFileSync(this.journalPath, "", "utf8");
  }
}
