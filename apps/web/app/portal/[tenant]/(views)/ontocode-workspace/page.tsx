"use client";
import { useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  OntoCodeThemeBoundary,
  OntoCodeWorkspaceHubConnected,
} from "@/app/portal/components/ontocode-workspace";
import { useOntoCodeSessions } from "@/lib/hooks/useOntoCodeWorkspace";

/**
 * v10 起，OntoCode 的默认入口是「最近的 Session 工作台」——不再有独立列表页
 * 与工作台内 Session 栏并存的双入口。旧 Build Sessions Hub 仅承担创建流
 * （?legacy=1 显式进入；v10 首页创建流在 M3 落地后退役）。
 */
export default function OntoCodeWorkspaceEntryPage() {
  const params = useParams<{ tenant: string }>();
  const tenant = params?.tenant ?? "";
  const router = useRouter();
  const searchParams = useSearchParams();
  const legacy = searchParams?.get("legacy") === "1";
  const sessionsQ = useOntoCodeSessions(legacy ? "" : tenant);

  useEffect(() => {
    if (legacy || !tenant || !sessionsQ.data) return;
    const items = [...sessionsQ.data.items].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    const newest = items[0];
    if (newest) {
      router.replace(
        `/portal/${encodeURIComponent(tenant)}/ontocode-workspace/${encodeURIComponent(newest.id)}`,
      );
    } else {
      router.replace(
        `/portal/${encodeURIComponent(tenant)}/ontocode-workspace?legacy=1&create=1`,
      );
    }
  }, [legacy, tenant, sessionsQ.data, router]);

  if (legacy) {
    return (
      <OntoCodeThemeBoundary>
        <OntoCodeWorkspaceHubConnected />
      </OntoCodeThemeBoundary>
    );
  }
  return (
    <div style={{ padding: 48, textAlign: "center", color: "#93a0ac", fontSize: 13 }}>
      正在打开最近的 Session…
    </div>
  );
}
