'use client';

import { useState, useCallback, useRef, useEffect, useMemo, memo } from 'react';
import type { Message, TokenUsage, FileAttachment } from '@/types';
import {
  Message as AIMessage,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';
import { ToolActionsGroup } from '@/components/ai-elements/tool-actions-group';
import { Button } from "@/components/ui/button";
import { Copy, Check, CaretDown, CaretUp } from "@/components/ui/icon";
import { FileAttachmentDisplay } from './FileAttachmentDisplay';
import { ImageGenConfirmation } from './ImageGenConfirmation';
import { ImageGenCard } from './ImageGenCard';
import { BatchPlanInlinePreview } from './batch-image-gen/BatchPlanInlinePreview';
import { buildReferenceImages } from '@/lib/image-ref-store';
import { parseDBDate } from '@/lib/utils';
import type { PlannerOutput } from '@/types';

interface ImageGenRequest {
  prompt: string;
  aspectRatio: string;
  resolution: string;
  referenceImages?: string[];
  useLastGenerated?: boolean;
}

function parseImageGenRequest(text: string): { beforeText: string; request: ImageGenRequest; afterText: string } | null {
  const regex = /```image-gen-request\s*\n?([\s\S]*?)\n?\s*```/;
  const match = text.match(regex);
  if (!match) return null;
  try {
    let raw = match[1].trim();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(raw);
    } catch {
      // Attempt to fix common model output issues: unescaped quotes in values
      raw = raw.replace(/"prompt"\s*:\s*"([\s\S]*?)"\s*([,}])/g, (_m, val, tail) => {
        const escaped = val.replace(/(?<!\\)"/g, '\\"');
        return `"prompt": "${escaped}"${tail}`;
      });
      json = JSON.parse(raw);
    }
    const beforeText = text.slice(0, match.index).trim();
    const afterText = text.slice((match.index || 0) + match[0].length).trim();
    return {
      beforeText,
      request: {
        prompt: String(json.prompt || ''),
        aspectRatio: String(json.aspectRatio || '1:1'),
        resolution: String(json.resolution || '1K'),
        referenceImages: Array.isArray(json.referenceImages) ? json.referenceImages : undefined,
        useLastGenerated: json.useLastGenerated === true,
      },
      afterText,
    };
  } catch {
    return null;
  }
}

interface ImageGenResultData {
  status: 'generating' | 'completed' | 'error';
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
  model?: string;
  images?: Array<{ mimeType: string; localPath?: string; data?: string }>;
  error?: string;
}

function parseImageGenResult(text: string): { beforeText: string; result: ImageGenResultData; afterText: string } | null {
  const regex = /```image-gen-result\s*\n?([\s\S]*?)\n?\s*```/;
  const match = text.match(regex);
  if (!match) return null;
  try {
    const json = JSON.parse(match[1]);
    const beforeText = text.slice(0, match.index).trim();
    const afterText = text.slice((match.index || 0) + match[0].length).trim();
    return {
      beforeText,
      result: {
        status: json.status || 'completed',
        prompt: String(json.prompt || ''),
        aspectRatio: json.aspectRatio,
        resolution: json.resolution,
        model: json.model,
        images: Array.isArray(json.images) ? json.images : undefined,
        error: json.error,
      },
      afterText,
    };
  } catch {
    return null;
  }
}

function parseBatchPlan(text: string): { beforeText: string; plan: PlannerOutput; afterText: string } | null {
  const regex = /```batch-plan\s*\n?([\s\S]*?)\n?\s*```/;
  const match = text.match(regex);
  if (!match) return null;
  try {
    const json = JSON.parse(match[1]);
    const beforeText = text.slice(0, match.index).trim();
    const afterText = text.slice((match.index || 0) + match[0].length).trim();
    return {
      beforeText,
      plan: {
        summary: json.summary || '',
        items: Array.isArray(json.items) ? json.items.map((item: Record<string, unknown>) => ({
          prompt: String(item.prompt || ''),
          aspectRatio: String(item.aspectRatio || '1:1'),
          resolution: String(item.resolution || '1K'),
          tags: Array.isArray(item.tags) ? item.tags : [],
          sourceRefs: Array.isArray(item.sourceRefs) ? item.sourceRefs : [],
        })) : [],
      },
      afterText,
    };
  } catch {
    return null;
  }
}

