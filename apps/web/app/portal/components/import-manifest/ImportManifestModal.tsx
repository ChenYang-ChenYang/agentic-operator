"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ManifestImportCommit as ManifestImportCommitSchema,
  ManifestImportOverwriteRequired as ManifestImportOverwriteRequiredSchema,
  ManifestImportPreview as ManifestImportPreviewSchema,
  WorkflowDetailSchema,
  type Conflict,
  type ConflictResolution,
  type ManifestImportBody,
  type ManifestImportOverwriteRequired,
  type ManifestImportPreview,
  type WorkflowDetail,
} from "@agentic/contracts";
import {
  Badge,
  Button,
  CodeBlock,
  Icon,
  ModalOverlay,
  MonacoEditor,
  Panel,
  Stat,
  type IconName,
} from "@/app/portal/components";
import { toast } from "@/app/portal/components/toast";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { fmtBytes } from "@/lib/format";
import { OverwriteConfirmModal } from "./OverwriteConfirmModal";
import { ImportPreviewGraph } from "./ImportPreviewGraph";

const MAX_FILE_BYTES = 1_000_000;

const IMPORT_STEPS = [
  { id: "source", icon: "upload" as IconName },
  { id: "validate", icon: "check" as IconName },
  { id: "diff", icon: "git" as IconName },
  { id: "resolve", icon: "alert" as IconName },
  { id: "preview", icon: "workflow" as IconName },
  { id: "deploy", icon: "deploy" as IconName },
] as const;

type SourceKind = "file" | "paste" | "url" | "git";
type ResolutionChoice = "auto_fix" | "skip";
/** The merged manifest-import contract deploys straight to production. */
type DeployTarget = "production";

interface FileEntry {
  name: string;
  size: number;
  ok: boolean;
  error?: string;
}

interface ManifestPair {
  workflow: unknown;
  actions: unknown[] | null;
}

interface RepoSource {
  repository: string;
  ref: string;
  path: string;
}

interface PendingLock {
  locked_by?: string;
  expires_at?: number;
}

interface CommitIssue {
  path: string;
  message: string;
  severity: string;
  code: string;
}

export interface ImportManifestModalProps {
  onClose: () => void;
  mode?: "workflow" | "agent";
  tenantSlug?: string;
  /**
   * Workflow-authoring integration: when set, the wizard validates with
   * `draft_only` and materializes the normalized manifest as a NEW editable
   * workflow draft (`POST /v1/workflows`) instead of committing a deployment.
   */
  draftTarget?: { slug: string; name: string };
  /** Called with the created workflow draft after a draft-mode import. */
  onDraftCreated?: (workflow: WorkflowDetail) => void;
  /**
   * Offers a way out for someone who has no manifest at all — the common case
   * right after a Business Domain is created, when this wizard is the first
   * thing they see. Omit it and the row is not rendered, so existing callers
   * are unchanged.
   */
  onStartBlank?: () => void;
  /** Offers the annotated starter file to edit offline. */
  onDownloadTemplate?: () => void;
}

function manifestHeaders(slug: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-agentic-tenant": slug,
  };
}

function unwrapEnvelope<T>(body: unknown): T {
  if (
    body &&
    typeof body === "object" &&
    (body as { ok?: boolean }).ok === true &&
    "data" in body
  ) {
    return (body as { data: T }).data;
  }
  return body as T;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}

function responseError(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error) return error;
    if (error && typeof error === "object") {
      const detail = error as { message?: unknown; code?: unknown };
      if (typeof detail.message === "string" && detail.message) {
        return detail.message;
      }
      if (typeof detail.code === "string" && detail.code) return detail.code;
    }
  }
  return `HTTP ${status}`;
}

function splitManifestPayload(payload: unknown): ManifestPair {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "workflow" in payload
  ) {
    const bundle = payload as { workflow: unknown; actions?: unknown };
    return {
      workflow: bundle.workflow,
      actions: Array.isArray(bundle.actions) ? bundle.actions : null,
    };
  }
  return { workflow: payload, actions: null };
}

function conflictKey(conflict: Conflict, index: number): string {
  return `${index}:${conflict.path}:${conflict.type}`;
}

function buildConflictResolutions(
  preview: ManifestImportPreview,
  choices: Record<string, ResolutionChoice>,
): ConflictResolution[] {
  return preview.conflicts.map((conflict, index) => {
    const choice = choices[conflictKey(conflict, index)];
    if (choice === "auto_fix" && conflict.auto_fix) return conflict.auto_fix;
    return { path: conflict.path, action: "skip" };
  });
}

