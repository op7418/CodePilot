/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import type { BridgeStatus, InboundMessage, OutboundMessage, StreamingPreviewState } from './types';
import { createAdapter, getRegisteredTypes } from './channel-adapter';
import type { BaseChannelAdapter } from './channel-adapter';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters';
import * as router from './channel-router';
import * as engine from './conversation-engine';
import * as broker from './permission-broker';
import { deliver, deliverRendered, chunkText } from './delivery-layer';
import { PLATFORM_LIMITS as limits } from './types';
import { markdownToTelegramChunks } from './markdown/telegram';
import { markdownToDiscordChunks } from './markdown/discord';
import { getSetting, insertAuditLog, updateChannelBinding } from '../db';
import { setBridgeModeActive } from '../telegram-bot';
import { escapeHtml } from './adapters/telegram-utils';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators';
import { ChannelPluginAdapter } from '../channels/channel-plugin-adapter';
import type { FeishuChannelPlugin } from '../channels/feishu';

/**
 * Extract the real platform chat_id from a potentially synthetic thread-session address.
 * Thread-session mode encodes addresses as `{real_chat_id}:thread:{root_id}`.
 */
function extractRealChatId(chatId: string): string {
  const threadIdx = chatId.indexOf(':thread:');
  return threadIdx >= 0 ? chatId.slice(0, threadIdx) : chatId;
}

const GLOBAL_KEY = '__bridge_manager__';

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

// ── Channel-aware rendering dispatch ──────────────────────────

import type { ChannelAddress, SendResult } from './types';

/**
 * Render response text and deliver via the appropriate channel format.
 * Telegram: Markdown → HTML chunks via deliverRendered.
 * Other channels: plain text via deliver (no HTML).
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
): Promise<SendResult> {
  if (adapter.channelType === 'telegram') {
    const chunks = markdownToTelegramChunks(responseText, 4096);
    if (chunks.length > 0) {
      return deliverRendered(adapter, address, chunks, { sessionId, replyToMessageId });
    }
    return { ok: true };
  }
  if (adapter.channelType === 'discord') {
    // Discord: native markdown, chunk at 2000 chars with fence repair
    const chunks = markdownToDiscordChunks(responseText, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: chunks[i].text,
        parseMode: 'Markdown',
        replyToMessageId,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (adapter.channelType === 'feishu') {
    // Feishu: pass markdown through for adapter to format as post/card
    return deliver(adapter, {
      address,
      text: responseText,
      parseMode: 'Markdown',
      replyToMessageId,
    }, { sessionId });
  }
  if (adapter.channelType === 'qq') {
    // QQ passive replies have a limited budget per msg_id (typically 5).
    // Limit chunks to avoid exhausting the budget and failing mid-response.
    const QQ_MAX_CHUNKS = 3;
    const limit = limits.qq || 2000;
    const fullText = responseText;
    const chunks = chunkText(fullText, limit);

    const effectiveChunks = chunks.length > QQ_MAX_CHUNKS
      ? [...chunks.slice(0, QQ_MAX_CHUNKS - 1), chunks.slice(QQ_MAX_CHUNKS - 1).join('\n').slice(0, limit - 30) + '\n\n[... response truncated]']
      : chunks;

    for (let i = 0; i < effectiveChunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: effectiveChunks[i],
        parseMode: 'plain',
        replyToMessageId,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (adapter.channelType === 'weixin') {
    // WeChat plain text only, 4096 chars per chunk, max 5 chunks.
    const WEIXIN_MAX_CHUNKS = 5;
    const limit = limits.weixin || 4096;
    const chunks = chunkText(responseText, limit);

    const effectiveChunks = chunks.length > WEIXIN_MAX_CHUNKS
      ? [...chunks.slice(0, WEIXIN_MAX_CHUNKS - 1), chunks.slice(WEIXIN_MAX_CHUNKS - 1).join('\n').slice(0, limit - 30) + '\n\n[... response truncated]']
      : chunks;

    for (let i = 0; i < effectiveChunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: effectiveChunks[i],
        parseMode: 'plain',
        replyToMessageId,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  // Generic fallback: deliver as plain text
  return deliver(adapter, {
    address,
    text: responseText,
    parseMode: 'plain',
    replyToMessageId,
  }, { sessionId });
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  autoStartChecked: boolean;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      sessionLocks: new Map(),
      autoStartChecked: false,
    };
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  return g[GLOBAL_KEY];
}

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  state.sessionLocks.set(sessionId, current);
  // Cleanup when the chain completes
  current.finally(() => {
    if (state.sessionLocks.get(sessionId) === current) {
      state.sessionLocks.delete(sessionId);
    }
  });
  return current;
}

export interface StartResult {
  started: boolean;
  reason?: string;
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 * Returns a result indicating success/failure with a reason.
 */
