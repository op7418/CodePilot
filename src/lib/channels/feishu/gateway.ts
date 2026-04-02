/**
 * Feishu WebSocket gateway — manages lark SDK client and WS connection lifecycle.
 *
 * Key design decisions:
 * - WSClient mode handles auth internally — no encryptKey/verificationToken needed.
 * - Client and WSClient receive the resolved SDK domain (Feishu vs Lark).
 * - card.action.trigger handler guarantees a valid response within 3 seconds,
 *   regardless of what the upper-layer handler does. Heavy logic is fire-and-forget.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuConfig } from './types';

const LOG_TAG = '[feishu/gateway]';

/** Map brand string to SDK domain constant. */
function resolveDomain(brand: string): lark.Domain | string {
  if (brand === 'lark') return lark.Domain.Lark;
  if (brand === 'feishu') return lark.Domain.Feishu;
  // Custom domain (e.g. self-hosted): pass through as-is
  return brand.replace(/\/+$/, '');
}

/** Default toast returned when the upper-layer handler fails or times out. */
const FALLBACK_TOAST = {
  toast: { type: 'info' as const, content: '已收到，正在处理...' },
};

/**
 * Card action callback handler type.
 * Receives the raw event data and returns a toast/card response object.
 * May also return void/undefined — gateway will fill in a default toast.
 */
export type CardActionHandler = (data: unknown) => Promise<unknown>;

export class FeishuGateway {
  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private running = false;
  private config: FeishuConfig;
  private eventDispatcher: lark.EventDispatcher;
  private onMessage: ((data: unknown) => void) | null = null;
  private cardActionHandler: CardActionHandler | null = null;

  constructor(config: FeishuConfig) {
    this.config = config;
    // WSClient mode doesn't need encryptKey/verificationToken — pass empty strings.
    this.eventDispatcher = new lark.EventDispatcher({
      encryptKey: '',
      verificationToken: '',
    });
  }

  /** Get the REST client (for API calls). */
  getRestClient(): lark.Client | null {
    return this.client;
  }

  /** Get the event dispatcher for handler registration. */
  getEventDispatcher(): lark.EventDispatcher {
    return this.eventDispatcher;
  }

  /** Register the im.message.receive_v1 handler. */
  registerMessageHandler(handler: (data: unknown) => void): void {
    this.onMessage = handler;
    this.eventDispatcher.register<Record<string, (data: unknown) => void>>({
      'im.message.receive_v1': (data: unknown) => {
        handler(data);
      },
    });
  }

  /**
   * Register a card action handler.
   *
   * The gateway wraps this handler with a 3-second timeout guarantee:
   * - If the handler resolves within 3s, its return value is used.
   * - If it throws or times out, a safe fallback toast is returned.
   * - The handler itself should keep synchronous work minimal and
   *   push heavy logic to fire-and-forget (setImmediate / queueMicrotask).
   *
   * Supports both button value formats:
   * - value.callback_data  (CodePilot permission buttons)
   * - value.action / value.operation_id  (OpenClaw-style buttons)
   */
  registerCardActionHandler(handler: CardActionHandler): void {
    this.cardActionHandler = handler;

    // Register the safe wrapper on the EventDispatcher.
    // The wrapper guarantees a response object is always returned.
    this.eventDispatcher.register<Record<string, (data: unknown) => Promise<unknown>>>({
      'card.action.trigger': (data: unknown) => this.safeCardActionHandler(data),
    });
  }

  /**
   * Gateway-level card action handler that enforces the 3-second response contract.
   *
   * Flow:
   * 1. Race the upper-layer handler against a 2.5s timeout (leaving 500ms margin).
   * 2. If the handler returns a valid object, use it.
   * 3. If it throws, times out, or returns nothing, return FALLBACK_TOAST.
   */
  private async safeCardActionHandler(data: unknown): Promise<unknown> {
    const handler = this.cardActionHandler;
    if (!handler) return FALLBACK_TOAST;

    const TIMEOUT_MS = 2500; // 2.5s — leave 500ms margin for SDK overhead

    try {
      const result = await Promise.race([
        handler(data),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), TIMEOUT_MS)),
      ]);

      // Handler resolved with a valid response
      if (result && typeof result === 'object') return result;

      // Handler returned void/undefined or timed out — use fallback
      return FALLBACK_TOAST;
    } catch (err) {
      console.error(LOG_TAG, 'Card action handler error:', err);
      return FALLBACK_TOAST;
    }
  }

  /** Start the WebSocket connection. */
  async start(): Promise<void> {
    if (this.running) return;

    const domain = resolveDomain(this.config.domain);

    this.client = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain,
      disableTokenCache: false,
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.warn,
    });

    // Monkey-patch handleEventData to support card action events (type: "card").
    // The SDK's WSClient only handles type="event" by default; card action
    // callbacks arrive as type="card" and would be silently dropped.
    // Patch: rewrite type header from "card" to "event" before dispatching.
    interface WSHeader { key: string; value: string }
    interface WSEventData { headers: WSHeader[]; [key: string]: unknown }
    type HandleEventDataFn = (data: WSEventData) => unknown;
    const wsClientRecord = this.wsClient as unknown as Record<string, unknown>;
    if (typeof wsClientRecord.handleEventData === 'function') {
      const origHandleEventData = (wsClientRecord.handleEventData as HandleEventDataFn).bind(this.wsClient);
      wsClientRecord.handleEventData = (data: WSEventData) => {
        const msgType = data.headers?.find?.((h: WSHeader) => h.key === 'type')?.value;
        if (msgType !== 'event') console.log(LOG_TAG, 'handleEventData type:', msgType);
        if (msgType === 'card') {
          const patchedData: WSEventData = {
            ...data,
            headers: data.headers.map((h: WSHeader) =>
              h.key === 'type' ? { ...h, value: 'event' } : h,
            ),
          };
          return origHandleEventData(patchedData);
        }
        return origHandleEventData(data);
      };
    }

    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    this.running = true;
    console.log(LOG_TAG, 'WebSocket connected');
  }

  /** Stop the WebSocket connection. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    // WSClient doesn't expose a clean stop — set refs to null
    this.wsClient = null;
    console.log(LOG_TAG, 'Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }
}
