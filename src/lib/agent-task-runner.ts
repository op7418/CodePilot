/**
 * Phase 3 Step 4 — background Agent task runner.
 *
 * **Step 4a → 4b transition (now active in 4b)**:
 *
 *   - **4a delivered** the architectural shell — task-bound chat
 *     session creation / reuse, `task.source` branching, HEARTBEAT_OK
 *     silent contract, message persistence with `task_run_id`
 *     metadata, marker render path. Underlying model call was
 *     `generateTextFromProvider` (one-shot text, no tools, no
 *     permission events).
 *
 *   - **4b swaps the model call** to headless `streamClaude` via
 *     `runClaudeHeadless` (see `lib/headless-claude.ts`). Tasks now go
 *     through the same Runtime / Agent execution chain as interactive
 *     chat. Tool calls, file reads, permission requests are real;
 *     `waiting_for_permission` is reachable when the agent hits a
 *     permission gate while running headless. The runner's return
 *     signature is unchanged from 4a — the swap is local to the
 *     `// 4. Model call` block.
 *
 * `task.source` branching:
 *
 *   - `'user'` → task-bound session (`chat_sessions.source='task'`,
 *     hidden from main list). Headless streamClaude consumes the
 *     stream; `permission_request` → `status: 'waiting_for_permission'`
 *     with partial assistant text persisted; `scheduled_tasks.status`
 *     → `'paused'` so the scheduler doesn't refire.
 *
 *   - `'assistant_heartbeat'` → buddy session (lazy-created if the
 *     user toggles heartbeat on before opening the workspace). Same
 *     headless streamClaude path; HEARTBEAT_OK silent contract gates
 *     the assistant message + notification.
 *
 * **No durable resume** — the v2 plan's hard line. When the runner
 * sees `permission_request` it cancels the stream completely. The
 * partial assistant text is persisted with `task_run_id` metadata
 * so the user can see what the agent was thinking; choosing
 * "Re-run" starts a brand new run with a fresh runId from scratch.
 *
 * **Marker render contract** — every message persisted here carries
 * `metadata.task_run_id`. MessageList renders `<TaskRunMarker />`
 * before the first message of each run group. The marker is RENDER-
 * ONLY — `task_run_id` is never written into `message.content` and
 * never enters the LLM prompt context.
 */

import type { ScheduledTask, TaskRunStatus } from '@/types';
import { normalizePermissionProfile } from '@/lib/permission/profile';

export interface AgentTaskRunResult {
  status: TaskRunStatus;
  /** The model's text output (or the error explanation, when status='failed'). */
  result?: string;
  /** Specific error text for status='failed'. */
  error?: string;
  /** Session id this run wrote to (created or reused). Undefined only on
   *  catastrophic failures before a session could be resolved. */
  sessionId?: string;
  /** Heartbeat-only: true when model output matched the silent contract
   *  (`HEARTBEAT_OK` exact match after trim). The caller MUST suppress
   *  the assistant-message write AND the notification. False (or
   *  undefined) means speak-up. */
  silent?: boolean;
  /** Id of the run row this result corresponds to. Set by the runner
   *  internally (it inserts the row before the model call) so the
   *  caller can update / link without a second insert. */
  runId: string;
}

/**
 * Resolve an existing task-bound session (`task.session_id`) or create
 * a new one. Persists the new session id back to `scheduled_tasks` so
 * subsequent runs reuse the same conversation.
 */
