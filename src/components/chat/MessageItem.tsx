'use client';

import { useState, useCallback, useRef, useEffect, useMemo, memo } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import type { Message, TokenUsage, FileAttachment, MediaBlock } from '@/types';
import {
  Message as AIMessage,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';
import { ToolActionsGroup } from '@/components/ai-elements/tool-actions-group';
import { MediaPreview } from './MediaPreview';
import { DiffSummary } from './DiffSummary';
import { Button } from "@/components/ui/button";
import { Check, CaretDown, CaretUp, CaretRight } from "@/components/ui/icon";
import { CodePilotIcon } from "@/components/ui/semantic-icon";
import { FileAttachmentDisplay } from './FileAttachmentDisplay';
import { ImageGenConfirmation } from './ImageGenConfirmation';
import { ImageGenCard } from './ImageGenCard';
import { BatchPlanInlinePreview } from './batch-image-gen/BatchPlanInlinePreview';
import { WidgetRenderer } from './WidgetRenderer';
import { buildReferenceImages } from '@/lib/image-ref-store';
// SPECIES_IMAGE_URL / EGG_IMAGE_URL / RARITY_BG_GRADIENT were used by
// the assistant-chat avatar (removed 2026-05-21); the imports are kept
// out to avoid stale references.
import { parseDBDate } from '@/lib/utils';
import { usePanel } from '@/hooks/usePanel';
import { classifyPath } from '@/lib/preview-source';
import { isWriteTool, isCreateTool, extractWritePath, resolveToolPath } from '@/lib/file-write-tools';
import { DevOutputSegment } from './DevOutputChips';

// Parser functions are now sourced from @/lib/message-parsers (single source of truth).
// Re-exported here for backward compatibility with existing test imports.
export {
  parseAllShowWidgets,
  parseShowWidget,
  computePartialWidgetKey,
  parseImageGenRequest,
  parseImageGenResult,
  parseBatchPlan,
  stripStructuredBlocks,
} from '@/lib/message-parsers';
export type { WidgetSegment, ShowWidgetData } from '@/lib/message-parsers';

interface MessageItemProps {
  message: Message;
  sessionId?: string;
  /** Whether this is an assistant workspace project */
  isAssistantProject?: boolean;
  /** Assistant name for avatar */
  assistantName?: string;
}

interface ToolBlock {
  type: 'tool_use' | 'tool_result';
  id?: string;
  name?: string;
  input?: unknown;
  content?: string;
  is_error?: boolean;
  media?: MediaBlock[];
}

function parseToolBlocks(content: string): { text: string; tools: ToolBlock[]; thinking?: string } {
  const tools: ToolBlock[] = [];
  let text = '';
  let thinking: string | undefined;

  // Try to parse as JSON array (new format from chat API)
  if (content.startsWith('[')) {
    try {
      const blocks = JSON.parse(content) as Array<{
        type: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        input?: unknown;
        tool_use_id?: string;
        content?: string;
        is_error?: boolean;
      }>;

      for (const block of blocks) {
        if (block.type === 'thinking' && block.thinking) {
          thinking = block.thinking;
        } else if (block.type === 'text' && block.text) {
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
            media: (block as { media?: MediaBlock[] }).media,
          });
        }
      }

      return { text: text.trim(), tools, thinking };
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
  media?: MediaBlock[];
}> {
  const paired: Array<{
    name: string;
    input: unknown;
    result?: string;
    isError?: boolean;
    media?: MediaBlock[];
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
        media: result?.media,
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
        media: t.media,
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
        <CodePilotIcon name="copy" size={12} aria-hidden />
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

export const MessageItem = memo(function MessageItem({ message, sessionId, isAssistantProject, assistantName }: MessageItemProps) {
  const isUser = message.role === 'user';

  // Collapse/expand state for long user messages (hooks must be called unconditionally)
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Preview wiring for DiffSummary (Phase 2.3). Clicking a previewable row
  // opens the artifact panel on that file. setPreviewSource auto-flips
  // previewOpen (see AppShell.tsx setPreviewSource side effects) so callers
  // don't need to set both.
  const { setPreviewSource, workingDirectory } = usePanel();


  // Memoize expensive parsing: parseToolBlocks + pairTools
  const { text, pairedTools, thinking } = useMemo(() => {
    const { text, tools, thinking } = parseToolBlocks(message.content);
    const pairedTools = pairTools(tools);
    return { text, pairedTools, thinking };
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

  // Assistant chat avatar removed (2026-05-21) — message bubbles already
  // carry assistant/user attribution via tone + alignment; the buddy
  // egg/species portrait next to every AI reply was visual noise and
  // duplicated identity already shown elsewhere (sidebar, composer
  // header). `isAssistantProject` is kept on the props since other
  // assistant-aware paths in this file may still reference it.

  return (
    <div>
      <div className="flex-1 min-w-0">
    <AIMessage from={isUser ? 'user' : 'assistant'}>
      <MessageContent>
        {/* File attachments for user messages */}
        {isUser && files.length > 0 && (
          <FileAttachmentDisplay files={files} />
        )}

        {/* Tool calls + thinking for assistant messages — single collapsible group */}
        {!isUser && (pairedTools.length > 0 || thinking) && (
          <ToolActionsGroup
            tools={pairedTools.map((tool, i) => ({
              id: `hist-${i}`,
              name: tool.name,
              input: tool.input,
              result: tool.result,
              isError: tool.isError,
              media: tool.media,
            }))}
            thinkingContent={thinking}
          />
        )}

        {/* Media from tool results — rendered outside tool group so images stay visible */}
        {!isUser && (() => {
          const allMedia = pairedTools.flatMap(t => t.media || []);
          return allMedia.length > 0 ? <MediaPreview media={allMedia} /> : null;
        })()}

        {/* Text content */}
        {displayText && (
          isUser ? (
            <div className="relative">
              {/* Round 14 (2026-05-23): switched the long-message
                  collapse from a CSS `transition: max-height` to
                  framer-motion `animate={{ height }}`. The CSS path
                  toggled between `maxHeight: 300px` and `undefined`
                  (== auto), which cannot interpolate — so expanding
                  and collapsing snapped instantly and looked like a
                  jarring flicker. motion.div measures the real
                  content height at run-time and tweens between the
                  collapsed pixel value and "auto" smoothly.
                  `initial={false}` skips a play on first paint so
                  long messages don't unfurl when they're rendered.
                  `overflow: hidden` clips the in-flight measure. */}
              <motion.div
                ref={contentRef}
                className="text-sm whitespace-pre-wrap break-words overflow-hidden"
                initial={false}
                animate={{ height: isOverflowing && !isExpanded ? COLLAPSE_HEIGHT : "auto" }}
                transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
              >
                {displayText}
              </motion.div>
              {isOverflowing && !isExpanded && (
                <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-muted to-transparent pointer-events-none" />
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
          ) : <AssistantContent displayText={displayText} messageId={message.id} sessionId={sessionId} />
        )}
      </MessageContent>

      {/* Diff summary for assistant messages with file modifications */}
      {!isUser && (() => {
        // Phase 4: write-tool classification + path resolution now live
        // in `src/lib/file-write-tools.ts` so the same set powers both
        // the DiffSummary cards here and the codepilot:file-changed
        // dispatch in stream-session-manager. Anywhere a new variant
        // (e.g. multi_edit) lands, both surfaces pick it up.
        const modifiedFiles = pairedTools
          .filter(t => isWriteTool(t.name) && !t.isError)
          .map(t => {
            const rawPath = extractWritePath(t.input);
            const resolvedPath = resolveToolPath(rawPath, workingDirectory);
            const parts = resolvedPath.split(/[/\\]/);
            const operation: 'created' | 'modified' = isCreateTool(t.name) ? 'created' : 'modified';
            return { path: resolvedPath, name: parts[parts.length - 1] || resolvedPath, operation };
          })
          .filter(f => f.path);
        if (modifiedFiles.length === 0) return null;
        // Deduplicate by path. When the same file appears multiple times (e.g.
        // created then edited in one turn), the last tool wins — callers see
        // "Modified" rather than "Created" which matches the file's final
        // state at the end of the turn.
        const unique = [...new Map(modifiedFiles.map(f => [f.path, f])).values()];
        return (
          <DiffSummary
            files={unique}
            onPreview={(file) => {
              // Phase 4: classify the path against the session's
              // workingDirectory. Inside the workspace → workspace trust
              // + baseDir, opens directly. Outside → agent-referenced,
              // which makes PreviewPanel render a confirm card and
              // delay fetch until the user explicitly accepts (path
              // could be a sensitive location named by the AI). The
              // panel transitions to user-selected/readonly on confirm.
              const { trust, baseDir, readonly } = classifyPath(file.path, workingDirectory);
              setPreviewSource({
                kind: 'file',
                filePath: file.path,
                trust,
                ...(baseDir ? { baseDir } : {}),
                readonly,
              });
            }}
            // Phase 3: export long screenshot via the Electron IPC. Only
            // .html/.htm rows pass the PREVIEWABLE+LONGSHOT gate in
            // DiffSummary; for those, we fetch the raw file contents from
            // /api/files/preview and hand them to the long-shot helper.
            // Markdown / JSX long-shot support requires a prior render-
            // to-HTML step (Streamdown serialize for .md; esbuild compile
            // for .tsx) that's Phase 3 follow-up — DiffSummary already
            // gates the button by extension so we won't get called for
            // those unless the gate changes later.
            onExportLongShot={async (file) => {
              try {
                const { exportHtmlAsLongShot } = await import('@/lib/artifact-export');
                const qs = new URLSearchParams({ path: file.path });
                if (workingDirectory) qs.set('baseDir', workingDirectory);
                const res = await fetch(`/api/files/preview?${qs}`);
                if (!res.ok) {
                  const data = await res.json().catch(() => ({}));
                  alert(`Export failed: ${data.error || res.status}`);
                  return;
                }
                const { preview } = await res.json();
                await exportHtmlAsLongShot({
                  html: preview.content,
                  filename: file.name.replace(/\.[^.]+$/, ''),
                  width: 1024,
                });
              } catch (err) {
                alert(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }}
          />
        );
      })()}

      {/* Footer with copy, timestamp and token usage */}
      <div className={`flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 ${isUser ? 'justify-end' : ''}`}>
        {!isUser && <span className="text-xs text-muted-foreground/50">{timestamp}</span>}
        {!isUser && tokenUsage && <TokenUsageDisplay usage={tokenUsage} />}
        {displayText && <CopyButton text={displayText} />}
      </div>
    </AIMessage>
      </div>
    </div>
  );
});

/**
 * Phase 5c slice 6 (2026-05-16, post-smoke) — visible error block
 * for `show-widget` fences the parser couldn't render. Surfaces
 * three failure modes:
 *   - raw HTML body (no JSON wrapper) — the S4 smoke failure
 *   - JSON parsed but no `widget_code` field
 *   - JSON itself malformed
 *
 * Each case lands here with a structured `reason` and the original
 * fence body so the user can read it inline and ask the model to
 * retry. Pre-fix the chat looked empty in all three cases.
 */
export function MalformedWidgetNotice({ reason, raw }: { reason: string; raw: string }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="my-3 rounded-md border border-status-warning-border bg-status-warning-muted p-3 text-sm">
      <div className="font-medium text-status-warning-foreground">Malformed `show-widget` block</div>
      <div className="mt-1 text-status-warning-foreground/80">{reason}</div>
      <button
        type="button"
        className="mt-2 text-xs text-status-warning-foreground underline-offset-2 hover:underline"
        onClick={() => setShowRaw(s => !s)}
      >
        {showRaw ? 'Hide source' : 'Show source'}
      </button>
      {showRaw && (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 text-xs">
          {raw}
        </pre>
      )}
    </div>
  );
}

/** Widget wrapper with "Pin to Dashboard" button.
 * Pin triggers a chat message → AI uses codepilot_dashboard_pin MCP tool.
 * Button is a pure trigger — no local pin/unpin state tracking.
 * Brief cooldown prevents double-click. */
function PinnableWidget({ widgetCode, title }: {
  widgetCode: string; title?: string; messageId: string; sessionId?: string;
}) {
  const [cooldown, setCooldown] = useState(false);
  const { workingDirectory } = usePanel();

  const handlePin = useCallback(() => {
    if (cooldown || !workingDirectory) return;
    setCooldown(true);
    window.dispatchEvent(new CustomEvent('widget-pin-request', {
      detail: { widgetCode, title: title || 'Untitled Widget' },
    }));
    // 5s cooldown to prevent rapid duplicate pins
    setTimeout(() => setCooldown(false), 5000);
  }, [cooldown, workingDirectory, widgetCode, title]);

  const handleExport = useCallback(async () => {
    try {
      const { exportWidgetAsImage, downloadBlob } = await import('@/lib/dashboard-export');
      const blob = await exportWidgetAsImage(widgetCode);
      downloadBlob(blob, `${(title || 'widget').replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_')}.png`);
    } catch (e) {
      console.error('[PinnableWidget] Export failed:', e);
    }
  }, [widgetCode, title]);

  // Card action button class — shared geometry / colors used by widget
  // toolbar and (round 12 onwards) the Markdown table + code block
  // toolbars. h-7 / text-xs / rounded-md gives a readable hit target
  // without dominating the card chrome. Permanent (no opacity-0
  // hover gate) per round 12 design refresh.
  // `justify-center` (round 13) keeps the icon centered inside
  // icon-only variants (h-7 w-7 px-0). Without it, the icon hugs
  // the button's left edge and the hover background visibly offsets
  // from the glyph.
  const cardActionBtn = "h-7 px-2 gap-1 inline-flex items-center justify-center rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:pointer-events-none";

  const buttons = (
    <>
      {workingDirectory && (
        <button
          className={cardActionBtn}
          onClick={handlePin}
          disabled={cooldown}
        >
          <CodePilotIcon name="pin" size="sm" aria-hidden />
          Pin
        </button>
      )}
      <button
        className={cn(cardActionBtn, "h-7 w-7 px-0")}
        onClick={handleExport}
        aria-label="Export PNG"
      >
        <CodePilotIcon name="download" size="sm" aria-hidden />
      </button>
    </>
  );

  return (
    <WidgetRenderer widgetCode={widgetCode} isStreaming={false} title={title} extraButtons={buttons} />
  );
}

/**
 * Memoized assistant message content — avoids re-running parseBatchPlan / parseImageGenResult /
 * parseImageGenRequest on every render when only unrelated props change.
 */
const AssistantContent = memo(function AssistantContent({ displayText, messageId, sessionId }: { displayText: string; messageId: string; sessionId?: string }) {
  return useMemo(() => {
    // Try show-widget first (Generative UI) — supports multiple widgets interleaved with text
    const widgetSegments = parseAllShowWidgets(displayText);
    if (widgetSegments.length > 0) {
      return (
        <>
          {widgetSegments.map((seg, i) => {
            if (seg.type === 'text') {
              return <MessageResponse key={`t-${i}`}>{seg.content}</MessageResponse>;
            }
            if (seg.type === 'malformed_widget') {
              return <MalformedWidgetNotice key={`mw-${i}`} reason={seg.reason} raw={seg.raw} />;
            }
            return <PinnableWidget key={`w-${i}`} widgetCode={seg.data.widget_code} title={seg.data.title} messageId={messageId} sessionId={sessionId} />;
          })}
        </>
      );
    }

    // Try batch-plan (Image Agent batch mode)
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
            <div className="rounded-md border border-status-error-border bg-status-error-muted p-3">
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
        sessionId || '',
        parsed.request.useLastGenerated || false,
        parsed.request.referenceImages,
      );
      return (
        <>
          {parsed.beforeText && <MessageResponse>{parsed.beforeText}</MessageResponse>}
          <ImageGenConfirmation
            messageId={messageId}
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
    const stripped = stripStructuredBlocks(displayText);
    // Phase 4.D — DevOutputSegment tokenizes the assistant text for
    // file references (/abs/path:12, foo.md#L12) and localhost URLs,
    // rendering them as clickable chips alongside the streamdown
    // markdown render. Plain text without dev-output tokens falls
    // through to a normal <MessageResponse> with zero overhead.
    return stripped ? <DevOutputSegment text={stripped} /> : null;
  }, [displayText, messageId, sessionId]);
});
