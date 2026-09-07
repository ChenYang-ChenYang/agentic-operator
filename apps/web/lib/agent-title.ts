/**
 * The name an operator reads for an agent, in the portal's current language.
 *
 * Ontology-compiled manifests ship `title_i18n` (`{ zh, en, … }`) next to the
 * single `title`; hand-authored manifests ship only `title`; a bare DB row may
 * have neither. Resolution: the exact language → its base language (`zh-CN`
 * → `zh`) → the manifest `title` → the technical `name`.
 */

export interface AgentTitleSource {
  name: string;
  title?: string | null;
  titleI18n?: Record<string, string> | null;
}

export function agentDisplayTitle(
  agent: AgentTitleSource,
  language: string | null | undefined,
): string {
  const localized = agent.titleI18n;
  if (localized && language) {
    const exact = localized[language]?.trim();
    if (exact) return exact;
    const base = language.split(/[-_]/)[0]?.toLowerCase();
    if (base) {
      for (const [tag, value] of Object.entries(localized)) {
        if (tag.toLowerCase().split(/[-_]/)[0] === base && value.trim()) {
          return value.trim();
        }
      }
    }
  }
  const title = agent.title?.trim();
  return title || agent.name;
}
