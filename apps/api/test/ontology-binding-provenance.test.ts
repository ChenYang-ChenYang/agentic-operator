import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DomainOntology, OntologySource } from "@agentic/agent-factory";
import {
  UploadedFirstOntologySource,
  UploadedOntologySource,
} from "../src/services/agent-factory/uploaded-ontology-source";
import { FsUploadedOntologyStore } from "../src/services/agent-factory/uploaded-ontology-store";
import type { OntologyTransportDescriptor } from "../src/services/agent-factory/ontology-transport-descriptor";

const oldDataRoot = process.env.AGENTIC_DATA_ROOT;
const roots: string[] = [];

function authoritative(source: DomainOntology["source"]): OntologySource {
  return {
    async listDomains() {
      return [{ id: "Agents-generation", name: "Agents generation" }];
    },
    async fetchOntology(domainId) {
      return {
        domainId,
        source,
        actions: [{ id: "remote", name: "remoteAction", actor: ["Agent"] }],
        events: [],
        objects: [],
        rules: [],
        workflow: [],
      };
    },
    async fetchActionRules() {
      return [{ id: "remote-rule" }];
    },
  };
}

/** A base source that can honestly describe which concrete transport it is. */
function describableBase(
  kind: "allmeta" | "manifest",
  configured: boolean,
): OntologySource & {
  describeTransport(domainId: string): Promise<OntologyTransportDescriptor>;
} {
  return {
    ...authoritative(kind === "allmeta" ? "allmeta" : "snapshot"),
    async describeTransport() {
      return { kind, configured };
    },
  };
}

async function tempRootWithUpload(
  tenant: string,
  domain: string,
): Promise<FsUploadedOntologyStore> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-resolution-"));
  roots.push(root);
  process.env.AGENTIC_DATA_ROOT = root;
  const store = new FsUploadedOntologyStore();
  await store.save(
    tenant,
    "uploaded bundle",
    { actions: [{ id: "uploaded", name: "uploadedAction", actor: ["Agent"] }] },
    domain,
  );
  return store;
}

afterEach(() => {
  if (oldDataRoot === undefined) delete process.env.AGENTIC_DATA_ROOT;
  else process.env.AGENTIC_DATA_ROOT = oldDataRoot;
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("ontology resolution provenance (describeResolution)", () => {
  const domain = "Agents-generation";

  it("reports the upload side when an upload binding pinned it, and never calls it shadowing", async () => {
    const tenant = "tenant-strict-upload";
    const store = await tempRootWithUpload(tenant, domain);
    const source = new UploadedFirstOntologySource(
      new UploadedOntologySource(tenant, store),
      describableBase("allmeta", true),
      domain,
    );

    expect(await source.describeResolution(domain)).toEqual({
      servedBy: "upload",
      shadowed: false,
      base: null,
    });
  });

  it("reports the base side when an explicit catalog binding pinned it, even with a same-id upload present", async () => {
    const tenant = "tenant-strict-base";
    const store = await tempRootWithUpload(tenant, domain);
    const source = new UploadedFirstOntologySource(
      new UploadedOntologySource(tenant, store),
      describableBase("allmeta", true),
      undefined,
      domain,
    );

    expect(await source.describeResolution(domain)).toEqual({
      servedBy: "base",
      shadowed: false,
      base: { kind: "allmeta", configured: true },
    });
  });

  it("flags shadowing when an unbound upload wins over a configured live base", async () => {
    const tenant = "tenant-unbound-upload";
    const store = await tempRootWithUpload(tenant, domain);
    const source = new UploadedFirstOntologySource(
      new UploadedOntologySource(tenant, store),
      describableBase("allmeta", true),
    );

    expect(await source.describeResolution(domain)).toEqual({
      servedBy: "upload",
      shadowed: true,
      base: { kind: "allmeta", configured: true },
    });
    // The reported side must match the side that actually serves.
    expect((await source.fetchOntology(domain)).actions[0]?.name).toBe(
      "uploadedAction",
    );
  });

  it("does not call it shadowing when the base transport is not configured", async () => {
    const tenant = "tenant-unbound-upload-no-base";
    const store = await tempRootWithUpload(tenant, domain);
    const source = new UploadedFirstOntologySource(
      new UploadedOntologySource(tenant, store),
      describableBase("allmeta", false),
    );

    expect(await source.describeResolution(domain)).toEqual({
      servedBy: "upload",
      shadowed: false,
      base: { kind: "allmeta", configured: false },
    });
  });

  it("reports the base transport when no upload exists for an unbound domain", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-resolution-"));
    roots.push(root);
    process.env.AGENTIC_DATA_ROOT = root;
    const source = new UploadedFirstOntologySource(
      new UploadedOntologySource("tenant-no-upload", new FsUploadedOntologyStore()),
      describableBase("manifest", true),
    );

    expect(await source.describeResolution(domain)).toEqual({
      servedBy: "base",
      shadowed: false,
      base: { kind: "manifest", configured: true },
    });
  });

  it("says it cannot name a base that does not describe itself, instead of guessing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-resolution-"));
    roots.push(root);
    process.env.AGENTIC_DATA_ROOT = root;
    const source = new UploadedFirstOntologySource(
      new UploadedOntologySource("tenant-opaque-base", new FsUploadedOntologyStore()),
      authoritative("allmeta"),
    );

    expect(await source.describeResolution(domain)).toEqual({
      servedBy: "base",
      shadowed: false,
      base: null,
    });
  });
});

