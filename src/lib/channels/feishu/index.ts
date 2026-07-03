/**
 * FeishuChannelPlugin — implements ChannelPlugin for Feishu/Lark.
 *
 * Composes: gateway (WS), inbound (parsing), outbound (sending),
 * identity (bot info), policy (access control), card-controller (streaming).
 */

import type { InboundMessage, OutboundMessage, SendResult } from '../../bridge/types';
import type { ChannelPlugin, ChannelCapabilities, ChannelMeta, CardStreamController } from '../types';
import type { FeishuConfig } from './types';

/** Shape of a Feishu card.action.trigger event */
interface CardActionEvent {
  action?: {
    value?: {
      callback_data?: string;
      chatId?: string;
      action?: string;
      operation_id?: string;
    };
  };
  context?: {
    open_chat_id?: string;
    open_message_id?: string;
  };
  operator?: { open_id?: string };
  open_id?: string;
  open_message_id?: string;
}
import { loadFeishuConfig, validateFeishuConfig } from './config';

/** Max number of message IDs to keep for dedup. */
const DEDUP_MAX = 1000;
import { FeishuGateway } from './gateway';
import { parseMessageWithResources } from './inbound';
import { getBotInfo } from './identity';
import { sendMessage, addReaction, removeReaction } from './outbound';
import { isUserAuthorized } from './policy';
import { createCardStreamController } from './card-controller';
import { downloadResource } from './resource-downloader';

export class FeishuChannelPlugin implements ChannelPlugin<FeishuConfig> {
  readonly meta: ChannelMeta = {
    channelType: 'feishu',
    displayName: 'Feishu / Lark',
  };

  private config: FeishuConfig | null = null;
  private gateway: FeishuGateway | null = null;
  private messageQueue: InboundMessage[] = [];
  private waitResolve: ((msg: InboundMessage | null) => void) | null = null;
  /** Track last received messageId per chatId for reaction acknowledgment. */
  private lastMessageIdByChat = new Map<string, string>();
  /** Track active reaction IDs per chatId so we can remove them on completion. */
  private activeReactions = new Map<string, { messageId: string; reactionId: string }>();
  /** Bot's open_id, resolved after gateway starts. Used for @mention detection (#384). */
  private botOpenId = '';
  /** Periodic retry timer for resolveBotIdentity when the initial probe fails. */
  private identityRetryTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Bumps on each start/stop so in-flight identity probes from a previous
   * start can detect they are stale and bail out before mutating state or
   * scheduling new timers.
   */
  private identityGeneration = 0;
  /** Dedup: set of recently seen message IDs to prevent duplicate processing. */
  private seenMessageIds = new Set<string>();

  loadConfig(): FeishuConfig | null {
    this.config = loadFeishuConfig();
    return this.config;
  }

  getConfig(): FeishuConfig | null {
    return this.config;
  }

  getCapabilities(): ChannelCapabilities {
    return {
      streaming: true,
      threadReply: true,
      search: false,  // True server-side search requires user_access_token; we only have local filtering
      history: true,
      reactions: false,
    };
  }

  validateConfig(): string | null {
    if (!this.config) {
      this.loadConfig();
    }
    return validateFeishuConfig(this.config);
  }

