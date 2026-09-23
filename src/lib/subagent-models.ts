import { getAllProviders } from './db';
import type { ChatRuntime } from './chat-runtime';
import type { CatalogModel } from './provider-catalog';
import { resolveProvider, type ResolvedProvider } from './provider-resolver';
import { getModelCompat, getProviderCompat } from './runtime-compat';
import { listManagedVirtualProviderModelGroups } from './managed-virtual-provider-models';

export interface SubagentModelOption {
  id: string;
  upstreamId?: string;
  displayName: string;
}

export interface SubagentRoute extends SubagentModelOption {
  providerId: string;
  providerName: string;
}

export type SubagentModelResolution =
  | { ok: true; model: string; requestedModel: string; displayName: string }
  | { ok: false; code: 'MODEL_REQUIRED' | 'MODEL_NOT_AVAILABLE'; requestedModel?: string };

/**
 * Build the exact Provider + Model routes CodePilot may use for a delegated
 * call in one Runtime. This mirrors the non-grey model picker contract:
 * enabled catalog rows are filtered by the canonical runtime compatibility
 * matrix, and an unavailable route is absent rather than silently replaced.
 */
export function listSubagentRoutes(runtime: Extract<ChatRuntime, 'codepilot_runtime' | 'codex_runtime'>): SubagentRoute[] {
  const candidates = [
    ...(runtime === 'codepilot_runtime'
      ? [{
          id: 'env',
          name: 'Environment',
          providerCompat: 'claude_code_ready' as const,
        }]
      : []),
    ...getAllProviders().map(provider => ({
      id: provider.id,
      name: provider.name,
      providerCompat: getProviderCompat(provider),
    })),
    ...listManagedVirtualProviderModelGroups().map(group => ({
      id: group.providerId,
      name: group.providerName,
      providerCompat: group.compat,
    })),
  ];
  const routes: SubagentRoute[] = [];

  for (const candidate of candidates) {
    let resolved: ResolvedProvider;
    try {
      resolved = resolveProvider({
        callScene: 'delegated_interactive',
        providerId: candidate.id,
        runtime,
      });
    } catch {
      continue;
    }

    const models = [...resolved.availableModels];
    appendMissingRoleModels(models, resolved);

    for (const model of models) {
      const compat = getModelCompat({
        providerBaseUrl: resolved.provider?.base_url,
        modelId: model.modelId,
        upstreamModelId: model.upstreamModelId,
        providerCompat: candidate.providerCompat,
        capabilities: model.capabilities,
      });
      if (compat.media || !compat.supportedRuntimes?.includes(runtime)) continue;
      routes.push({
        providerId: candidate.id,
        providerName: candidate.name,
        id: model.modelId,
        upstreamId: model.upstreamModelId,
        displayName: model.displayName || model.upstreamModelId || model.modelId,
      });
    }
  }

  return dedupeRoutes(routes);
}

export function findSubagentRoute(
  routes: readonly SubagentRoute[],
  providerId: unknown,
  modelId: unknown,
): SubagentRoute | undefined {
  if (typeof providerId !== 'string' || typeof modelId !== 'string') return undefined;
  return routes.find(route =>
    route.providerId === providerId
    && (route.id === modelId || route.upstreamId === modelId),
  );
}

/** Prefer a descriptive upstream id over protocol aliases such as `sonnet`. */
export function subagentRouteSelector(route: SubagentRoute): string {
  return route.upstreamId && route.upstreamId !== route.id ? route.upstreamId : route.id;
}

/**
 * Verify a Runtime-reported model against every identity that belongs to the
 * selected route. This is intentionally an exact (case-insensitive) identity
 * match: a Provider-side fallback must not be accepted merely because it
 * shares a vendor prefix with the requested model.
 */
export function reportedModelMatchesSubagentRoute(
  reportedModel: string | undefined,
  route: SubagentRoute,
): boolean {
  const reported = reportedModel?.trim().toLowerCase();
  if (!reported) return true;
  return new Set([
    route.id,
    route.upstreamId,
    route.displayName,
  ].filter((value): value is string => Boolean(value))
    .map(value => value.trim().toLowerCase()))
    .has(reported);
}

