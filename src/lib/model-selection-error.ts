/** Stable markers survive the Native SSE and Codex proxy error envelopes. */
export const MODEL_SELECTION_ERRORS = {
  OPENAI_OAUTH_EFFORT_UNAVAILABLE: 'This OpenAI account no longer advertises the selected reasoning effort. Choose an available effort in the model selector and retry.',
  OPENAI_OAUTH_CATALOG_EMPTY: 'The OpenAI account model catalog is empty. Refresh the model list or sign in again, then select a model.',
} as const;

export class ModelSelectionError extends Error {
  constructor(public readonly code: keyof typeof MODEL_SELECTION_ERRORS) {
    super(`[${code}] ${MODEL_SELECTION_ERRORS[code]}`);
    this.name = 'ModelSelectionError';
  }
}
