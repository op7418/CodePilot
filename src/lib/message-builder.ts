/**
 * message-builder.ts — Convert DB messages to Vercel AI SDK CoreMessage[] format.
 *
 * The DB stores all messages as `{ role: 'user' | 'assistant', content: string }`.
 * For assistant messages, `content` may be a JSON array of MessageContentBlock[]:
 *   [{ type: 'text', text }, { type: 'tool_use', id, name, input },
 *    { type: 'tool_result', tool_use_id, content }, ...]
 *
 * The Vercel AI SDK expects a strict multi-turn structure:
 *   - UserModelMessage: { role: 'user', content: UserContent }
 *   - AssistantModelMessage: { role: 'assistant', content: AssistantContent }
 *     where AssistantContent can include TextPart + ToolCallPart
 *   - ToolModelMessage: { role: 'tool', content: ToolContent }
 *     where ToolContent = Array<ToolResultPart>
 *
 * This module bridges the gap, splitting a single DB assistant record
 * (which may contain interleaved text + tool_use + tool_result) into
 * the correct alternating assistant → tool → assistant structure.
 */

import type {
  ModelMessage,
  AssistantModelMessage,
  ToolModelMessage,
  AssistantContent,
  ToolContent,
} from 'ai';
import type { Message, MessageContentBlock } from '@/types';
import { parseMessageContent } from '@/types';
import fs from 'fs';

interface FileMeta {
  id: string;
  name: string;
  type: string; // MIME type
  size: number;
  filePath?: string;
}

/**
 * Convert an array of DB messages (chronological order) into
 * Vercel AI SDK ModelMessage[] suitable for streamText({ messages }).
 *
 * Skips heartbeat-ack messages. Strips file metadata from user messages.
 */
export function buildCoreMessages(dbMessages: Message[]): ModelMessage[] {
  const raw: ModelMessage[] = [];

  for (const msg of dbMessages) {
    if (msg.is_heartbeat_ack === 1) continue;

    if (msg.role === 'user') {
      raw.push(buildUserMessage(msg.content));
    } else {
      // assistant — may contain structured blocks
      const blocks = parseMessageContent(msg.content);
      const converted = convertAssistantBlocks(blocks);
      raw.push(...converted);
    }
  }

  // Enforce message alternation: Anthropic API requires user/assistant turns to alternate.
  // Consecutive same-role messages get merged (user) or the later one wins (assistant).
  const result = enforceAlternation(raw);
  return result;
}

/**
 * Ensure messages alternate between user and assistant/tool roles.
 * Consecutive user messages are merged. Consecutive assistant messages are merged
 * (preserving all content parts) to avoid silently dropping tool call history.
 */
function enforceAlternation(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length <= 1) return messages;

  const result: ModelMessage[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];

    if (curr.role === prev.role && curr.role === 'user') {
      result[result.length - 1] = { role: 'user', content: mergeUserContent(prev.content, curr.content) };
    } else if (curr.role === prev.role && curr.role === 'assistant') {
      result[result.length - 1] = {
        role: 'assistant',
        content: mergeAssistantContent(prev.content, curr.content),
      } as AssistantModelMessage;
    } else {
      result.push(curr);
    }
  }

  return result;
}

// ── Sanitization ────────────────────────────────────────────────

/**
 * Detect and clean assistant text blocks that contain fake tool call syntax.
 * When the model outputs "(used Bash: {...})" as text instead of making a real
 * tool_use API call, those patterns pollute the conversation history and cause
 * the model to imitate them on future turns (feedback loop).
 *
 * Also strips leaked thinking tags like "(antml:thinking>..." which indicate
 * protocol confusion from context overload.
 */
function sanitizeAssistantText(text: string): string {
  // Strip fake tool call patterns: (used ToolName: {json...}) and [Tool call: Name — ...]
  let cleaned = text.replace(/\(used\s+\w+:\s*\{[^}]*\}[^)]*\)/g, '');
  cleaned = cleaned.replace(/\[Tool call:\s+\w+\s*—[^\]]*\]/g, '');
  // Strip leaked thinking tags: (antml:thinking>...) or </thinking>
  cleaned = cleaned.replace(/\(antml:thinking>[\s\S]*?(?:<\/antml:thinking>|\))/g, '');
  cleaned = cleaned.replace(/<\/?antml:thinking>/g, '');
  // Collapse multiple blank lines left by stripping
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

