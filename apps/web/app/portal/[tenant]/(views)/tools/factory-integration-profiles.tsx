"use client";

import { useId, useMemo, useState } from "react";
import { Badge, Button } from "@/app/portal/components";
import {
  useDeleteToolIntegrationProfile,
  useSaveToolIntegrationProfile,
  useToolIntegrationProfiles,
  type ToolCatalogEntry,
  type ToolIntegrationConfigValidation,
  type ToolIntegrationProfileRecord,
  type ToolIntegrationProfileEnvironment,
} from "@/lib/hooks/useTools";
import {
  formatIntegrationProfileConfig,
  integrationProfileTruth,
  parseIntegrationProfileDraft,
} from "./integration-profile-form";

const ENVIRONMENTS: ToolIntegrationProfileEnvironment[] = [
  "sandbox",
  "production",
];

const ENVIRONMENT_COPY: Record<
  ToolIntegrationProfileEnvironment,
  { label: string; description: string; tone: "blue" | "amber" }
> = {
  sandbox: {
    label: "SANDBOX",
    description: "仅供本机/测试执行，不能作为 production promotion 证据。",
    tone: "blue",
  },
  production: {
    label: "PRODUCTION",
    description: "与 sandbox 完全隔离；上线前仍需当前配置的 live probe。",
    tone: "amber",
  },
};

interface ProfileEditor {
  mode: "create" | "edit";
  environment: ToolIntegrationProfileEnvironment;
  profileKey: string;
  configText: string;
}

function profileValidation(
  profile: ToolIntegrationProfileRecord,
): ToolIntegrationConfigValidation | undefined {
  return profile.validation;
}

function deterministicTimestamp(value: string): string {
  return value.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

export function FactoryIntegrationProfiles({
  tool,
}: {
  tool: ToolCatalogEntry;
}) {
  const [open, setOpen] = useState(false);
  const profileQuery = useToolIntegrationProfiles(tool.name, { enabled: open });
  const profileCount =
    profileQuery.data?.count ?? tool.integrationProfiles?.length ?? 0;
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      style={managerStyle}
    >
      <summary style={summaryStyle}>
        <span>Factory integration profiles</span>
        <Badge tone={profileCount > 0 ? "green" : "muted"}>
          {profileCount} 已保存
        </Badge>
        <span style={summaryHintStyle}>sandbox / production 独立管理</span>
      </summary>
      {open ? (
        <FactoryIntegrationProfilesBody
          tool={tool}
          profileQuery={profileQuery}
        />
      ) : null}
    </details>
  );
}

