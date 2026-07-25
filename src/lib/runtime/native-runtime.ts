/**
 * runtime/native-runtime.ts — Native Agent Runtime (no Claude Code CLI).
 *
 * Uses Vercel AI SDK streamText() internally via agent-loop.ts.
 * This is the default runtime when Claude Code CLI is not installed.
 */

import type { AgentRuntime, RuntimeStreamOptions } from './types';
import { runAgentLoop } from '../agent-loop';
import { buildSystemPrompt } from '../agent-system-prompt';
import { resolveProvider } from '../provider-resolver';
import { syncMcpConnections, disposeAll as disposeMcp } from '../mcp-connection-manager';
import { isOAuthUsable } from '../openai-oauth-manager';
import { isXaiOAuthUsable } from '../xai-oauth-manager';
import { wrapController } from '../safe-stream';

// Track active AbortControllers for interrupt support
const activeControllers = new Map<string, AbortController>();

export const nativeRuntime: AgentRuntime = {
  id: 'native',
  displayName: 'Native (AI SDK)',
  description: 'Built-in agent runtime powered by Vercel AI SDK. No external CLI required.',

  stream(options: RuntimeStreamOptions): ReadableStream<string> {
    const cwd = options.workingDirectory || process.cwd();

    const systemPrompt = buildSystemPrompt({
      userPrompt: options.systemPrompt,
      workingDirectory: cwd,
      modelId: options.model,
    });

    // Create or reuse abort controller
    const abortController = options.abortController || new AbortController();
    activeControllers.set(options.sessionId, abortController);

    const ro = options.runtimeOptions || {};
    const maxSteps = (ro.maxSteps as number) || undefined;
    const files = ro.files as import('@/types').FileAttachment[] | undefined;

    const stream = runAgentLoop({
      prompt: options.prompt,
      callScene: options.callScene,
      sessionId: options.sessionId,
      providerId: options.providerId,
      sessionProviderId: options.sessionProviderId,
      model: options.model,
      systemPrompt,
      workingDirectory: cwd,
      abortController,
      // tools assembled inside agent-loop with permission context
      permissionMode: options.permissionMode,
      bypassPermissions: options.bypassPermissions,
      mcpServers: options.mcpServers,
      thinking: options.thinking,
      effort: options.effort,
      context1m: options.context1m,
      temperature: options.temperature,
      topP: options.topP,
      topK: options.topK,
      maxSteps,
      autoTrigger: options.autoTrigger,
      onRuntimeStatusChange: options.onRuntimeStatusChange,
      files,
    });

    // Clean up controller when stream ends
    const reader = stream.getReader();
    const cleanup = new ReadableStream<string>({
      async start(controllerRaw) {
        const controller = wrapController(controllerRaw);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
            if (controller.closed) break; // consumer aborted — stop pulling
          }
        } finally {
          activeControllers.delete(options.sessionId);
          controller.close();
        }
      },
    });

    return cleanup;
  },

  interrupt(sessionId: string): void {
    const controller = activeControllers.get(sessionId);
    if (controller) {
      controller.abort();
      activeControllers.delete(sessionId);
    }
  },

  isAvailable(): boolean {
    // Native runtime is available whenever any provider has credentials.
    // A lightweight check — don't resolve the full provider, just check if
    // there's any configured provider, env-based credentials, or OpenAI OAuth.
    try {
      const resolved = resolveProvider({ callScene: 'connection_test' });
      if (resolved.hasCredentials || !!resolved.provider) return true;
    } catch { /* fall through */ }

    // Also check OpenAI OAuth — it's a virtual provider not in the DB
    try {
      if (isOAuthUsable()) return true;
    } catch { /* module not available */ }

    try {
      if (isXaiOAuthUsable()) return true;
    } catch { /* module not available */ }

    return false;
  },

  dispose(): void {
    // Abort all active sessions
    for (const controller of activeControllers.values()) {
      controller.abort();
    }
    activeControllers.clear();
    // Clean up MCP connections
    disposeMcp().catch(() => {});
  },
};
