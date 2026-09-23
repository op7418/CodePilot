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
  /** Called after a stream completes. Phase indicates how it ended. */
  onStreamCompleted?: (phase: string) => void;
}

export function useStreamSubscription({
  sessionId,
  setStreamSnapshot,
  setStreamingSessionId,
  setPendingApprovalSessionId,
  setMessages,
  onStreamCompleted,
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
      // If stream finished while this ChatView was unmounted, consume finalMessageContent now.
      if (existing.phase !== 'active' && existing.finalMessageContent) {
        if (existing.phase === 'completed' && !existing.saveUnconfirmed) {
          // Normal completion — both messages are persisted. Re-fetch from DB
          // to get canonical state and avoid duplicating the temp assistant message.
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
        } else {
          // Failed saves and error/stopped/idle-timeout may be missing from DB.
          // Append locally to preserve the content the user saw before unmount.
          const assistantMessage: Message = {
            id: 'temp-assistant-' + Date.now(),
            session_id: sessionId,
            role: 'assistant',
            content: existing.finalMessageContent!,
            saveUnconfirmed: existing.saveUnconfirmed,
            created_at: new Date().toISOString(),
            token_usage: existing.tokenUsage ? JSON.stringify(existing.tokenUsage) : null,
          };
          transferPendingToMessage(assistantMessage.id);
          setMessages((prev) => [...prev, assistantMessage]);
        }
        clearSnapshot(sessionId);
      }
    } else {
      setStreamSnapshot(null);
    }

    const unsubscribe = subscribe(sessionId, (event) => {
      setStreamSnapshot(event.snapshot);

      // NOTE: clearing the single-value pendingApprovalSessionId on a resolved/
      // timed-out permission lives in AppShell's global stream-session-event
      // handler (A5 Step 2 follow-up #2), NOT here — that handler runs even
      // after this ChatView unmounts (user switched sessions), and clears
      // precisely (only when the event's session left the approvals set), so a
      // per-session unconditional clear here would be both redundant and less
      // safe (could drop a peer's global under split-screen).

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
            saveUnconfirmed: event.snapshot.saveUnconfirmed,
            created_at: new Date().toISOString(),
            token_usage: event.snapshot.tokenUsage ? JSON.stringify(event.snapshot.tokenUsage) : null,
          };
          // Transfer pending reference images to this message ID
          transferPendingToMessage(assistantMessage.id);
          setMessages((prev) => [...prev, assistantMessage]);
        }

        // Clear the snapshot from the manager since we've consumed it
        clearSnapshot(sessionId);

        // Signal stream completion with the final phase so the caller can
        // decide whether DB reconciliation is safe (only on success).
        onStreamCompleted?.(event.snapshot.phase);
      }
    });

    return () => {
      unsubscribe();
      // Do NOT abort — stream continues in the manager
    };
  }, [sessionId, setStreamingSessionId, setPendingApprovalSessionId, setStreamSnapshot, setMessages, onStreamCompleted]);
}
