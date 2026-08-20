#!/usr/bin/env node

/**
 * Build the reviewed Agents-generation ontology release candidate.
 *
 * Sources of authority:
 *   1. The user's v0_2_001 Action/Object/Rule files.
 *   2. The old six production functions, already reflected in the local
 *      zhaopin v2 execution/event models.
 *   3. The live Agents-generation Rules read through AllmetaOntology HTTP.
 *
 * This compiler never writes Allmeta/Neo4j. It produces a deterministic,
 * reviewable bundle which must pass Factory readiness before the separately
 * authorised Allmeta exact-domain release endpoint may consume it.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoAllmetaStorageMetadata,
  parseDotEnv,
} from "./allmeta-full-domain-release-client.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const domainId = "Agents-generation";
const version = "v0_4_001";
const generatedAt = "2026-07-30T00:00:00.000+08:00";
const outputDir = path.join(repoRoot, "artifacts", "ontology", domainId, version);

const sourcePaths = {
  actions: process.env.AGENTS_GENERATION_ACTIONS_SOURCE
    ?? "/Users/yuhancheng/Desktop/neo4j数据/standard/actions_v0_2_001.json",
  objects: process.env.AGENTS_GENERATION_OBJECTS_SOURCE
    ?? "/Users/yuhancheng/Desktop/neo4j数据/standard/objects_v0_2_001.json",
  rules: process.env.AGENTS_GENERATION_RULES_SOURCE
    ?? "/Users/yuhancheng/Desktop/neo4j数据/standard/rules_v0_2_001.json",
  actionScaffold: path.join(repoRoot, "models", "zhaopin-v1", "actions_v2.json"),
  eventScaffold: path.join(repoRoot, "models", "zhaopin-v1", "events_v2.json"),
  objectScaffold: path.join(repoRoot, "models", "zhaopin-v1", "objects_v1.json"),
  ruleScaffold: path.join(repoRoot, "models", "zhaopin-v1", "rules_v1.json"),
};

const readJson = async (filename) => JSON.parse(await readFile(filename, "utf8"));
const clone = (value) => structuredClone(value);
const text = (value) => typeof value === "string" ? value.trim() : "";
const refKey = (value) => text(value).normalize("NFKC").toLocaleLowerCase().replace(/[\s_.:/()（）-]+/g, "");
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
};
const digest = (value) => `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
const unique = (values) => [...new Set(values.filter(Boolean))];
const asArray = (value) => Array.isArray(value) ? value : [];
const byId = (rows) => new Map(rows.map((row) => [text(row.id), row]));

function sanitizeLiveReviewedDefinition(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  let definition = clone(value);
  if (typeof value.__allmeta_definition_json === "string") {
    try {
      definition = JSON.parse(value.__allmeta_definition_json);
    } catch {
      throw new Error(`${label} has malformed __allmeta_definition_json`);
    }
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new Error(`${label} __allmeta_definition_json must contain an object`);
    }
    const graphId = text(value.id);
    const definitionId = text(definition.id);
    if (graphId && definitionId && graphId !== definitionId) {
      throw new Error(`${label} graph id disagrees with its reviewed definition`);
    }
    if (graphId && !definitionId) definition.id = graphId;
  }

  const clean = (current, currentLabel) => {
    if (Array.isArray(current)) {
      return current.map((item, index) => clean(item, `${currentLabel}[${index}]`));
    }
    if (!current || typeof current !== "object") return current;
    const output = {};
    for (const [key, item] of Object.entries(current)) {
      if (key.startsWith("__allmeta_") || key === "source_file") continue;
      if (key.endsWith("_json")) {
        const logicalKey = key.slice(0, -"_json".length);
        if (Object.hasOwn(current, logicalKey)) continue;
        if (typeof item !== "string") {
          throw new Error(`${currentLabel}.${key} must contain JSON text`);
        }
        try {
          output[logicalKey] = clean(JSON.parse(item), `${currentLabel}.${logicalKey}`);
        } catch (error) {
          if (error instanceof SyntaxError) {
            throw new Error(`${currentLabel}.${key} contains malformed JSON`);
          }
          throw error;
        }
        continue;
      }
      output[key] = clean(item, `${currentLabel}.${key}`);
    }
    return output;
  };

  const sanitized = clean(definition, label);
  assertNoAllmetaStorageMetadata(sanitized, label);
  return sanitized;
}

async function fetchLiveRules() {
  // This flag exists only for deterministic local/compiler tests.  It must
  // bypass credential discovery as well as HTTP: a developer machine can have
  // a valid Allmeta token while its test sandbox is intentionally denied local
  // network access.  The resulting bundle is stamped releasable:false and the
  // release client rejects it before issuing any request.
  if (process.env.ALLOW_OFFLINE_LIVE_RULES === "1") return [];
  const envFile = text(process.env.ALLMETA_ENV_FILE)
    || "/Users/yuhancheng/allmetaOntology/.env.local";
  let fileEnv = {};
  try {
    fileEnv = parseDotEnv(await readFile(envFile, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const baseUrl = text(process.env.ALLMETA_BASE_URL || fileEnv.ALLMETA_BASE_URL)
    || "http://localhost:3500";
  const token = text(
    process.env.ALLMETA_API_KEY
    || process.env.ONTOLOGY_API_TOKEN
    || fileEnv.ONTOLOGY_API_TOKEN
    || fileEnv.ALLMETA_API_KEY,
  );
  if (!token) throw new Error("ALLMETA_API_KEY/ONTOLOGY_API_TOKEN is required to ground the release in live Rules");
  const url = new URL("/api/v1/ontology/rules", baseUrl);
  url.searchParams.set("domain", domainId);
  url.searchParams.set("limit", "500");
  let response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(
      `Allmeta Rules API at ${url.origin} is unreachable; no release bundle was updated. ${String(error?.cause?.code ?? error?.message ?? error)}`,
    );
  }
  if (!response.ok) throw new Error(`Allmeta Rules read failed: HTTP ${response.status}`);
  const body = await response.json();
  const items = Array.isArray(body) ? body : body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Allmeta returned no live Rules for Agents-generation");
  }
  return items;
}

function buildObjects(baseDocument, scaffoldDocument) {
  const objects = clone(baseDocument.objects ?? []);
  const existing = byId(objects);
  const businessExtras = new Set([
    "Requirement_Clarification_Record",
    "Resume_Upload",
    "Candidate_Identity_Result",
    "Rule_Check_Audit",
    "Interview_Invitation",
  ]);
  for (const object of scaffoldDocument.payload ?? []) {
    if (businessExtras.has(object.id) && !existing.has(object.id)) {
      const next = clone(object);
      objects.push(next);
      existing.set(next.id, next);
    }
  }

  const job = existing.get("Job_Requisition");
  if (!job) throw new Error("Job_Requisition is required");
  let threshold = asArray(job.properties).find((property) => property.name === "resume_match_score_threshold");
  if (!threshold) {
    threshold = {
      name: "resume_match_score_threshold",
      type: "Float",
      description: "简历匹配进入面试审批的阈值；由本体/租户配置提供，运行时代码不得内置常量。",
    };
    job.properties.push(threshold);
  }
  Object.assign(threshold, {
    type: "Float",
    default: 40,
    unit: "percent",
    is_required: true,
    required: true,
    nullable: false,
  });

  const identity = existing.get("Candidate_Identity_Result");
  if (!identity) throw new Error("Candidate_Identity_Result is required");
  const identityProperties = asArray(identity.properties);
  const renameProperty = (from, to) => {
    const property = identityProperties.find((candidate) => candidate.name === from);
    if (!property) return;
    property.name = to;
    property.aliases = unique([...(property.aliases ?? []), from]);
  };
  renameProperty("matched_rule_id", "matched_rule");
  renameProperty("needs_review", "needs_human_review");
  if (!identityProperties.some((property) => property.name === "upload_id")) {
    identityProperties.push({
      name: "upload_id",
      type: "String",
      description: "触发身份检查的简历上传编号。",
      is_foreign_key: true,
      references: "Resume_Upload",
    });
  }
  if (!identityProperties.some((property) => property.name === "pool_size")) {
    identityProperties.push({ name: "pool_size", type: "Integer", description: "本次去重实际比较的候选人数量。" });
  }

  for (const object of objects) {
    const pk = text(object.primary_key);
    const pkProperty = asArray(object.properties).find((property) => refKey(property.name) === refKey(pk));
    if (!pk || !pkProperty) throw new Error(`DataObject ${object.id} has no resolvable primary key property`);
    Object.assign(pkProperty, { is_required: true, required: true, nullable: false });
    for (const property of asArray(object.properties)) {
      if (!property.name || !property.type) throw new Error(`DataObject ${object.id} has an incomplete property`);
      if (property.is_foreign_key === true && !existing.has(text(property.references))) {
        throw new Error(`DataObject ${object.id}.${property.name} references missing ${property.references}`);
      }
    }
  }
  return objects;
}

const inheritedRuleFields = [
  "submissionCriteria",
  "businessBackgroundReason",
  "ruleSource",
  "applicableClient",
  "applicableDepartment",
  "relatedEntities",
  "specificScenarioStage",
  "enforcementLevel",
  "failurePolicy",
];
const semanticDriftRules = new Set(["27-5", "10-35", "15-17", "15-34", "30-4"]);
const proseOnlyRules = new Set([
  "2-5", "8-3", "8-12", "8-17", "9-2", "10-19", "10-20",
  "15-45", "10-46", "10-50", "17-4", "28-3", "28-4",
]);
const supplementalRuleIds = ["4-2", "4-3", "4-4", "9-14", "9-15"];

function normalizeRelatedEntities(values, objects) {
  const aliases = new Map();
  for (const object of objects) {
    aliases.set(refKey(object.id), object.id);
    aliases.set(refKey(object.name), object.id);
  }
  const out = [];
  for (const raw of asArray(values)) {
    const value = text(raw);
    const parenthetical = [...value.matchAll(/[（(]([A-Za-z][A-Za-z0-9_]*)[)）]/g)].at(-1)?.[1];
    const resolved = aliases.get(refKey(parenthetical)) ?? aliases.get(refKey(value));
    if (resolved) out.push(resolved);
  }
  return unique(out);
}

function buildRules(userDocument, liveRows, scaffoldDocument, objects) {
  const live = byId(liveRows.map((row, index) =>
    sanitizeLiveReviewedDefinition(row, `live Rules[${index}]`)));
  const scaffold = byId(scaffoldDocument.payload ?? []);
  const rules = [];

  for (const source of userDocument.rules ?? []) {
    const id = text(source.id);
    const prior = live.get(id) ?? scaffold.get(id) ?? {};
    const rule = { id };
    if (!semanticDriftRules.has(id) && !proseOnlyRules.has(id)) {
      for (const field of inheritedRuleFields) {
        if (prior[field] !== undefined) rule[field] = clone(prior[field]);
      }
    } else {
      for (const field of ["applicableClient", "applicableDepartment", "specificScenarioStage", "enforcementLevel", "failurePolicy", "relatedEntities"]) {
        if (prior[field] !== undefined) rule[field] = clone(prior[field]);
      }
    }
    Object.assign(rule, {
      businessLogicRuleName: source.name,
      name: source.name,
      standardizedLogicRule: source.description,
      description: source.description,
      executor: source.executor,
      applicableClient: source.belongsToClient ?? rule.applicableClient ?? "通用",
      applicableDepartment: source.belongsToDepartment ?? rule.applicableDepartment ?? "N/A",
      belongsToClient: source.belongsToClient,
      belongsToDepartment: source.belongsToDepartment,
      sourceVersion: "v0_2_001",
      sourceAuthority: "user_supplied_revision",
    });
    rule.relatedEntities = normalizeRelatedEntities(rule.relatedEntities, objects);

    if (semanticDriftRules.has(id)) {
      rule.revisionDecision = "user_supplied_text_replaces_previous_live_text";
      rule.automationStatus = id === "30-4" ? "needs_human_confirmation" : "approved";
      if (id === "27-5") rule.specificScenarioStage = "简历匹配";
      if (id === "30-4") rule.unresolvedSemantics = ["区间 40–60 是否包含上界 60 尚未定义"];
    } else if (proseOnlyRules.has(id)) {
      rule.automationStatus = "needs_human_confirmation";
      rule.unresolvedSemantics = ["当前只有业务正文，未提供完整机器可执行条件/证据契约"];
    } else {
      rule.automationStatus = "approved";
    }

    if (id === "10-46") {
      Object.assign(rule, {
        specificScenarioStage: "简历匹配",
        enforcementLevel: "mandatory",
        failurePolicy: "block",
        submissionCriteria: "候选人被检测为正编转外包受控状态。",
        relatedEntities: ["Candidate", "Compliance_Document"],
        automationStatus: "approved",
        condition: {
          kind: "evidence_presence",
          when: "candidate.employment_control_status == '正编转外包受控'",
          requiredEvidenceObject: "Compliance_Document",
        },
        effect: "缺少腾讯采购同意回流凭证时持续锁定推荐流程；凭证确认上传后解除锁定。",
        resumeCondition: "已上传并确认腾讯采购部门同意回流的 Compliance_Document。",
        evidenceBasis: "rules_v0_2_001/10-46 user supplied text",
      });
    }
    rules.push(rule);
  }

  for (const id of supplementalRuleIds) {
    if (rules.some((rule) => rule.id === id)) continue;
    const source = live.get(id) ?? scaffold.get(id);
    if (!source) throw new Error(`Required supplemental Rule ${id} is missing from both live Allmeta and scaffold`);
    const rule = clone(source);
    rule.id = id;
    rule.businessLogicRuleName ??= rule.name;
    rule.name ??= rule.businessLogicRuleName;
    rule.standardizedLogicRule ??= rule.description;
    rule.description ??= rule.standardizedLogicRule;
    rule.relatedEntities = normalizeRelatedEntities(rule.relatedEntities, objects);
    rule.automationStatus = "approved";
    rule.sourceAuthority = "live_allmeta_required_by_old6_action_steps";
    rules.push(rule);
  }

  if (rules.length !== 66) throw new Error(`Expected 66 replacement Rules, got ${rules.length}`);
  return rules.sort((left, right) => left.id.localeCompare(right.id, "en", { numeric: true }));
}

function addEventField(event, field) {
  const fields = event.payload.event_data ??= [];
  const existing = fields.find((candidate) => candidate.name === field.name);
  if (existing) Object.assign(existing, field);
  else fields.push(field);
}

function buildEvents(scaffoldDocument) {
  const events = clone(scaffoldDocument.events ?? [])
    .filter((event) => event.name !== "MATCH_PASSED_NO_INTERVIEW");
  const eventMap = new Map(events.map((event) => [event.name, event]));
  for (const event of events) event.payload.source_domain = null;

  const clarification = eventMap.get("CLARIFICATION_READY");
  clarification.payload.source_action = "confirmRequirementClarification";
  clarification.producers = ["confirmRequirementClarification"];

  const resumeDownloaded = eventMap.get("RESUME_DOWNLOADED");
  const employee = resumeDownloaded.payload.event_data.find((field) => field.name === "employee_id");
  if (employee) employee.required = true;

  const identityChecked = eventMap.get("CANDIDATE_IDENTITY_CHECKED");
  addEventField(identityChecked, {
    name: "parsed",
    type: "Object",
    target_object: "Resume",
    required: true,
    description: "供人工复核后重发身份检查的结构化简历；不得靠候选人编号猜回原始解析结果。",
  });
  const checkedUpload = identityChecked.payload.event_data.find((field) => field.name === "upload_id");
  if (checkedUpload) checkedUpload.required = true;

  const passed = eventMap.get("MATCH_RULE_CHECK_PASSED");
  addEventField(passed, {
    name: "resume_match_score_threshold",
    type: "Float",
    target_object: "Job_Requisition",
    required: true,
    description: "从 Job_Requisition 配置透传的面试审批阈值；生成函数只能读取该字段或规则结果，不得使用代码常量。",
  });

  for (const name of ["MATCH_PASSED_NEED_INTERVIEW", "MATCH_FAILED"]) {
    const event = eventMap.get(name);
    addEventField(event, {
      name: "resume_id",
      type: "String",
      target_object: "Resume",
      required: true,
      description: "简历编号，供失败后人工改派重放。",
    });
    addEventField(event, {
      name: "employee_id",
      type: "String",
      target_object: "Employee",
      required: true,
      description: "负责该候选人的招聘员工号，供人工改派后继续规则检查。",
    });
    addEventField(event, {
      name: "overall_match_grade",
      type: "Enum",
      target_object: "Candidate_Match_Result",
      required: true,
      description: "匹配评级 A/B/C/D/未评级。",
    });
  }

  const lockedConflict = eventMap.get("RESUME_LOCKED_CONFLICT");
  lockedConflict.description = "已通过当前 domain 明确绑定的外部 capability 取得锁定/保护事实，并由已批准 Rule 判定本次处理必须暂停；候选人与简历可保持已持久化状态，下游匹配不启动，由人工动作 resolveLockConflict 处理。若外部事实或策略不完整，Agent 应停靠并 ask_user，而不是发出本事件。";

  const invitationSent = eventMap.get("INTERVIEW_INVITATION_SENT");
  invitationSent.description = "外部邀请 capability 已明确确认邀请送达或复用已有邀请，并返回满足本 Event 契约的回执。送达后的本地/镜像持久化告警只进入 observability 与补偿队列，不再额外发 INTERVIEW_INVITATION_FAILED；一个执行项只能选择一个终态事件。";

  const invitationFailed = eventMap.get("INTERVIEW_INVITATION_FAILED");
  invitationFailed.description = "在 candidate_id 与 job_requisition_id 等事件锚点完整的前提下，外部 capability 明确返回不可恢复的业务拒绝或输入失败。网络、限流、5xx、超时等结果未知情形必须停靠重试，不发本事件；已确认送达后的持久化告警也不得发本事件。";
  const invitationErrorCode = invitationFailed.payload.event_data.find((field) => field.name === "error_code");
  if (invitationErrorCode) {
    invitationErrorCode.enum = asArray(invitationErrorCode.enum).filter((value) => value !== "PERSISTENCE_WARNING");
    invitationErrorCode.description = "终态失败分类；只能来自已确认的输入校验或供应商业务回执。不得把结果未知的网络/5xx/超时或送达后的本地持久化告警归为终态失败。";
  }
  for (const anchor of ["candidate_id", "job_requisition_id"]) {
    const field = invitationFailed.payload.event_data.find((candidate) => candidate.name === anchor);
    if (field) field.description = `${anchor} 是本失败事件的必填真实业务锚点；缺失时停靠并 ask_user，不得填 unknown 或占位值。`;
  }

  const requiredNames = new Set([
    "REQUIREMENT_LOGGED", "CLARIFICATION_READY", "JD_REJECTED", "JD_GENERATED", "JD_APPROVED",
    "RESUME_DOWNLOADED", "RESUME_PROCESSED", "RESUME_LOCKED_CONFLICT",
    "CANDIDATE_IDENTITY_REQUESTED", "CANDIDATE_IDENTITY_CHECKED",
    "MATCH_RULE_CHECK_PASSED", "MATCH_RULE_CHECK_FAILED", "MATCH_PASSED_NEED_INTERVIEW", "MATCH_FAILED",
    "INTERVIEW_INVITATION_REQUESTED", "INTERVIEW_INVITATION_SENT", "INTERVIEW_INVITATION_FAILED",
  ]);
  if (events.length !== requiredNames.size || events.some((event) => !requiredNames.has(event.name))) {
    throw new Error("Event replacement set does not match the reviewed 17-event topology");
  }
  return events;
}

function humanInput(name, type, description, required = false) {
  return { name, type, description, required, binding_kind: "human_input", prompt: description };
}

// These names belong to the reviewed zhaopin/RAAS compatibility package.  A
// fresh ontology-authored tenant must not inherit their candidate precedence,
// routing, threshold or persistence implementation.  The release compiler
// translates transport/persistence boundaries to generic, profile-bound
// capabilities and leaves business decisions in Rules/decision tables.
const legacyCompatibilityTools = new Set([
  "loadRaasRequirement",
  "loadRaasRuleContext",
  "candidateDedupLookup",
  "persistJd",
  "persistRaasEntities",
  "persistRuleCheckAudit",
  "routeResumeProcessed",
  "routeMatchOutcome",
  "routeInterviewInvitation",
]);

const rawFactOperationByStep = new Map([
  ["resolve_requirement_context", "requirement.context.read"],
  ["resolve_candidate_resume_context", "candidate.resume.rule-context.read"],
  ["resolve_matchable_requirements", "requisition.matchable.list"],
]);

// This is a reviewed Action-to-operation contract, not an operation inferred
// from prose at runtime. `entities.write` receives only this immutable
// server-catalog operation plus field-level values prepared by the Action.
// The integration metadata must independently declare the same system and
// capability, otherwise compilation fails closed.
const databaseWriteBindingByAction = new Map([
  ["4", { systemName: "RAAS_System", operation: "job_posting.sync" }],
  ["9-1", { systemName: "RAAS_System", operation: "candidate.save" }],
  ["10-1", { systemName: "RAAS_System", operation: "cmr.write_fail" }],
  ["10-2", { systemName: "RAAS_System", operation: "match_result.save" }],
  ["11-1", { systemName: "RAAS_System", operation: "invitation.mark_sent" }],
]);

const integrationKind = (value) => refKey(value);
const integrationRole = (value) => refKey(value);

function hasIntegration(systems, kinds, roles) {
  const acceptedKinds = new Set(kinds.map(integrationKind));
  const acceptedRoles = new Set(roles.map(integrationRole));
  return systems.some((system) =>
    acceptedKinds.has(integrationKind(system.kind))
    && acceptedRoles.has(integrationRole(system.role)));
}

function insertBeforeStep(action, beforeStepId, step) {
  const index = action.action_steps.findIndex((candidate) => candidate.step_id === beforeStepId);
  action.action_steps.splice(index < 0 ? action.action_steps.length : index, 0, step);
}

function genericToolStep(action, spec) {
  return {
    id: `${action.id}::${spec.step_id}`,
    step_id: spec.step_id,
    name: spec.name,
    object_type: "tool",
    type: "tool",
    tool: spec.tool,
    condition: spec.condition,
    description: spec.description,
    ...(spec.config ? { config: spec.config } : {}),
    ...(spec.tool_arguments ? { tool_arguments: spec.tool_arguments } : {}),
    ...(spec.result_map ? { result_map: spec.result_map } : {}),
    ...(spec.idempotency_key_from ? { idempotency_key_from: spec.idempotency_key_from } : {}),
    ...(spec.parent_step ? { parent_step: spec.parent_step } : {}),
  };
}

function genericLogicStep(action, spec) {
  return {
    id: `${action.id}::${spec.step_id}`,
    step_id: spec.step_id,
    name: spec.name,
    object_type: "logic",
    type: "logic",
    condition: spec.condition,
    description: spec.description,
    ...(spec.parent_step ? { parent_step: spec.parent_step } : {}),
  };
}

const recordTypeByObject = new Map([
  ["Candidate", "candidate"],
  ["Resume", "resume"],
  ["Job_Posting", "job_posting"],
  ["Candidate_Match_Result", "candidate_match_result"],
  ["Candidate_Identity_Result", "candidate_identity_result"],
  ["Communication_Log", "communication_log"],
]);

/**
 * `records.upsert` has one immutable record_type per binding.  A legacy tenant
 * persistence step often wrote several tables behind one tool name, so merely
 * renaming that tool produced a manifest which could not execute.  Derive one
 * generic record boundary per supported changed DataObject instead.  Objects
 * not owned by the local business-record store remain explicit in the
 * profile-bound external-database/Allmeta boundaries below.
 */
