"use client";

/**
 * Sidebar — compact 64px icon rail that expands to 232px without reflowing
 * the active portal view.
 *
 * Top to bottom: Logo + version, TenantSwitcher, 3 nav groups (Run / Observe
 * / Manage), footer status dots (Inngest + SQLite).
 *
 * Live + count pills come from GET /v1/counts. Unlike list-query lengths,
 * these tenant-wide totals are not truncated by pagination and `openTasks`
 * excludes resolved work.
 *
 * The host layout passes in the resolved tenant list so we don't refetch.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTenant } from "../../lib/use-tenant";
import { useCounts } from "@/lib/hooks/useAgents";
import { useHealth, fmtBytes } from "@/lib/hooks/useHealth";
import { useCan } from "@/lib/hooks/useMe";
import { StatusDot } from "../atoms";
import { Icon } from "../Icon";
import { Logo } from "./logo";
import { NavGroup, NavItem } from "./nav";
import { TenantSwitcher, type TenantOption } from "./tenant-switcher";
import { useI18n } from "../../lib/preferences-context";
import styles from "./sidebar.module.css";

export interface SidebarProps {
  tenants: TenantOption[];
  version?: string;
}

export function Sidebar({
  tenants,
  version = (process.env.NEXT_PUBLIC_APP_VERSION ?? "").trim(),
}: SidebarProps) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [tooltip, setTooltip] = useState<{
    text: string;
    top: number;
    left: number;
  } | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tenantSlug = useTenant();
  const base = `/portal/${tenantSlug}`;
  const { t } = useI18n();
  const can = useCan();
  const { data: counts } = useCounts();
  // Live health from /health — replaces the previously hardcoded
  // "3w · 0 lag" Inngest meta and "8.4 MB" SQLite meta in the footer so
  // both rows reflect real runtime status.
  const { data: health } = useHealth();

  const inngestMeta = useMemo(() => {
    if (!health?.inngest) return t("sidebar.healthChecking");
    if (health.inngest.note) return health.inngest.note;
    return health.inngest.reachable
      ? t("sidebar.healthReachable")
      : t("sidebar.healthUnreachable");
  }, [health?.inngest, t]);
  const inngestStatus: "ok" | "failed" = health?.inngest?.ok ? "ok" : "failed";
  const sqliteMeta = useMemo(() => {
    if (!health?.sqlite) return t("sidebar.healthChecking");
    return fmtBytes(health.sqlite.sizeBytes);
  }, [health?.sqlite, t]);
  const sqliteStatus: "ok" | "failed" = health?.sqlite?.ok ? "ok" : "failed";
  const expanded = pinnedOpen || hoverOpen || focusOpen;

  function clearTimer(timer: typeof openTimer) {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  function handlePointerEnter(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === "touch" || pinnedOpen) return;
    clearTimer(closeTimer);
    clearTimer(openTimer);
    // The brief tooltip gets a moment to orient users before the full rail
    // opens. Moving through the app chrome therefore feels intentional,
    // rather than making the navigation flash on every incidental pass.
    openTimer.current = setTimeout(() => setHoverOpen(true), 420);
  }

  function handlePointerLeave(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === "touch") return;
    clearTimer(openTimer);
    clearTimer(closeTimer);
    setTooltip(null);
    closeTimer.current = setTimeout(() => setHoverOpen(false), 140);
  }

  function handleFocus(event: FocusEvent<HTMLElement>) {
    clearTimer(closeTimer);
    // Keep the pin control stationary until its activation completes. If
    // focus expanded the rail first, the button would jump from the compact
    // rail edge to the expanded edge between pointer-down and click, causing
    // the first click to miss. Keyboard users can still press Enter/Space to
    // pin the rail, after which all labels are visible.
    if (
      event.target instanceof Element &&
      event.target.closest("[data-sidebar-pin]")
    ) {
      return;
    }
    setFocusOpen(true);
    setTooltip(null);
    // Focus is delegated at the aside, so every link expands the rail before
    // its visible focus ring is drawn. This keeps keyboard navigation legible.
  }

  function handleBlur(event: FocusEvent<HTMLElement>) {
    const next = event.relatedTarget;
    if (!next || !event.currentTarget.contains(next as Node)) {
      setFocusOpen(false);
    }
  }

  function handlePointerOver(event: PointerEvent<HTMLElement>) {
    if (expanded || !(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLElement>("[data-sidebar-tooltip]");
    if (!target || !event.currentTarget.contains(target)) return;
    const text = target.dataset.sidebarTooltip;
    if (!text) return;
    const rect = target.getBoundingClientRect();
    setTooltip({
      text,
      top: rect.top + rect.height / 2,
      left: rect.right + 8,
    });
  }

  function handlePointerOut(event: PointerEvent<HTMLElement>) {
    if (!(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLElement>("[data-sidebar-tooltip]");
    if (!target) return;
    if (
      event.relatedTarget instanceof Node &&
      target.contains(event.relatedTarget)
    ) {
      return;
    }
    setTooltip(null);
  }

  useEffect(
    () => () => {
      if (openTimer.current) clearTimeout(openTimer.current);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  return (
    <>
      <aside
        className={styles.sidebar}
        data-expanded={expanded}
        aria-label={t("sidebar.primaryNavigation")}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onPointerOver={handlePointerOver}
        onPointerOut={handlePointerOut}
        onFocusCapture={handleFocus}
        onBlurCapture={handleBlur}
      >
        {/* Logo block */}
        <div className={styles.header}>
          <span className={styles.brandLogo} aria-hidden="true">
            <Logo />
          </span>
          <div className={styles.brandText}>
            <span className={styles.brandName}>Agentic Operator</span>
            {version && <span className={styles.brandVersion}>{version}</span>}
          </div>
          <button
            type="button"
            className={styles.pinButton}
            aria-label={
              pinnedOpen ? t("sidebar.returnAutomatic") : t("sidebar.keepOpen")
            }
            aria-pressed={pinnedOpen}
            aria-expanded={expanded}
            data-sidebar-pin
            data-sidebar-tooltip={
              pinnedOpen
                ? t("sidebar.useAutomatic")
                : expanded
                  ? t("sidebar.keepOpen")
                  : t("sidebar.openNavigation")
            }
            onClick={() => {
              setTooltip(null);
              setPinnedOpen((value) => !value);
              if (pinnedOpen) setHoverOpen(false);
            }}
          >
            <Icon
              name={pinnedOpen ? "chevron-left" : "chevron-right"}
              size={13}
            />
          </button>
        </div>

        <TenantSwitcher
          tenants={tenants}
          expanded={expanded}
          onRequestExpand={() => {
            setTooltip(null);
            setPinnedOpen(true);
          }}
        />

        <nav className={styles.nav} aria-label={t("sidebar.portalSections")}>
          <NavGroup label={t("nav.group.run")}>
            <NavItem
              href={`${base}/dashboard`}
              icon="dashboard"
              label={t("nav.dashboard")}
            />
            <NavItem
              href={`${base}/workflows`}
              icon="workflow"
              label={t("nav.workflows")}
            />
            <NavItem
              href={`${base}/agents`}
              icon="agent"
              label={t("nav.agents")}
              count={counts?.agents || null}
              matchPrefix
            />
            <NavItem
              href={`${base}/runs`}
              icon="run"
              label={t("nav.runs")}
              liveCount={counts?.runningRuns ?? 0}
              matchPrefix
            />
          </NavGroup>
          <NavGroup label={t("nav.group.observe")}>
            <NavItem
              href={`${base}/events`}
              icon="event"
              label={t("nav.events")}
              matchPrefix
            />
            <NavItem
              href={`${base}/tasks`}
              icon="task"
              label={t("nav.tasks")}
              count={counts?.openTasks || null}
              highlight={(counts?.openTasks ?? 0) > 0}
              matchPrefix
            />
            <NavItem href={`${base}/logs`} icon="logs" label={t("nav.logs")} />
            <NavItem
              href={`${base}/reasoning`}
              icon="spark"
              label={t("nav.reasoning")}
              matchPrefix
            />
          </NavGroup>
          <NavGroup label={t("nav.group.manage")}>
            {/* The conversational workspace is OntoCode's canonical product
                surface. Its prefix match also keeps this item active while a
                user is inside an individual Build Session. */}
            <NavItem
              href={`${base}/ontocode-workspace`}
              icon="spark"
              label={t("nav.ontocode")}
              matchPrefix
            />
            <NavItem
              href={`${base}/deployments`}
              icon="deploy"
              label={t("nav.deployments")}
            />
            <NavItem
              href={`${base}/system-check`}
              icon="check"
              label={t("nav.systemCheck")}
              matchPrefix
            />
            <NavItem
              href={`${base}/tools`}
              icon="library"
              label={t("nav.toolLibrary")}
              matchPrefix
            />
            <NavItem
              href={`${base}/tenants`}
              icon="agent"
              label={t("nav.tenants")}
              matchPrefix
            />
            {/* P6-AUTH — Access & roles. Shown only to tenant admins (members.read)
             * and platform superadmins; viewers/operators never see it. */}
            {can("members.read") ? (
              <NavItem
                href={`${base}/access`}
                icon="human"
                label={t("nav.access")}
                matchPrefix
              />
            ) : null}
            <NavItem
              href={`${base}/settings`}
              icon="settings"
              label={t("nav.settings")}
              matchPrefix
            />
          </NavGroup>
        </nav>

        <footer
          className={styles.footer}
          aria-label={t("sidebar.systemStatus")}
        >
          <FooterRow
            status={inngestStatus}
            label="Inngest"
            meta={inngestMeta}
          />
          <FooterRow status={sqliteStatus} label="SQLite" meta={sqliteMeta} />
        </footer>
      </aside>
      {!expanded && tooltip && typeof document !== "undefined"
        ? createPortal(
            <div
              role="tooltip"
              className={styles.sidebarTooltip}
              style={{ top: tooltip.top, left: tooltip.left }}
            >
              {tooltip.text}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function FooterRow({
  status,
  label,
  meta,
}: {
  status: "ok" | "failed";
  label: string;
  meta: string;
}) {
  return (
    <div
      className={styles.footerRow}
      aria-label={`${label}: ${meta}`}
      data-sidebar-tooltip={`${label}: ${meta}`}
    >
      <StatusDot status={status} size={6} />
      <span className={styles.footerLabel}>{label}</span>
      <span className={styles.footerMeta}>{meta}</span>
    </div>
  );
}
