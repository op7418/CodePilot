import { useEffect } from 'react';
import type { Message, SessionStreamSnapshot } from '@/types';
import {
  subscribe,
  getSnapshot,
  clearSnapshot,
} from '@/lib/stream-session-manager';
import { transferPendingToMessage } from '@/lib/image-ref-store';

interface UseStreamSubscriptionOpts {
  sessionId: string;
  setStreamSnapshot: React.Dispatch<React.SetStateAction<SessionStreamSnapshot | null>>;
  setStreamingSessionId: (id: string) => void;
  setPendingApprovalSessionId: (id: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}

export function useStreamSubscription({
  sessionId,
  setStreamSnapshot,
  setStreamingSessionId,
  setPendingApprovalSessionId,
  setMessages,
}: UseStreamSubscriptionOpts): void {
  useEffect(() => {
    // Restore snapshot if stream is already active (e.g., user switched away and back)
    const existing = getSnapshot(sessionId);
    if (existing) {
      setStreamSnapshot(existing);
      if (existing.phase === 'active') {
        setStreamingSessionId(sessionId);
      }
      if (existing.pendingPermission && !existing.permissionResolved) {
        setPendingApprovalSessionId(sessionId);
      }
      // If stream completed while this ChatView was unmounted, consume finalMessageContent now.
      // Re-fetch messages from DB to avoid duplicates (backend already persisted the reply).
      if (existing.phase !== 'active' && existing.finalMessageContent) {
        fetch(`/api/chat/sessions/${sessionId}/messages?limit=50`)
          .then(res => res.ok ? res.json() : null)
          .then(data => {
            if (data?.messages) {
              setMessages(data.messages);
            }
          })
          .catch(() => {
            // Fallback: append locally if DB fetch fails
            const assistantMessage: Message = {
              id: 'temp-assistant-' + Date.now(),
              session_id: sessionId,
              role: 'assistant',
              content: existing.finalMessageContent!,
              created_at: new Date().toISOString(),
              token_usage: existing.tokenUsage ? JSON.stringify(existing.tokenUsage) : null,
            };
            transferPendingToMessage(assistantMessage.id);
            setMessages((prev) => [...prev, assistantMessage]);
          });
        clearSnapshot(sessionId);
      }
    } else {
      setStreamSnapshot(null);
    }

    const unsubscribe = subscribe(sessionId, (event) => {
      setStreamSnapshot(event.snapshot);

      // Sync panel state
      if (event.type === 'phase-changed') {
        if (event.snapshot.phase === 'active') {
          setStreamingSessionId(sessionId);
        } else {
          setStreamingSessionId('');
          setPendingApprovalSessionId('');
        }
      }
      if (event.type === 'permission-request') {
        setPendingApprovalSessionId(sessionId);
      }
      if (event.type === 'completed') {
        setStreamingSessionId('');
        setPendingApprovalSessionId('');

        // Append the final assistant message to the messages list
        const finalContent = event.snapshot.finalMessageContent;
        if (finalContent) {
          const assistantMessage: Message = {
            id: 'temp-assistant-' + Date.now(),
            session_id: sessionId,
            role: 'assistant',
            content: finalContent,
            created_at: new Date().toISOString(),
            token_usage: event.snapshot.tokenUsage ? JSON.stringify(event.snapshot.tokenUsage) : null,
          };
          // Transfer pending reference images to this message ID
          transferPendingToMessage(assistantMessage.id);
          setMessages((prev) => [...prev, assistantMessage]);
        }

        // Clear the snapshot from the manager since we've consumed it
        clearSnapshot(sessionId);
      }
    });

    return () => {
      unsubscribe();
      // Do NOT abort — stream continues in the manager
    };
  }, [sessionId, setStreamingSessionId, setPendingApprovalSessionId, setStreamSnapshot, setMessages]);
}
