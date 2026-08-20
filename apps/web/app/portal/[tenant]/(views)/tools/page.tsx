"use client";

/**
 * Agentic Tools — comprehensive API reference for the global tool registry.
 *
 * This is the canonical "what tools can I drop into a workflow?" page.
 * Every entry in @agentic/tools's globalToolRegistry gets a full section
 * with manifest declaration, args, returns, config, and chaining notes —
 * structured so a new-tenant author can compose an entire workflow from
 * configuration alone.
 *
 * Layout:
 *   - 240px sticky left rail: search + category chips + scrollable tool list
 *     (clicking a tool scrolls the right pane to that section).
 *   - Right pane: API-docs-style scrollable surface. Each tool section has
 *     anchor-stable id="tool-<name>" so direct links work.
 *
 * Backed by `useTools()` against GET /v1/tools.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Badge,
  Button,
  Empty,
  FilterChip,
  Panel,
  ViewHeader,
  useToast,
} from "@/app/portal/components";
import {
  useTools,
  useActivateToolRevision,
  useDeleteTool,
  useProbeToolRevision,
  useRejectToolRevision,
  useToolRevisions,
  type ManagedToolRevision,
  type ToolCatalogEntry,
  type ToolFieldSchema,
} from "@/lib/hooks/useTools";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { CreateToolModal } from "./create-tool-modal";
import { FactoryIntegrationProfiles } from "./factory-integration-profiles";
import { deriveToolRevisionReviewPolicy } from "./tool-revision-policy";

function slugifyAnchor(name: string): string {
  return "tool-" + name.replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase();
}

function revisionAnchor(id: string): string {
  return "tool-revision-" + id.replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase();
}

export default function ToolsPage() {
  const { t } = useI18n();
  const params = useParams<{ tenant: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data, isLoading, error } = useTools();
  const requestedRevisionId = searchParams.get("revision")?.trim() || null;
  const requestedRevisionDomain =
    searchParams.get("domain_id")?.trim() || undefined;
  // #TOOL-DEEP-LINK — "去工具档案 →" arrives with the tool it wants configured.
  // Without this the operator landed at the top of the whole catalogue, which
  // is indistinguishable from a button that does nothing.
  const requestedToolName = searchParams.get("tool")?.trim() || null;
  const revisionsQuery = useToolRevisions({
    limit: 50,
    domainId: requestedRevisionDomain,
  });
  const tools = data?.tools ?? [];
  const categories = data?.categories ?? [];

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | "all">("all");
  const [showCreate, setShowCreate] = useState(false);
  const scrollPaneRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tools.filter((t) => {
      if (category !== "all" && t.category !== category) return false;
      if (!q) return true;
      const hay = [
        t.name,
        t.summary,
        t.description ?? "",
        ...(t.aliases ?? []),
        t.sourcePath,
        ...Object.keys(t.argsSchema ?? {}),
        ...Object.keys(t.configSchema ?? {}),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [tools, query, category]);
  const filteredRevisions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (revisionsQuery.data?.revisions ?? []).filter(
      (revision) =>
        category === "all" &&
        (!q ||
          revision.name.toLowerCase().includes(q) ||
          revision.status.toLowerCase().includes(q) ||
          revision.definitionHash.toLowerCase().includes(q)),
    );
  }, [category, query, revisionsQuery.data?.revisions]);

  // Group filtered tools by category for the right-pane TOC.
  const grouped = useMemo(() => {
    const m = new Map<string, ToolCatalogEntry[]>();
    for (const t of filtered) {
      const arr = m.get(t.category) ?? [];
      arr.push(t);
      m.set(t.category, arr);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);
  const activeRevisionByName = useMemo(() => {
    const mapped = new Map<
      string,
      { id: string; domainId: string | null }
    >();
    for (const tool of tools) {
      if (tool.activeRevisionId) {
        mapped.set(tool.name, {
          id: tool.activeRevisionId,
          domainId: tool.activeRevisionDomainId ?? null,
        });
      }
    }
    return mapped;
  }, [tools]);

  // Deep-link → scroll on initial load if URL has #tool-<name>.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    // Defer until DOM has the section nodes.
    requestAnimationFrame(() => {
      const el = document.getElementById(hash);
      if (el) el.scrollIntoView({ behavior: "auto", block: "start" });
    });
  }, [filtered.length]);

  useEffect(() => {
    if (!requestedRevisionId) return;
    requestAnimationFrame(() => {
      document
        .getElementById(revisionAnchor(requestedRevisionId))
        ?.scrollIntoView({ behavior: "auto", block: "center" });
    });
  }, [filteredRevisions.length, requestedRevisionId]);

  function setRevisionDomain(domainId?: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (domainId) next.set("domain_id", domainId);
    else next.delete("domain_id");
    next.delete("revision");
    const suffix = next.toString() ? `?${next.toString()}` : "";
    router.replace(
      `/portal/${encodeURIComponent(params.tenant)}/tools${suffix}` as never,
    );
  }

  function scrollToTool(name: string) {
    const id = slugifyAnchor(name);
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      // Persist in URL so refresh / link-sharing works.
      window.history.replaceState(null, "", `#${id}`);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {showCreate && <CreateToolModal onClose={() => setShowCreate(false)} />}
      <ViewHeader
        title={t("nav.toolLibrary")}
        subtitle={t("tools.subtitle")}
        badge={
          <Badge tone="signal">
            {data
              ? t("tools.countBadge", {
                  count: data.count,
                  categories: data.categories.length,
                })
              : "—"}
          </Badge>
        }
      />

      {error && (
        <div style={{ padding: 20 }}>
          <Empty
            title={t("tools.loadFailedTitle")}
            hint={error.message || t("tools.apiUnreachable")}
          />
        </div>
      )}
      {!error && isLoading && (
        <div style={{ padding: 20 }}>
          <Empty title={t("tools.loading")} hint="" />
        </div>
      )}

      {!error && !isLoading && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "260px 1fr",
            gap: 0,
            flex: 1,
            minHeight: 0,
          }}
        >
          {/* LEFT RAIL */}
          <aside
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              padding: 16,
              borderRight: "1px solid var(--border)",
              background: "var(--panel-2)",
              overflow: "auto",
            }}
          >
            <Button
              tone="primary"
              icon="plus"
              onClick={() => setShowCreate(true)}
            >
              {t("tools.createTool")}
            </Button>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("tools.searchPlaceholder")}
              style={{
                width: "100%",
                padding: "7px 9px",
                fontFamily: "var(--mono)",
                fontSize: 12,
                background: "var(--bg)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                outline: "none",
              }}
            />

            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              <FilterChip
                active={category === "all"}
                onClick={() => setCategory("all")}
              >
                {t("tools.allChip", { count: tools.length })}
              </FilterChip>
              {categories.map((cat) => {
                const count = tools.filter((t) => t.category === cat).length;
                return (
                  <FilterChip
                    key={cat}
                    active={category === cat}
                    onClick={() => setCategory(cat)}
                  >
                    {cat} ({count})
                  </FilterChip>
                );
              })}
            </div>

            <nav style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {grouped.map(([cat, items]) => (
                <div key={cat}>
                  <div style={catLabelStyle}>{cat}</div>
                  <ul
                    style={{ listStyle: "none", margin: "4px 0 0", padding: 0 }}
                  >
                    {items.map((t) => (
                      <li key={t.name}>
                        <button
                          onClick={() => scrollToTool(t.name)}
                          style={navLinkStyle}
                        >
                          {t.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {grouped.length === 0 && (
                <div style={{ color: "var(--text-3)", fontSize: 12 }}>
                  {t("tools.navNoMatch")}
                </div>
              )}
            </nav>
          </aside>

          {/* RIGHT PANE — scroll target */}
          <div
            ref={scrollPaneRef}
            style={{ overflow: "auto", padding: "24px 32px" }}
          >
            {filtered.length === 0 &&
            filteredRevisions.length === 0 &&
            !revisionsQuery.isLoading ? (
              <Empty
                title={t("tools.noMatchTitle")}
                hint={t("tools.noMatchHint")}
              />
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 28 }}
              >
                <div style={introStyle}>
                  <h2
                    style={{
                      margin: 0,
                      fontFamily: "var(--display)",
                      fontSize: 20,
                      color: "var(--text)",
                    }}
                  >
                    {t("tools.apiReference")}
                  </h2>
                  <p style={introBodyStyle}>
                    {t("tools.introPart1")}{" "}
                    <code className="mono">tool_use[]</code>{" "}
                    {t("tools.introPart2")}{" "}
                    <code className="mono">tool_use[].config</code>{" "}
                    {t("tools.introPart3")}{" "}
                    <strong>{t("tools.resolutionOrder")}</strong>;{" "}
                    {t("tools.introPart4")}
                  </p>
                </div>

                {/* P3: where tools come from + the progressive doc→tool pipeline (cross-links the factory). */}
                <Panel
                  style={{ padding: "14px 16px", borderColor: "var(--signal)" }}
                >
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "var(--text)",
                      marginBottom: 6,
                    }}
                  >
                    {t("tools.origin.heading")}
                  </div>
                  <ol
                    style={{
                      margin: 0,
                      paddingLeft: 18,
                      fontSize: 12.5,
                      color: "var(--text-2)",
                      lineHeight: 1.7,
                    }}
                  >
                    <li>
                      <strong>{t("tools.origin.globalTitle")}</strong>：
                      {t("tools.origin.globalBefore")}{" "}
                      <code className="mono">tool_use[]</code>{" "}
                      {t("tools.origin.globalAfter")}
                    </li>
                    <li>
                      <strong>{t("tools.origin.discoveryTitle")}</strong>：
                      {t("tools.origin.discoveryBefore")}{" "}
                      <code className="mono">search_tools</code>{" "}
                      {t("tools.origin.discoveryAfter")}
                    </li>
                    <li>
                      <strong>{t("tools.origin.docsTitle")}</strong>：
                      {t("tools.origin.docsBefore")}{" "}
                      <code className="mono">fetch_doc</code>{" "}
                      {t("tools.origin.docsMiddle")}{" "}
                      <code className="mono">extract_api_schema</code>{" "}
                      {t("tools.origin.docsAfter")}{" "}
                      <code className="mono">create_tool</code>{" "}
                      {t("tools.origin.docsEnd")}
                    </li>
                  </ol>
                  <div style={{ marginTop: 8, fontSize: 12 }}>
                    <Link
                      href={`/portal/${params.tenant}/factory`}
                      style={{ color: "var(--signal)", textDecoration: "none" }}
                    >
                      {t("tools.origin.goFactory")}
                    </Link>
                  </div>
                </Panel>

                <ToolRevisionPanel
                  revisions={filteredRevisions}
                  loading={revisionsQuery.isLoading}
                  error={
                    revisionsQuery.error instanceof Error
                      ? revisionsQuery.error.message
                      : null
                  }
                  selectedRevisionId={requestedRevisionId}
                  requestedDomainId={requestedRevisionDomain}
                  onDomainChange={setRevisionDomain}
                  activeRevisionByName={activeRevisionByName}
                />

                {grouped.map(([cat, items]) => (
                  <section
                    key={cat}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 20,
                    }}
                  >
                    <h2 style={categoryHeadingStyle}>{cat}</h2>
                    {items.map((t) => (
                      <ToolSection
                        key={t.name}
                        tool={t}
                        requestedToolName={requestedToolName}
                      />
                    ))}
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolRevisionPanel({
  revisions,
  loading,
  error,
  selectedRevisionId,
  requestedDomainId,
  onDomainChange,
  activeRevisionByName,
}: {
  revisions: ManagedToolRevision[];
  loading: boolean;
  error: string | null;
  selectedRevisionId: string | null;
  requestedDomainId?: string;
  onDomainChange: (domainId?: string) => void;
  activeRevisionByName: Map<
    string,
    { id: string; domainId: string | null }
  >;
}) {
  return (
    <Panel
      style={{
        padding: "14px 16px",
        borderColor: "var(--border-2)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 700 }}>
            受控工具 revisions
          </div>
          <div
            style={{
              marginTop: 4,
              color: "var(--text-3)",
              fontSize: 11.5,
              lineHeight: 1.5,
            }}
          >
            draft 与 rejected 不在运行时工具目录中；只有带精确定义 probe
            证据并经人工激活的 revision 才可被 Agent 调用。
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          <Button
            small
            tone={requestedDomainId === "__unbound__" ? "ghost" : "primary"}
            onClick={() => onDomainChange(undefined)}
          >
            当前绑定域
          </Button>
          <Button
            small
            tone={requestedDomainId === "__unbound__" ? "primary" : "ghost"}
            onClick={() => onDomainChange("__unbound__")}
          >
            绑定前草稿（__unbound__）
          </Button>
          <Badge tone="muted">{revisions.length} revisions</Badge>
        </div>
      </div>
      {loading ? (
        <div style={{ marginTop: 12, color: "var(--text-3)", fontSize: 12 }}>
          正在读取 revision ledger…
        </div>
      ) : error ? (
        <div
          role="alert"
          style={{ marginTop: 12, color: "var(--red)", fontSize: 12 }}
        >
          无法读取工具 revision：{error}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          {revisions.length === 0 ? (
            <div style={{ color: "var(--text-3)", fontSize: 12 }}>
              此 revision domain 暂无草稿或历史版本。
              {selectedRevisionId
                ? " 深链中的 revision 不在该 domain；请切换当前绑定域或 __unbound__。"
                : ""}
            </div>
          ) : null}
          {revisions.map((revision) => (
            <ToolRevisionRow
              key={revision.id}
              revision={revision}
              selected={revision.id === selectedRevisionId}
              activeRevision={activeRevisionByName.get(revision.name)}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

function parseProbeObject(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} 不是合法 JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function ToolRevisionRow({
  revision,
  selected,
  activeRevision,
}: {
  revision: ManagedToolRevision;
  selected: boolean;
  activeRevision?: { id: string; domainId: string | null };
}) {
  const probe = useProbeToolRevision();
  const activate = useActivateToolRevision();
  const reject = useRejectToolRevision();
  const [argsText, setArgsText] = useState("{}");
  const [configText, setConfigText] = useState("{}");
  const [verifiedHash, setVerifiedHash] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const definition = revision.definition;
  const sideEffect =
    typeof definition.sideEffect === "string"
      ? definition.sideEffect
      : "unknown";
  const operation =
    typeof definition.operation === "string" ? definition.operation : "unknown";
  const reviewPolicy = deriveToolRevisionReviewPolicy(revision);
  const domainId = revision.domainId?.trim() || "__unbound__";
  const activeDomain = activeRevision?.domainId?.trim() || "__unbound__";
  const expectedActiveRevisionId =
    activeRevision && activeDomain === domainId ? activeRevision.id : null;
  const exactProbeVerified = verifiedHash === revision.definitionHash;
  const busy = probe.isPending || activate.isPending || reject.isPending;
  const statusTone =
    revision.status === "active"
      ? "green"
      : revision.status === "rejected"
        ? "red"
        : revision.status === "draft"
          ? "signal"
          : "muted";

  async function runProbe() {
    setRowError(null);
    setMessage(null);
    setVerifiedHash(null);
    try {
      const args = parseProbeObject(argsText, "Probe args");
      const config = parseProbeObject(configText, "Probe config");
      const receipt = await probe.mutateAsync({
        name: revision.name,
        revisionId: revision.id,
        revisionDomainId: domainId,
        args,
        config,
      });
      if (
        receipt.verified !== true ||
        receipt.definitionHash !== revision.definitionHash
      ) {
        throw new Error(
          "Probe 没有返回与该 revision definition hash 一致的 verified receipt。",
        );
      }
      setVerifiedHash(receipt.definitionHash);
      setMessage(
        `真实 probe 已核验 · ${receipt.durationMs ?? "?"}ms · #${receipt.definitionHash.slice(0, 12)}`,
      );
    } catch (cause) {
      setRowError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function activateRevision() {
    if (!exactProbeVerified || !reviewPolicy.canActivateAfterExactProbe) return;
    if (
      !window.confirm(
        `激活 ${revision.name} v${revision.version}？这会按 CAS 切换运行时 projection，历史版本会保留。`,
      )
    ) {
      return;
    }
    setRowError(null);
    setMessage(null);
    try {
      const receipt = await activate.mutateAsync({
        name: revision.name,
        revisionId: revision.id,
        revisionDomainId: domainId,
        expectedActiveRevisionId,
      });
      if (receipt.activated !== true) {
        throw new Error("服务端未确认 revision 已激活");
      }
      setMessage("Revision 已由当前登录用户激活，运行时目录正在刷新。");
    } catch (cause) {
      setRowError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function rejectRevision() {
    if (
      !window.confirm(
        `拒绝 ${revision.name} v${revision.version}？definition 历史会保留，但不能再激活。`,
      )
    ) {
      return;
    }
    setRowError(null);
    setMessage(null);
    try {
      const receipt = await reject.mutateAsync({
        name: revision.name,
        revisionId: revision.id,
        revisionDomainId: domainId,
      });
      if (receipt.rejected !== true) {
        throw new Error("服务端未确认 revision 已拒绝");
      }
      setMessage("Revision 已拒绝；immutable history 已保留。");
    } catch (cause) {
      setRowError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <article
      id={revisionAnchor(revision.id)}
      style={{
        display: "grid",
        gap: 10,
        padding: "11px 12px",
        border: `1px solid ${selected ? "var(--signal)" : "var(--border)"}`,
        borderRadius: 7,
        background: selected
          ? "color-mix(in srgb, var(--signal) 6%, var(--panel-2))"
          : "var(--panel-2)",
        scrollMarginTop: 24,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "minmax(180px, 1.4fr) auto minmax(220px, 1fr)",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              color: "var(--text)",
              font: "12px/1.4 var(--mono)",
              overflowWrap: "anywhere",
            }}
          >
            {revision.name} · v{revision.version}
          </div>
          <div
            style={{ marginTop: 3, color: "var(--text-3)", fontSize: 10.5 }}
          >
            {revision.source} · {sideEffect} · {operation} · domain {domainId}
          </div>
        </div>
        <Badge tone={statusTone}>{revision.status}</Badge>
        <div
          style={{
            color: "var(--text-3)",
            font: "10.5px/1.45 var(--mono)",
            textAlign: "right",
            overflowWrap: "anywhere",
          }}
        >
          #{revision.definitionHash.replace(/^sha256:/u, "").slice(0, 12)}
          <br />
          {revision.validation.passed
            ? "静态校验通过"
            : `${revision.validation.issues.length} 个静态问题`}
          {revision.status === "active"
            ? " · runtime active"
            : " · runtime inactive"}
        </div>
      </div>

      {!reviewPolicy.canProbe && reviewPolicy.lifecycleCandidate ? (
        <div
          role="alert"
          style={{
            padding: "9px 10px",
            borderRadius: 6,
            border:
              "1px solid color-mix(in srgb, var(--red) 45%, var(--border))",
            color: "var(--red)",
            fontSize: 11.5,
            lineHeight: 1.55,
          }}
        >
          <strong>Activation blocked：</strong>
          {reviewPolicy.blocker?.message ??
            (revision.validation.passed
              ? "该 revision 当前不满足受控 probe/activation 条件。"
              : revision.validation.issues.join("；"))}{" "}
          {reviewPolicy.writeLike
            ? "仅一次性授权不够；FDE 必须先注册可信的 create/readback/cleanup/absence 生命周期，再创建新 revision。"
            : "请先修复静态 contract，再保存一个新的 immutable revision。"}
        </div>
      ) : null}

      {reviewPolicy.canProbe ? (
        <details open={selected}>
          <summary
            style={{
              cursor: "pointer",
              color: "var(--text-2)",
              fontSize: 11.5,
            }}
          >
            精确 revision probe 与人工激活
          </summary>
          <div style={{ display: "grid", gap: 8, marginTop: 9 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
              }}
            >
              <label style={{ color: "var(--text-3)", fontSize: 10.5 }}>
                Probe args（JSON object）
                <textarea
                  value={argsText}
                  onChange={(event) => {
                    setArgsText(event.target.value);
                    setVerifiedHash(null);
                  }}
                  style={revisionJsonInputStyle}
                />
              </label>
              <label style={{ color: "var(--text-3)", fontSize: 10.5 }}>
                Probe config（仅 env 引用，不得填 secret）
                <textarea
                  value={configText}
                  onChange={(event) => {
                    setConfigText(event.target.value);
                    setVerifiedHash(null);
                  }}
                  style={revisionJsonInputStyle}
                />
              </label>
            </div>
            <div
              style={{
                display: "flex",
                gap: 7,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <Button
                small
                tone="ghost"
                disabled={busy}
                onClick={() => void runProbe()}
              >
                对此 revision 执行真实 probe
              </Button>
              <Button
                small
                tone="primary"
                disabled={busy || !exactProbeVerified}
                onClick={() => void activateRevision()}
              >
                {revision.status === "retired" ? "回滚并激活" : "人工激活"}
              </Button>
              <span
                style={{
                  color: exactProbeVerified
                    ? "var(--green)"
                    : "var(--text-3)",
                  font: "10.5px/1.45 var(--mono)",
                }}
              >
                CAS expected active: {expectedActiveRevisionId ?? "none"}
              </span>
            </div>
          </div>
        </details>
      ) : null}

      {reviewPolicy.canReject ? (
        <div>
          <Button
            small
            tone="ghost"
            disabled={busy}
            onClick={() => void rejectRevision()}
          >
            拒绝此草稿
          </Button>
        </div>
      ) : null}

      {message ? (
        <div role="status" style={{ color: "var(--green)", fontSize: 11.5 }}>
          {message}
        </div>
      ) : null}
      {rowError ? (
        <div role="alert" style={{ color: "var(--red)", fontSize: 11.5 }}>
          {rowError}
        </div>
      ) : null}
    </article>
  );
}

// ─── Section ────────────────────────────────────────────────────────────────

function ToolSection({
  tool,
  requestedToolName,
}: {
  tool: ToolCatalogEntry;
  requestedToolName?: string | null;
}) {
  const { t } = useI18n();
  const isRequested = requestedToolName === tool.name;
  const sectionRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!isRequested) return;
    sectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [isRequested]);
  const del = useDeleteTool();
  const toast = useToast();
  const isCreated = tool.origin === "created";
  const canDeactivateCreated =
    isCreated && Boolean(tool.activeRevisionId?.trim());
  const manifestSnippet = useMemo(() => {
    const entry: Record<string, unknown> = {
      name: tool.name,
      description: tool.summary,
    };
    if (tool.configExample && Object.keys(tool.configExample).length > 0) {
      entry.config = tool.configExample;
    }
    return JSON.stringify([entry], null, 2);
  }, [tool]);

  const hasArgs = tool.argsSchema && Object.keys(tool.argsSchema).length > 0;
  const hasConfig =
    tool.configSchema && Object.keys(tool.configSchema).length > 0;
  const hasReturns =
    tool.returnsSchema && Object.keys(tool.returnsSchema).length > 0;

  return (
    <article
      ref={sectionRef}
      id={`tool-${tool.name.replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase()}`}
      style={
        isRequested
          ? { ...sectionStyle, borderColor: "var(--signal)" }
          : sectionStyle
      }
    >
      <header style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <h3
            className="mono"
            style={{
              margin: 0,
              fontSize: 18,
              color: "var(--text)",
              fontWeight: 500,
            }}
          >
            {tool.name}
          </h3>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Badge tone="muted">{tool.category}</Badge>
            {/* #SCALE-TOOLS — empirical sandbox effectiveness: green ≥70%, red below (the ranking
                actually demotes <70% w/ ≥3 runs, so a red badge = "won't be recommended"). */}
            {typeof tool.successRate === "number" &&
              (tool.invoked ?? 0) > 0 && (
                <span
                  title={t("tools.effectiveness.tooltip", {
                    invoked: tool.invoked ?? 0,
                    succeeded: tool.succeeded ?? 0,
                  })}
                >
                  <Badge tone={tool.successRate >= 0.7 ? "green" : "red"}>
                    {t("tools.effectiveness.badge", {
                      rate: Math.round(tool.successRate * 100),
                      invoked: tool.invoked ?? 0,
                      demoted:
                        tool.successRate < 0.7 && (tool.invoked ?? 0) >= 3
                          ? t("tools.effectiveness.demoted")
                          : "",
                    })}
                  </Badge>
                </span>
              )}
            {isCreated && (
              <Badge tone="signal">{t("tools.createdBadge")}</Badge>
            )}
            {isCreated && tool.deactivationBlocker ? (
              <span title={tool.deactivationBlocker.message}>
                <Badge tone="red">需 lifecycle 迁移</Badge>
              </span>
            ) : null}
            {tool.chainsWith && tool.chainsWith.length > 0 && (
              <Badge tone="signal">
                {t("tools.chainsWith", { tools: tool.chainsWith.join(", ") })}
              </Badge>
            )}
            {isCreated && (
              <Button
                small
                tone="ghost"
                icon="trash"
                disabled={del.isPending || !canDeactivateCreated}
                title={
                  tool.deactivationBlocker?.message ??
                  "停用 active projection；immutable revision history 会保留"
                }
                onClick={() => {
                  if (!tool.activeRevisionId) return;
                  if (
                    confirm(
                      t("tools.deleteCreatedConfirm", { name: tool.name }),
                    )
                  ) {
                    del.mutate(
                      {
                        name: tool.name,
                        expectedActiveRevisionId: tool.activeRevisionId,
                        revisionDomainId:
                          tool.activeRevisionDomainId?.trim() || "__unbound__",
                      },
                      {
                        onSuccess: (receipt) => {
                          if (receipt.deactivated !== true) {
                            toast({
                              tone: "red",
                              title: t("tools.deleteCreatedFailed", {
                                message: "服务端未确认 deactivated:true",
                              }),
                            });
                            return;
                          }
                          toast({
                            tone: "green",
                            title: t("tools.deactivateCreatedSuccess", {
                              name: tool.name,
                            }),
                          });
                        },
                      onError: (error) =>
                        toast({
                          tone: "red",
                          title: t("tools.deleteCreatedFailed", {
                            message: (error as Error).message,
                          }),
                        }),
                      },
                    );
                  }
                }}
              >
                {t("tools.deleteCreated")}
              </Button>
            )}
          </div>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: 13,
            color: "var(--text)",
            lineHeight: 1.5,
          }}
        >
          {tool.summary}
        </p>
        {tool.description && (
          <p
            style={{
              margin: "4px 0 0",
              fontSize: 12.5,
              color: "var(--text-2)",
              lineHeight: 1.55,
            }}
          >
            {tool.description}
          </p>
        )}
        <div
          style={{
            display: "flex",
            gap: 14,
            fontSize: 11,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
            marginTop: 4,
            flexWrap: "wrap",
          }}
        >
          {tool.aliases && tool.aliases.length > 0 && (
            <span>
              {t("tools.aliasesLabel")} {tool.aliases.join(", ")}
            </span>
          )}
          <span>
            {t("tools.sourceLabel")} {tool.sourcePath}
          </span>
        </div>
      </header>

      <SubBlock
        title={t("tools.manifestDeclaration")}
        copyText={manifestSnippet}
      >
        <pre style={preStyle}>{manifestSnippet}</pre>
      </SubBlock>

      {hasArgs ? (
        <SubBlock
          title={t("tools.arguments")}
          subtitle={t("tools.argumentsSubtitle")}
        >
          <SchemaTable schema={tool.argsSchema!} />
          {tool.argsExample && Object.keys(tool.argsExample).length > 0 && (
            <ExampleBlock value={tool.argsExample} label={t("tools.example")} />
          )}
        </SubBlock>
      ) : (
        <SubBlock title={t("tools.arguments")}>
          <p style={mutedNoteStyle}>
            {t("tools.noArgsPart1")} <code className="mono">{"{}"}</code>.
          </p>
        </SubBlock>
      )}

      {hasReturns && (
        <SubBlock
          title={t("tools.returns")}
          subtitle={t("tools.returnsSubtitle")}
        >
          <SchemaTable schema={tool.returnsSchema!} />
          {tool.returnsExample !== undefined && (
            <ExampleBlock
              value={tool.returnsExample}
              label={t("tools.example")}
            />
          )}
        </SubBlock>
      )}

      {hasConfig ? (
        <SubBlock
          title={t("tools.perTenantConfig")}
          subtitle={t("tools.perTenantConfigSubtitle")}
        >
          <SchemaTable schema={tool.configSchema!} />
          {tool.configExample && Object.keys(tool.configExample).length > 0 && (
            <ExampleBlock
              value={tool.configExample}
              label={t("tools.exampleConfig")}
            />
          )}
        </SubBlock>
      ) : (
        <SubBlock title={t("tools.perTenantConfig")}>
          <p style={mutedNoteStyle}>{t("tools.noConfig")}</p>
        </SubBlock>
      )}

      <FactoryIntegrationProfiles tool={tool} />
    </article>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function SubBlock({
  title,
  subtitle,
  copyText,
  children,
}: {
  title: string;
  subtitle?: string;
  copyText?: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      toast({
        tone: "red",
        title: t("tools.copyFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 6,
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 10.5,
              textTransform: "uppercase",
              letterSpacing: 0.6,
              color: "var(--text-3)",
              fontFamily: "var(--mono)",
              fontWeight: 600,
            }}
          >
            {title}
          </div>
          {subtitle && (
            <div
              style={{
                fontSize: 11.5,
                color: "var(--text-3)",
                marginTop: 2,
                lineHeight: 1.4,
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
        {copyText && (
          <Button
            small
            tone="ghost"
            icon={copied ? "check" : "code"}
            onClick={copy}
          >
            {copied ? t("tools.copied") : t("tools.copy")}
          </Button>
        )}
      </div>
      {children}
    </div>
  );
}

function SchemaTable({ schema }: { schema: Record<string, ToolFieldSchema> }) {
  const { t } = useI18n();
  const entries = Object.entries(schema);
  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={thStyle}>{t("tools.colField")}</th>
          <th style={thStyle}>{t("tools.colType")}</th>
          <th style={thStyle}>{t("tools.colDefault")}</th>
          <th style={thStyle}>{t("tools.colDescription")}</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([key, def]) => (
          <tr key={key} style={{ borderTop: "1px solid var(--border)" }}>
            <td style={tdMono}>
              {key}
              {def.required && (
                <span
                  style={{
                    color: "var(--red)",
                    marginLeft: 4,
                    fontFamily: "var(--mono)",
                  }}
                  title={t("tools.required")}
                >
                  *
                </span>
              )}
            </td>
            <td style={tdMono}>{def.type}</td>
            <td style={tdMono}>
              {def.default !== undefined
                ? typeof def.default === "string"
                  ? `"${def.default}"`
                  : JSON.stringify(def.default)
                : "—"}
            </td>
            <td style={td}>{def.description ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ExampleBlock({ value, label }: { value: unknown; label: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const json = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      toast({
        tone: "red",
        title: t("tools.copyFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            textTransform: "uppercase",
            letterSpacing: 0.6,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
          }}
        >
          {label}
        </span>
        <Button
          small
          tone="ghost"
          icon={copied ? "check" : "code"}
          onClick={copy}
        >
          {copied ? t("tools.copied") : t("tools.copy")}
        </Button>
      </div>
      <pre style={preStyle}>{json}</pre>
    </div>
  );
}

// ─── styles ─────────────────────────────────────────────────────────────────

const catLabelStyle: React.CSSProperties = {
  fontSize: 10.5,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "var(--text-3)",
  fontFamily: "var(--mono)",
  marginBottom: 2,
};

const navLinkStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "4px 6px",
  fontSize: 12,
  fontFamily: "var(--mono)",
  color: "var(--text-2)",
  background: "transparent",
  border: "none",
  borderRadius: 3,
  cursor: "pointer",
  lineHeight: 1.4,
};

const introStyle: React.CSSProperties = {
  paddingBottom: 8,
  borderBottom: "1px solid var(--border)",
};
const introBodyStyle: React.CSSProperties = {
  margin: "8px 0 0",
  fontSize: 12.5,
  color: "var(--text-2)",
  lineHeight: 1.55,
};

const categoryHeadingStyle: React.CSSProperties = {
  margin: 0,
  paddingBottom: 4,
  borderBottom: "1px solid var(--border)",
  fontSize: 14,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "var(--text-3)",
  fontFamily: "var(--mono)",
};

const sectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: "18px 20px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--panel)",
  scrollMarginTop: 16,
};

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: 12,
  background: "var(--panel-2)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  fontFamily: "var(--mono)",
  fontSize: 12,
  color: "var(--text)",
  lineHeight: 1.5,
  overflow: "auto",
  whiteSpace: "pre",
};

const revisionJsonInputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  minHeight: 58,
  marginTop: 4,
  padding: "7px 8px",
  resize: "vertical",
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--text)",
  font: "11px/1.45 var(--mono)",
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 12.5,
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 10px",
  fontSize: 10.5,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--text-3)",
  fontFamily: "var(--mono)",
};

const td: React.CSSProperties = {
  padding: "8px 10px",
  fontSize: 12,
  color: "var(--text-2)",
  verticalAlign: "top",
  lineHeight: 1.45,
};

const tdMono: React.CSSProperties = {
  ...td,
  fontFamily: "var(--mono)",
  color: "var(--text)",
  whiteSpace: "nowrap",
};

const mutedNoteStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12.5,
  color: "var(--text-3)",
  lineHeight: 1.5,
};
