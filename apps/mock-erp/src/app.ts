import Fastify, { type FastifyInstance } from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MockErpError, WRITE_EFFECTS } from "./effects.js";
import {
  DEFAULT_DATA_DIR,
  DEFAULT_TRANSFORM_MAPS,
  MockErpStore,
  type Row,
} from "./store.js";
import { renderHome, renderRequisitions, renderTransfers } from "./ui.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const columnKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Resolve a filter key to a real column the way a model actually writes
 * filters (observed on live runs): any case/style (`material_code`,
 * `materialCode` → `MATERIAL_CODE`) and the list spellings the real MetaERP
 * swaggers use (`material_codes`, `itemCodeList`, `pbp_header_id_list` →
 * the singular column). Returns null when no column matches.
 */
function resolveColumn(columns: string[], key: string): string | null {
  const base = columnKey(key);
  const candidates = [base, base.replace(/list$/, ""), base.replace(/s$/, ""), base.replace(/ids$/, "id")];
  for (const candidate of candidates) {
    const hit = columns.find((name) => columnKey(name) === candidate);
    if (hit) return hit;
  }
  return null;
}

/** Exact match on one resolved column; list values are an IN. */
function matchesColumn(row: Row, column: string, value: unknown): boolean {
  const actual = row[column];
  const same = (candidate: unknown): boolean =>
    candidate === actual || String(candidate) === String(actual);
  return Array.isArray(value) ? value.some(same) : same(value);
}

export interface BuildAppOptions {
  dataDir?: string;
  transformMapsPath?: string;
  stateDir?: string;
  logger?: boolean;
}

export interface MockErpApp {
  app: FastifyInstance;
  store: MockErpStore;
}

export function buildApp(opts: BuildAppOptions = {}): MockErpApp {
  const store = new MockErpStore({
    dataDir: opts.dataDir ?? process.env.MOCK_ERP_DATA_DIR ?? DEFAULT_DATA_DIR,
    transformMapsPath:
      opts.transformMapsPath ??
      process.env.MOCK_ERP_TRANSFORM_MAPS ??
      DEFAULT_TRANSFORM_MAPS,
    stateDir:
      opts.stateDir ?? process.env.MOCK_ERP_STATE_DIR ?? path.join(APP_ROOT, "data"),
  });

  // Warn (don't crash) if transform-maps declares a write op we have no
  // hand-written semantics for — the demo package is the source of truth.
  const missing = [...store.writeOps.keys()].filter((op) => !WRITE_EFFECTS[op]);
  const app = Fastify({ logger: opts.logger ?? false });
  if (missing.length > 0) {
    app.log.warn({ missing }, "write ops in transform-maps without an effect impl");
  }

  // ---- operation dispatch (queries + writes share the ERP base path) -------
  app.post<{ Params: { op: string }; Body: Row | null }>(
    "/metaerp/openapi/v1/:op",
    async (req, reply) => {
      const op = req.params.op;
      const payload: Row =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
          ? (req.body as Row)
          : {};

      // Query op: return (optionally filtered) rows.
      const entity = store.queryOps.get(op);
      if (entity) {
        let rows = store.rows(entity);
        const filters = Object.entries(payload).filter(
          ([, v]) => v !== undefined && v !== null && v !== "",
        );
        if (filters.length === 0) return { rows };
        // Column vocabulary of the table = union of the stub rows' keys.
        const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
        const applied: Array<[string, unknown]> = [];
        const ignored: string[] = [];
        for (const [key, value] of filters) {
          const column = resolveColumn(columns, key);
          if (column) applied.push([column, value]);
          else ignored.push(key);
        }
        rows = rows.filter((row) => applied.every(([column, value]) => matchesColumn(row, column, value)));
        // A filter naming no column of this table is reported, not silently
        // honoured as "match nothing": the model can see its parameter name
        // was not a column and correct it, instead of concluding the table is
        // empty (which on a stock check reads as "库存为 0").
        return ignored.length > 0
          ? { rows, ignored_filters: ignored, columns }
          : { rows };
      }

      // Write op: apply the effect, journal, respond.
      const effect = WRITE_EFFECTS[op];
      if (effect && store.writeOps.has(op)) {
        try {
          const result = effect(store, payload);
          await store.journal({
            ts: new Date().toISOString(),
            op,
            payload,
            result,
          });
          return result;
        } catch (err) {
          if (err instanceof MockErpError) {
            await store.journal({
              ts: new Date().toISOString(),
              op,
              payload,
              result: { ok: false, error: err.message },
            });
            return reply.code(err.statusCode).send({ ok: false, error: err.message });
          }
          throw err;
        }
      }

      return reply.code(404).send({ ok: false, error: `unknown operation: ${op}` });
    },
  );

  // ---- verification / lifecycle --------------------------------------------
  app.get("/__journal", async () => ({ entries: store.readJournal() }));

  app.post("/__reset", async () => {
    store.reset();
    return { ok: true };
  });

  app.get("/health", async () => ({
    ok: true,
    entities: store.tables.size,
    ops: { query: store.queryOps.size, write: store.writeOps.size },
  }));

  // ---- minimal server-rendered UI (browser-automation demo target) ---------
  app.get("/ui", async (_req, reply) =>
    reply.type("text/html; charset=utf-8").send(renderHome(store)),
  );
  app.get("/ui/transfers", async (_req, reply) =>
    reply.type("text/html; charset=utf-8").send(renderTransfers(store)),
  );
  app.get("/ui/requisitions", async (_req, reply) =>
    reply.type("text/html; charset=utf-8").send(renderRequisitions(store)),
  );

  return { app, store };
}
