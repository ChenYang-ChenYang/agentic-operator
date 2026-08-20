"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Empty,
  Icon,
  SearchInput,
  StatusDot,
  ViewHeader,
  useToast,
  type StatusName,
} from "@/app/portal/components";
import { fmtAgo, fmtDur } from "@/app/portal/lib/format";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  useBulkRunAction,
  useDeleteRun,
  useRestoreRun,
  useRunsPaged,
  type BulkRunAction,
  type RunBusinessResult,
  type RunInvocationSource,
  type RunListRow,
} from "@/lib/hooks/useRuns";
import { useCounts } from "@/lib/hooks/useAgents";

const STATUS_TO_DOT: Record<string, StatusName> = {
  running: "running",
  queued: "waiting",
  waiting: "waiting",
  ok: "ok",
  failed: "failed",
  cancelled: "cancelled",
};

type StatusFilter =
  | "all"
  | "running"
  | "waiting"
  | "ok"
  | "failed"
  | "cancelled";
type TimeRange = "all" | "24h" | "7d" | "30d";

function timeRangeStart(range: TimeRange): number | undefined {
  if (range === "all") return undefined;
  const hours = range === "24h" ? 24 : range === "7d" ? 24 * 7 : 24 * 30;
  return Date.now() - hours * 60 * 60 * 1_000;
}

