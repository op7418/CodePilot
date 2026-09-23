import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateText } from 'ai';
import { createProvider, getProvider, getSetting, setSetting, getAllProviders, getDb, deleteProvider, applyDiscoveryDiff, getAllModelsForProvider, updateProviderModelUserFields } from '@/lib/db';
import { NextRequest } from 'next/server';
import { POST as probeModels } from '@/app/api/providers/[id]/discover-models/route';
import { POST as applyModels } from '@/app/api/providers/[id]/discover-models/apply/route';
import { GET as modelFeed } from '@/app/api/providers/models/route';
import { getPreset, resolveProviderPresetIdentity } from '@/lib/provider-catalog';
import { resolveProvider, toClaudeCodeEnv } from '@/lib/provider-resolver';
import { createModel } from '@/lib/ai-provider';
import { discoverModels } from '@/lib/model-discovery';
import { createTokenDanceFetch, testTokenDanceConnection } from '@/lib/tokendance-fetch';
import { parseTokenDanceModels, TOKENDANCE_APP_URL, TOKENDANCE_RECOVERY_ERRORS } from '@/lib/tokendance';
import { startTokenDanceAuth, completeTokenDanceAuth, cancelTokenDanceAuth, tokenDanceAuthStatus } from '@/lib/tokendance-auth';
import { POST as relay } from '@/app/api/tokendance/gateway/[...path]/route';
import { POST as authRoute } from '@/app/api/tokendance/auth/route';
import { localizeModelSelectionError } from '@/lib/model-selection-error-i18n';
import { translate } from '@/i18n';
import { classifyError } from '@/lib/error-classifier';
import { TOKENDANCE_FEATURED_MODEL_IDS } from '@/lib/tokendance';
import { validateRuntimeRoute } from '@/lib/runtime/route-validation';
import { getModelCompat, getModelCompatTier, getProviderCompat, compatLabel, compatTooltip } from '@/lib/runtime-compat';
import Anthropic from '@anthropic-ai/sdk';
import { getProxyParityEntry } from '@/lib/codex/proxy/provider-parity';

const originalFetch = globalThis.fetch;
const catalog = { data: [
  { id: 'deepseek-v4-flash', supported_protocols: ['openai:chat-completions'] },
  { id: 'claude-fable-5-1', supported_protocols: ['anthropic:messages', 'openai:chat-completions'] },
  { id: 'image-fixture', supported_protocols: ['openai:image-generations'] },
  { id: 'responses-only', supported_protocols: ['openai:responses'] },
] };
const ids: string[] = [];
const flows: string[] = [];
afterEach(() => { globalThis.fetch = originalFetch; flows.splice(0).forEach(cancelTokenDanceAuth); ids.splice(0).forEach(deleteProvider); });
function provider(key = 'tokendance') {
  const preset = getPreset(key)!;
  const p = createProvider({ name: 'TokenDance fixture', preset_key: key, protocol: preset.protocol, provider_type: preset.protocol, base_url: preset.baseUrl, api_key: 'fixture-secret', headers_json: '{"x-app-url":"https://wrong.example"}' });
  ids.push(p.id); return p;
}
async function start(method: 'browser' | 'code' = 'code', target?: string) {
  const flow = await startTokenDanceAuth('tokendance', method, target); flows.push(flow.flowId); return flow;
}

