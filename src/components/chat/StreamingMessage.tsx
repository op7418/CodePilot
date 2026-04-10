'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import {
  Message as AIMessage,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';
import { ToolActionsGroup } from '@/components/ai-elements/tool-actions-group';
import { MediaPreview } from './MediaPreview';
import { Button } from '@/components/ui/button';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { ImageGenConfirmation } from './ImageGenConfirmation';
import { BatchPlanInlinePreview } from './batch-image-gen/BatchPlanInlinePreview';
import { WidgetRenderer } from './WidgetRenderer';
import { parseAllShowWidgets, computePartialWidgetKey } from './MessageItem';
import { PENDING_KEY, buildReferenceImages } from '@/lib/image-ref-store';
import type { PlannerOutput, MediaBlock } from '@/types';

interface ImageGenRequest {
  prompt: string;
  aspectRatio: string;
  resolution: string;
  referenceImages?: string[];
  useLastGenerated?: boolean;
}

function parseImageGenRequest(text: string): { beforeText: string; request: ImageGenRequest; afterText: string; rawBlock: string } | null {
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
      rawBlock: match[0], // full ```image-gen-request...``` block for exact matching
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
  media?: MediaBlock[];
}

interface StreamingMessageProps {
  content: string;
  isStreaming: boolean;
  sessionId?: string;
  toolUses?: ToolUseInfo[];
  toolResults?: ToolResultInfo[];
  streamingToolOutput?: string;
  thinkingContent?: string;
  statusText?: string;
  onForceStop?: () => void;
}

/**
 * Smart content buffering — holds initial text until meaningful, but bypasses
 * for structured blocks (show-widget, batch-plan, image-gen-request).
 */
