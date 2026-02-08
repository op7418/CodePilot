/**
 * OpenRouter-compatible streaming client.
 * Uses undici fetch with proxy support + OpenAI-compatible chat completions API.
 * Outputs the same SSE event format as claude-client.ts so the frontend works unchanged.
 */
import type { SSEEvent, TokenUsage } from '@/types';
import { getSetting } from './db';
import { getMessages } from './db';
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';

export interface OpenRouterStreamOptions {
  prompt: string;
  sessionId: string;
  model?: string;
  systemPrompt?: string;
  abortController?: AbortController;
}

function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Get proxy dispatcher if http_proxy / https_proxy is set
 */
function getProxyDispatcher(): Dispatcher | undefined {
  const proxyUrl =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY;
  if (proxyUrl) {
    return new ProxyAgent(proxyUrl);
  }
  return undefined;
}

/**
 * Stream chat responses via OpenRouter (OpenAI-compatible API).
 * Returns a ReadableStream of SSE-formatted strings matching the existing protocol.
 */
export function streamOpenRouter(options: OpenRouterStreamOptions): ReadableStream<string> {
  const { sessionId, model, systemPrompt, abortController } = options;

  return new ReadableStream<string>({
    async start(controller) {
      try {
        // Resolve API key: app setting > env var
        const apiKey =
          getSetting('openrouter_api_key') ||
          process.env.OPENROUTER_API_KEY ||
          '';
        // Resolve base URL: app setting > env var > default
        const baseURL =
          getSetting('openrouter_base_url') ||
          process.env.OPENROUTER_BASE_URL ||
          'https://openrouter.ai/api/v1';
        // Resolve default model: app setting > env var > fallback
        const defaultModel =
          getSetting('openrouter_model') ||
          process.env.ANTHROPIC_MODEL ||
          'anthropic/claude-sonnet-4';

        if (!apiKey) {
          controller.enqueue(formatSSE({
            type: 'error',
            data: 'OpenRouter API key not configured. Please set it in Settings → API Configuration.',
          }));
          controller.enqueue(formatSSE({ type: 'done', data: '' }));
          controller.close();
          return;
        }

        const effectiveModel = model || defaultModel;

        // Build conversation history from database
        const previousMessages = getMessages(sessionId);
        const messages: Array<{ role: string; content: string }> = [];

        if (systemPrompt) {
          messages.push({ role: 'system', content: systemPrompt });
        }

        for (const msg of previousMessages) {
          messages.push({
            role: msg.role,
            content: msg.content,
          });
        }

        // The current user message is already saved to DB before streaming,
        // so it's included in previousMessages. No need to add again.

        // Send init status event
        controller.enqueue(formatSSE({
          type: 'status',
          data: JSON.stringify({
            model: effectiveModel,
            provider: 'openrouter',
          }),
        }));

        // Make streaming request to OpenRouter (with proxy support)
        const apiURL = baseURL.replace(/\/+$/, '') + '/chat/completions';
        const dispatcher = getProxyDispatcher();

        const fetchOptions: Parameters<typeof undiciFetch>[1] = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://github.com/op7418/CodePilot',
            'X-Title': 'CodePilot',
          },
          body: JSON.stringify({
            model: effectiveModel,
            messages,
            stream: true,
          }),
          signal: abortController?.signal as never,
        };

        if (dispatcher) {
          fetchOptions.dispatcher = dispatcher;
        }

        const response = await undiciFetch(apiURL, fetchOptions);

        if (!response.ok) {
          const errorBody = await response.text();
          let errorMessage: string;
          try {
            const parsed = JSON.parse(errorBody);
            errorMessage = parsed.error?.message || parsed.error || errorBody;
          } catch {
            errorMessage = errorBody;
          }
          controller.enqueue(formatSSE({
            type: 'error',
            data: `OpenRouter API error (${response.status}): ${errorMessage}`,
          }));
          controller.enqueue(formatSSE({ type: 'done', data: '' }));
          controller.close();
          return;
        }

        if (!response.body) {
          controller.enqueue(formatSSE({ type: 'error', data: 'No response body from OpenRouter' }));
          controller.enqueue(formatSSE({ type: 'done', data: '' }));
          controller.close();
          return;
        }

        // Parse the SSE stream from OpenRouter
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        while (true) {
          if (abortController?.signal.aborted) break;

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          // Keep the last potentially incomplete line
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;

            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;

            try {
              const chunk = JSON.parse(data);

              // Extract text delta
              const delta = chunk.choices?.[0]?.delta;
              if (delta?.content) {
                controller.enqueue(formatSSE({ type: 'text', data: delta.content }));
              }

              // Extract usage info (some providers include it in the final chunk)
              if (chunk.usage) {
                totalInputTokens = chunk.usage.prompt_tokens || 0;
                totalOutputTokens = chunk.usage.completion_tokens || 0;
              }
            } catch {
              // Skip malformed chunks
            }
          }
        }

        // Send result with token usage
        const tokenUsage: TokenUsage = {
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
        };

        controller.enqueue(formatSSE({
          type: 'result',
          data: JSON.stringify({
            subtype: 'success',
            is_error: false,
            usage: tokenUsage,
          }),
        }));

        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        controller.enqueue(formatSSE({ type: 'error', data: errorMessage }));
        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
      }
    },

    cancel() {
      abortController?.abort();
    },
  });
}
