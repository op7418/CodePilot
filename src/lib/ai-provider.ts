import { isTokenDanceBaseUrl } from './tokendance';
import { tokenDanceFetch } from './tokendance-fetch';
/**
 * ai-provider.ts — Unified AI model factory for the native Agent Loop.
 *
 * Creates a Vercel AI SDK LanguageModel from a ResolvedProvider + model override.
 * Both text-generator.ts (simple generation) and agent-loop.ts (agentic chat)
 * call through this module so provider handling is defined in exactly one place.
 *
 * Key design decisions (from comparative analysis of OpenCode, Claude Code, Craft Agents):
 * - BaseURL normalisation: append /v1 for bare domains (Anthropic proxies expect /v1/messages)
 * - Model ID: always resolve to full upstream ID, never send short aliases to API
 * - Beta headers: match OpenCode's set for proxy compatibility
 * - Third-party proxy safety: disable adaptive thinking (not widely supported by proxies)
 */

import {
  type LanguageModel,
  type LanguageModelMiddleware,
  wrapLanguageModel,
  defaultSettingsMiddleware,
  extractReasoningMiddleware,
} from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { GEMINI_FLASH_MODEL, geminiFlashMiddleware } from './google-model-options';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import {
  type ResolvedProvider,
  type AiSdkConfig,
  resolveProvider,
  toAiSdkConfig,
} from './provider-resolver';
import { extractComputeResidency } from './openai-oauth';
import { ensureTokenFresh } from './openai-oauth-manager';
import { createXaiOAuthFetch } from './xai-oauth-manager';
import { withChatImageDataUrlFetch } from './openai-chat-image-normalizer';
import { assertProviderCallAllowed, type ProviderCallScene } from './provider-call-policy';
import { ProviderTransportError } from './provider-transport-error';
import type { ChatRuntime } from './chat-runtime';

// ── Public API ──────────────────────────────────────────────────

export interface CreateModelOptions {
  callScene: ProviderCallScene;
  providerId?: string;
  sessionProviderId?: string;
  /** Provider snapshot captured by a fail-closed upstream caller. When set,
   *  model construction must not re-resolve or fall back to another provider. */
  resolvedProvider?: ResolvedProvider;
  model?: string;
  sessionModel?: string;
  /** Runtime-specific transport selection (for example native Responses in Codex Runtime). */
  runtime?: ChatRuntime;
  /** Internal auxiliary snapshot: captured with resolvedProvider before async work. */
  resolvedConfig?: AiSdkConfig;
}

export interface CreateModelResult {
  languageModel: LanguageModel;
  modelId: string;
  config: AiSdkConfig;
  resolved: ResolvedProvider;
  /** True when using a third-party proxy (not api.anthropic.com) */
  isThirdPartyProxy: boolean;
}

/**
 * Resolve provider + model and create a Vercel AI SDK LanguageModel instance.
 */