  async start(): Promise<void> {
    if (!this.config) {
      this.config = loadFeishuConfig();
    }
    if (!this.config) throw new Error('Feishu config not loaded');

    this.gateway = new FeishuGateway(this.config);

    // Register message handler — pushes to internal queue.
    // Reads this.botOpenId at call time so mention checks activate
    // once resolveBotIdentity() completes after gateway.start().
    //
    // For messages with attached resources (image/file/audio/video, #291), we
    // download in the background and enqueue after attachments are ready. Text
    // messages bypass the download step entirely.
    this.gateway.registerMessageHandler((data: unknown) => {
      const parsed = parseMessageWithResources(data, this.config!, this.botOpenId);
      if (!parsed) return;

      // Access control gate: enforce dmPolicy / groupPolicy / allowFrom /
      // groupAllowFrom before enqueuing. Without this check these settings
      // were dead config on Feishu — unlike Telegram/Discord/QQ adapters.
      //
      // Must use the RAW chat_id (before thread-session wrapping). When
      // threadSession is enabled, parseMessageWithResources encodes
      // "oc_xxx:thread:<root>" into address.chatId for routing, but groupAllowFrom
      // stores plain oc_xxx values, so matching against the wrapped address
      // would drop every legitimate thread message on allowlisted groups.
      const addrUserId = parsed.message.address.userId || '';
      const rawChatId = parsed.message.address.chatId.split(':thread:')[0];
      if (!isUserAuthorized(this.config!, addrUserId, rawChatId)) {
        console.log('[feishu/plugin]', 'Dropping unauthorized message from',
          addrUserId, 'in', rawChatId);
        return;
      }

      if (parsed.resources.length === 0) {
        this.enqueueMessage(parsed.message);
        return;
      }
      // Download resources then enqueue. Fire-and-forget — the gateway handler
      // must not block long-running downloads.
      this.downloadAndEnqueue(parsed.message, parsed.resources).catch((err) => {
        console.warn('[feishu/plugin]', 'Resource download failed:', err);
        // Still enqueue with whatever text we have so the conversation continues
        this.enqueueMessage(parsed.message);
      });
    });

    // Register card action handler — converts button clicks to callback messages.
    // Gateway guarantees 3-second response; this handler should stay lightweight.
    // Supports two button value formats:
    //   1. { callback_data: "perm:allow:xxx" }  — CodePilot permission buttons
    //   2. { action: "app_auth_done", operation_id: "xxx" }  — OpenClaw-style buttons
    this.gateway.registerCardActionHandler(async (data: unknown) => {
      const event = data as CardActionEvent;
      console.log('[feishu/plugin]', 'Card action raw event:', JSON.stringify(event).slice(0, 500));
      const value = event?.action?.value ?? {};
      // Feishu card.action.trigger v2 callback structure (per official docs):
      //   event.operator.open_id, event.context.open_chat_id, event.context.open_message_id
      // SDK InteractiveCardActionEvent (older type) flattens to:
      //   event.open_id, event.open_message_id
      // WSClient monkey-patch may deliver either format — try both paths.
      // Additionally, we embed chatId in button value as ultimate fallback.
      const chatId = event?.context?.open_chat_id || value.chatId || '';
      const messageId = event?.context?.open_message_id || event?.open_message_id || '';
      const userId = event?.operator?.open_id || event?.open_id || '';

      // Access control gate: reject card clicks from unauthorized users.
      // Required to prevent a non-whitelisted user from approving permissions
      // or switching projects via buttons on an existing bot card.
      if (chatId && !isUserAuthorized(this.config!, userId, chatId)) {
        console.log('[feishu/plugin]', 'Rejecting card action from unauthorized user',
          userId, 'in', chatId);
        return { toast: { type: 'warning' as const, content: '无权限操作' } };
      }

      // Format 1: callback_data (permission buttons)
      const callbackData = value.callback_data;
      if (callbackData && chatId) {
        const callbackMsg: InboundMessage = {
          messageId: messageId || `card_action_${Date.now()}`,
          address: {
            channelType: 'feishu',
            chatId,
            userId,
          },
          text: '',
          timestamp: Date.now(),
          callbackData,
          callbackMessageId: messageId,
        };
        console.log('[feishu/plugin]', 'Card action (callback_data):', callbackData);
        this.enqueueMessage(callbackMsg);
        return {
          toast: { type: 'info' as const, content: '已收到，正在处理...' },
        };
      }

      // Format 2: action / operation_id (OpenClaw-style buttons)
      const action = value.action;
      const operationId = value.operation_id;
      if (action) {
        // Encode as callbackData so the existing bridge-manager callback path
        // can handle it. Format: "action:{action}:{operation_id}"
        const syntheticCallback = operationId
          ? `action:${action}:${operationId}`
          : `action:${action}`;
        const actionMsg: InboundMessage = {
          messageId: messageId || `card_action_${Date.now()}`,
          address: {
            channelType: 'feishu',
            chatId,
            userId,
          },
          text: '',
          timestamp: Date.now(),
          callbackData: syntheticCallback,
          callbackMessageId: messageId,
        };
        console.log('[feishu/plugin]', 'Card action (action):', action, operationId ?? '');
        this.enqueueMessage(actionMsg);
        return {
          toast: { type: 'info' as const, content: '已收到，正在处理...' },
        };
      }

      // Unknown button format — still return a valid toast to prevent 200340
      console.warn('[feishu/plugin]', 'Unknown card action value:', JSON.stringify(value).slice(0, 200));
      return {
        toast: { type: 'info' as const, content: '已收到' },
      };
    });

    await this.gateway.start();

    // Resolve bot identity so mention filtering works (#384).
    // Fire-and-forget with retries — if it fails, mention detection simply no-ops
    // but the bot still functions normally for DMs and un-gated groups.
    //
    // Capture the current generation so stop() → new start() cycles can cancel
    // any in-flight probe from the previous run (prevents a stale probe from
    // writing botOpenId on a stopped plugin or scheduling a new retry timer).
    this.identityGeneration += 1;
    const probeGeneration = this.identityGeneration;
    this.resolveBotIdentity(probeGeneration).catch((err) => {
      console.warn('[feishu/plugin]', 'Bot identity resolution failed:', err);
    });
  }

