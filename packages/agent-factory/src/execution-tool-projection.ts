import {
  deriveIntegrationRequirements,
  resolveIntegrationBindings,
  type IntegrationBindingReport,
  type IntegrationCapabilityProvider,
} from "./integration-binding";
import { analyzeExecutionPlanRequirement } from "./ontology-execution";
import type { OntologyAction } from "./ontology-types";
import type { RealTool } from "./tool-catalog";

/**
 * Tool symbols written into an Ontology are source declarations, not proof
 * that the current tenant can dispatch those names. Keep this extraction
 * separate from the executable registry so callers cannot accidentally label
 * historical/source-only symbols as "available tools".
 */
export function ontologyDeclaredExecutionTools(
  action: OntologyAction,
): string[] {
  const stepTools = analyzeExecutionPlanRequirement(action)
    .ontologySteps.map((step) => step.tool)
    .filter((name): name is string => Boolean(name));
  const integration =
    action.integration &&
    typeof action.integration === "object" &&
    !Array.isArray(action.integration)
      ? (action.integration as Record<string, unknown>)
      : {};
  const integrationTools = Array.isArray(integration.systems)
    ? integration.systems.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return [];
        }
        const row = entry as Record<string, unknown>;
        const name = String(
          row.via_tool ?? row.viaTool ?? row.tool ?? "",
        ).trim();
        return name ? [name] : [];
      })
    : [];
  return [...new Set([...stepTools, ...integrationTools])];
}

/** Resolve only an exact registry name or one unique registered alias. */
export function canonicalRegisteredToolName(
  name: string,
  registry: readonly RealTool[],
): string | null {
  const exact = [
    ...new Set(
      registry.filter((tool) => tool.name === name).map((tool) => tool.name),
    ),
  ];
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  const aliases = [
    ...new Set(
      registry
        .filter((tool) => (tool.aliases ?? []).includes(name))
        .map((tool) => tool.name),
    ),
  ];
  return aliases.length === 1 ? aliases[0]! : null;
}

export function integrationBackedToolSubstitution(input: {
  action: OntologyAction;
  bindings: IntegrationBindingReport["bindings"];
}): {
  allowed: boolean;
  identityGaps: IntegrationBindingReport["bindings"];
} {
  const requirements = deriveIntegrationRequirements(input.action);
  const identityGaps = input.bindings.filter(
    (binding) =>
      binding.selectionRequired === true ||
      (binding.status === "missing" &&
        !binding.bindingId &&
        !binding.toolName &&
        !binding.requirement.authoringOptional),
  );
  return {
    // A source adapter name can be projected only when the structured
    // integration contract proves every non-optional execution identity.
    allowed:
      requirements.length > 0 &&
      input.bindings.length > 0 &&
      identityGaps.length === 0 &&
      input.bindings.every(
        (binding) =>
          Boolean(binding.bindingId || binding.toolName) ||
          binding.status === "human_boundary" ||
          Boolean(binding.requirement.authoringOptional),
      ),
    identityGaps,
  };
}

/**
 * Build an exact source-name -> executable-name projection from the final
 * bounded integration report.
 *
 * A registry name/alias is always canonicalized. An unregistered source name
 * is projected only through an explicit via_tool binding or a complete,
 * order-proven one-to-one tool-boundary sequence. A fuzzy/ranked candidate is
 * never enough.
 */
