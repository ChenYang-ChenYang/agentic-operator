/**
 * Reasoning is a standalone workspace, not an Agent Factory capability.
 * Its route must stay inside the currently selected Business Domain so the
 * workspace, context queries, and runs all keep the same tenant boundary.
 */
export function reasoningWorkspaceTenant(currentTenant: string): string {
  return currentTenant;
}

export function reasoningAgentHref(currentTenant: string): string {
  return `/portal/${reasoningWorkspaceTenant(currentTenant)}/reasoning-agent`;
}
