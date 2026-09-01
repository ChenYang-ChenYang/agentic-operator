import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCHEMA_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../schemas/3.2.0",
);

const UPSTREAM_FILE_HASHES = {
  "actions.schema.json":
    "6c9036feb8232141af2d3978b923a42a59feb502020987d0691a4509ac710fae",
  "common.schema.json":
    "cb6bf9335efd6d46e1f21cc2658786f6d4993d6d3839ffc2ddfb872d9b3e4d42",
  "events.schema.json":
    "ef5cde4ac4f4f7cebcf8955231c2b5ab7420013ed869dbbf0fe7565e11b68238",
  "links.schema.json":
    "550e0bbf943fb8c683564c8e7024ee896e13d7337ba0398a5c781bae9e0f945e",
  "objects.schema.json":
    "3f953e8e68cc8c85709fbfbb8acaa44ec9721f951fe48fcc88a9edaba581c4a7",
  "ontology-template-package-manifest.schema.json":
    "1fbd4895623d5abfe118e1d887aa64e58d6f42cb57ee37e09bf90a758c31447a",
  "ontology-template-package.schema.json":
    "340458399d7521376f0d80fcb81fe27876f983a401ca603f16fd862860fb9fec",
  "rules.schema.json":
    "c5b2fcfbe87bad1abcde745082da887f6d0a45f46681bb0b054c07edac76e0ba",
  "workflows.schema.json":
    "5be951f5882b680cbf09af8054aaa7e8244b1880d4e4d0ce17aa02d3d41e6cb4",
} as const;

describe("vendored OntoPlanet ontology schema bundle", () => {
  it("matches every canonical 3.2.0 schema digest in the upstream bundle manifest", () => {
    for (const [filename, expectedHash] of Object.entries(
      UPSTREAM_FILE_HASHES,
    )) {
      const actualHash = createHash("sha256")
        .update(readFileSync(path.join(SCHEMA_ROOT, filename)))
        .digest("hex");
      expect(actualHash, filename).toBe(expectedHash);
    }
  });
});
