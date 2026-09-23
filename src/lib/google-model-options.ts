import type { LanguageModelMiddleware } from 'ai';

export const GEMINI_FLASH_MODEL = 'gemini-3.8-flash';

/** Exact Developer API contract; do not impose 3.8 restrictions on other models. */
export function googleThinkingOptions(model: string, effort?: string) {
  if (model !== GEMINI_FLASH_MODEL) return undefined;
  const thinkingLevel = effort === 'low' || effort === 'medium' || effort === 'high'
    ? effort : effort === 'max' || effort === 'xhigh' ? 'high' : 'medium';
  return { thinkingConfig: { thinkingLevel, includeThoughts: true } };
}

/** Covers auxiliary generateText calls as well as the interactive stream. */
export const geminiFlashMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  transformParams: async ({ params }) => {
    const google = params.providerOptions?.google ?? {};
    const thinking = google.thinkingConfig as Record<string, unknown> | undefined;
    const defaults = googleThinkingOptions(GEMINI_FLASH_MODEL,
      typeof thinking?.thinkingLevel === 'string' ? thinking.thinkingLevel : undefined)!;
    return {
      ...params,
      temperature: undefined, topP: undefined, topK: undefined,
      providerOptions: {
        ...params.providerOptions,
        google: { ...google, ...defaults },
      },
    };
  },
};
