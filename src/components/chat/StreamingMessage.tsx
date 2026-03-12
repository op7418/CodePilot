'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import {
  Message as AIMessage,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';
import { ToolActionsGroup } from '@/components/ai-elements/tool-actions-group';
import { Button } from '@/components/ui/button';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { ImageGenConfirmation } from './ImageGenConfirmation';
import { BatchPlanInlinePreview } from './batch-image-gen/BatchPlanInlinePreview';
import { PENDING_KEY, buildReferenceImages } from '@/lib/image-ref-store';
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

interface ToolUseInfo {
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultInfo {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface StreamingMessageProps {
  content: string;
  isStreaming: boolean;
  toolUses?: ToolUseInfo[];
  toolResults?: ToolResultInfo[];
  streamingToolOutput?: string;
  statusText?: string;
  onForceStop?: () => void;
}

function ElapsedTimer() {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(0);

  useEffect(() => {
    startRef.current = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  return (
    <span className="tabular-nums">
      {mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}
    </span>
  );
}

function StreamingStatusBar({ statusText, onForceStop }: { statusText?: string; onForceStop?: () => void }) {
  const displayText = statusText || 'Thinking';

  // Parse elapsed seconds from statusText like "Running bash... (45s)"
  const elapsedMatch = statusText?.match(/\((\d+)s\)/);
  const toolElapsed = elapsedMatch ? parseInt(elapsedMatch[1], 10) : 0;
  const isWarning = toolElapsed >= 60;
  const isCritical = toolElapsed >= 90;

  return (
    <div className="flex items-center gap-3 py-2 px-1 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className={isCritical ? 'text-status-error-foreground' : isWarning ? 'text-status-warning-foreground' : undefined}>
          <Shimmer duration={1.5}>{displayText}</Shimmer>
        </span>
        {isWarning && !isCritical && (
          <span className="text-status-warning-foreground text-[10px]">Running longer than usual</span>
        )}
        {isCritical && (
          <span className="text-status-error-foreground text-[10px]">Tool may be stuck</span>
        )}
      </div>
      <span className="text-muted-foreground/50">|</span>
      <ElapsedTimer />
      {isCritical && onForceStop && (
        <Button
          variant="outline"
          size="xs"
          onClick={onForceStop}
          className="ml-auto border-status-error-border bg-status-error-muted text-[10px] font-medium text-status-error-foreground hover:bg-status-error-muted"
        >
          Force stop
        </Button>
      )}
    </div>
  );
}

export function StreamingMessage({
  content,
  isStreaming,
  toolUses = [],
  toolResults = [],
  streamingToolOutput,
  statusText,
  onForceStop,
}: StreamingMessageProps) {
  const { t } = useTranslation();
  const runningTools = toolUses.filter(
    (tool) => !toolResults.some((r) => r.tool_use_id === tool.id)
  );

  // Extract a human-readable summary of the running command
  const getRunningCommandSummary = (): string | undefined => {
    if (runningTools.length === 0) {
      // All tools completed but still streaming — AI is generating text
      if (toolUses.length > 0) return 'Generating response...';
      return undefined;
    }
    const tool = runningTools[runningTools.length - 1];
    const input = tool.input as Record<string, unknown>;
    if (tool.name === 'Bash' && input.command) {
      const cmd = String(input.command);
      return cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
    }
    if (input.file_path) return `${tool.name}: ${String(input.file_path)}`;
    if (input.path) return `${tool.name}: ${String(input.path)}`;
    return `Running ${tool.name}...`;
  };

  return (
    <AIMessage from="assistant">
      <MessageContent>
        {/* Tool calls — compact collapsible group */}
        {toolUses.length > 0 && (
          <ToolActionsGroup
            tools={toolUses.map((tool) => {
              const result = toolResults.find((r) => r.tool_use_id === tool.id);
              return {
                id: tool.id,
                name: tool.name,
                input: tool.input,
                result: result?.content,
                isError: result?.is_error,
              };
            })}
            isStreaming={isStreaming}
            streamingToolOutput={streamingToolOutput}
          />
        )}

        {/* Streaming text content rendered via Streamdown */}
        {content && (() => {
          // Try batch-plan first (Image Agent batch mode)
          const batchPlanResult = parseBatchPlan(content);
          if (batchPlanResult) {
            return (
              <>
                {batchPlanResult.beforeText && <MessageResponse>{batchPlanResult.beforeText}</MessageResponse>}
                <BatchPlanInlinePreview plan={batchPlanResult.plan} messageId="streaming-preview" />
                {batchPlanResult.afterText && <MessageResponse>{batchPlanResult.afterText}</MessageResponse>}
              </>
            );
          }

          // Try image-gen-request
          const parsed = parseImageGenRequest(content);
          if (parsed) {
            const refs = buildReferenceImages(
              PENDING_KEY,
              parsed.request.useLastGenerated || false,
              parsed.request.referenceImages,
            );
            return (
              <>
                {parsed.beforeText && <MessageResponse>{parsed.beforeText}</MessageResponse>}
                <ImageGenConfirmation
                  initialPrompt={parsed.request.prompt}
                  initialAspectRatio={parsed.request.aspectRatio}
                  initialResolution={parsed.request.resolution}
                  referenceImages={refs.length > 0 ? refs : undefined}
                />
                {parsed.afterText && <MessageResponse>{parsed.afterText}</MessageResponse>}
              </>
            );
          }
          // Strip partial or unparseable code fence blocks to avoid Shiki errors
          if (isStreaming) {
            const hasImageGenBlock = /```image-gen-request/.test(content);
            const hasBatchPlanBlock = /```batch-plan/.test(content);
            const stripped = content
              .replace(/```image-gen-request[\s\S]*$/, '')
              .replace(/```batch-plan[\s\S]*$/, '')
              .trim();
            if (stripped) return <MessageResponse>{stripped}</MessageResponse>;
            // Show shimmer while the structured block is being streamed
            if (hasImageGenBlock || hasBatchPlanBlock) return <Shimmer>{t('streaming.thinking')}</Shimmer>;
            return null;
          }
          const stripped = content
            .replace(/```image-gen-request[\s\S]*?```/g, '')
            .replace(/```batch-plan[\s\S]*?```/g, '')
            .trim();
          return stripped ? <MessageResponse>{stripped}</MessageResponse> : null;
        })()}

        {/* Loading indicator when no content yet */}
        {isStreaming && !content && toolUses.length === 0 && (
          <div className="py-2">
            <Shimmer>{t('streaming.thinking')}</Shimmer>
          </div>
        )}

        {/* Status bar during streaming */}
        {isStreaming && <StreamingStatusBar statusText={statusText || getRunningCommandSummary()} onForceStop={onForceStop} />}
      </MessageContent>
    </AIMessage>
  );
}