function expandGenericRecordPersistence(action) {
  const authored = action.action_steps.filter((step) => step.tool === "records.upsert");
  if (authored.length === 0) return;
  if (authored.length > 1) {
    throw new Error(`Action ${action.id} has multiple unexpanded records.upsert scaffold steps`);
  }
  const changedObjects = unique(asArray(action.side_effects?.data_changes)
    .map((change) => text(change.object_type || change.target_object)));
  const targets = changedObjects
    .map((objectId) => ({ objectId, recordType: recordTypeByObject.get(objectId) }))
    .filter((entry) => entry.recordType);
  if (targets.length === 0) {
    throw new Error(`Action ${action.id} maps a legacy persistence step to records.upsert but declares no supported record DataObject`);
  }

  const scaffold = authored[0];
  const scaffoldIndex = action.action_steps.indexOf(scaffold);
  const expanded = targets.map(({ objectId, recordType }, index) => {
    const localId = index === 0
      ? scaffold.step_id
      : `${scaffold.step_id}_${recordType}`;
    return {
      ...clone(scaffold),
      id: `${action.id}::${localId}`,
      step_id: localId,
      name: index === 0 ? scaffold.name : `${scaffold.name}${objectId.replace(/_/g, "")}`,
      config: { record_type: recordType },
      description: `把当前步骤产出的 ${objectId} 快照按 DataObject 主键幂等写入通用 business_records；只写 record_type=${recordType}，不执行候选人优先级、锁定、阈值、路由或外部数据库分支。`,
    };
  });
  action.action_steps.splice(scaffoldIndex, 1, ...expanded);
}