export function createModel(opts: CreateModelOptions): CreateModelResult {
  const resolved = opts.resolvedProvider ?? resolveProvider({
    callScene: opts.callScene,
    providerId: opts.providerId,
    sessionProviderId: opts.sessionProviderId,
    model: opts.model,
    sessionModel: opts.sessionModel,
    runtime: opts.runtime,
  });
  assertProviderCallAllowed(resolved.provider, opts.callScene);

  if (!resolved.hasCredentials) {
    if (resolved.provider) {
      throw new ProviderTransportError('PROVIDER_CREDENTIALS_UNAVAILABLE',
        'The selected provider credential is missing or unavailable. Re-enter its API key in Settings → Providers.',
      );
    }
    throw new ProviderTransportError('NATIVE_CREDENTIALS_REQUIRED',
      'No provider credentials available. Please configure a provider in Settings or set ANTHROPIC_API_KEY.',
    );
  }

  const config = opts.resolvedConfig ? { ...opts.resolvedConfig } : toAiSdkConfig(resolved, opts.model || opts.sessionModel, {
    runtime: opts.runtime,
  });
  const availability = getNativeTransportAvailability(resolved, config);
  if (!availability.available) {
    throw new ProviderTransportError(availability.code, availability.message);
  }

  // ── Model ID resolution ─────────────────────────────────────
  // toAiSdkConfig tries to resolve via availableModels catalog, but if
  // upstreamModelId is undefined (common for user-configured providers),
  // modelId remains a short alias like "sonnet". We must resolve it further.
  //
  // Resolution chain (matching Claude Code SDK's env var approach):
  // 1. Provider's roleModels (sonnet/opus/haiku → provider-specific upstream ID)
  // 2. Hardcoded Anthropic defaults (for env-mode without provider)
  // Model ID: trust what toAiSdkConfig resolved.
  // It uses the provider's availableModels catalog → upstreamModelId.
  // If no upstream mapping exists, pass the alias as-is (proxies often accept short aliases).
  // Only for env-mode (no provider) with bare aliases, map to current Anthropic defaults.
  if (!resolved.provider && isShortAlias(config.modelId)) {
    const CURRENT_DEFAULTS: Record<string, string> = {
      sonnet: 'claude-sonnet-4-6',
      opus: 'claude-opus-4-7',
      haiku: 'claude-haiku-4-5-20251001',
    };
    config.modelId = CURRENT_DEFAULTS[config.modelId] || config.modelId;
  }

  // Inject process env if needed (bedrock/vertex)
  for (const [k, v] of Object.entries(config.processEnvInjections)) {
    process.env[k] = v;
  }

  const isThirdPartyProxy = config.sdkType === 'claude-code-compat' || (
    config.sdkType === 'anthropic'
    && !!config.baseUrl
    && !isOfficialAnthropicUrl(config.baseUrl)
  );

  const rawModel = createLanguageModel(config, isThirdPartyProxy);

  // Apply middleware pipeline
  const languageModel = applyMiddleware(rawModel, config, isThirdPartyProxy);

  return { languageModel, modelId: config.modelId, config, resolved, isThirdPartyProxy };
}

/** Claude SDK settings availability is not evidence that Native can authenticate. */
export function getNativeTransportAvailability(resolved: ResolvedProvider, config: AiSdkConfig):
  | { available: true }
  | { available: false; code: 'CLAUDE_SETTINGS_ONLY' | 'NATIVE_CREDENTIALS_REQUIRED' | 'PROVIDER_TRANSPORT_UNSUPPORTED'; message: string } {
  if (resolved._codexAccount) return {
    available: false, code: 'PROVIDER_TRANSPORT_UNSUPPORTED',
    message: 'This account is available through Codex Runtime. Native auxiliary requests are unavailable.',
  };
  if (config.responsesApiAuth === 'codex_oauth' || config.useXaiOAuth
    || config.sdkType === 'bedrock' || config.sdkType === 'vertex') return { available: true };
  if (config.apiKey || config.authToken) return { available: true };
  const settingsOnly = !resolved.provider && resolved.hasCredentials;
  return {
    available: false,
    code: settingsOnly ? 'CLAUDE_SETTINGS_ONLY' : 'NATIVE_CREDENTIALS_REQUIRED',
    message: settingsOnly
      ? 'Credentials are available only to Claude Code SDK. Configure a Native provider to enable optional background AI features.'
      : 'No Native provider credentials are available. Configure a provider in Settings.',
  };
}

function isShortAlias(modelId: string): boolean {
  return ['sonnet', 'opus', 'haiku'].includes(modelId);
}

// ── URL helpers ─────────────────────────────────────────────────

function isOfficialAnthropicUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === 'api.anthropic.com' || hostname.endsWith('.anthropic.com');
  } catch {
    return false;
  }
}

/**
 * Whether a provider base URL points at the first-party Anthropic endpoint.
 * Empty / absent base_url = the SDK default (api.anthropic.com) = first-party.
 * Used to decide whether the SDK's `modelUsage.contextWindow` is trustworthy:
 * it's the SDK's bundled-catalog value — reliable for first-party Anthropic,
 * but a generic default for third-party Anthropic-compatible proxies (e.g. a
 * GLM endpoint via custom base_url), where it misrepresents the real window. (#632)
 */
export function isFirstPartyAnthropicEndpoint(baseUrl?: string | null): boolean {
  return !baseUrl || isOfficialAnthropicUrl(baseUrl);
}

/**
 * @ai-sdk/anthropic appends `/messages` to baseURL.
 * Default is `https://api.anthropic.com/v1` → `/v1/messages`.
 * Third-party proxies expect the same, but users often omit `/v1`.
 */
function normaliseBaseUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const cleaned = url.replace(/\/+$/, '');
  if (cleaned.endsWith('/v1')) return cleaned;
  // Has a deeper path (e.g. /api/anthropic) — don't touch
  try {
    const pathname = new URL(cleaned).pathname;
    if (pathname !== '/' && pathname !== '') return cleaned;
  } catch { return cleaned; }
  return `${cleaned}/v1`;
}

