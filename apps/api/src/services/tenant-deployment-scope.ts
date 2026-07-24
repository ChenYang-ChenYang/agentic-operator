/**
 * Process-level ownership boundary for tenant Inngest apps.
 *
 * The database flag says whether an operator wants a tenant deployed. The
 * optional AGENTIC_ENABLED_TENANTS allow-list says which API process is
 * allowed to host it. A UI mutation may change desired state only inside this
 * process boundary; this prevents one shard from taking over another shard's
 * tenant app.
 */

export function enabledTenantDeploymentScope(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> | null {
  const raw = env.AGENTIC_ENABLED_TENANTS?.trim();
  if (!raw) return null;
  const slugs = raw
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);
  return slugs.length > 0 ? new Set(slugs) : null;
}

export function isTenantInProcessDeploymentScope(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const scope = enabledTenantDeploymentScope(env);
  return scope === null || scope.has(slug);
}