function modernizeOntologyAuthoredExecution(action) {
  if (!action.actor.includes("Agent")) return;

  const systems = asArray(action.integration?.systems);
  const readsObjectStorage = hasIntegration(
    systems,
    ["object_store", "object_storage", "object storage", "file_store"],
    ["read", "reads", "fetch"],
  );
  const factSteps = [];
  for (const step of action.action_steps) {
    const factOperation = rawFactOperationByStep.get(step.step_id);
    if (factOperation) {
      step.tool = "facts.query";
      step.fact_operation = factOperation;
      factSteps.push(step);
      step.description = `通过当前 domain 已确认的只读数据库 integration profile 执行服务端 statement-catalog 操作 ${factOperation}，只返回原始事实行；本步不得产生匹配、锁定、阈值、路由或业务 verdict。参数必须由生成 plan 的 toolArguments 逐字段绑定，缺字段时 ask_user。`;
    }
    if (step.tool === "fs.readFromInbox" && readsObjectStorage) {
      step.tool = "objectStore.getObject";
      step.tool_arguments = {
        bucket: { from: "input.bucket", required: false },
        object_key: { from: "input.object_key", required: true },
      };
      step.result_map = {
        fields: {
          bucket: "result.bucket",
          object_key: "result.object_key",
          filename: "result.filename",
          mime: "result.mime",
          base64: "result.base64",
          sha256: "result.sha256",
          bytes: "result.bytes",
          etag: "result.etag",
        },
        include_raw: false,
      };
      step.description = "使用当前 domain 已确认的对象存储 profile，按 Event/input 中明确绑定的 bucket 与 object_key 读取受大小限制的原始文件；端点和凭证只能来自 server-owned env references。缺少对象定位、profile 或安全探针时停靠并 ask_user，不得回退到本机目录。";
    }
    if (step.tool === "persistJd" || step.tool === "persistRaasEntities" || step.tool === "persistRuleCheckAudit") {
      step.tool = "records.upsert";
      step.description = `把本 Action 声明的数据变更幂等写入通用业务记录层；record_type、业务主键和字段映射必须来自 DataObject/Action 契约，不能沿用旧 RAAS phase 分支。外部 PostgreSQL/Allmeta 写入由后续独立 profile-bound 步骤完成。`;
      delete step.config?.phase;
    }
    if (step.tool === "routeResumeProcessed" || step.tool === "routeMatchOutcome" || step.tool === "routeInterviewInvitation") {
      step.object_type = "logic";
      step.type = "logic";
      delete step.tool;
      step.outcome_decision = true;
      step.description = "只依据当前 Ontology Rule、DataObject 配置和已声明事件契约形成分支结论；不得调用旧 tenant 路由器，也不得在代码中内置阈值、状态优先级或失败恢复语义。";
    }
  }

  const resumeParser = action.action_steps.find((step) => step.tool === "parseResumeApi");
  const objectReader = action.action_steps.find((step) => step.tool === "objectStore.getObject");
  if (resumeParser && objectReader) {
    const objectReaderIndex = action.action_steps.indexOf(objectReader);
    const transportValidation = action.action_steps.findLast((step, index) =>
      index < objectReaderIndex && step.object_type === "logic");
    if (transportValidation) {
      transportValidation.description = "读取当前 domain 的 canonical Event/input 字段并校验 upload_id、bucket、object_key、employee_id 等已声明契约；信封差异由 tenant event adapter 在进入 Action 前处理。缺少必填字段时停靠并 ask_user，不得在函数中兼容猜测旧信封、snake/camel 别名或默认归属。";
    }
    resumeParser.tool_arguments = {
      resume_base64: { from: `results.${objectReader.step_id}.base64`, required: true },
      filename: { from: `results.${objectReader.step_id}.filename`, required: false },
      mime: { from: `results.${objectReader.step_id}.mime`, required: false },
    };
    resumeParser.description = "把前序对象存储步骤返回的受信任文件字节通过精确 toolArguments 交给已绑定的简历解析服务；不得让模型重写 base64，也不得从本机路径取件。显式不可解析文档按 Action 的错误契约处理；网络、限流或 5xx 结果未知时停靠重试，不得伪造解析结果。";
    action.submission_criteria = "1. 触发 Event 必须提供满足其契约的 upload_id、bucket、object_key 与 employee_id。\n2. 对象存储、解析服务、业务写库与 Allmeta profile 必须完成当前环境绑定；生产写配置须有有效安全探针。\n3. 身份检查 invoke 的输入/输出、超时和错误策略必须显式确认；未知结果不得静默视为新候选人。\n4. 若 Action 仍要求归属锁定分支，对应外部 capability 与阻断 Rule 必须可用；否则停靠并 ask_user。";
    const objectStorageSystem = systems.find((system) =>
      ["objectstore", "objectstorage", "filestore"].includes(integrationKind(system.kind))
      && ["read", "reads", "fetch"].includes(integrationRole(system.role)));
    if (objectStorageSystem) {
      objectStorageSystem.capability = "get-object — 按 Action/Event 的 bucket 与 object_key 读取有大小上限的对象；端点、凭证、bucket allowlist 与探针均由 integration profile 提供。";
    }
  }

  const invokeSteps = action.action_steps.filter((step) => step.object_type === "invoke" || text(step.invoke));
  for (const step of invokeSteps) {
    step.condition = "上游输入满足被调用 Action 的已发布输入契约，且 invoke binding 已确认";
    step.description = `按被调用 Action ${text(step.invoke) || "（未解析）"} 的版本化输入/输出契约执行同步 invoke；超时、不可用或返回证据不足时必须按显式 on_error 策略停靠或 ask_user，不得把身份未知静默改写成“新候选人”，也不得跳过 mandatory Rule。`;
  }
  for (const system of systems.filter((candidate) => integrationKind(candidate.kind) === "internalinvoke")) {
    system.capability = "invoke-action — 按被调用 Action 的版本化输入/输出与错误契约同步执行；失败策略必须显式绑定，不允许静默跳过 mandatory Rule。";
  }

  const lockSystem = systems.find((system) =>
    /lock|锁定|归属/i.test(`${text(system.capability)} ${text(system.name)}`));
  if (lockSystem) {
    lockSystem.capability = "read-lock-facts — 只读取原始锁定/保护事实；阻断语义由 approved Ontology Rule 决定，profile 未绑定时停靠并 ask_user。";
    const lockStep = action.action_steps.find((step) =>
      /lock|锁定|归属/i.test(`${text(step.step_id)} ${text(step.name)}`))
      ?? action.action_steps.findLast((step) =>
        /lock|锁定|归属/i.test(text(step.description)));
    if (lockStep) {
      lockStep.condition = "当前 Action/Rule 明确要求归属锁定事实，且对应 integration profile 与探针均已确认";
      lockStep.description = `通过 ${text(lockSystem.name) || "已声明外部系统"} 的已确认只读 capability 获取原始锁定/保护事实，再由 Ontology Rule 决定是否阻断。若 capability 尚未绑定、回执不确定或业务策略未定义，停靠并 ask_user；不得默认“未锁定”、默认放行或用环境变量暗中切换语义。`;
    }
  }

  const generateJd = action.action_steps.find((step) => step.tool === "generateJdApi");
  const jdPrompt = action.action_steps.find((step) => /build.*jd.*prompt/i.test(text(step.step_id)));
  if (generateJd && jdPrompt) {
    generateJd.tool_arguments = {
      prompt: { from: `results.${jdPrompt.step_id}.prompt`, required: true },
    };
  }

  const matchResume = action.action_steps.find((step) => step.tool === "matchResumeApi");
  const matchPayload = action.action_steps.find((step) => /build.*match.*payload/i.test(text(step.step_id)));
  if (matchResume && matchPayload) {
    matchPayload.description = "严格按 Action inputs、Event 契约和已批准 Rule 产出 {resume,jd} 两段非空纯文本；是否把规则判定摘要纳入 JD 必须由显式 Action/Rule 字段决定，不得使用隐藏开关、默认追加或口头约定。缺少来源字段时停靠并 ask_user。";
    matchResume.tool_arguments = {
      resume: { from: `results.${matchPayload.step_id}.resume`, required: true },
      jd: { from: `results.${matchPayload.step_id}.jd`, required: true },
    };
    const ruleSummaryInput = asArray(action.inputs).find((input) => input.name === "rule_check_rules");
    if (ruleSummaryInput) {
      ruleSummaryInput.description = "规则检查逐条结论；仅当当前 Action/Rule 契约明确要求时才纳入匹配 JD，并保持来源与审计标识，不受隐藏环境开关控制。";
    }
  }

  const invitation = action.action_steps.find((step) => step.tool === "inviteCandidateApi");
  if (invitation) {
    const invitationIndex = action.action_steps.indexOf(invitation);
    const prepareInvitation = action.action_steps.findLast((step, index) =>
      index < invitationIndex
      && step.object_type === "logic"
      && /resume.*jd|invitation|邀约|面试材料/i.test(`${text(step.step_id)} ${text(step.name)} ${text(step.description)}`)
    );
    const invitationValidation = action.action_steps.find((step, index) =>
      index < invitationIndex && step.object_type === "logic" && step !== prepareInvitation);
    if (invitationValidation) {
      invitationValidation.description = "只校验 canonical Event/input 中已声明的真实 candidate_id、job_requisition_id 与审计锚点；信封适配由 tenant event adapter 完成。锚点缺失时停靠并 ask_user，不得填 unknown、猜别名或先发一个无法满足 Event schema 的失败事件。";
    }
    if (prepareInvitation) {
      prepareInvitation.description = "从已声明 Event/input 或已确认只读 integration 中整理 canonical invitation_request：必须包含 resume 或供应商 resume_id、jd 或供应商 job_id，并携带可在重试间保持稳定的 hiring_request_id；可选字段只按 Action 输入逐字段映射。缺少材料、去重键或来源映射时停靠并 ask_user，不得猜数据库、供应商 ID 或默认值。";
      invitation.tool_arguments = Object.fromEntries([
        "resume", "resume_id", "jd", "job_id", "hiring_request_id",
        "candidate_email", "recruiter_email", "interviewer_requirement",
        "job_title", "company_name", "interview_language",
        "interview_duration", "interview_mode", "passing_score",
        "linked_assessment_id",
      ].map((argument) => [argument, {
        from: `results.${prepareInvitation.step_id}.invitation_request.${argument}`,
        required: false,
      }]));
      invitation.description = "调用已绑定的外部邀请 capability；该步骤会产生真实且不可自动撤销的发送副作用，必须持有当前 attempt grant，并使用稳定 hiring_request_id。供应商明确拒绝且锚点完整时可形成 FAILED；确认送达时形成 SENT；网络、限流、5xx 或其他不确定回执必须停靠重试，不能发布终态事件。送达后的本地持久化告警只进入 observability，不得再发布 FAILED。";
    }
    action.submission_criteria = "1. 触发 Event 必须携带真实 candidate_id 与 job_requisition_id；缺失时停靠并 ask_user，不得用占位值发布失败事件。\n2. 上游步骤必须逐字段形成 canonical invitation_request，其中 resume/resume_id 与 jd/job_id 各至少一个，供应商资源 ID 不得由业务 ID 冒充。\n3. 必须具备可跨重试保持稳定的 hiring_request_id、当前 attempt grant，以及已确认的外部邀请 integration profile。\n4. 只有供应商明确送达或明确终态拒绝才进入事件决策；结果未知时停靠重试。";
  }

  const outcomes = new Set(asArray(action.triggered_event).map(text));
  const markedDecision = action.action_steps.find((step) => step.outcome_decision === true);
  const authoredEmit = action.action_steps.find((step) => step.object_type === "emit");
  if (outcomes.has("RESUME_PROCESSED") && outcomes.has("RESUME_LOCKED_CONFLICT") && authoredEmit) {
    authoredEmit.description = "当且仅当已绑定锁定 capability 返回可验证事实，且已批准 Rule 判定阻断时选择 RESUME_LOCKED_CONFLICT；事实明确且 Rule 判定不阻断时选择 RESUME_PROCESSED。外部事实、绑定或规则缺失时在到达本决策前停靠并 ask_user，不得默认未锁定。";
  }
  if (outcomes.has("MATCH_RULE_CHECK_PASSED") && outcomes.has("MATCH_RULE_CHECK_FAILED") && authoredEmit) {
    authoredEmit.description = "逐岗位依据运行时取得的 approved Rules 与证据形成唯一结论：全部 mandatory Rule 明确通过时选择 MATCH_RULE_CHECK_PASSED；存在有业务证据的 mandatory 阻断时选择 MATCH_RULE_CHECK_FAILED。规则缺失、证据不足或推理依赖故障时停靠并 ask_user，不发布 PASSED/FAILED，也不存在绕过开关。";
  }
  if (outcomes.has("MATCH_PASSED_NEED_INTERVIEW") && outcomes.has("MATCH_FAILED") && markedDecision) {
    markedDecision.description = "使用 DataObject/Action 输入中的 resume_match_score_threshold 及当前已批准 Rule，对已持久化的标准化供应商结果形成唯一匹配结论；阈值或评分证据缺失时停靠并 ask_user，不得使用函数常量、null 默认通过或旧 tenant 路由。";
  }
  const invitationDecision = markedDecision ?? authoredEmit;
  if (outcomes.has("INTERVIEW_INVITATION_SENT") && outcomes.has("INTERVIEW_INVITATION_FAILED") && invitationDecision) {
    invitationDecision.description = "供应商明确确认送达或复用已有邀请时只选择 INTERVIEW_INVITATION_SENT；供应商在真实业务锚点完整时明确终态拒绝，才只选择 INTERVIEW_INVITATION_FAILED。网络、限流、5xx、超时等不确定回执在到达本决策前停靠重试。送达后的任何持久化告警只写 observability/补偿队列，绝不同时选择 SENT 与 FAILED。";
  }

  for (const step of factSteps) {
    const prepareStepId = `prepare_${step.step_id}_arguments`;
    insertBeforeStep(action, step.step_id, genericLogicStep(action, {
      step_id: prepareStepId,
      name: `prepare${String(step.name ?? step.step_id).replace(/^[a-z]/, (value) => value.toLocaleUpperCase())}Arguments`,
      condition: "已取得该 statement 所需的上游业务键",
      description: `只按已确认 integration profile 中 ${step.fact_operation} 的命名参数契约产出 {values}；参数值逐字段来自 Event/input/前序结果。profile 未给参数名或来源时必须 ask_user，不得整包透传 Event。`,
    }));
    step.tool_arguments = {
      operation: { const: step.fact_operation },
      values: { from: `results.${prepareStepId}.values`, required: true },
    };
    step.result_map = {
      fields: { rows: "result.rows", row_count: "result.row_count" },
      include_raw: false,
    };
  }

  if (action.id === "10-3") {
    const decision = action.action_steps.find((step) => step.step_id === "resolve_identity_match");
    if (decision) {
      const rules = clone(decision.rules ?? []);
      insertBeforeStep(action, decision.step_id, genericToolStep(action, {
        step_id: "query_identity_facts",
        name: "queryIdentityFacts",
        tool: "facts.query",
        condition: "身份字段已提取",
        description: "执行已确认 statement-catalog 操作 candidate.identity-facts.read，只返回候选人对比事实；不做强/弱命中、合并或人工复核判决。",
        tool_arguments: {
          operation: { const: "candidate.identity-facts.read" },
          values: { from: "results.prepare_query_identity_facts_arguments.values", required: true },
        },
        result_map: {
          fields: { rows: "result.rows", row_count: "result.row_count" },
          include_raw: false,
        },
      }));
      insertBeforeStep(action, "query_identity_facts", genericLogicStep(action, {
        step_id: "prepare_query_identity_facts_arguments",
        name: "prepareQueryIdentityFactsArguments",
        condition: "身份字段已提取且 profile 已确认",
        description: "只按已确认 candidate.identity-facts.read statement 参数契约产出 {values}；姓名、手机号、证件号等字段只作为原始查询参数，不在本步形成同人结论。缺少参数映射时 ask_user。",
      }));
      decision.tool = "reasoning.evaluateRules";
      decision.fact_operation = undefined;
      decision.rules = rules;
      decision.description = "运行时读取本 Action 精确挂载且 approved 的 Ontology Rules，以结构化事实逐条求值，输出命中规则、证据和待人工项；姓名/手机号优先级、模糊等价与是否自动合并均由规则/decision table 决定，不得由 tenant tool 或函数常量决定。";
    }
  }

  if (action.action_steps.some((step) => step.tool === "reasoning.evaluateRules")
      && action.action_steps.some((step) => /identity/i.test(text(step.step_id)))) {
    action.submission_criteria = "1. 触发 Event 或 invoke 输入必须满足本 Action 的 parsed 与业务锚点契约。\n2. 当前 Action 精确挂载的 approved Rules、原始身份事实查询 profile 和审计持久化必须可用。\n3. 规则、事实或审计任一缺失/失败时停靠并 ask_user，不返回 skipped、默认新候选人或无审计结论。";
  }

  const writes = systems;
  const firstEmit = action.action_steps.find((step) => step.object_type === "emit")?.step_id;
  const databaseWrites = writes.filter((system) =>
    integrationRole(system.role) === integrationRole("write")
    && integrationKind(system.kind) === integrationKind("database"));
  if (databaseWrites.length > 0) {
    if (databaseWrites.length !== 1) {
      throw new Error(`Action ${action.id} must declare exactly one reviewed database write integration`);
    }
    const binding = databaseWriteBindingByAction.get(action.id);
    if (!binding) {
      throw new Error(`Action ${action.id} has a database write integration but no reviewed entities.write binding`);
    }
    const integration = databaseWrites[0];
    const declaredOperation = text(integration.capability).split(/\s+—\s+/u)[0];
    if (text(integration.name) !== binding.systemName || declaredOperation !== binding.operation) {
      throw new Error(
        `Action ${action.id} database write integration disagrees with reviewed binding `
        + `${binding.systemName}/${binding.operation}`,
      );
    }
    insertBeforeStep(action, firstEmit, genericLogicStep(action, {
      step_id: "prepare_external_database_write",
      name: "prepareExternalDatabaseWrite",
      condition: "本地业务记录已持久化且 profile 已确认",
      description: `严格按当前 Action.side_effects、DataObject 主键及 ${binding.systemName} 已审查的 ${binding.operation} statement 参数契约，逐字段产出 {values,idempotency_key}。operation 由本 Action 的发布契约固定，values 不得整包透传 Event；字段来源、稳定幂等键或 profile 缺失时 ask_user，禁止猜 SQL、表名或 operation。`,
    }));
    insertBeforeStep(action, firstEmit, genericToolStep(action, {
      step_id: "persist_external_database",
      name: "persistExternalDatabase",
      tool: "entities.write",
      condition: "本 Action 的本地业务记录已幂等持久化",
      description: `通过 ${binding.systemName} 的 environment-specific profile 执行 server-owned operation ${binding.operation}；profile.allowed_operations 必须精确包含该 operation，values 参数映射、幂等键及补偿/回读契约必须显式绑定并通过写探针，禁止内联 SQL或由模型选择写操作。`,
      tool_arguments: {
        operation: { const: binding.operation },
        values: { from: "results.prepare_external_database_write.values", required: true },
      },
      idempotency_key_from: "results.prepare_external_database_write.idempotency_key",
    }));
  }
  if (databaseWrites.length === 0 && databaseWriteBindingByAction.has(action.id)) {
    throw new Error(`Action ${action.id} has a reviewed entities.write binding but no database write integration`);
  }
  const ontologyObjects = unique(writes
    .filter((system) => system.role === "write" && system.kind === "graph_db")
    .flatMap((system) => asArray(system.objects).map(text)));
  if (ontologyObjects.length > 0) {
    insertBeforeStep(action, firstEmit, genericLogicStep(action, {
      step_id: "prepare_ontology_instances",
      name: "prepareOntologyInstances",
      condition: "外部权威写入已完成或本 Action 明确声明仅镜像",
      description: `严格按当前 DataObject schema 为 ${ontologyObjects.join("、")} 产出 {instances:{ObjectId:{primary_value,properties}}}；properties 只含该对象已声明字段且包含真实主键，不从旧 tenant payload 整包复制。`,
    }));
    for (const objectId of ontologyObjects) {
      const suffix = objectId.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      insertBeforeStep(action, firstEmit, genericToolStep(action, {
        step_id: `persist_ontology_${suffix}`,
        name: `persistOntology${objectId.replace(/_/g, "")}`,
        tool: "ontology.writeInstance",
        condition: `${objectId} 的 schema-valid properties 与主键已准备`,
        description: `只写一个 ${objectId} 实例到 AllmetaOntology API；domain/action/tenant/对象 allowlist 来自已确认 profile，并须通过该精确 production 配置的写探针。不得直连 Neo4j。`,
        tool_arguments: {
          object_type: { const: objectId },
          properties: { from: `results.prepare_ontology_instances.instances.${objectId}.properties`, required: true },
        },
        idempotency_key_from: `results.prepare_ontology_instances.instances.${objectId}.primary_value`,
      }));
    }
  }
}

