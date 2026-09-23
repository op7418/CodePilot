import { isTokenDanceBaseUrl } from '../tokendance';
import { tokenDanceFetch } from '../tokendance-fetch';
/**
 * claude-code-compat-model.ts — LanguageModelV3 implementation for Claude Code-compatible proxies.
 *
 * Sends requests in the format that Claude Code proxy APIs expect
 * and translates Anthropic SSE responses into AI SDK stream parts.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamResult,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  LanguageModelV3FinishReason,
} from '@ai-sdk/provider';
import type { ClaudeCodeCompatConfig, AnthropicSSEEvent } from './types';
import { mapFinishReason } from './types';
import { buildHeaders, buildBody } from './request-builder';
import { parseSSEStream } from './sse-parser';

/**
 * Build the Messages API URL from a base URL.
 * Anthropic SDK appends `/messages` to baseURL. For proxy URLs that already
 * include a path (e.g. /api/anthropic), we insert /v1 before /messages.
 * For bare domains, we append /v1/messages.
 */
function buildMessagesUrl(baseUrl: string): string {
  const cleaned = baseUrl.replace(/\/+$/, '');
  // Already ends with /v1 → just append /messages
  if (cleaned.endsWith('/v1')) return `${cleaned}/messages`;
  // Has a deep path (e.g. /api/anthropic, /api/coding) → insert /v1/messages
  try {
    const pathname = new URL(cleaned).pathname;
    if (pathname !== '/' && pathname !== '') return `${cleaned}/v1/messages`;
  } catch { /* fall through */ }
  // Bare domain → /v1/messages
  return `${cleaned}/v1/messages`;
}

export class ClaudeCodeCompatModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const;
  readonly provider = 'claude-code-compat';
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private config: ClaudeCodeCompatConfig;

  constructor(config: ClaudeCodeCompatConfig) {
    this.config = config;
    this.modelId = config.modelId;
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const headers = buildHeaders(this.config);
    const body = buildBody(options, this.config);
    const url = buildMessagesUrl(this.config.baseUrl);

    const response = await (isTokenDanceBaseUrl(this.config.baseUrl) ? tokenDanceFetch : fetch)(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.abortSignal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(
        `Claude Code compat API error: ${response.status} ${response.statusText}\n${errorBody}`,
      );
    }

    if (!response.body) {
      throw new Error('No response body from Claude Code compat API');
    }

    // Some proxies return 200 + JSON error body instead of SSE stream
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json') && !contentType.includes('stream')) {
      const errorJson = await response.text().catch(() => '');
      throw new Error(`Proxy returned error: ${errorJson}`);
    }

    // State for tracking across SSE events
    let finishReason: LanguageModelV3FinishReason = { unified: 'other', raw: undefined };
    const usage: LanguageModelV3Usage = {
      inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 0, text: undefined, reasoning: undefined },
    };
    const activeBlocks = new Map<number, { type: string; id: string; name?: string; json?: string }>();

    const sseStream = parseSSEStream(response.body);
    let blockIdCounter = 0;

    // Create a ReadableStream that transforms Anthropic SSE → V3 StreamParts
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        try {
          for await (const event of sseStream) {
            const parts = mapEventToParts(event, activeBlocks, usage, blockIdCounter);
            blockIdCounter = parts.nextBlockId;

            if (event.type === 'message_delta') {
              finishReason = mapFinishReason(event.delta.stop_reason);
              if (event.usage) {
                usage.outputTokens.total = (usage.outputTokens.total || 0) + (event.usage.output_tokens || 0);
              }
            }

            for (const part of parts.parts) {
              controller.enqueue(part);
            }
          }

          // Always emit finish
          controller.enqueue({
            type: 'finish',
            finishReason,
            usage,
          });
        } catch (err) {
          controller.enqueue({
            type: 'error',
            error: err,
          });
        } finally {
          controller.close();
        }
      },
    });

    return {
      stream,
      request: { body },
      response: {
        headers: Object.fromEntries(response.headers.entries()),
      },
    };
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const headers = buildHeaders(this.config);
    const body = buildBody(options, this.config);
    body.stream = false;

    const url = buildMessagesUrl(this.config.baseUrl);

    const response = await (isTokenDanceBaseUrl(this.config.baseUrl) ? tokenDanceFetch : fetch)(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.abortSignal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(
        `Claude Code compat API error: ${response.status} ${response.statusText}\n${errorBody}`,
      );
    }

    const json = await response.json() as {
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    const content: LanguageModelV3GenerateResult['content'] = [];
    for (const block of json.content || []) {
      if (block.type === 'text' && block.text) {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use' && block.id && block.name) {
        content.push({
          type: 'tool-call',
          toolCallId: block.id,
          toolName: block.name,
          input: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
        });
      }
    }

    return {
      content,
      finishReason: mapFinishReason(json.stop_reason),
      usage: {
        inputTokens: { total: json.usage?.input_tokens || 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: json.usage?.output_tokens || 0, text: undefined, reasoning: undefined },
      },
      warnings: [],
      response: {
        headers: Object.fromEntries(response.headers.entries()),
      },
    };
  }
}

