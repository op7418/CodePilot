'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import type { Message, MessagesResponse, FileAttachment, SessionStreamSnapshot, MentionRef, TaskRunSummary } from '@/types';
import { MessageList } from './MessageList';
import { NewChatWelcome } from './NewChatWelcome';
import { TerminalReasonChip } from './TerminalReasonChip';
import { RateLimitBanner } from './RateLimitBanner';
import { MessageInput } from './MessageInput';
import { ChatComposerActionBar } from './ChatComposerActionBar';
import { ModeIndicator } from './ModeIndicator';
import { RuntimeSelector } from './RuntimeSelector';
import type { ChatRuntime } from '@/lib/chat-runtime-shared';
import { ChatPermissionSelector } from './ChatPermissionSelector';
import { RunCockpit } from './RunCockpit';
import { RunCheckpoint } from './RunCheckpoint';
import { TaskCheckpoint } from './TaskCheckpoint';
import { buildCheckpoints } from '@/lib/run-checkpoint';
// Chat first-paint memory contract (2026-05-09): ChatView must NOT
// statically reach `useOverviewData` (full Settings overview snapshot,
// fans out to 6+ /api endpoints + transitively pulls runtime/effective
// + provider-catalog). RunCheckpoint here keeps only session-scoped
// reasons; global health (runtimeFallback / Claude CLI fallback)
// belongs to /settings/health and the lazy RunCockpit popover. The
// previous `computeEffectiveRuntime` + `useClaudeStatus` imports
// existed solely to compute `runtimeFallback`; with that signal
// dropped from this surface, both go away too.
import { useGlobalAgentRuntime } from '@/hooks/useGlobalAgentRuntime';
import { Button } from '@/components/ui/button';
import { usePanel } from '@/hooks/usePanel';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import { PermissionPrompt } from './PermissionPrompt';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Clock, X } from '@/components/ui/icon';
import { BatchExecutionDashboard, BatchContextSync } from './batch-image-gen';
import { setLastGeneratedImages, loadLastGenerated } from '@/lib/image-ref-store';
import { useChatCommands } from '@/hooks/useChatCommands';
import { useAssistantTrigger } from '@/hooks/useAssistantTrigger';
import { useStreamSubscription } from '@/hooks/useStreamSubscription';
import { useProviderModels } from '@/hooks/useProviderModels';
import { findModelOption } from '@/lib/model-option-match';
// Import from `chat-runtime-shared`, NOT `chat-runtime`. The latter
// transitively imports the runtime registry → claude-client → Node-only
// deps (async_hooks, Sentry, OpenTelemetry). Pulling that into a client
// bundle breaks the Next.js build with "Module not found: Can't resolve
// 'async_hooks'". `chat-runtime-shared` only ships the pure helpers /
// types and is safe for client components. See
// `src/lib/chat-runtime-shared.ts` doc-block for the full rationale.
import { agentRuntimeToChatRuntime, effectiveChatRuntime } from '@/lib/chat-runtime-shared';
import { useContextUsage } from '@/hooks/useContextUsage';
import {
  startStream,
  stopStream,
  getSnapshot,
  getRewindPoints,
  respondToPermission,
} from '@/lib/stream-session-manager';

interface QueuedMessage {
  content: string;
  files?: FileAttachment[];
  systemPromptAppend?: string;
  displayOverride?: string;
  mentions?: MentionRef[];
  /** Phase 2 Context Accounting — preserve badge-derived Skill labels
   *  across the queue so dequeued sends carry them through to producer.
   *  Codex review v4 P1 fix (2026-05-20). */
  selectedSkills?: readonly string[];
}

interface ChatViewProps {
  sessionId: string;
  initialMessages?: Message[];
  initialHasMore?: boolean;
  modelName?: string;
  providerId?: string;
  /**
   * Phase 2 Step 3b: session's stored `runtime_pin` (chat-runtime label
   * form: '' / 'claude_code' / 'codepilot_runtime'). Drives the picker
   * filter for THIS session — global `agent_runtime` flips no longer
   * cascade. Empty / undefined = "follow global" (today's behavior).
   */
  runtimePin?: string;
  initialPermissionProfile?: 'default' | 'full_access';
  initialMode?: 'code' | 'plan';
  initialHasSummary?: boolean;
}

/** Maximum messages kept in React state. Older messages are trimmed and reloaded on scroll. */
const MAX_MESSAGES_IN_MEMORY = 300;

// Terminal actions that must route through the confirm dialog (destructive /
// state-changing). Module-scoped so the Set identity is stable across renders
// (was an exhaustive-deps warning on handleTerminalAction).
const CONFIRM_REQUIRED = new Set<import('./TerminalReasonChip').TerminalActionId>([
  'compress_and_retry',
  'enable_1m_and_retry',
  'switch_to_sonnet',
  'retry_simple',
]);