export default function RunsPage() {
  const tenant = useTenant();
  const { language, t } = useI18n();
  const toast = useToast();
  const copy = (zh: string, en: string) => (language === "zh" ? zh : en);

  const [status, setStatus] = useState<StatusFilter>("all");
  const [source, setSource] = useState<RunInvocationSource | "all">("all");
  const [businessResult, setBusinessResult] = useState<
    RunBusinessResult | "all"
  >("all");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [binMode, setBinMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const id = setTimeout(() => setQuery(queryInput.trim()), 300);
    return () => clearTimeout(id);
  }, [queryInput]);

  const filterSnapshot = useMemo(
    () => ({
      status: binMode || status === "all" ? undefined : status,
      q: query || undefined,
      invocationSource: source === "all" ? undefined : source,
      businessResult: businessResult === "all" ? undefined : businessResult,
      from: timeRangeStart(timeRange),
      deleted: binMode,
    }),
    [binMode, businessResult, query, source, status, timeRange],
  );

  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
    setAllMatching(false);
    setExcludedIds(new Set());
  }, [filterSnapshot, pageSize]);

  const runsQuery = useRunsPaged({
    ...filterSnapshot,
    page,
    pageSize,
  });
  const countsQuery = useCounts();
  const deleteRun = useDeleteRun();
  const restoreRun = useRestoreRun();
  const bulkAction = useBulkRunAction();

  const dataReady =
    runsQuery.data !== undefined &&
    !runsQuery.isPlaceholderData &&
    !runsQuery.isError;
  const rows = dataReady ? runsQuery.data.rows : [];
  const total = dataReady ? runsQuery.data.total : 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const selectedCount = allMatching
    ? Math.max(0, total - excludedIds.size)
    : selectedIds.size;
  const isSelected = (id: string) =>
    allMatching ? !excludedIds.has(id) : selectedIds.has(id);
  const pageAllSelected =
    rows.length > 0 && rows.every((row) => isSelected(row.id));
  const busy =
    bulkAction.isPending || deleteRun.isPending || restoreRun.isPending;

  function clearSelection() {
    setSelectedIds(new Set());
    setAllMatching(false);
    setExcludedIds(new Set());
  }

  function toggleRow(id: string) {
    if (allMatching) {
      setExcludedIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePage() {
    if (allMatching) {
      setExcludedIds((current) => {
        const next = new Set(current);
        for (const row of rows) {
          if (pageAllSelected) next.add(row.id);
          else next.delete(row.id);
        }
        return next;
      });
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const row of rows) {
        if (pageAllSelected) next.delete(row.id);
        else next.add(row.id);
      }
      return next;
    });
  }

  function runBulk(action: BulkRunAction) {
    if (selectedCount === 0) return;
    const destructive = action === "purge";
    const label = {
      delete: copy("移入回收站", "move to recycle bin"),
      restore: copy("恢复", "restore"),
      purge: copy("永久删除", "permanently delete"),
      replay: copy("重新运行", "replay"),
    }[action];
    if (
      !window.confirm(
        copy(
          `确认${label}选中的 ${selectedCount} 条运行记录？${destructive ? " 此操作不可恢复。" : ""}`,
          `Confirm ${label} for ${selectedCount} selected run(s)?${destructive ? " This cannot be undone." : ""}`,
        ),
      )
    ) {
      return;
    }
    bulkAction.mutate(
      {
        action,
        selection: allMatching
          ? {
              mode: "filter",
              filter: filterSnapshot,
              excludeIds: [...excludedIds],
            }
          : { mode: "ids", ids: [...selectedIds] },
      },
      {
        onSuccess: (result) => {
          clearSelection();
          toast({
            tone: result.failures?.length ? "amber" : "green",
            title: copy("批量操作完成", "Bulk action completed"),
            description: copy(
              `已处理 ${result.affected} 条，跳过 ${result.skipped} 条。`,
              `${result.affected} processed, ${result.skipped} skipped.`,
            ),
          });
        },
        onError: (error) =>
          toast({
            tone: "red",
            title: copy("批量操作失败", "Bulk action failed"),
            description: error.message,
          }),
      },
    );
  }

  const countValue: string | number = dataReady
    ? total
    : runsQuery.isFetching
      ? "…"
      : "—";
  const activeValue: string | number = countsQuery.isError
    ? "—"
    : countsQuery.data
      ? countsQuery.data.runningRuns
      : "…";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("nav.runs")}
        subtitle={t("runs.summary", { count: countValue, active: activeValue })}
        action={
          <div style={{ display: "flex", gap: 6 }}>
            <Button
              small
              tone={binMode ? "ghost" : "primary"}
              onClick={() => setBinMode(false)}
            >
              {t("runs.activeRecords")}
            </Button>
            <Button
              small
              icon="trash"
              tone={binMode ? "primary" : "ghost"}
              onClick={() => setBinMode(true)}
            >
              {t("runs.recycleBin")}
            </Button>
          </div>
        }
      />

      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <div style={{ width: 300, maxWidth: "100%" }}>
          <SearchInput
            value={queryInput}
            onChange={setQueryInput}
            placeholder={copy(
              "搜索 Run ID、Agent、Subject、事件、Correlation ID",
              "Search run, agent, subject, event, correlation",
            )}
          />
        </div>
        <Select
          value={status}
          onChange={(value) => setStatus(value as StatusFilter)}
          options={[
            ["all", copy("全部状态", "All statuses")],
            ["running", copy("运行中", "Running")],
            ["waiting", copy("等待中", "Waiting")],
            ["ok", copy("成功", "Succeeded")],
            ["failed", copy("失败", "Failed")],
            ["cancelled", copy("已取消", "Cancelled")],
          ]}
          disabled={binMode}
        />
        <Select
          value={source}
          onChange={(value) => setSource(value as RunInvocationSource | "all")}
          options={[
            ["all", copy("全部来源", "All sources")],
            ["event", "Event"],
            ["api", "API"],
            ["studio", "Studio"],
            ["replay", copy("重跑", "Replay")],
            ["demo", "Demo"],
          ]}
        />
        <Select
          value={businessResult}
          onChange={(value) =>
            setBusinessResult(value as RunBusinessResult | "all")
          }
          options={[
            ["all", copy("全部业务结果", "All business results")],
            ["produced", copy("已产出", "Output produced")],
            ["completed", copy("已完成", "Completed")],
            ["no_output", copy("无业务产出", "No output")],
            ["invalid", copy("产出无效", "Invalid output")],
            ["failed", copy("执行失败", "Execution failed")],
            ["pending", copy("处理中", "In progress")],
          ]}
        />
        <Select
          value={timeRange}
          onChange={(value) => setTimeRange(value as TimeRange)}
          options={[
            ["all", copy("全部时间", "All time")],
            ["24h", copy("最近 24 小时", "Last 24 hours")],
            ["7d", copy("最近 7 天", "Last 7 days")],
            ["30d", copy("最近 30 天", "Last 30 days")],
          ]}
        />
        {runsQuery.isFetching && (
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>
            {copy("正在刷新…", "Refreshing…")}
          </span>
        )}
      </div>

      {selectedCount > 0 && (
        <div
          style={{
            minHeight: 46,
            padding: "8px 16px",
            borderBottom: "1px solid var(--border)",
            background: "color-mix(in srgb, var(--signal) 8%, var(--panel))",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <strong style={{ fontSize: 12 }}>
            {copy(`已选择 ${selectedCount} 条`, `${selectedCount} selected`)}
          </strong>
          {!allMatching &&
            selectedIds.size === rows.length &&
            total > rows.length && (
              <button
                type="button"
                onClick={() => {
                  setAllMatching(true);
                  setSelectedIds(new Set());
                }}
                style={textButtonStyle}
              >
                {copy(
                  `选择符合当前筛选的全部 ${total} 条`,
                  `Select all ${total} matching runs`,
                )}
              </button>
            )}
          {allMatching && (
            <span style={{ fontSize: 11, color: "var(--text-2)" }}>
              {copy("已跨分页全选当前筛选结果", "All matching pages selected")}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {!binMode ? (
            <>
              <Button
                small
                icon="replay"
                onClick={() => runBulk("replay")}
                disabled={busy}
              >
                {copy("批量重跑", "Replay")}
              </Button>
              <Button
                small
                tone="danger"
                icon="trash"
                onClick={() => runBulk("delete")}
                disabled={busy}
              >
                {copy("删除", "Delete")}
              </Button>
            </>
          ) : (
            <>
              <Button
                small
                icon="replay"
                onClick={() => runBulk("restore")}
                disabled={busy}
              >
                {copy("恢复", "Restore")}
              </Button>
              <Button
                small
                tone="danger"
                icon="trash"
                onClick={() => runBulk("purge")}
                disabled={busy}
              >
                {copy("永久删除", "Delete permanently")}
              </Button>
            </>
          )}
          <Button small tone="ghost" onClick={clearSelection} disabled={busy}>
            {copy("取消选择", "Clear")}
          </Button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {runsQuery.isError ? (
          <Empty
            title={t("runs.loadFailed")}
            hint={
              runsQuery.error instanceof Error
                ? runsQuery.error.message
                : t("runs.loadFailedHint")
            }
          />
        ) : runsQuery.isFetching && !dataReady ? (
          <Empty title={t("runs.loading")} hint="" />
        ) : rows.length === 0 ? (
          <Empty
            title={binMode ? t("runs.binEmptyTitle") : t("runs.emptyTitle")}
            hint={binMode ? t("runs.binEmptyHint") : t("runs.emptyHint")}
          />
        ) : (
          <table
            style={{
              width: "100%",
              minWidth: 1080,
              borderCollapse: "collapse",
              tableLayout: "fixed",
            }}
          >
            <thead
              style={{ position: "sticky", top: 0, zIndex: "var(--z-overlay)" }}
            >
              <tr style={{ background: "var(--panel-2)" }}>
                <HeaderCell width={46}>
                  <input
                    type="checkbox"
                    checked={pageAllSelected}
                    onChange={togglePage}
                    aria-label={copy("选择本页", "Select page")}
                  />
                </HeaderCell>
                <HeaderCell width={230}>
                  {copy("智能体 / Run", "Agent / Run")}
                </HeaderCell>
                <HeaderCell width={220}>
                  {copy("触发事件", "Trigger")}
                </HeaderCell>
                <HeaderCell width={210}>
                  {copy("运行状态 / Step", "Status / Step")}
                </HeaderCell>
                <HeaderCell width={145}>
                  {copy("业务结果", "Business result")}
                </HeaderCell>
                <HeaderCell width={130}>{copy("开始", "Started")}</HeaderCell>
                <HeaderCell width={100}>{copy("耗时", "Duration")}</HeaderCell>
                <HeaderCell width={110}>{copy("操作", "Actions")}</HeaderCell>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <RunTableRow
                  key={row.id}
                  row={row}
                  tenant={tenant}
                  binMode={binMode}
                  selected={isSelected(row.id)}
                  onToggle={() => toggleRow(row.id)}
                  onDelete={() =>
                    deleteRun.mutate(row.id, {
                      onError: (error) =>
                        toast({
                          tone: "red",
                          title: t("runs.deleteFailed"),
                          description: error.message,
                        }),
                    })
                  }
                  onRestore={() =>
                    restoreRun.mutate(row.id, {
                      onError: (error) =>
                        toast({
                          tone: "red",
                          title: t("runs.restoreFailed"),
                          description: error.message,
                        }),
                    })
                  }
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div
        style={{
          padding: "9px 16px",
          borderTop: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span
            className="mono"
            style={{ fontSize: 11, color: "var(--text-3)" }}
          >
            {total === 0
              ? "0"
              : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} / ${total}`}
          </span>
          <Select
            value={String(pageSize)}
            onChange={(value) => setPageSize(Number(value))}
            options={[
              ["25", "25 / page"],
              ["50", "50 / page"],
              ["100", "100 / page"],
            ]}
          />
        </div>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <span
            className="mono"
            style={{ fontSize: 11, color: "var(--text-3)" }}
          >
            {page} / {pages}
          </span>
          <Button
            small
            icon="chevron-left"
            ariaLabel={t("runs.prevPage")}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={!dataReady || page <= 1}
          />
          <Button
            small
            icon="chevron-right"
            ariaLabel={t("runs.nextPage")}
            onClick={() => setPage((current) => Math.min(pages, current + 1))}
            disabled={!dataReady || page >= pages}
          />
        </div>
      </div>
    </div>
  );
}

function RunTableRow({
  row,
  tenant,
  binMode,
  selected,
  onToggle,
  onDelete,
  onRestore,
}: {
  row: RunListRow;
  tenant: string;
  binMode: boolean;
  selected: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const { language, t } = useI18n();
  const copy = (zh: string, en: string) => (language === "zh" ? zh : en);
  const businessLabel: Record<string, string> = {
    pending: copy("处理中", "In progress"),
    produced: copy("已产出", "Produced"),
    completed: copy("已完成", "Completed"),
    no_output: copy("无业务产出", "No output"),
    invalid: copy("产出无效", "Invalid"),
    failed: copy("执行失败", "Failed"),
  };
  const businessTone =
    row.businessResult === "produced" || row.businessResult === "completed"
      ? "green"
      : row.businessResult === "pending"
        ? "amber"
        : row.businessResult === "failed" || row.businessResult === "invalid"
          ? "red"
          : "muted";
  return (
    <tr
      style={{
        borderBottom: "1px solid var(--border)",
        background: selected
          ? "color-mix(in srgb, var(--signal) 7%, transparent)"
          : "transparent",
        opacity: binMode ? 0.78 : 1,
      }}
    >
      <Cell>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={copy(`选择 ${row.id}`, `Select ${row.id}`)}
        />
      </Cell>
      <Cell>
        <Link
          href={`/portal/${tenant}/runs/${row.id}` as never}
          style={{ color: "inherit", textDecoration: "none", display: "block" }}
        >
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {row.agentTitle ?? row.agentName}
          </div>
          <div
            className="mono"
            title={row.id}
            style={{
              marginTop: 4,
              fontSize: 10.5,
              color: "var(--text-3)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.id}
          </div>
          <div style={{ display: "flex", gap: 4, marginTop: 5 }}>
            {row.testRun && <Badge tone="signal">{t("runs.badgeTest")}</Badge>}
            {row.invocationSource === "replay" && (
              <Badge tone="amber">{t("runs.badgeReplay")}</Badge>
            )}
            {row.parentRunId && row.invocationSource !== "replay" && (
              <Badge tone="muted">{copy("子运行", "Child")}</Badge>
            )}
          </div>
        </Link>
      </Cell>
      <Cell>
        <div className="mono" style={{ fontSize: 11.5 }}>
          {row.triggerEvent ?? "—"}
        </div>
        <div
          className="mono"
          title={row.subject ?? undefined}
          style={{
            marginTop: 5,
            color: "var(--text-3)",
            fontSize: 10.5,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.subject ?? "—"}
        </div>
      </Cell>
      <Cell>
        <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
          <StatusDot status={STATUS_TO_DOT[row.status] ?? "idle"} />
          <span style={{ fontSize: 12 }}>{row.status}</span>
          {row.invocationSource && (
            <span
              className="mono"
              style={{ fontSize: 10, color: "var(--text-3)" }}
            >
              {row.invocationSource}
            </span>
          )}
        </div>
        <div
          style={{
            marginTop: 6,
            fontSize: 10.5,
            color: "var(--text-3)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.currentStepName
            ? `${row.currentStepOrd ?? "–"}/${row.stepCount ?? "–"} · ${row.currentStepName}`
            : row.stepCount
              ? `${row.stepCount} steps`
              : "—"}
        </div>
      </Cell>
      <Cell>
        <Badge tone={businessTone as "green" | "amber" | "red" | "muted"}>
          {businessLabel[row.businessResult ?? ""] ?? "—"}
        </Badge>
        {row.emittedEvent && (
          <div
            className="mono"
            title={row.emittedEvent}
            style={{
              marginTop: 6,
              fontSize: 10,
              color: "var(--text-3)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {row.emittedEvent}
          </div>
        )}
      </Cell>
      <Cell>
        <div style={{ fontSize: 11.5 }}>
          {row.startedAt ? fmtAgo(Date.parse(row.startedAt), language) : "—"}
        </div>
        {row.startedAt && (
          <div
            className="mono"
            style={{ marginTop: 5, fontSize: 9.5, color: "var(--text-3)" }}
          >
            {new Date(row.startedAt).toLocaleString()}
          </div>
        )}
      </Cell>
      <Cell>
        <span className="mono" style={{ fontSize: 11.5 }}>
          {fmtDur(row.durationMs)}
        </span>
      </Cell>
      <Cell>
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <button
            type="button"
            onClick={binMode ? onRestore : onDelete}
            title={binMode ? t("runs.restore") : t("runs.deleteRun")}
            aria-label={binMode ? t("runs.restore") : t("runs.deleteRun")}
            style={iconButtonStyle}
          >
            <Icon name={binMode ? "replay" : "trash"} size={13} />
          </button>
          {!binMode && (
            <Link
              href={`/portal/${tenant}/runs/${row.id}` as never}
              aria-label={copy("查看运行详情", "View run detail")}
              style={iconButtonStyle}
            >
              <Icon name="chevron-right" size={13} />
            </Link>
          )}
        </div>
      </Cell>
    </tr>
  );
}

function HeaderCell({
  children,
  width,
}: {
  children: React.ReactNode;
  width: number;
}) {
  return (
    <th
      style={{
        width,
        padding: "10px 12px",
        borderBottom: "1px solid var(--border)",
        color: "var(--text-3)",
        fontSize: 10.5,
        fontWeight: 600,
        textAlign: "left",
        letterSpacing: "0.02em",
      }}
    >
      {children}
    </th>
  );
}

function Cell({ children }: { children: React.ReactNode }) {
  return (
    <td
      style={{
        padding: "11px 12px",
        verticalAlign: "middle",
        minWidth: 0,
      }}
    >
      {children}
    </td>
  );
}

function Select({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      style={{
        height: 30,
        padding: "0 28px 0 9px",
        borderRadius: 6,
        border: "1px solid var(--border-2)",
        background: "var(--panel-2)",
        color: "var(--text-2)",
        fontSize: 11,
      }}
    >
      {options.map(([optionValue, label]) => (
        <option key={optionValue} value={optionValue}>
          {label}
        </option>
      ))}
    </select>
  );
}

const iconButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  padding: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--panel-2)",
  color: "var(--text-2)",
  cursor: "pointer",
  textDecoration: "none",
};

const textButtonStyle: React.CSSProperties = {
  border: 0,
  background: "transparent",
  color: "var(--signal)",
  cursor: "pointer",
  padding: 0,
  fontSize: 11,
  textDecoration: "underline",
};