function expandOutcomeSteps(action) {
  if (!action.actor.includes("Agent")) return;
  const outcomes = unique(asArray(action.triggered_event).map(text));
  if (outcomes.length === 0) return;
  const authoredEmit = action.action_steps.find((step) => step.object_type === "emit");
  if (outcomes.length === 1) {
    if (!authoredEmit) {
      action.action_steps.push({
        id: `${action.id}::emit_outcome`,
        step_id: "emit_outcome",
        name: "emitOutcome",
        object_type: "emit",
        type: "emit",
        event: outcomes[0],
        emit_event: outcomes[0],
        description: `发出本 Action 唯一声明事件 ${outcomes[0]}，payload 必须逐字段满足 Event 契约。`,
      });
    } else {
      authoredEmit.event = outcomes[0];
      authoredEmit.emit_event = outcomes[0];
    }
    return;
  }

  // One runtime emit step has one immutable event target.  A prose step that
  // says “route emit A/B” is therefore not executable.  Preserve it as the
  // decision boundary, then materialize one allow-listed emit step per Event.
  // All reviewed branches here are mutually exclusive for one action item, so
  // use one scalar selected_event rather than an array that could accidentally
  // emit success and failure together. A foreach item receives its own scalar.
  const decision = action.action_steps.find((step) => step.outcome_decision === true)
    ?? authoredEmit
    ?? action.action_steps.findLast((step) => step.object_type === "logic" || step.object_type === "condition");
  if (!decision) throw new Error(`Action ${action.id} has multiple outcomes but no decision step`);
  decision.object_type = "logic";
  decision.type = "logic";
  delete decision.event;
  delete decision.emit_event;
  const decisionId = decision.step_id;
  decision.outcome_cardinality = "exactly_one";
  decision.description = `${text(decision.description)} 输出 {selected_event, payload}：selected_event 必须且只能是本 Action.triggered_event 中一个值；payload 必须满足所选 Event schema。不得同时选择成功和失败，也不得省略分支或 fallback；分支依据只能来自 Ontology Rules/DataObjects/外部回执，不得按事件名或旧 tenant 代码猜测。`.trim();

  for (const eventName of outcomes) {
    const suffix = eventName.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    action.action_steps.push({
      id: `${action.id}::emit_${suffix}`,
      step_id: `emit_${suffix}`,
      name: `emit${eventName.toLocaleLowerCase().split("_").map((part) => part ? part[0].toLocaleUpperCase() + part.slice(1) : "").join("")}`,
      object_type: "emit",
      type: "emit",
      event: eventName,
      emit_event: eventName,
      condition: `results.${decisionId}.selected_event == "${eventName}"`,
      depends_on: [decisionId],
      emit_payload_from: `results.${decisionId}.payload`,
      description: `仅当决策步骤明确列出 ${eventName} 时发出该事件；不允许 fallback 到其它分支，payload 必须通过 ${eventName} 契约校验。`,
    });
  }
}

