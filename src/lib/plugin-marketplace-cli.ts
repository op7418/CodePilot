import type { SpawnOptionsWithoutStdio } from 'child_process';

import { findClaudeBinary, getExpandedPath, needsShell } from './platform';

export type PluginMarketplaceScope = 'user' | 'project' | 'local';
type PluginMarketplaceAction = 'install' | 'uninstall';

const SAFE_PLUGIN_PART = /^[A-Za-z0-9._-]+$/;
const VALID_SCOPES = new Set<PluginMarketplaceScope>(['user', 'project', 'local']);

export class PluginMarketplaceCliError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'PluginMarketplaceCliError';
  }
}

interface BuildPluginRefInput {
  name: string;
  marketplace?: string;
}

interface CreateSpawnSpecInput extends BuildPluginRefInput {
  action: PluginMarketplaceAction;
  scope?: PluginMarketplaceScope;
}

interface PluginMarketplaceCliDeps {
  findClaudeBinary: () => string | undefined;
  getExpandedPath: () => string;
  needsShell: (binPath: string) => boolean;
  env: Record<string, string | undefined>;
}

interface PluginSpawnSpec {
  command: string;
  args: string[];
  options: SpawnOptionsWithoutStdio & { env: NodeJS.ProcessEnv };
}

const defaultDeps: PluginMarketplaceCliDeps = {
  findClaudeBinary,
  getExpandedPath,
  needsShell,
  env: process.env,
};

function validateRequiredString(value: unknown, label: string): string {
  if (!value || typeof value !== 'string') {
    throw new PluginMarketplaceCliError(`${label} is required`, 400);
  }
  return value;
}

function validatePluginPart(value: string, label: string): string {
  if (!SAFE_PLUGIN_PART.test(value)) {
    throw new PluginMarketplaceCliError(`Invalid ${label}`, 400);
  }
  return value;
}

function validateScope(scope?: string): PluginMarketplaceScope | undefined {
  if (scope === undefined) return undefined;
  if (!VALID_SCOPES.has(scope as PluginMarketplaceScope)) {
    throw new PluginMarketplaceCliError('Invalid plugin scope', 400);
  }
  return scope as PluginMarketplaceScope;
}

function buildSpawnEnv(
  env: Record<string, string | undefined>,
  expandedPath: string
): NodeJS.ProcessEnv {
  const nextEnv = {} as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      nextEnv[key] = value;
    }
  }
  nextEnv.PATH = expandedPath;
  return nextEnv;
}

export function buildMarketplacePluginRef({
  name,
  marketplace,
}: BuildPluginRefInput): string {
  const safeName = validatePluginPart(validateRequiredString(name, 'plugin name'), 'plugin name');
  if (!marketplace) {
    return safeName;
  }
  const safeMarketplace = validatePluginPart(
    validateRequiredString(marketplace, 'marketplace name'),
    'marketplace name'
  );
  return `${safeName}@${safeMarketplace}`;
}

export function createMarketplacePluginSpawnSpec(
  input: CreateSpawnSpecInput,
  deps: PluginMarketplaceCliDeps = defaultDeps
): PluginSpawnSpec {
  const command = deps.findClaudeBinary();
  if (!command) {
    throw new PluginMarketplaceCliError('Claude CLI not found', 500);
  }

  const scope = validateScope(input.scope);
  const args =
    input.action === 'install'
      ? ['plugin', 'install', buildMarketplacePluginRef({ name: input.name, marketplace: input.marketplace })]
      : ['plugin', 'uninstall', buildMarketplacePluginRef({ name: input.name, marketplace: input.marketplace })];

  if (scope) {
    args.push('--scope', scope);
  }

  return {
    command,
    args,
    options: {
      env: buildSpawnEnv(deps.env, deps.getExpandedPath()),
      shell: deps.needsShell(command),
    },
  };
}
