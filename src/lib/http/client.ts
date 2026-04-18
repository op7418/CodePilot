import { HttpClientError, isLikelyNetworkError, isRetryableHttpStatus } from '@/lib/http/errors';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_RETRY_JITTER_MS = 75;

type NextFetchOptions = {
  revalidate?: number | false;
  tags?: string[];
};

export interface HttpClientRequestOptions extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  retryJitterMs?: number;
  requestId?: string;
  signal?: AbortSignal;
  next?: NextFetchOptions;
}

export interface HttpJsonResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  requestId: string;
}

function generateRequestId(): string {
  const maybeCrypto = globalThis.crypto as Crypto | undefined;
  if (maybeCrypto?.randomUUID) return maybeCrypto.randomUUID();
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  jitterMs: number,
  retryAfterSeconds?: number,
): number {
  if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.max(baseDelayMs, Math.ceil(retryAfterSeconds * 1000));
  }
  const exponential = baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
  return exponential + jitter;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

function combineSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (!secondary) return primary;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([primary, secondary]);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (primary.aborted || secondary.aborted) {
    controller.abort();
    return controller.signal;
  }
  primary.addEventListener('abort', abort, { once: true });
  secondary.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

function normalizeMethod(method?: string): string {
  return (method || 'GET').toUpperCase();
}

function buildRequestInit(
  url: string,
  requestId: string,
  options: HttpClientRequestOptions,
  signal: AbortSignal,
): RequestInit & { next?: NextFetchOptions } {
  const init = { ...options } as HttpClientRequestOptions & { [key: string]: unknown };
  delete init.timeoutMs;
  delete init.retries;
  delete init.retryDelayMs;
  delete init.retryJitterMs;
  delete init.requestId;

  const headers = new Headers(options.headers);
  if (!headers.has('x-request-id')) {
    headers.set('x-request-id', requestId);
  }

  return {
    ...init,
    method: normalizeMethod(options.method),
    headers,
    signal,
    next: options.next,
  };
}

function extractRetryAfterSeconds(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, (dateMs - Date.now()) / 1000);
}

export async function requestJson<T>(url: string, options: HttpClientRequestOptions = {}): Promise<HttpJsonResponse<T>> {
  const requestId = options.requestId || generateRequestId();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const retryJitterMs = Math.max(0, options.retryJitterMs ?? DEFAULT_RETRY_JITTER_MS);
  const method = normalizeMethod(options.method);

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const timeout = createTimeoutSignal(timeoutMs);
    const signal = combineSignals(timeout.signal, options.signal);
    const init = buildRequestInit(url, requestId, options, signal);
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        const retryable = isRetryableHttpStatus(response.status);
        const statusText = response.statusText || 'Unknown Error';
        const error = new HttpClientError({
          code: 'http_status',
          requestId,
          status: response.status,
          url,
          method,
          retryable,
          attempt,
          message: `Upstream HTTP ${response.status} ${statusText}`,
        });
        if (retryable && attempt <= retries) {
          const delayMs = computeBackoffDelay(
            attempt,
            retryDelayMs,
            retryJitterMs,
            extractRetryAfterSeconds(response.headers),
          );
          await delay(delayMs, options.signal);
          continue;
        }
        throw error;
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch (cause) {
        throw new HttpClientError({
          code: 'invalid_json',
          requestId,
          url,
          method,
          retryable: false,
          attempt,
          message: 'Failed to parse JSON response',
          cause,
        });
      }

      return {
        data: data as T,
        status: response.status,
        headers: response.headers,
        requestId,
      };
    } catch (error) {
      if (error instanceof HttpClientError) {
        throw error;
      }

      const isTimeout = timeout.signal.aborted && !options.signal?.aborted;
      const code = isTimeout ? 'timeout' : (isLikelyNetworkError(error) ? 'network' : 'unknown');
      const retryable = code === 'timeout' || code === 'network';
      const normalized = new HttpClientError({
        code,
        requestId,
        url,
        method,
        retryable,
        attempt,
        message: isTimeout ? `Request timeout after ${timeoutMs}ms` : `Request failed: ${String((error as Error)?.message || error)}`,
        cause: error,
      });
      if (retryable && attempt <= retries) {
        const delayMs = computeBackoffDelay(attempt, retryDelayMs, retryJitterMs);
        await delay(delayMs, options.signal);
        continue;
      }
      throw normalized;
    } finally {
      timeout.cleanup();
    }
  }

  throw new HttpClientError({
    code: 'unknown',
    requestId,
    url,
    method,
    retryable: false,
    attempt: retries + 1,
    message: 'Request failed after retries',
  });
}

export async function getJson<T>(url: string, options: HttpClientRequestOptions = {}): Promise<HttpJsonResponse<T>> {
  return requestJson<T>(url, { ...options, method: 'GET' });
}

export { HttpClientError } from '@/lib/http/errors';