function structurePerRequisitionExecution(action) {
  if (action.id !== "10-1") return;
  const firstChild = action.action_steps.findIndex((step) => step.step_id === "evaluate_rules_per_requisition");
  if (firstChild < 0) throw new Error("Action 10-1 is missing evaluate_rules_per_requisition");
  const parentStepId = "foreach_requisition";
  action.action_steps.splice(firstChild, 0, {
    id: `${action.id}::${parentStepId}`,
    step_id: parentStepId,
    name: "foreachRequisition",
    object_type: "foreach",
    type: "foreach",
    items_from: "results.resolve_matchable_requirements.rows",
    item_as: "requisition",
    item_key_from: "locals.requisition.job_requisition_id",
    foreach_mode: "sequential",
    description: "对 resolve_matchable_requirements.rows 顺序 foreach；当前项绑定为 locals.requisition，并以真实 job_requisition_id 作为稳定重放键。以下 parent_step=foreach_requisition 的规则求值、审计、外部写入、Allmeta 写入、分支与 emit 都必须放进 body；零岗位时 body 不执行且不得伪造事件。",
  });
  for (let index = firstChild + 1; index < action.action_steps.length; index += 1) {
    action.action_steps[index].parent_step = parentStepId;
  }
}

function buildActions(userRows, scaffoldRows, events) {
  const scaffold = byId(scaffoldRows);
  const eventMap = new Map(events.map((event) => [event.name, event]));
  const actionRows = clone(userRows);

  for (const action of actionRows) {
    const execution = scaffold.get(action.id) ?? {};
    action.trigger = action.id === "4"
      ? ["REQUIREMENT_LOGGED", "CLARIFICATION_READY", "JD_REJECTED"]
      : asArray(action.trigger);
    action.triggered_event = asArray(action.emit);
    delete action.emit;
    action.target_objects = clone(execution.target_objects ?? []);
    action.action_steps = clone(execution.action_steps ?? []);
    action.integration = clone(execution.integration ?? { systems: [] });
    action.integration.event_sources ??= {};
    action.side_effects = clone(execution.side_effects ?? { data_changes: [], notifications: [] });
    for (const field of [...asArray(action.inputs), ...asArray(action.outputs)]) {
      if (Array.isArray(field.enum)) {
        field.enum = field.enum.filter((value) => value !== "PERSISTENCE_WARNING");
      }
      if (field.name === "error_code" && /PERSISTENCE_WARNING|双发/i.test(text(field.description))) {
        field.description = "终态失败分类；必须来自输入校验或外部 capability 的明确业务回执。结果未知的网络故障以及已确认送达后的持久化告警都不属于终态失败。";
      }
    }
    if (action.actor.includes("Human") && asArray(action.trigger).includes("INTERVIEW_INVITATION_FAILED")) {
      action.description = "【人工处理】消费 INTERVIEW_INVITATION_FAILED，在真实业务锚点与明确终态错误证据完整时补齐数据、修正外部配置或改走线下流程；只有重新获得人工审批并生成新的稳定请求标识后，才可再次发出 INTERVIEW_INVITATION_REQUESTED。网络结果未知由原 Agent 停靠重试，送达后的持久化告警走 observability/补偿，不进入本人工失败流程。";
      action.instruction = action.description;
      for (const step of action.action_steps) {
        step.description = "按 Event.error_code 与明确业务证据进行人工处置；修复后如需重试，必须重新审批并生成新的稳定请求标识。网络结果未知不在这里重复发送，送达后的持久化告警仅做补偿。";
      }
    }
    // The old rule-check persistence boundary wrote both the audit and CMR.
    // `records.upsert` intentionally has no recruitment-specific audit type,
    // so keep the local generic record as Candidate_Match_Result and make the
    // declared PostgreSQL + Allmeta boundaries own Rule_Check_Audit explicitly.
    // This is release-domain modeling, not a tenant runtime decision branch.
    if (action.id === "10-1") {
      const graphWrite = asArray(action.integration.systems)
        .find((system) => system.kind === "graph_db" && system.role === "write");
      if (!graphWrite) throw new Error("Action 10-1 requires an Allmeta write integration for Rule_Check_Audit");
      graphWrite.objects = unique([...asArray(graphWrite.objects).map(text), "Rule_Check_Audit"]);
    }
    for (const notification of action.side_effects.notifications ?? []) {
      if (notification.triggered_event == null) delete notification.triggered_event;
    }
    action.system_prompt = action.actor.includes("Agent")
      ? `你负责执行本体 Action ${action.name}。只按 action_steps、已绑定工具和已批准规则行动；缺少绑定、凭证或证据时停止并请求人工补充。`
      : "";
    action.user_prompt = text(action.instruction || action.description);

    if (action.id === "8" && !action.inputs.some((input) => input.name === "employee_id")) {
      action.inputs.push(humanInput("employee_id", "String", "上传简历的当前招聘员工号。", true));
    }
    if (action.id === "10-4") {
      const additions = [
        humanInput("upload_id", "String", "复核关联的简历上传编号。", true),
        humanInput("resume_id", "String", "复核关联的简历编号。", false),
        humanInput("parsed", "Object", "原身份检查事件携带的结构化简历；修正后可重新提交。", true),
      ];
      for (const input of additions) if (!action.inputs.some((candidate) => candidate.name === input.name)) action.inputs.push(input);
    }
    if (action.id === "10-6") {
      for (const input of [
        humanInput("upload_id", "String", "原匹配事件的上传编号。", true),
        humanInput("employee_id", "String", "负责改派的招聘员工号。", true),
      ]) if (!action.inputs.some((candidate) => candidate.name === input.name)) action.inputs.push(input);
    }
    if (action.id === "11-3") {
      for (const input of [
        humanInput("candidate_id", "String", "邀约失败事件中的候选人编号。", true),
        humanInput("job_requisition_id", "String", "邀约失败事件中的岗位编号。", true),
        humanInput("application_id", "String", "邀约失败事件中的投递申请编号。", false),
      ]) if (!action.inputs.some((candidate) => candidate.name === input.name)) action.inputs.push(input);
      const errorCode = action.inputs.find((candidate) => candidate.name === "error_code");
      if (errorCode) errorCode.type = "Enum";
    }
    if (action.id === "10-2" && !action.inputs.some((input) => input.name === "resume_match_score_threshold")) {
      action.inputs.push({
        name: "resume_match_score_threshold",
        type: "Float",
        description: "从 Job_Requisition 透传的面试审批阈值。",
        required: true,
      });
    }

    // Input/output branch mappings are compiled in one deterministic pass
    // after every Action and Event has been normalized. Keeping the mapping
    // logic out of this scaffold merge prevents per-Action business patches.
    for (const input of action.inputs ?? []) delete input.source_object;

    for (const [index, step] of action.action_steps.entries()) {
      if (!step || typeof step !== "object") throw new Error(`Action ${action.id} has an invalid step`);
      const localId = text(step.step_id || step.id || step.name) || `step_${index + 1}`;
      step.step_id = localId;
      step.id = `${action.id}::${localId}`;
      step.object_type = text(step.object_type || step.type) || "action";
      step.type = step.object_type;
      step.order = Number(step.order ?? index + 1);
      for (const rule of step.rules ?? []) {
        if (rule.id === "H-10-66") rule.id = "10-46";
      }
    }

    modernizeOntologyAuthoredExecution(action);
    expandGenericRecordPersistence(action);

    if (action.id === "10-3") insertBeforeStep(action, "query_identity_facts", genericToolStep(action, {
      step_id: "fetch_identity_rules", name: "fetchIdentityRules", tool: "ontology.fetchActionRules",
      condition: "身份字段已提取", description: "通过已确认的 Allmeta 集成配置读取当前 Action 精确挂载且 approved 的 Rules；读取失败 fail-closed，不使用缓存正文或 tenant 代码中的规则副本。",
    }));
    if (action.id === "10-1") {
      insertBeforeStep(action, "evaluate_rules_per_requisition", genericToolStep(action, {
        step_id: "fetch_match_rules", name: "fetchMatchRules", tool: "ontology.fetchActionRules", condition: "岗位上下文已加载", description: "通过已确认的 Allmeta 集成配置读取本 Action 精确挂载且 approved 的 Rules；漂移、缺失或读取失败均停靠。",
      }));
    }

    expandOutcomeSteps(action);
    structurePerRequisitionExecution(action);

    action.action_steps.forEach((step, index) => { step.order = index + 1; });
    action.tool_use = unique(action.action_steps.map((step) => text(step.tool)));
    const leakedCompatibilityTools = action.tool_use.filter((tool) => legacyCompatibilityTools.has(tool));
    if (leakedCompatibilityTools.length) {
      throw new Error(`Action ${action.id} still references tenant compatibility tools: ${leakedCompatibilityTools.join(", ")}`);
    }
  }
  return actionRows;
}