export function getSubagentRoutingGuidance(
  runtime: Extract<ChatRuntime, 'codepilot_runtime' | 'codex_runtime'>,
  routes: readonly SubagentRoute[],
): string {
  const label = runtime === 'codex_runtime' ? 'Codex Runtime' : 'CodePilot Runtime';
  const routeLines = routes.map(route =>
    `  - provider_id=${JSON.stringify(route.providerId)}, model=${JSON.stringify(subagentRouteSelector(route))}: ${route.displayName} (${route.providerName})`,
  );
  return [
    `${label} model-specific Sub Agent contract:`,
    '- A named-model child requires the exact provider_id + model pair from the route list below. These are catalog-compatible candidates, not proof of account entitlement.',
    '- Never substitute the parent model, sonnet/opus/haiku, or another Provider when the requested route is absent or fails.',
    '- Each call is a blocking one-shot foreground run. The tool returns only after that child reaches a terminal status; no background child remains running after the tool returns.',
    '- Treat terminal=true plus the returned status/body as the child result immediately. Never describe a returned call as merely submitted, launched, queued, still processing, or waiting for later monitoring.',
    '- For dependent children in one plan, use one workflow_id, a unique task_key per child, and depends_on upstream task keys. Emit/create upstream task calls before their dependents. CodePilot waits on durable terminal facts and injects upstream results before the downstream Runtime starts. You may instead wait for the prior tool result and include it directly, but undeclared placeholder/wait-only calls are rejected.',
    '- A first attempt omits logical_run_id. If the same logical task is retried, reuse the exact logicalRunId returned by the failed attempt; never reuse it for a different task. Attempts share one user-visible capsule and remain separately auditable.',
    '- If a child fails, times out, or lacks a required capability, stop dependent work, report the exact failure, and ask the user whether to retry, choose another route, or change Runtime.',
    ...(routeLines.length > 0 ? routeLines : ['  - (none)']),
  ].join('\n');
}

/**
 * Legacy same-provider helper retained for callers/tests outside the managed
 * route path. New delegation code must use listSubagentRoutes() so a named
 * cross-provider model is represented by an explicit route.
 */
export function getSameProviderSubagentModels(input: {
  providerId?: string;
  sessionProviderId?: string;
  parentModel?: string;
}): SubagentModelOption[] {
  try {
    const resolved = resolveProvider({
      callScene: 'delegated_interactive',
      providerId: input.providerId,
      sessionProviderId: input.sessionProviderId,
      model: input.parentModel,
      sessionModel: input.parentModel,
      runtime: 'codepilot_runtime',
    });
    const models = resolved.availableModels.map(toOption);
    if (input.parentModel && !models.some(model => matchesModel(model, input.parentModel!))) {
      models.unshift({
        id: input.parentModel,
        displayName: resolved.modelDisplayName || input.parentModel,
      });
    }
    return dedupeModels(models);
  } catch {
    return input.parentModel
      ? [{ id: input.parentModel, displayName: input.parentModel }]
      : [];
  }
}

export function resolveSameProviderSubagentModel(
  requestedModel: string | undefined,
  parentModel: string | undefined,
  availableModels: readonly SubagentModelOption[],
): SubagentModelResolution {
  const requested = requestedModel?.trim();
  const candidate = !requested || requested === 'inherit' ? parentModel?.trim() : requested;
  if (!candidate) return { ok: false, code: 'MODEL_REQUIRED', requestedModel: requested };

  const match = availableModels.find(model => matchesModel(model, candidate));
  if (!match) {
    return { ok: false, code: 'MODEL_NOT_AVAILABLE', requestedModel: candidate };
  }
  return {
    ok: true,
    model: match.id,
    requestedModel: requested || 'inherit',
    displayName: match.displayName,
  };
}

function appendMissingRoleModels(models: CatalogModel[], resolved: ResolvedProvider): void {
  for (const roleModel of Object.values(resolved.roleModels)) {
    if (!roleModel || models.some(model =>
      model.modelId === roleModel || model.upstreamModelId === roleModel)) continue;
    models.push({ modelId: roleModel, displayName: roleModel });
  }
}

function toOption(model: CatalogModel): SubagentModelOption {
  return {
    id: model.modelId,
    upstreamId: model.upstreamModelId,
    displayName: model.displayName,
  };
}

function matchesModel(model: SubagentModelOption, candidate: string): boolean {
  return model.id === candidate || model.upstreamId === candidate;
}

function dedupeModels(models: SubagentModelOption[]): SubagentModelOption[] {
  const seen = new Set<string>();
  return models.filter(model => {
    if (!model.id || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function dedupeRoutes(routes: SubagentRoute[]): SubagentRoute[] {
  const seen = new Set<string>();
  return routes.filter(route => {
    const key = `${route.providerId}\0${route.id}`;
    if (!route.id || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
