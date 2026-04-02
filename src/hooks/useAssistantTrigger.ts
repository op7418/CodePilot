import { useCallback, useEffect, useRef } from 'react';
import type { Message, FileAttachment } from '@/types';
// getLocalDateString removed — heartbeat no longer auto-triggers
import { startStream } from '@/lib/stream-session-manager';

// ── localStorage heartbeat for cross-tab liveness detection ──
// The session that owns the onboarding lock writes {sessionId, ts} every 10s.
// Other sessions check this to decide if the owner tab is still alive.
// The heartbeat is scoped: isOwnerAlive(hookTriggeredSessionId) only returns
// true if the heartbeat's sessionId matches, so a stale heartbeat from a
// completed session can't masquerade as a different session's owner.
const HEARTBEAT_KEY = 'codepilot:onboarding-heartbeat';
const HEARTBEAT_INTERVAL = 10_000;   // write every 10s
const HEARTBEAT_STALE_MS = 30_000;   // consider dead after 30s without update

/** Remove the heartbeat key only if it still belongs to the given session. */
function removeHeartbeatIfOwned(sessionId: string): void {
  try {
    const raw = localStorage.getItem(HEARTBEAT_KEY);
    if (!raw) return;
    const { sid } = JSON.parse(raw) as { sid: string };
    if (sid === sessionId) {
      localStorage.removeItem(HEARTBEAT_KEY);
    }
  } catch { /* ignore */ }
}

function startHeartbeat(sessionId: string): () => void {
  if (typeof window === 'undefined') return () => {};
  const write = () => {
    try {
      localStorage.setItem(HEARTBEAT_KEY, JSON.stringify({ sid: sessionId, ts: Date.now() }));
    } catch { /* ignore */ }
  };
  write();
  const id = setInterval(write, HEARTBEAT_INTERVAL);
  return () => {
    clearInterval(id);
    removeHeartbeatIfOwned(sessionId);
  };
}

/** Stop the heartbeat externally (called when onboarding/check-in completes). */
export function clearOnboardingHeartbeat(sessionId?: string): void {
  if (typeof window === 'undefined') return;
  if (sessionId) {
    removeHeartbeatIfOwned(sessionId);
  } else {
    // Legacy fallback: unconditional remove (only when caller doesn't know sessionId)
    try { localStorage.removeItem(HEARTBEAT_KEY); } catch { /* ignore */ }
  }
}

/**
 * Check if the tab owning the given sessionId is still alive.
 * Returns false if the heartbeat is stale, missing, or belongs to a different session.
 */