function eventHasField(event, fieldName) {
  const key = refKey(fieldName);
  return asArray(event?.payload?.event_data).some((field) =>
    [field.name, ...asArray(field.aliases)].some((candidate) => refKey(candidate) === key));
}

function dataChangeParts(change) {
  return {
    object: text(change?.target_object || change?.object_type),
    properties: unique(asArray(change?.impacted_properties ?? change?.property_impacted).map(text)),
  };
}

function eventMutationMatches(change, event) {
  const declared = dataChangeParts(change);
  if (!declared.object) return false;
  return asArray(event?.payload?.state_mutations).some((mutation) => {
    if (refKey(mutation.target_object) !== refKey(declared.object)) return false;
    if (declared.properties.length === 0) return true;
    const mutationProperties = new Set(asArray(mutation.impacted_properties).map(refKey));
    return declared.properties.some((property) => mutationProperties.has(refKey(property)));
  });
}

/**
 * Compile the cross-branch Action execution contract from the reviewed Event
 * schemas. Exact payload-field and state-mutation evidence is authoritative;
 * this pass never invents an Event name or silently selects one branch.
 */
function compileActionEventContracts(actions, events) {
  const eventMap = new Map(events.map((event) => [event.name, event]));
  const invokedActionNames = new Set(actions.flatMap((action) =>
    asArray(action.action_steps).map((step) => text(step.invoke)).filter(Boolean)));
  const assertKnownEvents = (action, relation, names) => {
    const missing = names.filter((eventName) => !eventMap.has(eventName));
    if (missing.length) {
      throw new Error(`Action ${action.id} ${relation} references missing Events: ${missing.join(", ")}`);
    }
  };

  for (const action of actions) {
    const triggers = unique(asArray(action.trigger).map(text));
    const outcomes = unique(asArray(action.triggered_event).map(text));
    assertKnownEvents(action, "trigger", triggers);
    assertKnownEvents(action, "triggered_event", outcomes);

    for (const input of action.inputs ?? []) {
      const sources = triggers.filter((eventName) => eventHasField(eventMap.get(eventName), input.name));
      if (sources.length > 0) {
        Object.assign(input, {
          binding_kind: "event",
          // Preserve every legitimate source for a common field. A scalar is
          // used only when the field belongs to exactly one trigger contract.
          source_event: sources.length === 1 ? sources[0] : sources,
          event_field: input.name,
          event_path: input.name,
        });
        delete input.prompt;
      } else if (action.actor.includes("Human")) {
        input.binding_kind = "human_input";
        input.prompt = text(input.description) || `请提供 ${input.name}`;
        delete input.source_event;
        delete input.event_field;
        delete input.event_path;
      }
    }

    for (const output of action.outputs ?? []) {
      const emittedOn = outcomes.filter((eventName) => eventHasField(eventMap.get(eventName), output.name));
      const supportsInvokeReturn = invokedActionNames.has(action.name);
      delete output.events;
      if (emittedOn.length > 0) {
        output.delivery = supportsInvokeReturn ? ["event", "invoke_return"] : "event";
        output.emitted_on = emittedOn;
        output.event_field = output.name;
      } else {
        output.delivery = supportsInvokeReturn ? ["invoke_return", "internal"] : "internal";
        delete output.emitted_on;
        delete output.event_field;
        // For a multi-outcome Action, an internal result still needs an
        // explicit branch-applicability contract. `events` is the schema's
        // non-emission alias and avoids claiming the field is in the payload.
        if (outcomes.length > 1) output.events = outcomes;
      }
    }

    const changes = [
      ...asArray(action.side_effects?.data_changes).map((change, index) => ({
        change,
        path: `side_effects.data_changes[${index}]`,
      })),
      ...asArray(action.action_steps).flatMap((step, stepIndex) =>
        asArray(step.data_changes).map((change, changeIndex) => ({
          change,
          path: `action_steps[${stepIndex}].data_changes[${changeIndex}]`,
        }))),
    ];
    for (const { change, path: changePath } of changes) {
      delete change.applies_on_events;
      if (outcomes.length <= 1) continue;
      const appliesOn = outcomes.filter((eventName) => eventMutationMatches(change, eventMap.get(eventName)));
      if (appliesOn.length === 0) {
        const { object, properties } = dataChangeParts(change);
        throw new Error(
          `Action ${action.id} ${changePath} (${object}.${properties.join(",")}) has no reviewed Event mutation evidence`,
        );
      }
      change.applies_on_events = appliesOn;
    }
  }
}

