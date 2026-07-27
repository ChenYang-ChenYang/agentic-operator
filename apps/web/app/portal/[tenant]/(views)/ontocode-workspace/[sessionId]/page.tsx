"use client";
import { useSearchParams } from "next/navigation";
import {
  OntoCodeThemeBoundary,
  OntoCodeWorkspaceSessionConnected,
} from "@/app/portal/components/ontocode-workspace";
import { WorkbenchSessionConnected } from "@/app/portal/components/ontocode-v10/WorkbenchSession";

/**
 * v10 三栏工作台灰度开关：?v10=1 走新工作台（C7 换装后成为默认）。
 * 旧工作台保持原样，保证并行期可对照。
 */
export default function OntoCodeWorkspaceSessionPage() {
  const searchParams = useSearchParams();
  if (searchParams?.get("v10") === "1") {
    return <WorkbenchSessionConnected />;
  }
  return (
    <OntoCodeThemeBoundary>
      <OntoCodeWorkspaceSessionConnected />
    </OntoCodeThemeBoundary>
  );
}
