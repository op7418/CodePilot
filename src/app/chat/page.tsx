'use client';

import { Suspense, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Message, SSEEvent, SessionResponse, TokenUsage, PermissionRequestEvent, FileAttachment, MentionRef } from '@/types';
import type { SessionPermissionProfile } from '@/lib/permission/profile';
import { MessageList } from '@/components/chat/MessageList';
import { MessageInput, composerDraftKey } from '@/components/chat/MessageInput';
import { ChatComposerActionBar } from '@/components/chat/ChatComposerActionBar';
import { ModeIndicator } from '@/components/chat/ModeIndicator';
import { ChatPermissionSelector } from '@/components/chat/ChatPermissionSelector';
import { RuntimeSelector } from '@/components/chat/RuntimeSelector';
import { agentRuntimeToChatRuntime, effectiveChatRuntime } from '@/lib/chat-runtime-shared';
import { toWireEffort, resolveModelSwitchEffortEffect } from '@/lib/effort-levels';
import { refreshSessionTitle } from '@/lib/session-title-events';
import type { ChatRuntime } from '@/lib/chat-runtime-shared';
import { PermissionPrompt } from '@/components/chat/PermissionPrompt';
import { ChatEmptyState } from '@/components/chat/ChatEmptyState';
import { NewChatWelcome } from '@/components/chat/NewChatWelcome';
import { RunCockpit } from '@/components/chat/RunCockpit';
import { RunCheckpoint } from '@/components/chat/RunCheckpoint';
import { OnboardingWizard } from '@/components/assistant/OnboardingWizard';
import { ErrorBanner } from '@/components/ui/error-banner';
import { buildCheckpoints } from '@/lib/run-checkpoint';
// Chat first-paint memory contract (2026-05-09): NewChatPage must NOT
// statically reach `useOverviewData` (full Settings overview snapshot,
// fans out to 6+ /api endpoints + transitively pulls runtime/effective
// + provider-catalog). RunCheckpoint now only carries session-scoped
// "can this send go through" reasons; full health signals belong to
// /settings/health and the lazy RunCockpit popover. RuntimeSelector
// only needs the global agent_runtime label, which the lightweight
// hook below fetches from /api/settings/app alone.
// `computeEffectiveRuntime` and `useClaudeStatus` were here ONLY to
// compute `runtimeFallback` for the checkpoint banner — that signal
// was global health, not session blocking, so it's no longer surfaced
// at the chat first-paint. See chat-static-graph.test.ts.
import { useGlobalAgentRuntime } from '@/hooks/useGlobalAgentRuntime';
import { FolderPicker } from '@/components/chat/FolderPicker';
import { useNativeFolderPicker } from '@/hooks/useNativeFolderPicker';
import { useTranslation } from '@/hooks/useTranslation';
import { usePanel } from '@/hooks/usePanel';
import { maybeShowStatusToast } from '@/hooks/useSSEStream';
import { seedSnapshotPatch } from '@/lib/stream-session-manager';
import { createFirstTurnNavGuard, type FirstTurnNavGuard } from '@/lib/first-turn-navigation';
// `runtime/effective` stays — it's needed for the local resolver effect
// that produces `invalidDefault` (runtime-aware pinned-default check).
// That's the only contributor to RunCheckpoint's pinned-invalid
// reason on the new-chat page.
import { resolveNewChatDefault } from '@/lib/runtime/effective';

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

export default function NewChatPage() {
  // useSearchParams in App Router needs a Suspense boundary. The body of
  // NewChatPage was previously reading window.location.search inside a
  // `useMemo([])` to avoid that wrapper, but `useMemo([])` only runs once
  // per mount, so URL changes after mount (e.g. router.push to
  // /chat?prefill=… while /chat is already mounted, or back-forward
  // navigation) didn't update `prefillText`. Result: Tasks page → "新建任务"
  // could land on /chat with the prefill query in the URL but an empty
  // textarea. Suspense + useSearchParams makes prefill reactive without
  // breaking SSR/static prerender.
  return (
    <Suspense fallback={null}>
      <NewChatPageInner />
    </Suspense>
  );
}

function NewChatPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const prefillText = searchParams.get('prefill') || '';
  // #4/#5 (Codex P2) — the prefill enters the composer via `initialValue`, which
  // MessageInput prioritises OVER the draft. So clearing only the sessionStorage
  // draft at send-accept (below) leaves the URL prefill, and the accept-time
  // composer remount re-seeds the just-sent text from `initialValue`. Track which
  // prefill we've already sent and feed '' for it so the remount comes up empty;
  // a genuinely NEW prefill (different text) still shows.
  const [consumedPrefill, setConsumedPrefill] = useState<string | null>(null);
  const effectivePrefill = prefillText && prefillText !== consumedPrefill ? prefillText : '';
  // #4/#5 (Codex P2, warm-nav) — live ref to the URL prefill so the accept path
  // in `sendFirstMessage` consumes the *current* prefill even after a warm
  // navigation (/chat already mounted, then router.push to /chat?prefill=…).
  // `sendFirstMessage` is a stable useCallback that intentionally omits
  // prefillText from its deps — adding it would churn the callback identity and
  // cascade through `handleCommand`. Reading prefillText from that stale closure
  // saw the OLD (often empty) prefill, so `setConsumedPrefill` never fired and
  // the prefill kept re-seeding the composer. The ref is synced in an effect
  // (not during render — react-hooks/refs); the effect flushes before the next
  // user event, so the accept-time consume always sees the live prefill.
  const prefillTextRef = useRef(prefillText);
  useEffect(() => { prefillTextRef.current = prefillText; }, [prefillText]);
  const { setPendingApprovalSessionId } = usePanel();
  const { t } = useTranslation();
  const { isElectron, openNativePicker } = useNativeFolderPicker();
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingThinkingContent, setStreamingThinkingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolUses, setToolUses] = useState<ToolUseInfo[]>([]);
  const [toolResults, setToolResults] = useState<ToolResultInfo[]>([]);
  const [statusText, setStatusText] = useState<string | undefined>();
  const [workingDir, setWorkingDir] = useState('');
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [errorBanner, setErrorBanner] = useState<{ message: string; description?: string } | null>(null);
  const [recentProjects, setRecentProjects] = useState<string[]>([]);
  const [hasProvider, setHasProvider] = useState(true); // assume true until checked
  // True when the runtime-filtered /api/providers/models call succeeded
  // but returned an empty list — i.e. user has providers configured but
  // none are compatible with the active runtime. Distinct from
  // !hasProvider (no provider at all). Send is gated, picker shows empty.
  const [noCompatibleProvider, setNoCompatibleProvider] = useState(false);
  // Phase 2C contract: when global_default_mode='pinned' AND the pinned
  // provider/model isn't reachable under the effective Runtime, we set
  // this state to block sends. We DO NOT silently substitute another
  // provider/model — that's the entire point of pinning. Recovery
  // actions (switch Runtime / enable model / pick new / revert to Auto)
  // live on the Runtime page banner (Phase 2C.3) + Health page (2C.5);
  // here we just gate send + surface a minimal inline notice.
  const [invalidDefault, setInvalidDefault] = useState<
    | {
        providerId?: string;
        providerName?: string;
        modelValue?: string;
        reason?: 'provider-missing' | 'model-missing' | 'pin-incomplete';
      }
    | null
  >(null);
  const [showWizard, setShowWizard] = useState(false);
  const [assistantConfigured, setAssistantConfigured] = useState(false);
  const [assistantWorkspacePath, setAssistantWorkspacePath] = useState('');
  const [mode, setMode] = useState('code');
  // Model/provider start empty — populated by the async global-default fetch.
  // This prevents the race where a user sends before the fetch completes and
  // gets the stale localStorage model instead of the configured default.
  const [modelReady, setModelReady] = useState(false);
  const [currentModel, setCurrentModel] = useState(() => {
    if (typeof window === 'undefined') return '';
    // One-time migration: clear stale model/provider from pre-0.38 installs
    if (!localStorage.getItem('codepilot:migration-038')) {
      localStorage.removeItem('codepilot:last-model');
      localStorage.removeItem('codepilot:last-provider-id');
      localStorage.setItem('codepilot:migration-038', '1');
    }
    return '';
  });
  const [currentProviderId, setCurrentProviderId] = useState(() => {
    if (typeof window === 'undefined') return '';
    if (!localStorage.getItem('codepilot:migration-038')) {
      return '';
    }
    return '';
  });
  const [pendingPermission, setPendingPermission] = useState<PermissionRequestEvent | null>(null);
  const [permissionResolved, setPermissionResolved] = useState<'allow' | 'deny' | 'timeout' | null>(null);
  const [streamingToolOutput, setStreamingToolOutput] = useState('');
  const [permissionProfile, setPermissionProfile] = useState<SessionPermissionProfile>('default');
  const [pendingContextTokens, setPendingContextTokens] = useState(0);
  // Phase 6 Phase 3 — per-source split (attachment / mention / directory).
  // Flows through RunCockpit → useContextUsage → breakdown so the popover's
  // files_attachments row renders real numbers, not 0.
  const [pendingContextSubTotals, setPendingContextSubTotals] = useState<
    import('@/lib/message-input-logic').PendingContextSubTotals | undefined
  >(undefined);

  // Phase 6 P0 follow-up round 2 (2026-05-15) — split the legacy
  // `hasProvider` gate into two derived states so virtual providers
  // (Codex Account / OpenAI OAuth) don't get falsely blocked by the
  // /api/setup gate that doesn't know about them:
  //
  //   - `canSendWithCurrentProvider`: is the current (provider,
  //     model) tuple actually sendable right now? Used by the send
  //     button + sendFirstMessage gate.
  //   - `hasSendableProviderForCurrentRuntime`: is there ANY way to
  //     send under the active runtime? Used by the empty-state
  //     overlay so a Codex-Account-only user (no traditional
  //     provider per /api/setup) doesn't see the legacy "configure
  //     a provider" onboarding card when Codex is fully signed in
  //     and the resolver has landed on (codex_account, gpt-5.5).
  //
  // Both bypasses are the same shape — virtual providers
  // (`codex_account` / `openai-oauth`) are sendable regardless of
  // /api/setup state because they're authenticated through their
  // own routes. Legacy DB providers still require `hasProvider`.
  // `hasProvider` itself is preserved verbatim for the onboarding
  // empty-state branch inside ChatEmptyState — that surface is
  // about "have you ever set up a traditional provider", which is
  // still a meaningful question even when codex is available.
  const canSendWithCurrentProvider = useMemo(() => {
    if (!currentModel || !currentProviderId) return false;
    // Codex Account bypasses the /api/setup gate — the resolver
    // already proved this pair is reachable under the active runtime
    // (it wouldn't have landed in `currentProviderId` otherwise).
    if (currentProviderId === 'codex_account') return true;
    // Same goes for OpenAI OAuth, which is also a virtual provider
    // (`/api/openai-oauth/status`-managed).
    if (currentProviderId === 'openai-oauth') return true;
    if (currentProviderId === 'xai-oauth') return true;
    // Everything else still requires the legacy "provider set up"
    // signal so we don't accidentally route to an env-fallback
    // provider that the resolver synthesised but the user never
    // configured.
    return hasProvider;
  }, [hasProvider, currentProviderId, currentModel]);

  // Empty-state overlay gate. Differs from `canSendWithCurrentProvider`
  // ONLY around `modelReady`: during the initial resolver window
  // currentProviderId/Model are empty so `canSendWithCurrentProvider`
  // is false, but that's "still loading" not "no provider exists".
  // Without the modelReady gate we'd flash the no-provider empty state
  // on every mount.
  //
  // Once `modelReady === true`, the resolver has done its job:
  //   - currentProviderId === 'codex_account' → Codex is available,
  //     no empty state.
  //   - currentProviderId is a DB provider → hasProvider true (we
  //     wouldn't have a usable DB provider id otherwise), no empty
  //     state.
  //   - currentProviderId === '' → genuinely no provider reachable
  //     under the active runtime → empty state shows.
  const hasSendableProviderForCurrentRuntime = useMemo(() => {
    if (!modelReady) return true; // still loading; don't flash the empty state
    return canSendWithCurrentProvider;
  }, [modelReady, canSendWithCurrentProvider]);

  // Phase 2 Step 4c — runtime pin for the not-yet-created session.
  // RuntimeSelector writes here; on first send we PATCH the new
  // session row with this value before the chat POST runs (so the
  // chat route's lazy-seed sees the user's choice instead of falling
  // through to the global default). Empty string = follow global.
  // **Hoisted above checkpointReasons** because round-2 review needs
  // the value inside the checkpoint memo (suppressing stale
  // overview.defaultInvalid under explicit override) AND inside the
  // resolver effects (mode override) — declaring it after would TDZ.
  const [runtimePin, setRuntimePin] = useState<string>('');
  // Round-1 review fix — derive the chat-runtime param up front so
  // the default-resolver fetches and effect deps can both stay in
  // sync when the user switches runtime mid-page.
  //
  // Phase 6 P0 (2026-05-15): resolve to a CONCRETE RuntimeId, never
  // `'auto'`. The earlier `chatRuntimeParamForSession` returned
  // `'auto'` when no session pin existed; that flowed into
  // `useProviderModels`, which treated `'auto'` as "no per-row
  // gating", so the picker rendered every model as enabled even
  // under Codex Runtime where most providers can't yet route
  // through the (still-scaffolded) provider proxy. `globalRuntime`
  // is hoisted from below so we can resolve `'auto'` here using
  // the global `agent_runtime` setting.
  const globalRuntime = useGlobalAgentRuntime();
  const sessionRuntimeParam = effectiveChatRuntime(runtimePin, globalRuntime.agentRuntime);

  // Run Checkpoint signals — session-scoped only, no global health.
  //
  // Phase 2 originally pulled the full `useOverviewData()` snapshot
  // here so RunCheckpoint and RunCockpit could "agree on the same
  // numbers". That coupling cost the chat first paint a fan-out of
  // /api fetches plus a static compile-graph reach into Settings
  // Overview / runtime/effective / provider catalog. The 2026-05-09
  // memory cut moves global health (provider count / models enabled /
  // workspace state / global default invalid / runtime fallback) out
  // of this surface entirely — RunCockpit's lazy popover still shows
  // them when the user opens it, /settings/health is the canonical
  // dashboard. RunCheckpoint here keeps only the reasons that gate
  // "can this send go through":
  //   - noCompatibleProvider:        local state, set when the picker
  //                                   can't find a provider/model pair
  //                                   under the active runtime
  //   - !!invalidDefault:            local state from the runtime-aware
  //                                   resolver effect (NOT OR'd with
  //                                   any global flag — under explicit
  //                                   pin the local check is canonical;
  //                                   under follow-default it's the
  //                                   runtime-aware substitute for the
  //                                   global pinned check)
  //   - context-cost: per-send confirmation gate, unrelated to runtime
  //
  // /chat (new conversation page) hasn't accumulated messages yet, so
  // usedContextTokens is 0 — the context-cost trigger collapses to the
  // 10K hard cap on the pending side.
  const usedContextTokens = 0;
  const checkpointReasons = useMemo(() => {
    const pinnedDescriptor = invalidDefault?.modelValue
      ? `${invalidDefault.providerName ?? invalidDefault.providerId ?? '?'} / ${invalidDefault.modelValue}`
      : invalidDefault?.providerId ?? undefined;
    return buildCheckpoints({
      noCompatibleProvider,
      defaultInvalid: !!invalidDefault,
      pinnedDescriptor,
      pendingContextTokens,
      usedContextTokens,
    });
  }, [
    invalidDefault,
    noCompatibleProvider,
    pendingContextTokens,
    usedContextTokens,
  ]);
  // (globalRuntime is now declared above near sessionRuntimeParam so the
  // 'auto' → concrete runtime resolution happens once at the top.
  // Phase 6 P0, 2026-05-15.)
  const blockingReasonIds = useMemo(
    () => checkpointReasons.filter((r) => r.requiresConfirm).map((r) => r.id),
    [checkpointReasons],
  );
  const handleCheckpointAction = useCallback((actionId: string) => {
    // Generic confirm→bypass bridge (MessageInput listens for this event and
    // re-runs submit with bypass=true). As of #632 no built-in reason emits
    // 'confirm-context-cost' — context-cost is now a non-blocking heads-up;
    // this is retained dormant for any future real-danger confirm reason.
    if (actionId === 'confirm-context-cost') {
      window.dispatchEvent(new Event('run-checkpoint-confirm-send'));
    }
  }, []);
  const [createdSessionId, setCreatedSessionId] = useState<string | undefined>();
  const abortControllerRef = useRef<AbortController | null>(null);
  // Phase 2 ③ — first-turn navigation guard. The inline first-turn stream
  // router.push()es to the new session on completion; if the user navigated
  // away mid-stream (this page unmounted) that push must be suppressed so they
  // aren't dragged back. The unmount cleanup below deactivates the guard and
  // aborts the in-flight send controller.
  const navGuardRef = useRef<FirstTurnNavGuard | null>(null);
  if (!navGuardRef.current) navGuardRef.current = createFirstTurnNavGuard();
  useEffect(() => {
    const guard = navGuardRef.current;
    // Re-arm on (re)mount so StrictMode's mount→unmount→remount (whose
    // cleanup deactivates the guard) doesn't leave it permanently dead.
    guard?.reactivate();
    return () => {
      guard?.deactivate();
      abortControllerRef.current?.abort();
    };
  }, []);
  // #615: guards the first-message send while it's mid-flight. We defer the
  // isStreaming / optimistic-bubble flips until the backend ACCEPTS the message
  // (otherwise flipping `isNewChat` remounts the composer and eats the
  // screenshot), which means the usual `if (isStreaming) return` re-entry guard
  // isn't armed during that window — this ref blocks a double-submit instead.
  const firstSendInFlightRef = useRef(false);
  // Effort level — lifted here so the first message includes it
  const [selectedEffort, setSelectedEffort] = useState<string | undefined>(undefined);
  // Provider options (thinking mode + 1M context)
  const [thinkingMode, setThinkingMode] = useState<string>('adaptive');
  const [context1m, setContext1m] = useState(false);

  // Fetch provider-specific options (with abort to prevent stale responses on fast switch)
  useEffect(() => {
    const pid = currentProviderId || 'env';
    const controller = new AbortController();
    fetch(`/api/providers/options?providerId=${encodeURIComponent(pid)}`, { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!controller.signal.aborted) {
          setThinkingMode(data?.options?.thinking_mode || 'adaptive');
          setContext1m(!!data?.options?.context_1m);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [currentProviderId]);

  // Validate restored model/provider against actual available providers/models.
  // For NEW conversations, the global default model takes priority
  // over localStorage's last-model (which is a cross-session global memory).
  useEffect(() => {
    let cancelled = false;

    // Step 4c round 1 review — re-run on `sessionRuntimeParam` change
    // (was `[]` before, runtime-pin flips just updated the picker hook
    // and left the rest stale: red RunCheckpoint stayed up, send button
    // stayed disabled). Reset `modelReady` for the duration of the new
    // fetch so consumers see a definite "still resolving" beat instead
    // of the previous run's verdict.
    setModelReady(false);

    // Fetch models filtered by the **current** session runtime param —
    // empty pin → 'auto' (server resolves), explicit pin → that value
    // exactly. Without this the user-picked runtime never feeds back
    // into invalidDefault / noCompatibleProvider, and the resolved pair
    // could lock onto a provider the new runtime can't reach.
    const modelsP = fetch(`/api/providers/models?runtime=${sessionRuntimeParam}`).then(r => r.ok ? r.json() : null);
    const globalP = fetch('/api/providers/options?providerId=__global__').then(r => r.ok ? r.json() : null);

    Promise.all([modelsP, globalP]).then(([modelsData, globalData]) => {
      if (cancelled) return;
      // Three outcomes from a runtime-filtered fetch:
      //   1. API unreachable / malformed → fall back to localStorage so
      //      the picker still has *something* to show.
      //   2. Groups present → run validation chain below.
      //   3. Groups present but empty array → meaningful "no provider
      //      compatible with the active runtime" state. Don't restore
      //      the saved provider/model from localStorage — that would
      //      put back the very combination the runtime gate just
      //      filtered out. Clear and let the empty-state UI surface.
      if (!modelsData?.groups) {
        const savedModel = localStorage.getItem('codepilot:last-model') || 'sonnet';
        const savedProvider = localStorage.getItem('codepilot:last-provider-id') || '';
        setCurrentModel(savedModel);
        setCurrentProviderId(savedProvider);
        setModelReady(true);
        return;
      }
      // Phase 2C: resolver branches on default_mode (Auto vs Pinned).
      // Auto walks the savedPair → apiDefault → first chain; Pinned
      // demands an exact match and returns 'invalid-default' otherwise.
      // No silent substitution for Pinned — see invalidDefault state.
      //
      // Step 4c round 2 — when the user has explicitly switched runtime
      // via RuntimeSelector (`runtimePin !== ''`), the global pinned
      // policy no longer reflects their intent for THIS conversation:
      // they've actively asked for a different runtime, so blocking
      // them on a global pinned default that's incompatible with that
      // runtime forces them to "fix global settings" when the right
      // answer is "use the picker's auto-resolved pair under the new
      // runtime". Treat this case as 'auto' mode so the resolver
      // walks savedPair → apiDefault → first instead of demanding the
      // global pinned. When `runtimePin === ''` (still following the
      // global runtime), keep the strict pinned semantics — the
      // memory rule "pinned default is a hard promise" still holds
      // for that path.
      const opts = globalData?.options;
      const effectiveMode: 'pinned' | 'auto' = runtimePin
        ? 'auto'
        : (opts?.default_mode === 'pinned' ? 'pinned' : 'auto');
      const resolved = resolveNewChatDefault({
        groups: modelsData.groups,
        apiDefaultProviderId: modelsData.default_provider_id,
        mode: effectiveMode,
        pinnedProviderId: opts?.default_model_provider || '',
        pinnedModel: opts?.default_model || '',
        savedProviderId: localStorage.getItem('codepilot:last-provider-id') || '',
        savedModel: localStorage.getItem('codepilot:last-model') || '',
      });

      if (resolved.status === 'no-compatible') {
        setCurrentModel('');
        setCurrentProviderId('');
        setNoCompatibleProvider(true);
        setInvalidDefault(null);
      } else if (resolved.status === 'invalid-default') {
        // Phase 6 P0 round 3 (2026-05-15): pinned default is
        // unreachable under the active runtime, but we MUST land
        // parent state on a working fallback pair so the chat is
        // still sendable. Pre-round-3 this branch cleared
        // currentProviderId/Model — the banner said "auto-switched
        // to an available model" but the parent state went empty,
        // and MessageInput's useProviderModels resolved a DIFFERENT
        // visible fallback. Composer rendered as usable + send gate
        // tripped on empty parent state. Now we surface the warning
        // AND re-resolve as Auto so parent state matches the
        // banner's promise.
        setInvalidDefault({
          providerId: resolved.providerId,
          providerName: resolved.providerName,
          modelValue: resolved.modelValue,
          reason: resolved.reason,
        });
        setNoCompatibleProvider(false);
        const autoFallback = resolveNewChatDefault({
          groups: modelsData.groups,
          apiDefaultProviderId: modelsData.default_provider_id,
          mode: 'auto',
          pinnedProviderId: opts?.default_model_provider || '',
          pinnedModel: opts?.default_model || '',
          savedProviderId: localStorage.getItem('codepilot:last-provider-id') || '',
          savedModel: localStorage.getItem('codepilot:last-model') || '',
        });
        if (autoFallback.status === 'auto-resolved') {
          setCurrentProviderId(autoFallback.providerId ?? '');
          setCurrentModel(autoFallback.modelValue ?? '');
        } else {
          // Auto chain also failed → parent state stays empty.
          // The pinned-invalid warning still shows; the no-provider
          // empty-state overlay surfaces because canSendWithCurrent*
          // is false.
          setCurrentProviderId('');
          setCurrentModel('');
        }
      } else {
        // 'ok' (Pinned valid) or 'auto-resolved' (Auto chain found one).
        setCurrentProviderId(resolved.providerId ?? '');
        setCurrentModel(resolved.modelValue ?? '');
        setNoCompatibleProvider(false);
        setInvalidDefault(null);
      }
      setModelReady(true);
    }).catch(() => {
      // Fetch failed — fall back to localStorage best-effort
      const savedModel = localStorage.getItem('codepilot:last-model') || 'sonnet';
      const savedProvider = localStorage.getItem('codepilot:last-provider-id') || '';
      setCurrentModel(savedModel);
      setCurrentProviderId(savedProvider);
      setModelReady(true);
    });

    return () => { cancelled = true; };

  }, [sessionRuntimeParam]); // Re-validate whenever the runtime selector flips

  // Initialize workingDir from localStorage (or setup default), validating the path exists
  useEffect(() => {
    let cancelled = false;

    const validateDir = async (path: string): Promise<boolean> => {
      try {
        const res = await fetch(`/api/files/browse?dir=${encodeURIComponent(path)}`);
        return res.ok;
      } catch {
        return false;
      }
    };

    const tryFallbackToDefault = async () => {
      try {
        const res = await fetch('/api/setup');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled || !data?.defaultProject) return;
        if (await validateDir(data.defaultProject) && !cancelled) {
          setWorkingDir(data.defaultProject);
          localStorage.setItem('codepilot:last-working-directory', data.defaultProject);
        }
      } catch { /* ignore */ }
    };

    const init = async () => {
      const saved = localStorage.getItem('codepilot:last-working-directory');
      if (saved) {
        if (await validateDir(saved) && !cancelled) {
          setWorkingDir(saved);
        } else if (!cancelled) {
          // Stale — clear and try setup default
          localStorage.removeItem('codepilot:last-working-directory');
          await tryFallbackToDefault();
        }
      } else {
        await tryFallbackToDefault();
      }
    };

    init();

    const handler = (e: Event) => {
      const path = (e as CustomEvent).detail?.path;
      if (path) setWorkingDir(path);
    };
    window.addEventListener('project-directory-changed', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('project-directory-changed', handler);
    };
  }, []);

  // Load recent projects for empty state
  useEffect(() => {
    fetch('/api/setup/recent-projects')
      .then(r => r.ok ? r.json() : { projects: [] })
      .then(data => setRecentProjects(data.projects || []))
      .catch(() => {});
  }, []);

  // Detect assistant workspace status
  useEffect(() => {
    fetch('/api/settings/workspace')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.path && data?.valid !== false) {
          setAssistantWorkspacePath(data.path);
          setAssistantConfigured(!!data.state?.onboardingComplete);
        }
      })
      .catch(() => {});
  }, []);

  // Check provider availability — only 'completed' counts, 'skipped' means user deferred but has no real credentials
  useEffect(() => {
    const checkProvider = () => {
      // Lock sending while we re-resolve the model/provider
      setModelReady(false);
      fetch('/api/setup')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data) {
            setHasProvider(data.provider === 'completed');
          }
        })
        .catch(() => {});
      // Sync provider/model, applying global default model for new conversations.
      const savedProviderId = localStorage.getItem('codepilot:last-provider-id');

      // Fetch models + global default in parallel. Same runtime gating as
      // the initial-load branch above: server filters by the **current**
      // session runtime param (Step 4c round 1 review fix — was hardcoded
      // 'auto'; that locked the saved-provider validation to whatever
      // runtime resolved at mount even after the user switched it).
      const modelsP = fetch(`/api/providers/models?runtime=${sessionRuntimeParam}`).then(r => r.ok ? r.json() : null);
      const globalP = fetch('/api/providers/options?providerId=__global__').then(r => r.ok ? r.json() : null);

      Promise.all([modelsP, globalP]).then(([modelsData, globalData]) => {
        // Distinguish failure (modelsData null) from valid empty result.
        // Failure → keep existing state, just unlock send. Valid empty
        // (runtime filter dropped every group) → clear stale provider/
        // model so we don't leak the just-filtered-out combination back
        // into the picker; UI's empty state surfaces "no compatible
        // provider for this runtime".
        if (!modelsData?.groups) {
          setModelReady(true);
          return;
        }
        // Phase 2C: same shared resolver as the initial-load branch.
        // 'no-compatible' / 'invalid-default' / 'ok' / 'auto-resolved' —
        // no silent substitution for Pinned (see invalidDefault state).
        //
        // Step 4c round 2 — same `runtimePin` override as the
        // initial-load branch above: explicit runtime pick → 'auto'
        // mode, no global-pinned enforcement.
        const opts = globalData?.options;
        const effectiveMode: 'pinned' | 'auto' = runtimePin
          ? 'auto'
          : (opts?.default_mode === 'pinned' ? 'pinned' : 'auto');
        const resolved = resolveNewChatDefault({
          groups: modelsData.groups,
          apiDefaultProviderId: modelsData.default_provider_id,
          mode: effectiveMode,
          pinnedProviderId: opts?.default_model_provider || '',
          pinnedModel: opts?.default_model || '',
          savedProviderId: savedProviderId || '',
          savedModel: localStorage.getItem('codepilot:last-model') || '',
        });

        if (resolved.status === 'no-compatible') {
          setCurrentProviderId('');
          setCurrentModel('');
          setNoCompatibleProvider(true);
          setInvalidDefault(null);
        } else if (resolved.status === 'invalid-default') {
          // Phase 6 P0 round 3 (2026-05-15) — see the matching
          // round-3 fix in the initial-load resolver above. Surface
          // the pinned-invalid warning AND re-resolve as Auto so
          // parent state lands on a sendable (provider, model) pair.
          setNoCompatibleProvider(false);
          setInvalidDefault({
            providerId: resolved.providerId,
            providerName: resolved.providerName,
            modelValue: resolved.modelValue,
            reason: resolved.reason,
          });
          const autoFallback = resolveNewChatDefault({
            groups: modelsData.groups,
            apiDefaultProviderId: modelsData.default_provider_id,
            mode: 'auto',
            pinnedProviderId: opts?.default_model_provider || '',
            pinnedModel: opts?.default_model || '',
            savedProviderId: savedProviderId || '',
            savedModel: localStorage.getItem('codepilot:last-model') || '',
          });
          if (autoFallback.status === 'auto-resolved') {
            setCurrentProviderId(autoFallback.providerId ?? '');
            setCurrentModel(autoFallback.modelValue ?? '');
          } else {
            setCurrentProviderId('');
            setCurrentModel('');
          }
        } else {
          setNoCompatibleProvider(false);
          setInvalidDefault(null);
          const resolvedProviderId = resolved.providerId ?? '';
          const resolvedModelValue = resolved.modelValue ?? '';
          setCurrentProviderId(resolvedProviderId);
          setCurrentModel(resolvedModelValue);
          // Side effect specific to this call site: keep localStorage in
          // sync so the next mount doesn't try to restore a saved value
          // that's no longer in any compatible group. The initial-load
          // branch doesn't write back because the user might still have
          // valid state pending a different fetch.
          if (savedProviderId !== null && savedProviderId !== resolvedProviderId) {
            localStorage.removeItem('codepilot:last-provider-id');
          }
          const savedModel = localStorage.getItem('codepilot:last-model');
          if (savedModel !== resolvedModelValue) {
            localStorage.setItem('codepilot:last-model', resolvedModelValue);
          }
        }
        setModelReady(true);
      }).catch(() => {
        // On fetch failure, still apply localStorage values as-is (best effort)
        if (savedProviderId !== null) setCurrentProviderId(savedProviderId);
        const savedModel = localStorage.getItem('codepilot:last-model');
        if (savedModel) setCurrentModel(savedModel);
        setModelReady(true);
      });
    };
    checkProvider();

    window.addEventListener('provider-changed', checkProvider);
    return () => window.removeEventListener('provider-changed', checkProvider);
  }, [sessionRuntimeParam]); // Step 4c round 1 — re-run on runtime pin flip

  const handleSelectFolder = useCallback(async () => {
    if (isElectron) {
      const path = await openNativePicker({ title: t('folderPicker.title') });
      if (path) {
        setWorkingDir(path);
        localStorage.setItem('codepilot:last-working-directory', path);
      }
    } else {
      setFolderPickerOpen(true);
    }
  }, [isElectron, openNativePicker, t]);

  const handleFolderPickerSelect = useCallback((path: string) => {
    setWorkingDir(path);
    localStorage.setItem('codepilot:last-working-directory', path);
    setFolderPickerOpen(false);
  }, []);

  const handleSelectProject = useCallback((path: string) => {
    setWorkingDir(path);
    localStorage.setItem('codepilot:last-working-directory', path);
  }, []);

  const stopStreaming = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  const handlePermissionResponse = useCallback(async (decision: 'allow' | 'allow_session' | 'deny', updatedInput?: Record<string, unknown>, denyMessage?: string) => {
    if (!pendingPermission) return;

    const body: { permissionRequestId: string; approvalToken?: string; decision: { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] } | { behavior: 'deny'; message?: string } } = {
      permissionRequestId: pendingPermission.permissionRequestId,
      // Echo the server-issued HMAC token; the route rejects responses
      // without a valid one (Phase 4 ② hardening).
      ...(pendingPermission.approvalToken ? { approvalToken: pendingPermission.approvalToken } : {}),
      decision: decision === 'deny'
        ? { behavior: 'deny', message: denyMessage || 'User denied permission' }
        : {
            behavior: 'allow',
            ...(updatedInput ? { updatedInput } : {}),
            ...(decision === 'allow_session' && pendingPermission.suggestions
              ? { updatedPermissions: pendingPermission.suggestions }
              : {}),
          },
    };

    setPermissionResolved(decision === 'deny' ? 'deny' : 'allow');
    setPendingApprovalSessionId('');

    try {
      await fetch('/api/chat/permission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // Best effort
    }

    setTimeout(() => {
      setPendingPermission(null);
      setPermissionResolved(null);
    }, 1000);
  }, [pendingPermission, setPendingApprovalSessionId]);

  const sendFirstMessage = useCallback(
    async (content: string, files?: FileAttachment[], systemPromptAppend?: string, displayOverride?: string, mentions?: MentionRef[], selectedSkills?: readonly string[]) => {
      // Each early-out below is a NOT-delivered case: return false so the
      // composer preserves the user's text + attachments instead of letting
      // PromptInput clear a first-message screenshot that never got sent (#615).
      if (isStreaming) return false;

      // Wait for model/provider to be resolved from the global default before allowing send
      if (!modelReady) return false;

      // Block send when the runtime-filtered API returned an empty group
      // list — user has providers but none are compatible with the
      // active runtime. Without this gate, sendFirstMessage would post
      // `model: '', provider_id: ''` to /api/chat/sessions and the server
      // would resolve them via the env-default chain, silently bypassing
      // the runtime gate that just hid every option in the picker.
      if (noCompatibleProvider) {
        setErrorBanner({
          message: t('error.providerUnavailable'),
          description: t('chat.empty.noProvider'),
        });
        return false; // not delivered → preserve composer (#615)
      }

      // Phase 6 UI收口 P0 (2026-05-14): pinned-invalid is a GLOBAL
      // warning, not a per-session block. If the picker has resolved
      // to a usable (currentProviderId, currentModel) pair that lives
      // in the runtime-filtered group set, the user can send — the
      // global pinned default being broken is a separate concern
      // (surfaced as a non-error checkpoint banner with a "fix default"
      // jump link). We still honour the "no silent substitution of
      // pinned default" contract; we just don't drag the composer
      // along with it.
      //
      // Pre-round-4 this branch hard-blocked sends whenever
      // `invalidDefault` was set, even though `currentProviderId` /
      // `currentModel` had already fallen back to a working pair.
      // Users saw GPT-5.5 in the model button + a red "default model
      // unavailable" banner + a disabled composer at the same time —
      // a three-way contradiction the round 4 fix resolves.

      // Require a project directory before sending
      if (!workingDir.trim()) {
        setErrorBanner({ message: t('chat.empty.noDirectory') });
        return false; // not delivered → preserve composer (#615)
      }

      // Phase 6 P0 follow-up (2026-05-15) — Codex Account is a virtual
      // provider that doesn't flow through /api/setup, so `hasProvider`
      // (which reads `data.provider === 'completed'`) stays false even
      // when the user has signed in to Codex and the picker has
      // resolved (`currentProviderId === 'codex_account'`,
      // `currentModel === 'gpt-5.5'` etc.). Pre-fix, the user could
      // see the GPT-5.5 model selector + an enabled send button, then
      // click send and hit the legacy "no provider configured" wall.
      //
      // `canSendWithCurrentProvider` reflects what we actually need at
      // send time: the runtime/model/provider triple resolves to a
      // working route. `hasProvider` stays purely as the
      // legacy-provider setup signal for the empty-state UI (line
      // 1076 below) — that surface is about onboarding, not about
      // "is this exact send valid".
      if (!canSendWithCurrentProvider) {
        setErrorBanner({
          message: t('error.providerUnavailable'),
          description: t('chat.empty.noProvider'),
        });
        return false; // not delivered → preserve composer (#615)
      }

      // #615 remount fix: do NOT flip isStreaming / push the optimistic bubble
      // yet. Either flips `isNewChat` (messages.length === 0 && !isStreaming),
      // which swaps the whole layout ternary — the composer moves from the
      // centered hero branch to the active-layout branch (a DIFFERENT parent), so
      // MessageInput remounts and PromptInput loses the attachment, BEFORE we even
      // learn the send failed. Defer those flips to the post-accept point so a
      // pre-acceptance failure leaves the hero (and the screenshot) untouched.
      if (firstSendInFlightRef.current) return false; // double-submit guard while mid-flight
      firstSendInFlightRef.current = true;

      const controller = new AbortController();
      abortControllerRef.current = controller;

      let sessionId = '';
      // #615: tracks whether the message reached a delivered / recoverable state
      // (session created + POST /api/chat accepted). A failure BEFORE this must
      // return false so the composer preserves the user's text + attachments —
      // otherwise a session-create 500 silently eats the screenshot.
      let accepted = false;

      try {
        // Create a new session with working directory + model/provider
        // No `title` here on purpose. The client used to name the session at
        // create time by cutting the first 50 characters with no ellipsis,
        // while the chat route named it AGAIN from the same message under
        // different rules — two writers, two answers. The session is now
        // created as a placeholder and the route derives the one fallback
        // title after the first real message is persisted;
        // `refreshSessionTitle` below pulls it back for the UI.
        const createBody: Record<string, string> = {
          mode,
          working_directory: workingDir.trim(),
          permission_profile: permissionProfile,
          model: currentModel,
          provider_id: currentProviderId,
        };

        const createRes = await fetch('/api/chat/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(createBody),
        });

        if (!createRes.ok) {
          const errBody = await createRes.json().catch(() => ({}));
          throw new Error(errBody.error || `Failed to create session (${createRes.status})`);
        }

        const { session }: SessionResponse = await createRes.json();
        sessionId = session.id;
        setCreatedSessionId(sessionId);

        // Phase 2 Step 4c — if the user explicitly picked a runtime in
        // the composer's RuntimeSelector before sending, persist it now
        // (before the chat POST runs). This way the chat route's
        // lazy-seed sees `session.runtime_pin` already set and skips the
        // global-default fallback. Awaited so we don't race with /api/chat.
        if (runtimePin) {
          try {
            await fetch(`/api/chat/sessions/${sessionId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runtime_pin: runtimePin }),
            });
          } catch {
            // Non-fatal — the lazy-seed will still pin to the global
            // default; the user can re-pick from /chat/[id] after redirect.
          }
        }

        // Notify ChatListPanel to refresh immediately
        window.dispatchEvent(new CustomEvent('session-created'));

        // NOTE: the optimistic user bubble is pushed AFTER the message is
        // accepted (post-accept block below), not here — pushing it now would
        // make messages non-empty → flip isNewChat → remount the composer and
        // eat the screenshot on a /api/chat rejection. (#615)

        // Build thinking config from settings
        const thinkingConfig = thinkingMode && thinkingMode !== 'adaptive'
          ? { type: thinkingMode }
          : thinkingMode === 'adaptive' ? { type: 'adaptive' } : undefined;

        // Send the message via streaming API
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: session.id,
            content,
            mode,
            model: currentModel,
            provider_id: currentProviderId,
            ...(files && files.length > 0 ? { files } : {}),
            ...(mentions && mentions.length > 0 ? { mentions } : {}),
            ...(systemPromptAppend ? { systemPromptAppend } : {}),
            // 'auto' sentinel means "no explicit effort" — omitted so Claude
            // Code CLI applies its per-model default (Opus 4.7 → xhigh).
            ...(toWireEffort(selectedEffort) ? { effort: toWireEffort(selectedEffort) } : {}),
            ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
            ...(context1m ? { context_1m: true } : {}),
            ...(displayOverride ? { displayOverride } : {}),
            ...(selectedSkills && selectedSkills.length > 0
              ? { selectedSkills }
              : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          if (err?.code === 'NEEDS_PROVIDER_SETUP' && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('open-setup-center', {
              detail: { initialCard: err.initialCard ?? 'provider' },
            }));
          }
          throw new Error(err?.error || 'Failed to send message');
        }
        // Backend accepted the message + files (POST /api/chat is 2xx and the
        // stream is opening) — from here the screenshot is committed
        // server-side, so a later error must NOT preserve the composer (#615).
        accepted = true;
        // #4/#5 — clear the persisted composer draft at accept. The imminent
        // isStreaming flip REMOUNTS the composer, which re-seeds inputValue from
        // this draft (the only composer state surviving the remount); without
        // clearing it the just-sent text lingers all turn (CDP repro).
        try { sessionStorage.removeItem(composerDraftKey()); } catch { /* unavailable */ }
        // #4/#5 (Codex P2) — also mark the URL prefill consumed so the remount's
        // `initialValue` (which outranks the draft) doesn't re-seed the sent text.
        if (prefillTextRef.current) setConsumedPrefill(prefillTextRef.current);

        // The route wrote the fallback title before returning this response —
        // pull it back so the top bar / sidebar show the real title now
        // instead of waiting on the sidebar's 5s poll. Not awaited: the title
        // is cosmetic and must never delay the stream. Deliberately placed
        // AFTER the draft clear, which `composer-first-message-clear.test.ts`
        // pins to within 600 chars of `accepted = true`.
        void refreshSessionTitle(session.id);

        // Flip the layout-driving state ONLY now: show streaming + push the
        // optimistic user bubble. Deferring to here keeps `isNewChat` true
        // through any pre-acceptance failure, so the composer never remounts and
        // the screenshot survives (#615).
        setIsStreaming(true);
        setStreamingContent('');
        setToolUses([]);
        setToolResults([]);
        setStatusText(undefined);
        {
          // Optimistic user bubble — preserves base64 `data` so images render
          // their thumbnail immediately (backend strips `data` before persisting).
          const displayUserContent = displayOverride || content;
          const contentWithFileMeta = files && files.length > 0
            ? `<!--files:${JSON.stringify(files.map(f => ({ id: f.id, name: f.name, type: f.type, size: f.size, data: f.data })))}-->${displayUserContent}`
            : displayUserContent;
          const userMessage: Message = {
            id: 'temp-' + Date.now(),
            session_id: session.id,
            role: 'user',
            content: contentWithFileMeta,
            created_at: new Date().toISOString(),
            token_usage: null,
          };
          setMessages([userMessage]);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response stream');

        const decoder = new TextDecoder();
        let accumulated = '';
        let tokenUsage: TokenUsage | null = null;
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            try {
              const event: SSEEvent = JSON.parse(line.slice(6));

              switch (event.type) {
                case 'text': {
                  accumulated += event.data;
                  setStreamingContent(accumulated);
                  break;
                }
                case 'tool_use': {
                  try {
                    const toolData = JSON.parse(event.data);
                    setStreamingToolOutput('');
                    setToolUses((prev) => {
                      if (prev.some((t) => t.id === toolData.id)) return prev;
                      return [...prev, { id: toolData.id, name: toolData.name, input: toolData.input }];
                    });
                  } catch { /* skip */ }
                  break;
                }
                case 'tool_result': {
                  try {
                    const resultData = JSON.parse(event.data);
                    setStreamingToolOutput('');
                    setToolResults((prev) => [...prev, { tool_use_id: resultData.tool_use_id, content: resultData.content }]);
                  } catch { /* skip */ }
                  break;
                }
                case 'tool_output': {
                  try {
                    const parsed = JSON.parse(event.data);
                    if (parsed._progress) {
                      setStatusText(`Running ${parsed.tool_name}... (${Math.round(parsed.elapsed_time_seconds)}s)`);
                      break;
                    }
                  } catch {
                    // Not JSON — raw stderr output
                  }
                  setStreamingToolOutput((prev) => {
                    const next = prev + (prev ? '\n' : '') + event.data;
                    return next.length > 5000 ? next.slice(-5000) : next;
                  });
                  break;
                }
                case 'status': {
                  try {
                    const statusData = JSON.parse(event.data);
                    if (statusData.session_id) {
                      setStatusText(`Connected (${statusData.model || 'claude'})`);
                      setTimeout(() => setStatusText(undefined), 2000);
                    } else if (statusData.notification) {
                      // Shared toast routing so code-driven notifications
                      // (e.g. RUNTIME_EFFORT_IGNORED) survive the next
                      // status-text update on both the first-message flow
                      // (this page) and the ongoing session flow
                      // (useSSEStream via stream-session-manager).
                      maybeShowStatusToast(statusData);
                      setStatusText(statusData.message || statusData.title || undefined);
                    } else if (statusData.apiRetry) {
                      // #635 — show human copy, not raw JSON. The first-message
                      // path doesn't run the idle checker, so this is display-only.
                      setStatusText(
                        typeof statusData.attempt === 'number'
                          ? `Retrying upstream (attempt ${statusData.attempt})…`
                          : 'Retrying upstream…',
                      );
                    } else {
                      setStatusText(event.data || undefined);
                    }
                  } catch {
                    setStatusText(event.data || undefined);
                  }
                  break;
                }
                case 'result': {
                  try {
                    const resultData = JSON.parse(event.data);
                    if (resultData.usage) tokenUsage = resultData.usage;
                    // Phase 1: seed terminal_reason into the snapshot the
                    // redirected ChatView will read so first-turn
                    // prompt_too_long / blocking_limit / max_turns /
                    // hook_stopped can still surface the chip + action
                    // buttons in the post-redirect view.
                    if (resultData.terminal_reason && session?.id) {
                      seedSnapshotPatch(session.id, {
                        terminalReason: resultData.terminal_reason as string,
                      });
                    }
                  } catch { /* skip */ }
                  setStatusText(undefined);
                  break;
                }
                case 'rate_limit': {
                  // Phase 2: subscription rate-limit telemetry. Seed the
                  // snapshot so RateLimitBanner renders after redirect.
                  try {
                    const info = JSON.parse(event.data);
                    if (session?.id) {
                      seedSnapshotPatch(session.id, { rateLimitInfo: info });
                    }
                  } catch { /* skip */ }
                  break;
                }
                case 'context_usage': {
                  // Phase 5 extension-point; no producer currently (see
                  // b65c6ac). Seed the snapshot for forward compatibility.
                  try {
                    const snap = JSON.parse(event.data);
                    if (session?.id) {
                      seedSnapshotPatch(session.id, { contextUsageSnapshot: snap });
                    }
                  } catch { /* skip */ }
                  break;
                }
                case 'thinking': {
                  // Opus 4.7 with display: 'summarized' streams reasoning
                  // as thinking deltas. Accumulate them into the same
                  // streamingThinkingContent surface that ChatView's
                  // MessageList already renders, so the first-turn UI
                  // shows the reasoning block as it streams in. Backend
                  // /api/chat/route.ts separately persists thinking as a
                  // content-block JSON on the assistant message, so the
                  // redirected ChatView gets a fully-formed message from
                  // DB — this branch is for the pre-redirect live view.
                  setStreamingThinkingContent((prev) => prev + event.data);
                  break;
                }
                case 'permission_request': {
                  try {
                    const permData: PermissionRequestEvent = JSON.parse(event.data);
                    setPendingPermission(permData);
                    setPermissionResolved(null);
                    setPendingApprovalSessionId(sessionId);
                  } catch {
                    // skip malformed permission_request data
                  }
                  break;
                }
                case 'permission_resolved': {
                  // A5 Step 2 — registry timed out the pending request and
                  // auto-denied it. The inline first-message flow has a single
                  // active prompt and the registry only emits this for a still-
                  // unresolved request, so marking resolved without an explicit
                  // id-guard is safe here (entry 2 / stream-session-manager
                  // id-guards because it has fresh mutable snapshot access).
                  // Also clear the sidebar "needs approval" badge: the prompt
                  // now shows the timeout one-liner, nothing's left to approve
                  // (A5 follow-up — without this the badge lingers till stream end).
                  try {
                    const data = JSON.parse(event.data) as { status: 'timeout' };
                    setPermissionResolved(data.status);
                    setPendingApprovalSessionId('');
                  } catch {
                    // skip malformed permission_resolved data
                  }
                  break;
                }
                case 'error': {
                  // Try to parse structured error JSON from classifier
                  let errorDisplay: string;
                  try {
                    const parsed = JSON.parse(event.data);
                    if (parsed.category && parsed.userMessage) {
                      errorDisplay = parsed.userMessage;
                      if (parsed.actionHint) errorDisplay += `\n\n**What to do:** ${parsed.actionHint}`;
                      if (parsed.details) errorDisplay += `\n\nDetails: ${parsed.details}`;
                      // Add diagnostic guidance for provider/auth related errors
                      const diagCategories = new Set([
                        'AUTH_REJECTED', 'AUTH_FORBIDDEN', 'AUTH_STYLE_MISMATCH',
                        'NO_CREDENTIALS', 'PROVIDER_NOT_APPLIED', 'MODEL_NOT_AVAILABLE',
                        'NETWORK_UNREACHABLE', 'ENDPOINT_NOT_FOUND', 'PROCESS_CRASH',
                        'CLI_NOT_FOUND', 'UNSUPPORTED_FEATURE',
                      ]);
                      if (diagCategories.has(parsed.category)) {
                        errorDisplay += '\n\n💡 [Run Provider Diagnostics](/settings/providers) to troubleshoot, or check the [Provider Setup Guide](https://www.codepilot.sh/docs/providers).';
                      }
                    } else {
                      errorDisplay = event.data;
                    }
                  } catch {
                    errorDisplay = event.data;
                  }
                  accumulated += '\n\n**Error:** ' + errorDisplay;
                  setStreamingContent(accumulated);
                  break;
                }
                case 'done':
                  break;
              }
            } catch {
              // skip
            }
          }
        }

        // Add the completed assistant message
        if (accumulated.trim()) {
          const assistantMessage: Message = {
            id: 'temp-assistant-' + Date.now(),
            session_id: session.id,
            role: 'assistant',
            content: accumulated.trim(),
            created_at: new Date().toISOString(),
            token_usage: tokenUsage ? JSON.stringify(tokenUsage) : null,
          };
          setMessages((prev) => [...prev, assistantMessage]);
        }

        // Navigate to the session page after response is complete — but ONLY
        // if the user is still on this new-chat page. If they switched away
        // mid-stream (navGuard deactivated on unmount), suppress the push so
        // we don't drag them back to the just-created session (Phase 2 ③).
        navGuardRef.current?.navigate(() => router.push(`/chat/${session.id}`));
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          // Aborted — either the user hit stop, or the page unmounted (session
          // switch) and the cleanup aborted the controller. Only navigate to
          // the session if the guard is still active (user stopped while
          // still here); a switch-away abort must NOT push them back.
          if (sessionId) {
            navGuardRef.current?.navigate(() => router.push(`/chat/${sessionId}`));
          }
        } else {
          const errMsg = error instanceof Error ? error.message : 'Unknown error';
          setErrorBanner({ message: t('error.sessionCreateFailed'), description: errMsg });
        }
        // #615: a failure BEFORE the message was accepted for delivery (session
        // creation or POST /api/chat rejected) must preserve the composer so the
        // user's screenshot isn't cleared. Post-acceptance errors (mid-stream)
        // keep today's behavior — the message already went, so the composer clears.
        if (!accepted) return false;
      } finally {
        setIsStreaming(false);
        setStreamingContent('');
        setStreamingThinkingContent('');
        setToolUses([]);
        setToolResults([]);
        setStreamingToolOutput('');
        setStatusText(undefined);
        setPendingPermission(null);
        setPermissionResolved(null);
        setPendingApprovalSessionId('');
        abortControllerRef.current = null;
        firstSendInFlightRef.current = false;
      }
    },
    [isStreaming, router, workingDir, mode, currentModel, currentProviderId, permissionProfile, selectedEffort, thinkingMode, context1m, setPendingApprovalSessionId, t, canSendWithCurrentProvider, modelReady, noCompatibleProvider, invalidDefault]
  );

  const handleCommand = useCallback((command: string) => {
    switch (command) {
      case '/help': {
        const helpMessage: Message = {
          id: 'cmd-' + Date.now(),
          session_id: '',
          role: 'assistant',
          content: `## Available Commands\n\n- **/help** - Show this help message\n- **/clear** - Clear conversation history\n- **/compact** - Compress conversation context\n- **/cost** - Show token usage statistics\n- **/doctor** - Check system health\n- **/init** - Initialize CLAUDE.md\n- **/review** - Start code review\n- **/terminal-setup** - Configure terminal\n\n**Tips:**\n- Type \`@\` to mention files\n- Use Shift+Enter for new line\n- Select a project folder to enable file operations`,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages(prev => [...prev, helpMessage]);
        break;
      }
      case '/clear':
        setMessages([]);
        break;
      case '/cost': {
        const costMessage: Message = {
          id: 'cmd-' + Date.now(),
          session_id: '',
          role: 'assistant',
          content: `## Token Usage\n\nToken usage tracking is available after sending messages. Check the token count displayed at the bottom of each assistant response.`,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages(prev => [...prev, costMessage]);
        break;
      }
      default:
        sendFirstMessage(command);
    }
  }, [sendFirstMessage]);

  // New-chat layout (2026-05-21): when there are no messages and no
  // streaming, replace the bottom-pinned composer + top scrolling
  // message list with a centered hero block — welcome greeting + logo,
  // composer in the middle, optional onboarding cards below. Mirrors
  // the ChatGPT / Claude / Codex new-chat pattern. Once the user
  // sends the first message (messages.length > 0 OR isStreaming),
  // we fall back to the traditional list-above + composer-below layout.
  const isNewChat = messages.length === 0 && !isStreaming;
  const needsOnboardingCards = !workingDir.trim() || !hasSendableProviderForCurrentRuntime;

  const chatEmptyStateNode = (
    <ChatEmptyState
      hasDirectory={!!workingDir.trim()}
      hasProvider={hasSendableProviderForCurrentRuntime}
      onSelectFolder={handleSelectFolder}
      recentProjects={recentProjects}
      onSelectProject={handleSelectProject}
      assistantConfigured={assistantConfigured}
      onOpenAssistant={() => {
        if (assistantConfigured) {
          // Navigate to the latest assistant session
          fetch(`/api/workspace/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'checkin' }),
          })
            .then(r => r.json())
            .then(data => router.push(`/chat/${data.session.id}`))
            .catch(() => {});
        } else if (assistantWorkspacePath) {
          setShowWizard(true);
        } else {
          router.push('/settings/assistant');
        }
      }}
    />
  );

  // Single composer stack — reused in both the new-chat hero (centered)
  // and the active-chat layout (bottom-pinned). Avoids duplicating
  // ErrorBanner / RunCheckpoint / PermissionPrompt / MessageInput /
  // ChatComposerActionBar across two branches.
  const composerStack = (
    <>
      {/* #615: stable keys so MessageInput keeps its identity (and PromptInput
          keeps its attachment state) when ErrorBanner appears/disappears as a
          sibling. The dominant remount cause — the isNewChat layout swap — is
          fixed by deferring the layout-flip until accept (see sendFirstMessage);
          these keys cover the within-parent ErrorBanner toggle. */}
      {errorBanner && (
        <ErrorBanner
          key="composer-error-banner"
          message={errorBanner.message}
          description={errorBanner.description}
          className="mx-4 mb-2"
          onDismiss={() => setErrorBanner(null)}
          actions={[
            { label: t('error.retry'), onClick: () => setErrorBanner(null) },
          ]}
        />
      )}
      <RunCheckpoint key="composer-run-checkpoint" reasons={checkpointReasons} className="mb-2" onAction={handleCheckpointAction} />
      <PermissionPrompt
        key="composer-permission-prompt"
        pendingPermission={pendingPermission}
        permissionResolved={permissionResolved}
        onPermissionResponse={handlePermissionResponse}
        toolUses={toolUses}
      />
      <MessageInput
        key="composer-message-input"
        onSend={sendFirstMessage}
        onCommand={handleCommand}
        onStop={stopStreaming}
        disabled={!modelReady || noCompatibleProvider}
        isStreaming={isStreaming}
        modelName={currentModel}
        onModelChange={setCurrentModel}
        providerId={currentProviderId}
        runtime={sessionRuntimeParam}
        onProviderModelChange={(pid, model, opts) => {
          setCurrentProviderId(pid);
          setCurrentModel(model);
          // s07 (reviewer fix run i31, 2026-07-18) — the new-chat composer had NO
          // effort fallback at all: a manual or auto-correct switch to a model
          // that doesn't offer the selected tier left it selected, so the first
          // message sent an unsupported effort (or toWireEffort silently dropped
          // it while the button still showed it). Mirror ChatView: clear the
          // illegal transient tier on ANY effective model change — validated
          // against the SAME picker feed via opts.supportedEffortLevels — and
          // surface the one-shot sourced notice only when a reset actually fired.
          // This runs BEFORE the isAuto persist-skip; isAuto still governs only
          // the localStorage "recently used" writes, never the effort effect.
          const effortEffect = resolveModelSwitchEffortEffect(
            selectedEffort,
            opts?.supportedEffortLevels,
          );
          if (effortEffect.resetEffort) {
            setSelectedEffort(undefined);
          }
          if (effortEffect.showResetToast) {
            import('@/hooks/useToast').then(({ showToast }) => {
              showToast({
                type: 'info',
                message: t('messageInput.effort.resetOnModelSwitch'),
                duration: 4000,
              });
            });
          }
          if (opts?.isAuto) return;
          localStorage.setItem('codepilot:last-provider-id', pid);
          localStorage.setItem('codepilot:last-model', model);
          setInvalidDefault(null);
          setNoCompatibleProvider(false);
        }}
        workingDirectory={workingDir}
        effort={selectedEffort}
        onEffortChange={setSelectedEffort}
        initialValue={effectivePrefill}
        onPendingContextTokensChange={setPendingContextTokens}
        onPendingContextSubTotalsChange={setPendingContextSubTotals}
        blockingReasonIds={blockingReasonIds}
      />
      <ChatComposerActionBar
        left={
          <>
            <ModeIndicator mode={mode} onModeChange={setMode} disabled={isStreaming} />
            <RuntimeSelector
              runtimePin={runtimePin}
              effectiveRuntime={agentRuntimeToChatRuntime(globalRuntime.agentRuntime)}
              onRuntimePinChange={(pin: ChatRuntime) => setRuntimePin(pin)}
              disabled={isStreaming}
            />
            <ChatPermissionSelector
              permissionProfile={permissionProfile}
              onPermissionChange={setPermissionProfile}
              runtime={sessionRuntimeParam}
            />
          </>
        }
        right={
          <RunCockpit
            providerId={currentProviderId}
            messages={[]}
            modelName={currentModel}
            permissionProfile={permissionProfile}
            pendingContextTokens={pendingContextTokens}
            pendingContextSubTotals={pendingContextSubTotals}
            sessionRuntimePin={runtimePin}
          />
        }
      />
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {isNewChat ? (
        // Centered new-chat hero: welcome → composer → onboarding cards
        // as one vertically-centered max-w-3xl block. Mirrors ChatGPT /
        // Claude / Codex new-chat pattern.
        <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-4 py-8">
          <div className="w-full max-w-3xl">
            <NewChatWelcome workingDir={workingDir} />
            {composerStack}
            {needsOnboardingCards && <div className="mt-4">{chatEmptyStateNode}</div>}
          </div>
        </div>
      ) : (
        <>
          <MessageList
            messages={messages}
            streamingContent={streamingContent}
            streamingThinkingContent={streamingThinkingContent}
            isStreaming={isStreaming}
            sessionId={createdSessionId}
            toolUses={toolUses}
            toolResults={toolResults}
            streamingToolOutput={streamingToolOutput}
            statusText={statusText}
          />
          {composerStack}
        </>
      )}
      <FolderPicker
        open={folderPickerOpen}
        onOpenChange={setFolderPickerOpen}
        onSelect={handleFolderPickerSelect}
      />
      {showWizard && assistantWorkspacePath && (
        <OnboardingWizard
          workspacePath={assistantWorkspacePath}
          onComplete={(session) => {
            setShowWizard(false);
            setAssistantConfigured(true);
            router.push(`/chat/${session.id}`);
          }}
        />
      )}
    </div>
  );
}
