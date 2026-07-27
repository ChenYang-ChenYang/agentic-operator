"use client";
import { useSearchParams } from "next/navigation";
import {
  OntoCodeThemeBoundary,
  OntoCodeWorkspaceSessionConnected,
} from "@/app/portal/components/ontocode-workspace";
import { WorkbenchSessionConnected } from "@/app/portal/components/ontocode-v10/WorkbenchSession";

/**
 * v10 三栏工作台是 Session 页的默认实现。
 * `?legacy=1` 保留旧对话式工作台作为并行期逃生门（M3 退役批次移除）。
 */
export default function OntoCodeWorkspaceSessionPage() {
  const searchParams = useSearchParams();
  if (searchParams?.get("legacy") === "1") {
    return (
      <OntoCodeThemeBoundary>
        <OntoCodeWorkspaceSessionConnected />
      </OntoCodeThemeBoundary>
    );
  }
  return <WorkbenchSessionConnected />;
}