interface MessageItemProps {
  message: Message;
}

interface ToolBlock {
  type: 'tool_use' | 'tool_result';
  id?: string;
  name?: string;
  input?: unknown;
  content?: string;
  is_error?: boolean;
}

function parseToolBlocks(content: string): { text: string; tools: ToolBlock[] } {
  const tools: ToolBlock[] = [];
  let text = '';

  // Try to parse as JSON array (new format from chat API)
  if (content.startsWith('[')) {
    try {
      const blocks = JSON.parse(content) as Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
        tool_use_id?: string;
        content?: string;
        is_error?: boolean;
      }>;
      
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          text += block.text;
        } else if (block.type === 'tool_use') {
          tools.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
        } else if (block.type === 'tool_result') {
          tools.push({
            type: 'tool_result',
            id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error,
          });
        }
      }
      
      return { text: text.trim(), tools };
    } catch {
      // Not valid JSON, fall through to legacy parsing
    }
  }

  // Legacy format: HTML comments
  text = content;
  const toolUseRegex = /<!--tool_use:([\s\S]*?)-->/g;
  let match;
  while ((match = toolUseRegex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      tools.push({ type: 'tool_use', ...parsed });
    } catch {
      // skip malformed
    }
    text = text.replace(match[0], '');
  }

  const toolResultRegex = /<!--tool_result:([\s\S]*?)-->/g;
  while ((match = toolResultRegex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      tools.push({ type: 'tool_result', ...parsed });
    } catch {
      // skip malformed
    }
    text = text.replace(match[0], '');
  }

  return { text: text.trim(), tools };
}

function pairTools(tools: ToolBlock[]): Array<{
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
}> {
  const paired: Array<{
    name: string;
    input: unknown;
    result?: string;
    isError?: boolean;
  }> = [];

  const resultMap = new Map<string, ToolBlock>();
  for (const t of tools) {
    if (t.type === 'tool_result' && t.id) {
      resultMap.set(t.id, t);
    }
  }

  for (const t of tools) {
    if (t.type === 'tool_use' && t.name) {
      const result = t.id ? resultMap.get(t.id) : undefined;
      paired.push({
        name: t.name,
        input: t.input,
        result: result?.content,
        isError: result?.is_error,
      });
    }
  }

  for (const t of tools) {
    if (t.type === 'tool_result' && !tools.some(u => u.type === 'tool_use' && u.id === t.id)) {
      paired.push({
        name: 'tool_result',
        input: {},
        result: t.content,
        isError: t.is_error,
      });
    }
  }

  return paired;
}

function parseMessageFiles(content: string): { files: FileAttachment[]; text: string } {
  const match = content.match(/^<!--files:(.*?)-->\n?/);
  if (!match) return { files: [], text: content };
  try {
    const files = JSON.parse(match[1]);
    const text = content.slice(match[0].length);
    return { files, text };
  } catch {
    return { files: [], text: content };
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  }, [text]);

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs text-muted-foreground/60 hover:text-muted-foreground h-auto"
      title="Copy"
    >
      {copied ? (
        <Check size={12} className="text-status-success-foreground" />
      ) : (
        <Copy size={12} />
      )}
    </Button>
  );
}

