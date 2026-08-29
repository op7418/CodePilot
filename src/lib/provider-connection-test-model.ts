export function resolveConnectionTestModelName(
  defaultModelName: string,
  mappedSonnetModelName: string,
): string | undefined {
  return defaultModelName || mappedSonnetModelName || undefined;
}
