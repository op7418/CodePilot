/** xAI Responses provider-option mapping shared by Native and Codex proxy. */
export function mapXaiReasoningEffort(
  effort: string | undefined,
): 'none' | 'low' | 'medium' | 'high' | undefined {
  switch (effort) {
    case 'minimal':
      return 'none';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high';
    default:
      return undefined;
  }
}

export function buildXaiProviderOptions(effort?: string): {
  store: false;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
} {
  const reasoningEffort = mapXaiReasoningEffort(effort);
  return {
    // @ai-sdk/xai defaults Responses `store` to true. CodePilot sends the
    // complete conversation and does not use previousResponseId, so retaining
    // an upstream response adds no continuity benefit. This is an xAI-specific
    // data-minimisation decision, not inherited from the Codex/OpenAI endpoint.
    store: false,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}
