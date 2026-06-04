'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import { useStickToBottomContext } from 'use-stick-to-bottom';
import { Button } from '@/components/ui/button';
import type { Message } from '@/types';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationEmptyState,
} from '@/components/ai-elements/conversation';
import { MessageItem } from './MessageItem';
import { RuntimeSwitchMarker, parseRuntimeSwitchMarker } from './RuntimeSwitchMarker';
import { TaskRunMarker } from './TaskRunMarker';
import { TaskWaitingForPermissionPanel } from './TaskWaitingForPermissionPanel';
import type { TaskRunSummary } from '@/types';
import { StreamingMessage } from './StreamingMessage';
import { MonolithIcon } from '@/components/brand/MonolithIcon';
import { SPECIES_IMAGE_URL, EGG_IMAGE_URL, RARITY_BG_GRADIENT, type Species, type Rarity } from '@/lib/buddy';

/**
 * Scrolls to bottom when streaming starts or new messages are appended.
 * Must be rendered inside <Conversation> (StickToBottom provider).
 */
function ScrollOnStream({ isStreaming, messageCount }: { isStreaming: boolean; messageCount: number }) {
  const { scrollToBottom } = useStickToBottomContext();
  const wasStreaming = useRef(false);
  const prevCount = useRef(messageCount);

  // Scroll when new messages are appended (covers optimistic user message + assistant completion)
  useEffect(() => {
    if (messageCount > prevCount.current) {
      scrollToBottom();
    }
    prevCount.current = messageCount;
  }, [messageCount, scrollToBottom]);

  useEffect(() => {
    if (isStreaming && !wasStreaming.current) {
      scrollToBottom();
    }
    wasStreaming.current = isStreaming;
  }, [isStreaming, scrollToBottom]);

  return null;
}

/**
 * Rewind button shown on user messages that have file checkpoints.
 */
function RewindButton({ sessionId, userMessageId }: { sessionId: string; userMessageId: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'preview' | 'loading' | 'done'>('idle');
  const [preview, setPreview] = useState<{ filesChanged?: string[]; insertions?: number; deletions?: number } | null>(null);

  const handleDryRun = useCallback(async () => {
    setState('loading');
    try {
      const res = await fetch('/api/chat/rewind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, userMessageId, dryRun: true }),
      });
      const data = await res.json();
      if (data.canRewind) {
        setPreview(data);
        setState('preview');
      } else {
        setState('idle');
      }
    } catch {
      setState('idle');
    }
  }, [sessionId, userMessageId]);

  const handleRewind = useCallback(async () => {
    setState('loading');
    try {
      const res = await fetch('/api/chat/rewind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, userMessageId }),
      });
      const data = await res.json();
      if (data.canRewind !== false) {
        setState('done');
        setTimeout(() => setState('idle'), 3000);
      } else {
        setState('idle');
      }
    } catch {
      setState('idle');
    }
  }, [sessionId, userMessageId]);

  if (state === 'done') {
    return (
      <span className="text-[10px] text-status-success-foreground ml-2">
        {t('messageList.rewindDone' as TranslationKey)}
      </span>
    );
  }

  if (state === 'preview' && preview) {
    return (
      <span className="inline-flex items-center gap-1.5 ml-2">
        <span className="text-[10px] text-muted-foreground">
          {preview.filesChanged?.length || 0} files, +{preview.insertions || 0}/-{preview.deletions || 0}
        </span>
        <Button
          variant="link"
          size="xs"
          onClick={handleRewind}
          className="text-[10px] text-primary h-auto p-0"
        >
          {t('messageList.rewindConfirm' as TranslationKey)}
        </Button>
        <Button
          variant="link"
          size="xs"
          onClick={() => setState('idle')}
          className="text-[10px] text-muted-foreground h-auto p-0"
        >
          {t('messageList.rewindCancel' as TranslationKey)}
        </Button>
      </span>
    );
  }

  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={handleDryRun}
      disabled={state === 'loading'}
      className="text-[10px] text-muted-foreground hover:text-foreground ml-2 opacity-0 group-hover:opacity-100 h-auto p-0"
    >
      {state === 'loading' ? '...' : t('messageList.rewindToHere' as TranslationKey)}
    </Button>
  );
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

/** Rewind points contain SDK UUIDs (not local message IDs) */
interface RewindPoint {
  userMessageId: string; // SDK UUID
}