// ── SSE Event → V3 StreamPart mapping ───────────────────────────

interface MapResult {
  parts: LanguageModelV3StreamPart[];
  nextBlockId: number;
}

function mapEventToParts(
  event: AnthropicSSEEvent,
  activeBlocks: Map<number, { type: string; id: string; name?: string; json?: string }>,
  usage: LanguageModelV3Usage,
  blockIdCounter: number,
): MapResult {
  const parts: LanguageModelV3StreamPart[] = [];

  switch (event.type) {
    case 'message_start': {
      if (event.message.usage) {
        usage.inputTokens.total = event.message.usage.input_tokens || 0;
      }
      parts.push({ type: 'stream-start', warnings: [] });
      break;
    }

    case 'content_block_start': {
      const id = `block-${blockIdCounter++}`;
      const block = event.content_block;

      if (block.type === 'text') {
        activeBlocks.set(event.index, { type: 'text', id });
        parts.push({ type: 'text-start', id });
      } else if (block.type === 'thinking') {
        activeBlocks.set(event.index, { type: 'thinking', id });
        parts.push({ type: 'reasoning-start', id });
      } else if (block.type === 'tool_use') {
        activeBlocks.set(event.index, { type: 'tool_use', id: block.id, name: block.name, json: '' });
        parts.push({ type: 'tool-input-start', id: block.id, toolName: block.name });
      }
      break;
    }

    case 'content_block_delta': {
      const active = activeBlocks.get(event.index);
      if (!active) break;

      if (event.delta.type === 'text_delta' && active.type === 'text') {
        parts.push({ type: 'text-delta', id: active.id, delta: event.delta.text });
      } else if (event.delta.type === 'thinking_delta' && active.type === 'thinking') {
        parts.push({ type: 'reasoning-delta', id: active.id, delta: event.delta.thinking });
      } else if (event.delta.type === 'input_json_delta' && active.type === 'tool_use') {
        active.json = (active.json || '') + event.delta.partial_json;
        parts.push({ type: 'tool-input-delta', id: active.id, delta: event.delta.partial_json });
      }
      break;
    }

    case 'content_block_stop': {
      const active = activeBlocks.get(event.index);
      if (!active) break;

      if (active.type === 'text') {
        parts.push({ type: 'text-end', id: active.id });
      } else if (active.type === 'thinking') {
        parts.push({ type: 'reasoning-end', id: active.id });
      } else if (active.type === 'tool_use') {
        parts.push({ type: 'tool-input-end', id: active.id });
        // Emit the complete tool call
        let input: unknown;
        try { input = JSON.parse(active.json || '{}'); } catch { input = active.json || '{}'; }
        parts.push({
          type: 'tool-call',
          toolCallId: active.id,
          toolName: active.name || 'unknown',
          input: typeof input === 'string' ? input : JSON.stringify(input),
        });
      }

      activeBlocks.delete(event.index);
      break;
    }

    case 'message_delta': {
      // Usage and finish reason handled in the caller
      break;
    }

    case 'message_stop':
    case 'ping':
      break;

    case 'error': {
      parts.push({ type: 'error', error: new Error(event.error.message) });
      break;
    }
  }

  return { parts, nextBlockId: blockIdCounter };
}
