/**
 * useIntegrations — TanStack Query wrappers around `/v1/integrations`.
 *
 * Backs Settings → Integrations: list the tenant's configured external
 * services (e.g. GoHire ATS) + the catalog of providers that can be added,
 * upsert one (base URL + API key), remove one, and run a connection test.
 *
 * Tenant scope rides on `tenantHeader()` — the api enforces filtering
 * server-side. The API key is write-only: it goes UP in the upsert body and
 * never comes back down (responses carry only `keyMasked` + `hasKey`).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { tenantHeader } from "./tenant-header";

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: { code: string; message: string };
}

async function callV1<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers: initHeaders, ...rest } = init;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...tenantHeader(),
    ...(initHeaders as Record<string, string> | undefined),
  };
  if (rest.body !== undefined && rest.body !== null && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, { credentials: "same-origin", ...rest, headers });
  const body = (await res.json()) as ApiOk<T> | ApiErr;
  if (!body.ok) {
    throw new Error(`${path}: ${body.error.code} — ${body.error.message}`);
  }
  return body.data;
}

export type IntegrationStatus = "unconfigured" | "ok" | "error";

export interface Integration {
  id: string;
  provider: string;
  name: string;
  baseUrl: string | null;
  keyMasked: string | null;
  hasKey: boolean;
  /** Non-secret dynamic field values keyed by spec key. */
  config: Record<string, string>;
  /** KEYS of stored extra secret fields (values never come down). */
  secretKeysStored: string[];
  status: IntegrationStatus;
  lastCheckedAt: number | null;
  lastError: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AvailableIntegration {
  id: string;
  name: string;
  kind: string;
  defaultBaseUrl: string;
  description: string;
  docsUrl?: string;
  /** "catalog" = built-in; "profile" = derived from a System Profile. */
  source?: "catalog" | "profile";
}

// ── Dynamic config requirement (mirrors @agentic/contracts SystemConfigRequirement) ──

export type ConfigFieldKind = "base_url" | "api_key" | "secret" | "text" | "select" | "env_only";

export interface DerivedConfigField {
  key: string;
  label: string;
  kind: ConfigFieldKind;
  required: boolean;
  secret?: boolean;
  envRef?: string;
  placeholder?: string;
  hint?: string;
  options?: string[];
  source: "profile" | "tool" | "catalog" | "default";
  satisfied: boolean;
  envPresent?: boolean;
}

export interface ConfigRequirement {
  provider: string | null;
  posture: "fields" | "none" | "env_only" | "server_managed" | "planned" | "unsupported";
  fields: DerivedConfigField[];
  satisfied: boolean;
  note?: string;
}

export interface RequirementPayload {
  provider: string;
  systemName: string;
  profileId: string | null;
  requirement: ConfigRequirement;
}

/** The dynamic form spec for one provider — what the editor renders. */
export function useIntegrationRequirement(
  provider: string | null,
): UseQueryResult<RequirementPayload> {
  return useQuery({
    queryKey: ["integrations", "requirements", provider],
    queryFn: () =>
      callV1<RequirementPayload>(
        `/v1/integrations/requirements?provider=${encodeURIComponent(provider!)}`,
      ),
    enabled: provider !== null && provider.length > 0,
    staleTime: 10_000,
  });
}

export interface IntegrationsPayload {
  integrations: Integration[];
  available: AvailableIntegration[];
}

const INTEGRATION_KEYS = {
  list: ["integrations", "list"] as const,
};

export function useIntegrations(): UseQueryResult<IntegrationsPayload> {
  return useQuery({
    queryKey: INTEGRATION_KEYS.list,
    queryFn: () => callV1<IntegrationsPayload>("/v1/integrations"),
    staleTime: 10_000,
  });
}

export interface UpsertIntegrationInput {
  provider: string;
  name?: string;
  baseUrl?: string;
  /** Omit to leave the stored key untouched; "" to clear it. */
  apiKey?: string;
  /** Dynamic field values keyed by spec key ("" deletes; omitted keys keep).
   *  The server routes secret vs plain by the field's spec — fail-closed. */
  fields?: Record<string, string>;
  enabled?: boolean;
}

export function useUpsertIntegration() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertIntegrationInput) =>
      callV1<Integration>("/v1/integrations", {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: INTEGRATION_KEYS.list });
    },
  });
}

export function useDeleteIntegration() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) =>
      callV1<{ deleted: true }>(
        `/v1/integrations/${encodeURIComponent(provider)}`,
        { method: "DELETE" },
      ),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: INTEGRATION_KEYS.list });
    },
  });
}

export interface TestIntegrationResult {
  ok: boolean;
  status: IntegrationStatus;
  message: string | null;
  checkedAt: number;
  integration: Integration | null;
}

export function useTestIntegration() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) =>
      callV1<TestIntegrationResult>(
        `/v1/integrations/${encodeURIComponent(provider)}/test`,
        { method: "POST" },
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: INTEGRATION_KEYS.list });
    },
  });
}