const BUFFER_WORD_THRESHOLD = 40;
const BUFFER_MAX_MS = 2500;
const STRUCTURED_BLOCK_RE = /```(show-widget|batch-plan|image-gen-request)/;

function useBufferedContent(rawContent: string, isStreaming: boolean): string {
  const [bypassed, setBypassed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Derive whether bypass conditions are met (pure computation, no side effects)
  const shouldBypass = !isStreaming
    || bypassed
    || (!!rawContent && STRUCTURED_BLOCK_RE.test(rawContent))
    || (!!rawContent && rawContent.split(/\s+/).filter(Boolean).length >= BUFFER_WORD_THRESHOLD);

  // Effect: sync bypass state when conditions are met (one-way latch, safe)
  useEffect(() => {
    if (shouldBypass && !bypassed && isStreaming && rawContent) {
      setBypassed(true); // eslint-disable-line react-hooks/set-state-in-effect
    }
  }, [shouldBypass, bypassed, isStreaming, rawContent]);

  // Effect: reset on new turn (content emptied)
  useEffect(() => {
    if (!rawContent && !isStreaming) {
      setBypassed(false); // eslint-disable-line react-hooks/set-state-in-effect
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
  }, [rawContent, isStreaming]);

  // Effect: max timeout — starts once when content first arrives during streaming.
  // Uses a boolean gate (hasContent) so the timer is created exactly once, not on every delta.
  const hasContent = !!rawContent;
  useEffect(() => {
    if (!isStreaming || bypassed || !hasContent) return;
    // Only start the timer if one isn't already running
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      setBypassed(true);
      timerRef.current = null;
    }, BUFFER_MAX_MS);
    // No cleanup — timer must survive rawContent changes.
    // It is cleaned up by the reset effect (when content empties) or when bypassed is set.
  }, [isStreaming, bypassed, hasContent]);

  // Pure render: no side effects
  if (!isStreaming) return rawContent;
  if (shouldBypass) return rawContent;
  return '';
}

/**
 * Thinking phase label that evolves over time to reduce perceived wait.
 * 0-5s: "思考中..." / "Thinking..."
 * 5-15s: "深度思考中..." / "Thinking deeply..."
 * 15s+: "组织回复中..." / "Preparing response..."
 */
function ThinkingPhaseLabel() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const t1 = setTimeout(() => setPhase(1), 5000);
    const t2 = setTimeout(() => setPhase(2), 15000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  const text = phase === 0
    ? t('streaming.thinking')
    : phase === 1
      ? t('streaming.thinkingDeep')
      : t('streaming.preparing');

  return <Shimmer>{text}</Shimmer>;
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
  sessionId,
  toolUses = [],
  toolResults = [],
  streamingToolOutput,
  thinkingContent,
  statusText,
  onForceStop,
}: StreamingMessageProps) {
  const { t } = useTranslation();
  const bufferedContent = useBufferedContent(content, isStreaming);
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
        {/* Tool calls + thinking — single collapsible group */}
        {(toolUses.length > 0 || thinkingContent) && (
          <ToolActionsGroup
            tools={toolUses.map((tool) => {
              const result = toolResults.find((r) => r.tool_use_id === tool.id);
              return {
                id: tool.id,
                name: tool.name,
                input: tool.input,
                result: result?.content,
                isError: result?.is_error,
                media: result?.media,
              };
            })}
            isStreaming={isStreaming}
            streamingToolOutput={streamingToolOutput}
            thinkingContent={thinkingContent}
          />
        )}

        {/* Media from tool results — rendered outside tool group so images stay visible */}
        {(() => {
          const allMedia = toolResults.flatMap(r => r.media || []);
          return allMedia.length > 0 ? <MediaPreview media={allMedia} /> : null;
        })()}

        {/* Streaming text content rendered via Streamdown */}
        {content && (() => {
          // ── Show-widget handling ──
          // During streaming: detect partial fences FIRST to avoid premature script execution.
          // After streaming: use parseAllShowWidgets for completed fences only.
          const hasWidgetFence = /```show-widget/.test(content);

          if (hasWidgetFence && isStreaming) {
            // Streaming mode: find the last ```show-widget fence.
            // If it's closed, all fences are complete → render them all.
            // If it's open, render completed fences before it + partial preview for the open one.
            const lastFenceStart = content.lastIndexOf('```show-widget');
            const afterLastFence = content.slice(lastFenceStart);
            const lastFenceClosed = /```show-widget\s*\n?[\s\S]*?\n?\s*```/.test(afterLastFence);

            if (lastFenceClosed) {
              // All fences complete — parse and render the full content
              const allSegments = parseAllShowWidgets(content);
              return (
                <>
                  {allSegments.map((seg, i) =>
                    seg.type === 'text'
                      ? <MessageResponse key={`t-${i}`}>{seg.content}</MessageResponse>
                      : <WidgetRenderer key={`w-${i}`} widgetCode={seg.data.widget_code} isStreaming={false} title={seg.data.title} />
                  )}
                </>
              );
            }

            // Last fence is still being streamed.
            // Parse everything BEFORE it (completed fences + interleaved text).
            const beforePart = content.slice(0, lastFenceStart).trim();
            const hasCompletedFences = beforePart && /```show-widget/.test(beforePart);
            const completedSegments = hasCompletedFences ? parseAllShowWidgets(beforePart) : [];

            // Extract partial widget_code from the open fence
            const fenceBody = content.slice(lastFenceStart + '```show-widget'.length).trim();
            let partialCode: string | null = null;
            const keyIdx = fenceBody.indexOf('"widget_code"');
            if (keyIdx !== -1) {
              const colonIdx = fenceBody.indexOf(':', keyIdx + 13);
              if (colonIdx !== -1) {
                const quoteIdx = fenceBody.indexOf('"', colonIdx + 1);
                if (quoteIdx !== -1) {
                  let raw = fenceBody.slice(quoteIdx + 1);
                  raw = raw.replace(/"\s*\}\s*$/, '');
                  if (raw.endsWith('\\')) raw = raw.slice(0, -1);
                  try {
                    partialCode = raw
                      .replace(/\\\\/g, '\x00BACKSLASH\x00')
                      .replace(/\\n/g, '\n')
                      .replace(/\\t/g, '\t')
                      .replace(/\\r/g, '\r')
                      .replace(/\\"/g, '"')
                      .replace(/\x00BACKSLASH\x00/g, '\\');
                  } catch { partialCode = null; }
                }
              }
            }

            // Truncate at any unclosed <script> to prevent script content
            // from showing as visible text during streaming preview.
            // Scripts always come last per guidelines, so truncating is safe.
            let scriptsTruncated = false;
            if (partialCode) {
              const lastScript = partialCode.lastIndexOf('<script');
              if (lastScript !== -1) {
                const afterScript = partialCode.slice(lastScript);
                if (!/<script[\s\S]*?<\/script>/i.test(afterScript)) {
                  partialCode = partialCode.slice(0, lastScript).trim() || null;
                  scriptsTruncated = true;
                }
              }
            }

            let partialTitle: string | undefined;
            const titleMatch = fenceBody.match(/"title"\s*:\s*"([^"]*?)"/);
            if (titleMatch) partialTitle = titleMatch[1];

            // Key must match the map-index key that parseAllShowWidgets will produce
            // once the fence closes, so React preserves the WidgetRenderer instance.
            // See computePartialWidgetKey() for the invariant explanation.
            const partialWidgetKey = computePartialWidgetKey(content);

            return (
              <>
                {/* Plain text before the first widget fence (no completed fences yet) */}
                {!hasCompletedFences && beforePart && (
                  <MessageResponse key="pre-text">{beforePart}</MessageResponse>
                )}
                {/* Completed widget fences + interleaved text */}
                {completedSegments.map((seg, i) =>
                  seg.type === 'text'
                    ? <MessageResponse key={`t-${i}`}>{seg.content}</MessageResponse>
                    : <WidgetRenderer key={`w-${i}`} widgetCode={seg.data.widget_code} isStreaming={false} title={seg.data.title} />
                )}
                {partialCode && partialCode.length > 10 ? (
                  <WidgetRenderer key={partialWidgetKey} widgetCode={partialCode} isStreaming={true} title={partialTitle} showOverlay={scriptsTruncated} />
                ) : (
                  <Shimmer>{t('widget.loading')}</Shimmer>
                )}
              </>
            );
          }

          if (hasWidgetFence && !isStreaming) {
            // Non-streaming: all fences should be complete
            const widgetSegments = parseAllShowWidgets(content);
            if (widgetSegments.length > 0) {
              return (
                <>
                  {widgetSegments.map((seg, i) =>
                    seg.type === 'text'
                      ? <MessageResponse key={`t-${i}`}>{seg.content}</MessageResponse>
                      : <WidgetRenderer key={`w-${i}`} widgetCode={seg.data.widget_code} isStreaming={false} title={seg.data.title} />
                  )}
                </>
              );
            }
          }

          // Try batch-plan (Image Agent batch mode)
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
              sessionId || '',
              parsed.request.useLastGenerated || false,
              parsed.request.referenceImages,
            );
            return (
              <>
                {parsed.beforeText && <MessageResponse>{parsed.beforeText}</MessageResponse>}
                <ImageGenConfirmation
                  sessionId={sessionId}
                  initialPrompt={parsed.request.prompt}
                  initialAspectRatio={parsed.request.aspectRatio}
                  initialResolution={parsed.request.resolution}
                  rawRequestBlock={parsed.rawBlock}
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
            // Use bufferedContent for plain text to avoid initial character flicker
            const textToRender = bufferedContent || '';
            const stripped = textToRender
              .replace(/```image-gen-request[\s\S]*$/, '')
              .replace(/```batch-plan[\s\S]*$/, '')
              .replace(/```show-widget[\s\S]*$/, '')
              .trim();
            if (stripped) return <MessageResponse key="pre-text">{stripped}</MessageResponse>;
            // Show shimmer while the structured block is being streamed
            if (hasImageGenBlock || hasBatchPlanBlock) return <Shimmer>{t('streaming.thinking')}</Shimmer>;
            return null;
          }
          const stripped = content
            .replace(/```image-gen-request[\s\S]*?```/g, '')
            .replace(/```batch-plan[\s\S]*?```/g, '')
            .replace(/```show-widget[\s\S]*?(```|$)/g, '')
            .trim();
          return stripped ? <MessageResponse>{stripped}</MessageResponse> : null;
        })()}

        {/* Loading indicator when no content yet and no thinking content — evolves over time */}
        {isStreaming && !content && toolUses.length === 0 && !thinkingContent && (
          <div className="py-2">
            <ThinkingPhaseLabel />
          </div>
        )}

        {/* Status bar during streaming — priority: tool status > widget > generating > thinking */}
        {isStreaming && <StreamingStatusBar statusText={
          statusText
          || getRunningCommandSummary()
          || (content && /```show-widget/.test(content) ? (() => {
            // Detect if scripts are being streamed (unclosed <script> in the last open fence)
            const lastFence = content.lastIndexOf('```show-widget');
            if (lastFence !== -1) {
              const after = content.slice(lastFence);
              const fenceClosed = /```show-widget\s*\n?[\s\S]*?\n?\s*```/.test(after);
              if (!fenceClosed && /<script\b/i.test(after)) {
                return t('widget.addingInteractivity');
              }
            }
            return t('widget.streaming');
          })() : undefined)
          || (content && content.length > 0 ? t('streaming.generating') : undefined)
        } onForceStop={onForceStop} />}
      </MessageContent>
    </AIMessage>
  );
}
