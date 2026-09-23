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
import { replayNativeSteps } from './native-step-history';
import { repairIncompleteToolHistory } from './tool-history-integrity';

interface FileMeta {
  id: string;
  name: string;
  type: string; // MIME type
  size: number;
  filePath?: string;
}

/**
 * Whether a MIME type (or fallback filename extension) is safe to read as
 * UTF-8 text and inline into a prompt. Used to avoid injecting binary content
 * (audio/video/PDF/zip) as garbled characters during history replay.
 */
function isTextLikeMime(mime: string | undefined, name: string | undefined): boolean {
  const m = (mime || '').toLowerCase();
  if (!m && !name) return false;
  if (m.startsWith('text/')) return true;
  // Common "application/*" types that are actually text
  if (['application/json', 'application/xml', 'application/javascript',
       'application/typescript', 'application/yaml', 'application/x-yaml',
       'application/x-sh', 'application/toml', 'application/x-toml',
       'application/graphql', 'application/sql'].includes(m)) return true;
  if (m.includes('+json') || m.includes('+xml') || m.includes('+yaml')) return true;
  // Fallback to extension for missing/generic MIME types
  const ext = (name || '').toLowerCase().split('.').pop() || '';
  const TEXT_EXTS = new Set([
    'txt', 'md', 'markdown', 'rst', 'log', 'json', 'jsonc', 'yaml', 'yml',
    'toml', 'ini', 'cfg', 'conf', 'csv', 'tsv', 'xml', 'html', 'htm', 'css',
    'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp',
    'cs', 'php', 'pl', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'sql', 'graphql', 'proto', 'env', 'gitignore', 'dockerfile',
  ]);
  return TEXT_EXTS.has(ext);
}

/**
 * Convert an array of DB messages (chronological order) into
 * Vercel AI SDK ModelMessage[] suitable for streamText({ messages }).
 *
 * Skips heartbeat-ack messages. Strips file metadata from user messages.
 */
export function buildCoreMessages(dbMessages: Message[], route?: { providerId: string; modelId: string }): ModelMessage[] {
  const raw: ModelMessage[] = [];

  for (const msg of dbMessages) {
    if (msg.is_heartbeat_ack === 1) continue;

    if (msg.role === 'user') {
      raw.push(buildUserMessage(msg.content));
    } else {
      // assistant — may contain structured blocks
      const blocks = parseMessageContent(msg.content);
      const converted = replayNativeSteps(blocks, route, convertAssistantBlocks);
      raw.push(...converted);
    }
  }

  // Enforce message alternation first, preserving the existing transcript
  // semantics, then repair incomplete tool segments left by Stop/partial SSE
  // persistence. The repair inserts only an explicit app-owned missing-result
  // marker; it never fabricates a successful tool output.
  const alternated = enforceAlternation(raw, Boolean(route));
  const repaired = repairIncompleteToolHistory(alternated);
  if (repaired.synthesizedResults > 0 || repaired.droppedOrphanResults > 0) {
    console.warn(
      `[message-builder] repaired incomplete tool history: missing_results=${repaired.synthesizedResults} orphan_results=${repaired.droppedOrphanResults}`,
    );
  }
  return enforceAlternation(repaired.messages, Boolean(route));
}

/**
 * Ensure messages alternate between user and assistant/tool roles.
 * Consecutive user messages are merged. Consecutive assistant messages keep the last.
 */
function enforceAlternation(messages: ModelMessage[], preserveNativeParts = false): ModelMessage[] {
  if (messages.length <= 1) return messages;

  const result: ModelMessage[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];

    if (curr.role === prev.role && curr.role === 'user') {
      // Merge consecutive user messages, preserving multi-part content
      result[result.length - 1] = { role: 'user', content: mergeUserContent(prev.content, curr.content) };
    } else if (curr.role === prev.role && curr.role === 'assistant') {
      if (preserveNativeParts) {
        const previous = typeof prev.content === 'string' ? [{ type: 'text' as const, text: prev.content }] : prev.content;
        const current = typeof curr.content === 'string' ? [{ type: 'text' as const, text: curr.content }] : curr.content;
        result[result.length - 1] = { role: 'assistant', content: [...previous, ...current] } as AssistantModelMessage;
        continue;
      }
      // Keep the later assistant message (more recent)
      result[result.length - 1] = curr;
    } else {
      result.push(curr);
    }
  }

  return result;
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
    } else if (isTextLikeMime(meta.type, meta.name)) {
      // Actual text content — inline it (truncated)
      try {
        const fileContent = fs.readFileSync(meta.filePath, 'utf-8');
        parts.push({ type: 'text', text: `\n--- ${meta.name} ---\n${fileContent.slice(0, 50000)}\n--- end ---` });
      } catch {
        parts.push({ type: 'text', text: `[Attached file: ${meta.name}]` });
      }
    } else {
      // Binary content (audio, video, archives, PDFs, etc) — reading as UTF-8
      // would inject garbled bytes into the prompt and waste tokens. Keep a
      // reference note so the model knows the attachment existed, and include
      // the file path so tools like Read can open it on demand.
      parts.push({
        type: 'text',
        text: `[Attached file: ${meta.name} (${meta.type}, binary — content not inlined; path: ${meta.filePath})]`,
      });
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
          assistantParts.push({ type: 'text', text: block.text });
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
