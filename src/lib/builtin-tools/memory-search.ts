/** Native Runtime protocol adapter. Memory behavior lives in the neutral service. */
import { tool } from 'ai';
import { createMemoryMutationTools } from '@/lib/memory-service';
import { createMemoryAdapterQueryTools, type MemoryAdapterOptions } from '@/lib/memory-rerank';
export { MEMORY_SEARCH_SYSTEM_PROMPT } from '@/lib/memory-service';

export function createMemorySearchTools(workspacePath: string, options: MemoryAdapterOptions = {}) {
  const read = createMemoryAdapterQueryTools(workspacePath, options);
  const write = createMemoryMutationTools(workspacePath, options);
  return {
    ...(options.access !== 'write' ? {
      codepilot_memory_search: tool(read.codepilot_memory_search),
      codepilot_memory_get: tool(read.codepilot_memory_get),
      codepilot_memory_recent: tool(read.codepilot_memory_recent),
    } : {}),
    ...(options.access !== 'read' ? {
      codepilot_memory_remember: tool(write.codepilot_memory_remember),
      codepilot_memory_update: tool(write.codepilot_memory_update),
      codepilot_memory_forget: tool(write.codepilot_memory_forget),
    } : {}),
  };
}
