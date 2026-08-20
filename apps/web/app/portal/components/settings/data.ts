/**
 * Settings navigation + enumerated allow-lists; no runtime records live here.
 *
 * Section labels/hints are i18n keys resolved at render time
 * (`settings.section.<id>` / `settings.sectionHint.<id>`), so this registry
 * stays icon-only. TIMEZONES / LOCALES are intentional enumerations for
 * select fields (Workspace section), not synthesized data.
 */

export const SETTINGS_SECTIONS = [
  { id: "workspace", icon: "settings" as const },
  { id: "appearance", icon: "moon" as const },
  { id: "people", icon: "human" as const },
  // AI & models — LLM gateway settings, routing, providers, live tests.
  { id: "ai", icon: "spark" as const },
  { id: "models", icon: "spark" as const },
  // Programmatic access + outbound integrations (real /v1/api-tokens and
  // /v1/integrations surfaces).
  { id: "tokens", icon: "code" as const },
  { id: "integrations", icon: "external" as const },
  { id: "billing", icon: "deploy" as const },
  // P3-FE-03 — cost dashboard. Lives at its own sub-route so deep-links
  // and tab-state survive a reload.
  { id: "usage", icon: "dashboard" as const },
  { id: "audit", icon: "logs" as const },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

// Sections that render at their own sub-route (see ROUTED_SECTIONS in the
// settings page). A `?section=` deep-link to one of these would only flash an
// empty inline slot, so we treat them as "not inline-deep-linkable".
const ROUTED_SECTION_IDS: ReadonlySet<string> = new Set(["usage", "audit"]);

/**
 * Resolve a `?section=` deep-link to a section the page can render inline,
 * falling back to "workspace" for missing/unknown/sub-routed values. This is
 * what lets callers (e.g. OntoCode's "去配置" CTA) land the operator directly
 * on the relevant tab instead of the default Workspace one.
 */
export function resolveDeepLinkedSection(
  raw: string | null | undefined,
): SettingsSectionId {
  if (
    raw &&
    !ROUTED_SECTION_IDS.has(raw) &&
    SETTINGS_SECTIONS.some((s) => s.id === raw)
  ) {
    return raw as SettingsSectionId;
  }
  return "workspace";
}

export const TIMEZONES = [
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Hong_Kong",
  "Australia/Sydney",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "UTC",
];

export const LOCALES = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "zh-CN", label: "Simplified Chinese" },
  { value: "zh-TW", label: "Traditional Chinese" },
  { value: "ja-JP", label: "Japanese" },
  { value: "ko-KR", label: "Korean" },
];