export function finalExecutionToolProjection(input: {
  action: OntologyAction;
  bindings: IntegrationBindingReport["bindings"];
  registry: readonly RealTool[];
  substitutionAllowed: boolean;
}): ReadonlyMap<string, string> {
  const projected = new Map<string, string>();
  const ambiguous = new Set<string>();
  const add = (raw: string, target: string): void => {
    if (!raw || !target || ambiguous.has(raw)) return;
    const existing = projected.get(raw);
    if (existing && existing !== target) {
      projected.delete(raw);
      ambiguous.add(raw);
      return;
    }
    projected.set(raw, target);
  };

  for (const raw of ontologyDeclaredExecutionTools(input.action)) {
    const registered = canonicalRegisteredToolName(raw, input.registry);
    if (registered) add(raw, registered);
  }
  if (!input.substitutionAllowed) return projected;

  const integration =
    input.action.integration &&
    typeof input.action.integration === "object" &&
    !Array.isArray(input.action.integration)
      ? (input.action.integration as Record<string, unknown>)
      : {};
  const systems = Array.isArray(integration.systems) ? integration.systems : [];
  for (let index = 0; index < systems.length; index++) {
    const system = systems[index];
    if (!system || typeof system !== "object" || Array.isArray(system)) {
      continue;
    }
    const row = system as Record<string, unknown>;
    const raw = String(row.via_tool ?? row.viaTool ?? row.tool ?? "").trim();
    const binding = input.bindings[index];
    if (
      raw &&
      binding?.bindingKind !== "runtime" &&
      binding?.bindingKind !== "event" &&
      binding?.toolName &&
      binding.selectionRequired !== true
    ) {
      add(raw, binding.toolName);
    }
  }

  let toolSteps = (input.action.action_steps ?? [])
    .map((step, sourceIndex) => ({
      raw: String(step.tool ?? "").trim(),
      sourceIndex,
      order: Number(step.order),
    }))
    .filter((step) => Boolean(step.raw));
  let toolBindings = input.bindings
    .map((binding, sourceIndex) => ({
      binding,
      sourceIndex,
      callOrder: Number(
        systems[sourceIndex] &&
          typeof systems[sourceIndex] === "object" &&
          !Array.isArray(systems[sourceIndex])
          ? ((systems[sourceIndex] as Record<string, unknown>).call_order ??
              (systems[sourceIndex] as Record<string, unknown>).callOrder)
          : Number.NaN,
      ),
    }))
    .filter(
      ({ binding }) =>
        binding.requirement.replayable &&
        binding.bindingKind !== "runtime" &&
        binding.bindingKind !== "event" &&
        Boolean(binding.toolName) &&
        binding.selectionRequired !== true,
    );
  if (toolSteps.length === 0 || toolSteps.length !== toolBindings.length) {
    return projected;
  }
  // Array position alone is not authority when more than one boundary exists.
  if (toolSteps.length > 1) {
    const stepOrders = toolSteps.map((step) => step.order);
    const callOrders = toolBindings.map((row) => row.callOrder);
    if (
      stepOrders.some((order) => !Number.isInteger(order) || order < 0) ||
      callOrders.some((order) => !Number.isInteger(order) || order < 1) ||
      new Set(stepOrders).size !== toolSteps.length ||
      new Set(callOrders).size !== toolBindings.length
    ) {
      return projected;
    }
    toolSteps = [...toolSteps].sort(
      (left, right) =>
        left.order - right.order || left.sourceIndex - right.sourceIndex,
    );
    toolBindings = [...toolBindings].sort(
      (left, right) =>
        left.callOrder - right.callOrder ||
        left.sourceIndex - right.sourceIndex,
    );
  }
  const anchorsAgree = toolSteps.every((step, index) => {
    const target = toolBindings[index]?.binding.toolName;
    if (!target) return false;
    const registered = canonicalRegisteredToolName(step.raw, input.registry);
    if (registered && registered !== target) return false;
    const alreadyProjected = projected.get(step.raw);
    return !alreadyProjected || alreadyProjected === target;
  });
  if (!anchorsAgree) return projected;
  for (let index = 0; index < toolSteps.length; index++) {
    add(toolSteps[index]!.raw, toolBindings[index]!.binding.toolName!);
  }
  return projected;
}

export interface BoundedExecutionToolProjection {
  discovery: IntegrationBindingReport;
  finalBinding: IntegrationBindingReport;
  substitution: ReturnType<typeof integrationBackedToolSubstitution>;
  projection: ReadonlyMap<string, string>;
  sourceDeclarations: string[];
}

export type OntologyToolSourceDeclarationStatus =
  | "registered"
  | "registry_alias"
  | "integration_projected"
  | "source_only_unresolved";

export interface OntologyToolSourceDeclaration {
  action: string;
  symbol: string;
  declared_by: Array<"action_steps" | "integration" | "tool_use">;
  status: OntologyToolSourceDeclarationStatus;
  canonical_tool: string | null;
  available: boolean;
}

/**
 * Resolve once broadly for discovery, then resolve again against the bounded
 * set made of exact registered declarations plus already-unique discovered
 * transports. This is the shared authoring truth used by readiness and action
 * briefs; the broad ranking result alone must never rewrite an exact symbol.
 */
