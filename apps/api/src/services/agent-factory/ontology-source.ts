// ManifestOntologySource — the OntologySource port for the new arch.
//
// The new monorepo dropped Neo4j/Allmeta; a domain's ontology lives as JSON under
// models/<slug>-v<n>/ (actions[-_]v<N>.json, events_v*.json, objects_v*.json,
// rules_v*.json, workflow_v*.json). This reads those files directly and maps them to
// the factory's DomainOntology / OntologyAction shape. Strict: a missing/empty domain
// throws (the factory must not hallucinate against a stub).

import fs from "node:fs";
import path from "node:path";
import type {
  OntologySource,
  DomainOntology,
  OntologyAction,
  OntologyObject,
  OntologyEvent,
  OntologyRule,
} from "@agentic/agent-factory";
import { resolveModelsRoot as resolveConfiguredModelsRoot } from "@agentic/runtime";
import type { OntologyTransportDescriptor } from "./ontology-transport-descriptor";

function resolveModelsRoot(): string {
  const root = resolveConfiguredModelsRoot();
  if (!root)
    throw new Error(
      "AGENTIC_MODELS_DIR is not configured and no Agentic Operator workspace root was found",
    );
  return root;
}

/** Strip a trailing version suffix from a local legacy folder identity. */
const tenantSlugFromFolder = (folder: string): string =>
  folder.toLowerCase().replace(/-v\d+(\.\d+)*$/i, "");

/** Pick the highest-versioned `base[-_]v<N>.json` (handles both hyphen + underscore
 *  naming present in models/), falling back to `base.json`. */
function pickVersioned(dir: string, base: string): string | null {
  let best: { n: number; file: string } | null = null;
  let plain: string | null = null;
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const re = new RegExp(`^${base}[-_]v(\\d+)\\.json$`, "i");
  for (const f of files) {
    if (f === `${base}.json`) plain = path.join(dir, f);
    const m = f.match(re);
    if (m) {
      const n = Number(m[1]);
      if (!best || n > best.n) best = { n, file: path.join(dir, f) };
    }
  }
  return best?.file ?? plain;
}

function readJson(file: string | null): unknown {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Pull the inner array out of `{<key>:[...]}` / `{payload:[...]}` / `{events:[...]}` / a bare array. */
function unwrap(raw: unknown, key: string): Record<string, unknown>[] {
  if (raw == null) return [];
  let list: unknown[] | undefined;
  if (Array.isArray(raw)) list = raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj[key])) list = obj[key] as unknown[];
  }
  if (list) {
    if (
      list.some(
        (entry) => !entry || typeof entry !== "object" || Array.isArray(entry),
      )
    ) {
      throw new Error(`ontology ${key}[] entries must be objects`);
    }
    return list as Record<string, unknown>[];
  }
  throw new Error(
    `ontology JSON must be an array or an object containing ${key}[]`,
  );
}