export function ChatView({ sessionId, initialMessages = [], initialHasMore = false, modelName, providerId, runtimePin: initialRuntimePin, initialPermissionProfile, initialMode, initialHasSummary }: ChatViewProps) {
  const { setStreamingSessionId, workingDirectory, setPendingApprovalSessionId, setFileTreeOpen, setIsAssistantWorkspace } = usePanel();
  const { t } = useTranslation();
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  // Phase 3 Step 4 — inline-joined task_run_logs metadata for messages
  // tagged via `messages.task_run_id`. Populated from
  // `MessagesResponse.taskRuns` whenever we (re)fetch messages.
  // Used by `<MessageList />` to render `<TaskRunMarker />` without
  // per-marker fetches.
  const [taskRuns, setTaskRuns] = useState<Record<string, TaskRunSummary>>({});
  const [permissionProfile, setPermissionProfile] = useState<'default' | 'full_access'>(initialPermissionProfile || 'default');
  const [pendingContextTokens, setPendingContextTokens] = useState(0);
  // Phase 6 Phase 3 — per-source split (attachment / mention / directory).
  // Flows through RunCockpit → useContextUsage → breakdown so the popover's
  // files_attachments row renders real numbers, not 0.
  const [pendingContextSubTotals, setPendingContextSubTotals] = useState<
    import('@/lib/message-input-logic').PendingContextSubTotals | undefined
  >(undefined);

  // Whether this session's working directory matches the configured assistant workspace
  const [isAssistantProject, setIsAssistantProject] = useState(false);
  const [assistantName, setAssistantName] = useState('');

  // Workspace mismatch banner state
  const [workspaceMismatchPath, setWorkspaceMismatchPath] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);

  /** Tracks whether the tail (newest messages) was trimmed during a prepend. */
  const tailTrimmedRef = useRef(false);

  /**
   * Capped message setter for append paths (user send, stream completion, commands).
   *
   * - Normal case: trims head (oldest) when exceeding cap, sets hasMore = true.
   * - If tail was previously trimmed by a prepend (user scrolled far up): re-fetches
   *   the latest messages from DB as a fresh base, then applies the append on top.
   *   This slides the window back to the bottom without losing the new message.
   */
  /**
   * Reconcile the message window with DB after tail was trimmed.
   * Preserves local-only cmd-* messages (/help, /cost) since they're never persisted.
   * Called with a delay to ensure pending persists have completed.
   */
  const reconcileWithDb = useCallback(() => {
    fetch(`/api/chat/sessions/${sessionId}/messages?limit=50`)
      .then(res => res.ok ? res.json() : null)
      .then((data: MessagesResponse | null) => {
        if (!data?.messages) return;
        setHasMore(data.hasMore ?? true);
        // Phase 3 Step 4 — capture inline-joined task_run summaries.
        // Merge into existing map (don't replace) so older marker
        // entries from earlier pages are preserved when paging.
        if (data.taskRuns) {
          setTaskRuns(prev => ({ ...prev, ...data.taskRuns }));
        }
        const dbMessages: Message[] = data.messages;
        setMessages(current => {
          const localCommands = current.filter(m => m.id.startsWith('cmd-'));
          if (localCommands.length === 0) return dbMessages;
          const merged = [...dbMessages, ...localCommands];
          return merged.length > MAX_MESSAGES_IN_MEMORY
            ? merged.slice(-MAX_MESSAGES_IN_MEMORY)
            : merged;
        });
      })
      .catch(() => { /* keep current state as-is */ });
  }, [sessionId]);

  const cappedSetMessages: typeof setMessages = useCallback((action) => {
    setMessages((prev) => {
      const next = typeof action === 'function' ? action(prev) : action;
      if (next.length > MAX_MESSAGES_IN_MEMORY) {
        setHasMore(true);
        return next.slice(-MAX_MESSAGES_IN_MEMORY);
      }
      return next;
    });
  }, []);
  const [mode, setMode] = useState<string>(initialMode || 'code');
  const [currentModel, setCurrentModel] = useState(() => modelName || (typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-model') : null) || 'sonnet');
  // providerId='' is a LEGITIMATE historic env-mode session value — only
  // fall back to localStorage when the prop wasn't supplied at all
  // (undefined). Treating '' as falsy here would let localStorage's
  // last-used provider hijack a saved env session.
  const [currentProviderId, setCurrentProviderId] = useState(() =>
    providerId !== undefined
      ? providerId
      : (typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-provider-id') : null) || ''
  );
  const [selectedEffort, setSelectedEffort] = useState<string | undefined>(undefined);
  const [thinkingMode, setThinkingMode] = useState<string>('adaptive');
  const [context1m, setContext1m] = useState(false);
  const [hasSummary, setHasSummary] = useState(initialHasSummary || false);

  // Sync model/provider when session data loads. providerId='' is a
  // valid env-mode session value (Codex P1 review) — guard with
  // `!== undefined` rather than truthiness so an env session prop can
  // overwrite a localStorage-seeded non-empty currentProviderId.
  useEffect(() => { if (modelName) setCurrentModel(modelName); }, [modelName]);
  useEffect(() => { if (providerId !== undefined) setCurrentProviderId(providerId); }, [providerId]);

  // Phase 2 Step 4c — `runtime_pin` becomes local state so the composer
  // toolbar's RuntimeSelector can write through to it without waiting
  // for a parent reload. Initialised from the prop the page passed in
  // (loaded server-side from chat_sessions); the sync effect catches
  // session swaps. handleRuntimePinChange (declared with the other
  // handlers below) PATCHes the row and updates this state.
  const [runtimePin, setRuntimePin] = useState<string>(initialRuntimePin || '');
  useEffect(() => {
    if (initialRuntimePin !== undefined) setRuntimePin(initialRuntimePin);
  }, [initialRuntimePin]);

  // Phase 2 Step 3b — picker filter follows the SESSION's runtime pin,
  // not the global `agent_runtime`. When the user has explicitly pinned
  // this chat to Claude Code or CodePilot Runtime, that pin survives
  // global flips; when the session has no pin (legacy / unpinned new
  // chat), we resolve to the global runtime concretely.
  //
  // Phase 6 P0 (2026-05-15): hoisted `useGlobalAgentRuntime()` so we
  // can pass the resolved concrete RuntimeId to `useProviderModels`
  // instead of the old `'auto'` sentinel. With `'auto'` the hook
  // skipped per-row compat gating and the picker rendered every model
  // as enabled even under Codex Runtime — the bug the user caught.
  const globalRuntime = useGlobalAgentRuntime();
  const sessionRuntimeParam = effectiveChatRuntime(runtimePin, globalRuntime.agentRuntime);
  const {
    noCompatibleProvider,
    fetchState: providerFetchState,
    resolvedProviderId,
    resolvedModel,
    providerWasFilteredOut,
  } = useProviderModels(currentProviderId, currentModel, sessionRuntimeParam);

  // Phase 2 Step 3b — was: silently set state + PATCH the session row
  // when the runtime filter excluded the saved provider. That made an
  // open chat appear to "lose" its pinned provider after a global flip,
  // *and* the DB was rewritten without any user action — exactly the
  // drift Step 3 closes (RED #6 in the audit).
  //
  // Now: detect the mismatch and surface an inline notice instead. The
  // picker (MessageInput) still shows only runtime-compatible providers
  // so the user can pick one explicitly; once they do, the existing
  // `onProviderModelChange` path persists their choice. No silent DB
  // writes, no unannounced state changes.
  const sessionProviderRuntimeIncompatible =
    providerFetchState === 'loaded'
    && providerWasFilteredOut
    && !!currentProviderId
    && (currentProviderId !== resolvedProviderId || currentModel !== resolvedModel);

  // Phase 2 Step 4b — listen for the chat route's
  // `INVALID_SESSION_PROVIDER` 409 surfaced as a window event by
  // `stream-session-manager`. When the session's saved provider has
  // been deleted between when this chat was loaded and when the user
  // pressed send, the route refuses to send and we render an inline
  // banner that explains "your saved provider is gone — pick another
  // in the composer below" instead of letting the generic "Failed to
  // send message" toast be the only feedback.
  //
  // Cleared automatically when the user picks a real provider via
  // the picker (the existing `onProviderModelChange` →
  // `handleProviderModelChange` flow updates currentProviderId,
  // which makes the banner irrelevant; we clear on that signal).
  const [invalidSessionProvider, setInvalidSessionProvider] = useState<{
    sessionProviderId: string;
    reason: string;
  } | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string; sessionProviderId?: string; reason?: string }>).detail;
      if (!detail || detail.sessionId !== sessionId) return;
      setInvalidSessionProvider({
        sessionProviderId: detail.sessionProviderId ?? '',
        reason: detail.reason ?? 'provider-missing',
      });
      // Step 4b review fix round 3 — remove ONLY the optimistic bubble
      // that `sendMessage`/dequeue pushed for *this* failed attempt.
      // We track its id in `pendingOptimisticUserIdRef`; broad-filtering
      // every `temp-*` user message would wipe earlier successful turns
      // whose DB rows haven't replaced their optimistic copies yet (the
      // `temp-*` → real-id swap doesn't happen mid-session). Backend
      // never persisted this one (early resolver gate runs before
      // `addMessage`), so dropping the local bubble aligns transcript
      // with reality without touching prior turns.
      const pendingId = pendingOptimisticUserIdRef.current;
      if (pendingId) {
        cappedSetMessages((prev) => prev.filter((m) => m.id !== pendingId));
        pendingOptimisticUserIdRef.current = null;
      }
    };
    window.addEventListener('chat-invalid-session-provider', handler);
    return () => window.removeEventListener('chat-invalid-session-provider', handler);
  }, [sessionId, cappedSetMessages]);
  // Clear the banner once the user has picked a different provider —
  // we compare against the snapshot we received in the event so a
  // re-render with the same currentProviderId doesn't keep clearing /
  // re-flashing as picker state churns.
  useEffect(() => {
    if (!invalidSessionProvider) return;
    if (currentProviderId && currentProviderId !== invalidSessionProvider.sessionProviderId) {
      setInvalidSessionProvider(null);
    }
  }, [currentProviderId, invalidSessionProvider]);

  // Run Checkpoint signals — session-scoped only.
  //
  // An ALREADY-OPENED conversation has its own `currentProviderId/currentModel`
  // saved on chat_sessions; the global pinned-default-invalid signal
  // describes whether *new conversations* would get a valid model, which
  // has nothing to do with whether *this saved session* can still send.
  // The 2026-05-09 memory cut removes the rest of the global checks
  // (`runtimeFallback` / Claude CLI fallback) too — those are global
  // health, not session blocking, and live in /settings/health and the
  // lazy RunCockpit popover. RunCheckpoint here is purely about "can
  // this send go through":
  //   - noCompatibleProvider: session-specific (set by the picker when
  //     no provider/model pair is reachable under the active runtime)
  //   - sessionProviderRuntimeIncompatible (rendered as a separate
  //     banner just below RunCheckpoint, not piped through buildCheckpoints)
  //   - context-cost: per-send confirmation gate
  //
  // usedContextTokens reads from the same `useContextUsage` hook
  // RunCockpit uses so the cost trigger reads the SAME used count the
  // user sees in the status row.
  const usage = useContextUsage(messages, currentModel);
  const usedContextTokens = usage.used;

  const checkpointReasons = useMemo(() => {
    return buildCheckpoints({
      noCompatibleProvider,
      // Always false for an existing session — global pinned-default
      // is not this session's concern.
      defaultInvalid: false,
      pendingContextTokens,
      usedContextTokens,
    });
  }, [
    noCompatibleProvider,
    pendingContextTokens,
    usedContextTokens,
  ]);
  // (globalRuntime hoisted above near sessionRuntimeParam — Phase 6 P0,
  // 2026-05-15.)
  const blockingReasonIds = useMemo(
    () => checkpointReasons.filter((r) => r.requiresConfirm).map((r) => r.id),
    [checkpointReasons],
  );
  const handleCheckpointAction = useCallback((actionId: string) => {
    if (actionId === 'confirm-context-cost') {
      window.dispatchEvent(new Event('run-checkpoint-confirm-send'));
    }
  }, []);

  // Fetch provider-specific options with debouncing to prevent rapid API calls
  // during model switching. Uses a 300ms debounce to batch rapid changes.
  const providerOptionsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Clear any pending debounce
    if (providerOptionsDebounceRef.current) {
      clearTimeout(providerOptionsDebounceRef.current);
    }

    const pid = currentProviderId || 'env';
    const controller = new AbortController();

    // Debounce the fetch to batch rapid provider switches
    providerOptionsDebounceRef.current = setTimeout(() => {
      fetch(`/api/providers/options?providerId=${encodeURIComponent(pid)}`, { signal: controller.signal })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (!controller.signal.aborted) {
            setThinkingMode(data?.options?.thinking_mode || 'adaptive');
            setContext1m(!!data?.options?.context_1m);
          }
        })
        .catch(() => {});
    }, 300);

    return () => {
      controller.abort();
      if (providerOptionsDebounceRef.current) {
        clearTimeout(providerOptionsDebounceRef.current);
      }
    };
  }, [currentProviderId]);

  // Resolve upstream model ID for the current model/provider so the context
  // indicator can disambiguate alias windows (first-party opus = 1M vs
  // Bedrock/Vertex opus = 200K). /api/providers/models already returns
  // upstreamModelId per model on the returned groups.
  // Debounced to batch rapid model/provider switches.
  const [currentModelUpstream, setCurrentModelUpstream] = useState<string | undefined>(undefined);
  const modelUpstreamDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Clear any pending debounce
    if (modelUpstreamDebounceRef.current) {
      clearTimeout(modelUpstreamDebounceRef.current);
    }

    const pid = currentProviderId || 'env';
    const controller = new AbortController();

    // Debounce the fetch to batch rapid model/provider switches
    modelUpstreamDebounceRef.current = setTimeout(() => {
      fetch('/api/providers/models', { signal: controller.signal })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (controller.signal.aborted) return;
          const group = data?.groups?.find((g: { provider_id: string }) => g.provider_id === pid);
          // Canonical-aware (tech-debt #37): currentModel may be a canonical id
          // (`claude-opus-4-7`) while the rows are aliases (`opus`) — match by
          // either so the context-window indicator gets the right upstream.
          const models = (group?.models ?? []) as Array<{ value: string; upstreamModelId?: string }>;
          const model = findModelOption(models, currentModel);
          setCurrentModelUpstream(model?.upstreamModelId);
        })
        .catch(() => {});
    }, 300);

    return () => {
      controller.abort();
      if (modelUpstreamDebounceRef.current) {
        clearTimeout(modelUpstreamDebounceRef.current);
      }
    };
  }, [currentProviderId, currentModel]);
  useEffect(() => { if (initialPermissionProfile) setPermissionProfile(initialPermissionProfile); }, [initialPermissionProfile]);

  // Restore session-scoped last-generated images from sessionStorage
  useEffect(() => { loadLastGenerated(sessionId); }, [sessionId]);

  // Stream snapshot from the manager — drives all streaming UI
  const [streamSnapshot, setStreamSnapshot] = useState<SessionStreamSnapshot | null>(
    () => getSnapshot(sessionId)
  );

  // Derive rendering state from snapshot
  const isStreaming = streamSnapshot?.phase === 'active';
  const streamingContent = streamSnapshot?.streamingContent ?? '';
  const toolUses = streamSnapshot?.toolUses ?? [];
  const toolResults = streamSnapshot?.toolResults ?? [];
  const streamingToolOutput = streamSnapshot?.streamingToolOutput ?? '';
  const streamingThinkingContent = streamSnapshot?.streamingThinkingContent ?? '';
  const statusText = streamSnapshot?.statusText;
  const pendingPermission = streamSnapshot?.pendingPermission ?? null;
  const permissionResolved = streamSnapshot?.permissionResolved ?? null;
  const rewindPoints = getRewindPoints(sessionId);

  // ── Skill nudge banner ──
  // Listens for 'skill-nudge' window events dispatched by stream-session-manager
  // when the agent loop completes a complex multi-step workflow.
  const [skillNudge, setSkillNudge] = useState<{
    message: string;
    step: number;
    distinctToolCount: number;
    toolNames: string[];
  } | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId === sessionId) {
        setSkillNudge({
          message: detail.message || '',
          step: detail.step || 0,
          distinctToolCount: detail.distinctToolCount || 0,
          toolNames: detail.toolNames || [],
        });
      }
    };
    window.addEventListener('skill-nudge', handler);
    return () => window.removeEventListener('skill-nudge', handler);
  }, [sessionId]);

  // Clear nudge when starting a new message (new workflow begins)
  useEffect(() => {
    if (isStreaming) setSkillNudge(null);
  }, [isStreaming]);

  // ── Message queue — allows sending while AI is responding ──
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);
  const dequeuingRef = useRef(false);

  // Tracks the id of the optimistic `temp-*` user bubble that the most
  // recent send pushed onto the local transcript. Read by the
  // `chat-invalid-session-provider` handler to remove ONLY that one
  // bubble on a 409 — without this ref, broad-filtering all `temp-*`
  // user messages would also wipe earlier successful turns whose DB
  // rows haven't replaced their optimistic copies yet (the `temp-*`
  // → DB id swap doesn't always happen — once a stream completes the
  // optimistic message stays in `messages` until the next reload).
  const pendingOptimisticUserIdRef = useRef<string | null>(null);

  // Pending image generation notices
  const pendingImageNoticesRef = useRef<string[]>([]);
  const sendMessageRef = useRef<(content: string, files?: FileAttachment[], systemPromptAppend?: string, displayOverride?: string, mentions?: MentionRef[]) => Promise<void>>(undefined);
  const initMetaRef = useRef<{ tools?: unknown; slash_commands?: unknown; skills?: unknown } | null>(null);

  const handleModeChange = useCallback((newMode: string) => {
    setMode(newMode);
    if (sessionId) {
      fetch(`/api/chat/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode }),
      }).then(() => {
        window.dispatchEvent(new CustomEvent('session-updated'));
      }).catch(() => { /* silent */ });

      fetch('/api/chat/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, mode: newMode }),
      }).catch(() => { /* silent */ });
    }
  }, [sessionId]);

  const handleProviderModelChange = useCallback((
    newProviderId: string,
    model: string,
    opts?: { isAuto?: boolean },
  ) => {
    setCurrentProviderId(newProviderId);
    setCurrentModel(model);
    // Phase 6 P0 (2026-05-15) — only persist to the session row on a
    // MANUAL user pick. An auto-correct fallback (when the saved
    // model isn't in the active runtime's compatible set) must NOT
    // overwrite the session's stored (provider, model) — that would
    // make the silent fallback survive a reload + permanently lose
    // the user's last intended pin, which is exactly the kind of
    // hidden state mutation the picker is supposed to avoid.
    if (opts?.isAuto) return;
    fetch(`/api/chat/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, provider_id: newProviderId }),
    }).catch(() => {});
  }, [sessionId]);

  // Phase 2 Step 4c — RuntimeSelector callback. Optimistic local update
  // (so the picker filter and other consumers see the new pin
  // immediately) then PATCH to persist. Errors are swallowed for parity
  // with handleProviderModelChange — the next page load would surface
  // any drift via the existing 409 banner path. The PATCH route's
  // sdk_session_id cleanup logic (Step 4c track 1) handles the
  // SDK-session-can't-survive-runtime-swap case server-side.
  //
  // Step 4c R6 — when the switch happens **mid-conversation** (i.e.
  // there's already at least one user message in the transcript),
  // also append a `[__RUNTIME_SWITCH__ from=X to=Y]` marker message
  // so future scroll-back can answer "where did we change engines?".
  // We persist via the same `/api/chat/messages` POST that the
  // image-gen notice path already uses (line ~1191), and append
  // optimistically so the marker shows up before the round-trip.
  const handleRuntimePinChange = useCallback((pin: ChatRuntime) => {
    const previousPin = runtimePin;
    setRuntimePin(pin);
    fetch(`/api/chat/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtime_pin: pin }),
    }).catch(() => {});
    // Mid-conversation marker — only when there's prior content. A
    // brand-new session pre-first-message doesn't need a "switched
    // FROM something" marker.
    const hasUserTurn = messages.some((m) => m.role === 'user' && !m.id.startsWith('temp-'));
    if (!hasUserTurn) return;
    const fromPart =
      previousPin === 'claude_code' || previousPin === 'codepilot_runtime'
        ? ` from=${previousPin}`
        : '';
    const markerContent = `[__RUNTIME_SWITCH__${fromPart} to=${pin}]`;
    const markerMessage: Message = {
      id: 'temp-' + Date.now(),
      session_id: sessionId,
      role: 'user',
      content: markerContent,
      created_at: new Date().toISOString(),
      token_usage: null,
    };
    cappedSetMessages((prev) => [...prev, markerMessage]);
    fetch('/api/chat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, role: 'user', content: markerContent }),
    }).catch(() => {});
  }, [sessionId, runtimePin, messages, cappedSetMessages]);

  // ── Extracted hooks ──

  const handleStreamCompleted = useCallback((phase: string) => {
    // Only reconcile on normal completion — both messages are persisted.
    // Error/stopped/idle-timeout paths emit 'completed' before the server
    // has persisted partial output, so reconciliation would race.
    if (tailTrimmedRef.current && phase === 'completed') {
      tailTrimmedRef.current = false;
      reconcileWithDb();
    }
    // Clear the optimistic-user-id ref once any stream finishes — on
    // success the ref is no longer needed; on a non-409 error the ref
    // would otherwise dangle, and a future 409 would mistakenly read
    // a stale id. The 409 handler clears it eagerly before this fires.
    pendingOptimisticUserIdRef.current = null;
  }, [reconcileWithDb]);

  useStreamSubscription({
    sessionId,
    setStreamSnapshot,
    setStreamingSessionId,
    setPendingApprovalSessionId,
    setMessages: cappedSetMessages,
    onStreamCompleted: handleStreamCompleted,
  });

  const initializedRef = useRef(false);
  useEffect(() => {
    if (initialMessages.length > 0 && !initializedRef.current) {
      initializedRef.current = true;
      setMessages(initialMessages);
    }
  }, [initialMessages]);

  useEffect(() => { setHasMore(initialHasMore); }, [initialHasMore]);

  // Detect compression from multiple sources:
  // 1. Auto-compression: stream-session-manager dispatches 'context-compressed' event
  // 2. Manual /compact: response message contains the compression marker
  useEffect(() => {
    if (!hasSummary && messages.some(m => m.role === 'assistant' && m.content.includes('上下文已压缩'))) {
      setHasSummary(true);
    }
  }, [messages, hasSummary]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId === sessionId) {
        setHasSummary(true);
        // Phase 1b: if the user asked for "compress and retry", kick off
        // the retry now that compression actually finished. Stored flag
        // + last user message are consumed once so we can't replay
        // twice. Staleness protection uses (a) the arming-flag gate in
        // the sendMessage wrapper to clear pending state on any
        // subsequent user action, (b) the 45s timeout on the arm, and
        // (c) the session-switch clear — no per-request / compact run
        // id is wired through the SSE contract, so we rely on those
        // three clears rather than a correlation token.
        if (pendingRetryAfterCompactRef.current && pendingRetryMessageRef.current) {
          const msg = pendingRetryMessageRef.current;
          clearPendingRetry();
          // Small delay so compression SSE pipeline flushes before next send.
          setTimeout(() => {
            sendMessageRef.current?.(msg);
          }, 100);
        }
      }
    };
    window.addEventListener('context-compressed', handler);
    return () => window.removeEventListener('context-compressed', handler);
  }, [sessionId]);

  // Phase 1b — TerminalReason action state
  // Refs (not state) so the context-compressed handler above can read the
  // latest value without re-subscribing.
  const pendingRetryAfterCompactRef = useRef(false);
  const pendingRetryMessageRef = useRef<string | null>(null);
  /** Timeout handle so we don't leak a pending retry if /compact never
   *  emits context-compressed (e.g. network error, user cancels). */
  const pendingRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** True for the synchronous window where compress_and_retry is arming
   *  its own /compact call. Used by the sendMessage wrapper to avoid
   *  clearing the pending state we just set. Resets to false right after
   *  the sendMessageRef call returns (sendMessage runs its synchronous
   *  prefix — including the wrapper's stale-retry check — before the
   *  control returns here). */
  const retryArmingInProgressRef = useRef(false);

  const clearPendingRetry = useCallback(() => {
    pendingRetryAfterCompactRef.current = false;
    pendingRetryMessageRef.current = null;
    if (pendingRetryTimerRef.current) {
      clearTimeout(pendingRetryTimerRef.current);
      pendingRetryTimerRef.current = null;
    }
  }, []);

  // Safety: drop any pending retry state on session switch — stale
  // cross-session replay would be nonsense.
  useEffect(() => {
    clearPendingRetry();
  }, [sessionId, clearPendingRetry]);
  const [pendingTerminalAction, setPendingTerminalAction] = useState<{
    actionId: import('./TerminalReasonChip').TerminalActionId;
    lastUserMessage: string;
  } | null>(null);
  // Phase 2 — user can dismiss the rate-limit banner; keeps it from
  // re-rendering on snapshot updates within the same session. Resets on
  // session switch because the snapshot state itself resets.
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
  useEffect(() => { setRateLimitDismissed(false); }, [sessionId]);

  // Find the most recent user message — replay target for retry actions.
  const findLastUserMessage = useCallback((): string | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].content;
    }
    return null;
  }, [messages]);

  // Execute an action after confirmation (or immediately for non-destructive ones).
  const runTerminalAction = useCallback((actionId: import('./TerminalReasonChip').TerminalActionId, lastUserMessage: string | null) => {
    switch (actionId) {
      case 'compress_and_retry': {
        if (!lastUserMessage) return;
        // Arm the retry. Safety nets for stale-replay:
        //   - 45s timeout (in case /compact never emits context-compressed)
        //   - session switch clears it (useEffect with clearPendingRetry)
        //   - any subsequent user-initiated sendMessage clears it
        //     (including manual /compact or compress_only — per round-13
        //     Codex review: we can't rely on content equality to
        //     distinguish internal vs manual /compact since a user can
        //     type /compact themselves)
        pendingRetryAfterCompactRef.current = true;
        pendingRetryMessageRef.current = lastUserMessage;
        if (pendingRetryTimerRef.current) clearTimeout(pendingRetryTimerRef.current);
        pendingRetryTimerRef.current = setTimeout(() => {
          console.warn('[chat] compress-and-retry timed out — pending retry cleared');
          clearPendingRetry();
        }, 45_000);
        // Mark the synchronous arming window so the sendMessage wrapper
        // below skips its stale-retry clear on THIS call. The wrapper's
        // check is synchronous (runs before the first await in
        // sendMessage), so resetting the flag right after the call is
        // sufficient — no microtask deferral needed.
        retryArmingInProgressRef.current = true;
        try {
          sendMessageRef.current?.('/compact');
        } finally {
          retryArmingInProgressRef.current = false;
        }
        break;
      }
      case 'compress_only':
        // User chose "just compress, don't replay" — drop any previously
        // armed compress_and_retry so its pendingRetryMessage can't ride
        // on THIS compact's context-compressed event.
        clearPendingRetry();
        sendMessageRef.current?.('/compact');
        break;
      case 'enable_1m_and_retry':
        if (!lastUserMessage) return;
        setContext1m(true);
        // Persist per-provider so future sessions keep 1M until user opts out.
        fetch(`/api/providers/options?providerId=${encodeURIComponent(currentProviderId || 'env')}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ options: { context_1m: true } }),
        }).catch(() => {});
        setTimeout(() => sendMessageRef.current?.(lastUserMessage), 50);
        break;
      case 'switch_to_sonnet':
        if (!lastUserMessage) return;
        setCurrentModel('sonnet');
        setTimeout(() => sendMessageRef.current?.(lastUserMessage), 50);
        break;
      case 'continue_max_turns':
        sendMessageRef.current?.('continue');
        break;
      case 'retry_simple':
        if (!lastUserMessage) return;
        sendMessageRef.current?.(lastUserMessage);
        break;
      case 'open_hook_settings':
        router.push('/settings');
        break;
      case 'retry_image_upload':
        // No attachments API exposure here yet — surface a toast nudging
        // the user to re-drag the image. Full wire lands with Phase 2's
        // attachment UX work.
        import('@/hooks/useToast').then(({ showToast }) => {
          showToast({ type: 'info', message: t('terminalAction.retryImageUpload' as TranslationKey), duration: 4000 });
        }).catch(() => {});
        break;
    }
  }, [currentProviderId, router, t]);

  // Entry point from the chip. Destructive actions route through confirm
  // dialog; non-destructive ones run immediately. (CONFIRM_REQUIRED hoisted
  // to module scope below — stable Set identity, no longer a render-time dep.)
  const handleTerminalAction = useCallback((actionId: import('./TerminalReasonChip').TerminalActionId) => {
    const lastUserMessage = findLastUserMessage();
    if (CONFIRM_REQUIRED.has(actionId) && lastUserMessage) {
      setPendingTerminalAction({ actionId, lastUserMessage });
    } else {
      runTerminalAction(actionId, lastUserMessage);
    }
  }, [findLastUserMessage, runTerminalAction]);

  const buildThinkingConfig = useCallback((): { type: string } | undefined => {
    if (!thinkingMode || thinkingMode === 'adaptive') return { type: 'adaptive' };
    if (thinkingMode === 'enabled') return { type: 'enabled' };
    if (thinkingMode === 'disabled') return { type: 'disabled' };
    return undefined;
  }, [thinkingMode]);

  const checkAssistantTrigger = useAssistantTrigger({
    sessionId,
    workingDirectory,
    isStreaming,
    mode,
    resolvedModel,
    resolvedProviderId,
    noCompatibleProvider,
    fetchState: providerFetchState,
    initialMessages,
    handleModeChange,
    buildThinkingConfig,
    sendMessageRef,
    initMetaRef,
  });

  // Detect workspace mismatch
  useEffect(() => {
    if (!workingDirectory) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/settings/workspace');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;

        if (data.path && workingDirectory !== data.path) {
          setIsAssistantProject(false);
          setIsAssistantWorkspace(false);
          const inspectRes = await fetch(`/api/workspace/inspect?path=${encodeURIComponent(workingDirectory)}`);
          if (!inspectRes.ok || cancelled) return;
          const inspectData = await inspectRes.json();
          if (inspectData.hasAssistantData) {
            setWorkspaceMismatchPath(data.path);
          } else {
            setWorkspaceMismatchPath(null);
          }
        } else {
          // workingDirectory matches assistant workspace path
          const isAssistant = !!data.path;
          setIsAssistantProject(isAssistant);
          setWorkspaceMismatchPath(null);
          setIsAssistantWorkspace(isAssistant);
          // Default panel is now controlled by the user's "Default Side Panel" setting
          // in chat/[id]/page.tsx — no longer force-override for assistant workspaces.
          // Load assistant name for avatar display
          if (data.path) {
            try {
              const summaryRes = await fetch('/api/workspace/summary');
              if (summaryRes.ok && !cancelled) {
                const summary = await summaryRes.json();
                setAssistantName(summary.name || '');
                // Store buddy emoji globally for MessageItem avatar rendering
                // Store buddy info globally for MessageItem avatar rendering
                (globalThis as Record<string, unknown>).__codepilot_buddy_info__ = summary.buddy
                  ? { emoji: summary.buddy.emoji, species: summary.buddy.species, rarity: summary.buddy.rarity }
                  : undefined;
              }
            } catch { /* ignore */ }
          }
        }
      } catch {
        // ignore
      }
    })();
    return () => { cancelled = true; };
    // setIsAssistantWorkspace is a stable useState setter (AppShell) — safe to list.
  }, [workingDirectory, setIsAssistantWorkspace]);

  // Listen for workspace-switched events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.newPath && workingDirectory && workingDirectory === detail.oldPath) {
        setWorkspaceMismatchPath(detail.newPath);
      }
    };
    window.addEventListener('assistant-workspace-switched', handler);
    return () => window.removeEventListener('assistant-workspace-switched', handler);
  }, [workingDirectory]);

  const handleOpenNewAssistant = useCallback(async () => {
    try {
      const model = typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-model') || '' : '';
      const provider_id = typeof window !== 'undefined' ? localStorage.getItem('codepilot:last-provider-id') || '' : '';
      const res = await fetch('/api/workspace/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'checkin', model, provider_id }),
      });
      if (res.ok) {
        const data = await res.json();
        window.dispatchEvent(new CustomEvent('session-created'));
        router.push(`/chat/${data.session.id}`);
      }
    } catch (e) {
      console.error('[ChatView] Failed to open assistant session:', e);
    }
  }, [router]);

  const loadEarlierMessages = useCallback(async () => {
    if (loadingMoreRef.current || !hasMore || messages.length === 0) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const earliest = messages[0];
      const earliestRowId = (earliest as Message & { _rowid?: number })._rowid;
      if (!earliestRowId) return;
      const res = await fetch(`/api/chat/sessions/${sessionId}/messages?limit=100&before=${earliestRowId}`);
      if (!res.ok) return;
      const data: MessagesResponse = await res.json();
      setHasMore(data.hasMore ?? false);
      if (data.messages.length > 0) {
        setMessages(prev => {
          const merged = [...data.messages, ...prev];
          if (merged.length > MAX_MESSAGES_IN_MEMORY) {
            // Trim newest messages off the tail — they'll be restored when
            // the next append triggers cappedSetMessages (re-fetches from DB).
            tailTrimmedRef.current = true;
            return merged.slice(0, MAX_MESSAGES_IN_MEMORY);
          }
          return merged;
        });
      }
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [sessionId, messages, hasMore]);

  const stopStreaming = useCallback(() => { stopStream(sessionId); }, [sessionId]);

  const handlePermissionResponse = useCallback(
    async (decision: 'allow' | 'allow_session' | 'deny', updatedInput?: Record<string, unknown>, denyMessage?: string) => {
      setPendingApprovalSessionId('');
      await respondToPermission(sessionId, decision, updatedInput, denyMessage);
    },
    [sessionId, setPendingApprovalSessionId]
  );

  /** Start an API stream for the given content. Does NOT add a user message to the list. */
  const doStartStream = useCallback(
    (content: string, files?: FileAttachment[], systemPromptAppend?: string, displayOverride?: string, mentions?: MentionRef[], selectedSkills?: readonly string[]) => {
      // Guard 1: idle = picker feed hasn't loaded yet. We don't know
      // what the runtime gate would have done with the saved pair, so
      // we can't safely fire — letting it through with raw values
      // would let a stale incompatible pair reach /api/chat where it
      // gets re-resolved against env defaults. Block until loaded.
      if (providerFetchState === 'idle') {
        console.warn('[ChatView] startStream suppressed: provider feed still loading');
        return;
      }
      // Guard 2: refuse when the active runtime has no compatible
      // provider at all (catch-all for empty filtered set).
      if (noCompatibleProvider) {
        console.warn('[ChatView] startStream suppressed: no provider compatible with active runtime');
        return;
      }
      // Guard 3: only after fetch settles, refuse when resolved pair is
      // empty. failed branch (API down) still has the synthetic env
      // group from the catch path, so resolved pair stays populated.
      if (providerFetchState === 'loaded' && (!resolvedProviderId || !resolvedModel)) {
        console.warn('[ChatView] startStream suppressed: resolved provider/model is empty');
        return;
      }
      // Guard 4 (Phase 2 Step 3b review): when the session's saved
      // provider isn't reachable under the current execution engine,
      // refuse to send. Without this, the wire-decision below would
      // pick `resolvedProviderId/resolvedModel` (the runtime-filtered
      // *fallback*) and the chat route's lazy-seed path would persist
      // them onto the session row — the silent rewrite the Step 3b
      // inline-notice fix was supposed to prevent. User must pick a
      // new provider in the picker (still reachable in the composer)
      // BEFORE this turn can fire. The matching MessageInput
      // `disabled` flag is set in the JSX below so the send button
      // visibly reflects the same gate.
      if (sessionProviderRuntimeIncompatible) {
        console.warn('[ChatView] startStream suppressed: session provider runtime-incompatible — user must pick another in the composer');
        return;
      }
      const notices = pendingImageNoticesRef.current.length > 0
        ? [...pendingImageNoticesRef.current]
        : undefined;
      if (notices) pendingImageNoticesRef.current = [];

      // Wire decision:
      //   - loaded → use resolved pair (runtime-filtered truth).
      //   - failed → fall back to raw currentModel/currentProviderId.
      //     The catch-branch env synthetic also surfaces via resolved,
      //     so this fallback only triggers in the rare case where the
      //     resolved fields haven't populated yet on a failure path.
      // (idle is already gated above, never reaches here.)
      const sendModel = providerFetchState === 'loaded' ? resolvedModel : (resolvedModel || currentModel);
      const sendProviderId = providerFetchState === 'loaded' ? resolvedProviderId : (resolvedProviderId || currentProviderId);
      startStream({
        sessionId,
        content,
        mode,
        model: sendModel,
        providerId: sendProviderId,
        files,
        workingDirectory,
        systemPromptAppend,
        pendingImageNotices: notices,
        // 'auto' sentinel means "no explicit effort" — filter it here so
        // the CLI applies its per-model default (Opus 4.7 → xhigh, etc.)
        effort: selectedEffort && selectedEffort !== 'auto' ? selectedEffort : undefined,
        thinking: buildThinkingConfig(),
        context1m,
        displayOverride,
        mentions,
        selectedSkills,
        onModeChanged: (sdkMode) => {
          const uiMode = sdkMode === 'plan' ? 'plan' : 'code';
          handleModeChange(uiMode);
        },
        sendMessageFn: (retryContent: string, retryFiles?: FileAttachment[]) => {
          sendMessageRef.current?.(retryContent, retryFiles);
        },
        onInitMeta: (meta) => {
          initMetaRef.current = meta;
          console.log('[ChatView] SDK init meta received:', meta);
        },
      });
    },
    [sessionId, mode, currentModel, currentProviderId, selectedEffort, context1m, buildThinkingConfig, handleModeChange, noCompatibleProvider, providerFetchState, resolvedProviderId, resolvedModel, sessionProviderRuntimeIncompatible]
  );

  const sendMessage = useCallback(
    async (content: string, files?: FileAttachment[], systemPromptAppend?: string, displayOverride?: string, mentions?: MentionRef[], selectedSkills?: readonly string[]) => {
      // Hoist provider-state guards above message append. Without this
      // sendMessage would write a user bubble into the local list and
      // *then* doStartStream would refuse to fire — leaving the user
      // staring at their own message with no response. Auto-trigger /
      // command paths can reach this even when MessageInput is disabled,
      // so the early-outs have to live here too.
      if (providerFetchState === 'idle') {
        console.warn('[ChatView] sendMessage suppressed: provider feed still loading');
        return;
      }
      if (noCompatibleProvider) {
        console.warn('[ChatView] sendMessage suppressed: no provider compatible with active runtime');
        return;
      }
      // Mirror doStartStream's Guard 4 *before* we push the optimistic
      // bubble. MessageInput's disabled prop already blocks the typical
      // click-to-send path when this flag is true, but autoTrigger /
      // widget bridge / pendingRetryAfterCompact callbacks bypass the
      // input and call sendMessage directly. Without this guard those
      // paths would push a temp-* user bubble, then doStartStream would
      // refuse to fire — same ghost-message shape Step 4b just fixed.
      if (sessionProviderRuntimeIncompatible) {
        console.warn('[ChatView] sendMessage suppressed: session provider not compatible with active runtime — pick a different provider in the composer');
        return;
      }

      const displayUserContent = displayOverride || content;
      let displayContent = displayUserContent;
      if (files && files.length > 0) {
        // Optimistic save preserves the base64 `data` so the bubble can
        // render images immediately (FileAttachmentDisplay's `fileUrl`
        // prefers `data` → `filePath`). Without `data`, every image
        // optimistically falls back to a generic file icon until the
        // page reloads with the DB-persisted `filePath`. Backend's
        // POST handler still strips `data` before persisting, and the
        // GET messages route re-strips on read — so DB stays lean.
        const fileMeta = files.map(f => ({ id: f.id, name: f.name, type: f.type, size: f.size, data: f.data }));
        displayContent = `<!--files:${JSON.stringify(fileMeta)}-->${displayUserContent}`;
      }

      // Phase 1b safety: if a compress_and_retry is armed, drop it
      // whenever the user sends ANY new content — including a manual
      // /compact typed themselves or a "仅压缩" click. Without this, a
      // retry queued by Action Chip would piggyback on a later
      // user-initiated /compact's context-compressed event and replay
      // the old lastUserMessage out of order.
      //
      // The retryArmingInProgressRef flag excludes the one
      // synchronous call the compress_and_retry action itself makes
      // through this wrapper — that call must NOT clear the state it
      // just set. runTerminalAction flips the flag on before calling
      // sendMessageRef and off again right after.
      if (pendingRetryAfterCompactRef.current && !retryArmingInProgressRef.current) {
        clearPendingRetry();
      }

      // Queue message if currently streaming — hold above input, send after completion
      if (isStreaming) {
        setMessageQueue((prev) => [...prev, { content, files, systemPromptAppend, displayOverride, mentions, selectedSkills }]);
        return;
      }

      const userMessage: Message = {
        id: 'temp-' + Date.now(),
        session_id: sessionId,
        role: 'user',
        content: displayContent,
        created_at: new Date().toISOString(),
        token_usage: null,
      };
      pendingOptimisticUserIdRef.current = userMessage.id;
      cappedSetMessages((prev) => [...prev, userMessage]);
      doStartStream(content, files, systemPromptAppend, displayOverride, mentions, selectedSkills);
    },
    [sessionId, isStreaming, doStartStream, cappedSetMessages, noCompatibleProvider, providerFetchState, sessionProviderRuntimeIncompatible]
  );

  sendMessageRef.current = sendMessage;

  // ── Dequeue: when streaming finishes and queue is non-empty, send next ──
  useEffect(() => {
    if (!isStreaming && messageQueue.length > 0 && !dequeuingRef.current) {
      // Same hoisted guards as sendMessage. Idle = wait (re-runs when
      // fetchState transitions). noCompatible = drop the queue so it
      // doesn't loop on a provider that's never coming back.
      if (providerFetchState === 'idle') {
        return;
      }
      if (noCompatibleProvider) {
        console.warn('[ChatView] dequeue suppressed: no provider compatible with active runtime');
        setMessageQueue([]);
        return;
      }
      // Mirror sendMessage's runtime-incompatible guard. Without this
      // the dequeue would push a temp-* user bubble for the queued
      // message and then doStartStream's Guard 4 would refuse to fire
      // — same ghost-message shape as Step 4b round 2/3 just fixed,
      // just on the queue path. We *hold* the queue (vs. clear) here
      // because the user can fix this themselves by picking a
      // compatible provider in the composer; once `sessionProviderRuntimeIncompatible`
      // flips back to false the effect re-runs and dequeues normally.
      // The flag is in the dep array so the re-run actually happens.
      if (sessionProviderRuntimeIncompatible) {
        console.warn('[ChatView] dequeue held: session provider not compatible with active runtime — waiting for user to pick a different provider');
        return;
      }
      dequeuingRef.current = true;
      const [next, ...rest] = messageQueue;
      setMessageQueue(rest);
      // Add the queued message to the conversation as a normal user message
      const displayUserContent = next.displayOverride || next.content;
      let displayContent = displayUserContent;
      if (next.files && next.files.length > 0) {
        // Same optimistic-data preservation as the primary send path —
        // queued messages also need to render images immediately.
        const fileMeta = next.files.map(f => ({ id: f.id, name: f.name, type: f.type, size: f.size, data: f.data }));
        displayContent = `<!--files:${JSON.stringify(fileMeta)}-->${displayUserContent}`;
      }
      const userMessage: Message = {
        id: 'temp-' + Date.now(),
        session_id: sessionId,
        role: 'user',
        content: displayContent,
        created_at: new Date().toISOString(),
        token_usage: null,
      };
      pendingOptimisticUserIdRef.current = userMessage.id;
      cappedSetMessages((prev) => [...prev, userMessage]);
      doStartStream(next.content, next.files, next.systemPromptAppend, next.displayOverride, next.mentions, next.selectedSkills);
    }
    if (isStreaming) {
      dequeuingRef.current = false;
    }
  }, [isStreaming, messageQueue, doStartStream, cappedSetMessages, sessionId, noCompatibleProvider, providerFetchState, sessionProviderRuntimeIncompatible]);

  // Expose widget drill-down bridge: widgets can call window.__widgetSendMessage(text)
  // to trigger follow-up questions (e.g. clicking a node to get deeper explanation)
  // Hardened: type-checked, length-limited, rate-limited, sanitized.
  useEffect(() => {
    let lastCallTime = 0;
    const RATE_LIMIT_MS = 2000;
    const MAX_LENGTH = 500;

    const bridge = (text: unknown) => {
      if (typeof text !== 'string') return;
      const trimmed = text.trim();
      if (!trimmed || trimmed.length > MAX_LENGTH) return;

      // Rate limit: max one message per 2 seconds
      const now = Date.now();
      if (now - lastCallTime < RATE_LIMIT_MS) return;
      lastCallTime = now;

      sendMessageRef.current?.(trimmed);
    };
    (window as unknown as Record<string, unknown>).__widgetSendMessage = bridge;
    return () => {
      delete (window as unknown as Record<string, unknown>).__widgetSendMessage;
    };
  }, []);

  // Listen for widget pin requests from PinnableWidget buttons.
  // The AI model receives the widget code + instructions and calls the
  // codepilot_dashboard_pin MCP tool to complete the pin operation.
  useEffect(() => {
    const handler = (e: Event) => {
      const { widgetCode, title } = (e as CustomEvent).detail || {};
      if (!widgetCode || !sendMessageRef.current) return;

      const instruction = `请将下面的可视化组件固定到项目看板。\n\n标题建议：${title || 'Untitled'}\n\n组件代码：\n${widgetCode}`;
      sendMessageRef.current(instruction, undefined, undefined, `📌 固定「${title || 'Widget'}」到看板`);
    };
    window.addEventListener('widget-pin-request', handler);
    return () => window.removeEventListener('widget-pin-request', handler);
  }, []);

  // Listen for dashboard widget drilldown (click title → conversation)
  useEffect(() => {
    const handler = (e: Event) => {
      const { title, dataContract } = (e as CustomEvent).detail || {};
      if (!title || !sendMessageRef.current) return;
      sendMessageRef.current(
        `请深入分析看板组件「${title}」的数据。\n数据契约：${dataContract || '无'}`,
        undefined, undefined,
        `🔍 分析「${title}」`,
      );
    };
    window.addEventListener('dashboard-widget-drilldown', handler);
    return () => window.removeEventListener('dashboard-widget-drilldown', handler);
  }, []);

  // Listen for dashboard command input
  useEffect(() => {
    const handler = (e: Event) => {
      const { text } = (e as CustomEvent).detail || {};
      if (!text || !sendMessageRef.current) return;
      sendMessageRef.current(text, undefined, undefined, text);
    };
    window.addEventListener('dashboard-command', handler);
    return () => window.removeEventListener('dashboard-command', handler);
  }, []);

  const handleCommand = useChatCommands({ sessionId, messages, setMessages: cappedSetMessages, sendMessage });

  // Listen for image generation completion
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      const paths = (detail.images || [])
        .map((img: { localPath?: string }) => img.localPath)
        .filter(Boolean);
      const pathInfo = paths.length > 0 ? `\nGenerated image file paths:\n${paths.map((p: string) => `- ${p}`).join('\n')}` : '';
      const notice = `[Image generation completed]\n- Prompt: "${detail.prompt}"\n- Aspect ratio: ${detail.aspectRatio}\n- Resolution: ${detail.resolution}${pathInfo}`;

      if (paths.length > 0) {
        setLastGeneratedImages(sessionId, paths);
      }

      pendingImageNoticesRef.current.push(notice);

      const dbNotice = `[__IMAGE_GEN_NOTICE__ prompt: "${detail.prompt}", aspect ratio: ${detail.aspectRatio}, resolution: ${detail.resolution}${paths.length > 0 ? `, file path: ${paths.join(', ')}` : ''}]`;
      fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, role: 'user', content: dbNotice }),
      }).catch(() => {});
    };
    window.addEventListener('image-gen-completed', handler);
    return () => window.removeEventListener('image-gen-completed', handler);
  }, [sessionId]);

  // New-chat layout (2026-05-21): when a session exists but has no
  // messages yet and is NOT actively streaming, render the same
  // centered logo + welcome + composer hero as /chat (the
  // session-less landing). Covers "clicked + on a project" and
  // "clicked + in the assistant workspace" — both create an empty
  // session and land here.
  const isNewChat = messages.length === 0 && !isStreaming;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Workspace mismatch banner */}
      {workspaceMismatchPath && (
        <div className="flex items-center justify-between gap-3 border-b border-status-warning/30 bg-status-warning-muted px-4 py-2">
          <span className="text-xs text-status-warning-foreground">
            {t('assistant.switchedBanner', { path: workspaceMismatchPath })}
          </span>
          <Button
            onClick={handleOpenNewAssistant}
            className="shrink-0 rounded-md bg-status-warning px-3 py-1 text-xs font-medium text-white hover:bg-status-warning/80 transition-colors"
          >
            {t('assistant.openNewAssistant')}
          </Button>
        </div>
      )}
      {isNewChat ? (
        // Centered hero — welcome row + composer as one vertically
        // centered max-w-3xl block. Skips MessageList and all the
        // inline post-stream affordances (TerminalReasonChip,
        // skillNudge, RateLimitBanner, etc.) since none of them
        // apply when there are no messages yet.
        <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-4 py-8">
          <div className="w-full max-w-3xl">
            <NewChatWelcome workingDir={workingDirectory} isAssistant={isAssistantProject} />
            <MessageInput
              key={sessionId}
              onSend={sendMessage}
              onCommand={handleCommand}
              onStop={stopStreaming}
              disabled={
                noCompatibleProvider
                || providerFetchState === 'idle'
                || sessionProviderRuntimeIncompatible
              }
              isStreaming={isStreaming}
              sessionId={sessionId}
              modelName={currentModel}
              onModelChange={setCurrentModel}
              providerId={currentProviderId}
              runtime={sessionRuntimeParam}
              onProviderModelChange={handleProviderModelChange}
              workingDirectory={workingDirectory}
              onAssistantTrigger={checkAssistantTrigger}
              effort={selectedEffort}
              onEffortChange={setSelectedEffort}
              sdkInitMeta={initMetaRef.current}
              isAssistantProject={isAssistantProject}
              hasMessages={false}
              onPendingContextTokensChange={setPendingContextTokens}
              onPendingContextSubTotalsChange={setPendingContextSubTotals}
              blockingReasonIds={blockingReasonIds}
            />
            <ChatComposerActionBar
              left={
                <>
                  <ModeIndicator mode={mode} onModeChange={handleModeChange} disabled={isStreaming} />
                  <RuntimeSelector
                    runtimePin={runtimePin}
                    effectiveRuntime={agentRuntimeToChatRuntime(globalRuntime.agentRuntime)}
                    onRuntimePinChange={handleRuntimePinChange}
                    disabled={isStreaming}
                  />
                  <ChatPermissionSelector
                    sessionId={sessionId}
                    permissionProfile={permissionProfile}
                    onPermissionChange={setPermissionProfile}
                  />
                </>
              }
              right={
                <RunCockpit
                  providerId={currentProviderId}
                  messages={messages}
                  modelName={currentModel}
                  context1m={context1m}
                  hasSummary={hasSummary}
                  upstreamModelId={currentModelUpstream}
                  contextUsageSnapshot={streamSnapshot?.contextUsageSnapshot}
                  permissionProfile={permissionProfile}
                  pendingContextTokens={pendingContextTokens}
                  pendingContextSubTotals={pendingContextSubTotals}
                  sessionRuntimePin={runtimePin}
                />
              }
            />
          </div>
        </div>
      ) : (
        <>
        <MessageList
        messages={messages}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
        toolUses={toolUses}
        toolResults={toolResults}
        streamingToolOutput={streamingToolOutput}
        streamingThinkingContent={streamingThinkingContent}
        statusText={statusText}
        onForceStop={stopStreaming}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={loadEarlierMessages}
        rewindPoints={rewindPoints}
        sessionId={sessionId}
        startedAt={streamSnapshot?.startedAt}
        isAssistantProject={isAssistantProject}
        assistantName={assistantName}
        taskRuns={taskRuns}
        // Codex P2 — wire the WaitingForPermissionPanel's
        // post-action callback into our existing message reconcile
        // so abandoning / re-running a paused run actually causes
        // the panel to disappear (or update to the new run state)
        // instead of staying frozen on the cancelled row.
        onTaskRunAction={reconcileWithDb}
      />
      {/* End-of-turn terminal reason chip (only shown when stream is not active) */}
      {!isStreaming && (
        <TerminalReasonChip
          reason={streamSnapshot?.terminalReason}
          onAction={handleTerminalAction}
        />
      )}
      {/* Permission prompt */}
      <PermissionPrompt
        pendingPermission={pendingPermission}
        permissionResolved={permissionResolved}
        onPermissionResponse={handlePermissionResponse}
        toolUses={toolUses}
        permissionProfile={permissionProfile}
      />
      {/* Phase 1b — confirmation dialog for destructive chip actions */}
      <AlertDialog
        open={pendingTerminalAction !== null}
        onOpenChange={(open) => { if (!open) setPendingTerminalAction(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('terminalAction.confirmTitle' as TranslationKey)}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingTerminalAction?.actionId === 'compress_and_retry' && t('terminalAction.confirmCompressAndRetry' as TranslationKey)}
              {pendingTerminalAction?.actionId === 'enable_1m_and_retry' && t('terminalAction.confirmEnable1mAndRetry' as TranslationKey)}
              {pendingTerminalAction?.actionId === 'switch_to_sonnet' && t('terminalAction.confirmSwitchToSonnet' as TranslationKey)}
              {pendingTerminalAction?.actionId === 'retry_simple' && t('terminalAction.confirmRetry' as TranslationKey)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('terminalAction.confirmCancel' as TranslationKey)}</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              if (pendingTerminalAction) {
                runTerminalAction(pendingTerminalAction.actionId, pendingTerminalAction.lastUserMessage);
                setPendingTerminalAction(null);
              }
            }}>
              {t('terminalAction.confirmCta' as TranslationKey)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Skill nudge banner — shown after complex multi-step workflows */}
      {skillNudge && !isStreaming && (
        <div className="mx-auto w-full max-w-3xl border-t border-border bg-background px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="flex-1 text-sm text-muted-foreground">
              {t('skillNudge.message')
                .replace('{step}', String(skillNudge.step))
                .replace('{toolCount}', String(skillNudge.distinctToolCount))}
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => {
                  setSkillNudge(null);
                  sendMessageRef.current?.(t('skillNudge.savePrompt'));
                }}
              >
                {t('skillNudge.saveButton')}
              </Button>
              <button
                type="button"
                onClick={() => setSkillNudge(null)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                aria-label="Dismiss"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Batch image generation panels */}
      <BatchExecutionDashboard />
      <BatchContextSync />

      {/* Queued message banner — shown above input when messages are
          waiting. Same Luma-light pill aesthetic as the chat composer:
          24px radius, soft muted bg, no border, ghost X button. */}
      {messageQueue.length > 0 && (
        <div className="mx-auto w-full max-w-3xl space-y-1 px-4 pb-1.5">
          {messageQueue.map((qm, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-2xl bg-muted px-3 py-2"
            >
              <Clock size={14} className="shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate text-xs text-muted-foreground">
                {(qm.displayOverride || qm.content).length > 80
                  ? (qm.displayOverride || qm.content).slice(0, 77) + '...'
                  : (qm.displayOverride || qm.content)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setMessageQueue((prev) => prev.filter((_, idx) => idx !== i))}
                aria-label={t('messageQueue.cancel' as TranslationKey)}
                className="shrink-0 text-muted-foreground/70 hover:text-foreground"
              >
                <X size={12} />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Phase 2 — subscription rate-limit banner (allowed_warning / rejected) */}
      {!rateLimitDismissed && streamSnapshot?.rateLimitInfo && streamSnapshot.rateLimitInfo.status !== 'allowed' && (
        <RateLimitBanner
          info={streamSnapshot.rateLimitInfo}
          onRequestSwitchToSonnet={() => {
            const lastUserMessage = findLastUserMessage();
            if (lastUserMessage) {
              setPendingTerminalAction({ actionId: 'switch_to_sonnet', lastUserMessage });
            } else {
              setCurrentModel('sonnet');
            }
          }}
          onDismiss={() => setRateLimitDismissed(true)}
        />
      )}
      {/* Run Checkpoint — Round 1 trust layer (Pinned-invalid /
          Runtime fallback / no-compatible-provider). Sits right above
          MessageInput so the user sees the gating reason next to the
          disabled composer. See `docs/exec-plans/active/chat-run-checkpoint.md`. */}
      <RunCheckpoint reasons={checkpointReasons} className="mb-2" onAction={handleCheckpointAction} />
      {/* Task checklist — moved out of the FileTree sidebar. Default
          expanded; minimize via top-right toggle; auto-hides when 0
          tasks or all completed. Same /api/tasks data source the
          previous sidebar TaskList used; SDK TodoWrite syncs via the
          `tasks-updated` window event. */}
      <TaskCheckpoint sessionId={sessionId} className="mb-2" />
      {invalidSessionProvider && (
        // Phase 2 Step 4b — server returned 409 INVALID_SESSION_PROVIDER:
        // the session's saved provider was deleted between when this
        // chat was loaded and when the user pressed send. We refuse to
        // route through env silently (Step 3a contract); this banner
        // tells the user what's wrong + points them at the picker
        // below to make an explicit choice. Clears on first
        // provider-pick (the useEffect that watches currentProviderId).
        <div
          className="mb-2 rounded-md border border-status-error-border bg-status-error-muted px-3 py-2 text-xs text-status-error-foreground"
          role="alert"
        >
          {t('chat.invalidSessionProvider.message' as TranslationKey, {
            providerId: invalidSessionProvider.sessionProviderId,
          })}
        </div>
      )}
      {sessionProviderRuntimeIncompatible && (
        // Phase 2 Step 3b — replaces the silent PATCH that used to
        // rewrite the session's provider/model whenever the runtime
        // filter excluded the saved one. Same trigger
        // (`providerWasFilteredOut`), now informational: tells the
        // user the saved provider isn't reachable under the current
        // execution engine and points them at the picker below to
        // make an explicit choice. No DB writes happen until they
        // pick — `onProviderModelChange` (handleProviderModelChange)
        // remains the only persist path, same shape as a normal
        // user-initiated switch.
        <div
          className="mb-2 rounded-md border border-status-warning-border bg-status-warning-muted px-3 py-2 text-xs text-status-warning-foreground"
          role="status"
        >
          {t('chat.sessionProviderIncompatible.message' as TranslationKey, {
            providerId: currentProviderId,
          })}
        </div>
      )}
      <MessageInput
        key={sessionId}
        onSend={sendMessage}
        onCommand={handleCommand}
        onStop={stopStreaming}
        // Phase 2 Step 3b review: disable composer (textarea + send
        // button) while the saved provider is runtime-incompatible —
        // the picker stays reachable so the user can pick a new one
        // and unblock send. Without this, the inline notice is purely
        // informational and a quick-clicker can still fire a send
        // that the wire layer would silently re-route through the
        // runtime-filtered fallback. The matching `doStartStream`
        // guard above is belt-and-suspenders.
        disabled={
          noCompatibleProvider
          || providerFetchState === 'idle'
          || sessionProviderRuntimeIncompatible
        }
        isStreaming={isStreaming}
        sessionId={sessionId}
        modelName={currentModel}
        onModelChange={setCurrentModel}
        providerId={currentProviderId}
        runtime={sessionRuntimeParam}
        onProviderModelChange={handleProviderModelChange}
        workingDirectory={workingDirectory}
        onAssistantTrigger={checkAssistantTrigger}
        effort={selectedEffort}
        onEffortChange={setSelectedEffort}
        sdkInitMeta={initMetaRef.current}
        isAssistantProject={isAssistantProject}
        hasMessages={messages.length > 0}
        onPendingContextTokensChange={setPendingContextTokens}
        onPendingContextSubTotalsChange={setPendingContextSubTotals}
        blockingReasonIds={blockingReasonIds}
      />
      <ChatComposerActionBar
        left={
          <>
            <ModeIndicator mode={mode} onModeChange={handleModeChange} disabled={isStreaming} />
            <RuntimeSelector
              runtimePin={runtimePin}
              effectiveRuntime={agentRuntimeToChatRuntime(globalRuntime.agentRuntime)}
              onRuntimePinChange={handleRuntimePinChange}
              disabled={isStreaming}
            />
            <ChatPermissionSelector
              sessionId={sessionId}
              permissionProfile={permissionProfile}
              onPermissionChange={setPermissionProfile}
            />
          </>
        }
        right={
          <RunCockpit
            providerId={currentProviderId}
            messages={messages}
            modelName={currentModel}
            context1m={context1m}
            hasSummary={hasSummary}
            upstreamModelId={currentModelUpstream}
            contextUsageSnapshot={streamSnapshot?.contextUsageSnapshot}
            permissionProfile={permissionProfile}
            pendingContextTokens={pendingContextTokens}
            pendingContextSubTotals={pendingContextSubTotals}
            sessionRuntimePin={runtimePin}
          />
        }
      />
        </>
      )}
    </div>
  );
}
