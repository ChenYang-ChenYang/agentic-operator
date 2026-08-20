"use client";

/**
 * #CONFIG-GAPS — "what does THIS Build still need connected?"
 *
 * Before this block, clicking 「去设置」 from a paused Build landed on an
 * integration list built from the STATIC provider catalogue (one entry) unioned
 * with the few System Profiles that declare `credential.provider`. A six-agent
 * fleet needing eight systems saw exactly one, and once it was configured the
 * page offered nothing at all. The Candidate Package had the precise answer the
 * whole time — its validation blockers name every unready (system, tool, role)
 * and the config keys each one is missing.
 *
 * Two rules this block keeps:
 *   - Every row says where the work actually happens. Sending someone to a
 *     credential form that is already complete is the dead end we are removing.
 *   - Env-only systems name their variables and stop there. Deployment secrets
 *     do not belong in a browser form, so the honest surface is "here is what
 *     ops must set, and whether the server can see it".
 */

import { useRouter } from "next/navigation";
import { Button, Panel } from "@/app/portal/components";
import {
  useOntoCodeConfigurationGaps,
  type OntoCodeConfigurationGapsReceipt,
  type OntoCodeGapSurface,
} from "@/lib/hooks/useOntoCodeWorkspace";

type GapRow = OntoCodeConfigurationGapsReceipt["systems"][number];

const SURFACE_LABEL: Record<OntoCodeGapSurface, string> = {
  integration: "凭证",
  tool_profile: "工具档案",
  env: "部署环境变量",
  human_boundary: "人工边界",
  runtime: "平台提供",
};

/** What the operator should understand before clicking anything. */
const SURFACE_NOTE: Record<OntoCodeGapSurface, string> = {
  integration: "在下方「集成」里填写凭证。",
  tool_profile: "这些是工具档案的配置项，不是登录凭证——在工具目录里按工具填写。",
  env: "由运维在服务端设置这些环境变量；出于安全，页面只显示变量名和是否已存在，不接收它们的值。",
  human_boundary: "你已确认由人工承接，无需在这里配置。沙箱与交付仍会如实拦截。",
  runtime: "平台运行时已提供，无需配置。",
};

function fieldSummary(row: GapRow): string[] {
  // Prefer the derived field specs (they carry required/satisfied); fall back
  // to the raw keys the Candidate named when a system has no profile yet.
  if (row.fields.length > 0) {
    return row.fields.map((f) => {
      const mark = f.satisfied || f.envPresent ? " ✓" : f.required ? " *" : "";
      return `${f.key}${mark}`;
    });
  }
  return row.missingConfigKeys;
}

export function BuildConnectionNeeds({
  tenant,
  sessionId,
  onConfigureProvider,
}: {
  tenant: string;
  sessionId: string;
  onConfigureProvider: (provider: string) => void;
}) {
  const router = useRouter();
  const q = useOntoCodeConfigurationGaps(tenant, sessionId);
  return (
    <BuildConnectionNeedsView
      tenant={tenant}
      rows={q.data?.systems ?? []}
      loading={q.isLoading}
      failed={q.isError}
      candidateAbsent={q.data?.candidateAbsent ?? false}
      onConfigureProvider={onConfigureProvider}
      onOpenTool={(toolName) =>
        router.push(
          `/portal/${encodeURIComponent(tenant)}/tools?tool=${encodeURIComponent(toolName)}`,
        )
      }
    />
  );
}

/**
 * Presentation split from data-fetching so the rendered output can be asserted
 * directly: this page is unreachable to an unauthenticated check, so its
 * markup is the only thing that can be verified without a live login.
 */
export function BuildConnectionNeedsView({
  rows,
  loading,
  failed,
  candidateAbsent,
  onConfigureProvider,
  onOpenTool,
}: {
  tenant: string;
  rows: OntoCodeConfigurationGapsReceipt["systems"];
  loading: boolean;
  failed: boolean;
  candidateAbsent: boolean;
  onConfigureProvider: (provider: string) => void;
  onOpenTool: (toolName: string) => void;
}) {
  // Every row here carries blockers; counting only the unsatisfied ones
  // under-reported the work (4 of 6 while all six were blocked).
  const outstanding = rows.filter((r) => r.blockers.length > 0).length;

  if (loading) {
    return (
      <Panel title="本次生成需要的连接" padded>
        <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>正在读取…</div>
      </Panel>
    );
  }
  if (failed) {
    return (
      <Panel title="本次生成需要的连接" padded>
        <div style={{ fontSize: 12.5, color: "var(--red)" }}>
          读不到本次生成的连接需求。这不代表「没有需求」——请刷新重试。
        </div>
      </Panel>
    );
  }
  if (candidateAbsent) {
    return (
      <Panel title="本次生成需要的连接" padded>
        <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>
          这个会话还没有生成候选包，所以还不知道要连哪些系统。先在工作台完成一次代码生成。
        </div>
      </Panel>
    );
  }
  if (rows.length === 0) return null;

  return (
    <Panel
      title={`本次生成需要的连接（${outstanding} 项待处理 / 共 ${rows.length}）`}
      subtitle="来自本次候选包自己记录的缺口，不是通用清单。"
      padded={false}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        {rows.map((row) => (
          <div
            key={row.system}
            style={{
              padding: "12px 16px",
              borderTop: "1px solid var(--border)",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <strong style={{ fontSize: 13 }}>{row.system}</strong>
              <span
                style={{
                  fontSize: 11,
                  padding: "1px 6px",
                  borderRadius: 4,
                  border: "1px solid var(--border-2)",
                  color: "var(--text-3)",
                }}
              >
                {SURFACE_LABEL[row.surface]}
              </span>
              {/*
                A system appears here because work remains, so the row never
                says "done". `satisfied` only ever means the CREDENTIAL half is
                complete — saying 「已就绪」 above a wall of missing profile keys
                is the dishonesty this panel exists to remove.
              */}
              <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>
                {row.blockers.length} 项阻塞
              </span>
              {row.satisfied ? (
                <span style={{ fontSize: 11.5, color: "var(--signal)" }}>
                  凭证已就绪
                </span>
              ) : null}
            </div>

            <div style={{ fontSize: 12, color: "var(--text-2)" }}>
              {SURFACE_NOTE[row.surface]}
            </div>

            {fieldSummary(row).length > 0 && (
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--text-3)",
                  fontFamily: "var(--mono, monospace)",
                  wordBreak: "break-word",
                }}
              >
                {fieldSummary(row).join("  ·  ")}
              </div>
            )}

            {row.blockers[0]?.reason && (
              <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>
                {row.blockers[0].reason}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {row.surface === "integration" && row.provider && (
                <Button
                  small
                  tone="primary"
                  onClick={() => onConfigureProvider(row.provider!)}
                >
                  配置凭证 →
                </Button>
              )}
              {row.surface === "integration" && !row.provider && (
                <Button
                  small
                  onClick={() =>
                    onConfigureProvider(row.system.toLowerCase().replace(/_/g, "-"))
                  }
                >
                  手动添加集成 →
                </Button>
              )}
              {row.surface === "tool_profile" && (
                <Button
                  small
                  onClick={() =>
                    onOpenTool(
                      row.blockers.find((b) => b.toolName)?.toolName ?? "",
                    )
                  }
                >
                  去工具档案 →
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
