import type { CliProvider } from './cli-maintenance-contract';

export function remainingCliUpdateEntries<T extends { provider: CliProvider }>(
  entries: readonly T[],
  completedProviders: ReadonlySet<CliProvider>,
): T[] {
  return entries.filter((entry) => !completedProviders.has(entry.provider));
}