interface MessageListProps {
  messages: Message[];
  streamingContent: string;
  isStreaming: boolean;
  toolUses?: ToolUseInfo[];
  toolResults?: ToolResultInfo[];
  streamingToolOutput?: string;
  streamingThinkingContent?: string;
  statusText?: string;
  onForceStop?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** SDK rewind points — only emitted for visible prompt-level user messages (not tool results or auto-triggers), mapped by position */
  rewindPoints?: RewindPoint[];
  sessionId?: string;
  startedAt?: number;
  /** Whether this is an assistant workspace project */
  isAssistantProject?: boolean;
  /** Assistant name for avatar display */
  assistantName?: string;
  /**
   * Phase 3 Step 4 — inline-joined task_run_logs metadata, keyed by
   * run id, delivered by `/api/chat/sessions/[id]/messages`. When a
   * message has `task_run_id` and that run is the FIRST occurrence
   * for this run id in the visible list, MessageList renders a
   * `<TaskRunMarker />` before that message. Empty / undefined when
   * no message in the page came from a scheduled task or heartbeat.
   */
  taskRuns?: Record<string, TaskRunSummary>;
  /**
   * Codex P2 — invoked after the WaitingForPermissionPanel finishes a
   * Re-run / Abandon action. The panel itself only knows the new run
   * exists in the DB; only the parent ChatView holds the message +
   * taskRuns state, so we bubble up here for it to call
   * `reconcileWithDb` (or any equivalent refresh). Without this hop,
   * `taskRuns[run.id].status` stays stuck on `'waiting_for_permission'`
   * and the panel never disappears even after the abandon PATCH lands.
   */
  onTaskRunAction?: () => void;
}

