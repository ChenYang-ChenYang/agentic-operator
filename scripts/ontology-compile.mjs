#!/usr/bin/env node
/**
 * Ontology→manifest compiler CLI (design G1 item 5).
 *
 *   pnpm ontology:compile -- --source <allmetaOntology dist dir> --tenant power-scm \
 *     [--overlay overlays/power-scm.json] [--out models/] [--check]
 *
 * The library lives in packages/ontology-compiler (TypeScript, dependency-free)
 * and is imported here via a relative path so Node's native type stripping
 * applies (bare workspace specifiers resolve through node_modules, where type
 * stripping is disabled).
 */

import { runCli } from "../packages/ontology-compiler/src/cli.ts";

// pnpm forwards the `--` separator literally; drop it before option parsing.
const argv = process.argv.slice(2).filter((arg, index) => !(arg === "--" && index === 0));

process.exitCode = await runCli(argv);
