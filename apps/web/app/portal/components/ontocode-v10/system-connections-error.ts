/**
 * FDE-facing copy for a failed system-connections read.
 *
 * The workbench used to render `error.message` directly. For an
 * `ApiResponseError` that string is a diagnostic line — `path: CODE (HTTP 500)
 * — <raw body>` — so when the API answered with a non-JSON body the FDE was
 * shown literally「无法读取系统连接：/v1/…: http_500 (HTTP 500) — Internal
 * Server Error」. That names no cause and suggests no next step.
 *
 * Two rules here:
 *   · when the server explained itself, show the server's words and nothing
 *     else — the API owns that prose and it is already in business language;
 *   · when it did not, say plainly that no reason came back, and keep the raw
 *     response as clearly-labelled secondary detail instead of passing it off
 *     as an explanation.
 *
 * Nothing is invented: an unexplained failure is reported as unexplained.
 */

import { ApiResponseError } from "@/lib/api-response";

const PREFIX = "无法读取系统连接";

export function systemConnectionsErrorText(error: unknown): string | null {
  if (!error) return null;
  if (!(error instanceof ApiResponseError)) {
    return error instanceof Error ? `${PREFIX}：${error.message}` : null;
  }
  // The API's own explanation — message plus hint, verbatim.
  if (error.serverMessage && error.serverText) {
    return `${PREFIX}：${error.serverText}`;
  }
  if (error.status === 0) {
    return (
      `${PREFIX}：请求没有得到任何响应，可能是网络中断，或者后端服务此刻不可用。` +
      `请稍后重试。`
    );
  }
  const rawDetail = error.detail ? `原始响应：${error.detail}` : "响应体为空";
  return (
    `${PREFIX}：接口返回了 HTTP ${error.status}，但没有说明原因（${rawDetail}）。` +
    `请稍后重试；若一直如此，请把这条提示反馈给平台维护者。`
  );
}