export async function ensureTaskBoundSession(task: ScheduledTask): Promise<string> {
  const { getSession, createSession, updateScheduledTask, updateSessionRuntime } =
    await import('@/lib/db');
  if (task.session_id) {
    const existing = getSession(task.session_id);
    // Codex P2 follow-up — non-heartbeat ai_task tasks must ONLY
    // reuse a session whose `source === 'task'`. Two attack paths
    // this guard closes:
    //
    //   1. Legacy dirty rows from before origin_session_id existed —
    //      task.session_id was set (by an earlier-rev ensureTask path
    //      or a manual repair) to point at a user-visible chat. After
    //      the origin_session_id fix, the runner would still trust
    //      that pointer and write the task's assistant message into
    //      the user's regular chat. Any pre-existing scheduled_tasks
    //      row with session_id pointing at a `source='user'` chat
    //      would silently keep the old behaviour forever.
    //
    //   2. /api/tasks/schedule still accepts session_id from the
    //      POST body. The schedule_task tool doesn't send it (we
    //      removed that), but a misconfigured external caller could
    //      still POST one and have the runner write into a
    //      user-visible chat.
    //
    // Defence: ignore any existing session that isn't already a
    // task-bound execution session, and fall through to the create
    // branch below (which will inherit from origin_session_id and
    // overwrite task.session_id with the new task-bound id). The
    // task-bound session always has source='task' — it's set on
    // creation by `createSession(..., 'task')`.
    if (existing && existing.source === 'task') {
      return existing.id;
    }
    // Otherwise fall through — even if `existing` is defined but
    // user-source, we DO NOT return it. The new task-bound session
    // created below will become this task's session, the dirty
    // pointer gets overwritten on persist, and from now on the
    // legacy bug is closed for this row.
  }
  // Phase 3 Step 4 follow-up — inherit the originating chat session's
  // runtime context into the task-bound session. Without this the
  // runner used to fall back to whatever the global default was at
  // tick time, so a task scheduled from project A could end up
  // executing in project B's working dir / provider / runtime, or
  // worse, write its result into the assistant's latest visible
  // session because no per-project anchoring existed.
  //
  // Origin chain (every field independently fallable so a partially-
  // populated origin row still helps):
  //   1. task.origin_session_id → chat_sessions row (the user chat
  //      where the model called codepilot_schedule_task)
  //   2. task.working_directory (POSTed alongside origin_session_id;
  //      the closure-captured stream cwd)
  //   3. otherwise undefined / 'default' / etc.
  //
  // We DELIBERATELY do NOT call resolveBuddySessionId or
  // getLatestSessionByWorkingDirectory here — the buddy/heartbeat
  // surface is for the heartbeat path only. Mixing them re-introduces
  // the cross-project bleed the origin_session_id column was added
  // to fix.
  let originSession = task.origin_session_id ? getSession(task.origin_session_id) : undefined;
  if (originSession && originSession.source === 'task') {
    // Defensive: an origin_session_id pointing at another task-bound
    // session would chain inheritance and confuse provenance. Treat
    // as "no origin" and fall back to task.working_directory.
    originSession = undefined;
  }
  const inheritedWorkingDirectory =
    originSession?.sdk_cwd
    || originSession?.working_directory
    || task.working_directory
    || undefined;
  const inheritedProviderId = originSession?.provider_id || undefined;
  const inheritedModel = originSession?.model || undefined;
  // Inherit the origin session's profile — never upgrade. A background task
  // has no foreground UI to raise a prompt in, which is an argument for
  // asking less, not for granting more.
  const inheritedPermissionProfile = normalizePermissionProfile(originSession?.permission_profile);

  const newSession = createSession(
    `[Task] ${task.name}`,
    inheritedModel,
    undefined,
    inheritedWorkingDirectory,
    'code',
    inheritedProviderId,
    inheritedPermissionProfile,
    'task',
    // The task's name is the session's identity — never re-derive it from
    // whatever prompt the runner happens to send first.
    'system',
  );
  // Inherit runtime_pin separately — createSession doesn't take it as
  // an arg today (it's a Phase 2 column added later). Lift the same
  // pin so the task-bound session honors the origin's per-session
  // runtime commitment.
  if (originSession?.runtime_pin) {
    try {
      updateSessionRuntime(newSession.id, originSession.runtime_pin);
    } catch { /* best-effort */ }
  }
  // Persist session_id back to the task so next run reuses the
  // session. Best-effort: if the update fails for any reason, the next
  // run will create a second session — not ideal but not corrupt.
  try {
    updateScheduledTask(task.id, { session_id: newSession.id });
  } catch { /* swallow — we still proceed with this run */ }
  return newSession.id;
}