function TokenUsageDisplay({ usage }: { usage: TokenUsage }) {
  const totalTokens = usage.input_tokens + usage.output_tokens;
  const costStr = usage.cost_usd !== undefined && usage.cost_usd !== null
    ? ` · $${usage.cost_usd.toFixed(4)}`
    : '';

  return (
    <span className="group/tokens relative cursor-default text-xs text-muted-foreground/50">
      <span>{totalTokens.toLocaleString()} tokens{costStr}</span>
      <span className="pointer-events-none absolute bottom-full left-0 mb-1.5 whitespace-nowrap rounded-md bg-popover px-2.5 py-1.5 text-[11px] text-popover-foreground shadow-md border border-border/50 opacity-0 group-hover/tokens:opacity-100 transition-opacity duration-150 z-50">
        In: {usage.input_tokens.toLocaleString()} · Out: {usage.output_tokens.toLocaleString()}
        {usage.cache_read_input_tokens ? ` · Cache: ${usage.cache_read_input_tokens.toLocaleString()}` : ''}
        {costStr}
      </span>
    </span>
  );
}

const COLLAPSE_HEIGHT = 300;

export const MessageItem = memo(function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === 'user';

  // Collapse/expand state for long user messages (hooks must be called unconditionally)
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Memoize expensive parsing: parseToolBlocks + pairTools
  const { text, pairedTools } = useMemo(() => {
    const { text, tools } = parseToolBlocks(message.content);
    const pairedTools = pairTools(tools);
    return { text, pairedTools };
  }, [message.content]);

  // Memoize file attachment parsing
  const { files, displayText } = useMemo(() => {
    if (isUser) {
      const { files, text: textWithoutFiles } = parseMessageFiles(text);
      return { files, displayText: textWithoutFiles };
    }
    return { files: [] as FileAttachment[], displayText: text };
  }, [text, isUser]);

  useEffect(() => {
    if (isUser && contentRef.current) {
      setIsOverflowing(contentRef.current.scrollHeight > COLLAPSE_HEIGHT);
    }
  }, [isUser, displayText]);

  // Memoize token usage JSON parsing
  const tokenUsage = useMemo<TokenUsage | null>(() => {
    if (!message.token_usage) return null;
    try {
      return JSON.parse(message.token_usage);
    } catch {
      return null;
    }
  }, [message.token_usage]);

  // Hide image-gen system notices — they exist in DB for Claude's context but shouldn't render
  if (isUser && message.content.startsWith('[__IMAGE_GEN_NOTICE__')) {
    return null;
  }

  const timestamp = parseDBDate(message.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <AIMessage from={isUser ? 'user' : 'assistant'}>
      <MessageContent>
        {/* File attachments for user messages */}
        {isUser && files.length > 0 && (
          <FileAttachmentDisplay files={files} />
        )}

        {/* Tool calls for assistant messages — compact collapsible group */}
        {!isUser && pairedTools.length > 0 && (
          <ToolActionsGroup
            tools={pairedTools.map((tool, i) => ({
              id: `hist-${i}`,
              name: tool.name,
              input: tool.input,
              result: tool.result,
              isError: tool.isError,
            }))}
          />
        )}

        {/* Text content */}
        {displayText && (
          isUser ? (
            <div className="relative">
              <div
                ref={contentRef}
                className="text-sm whitespace-pre-wrap break-words transition-[max-height] duration-300 ease-in-out overflow-hidden"
                style={
                  isOverflowing && !isExpanded
                    ? { maxHeight: `${COLLAPSE_HEIGHT}px` }
                    : undefined
                }
              >
                {displayText}
              </div>
              {isOverflowing && !isExpanded && (
                <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-secondary to-transparent pointer-events-none" />
              )}
              {isOverflowing && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsExpanded(!isExpanded)}
                  className="relative z-10 flex items-center gap-1 mt-1 text-xs text-muted-foreground hover:text-foreground h-auto px-1 py-0.5"
                >
                  {isExpanded ? (
                    <>
                      <CaretUp size={12} />
                      <span>收起</span>
                    </>
                  ) : (
                    <>
                      <CaretDown size={12} />
                      <span>展开</span>
                    </>
                  )}
                </Button>
              )}
            </div>
          ) : <AssistantContent displayText={displayText} messageId={message.id} />
        )}
      </MessageContent>

      {/* Footer with copy, timestamp and token usage */}
      <div className={`flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 ${isUser ? 'justify-end' : ''}`}>
        {!isUser && <span className="text-xs text-muted-foreground/50">{timestamp}</span>}
        {!isUser && tokenUsage && <TokenUsageDisplay usage={tokenUsage} />}
        {displayText && <CopyButton text={displayText} />}
      </div>
    </AIMessage>
  );
});

