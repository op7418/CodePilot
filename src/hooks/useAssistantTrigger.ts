import { useCallback, useEffect, useRef } from 'react';
import type { Message, FileAttachment } from '@/types';
import { getLocalDateString } from '@/lib/utils';
import { startStream } from '@/lib/stream-session-manager';

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

      // Check hookTriggeredSessionId: if this session already has a trigger in progress
      // AND there are existing messages (conversation started), skip to avoid re-triggering.
      // If the session has no messages, the previous trigger may have failed — allow retry.
      if (state.hookTriggeredSessionId === sessionId && initialMessages.length > 0) return;

      const today = getLocalDateString();
      const needsOnboarding = !state.onboardingComplete;
      const needsCheckIn = state.onboardingComplete && state.lastCheckInDate !== today;

      if (!needsOnboarding && !needsCheckIn) return;

      // ── Compensation: check if a past message already contains a completion fence ──
      // This handles the case where the server-side detection also missed (e.g. crash/restart)
      // and the frontend is about to re-trigger onboarding unnecessarily.
      if (needsOnboarding && initialMessages.length > 0) {
        try {
          const { extractCompletion } = await import('@/lib/onboarding-completion');
          // Scan assistant messages from newest to oldest for an unprocessed completion
          for (let i = initialMessages.length - 1; i >= 0; i--) {
            const msg = initialMessages[i];
            if (msg.role !== 'assistant') continue;
            const completion = extractCompletion(msg.content);
            if (completion?.type === 'onboarding') {
              console.log('[useAssistantTrigger] Found unprocessed onboarding completion in message history, compensating...');
              const resp = await fetch('/api/workspace/onboarding', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ answers: completion.answers, sessionId }),
              });
              if (resp.ok) {
                await fetch('/api/workspace/hook-triggered', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ sessionId: '__clear__' }),
                }).catch(() => {});
                console.log('[useAssistantTrigger] Onboarding compensation succeeded, skipping re-trigger');
                return; // Don't re-trigger onboarding
              }
              break; // Found fence but processing failed — fall through to re-trigger
            }
          }
        } catch (e) {
          console.error('[useAssistantTrigger] Onboarding compensation check failed:', e);
        }
      }

      // For daily check-in, only trigger in the most recent session for this workspace.
      // This prevents older sessions from hijacking the check-in when reopened.
      if (needsCheckIn) {
        const latestRes = await fetch(`/api/workspace/latest-session?workingDirectory=${encodeURIComponent(data.path)}`);
        if (latestRes.ok) {
          const { sessionId: latestSessionId } = await latestRes.json();
          if (latestSessionId && latestSessionId !== sessionId) return;
        }
      }

      // Mark fired so we don't re-trigger on focus/re-render
      assistantTriggerFiredRef.current = true;

      // Mark in persistent state to prevent duplicate triggers across page reloads
      await fetch('/api/workspace/hook-triggered', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });

      // Use autoTrigger: the message is invisible (no user bubble, no title update)
      const triggerMsg = needsOnboarding
        ? '请开始助理引导设置。'
        : '请开始每日问询。';
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
