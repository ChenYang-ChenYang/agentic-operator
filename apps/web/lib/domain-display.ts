"use client";

export interface AgentFactoryDomain {
  id: string;
  name?: string | null;
  source?: "allmeta" | "upload" | "manifest";
  counts?: {
    actions?: number;
    events?: number;
    objects?: number;
    rules?: number;
    workflow?: number;
  };
}

export interface RuntimeDomainLike {
  slug: string;
  name: string;
  productKind?: "business_domain" | "runtime_namespace";
  archivedAt?: number | null;
  agentCount?: number | null;
}

export function domainLabel(domain: AgentFactoryDomain): string {
  return domain.name?.trim() || domain.id;
}

export function isInternalRuntimeDomain(slug: string): boolean {
  const s = slug.toLowerCase();
  return s === "__system" || s === "system" || s.endsWith("-sb");
}

export function isVisibleRuntimeDomain(domain: RuntimeDomainLike): boolean {
  const slug = domain.slug.toLowerCase();
  if (isInternalRuntimeDomain(slug)) return false;
  if (domain.productKind === "runtime_namespace") return false;
  // An unclassified/new tenant remains a visible Business Domain even before
  // it has Agents or Ontology registrations. Only an explicit persisted
  // runtime-namespace marker removes it from product navigation.
  return true;
}
