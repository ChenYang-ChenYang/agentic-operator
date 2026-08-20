/**
 * Turn a failed Ontology-backed read into an HTTP answer that tells the truth.
 *
 * The rule this module exists to enforce: a refusal keeps its reason. Three
 * things travel together and none may be dropped —
 *
 *   · a STATUS that matches what actually went wrong (an outage is not a 404),
 *   · a stable CODE the caller can branch on,
 *   · FDE-facing PROSE in business language, with the transport's own English
 *     diagnostic preserved beside it in `details` rather than pasted into the
 *     sentence a human reads.
 *
 * Classification reads the typed reason the transport recorded
 * (`OntologyTransportError`), never the shape of its message. When no transport
 * reason is present the failure is reported as an internal defect at a named
 * stage — an honest "we do not know yet, here is where it broke" — instead of
 * being folded into the nearest plausible business cause.
 */

import {
  findOntologyTransportError,
  type OntologyTransportFailure,
} from "./agent-factory/ontology-transport-error";
import { redactHarnessTelemetryText } from "./ontocode-telemetry-redaction";

/**
 * Where in the read a failure happened. These are the handler's own phases;
 * they exist so a 500 can still say something actionable.
 */
export type OntologyReadStage =
  | "read_profiles"
  | "resolve_binding"
  | "build_source"
  | "read_ontology"
  | "read_agent_drafts"
  | "summarize"
  | "enrich";

const STAGE_LABELS: Record<OntologyReadStage, string> = {
  read_profiles: "读取系统档案",
  resolve_binding: "确认业务域绑定",
  build_source: "建立本体读取通道",
  read_ontology: "读取本体",
  read_agent_drafts: "读取本次生成范围",
  summarize: "汇总系统覆盖",
  enrich: "补齐连接状态",
};

/** A reason string the caller can branch on. Distinct from `code` so the wire
 *  code can stay stable while the underlying vocabulary grows. */
export type OntologyReadFailureReason = OntologyTransportFailure | "internal";

export interface OntologyReadFailureDetails {
  reason: OntologyReadFailureReason;
  stage: OntologyReadStage;
  domain: string;
  /** Only for `rejected`: the status the ontology service itself returned. */
  upstreamStatus?: number;
  /** The transport's own words, redacted. Never empty, never an empty object:
   *  when an error carries no message the raw value is reported as-is. */
  diagnostic: string;
}

export interface OntologyReadFailure {
  status: number;
  code: string;
  message: string;
  hint?: string;
  details: OntologyReadFailureDetails;
}

/** Cap the structured diagnostic. Truncation is reported, never silent. */
const DIAGNOSTIC_LIMIT = 1_500;

/**
 * Redact through the workspace's single telemetry boundary. That boundary
 * exists precisely because an Ontology transport quotes its own base URL back
 * in a failure message; a second hand-rolled scrubber beside it is how a
 * narrower vocabulary ends up leaking what the wider one caught.
 */
export function redactOntologyDiagnostic(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message || `${error.name}（未携带消息）`
      : String(error);
  const safe = redactHarnessTelemetryText(raw);
  return safe.length > DIAGNOSTIC_LIMIT
    ? `${safe.slice(0, DIAGNOSTIC_LIMIT)}…（诊断信息共 ${safe.length} 字，已截断）`
    : safe;
}

/**
 * The stack, through the same boundary. A stack frame list is the most useful
 * thing an internal defect can leave behind, but the message it starts with can
 * carry whatever the failing subsystem was holding — so the server log gets the
 * redacted string rather than the raw `Error`. Passing `{ err }` to the logger
 * would serialize the original message and defeat the redaction above.
 */
export function redactOntologyStack(error: unknown): string | undefined {
  const stack = error instanceof Error ? error.stack : undefined;
  return stack ? redactHarnessTelemetryText(stack) : undefined;
}

interface FailureShape {
  status: number;
  code: string;
  message: (domain: string) => string;
}

