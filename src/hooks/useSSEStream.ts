import { useRef, useCallback } from 'react';
import type { SSEEvent, TokenUsage, PermissionRequestEvent, MediaBlock } from '@/types';

interface ToolUseInfo {
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultInfo {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  media?: MediaBlock[];
}

export interface SSECallbacks {
  onText: (accumulated: string) => void;
  onToolUse: (tool: ToolUseInfo) => void;
  onToolResult: (result: ToolResultInfo) => void;
  onToolOutput: (data: string) => void;
  onToolProgress: (toolName: string, elapsedSeconds: number) => void;
  onStatus: (text: string | undefined) => void;
  onResult: (usage: TokenUsage | null) => void;
  onPermissionRequest: (data: PermissionRequestEvent) => void;
  onToolTimeout: (toolName: string, elapsedSeconds: number) => void;
  onModeChanged: (mode: string) => void;
  onTaskUpdate: (sessionId: string) => void;
  onRewindPoint: (sdkUserMessageId: string) => void;
  onThinking?: (delta: string) => void;
  onKeepAlive: () => void;
  onError: (accumulated: string) => void;
  onInitMeta?: (meta: {
    tools?: unknown;
    slash_commands?: unknown;
    skills?: unknown;
    plugins?: Array<{ name: string; path: string }>;
    mcp_servers?: unknown;
    output_style?: string;
  }) => void;
}

/**
 * Parse a single SSE line (after stripping "data: " prefix) and dispatch
 * to the appropriate callback.  Returns the updated accumulated text.
 */
function handleSSEEvent(
  event: SSEEvent,
  accumulated: string,
  callbacks: SSECallbacks,
): string {
  switch (event.type) {
    case 'text': {
      const next = accumulated + event.data;
      callbacks.onText(next);
      return next;
    }

    case 'thinking': {
      callbacks.onThinking?.(event.data);
      return accumulated;
    }

    case 'tool_use': {
      try {
        const toolData = JSON.parse(event.data);
        callbacks.onToolUse({
          id: toolData.id,
          name: toolData.name,
          input: toolData.input,
        });
      } catch {
        // skip malformed tool_use data
      }
      return accumulated;
    }

    case 'tool_result': {
      try {
        const resultData = JSON.parse(event.data);
        callbacks.onToolResult({
          tool_use_id: resultData.tool_use_id,
          content: resultData.content,
          ...(resultData.is_error ? { is_error: true } : {}),
          ...(Array.isArray(resultData.media) && resultData.media.length > 0
            ? { media: resultData.media }
            : {}),
        });
      } catch {
        // skip malformed tool_result data
      }
      return accumulated;
    }

    case 'tool_output': {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed._progress) {
          callbacks.onToolProgress(parsed.tool_name, Math.round(parsed.elapsed_time_seconds));
          return accumulated;
        }
      } catch {
        // Not JSON - raw stderr output, fall through
      }
      callbacks.onToolOutput(event.data);
      return accumulated;
    }

    case 'status': {
      try {
        const statusData = JSON.parse(event.data);
        // Skip internal-only status events (e.g. resume fallback notifications)
        if (statusData._internal) {
          return accumulated;
        }
        if (statusData.session_id) {
          callbacks.onStatus(`Connected (${statusData.requested_model || statusData.model || 'claude'})`);
          callbacks.onInitMeta?.({
            tools: statusData.tools,
            slash_commands: statusData.slash_commands,
            skills: statusData.skills,
            plugins: statusData.plugins,
            mcp_servers: statusData.mcp_servers,
            output_style: statusData.output_style,
          });
        } else if (statusData.notification) {
          callbacks.onStatus(statusData.message || statusData.title || undefined);
        } else {
          callbacks.onStatus(typeof event.data === 'string' ? event.data : undefined);
        }
      } catch {
        callbacks.onStatus(event.data || undefined);
      }
      return accumulated;
    }

    case 'result': {
      try {
        const resultData = JSON.parse(event.data);
        callbacks.onResult(resultData.usage || null);
      } catch {
        callbacks.onResult(null);
      }
      callbacks.onStatus(undefined);
      return accumulated;
    }

    case 'permission_request': {
      try {
        const permData: PermissionRequestEvent = JSON.parse(event.data);
        callbacks.onPermissionRequest(permData);
      } catch {
        // skip malformed permission_request data
      }
      return accumulated;
    }

    case 'tool_timeout': {
      try {
        const timeoutData = JSON.parse(event.data);
        callbacks.onToolTimeout(timeoutData.tool_name, timeoutData.elapsed_seconds);
      } catch {
        // skip malformed timeout data
      }
      return accumulated;
    }

    case 'mode_changed': {
      callbacks.onModeChanged(event.data);
      return accumulated;
    }