/** Action trigger/emission declarations are the topology authority. */
function alignEventTopology(actions, events) {
  const producers = new Map(events.map((event) => [event.name, []]));
  const consumers = new Map(events.map((event) => [event.name, []]));
  for (const action of actions) {
    for (const eventName of action.trigger ?? []) consumers.get(eventName)?.push(action.name);
    for (const eventName of action.triggered_event ?? []) producers.get(eventName)?.push(action.name);
  }
  for (const event of events) {
    event.producers = unique(producers.get(event.name) ?? []);
    event.consumers = unique(consumers.get(event.name) ?? []);
    event.payload.source_action = event.producers.length === 1 ? event.producers[0] : null;
    if (event.producers.length === 0 && event.consumers.length === 0) {
      throw new Error(`Event ${event.name} is unreferenced by every candidate Action`);
    }
  }
}

function filterUnknownMutationProperties(actions, events, objects) {
  const properties = new Map(objects.map((object) => [object.id, new Set(asArray(object.properties).map((property) => property.name))]));
  const aliases = new Map([["Candidate_Match_Result.job_requisition_id", "job_position_id"]]);
  const normalize = (objectId, field) => aliases.get(`${objectId}.${field}`) ?? field;
  for (const event of events) {
    for (const mutation of event.payload.state_mutations ?? []) {
      const known = properties.get(mutation.target_object);
      mutation.impacted_properties = unique(asArray(mutation.impacted_properties)
        .map((field) => normalize(mutation.target_object, field))
        .filter((field) => known?.has(field)));
    }
  }
  for (const action of actions) {
    for (const change of action.side_effects?.data_changes ?? []) {
      const known = properties.get(change.object_type);
      change.property_impacted = unique(asArray(change.property_impacted)
        .map((field) => normalize(change.object_type, field))
        .filter((field) => known?.has(field)));
    }
  }
}

function buildPolicyScopes(rules) {
  const scopes = new Map();
  for (const rule of rules) {
    if (refKey(rule.enforcementLevel) !== "mandatory") continue;
    const client = text(rule.applicableClient) || "通用";
    const department = text(rule.applicableDepartment) || "N/A";
    const stage = text(rule.specificScenarioStage) || "未指定阶段";
    const key = `${client}\u0000${department}\u0000${stage}`;
    if (!scopes.has(key)) {
      const suffix = createHash("sha256").update(`${domainId}\u0000${key}`).digest("hex").slice(0, 16);
      scopes.set(key, {
        id: `policy-scope-${suffix}`,
        domainId,
        applicableClient: client,
        applicableDepartment: department,
        stage,
        status: "approved",
        source: "deterministic_rule_scope_compiler",
        version,
      });
    }
    rule.policyScopeId = scopes.get(key).id;
  }
  return [...scopes.values()].sort((left, right) => left.id.localeCompare(right.id));
}

const relationshipTypes = {
  "object-fk": "REFERENCES",
  "action-trigger": "TRIGGERS",
  "action-emission": "EMITS",
  "action-targets-object": "TARGETS",
  "action-mutates": "MUTATES",
  "action-reads": "READS",
  "action-includes-step": "HAS_STEP",
  "rule-references-object": "APPLIES_TO",
  "rule-governs": "GOVERNS",
  "rule-scoped-to": "SCOPED_TO",
  "rule-relevant-to-action": "RELEVANT_TO",
  "event-carries-object": "CARRIES",
  "event-mutates-object": "MUTATES",
};

