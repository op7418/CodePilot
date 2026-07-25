import { NextRequest } from 'next/server';
import { streamClaude } from '@/lib/claude-client';
import { resolveInTreeAttachmentPath } from '@/lib/in-tree-attachment';
import { addMessage, getMessages, getSession, getSessionSummary, updateSessionTitle, updateSdkSessionId, updateSessionModel, updateSessionProvider, updateSessionProviderId, updateSessionRuntime, getSetting, acquireSessionLock, renewSessionLock, releaseSessionLock, setSessionRuntimeStatus, isLockOwner } from '@/lib/db';
import { deriveConversationTitle } from '@/lib/conversation-title';
import { resolveProviderForSession } from '@/lib/provider-resolver';
import { resolveRuntimeForSession } from '@/lib/chat-runtime';
import { notifySessionStart } from '@/lib/telegram-bot';
import { collectStreamResponse } from '@/lib/chat-collect-stream-response';
import { loadCodePilotMcpServers, loadAllMcpServers } from '@/lib/mcp-loader';
import { assembleContext } from '@/lib/context-assembler';
import { buildContextCompressedStatus } from '@/lib/context-compressor';
import type { SendMessageRequest, FileAttachment, ClaudeStreamOptions } from '@/types';
import { wrapController } from '@/lib/safe-stream';
import { ensureSchedulerRunning } from '@/lib/task-scheduler';
import { predictNativeRuntime } from '@/lib/runtime';
import { hasCodePilotProvider } from '@/lib/provider-presence';
import { createSessionLockSettler } from '@/lib/session-lock-settle';
import { evaluateRenewal } from '@/lib/session-lock-renewal';
import { validateSendMessageBody } from '@/lib/chat-request-validation';
import {
  normalizePermissionProfile,
  resolveClaudeWireOptions,
  resolveProfileAutoReviewSupport,
} from '@/lib/permission/profile';
import { buildReviewEvent } from '@/lib/permission/review-event';
import { emitReviewEvent } from '@/lib/permission/review-audit';
import { isAutoReviewSupported, getAutoReviewUnavailableReason } from '@/lib/permission/sdk-capability';

// codex-stop-recovery Phase 3 — after the request aborts (Stop force-abort /
// client disconnect), how long to wait for the natural interrupt→terminal→
// collect path to release the lock before the watchdog forces it. Long enough
// that the common case settles itself as 'idle'; short enough that a turn with
// no terminal event still frees the session promptly instead of forever.
const LOCK_RECOVERY_GRACE_MS = 8000;

// Session lock renewal (I3) — cap on how many times an autoTrigger
// (background/heartbeat) turn's lock-renewal interval may renew before it is
// force-settled. 30 renewals ≈ 30min @ 60s tick. A background turn has no
// Stop/abort watchdog (its initiating request may disconnect while it keeps
// running), so without this cap a stuck background turn would renew its lock
// forever and beat the TTL — the session could never be reclaimed. Foreground
// turns stay uncapped here; they are bounded by the watchdog instead.
const AUTO_TRIGGER_MAX_RENEWALS = 30;