const TRANSPORT_FAILURES: Record<OntologyTransportFailure, FailureShape> = {
  unconfigured: {
    status: 503,
    code: "ONTOLOGY_SOURCE_UNCONFIGURED",
    message: (domain) =>
      `这个工作区还没有配置本体读取通道，因此列不出业务域「${domain}」引用了哪些外部系统。` +
      `请先在部署配置里补齐 Allmeta 的地址与访问凭证，再重试。`,
  },
  unreachable: {
    status: 502,
    code: "ONTOLOGY_SOURCE_UNREACHABLE",
    message: (domain) =>
      `连不上本体服务，所以读不到业务域「${domain}」。这不代表该业务域不存在——` +
      `请确认本体服务已启动、地址与网络可达，再重试。`,
  },
  timeout: {
    status: 504,
    code: "ONTOLOGY_SOURCE_TIMEOUT",
    message: (domain) =>
      `本体服务在限定时间内没有返回业务域「${domain}」的内容。` +
      `请稍后重试；若持续超时，请检查本体服务的负载与响应时间。`,
  },
  rejected: {
    status: 502,
    code: "ONTOLOGY_SOURCE_REJECTED",
    message: (domain) =>
      `本体服务可达，但拒绝了这次读取，因此拿不到业务域「${domain}」的内容。` +
      `请检查本体服务的访问凭证与该业务域的读取权限。`,
  },
  payload_contract: {
    status: 502,
    code: "ONTOLOGY_PAYLOAD_INVALID",
    message: (domain) =>
      `本体服务返回的内容不满足读取契约，业务域「${domain}」无法被完整解析。` +
      `已如实中止——不猜测缺失的部分。请检查该业务域在本体服务里的数据是否完整。`,
  },
  domain_not_in_catalog: {
    status: 404,
    code: "DOMAIN_NOT_FOUND",
    message: (domain) =>
      `本体目录里没有业务域「${domain}」。业务域 id 区分大小写，` +
      `请使用目录里的原始写法，或到业务域设置里重新选择。`,
  },
  domain_empty: {
    status: 409,
    code: "DOMAIN_HAS_NO_ACTIONS",
    message: (domain) =>
      `业务域「${domain}」在本体里还没有任何动作，无法推导它会用到哪些外部系统。` +
      `请先补齐该业务域的动作定义。`,
  },
  domain_unstable: {
    status: 503,
    code: "ONTOLOGY_SOURCE_UNSTABLE",
    message: (domain) =>
      `读取期间业务域「${domain}」的本体正在被改动，取不到同一版本的完整内容。` +
      `已如实中止——不返回半新半旧的结果。请稍后重试。`,
  },
  uploaded_bundle_missing: {
    status: 404,
    code: "UPLOADED_ONTOLOGY_MISSING",
    message: (domain) =>
      `这个工作区绑定的是上传的本体，但文件里找不到业务域「${domain}」。` +
      `请重新上传该业务域的本体文件，或改回从本体目录选择。`,
  },
  // A read that re-wrapped a cause it could not classify. It is NOT a statement
  // about the ontology service — saying anything about the service here would
  // be the borrowed reason this module exists to refuse.
  internal: {
    status: 500,
    code: "ONTOLOGY_READ_INTERNAL",
    message: (domain) =>
      `读取业务域「${domain}」的本体时出错了，但这次失败没有携带可判定的原因。` +
      `已如实中止——不猜测是本体服务、网络还是数据的问题。这是平台自身的缺陷，` +
      `请把这条提示连同下面的诊断信息反馈给平台维护者。`,
  },
};

/**
 * The System Profile table answers "which of these systems has already been
 * described/configured". When it cannot be read, "no profiles" is not a
 * smaller truth — it is a different, false one ("nothing is configured"). So
 * the read fails closed with the real reason attached.
 *
 * It lives beside the ontology classifier because `read_profiles` is already
 * one of the stages above: both routes that consult this table treat it as one
 * step of the same "can we answer this at all" question, and both must answer
 * it with the same vocabulary. The migration case is separated by the driver's
 * own signal, and it is the ONLY substring judgement made here — every other
 * cause keeps its own code rather than being folded into it.
 */
export function classifySystemProfileStoreFailure(error: unknown): {
  code: string;
  message: string;
  details: { reason: string; stage: OntologyReadStage; diagnostic: string };
} {
  const raw = error instanceof Error ? error.message : String(error);
  const migrationPending = raw.includes("no such table");
  return {
    code: migrationPending
      ? "MIGRATION_PENDING"
      : "SYSTEM_PROFILE_STORE_UNAVAILABLE",
    message: migrationPending
      ? "system_profiles 表尚未迁移——停掉 dev 栈后运行 pnpm db:migrate 再重启。"
      : "系统档案存储暂时读不出来，因此判断不了哪些外部系统已经描述过。" +
        "已如实中止——不把「读不到」当成「一个都没配」。",
    details: {
      reason: migrationPending ? "migration_pending" : "profile_store_unreadable",
      stage: "read_profiles",
      diagnostic: redactOntologyDiagnostic(error),
    },
  };
}

export function classifyOntologyReadFailure(input: {
  error: unknown;
  stage: OntologyReadStage;
  domain: string;
}): OntologyReadFailure {
  const observed = findOntologyTransportError(input.error);
  const diagnostic = redactOntologyDiagnostic(input.error);
  if (!observed) {
    return {
      status: 500,
      code: "COVERAGE_FAILED",
      message:
        `读取业务域「${input.domain}」的系统连接清单时，在「${STAGE_LABELS[input.stage]}」这一步出错了。` +
        `已如实中止——没有返回一份不完整的清单。这是平台自身的缺陷，请把这条提示反馈给平台维护者。`,
      details: {
        reason: "internal",
        stage: input.stage,
        domain: input.domain,
        diagnostic,
      },
    };
  }
  const shape = TRANSPORT_FAILURES[observed.failure];
  return {
    status: shape.status,
    code: shape.code,
    message: shape.message(input.domain),
    details: {
      reason: observed.failure,
      stage: input.stage,
      domain: input.domain,
      ...(observed.upstreamStatus !== undefined
        ? { upstreamStatus: observed.upstreamStatus }
        : {}),
      diagnostic,
    },
  };
}