function buildLinks(objects, rules, actions, events, policyScopes) {
  const links = new Map();
  const endpointType = {
    object: "DataObject",
    rule: "Rule",
    policyscope: "PolicyScope",
    action: "Action",
    actionstep: "ActionStep",
    event: "Event",
    workflow: "Workflow",
  };
  const add = (kind, fromType, fromId, toType, toId, evidence, confidence = 1, extra = {}) => {
    const id = `${kind}/${fromType}/${fromId}/${toType}/${toId}`;
    if (links.has(id)) return;
    links.set(id, {
      id,
      linkId: id,
      kind,
      relationshipType: relationshipTypes[kind],
      from: { type: endpointType[fromType] ?? fromType, id: fromId },
      to: { type: endpointType[toType] ?? toType, id: toId },
      domainId,
      status: "approved",
      confidence,
      evidence: [{ source: "deterministic_compiler", reason: evidence }],
      source: "Agents-generation reviewed release compiler",
      version,
      managedBy: "links-builder",
      allmetaLink: true,
      derived: true,
      ...extra,
    });
  };

  for (const object of objects) {
    for (const property of object.properties ?? []) {
      if (property.is_foreign_key === true && property.references) {
        add("object-fk", "object", object.id, "object", property.references, `${object.id}.${property.name} declares references=${property.references}`);
      }
    }
  }
  const ruleMap = byId(rules);
  for (const action of actions) {
    for (const event of action.trigger) add("action-trigger", "event", event, "action", action.id, `${action.name}.trigger contains ${event}`);
    for (const event of action.triggered_event) add("action-emission", "action", action.id, "event", event, `${action.name}.triggered_event contains ${event}`);
    for (const object of action.target_objects) add("action-targets-object", "action", action.id, "object", object, `${action.name}.target_objects contains ${object}`);
    for (const system of action.integration?.systems ?? []) {
      const kind = /write|persist|upsert/i.test(text(system.role)) ? "action-mutates" : "action-reads";
      for (const object of system.objects ?? []) add(kind, "action", action.id, "object", object, `${action.name} integration ${system.name}/${system.role}`);
    }
    for (const step of action.action_steps ?? []) {
      add("action-includes-step", "action", action.id, "actionstep", step.id, `${action.name}.action_steps contains ${step.id}`);
      for (const reference of step.rules ?? []) {
        const rule = ruleMap.get(reference.id);
        if (!rule) throw new Error(`Action ${action.name} step ${step.id} references missing Rule ${reference.id}`);
        add("rule-governs", "rule", rule.id, "actionstep", step.id, `${step.id}.rules contains ${rule.id}`);
        add("rule-relevant-to-action", "rule", rule.id, "action", action.id, `${rule.id} governs a step owned by ${action.name}`, 0.99);
        for (const object of rule.relatedEntities ?? []) {
          add("rule-references-object", "rule", rule.id, "object", object, `${rule.id}.relatedEntities contains ${object}`, 0.98);
        }
        if (refKey(rule.enforcementLevel) === "mandatory") {
          if (!rule.policyScopeId || !policyScopes.some((scope) => scope.id === rule.policyScopeId)) {
            throw new Error(`Mandatory Rule ${rule.id} has no PolicyScope`);
          }
          const policyScope = policyScopes.find((scope) => scope.id === rule.policyScopeId);
          add(
            "rule-scoped-to",
            "rule",
            rule.id,
            "policyscope",
            rule.policyScopeId,
            `${rule.id} compiled client/department/stage scope`,
            1,
            { policyScope },
          );
        }
      }
    }
  }
  for (const event of events) {
    for (const object of unique(event.payload.event_data.map((field) => field.target_object))) {
      add("event-carries-object", "event", event.name, "object", object, `${event.name}.payload.event_data targets ${object}`);
    }
    for (const object of unique(event.payload.state_mutations.map((mutation) => mutation.target_object))) {
      add("event-mutates-object", "event", event.name, "object", object, `${event.name}.payload.state_mutations targets ${object}`);
    }
  }
  return [...links.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function metadata(kind, count, sourceDigests) {
  return {
    domainId,
    documentType: kind,
    version,
    generatedAt,
    generatedBy: "Codex reviewed ontology compiler",
    count,
    sourceDigests,
  };
}

async function main() {
  const [userActions, userObjects, userRules, actionScaffold, eventScaffold, objectScaffold, ruleScaffold, liveRules] = await Promise.all([
    readJson(sourcePaths.actions), readJson(sourcePaths.objects), readJson(sourcePaths.rules),
    readJson(sourcePaths.actionScaffold), readJson(sourcePaths.eventScaffold),
    readJson(sourcePaths.objectScaffold), readJson(sourcePaths.ruleScaffold), fetchLiveRules(),
  ]);
  const sourceDigests = {
    actions_v0_2_001: digest(userActions),
    objects_v0_2_001: digest(userObjects),
    rules_v0_2_001: digest(userRules),
    live_rules_before_release: digest(liveRules),
  };
  const releaseGrounding = {
    schema: "agents-generation-release-grounding/v1",
    allmetaRulesRead: liveRules.length > 0,
    liveRuleCount: liveRules.length,
    liveRuleDigest: sourceDigests.live_rules_before_release,
    mode: liveRules.length > 0 ? "live_allmeta_api" : "offline_scaffold_test",
    releasable: liveRules.length > 0,
  };
  const objects = buildObjects(userObjects, objectScaffold);
  const rules = buildRules(userRules, liveRules, ruleScaffold, objects);
  const events = buildEvents(eventScaffold);
  const actions = buildActions(userActions, actionScaffold, events);
  filterUnknownMutationProperties(actions, events, objects);
  compileActionEventContracts(actions, events);
  alignEventTopology(actions, events);
  const policyScopes = buildPolicyScopes(rules);
  const links = buildLinks(objects, rules, actions, events, policyScopes);
  const actionSteps = actions.flatMap((action) => action.action_steps.map((step) => ({ ...clone(step), action_id: action.id, action_name: action.name })));
  assertNoAllmetaStorageMetadata({
    objects,
    rules,
    actions,
    actionSteps,
    events,
    policyScopes,
    links,
  }, `${domainId} ${version} release definitions`);

  const domainOntology = {
    domainId,
    source: "snapshot",
    objects,
    rules,
    actions,
    events,
    links,
    workflow: [],
  };
  const payloadDigest = digest({ objects, rules, actions, actionSteps, events, policyScopes, links });
  const releaseBundle = {
    schemaVersion: 1,
    domainId,
    version,
    generatedAt,
    mode: "exact-domain-replacement",
    payloadDigest,
    sourceDigests,
    releaseGrounding,
    objects,
    rules,
    actions,
    actionSteps,
    events,
    policyScopes,
    links,
  };
  const report = {
    domainId,
    version,
    payloadDigest,
    counts: {
      objects: objects.length,
      rules: rules.length,
      actions: actions.length,
      agentActions: actions.filter((action) => action.actor.includes("Agent")).length,
      humanActions: actions.filter((action) => action.actor.includes("Human")).length,
      actionSteps: actionSteps.length,
      events: events.length,
      policyScopes: policyScopes.length,
      links: links.length,
    },
    reviewedDecisions: [
      "createJD subscribes REQUIREMENT_LOGGED, CLARIFICATION_READY and JD_REJECTED",
      "invitation approval topology remains MATCH_PASSED_NEED_INTERVIEW -> REQUESTED -> SENT|FAILED",
      "MATCH_PASSED_NO_INTERVIEW is removed because no production branch emits it",
      "the new user-supplied Rule text replaces conflicting live prose",
      "ambiguous rules outside the six-Agent executable slice retain needs_human_confirmation",
      "match threshold is stored in Job_Requisition and passed through Events; runtime must not contain a numeric fallback",
      "Agents-generation binds domain-neutral facts.query through reviewed integration metadata, then evaluates live Ontology rules; legacy tenant candidate/routing decisions are not executable capabilities",
      "each external database boundary uses entities.write with an Action-owned immutable server-catalog operation, field-level values and a stable idempotency key; Allmeta writes remain separate ontology.writeInstance steps",
      "external database and Allmeta writes require independent environment-specific profiles and mandatory live/write probes",
    ],
    deferredHumanSemantics: rules.filter((rule) => rule.automationStatus === "needs_human_confirmation").map((rule) => ({
      id: rule.id,
      name: rule.name,
      unresolvedSemantics: rule.unresolvedSemantics,
    })),
    sourceDigests,
    releaseGrounding,
  };

  await mkdir(outputDir, { recursive: true });
  const outputs = [
    [`objects_${version}.json`, { metadata: metadata("DataObjects", objects.length, sourceDigests), objects }],
    [`rules_${version}.json`, { metadata: metadata("Rules", rules.length, sourceDigests), rules }],
    [`actions_${version}.json`, { metadata: metadata("Actions", actions.length, sourceDigests), actions }],
    [`events_${version}.json`, { metadata: metadata("Events", events.length, sourceDigests), events }],
    [`policy_scopes_${version}.json`, { metadata: metadata("PolicyScopes", policyScopes.length, sourceDigests), policyScopes }],
    [`links_${version}.json`, { metadata: metadata("Links", links.length, sourceDigests), links }],
    [`domain_ontology_${version}.json`, domainOntology],
    [`release_bundle_${version}.json`, releaseBundle],
    [`synthesis_report_${version}.json`, report],
  ];
  for (const [filename, value] of outputs) {
    await writeFile(path.join(outputDir, filename), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
