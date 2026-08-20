/**
 * loadStudioDomain(sourceDir) — read an allmetaOntology `dist/` export into a
 * typed model. Expected layout (design G1):
 *
 *   <sourceDir>/studio-models/<namespace>/<domainId>/{actions,events,objects,rules,workflows}_v*.json
 *   <sourceDir>/transform-maps/transform-maps.json
 *
 * File-family resolution prefers `_LATEST` snapshots, else the
 * lexicographically highest versioned file — deterministic for a fixed tree.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type {
  StudioAction,
  StudioDomainModel,
  StudioEvent,
  StudioObject,
  StudioRule,
  StudioWorkflow,
  TransformMaps,
} from "./types.ts";

function fail(message: string): never {
  throw new Error(`[ontology-compiler] ${message}`);
}

function readJson(filePath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`cannot read ${filePath}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`invalid JSON in ${filePath}: ${(error as Error).message}`);
  }
}

function isDir(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** Find the single studio domain directory under `<sourceDir>/studio-models`. */
function resolveDomainDir(sourceDir: string): string {
  const root = path.join(sourceDir, "studio-models");
  if (!isDir(root)) fail(`missing studio-models directory under ${sourceDir}`);
  const domains: string[] = [];
  for (const ns of readdirSync(root).sort()) {
    const nsDir = path.join(root, ns);
    if (!isDir(nsDir)) continue;
    for (const domain of readdirSync(nsDir).sort()) {
      const domainDir = path.join(nsDir, domain);
      if (isDir(domainDir)) domains.push(domainDir);
    }
  }
  if (domains.length === 0) fail(`no domain directory under ${root}`);
  if (domains.length > 1) {
    fail(`expected exactly one domain under ${root}, found: ${domains.join(", ")}`);
  }
  return domains[0]!;
}

/** Pick the newest file of a family: `<family>_v*_LATEST.json` wins, else the
 * lexicographically last `<family>_v*.json`. */
function resolveFamilyFile(domainDir: string, family: string): string {
  const files = readdirSync(domainDir)
    .filter((file) => file.startsWith(`${family}_v`) && file.endsWith(".json"))
    .sort();
  if (!files.length) fail(`no ${family}_v*.json in ${domainDir}`);
  const latest = files.filter((file) => file.toUpperCase().includes("LATEST"));
  const chosen = latest.length ? latest[latest.length - 1]! : files[files.length - 1]!;
  return path.join(domainDir, chosen);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be a JSON array`);
  return value;
}

export function loadStudioDomain(sourceDir: string): StudioDomainModel {
  const resolvedSource = path.resolve(sourceDir);
  if (!isDir(resolvedSource)) fail(`source directory not found: ${resolvedSource}`);
  const domainDir = resolveDomainDir(resolvedSource);
  const domainId = path.basename(domainDir);

  const rawActions = readJson(resolveFamilyFile(domainDir, "actions"));
  const actions = asArray(rawActions, "actions file") as StudioAction[];

  const eventsEnvelope = asRecord(readJson(resolveFamilyFile(domainDir, "events")), "events file");
  const events = asArray(eventsEnvelope.events, "events file .events") as StudioEvent[];

  const objectsEnvelope = asRecord(readJson(resolveFamilyFile(domainDir, "objects")), "objects file");
  const objects = asArray(objectsEnvelope.payload, "objects file .payload") as StudioObject[];

  const rulesEnvelope = asRecord(readJson(resolveFamilyFile(domainDir, "rules")), "rules file");
  const rules = asArray(rulesEnvelope.payload, "rules file .payload") as StudioRule[];

  const workflowsEnvelope = asRecord(
    readJson(resolveFamilyFile(domainDir, "workflows")),
    "workflows file",
  );
  const workflows = asArray(workflowsEnvelope.workflows, "workflows file .workflows") as StudioWorkflow[];

  const transformMapsPath = path.join(resolvedSource, "transform-maps", "transform-maps.json");
  const transformMaps = asRecord(readJson(transformMapsPath), "transform-maps.json") as unknown as TransformMaps;
  asArray(transformMaps.object_maps, "transform-maps.json .object_maps");
  asArray(transformMaps.action_maps, "transform-maps.json .action_maps");

  for (const action of actions) {
    if (!action || typeof action !== "object" || typeof action.id !== "string" || !action.id) {
      fail("every ontology action requires a string id");
    }
    if (!action.implementation || typeof action.implementation.kind !== "string") {
      fail(`action ${action.id} is missing implementation.kind`);
    }
  }

  return {
    domainId,
    actions,
    events,
    objects,
    rules,
    workflows,
    transformMaps,
    raw: {
      actions: rawActions,
      events: { metadata: eventsEnvelope.metadata, events },
      objects: { metadata: objectsEnvelope.metadata, payload: objects },
      rules: { metadata: rulesEnvelope.metadata, payload: rules },
    },
  };
}

export function loadOverlay(overlayPath: string): Record<string, unknown> {
  return asRecord(readJson(path.resolve(overlayPath)), `overlay ${overlayPath}`);
}