function FactoryIntegrationProfilesBody({
  tool,
  profileQuery,
}: {
  tool: ToolCatalogEntry;
  profileQuery: ReturnType<typeof useToolIntegrationProfiles>;
}) {
  const inputId = useId();
  const [editor, setEditor] = useState<ProfileEditor | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [statusText, setStatusText] = useState<string | null>(null);
  const saveProfile = useSaveToolIntegrationProfile();
  const deleteProfile = useDeleteToolIntegrationProfile();

  const initialProfiles = useMemo<ToolIntegrationProfileRecord[]>(
    () =>
      (tool.integrationProfiles ?? []).map((profile) => ({
        ...profile,
        validation: undefined,
      })),
    [tool.integrationProfiles],
  );
  const profiles = profileQuery.data?.profiles ?? initialProfiles;
  const busy = saveProfile.isPending || deleteProfile.isPending;

  function beginCreate(environment: ToolIntegrationProfileEnvironment) {
    setFormErrors([]);
    setStatusText(null);
    setEditor({
      mode: "create",
      environment,
      profileKey:
        environment === "sandbox" ? "sandbox-default" : "production-default",
      configText: formatIntegrationProfileConfig(tool.configExample),
    });
  }

  function beginEdit(profile: ToolIntegrationProfileRecord) {
    setFormErrors([]);
    setStatusText(null);
    setEditor({
      mode: "edit",
      environment: profile.environment,
      profileKey: profile.profileKey,
      configText: formatIntegrationProfileConfig(profile.config),
    });
  }

  function submitProfile() {
    if (!editor) return;
    const parsed = parseIntegrationProfileDraft(
      editor.profileKey,
      editor.configText,
    );
    if (!parsed.ok) {
      setFormErrors(parsed.errors);
      return;
    }
    setFormErrors([]);
    setStatusText(null);
    saveProfile.mutate(
      {
        name: tool.name,
        profileKey: parsed.profileKey,
        environment: editor.environment,
        config: parsed.config,
      },
      {
        onSuccess: ({ validation }) => {
          setEditor(null);
          setStatusText(
            validation.ready
              ? "Profile 已保存，服务器环境引用已就绪；这不等于探针已验证。"
              : `Profile 已保存，但仍缺少服务器环境引用：${
                  validation.missingEnvRefs.join("、") || "请检查工具配置"
                }。`,
          );
        },
        onError: (error) => {
          setFormErrors([
            error instanceof Error ? error.message : String(error),
          ]);
        },
      },
    );
  }

  function removeProfile(profile: ToolIntegrationProfileRecord) {
    const accepted = window.confirm(
      `删除 ${tool.name} / ${profile.profileKey} / ${profile.environment}？另一环境的同名 profile 不会被删除。`,
    );
    if (!accepted) return;
    setFormErrors([]);
    setStatusText(null);
    deleteProfile.mutate(
      {
        name: tool.name,
        profileKey: profile.profileKey,
        environment: profile.environment,
      },
      {
        onSuccess: () => {
          if (
            editor?.profileKey === profile.profileKey &&
            editor.environment === profile.environment
          ) {
            setEditor(null);
          }
          setStatusText(
            `${profile.profileKey} / ${profile.environment} 已删除。`,
          );
        },
        onError: (error) => {
          setFormErrors([
            error instanceof Error ? error.message : String(error),
          ]);
        },
      },
    );
  }

  return (
    <div style={bodyStyle}>
      <div role="note" style={securityNoteStyle}>
        <strong>Secret-free 边界：</strong>
        这里只保存非密钥配置和引用名，禁止粘贴 API key、token、密码或带凭证的
        URL。当前执行契约使用 <code>*_env</code>；受管 Vault
        凭证需先在服务端映射为环境变量引用。保存成功只表示配置已确认，不会自动产生
        probe receipt。
      </div>

      {tool.probeStatus === "verified" ? (
        <div style={toolProbeNoteStyle}>
          <Badge tone={tool.productionProbeVerified ? "green" : "blue"}>
            {tool.productionProbeVerified
              ? "工具级 production live-probe 存在"
              : "工具级探针证据存在"}
          </Badge>
          <span>
            该证据未由 profile API 绑定到下面某一条配置，因此不会把任一 profile
            标成“探针已验证”。
          </span>
        </div>
      ) : null}

      {profileQuery.isLoading && profiles.length === 0 ? (
        <div style={emptyStyle}>正在读取 profiles…</div>
      ) : null}
      {profileQuery.isError ? (
        <div role="alert" style={errorStyle}>
          无法读取 profiles：
          {profileQuery.error instanceof Error
            ? profileQuery.error.message
            : String(profileQuery.error)}
        </div>
      ) : null}

      <div style={environmentGridStyle}>
        {ENVIRONMENTS.map((environment) => {
          const copy = ENVIRONMENT_COPY[environment];
          const rows = profiles.filter(
            (profile) => profile.environment === environment,
          );
          return (
            <section key={environment} style={environmentCardStyle}>
              <header style={environmentHeaderStyle}>
                <div>
                  <Badge tone={copy.tone}>{copy.label}</Badge>
                  <p style={environmentDescriptionStyle}>{copy.description}</p>
                </div>
                <Button
                  small
                  tone="ghost"
                  disabled={busy}
                  onClick={() => beginCreate(environment)}
                >
                  新建 profile
                </Button>
              </header>

              {rows.length === 0 ? (
                <div style={emptyStyle}>尚未保存 {environment} profile。</div>
              ) : (
                <div style={profileListStyle}>
                  {rows.map((profile) => {
                    const validation = profileValidation(profile);
                    const truth = integrationProfileTruth(validation);
                    return (
                      <article
                        key={`${profile.environment}:${profile.profileKey}`}
                        style={profileCardStyle}
                      >
                        <div style={profileTitleRowStyle}>
                          <strong style={profileKeyStyle}>
                            {profile.profileKey}
                          </strong>
                          <div style={badgeRowStyle}>
                            <Badge tone="green">{truth.saved}</Badge>
                            {validation?.ready === true ? (
                              <Badge tone="blue">{truth.environment}</Badge>
                            ) : validation ? (
                              <Badge tone="amber">{truth.environment}</Badge>
                            ) : (
                              <Badge tone="muted">{truth.environment}</Badge>
                            )}
                            <Badge tone="muted">{truth.probe}</Badge>
                          </div>
                        </div>

                        {validation && validation.missingEnvRefs.length > 0 ? (
                          <div style={warningStyle}>
                            缺少服务器环境变量：
                            {validation.missingEnvRefs.join("、")}
                          </div>
                        ) : null}
                        {validation && validation.issues.length > 0 ? (
                          <ul style={issueListStyle}>
                            {validation.issues.map((issue) => (
                              <li key={`${issue.code}:${issue.path}`}>
                                {issue.path}：{issue.message}
                              </li>
                            ))}
                          </ul>
                        ) : null}

                        <pre style={configPreviewStyle}>
                          {formatIntegrationProfileConfig(profile.config)}
                        </pre>
                        <div style={profileMetaStyle}>
                          <span>确认人：{profile.confirmedBy || "未知"}</span>
                          <span>
                            确认时间：
                            {deterministicTimestamp(profile.confirmedAt)}
                          </span>
                          <span title={profile.configDigest}>
                            config digest：
                            {profile.configDigest.slice(0, 12) || "—"}
                          </span>
                        </div>
                        <div style={actionRowStyle}>
                          <Button
                            small
                            tone="ghost"
                            disabled={busy}
                            onClick={() => beginEdit(profile)}
                          >
                            编辑
                          </Button>
                          <Button
                            small
                            tone="danger"
                            disabled={busy}
                            onClick={() => removeProfile(profile)}
                          >
                            删除此环境
                          </Button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {editor ? (
        <section style={editorStyle}>
          <div style={editorTitleRowStyle}>
            <div>
              <strong>
                {editor.mode === "create" ? "新建" : "更新"}{" "}
                {editor.environment} profile
              </strong>
              <div style={editorHintStyle}>
                同一个 profile key 可在 sandbox 和 production
                各保存一份；两者不会互相覆盖。
              </div>
            </div>
            <Badge tone={ENVIRONMENT_COPY[editor.environment].tone}>
              {ENVIRONMENT_COPY[editor.environment].label}
            </Badge>
          </div>

          <label htmlFor={`${inputId}-key`} style={labelStyle}>
            Profile key
          </label>
          <input
            id={`${inputId}-key`}
            value={editor.profileKey}
            disabled={busy || editor.mode === "edit"}
            onChange={(event) =>
              setEditor((current) =>
                current
                  ? { ...current, profileKey: event.target.value }
                  : current,
              )
            }
            style={inputStyle}
            autoComplete="off"
          />

          <label htmlFor={`${inputId}-config`} style={labelStyle}>
            Secret-free config JSON
          </label>
          <textarea
            id={`${inputId}-config`}
            value={editor.configText}
            disabled={busy}
            onChange={(event) =>
              setEditor((current) =>
                current
                  ? { ...current, configText: event.target.value }
                  : current,
              )
            }
            style={textareaStyle}
            spellCheck={false}
          />
          {tool.configSchema && Object.keys(tool.configSchema).length > 0 ? (
            <div style={schemaHintStyle}>
              允许的工具配置项：
              {Object.entries(tool.configSchema)
                .map(
                  ([key, field]) => `${key}${field.required ? "（必填）" : ""}`,
                )
                .join("、")}
            </div>
          ) : (
            <div style={schemaHintStyle}>
              此工具未声明配置项，通常应保存空对象 {"{}"}。
            </div>
          )}

          {formErrors.length > 0 ? (
            <ul role="alert" style={issueListStyle}>
              {formErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
          <div style={actionRowStyle}>
            <Button
              small
              tone="primary"
              disabled={busy}
              onClick={submitProfile}
            >
              {saveProfile.isPending ? "保存中…" : "保存 secret-free profile"}
            </Button>
            <Button
              small
              tone="ghost"
              disabled={busy}
              onClick={() => {
                setEditor(null);
                setFormErrors([]);
              }}
            >
              取消
            </Button>
          </div>
        </section>
      ) : null}

      {statusText ? (
        <div role="status" style={statusStyle}>
          {statusText}
        </div>
      ) : null}
    </div>
  );
}

const managerStyle: React.CSSProperties = {
  borderTop: "1px solid var(--border)",
  paddingTop: 12,
};

const summaryStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  cursor: "pointer",
  color: "var(--text)",
  fontSize: 12.5,
  fontWeight: 600,
};

const summaryHintStyle: React.CSSProperties = {
  color: "var(--text-3)",
  fontSize: 11,
  fontWeight: 400,
};

const bodyStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  paddingTop: 12,
};

const securityNoteStyle: React.CSSProperties = {
  padding: "10px 12px",
  border: "1px solid color-mix(in srgb, var(--amber) 32%, var(--border))",
  borderRadius: 5,
  background: "color-mix(in srgb, var(--amber) 7%, var(--panel-2))",
  color: "var(--text-2)",
  fontSize: 11.5,
  lineHeight: 1.55,
};

const toolProbeNoteStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  color: "var(--text-2)",
  fontSize: 11.5,
};

const environmentGridStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-start",
  gap: 10,
};

const environmentCardStyle: React.CSSProperties = {
  flex: "1 1 320px",
  minWidth: 0,
  padding: 10,
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--panel-2)",
};

const environmentHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 10,
  marginBottom: 8,
};

const environmentDescriptionStyle: React.CSSProperties = {
  margin: "5px 0 0",
  color: "var(--text-3)",
  fontSize: 10.5,
  lineHeight: 1.45,
};

const profileListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const profileCardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 10,
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--panel)",
};

const profileTitleRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 8,
  flexWrap: "wrap",
};

const profileKeyStyle: React.CSSProperties = {
  color: "var(--text)",
  font: "12px/1.45 var(--mono)",
};

const badgeRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 5,
};

const configPreviewStyle: React.CSSProperties = {
  margin: 0,
  maxHeight: 180,
  overflow: "auto",
  padding: 8,
  border: "1px solid var(--border)",
  borderRadius: 4,
  background: "var(--bg)",
  color: "var(--text-2)",
  font: "10.5px/1.5 var(--mono)",
  whiteSpace: "pre",
};

const profileMetaStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "4px 12px",
  color: "var(--text-3)",
  font: "10px/1.45 var(--mono)",
};

const actionRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 7,
};

const editorStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 7,
  padding: 12,
  border: "1px solid var(--border-2)",
  borderRadius: 5,
  background: "var(--panel-2)",
};

const editorTitleRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 10,
};

const editorHintStyle: React.CSSProperties = {
  marginTop: 3,
  color: "var(--text-3)",
  fontSize: 10.5,
  lineHeight: 1.45,
};

const labelStyle: React.CSSProperties = {
  marginTop: 3,
  color: "var(--text-2)",
  fontSize: 11,
  fontWeight: 600,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 8px",
  border: "1px solid var(--border-2)",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--text)",
  font: "11px/1.45 var(--mono)",
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  minHeight: 150,
  resize: "vertical",
};

const schemaHintStyle: React.CSSProperties = {
  color: "var(--text-3)",
  fontSize: 10.5,
  lineHeight: 1.45,
};

const emptyStyle: React.CSSProperties = {
  padding: "8px 0",
  color: "var(--text-3)",
  fontSize: 11.5,
};

const warningStyle: React.CSSProperties = {
  color: "var(--amber)",
  fontSize: 10.5,
  lineHeight: 1.45,
};

const issueListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  color: "var(--red)",
  fontSize: 10.5,
  lineHeight: 1.5,
};

const errorStyle: React.CSSProperties = {
  color: "var(--red)",
  fontSize: 11.5,
};

const statusStyle: React.CSSProperties = {
  color: "var(--green)",
  fontSize: 11.5,
};