/**
 * Memoized assistant message content — avoids re-running parseBatchPlan / parseImageGenResult /
 * parseImageGenRequest on every render when only unrelated props change.
 */
const AssistantContent = memo(function AssistantContent({ displayText, messageId }: { displayText: string; messageId: string }) {
  return useMemo(() => {
    // Try batch-plan first (Image Agent batch mode)
    const batchPlanResult = parseBatchPlan(displayText);
    if (batchPlanResult) {
      return (
        <>
          {batchPlanResult.beforeText && <MessageResponse>{batchPlanResult.beforeText}</MessageResponse>}
          <BatchPlanInlinePreview plan={batchPlanResult.plan} messageId={messageId} />
          {batchPlanResult.afterText && <MessageResponse>{batchPlanResult.afterText}</MessageResponse>}
        </>
      );
    }

    // Try image-gen-result first (new direct-call format)
    const genResult = parseImageGenResult(displayText);
    if (genResult) {
      const { result } = genResult;
      if (result.status === 'generating') {
        return (
          <>
            {genResult.beforeText && <MessageResponse>{genResult.beforeText}</MessageResponse>}
            <div className="flex items-center gap-2 py-3">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-sm text-muted-foreground">Generating image...</span>
            </div>
            {genResult.afterText && <MessageResponse>{genResult.afterText}</MessageResponse>}
          </>
        );
      }
      if (result.status === 'error') {
        return (
          <>
            {genResult.beforeText && <MessageResponse>{genResult.beforeText}</MessageResponse>}
            <div className="rounded-md border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-3">
              <p className="text-sm text-status-error-foreground">{result.error || 'Image generation failed'}</p>
            </div>
            {genResult.afterText && <MessageResponse>{genResult.afterText}</MessageResponse>}
          </>
        );
      }
      if (result.status === 'completed' && result.images && result.images.length > 0) {
        return (
          <>
            {genResult.beforeText && <MessageResponse>{genResult.beforeText}</MessageResponse>}
            <ImageGenCard
              images={result.images.map(img => ({
                data: img.data || '',
                mimeType: img.mimeType,
                localPath: img.localPath,
              }))}
              prompt={result.prompt}
              aspectRatio={result.aspectRatio}
              imageSize={result.resolution}
              model={result.model}
            />
            {genResult.afterText && <MessageResponse>{genResult.afterText}</MessageResponse>}
          </>
        );
      }
    }

    // Legacy: image-gen-request (model-dependent format, for old messages)
    const parsed = parseImageGenRequest(displayText);
    if (parsed) {
      const refs = buildReferenceImages(
        messageId,
        parsed.request.useLastGenerated || false,
        parsed.request.referenceImages,
      );
      return (
        <>
          {parsed.beforeText && <MessageResponse>{parsed.beforeText}</MessageResponse>}
          <ImageGenConfirmation
            messageId={messageId}
            initialPrompt={parsed.request.prompt}
            initialAspectRatio={parsed.request.aspectRatio}
            initialResolution={parsed.request.resolution}
            referenceImages={refs.length > 0 ? refs : undefined}
          />
          {parsed.afterText && <MessageResponse>{parsed.afterText}</MessageResponse>}
        </>
      );
    }
    const stripped = displayText
      .replace(/```image-gen-request[\s\S]*?```/g, '')
      .replace(/```image-gen-result[\s\S]*?```/g, '')
      .replace(/```batch-plan[\s\S]*?```/g, '')
      .trim();
    return stripped ? <MessageResponse>{stripped}</MessageResponse> : null;
  }, [displayText, messageId]);
});
