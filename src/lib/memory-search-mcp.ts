/** Claude/Codex MCP protocol adapter; no independent Memory behavior. */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { createMemoryMutationTools } from './memory-service';
import { createMemoryAdapterQueryTools, type MemoryAdapterOptions } from './memory-rerank';
export { MEMORY_SEARCH_SYSTEM_PROMPT } from './memory-service';

export function createMemorySearchMcpServer(workspacePath: string, options: MemoryAdapterOptions = {}) {
  const definitions = createMemoryAdapterQueryTools(workspacePath, options);
  const mutations = createMemoryMutationTools(workspacePath, options);
  const search = definitions.codepilot_memory_search;
  const get = definitions.codepilot_memory_get;
  const recent = definitions.codepilot_memory_recent;
  const remember = mutations.codepilot_memory_remember;
  const update = mutations.codepilot_memory_update;
  const forget = mutations.codepilot_memory_forget;
  return createSdkMcpServer({
    name: options.access === 'write' ? 'codepilot-memory-write' : 'codepilot-memory',
    version: '1.0.0',
    tools: [
      ...(options.access !== 'write' ? [
        tool('codepilot_memory_search', search.description, search.inputSchema.shape, async input => ({
          content: [{ type: 'text' as const, text: await search.execute(input) }],
        })),
        tool('codepilot_memory_get', get.description, get.inputSchema.shape, async input => ({
          content: [{ type: 'text' as const, text: await get.execute(input) }],
        })),
        tool('codepilot_memory_recent', recent.description, recent.inputSchema.shape, async input => ({
          content: [{ type: 'text' as const, text: await recent.execute(input) }],
        })),
      ] : []),
      ...(options.access !== 'read' ? [
        tool('codepilot_memory_remember', remember.description, remember.inputSchema.shape, async input => ({
          content: [{ type: 'text' as const, text: await remember.execute(input) }],
        })),
        tool('codepilot_memory_update', update.description, update.inputSchema.shape, async input => ({
          content: [{ type: 'text' as const, text: await update.execute(input) }],
        })),
        tool('codepilot_memory_forget', forget.description, forget.inputSchema.shape, async input => ({
          content: [{ type: 'text' as const, text: await forget.execute(input) }],
        })),
      ] : []),
    ],
  });
}