export async function start(): Promise<StartResult> {
  const state = getState();
  if (state.running) return { started: true };

  const bridgeEnabled = getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return { started: false, reason: 'bridge_not_enabled' };
  }

  // Iterate all registered adapter types and create those that are enabled
  const configErrors: string[] = [];
  let enabledCount = 0;
  for (const channelType of getRegisteredTypes()) {
    const settingKey = `bridge_${channelType}_enabled`;
    if (getSetting(settingKey) !== 'true') continue;
    enabledCount++;

    const adapter = createAdapter(channelType);
    if (!adapter) continue;

    const configError = adapter.validateConfig();
    if (!configError) {
      registerAdapter(adapter);
    } else {
      console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
      configErrors.push(`${channelType}: ${configError}`);
    }
  }

  if (enabledCount === 0) {
    return { started: false, reason: 'no_channels_enabled' };
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    const reason = configErrors.length > 0
      ? `adapter_config_invalid: ${configErrors.join('; ')}`
      : 'no_adapters_started';
    return { started: false, reason };
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Suppress notification bot polling to avoid conflicts
  setBridgeModeActive(true);

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
    }
  }

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
  return { started: true };
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  state.running = false;

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  // Stop all adapters
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${type}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
    }
  }

  state.adapters.clear();
  state.adapterMeta.clear();
  state.sessionLocks.clear();
  state.activeTasks.clear();
  state.startedAt = null;

  // Re-enable notification bot polling
  setBridgeModeActive(false);

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Restart the bridge (stop + start). Useful when adapter config changes
 * at runtime, e.g. a new WeChat account is linked while the bridge is running.
 */
export async function restart(): Promise<StartResult> {
  const state = getState();
  if (state.running) {
    await stop();
  }
  return start();
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const autoStart = getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
}

/**
 * Get a running adapter by channel type.
 * Returns null if the adapter is not registered.
 */