// ── Provider creation ───────────────────────────────────────────

// Beta headers matching OpenCode's anthropic custom loader.
// Ref: opencode-dev/packages/opencode/src/provider/provider.ts lines 120-131
const ANTHROPIC_BETA_HEADERS = [
  'interleaved-thinking-2025-05-14',
];

/**
 * Build an API-key authenticated Responses model from a resolved transport.
 * Exported so request-shape tests can exercise the exact production factory
 * with a capture fetch instead of duplicating the SDK setup.
 */
export function createApiKeyResponsesLanguageModel(
  config: Pick<
    AiSdkConfig,
    'apiKey' | 'baseUrl' | 'modelId' | 'headers' | 'supportsResponsesReasoningSummary'
  >,
  fetchImpl?: typeof fetch,
): LanguageModel {
  const hasHeaders = Object.keys(config.headers || {}).length > 0;
  const upstreamFetch = fetchImpl ?? globalThis.fetch;
  const compatibleFetch = config.supportsResponsesReasoningSummary === false
    ? (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body !== 'string') return upstreamFetch(input, init);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(init.body) as Record<string, unknown>;
        } catch {
          return upstreamFetch(input, init);
        }
        const reasoning = body.reasoning;
        if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning)) {
          return upstreamFetch(input, init);
        }
        const { summary: _unsupportedSummary, ...supportedReasoning } = reasoning as Record<string, unknown>;
        return upstreamFetch(input, {
          ...init,
          body: JSON.stringify({ ...body, reasoning: supportedReasoning }),
        });
      }) as typeof fetch
    : fetchImpl;
  const openai = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    ...(hasHeaders ? { headers: config.headers } : {}),
    ...(compatibleFetch ? { fetch: compatibleFetch } : {}),
  });
  return openai.responses(config.modelId);
}

