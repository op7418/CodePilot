/**
 * Codex app-server JSON-RPC client.
 *
 * Phase 5 Phase 1 (2026-05-13). Implements the transport-agnostic
 * request / response / notification machinery; the concrete transport
 * (stdio readable+writable pair) is injected so unit tests can pump
 * the protocol without spawning a real `codex` binary.
 *
 * Protocol notes (per `资料/codex/codex-rs/app-server/README.md`):
 *
 * - JSON-RPC 2.0 over newline-delimited JSON on stdio.
 * - Server omits the `"jsonrpc":"2.0"` field on the wire but accepts
 *   it on incoming messages. We emit it for clarity and clients on
 *   other transports.
 * - Initialize handshake required once per connection: send
 *   `initialize` request, then `initialized` notification. Any other
 *   request before this returns "Not initialized".
 * - Backpressure: code `-32001` "Server overloaded; retry later." is
 *   retryable. Caller decides backoff policy.
 */

import type {
  CodexInitializeCapabilities,
  CodexInitializeResponse,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types';
import { CODEX_CLIENT_NAME, JSON_RPC_OVERLOADED_CODE } from './types';

/**
 * Minimal transport contract: caller provides a way to push JSON
 * strings to the server (`send`) and a way to subscribe to incoming
 * JSON strings (`onMessage`). Production wires stdio of a child
 * process; tests wire a pair of buffers.
 */
export interface CodexTransport {
  send(message: string): void | Promise<void>;
  onMessage(handler: (line: string) => void): () => void;
  /**
   * Subscribe to transport death (child process exit / socket error).
   * Optional so simple/legacy transports stay valid. When implemented,
   * the client uses it to reject all pending requests the instant the
   * process dies, instead of letting each wait out the 30s RPC timeout.
   *
   * Contract: if the transport is ALREADY closed when `onClose` is
   * called, it MUST invoke `handler` immediately (synchronously) — this
   * closes the race where the process exits before the client attaches.
   */
  onClose?(handler: (reason?: Error) => void): () => void;
  /**
   * Close the transport. Returns once the underlying resource has
   * been released (process killed, socket closed, etc.).
   */
  close(): Promise<void>;
}

export interface CodexClientOptions {
  /** Client display version — surfaced to Codex for compliance logs. */
  version: string;
  /** Optional human-readable title. */
  title?: string;
  /** Optional capabilities override. */
  capabilities?: CodexInitializeCapabilities;
  /** Request timeout in ms (per-request). Default 30s. */
  requestTimeoutMs?: number;
  /** Max retries on `-32001 overloaded`. Default 3. */
  maxOverloadRetries?: number;
}

export interface CodexRequestOptions {
  /** Abort only this RPC and remove its pending entry immediately. */
  signal?: AbortSignal;
  /** Per-call timeout override. Defaults to the client-level timeout. */
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: CodexRpcError | Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  method: string;
  startedAt: number;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export class CodexRequestAbortedError extends Error {
  readonly code = 'CODEX_RPC_ABORTED';

  constructor(method: string) {
    super(`Codex RPC aborted: ${method}`);
    this.name = 'AbortError';
  }
}

export class CodexRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(args: { code: number; message: string; data?: unknown }) {
    super(args.message);
    this.name = 'CodexRpcError';
    this.code = args.code;
    this.data = args.data;
  }
  get retryable(): boolean {
    return this.code === JSON_RPC_OVERLOADED_CODE;
  }
}

/**
 * Handler for a server-originated JSON-RPC request. Resolve with the
 * canonical response body OR throw to reject with an error.
 *
 * The client routes incoming `{ id, method, params }` (no result/error)
 * to whichever handler is registered for that method. If no handler is
 * registered, the client sends a JSON-RPC `-32601 method not found`
 * automatically so Codex doesn't hang waiting on us.
 */
export type ServerRequestHandler<TParams = unknown, TResult = unknown> = (
  params: TParams,
  context: { id: number | string; method: string },
) => Promise<TResult> | TResult;

export class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  /**
   * Wildcard notification handlers — receive `(method, params)` for
   * EVERY incoming notification. Phase 5 review round 2 fix (2026-05-13):
   * the runtime previously subscribed to ~9 specific methods, so any
   * notification outside that list was silently dropped despite the
   * mapper's `unknown_item` fallback claim. With this hook, the
   * runtime registers a single wildcard handler that runs every
   * notification through `translateCodexNotification`, so unknown
   * methods actually surface end-to-end.
   */
  private readonly anyNotificationHandlers = new Set<(method: string, params: unknown) => void>();
  private readonly serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private unsubscribe: (() => void) | null = null;
  private unsubscribeClose: (() => void) | null = null;
  private initializeResult: CodexInitializeResponse | null = null;
  /**
   * Set once the transport reports the process has died. Subsequent
   * requests fast-fail with `closeReason` instead of timing out.
   */
  private closed = false;
  private closeReason: Error | null = null;
  private readonly timeoutMs: number;
  private readonly maxOverloadRetries: number;

  constructor(
    private readonly transport: CodexTransport,
    private readonly opts: CodexClientOptions,
  ) {
    this.timeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.maxOverloadRetries = opts.maxOverloadRetries ?? 3;
  }

  /**
   * Attach the message-line listener. Must be called before sending
   * any request. `initialize()` calls this first.
   */
  private attach(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.transport.onMessage((line) => this.handleLine(line));
    // P0 (2026-06-01): when the underlying process/transport dies, reject
    // every pending request immediately instead of letting each wait out
    // the 30s RPC timeout. Without this, a Codex app-server that exits
    // during `initialize` (e.g. an older binary that fatally rejects the
    // user's ~/.codex/config.toml) hangs the model-list fetch — and the
    // chat composer + Settings pages that depend on it — for a full 30s.
    // The transport invokes this synchronously if it is already closed,
    // which also covers a process that exits before we attach.
    if (this.transport.onClose) {
      this.unsubscribeClose = this.transport.onClose((reason) => this.handleClose(reason));
    }
  }

  /**
   * Transport died — fail fast. Mark the client closed so new requests
   * reject immediately, and reject everything currently in flight.
   */
  private handleClose(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason ?? new Error('Codex app-server connection closed');
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.signal && pending.abortHandler) {
        pending.signal.removeEventListener('abort', pending.abortHandler);
      }
      pending.reject(this.closeReason);
      this.pending.delete(id);
    }
  }

  /**
   * Perform the handshake. Resolves with the server's initialize
   * response (userAgent + codexHome + platform info). Subsequent
   * methods will throw if called before this resolves.
   */
  async initialize(): Promise<CodexInitializeResponse> {
    if (this.initializeResult) return this.initializeResult;
    this.attach();
    const result = await this.request<CodexInitializeResponse>('initialize', {
      clientInfo: {
        name: CODEX_CLIENT_NAME,
        title: this.opts.title ?? null,
        version: this.opts.version,
      },
      capabilities: this.opts.capabilities ?? null,
    });
    this.initializeResult = result;
    // Acknowledge — server expects this notification before any
    // further request beyond `initialize`.
    await this.notify('initialized', {});
    return result;
  }

  get initialized(): boolean {
    return this.initializeResult !== null;
  }

  /** Send a request; resolves with the typed result. */
  async request<TResult>(
    method: string,
    params?: unknown,
    options: CodexRequestOptions = {},
  ): Promise<TResult> {
    let attempt = 0;
    // Overload retry loop. Each attempt uses a fresh id so a late
    // overload response from a previous attempt can't resolve the new one.
    while (true) {
      try {
        return await this.requestOnce<TResult>(method, params, options);
      } catch (err) {
        if (err instanceof CodexRpcError && err.retryable && attempt < this.maxOverloadRetries) {
          attempt++;
          // Exponential backoff with jitter (50–250ms × 2^attempt).
          const base = 50 + Math.random() * 200;
          await new Promise((r) => setTimeout(r, base * 2 ** (attempt - 1)));
          continue;
        }
        throw err;
      }
    }
  }

  private requestOnce<TResult>(
    method: string,
    params?: unknown,
    options: CodexRequestOptions = {},
  ): Promise<TResult> {
    // attach() may discover an already-dead transport and set `closed`.
    if (!this.unsubscribe) this.attach();
    if (this.closed) {
      return Promise.reject(this.closeReason ?? new Error('Codex app-server connection closed'));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new CodexRequestAbortedError(method));
    }
    return new Promise<TResult>((resolve, reject) => {
      const id = this.nextId++;
      const timeoutMs = options.timeoutMs ?? this.timeoutMs;
      const cleanup = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        if (pending.timer) clearTimeout(pending.timer);
        if (pending.signal && pending.abortHandler) {
          pending.signal.removeEventListener('abort', pending.abortHandler);
        }
        this.pending.delete(id);
      };
      const abortHandler = options.signal
        ? () => {
            if (!this.pending.has(id)) return;
            cleanup();
            reject(new CodexRequestAbortedError(method));
          }
        : undefined;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              cleanup();
              reject(new Error(`Codex RPC timeout: ${method} (>${timeoutMs}ms)`));
            }, timeoutMs)
          : null;
      this.pending.set(id, {
        resolve: (v) => resolve(v as TResult),
        reject,
        timer,
        method,
        startedAt: Date.now(),
        signal: options.signal,
        abortHandler,
      });
      options.signal?.addEventListener('abort', abortHandler!, { once: true });
      // Close the check→listener race: AbortSignal does not replay an abort
      // event to listeners attached after it has already fired.
      if (options.signal?.aborted) {
        abortHandler?.();
        return;
      }
      const message: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      };
      void Promise.resolve(this.transport.send(JSON.stringify(message))).catch((err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** Send a notification (no response). */
  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.unsubscribe) this.attach();
    const message: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    await this.transport.send(JSON.stringify(message));
  }

  /**
   * Subscribe to a notification method name. Returns an unsubscribe
   * function. Multiple handlers can be attached per method; they're
   * invoked in registration order.
   */
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  /**
   * Subscribe to every incoming notification. Phase 5 review round 2
   * fix — gives the runtime a chance to route ALL notifications
   * through the canonical mapper (including unknown methods that
   * the mapper turns into `unknown_item`), instead of dropping
   * anything that wasn't named in a per-method subscription.
   *
   * Fired alongside (not instead of) per-method handlers. Per-method
   * handlers still run; the wildcard is additive. Order: per-method
   * handlers first, then wildcards in registration order.
   */
  onAnyNotification(handler: (method: string, params: unknown) => void): () => void {
    this.anyNotificationHandlers.add(handler);
    return () => {
      this.anyNotificationHandlers.delete(handler);
    };
  }

  /**
   * Register a server-originated request handler. Phase 5 review fix
   * (2026-05-13) — Codex's approval flow (item/commandExecution/
   * requestApproval, item/fileChange/requestApproval, etc.) is a
   * server REQUEST, not a notification: the client MUST respond or
   * the turn hangs. Only one handler per method; subsequent
   * registrations replace.
   *
   * Handler may return synchronously OR a promise. Resolve with the
   * canonical response body; throw an Error to emit `-32603 internal
   * error` back to the server. To send a structured JSON-RPC error
   * (e.g. `-32601 method not found`), throw a `CodexRpcError`.
   */
  onServerRequest<TParams = unknown, TResult = unknown>(
    method: string,
    handler: ServerRequestHandler<TParams, TResult>,
  ): () => void {
    this.serverRequestHandlers.set(method, handler as ServerRequestHandler);
    return () => {
      // Only unregister if this exact handler is still registered (idempotent
      // unsubscribe even if a later caller has overwritten the slot).
      if (this.serverRequestHandlers.get(method) === (handler as ServerRequestHandler)) {
        this.serverRequestHandlers.delete(method);
      }
    };
  }

  /**
   * Tear down the client. Cancels any pending requests with a
   * "client disposed" error so callers don't hang forever.
   */
  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeClose?.();
    this.unsubscribeClose = null;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.signal && pending.abortHandler) {
        pending.signal.removeEventListener('abort', pending.abortHandler);
      }
      pending.reject(new Error(`Codex RPC aborted: ${pending.method} (client disposed)`));
      this.pending.delete(id);
    }
    await this.transport.close();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Wire-level message router
  // ─────────────────────────────────────────────────────────────────────

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcMessage;
    } catch (err) {
      console.warn('[codex] malformed JSON-RPC line', { line: trimmed.slice(0, 200), err });
      return;
    }

    // Response = has `id` + (`result` or `error`).
    if ('id' in parsed && parsed.id !== null && parsed.id !== undefined && ('result' in parsed || 'error' in parsed)) {
      this.routeResponse(parsed as JsonRpcResponse, Buffer.byteLength(trimmed, 'utf8'));
      return;
    }
    // Server-originated request = has `id` + `method` (no result/error).
    // Phase 5 review fix (2026-05-13): Codex's approval flow uses this
    // shape; ignoring it causes the turn to hang. Route to a handler
    // and emit a JSON-RPC response. Approval methods include:
    //   item/commandExecution/requestApproval
    //   item/fileChange/requestApproval
    //   item/permissions/requestApproval
    //   execCommandApproval / applyPatchApproval (legacy)
    //   item/tool/requestUserInput
    //   etc.
    if (
      'id' in parsed &&
      parsed.id !== null &&
      parsed.id !== undefined &&
      'method' in parsed &&
      !('result' in parsed) &&
      !('error' in parsed)
    ) {
      this.routeServerRequest(parsed as JsonRpcRequest);
      return;
    }
    // Notification = has `method` but no `id`.
    if ('method' in parsed && !('id' in parsed)) {
      this.routeNotification(parsed as JsonRpcNotification);
      return;
    }
    // Doesn't match any known shape — JSON-RPC spec lets servers send
    // batches or other variants we haven't seen yet. Log and ignore so
    // a future protocol extension doesn't crash us.
    console.warn('[codex] unsupported message shape', { method: 'method' in parsed ? parsed.method : '<unknown>' });
  }

  private routeServerRequest(message: JsonRpcRequest): void {
    const handler = this.serverRequestHandlers.get(message.method);
    if (!handler) {
      // No handler registered → respond with method-not-found so the
      // server doesn't hang. Codex's approval flow surfaces this as
      // an immediate "declined" outcome at the server side; runtime
      // adapter is expected to register a real handler before starting
      // any turn that may trigger approvals.
      console.warn('[codex] server-originated request with NO handler:', message.method);
      void this.sendResponse(message.id, {
        error: { code: -32601, message: `No handler registered for ${message.method}` },
      });
      return;
    }
    void (async () => {
      try {
        const result = await handler(message.params, { id: message.id, method: message.method });
        await this.sendResponse(message.id, { result });
      } catch (err) {
        if (err instanceof CodexRpcError) {
          await this.sendResponse(message.id, {
            error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) },
          });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          await this.sendResponse(message.id, {
            error: { code: -32603, message: msg },
          });
        }
      }
    })();
  }

  private async sendResponse(
    id: number | string,
    body: { result: unknown } | { error: { code: number; message: string; data?: unknown } },
  ): Promise<void> {
    await this.transport.send(JSON.stringify({ jsonrpc: '2.0', id, ...body }));
  }

  private routeResponse(message: JsonRpcResponse, responseBytes: number): void {
    const idKey = message.id as number | string;
    const pending = this.pending.get(idKey);
    if (!pending) {
      // Late response after timeout / dispose. Drop silently — already
      // rejected by the timer path.
      return;
    }
    this.pending.delete(idKey);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener('abort', pending.abortHandler);
    }
    if (pending.method === 'model/list') {
      console.info('[codex.models] response', {
        durationMs: Date.now() - pending.startedAt,
        responseBytes,
        outcome: 'error' in message ? 'rpc_error' : 'success',
      });
    }
    if ('error' in message) {
      pending.reject(
        new CodexRpcError({
          code: message.error.code,
          message: message.error.message,
          data: message.error.data,
        }),
      );
      return;
    }
    pending.resolve((message as { result: unknown }).result);
  }

  private routeNotification(message: JsonRpcNotification): void {
    const handlers = this.notificationHandlers.get(message.method);
    if (handlers && handlers.size > 0) {
      for (const h of handlers) {
        try {
          h(message.params);
        } catch (err) {
          console.warn('[codex] notification handler threw', { method: message.method, err });
        }
      }
    }
    // Wildcard handlers run for every notification — runtime uses
    // this to put unknown methods through the canonical mapper.
    if (this.anyNotificationHandlers.size > 0) {
      for (const h of this.anyNotificationHandlers) {
        try {
          h(message.method, message.params);
        } catch (err) {
          console.warn('[codex] any-notification handler threw', { method: message.method, err });
        }
      }
    }
  }
}