export function resolveBoundedExecutionToolProjection(input: {
  action: OntologyAction;
  registry: readonly RealTool[];
  capabilityProviders?: IntegrationCapabilityProvider[];
  systemAliasGroups?: readonly (readonly string[])[];
  additionalBoundToolNames?: readonly string[];
}): BoundedExecutionToolProjection {
  const registry = [...input.registry];
  const sourceDeclarations = [
    ...new Set([
      ...ontologyDeclaredExecutionTools(input.action),
      ...(input.action.tool_use ?? [])
        .map(String)
        .map((value) => value.trim())
        .filter(Boolean),
    ]),
  ];
  const bindingOptions = {
    capabilityProviders: input.capabilityProviders,
    systemAliasGroups: input.systemAliasGroups,
  };
  const discovery = resolveIntegrationBindings(
    input.action,
    registry,
    bindingOptions,
  );
  const uniqueDiscoveredTools = discovery.bindings
    .filter((binding) => !binding.selectionRequired)
    .map(
      (binding) =>
        binding.toolName ??
        (binding.bindingKind === "tool" ? binding.bindingId : undefined),
    )
    .filter((name): name is string => Boolean(name));
  const exactRegisteredTools = sourceDeclarations
    .map((name) => canonicalRegisteredToolName(name, registry))
    .filter((name): name is string => Boolean(name));
  const boundToolNames = [
    ...new Set([
      ...exactRegisteredTools,
      ...uniqueDiscoveredTools,
      ...(input.additionalBoundToolNames ?? []),
    ]),
  ];
  const finalBinding = resolveIntegrationBindings(input.action, registry, {
    ...bindingOptions,
    ...(boundToolNames.length ? { boundToolNames } : {}),
  });
  const substitution = integrationBackedToolSubstitution({
    action: input.action,
    bindings: finalBinding.bindings,
  });
  return {
    discovery,
    finalBinding,
    substitution,
    projection: finalExecutionToolProjection({
      action: input.action,
      bindings: finalBinding.bindings,
      registry,
      substitutionAllowed: substitution.allowed,
    }),
    sourceDeclarations,
  };
}

/** Render source declarations against the same bounded projection used by
 * authoring readiness. This is metadata only; it never expands the executable
 * registry catalog. */
export function describeOntologyToolSourceDeclarations(input: {
  action: OntologyAction;
  registry: readonly RealTool[];
  capabilityProviders?: IntegrationCapabilityProvider[];
  systemAliasGroups?: readonly (readonly string[])[];
}): OntologyToolSourceDeclaration[] {
  const bounded = resolveBoundedExecutionToolProjection(input);
  const stepSymbols = new Set(
    (input.action.action_steps ?? []).flatMap((step) => {
      const symbol = String(step.tool ?? "").trim();
      return symbol ? [symbol] : [];
    }),
  );
  const integration =
    input.action.integration &&
    typeof input.action.integration === "object" &&
    !Array.isArray(input.action.integration)
      ? (input.action.integration as Record<string, unknown>)
      : {};
  const integrationSymbols = new Set(
    (Array.isArray(integration.systems) ? integration.systems : []).flatMap(
      (system) => {
        if (!system || typeof system !== "object" || Array.isArray(system)) {
          return [];
        }
        const row = system as Record<string, unknown>;
        const symbol = String(
          row.via_tool ?? row.viaTool ?? row.tool ?? "",
        ).trim();
        return symbol ? [symbol] : [];
      },
    ),
  );
  const toolUseSymbols = new Set(
    (input.action.tool_use ?? []).map(String).map((value) => value.trim()),
  );
  const availableTools = new Set(input.registry.map((tool) => tool.name));
  return bounded.sourceDeclarations.map((symbol) => {
    const registered = canonicalRegisteredToolName(symbol, input.registry);
    const projected = bounded.projection.get(symbol);
    const canonicalTool = registered ?? projected ?? null;
    return {
      action: input.action.name,
      symbol,
      declared_by: [
        ...(stepSymbols.has(symbol) ? (["action_steps"] as const) : []),
        ...(integrationSymbols.has(symbol) ? (["integration"] as const) : []),
        ...(toolUseSymbols.has(symbol) ? (["tool_use"] as const) : []),
      ],
      status: registered
        ? registered === symbol
          ? "registered"
          : "registry_alias"
        : projected
          ? "integration_projected"
          : "source_only_unresolved",
      canonical_tool: canonicalTool,
      available: Boolean(canonicalTool && availableTools.has(canonicalTool)),
    };
  });
}
