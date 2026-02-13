'use client';

import { useRef, useEffect } from 'react';
import type { Message, PermissionRequestEvent } from '@/types';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationEmptyState,
} from '@/components/ai-elements/conversation';
import { MessageItem } from './MessageItem';
import { StreamingMessage } from './StreamingMessage';
import { CodePilotLogo } from './CodePilotLogo';

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

interface MessageListProps {
  messages: Message[];
  streamingContent: string;
  isStreaming: boolean;
  toolUses?: ToolUseInfo[];
  toolResults?: ToolResultInfo[];
  streamingToolOutput?: string;
  statusText?: string;
  pendingPermission?: PermissionRequestEvent | null;
  onPermissionResponse?: (decision: 'allow' | 'allow_session' | 'deny') => void;
  permissionResolved?: 'allow' | 'deny' | null;
  onForceStop?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

export function MessageList({
  messages,
  streamingContent,
  isStreaming,
  toolUses = [],
  toolResults = [],
  streamingToolOutput,
  statusText,
  pendingPermission,
  onPermissionResponse,
  permissionResolved,
  onForceStop,
  hasMore,
  loadingMore,
  onLoadMore,
}: MessageListProps) {
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
    return (
      <div className="flex flex-1 items-center justify-center">
        <ConversationEmptyState
          title="Claude Chat"
          description="Start a conversation with Claude. Ask questions, get help with code, or explore ideas."
          icon={<CodePilotLogo className="h-16 w-16" />}
        />
      </div>
    );
  }

  return (
    <Conversation>
      <ConversationContent className="mx-auto max-w-3xl px-4 py-6 gap-6">
        {hasMore && (
          <div className="flex justify-center">
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              {loadingMore ? 'Loading...' : 'Load earlier messages'}
            </button>
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} id={`msg-${message.id}`}>
            <MessageItem message={message} />
          </div>
        ))}

        {isStreaming && (
          <StreamingMessage
            content={streamingContent}
            isStreaming={isStreaming}
            toolUses={toolUses}
            toolResults={toolResults}
            streamingToolOutput={streamingToolOutput}
            statusText={statusText}
            pendingPermission={pendingPermission}
            onPermissionResponse={onPermissionResponse}
            permissionResolved={permissionResolved}
            onForceStop={onForceStop}
          />
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
