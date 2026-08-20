"use client";
// OntoCode v10 · 三栏布局的唯一持有者：宽度 + 收起状态 + 持久化 + 视口跟踪。
//
// 单一写入方是刻意的：如果 Shell 和容器各写各的 localStorage，一次收起就会
// 把另一方刚存的宽度盖掉。纯几何/校验/reducer 都在 workbench-layout.ts，
// 这里只做 React 侧的副作用接线（DOM 依赖，不进 node 单测）。
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  DEFAULT_WORKBENCH_LAYOUT,
  readWorkbenchLayout,
  workbenchLayoutReducer,
  workbenchLayoutStorageKey,
  writeWorkbenchLayout,
} from "./workbench-layout";
import type { WorkbenchLayout } from "./workbench-layout";

export interface UseWorkbenchLayoutResult {
  layout: WorkbenchLayout;
  /** Live `window.innerWidth`; 0 until the first client effect runs. */
  viewportWidth: number;
  toggleRail: () => void;
  toggleInspector: () => void;
  /** Kept boolean-only (`open`), matching the call sites that force the
   *  inspector open when a card or stage doc wants to show something. */
  setInspectorOpen: (open: boolean) => void;
  resizeRail: (width: number) => void;
  resizeInspector: (width: number) => void;
}

export function useWorkbenchLayout(tenant: string): UseWorkbenchLayoutResult {
  const storageKey = useMemo(() => workbenchLayoutStorageKey(tenant), [tenant]);
  const [layout, dispatch] = useReducer(
    workbenchLayoutReducer,
    DEFAULT_WORKBENCH_LAYOUT,
  );
  // SSR renders with 0 (→ design maxima); the real width lands after mount.
  // Reading `window` in the initializer instead would desync hydration.
  const [viewportWidth, setViewportWidth] = useState(0);
  const hydratedRef = useRef(false);

  useEffect(() => {
    const sync = () => setViewportWidth(window.innerWidth);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  useEffect(() => {
    hydratedRef.current = false;
    dispatch({
      type: "hydrate",
      layout: readWorkbenchLayout(window.localStorage, storageKey),
    });
    hydratedRef.current = true;
  }, [storageKey]);

  useEffect(() => {
    // Don't let the pre-hydration default overwrite what's on disk.
    if (!hydratedRef.current) return;
    writeWorkbenchLayout(window.localStorage, storageKey, layout);
  }, [layout, storageKey]);

  return {
    layout,
    viewportWidth,
    toggleRail: useCallback(() => dispatch({ type: "toggleRail" }), []),
    toggleInspector: useCallback(
      () => dispatch({ type: "toggleInspector" }),
      [],
    ),
    setInspectorOpen: useCallback(
      (open: boolean) =>
        dispatch({ type: "setInspectorCollapsed", collapsed: !open }),
      [],
    ),
    resizeRail: useCallback(
      (width: number) =>
        dispatch({ type: "setRailWidth", width, viewportWidth }),
      [viewportWidth],
    ),
    resizeInspector: useCallback(
      (width: number) =>
        dispatch({ type: "setInspectorWidth", width, viewportWidth }),
      [viewportWidth],
    ),
  };
}