// Start the task scheduler on first API call
ensureSchedulerRunning();
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let activeSessionId: string | undefined;
  let activeLockId: string | undefined;

  try {
    const body: SendMessageRequest & { files?: FileAttachment[]; toolTimeout?: number; provider_id?: string; systemPromptAppend?: string; autoTrigger?: boolean; thinking?: unknown; effort?: string; enableFileCheckpointing?: boolean; displayOverride?: string; context_1m?: boolean; selectedSkills?: readonly string[] } = await request.json();
    const { session_id, content, model, mode, files, toolTimeout, provider_id, systemPromptAppend, autoTrigger, thinking, effort, enableFileCheckpointing, displayOverride, context_1m, selectedSkills } = body;

    // Required-field validation BEFORE any use of `content` (audit ③). The
    // logs below read content.length/slice; a missing or non-string content
    // would throw here and surface as a 500 instead of an honest 400.
    const bodyValidationError = validateSendMessageBody(body);
    if (bodyValidationError) {
      return new Response(JSON.stringify({ error: bodyValidationError.error }), {
        status: bodyValidationError.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log('[chat API] content length:', content.length, 'first 200 chars:', content.slice(0, 200));
    console.log('[chat API] systemPromptAppend:', systemPromptAppend ? `${systemPromptAppend.length} chars` : 'none');

    // Precondition: CodePilot must have a provider configured. ~/.claude/settings.json
    // (cc-switch, CLI login) is intentionally NOT counted — users with only that source
    // are redirected to the setup flow to add a proper CodePilot provider.
    if (!hasCodePilotProvider()) {
      return new Response(
        JSON.stringify({
          error: 'No provider configured in CodePilot.',
          code: 'NEEDS_PROVIDER_SETUP',
          actionHint: 'open_setup_center',
          initialCard: 'provider',
        }),
        { status: 412, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const session = getSession(session_id);
    if (!session) {
      return new Response(JSON.stringify({ error: 'Session not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Acquire exclusive lock for this session to prevent concurrent requests
    const lockId = crypto.randomBytes(8).toString('hex');
    const lockAcquired = acquireSessionLock(session_id, lockId, `chat-${process.pid}`, 600);
    if (!lockAcquired) {
      return new Response(
        JSON.stringify({ error: 'Session is busy processing another request', code: 'SESSION_BUSY' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );
    }
    activeSessionId = session_id;
    activeLockId = lockId;
    setSessionRuntimeStatus(session_id, 'running');

    // ─── Phase 2 Step 3 — early resolver gate ───────────────────────
    //
    // Resolve provider + runtime BEFORE any user-visible side effect
    // (Telegram notify, file uploads, addMessage, title update) AND
    // before the `/compact` branch — the compressor calls
    // `resolveAuxiliaryModel` internally and would otherwise silently
    // fall through to env / another provider when the session's
    // committed provider has been deleted, bypassing the same "session
    // provider missing → fail closed" promise we make for normal sends.
    // Failing closed up here means: if the session points at a deleted
    // provider, NO compression runs, NO transcript writes happen, and
    // the same composer text / `/compact` invocation can be retried
    // after the user picks a new provider.
    //
    // `resolveRuntimeForSession` is also called here so `resolved`
    // (`.provider`, `.model`) is the same value used by the
    // lazy-seed + downstream streamClaude call below.
    // Lift to a local so the lazy-seed below can write the same value
    // we routed THIS turn through (no second call to the registry).
    const effectiveSessionRuntime = resolveRuntimeForSession(session);
    const resolved = resolveProviderForSession(
      {
        provider_id: session.provider_id || '',
        model: session.model || '',
        requestProviderId: provider_id || undefined,
        requestModel: model || undefined,
      },
      { runtime: effectiveSessionRuntime, callScene: 'interactive_chat' },
    );
    if (resolved.invalidReason) {
      releaseSessionLock(session_id, lockId);
      activeSessionId = undefined;
      activeLockId = undefined;
      setSessionRuntimeStatus(session_id, 'idle');
      return new Response(
        JSON.stringify({
          error: 'Session points at a provider that no longer exists.',
          code: 'INVALID_SESSION_PROVIDER',
          reason: resolved.invalidReason,
          // Frontend can use this to render "your saved provider was
          // deleted — pick another or revert to default" without
          // having to refetch session state.
          sessionProviderId: session.provider_id || '',
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const resolvedProvider = resolved.provider;

    // Phase 2 Step 4a — lazy-seed `session.runtime_pin`.
    //
    // Sessions created before the column shipped (or before the user
    // ever explicitly switched runtime in the chat) carry an empty
    // `runtime_pin`, which means `resolveRuntimeForSession` falls
    // through to the global `agent_runtime` setting. That's fine for
    // THIS turn — but on the NEXT turn, after the user has flipped
    // the global setting in Settings, the same session would silently
    // resolve to the new global value: drift.
    //
    // Lock it in: the moment the user actually sends a message, we
    // pin the currently-routed runtime to the session row. Subsequent
    // sends use the pin regardless of global flips. Same principle as
    // the model + provider lazy-seed below: "the session's first
    // commitment is whatever they were ACTIVELY using when they
    // pressed send".
    //
    // **autoTrigger guard (Step 4a review)**: invisible system turns
    // (heartbeat checks, assistant hooks, /skill expansion etc.) must
    // NOT pin the runtime — the user contract is "first USER send
    // fixes it", and an autoTrigger firing at the wrong moment would
    // silently capture whatever global was active for the BACKGROUND
    // task, not the user's choice. Background turns still resolve via
    // `effectiveSessionRuntime` for routing this turn, they just don't
    // persist that decision. Mirrors the same `!autoTrigger` gate
    // already wrapping `addMessage` / `updateSessionTitle` below.
    //
    // Mutates the in-memory `session.runtime_pin` too so the
    // streamClaude call below picks up the seeded value (rather than
    // re-reading DB).
    if (!session.runtime_pin && !autoTrigger) {
      updateSessionRuntime(session_id, effectiveSessionRuntime);
      session.runtime_pin = effectiveSessionRuntime;
    }

    // ── /compact command handler ────────────────────────────────────
    if (content.trim() === '/compact') {
      try {
        const { compressConversation, resetCompressionState, filterHistoryByCompactBoundary } = await import('@/lib/context-compressor');
        const { getMessages: getDbMessages, getSessionSummary: getDbSummary, updateSessionSummary: updateDbSummary } = await import('@/lib/db');
        // Note: addMessage is intentionally NOT imported here. Neither the
        // success path nor the no-op path persists slash-command feedback
        // to DB — both are UI artifacts that would otherwise land after
        // context_summary_boundary_rowid and leak into the model's
        // transcript on subsequent turns. Repeated /compact calls would
        // accumulate those rows and eventually get folded into the next
        // summary. SSE frames convey the outcome to the user; the DB stays
        // clean. See the regression test in
        // context-compressor-handoff.test.ts that scans this block for
        // any addMessage/addDbMessage call.

        resetCompressionState(session_id);
        const { messages: allMsgs } = getDbMessages(session_id, { limit: 200, excludeHeartbeatAck: true });
        const existingSummaryData = getDbSummary(session_id);

        // If a prior summary exists, only compress rows strictly after its
        // coverage boundary. Without this, a second /compact would feed
        // existingSummary + messages already covered by existingSummary +
        // newer messages into the summarizer and duplicate the old context
        // inside the new summary. This mirrors the auto pre-compression
        // path (which filters by boundary via filterHistoryByCompactBoundary
        // before estimating / compressing).
        const rowsToCompactCandidate = filterHistoryByCompactBoundary({
          history: allMsgs,
          summary: existingSummaryData.summary,
          summaryBoundaryRowid: existingSummaryData.boundaryRowid,
        });

        if (rowsToCompactCandidate.length < 4) {
          // Short path: either the whole conversation is short, or it's
          // already compacted and there's not enough NEW material to
          // warrant another pass. Either way: no compression, no SDK
          // session invalidation, no context_compressed event. hasSummary
          // must not flip because nothing new got summarized.
          //
          // Do NOT addDbMessage this notice. It's a UI artifact like the
          // success-path confirmation. Persisting it would land a row
          // AFTER context_summary_boundary_rowid, and on the next
          // fallback/estimation pass the filter would keep it as real
          // assistant context. Repeated /compact in an already-compacted
          // session would accumulate these rows and the next real compact
          // would fold them into the summary. SSE delivers the message
          // to the user on this turn; the DB transcript stays clean.
          const msg = existingSummaryData.summary
            ? '上下文已经压缩过，新消息不多，暂不需要再次压缩。'
            : '对话还很短，暂不需要压缩。';
          releaseSessionLock(session_id, lockId);
          setSessionRuntimeStatus(session_id, 'idle');
          const sseData = `data: ${JSON.stringify({ type: 'text', data: msg })}\n\ndata: ${JSON.stringify({ type: 'done' })}\n\n`;
          return new Response(sseData, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
        }

        const msgData = rowsToCompactCandidate.map(m => ({ role: m.role, content: m.content }));
        const result = await compressConversation({
          sessionId: session_id,
          messages: msgData,
          existingSummary: existingSummaryData.summary || undefined,
          providerId: provider_id || session.provider_id || undefined,
          sessionModel: model || session.model || undefined,
        });

        // Coverage boundary = rowid of the last message actually compressed
        // in THIS pass (the last of rowsToCompactCandidate). If the filter
        // returned nothing (shouldn't happen — short path above covers it)
        // fall back to the existing boundary rather than resetting to 0.
        const compactBoundaryRowid =
          rowsToCompactCandidate[rowsToCompactCandidate.length - 1]._rowid
          ?? existingSummaryData.boundaryRowid
          ?? 0;
        // Do NOT persist the confirmation message to DB. It's a UI artifact
        // — the summary + SSE frame already convey the outcome. Persisting it
        // as an assistant message would leak "上下文已压缩..." into the
        // transcript the model sees on subsequent turns (rowid > boundary
        // → kept by filter). Claude Code's own /compact handler behaves the
        // same way: slash-command feedback stays out of the model's context.
        const msg = `上下文已压缩。压缩了 ${result.messagesCompressed} 条消息，预计节省 ~${Math.round(result.estimatedTokensSaved / 1000)}K tokens。`;
        updateDbSummary(session_id, result.summary, compactBoundaryRowid);
        // Invalidate the SDK session so the next user message does NOT resume
        // the old (pre-compaction) transcript. Without this, the Claude Code
        // SDK keeps using its own full history on resume and our fresh summary
        // would never reach the model — reactive compact would re-trigger on
        // the very next turn. See feedback_db_migration_safety note: we only
        // clear the session-id link, never the underlying messages.
        updateSdkSessionId(session_id, '');
        releaseSessionLock(session_id, lockId);
        setSessionRuntimeStatus(session_id, 'idle');
        // Emit context_compressed BEFORE the text event so the SSE consumer
        // (useSSEStream) updates hasSummary via the dedicated dispatch path
        // before the text arrives and the stream terminates.
        const compressedStatusFrame = `data: ${JSON.stringify({
          type: 'status',
          data: JSON.stringify(buildContextCompressedStatus({
            messagesCompressed: result.messagesCompressed,
            tokensSaved: result.estimatedTokensSaved,
          })),
        })}\n\n`;
        const sseData = compressedStatusFrame
          + `data: ${JSON.stringify({ type: 'text', data: msg })}\n\n`
          + `data: ${JSON.stringify({ type: 'done' })}\n\n`;
        return new Response(sseData, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
      } catch (compactErr) {
        console.error('[chat API] /compact failed:', compactErr);
        releaseSessionLock(session_id, lockId);
        setSessionRuntimeStatus(session_id, 'idle');
        return new Response(JSON.stringify({ error: 'Compression failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Telegram notification: session started (fire-and-forget)
    // Skip for auto-trigger turns (onboarding/heartbeat) — these are invisible system triggers
    const telegramNotifyOpts = {
      sessionId: session_id,
      // Same derivation as the fallback title below, so the Telegram
      // notification and the sidebar never disagree about what this chat is
      // called (and the notification doesn't leak mention-expanded paths).
      sessionTitle: session.title !== 'New Chat'
        ? session.title
        : deriveConversationTitle(displayOverride || content) || session.title,
      workingDirectory: session.working_directory,
    };
    if (!autoTrigger) {
      notifySessionStart(telegramNotifyOpts).catch(() => {});
    }

    // Save user message — persist file metadata so attachments survive page reload
    // Skip saving for autoTrigger messages (invisible system triggers for assistant hooks)
    // Use displayOverride for DB storage if provided (e.g. /skillName instead of expanded prompt)
    let savedContent = displayOverride || content;
    let fileMeta: Array<{ id: string; name: string; type: string; size: number; filePath: string }> | undefined;
    /** Set ONLY on the first real user turn (see the fallback-title CAS below).
     *  Non-null hands Phase 2 semantic title generation to `collectStreamResponse`,
     *  which fires it in the background after a clean completion. */
    let titleGenerationInput: string | null = null;
    if (!autoTrigger) {
      if (files && files.length > 0) {
        const workDir = session.working_directory;
        const uploadDir = path.join(workDir, '.codepilot-uploads');
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }
        fileMeta = await Promise.all(files.map(async (f) => {
          // Directory references travel through the same files[] pipeline
          // (so they render as chips in the message bubble), but they
          // don't have file content — skip the disk write and just
          // preserve the user-facing directory path verbatim. The chip
          // renderer keys off `type === 'inode/directory'` to switch to
          // the Folder icon and skip URL fetching.
          if (f.type === 'inode/directory') {
            return { id: f.id, name: f.name, type: f.type, size: 0, filePath: f.filePath || '' };
          }
          // #628 — @-mention of an in-tree project file: preserve the REAL path so
          // the AI's Read/Edit lands on the user's actual file, not a copy. Never
          // trust the client path — resolveInTreeAttachmentPath realpath-resolves
          // it (rejecting symlinks that escape cwd, Codex P1) and requires
          // containment; out-of-cwd / symlink / missing → null → fall through to
          // the copy below (non-destructive).
          const inTreeReal = await resolveInTreeAttachmentPath(f.originPath, workDir);
          if (inTreeReal) {
            return { id: f.id, name: f.name, type: f.type, size: f.size, filePath: inTreeReal };
          }
          const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
          const buffer = Buffer.from(f.data, 'base64');
          fs.writeFileSync(filePath, buffer);
          return { id: f.id, name: f.name, type: f.type, size: buffer.length, filePath };
        }));
        savedContent = `<!--files:${JSON.stringify(fileMeta)}-->${displayOverride || content}`;
      }
      addMessage(session_id, 'user', savedContent);

      // Fallback title — derived from the first REAL user message, which is
      // exactly the message we just persisted (autoTrigger turns never reach
      // here, so an invisible system trigger can't name the user's chat).
      //
      // Input is `displayOverride || content`, NOT `content`: `content` is the
      // model-facing text and may carry the `[Referenced Directories]` block
      // expanded from @-mentions / directory chips. Titling on that leaked
      // attachment paths and file summaries into the sidebar (the privacy bug
      // this replaces).
      //
      // The CAS on 'placeholder' is what makes this safe to run on every
      // non-autoTrigger send instead of gating on `title === 'New Chat'`: a
      // session that already has any real title — manual, system, import, or
      // an earlier fallback — matches zero rows and is left alone.
      const fallbackTitle = deriveConversationTitle(displayOverride || content);
      if (fallbackTitle) {
        // The CAS return value doubles as the "this is the FIRST real turn"
        // signal for Phase 2 semantic generation: it is true exactly once per
        // session, on the send that moved `placeholder -> fallback`. Deriving
        // "first turn" this way rather than by counting messages means the two
        // features can never disagree about which message named the chat.
        const landed = updateSessionTitle(session_id, fallbackTitle, 'fallback', {
          expectOrigin: ['placeholder'],
        });
        if (landed) {
          titleGenerationInput = displayOverride || content;
        }
      }
    }

    // Determine model: request override > session model. We deliberately
    // do NOT fall through to `getSetting('default_model')` here — Phase 2
    // Step 3 contract (drift point #5) is "session.model is the truth;
    // global settings only seed new chats, never silently affect old ones".
    // If both request body and session.model are empty (new chat first
    // send, or legacy row), we let the resolver pick a candidate from the
    // provider's available models; whatever it returns is then lazy-seeded
    // back to session.model below so subsequent sends are stable.
    let effectiveModel = model || session.model || undefined;

    // When Claude Code is disabled, sessions with env-provider models
    // (sonnet/opus/haiku) can't use them anymore. The only "safe" silent
    // move (clearing to undefined → resolver picks next) is preserved
    // here as a degenerate-state fallback. NOTE: this branch still
    // reads `default_model` from settings for the env-only escape-hatch
    // case — that's separate from the Step 3 contract about session.model
    // being the source of truth (see the line above that drops the
    // legacy `|| default_model` tail). RED #5 closes because the
    // `session.model OR default_model` chain shape is no longer present;
    // this read is a different shape (standalone, only inside the
    // env-only degenerate branch).
    const cliDisabled = getSetting('cli_enabled') === 'false';
    const ENV_MODELS = new Set(['sonnet', 'opus', 'haiku']);
    const effectiveProviderId_pre = provider_id || session.provider_id || '';
    if (cliDisabled && effectiveModel && ENV_MODELS.has(effectiveModel) && (!effectiveProviderId_pre || effectiveProviderId_pre === 'env')) {
      effectiveModel = getSetting('default_model') || undefined;
      if (effectiveModel && ENV_MODELS.has(effectiveModel)) {
        effectiveModel = undefined;
      }
    }

    // Phase 2 Step 3 — `resolved` was computed in the early gate above
    // (before any side effects, so an invalid session can fail closed
    // without leaving a half-written user turn in the DB). Reuse the
    // same value here for downstream lazy-seeding + persistence.
    const effectiveProviderId = provider_id || session.provider_id || '';

    // Lazy-seed session.model + session.provider_id: when the chat had
    // no committed model/provider (legacy row, brand-new session whose
    // first message didn't carry either), persist whatever the resolver
    // picked so the next send no longer needs to re-resolve via the
    // global picker. This is the contract that lets the route stop
    // reading `default_model` — session.model + session.provider_id
    // are guaranteed non-empty after first send.
    if (!effectiveModel && resolved.model) {
      effectiveModel = resolved.model;
    }
    if (effectiveModel && effectiveModel !== session.model) {
      updateSessionModel(session_id, effectiveModel);
    }

    const providerName = resolvedProvider?.name || '';
    if (providerName !== (session.provider_name || '')) {
      updateSessionProvider(session_id, providerName);
    }
    // Persist provider_id: prefer request override, then existing session,
    // then the resolver's pick (real DB providers only — virtual
    // 'env' / 'openai-oauth' don't have a row to point at). Without the
    // resolver fallback, a brand-new session whose request didn't carry
    // a provider_id would write '' here and the next send would re-resolve
    // through the global fallback chain — exactly the drift Step 3 closes.
    const persistProviderId = provider_id
      || session.provider_id
      || resolved.provider?.id
      || '';
    if (persistProviderId !== (session.provider_id || '')) {
      updateSessionProviderId(session_id, persistProviderId);
    }

    // Resolve permission mode from request body (sent by frontend on each message)
    // or fall back to session's persisted mode from DB.
    // Request body mode takes priority to avoid race condition: user switches mode
    // then immediately sends — the PATCH may not have landed in DB yet.
    const effectiveMode = mode || session.mode || 'code';

    // Profile → SDK wire options. Plan mode takes precedence over every
    // profile: if the user explicitly chose Plan, they expect no tool
    // execution regardless of permission profile. `auto_review` maps to the
    // SDK's own reviewer ('auto') and never sets the bypass flag; only
    // `full_access` does. See lib/permission/profile.ts for the full ladder.
    const permissionWire = resolveClaudeWireOptions({
      profile: normalizePermissionProfile(session.permission_profile),
      effectiveMode,
      autoReviewSupported: resolveProfileAutoReviewSupport({
        runtime: effectiveSessionRuntime,
        claudeSdkSupported: isAutoReviewSupported(),
      }),
    });
    const permissionMode = permissionWire.permissionMode;
    const bypassPermissions = permissionWire.bypassPermissions;

    // The session persisted a profile this SDK build can't honour. Degrading
    // is allowed (to MORE asking, never less) but going quiet is not — the
    // user picked "review on my behalf" and is owed the news that nobody is
    // reviewing.
    if (permissionWire.degradedReason === 'auto_review_unsupported') {
      console.warn(
        `[chat] Session ${session_id} requested auto_review but the installed Agent SDK does not support it`,
        getAutoReviewUnavailableReason(),
      );
      // A console line is not an audit trail and is not a user-visible fact.
      // The canonical `unavailable` event is what records that this turn ran
      // with nobody reviewing, and it is a DENYING state by contract — the
      // session says 替我审批 while the wire says "ask the user for
      // everything", and that gap has to be attributable after the fact.
      emitReviewEvent(buildReviewEvent({
        state: 'unavailable',
        requestId: `auto-review-unavailable-${session_id}`,
        sessionId: session_id,
        runtimeId: 'claude_code',
        reviewerSource: 'sdk-reviewer',
        toolName: '*',
        reason: (() => {
          const gap = getAutoReviewUnavailableReason();
          return gap
            ? `Agent SDK ${gap.installedVersion ?? 'unknown'} < ${gap.minVersion} required for auto_review`
            : 'auto_review_unsupported';
        })(),
      }));
    }
    const systemPromptOverride: string | undefined = undefined;

    const abortController = new AbortController();

    // Handle client disconnect
    request.signal.addEventListener('abort', () => {
      abortController.abort();
    });

    // Convert file attachments to the format expected by streamClaude.
    // Include filePath from the already-saved files so claude-client can
    // reference the on-disk copies instead of writing them again.
    const fileAttachments: FileAttachment[] | undefined = files && files.length > 0
      ? files.map((f, i) => {
          const meta = fileMeta?.find((m: { id: string }) => m.id === f.id);
          return {
            id: f.id || `file-${Date.now()}-${i}`,
            name: f.name,
            type: f.type,
            size: f.size,
            data: meta?.filePath ? '' : f.data, // Clear base64 once written to disk — claude-client reads from filePath on demand
            filePath: meta?.filePath,
          };
        })
      : undefined;

    // Load conversation history from DB as fallback context.
    // Fetch up to 200 messages (DB query is cheap); actual truncation is done
    // by buildFallbackContext using a token budget, not a fixed message count.
    const { messages: recentMsgs } = getMessages(session_id, { limit: 200, excludeHeartbeatAck: true });
    // Load session summary for compression-aware fallback (needed before the
    // compact-boundary filter below).
    const sessionSummaryData = getSessionSummary(session_id);

    // Exclude the user message we just saved (last in the list) — it's already the prompt
    const historyBeforeBoundary = recentMsgs.slice(0, -1);
    // Drop history at-or-before the coverage boundary
    // (context_summary_boundary_rowid — the rowid of the last message
    // actually covered by the summary). Rowid, not timestamp: disambiguates
    // same-second writes. See filterHistoryByCompactBoundary doc.
    const { filterHistoryByCompactBoundary } = await import('@/lib/context-compressor');
    const historyAfterBoundary = filterHistoryByCompactBoundary({
      history: historyBeforeBoundary,
      summary: sessionSummaryData.summary,
      summaryBoundaryRowid: sessionSummaryData.boundaryRowid,
    });
    if (historyAfterBoundary.length < historyBeforeBoundary.length) {
      console.log(`[chat API] Compact boundary filter: dropped ${historyBeforeBoundary.length - historyAfterBoundary.length} messages at-or-before rowid ${sessionSummaryData.boundaryRowid}, kept ${historyAfterBoundary.length}`);
    }
    // Preserve _rowid through to streamClaude: if a CONTEXT_TOO_LONG
    // reactive compact fires inside streamClaude on this turn, it needs the
    // rowids in conversationHistory to write a correct
    // context_summary_boundary_rowid. Without this, reactive compact would
    // fall back to the "preserve existing boundary" degraded path.
    const historyMsgs = historyAfterBoundary.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      _rowid: m._rowid,
    }));

    // Unified context assembly — extracts workspace, CLI tools, widget prompt
    const assembled = await assembleContext({
      session,
      entryPoint: 'desktop',
      userPrompt: content,
      systemPromptAppend,
      conversationHistory: historyMsgs,
      autoTrigger: !!autoTrigger,
    });
    const finalSystemPrompt = assembled.systemPrompt;
    const generativeUIEnabled = assembled.generativeUIEnabled;
    const assistantProjectInstructions = assembled.assistantProjectInstructions;
    const isAssistantProject = assembled.isAssistantProject;

    // Load MCP servers for the predicted runtime:
    // - SDK Runtime: only needs servers with ${...} env placeholders (SDK loads the rest via settingSources)
    // - Native Runtime: needs ALL servers (it manages MCP connections independently)
    // Note: was a lazy `require()` previously; converted to static import after
    // Turbopack's CJS↔ESM interop started returning `{ default: ... }` shape
    // and broke "predictNativeRuntime is not a function" at runtime.
    const mcpServers = predictNativeRuntime(effectiveProviderId)
      ? loadAllMcpServers()
      : loadCodePilotMcpServers();

    // ── Context compression check ───────────────────────────────────
    // Estimate next-turn context size and compress if over threshold.
    let activeSessionSummary = sessionSummaryData.summary || undefined;
    let fallbackTokenBudget: number | undefined;
    let compressionOccurred = false;
    let compressionStats: { messagesCompressed: number; tokensSaved: number } | null = null;

    // Stream handoff variables. Default to the resume path (use the stored SDK
    // session, full history). When auto-compression succeeds below, these get
    // switched to the fresh-session path via planStreamHandoffAfterCompaction:
    // sdkSessionId = undefined (force fresh SDK session so our new summary is
    // actually seen by the model) and conversationHistory = messagesToKeep
    // (avoid feeding the summary + the turns that summary already covers).
    let streamSdkSessionId: string | undefined = session.sdk_session_id || undefined;
    let streamConversationHistory: typeof historyMsgs = historyMsgs;

    try {
      const { estimateContextTokens } = await import('@/lib/context-estimator');
      const { getContextWindow } = await import('@/lib/model-context');
      const { needsCompression, compressConversation } = await import('@/lib/context-compressor');
      const { updateSessionSummary } = await import('@/lib/db');

      const modelForWindow = resolved.upstreamModel || resolved.model || effectiveModel || 'sonnet';
      // Pass upstream explicitly so alias lookups (e.g. 'opus') resolve to
      // the correct per-provider window — first-party opus → 4.7 (1M) vs
      // Bedrock/Vertex opus → 4.6 (200K).
      const contextWindow = getContextWindow(modelForWindow, {
        context1m: context_1m,
        upstream: resolved.upstreamModel,
      }) || 200000;

      // Estimate using normalized content (matches what buildFallbackContext actually sends).
      // Raw transcript overestimates tool-heavy conversations because normalize + microcompact
      // strip metadata and truncate old tool results significantly.
      const { normalizeMessageContent, microCompactMessage } = await import('@/lib/message-normalizer');
      const { roughTokenEstimate } = await import('@/lib/context-estimator');
      const normalizedHistory = historyMsgs.map((m, i) => ({
        role: m.role,
        content: microCompactMessage(m.role, normalizeMessageContent(m.role, m.content), historyMsgs.length - 1 - i),
      }));

      const estimate = estimateContextTokens({
        systemPrompt: finalSystemPrompt,
        history: normalizedHistory,
        currentUserMessage: content,
        sessionSummary: activeSessionSummary,
      });

      // Budget for history = 70% of window minus system prompt, summary, and current user message.
      // buildFallbackContext adds summary + prompt on top of the history, so we must account for them.
      fallbackTokenBudget = Math.floor(
        contextWindow * 0.7 - estimate.breakdown.system - estimate.breakdown.summary - estimate.breakdown.userMessage
      );

      if (needsCompression(estimate.total, contextWindow, session_id)) {
        console.log(`[chat API] Context at ${((estimate.total / contextWindow) * 100).toFixed(1)}% — triggering compression`);

        // Slice keep/compress on the raw DB rows (with _rowid) FIRST, then
        // map to {role, content} when calling compressConversation. This
        // preserves rowid on rowsToCompress so we can write the true
        // coverage boundary below. historyMsgs[i] corresponds 1:1 to
        // historyAfterBoundary[i] (same filter result, the map at L299
        // just drops fields).
        const recentBudget = Math.floor(contextWindow * 0.5);
        const rowsToKeep: typeof historyAfterBoundary = [];
        let keptTokens = 0;
        for (let i = normalizedHistory.length - 1; i >= 0; i--) {
          const msgTokens = roughTokenEstimate(normalizedHistory[i].content) + 10;
          if (keptTokens + msgTokens > recentBudget) break;
          rowsToKeep.unshift(historyAfterBoundary[i]);
          keptTokens += msgTokens;
        }
        const rowsToCompress = historyAfterBoundary.slice(0, historyAfterBoundary.length - rowsToKeep.length);
        // messagesToKeep must carry _rowid through — if a reactive compact
        // fires on this same turn (CONTEXT_TOO_LONG retry) it will see
        // these rows as conversationHistory and need the rowids to write a
        // correct boundary. messagesToCompress only feeds compressConversation
        // which needs role/content; no need to plumb _rowid there.
        const messagesToKeep = rowsToKeep.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content, _rowid: m._rowid }));
        const messagesToCompress = rowsToCompress.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

        if (messagesToCompress.length > 0) {
          try {
            const result = await compressConversation({
              sessionId: session_id,
              messages: messagesToCompress,
              existingSummary: activeSessionSummary,
              providerId: effectiveProviderId || undefined,
              sessionModel: effectiveModel || undefined,
            });
            activeSessionSummary = result.summary;
            // Coverage boundary = rowid of the last message actually in
            // messagesToCompress. rowid, not timestamp: rowsToCompress.last
            // and rowsToKeep.first may share a second on fast paths and the
            // strict-gt filter would mis-classify one of them. Do NOT use
            // summary WRITE time: the current user turn was addMessage'd
            // just before this branch ran and sits at a created_at slightly
            // earlier than "now", which would silently drop it on the next
            // turn's filter. The user turn has rowid strictly greater than
            // any row in rowsToCompress, so the rowid boundary naturally
            // spares it.
            const autoCompactBoundaryRowid = rowsToCompress[rowsToCompress.length - 1]._rowid ?? 0;
            updateSessionSummary(session_id, result.summary, autoCompactBoundaryRowid);
            // Recalculate budget with new (larger) summary
            const newSummaryTokens = roughTokenEstimate(result.summary);
            const userMsgTokens = roughTokenEstimate(content);
            fallbackTokenBudget = Math.floor(
              contextWindow * 0.7 - estimate.breakdown.system - newSummaryTokens - userMsgTokens
            );
            // Flag so we can notify frontend via a leading SSE event
            compressionOccurred = true;
            compressionStats = {
              messagesCompressed: result.messagesCompressed,
              tokensSaved: result.estimatedTokensSaved,
            };

            // Force this turn AND all subsequent turns off SDK resume — see
            // planStreamHandoffAfterCompaction for the rationale.
            updateSdkSessionId(session_id, '');
            const { planStreamHandoffAfterCompaction } = await import('@/lib/context-compressor');
            const handoff = planStreamHandoffAfterCompaction({
              compressed: true,
              originalHistory: historyMsgs,
              messagesToKeep,
              originalSdkSessionId: streamSdkSessionId,
            });
            streamSdkSessionId = handoff.sdkSessionId;
            streamConversationHistory = handoff.conversationHistory;

            console.log(`[chat API] Compressed ${result.messagesCompressed} messages, saved ~${result.estimatedTokensSaved} tokens; cleared SDK session, switching to fresh query with summary + ${messagesToKeep.length} recent turns`);
          } catch (compErr) {
            console.warn('[chat API] Compression failed, proceeding without:', compErr);
          }
        }
      }
    } catch (estimateErr) {
      console.warn('[chat API] Context estimation failed, proceeding without compression:', estimateErr);
    }

    // Stream Claude response, using SDK session ID for resume if available
    console.log('[chat API] streamClaude params:', {
      promptLength: content.length,
      promptFirst200: content.slice(0, 200),
      // Log the handoff value, not the DB value — after auto-compaction these
      // diverge and the handoff is what streamClaude actually receives.
      sdkSessionId: streamSdkSessionId || 'none',
      compressionOccurred,
      historyMessageCount: streamConversationHistory.length,
      systemPromptLength: finalSystemPrompt?.length || 0,
      systemPromptFirst200: finalSystemPrompt?.slice(0, 200) || 'none',
    });
    const stream = streamClaude({
      prompt: content,
      callScene: 'interactive_chat',
      sessionId: session_id,
      // Session-lock ownership token minted above (crypto.randomBytes). Plumbed
      // so this turn's Query registers/unregisters under the lock owner (I1 gate).
      lockId,
      sdkSessionId: streamSdkSessionId,
      model: resolved.upstreamModel || resolved.model || effectiveModel,
      systemPrompt: finalSystemPrompt,
      workingDirectory: session.sdk_cwd || session.working_directory || undefined,
      abortController,
      permissionMode,
      files: fileAttachments,
      toolTimeoutSeconds: toolTimeout || 300,
      provider: resolvedProvider,
      // Use the lazy-seeded provider id so a brand-new chat (request
      // didn't carry a provider, session.provider_id was empty) actually
      // sends to the resolver-picked provider on this turn — not just
      // on the next one after `persistProviderId` writes back. Same
      // priority chain as the persist branch above.
      providerId: persistProviderId || effectiveProviderId || undefined,
      sessionProviderId: session.provider_id || undefined,
      // Phase 2 Step 3: pass the session's runtime pin so streamClaude
      // honors per-session execution-engine commitment over the global
      // `agent_runtime` setting. Empty pin → streamClaude falls back to
      // global, preserving today's behavior for legacy / unpinned chats.
      sessionRuntimePin: session.runtime_pin || undefined,
      mcpServers,
      conversationHistory: streamConversationHistory,
      sessionSummary: activeSessionSummary,
      // Plumbed through so reactive compact (CONTEXT_TOO_LONG retry inside
      // streamClaude) can preserve the already-established boundary when
      // conversationHistory has no _rowid to derive a new one from. Prevents
      // a degraded reactive compact from silently resetting a real boundary
      // back to 0 and regressing the next turn's filter to passthrough.
      sessionSummaryBoundaryRowid: sessionSummaryData.boundaryRowid,
      fallbackTokenBudget,
      bypassPermissions,
      thinking: thinking as ClaudeStreamOptions['thinking'],
      effort: effort as ClaudeStreamOptions['effort'],
      context1m: context_1m,
      generativeUI: generativeUIEnabled,
      enableFileCheckpointing: enableFileCheckpointing ?? true,
      autoTrigger: !!autoTrigger,
      selectedSkills,
      onRuntimeStatusChange: (status: string) => {
        // I1 ownership gate: a superseded turn (its session lock taken over by a
        // newer turn) must not write session-level runtime_status. lockId is the
        // owner token minted at :85 and is directly in scope here.
        try {
          if (isLockOwner(session_id, lockId)) {
            setSessionRuntimeStatus(session_id, status);
          } else {
            console.warn(`[chat/route] stale owner (lockId superseded), skipping runtime_status write for session ${session_id}`);
          }
        } catch { /* best effort */ }
      },
    });

    // Tee the stream: one for client, one for collecting the response
    const [streamForClient, streamForCollect] = stream.tee();

    // Session lock renewal — renewal interval + its autoTrigger cap
    // counter are forward-declared here (assigned after settleLock below). The
    // interval callback now references settleLock (to force-settle at the cap),
    // and settleLock's clearRenewal closure references lockRenewalInterval — a
    // mutual reference. Declaring both as `let` before settleLock, then creating
    // the interval AFTER settleLock is defined, avoids a TDZ: settleLock is a
    // live const by the time the interval closes over it, and lockRenewalInterval
    // is assigned before any 60s tick or settle can run clearRenewal.
    let renewalCount = 0;
    // eslint-disable-next-line prefer-const -- intentional forward declaration for the mutual closures described above
    let lockRenewalInterval: ReturnType<typeof setInterval>;

    // codex-stop-recovery Phase 3 — Stop/abort watchdog resources. Declared
    // before the settler so its (one-shot) clearRenewal can also tear these
    // down: whichever settle path fires first must clear the pending
    // setTimeout AND detach the abort listener, or the timer keeps the event
    // loop alive for the full grace window after a turn already settled
    // normally, and the listener lingers on abortController (audit ⑥).
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdogAbortListener: (() => void) | undefined;
    const clearWatchdog = () => {
      if (watchdogTimer !== undefined) {
        clearTimeout(watchdogTimer);
        watchdogTimer = undefined;
      }
      if (watchdogAbortListener) {
        abortController.signal.removeEventListener('abort', watchdogAbortListener);
        watchdogAbortListener = undefined;
      }
    };

    // codex-stop-recovery Phase 3 — one settler shared by the normal completion
    // path and the Stop/abort watchdog below. Idempotent; only writes status
    // when releaseSessionLock confirms we still own the lock (lockId-scoped
    // release vs session-scoped status — see session-lock-settle.ts).
    const settleLock = createSessionLockSettler({
      // Runs exactly once (settler is one-shot) — tear down both the renewal
      // interval and the watchdog timer/listener at the first settle.
      clearRenewal: () => { clearInterval(lockRenewalInterval); clearWatchdog(); },
      releaseLock: () => releaseSessionLock(session_id, lockId),
      setStatus: (status) => { try { setSessionRuntimeStatus(session_id, status); } catch { /* best effort */ } },
    });

    // Periodically renew the session lock so long-running tasks don't expire.
    // Session lock renewal bounds two runaway modes via the pure
    // evaluateRenewal decision (session-lock-renewal.ts):
    //  - DP3 (both turn types): renewSessionLock returned false → this lockId no
    //    longer owns the row (taken over / already released). Stop renewing; the
    //    interval is spinning on a lock we don't hold.
    //  - I3 (autoTrigger only): a stuck background/heartbeat turn would renew
    //    forever and beat the TTL. Cap at AUTO_TRIGGER_MAX_RENEWALS renewals,
    //    then settle('interrupted') so the session can be reclaimed.
    // Foreground turns stay uncapped (bounded by the Stop/abort watchdog below).
    lockRenewalInterval = setInterval(() => {
      let renewed: boolean;
      try {
        renewed = renewSessionLock(session_id, lockId, 600);
      } catch {
        // Transient DB error — best effort. Keep the interval alive (do NOT
        // conflate a throw with a definitive renew-false) and retry next tick.
        return;
      }
      // Only advance the cap counter on a successful renew of an autoTrigger
      // turn; a renew-false tick is handled as DP3 stop below, not a cap step.
      if (autoTrigger && renewed) renewalCount++;
      const decision = evaluateRenewal({
        autoTrigger: !!autoTrigger,
        renewalCount,
        renewed,
        max: AUTO_TRIGGER_MAX_RENEWALS,
      });
      if (decision === 'stop-renew-false') {
        console.warn(`[chat/route] lockId 已不 own（被接管/已释放），停止续租 session ${session_id}`);
        clearInterval(lockRenewalInterval);
        return;
      }
      if (decision === 'settle-cap') {
        console.warn(`[chat/route] autoTrigger 续租达上限 ${AUTO_TRIGGER_MAX_RENEWALS}，settle interrupted session ${session_id}`);
        settleLock('interrupted');
        return;
      }
      // 'continue' — still own the lock and under any cap; wait for next tick.
    }, 60_000);

    // Save assistant message in background, with cleanup callback to release lock
    const isHeartbeatTurn = !!autoTrigger && content.includes('心跳检查');
    collectStreamResponse(streamForCollect, session_id, lockId, telegramNotifyOpts, () => {
      settleLock('idle');
    }, {
      isHeartbeatTurn,
      suppressNotifications: !!autoTrigger,
      // Phase 2 semantic title. Non-null only on the first real user turn.
      // The provider/runtime handed over here are THIS session's resolved
      // values — the same ones that answered the message — so generation can
      // never reach a provider the user didn't pick for this chat.
      titleGeneration: titleGenerationInput
        ? {
            userText: titleGenerationInput,
            runtime: effectiveSessionRuntime,
            providerId: persistProviderId || effectiveProviderId || '',
            model: resolved.upstreamModel || resolved.model || effectiveModel || undefined,
          }
        : undefined,
    });

    // codex-stop-recovery Phase 3 — Stop/abort watchdog. The normal path settles
    // when the runtime stream closes on a terminal event. But a turn that's
    // interrupted yet never emits a terminal event (a Codex stuck turn) would
    // leave collect reading forever and the lock renewing forever → the next
    // same-session send is blocked by SESSION_BUSY indefinitely. When the request
    // aborts (Stop force-abort / client disconnect) we give the natural
    // interrupt→terminal→collect path a grace window, then force the lock to
    // settle. Gated on !autoTrigger: background/heartbeat turns must keep running
    // (and keep their lock) even after their initiating request disconnects.
    if (!autoTrigger) {
      // Save the setTimeout handle + listener ref so a normal settle can cancel
      // the pending force-settle and detach this listener (clearWatchdog above).
      watchdogAbortListener = () => {
        watchdogTimer = setTimeout(() => settleLock('interrupted'), LOCK_RECOVERY_GRACE_MS);
      };
      abortController.signal.addEventListener('abort', watchdogAbortListener, { once: true });
    }

    // If auto-compression happened, prepend a notification event to the stream.
    // The message is human-readable so the browser status bar shows something
    // meaningful, and includes structured data for future rich UI handling.
    const responseStream = compressionOccurred
      ? new ReadableStream<string>({
          async start(controllerRaw) {
            const controller = wrapController(controllerRaw);
            controller.enqueue(`data: ${JSON.stringify({
              type: 'status',
              data: JSON.stringify(buildContextCompressedStatus({
                messagesCompressed: compressionStats?.messagesCompressed ?? 0,
                tokensSaved: compressionStats?.tokensSaved ?? 0,
              })),
            })}\n\n`);
            const reader = streamForClient.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
                if (controller.closed) break; // consumer aborted
              }
            } finally {
              controller.close();
            }
          },
        })
      : streamForClient;

    return new Response(responseStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    // Release lock and reset status on error (only if lock was acquired)
    if (activeSessionId && activeLockId) {
      try {
        releaseSessionLock(activeSessionId, activeLockId);
        setSessionRuntimeStatus(activeSessionId, 'idle', error instanceof Error ? error.message : 'Unknown error');
      } catch { /* best effort */ }
    }

    const message = error instanceof Error ? error.message : 'Internal server error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