function isOwnerAlive(expectedSessionId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = localStorage.getItem(HEARTBEAT_KEY);
    if (!raw) return false;
    const { sid, ts } = JSON.parse(raw) as { sid: string; ts: number };
    if (sid !== expectedSessionId) return false;
    return Date.now() - ts < HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

interface UseAssistantTriggerOpts {
  sessionId: string;
  workingDirectory?: string;
  isStreaming: boolean;
  mode: string;
  currentModel: string;
  currentProviderId: string;
  initialMessages: Message[];
  handleModeChange: (mode: string) => void;
  buildThinkingConfig: () => { type: string } | undefined;
  sendMessageRef: React.MutableRefObject<((content: string, files?: FileAttachment[]) => Promise<void>) | undefined>;
  initMetaRef: React.MutableRefObject<{ tools?: unknown; slash_commands?: unknown; skills?: unknown } | null>;
}

export function useAssistantTrigger({
  sessionId,
  workingDirectory,
  isStreaming,
  mode,
  currentModel,
  currentProviderId,
  initialMessages,
  handleModeChange,
  buildThinkingConfig,
  sendMessageRef,
  initMetaRef,
}: UseAssistantTriggerOpts): () => void {
  const assistantTriggerFiredRef = useRef(false);
  const stopHeartbeatRef = useRef<(() => void) | null>(null);

  // Clean up heartbeat on unmount (tab close, navigation away)
  useEffect(() => {
    return () => {
      stopHeartbeatRef.current?.();
      stopHeartbeatRef.current = null;
    };
  }, []);

  // Stop heartbeat when the triggered stream finishes (onboarding/check-in completed or errored).
  // assistantTriggerFiredRef means WE started the stream; !isStreaming means it's done.
  useEffect(() => {
    if (assistantTriggerFiredRef.current && !isStreaming && stopHeartbeatRef.current) {
      stopHeartbeatRef.current();
      stopHeartbeatRef.current = null;
    }
  }, [isStreaming]);

  const checkAssistantTrigger = useCallback(async () => {
    // Don't trigger if already streaming or already triggered in this mount
    if (isStreaming || assistantTriggerFiredRef.current) return;

    try {
      const res = await fetch('/api/settings/workspace');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.path) return;

      // Check if this session's working directory matches workspace path
      if (workingDirectory !== data.path) return;

      const state = data.state;
      if (!state) return;

      // Guard against duplicate triggers across sessions:
      // 1. If ANOTHER session owns the lock, check if its tab is still alive via
      //    localStorage heartbeat. No fixed timeout — the heartbeat stops immediately
      //    when the tab closes/crashes, and we detect it within 30s.
      // 2. If THIS session already triggered and has messages, don't re-trigger.
      if (state.hookTriggeredSessionId && state.hookTriggeredSessionId !== sessionId) {
        if (isOwnerAlive(state.hookTriggeredSessionId)) {
          return; // Owning tab is still open, don't interfere
        }
        // Owner tab is gone — atomically clear the stale lock (CAS: only if owner
        // is still the stale session we observed).  If another tab already swapped
        // in, the server returns owner_mismatch and we bail out.
        try {
          const clearRes = await fetch('/api/workspace/hook-triggered', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: '__clear__',
              expectedOwner: state.hookTriggeredSessionId,
            }),
          });
          if (clearRes.ok) {
            const clearData = await clearRes.json();
            if (!clearData.success) return; // Another tab won the race
          } else {
            return;
          }
        } catch {
          return; // Can't clear, err on the safe side
        }
      }
      if (state.hookTriggeredSessionId === sessionId && initialMessages.length > 0) return;

      const needsOnboarding = !state.onboardingComplete;

      // Onboarding is now handled by the frontend Wizard component (OnboardingWizard.tsx).
      if (needsOnboarding) return;

      // Auto-trigger for:
      // 1. Buddy welcome: no buddy + empty session → adoption prompt (takes priority)
      // 2. Heartbeat: server says overdue + has buddy + empty session → full HEARTBEAT.md check
      // Buddy welcome takes priority: heartbeat defers until buddy exists.
      // Once buddy is hatched and user opens a new empty session, heartbeat fires.
      const needsBuddyWelcome = state.onboardingComplete && !state.buddy && initialMessages.length === 0;
      // Only trigger heartbeat when buddy exists — avoids collision with buddy-welcome
      const needsHeartbeat = !!data.needsHeartbeat && !!state.buddy && initialMessages.length === 0;

      if (!needsBuddyWelcome && !needsHeartbeat) return;

      // Mark fired so we don't re-trigger on focus/re-render
      assistantTriggerFiredRef.current = true;

      // Start heartbeat BEFORE marking persistent state — so the heartbeat is
      // already running when other tabs check liveness.
      stopHeartbeatRef.current?.();
      stopHeartbeatRef.current = startHeartbeat(sessionId);

      // Mark in persistent state to prevent duplicate triggers across page reloads.
      // CAS: only set owner if currently unowned (null).  If another tab set itself
      // as owner between our clear and this call, the server rejects and we bail.
      try {
        const setRes = await fetch('/api/workspace/hook-triggered', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, expectedOwner: null }),
        });
        // Bail on any non-2xx (including 500) or CAS rejection — never
        // proceed to startStream without a confirmed lock.
        if (!setRes.ok) {
          assistantTriggerFiredRef.current = false;
          stopHeartbeatRef.current?.();
          stopHeartbeatRef.current = null;
          return;
        }
        const setData = await setRes.json();
        if (!setData.success) {
          // Lost race — another tab claimed ownership
          assistantTriggerFiredRef.current = false;
          stopHeartbeatRef.current?.();
          stopHeartbeatRef.current = null;
          return;
        }
      } catch {
        // Network error — bail out
        assistantTriggerFiredRef.current = false;
        stopHeartbeatRef.current?.();
        stopHeartbeatRef.current = null;
        return;
      }

      // Use autoTrigger: the message is invisible (no user bubble, no title update)
      const triggerMsg = needsBuddyWelcome
        ? '请做自我介绍并引导用户领养伙伴。'
        : '心跳检查';
      startStream({
        sessionId,
        content: triggerMsg,
        mode,
        model: currentModel,
        providerId: currentProviderId,
        autoTrigger: true,
        thinking: buildThinkingConfig(),
        onModeChanged: (sdkMode) => {
          const uiMode = sdkMode === 'plan' ? 'plan' : 'code';
          handleModeChange(uiMode);
        },
        sendMessageFn: (retryContent: string, retryFiles?: FileAttachment[]) => {
          sendMessageRef.current?.(retryContent, retryFiles);
        },
        onInitMeta: (meta) => {
          initMetaRef.current = meta;
          console.log('[useAssistantTrigger] SDK init meta received:', meta);
        },
      });
    } catch (e) {
      console.error('[useAssistantTrigger] Assistant auto-trigger failed:', e);
    }
  }, [sessionId, workingDirectory, isStreaming, mode, currentModel, currentProviderId, handleModeChange, buildThinkingConfig, initialMessages, sendMessageRef, initMetaRef]);

  // Fire with a small delay to let the session fully initialize
  useEffect(() => {
    const timer = setTimeout(checkAssistantTrigger, 500);
    return () => clearTimeout(timer);
  }, [checkAssistantTrigger]);

  return checkAssistantTrigger;
}
