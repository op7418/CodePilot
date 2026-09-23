import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, wrapLanguageModel } from 'ai';
import { GEMINI_FLASH_MODEL, geminiFlashMiddleware, googleThinkingOptions } from './google-model-options';
import type { ConnectionTestResult } from './claude-client';

export async function testGoogleConnection(config: {
  apiKey: string; baseUrl: string; modelName?: string;
}): Promise<ConnectionTestResult> {
  const modelId = config.modelName || GEMINI_FLASH_MODEL;
  const google = createGoogleGenerativeAI({ apiKey: config.apiKey, baseURL: config.baseUrl || undefined });
  const rawModel = google(modelId);
  try {
    const result = await generateText({
      model: modelId === GEMINI_FLASH_MODEL
        ? wrapLanguageModel({ model: rawModel, middleware: geminiFlashMiddleware }) : rawModel,
      prompt: 'Reply with OK.',
      providerOptions: { google: googleThinkingOptions(modelId, 'low') ?? {} },
      maxOutputTokens: 2048, maxRetries: 0, abortSignal: AbortSignal.timeout(30_000),
    });
    return result.text.trim()
      ? { success: true }
      : { success: false, error: { code: 'EMPTY_RESPONSE', message: 'Gemini returned no text.', suggestion: 'Check the selected text model and try again.' } };
  } catch (error) {
    const status = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    // Provider response bodies and arbitrary error messages may contain the key.
    return { success: false, error: {
      code: typeof status === 'number' ? `HTTP_${status}` : 'CONNECTION_FAILED',
      message: typeof status === 'number' ? `Gemini API returned HTTP ${status}.` : 'Could not reach the Gemini API.',
      suggestion: 'Check the AI Studio API key, model access, quota and network connection.',
    } };
  }
}