export function ImportManifestModal({
  onClose,
  mode = "workflow",
  tenantSlug,
  draftTarget,
  onDraftCreated,
  onStartBlank,
  onDownloadTemplate,
}: ImportManifestModalProps) {
  const { t } = useI18n();
  const urlTenant = useTenant();
  const slug = tenantSlug ?? urlTenant;
  const queryClient = useQueryClient();

  const [step, setStep] = useState(0);
  const [source, setSource] = useState<SourceKind>("file");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [pasted, setPasted] = useState("");
  const [url, setUrl] = useState("");
  const [repo, setRepo] = useState<RepoSource>({
    repository: "",
    ref: "",
    path: "",
  });
  const [workflowRaw, setWorkflowRaw] = useState<unknown>(null);
  const [actionsRaw, setActionsRaw] = useState<unknown[] | null>(null);
  const [preview, setPreview] = useState<ManifestImportPreview | null>(null);
  const [resolutions, setResolutions] = useState<
    Record<string, ResolutionChoice>
  >({});
  // hint: "Production only" — the api's commit contract accepts a single
  // target; there is no staging tier to silently claim.
  const [target] = useState<DeployTarget>("production");
  const [noteText, setNoteText] = useState("");
  const [validating, setValidating] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitIssues, setCommitIssues] = useState<CommitIssue[]>([]);
  const [pendingLock, setPendingLock] = useState<PendingLock | null>(null);
  const [overwriteRequired, setOverwriteRequired] =
    useState<ManifestImportOverwriteRequired | null>(null);

  const pendingDeploymentRef = useRef<string | null>(null);
  const committedRef = useRef(false);
  const dropRef = useRef<HTMLDivElement | null>(null);

  const cancelPendingDeployment = useCallback(
    async (deploymentId: string, keepalive = false) => {
      const response = await fetch(
        `/v1/tenants/${encodeURIComponent(slug)}/manifest-import/${encodeURIComponent(deploymentId)}`,
        {
          method: "DELETE",
          credentials: "same-origin",
          headers: manifestHeaders(slug),
          keepalive,
        },
      );
      if (!response.ok && response.status !== 404 && response.status !== 409) {
        const body = await readResponseBody(response);
        throw new Error(responseError(body, response.status));
      }
      if (pendingDeploymentRef.current === deploymentId) {
        pendingDeploymentRef.current = null;
      }
    },
    [slug],
  );

  useEffect(() => {
    return () => {
      const deploymentId = pendingDeploymentRef.current;
      if (!deploymentId || committedRef.current) return;
      void fetch(
        `/v1/tenants/${encodeURIComponent(slug)}/manifest-import/${encodeURIComponent(deploymentId)}`,
        {
          method: "DELETE",
          credentials: "same-origin",
          headers: manifestHeaders(slug),
          keepalive: true,
        },
      );
    };
  }, [slug]);

  const canAdvance = useMemo(() => {
    if (validating || committing || closing) return false;
    if (step === 0) {
      if (source === "file") return workflowRaw !== null;
      if (source === "paste") return pasted.trim().length > 0;
      if (source === "url") return /^https?:\/\//i.test(url.trim());
      return Boolean(
        repo.repository.trim() && repo.ref.trim() && repo.path.trim(),
      );
    }
    if (step === 1) {
      return Boolean(
        preview && !preview.issues.some((issue) => issue.severity === "error"),
      );
    }
    return preview !== null;
  }, [
    closing,
    committing,
    pasted,
    preview,
    repo,
    source,
    step,
    url,
    validating,
    workflowRaw,
  ]);

  const commitBody = useMemo<ManifestImportBody | null>(() => {
    if (!preview) return null;
    const note = noteText.trim();
    return {
      mode: "commit",
      workflow: workflowRaw,
      ...(actionsRaw ? { actions: actionsRaw } : {}),
      target,
      deployment_id: preview.deployment_id,
      conflict_resolutions: buildConflictResolutions(preview, resolutions),
      confirm_overwrite: false,
      ...(note ? { note: note.slice(0, 500) } : {}),
    };
  }, [actionsRaw, noteText, preview, resolutions, target, workflowRaw]);

  const refetchManifestDependents = () => {
    void queryClient.invalidateQueries({ queryKey: ["agents"] as const });
    void queryClient.invalidateQueries({ queryKey: ["workflows"] as const });
    void queryClient.invalidateQueries({ queryKey: ["events"] as const });
    void queryClient.invalidateQueries({ queryKey: ["deployments"] as const });
  };

  async function requestClose() {
    if (committing || closing) return;
    setClosing(true);
    const deploymentId = pendingDeploymentRef.current;
    try {
      if (deploymentId && !committedRef.current) {
        await cancelPendingDeployment(deploymentId);
      }
      onClose();
    } catch (error) {
      setValidationError(
        `${t("importManifestModal.cancelFailed")}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setClosing(false);
    }
  }

  async function fetchRemotePair(): Promise<ManifestPair> {
    const endpoint =
      source === "git"
        ? `/v1/tenants/${encodeURIComponent(slug)}/manifest-import/fetch-repo`
        : `/v1/tenants/${encodeURIComponent(slug)}/manifest-import/fetch-url`;
    const requestBody =
      source === "git"
        ? {
            repository: repo.repository.trim(),
            ref: repo.ref.trim(),
            path: repo.path.trim(),
          }
        : { url: url.trim() };
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: manifestHeaders(slug),
      body: JSON.stringify(requestBody),
    });
    const body = await readResponseBody(response);
    if (!response.ok) throw new Error(responseError(body, response.status));
    const fetched = unwrapEnvelope<{
      workflow: unknown;
      actions?: unknown[];
    }>(body);
    if (!fetched || typeof fetched !== "object" || !("workflow" in fetched)) {
      throw new Error(t("importManifestModal.errInvalidFetchResponse"));
    }
    return {
      workflow: fetched.workflow,
      actions: Array.isArray(fetched.actions) ? fetched.actions : null,
    };
  }

  async function startValidation() {
    if (validating) return;
    setValidationError(null);
    setCommitError(null);
    setPendingLock(null);
    setPreview(null);
    setValidating(true);

    try {
      const previousDeployment = pendingDeploymentRef.current;
      if (previousDeployment && !committedRef.current) {
        await cancelPendingDeployment(previousDeployment);
      }

      let pair: ManifestPair;
      if (source === "paste") {
        try {
          pair = splitManifestPayload(JSON.parse(pasted.trim()) as unknown);
        } catch (error) {
          throw new Error(
            `${t("importManifestModal.errInvalidJson")}: ${error instanceof Error ? error.message : t("importManifestModal.errParseError")}`,
          );
        }
      } else if (source === "url" || source === "git") {
        pair = await fetchRemotePair();
      } else {
        pair = { workflow: workflowRaw, actions: actionsRaw };
      }

      if (pair.workflow === null || pair.workflow === undefined) {
        throw new Error(t("importManifestModal.errNoManifest"));
      }
      setWorkflowRaw(pair.workflow);
      setActionsRaw(pair.actions);
      setStep(1);

      const response = await fetch(
        `/v1/tenants/${encodeURIComponent(slug)}/manifest-import`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: manifestHeaders(slug),
          body: JSON.stringify({
            mode: "validate",
            workflow: pair.workflow,
            ...(pair.actions ? { actions: pair.actions } : {}),
          }),
        },
      );
      const body = await readResponseBody(response);
      if (response.status === 423) {
        const lock = body as PendingLock;
        setPendingLock({
          locked_by: lock.locked_by,
          expires_at: lock.expires_at,
        });
        return;
      }
      if (!response.ok) throw new Error(responseError(body, response.status));

      const result = ManifestImportPreviewSchema.safeParse(
        unwrapEnvelope<unknown>(body),
      );
      if (!result.success) {
        throw new Error(
          `${t("importManifestModal.errInvalidPreview")}: ${result.error.issues[0]?.message ?? t("importManifestModal.errUnknownSchema")}`,
        );
      }
      committedRef.current = false;
      pendingDeploymentRef.current = result.data.deployment_id ?? null;
      setPreview(result.data);
      setResolutions(
        Object.fromEntries(
          result.data.conflicts.map((conflict, index) => [
            conflictKey(conflict, index),
            conflict.auto_fix ? "auto_fix" : "skip",
          ]),
        ),
      );
    } catch (error) {
      setValidationError(
        error instanceof Error
          ? error.message
          : t("importManifestModal.errNetworkValidate"),
      );
      setStep(0);
    } finally {
      setValidating(false);
    }
  }

  function actualCommitBody(
    confirmOverwrite: boolean,
  ): ManifestImportBody | null {
    if (!commitBody) return null;
    return { ...commitBody, confirm_overwrite: confirmOverwrite };
  }

  async function runCommit(confirmOverwrite: boolean) {
    const bodyToSend = actualCommitBody(confirmOverwrite);
    if (!preview || !bodyToSend) {
      setCommitError(t("importManifestModal.errNoDeploySession"));
      return;
    }
    setCommitError(null);
    setCommitIssues([]);
    setCommitting(true);
    try {
      const response = await fetch(
        `/v1/tenants/${encodeURIComponent(slug)}/manifest-import`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: manifestHeaders(slug),
          body: JSON.stringify(bodyToSend),
        },
      );
      const body = await readResponseBody(response);
      if (response.status === 409) {
        const overwrite = ManifestImportOverwriteRequiredSchema.safeParse(body);
        if (!overwrite.success) {
          throw new Error(t("importManifestModal.errInvalidOverwriteResponse"));
        }
        setOverwriteRequired(overwrite.data);
        return;
      }
      if (!response.ok) {
        if (body && typeof body === "object") {
          const issues = (body as { issues?: unknown }).issues;
          if (Array.isArray(issues)) setCommitIssues(issues as CommitIssue[]);
        }
        throw new Error(responseError(body, response.status));
      }
      const committed = ManifestImportCommitSchema.safeParse(
        unwrapEnvelope<unknown>(body),
      );
      if (!committed.success) {
        throw new Error(
          `${t("importManifestModal.errInvalidCommitResponse")}: ${committed.error.issues[0]?.message ?? t("importManifestModal.errUnknownSchema")}`,
        );
      }
      committedRef.current = true;
      pendingDeploymentRef.current = null;
      setOverwriteRequired(null);
      toast({
        tone: "green",
        title: t("importManifestModal.toastDeployedTitle"),
        description: t("importManifestModal.toastVersionLive", {
          version: committed.data.version,
          slug,
        }),
      });
      refetchManifestDependents();
      onClose();
    } catch (error) {
      setCommitError(
        error instanceof Error
          ? error.message
          : t("importManifestModal.errNetworkDeploy"),
      );
    } finally {
      setCommitting(false);
    }
  }

  /**
   * Draft-mode import (workflow authoring). Re-validates with `draft_only`
   * so the api returns the canonical normalized payloads, then creates the
   * workflow draft through the authoring surface. No deployment is committed
   * and the pending validate session is left to the unmount cleanup.
   */
  async function createImportedDraft() {
    if (!draftTarget || !preview) return;
    setCommitError(null);
    setCommitIssues([]);
    setCommitting(true);
    try {
      const validateResponse = await fetch(
        `/v1/tenants/${encodeURIComponent(slug)}/manifest-import`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: manifestHeaders(slug),
          body: JSON.stringify({
            mode: "validate",
            workflow: workflowRaw,
            ...(actionsRaw ? { actions: actionsRaw } : {}),
            draft_only: true,
            workflow_slug: draftTarget.slug,
            workflow_name: draftTarget.name,
            conflict_resolutions: buildConflictResolutions(
              preview,
              resolutions,
            ),
          }),
        },
      );
      const validateBody = await readResponseBody(validateResponse);
      if (!validateResponse.ok) {
        throw new Error(responseError(validateBody, validateResponse.status));
      }
      const normalizedResult = ManifestImportPreviewSchema.safeParse(
        unwrapEnvelope<unknown>(validateBody),
      );
      if (!normalizedResult.success) {
        throw new Error(
          `${t("importManifestModal.errInvalidPreview")}: ${normalizedResult.error.issues[0]?.message ?? t("importManifestModal.errUnknownSchema")}`,
        );
      }
      const normalized = normalizedResult.data;
      const blockingIssues = normalized.issues.filter(
        (issue) => issue.severity === "error",
      );
      const blockingConflicts = normalized.conflicts.filter(
        (conflict) => conflict.severity === "block",
      );
      if (blockingIssues.length || blockingConflicts.length) {
        setCommitError(t("importManifestModal.errResolveBlockingBeforeDraft"));
        setCommitIssues(blockingIssues as CommitIssue[]);
        return;
      }
      if (!normalized.normalized_workflow) {
        throw new Error(t("importManifestModal.errMissingNormalizedWorkflow"));
      }
      const createResponse = await fetch("/v1/workflows", {
        method: "POST",
        credentials: "same-origin",
        headers: manifestHeaders(slug),
        body: JSON.stringify({
          slug: draftTarget.slug,
          name: draftTarget.name,
          description: t("importManifestModal.importedDraftDescription"),
          source: {
            type: "manifest",
            manifest: normalized.normalized_workflow,
            actions: normalized.normalized_actions ?? undefined,
          },
        }),
      });
      const createBody = await readResponseBody(createResponse);
      if (!createResponse.ok) {
        throw new Error(responseError(createBody, createResponse.status));
      }
      const workflow = WorkflowDetailSchema.parse(
        unwrapEnvelope<unknown>(createBody),
      );
      toast({
        tone: "green",
        title: t("importManifestModal.toastDraftCreated"),
        description: t("importManifestModal.toastDraftReady", {
          name: workflow.name,
        }),
      });
      refetchManifestDependents();
      onDraftCreated?.(workflow);
      onClose();
    } catch (error) {
      setCommitError(
        error instanceof Error
          ? error.message
          : t("importManifestModal.errDraftCreationFailed"),
      );
    } finally {
      setCommitting(false);
    }
  }

  function next() {
    if (step === 0) {
      void startValidation();
      return;
    }
    setStep((current) => Math.min(IMPORT_STEPS.length - 1, current + 1));
  }

  function back() {
    setStep((current) => Math.max(0, current - 1));
  }

  async function handleFiles(list: FileList | null) {
    if (!list) return;
    let nextWorkflow: unknown = null;
    let nextActions: unknown[] | null = null;
    const entries: FileEntry[] = [];

    for (const file of Array.from(list)) {
      if (file.size > MAX_FILE_BYTES) {
        entries.push({
          name: file.name,
          size: file.size,
          ok: false,
          error: t("importManifestModal.errFileTooLarge"),
        });
        continue;
      }
      try {
        const parsed = JSON.parse(await file.text()) as unknown;
        if (/actions.*\.json$/i.test(file.name)) {
          if (!Array.isArray(parsed)) {
            throw new Error(t("importManifestModal.errActionsMustBeArray"));
          }
          nextActions = parsed;
        } else if (/workflow.*\.json$/i.test(file.name)) {
          const pair = splitManifestPayload(parsed);
          nextWorkflow = pair.workflow;
          if (pair.actions) nextActions = pair.actions;
        } else {
          throw new Error(t("importManifestModal.errUnknownFileRole"));
        }
        entries.push({ name: file.name, size: file.size, ok: true });
      } catch (error) {
        entries.push({
          name: file.name,
          size: file.size,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    setFiles(entries);
    setWorkflowRaw(nextWorkflow);
    setActionsRaw(nextActions);
    const firstError = entries.find((entry) => !entry.ok)?.error;
    setValidationError(firstError ?? null);
  }

  function onDragOver(event: React.DragEvent) {
    event.preventDefault();
    dropRef.current?.classList.add("drop-hot");
  }

  function onDragLeave() {
    dropRef.current?.classList.remove("drop-hot");
  }

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    dropRef.current?.classList.remove("drop-hot");
    void handleFiles(event.dataTransfer.files);
  }

  const title =
    mode === "agent"
      ? t("importManifestModal.titleAgent")
      : t("importManifestModal.titleWorkflow");

  return (
    <ModalOverlay onClose={() => void requestClose()}>
      <div style={modalStyle}>
        <header style={headerStyle}>
          <Icon
            name="upload"
            size={14}
            style={{ color: "var(--accent-text)" }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{ fontSize: 14, color: "var(--text)", fontWeight: 500 }}
            >
              {title}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-3)" }}>
              {t("importManifestModal.headerAccepts")}{" "}
              <span className="mono" style={{ color: "var(--text-2)" }}>
                workflow.json
              </span>{" "}
              +{" "}
              <span className="mono" style={{ color: "var(--text-2)" }}>
                actions.json
              </span>
              . {t("importManifestModal.headerValidates")}
            </div>
          </div>
          <button
            onClick={() => void requestClose()}
            disabled={committing || closing}
            aria-label={t("importManifestModal.cancel")}
            style={{ color: "var(--text-3)" }}
          >
            <Icon name="x" size={13} />
          </button>
        </header>

        <div style={stepsStyle}>
          {IMPORT_STEPS.map((item, index) => (
            <ImportStepDot
              key={item.id}
              step={item}
              idx={index}
              active={step === index}
              done={index < step}
            />
          ))}
        </div>

        <div style={{ padding: 20, overflow: "auto", flex: 1, minHeight: 0 }}>
          {step === 0 && (
            <SourceStep
              source={source}
              setSource={setSource}
              files={files}
              handleFiles={handleFiles}
              pasted={pasted}
              setPasted={setPasted}
              url={url}
              setUrl={setUrl}
              repo={repo}
              setRepo={setRepo}
              dropRef={dropRef}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onStartBlank={onStartBlank}
              onDownloadTemplate={onDownloadTemplate}
            />
          )}
          {step === 1 &&
            (validating ? (
              <ValidatingState />
            ) : (
              <ValidateStep preview={preview} />
            ))}
          {step === 2 && preview && <DiffStep preview={preview} />}
          {step === 3 && preview && (
            <ResolveStep
              preview={preview}
              resolutions={resolutions}
              setResolutions={setResolutions}
            />
          )}
          {step === 4 && preview && (
            <PreviewStep preview={preview} manifest={workflowRaw} />
          )}
          {step === 5 && preview && commitBody && (
            <DeployStep
              slug={slug}
              target={target}
              noteText={noteText}
              setNoteText={setNoteText}
              commitBody={commitBody}
            />
          )}
        </div>

        {((validationError && (step === 0 || step === 1)) ||
          pendingLock ||
          commitError) && (
          <ErrorSurface
            validationError={validationError}
            pendingLock={pendingLock}
            commitError={commitError}
            commitIssues={commitIssues}
          />
        )}

        <footer style={footerStyle}>
          {step > 0 && (
            <Button tone="ghost" icon="chevron-left" onClick={back}>
              {t("importManifestModal.back")}
            </Button>
          )}
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>
            {t("importManifestModal.stepCounter", {
              current: step + 1,
              total: IMPORT_STEPS.length,
            })}
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <Button
              tone="ghost"
              onClick={() => void requestClose()}
              disabled={committing || closing}
            >
              {closing
                ? t("importManifestModal.cancelling")
                : t("importManifestModal.cancel")}
            </Button>
            {step < IMPORT_STEPS.length - 1 ? (
              <Button
                tone="primary"
                icon="chevron-right"
                onClick={next}
                disabled={!canAdvance}
              >
                {step === 0
                  ? validating
                    ? t("importManifestModal.validatingManifest")
                    : t("importManifestModal.validate")
                  : t("importManifestModal.continue")}
              </Button>
            ) : (
              <Button
                tone="primary"
                icon="deploy"
                onClick={() => {
                  if (draftTarget) void createImportedDraft();
                  else void runCommit(false);
                }}
                disabled={committing || !commitBody}
              >
                {committing
                  ? draftTarget
                    ? t("importManifestModal.creatingDraft")
                    : t("importManifestModal.deploying")
                  : draftTarget
                    ? t("importManifestModal.createWorkflowDraft")
                    : t("importManifestModal.deployToProd")}
              </Button>
            )}
          </div>
        </footer>

        <style>{`.drop-hot { background: var(--panel-2) !important; border-color: var(--signal) !important; }`}</style>
      </div>

      {overwriteRequired && (
        <OverwriteConfirmModal
          payload={{
            ...overwriteRequired,
            prior: preview
              ? {
                  version_label: preview.prior.version,
                  agents: preview.prior.agents,
                }
              : undefined,
          }}
          committing={committing}
          onCancel={() => setOverwriteRequired(null)}
          onConfirm={() => void runCommit(true)}
        />
      )}
    </ModalOverlay>
  );
}

function ImportStepDot({
  step,
  idx,
  active,
  done,
}: {
  step: (typeof IMPORT_STEPS)[number];
  idx: number;
  active: boolean;
  done: boolean;
}) {
  const { t } = useI18n();
  return (
    <div style={stepDotStyle(active, done)}>
      <span style={stepNumberStyle(active, done)}>{done ? "✓" : idx + 1}</span>
      <Icon name={step.icon} size={10} style={{ color: "var(--text-3)" }} />
      <div>
        <div style={stepLabelStyle(active)}>
          {t(`importManifestModal.step_${step.id}`)}
        </div>
        <div style={{ fontSize: 10, color: "var(--text-3)" }}>
          {t(`importManifestModal.stepHint_${step.id}`)}
        </div>
      </div>
    </div>
  );
}

function SourceStep({
  source,
  setSource,
  files,
  handleFiles,
  pasted,
  setPasted,
  url,
  setUrl,
  repo,
  setRepo,
  dropRef,
  onDragOver,
  onDragLeave,
  onDrop,
  onStartBlank,
  onDownloadTemplate,
}: {
  source: SourceKind;
  setSource: (source: SourceKind) => void;
  files: FileEntry[];
  handleFiles: (files: FileList | null) => void | Promise<void>;
  pasted: string;
  setPasted: (value: string) => void;
  url: string;
  setUrl: (value: string) => void;
  repo: RepoSource;
  setRepo: (value: RepoSource) => void;
  dropRef: React.RefObject<HTMLDivElement | null>;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: React.DragEvent) => void;
  onStartBlank?: () => void;
  onDownloadTemplate?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div>
      <div style={eyebrowStyle}>{t("importManifestModal.bringAWorkflow")}</div>
      <div style={sourceGridStyle}>
        <SourceCard
          active={source === "file"}
          onClick={() => setSource("file")}
          icon="upload"
          title={t("importManifestModal.srcUploadTitle")}
          sub={t("importManifestModal.srcUploadSub")}
        />
        <SourceCard
          active={source === "paste"}
          onClick={() => setSource("paste")}
          icon="code"
          title={t("importManifestModal.srcPasteTitle")}
          sub={t("importManifestModal.srcPasteSub")}
        />
        <SourceCard
          active={source === "url"}
          onClick={() => setSource("url")}
          icon="external"
          title={t("importManifestModal.srcUrlTitle")}
          sub={t("importManifestModal.srcUrlSub")}
        />
        <SourceCard
          active={source === "git"}
          onClick={() => setSource("git")}
          icon="git"
          title={t("importManifestModal.srcRepoTitle")}
          sub={t("importManifestModal.srcRepoSub")}
        />
      </div>

      {onStartBlank || onDownloadTemplate ? (
        <div
          style={{
            marginTop: 18,
            paddingTop: 16,
            borderTop: "1px solid var(--border)",
            display: "grid",
            gap: 10,
          }}
        >
          <div style={eyebrowStyle}>
            {t("importManifestModal.orStartFromNothing")}
          </div>
          {onStartBlank ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                flexWrap: "wrap",
                padding: "13px 15px",
                borderRadius: 6,
                border: "1px solid var(--border-2)",
                background: "var(--panel-2)",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <strong style={{ display: "block", fontSize: 13 }}>
                  {t("importManifestModal.startBlankTitle")}
                </strong>
                <span style={{ color: "var(--text-3)", fontSize: 11.5 }}>
                  {t("importManifestModal.startBlankSub")}
                </span>
              </div>
              <Button icon="plus" tone="primary" onClick={onStartBlank}>
                {t("importManifestModal.createBlankCta")}
              </Button>
            </div>
          ) : null}
          {onDownloadTemplate ? (
            <button
              type="button"
              onClick={onDownloadTemplate}
              style={{
                justifySelf: "start",
                background: "none",
                border: "none",
                padding: 0,
                color: "var(--signal)",
                fontSize: 11.5,
                cursor: "pointer",
              }}
            >
              {t("importManifestModal.downloadTemplateLink")}
            </button>
          ) : null}
        </div>
      ) : null}

      {source === "file" && (
        <>
          <div
            ref={dropRef}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            style={dropStyle}
          >
            <Icon name="upload" size={22} style={{ color: "var(--text-3)" }} />
            <div style={{ marginTop: 8, fontSize: 13, color: "var(--text-2)" }}>
              {t("importManifestModal.dropPrefix")}{" "}
              <span className="mono" style={{ color: "var(--text)" }}>
                workflow.json
              </span>{" "}
              {t("importManifestModal.dropAnd")}{" "}
              <span className="mono" style={{ color: "var(--text)" }}>
                actions.json
              </span>
            </div>
            <div
              style={{ marginTop: 4, fontSize: 11.5, color: "var(--text-3)" }}
            >
              {t("importManifestModal.or")}{" "}
              <label style={{ color: "var(--accent-text)", cursor: "pointer" }}>
                {t("importManifestModal.browseFiles")}
                <input
                  type="file"
                  multiple
                  accept=".json,application/json"
                  style={{ display: "none" }}
                  onChange={(event) => void handleFiles(event.target.files)}
                />
              </label>{" "}
              {t("importManifestModal.maxFileSize")}
            </div>
          </div>
          {files.length > 0 && (
            <div
              style={{
                marginTop: 12,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {files.map((file, index) => (
                <div
                  key={`${file.name}:${index}`}
                  style={fileRowStyle(file.ok)}
                >
                  <Icon
                    name={file.ok ? "check" : "alert"}
                    size={12}
                    style={{ color: file.ok ? "var(--green)" : "var(--amber)" }}
                  />
                  <span
                    className="mono"
                    style={{ fontSize: 12, color: "var(--text)" }}
                  >
                    {file.name}
                  </span>
                  {file.error && (
                    <span style={{ fontSize: 11, color: "var(--amber)" }}>
                      {file.error}
                    </span>
                  )}
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 11,
                      fontFamily: "var(--mono)",
                      color: "var(--text-3)",
                    }}
                  >
                    {fmtBytes(file.size)}
                  </span>
                  <Badge tone={file.ok ? "green" : "amber"}>
                    {file.ok
                      ? t("importManifestModal.badgeDetected")
                      : t("importManifestModal.badgeUnknownRole")}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {source === "paste" && (
        <MonacoEditor
          value={pasted}
          onChange={setPasted}
          language="json"
          height={320}
        />
      )}

      {source === "url" && (
        <div>
          <FieldLabel>{t("importManifestModal.manifestUrlLabel")}</FieldLabel>
          <input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/workflow.json"
            style={inputStyle}
          />
          <div style={helpStyle}>{t("importManifestModal.urlJsonOnly")}</div>
        </div>
      )}

      {source === "git" && (
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: 12 }}
        >
          <div>
            <FieldLabel>
              {t("importManifestModal.repoRepositoryLabel")}
            </FieldLabel>
            <input
              value={repo.repository}
              onChange={(event) =>
                setRepo({ ...repo, repository: event.target.value })
              }
              placeholder="https://github.com/organization/repository"
              style={inputStyle}
            />
          </div>
          <div>
            <FieldLabel>{t("importManifestModal.repoRefLabel")}</FieldLabel>
            <input
              value={repo.ref}
              onChange={(event) =>
                setRepo({ ...repo, ref: event.target.value })
              }
              placeholder={t("importManifestModal.repoRefPlaceholder")}
              style={inputStyle}
            />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <FieldLabel>{t("importManifestModal.repoPathLabel")}</FieldLabel>
            <input
              value={repo.path}
              onChange={(event) =>
                setRepo({ ...repo, path: event.target.value })
              }
              placeholder="path/to/workflow.json"
              style={inputStyle}
            />
            <div style={helpStyle}>{t("importManifestModal.repoHelp")}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label
      style={{
        display: "block",
        fontSize: 11,
        color: "var(--text-2)",
        marginBottom: 4,
      }}
    >
      {children}
    </label>
  );
}

function SourceCard({
  active,
  onClick,
  icon,
  title,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  icon: IconName;
  title: string;
  sub: string;
}) {
  return (
    <button onClick={onClick} style={sourceCardStyle(active)}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 5,
        }}
      >
        <Icon
          name={icon}
          size={12}
          style={{ color: active ? "var(--accent-text)" : "var(--text-2)" }}
        />
        <span style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 500 }}>
          {title}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.45 }}>
        {sub}
      </div>
    </button>
  );
}

function ValidatingState() {
  const { t } = useI18n();
  return (
    <div style={{ padding: "60px 20px", textAlign: "center" }}>
      <div style={spinnerStyle} />
      <div style={{ marginTop: 16, fontSize: 13, color: "var(--text)" }}>
        {t("importManifestModal.validatingManifest")}
      </div>
      <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--text-3)" }}>
        {t("importManifestModal.validatingSteps")}
      </div>
    </div>
  );
}

function ValidateStep({ preview }: { preview: ManifestImportPreview | null }) {
  const { t } = useI18n();
  if (!preview) return null;
  return (
    <div>
      <div style={metricsGridStyle}>
        <MetricCell
          label={t("importManifestModal.cellSchemaVersion")}
          value={preview.schema_version}
        />
        <MetricCell
          label={t("importManifestModal.cellAgents")}
          value={preview.parsed.agents}
        />
        <MetricCell
          label={t("importManifestModal.cellEvents")}
          value={preview.parsed.events}
        />
        <MetricCell
          label={t("importManifestModal.cellActions")}
          value={preview.parsed.actions}
        />
        <MetricCell
          label={t("importManifestModal.cellElapsed")}
          value={`${preview.elapsed_ms} ms`}
        />
      </div>
      <IssuesPanel issues={preview.issues} />
    </div>
  );
}

function MetricCell({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div
      style={{ padding: "10px 14px", borderRight: "1px solid var(--border)" }}
    >
      <div style={metricLabelStyle}>{label}</div>
      <div
        style={{
          marginTop: 4,
          fontSize: 16,
          fontFamily: "var(--mono)",
          color: "var(--text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function IssuesPanel({ issues }: { issues: ManifestImportPreview["issues"] }) {
  const { t } = useI18n();
  return (
    <Panel title={t("importManifestModal.validationResults")} padded={false}>
      {issues.length === 0 ? (
        <div style={emptyRowStyle}>{t("importManifestModal.noIssues")}</div>
      ) : (
        issues.map((issue, index) => (
          <div
            key={`${issue.path}:${issue.code}:${index}`}
            style={issueRowStyle(index, issues.length)}
          >
            <Icon
              name={issue.severity === "info" ? "check" : "alert"}
              size={11}
              style={{
                color:
                  issue.severity === "error"
                    ? "var(--red)"
                    : issue.severity === "warning"
                      ? "var(--amber)"
                      : "var(--green)",
              }}
            />
            <span
              className="mono"
              style={{ fontSize: 11, color: "var(--text-3)" }}
            >
              {issue.path || "/"}
            </span>
            <span style={{ fontSize: 12, color: "var(--text-2)" }}>
              {issue.message}
            </span>
            <Badge
              tone={
                issue.severity === "error"
                  ? "red"
                  : issue.severity === "warning"
                    ? "amber"
                    : "muted"
              }
            >
              {issue.code}
            </Badge>
          </div>
        ))
      )}
    </Panel>
  );
}

function DiffStep({ preview }: { preview: ManifestImportPreview }) {
  const { t } = useI18n();
  const subtitle = preview.prior.version
    ? t("importManifestModal.diffPrior", {
        version: preview.prior.version,
        prior: preview.prior.agents,
        imported: preview.parsed.agents,
      })
    : t("importManifestModal.diffNoPrior", {
        imported: preview.parsed.agents,
      });
  return (
    <Panel
      title={t("importManifestModal.diffTitle")}
      subtitle={subtitle}
      padded={false}
    >
      {preview.prior.live_deployment_id && (
        <div
          style={{
            padding: "8px 14px",
            borderBottom: "1px solid var(--border)",
            fontSize: 11,
            color: "var(--text-3)",
          }}
        >
          {t("importManifestModal.priorDeploymentId")}{" "}
          <span className="mono">{preview.prior.live_deployment_id}</span>
        </div>
      )}
      <DiffGroup label="added" ids={preview.diff.added} />
      <DiffGroup label="modified" ids={preview.diff.modified} />
      <DiffGroup label="removed" ids={preview.diff.removed} />
    </Panel>
  );
}

function DiffGroup({
  label,
  ids,
}: {
  label: "added" | "modified" | "removed";
  ids: string[];
}) {
  const { t } = useI18n();
  const color =
    label === "added"
      ? "var(--green)"
      : label === "modified"
        ? "var(--amber)"
        : "var(--red)";
  const sigil = label === "added" ? "+" : label === "modified" ? "~" : "−";
  const labelText =
    label === "added"
      ? t("importManifestModal.diffAdded")
      : label === "modified"
        ? t("importManifestModal.diffModified")
        : t("importManifestModal.diffRemoved");
  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div style={diffHeaderStyle}>
        <span style={{ color, fontFamily: "var(--mono)", fontWeight: 700 }}>
          {sigil}
        </span>
        <span style={diffLabelStyle}>
          {labelText} · {ids.length}
        </span>
      </div>
      {ids.length === 0 ? (
        <div style={emptyRowStyle}>{t("importManifestModal.diffNone")}</div>
      ) : (
        ids.map((id) => (
          <div key={id} style={diffItemStyle}>
            <Badge tone="muted">{id}</Badge>
          </div>
        ))
      )}
    </div>
  );
}

function ResolveStep({
  preview,
  resolutions,
  setResolutions,
}: {
  preview: ManifestImportPreview;
  resolutions: Record<string, ResolutionChoice>;
  setResolutions: (value: Record<string, ResolutionChoice>) => void;
}) {
  const { t } = useI18n();
  return (
    <Panel
      title={t("importManifestModal.conflictsTitle", {
        count: preview.conflicts.length,
      })}
      subtitle={t("importManifestModal.conflictsSubtitle")}
      padded={false}
    >
      {preview.conflicts.length === 0 ? (
        <div style={emptyRowStyle}>{t("importManifestModal.noConflicts")}</div>
      ) : (
        preview.conflicts.map((conflict, index) => {
          const key = conflictKey(conflict, index);
          const current = resolutions[key] ?? "skip";
          return (
            <div
              key={key}
              style={conflictRowStyle(index, preview.conflicts.length)}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Badge tone={conflict.severity === "block" ? "red" : "amber"}>
                  {conflict.type}
                </Badge>
                <span
                  className="mono"
                  style={{ fontSize: 12, color: "var(--text)" }}
                >
                  {conflict.path}
                </span>
              </div>
              <div
                style={{ marginTop: 6, fontSize: 11.5, color: "var(--text-2)" }}
              >
                {conflict.detail}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                {conflict.auto_fix && (
                  <ResolveOption
                    active={current === "auto_fix"}
                    onClick={() =>
                      setResolutions({ ...resolutions, [key]: "auto_fix" })
                    }
                    label={t("importManifestModal.conflictAutoFix")}
                    hint={
                      conflict.suggestion ??
                      t("importManifestModal.conflictAutoFixHint", {
                        action: conflict.auto_fix.action,
                      })
                    }
                  />
                )}
                <ResolveOption
                  active={current === "skip"}
                  onClick={() =>
                    setResolutions({ ...resolutions, [key]: "skip" })
                  }
                  label={t("importManifestModal.conflictSkip")}
                  hint={t("importManifestModal.conflictSkipHint")}
                />
              </div>
            </div>
          );
        })
      )}
    </Panel>
  );
}

function ResolveOption({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button onClick={onClick} style={resolveOptionStyle(active)}>
      <span>{label}</span>
      <span
        style={{
          fontSize: 10,
          fontFamily: "var(--mono)",
          color: "var(--text-3)",
        }}
      >
        {hint}
      </span>
    </button>
  );
}

function PreviewStep({
  preview,
  manifest,
}: {
  preview: ManifestImportPreview;
  manifest: unknown;
}) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel
        title={t("importManifestModal.previewTitle")}
        subtitle={`${t("importManifestModal.sessionLabel")} ${preview.deployment_id}`}
        padded
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, 1fr)",
            gap: 12,
          }}
        >
          <Stat
            label={t("importManifestModal.cellAgents")}
            value={preview.parsed.agents}
            mono
          />
          <Stat
            label={t("importManifestModal.cellEvents")}
            value={preview.parsed.events}
            mono
          />
          <Stat
            label={t("importManifestModal.cellActions")}
            value={preview.parsed.actions}
            mono
          />
          <Stat
            label={t("importManifestModal.statIssues")}
            value={preview.issues.length}
            mono
          />
          <Stat
            label={t("importManifestModal.statValidationTime")}
            value={`${preview.elapsed_ms} ms`}
            mono
          />
        </div>
      </Panel>
      <Panel title={t("importManifestModal.summaryTitle")} padded>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 12,
          }}
        >
          <Stat
            label={t("importManifestModal.diffAdded")}
            value={preview.diff.added.length}
            mono
            accent="var(--green)"
          />
          <Stat
            label={t("importManifestModal.diffModified")}
            value={preview.diff.modified.length}
            mono
            accent="var(--amber)"
          />
          <Stat
            label={t("importManifestModal.diffRemoved")}
            value={preview.diff.removed.length}
            mono
            accent="var(--red)"
          />
          <Stat
            label={t("importManifestModal.statConflicts")}
            value={preview.conflicts.length}
            mono
          />
        </div>
      </Panel>
      <Panel title={t("importPreviewGraph.title")} padded>
        <ImportPreviewGraph manifest={manifest} diff={preview.diff} />
      </Panel>
      <IssuesPanel issues={preview.issues} />
    </div>
  );
}

function DeployStep({
  slug,
  target,
  noteText,
  setNoteText,
  commitBody,
}: {
  slug: string;
  target: DeployTarget;
  noteText: string;
  setNoteText: (note: string) => void;
  commitBody: ManifestImportBody;
}) {
  const { t } = useI18n();
  return (
    <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 14 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Panel
          title={t("importManifestModal.deployTarget")}
          subtitle={t("importManifestModal.currentTenant", { slug })}
          padded
        >
          {/* Single supported tier — the api contract has no staging target,
           * so the wizard makes no staging claim. */}
          <DeployTargetOption
            value="production"
            current={target}
            label={t("importManifestModal.targetProduction")}
            sub={t("importManifestModal.targetProductionSub")}
          />
        </Panel>
        <Panel title={t("importManifestModal.noteLabel")} padded>
          <textarea
            value={noteText}
            maxLength={500}
            onChange={(event) => setNoteText(event.target.value)}
            placeholder={t("importManifestModal.notePlaceholder")}
            style={{ ...inputStyle, minHeight: 100, resize: "vertical" }}
          />
          <div style={{ ...helpStyle, textAlign: "right" }}>
            {t("importManifestModal.noteCounter", { count: noteText.length })}
          </div>
        </Panel>
      </div>
      <Panel
        title={t("importManifestModal.finalManifest")}
        subtitle={t("importManifestModal.finalManifestSubtitle")}
        padded={false}
      >
        <CodeBlock>{JSON.stringify(commitBody, null, 2)}</CodeBlock>
      </Panel>
    </div>
  );
}

function DeployTargetOption({
  value,
  current,
  label,
  sub,
}: {
  value: DeployTarget;
  current: DeployTarget;
  label: string;
  sub: string;
}) {
  const active = current === value;
  return (
    <label style={deployTargetStyle(active)}>
      <input
        type="radio"
        name="manifest-deploy-target"
        value={value}
        checked={active}
        readOnly
        style={{ accentColor: "var(--signal)" }}
      />
      <div>
        <div style={{ fontSize: 12.5, color: "var(--text)" }}>{label}</div>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>{sub}</div>
      </div>
    </label>
  );
}

function ErrorSurface({
  validationError,
  pendingLock,
  commitError,
  commitIssues,
}: {
  validationError: string | null;
  pendingLock: PendingLock | null;
  commitError: string | null;
  commitIssues: CommitIssue[];
}) {
  const { t } = useI18n();
  const tone = commitError || validationError ? "var(--red)" : "var(--amber)";
  return (
    <div
      style={{
        padding: "10px 18px",
        borderTop: `1px solid ${tone}`,
        color: tone,
        fontSize: 12,
        maxHeight: 180,
        overflow: "auto",
      }}
    >
      {validationError && <div>{validationError}</div>}
      {pendingLock && (
        <div>
          {t("importManifestModal.lockInProgress")}
          {pendingLock.locked_by ? ` (${pendingLock.locked_by})` : ""}.{" "}
          {t("importManifestModal.lockWait")}
        </div>
      )}
      {commitError && <div>{commitError}</div>}
      {commitIssues.length > 0 && (
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {commitIssues.map((issue, index) => (
            <li key={`${issue.path}:${issue.code}:${index}`}>
              <span className="mono">{issue.path}</span> — {issue.message} [
              {issue.code}]
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const modalStyle: React.CSSProperties = {
  width: 980,
  maxHeight: "90vh",
  background: "var(--panel)",
  border: "1px solid var(--border-2)",
  borderRadius: 8,
  overflow: "hidden",
  boxShadow: "0 24px 60px -20px rgba(0,0,0,0.6)",
  display: "flex",
  flexDirection: "column",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "14px 18px",
  borderBottom: "1px solid var(--border)",
};

const stepsStyle: React.CSSProperties = {
  display: "flex",
  padding: "10px 18px",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg-2)",
  gap: 4,
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "12px 18px",
  borderTop: "1px solid var(--border)",
  background: "var(--panel-2)",
};

const sourceGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: 8,
  marginBottom: 18,
};

const eyebrowStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "var(--mono)",
  textTransform: "uppercase",
  color: "var(--text-3)",
  letterSpacing: "0.08em",
  marginBottom: 10,
};

const dropStyle: React.CSSProperties = {
  padding: 32,
  textAlign: "center",
  background: "var(--bg-2)",
  border: "1px dashed var(--border-3)",
  borderRadius: 6,
  transition: "background 0.12s, border-color 0.12s",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  background: "var(--panel-2)",
  border: "1px solid var(--border-2)",
  borderRadius: 4,
  color: "var(--text)",
  fontFamily: "var(--mono)",
  fontSize: 12,
  outline: "none",
  boxSizing: "border-box",
};

const helpStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 11,
  color: "var(--text-3)",
  lineHeight: 1.5,
};

const spinnerStyle: React.CSSProperties = {
  display: "inline-block",
  width: 22,
  height: 22,
  border: "3px solid var(--border-2)",
  borderTopColor: "var(--signal)",
  borderRadius: "50%",
  animation: "spin 0.8s linear infinite",
};

const metricsGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(5, 1fr)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  marginBottom: 14,
  background: "var(--panel)",
};

const metricLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontFamily: "var(--mono)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--text-3)",
};

const emptyRowStyle: React.CSSProperties = {
  padding: "12px 14px",
  fontSize: 11.5,
  color: "var(--text-3)",
};

const diffHeaderStyle: React.CSSProperties = {
  padding: "8px 14px",
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: "var(--panel-2)",
};

const diffLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "var(--mono)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--text-2)",
};

const diffItemStyle: React.CSSProperties = {
  padding: "7px 14px 7px 36px",
  borderTop: "1px solid var(--border)",
};

function stepDotStyle(active: boolean, done: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "5px 10px",
    background: active ? "var(--panel)" : "transparent",
    border: `1px solid ${active ? "var(--signal)" : "transparent"}`,
    borderRadius: 4,
    opacity: active ? 1 : done ? 0.95 : 0.5,
  };
}

function stepNumberStyle(active: boolean, done: boolean): React.CSSProperties {
  return {
    width: 18,
    height: 18,
    borderRadius: "50%",
    background: done ? "var(--signal)" : "transparent",
    border: `1px solid ${done || active ? "var(--signal)" : "var(--border-2)"}`,
    color: done
      ? "var(--on-signal)"
      : active
        ? "var(--accent-text)"
        : "var(--text-3)",
    fontSize: 10,
    fontFamily: "var(--mono)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
}

function stepLabelStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    fontFamily: "var(--mono)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: active ? "var(--text)" : "var(--text-3)",
    lineHeight: 1.1,
  };
}

function sourceCardStyle(active: boolean): React.CSSProperties {
  return {
    padding: "12px 14px",
    background: active ? "var(--panel-3)" : "var(--panel-2)",
    border: `1px solid ${active ? "var(--signal)" : "var(--border)"}`,
    borderRadius: 5,
    textAlign: "left",
    cursor: "pointer",
  };
}

function fileRowStyle(ok: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "7px 12px",
    background: "var(--panel-2)",
    border: `1px solid ${ok ? "var(--border)" : "color-mix(in srgb, var(--amber) 30%, transparent)"}`,
    borderRadius: 4,
  };
}

function issueRowStyle(index: number, count: number): React.CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: "16px minmax(100px, 220px) 1fr auto",
    alignItems: "center",
    gap: 10,
    padding: "8px 14px",
    borderBottom: index < count - 1 ? "1px solid var(--border)" : "none",
  };
}

function conflictRowStyle(index: number, count: number): React.CSSProperties {
  return {
    padding: "12px 14px",
    borderBottom: index < count - 1 ? "1px solid var(--border)" : "none",
  };
}

function resolveOptionStyle(active: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: active ? "var(--panel-3)" : "var(--panel-2)",
    color: active ? "var(--text)" : "var(--text-3)",
    border: `1px solid ${active ? "var(--signal)" : "var(--border-2)"}`,
    borderRadius: 4,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 1,
  };
}

function deployTargetStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 12px",
    background: active ? "var(--panel-2)" : "transparent",
    border: `1px solid ${active ? "var(--signal)" : "var(--border)"}`,
    borderRadius: 4,
    cursor: "pointer",
    marginBottom: 6,
  };
}