/**
 * Resolve (or lazily create) the buddy session for the assistant
 * workspace. Used by the heartbeat path.
 *
 * v2 review fix — earlier rev failed when no workspace session
 * existed yet (heartbeat would error out the moment a user toggled
 * heartbeat on without first opening the workspace), which is a
 * pretty hostile failure mode for "Hermes-style background ping".
 *
 * v2 behavior: when the workspace is configured but no session has
 * been opened yet, lazily create a stable buddy session in the
 * workspace dir so heartbeat speak-up has somewhere to write. The
 * session is `source='user'` (user-visible in the main chat list)
 * because heartbeat output is part of the assistant↔user
 * conversation, not a task-bound execution session. Title makes it
 * obvious where the messages came from when the user later opens it.
 *
 * Returns undefined ONLY when no `assistant_workspace_path` setting
 * is configured at all — the caller treats that as "no workspace,
 * skip the run", which is a different signal from "workspace exists
 * but is fresh".
 */
async function resolveBuddySessionId(): Promise<string | undefined> {
  const { getSetting, getLatestSessionByWorkingDirectory, createSession } = await import('@/lib/db');
  const workspacePath = getSetting('assistant_workspace_path');
  if (!workspacePath) return undefined;
  // Codex review fix — restrict the lookup to `source='user'`. Without
  // this filter, a separate `ai_task` whose `working_directory` happens
  // to point at the assistant workspace would have created a hidden
  // `source='task'` execution session that sorts as the "latest" by
  // updated_at; heartbeat speak-up would then write into that hidden
  // session instead of a user-visible buddy chat.
  const existing = getLatestSessionByWorkingDirectory(workspacePath, {
    includeSources: ['user'],
  });
  if (existing) return existing.id;
  // Lazy create. Source='user' so the session appears in the main
  // chat list — heartbeat speak-up is part of the assistant
  // conversation the user opens manually later. Permission profile
  // 'default' so tool gating still applies once the user starts
  // chatting in it.
  const fresh = createSession(
    'Assistant heartbeat',
    undefined,
    undefined,
    workspacePath,
    'code',
    undefined,
    'default',
    'user',
    // 'system' even though source is 'user': the user can chat here later, but
    // "Assistant heartbeat" is what makes this session findable in the list.
    // Renaming it from the user's first reply would lose that.
    'system',
  );
  return fresh.id;
}

/**
 * Best-effort read of HEARTBEAT.md from the assistant workspace. The
 * contents are appended to the task prompt as additional context so the
 * model's silent / speak-up decision is grounded in what the user wrote
 * in the file. Missing file → empty string (the prompt itself still
 * tells the model what to do).
 */