describe("ontology binding provenance", () => {
  it("keeps an explicit Allmeta binding authoritative over a later same-id upload", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "factory-binding-source-"),
    );
    roots.push(root);
    process.env.AGENTIC_DATA_ROOT = root;
    const tenant = "tenant-source-test";
    const domain = "Agents-generation";
    const store = new FsUploadedOntologyStore();
    await store.save(
      tenant,
      "same id upload",
      {
        actions: [{ id: "uploaded", name: "uploadedAction", actor: ["Agent"] }],
      },
      domain,
    );

    const source = new UploadedFirstOntologySource(
      new UploadedOntologySource(tenant, store),
      authoritative("allmeta"),
      undefined,
      domain,
    );

    expect((await source.fetchOntology(domain)).source).toBe("allmeta");
    expect((await source.fetchOntology(domain)).actions[0]?.name).toBe(
      "remoteAction",
    );
    expect(await source.fetchActionRules(domain, "remoteAction")).toEqual([
      { id: "remote-rule" },
    ]);
  });

  it("never falls an upload binding through to a same-id authoritative domain", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "factory-binding-source-"),
    );
    roots.push(root);
    process.env.AGENTIC_DATA_ROOT = root;
    const domain = "Agents-generation";
    const source = new UploadedFirstOntologySource(
      new UploadedOntologySource(
        "tenant-with-missing-upload",
        new FsUploadedOntologyStore(),
      ),
      authoritative("allmeta"),
      domain,
    );

    await expect(source.fetchOntology(domain)).rejects.toThrow(
      /上传的本体里找不到/,
    );
    await expect(
      source.fetchActionRules(domain, "remoteAction"),
    ).rejects.toThrow(/上传的本体里找不到/);
  });

  it("keeps a valid upload binding readable when the unrelated base catalog is offline", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "factory-binding-source-"),
    );
    roots.push(root);
    process.env.AGENTIC_DATA_ROOT = root;
    const tenant = "tenant-upload-isolation";
    const domain = "RAAS-v1";
    const store = new FsUploadedOntologyStore();
    await store.save(
      tenant,
      "RAAS-v1",
      {
        actions: [{ id: "screen", name: "screenCandidate", actor: ["Agent"] }],
      },
      domain,
    );
    const unavailableBase: OntologySource = {
      async listDomains() {
        throw new Error("Allmeta is offline");
      },
      async fetchOntology() {
        throw new Error("Allmeta is offline");
      },
      async fetchActionRules() {
        throw new Error("Allmeta is offline");
      },
    };
    const source = new UploadedFirstOntologySource(
      new UploadedOntologySource(tenant, store),
      unavailableBase,
      domain,
    );

    expect(await source.listDomains()).toEqual([
      expect.objectContaining({
        id: domain,
        name: "RAAS-v1（上传）",
        source: "upload",
      }),
    ]);
    expect((await source.fetchOntology(domain)).actions[0]?.name).toBe(
      "screenCandidate",
    );
  });

  it("decorates the uploaded marker idempotently (no compounded （上传）（上传）)", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "factory-binding-source-"),
    );
    roots.push(root);
    process.env.AGENTIC_DATA_ROOT = root;
    const tenant = "tenant-marker-test";
    const store = new FsUploadedOntologyStore();
    // A clean name gets exactly one marker; an already-decorated (or doubly
    // decorated) stored name is normalized back to exactly one — so a re-upload
    // that echoed the display name back can never keep compounding.
    await store.save(
      tenant,
      "Clean Domain",
      { actions: [{ name: "a", actor: ["Agent"] }] },
      "clean",
    );
    await store.save(
      tenant,
      "Once（上传）",
      { actions: [{ name: "b", actor: ["Agent"] }] },
      "once",
    );
    await store.save(
      tenant,
      "Twice（上传）（上传）",
      { actions: [{ name: "c", actor: ["Agent"] }] },
      "twice",
    );

    const names = new Map(
      (await new UploadedOntologySource(tenant, store).listDomains()).map(
        (d) => [d.id, d.name],
      ),
    );
    expect(names.get("clean")).toBe("Clean Domain（上传）");
    expect(names.get("once")).toBe("Once（上传）");
    expect(names.get("twice")).toBe("Twice（上传）");
    for (const name of names.values())
      expect(name).not.toContain("（上传）（上传）");
  });
});