  /**
   * Fetch bot open_id with retry so mention features degrade gracefully.
   *
   * Behavior:
   * - 3 quick attempts on startup (2s/4s/6s backoff)
   * - If all startup attempts fail, schedule a slow periodic retry every 60s
   *   so a transient API outage doesn't permanently disable requireMention
   *   for the rest of the process lifetime.
   * - Until resolved, requireMention fails open (inbound.ts gate checks
   *   botOpenId truthiness). This avoids dropping every group message during
   *   startup but does mean un-mentioned messages slip through the gap.
   *
   * The probe carries a generation snapshot. If stop() (or a subsequent
   * start()) has bumped the generation since this probe was launched, all
   * mutations and the retry-timer schedule are suppressed so a stale probe
   * can't repopulate state after shutdown.
   */
  private async resolveBotIdentity(generation: number, maxRetries = 3): Promise<void> {
    const client = this.gateway?.getRestClient();
    if (!client) return;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (this.identityGeneration !== generation) return; // stale — bail
      const info = await getBotInfo(client);
      if (this.identityGeneration !== generation) return; // stopped during await
      if (info?.openId) {
        this.botOpenId = info.openId;
        if (this.config?.requireMention) {
          console.log('[feishu/plugin]', `Bot identity resolved (attempt ${attempt}); requireMention gate now active`);
        }
        return;
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    if (this.identityGeneration !== generation) return; // don't schedule stale retries
    console.warn(
      '[feishu/plugin]',
      'Could not resolve bot identity — mention detection disabled; will retry every 60s'
    );
    this.startIdentityRetryTimer(generation);
  }

  /**
   * Slow background retry to recover from transient bot identity failures.
   * Polls every 60s until identity resolves, then stops. Canceled on stop().
   *
   * The timer callback checks the generation so an interval scheduled by a
   * previous start() cycle can't mutate state on a fresh plugin instance.
   *
   * Each callback captures its own handle (`myTimer`) so a stale callback
   * can only clear its own timer, never a timer belonging to a later
   * generation. Without this capture, a queued stale callback would see the
   * generation mismatch and then clearInterval(this.identityRetryTimer),
   * which might point at the fresh timer of a subsequent start() cycle,
   * silently killing recovery for the new session.
   */
  private startIdentityRetryTimer(generation: number): void {
    if (this.identityRetryTimer) return;
    // eslint-disable-next-line prefer-const
    let myTimer: ReturnType<typeof setInterval>;
    const clearSelf = () => {
      clearInterval(myTimer);
      // Only detach the shared field if it still points at our timer —
      // otherwise we'd clear a newer generation's recovery timer.
      if (this.identityRetryTimer === myTimer) {
        this.identityRetryTimer = null;
      }
    };
    myTimer = setInterval(async () => {
      if (this.identityGeneration !== generation) {
        clearSelf();
        return;
      }
      const client = this.gateway?.getRestClient();
      if (!client) return;
      const info = await getBotInfo(client);
      if (this.identityGeneration !== generation) {
        clearSelf();
        return;
      }
      if (info?.openId) {
        this.botOpenId = info.openId;
        clearSelf();
        if (this.config?.requireMention) {
          console.log('[feishu/plugin]', 'Bot identity resolved via background retry; requireMention gate now active');
        }
      }
    }, 60_000);
    this.identityRetryTimer = myTimer;
  }

  async stop(): Promise<void> {
    // Invalidate any in-flight identity probe so it can't mutate state
    // or schedule a new retry timer after shutdown.
    this.identityGeneration += 1;
    if (this.identityRetryTimer) {
      clearInterval(this.identityRetryTimer);
      this.identityRetryTimer = null;
    }
    if (this.gateway) {
      await this.gateway.stop();
      this.gateway = null;
    }
    this.botOpenId = '';
    // Unblock any waiting consumer
    if (this.waitResolve) {
      this.waitResolve(null);
      this.waitResolve = null;
    }
    // NOTE: Do NOT clear seenMessageIds here.
    // After gateway.stop() closes the WSClient, in-flight events from the old
    // connection may still arrive briefly. Keeping the dedup set prevents them
    // from being re-processed if a new gateway starts immediately after.
    // The set is bounded by DEDUP_MAX and will naturally age out.
  }

  isRunning(): boolean {
    return this.gateway?.isRunning() ?? false;
  }

  /**
   * Download resources then enqueue the message with populated attachments (#291).
   * Called from the message handler when non-text messages arrive. Partial
   * failures (some downloads fail) still enqueue — the LLM can see what succeeded.
   */
  private async downloadAndEnqueue(
    base: InboundMessage,
    resources: import('./inbound').PendingResource[],
  ): Promise<void> {
    const client = this.gateway?.getRestClient();
    if (!client) {
      this.enqueueMessage(base);
      return;
    }

    const attachments: import('@/types').FileAttachment[] = [];
    for (const r of resources) {
      const att = await downloadResource(client, r.messageId, r.fileKey, r.resourceType);
      if (att) attachments.push(att);
    }

    this.enqueueMessage({
      ...base,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  }

  private enqueueMessage(msg: InboundMessage): void {
    // Dedup: skip messages already seen (prevents duplicates from WS reconnect/retry)
    if (msg.messageId && !msg.callbackData) {
      if (this.seenMessageIds.has(msg.messageId)) {
        console.log('[feishu/plugin]', 'Duplicate message skipped:', msg.messageId);
        return;
      }
      this.seenMessageIds.add(msg.messageId);

      // Track messageId for reaction acknowledgment
      this.lastMessageIdByChat.set(msg.address.chatId, msg.messageId);

      // Prune dedup set when it exceeds capacity
      if (this.seenMessageIds.size > DEDUP_MAX) {
        const excess = this.seenMessageIds.size - DEDUP_MAX;
        let removed = 0;
        for (const id of this.seenMessageIds) {
          if (removed >= excess) break;
          this.seenMessageIds.delete(id);
          removed++;
        }
      }
    }

    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = null;
      resolve(msg);
    } else {
      this.messageQueue.push(msg);
    }
  }

  async consumeOne(): Promise<InboundMessage | null> {
    if (this.messageQueue.length > 0) {
      return this.messageQueue.shift()!;
    }
    return new Promise<InboundMessage | null>((resolve) => {
      this.waitResolve = resolve;
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const client = this.gateway?.getRestClient();
    if (!client) return { ok: false, error: 'Not connected' };
    return sendMessage(client, message);
  }

  isAuthorized(userId: string, chatId: string): boolean {
    if (!this.config) return false;
    return isUserAuthorized(this.config, userId, chatId);
  }

  /** Add emoji reaction to acknowledge message receipt. */
  onMessageStart(chatId: string): void {
    const client = this.gateway?.getRestClient();
    const messageId = this.lastMessageIdByChat.get(chatId);
    if (!client || !messageId) return;
    // Fire-and-forget — don't block message processing
    addReaction(client, messageId, 'Typing').then((reactionId) => {
      if (reactionId) {
        this.activeReactions.set(chatId, { messageId, reactionId });
      }
    }).catch(() => {});
  }

  /** Remove the "processing" reaction after response is sent. */
  onMessageEnd(chatId: string): void {
    const client = this.gateway?.getRestClient();
    const reaction = this.activeReactions.get(chatId);
    if (!client || !reaction) return;
    this.activeReactions.delete(chatId);
    removeReaction(client, reaction.messageId, reaction.reactionId).catch(() => {});
  }

  getCardStreamController(): CardStreamController | null {
    const client = this.gateway?.getRestClient();
    if (!client) {
      console.log('[feishu/plugin] getCardStreamController: no client');
      return null;
    }
    if (!this.config) {
      console.log('[feishu/plugin] getCardStreamController: no config');
      return null;
    }
    return createCardStreamController(client, this.config.cardStreamConfig);
  }

  /** Expose gateway for direct access (e.g. message-actions need restClient). */
  get _gateway(): FeishuGateway | null {
    return this.gateway;
  }
}
