/**
 * A fleet entry records which model a tenant wants; it does not guarantee the
 * provider still has credentials in this deployment. Selecting an entry whose
 * provider is unconfigured fails the request at `resolveModel` before any
 * generation happens, so pick a usable entry — or none, which lets the caller
 * fall back to the workspace default.
 */
export interface SelectableFleetEntry {
  provider: string;
  modelName: string;
  role: string;
  /** Absent on payloads from an older API; treated as configured. */
  providerConfigured?: boolean;
}

export function defaultFleetModelKey(entries: SelectableFleetEntry[]): string {
  const usable = entries.filter((entry) => entry.providerConfigured !== false);
  const chosen =
    usable.find((entry) => entry.role === "primary") ?? usable[0] ?? null;
  return chosen ? `${chosen.provider}::${chosen.modelName}` : "";
}