/**
 * Check if a text block consists entirely (or almost entirely) of fake tool calls.
 * If so, replace with a brief marker instead of sending garbage to the model.
 * Only sanitize if >80% of the content appears to be fake tool calls.
 */
function cleanAssistantTextBlock(text: string): string {
  const originalLength = text.trim().length;
  if (originalLength < 50) return text; // Don't sanitize short texts

  const sanitized = sanitizeAssistantText(text);
  const removedLength = originalLength - sanitized.length;
  const removalRatio = removedLength / originalLength;

  // Only apply sanitization if >80% was fake tool calls
  if (removalRatio > 0.8) {
    return sanitized || '[Tool calls in this turn were not executed]';
  }

  // Otherwise return original text untouched
  return text;
}

// ── Internal ────────────────────────────────────────────────────

/**
 * Merge two user message contents, handling both string and multi-part array formats.
 * Ensures file attachments (non-string parts) are preserved during merge.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mergeUserContent(a: any, b: any): any {
  const partsA = typeof a === 'string' ? [{ type: 'text', text: a }] : Array.isArray(a) ? a : [{ type: 'text', text: String(a) }];
  const partsB = typeof b === 'string' ? [{ type: 'text', text: b }] : Array.isArray(b) ? b : [{ type: 'text', text: String(b) }];
  const merged = [...partsA, ...partsB];

  // If all parts are text, collapse back to a single string for simplicity
  if (merged.every((p: { type: string }) => p.type === 'text')) {
    return merged.map((p: { text?: string }) => p.text || '').join('\n\n').trim();
  }
  return merged;
}

/**
 * Merge two assistant message contents, preserving all content parts (text, tool-call, etc.).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mergeAssistantContent(a: any, b: any): Exclude<AssistantContent, string> {
  const toArray = (c: unknown): Exclude<AssistantContent, string> => {
    if (typeof c === 'string') return c.trim() ? [{ type: 'text' as const, text: c }] : [];
    if (Array.isArray(c)) return c as Exclude<AssistantContent, string>;
    return [];
  };
  return [...toArray(a), ...toArray(b)];
}

/**
 * Parse user message content, rebuilding file attachments as multi-modal content parts.
 * File metadata is stored as `<!--files:[{id,name,type,size,filePath}]-->text`.
 * For image files: reads from disk and includes as { type: 'file', data, mediaType }.
 * For non-image files: includes filename mention in text.
 * If no file metadata or files can't be read: returns plain text.
 */
function buildUserMessage(content: string): ModelMessage {
  const match = content.match(/^<!--files:(\[.*?\])-->([\s\S]*)$/);
  if (!match) {
    return { role: 'user', content };
  }

  const text = match[2] || '';
  let fileMetas: FileMeta[] = [];
  try { fileMetas = JSON.parse(match[1]); } catch { /* ignore */ }

  if (fileMetas.length === 0) {
    return { role: 'user', content: text };
  }

  // Build multi-modal content parts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts: any[] = [];
  if (text.trim()) {
    parts.push({ type: 'text', text: text.trim() });
  }

  for (const meta of fileMetas) {
    if (!meta.filePath || !meta.type) continue;

    // Only include image files as binary content (models can see them)
    if (meta.type.startsWith('image/')) {
      try {
        const data = fs.readFileSync(meta.filePath);
        const base64 = data.toString('base64');
        parts.push({ type: 'file', data: base64, mediaType: meta.type });
      } catch {
        // File no longer exists — mention it in text
        parts.push({ type: 'text', text: `[Attached file: ${meta.name} (no longer available)]` });
      }
    } else {
      // Non-image files: try to include as text content
      try {
        const fileContent = fs.readFileSync(meta.filePath, 'utf-8');
        parts.push({ type: 'text', text: `\n--- ${meta.name} ---\n${fileContent.slice(0, 50000)}\n--- end ---` });
      } catch {
        parts.push({ type: 'text', text: `[Attached file: ${meta.name}]` });
      }
    }
  }

  if (parts.length === 0) {
    return { role: 'user', content: text };
  }
  if (parts.length === 1 && parts[0].type === 'text') {
    return { role: 'user', content: parts[0].text };
  }

  return { role: 'user', content: parts };
}

