"use client";

/**
 * 造工具 modal — the standalone tool-generation entry point in the tool LIBRARY.
 *
 * Two ways in (both create a tenant/domain-scoped, non-executable revision):
 *   · 从 URL/文档：贴一个公网 API 文档地址（或直接粘文档文本）+ 这个工具要干嘛 → AI 提炼出
 *     方法/URL/入参/返回契约草稿 → 你核对/编辑 → 保存。
 *   · 手填：直接填一个声明式 HTTP 工具。
 * Saving never makes the draft runtime-discoverable. Probe + explicit human
 * activation are separate lifecycle steps.
 */

import { useState } from "react";
import { Button, useToast } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  useGenerateToolFromDoc,
  useSaveTool,
  type ToolDraft,
} from "@/lib/hooks/useTools";
import { buildToolDraftPayload } from "./create-tool-payload";

const lbl: React.CSSProperties = {
  fontSize: 10.5,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--text-3)",
  fontFamily: "var(--mono)",
  display: "block",
  marginBottom: 3,
};
const inp: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  fontSize: 12,
  fontFamily: "var(--mono)",
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  outline: "none",
};

function jsonStr(v: unknown): string {
  if (v == null) return "";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return "";
  }
}
export function CreateToolModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const notify = (
    title: string,
    tone: "default" | "green" | "red" = "default",
  ) => toast({ tone, title });
  const gen = useGenerateToolFromDoc();
  const save = useSaveTool();

  const [intent, setIntent] = useState("");
  const [url, setUrl] = useState("");
  const [docText, setDocText] = useState("");

  // the editable tool form (filled by AI extraction or by hand)
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [method, setMethod] = useState("GET");
  const [urlTemplate, setUrlTemplate] = useState("");
  const [sideEffect, setSideEffect] = useState("");
  const [operation, setOperation] = useState("");
  const [effectScope, setEffectScope] = useState("");
  const [sandboxPolicy, setSandboxPolicy] = useState("");
  const [headers, setHeaders] = useState("");
  const [bodyTemplate, setBodyTemplate] = useState("");
  const [requestSpec, setRequestSpec] = useState("");
  const [responseSpec, setResponseSpec] = useState("");
  const [examples, setExamples] = useState("");
  const [paramsSchema, setParamsSchema] = useState("");
  const [returnsSchema, setReturnsSchema] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [notes, setNotes] = useState("");

  function applyDraft(d: ToolDraft) {
    if (d.name) setName(String(d.name));
    if (d.description) setDescription(String(d.description));
    if (d.method) setMethod(String(d.method).toUpperCase());
    if (d.url_template) setUrlTemplate(String(d.url_template));
    if (d.side_effect) setSideEffect(String(d.side_effect));
    if (d.operation) setOperation(String(d.operation));
    if (d.effect_scope) setEffectScope(String(d.effect_scope));
    if (d.sandbox_policy) setSandboxPolicy(String(d.sandbox_policy));
    if (d.headers) setHeaders(jsonStr(d.headers));
    if (d.body_template) setBodyTemplate(String(d.body_template));
    if (d.request_spec) setRequestSpec(jsonStr(d.request_spec));
    if (d.response_spec) setResponseSpec(jsonStr(d.response_spec));
    if (d.examples) setExamples(jsonStr(d.examples));
    if (d.params_schema) setParamsSchema(jsonStr(d.params_schema));
    if (d.returns_schema) setReturnsSchema(jsonStr(d.returns_schema));
    if (d.capabilities) setCapabilities(jsonStr(d.capabilities));
    const meta = [
      d.auth_hint
        ? t("createToolModal.meta.auth", { authHint: d.auth_hint })
        : "",
      d.confidence != null
        ? t("createToolModal.meta.confidence", { confidence: d.confidence })
        : "",
      d.notes ?? "",
    ]
      .filter(Boolean)
      .join(" · ");
    setNotes(meta);
    if (!description && !d.description && d.notes) {
      setDescription(String(d.notes).slice(0, 120));
    }
  }

  async function onExtract() {
    if (!intent.trim()) {
      notify(t("createToolModal.toast.intentRequired"));
      return;
    }
    if (!url.trim() && !docText.trim()) {
      notify(t("createToolModal.toast.sourceRequired"));
      return;
    }
    try {
      const r = await gen.mutateAsync({
        intent: intent.trim(),
        url: url.trim() || undefined,
        text: docText.trim() || undefined,
      });
      applyDraft(r.draft);
      notify(t("createToolModal.toast.extractSuccess"), "green");
    } catch (e) {
      notify(
        t("createToolModal.toast.extractFailed", {
          message: (e as Error).message,
        }),
        "red",
      );
    }
  }

  async function onSave() {
    const built = buildToolDraftPayload({
      name,
      description,
      method,
      urlTemplate,
      headers,
      bodyTemplate,
      requestSpec,
      responseSpec,
      examples,
      sideEffect,
      operation,
      effectScope,
      sandboxPolicy,
      paramsSchema,
      returnsSchema,
      capabilities,
    });
    if (!built.ok) {
      notify(built.message, "red");
      return;
    }
    try {
      const receipt = await save.mutateAsync(built.payload);
      if (receipt.runtimeActive || receipt.lifecycle !== "draft") {
        notify(
          "服务端返回了非草稿状态；界面已停止，未把它宣称为可执行。",
          "red",
        );
        return;
      }
      notify(
        `受控草稿 ${name.trim()} v${receipt.version ?? "?"} 已保存，尚不可执行。`,
        "green",
      );
      onClose();
    } catch (e) {
      notify(
        t("createToolModal.toast.saveFailed", {
          message: (e as Error).message,
        }),
        "red",
      );
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: "var(--z-modal)" as unknown as number,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        overflow: "auto",
        padding: "40px 16px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, 100%)",
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, color: "var(--text)" }}>
            {t("createToolModal.title")}
          </h2>
          <button
            type="button"
            aria-label={t("createToolModal.cancel")}
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-3)",
              fontSize: 18,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>

        {/* AI extract from a doc/URL */}
        <div
          style={{
            border: "1px solid var(--signal)",
            borderRadius: 8,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}
          >
            {t("createToolModal.extractSection.heading")}
          </div>
          <div>
            <label style={lbl}>{t("createToolModal.field.intentLabel")}</label>
            <input
              style={inp}
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder={t("createToolModal.field.intentPlaceholder")}
            />
          </div>
          <div>
            <label style={lbl}>{t("createToolModal.field.urlLabel")}</label>
            <input
              style={inp}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://docs.example.com/api/jobs"
            />
          </div>
          <div>
            <label style={lbl}>{t("createToolModal.field.docTextLabel")}</label>
            <textarea
              style={{ ...inp, minHeight: 56, resize: "vertical" }}
              value={docText}
              onChange={(e) => setDocText(e.target.value)}
              placeholder={t("createToolModal.field.docTextPlaceholder")}
            />
          </div>
          <div>
            <Button
              small
              tone="primary"
              onClick={onExtract}
              disabled={gen.isPending}
            >
              {gen.isPending
                ? t("createToolModal.extractButton.pending")
                : t("createToolModal.extractButton.idle")}
            </Button>
            {notes && (
              <span
                style={{ marginLeft: 10, fontSize: 11, color: "var(--text-3)" }}
              >
                {notes}
              </span>
            )}
          </div>
        </div>

        {/* the editable form */}
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>
          {t("createToolModal.formSection.heading")}
        </div>
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}
        >
          <div>
            <label style={lbl}>{t("createToolModal.field.nameLabel")}</label>
            <input
              style={inp}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="acme.createTicket"
            />
          </div>
          <div>
            <label style={lbl}>{t("createToolModal.field.methodLabel")}</label>
            <select
              style={inp}
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {["GET", "POST", "PUT", "DELETE", "PATCH"].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label style={lbl}>
            {t("createToolModal.field.descriptionLabel")}
          </label>
          <input
            style={inp}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("createToolModal.field.descriptionPlaceholder")}
          />
        </div>
        <div>
          <label style={lbl}>
            {t("createToolModal.field.urlTemplateLabel")}
          </label>
          <input
            style={inp}
            value={urlTemplate}
            onChange={(e) => setUrlTemplate(e.target.value)}
            placeholder="https://api.example.com/v1/jobs/{job_id}"
          />
        </div>
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}
        >
          <div>
            <label style={lbl}>
              {t("createToolModal.field.sideEffectLabel")}
            </label>
            <select
              style={inp}
              value={sideEffect}
              onChange={(e) => setSideEffect(e.target.value)}
            >
              <option value="">— 必须人工确认 —</option>
              {["read", "write", "dual"].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              fontSize: 11.5,
              lineHeight: 1.5,
              color: "var(--text-3)",
            }}
          >
            保存范围：当前 tenant/domain 的受控
            revision；不会直接发布到共享运行时目录。
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 10,
          }}
        >
          <div>
            <label style={lbl}>
              {t("createToolModal.field.operationLabel")}
            </label>
            <select
              style={inp}
              value={operation}
              onChange={(e) => setOperation(e.target.value)}
            >
              <option value="">— 必须人工确认 —</option>
              {["read", "compute", "write", "read_write"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={lbl}>
              {t("createToolModal.field.effectScopeLabel")}
            </label>
            <select
              style={inp}
              value={effectScope}
              onChange={(e) => setEffectScope(e.target.value)}
            >
              <option value="">— 必须人工确认 —</option>
              <option value="external">external</option>
            </select>
          </div>
          <div>
            <label style={lbl}>
              {t("createToolModal.field.sandboxPolicyLabel")}
            </label>
            <select
              style={inp}
              value={sandboxPolicy}
              onChange={(e) => setSandboxPolicy(e.target.value)}
            >
              <option value="">— 必须人工确认 —</option>
              <option value="live_external">live_external</option>
              <option value="requires_attempt_grant">
                requires_attempt_grant
              </option>
            </select>
          </div>
        </div>
        <div
          style={{
            padding: "8px 10px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--panel-2)",
            color: "var(--text-3)",
            fontSize: 11.5,
            lineHeight: 1.5,
          }}
        >
          {t("createToolModal.field.executionPolicyHint")}
        </div>
        <div>
          <label style={lbl}>{t("createToolModal.field.headersLabel")}</label>
          <textarea
            style={{ ...inp, minHeight: 44, resize: "vertical" }}
            value={headers}
            onChange={(e) => setHeaders(e.target.value)}
            placeholder='{ "Authorization": "Bearer {ACME_KEY}" }'
          />
        </div>
        {method !== "GET" && (
          <div>
            <label style={lbl}>
              {t("createToolModal.field.bodyTemplateLabel")}
            </label>
            <textarea
              style={{ ...inp, minHeight: 44, resize: "vertical" }}
              value={bodyTemplate}
              onChange={(e) => setBodyTemplate(e.target.value)}
              placeholder='{ "title": "{title}" }'
            />
          </div>
        )}
        <details>
          <summary
            style={{
              cursor: "pointer",
              color: "var(--text-2)",
              fontSize: 11.5,
            }}
          >
            Typed HTTP envelope（request_spec / response_spec / examples）
          </summary>
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            <label style={lbl}>request_spec（与 body_template 互斥）</label>
            <textarea
              style={{ ...inp, minHeight: 70, resize: "vertical" }}
              value={requestSpec}
              onChange={(event) => setRequestSpec(event.target.value)}
              placeholder='{"encoding":"multipart","files":[{"field":"file","base64_path":"args.pdf_base64"}]}'
            />
            <label style={lbl}>response_spec</label>
            <textarea
              style={{ ...inp, minHeight: 70, resize: "vertical" }}
              value={responseSpec}
              onChange={(event) => setResponseSpec(event.target.value)}
              placeholder='{"unwrap_path":"data.data","assertions":[{"path":"data.data.id","op":"non_empty","failure":"terminal","code":"id_missing"}]}'
            />
            <label style={lbl}>examples（仅脱敏 request / response）</label>
            <textarea
              style={{ ...inp, minHeight: 70, resize: "vertical" }}
              value={examples}
              onChange={(event) => setExamples(event.target.value)}
              placeholder='[{"request":{"id":"example"},"response":{"data":{"id":"example"}},"source":"documentation"}]'
            />
          </div>
        </details>
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}
        >
          <div>
            <label style={lbl}>
              {t("createToolModal.field.paramsSchemaLabel")}
            </label>
            <textarea
              style={{ ...inp, minHeight: 56, resize: "vertical" }}
              value={paramsSchema}
              onChange={(e) => setParamsSchema(e.target.value)}
              placeholder={t("createToolModal.field.paramsSchemaPlaceholder")}
            />
          </div>
          <div>
            <label style={lbl}>
              {t("createToolModal.field.returnsSchemaLabel")}
            </label>
            <textarea
              style={{ ...inp, minHeight: 56, resize: "vertical" }}
              value={returnsSchema}
              onChange={(e) => setReturnsSchema(e.target.value)}
              placeholder='{ "title": "string", "salary": "number" }'
            />
          </div>
        </div>
        <div>
          <label style={lbl}>
            {t("createToolModal.field.capabilitiesLabel")}
          </label>
          <textarea
            style={{ ...inp, minHeight: 78, resize: "vertical" }}
            value={capabilities}
            onChange={(e) => setCapabilities(e.target.value)}
            placeholder='[{"systems":["AllmetaOntology"],"kinds":["ontology"],"roles":["read"],"operations":["query"],"objectTypes":["Candidate"],"probeRequired":true}]'
          />
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 4,
          }}
        >
          <Button small tone="ghost" onClick={onClose}>
            {t("createToolModal.cancel")}
          </Button>
          <Button
            small
            tone="primary"
            onClick={onSave}
            disabled={save.isPending}
          >
            {save.isPending
              ? t("createToolModal.saveButton.pending")
              : t("createToolModal.saveButton.idle")}
          </Button>
        </div>
      </div>
    </div>
  );
}
