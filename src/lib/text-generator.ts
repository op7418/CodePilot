import { streamText } from 'ai';
import { createModel } from './ai-provider';
import type { ResolvedProvider } from './provider-resolver';
import { assertProviderCallAllowed, type ProviderCallScene } from './provider-call-policy';

export interface StreamTextParams {
  callScene: ProviderCallScene;
  providerId: string;
  /** Exact provider snapshot supplied by fail-closed background calls. */
  resolvedProvider?: ResolvedProvider;
  model: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

/**
 * Stream text from the user's current provider.
 * Returns an async iterable of text chunks.
 *
 * Provider resolution is fully delegated to ai-provider.ts → provider-resolver.ts.
 * No fallback logic here — the resolver's chain (explicit → session → global default → env)
 * is the single source of truth.
 *
 * NOTE: Do NOT expand model aliases (sonnet/opus/haiku) here.
 * toAiSdkConfig() resolves model IDs through the provider's availableModels catalog,
 * which uses the short alias as modelId. Expanding aliases would break that lookup
 * for SDK proxy providers (Kimi, GLM, MiniMax, etc.) that expect short aliases.
 */
/**
 * Pump a fullStream: yield text deltas, THROW on error parts.
 *
 * ai@7 的 `textStream` 对 error part 静默收尾（不抛）——上游 4xx/5xx 会变成
 * "空文本"，调用方只能报出误导性的下游错误（tech-debt #53 实测：ClinePass
 * 400 invalid model format 被伪装成 "Failed to extract plan JSON"）。走
 * fullStream 并把 error part 转成异常，错误语义才是真实的。
 * Exported for unit testing.
 */
export async function* pumpTextStream(
  fullStream: AsyncIterable<{ type: string; text?: string; error?: unknown }>,
): AsyncIterable<string> {
  for await (const part of fullStream) {
    if (part.type === 'text-delta' && typeof part.text === 'string') {
      yield part.text;
    } else if (part.type === 'error') {
      const er = part.error as { message?: string; responseBody?: string } | undefined;
      const body = typeof er?.responseBody === 'string' ? ` — upstream: ${er.responseBody.slice(0, 300)}` : '';
      throw new Error(`${er?.message || String(part.error)}${body}`);
    }
  }
}

export async function* streamTextFromProvider(params: StreamTextParams): AsyncIterable<string> {
  assertProviderCallAllowed(params.resolvedProvider?.provider, params.callScene);
  const { languageModel } = createModel({
    callScene: params.callScene,
    providerId: params.providerId,
    resolvedProvider: params.resolvedProvider,
    model: params.model,
  });

  const result = streamText({
    model: languageModel,
    // ai@7: `system` is a deprecated alias of `instructions` (wire-identical).
    instructions: params.system,
    prompt: params.prompt,
    maxOutputTokens: params.maxTokens || 4096,
    abortSignal: params.abortSignal || AbortSignal.timeout(120_000),
  });

  yield* pumpTextStream(result.fullStream as AsyncIterable<{ type: string; text?: string; error?: unknown }>);
}

/**
 * Generate complete text (non-streaming) from the user's current provider.
 * Useful when you need the full response as a string.
 */
export async function generateTextFromProvider(params: StreamTextParams): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of streamTextFromProvider(params)) {
    chunks.push(chunk);
  }
  return chunks.join('');
}