describe('TokenDance catalog and transport', () => {
  it('describes mixed protocols and reports the actual Codex adapter family', () => {
    for (const preset of ['tokendance', 'tokendance-anthropic']) {
      const p = provider(preset);
      const compat = getProviderCompat(p);
      assert.equal(compatLabel(compat, true, p), '多协议 · 按模型支持');
      assert.equal(compatLabel(compat, false, p), 'Multi-protocol · per model');
      const tooltip = compatTooltip(compat, false, p);
      assert.match(tooltip, preset === 'tokendance' ? /Native\/Codex use Chat Completions/ : /uses Messages in Native\/Codex/);
      assert.doesNotMatch(tooltip, /Generic Anthropic|verified/i);
      assert.equal(getProxyParityEntry(p).adapter_family, preset === 'tokendance' ? 'openai_compatible' : 'anthropic_compatible');
      assert.equal(getProxyParityEntry(p).adapter_status, 'ready');
      for (const [modelId, expected] of [['glm-5.3', 'claude_code_experimental'], ['kimi-k3', 'codepilot_only']]) {
        assert.equal(getModelCompatTier({providerBaseUrl: p.base_url, providerCompat: compat, modelId}), expected);
      }
    }
    const other = {...provider(), base_url: 'https://other.example/v1'};
    assert.equal(compatLabel('claude_code_experimental', false, other), 'Claude Code experimental');
    assert.match(compatTooltip('claude_code_experimental', false, other), /Generic Anthropic/);
    assert.equal(compatLabel('media_only', true, provider()), '图片生成');
  });

  it('returns the TokenDance unavailable reason in the saved UI language', async () => {
    const p = provider();
    applyDiscoveryDiff(p.id, [{modelId: 'kimi-k3', upstreamModelId: 'kimi-k3'}], () => true);
    const previous = getSetting('locale');
    try {
      for (const locale of ['en', 'zh'] as const) {
        setSetting('locale', locale);
        const feed = await (await modelFeed(new NextRequest('http://localhost/api/providers/models'))).json();
        const model = feed.groups.find((g: {provider_id: string}) => g.provider_id === p.id).models[0];
        assert.equal(model.unsupportedReasonByRuntime.claude_code, translate(locale, 'provider.tokenDanceMessagesUnavailable'));
        if (locale === 'en') assert.doesNotMatch(model.unsupportedReasonByRuntime.claude_code, /[\u4e00-\u9fff]/);
        else assert.match(model.unsupportedReasonByRuntime.claude_code, /内置 TokenDance 目录/);
      }
    } finally { setSetting('locale', previous || ''); }
  });

  it('discovers TTS declaring Chat Completions but keeps it hidden by default', async () => {
    const p = provider();
    const body = {data: [{id: 'mimo-v2.5-tts', supported_protocols: ['openai:chat-completions']}]};
    assert.deepEqual(parseTokenDanceModels(body, 'anthropic').ids, []);
    globalThis.fetch = async () => Response.json(body);
    const context = {params: Promise.resolve({id: p.id})};
    const probe = await (await probeModels(new NextRequest('http://localhost', {method: 'POST'}), context)).json();
    assert.equal(probe.ok, true);
    assert.equal(probe.diff[0].modelId, 'mimo-v2.5-tts');
    await applyModels(new NextRequest('http://localhost', {method: 'POST', body: JSON.stringify({upstreamModels: probe.diff})}), context);
    const row = getAllModelsForProvider(p.id).find(m => m.model_id === 'mimo-v2.5-tts');
    assert.ok(row);
    assert.equal(row.enabled, 0);
    assert.equal(row.enable_source, 'discovered');
  });

  it('defaults to the six requested models and rejects Kimi K3 only for Claude Code', async () => {
    const p = provider();
    const context = { params: Promise.resolve({ id: p.id }) };
    const names = [...TOKENDANCE_FEATURED_MODEL_IDS, 'minimax-m2.7', 'glm-5'];
    const upstreamModels = names.map(modelId => ({ modelId, upstreamModelId: modelId }));
    // Reproduce the previous all-enabled state, then apply the curated policy.
    applyDiscoveryDiff(p.id, upstreamModels, () => true);
    await applyModels(new NextRequest('http://localhost', { method: 'POST', body: JSON.stringify({ upstreamModels }) }), context);
    assert.deepEqual(getAllModelsForProvider(p.id).filter(m => m.enabled).map(m => m.model_id).sort(), [...TOKENDANCE_FEATURED_MODEL_IDS].sort());
    const feed = await (await modelFeed(new NextRequest('http://localhost/api/providers/models'))).json();
    const models = feed.groups.find((g: {provider_id: string}) => g.provider_id === p.id).models;
    assert.equal(models.length, 6);
    for (const model of models) {
      assert.ok(model.supportedRuntimes.includes('codepilot_runtime'));
      assert.ok(model.supportedRuntimes.includes('codex_runtime'));
      assert.equal(model.supportedRuntimes.includes('claude_code'), model.value !== 'kimi-k3');
    }
    assert.equal((await validateRuntimeRoute({ runtimeId: 'claude_code', providerId: p.id, modelId: 'glm-5.3' })).ok, true);
    assert.equal((await validateRuntimeRoute({ runtimeId: 'claude_code', providerId: p.id, modelId: 'kimi-k3' })).ok, false);
    assert.equal(getProvider(p.id)?.protocol, 'openai-compatible');
    assert.equal(getProvider(p.id)?.api_key, 'fixture-secret');
    assert.deepEqual(getModelCompat({ modelId: 'glm-5.3', providerBaseUrl: p.base_url, providerCompat: 'media_only' }), {media: true});
    for (const providerBaseUrl of ['https://other.example/gateway/v1', 'https://tokendance.space.evil.example/gateway/v1']) {
      assert.equal(getModelCompat({modelId: 'glm-5.3', providerBaseUrl, providerCompat: 'codepilot_only'}).supportedRuntimes?.includes('claude_code'), false);
    }
    assert.equal(getModelCompat({modelId: 'future-model', providerBaseUrl: p.base_url, providerCompat: 'claude_code_experimental'}).supportedRuntimes?.includes('claude_code'), false);
  });

  it('the existing OpenAI connection drives a real Anthropic SDK through the Claude relay using the same key', async () => {
    const p = provider();
    const env = toClaudeCodeEnv({}, resolveProvider({ providerId: p.id, model: 'glm-5.3', runtime: 'claude_code', callScene: 'interactive_chat' }));
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'fixture-secret');
    assert.equal(env.ANTHROPIC_API_KEY, '');
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) {
      assert.equal(env[key], 'glm-5.3');
    }
    const resolved = resolveProvider({ providerId: p.id, model: 'glm-5.3', runtime: 'claude_code', callScene: 'interactive_chat' });
    const mapped = toClaudeCodeEnv({}, {...resolved, roleModels: {...resolved.roleModels, haiku: 'deepseek-v4-flash'}});
    assert.equal(mapped.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-v4-flash');
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://tokendance.space/gateway/v1/messages');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-secret');
      assert.equal(new Headers(init?.headers).get('x-app-url'), TOKENDANCE_APP_URL);
      assert.equal(JSON.parse(Buffer.from(init?.body as ArrayBuffer).toString()).model, 'glm-5.3');
      return Response.json({ id: 'fixture', type: 'message', role: 'assistant', model: 'glm-5.3', content: [{type: 'text', text: 'ok'}], stop_reason: 'end_turn', stop_sequence: null, usage: {input_tokens: 1, output_tokens: 1} });
    };
    const client = new Anthropic({ apiKey: null, authToken: env.ANTHROPIC_AUTH_TOKEN, baseURL: env.ANTHROPIC_BASE_URL,
      fetch: async (url, init) => relay(new Request(url, init), { params: Promise.resolve({path: ['v1', 'messages']}) }),
    });
    const result = await client.messages.create({model: 'glm-5.3', max_tokens: 32, messages: [{role: 'user', content: 'hi'}]});
    assert.equal(result.content[0].type, 'text');
  });
  it('discovery reaches the picker and refresh repairs system-hidden rows without changing user choices', async () => {
    const fixtures = { data: [
      { id: 'glm-5.3', supported_protocols: ['openai:chat-completions', 'anthropic:messages'] },
      { id: 'glm-5.3-flash', supported_protocols: ['openai:chat-completions', 'anthropic:messages'] },
      { id: 'gemini-preview', supported_protocols: ['openai:chat-completions', 'anthropic:messages'] },
      { id: 'image-fixture', supported_protocols: ['openai:image-generations'] },
    ] };
    globalThis.fetch = async () => Response.json(fixtures);
    for (const key of ['tokendance', 'tokendance-anthropic']) {
      const p = provider(key);
      const context = { params: Promise.resolve({ id: p.id }) };
      const probe = await (await probeModels(new NextRequest('http://localhost'), context)).json();
      assert.equal(probe.ok, true);
      const upstreamModels = probe.diff.map((m: { modelId: string; upstreamModelId: string }) => ({ modelId: m.modelId, upstreamModelId: m.upstreamModelId }));
      // Reproduce the previous implementation's state: every discovered row hidden.
      applyDiscoveryDiff(p.id, upstreamModels, () => false);
      assert.equal(getAllModelsForProvider(p.id).filter(m => m.enabled).length, 0);
      updateProviderModelUserFields(p.id, 'glm-5.3-flash', { enabled: 1 });
      updateProviderModelUserFields(p.id, 'glm-5.3-flash', { enabled: 0 });
      const apply = await applyModels(new NextRequest('http://localhost', { method: 'POST', body: JSON.stringify({ upstreamModels }) }), context);
      assert.equal(apply.status, 200);
      const rows = getAllModelsForProvider(p.id);
      assert.equal(rows.find(m => m.model_id === 'glm-5.3')?.enabled, 1);
      assert.equal(rows.find(m => m.model_id === 'gemini-preview')?.enabled, 0);
      assert.equal(rows.find(m => m.model_id === 'glm-5.3-flash')?.enable_source, 'manual_hidden');
      assert.equal(rows.find(m => m.model_id === 'glm-5.3-flash')?.enabled, 0);
      assert.equal(rows.some(m => m.model_id === 'image-fixture'), false);
      const response = await modelFeed(new NextRequest('http://localhost/api/providers/models'));
      assert.equal(response.status, 200);
      const group = (await response.json()).groups.find((g: { provider_id: string }) => g.provider_id === p.id);
      assert.ok(group, 'provider must survive the empty-group filter');
      const model = group.models.find((m: { value: string }) => m.value === 'glm-5.3');
      assert.ok(model);
      assert.ok(model.supportedRuntimes.includes('codepilot_runtime'));
      assert.ok(model.supportedRuntimes.includes('codex_runtime'));
      assert.equal(model.supportedRuntimes.includes('claude_code'), true);
      assert.equal(group.models.some((m: { value: string }) => m.value === 'glm-5.3-flash'), false);
    }
  });
  it('filters by declared protocol and fails on schema drift instead of emptying the list', async () => {
    assert.deepEqual(parseTokenDanceModels(catalog, 'anthropic').ids, ['claude-fable-5-1']);
    assert.deepEqual(parseTokenDanceModels(catalog, 'openai-compatible').ids, ['deepseek-v4-flash', 'claude-fable-5-1']);
    assert.throws(() => parseTokenDanceModels({ data: [{ id: 'unknown' }] }, 'anthropic'));
    globalThis.fetch = async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      return Response.json(catalog);
    };
    const result = await discoverModels({ protocol: 'anthropic', presetKey: 'tokendance-anthropic', baseUrl: 'https://tokendance.space/gateway' });
    assert.equal(result.ok, true); assert.deepEqual(result.fullModelIds, ['claude-fable-5-1']);
    for (const key of ['tokendance', 'tokendance-anthropic']) {
      const p = provider(key); assert.equal(resolveProviderPresetIdentity(p).status, 'resolved');
      assert.deepEqual(getPreset(key)!.defaultModels, []);
    }
  });

  it('pins attribution, preserves caller headers, denies endpoint leakage before I/O', async () => {
    const headers = new Headers({ 'X-App-URL': 'wrong', Authorization: 'Bearer fixture' });
    let calls = 0;
    const wrapped = createTokenDanceFetch(async (_input, init) => {
      calls++; assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('x-app-url'), TOKENDANCE_APP_URL);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture');
      return Response.json({ ok: true });
    });
    await wrapped(new Request('https://tokendance.space/gateway/v1/messages', { headers }));
    assert.equal(headers.get('x-app-url'), 'wrong');
    for (const url of ['https://tokendance.space.evil/gateway/v1/messages', 'http://tokendance.space/gateway/v1/messages', 'https://tokendance.space/portal/api/v1/auth/keys']) {
      await assert.rejects(wrapped(url, { headers }));
    }
    assert.equal(calls, 1);
  });

  it('normalizes only known recovery actions on failure and localizes persisted errors', async () => {
    for (const [action, message] of Object.entries(TOKENDANCE_RECOVERY_ERRORS)) {
      const wrapped = createTokenDanceFetch(async () => Response.json({ error: { message: 'upstream' } }, { status: 403, headers: { 'TokenDance-Recovery-Action': action } }));
      const result = await wrapped('https://tokendance.space/gateway/v1/messages');
      assert.equal(result.status, 403); assert.equal((await result.json()).error.message, message);
      assert.doesNotMatch(localizeModelSelectionError(message, key => translate('zh', key)), /\[TOKENDANCE_/);
      const classified = classifyError({ error: new Error(`SDK HTTP 403: ${message}`), baseUrl: 'https://tokendance.space/gateway' });
      assert.equal(classified.userMessage, message);
      assert.equal(classified.retryable, false);
    }
    for (const status of [200, 429]) {
      const wrapped = createTokenDanceFetch(async () => new Response('original', { status, headers: { 'TokenDance-Recovery-Action': status === 200 ? 'top_up_balance' : 'future_action' } }));
      assert.equal(await (await wrapped('https://tokendance.space/gateway/v1/messages')).text(), 'original');
    }
  });

  it('real Native and Codex SDK factories send selected models, key and attribution', async () => {
    for (const runtime of ['codepilot_runtime', 'codex_runtime'] as const) {
      const p = provider(); let captured = false;
      globalThis.fetch = async (url, init) => {
        captured = true; assert.equal(String(url), 'https://tokendance.space/gateway/v1/chat/completions');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-secret');
        assert.equal(new Headers(init?.headers).get('x-app-url'), TOKENDANCE_APP_URL);
        assert.equal(JSON.parse(String(init?.body)).model, 'deepseek-v4-flash');
        return Response.json({ id: 'fixture', object: 'chat.completion', created: 1, model: 'deepseek-v4-flash', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      };
      const { languageModel } = createModel({ callScene: 'interactive_chat', providerId: p.id, model: 'deepseek-v4-flash', runtime });
      const result = await generateText({ model: languageModel, prompt: 'hi', maxRetries: 0 });
      assert.equal(result.text, 'ok'); assert.equal(captured, true);
    }
  });

  it('Anthropic native SDK and Claude subprocess relay preserve recovery and exact target', async () => {
    const p = provider('tokendance-anthropic');
    const resolved = resolveProvider({ providerId: p.id, model: 'claude-fable-5-1', callScene: 'interactive_chat' });
    const env = toClaudeCodeEnv({}, resolved);
    assert.match(env.ANTHROPIC_BASE_URL!, /^http:\/\/127\.0\.0\.1:\d+\/api\/tokendance\/gateway$/);
    let count = 0;
    globalThis.fetch = async (url, init) => {
      count++; assert.match(String(url), /^https:\/\/tokendance.space\/gateway\/v1\/messages/);
      assert.equal(new Headers(init?.headers).get('x-app-url'), TOKENDANCE_APP_URL);
      return Response.json({ error: { message: 'balance' } }, { status: 402, headers: { 'TokenDance-Recovery-Action': 'top_up_balance' } });
    };
    const { languageModel } = createModel({ callScene: 'interactive_chat', providerId: p.id, model: 'claude-fable-5-1' });
    await assert.rejects(generateText({ model: languageModel, prompt: 'hi', maxRetries: 0 }), /TOKENDANCE_TOP_UP/);
    const result = await relay(new Request('http://127.0.0.1/api/tokendance/gateway/v1/messages?beta=true', { method: 'POST', headers: { 'x-api-key': 'fixture', 'X-App-URL': 'wrong' }, body: '{"model":"claude-fable-5-1"}' }), { params: Promise.resolve({ path: ['v1', 'messages'] }) });
    assert.equal(result.status, 402); assert.match(await result.text(), /TOKENDANCE_TOP_UP/); assert.equal(count, 2);
    assert.equal((await relay(new Request('http://localhost', { method: 'POST' }), { params: Promise.resolve({ path: ['portal'] }) })).status, 404);
  });

  it('connection test never treats a public catalog as authenticated success', async () => {
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      if (String(url).endsWith('/models')) return Response.json(catalog);
      assert.equal(new Headers(init?.headers).get('x-app-url'), TOKENDANCE_APP_URL);
      assert.equal(JSON.parse(String(init?.body)).model, 'deepseek-v4-flash');
      return Response.json({}, { status: 401 });
    };
    assert.equal((await testTokenDanceConnection({ apiKey: 'invalid-fixture', protocol: 'openai-compatible' })).success, false);
    assert.equal(calls, 2);
  });

  it('production Codex proxy carries TokenDance recovery through the Responses stream', async () => {
    const p = provider(); let captured = false;
    globalThis.fetch = async (url, init) => {
      captured = true;
      assert.equal(String(url), 'https://tokendance.space/gateway/v1/chat/completions');
      assert.equal(new Headers(init?.headers).get('x-app-url'), TOKENDANCE_APP_URL);
      return Response.json({ error: { message: 'expired' } }, { status: 401, headers: { 'TokenDance-Recovery-Action': 'reauthorize_api_key' } });
    };
    const { handleProxyRequest } = await import('@/lib/codex/proxy/adapter');
    const result = await handleProxyRequest({
      targetProviderId: p.id, sessionId: '', workspacePath: process.env.CLAUDE_GUI_DATA_DIR!, signal: new AbortController().signal,
      body: { model: 'deepseek-v4-flash', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], stream: true },
    });
    assert.equal(result.kind, 'stream');
    if (result.kind === 'stream') {
      const body = await new Response(result.body).text();
      assert.match(body, /response.failed/); assert.match(body, /TOKENDANCE_REAUTHORIZE/);
    }
    assert.equal(captured, true);
  });

  it('Claude relay streams successful bytes unchanged and does not forward caller attribution', async () => {
    const wire = 'event: message_start\ndata: {"id":"fixture"}\n\nevent: message_stop\ndata: {}\n\n';
    globalThis.fetch = async (_url, init) => {
      assert.equal(init?.body instanceof ArrayBuffer, true);
      assert.equal(new Headers(init?.headers).get('x-app-url'), TOKENDANCE_APP_URL);
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
    };
    const result = await relay(new Request('http://localhost/api/tokendance/gateway/v1/messages', {
      method: 'POST', body: '{}', headers: { 'x-api-key': 'fixture', 'X-App-URL': 'wrong' },
    }), { params: Promise.resolve({ path: ['v1', 'messages'] }) });
    assert.equal(result.status, 200); assert.equal(await result.text(), wire);
  });
});