function createLanguageModel(config: AiSdkConfig, isThirdPartyProxy: boolean): LanguageModel {
  const hasHeaders = Object.keys(config.headers || {}).length > 0;

  switch (config.sdkType) {
    case 'anthropic': {
      const baseURL = normaliseBaseUrl(config.baseUrl);
      const headers: Record<string, string> = {
        'anthropic-beta': ANTHROPIC_BETA_HEADERS.join(','),
        ...config.headers,
      };

      const anthropic = createAnthropic({
        ...(config.authToken
          ? { authToken: config.authToken }
          : { apiKey: config.apiKey }),
        baseURL,
        headers,
        ...(isTokenDanceBaseUrl(config.baseUrl) ? { fetch: tokenDanceFetch } : {}),
      });
      return anthropic(config.modelId);
    }

    case 'claude-code-compat': {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createClaudeCodeCompatModel } = require('./claude-code-compat') as typeof import('./claude-code-compat');
      return createClaudeCodeCompatModel({
        apiKey: config.apiKey,
        authToken: config.authToken,
        baseUrl: config.baseUrl || 'https://api.anthropic.com/v1',
        modelId: config.modelId,
        headers: config.headers,
      }) as unknown as LanguageModel;
    }

    case 'openai': {
      // API-key Responses providers use the normal SDK transport. The preset
      // resolver only enables this for model/runtime pairs whose vendor wire
      // contract was verified (DeepSeek V4 Flash + Codex Runtime today).
      if (config.useResponsesApi && config.responsesApiAuth === 'api_key') {
        return createApiKeyResponsesLanguageModel(config);
      }

      // OpenAI OAuth (Codex API) — use custom fetch to rewrite URL + inject auth
      // Pattern from opencode-dev's codex.ts plugin
      if (config.useResponsesApi && config.responsesApiAuth === 'codex_oauth') {
        // Phase 5b round-7 fix (2026-05-18) — per-fetch token refresh.
        // Pre-fix this captured `getOAuthCredentialsSync()` at model-
        // creation time AND stored `accessToken` / `accountId` in
        // closure. Two problems:
        //   (1) `getOAuthCredentialsSync()` returns undefined for
        //       expired tokens even when a refresh_token is on hand —
        //       so a session sitting past expiry could never recover,
        //       and `/api/openai-oauth/status` would say
        //       authenticated:true while the proxy hard-errored.
        //   (2) Even when fresh creds were captured, they went stale
        //       on long sessions; subsequent fetches kept reusing the
        //       captured value.
        // Fix: drop the construction-time check entirely. On every
        // fetch, `await ensureTokenFresh()` — it refreshes via
        // refresh_token if the access token is past/within the 5-min
        // expiry buffer, persists via `saveTokens()`, and returns
        // fresh creds. Only returns undefined when there's no usable
        // refresh path at all, at which point we throw the "log in
        // again" error — but at first-fetch time, not lazily at
        // model-creation.
        const codexEndpoint = config.baseUrl
          ? `${config.baseUrl}/responses`
          : 'https://chatgpt.com/backend-api/codex/responses';

        const openai = createOpenAI({
          apiKey: 'codex-oauth',  // placeholder — overridden by custom fetch
          // Keep default baseURL so SDK constructs valid paths
          fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
            const reqUrl = url instanceof URL ? url : new URL(typeof url === 'string' ? url : url.url);
            if (new URL(codexEndpoint).href !== 'https://chatgpt.com/backend-api/codex/responses'
              || reqUrl.origin !== 'https://api.openai.com' || reqUrl.pathname !== '/v1/responses') {
              throw new ProviderTransportError('PROVIDER_TRANSPORT_UNSUPPORTED', 'OpenAI OAuth requires the ChatGPT Codex endpoint');
            }
            const creds = await ensureTokenFresh();
            if (!creds) {
              throw new ProviderTransportError('PROVIDER_OAUTH_EXPIRED', 'OpenAI OAuth token expired or not available. Please log in again in Settings.');
            }
            // Rewrite URL to Codex endpoint
            const targetUrl = reqUrl.pathname.includes('/responses')
              ? new URL(codexEndpoint)
              : reqUrl;

            // Build headers with OAuth credentials
            const headers = new Headers(init?.headers);
            // Remove SDK's dummy auth, inject real OAuth token
            headers.delete('Authorization');
            headers.delete('authorization');
            headers.set('Authorization', `Bearer ${creds.accessToken}`);
            if (creds.accountId) {
              headers.set('chatgpt-account-id', creds.accountId);
            }

            const residency = extractComputeResidency(creds.accessToken);
            if (residency) headers.set('x-openai-internal-codex-residency', residency);

            // Timeout: 30s default, configurable via CODEX_TIMEOUT_MS
            const timeoutMs = parseInt(process.env.CODEX_TIMEOUT_MS || '30000', 10);
            const timeoutCtl = new AbortController();
            const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
            const combinedSignal = init?.signal
              ? AbortSignal.any([init.signal, timeoutCtl.signal])
              : timeoutCtl.signal;

            try {
              const resp = await fetch(targetUrl, { ...init, headers, signal: combinedSignal, redirect: 'error' });
              clearTimeout(timer);
              if (!resp.ok) {
                const body = await resp.clone().text().catch(() => '');
                console.error(`[openai-codex] ${resp.status} ${resp.statusText}:`, body.slice(0, 500));
              }
              return resp;
            } catch (err) {
              clearTimeout(timer);
              if (err instanceof Error && err.name === 'AbortError' && timeoutCtl.signal.aborted) {
                throw new ProviderTransportError('PROVIDER_REQUEST_TIMEOUT',
                  `OpenAI Codex API 连接超时 (${timeoutMs}ms)。如果你在防火墙内，请配置系统代理或在设置中设置 HTTPS_PROXY。`
                );
              }
              throw err;
            }
          },
        });
        return openai.responses(config.modelId);
      }

      const openai = createOpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        ...(hasHeaders ? { headers: config.headers } : {}),
        // @ai-sdk/openai@4.0.5 .chat() emits image_url.url as BARE base64
        // (missing the data:<mime>;base64, prefix — Phase 2 发现 3, fixture
        // openai-chat-file-image-upstream-bare-base64). Gateways expect a
        // data URL or remote URL, so bare base64 breaks image input on this
        // wire. The wrapper sniffs the real MIME (png/jpeg/webp/gif/svg) and
        // prefixes it; already-schemed URLs pass through verbatim, so an
        // upstream fix cannot double-prefix.
        fetch: withChatImageDataUrlFetch(isTokenDanceBaseUrl(config.baseUrl) ? tokenDanceFetch : undefined),
      });
      // Chat Completions, NOT the Responses API. In @ai-sdk/openai v3 the bare
      // `openai(modelId)` call defaults to `.responses()` (/v1/responses), but
      // every provider that reaches this non-OAuth branch speaks the OpenAI
      // Chat Completions wire: openai-compatible third-party gateways,
      // OpenRouter /v1, and bedrock/vertex/google-via-baseUrl proxies. The
      // Codex OAuth path that genuinely needs Responses returns earlier via
      // `openai.responses()` under `config.useResponsesApi`. Third-party
      // gateways implement /v1/chat/completions, not /v1/responses, so
      // `.chat()` is the correct + portable wire here.
      return openai.chat(config.modelId);
    }

    case 'xai': {
      const xai = createXai({
        apiKey: config.useXaiOAuth ? 'xai-oauth' : config.apiKey,
        baseURL: config.baseUrl || 'https://api.x.ai/v1',
        ...(hasHeaders ? { headers: config.headers } : {}),
        ...(config.useXaiOAuth ? { fetch: createXaiOAuthFetch(config.modelId) } : {}),
      });
      // Grok 4.5+ is intentionally wired through xAI Responses, not the
      // provider's OpenAI-compatible Chat Completions surface.
      return xai.responses(config.modelId);
    }

    case 'google': {
      const google = createGoogleGenerativeAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        ...(hasHeaders ? { headers: config.headers } : {}),
      });
      const model = google(config.modelId);
      return config.modelId === GEMINI_FLASH_MODEL
        ? wrapLanguageModel({ model, middleware: geminiFlashMiddleware })
        : model;
    }

    case 'bedrock': {
      const bedrock = createAmazonBedrock({
        ...(hasHeaders ? { headers: config.headers } : {}),
      });
      return bedrock(config.modelId);
    }

    case 'vertex': {
      const vertex = createVertexAnthropic({
        ...(hasHeaders ? { headers: config.headers } : {}),
      });
      return vertex(config.modelId);
    }

    default: {
      const anthropic = createAnthropic({
        ...(config.authToken
          ? { authToken: config.authToken }
          : { apiKey: config.apiKey }),
        baseURL: config.baseUrl,
        ...(hasHeaders ? { headers: config.headers } : {}),
      });
      return anthropic(config.modelId);
    }
  }
}

