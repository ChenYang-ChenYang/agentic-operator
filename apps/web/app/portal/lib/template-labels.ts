/**
 * Localised names and descriptions for the API's workflow template catalog.
 *
 * The catalog is defined server-side (apps/api/src/services/workflow-templates.ts)
 * as English literals, and `GET /v1/workflow-templates` takes no locale — so the
 * cards rendered English text inside a Chinese UI while the counts beside them
 * were translated.
 *
 * Localising on the client keeps the server as the single source of truth for
 * template ids and structure. An id this dictionary does not know keeps the
 * server's own string, so a newly added template degrades to English rather
 * than rendering a raw key.
 */

import type { Translate } from "./preferences-context";

const NAME_KEYS: Readonly<Record<string, string>> = {
  "hello-world": "workflowTemplates.helloWorld.name",
  "webhook-summarizer": "workflowTemplates.webhookSummarizer.name",
  "scheduled-report": "workflowTemplates.scheduledReport.name",
  "support-triage": "workflowTemplates.supportTriage.name",
  "document-approval": "workflowTemplates.documentApproval.name",
  "data-enrichment": "workflowTemplates.dataEnrichment.name",
};

const DESCRIPTION_KEYS: Readonly<Record<string, string>> = {
  "hello-world": "workflowTemplates.helloWorld.description",
  "webhook-summarizer": "workflowTemplates.webhookSummarizer.description",
  "scheduled-report": "workflowTemplates.scheduledReport.description",
  "support-triage": "workflowTemplates.supportTriage.description",
  "document-approval": "workflowTemplates.documentApproval.description",
  "data-enrichment": "workflowTemplates.dataEnrichment.description",
};

/** Closed enum in the contract, so every value is known up front. */
const CATEGORY_KEYS: Readonly<Record<string, string>> = {
  starter: "workflowTemplates.category.starter",
  operations: "workflowTemplates.category.operations",
  support: "workflowTemplates.category.support",
  documents: "workflowTemplates.category.documents",
  data: "workflowTemplates.category.data",
};

export function templateNameLabel(
  t: Translate,
  id: string,
  fallback: string,
): string {
  const key = NAME_KEYS[id];
  return key ? t(key) : fallback;
}

export function templateDescriptionLabel(
  t: Translate,
  id: string,
  fallback: string,
): string {
  const key = DESCRIPTION_KEYS[id];
  return key ? t(key) : fallback;
}

export function templateCategoryLabel(t: Translate, category: string): string {
  const key = CATEGORY_KEYS[category];
  return key ? t(key) : category;
}
