#!/usr/bin/env node
/**
 * Safe immutable Ontology Package inspection entry point.
 *
 * Node 26 strips the TypeScript types in the workspace source import.  Keeping
 * the executable as a tiny wrapper makes the package library independently
 * testable and avoids a second implementation of the admission rules.
 */

import { runPackageCli } from "../packages/ontology-compiler/src/package-cli.ts";

const argv = process.argv
  .slice(2)
  .filter((argument, index) => !(argument === "--" && index === 0));

process.exitCode = await runPackageCli(argv);
