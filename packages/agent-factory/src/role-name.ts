const MAX_AGENT_DISPLAY_NAME_CODEPOINTS = 12;

function clean(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keep the UI-only Agent display name bounded and stable across model retries.
 *
 * Some providers degenerate while filling `role_name` and append a long tail
 * made only of the characters in “职位” (for example
 * `身份风控官职位职职职…`).  That tail is generation noise, not Ontology or
 * product data.  Strip only the unmistakably repeated form (three or more
 * trailing characters after the first “职位”), then enforce the documented
 * 12-codepoint limit. A normal name such as “创建职位” is unchanged.
 */
export function normalizeAgentDisplayName(
  value: unknown,
  fallback: unknown,
): string {
  let name = clean(value);
  name = name.replace(/职位[职位]{3,}$/u, "").trim();
  if (!name) name = clean(fallback);
  return Array.from(name).slice(0, MAX_AGENT_DISPLAY_NAME_CODEPOINTS).join("");
}