export function MessageList({
  messages,
  streamingContent,
  isStreaming,
  toolUses = [],
  toolResults = [],
  streamingToolOutput,
  streamingThinkingContent,
  statusText,
  onForceStop,
  hasMore,
  loadingMore,
  onLoadMore,
  rewindPoints = [],
  taskRuns,
  onTaskRunAction,
  sessionId,
  startedAt,
  isAssistantProject,
  assistantName,
}: MessageListProps) {
  const { t } = useTranslation();
  // Scroll anchor: preserve position when older messages are prepended
  const anchorIdRef = useRef<string | null>(null);
  // Before loading more, record the first visible message ID
  const handleLoadMore = () => {
    if (messages.length > 0) {
      anchorIdRef.current = messages[0].id;
    }
    onLoadMore?.();
  };

  // After messages are prepended, scroll the anchor element back into view.
  // Uses the anchor ID (set before loading) rather than a length comparison,
  // because a capped prepend can swap messages without changing total count.
  useEffect(() => {
    if (anchorIdRef.current) {
      const el = document.getElementById(`msg-${anchorIdRef.current}`);
      if (el) {
        el.scrollIntoView({ block: 'start' });
      }
      anchorIdRef.current = null;
    }
  }, [messages]);

  if (messages.length === 0 && !isStreaming) {
    if (isAssistantProject) {
      // Assistant workspace — show buddy or egg welcome
      const buddyInfo = typeof globalThis !== 'undefined'
        ? (globalThis as Record<string, unknown>).__codepilot_buddy_info__ as { species?: string; rarity?: string } | undefined
        : undefined;
      const hasBuddy = !!buddyInfo?.species;
      return (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-center">
            {hasBuddy ? (
              <div
                className="w-20 h-20 rounded-2xl flex items-center justify-center"
                style={{ background: RARITY_BG_GRADIENT[buddyInfo!.rarity as Rarity] || '' }}
              >
                <img
                  src={SPECIES_IMAGE_URL[buddyInfo!.species as Species] || ''}
                  alt="" width={64} height={64} className="drop-shadow-md"
                />
              </div>
            ) : (
              <img src={EGG_IMAGE_URL} alt="" width={64} height={64} className="drop-shadow-md" />
            )}
            <div className="space-y-1">
              <h3 className="font-medium text-sm">
                {hasBuddy
                  ? (assistantName || t('messageList.claudeChat'))
                  : t('buddy.adoptPrompt' as TranslationKey)}
              </h3>
              <p className="text-muted-foreground text-sm">
                {hasBuddy
                  ? t('messageList.emptyDescription')
                  : t('buddy.adoptDescription' as TranslationKey)}
              </p>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-1 items-center justify-center">
        <ConversationEmptyState
          title={t('messageList.claudeChat')}
          description={t('messageList.emptyDescription')}
          icon={<MonolithIcon className="h-16 w-16" />}
        />
      </div>
    );
  }

  return (
    <Conversation>
      <ScrollOnStream isStreaming={isStreaming} messageCount={messages.length} />
      <ConversationContent className="mx-auto max-w-3xl px-4 py-6 gap-6">
        {hasMore && (
          <div className="flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="text-muted-foreground hover:text-foreground"
            >
              {loadingMore ? t('messageList.loading') : t('messageList.loadEarlier')}
            </Button>
          </div>
        )}
        {messages.map((message, idx) => {
          // Step 4c R6 — runtime-switch transcript marker. ChatView
          // appends a marker message (`role='user'` carrying a
          // `[__RUNTIME_SWITCH__ from=X to=Y]` sentinel) whenever the
          // user flips RuntimeSelector mid-conversation. Detect and
          // render as an inline checkpoint instead of a normal user
          // bubble — same idea as `[__IMAGE_GEN_NOTICE__ ...]` already
          // does for image-gen events.

          // Performance: older messages get content-visibility:auto so
          // the browser skips layout/paint when they're off-screen.
          // Only the last VISIBLE_WINDOW messages are forced to render
          // eagerly (they're typically in or near the viewport).
          const VISIBLE_WINDOW = 50;
          const isOldMessage = idx < messages.length - VISIBLE_WINDOW;
          const contentVisibilityStyle = isOldMessage
            ? { contentVisibility: 'auto' as const, containIntrinsicBlockSize: '80px' }
            : undefined;
          if (message.role === 'user') {
            const switchPayload = parseRuntimeSwitchMarker(message.content);
            if (switchPayload) {
              return (
                <div key={message.id} id={`msg-${message.id}`} style={contentVisibilityStyle}>
                  <RuntimeSwitchMarker payload={switchPayload} />
                </div>
              );
            }
          }

          // Phase 3 Step 4 — TaskRunMarker. Render before the FIRST
          // message that belongs to a given task_run_id (vs. the
          // previous message in the list). Subsequent messages in the
          // same run don't repeat the marker.
          //
          // Critically the marker is built from the inline-joined
          // `taskRuns` map (delivered by `/api/chat/sessions/[id]/
          // messages`) — no per-marker fetch. Marker is React-only;
          // `task_run_id` is never in `message.content` and never
          // reaches the LLM prompt builder.
          let leadingMarker: React.ReactNode = null;
          if (message.task_run_id) {
            const prev = idx > 0 ? messages[idx - 1] : null;
            const prevRunId = prev?.task_run_id ?? null;
            if (prevRunId !== message.task_run_id) {
              leadingMarker = (
                <TaskRunMarker run={taskRuns?.[message.task_run_id]} />
              );
            }
          }

          // Map rewind points to visible user messages by position:
          // Backend only emits rewind_point for prompt-level user messages
          // (not tool results, not auto-trigger), so they're 1:1 with visible user messages.
          let rewindSdkUuid: string | undefined;
          if (message.role === 'user' && sessionId && rewindPoints.length > 0) {
            const userMsgsBefore = messages.filter(m => m.role === 'user');
            const userIndex = userMsgsBefore.indexOf(message);
            if (userIndex >= 0 && userIndex < rewindPoints.length) {
              rewindSdkUuid = rewindPoints[userIndex].userMessageId;
            }
          }

          return (
            <div key={message.id} id={`msg-${message.id}`} className="group" style={contentVisibilityStyle}>
              {leadingMarker}
              <MessageItem message={message} sessionId={sessionId} isAssistantProject={isAssistantProject} assistantName={assistantName} />
              {rewindSdkUuid && sessionId && !isStreaming && (
                <RewindButton sessionId={sessionId} userMessageId={rewindSdkUuid} />
              )}
            </div>
          );
        })}

        {/* Phase 3 Step 4b — when the LAST message in this session
            belongs to a waiting_for_permission run, render the
            TaskWaitingForPermissionPanel inline at the bottom of the
            transcript. The user sees the partial assistant message
            (which the runner persisted before aborting) above, then
            this panel offers Re-run / Abandon. No durable resume —
            re-run starts a fresh runId, abandon cancels the old run. */}
        {(() => {
          if (isStreaming) return null;
          if (!messages.length || !taskRuns) return null;
          const lastMsg = messages[messages.length - 1];
          if (!lastMsg.task_run_id) return null;
          const run = taskRuns[lastMsg.task_run_id];
          if (!run || run.status !== 'waiting_for_permission') return null;
          return <TaskWaitingForPermissionPanel run={run} onAction={onTaskRunAction} />;
        })()}

        {isStreaming && (
          <StreamingMessage
            content={streamingContent}
            isStreaming={isStreaming}
            sessionId={sessionId}
            startedAt={startedAt!}
            toolUses={toolUses}
            toolResults={toolResults}
            streamingToolOutput={streamingToolOutput}
            thinkingContent={streamingThinkingContent}
            statusText={statusText}
            onForceStop={onForceStop}
          />
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