async function readHeartbeatMd(): Promise<string> {
  try {
    const { getSetting } = await import('@/lib/db');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const workspacePath = getSetting('assistant_workspace_path');
    if (!workspacePath) return '';
    const filePath = path.resolve(workspacePath, 'HEARTBEAT.md');
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Heartbeat silent contract: trim the model output and compare to the
 * literal string `HEARTBEAT_OK`. Anything else (including
 * `HEARTBEAT_OK\n\nfoo`, surrounding prose, or a different sentinel)
 * is speak-up. Locked-down to avoid silent leakage where a model
 * mentions HEARTBEAT_OK in passing but actually has things to say.
 */
export function isHeartbeatSilent(modelOutput: string): boolean {
  return modelOutput.trim() === 'HEARTBEAT_OK';
}

/**
 * Phase 3 Step 4 main entry. The caller (`executeDueTask` in
 * `task-scheduler.ts`) is responsible for the surrounding plumbing:
 * `scheduled_tasks.last_status` flips, `computeNextRun`, notification
 * dispatch, and (for waiting_for_permission) the `status='paused'`
 * gate. This function owns the model call + session/message writing
 * + task_run_logs row lifecycle.
 *
 * `providedRunId` lets `runScheduledTaskNow` (the manual "Run now"
 * flow) hand its pre-allocated row to the runner — that row was
 * created with `status='running'` so the caller could return a runId
 * to the user immediately. When omitted (the scheduler poll path),
 * the runner creates the running row itself.
 */
export async function runScheduledAgentTask(
  task: ScheduledTask,
  providedRunId?: string,
): Promise<AgentTaskRunResult> {
  const { insertTaskRunLog, updateTaskRunLog, addMessage } = await import('@/lib/db');
  const startedAt = Date.now();

  // 1. Use the caller-provided run row when present (e.g. the manual
  //    "Run now" path pre-allocates the row so it can return a runId
  //    synchronously). Otherwise insert running ourselves.
  const runId: string = providedRunId
    ?? insertTaskRunLog({ task_id: task.id, status: 'running' }).runId;

  try {
    // 2. Resolve which session this run writes to.
    let sessionId: string;
    const isHeartbeat = task.source === 'assistant_heartbeat';
    if (isHeartbeat) {
      const buddyId = await resolveBuddySessionId();
      if (!buddyId) {
        const error = 'No assistant workspace / buddy session — heartbeat skipped.';
        updateTaskRunLog(runId, {
          status: 'failed',
          error,
          duration_ms: Date.now() - startedAt,
        });
        return { runId, status: 'failed', error };
      }
      sessionId = buddyId;
    } else {
      sessionId = await ensureTaskBoundSession(task);
    }

    // 3. Build the prompt the model will see.
    let prompt: string;
    if (isHeartbeat) {
      const heartbeatMd = await readHeartbeatMd();
      prompt = [
        task.prompt,
        '',
        '## HEARTBEAT.md content',
        heartbeatMd || '(file missing or empty — assume nothing to report)',
        '',
        'If there is nothing the user needs to know about, respond with EXACTLY the literal string `HEARTBEAT_OK` and nothing else.',
        'Otherwise, write a short message to the user about what needs attention.',
      ].join('\n');
    } else {
      prompt = task.prompt;
      // 3a. user-source ai_task: persist the user prompt as the first
      //     message of this run so opening the task-bound session shows
      //     a real conversation, not just "where did this assistant
      //     reply come from?". Heartbeat skips this — buddy session is
      //     a continuing conversation, the prompt itself is internal.
      try {
        addMessage(sessionId, 'user', task.prompt, undefined, { task_run_id: runId });
      } catch { /* best-effort — model call still goes ahead */ }
    }

    // 4. Model call — Step 4b: headless `streamClaude` via
    //    `runClaudeHeadless`. Replaces 4a's `generateTextFromProvider`
    //    one-shot. Tasks now go through the same Runtime / Agent
    //    execution chain as interactive chat: tool calls, file reads,
    //    permission requests are all real. `permission_request`
    //    causes the wrapper to abort the stream + return
    //    `status: 'waiting_for_permission'` with partial assistant
    //    text — the runner persists that partial text and pauses the
    //    scheduled_tasks row so the user can decide to re-run or
    //    abandon. No durable resume in v1.
    // Codex P1 — earlier rev only forwarded prompt/sessionId/system/
    // workingDirectory to runClaudeHeadless. Result: every scheduled
    // run was effectively a "new brain" — no SDK resume, no
    // conversationHistory, no sessionSummary, no per-session
    // runtime/provider pin. So the buddy heartbeat couldn't recall
    // what it last said, and a recurring task wouldn't follow up its
    // own prior turn even though the messages all sat in the same
    // task-bound session. Mirror chat/route.ts:434-666 here: load
    // session + history + summary, plumb sdk_session_id through, and
    // persist the new sdk_session_id back after a successful run.
    // Lightweight imports first — these are needed by the invalidReason
    // gate below and must NOT be paid for on the heavy headless path
    // when we can short-circuit fast. mcp-loader / headless-claude
    // pull in transitive trees (claude-client, SDK shims, etc.) and
    // would push a "session has a deleted provider" run from the
    // synchronous gate that should take <50ms up to several hundred
    // ms — long enough that timing-sensitive tests (run-event-link)
    // see the row still in 'running' when they sample it after a 400ms
    // wait. The gate must always be fast.
    const {
      getSession,
      getMessages,
      getSessionSummary,
      updateSdkSessionId,
    } = await import('./db');
    const { resolveProviderForSession } = await import('./provider-resolver');
    const { resolveRuntimeForSession } = await import('./chat-runtime');

    const session = getSession(sessionId);
    // session must exist by this point — ensureTaskBoundSession /
    // resolveBuddySessionId would have created or thrown above. We
    // still tolerate `undefined` defensively (DB row deletion races).

    // Codex P2 — Phase 2 immunity gate, mirrored from
    // chat/route.ts:102-128. Without it, the runner falls through
    // raw `resolveProvider`'s env fallback when the session's stored
    // provider has been deleted, silently re-routing the run through
    // a different provider. The whole point of `resolveProviderForSession`
    // is to surface `invalidReason` so callers refuse to send. We
    // refuse here too: write the run as failed with the reason and
    // bail. The user can fix the session's provider in the chat UI
    // and re-run from the WaitingForPermissionPanel / scheduler.
    const effectiveSessionRuntime = resolveRuntimeForSession({
      runtime_pin: session?.runtime_pin || '',
    });
    const resolved = resolveProviderForSession(
      {
        provider_id: session?.provider_id || '',
        model: session?.model || '',
      },
      {
        runtime: effectiveSessionRuntime,
        callScene: isHeartbeat ? 'assistant_heartbeat' : 'scheduled_task',
      },
    );
    if (resolved.invalidReason) {
      const reasonLabel =
        resolved.invalidReason === 'provider-missing'
          ? 'session provider no longer exists'
          : resolved.invalidReason === 'model-missing'
            ? 'session model not available'
            : 'session runtime no longer compatible';
      const error = `Cannot run task: ${reasonLabel} (${resolved.invalidReason}). Open the chat session and pick a valid provider/model before re-running.`;
      updateTaskRunLog(runId, {
        status: 'failed',
        error,
        duration_ms: Date.now() - startedAt,
      });
      return { runId, status: 'failed', error, sessionId };
    }
    const effectiveProviderId =
      resolved.provider?.id || session?.provider_id || '';

    // Heavy imports only on the healthy path — the invalidReason gate
    // above already returned for the deleted-provider case and we
    // never need these.
    const { runClaudeHeadless } = await import('./headless-claude');
    const { filterHistoryByCompactBoundary } = await import('./context-compressor');
    const { predictNativeRuntime } = await import('./runtime');
    const { loadAllMcpServers, loadCodePilotMcpServers } = await import('./mcp-loader');

    // Same MCP-loader rule chat/route.ts:488-490 uses: native runtime
    // wants the FULL server map (it manages MCP itself); SDK runtime
    // only wants servers with `${...}` env placeholders (the SDK loads
    // the rest via settingSources). Without this, headless runs only
    // saw the keyword-injected CodePilot built-ins, never the
    // user-configured MCP servers — so the same prompt could behave
    // differently in foreground vs scheduled.
    const mcpServers = predictNativeRuntime(effectiveProviderId)
      ? loadAllMcpServers()
      : loadCodePilotMcpServers();

    const sessionSummaryData = getSessionSummary(sessionId);
    const { messages: recentMsgs } = getMessages(sessionId, {
      limit: 200,
      excludeHeartbeatAck: true,
    });
    // ai_task user-source persisted the user prompt at step 3a; it
    // sits at the tail of recentMsgs and would double-count if fed
    // both as conversationHistory AND as the prompt arg. Heartbeat
    // never persists its prompt, so the tail is the last buddy turn
    // and we keep all rows.
    const historyBeforeBoundary = isHeartbeat
      ? recentMsgs
      : recentMsgs.slice(0, -1);
    const historyAfterBoundary = filterHistoryByCompactBoundary({
      history: historyBeforeBoundary,
      summary: sessionSummaryData.summary,
      summaryBoundaryRowid: sessionSummaryData.boundaryRowid,
    });
    const conversationHistory = historyAfterBoundary.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      _rowid: m._rowid,
    }));

    // Codex P1 — heartbeat systemPrompt is now strict. Earlier rev
    // gave the model a one-line instruction with no tool restrictions,
    // so the model would routinely fan out into list_tasks /
    // memory_recent / shell-`date` / Search across multiple steps.
    // On a runtime that doesn't honour a final `done` after step
    // completion the headless run would hang forever in tool-call
    // loops. The new prompt enumerates legal tool calls (one,
    // memory_recent only) and explicitly forbids the introspection
    // and side-effect tools. The runner ALSO disallows them at the
    // SDK level via `disallowedTools` below for belt + suspenders.
    const HEARTBEAT_DISALLOWED_TOOLS = [
      'codepilot_list_tasks',
      'codepilot_schedule_task',
      'codepilot_cancel_task',
      'codepilot_hatch_buddy',
      'codepilot_notify',
      'Bash',
      'WebSearch',
      'WebFetch',
      'Task',
    ] as const;
    const systemPrompt = isHeartbeat
      ? `You are the user's assistant buddy running a background heartbeat check. STRICT RULES:\n` +
        `1. HEARTBEAT.md is already in the prompt below — read it.\n` +
        `2. AT MOST ONE tool call. Allowed: codepilot_memory_recent (only if you genuinely need recent memory to interpret HEARTBEAT.md). Forbidden: ${HEARTBEAT_DISALLOWED_TOOLS.join(', ')}, any shell, any web.\n` +
        `3. If HEARTBEAT.md is empty or nothing needs the user's attention right now: respond with EXACTLY the literal string \`HEARTBEAT_OK\` and nothing else.\n` +
        `4. Otherwise: write a SHORT (≤2 sentence) message about what needs attention. Do not invent items not grounded in HEARTBEAT.md.\n` +
        `Heartbeat must NOT introspect the scheduling system itself or invoke tools that have side effects on the user (notifications, scheduling, naming).`
      : `You are executing a scheduled task. Be concise and direct.\nTask name: ${task.name}\nCurrent time: ${new Date().toLocaleString()}`;

    const headless = await runClaudeHeadless({
      prompt,
      callScene: isHeartbeat ? 'assistant_heartbeat' : 'scheduled_task',
      sessionId,
      // SDK session resume — when present, streamClaude continues the
      // existing SDK conversation instead of starting from scratch.
      // Empty → fresh SDK session (which conversationHistory +
      // sessionSummary below repopulate as fallback context).
      sdkSessionId: session?.sdk_session_id || undefined,
      // Codex P2 — feed the resolved provider + model directly so the
      // headless run uses the SAME destination chat/route.ts would
      // pick for an interactive turn. Falling back to streamClaude's
      // own raw resolver here would re-introduce the silent env
      // re-route Phase 2 closed.
      provider: resolved.provider,
      providerId: effectiveProviderId || undefined,
      sessionProviderId: session?.provider_id || undefined,
      // Prefer upstream over alias (route.ts line 647 does the same)
      // so the SDK addresses the model the provider actually serves
      // — third-party Anthropic-compat proxies sometimes only accept
      // the upstream id.
      model:
        resolved.upstreamModel ||
        resolved.model ||
        session?.model ||
        undefined,
      // Per-session runtime pin from chat_sessions — the headline
      // immunity behaviour Phase 2 promised. ScheduledTask itself
      // doesn't carry runtime_pin; pinning lives on the task-bound
      // (or buddy) session row.
      sessionRuntimePin: session?.runtime_pin || undefined,
      systemPrompt,
      workingDirectory:
        session?.sdk_cwd ||
        session?.working_directory ||
        task.working_directory ||
        undefined,
      conversationHistory,
      sessionSummary: sessionSummaryData.summary || undefined,
      sessionSummaryBoundaryRowid: sessionSummaryData.boundaryRowid,
      // Codex P1 — heartbeat MUST NOT carry external user MCP
      // servers. claude-client also gates MCP registration on
      // agentMode='heartbeat' as a hard backstop, but cutting it
      // here too means the heartbeat path never even computes the
      // MCP map. Normal ai_task keeps full MCP access.
      mcpServers: isHeartbeat ? undefined : mcpServers,
      // Codex P1 — agentMode tells claude-client to apply heartbeat
      // restrictions: skip codepilot-notify/widget/media/cli-tools/
      // dashboard MCP registrations, drop project mcps, restrict
      // allowedTools to memory only, and add disallowedTools that
      // block dangerous SDK builtins (Bash/Edit/Write/etc.).
      agentMode: isHeartbeat ? 'heartbeat' : undefined,
      // Default permission mode — agent will request permissions for
      // destructive tools, which the headless wrapper translates into
      // `waiting_for_permission`. Read-only tools (Read / Glob / Grep)
      // proceed without prompting.
      permissionMode: 'default',
      // Codex P1 — explicit per-tool timeout. claude-client's default
      // (toolTimeoutSeconds=0) means "no timeout"; in a background
      // task on a runtime that never returns from a tool, the tool
      // blocks the SDK indefinitely. Heartbeat: 5 min cap (its
      // disallowedTools list already keeps it to read-mostly memory
      // lookups). Normal ai_task: 10 min cap. Both are fuses, not
      // expected upper bounds.
      toolTimeoutSeconds: isHeartbeat ? 300 : 600,
      // Skip the autoTrigger code path's "no transcript update"
      // semantics: the runner DOES want this turn persisted so users
      // can see what the agent did from /settings/tasks.
      autoTrigger: false,
    },
    // Codex P1 — consumer-side total / idle fuses. Heartbeat is
    // intentionally tight because the prompt + disallowedTools keeps
    // the workload to <30s; if a heartbeat trips this, the prompt or
    // runtime is wrong, not the fuse.
    {
      maxTotalMs: isHeartbeat ? 90_000 : 5 * 60_000,
      maxIdleMs: isHeartbeat ? 30_000 : 90_000,
    });

    // Persist the new SDK session id so the next run can resume.
    // Mirrors chat route.ts collectStreamResponse status/result
    // capture. Best-effort: a write failure here just means the
    // next run re-starts the SDK session; not a blocker for THIS
    // run's outcome reporting.
    if (
      headless.sdkSessionId &&
      headless.sdkSessionId !== session?.sdk_session_id
    ) {
      try {
        updateSdkSessionId(sessionId, headless.sdkSessionId);
      } catch { /* best-effort */ }
    }

    // 5. Branch on headless result + source.
    const trimmed = headless.assistantText.trim();

    if (headless.status === 'waiting_for_permission') {
      // Persist partial assistant text (with task_run_id) so the user
      // can see what the agent was about to do when it hit the
      // permission gate. Empty assistantText is fine — message just
      // has the marker linkage and a placeholder body.
      const partialBody = trimmed.length > 0
        ? trimmed
        : `(等待权限：${headless.pendingPermission?.toolName || '工具调用'}）`;
      try {
        addMessage(sessionId, 'assistant', partialBody, undefined, { task_run_id: runId });
      } catch { /* best-effort */ }
      updateTaskRunLog(runId, {
        status: 'waiting_for_permission',
        result: partialBody.slice(0, 2000),
        duration_ms: Date.now() - startedAt,
      });
      return {
        runId,
        status: 'waiting_for_permission',
        sessionId,
        result: partialBody,
      };
    }

    if (headless.status === 'failed') {
      const errorMsg = headless.error || 'Headless stream failed';
      // Codex follow-up — when the model produced output (typical for
      // the pseudo-tool-call-XML failure case where streamClaude said
      // 'done' cleanly but no tools fired), persist that output to
      // the chat session WITH a clear failure annotation so the user
      // can see what actually happened. Empty assistantText (e.g. a
      // raw stream error before any tokens) just gets the run row;
      // no point writing an empty assistant message.
      if (trimmed.length > 0) {
        const annotated = `${trimmed}\n\n---\n⚠️ ${errorMsg}`;
        try {
          addMessage(sessionId, 'assistant', annotated, undefined, { task_run_id: runId });
        } catch { /* best-effort */ }
      }
      updateTaskRunLog(runId, {
        status: 'failed',
        error: errorMsg,
        duration_ms: Date.now() - startedAt,
      });
      return { runId, status: 'failed', error: errorMsg, sessionId };
    }

    // status === 'succeeded' from here on.

    if (isHeartbeat && isHeartbeatSilent(trimmed)) {
      updateTaskRunLog(runId, {
        status: 'succeeded',
        result: 'silent',
        duration_ms: Date.now() - startedAt,
      });
      return { runId, status: 'succeeded', silent: true, sessionId, result: trimmed };
    }

    // Speak-up (heartbeat) or normal ai_task → write assistant message.
    try {
      addMessage(sessionId, 'assistant', trimmed, undefined, { task_run_id: runId });
    } catch { /* best-effort */ }

    updateTaskRunLog(runId, {
      status: 'succeeded',
      result: trimmed.slice(0, 2000),
      duration_ms: Date.now() - startedAt,
    });
    return {
      runId,
      status: 'succeeded',
      silent: false,
      sessionId,
      result: trimmed,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    updateTaskRunLog(runId, {
      status: 'failed',
      error: errorMsg,
      duration_ms: Date.now() - startedAt,
    });
    return { runId, status: 'failed', error: errorMsg };
  }
}