    case 'task_update': {
      try {
        const taskData = JSON.parse(event.data);
        callbacks.onTaskUpdate(taskData.session_id);
      } catch {
        // skip malformed task_update data
      }
      return accumulated;
    }

    case 'rewind_point': {
      try {
        const rpData = JSON.parse(event.data);
        if (rpData.userMessageId) {
          callbacks.onRewindPoint(rpData.userMessageId);
        }
      } catch {
        // skip malformed rewind_point data
      }
      return accumulated;
    }

    case 'keep_alive': {
      callbacks.onKeepAlive();
      return accumulated;
    }

    case 'error': {
      // Try to parse structured error JSON from error-classifier
      let errorDisplay: string;
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.category && parsed.userMessage) {
          // Structured error from classifier
          errorDisplay = parsed.userMessage;
          if (parsed.actionHint) {
            errorDisplay += `\n\n**What to do:** ${parsed.actionHint}`;
          }
          if (parsed.details) {
            errorDisplay += `\n\nDetails: ${parsed.details}`;
          }
          // Add diagnostic guidance for provider/auth related errors
          const diagCategories = new Set([
            'AUTH_REJECTED', 'AUTH_FORBIDDEN', 'AUTH_STYLE_MISMATCH',
            'NO_CREDENTIALS', 'PROVIDER_NOT_APPLIED', 'MODEL_NOT_AVAILABLE',
            'NETWORK_UNREACHABLE', 'ENDPOINT_NOT_FOUND', 'PROCESS_CRASH',
            'CLI_NOT_FOUND', 'UNSUPPORTED_FEATURE',
          ]);
          if (diagCategories.has(parsed.category)) {
            errorDisplay += '\n\n💡 [Run Provider Diagnostics](/settings#providers) to troubleshoot, or check the [Provider Setup Guide](https://www.codepilot.sh/docs/providers).';
          }
        } else {
          errorDisplay = event.data;
        }
      } catch {
        // Plain text error (backward compatible)
        errorDisplay = event.data;
      }
      const next = accumulated + '\n\n**Error:** ' + errorDisplay;
      callbacks.onError(next);
      return next;
    }

    case 'done': {
      return accumulated;
    }

    default:
      return accumulated;
  }
}

/**
 * Reads an SSE response body and dispatches parsed events through callbacks.
 * Returns the final accumulated text and token usage.
 */
export async function consumeSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  callbacks: SSECallbacks,
): Promise<{ accumulated: string; tokenUsage: TokenUsage | null }> {
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let tokenUsage: TokenUsage | null = null;

  const wrappedCallbacks: SSECallbacks = {
    ...callbacks,
    onResult: (usage) => {
      tokenUsage = usage;
      callbacks.onResult(usage);
    },
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;

      try {
        const event: SSEEvent = JSON.parse(line.slice(6));
        accumulated = handleSSEEvent(event, accumulated, wrappedCallbacks);
      } catch {
        // skip malformed SSE lines
      }
    }
  }

  return { accumulated, tokenUsage };
}

/**
 * Hook that provides a stable consumeSSEStream function bound to the latest
 * callbacks via a ref, avoiding stale closures.
 */
export function useSSEStream() {
  const callbacksRef = useRef<SSECallbacks | null>(null);

  const processStream = useCallback(
    async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      callbacks: SSECallbacks,
    ) => {
      callbacksRef.current = callbacks;

      // Proxy through ref so callers always hit the latest callbacks
      const proxied: SSECallbacks = {
        onText: (a) => callbacksRef.current?.onText(a),
        onToolUse: (t) => callbacksRef.current?.onToolUse(t),
        onToolResult: (r) => callbacksRef.current?.onToolResult(r),
        onToolOutput: (d) => callbacksRef.current?.onToolOutput(d),
        onToolProgress: (n, s) => callbacksRef.current?.onToolProgress(n, s),
        onStatus: (t) => callbacksRef.current?.onStatus(t),
        onResult: (u) => callbacksRef.current?.onResult(u),
        onPermissionRequest: (d) => callbacksRef.current?.onPermissionRequest(d),
        onToolTimeout: (n, s) => callbacksRef.current?.onToolTimeout(n, s),
        onModeChanged: (m) => callbacksRef.current?.onModeChanged(m),
        onTaskUpdate: (s) => callbacksRef.current?.onTaskUpdate(s),
        onRewindPoint: (id) => callbacksRef.current?.onRewindPoint(id),
        onThinking: (d) => callbacksRef.current?.onThinking?.(d),
        onKeepAlive: () => callbacksRef.current?.onKeepAlive(),
        onError: (a) => callbacksRef.current?.onError(a),
        onInitMeta: (m) => callbacksRef.current?.onInitMeta?.(m),
      };

      return consumeSSEStream(reader, proxied);
    },
    [],
  );

  return { processStream };
}
