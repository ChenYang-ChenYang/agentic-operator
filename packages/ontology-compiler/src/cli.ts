/**
 * CLI driver (design G1 item 5):
 *
 *   pnpm ontology:compile -- --source <dir> --tenant <slug> \
 *     [--overlay overlays/<domain>.json] [--out models/] [--check]
 *
 * Writes the AO five-file layout `<out>/<tenant>-v1/` plus
 * `erp-operations.json`. `--check` compiles in memory and diffs against the
 * files on disk (exit code 1 on any difference) without writing.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { canonicalJson } from "./canonical-json.ts";
import { compile, serializeCompileResult } from "./compile.ts";
import { loadOverlay, loadStudioDomain } from "./load.ts";
import type { CompilerOverlay } from "./types.ts";

const USAGE = `usage: ontology-compile --source <dir> --tenant <slug> [--overlay <file>] [--out <dir>] [--check]

  --source   allmetaOntology dist/ export (studio-models/ + transform-maps/)
  --tenant   tenant slug, e.g. power-scm (output dir <out>/<tenant>-v1/)
  --overlay  compiler overlay JSON (emissions, rule gates, forms, tool args)
  --out      output root (default: models/)
  --check    compile in memory and diff against <out>/<tenant>-v1/; no writes
`;

export interface CliIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

export async function runCli(
  argv: string[],
  io: CliIo = { log: console.log, error: console.error },
): Promise<number> {
  let values: {
    source?: string;
    tenant?: string;
    overlay?: string;
    out?: string;
    check?: boolean;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        source: { type: "string" },
        tenant: { type: "string" },
        overlay: { type: "string" },
        out: { type: "string", default: "models" },
        check: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    io.error(`ontology-compile: ${(error as Error).message}`);
    io.error(USAGE);
    return 2;
  }

  if (values.help) {
    io.log(USAGE);
    return 0;
  }
  if (!values.source || !values.tenant) {
    io.error("ontology-compile: --source and --tenant are required");
    io.error(USAGE);
    return 2;
  }

  try {
    const model = loadStudioDomain(values.source);
    const overlay = (values.overlay ? loadOverlay(values.overlay) : {}) as CompilerOverlay;
    const result = compile(model, overlay, { tenant: values.tenant });
    const files = serializeCompileResult(result);
    const outDir = path.resolve(values.out ?? "models", `${values.tenant}-v1`);

    if (values.check) {
      let differences = 0;
      for (const [fileName, value] of files) {
        const target = path.join(outDir, fileName);
        const expected = canonicalJson(value);
        if (!existsSync(target)) {
          io.error(`MISSING  ${target}`);
          differences += 1;
          continue;
        }
        const actual = readFileSync(target, "utf8");
        if (actual === expected) {
          io.log(`OK       ${target}`);
        } else {
          io.error(`DIFFERS  ${target}`);
          differences += 1;
        }
      }
      if (differences) {
        io.error(`ontology-compile --check: ${differences} file(s) out of date; rerun without --check to update`);
        return 1;
      }
      io.log("ontology-compile --check: outputs are up to date");
      return 0;
    }

    mkdirSync(outDir, { recursive: true });
    for (const [fileName, value] of files) {
      const target = path.join(outDir, fileName);
      writeFileSync(target, canonicalJson(value), "utf8");
      io.log(`WROTE    ${target}`);
    }
    io.log(
      `ontology-compile: ${result.workflow.length} agents, ${result.erpOperations.length} ERP operations → ${outDir}`,
    );
    return 0;
  } catch (error) {
    io.error(`ontology-compile: ${(error as Error).message}`);
    return 1;
  }
}