export function getAdapter(channelType: string): BaseChannelAdapter | null {
  const state = getState();
  return state.adapters.get(channelType) ?? null;
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries and commands are lightweight — process inline.
        // Regular messages use per-session locking for concurrency.
        if (msg.callbackData || msg.text.trim().startsWith('/')) {
          await handleMessage(adapter, msg);
        } else {
          const binding = router.resolve(msg.address);
          // Fire-and-forget into session lock — loop continues to accept
          // messages for other sessions immediately.
          processWithSessionLock(binding.codepilotSessionId, () =>
            handleMessage(adapter, msg),
          ).catch(err => {
            console.error(`[bridge-manager] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
    }
  });
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries
  if (msg.callbackData) {
    // CWD switch button callback
    if (msg.callbackData.startsWith('cwd:')) {
      const targetDir = msg.callbackData.slice(4);
      const validated = validateWorkingDirectory(targetDir);
      if (validated) {
        const binding = router.resolve(msg.address);
        router.updateBinding(binding.id, { workingDirectory: validated, sdkSessionId: '' });
        await deliver(adapter, {
          address: msg.address,
          text: `Working directory switched to <code>${escapeHtml(validated)}</code>\n(Next message starts fresh context)`,
          parseMode: 'HTML',
          replyToMessageId: msg.messageId,
        });
      }
      ack();
      return;
    }

    // Permission buttons
    const handled = broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId);
    if (handled) {
      const confirmMsg: OutboundMessage = {
        address: msg.address,
        text: 'Permission response recorded.',
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      };
      await deliver(adapter, confirmMsg);
    }
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;
  if (!rawText && !hasAttachments) { ack(); return; }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (rawText.startsWith('/')) {
    await handleCommand(adapter, msg, rawText, msg.messageId);
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  // Regular message — route to conversation engine
  const binding = router.resolve(msg.address);

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(msg.address.chatId);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  const state = getState();
  state.activeTasks.set(binding.codepilotSessionId, taskAbort);

  // ── Streaming preview setup ──────────────────────────────────
  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  // ── Card streaming setup (Feishu) ──────────────────────────────
  let cardController: import('../channels/types').CardStreamController | null = null;
  let cardMessageId: string | null = null;
  let cardCreating = false;
  let cardBufferedText = '';
  let cardFinalized = false;
  /** Promise that resolves when card creation completes — await before finalize. */
  let cardCreatePromise: Promise<void> | null = null;
  /** Track tool calls for card progress display */
  const cardToolCalls: import('../channels/types').ToolCallInfo[] = [];

  if (!previewState && adapter.getCardStreamController) {
    cardController = adapter.getCardStreamController();
    console.log('[bridge-manager] Card stream controller:', cardController ? 'available' : 'null');
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;

  // Build the onPartialText callback — preview streaming OR card streaming
  let onPartialText: ((fullText: string) => void) | undefined;

  if (previewState && streamCfg) {
    // Preview-based streaming (Telegram, etc.)
    const ps = previewState;
    const cfg = streamCfg;
    onPartialText = (fullText: string) => {
      if (ps.degraded) return;

      ps.pendingText = fullText.length > cfg.maxChars
        ? fullText.slice(0, cfg.maxChars) + '...'
        : fullText;

      const delta = ps.pendingText.length - ps.lastSentText.length;
      const elapsed = Date.now() - ps.lastSentAt;

      if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
        if (!ps.throttleTimer) {
          ps.throttleTimer = setTimeout(() => {
            ps.throttleTimer = null;
            if (!ps.degraded) flushPreview(adapter, ps, cfg);
          }, cfg.intervalMs);
        }
        return;
      }

      if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
        if (!ps.throttleTimer) {
          ps.throttleTimer = setTimeout(() => {
            ps.throttleTimer = null;
            if (!ps.degraded) flushPreview(adapter, ps, cfg);
          }, cfg.intervalMs - elapsed);
        }
        return;
      }

      if (ps.throttleTimer) {
        clearTimeout(ps.throttleTimer);
        ps.throttleTimer = null;
      }
      flushPreview(adapter, ps, cfg);
    };
  } else if (cardController) {
    // Card-based streaming (Feishu)
    onPartialText = (fullText: string) => {
      if (cardCreating) {
        cardBufferedText = fullText;
        return;
      }

      if (!cardMessageId) {
        // First call — create the card
        cardCreating = true;
        cardBufferedText = fullText;
        cardCreatePromise = cardController!.create(msg.address.chatId, fullText, msg.messageId).then((msgId) => {
          cardCreating = false;
          cardMessageId = msgId || null;
          // Flush any buffered text that arrived during creation
          if (cardMessageId && cardBufferedText && cardBufferedText !== fullText) {
            cardController!.update(cardMessageId, cardBufferedText).catch(() => {});
          }
        }).catch(() => {
          cardCreating = false;
        });
        return;
      }

      cardController!.update(cardMessageId, fullText).catch(() => {});
    };
  }

  // Build onToolEvent callback for card tool progress
  interface ToolEvent {
    type: string;
    id?: string;
    name?: string;
    tool_use_id?: string;
    is_error?: boolean;
  }
  let onToolEvent: ((event: ToolEvent) => void) | undefined;
  if (cardController) {
    onToolEvent = (event: ToolEvent) => {
      if (event.type === 'tool_use') {
        cardToolCalls.push({ id: event.id!, name: event.name!, status: 'running' });
      } else if (event.type === 'tool_result') {
        const tc = cardToolCalls.find((t) => t.id === event.tool_use_id);
        if (tc) tc.status = event.is_error ? 'error' : 'complete';
      }

      // Bootstrap card if tool event arrives before any text (tool-first turns).
      // Without this, tool progress has nowhere to render.
      if (!cardMessageId && !cardCreating) {
        cardCreating = true;
        cardCreatePromise = cardController!.create(msg.address.chatId, '', msg.messageId).then((msgId) => {
          cardCreating = false;
          cardMessageId = msgId || null;
          if (cardMessageId && cardController?.updateToolCalls) {
            cardController.updateToolCalls(cardMessageId, cardToolCalls);
          }
          // Flush any text that arrived while creating
          if (cardMessageId && cardBufferedText) {
            cardController!.update(cardMessageId, cardBufferedText).catch(() => {});
          }
        }).catch(() => { cardCreating = false; });
        return;
      }

      // Update card display if we have a message ID
      if (cardMessageId && cardController?.updateToolCalls) {
        cardController.updateToolCalls(cardMessageId, cardToolCalls);
      }
    };
  }

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use text or empty string for image-only messages (prompt is still required by streamClaude)
    const promptText = text || (hasAttachments ? 'Describe this image.' : '');

    const result = await engine.processMessage(binding, promptText, async (perm) => {
      await broker.forwardPermissionRequest(
        adapter,
        msg.address,
        perm.permissionRequestId,
        perm.toolName,
        perm.toolInput,
        binding.codepilotSessionId,
        perm.suggestions,
        msg.messageId,
      );
    }, taskAbort.signal, hasAttachments ? msg.attachments : undefined, onPartialText, onToolEvent);

    // Await any in-flight card creation before checking cardMessageId,
    // preventing race where processMessage() returns before create() resolves.
    if (cardCreatePromise) {
      await cardCreatePromise;
    }

    // Send response text — render via channel-appropriate format
    if (result.responseText) {
      if (cardController && cardMessageId) {
        // Finalize streaming card with final content
        const finalStatus = result.hasError ? 'error' : 'completed';
        await cardController.finalize(cardMessageId, result.responseText, finalStatus);
        cardFinalized = true;
      } else {
        await deliverResponse(adapter, msg.address, result.responseText, binding.codepilotSessionId, msg.messageId);
      }
    } else if (result.hasError) {
      if (cardController && cardMessageId) {
        await cardController.finalize(cardMessageId, `❌ Error: ${result.errorMessage}`, 'error');
        cardFinalized = true;
      } else {
        const errorResponse: OutboundMessage = {
          address: msg.address,
          text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
          parseMode: 'HTML',
          replyToMessageId: msg.messageId,
        };
        await deliver(adapter, errorResponse);
      }
    }

    // Persist the actual SDK session ID for future resume.
    // On error, ALWAYS clear — the SDK may emit a session_id before crashing,
    // and saving that broken ID would cause all subsequent messages to fail
    // by repeatedly trying to resume a corrupted session.
    if (binding.id) {
      try {
        if (result.hasError) {
          updateChannelBinding(binding.id, { sdkSessionId: '' });
        } else if (result.sdkSessionId) {
          updateChannelBinding(binding.id, { sdkSessionId: result.sdkSessionId });
        }
      } catch { /* best effort */ }
    }
  } finally {
    // Clean up preview state
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }

    // Clean up card streaming state — await creation if still in flight
    if (cardController && !cardFinalized) {
      const pending = cardCreatePromise as Promise<void> | null;
      if (pending) await pending.catch(() => {});
      if (cardMessageId) {
        cardController.finalize(cardMessageId, '⚠️ Response interrupted.', 'interrupted').catch(() => {});
      }
    }

    state.activeTasks.delete(binding.codepilotSessionId);
    // Notify adapter that message processing ended
    adapter.onMessageEnd?.(msg.address.chatId);
    // Commit the offset only after full processing (success or failure)
    ack();
  }
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
  replyToMessageId?: string,
): Promise<void> {
  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: `Command rejected: invalid input detected.`,
      parseMode: 'plain',
      replyToMessageId,
    });
    return;
  }

  let response = '';

  switch (command) {
    case '/start':
      response = [
        '<b>CodePilot Bridge</b>',
        '',
        'Send any message to interact with Claude.',
        'Type /help for available commands.',
      ].join('\n');
      break;

    case '/new': {
      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      } else {
        // No path specified — inherit CWD from current binding
        const current = router.resolve(msg.address);
        if (current.workingDirectory) {
          workDir = current.workingDirectory;
        }
      }
      const binding = router.createBinding(msg.address, workDir);
      response = `New session created.\nSession: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>\nCWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`;
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind &lt;session_id&gt;';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format. Expected a 32-64 character hex/UUID string.';
        break;
      }
      const binding = router.bindToSession(msg.address, args);
      if (binding) {
        response = `Bound to session <code>${args.slice(0, 8)}...</code>`;
      } else {
        response = 'Session not found.';
      }
      break;
    }

    case '/cwd': {
      if (args) {
        // Direct path specified
        const validatedPath = validateWorkingDirectory(args);
        if (!validatedPath) {
          response = 'Invalid path. Must be an absolute path without traversal sequences or special characters.';
          break;
        }
        const binding = router.resolve(msg.address);
        router.updateBinding(binding.id, { workingDirectory: validatedPath, sdkSessionId: '' });
        response = `Working directory set to <code>${escapeHtml(validatedPath)}</code>\n(SDK session reset — next message starts fresh context)`;
        break;
      }

      // No args — show project selector card with buttons.
      // Design decision: /cwd picker is a "recent projects quick-switch" for
      // a single-operator desktop app. It intentionally shows all active
      // directories across this channel type (not isolated per chat).
      // If multi-user / chat-level isolation is needed in the future,
      // this should be scoped by userId or chatId instead.
      const bindings = router.listBindings(msg.address.channelType);
      const uniqueDirs = [...new Set(
        bindings
          .filter((b) => b.active)
          .map((b) => b.workingDirectory)
          .filter((d): d is string => !!d && d !== '~')
      )].slice(0, 8); // Max 8 options

      if (uniqueDirs.length === 0) {
        response = 'No project directories found.\nUsage: /cwd /path/to/directory';
        break;
      }

      // Send as interactive card with buttons (Feishu) or text list (other channels)
      const currentBinding = router.resolve(msg.address);
      const currentCwd = currentBinding.workingDirectory || '~';

      // Build inline buttons for project selection
      const inlineButtons = uniqueDirs.map((dir) => {
        const label = dir === currentCwd ? `📍 ${dir.split('/').pop() || dir}` : (dir.split('/').pop() || dir);
        return [{
          text: label,
          callbackData: `cwd:${dir}`,
        }];
      });

      const cardMsg: OutboundMessage = {
        address: msg.address,
        text: `<b>Switch Working Directory</b>\n\nCurrent: <code>${escapeHtml(currentCwd)}</code>\n\nSelect a project:`,
        parseMode: 'HTML',
        replyToMessageId,
        inlineButtons,
      };
      await deliver(adapter, cardMsg);
      return; // Don't send response — card is already sent
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { mode: args });
      response = `Mode set to <b>${args}</b>`;
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      response = [
        '<b>Bridge Status</b>',
        '',
        `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        `Model: <code>${binding.model || 'default'}</code>`,
      ].join('\n');
      break;
    }

    case '/sessions': {
      const bindings = router.listBindings(adapter.channelType);
      if (bindings.length === 0) {
        response = 'No sessions found.';
      } else {
        const lines = ['<b>Sessions:</b>', ''];
        for (const b of bindings.slice(0, 10)) {
          const active = b.active ? 'active' : 'inactive';
          lines.push(`<code>${b.codepilotSessionId.slice(0, 8)}...</code> [${active}] ${escapeHtml(b.workingDirectory || '~')}`);
        }
        response = lines.join('\n');
      }
      break;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const st = getState();
      const taskAbort = st.activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        st.activeTasks.delete(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/perm': {
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage: /perm allow <id> | /perm allow_session <id> | /perm deny <id>
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny &lt;permission_id&gt;';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
      if (handled) {
        response = `Permission ${permAction}: recorded.`;
      } else {
        response = `Permission not found or already resolved.`;
      }
      break;
    }

    case '/history': {
      // Fetch recent messages from the current chat (or thread)
      if (!(adapter instanceof ChannelPluginAdapter)) {
        response = 'History is not supported for this channel type.';
        break;
      }
      const plugin = adapter.getPlugin();
      if (!plugin.getCardStreamController && !plugin.meta?.channelType) {
        response = 'History is not available.';
        break;
      }
      // Use message-actions if the plugin has Feishu-type capabilities
      try {
        const { readMessages, readThreadMessages } = await import('../channels/feishu/message-actions');
        const restClient = (plugin as FeishuChannelPlugin)._gateway?.getRestClient?.();
        if (!restClient) {
          response = 'Channel not connected.';
          break;
        }
        const pageSize = parseInt(args, 10) || 10;
        const chatIdRaw = msg.address.chatId;
        const threadIdx = chatIdRaw.indexOf(':thread:');

        let result;
        if (threadIdx >= 0) {
          // Thread history: extract thread ID and use readThreadMessages
          const threadId = chatIdRaw.slice(threadIdx + ':thread:'.length);
          result = await readThreadMessages(restClient, threadId, { pageSize });
        } else {
          const realChatId = extractRealChatId(chatIdRaw);
          result = await readMessages(restClient, realChatId, { pageSize });
        }

        if (result.items.length === 0) {
          response = 'No messages found.';
        } else {
          const lines = [`<b>Recent ${result.items.length} messages:</b>`, ''];
          for (const item of result.items) {
            const time = item.createTime ? new Date(parseInt(item.createTime, 10) * 1000).toLocaleString() : '?';
            let content = '';
            try {
              const parsed = JSON.parse(item.content);
              content = (parsed.text ?? '').slice(0, 80);
            } catch {
              content = item.content.slice(0, 80);
            }
            lines.push(`[${time}] ${escapeHtml(content)}`);
          }
          if (result.hasMore) lines.push('\n<i>(more messages available)</i>');
          response = lines.join('\n');
        }
      } catch (err) {
        response = `Failed to fetch history: ${err instanceof Error ? escapeHtml(err.message) : 'unknown error'}`;
      }
      break;
    }

    case '/search': {
      // Simplified local search — lists recent messages and filters client-side.
      // This is NOT equivalent to OpenClaw's server-side search (search.message.create API
      // with user_access_token). Results are limited to recent messages in the current chat.
      if (!args) {
        response = 'Usage: /search &lt;keyword&gt;';
        break;
      }
      if (!(adapter instanceof ChannelPluginAdapter)) {
        response = 'Search is not supported for this channel type.';
        break;
      }
      try {
        const { searchMessages } = await import('../channels/feishu/message-actions');
        const plugin = adapter.getPlugin();
        const restClient = (plugin as FeishuChannelPlugin)._gateway?.getRestClient?.();
        if (!restClient) {
          response = 'Channel not connected.';
          break;
        }
        const realChatId = extractRealChatId(msg.address.chatId);
        const result = await searchMessages(restClient, realChatId, args, { pageSize: 10 });
        if (result.items.length === 0) {
          response = `No messages matching "<b>${escapeHtml(args)}</b>".`;
        } else {
          const lines = [`<b>${result.items.length} result(s) for "${escapeHtml(args)}":</b>`, ''];
          for (const item of result.items) {
            const time = item.createTime ? new Date(parseInt(item.createTime, 10) * 1000).toLocaleString() : '?';
            let content = '';
            try {
              const parsed = JSON.parse(item.content);
              content = (parsed.text ?? '').slice(0, 100);
            } catch {
              content = item.content.slice(0, 100);
            }
            lines.push(`[${time}] ${escapeHtml(content)}`);
          }
          response = lines.join('\n');
        }
      } catch (err) {
        response = `Search failed: ${err instanceof Error ? escapeHtml(err.message) : 'unknown error'}`;
      }
      break;
    }

    case '/feishu': {
      const subArgs = args.split(/\s+/);
      const subcommand = subArgs[0]?.toLowerCase() || 'help';

      switch (subcommand) {
        case 'start': {
          // Validate Feishu config
          if (!(adapter instanceof ChannelPluginAdapter)) {
            response = 'This command is only available in Feishu channels.';
            break;
          }
          const plugin = adapter.getPlugin();
          const config = (plugin as FeishuChannelPlugin).getConfig?.();
          if (!config) {
            response = '❌ Feishu plugin not configured.\n\nPlease set App ID and App Secret in CodePilot settings, or use /feishu auth.';
            break;
          }
          const validationError = plugin.validateConfig();
          if (validationError) {
            response = `❌ Configuration error: ${validationError}`;
            break;
          }
          const capabilities = plugin.getCapabilities();
          const lines = [
            '✅ Feishu Bridge is running',
            '',
            `Streaming: ${capabilities.streaming ? '✅ Enabled' : '❌ Disabled'}`,
            `Thread Reply: ${capabilities.threadReply ? '✅' : '❌'}`,
            `Search: ${capabilities.search ? '✅' : '❌'}`,
            `History: ${capabilities.history ? '✅' : '❌'}`,
          ];
          response = lines.join('\n');
          break;
        }

        case 'auth': {
          // Show auth status and guidance
          if (!(adapter instanceof ChannelPluginAdapter)) {
            response = 'This command is only available in Feishu channels.';
            break;
          }
          const plugin = adapter.getPlugin();
          const config = (plugin as FeishuChannelPlugin).getConfig?.();
          if (!config) {
            response = '❌ App credentials not configured.\n\nPlease configure App ID and App Secret in CodePilot Settings → Bridge → Feishu.';
            break;
          }
          // Note: CodePilot currently uses app-level bot tokens (no user OAuth)
          // This is a simplified version compared to OpenClaw's full OAuth Device Flow
          response = [
            '🔐 Feishu Auth Status',
            '',
            `App ID: ${config.appId}`,
            `DM Policy: ${config.dmPolicy}`,
            `Allow From: ${(config.allowFrom || []).join(', ') || '(all)'}`,
            '',
            'ℹ️ CodePilot uses app-level bot tokens.',
            'User-level OAuth (user_access_token) is not yet supported.',
            'Some features requiring user identity (cross-chat search, sending as user) are unavailable.',
          ].join('\n');
          break;
        }

        case 'doctor': {
          // Run diagnostics
          if (!(adapter instanceof ChannelPluginAdapter)) {
            response = 'This command is only available in Feishu channels.';
            break;
          }
          const plugin = adapter.getPlugin();
          const config = (plugin as FeishuChannelPlugin).getConfig?.();
          const lines = ['🔍 Feishu Doctor', ''];

          // Config check
          if (!config) {
            lines.push('❌ Configuration: Not configured');
          } else {
            lines.push('✅ Configuration: OK');
            lines.push(`   App ID: ${config.appId}`);
            lines.push(`   DM Policy: ${config.dmPolicy}`);
            lines.push(`   Thread Session: ${config.threadSession ? 'Yes' : 'No'}`);
            lines.push(`   Streaming: Enabled`);
          }

          // Connection check
          if (plugin.isRunning()) {
            lines.push('✅ Connection: WebSocket connected');
          } else {
            lines.push('❌ Connection: Not running');
          }

          // Capabilities
          const caps = plugin.getCapabilities();
          lines.push('');
          lines.push('Capabilities:');
          lines.push(`   Streaming Cards: ${caps.streaming ? '✅' : '❌'}`);
          lines.push(`   Thread Reply: ${caps.threadReply ? '✅' : '❌'}`);
          lines.push(`   Message Search: ${caps.search ? '✅' : '❌ (requires user_access_token)'}`);
          lines.push(`   Message History: ${caps.history ? '✅' : '❌'}`);

          // Known limitations
          lines.push('');
          lines.push('Known Limitations (CodePilot vs OpenClaw):');
          lines.push('   • No user_access_token / OAuth Device Flow');
          lines.push('   • No cross-chat search (search.message.create requires UAT)');
          lines.push('   • No "send as user" capability');
          lines.push('   • Simplified card streaming (no reasoning phase display)');

          response = lines.join('\n');
          break;
        }

        default: {
          // /feishu help or unknown subcommand
          response = [
            'Feishu Bridge Commands',
            '',
            '/feishu start — Check plugin status and configuration',
            '/feishu auth — View auth status and guidance',
            '/feishu doctor — Run diagnostics',
            '/feishu help — Show this help',
          ].join('\n');
          break;
        }
      }
      break;
    }

    case '/help':
      response = [
        '<b>CodePilot Bridge Commands</b>',
        '',
        '<b>Session:</b>',
        '/new [path] - Create new session (optional: specify CWD)',
        '/cwd /path - Change CWD, reset context',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/mode plan|code|ask - Change mode',
        '/status - Show session / CWD / mode / model',
        '/sessions - List recent sessions',
        '/stop - Stop current task',
        '',
        '<b>Messages:</b>',
        '/history [count] - Show recent messages',
        '/search &lt;keyword&gt; - Search in current chat',
        '/perm allow|deny &lt;id&gt; - Permission response',
        '',
        '<b>Feishu:</b>',
        '/feishu doctor - Run diagnostics',
        '/feishu auth - View auth status',
      ].join('\n');
      break;

    default:
      response = `Unknown command: ${escapeHtml(command)}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: 'HTML',
      replyToMessageId,
    });
  }
}
