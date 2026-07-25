/**
 * runtime/sdk-runtime.ts — Claude Code SDK Agent Runtime.
 *
 * Wraps the existing SDK path in claude-client.ts behind the AgentRuntime interface.
 * Delegates to streamClaudeSdk() which contains the original SDK query() logic.
 *
 * Strategy: Rather than copy 500+ lines of SDK code here, we keep the SDK logic
 * in claude-client.ts (exported as streamClaudeSdk) and this file is a thin adapter.
 * When Phase 8 completes, we can optionally move the code here.
 */

import type { AgentRuntime, RuntimeStreamOptions } from './types';
import type { ClaudeStreamOptions } from '@/types';
import { findClaudeBinary } from '../platform';
import { getConversation } from '../conversation-registry';
import { getSetting, getActiveProvider } from '../db';
// Static import. Used to be `require('../claude-client')` for lazy loading,
// but Turbopack's ESM↔CJS interop returns the module wrapped in `{ default: ... }`
// instead of the named-export shape webpack used to produce, which breaks the
// destructuring and surfaces as "Error: streamClaudeSdk is not a function" the
// moment a DB-provider request hits the SDK runtime. Lazy loading was a
// micro-optimization (claude-client is imported elsewhere too via
// streamClaude), so it's safe to drop in favor of a static import that both
// bundlers handle correctly.
import { streamClaudeSdk } from '../claude-client';

export const sdkRuntime: AgentRuntime = {
  id: 'claude-code-sdk',
  displayName: 'Claude Code',
  description: 'Claude Code CLI agent with built-in tools, MCP, and permissions.',

  stream(options: RuntimeStreamOptions): ReadableStream<string> {

    // Convert RuntimeStreamOptions → ClaudeStreamOptions
    const ro = options.runtimeOptions || {};
    const sdkOptions: ClaudeStreamOptions = {
      prompt: options.prompt,
      callScene: options.callScene,
      sessionId: options.sessionId,
      model: options.model,
      systemPrompt: options.systemPrompt,
      workingDirectory: options.workingDirectory,
      abortController: options.abortController,
      permissionMode: options.permissionMode,
      mcpServers: options.mcpServers,
      thinking: options.thinking,
      effort: options.effort,
      context1m: options.context1m,
      temperature: options.temperature,
      topP: options.topP,
      topK: options.topK,
      autoTrigger: options.autoTrigger,
      bypassPermissions: options.bypassPermissions,
      onRuntimeStatusChange: options.onRuntimeStatusChange,
      providerId: options.providerId,
      sessionProviderId: options.sessionProviderId,

      // SDK-specific fields from runtimeOptions
      sdkSessionId: ro.sdkSessionId as string | undefined,
      files: ro.files as ClaudeStreamOptions['files'],
      conversationHistory: ro.conversationHistory as ClaudeStreamOptions['conversationHistory'],
      sessionSummary: ro.sessionSummary as string | undefined,
      fallbackTokenBudget: ro.fallbackTokenBudget as number | undefined,
      toolTimeoutSeconds: ro.toolTimeoutSeconds as number | undefined,
      outputFormat: ro.outputFormat as ClaudeStreamOptions['outputFormat'],
      agents: ro.agents as ClaudeStreamOptions['agents'],
      agent: ro.agent as string | undefined,
      enableFileCheckpointing: ro.enableFileCheckpointing as boolean | undefined,
      generativeUI: ro.generativeUI as boolean | undefined,
      provider: ro.provider as ClaudeStreamOptions['provider'],
      lockId: ro.lockId as string | undefined,
    };

    return streamClaudeSdk(sdkOptions);
  },

  interrupt(sessionId: string): void {
    const conversation = getConversation(sessionId);
    if (conversation) {
      conversation.interrupt();
    }
  },

  isAvailable(): boolean {
    // SDK is available if the CLI binary exists. Authentication is managed
    // by the CLI itself (OAuth session, env vars, provider config, etc.)
    // and should fail at runtime with a clear error, not be pre-filtered here.
    //
    // Previous approach tried to check credentials in isAvailable(), but
    // this couldn't cover all auth paths (CLI OAuth, ~/.claude session, etc.)
    // and caused false negatives — users with valid CLI auth were routed
    // to native runtime unexpectedly.
    return !!findClaudeBinary();
  },

  dispose(): void {
    // SDK manages its own subprocess lifecycle
  },
};