/**
 * Convert a flat array of MessageContentBlock[] (from a single DB assistant record)
 * into a sequence of CoreMessage[].
 *
 * The DB stores one assistant record per SDK "turn", which may contain:
 *   [text, tool_use, tool_use, tool_result, tool_result, text, tool_use, tool_result, text]
 *
 * We need to split this into:
 *   assistant: [text, tool_call, tool_call]
 *   tool: [result, result]
 *   assistant: [text, tool_call]
 *   tool: [result]
 *   assistant: [text]
 *
 * Strategy: scan blocks sequentially. Accumulate assistant content (text + tool_use).
 * When we hit tool_result blocks, flush the assistant message, then emit tool message(s).
 * Resume accumulating for the next assistant segment.
 */
function convertAssistantBlocks(blocks: MessageContentBlock[]): ModelMessage[] {
  const messages: ModelMessage[] = [];

  // AssistantContent = string | Array<TextPart | FilePart | ReasoningPart | ToolCallPart | ...>
  let assistantParts: Exclude<AssistantContent, string> = [];
  // ToolContent = Array<ToolResultPart | ToolApprovalResponse>
  let toolResults: ToolContent = [];

  const flushAssistant = () => {
    if (assistantParts.length > 0) {
      messages.push({ role: 'assistant', content: assistantParts } as AssistantModelMessage);
      assistantParts = [];
    }
  };

  const flushToolResults = () => {
    if (toolResults.length > 0) {
      messages.push({ role: 'tool', content: toolResults } as ToolModelMessage);
      toolResults = [];
    }
  };

  // Build a map of tool_use_id → toolName so tool_result can reference it
  const toolNameMap = new Map<string, string>();
  for (const block of blocks) {
    if (block.type === 'tool_use') {
      toolNameMap.set(block.id, block.name);
    }
  }

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        // If we have pending tool results, flush them first (tool → assistant transition)
        if (toolResults.length > 0) {
          flushToolResults();
        }
        if (block.text.trim()) {
          const cleaned = cleanAssistantTextBlock(block.text);
          assistantParts.push({ type: 'text', text: cleaned });
        }
        break;

      case 'thinking':
        // Thinking blocks are Anthropic-specific. The AI SDK supports ReasoningPart
        // but sending reasoning back to the model is provider-dependent.
        // Skip — thinking is informational and not sent back to the model
        // in most cases. Anthropic's sendReasoning option controls this at the provider level.
        break;

      case 'tool_use':
        // If we have pending tool results, flush them first
        if (toolResults.length > 0) {
          flushToolResults();
        }
        assistantParts.push({
          type: 'tool-call',
          toolCallId: block.id,
          toolName: block.name,
          input: block.input,
        });
        break;

      case 'tool_result':
        // Flush assistant first (assistant → tool transition)
        flushAssistant();
        toolResults.push({
          type: 'tool-result',
          toolCallId: block.tool_use_id,
          toolName: toolNameMap.get(block.tool_use_id) || 'unknown',
          output: { type: 'text', value: block.content },
        });
        break;

      case 'code':
        // Code blocks are rendered as text
        if (toolResults.length > 0) {
          flushToolResults();
        }
        assistantParts.push({
          type: 'text',
          text: `\`\`\`${block.language}\n${block.code}\n\`\`\``,
        });
        break;
    }
  }

  // Flush remaining
  flushAssistant();
  flushToolResults();

  // If no messages were generated (empty blocks), emit a minimal assistant message
  if (messages.length === 0) {
    messages.push({ role: 'assistant', content: '' });
  }

  return messages;
}
