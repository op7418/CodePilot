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
import { StreamingMessage } from './StreamingMessage';
import { CodePilotLogo } from './CodePilotLogo';
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
  statusText?: string;
  onForceStop?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** SDK rewind points — only emitted for visible prompt-level user messages (not tool results or auto-triggers), mapped by position */
  rewindPoints?: RewindPoint[];
  sessionId?: string;
  /** Whether this is an assistant workspace project */
  isAssistantProject?: boolean;
  /** Assistant name for avatar display */
  assistantName?: string;
}

export function MessageList({
  messages,
  streamingContent,
  isStreaming,
  toolUses = [],
  toolResults = [],
  streamingToolOutput,
  statusText,
  onForceStop,
  hasMore,
  loadingMore,
  onLoadMore,
  rewindPoints = [],
  sessionId,
  isAssistantProject,
  assistantName,
}: MessageListProps) {
  const { t } = useTranslation();
  // Scroll anchor: preserve position when older messages are prepended
  const anchorIdRef = useRef<string | null>(null);
  const prevMessageCountRef = useRef(messages.length);

  // Before loading more, record the first visible message ID
  const handleLoadMore = () => {
    if (messages.length > 0) {
      anchorIdRef.current = messages[0].id;
    }
    onLoadMore?.();
  };

  // After messages are prepended, scroll the anchor element back into view
  useEffect(() => {
    if (anchorIdRef.current && messages.length > prevMessageCountRef.current) {
      const el = document.getElementById(`msg-${anchorIdRef.current}`);
      if (el) {
        el.scrollIntoView({ block: 'start' });
      }
      anchorIdRef.current = null;
    }
    prevMessageCountRef.current = messages.length;
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
          icon={<CodePilotLogo className="h-16 w-16" />}
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
        {messages.map((message) => {
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
            <div key={message.id} id={`msg-${message.id}`} className="group">
              <MessageItem message={message} sessionId={sessionId} isAssistantProject={isAssistantProject} assistantName={assistantName} />
              {rewindSdkUuid && sessionId && !isStreaming && (
                <RewindButton sessionId={sessionId} userMessageId={rewindSdkUuid} />
              )}
            </div>
          );
        })}

        {isStreaming && (
          <StreamingMessage
            content={streamingContent}
            isStreaming={isStreaming}
            sessionId={sessionId}
            toolUses={toolUses}
            toolResults={toolResults}
            streamingToolOutput={streamingToolOutput}
            statusText={statusText}
            onForceStop={onForceStop}
          />
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