// ── Middleware pipeline ────────────────────────────────────────

/**
 * Logging middleware — logs model calls for debugging.
 * Only active in development (NODE_ENV !== 'production').
 */
const loggingMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrapGenerate: async ({ doGenerate }: any) => {
    const start = Date.now();
    const result = await doGenerate();
    console.log(`[ai-provider] generate: ${Date.now() - start}ms, tokens: ${result.usage?.inputTokens ?? '?'}→${result.usage?.outputTokens ?? '?'}`);
    return result;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrapStream: async ({ doStream }: any) => {
    const start = Date.now();
    const result = await doStream();
    console.log(`[ai-provider] stream started: ${Date.now() - start}ms`);
    return result;
  },
};

/**
 * Apply middleware pipeline to a language model.
 *
 * Middleware stack (applied in order):
 * 1. defaultSettingsMiddleware — consistent defaults across providers
 * 2. extractReasoningMiddleware — DeepSeek R1 / <think> tag models
 * 3. loggingMiddleware — dev-only request/response logging
 */
function applyMiddleware(
  model: LanguageModel,
  config: AiSdkConfig,
  _isThirdPartyProxy: boolean,
): LanguageModel {
  const middlewares: LanguageModelMiddleware[] = [];

  // 1. Default settings — ensure consistent temperature across providers
  middlewares.push(defaultSettingsMiddleware({
    settings: {
      // Don't set temperature for reasoning models (o3, o4-mini, etc.)
      // as they ignore it or error
    },
  }));

  // 2. Reasoning extraction — for DeepSeek R1 and similar models that use <think> tags
  //    Only apply to OpenAI-compatible providers (not Anthropic, which has native thinking)
  if (config.sdkType === 'openai' && !config.useResponsesApi) {
    middlewares.push(extractReasoningMiddleware({
      tagName: 'think',
    }));
  }

  // 3. Logging (dev only)
  if (process.env.NODE_ENV !== 'production') {
    middlewares.push(loggingMiddleware);
  }

  // Apply middleware chain
  if (middlewares.length === 0) return model;

  // wrapLanguageModel expects LanguageModelV3, cast through any for union type compat
  return wrapLanguageModel({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: model as any,
    middleware: middlewares,
  }) as unknown as LanguageModel;
}
