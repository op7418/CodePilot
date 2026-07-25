/**
 * tools/agent.ts — AgentTool: spawn a sub-agent with isolated context.
 *
 * The sub-agent runs an independent agent-loop with restricted tools
 * and a separate message history. Results are returned as text to the parent.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getAgent, getSubAgents } from '../agent-registry';
import { runAgentLoop } from '../agent-loop';
import { createModel } from '../ai-provider';
import { assembleTools } from '../agent-tools';
import type { ToolSet } from 'ai';

/**
 * Create the Agent tool for spawning sub-agents.
 */
export function createAgentTool(ctx: {
  workingDirectory: string;
  providerId?: string;
  sessionProviderId?: string;
  parentModel?: string;
  /** Inherit permission mode from parent */
  permissionMode?: string;
  /** Parent session ID — sub-agent inherits permission context */
  parentSessionId?: string;
  /** Callback to forward SSE events (permission_request) to the parent stream */
  emitSSE?: (event: { type: string; data: string }) => void;
  /** Abort signal from parent */
  abortSignal?: AbortSignal;
}) {
  const subAgentIds = getSubAgents().map(a => a.id);

  return tool({
    description:
      'Launch a sub-agent to handle a complex, multi-step task autonomously. ' +
      'The sub-agent has its own context and tool access. ' +
      `Available agents: ${subAgentIds.join(', ')}. ` +
      'Use "explore" for quick codebase searches, "general" for multi-step tasks.',
    inputSchema: z.object({
      prompt: z.string().describe('The task for the sub-agent to perform'),
      agent: z.string().optional().describe(`Agent type: ${subAgentIds.join(' | ')} (default: general)`),
    }),
    execute: async ({ prompt, agent: agentId }) => {
      const agentDef = getAgent(agentId || 'general');
      if (!agentDef) {
        return `Error: Unknown agent "${agentId}". Available: ${subAgentIds.join(', ')}`;
      }

      // Build restricted tool set — inherit permission context from parent
      const permissionContext = (ctx.parentSessionId && ctx.emitSSE && ctx.permissionMode)
        ? {
            sessionId: ctx.parentSessionId,
            permissionMode: (ctx.permissionMode || 'normal') as import('../permission-checker').PermissionMode,
            emitSSE: ctx.emitSSE,
            abortSignal: ctx.abortSignal,
          }
        : undefined;
      const { tools: allTools } = assembleTools({
        workingDirectory: ctx.workingDirectory,
        providerId: ctx.providerId,
        sessionProviderId: ctx.sessionProviderId,
        model: ctx.parentModel,
        permissionContext,
      });
      const subTools = filterTools(allTools, agentDef.allowedTools, agentDef.disallowedTools);

      // Use agent's model or inherit from parent
      const model = agentDef.model || ctx.parentModel;

      // Build system prompt
      const systemPrompt = agentDef.prompt
        ? `${agentDef.prompt}\n\nWorking directory: ${ctx.workingDirectory}`
        : `You are a helpful sub-agent. Working directory: ${ctx.workingDirectory}`;

      // Run sub-agent loop and collect the full response
      const stream = runAgentLoop({
        callScene: 'interactive_chat',
        prompt,
        sessionId: `sub-${Date.now()}`, // ephemeral session
        providerId: ctx.providerId,
        sessionProviderId: ctx.sessionProviderId,
        model,
        systemPrompt,
        workingDirectory: ctx.workingDirectory,
        tools: subTools,
        maxSteps: agentDef.maxSteps || 30,
        permissionMode: ctx.permissionMode, // inherit from parent
      });

      // Emit subagent start event as tool_output so the parent UI can show progress
      if (ctx.emitSSE) {
        ctx.emitSSE({ type: 'tool_output', data: `[subagent:${agentDef.id}] ${prompt.length > 120 ? prompt.slice(0, 117) + '...' : prompt}` });
      }

      // Collect text from the stream
      const reader = stream.getReader();
      const textParts: string[] = [];

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Parse SSE events, extract text content and forward permission requests
          if (value) {
            const lines = value.split('\n');
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              try {
                const event = JSON.parse(line.slice(6));
                if (event.type === 'text') {
                  textParts.push(event.data);
                } else if (event.type === 'permission_request' && ctx.emitSSE) {
                  // Forward permission requests to parent stream so the
                  // client can show the approval UI for sub-agent tool calls
                  ctx.emitSSE(event);
                } else if (event.type === 'tool_use' && ctx.emitSSE) {
                  // Forward subagent tool invocations as tool_output progress
                  try {
                    const tool = JSON.parse(event.data);
                    const toolRenderer = getToolSummary(tool.name, tool.input);
                    ctx.emitSSE({ type: 'tool_output', data: `> ${toolRenderer}` });
                  } catch { /* skip malformed */ }
                } else if (event.type === 'tool_result' && ctx.emitSSE) {
                  // Show tool completion
                  try {
                    const res = JSON.parse(event.data);
                    const status = res.is_error ? 'x' : '+';
                    ctx.emitSSE({ type: 'tool_output', data: `[${status}] done` });
                  } catch { /* skip malformed */ }
                }
              } catch { /* skip non-JSON lines */ }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      return textParts.join('') || '(Sub-agent produced no text output)';
    },
  });
}

// ── Helpers ─────────────────────────────────────────────────────

/** Build a one-line summary of a tool invocation for subagent progress output. */
function getToolSummary(name: string, input: unknown): string {
  const inp = input as Record<string, unknown> | undefined;
  if (!inp) return name;
  const lower = name.toLowerCase();
  if (['bash', 'execute', 'run', 'shell'].includes(lower)) {
    const cmd = (inp.command || inp.cmd || '') as string;
    return cmd ? (cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd) : 'bash';
  }
  const filePath = (inp.file_path || inp.path || inp.filePath || '') as string;
  if (['read', 'readfile', 'read_file'].includes(lower)) {
    return filePath ? `Read ${filePath}` : 'Read';
  }
  if (['write', 'edit', 'writefile', 'write_file', 'create_file'].includes(lower)) {
    return filePath ? `Edit ${filePath}` : 'Edit';
  }
  if (['glob', 'grep', 'search', 'find_files', 'search_files'].includes(lower)) {
    const pattern = (inp.pattern || inp.query || inp.glob || '') as string;
    return pattern ? `${name} "${pattern.length > 40 ? pattern.slice(0, 37) + '...' : pattern}"` : name;
  }
  return name;
}

function filterTools(
  allTools: ToolSet,
  allowedTools?: string[],
  disallowedTools?: string[],
): ToolSet {
  if (allowedTools && allowedTools.length > 0) {
    // Whitelist mode: only include specified tools
    const filtered: ToolSet = {};
    for (const name of allowedTools) {
      if (allTools[name]) filtered[name] = allTools[name];
    }
    return filtered;
  }

  if (disallowedTools && disallowedTools.length > 0) {
    // Blacklist mode: include all except specified
    const filtered: ToolSet = {};
    const blocked = new Set(disallowedTools);
    for (const [name, tool] of Object.entries(allTools)) {
      if (!blocked.has(name)) filtered[name] = tool;
    }
    return filtered;
  }

  return allTools;
}
