'use client';

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
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
import {
  MESSAGE_ROW_ESTIMATE,
  MESSAGE_ROW_OVERSCAN,
  isFirstMessageOfTaskRun,
  resolveRewindUuid,
  getWaitingPanelRun,
  findAnchorIndex,
  shouldAutoScrollOnGrowth,
} from './message-list-virtual';

/**
 * Scrolls to bottom when streaming starts or new messages are appended at the tail.
 * Must be rendered inside <Conversation> (StickToBottom provider).
 *
 * Phase 5A prepend-anchor fix: the count-growth effect must NOT fire on
 * "load earlier" prepend — inserting older messages at the head grows the count
 * but should keep the user where they were. We distinguish append vs. prepend by
 * `firstId` (messages[0]?.id): append never changes the head, prepend (incl.
 * capped-prepend that trims the tail) always changes it. When the head changes we
 * skip scrollToBottom so the virtualizer's scrollToIndex(align:'start') anchor
 * restore wins instead of yanking the user back to the newest message.
 */
function ScrollOnStream({
  isStreaming,
  messageCount,
  firstId,
}: {
  isStreaming: boolean;
  messageCount: number;
  firstId: string | undefined;
}) {
  const { scrollToBottom } = useStickToBottomContext();
  const wasStreaming = useRef(false);
  const prevCount = useRef(messageCount);
  const prevFirstId = useRef(firstId);

  // Scroll only on tail append (optimistic user message + assistant completion);
  // skip on prepend (firstId changed) so anchor restore keeps the reading position.
  useEffect(() => {
    if (shouldAutoScrollOnGrowth(prevCount.current, messageCount, prevFirstId.current, firstId)) {
      scrollToBottom();
    }
    prevCount.current = messageCount;
    prevFirstId.current = firstId;
  }, [messageCount, firstId, scrollToBottom]);

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
  onRetryLastMessage?: () => void;
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
  onRetryLastMessage,
}: MessageListProps) {
  const { t } = useTranslation();

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
      <ScrollOnStream isStreaming={isStreaming} messageCount={messages.length} firstId={messages[0]?.id} />
      <ConversationContent className="mx-auto max-w-3xl px-4 py-6 gap-6">
        <VirtualTranscript
          messages={messages}
          rewindPoints={rewindPoints}
          sessionId={sessionId}
          isStreaming={isStreaming}
          taskRuns={taskRuns}
          onTaskRunAction={onTaskRunAction}
          isAssistantProject={isAssistantProject}
          assistantName={assistantName}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={onLoadMore}
          streamingContent={streamingContent}
          toolUses={toolUses}
          toolResults={toolResults}
          streamingToolOutput={streamingToolOutput}
          streamingThinkingContent={streamingThinkingContent}
          statusText={statusText}
          onForceStop={onForceStop}
          startedAt={startedAt}
          onRetryLastMessage={onRetryLastMessage}
        />
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

interface VirtualTranscriptProps {
  messages: Message[];
  rewindPoints: RewindPoint[];
  sessionId?: string;
  isStreaming: boolean;
  taskRuns?: Record<string, TaskRunSummary>;
  onTaskRunAction?: () => void;
  isAssistantProject?: boolean;
  assistantName?: string;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  streamingContent: string;
  toolUses: ToolUseInfo[];
  toolResults: ToolResultInfo[];
  streamingToolOutput?: string;
  streamingThinkingContent?: string;
  statusText?: string;
  onForceStop?: () => void;
  startedAt?: number;
  onRetryLastMessage?: () => void;
}

/**
 * Phase 5A — 虚拟化的 transcript 主体。必须渲染在 <Conversation>
 * (StickToBottom) 内部，才能通过 `useStickToBottomContext().scrollRef`
 * 拿到真实滚动容器交给 `@tanstack/react-virtual`。
 *
 * 设计：只虚拟化 `messages`（每条消息 = 一行，marker / rewind 渲染在行内，
 * 与虚拟化前 1:1）；load-more 按钮、waiting panel、StreamingMessage 保持
 * 普通文档流的兄弟节点，行为与旧实现一致。置底 / 上滚不强拉 / 首次瞬时置底
 * 全部沿用 use-stick-to-bottom（`ScrollOnStream` + `initial="instant"` +
 * resize 自动锁底，escapedFromLock 时不打扰），本组件不重造滚动引擎。
 */
function VirtualTranscript({
  messages,
  rewindPoints,
  sessionId,
  isStreaming,
  taskRuns,
  onTaskRunAction,
  isAssistantProject,
  assistantName,
  hasMore,
  loadingMore,
  onLoadMore,
  streamingContent,
  toolUses,
  toolResults,
  streamingToolOutput,
  streamingThinkingContent,
  statusText,
  onForceStop,
  startedAt,
  onRetryLastMessage,
}: VirtualTranscriptProps) {
  const { t } = useTranslation();
  const { scrollRef } = useStickToBottomContext();

  // 虚拟列表容器（高度=totalSize，行绝对定位）。用它的 offsetTop 作为
  // react-virtual 的 scrollMargin —— 上方还有 load-more 按钮 + content
  // 的 padding，列表不是从滚动容器顶部开始的。
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  // Scroll anchor: preserve position when older messages are prepended.
  const anchorIdRef = useRef<string | null>(null);

  // A2 (audit 2026-06): 可见 user 消息列表驱动 rewind-point 位置映射；
  // memoize 一次（旧代码在 map 回调里重算 → 流式重渲染时 O(n²)）。
  const userMessages = useMemo(
    () => messages.filter((m) => m.role === 'user'),
    [messages],
  );

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => MESSAGE_ROW_ESTIMATE,
    // stable key = message.id：流式更新时不整表重挂，只有真正新增/删除才动 key。
    getItemKey: (index) => messages[index]?.id ?? index,
    // dynamic measurement：行高差异极大，每行挂载后经 `ref={virtualizer.measureElement}`
    // 用 ResizeObserver 校正真实高度（见下方虚拟行）；estimateSize 只是未测量行的种子。
    overscan: MESSAGE_ROW_OVERSCAN,
    scrollMargin,
  });

  // 重测 scrollMargin：load-more 按钮出现/消失改变列表顶部偏移。用 useEffect
  // （非 layoutEffect）避免 SSR 警告；首帧的微小偏移被 use-stick-to-bottom 的
  // initial 置底掩盖。offsetTop 只随按钮存在与否变化，与消息条数无关。
  useEffect(() => {
    if (listRef.current) {
      setScrollMargin(listRef.current.offsetTop);
    }
  }, [hasMore, loadingMore]);

  // Before loading more, record the first visible message ID.
  const handleLoadMore = useCallback(() => {
    if (messages.length > 0) {
      anchorIdRef.current = messages[0].id;
    }
    onLoadMore?.();
  }, [messages, onLoadMore]);

  // Prepend 后重新锚定。旧实现用 getElementById(`msg-…`) + scrollIntoView，
  // 虚拟化后锚点行此刻不一定在渲染窗口内，改用 virtualizer.scrollToIndex
  // (align:'start') —— 用记录的 anchorId 在 NEW 数组里查 index。capped prepend
  // 裁的是尾部新消息不是头部，锚点必然存活；查不到（-1）则跳过滚动。
  useEffect(() => {
    const anchorId = anchorIdRef.current;
    if (!anchorId) return;
    const index = findAnchorIndex(messages, anchorId);
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: 'start' });
    }
    anchorIdRef.current = null;
  }, [messages, virtualizer]);

  // 每条消息渲染成一行——与虚拟化前的 messages.map 回调逐一对应。
  const renderMessageRow = (message: Message, idx: number): React.ReactNode => {
    // Step 4c R6 — runtime-switch transcript marker. ChatView appends a
    // marker message (`role='user'` carrying a `[__RUNTIME_SWITCH__ …]`
    // sentinel) whenever the user flips RuntimeSelector mid-conversation.
    // Render as an inline checkpoint instead of a normal user bubble.
    if (message.role === 'user') {
      const switchPayload = parseRuntimeSwitchMarker(message.content);
      if (switchPayload) {
        return (
          <div id={`msg-${message.id}`} className="pb-6">
            <RuntimeSwitchMarker payload={switchPayload} />
          </div>
        );
      }
    }

    // Phase 3 Step 4 — TaskRunMarker before the FIRST message of a given
    // task_run_id. Built from the inline-joined `taskRuns` map (no per-marker
    // fetch); marker is React-only — `task_run_id` never enters `content` or
    // the LLM prompt builder.
    const leadingMarker = isFirstMessageOfTaskRun(messages, idx) && message.task_run_id
      ? <TaskRunMarker run={taskRuns?.[message.task_run_id]} />
      : null;

    // Map rewind points to visible user messages by position (backend emits
    // rewind_point only for prompt-level user messages → 1:1 with userMessages).
    const rewindSdkUuid = resolveRewindUuid({ message, userMessages, rewindPoints, sessionId });

    return (
      <div id={`msg-${message.id}`} className="group pb-6">
        {leadingMarker}
        <MessageItem
          message={message}
          sessionId={sessionId}
          isAssistantProject={isAssistantProject}
          assistantName={assistantName}
          isLastAssistant={!isStreaming && message.role === 'assistant' && idx === messages.length - 1}
          onRetry={!isStreaming && message.role === 'assistant' && idx === messages.length - 1 ? onRetryLastMessage : undefined}
        />
        {rewindSdkUuid && sessionId && !isStreaming && (
          <RewindButton sessionId={sessionId} userMessageId={rewindSdkUuid} />
        )}
      </div>
    );
  };

  const run = getWaitingPanelRun({ messages, taskRuns, isStreaming });
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <>
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

      {/* 虚拟列表容器：高度 = totalSize，行绝对定位。虚拟化前由 flex `gap-6`
          提供的行间距并入每行的 pb-6（被 measureElement 一并测量）。 */}
      <div
        ref={listRef}
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualItems.map((virtualItem) => {
          const message = messages[virtualItem.index];
          if (!message) return null;
          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${virtualItem.start - scrollMargin}px)` }}
            >
              {renderMessageRow(message, virtualItem.index)}
            </div>
          );
        })}
      </div>

      {/* Phase 3 Step 4b — when the LAST message belongs to a
          waiting_for_permission run (and not streaming), render the
          TaskWaitingForPermissionPanel inline at the bottom of the transcript. */}
      {run && (
        <TaskWaitingForPermissionPanel run={run} onAction={onTaskRunAction} />
      )}

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
    </>
  );
}