function asStrArr(v: unknown, field: string): string[] {
  if (v == null || v === "") return [];
  const values = Array.isArray(v) ? v : [v];
  return values.map((value, index) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${field}[${index}] must be a non-empty string`);
    }
    return value.trim();
  });
}

function optionalObjectArray(
  value: unknown,
  field: string,
): Array<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (
    value.some(
      (entry) => !entry || typeof entry !== "object" || Array.isArray(entry),
    )
  ) {
    throw new Error(`${field} entries must be objects`);
  }
  return value as Array<Record<string, unknown>>;
}

function optionalObject(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function toOntologyAction(
  a: Record<string, unknown>,
  index: number,
): OntologyAction {
  const name = typeof a.name === "string" ? a.name.trim() : "";
  if (!name) throw new Error(`actions[${index}].name is required`);
  const id =
    a.id === undefined ? name : typeof a.id === "string" ? a.id.trim() : "";
  if (!id) throw new Error(`actions[${index}].id must be a non-empty string`);
  const actor = asStrArr(a.actor, `actions[${index}].actor`);
  if (!actor.length) throw new Error(`actions[${index}].actor is required`);

  let toolUse: string[];
  if (a.tool_use == null || a.tool_use === "") {
    toolUse = [];
  } else {
    const rawTools = Array.isArray(a.tool_use) ? a.tool_use : [a.tool_use];
    toolUse = rawTools.map((tool, toolIndex) => {
      const value =
        typeof tool === "string"
          ? tool
          : tool && typeof tool === "object" && !Array.isArray(tool)
            ? ((tool as { name?: unknown; id?: unknown }).name ??
              (tool as { id?: unknown }).id)
            : undefined;
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(
          `actions[${index}].tool_use[${toolIndex}] must be a name/id string`,
        );
      }
      return value.trim();
    });
  }

  return {
    id,
    name,
    description: a.description ? String(a.description) : undefined,
    category: a.category ? String(a.category) : undefined,
    actor,
    trigger: asStrArr(a.trigger, `actions[${index}].trigger`),
    triggered_event: asStrArr(
      a.triggered_event,
      `actions[${index}].triggered_event`,
    ),
    target_objects: asStrArr(
      a.target_objects,
      `actions[${index}].target_objects`,
    ),
    // tool_use on disk is Array<{name}> | string[] | "" — normalize to string[].
    tool_use: toolUse,
    system_prompt: String(a.system_prompt ?? ""),
    user_prompt: String(a.user_prompt ?? ""),
    inputs: optionalObjectArray(a.inputs, `actions[${index}].inputs`),
    outputs: optionalObjectArray(a.outputs, `actions[${index}].outputs`),
    submission_criteria: a.submission_criteria
      ? String(a.submission_criteria)
      : undefined,
    side_effects: optionalObject(
      a.side_effects,
      `actions[${index}].side_effects`,
    ),
    // Execution-bearing ontology fields: dropping either makes the factory flatten a real
    // multi-step action into a prompt-only shell and loses declared external/data-store edges.
    action_steps: optionalObjectArray(
      a.action_steps,
      `actions[${index}].action_steps`,
    ),
    integration: optionalObject(a.integration, `actions[${index}].integration`),
  };
}

export class ManifestOntologySource implements OntologySource {
  constructor(private readonly root: string = resolveModelsRoot()) {}

  /** Self-description for resolution provenance. `configured` is MEASURED: a
   *  manifest transport only "would have answered" for a domain that actually
   *  has a published local folder. */
  async describeTransport(
    domainId: string,
  ): Promise<OntologyTransportDescriptor> {
    return {
      kind: "manifest",
      configured: (await this.listDomains()).some((d) => d.id === domainId),
    };
  }

  private folders(): string[] {
    return fs
      .readdirSync(this.root)
      .filter((f) => {
        if (f.startsWith(".")) return false;
        try {
          return fs.statSync(path.join(this.root, f)).isDirectory();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      })
      .sort();
  }

  /** Build the one-to-one public-id → folder identity map.
   *
   * Directory versions are an implementation detail, while `tenantSlugFromFolder`
   * is the persisted domain identity. If two folders collapse to the same id
   * (for example two differently versioned folders with the same base id), choosing the first `readdir` result
   * would make bindings resolve differently across machines/deploys. Reject the
   * catalog instead of publishing an identity we cannot resolve uniquely.
   */
  private canonicalFolders(): Array<{ id: string; folder: string }> {
    const byId = new Map<string, string>();
    for (const folder of this.folders()) {
      const id = tenantSlugFromFolder(folder);
      const previous = byId.get(id);
      if (previous) {
        throw new Error(
          `本体目录身份冲突：${previous} 与 ${folder} 都映射为「${id}」。请只保留一个 canonical domain 目录。`,
        );
      }
      byId.set(id, folder);
    }
    return [...byId].map(([id, folder]) => ({ id, folder }));
  }

  private folderFor(domainId: string): string | null {
    // listDomains() publishes tenantSlugFromFolder(folder) as the canonical id.
    // Runtime fetches must use that exact id; accepting folder names, casing or
    // version aliases here would silently remap a persisted binding.
    return (
      this.canonicalFolders().find((entry) => entry.id === domainId)?.folder ??
      null
    );
  }

  async listDomains() {
    return (
      this.canonicalFolders()
        .map(({ id, folder }) => {
          const dir = path.join(this.root, folder);
          const actions = unwrap(
            readJson(pickVersioned(dir, "actions")),
            "actions",
          );
          const events = unwrap(
            readJson(pickVersioned(dir, "events")),
            "events",
          );
          const objects = unwrap(
            readJson(pickVersioned(dir, "objects")),
            "payload",
          );
          const rules = unwrap(
            readJson(pickVersioned(dir, "rules")),
            "payload",
          );
          const workflow = unwrap(
            readJson(pickVersioned(dir, "workflow")),
            "agents",
          );
          return {
            id,
            name: folder,
            counts: {
              actions: actions.length,
              events: events.length,
              objects: objects.length,
              rules: rules.length,
              workflow: workflow.length,
            },
            source: "manifest" as const,
          };
        })
        // Hide DEPLOYMENT ARTIFACTS from the factory picker (they're not ontology SOURCES):
        //   · `-sb` = throwaway sandbox tenants (each sandbox_run writes a new workflow_vN.json).
        //   · ontology-LESS folders = a PROMOTED workflow (only workflow*.json, no actions/events/
        //     objects/rules) — e.g. `agents-generation-v1`, which otherwise shadows live Allmeta
        //     an exact live Allmeta domain in BOTH listDomains AND composite routing.
        // A real local legacy ontology folder has at least one source list, so it remains available
        // only to the migration-only `auto` binding path.
        .filter(
          (d) =>
            !/-sb$/.test(d.id) &&
            d.counts.actions +
              d.counts.events +
              d.counts.objects +
              d.counts.rules >
              0,
        )
    );
  }

  async fetchOntology(domainId: string): Promise<DomainOntology> {
    const folder = this.folderFor(domainId);
    if (!folder)
      throw new Error(
        `本体源里找不到业务域「${domainId}」——models/ 下没有匹配的目录。`,
      );
    const dir = path.join(this.root, folder);

    const actions = unwrap(
      readJson(pickVersioned(dir, "actions")),
      "actions",
    ).map(toOntologyAction);
    if (!actions.length)
      throw new Error(
        `业务域「${domainId}」没有可用的动作定义——不生成空壳（避免幻觉）。`,
      );

    const objects = unwrap(
      readJson(pickVersioned(dir, "objects")),
      "payload",
    ) as unknown as OntologyObject[];
    const events = unwrap(
      readJson(pickVersioned(dir, "events")),
      "events",
    ) as unknown as OntologyEvent[];
    const rules = unwrap(
      readJson(pickVersioned(dir, "rules")),
      "payload",
    ) as unknown as OntologyRule[];
    const workflow = unwrap(readJson(pickVersioned(dir, "workflow")), "agents");
    return {
      domainId,
      objects,
      rules,
      actions,
      events,
      workflow,
      source: "snapshot",
    };
  }

  async fetchActionRules(
    domainId: string,
    actionName: string,
  ): Promise<unknown[]> {
    const folder = this.folderFor(domainId);
    if (!folder)
      throw new Error(
        `本体源里找不到业务域「${domainId}」，无法读取 action rules。`,
      );
    const dir = path.join(this.root, folder);
    const actions = unwrap(readJson(pickVersioned(dir, "actions")), "actions");
    const action = actions.find((a) => a.name === actionName);
    if (!action) {
      throw new Error(
        `业务域「${domainId}」没有动作「${actionName}」，无法读取 action rules。`,
      );
    }
    // Preferred: rules nested under the action's steps.
    if (action && Array.isArray(action.action_steps)) {
      return (action.action_steps as Array<Record<string, unknown>>).flatMap(
        (s) => (Array.isArray(s.rules) ? (s.rules as unknown[]) : []),
      );
    }
    // Fallback: rules_v*.json, prefix-matched on the hierarchical id (action "3" owns "3-1"…).
    if (action.id) {
      const rules = unwrap(readJson(pickVersioned(dir, "rules")), "payload");
      return rules.filter(
        (r) =>
          typeof r?.id === "string" &&
          (r.id as string).startsWith(`${String(action.id)}-`),
      );
    }
    return [];
  }
}