describe('TokenDance API key authorization', () => {
  it('exchanges S256 once and stores an encrypted key without exposing it in status', async () => {
    const flow = await start(); const url = new URL(flow.url);
    assert.equal(url.searchParams.get('app_url'), TOKENDANCE_APP_URL);
    assert.equal(url.searchParams.get('key_name'), 'Codepilot'); assert.equal(url.searchParams.has('callback_url'), false);
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      calls++; assert.equal(String(input), 'https://tokendance.space/portal/api/v1/auth/keys');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.code_challenge_method, 'S256'); assert.equal(body.code, 'one-time');
      assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), url.searchParams.get('code_challenge'));
      assert.equal(init?.redirect, 'error');
      return Response.json({ key: 'oauth-fixture-secret' });
    };
    await completeTokenDanceAuth(flow.flowId, 'one-time');
    const status = tokenDanceAuthStatus(flow.flowId); assert.equal(status.status, 'complete');
    ids.push(status.providerId!); assert.equal(getProvider(status.providerId!)?.api_key, 'oauth-fixture-secret');
    const row = getDb().prepare('SELECT api_key, api_key_ciphertext FROM api_providers WHERE id=?').get(status.providerId) as { api_key: string; api_key_ciphertext: string };
    assert.equal(row.api_key, ''); assert.ok(row.api_key_ciphertext); assert.doesNotMatch(JSON.stringify(status), /secret|verifier|one-time/);
    await assert.rejects(completeTokenDanceAuth(flow.flowId, 'one-time')); assert.equal(calls, 1);
  });

  it('reauthorizes in place and rejects late results after cancellation or provider changes', async () => {
    const p = provider(); const count = getAllProviders().length;
    let flow = await start('code', p.id);
    globalThis.fetch = async () => Response.json({ key: 'replacement-key' });
    await completeTokenDanceAuth(flow.flowId, 'code');
    assert.equal(tokenDanceAuthStatus(flow.flowId).providerId, p.id);
    assert.equal(getAllProviders().length, count); assert.equal(getProvider(p.id)?.api_key, 'replacement-key');
    flow = await start('code', p.id);
    let release!: (response: Response) => void;
    globalThis.fetch = () => new Promise(resolve => { release = resolve; });
    const completing = completeTokenDanceAuth(flow.flowId, 'late');
    cancelTokenDanceAuth(flow.flowId); release(Response.json({ key: 'must-not-save' })); await completing;
    assert.equal(getProvider(p.id)?.api_key, 'replacement-key'); assert.equal(tokenDanceAuthStatus(flow.flowId).status, 'cancelled');
    flow = await start('code', p.id); deleteProvider(p.id);
    globalThis.fetch = async () => Response.json({ key: 'deleted-target' });
    await completeTokenDanceAuth(flow.flowId, 'late'); assert.equal(tokenDanceAuthStatus(flow.flowId).status, 'failed');
    assert.equal(getProvider(p.id), undefined);
  });

  it('binds loopback and validates callback state before exchanging', async () => {
    const flow = await start('browser'); const url = new URL(flow.url);
    const callback = new URL(url.searchParams.get('callback_url')!);
    assert.equal(callback.hostname, '127.0.0.1'); assert.ok(Number(callback.port) > 0);
    callback.searchParams.set('code', 'one-time');
    const invalid = new URL(callback); invalid.searchParams.set('state', 'wrong');
    assert.equal((await originalFetch(invalid)).status, 400);
    assert.equal(tokenDanceAuthStatus(flow.flowId).status, 'pending');
    globalThis.fetch = async () => Response.json({ key: 'callback-fixture' });
    assert.equal((await originalFetch(callback)).status, 200);
    for (let i = 0; i < 30 && tokenDanceAuthStatus(flow.flowId).status !== 'complete'; i++) await new Promise(r => setTimeout(r, 10));
    const status = tokenDanceAuthStatus(flow.flowId); assert.equal(status.status, 'complete'); ids.push(status.providerId!);
  });

  it('does not retry or leak exchange errors and rejects cross-origin starts', async () => {
    const flow = await start(); let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ error: 'secret-must-not-escape' }, { status: 503 }); };
    await completeTokenDanceAuth(flow.flowId, 'secret-code');
    assert.deepEqual(tokenDanceAuthStatus(flow.flowId).status, 'failed'); assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(tokenDanceAuthStatus(flow.flowId)), /secret/);
    const response = await authRoute(new Request('http://localhost/api/tokendance/auth', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }));
    assert.equal(response.status, 403);
  });
});
