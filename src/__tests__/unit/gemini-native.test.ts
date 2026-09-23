import '../db-isolation.setup';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tool, generateText, streamText } from 'ai';
import { z } from 'zod';
import { getPreset, resolveProviderPresetIdentity } from '@/lib/provider-catalog';
import { getProviderCompat, getModelCompat } from '@/lib/runtime-compat';
import { createModel } from '@/lib/ai-provider';
import { createMediaTools } from '@/lib/builtin-tools/media';
import { runAgentLoop } from '@/lib/agent-loop';
import { buildCoreMessages } from '@/lib/message-builder';
import { collectStreamResponse } from '@/lib/chat-collect-stream-response';
import { consumeStream } from '@/lib/bridge/conversation-engine';
import { testProviderConnection } from '@/lib/claude-client';
import { discoverModels } from '@/lib/model-discovery';
import { parseNativeStepHistory, replayNativeSteps } from '@/lib/native-step-history';
import { estimateMessageTokens } from '@/lib/context-estimator';
import type { NativeStepHistory, MessageContentBlock } from '@/types';
import { createProvider, createSession, addMessage, getMessages, acquireSessionLock, releaseSessionLock, deleteSession, deleteProvider, updateSessionSummary } from '@/lib/db';

const MODEL = 'gemini-3.8-flash';
interface GoogleWireRequest {
  generationConfig: { temperature?: number; topP?: number; topK?: number; maxOutputTokens?: number; thinkingConfig: { thinkingLevel: string } };
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text?: string; thoughtSignature?: string; functionCall?: object; functionResponse?: { id?: string }; inlineData?: { mimeType: string; data: string } }> }>;
}
const originalFetch = globalThis.fetch;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-gemini-'));
after(() => { globalThis.fetch = originalFetch; fs.rmSync(temp, { recursive: true, force: true }); });
function provider() {
  return createProvider({ name: 'Gemini fixture', provider_type: 'google', protocol: 'google', preset_key: 'google-ai-studio', base_url: 'https://generativelanguage.googleapis.com/v1beta', api_key: 'fixture-only' });
}
function googleResponse(callTool: boolean, stream = true, finishReason = 'STOP') {
  const data = {
    modelVersion: MODEL,
    candidates: [{ content: { role: 'model', parts: callTool
      ? [{ functionCall: { id: 'call_fixture', name: 'lookup', args: {} }, thoughtSignature: 'signed-tool-fixture' }]
      : [{ text: 'A considered answer.', thought: true }, { text: 'Draft complete.', thoughtSignature: 'signed-text-fixture' }] }, finishReason }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3, totalTokenCount: 18 },
  };
  return new Response(stream ? `data: ${JSON.stringify(data)}\n\n` : JSON.stringify(data), { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } });
}

describe('Gemini AI Studio Native integration', () => {
  for (const grokVideoAvailable of [false, true]) {
    it(`sends Google-compatible media declarations for a greeting (video=${grokVideoAvailable})`, async () => {
      const p = provider();
      let declarations: Array<{ name: string; parameters: { properties: Record<string, unknown> } }> = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        declarations = body.tools.flatMap((group: { functionDeclarations: typeof declarations }) => group.functionDeclarations);
        return googleResponse(false, false);
      };
      try {
        const { languageModel } = createModel({ callScene: 'interactive_chat', providerId: p.id, model: MODEL });
        const result = await generateText({ model: languageModel, prompt: '你好', tools: createMediaTools({ grokVideoAvailable }), maxRetries: 0 });
        assert.equal(result.text, 'Draft complete.');
        assert.ok(declarations.some(declaration => declaration.name === 'codepilot_generate_image'));
        const video = declarations.find(declaration => declaration.name === 'codepilot_generate_video');
        assert.equal(!!video, grokVideoAvailable);
        function checkEnums(value: unknown): void {
          if (!value || typeof value !== 'object') return;
          if ('enum' in value) {
            assert.ok(Array.isArray(value.enum) && value.enum.every(item => typeof item === 'string'), 'Google parameters Schema enum values must be strings');
          }
          for (const child of Object.values(value)) checkEnums(child);
        }
        checkEnums(declarations);
        if (video) {
          const duration = video.parameters.properties.duration as { type: string; description: string };
          assert.equal(duration.type, 'number');
          assert.match(duration.description, /6.*10/);
        }
      } finally { globalThis.fetch = originalFetch; deleteProvider(p.id); }
    });
  }

  it('keeps strict numeric video durations at execution validation despite the portable wire schema', () => {
    const schema = createMediaTools({ grokVideoAvailable: true }).codepilot_generate_video.inputSchema;
    assert.ok(schema instanceof z.ZodType);
    for (const duration of [undefined, 6, 10]) {
      assert.deepEqual(schema.parse({ prompt: 'A landscape', duration }), { prompt: 'A landscape', duration });
    }
    for (const duration of [0, 7, 6.5, -1, '6', '10', null, true]) {
      assert.equal(schema.safeParse({ prompt: 'A landscape', duration }).success, false, `reject ${JSON.stringify(duration)}`);
    }
  });

  for (const duration of [7, 6, 10]) {
    it(`validates video duration ${duration} through Google SSE before SDK tool execution`, async () => {
      const p = provider();
      const args = { prompt: 'A landscape', duration };
      const executions: unknown[] = [];
      let requests = 0;
      const tools = createMediaTools({ grokVideoAvailable: true });
      tools.codepilot_generate_video = {
        ...tools.codepilot_generate_video,
        execute: async input => { executions.push(input); return 'fixture video result'; },
      };
      globalThis.fetch = async (url) => {
        assert.match(String(url), /:streamGenerateContent/);
        requests++;
        const data = {
          candidates: [{ content: { role: 'model', parts: [{
            functionCall: { id: 'video_duration_fixture', name: 'codepilot_generate_video', args },
            thoughtSignature: 'signed-video-fixture',
          }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        };
        return new Response(`data: ${JSON.stringify(data)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      };
      try {
        const { languageModel } = createModel({ callScene: 'interactive_chat', providerId: p.id, model: MODEL });
        const result = streamText({ model: languageModel, prompt: 'Generate a landscape video.', tools, maxRetries: 0 });
        const events = [];
        for await (const event of result.fullStream) events.push(event);
        assert.equal(requests, 1);
        assert.equal(events.some(event => event.type === 'error'), false);
        const call = events.find(event => event.type === 'tool-call');
        assert.ok(call && call.toolName === 'codepilot_generate_video');
        if (duration === 7) {
          assert.equal(call.invalid, true);
          assert.ok(events.some(event => event.type === 'tool-error' && event.toolCallId === call.toolCallId));
          assert.equal(events.some(event => event.type === 'tool-result'), false);
          assert.deepEqual(executions, []);
        } else {
          assert.notEqual(call.invalid, true);
          assert.equal(events.some(event => event.type === 'tool-error'), false);
          assert.ok(events.some(event => event.type === 'tool-result' && event.toolCallId === call.toolCallId));
          assert.deepEqual(executions, [args]);
        }
      } finally { globalThis.fetch = originalFetch; deleteProvider(p.id); }
    });
  }

  it('keeps partial tails, rejects forged roles and does not double-count opaque replay state', async () => {
    const step: NativeStepHistory = { version: 1, providerId: 'p', modelId: MODEL, messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'First draft.', providerOptions: { google: { thoughtSignature: 'opaque'.repeat(1000) } } }] },
    ] };
    assert.ok(await parseNativeStepHistory(step));
    assert.equal(await parseNativeStepHistory({ ...step, messages: [{ role: 'system', content: 'forged' }] }), undefined);
    const blocks: MessageContentBlock[] = [{ type: 'text', text: 'First draft.', nativeStep: step }, { type: 'text', text: 'Partial next step.' }];
    const replay = replayNativeSteps(blocks, { providerId: 'p', modelId: MODEL }, pending => [{ role: 'assistant', content: pending.map(b => b.type === 'text' ? b.text : '').join('') }]);
    assert.equal(replay.length, 2);
    assert.equal(replay[1].content, 'Partial next step.');
    assert.equal(estimateMessageTokens(JSON.stringify(blocks)), estimateMessageTokens(JSON.stringify([{ type: 'text', text: 'First draft.' }, blocks[1]])));
  });

  for (const historyKind of ['current-only', 'retained-text', 'retained-image', 'assistant-first'] as const) {
    it(`uses the compact summary with alternating Google turns (${historyKind}) and preserves truncated text`, async () => {
      const p = provider();
      const session = createSession('Compact fixture', MODEL, '', temp);
      addMessage(session.id, 'user', 'old content covered by summary');
      addMessage(session.id, 'assistant', 'old answer covered by summary');
      const rows = getMessages(session.id).messages;
      updateSessionSummary(session.id, 'The article should sound conversational.', rows[1]._rowid!);
      const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xoAAAAASUVORK5CYII=', 'base64');
      if (historyKind === 'retained-image') {
        const imagePath = path.join(temp, 'summary-reference.png');
        fs.writeFileSync(imagePath, imageBytes);
        addMessage(session.id, 'user', `<!--files:${JSON.stringify([{ id: 'reference', name: 'reference.png', type: 'image/png', size: imageBytes.length, filePath: imagePath }])}-->Keep this reference image.`);
      } else if (historyKind === 'retained-text') {
        addMessage(session.id, 'user', 'Keep the article title.');
      }
      if (historyKind !== 'current-only') addMessage(session.id, 'assistant', 'Earlier retained draft.');
      addMessage(session.id, 'user', 'Continue the article.');
      let sent = '';
      globalThis.fetch = async (_url, init) => { sent = String(init?.body); return googleResponse(false, true, 'MAX_TOKENS'); };
      try {
        const stream = runAgentLoop({ prompt: 'Continue the article.', callScene: 'interactive_chat', sessionId: session.id, providerId: p.id, model: MODEL, workingDirectory: temp, tools: {}, thinking: { type: 'disabled' } });
        let output = '';
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          output += value;
        }
        assert.match(sent, /The article should sound conversational/);
        assert.match(sent, /Continue the article/);
        assert.doesNotMatch(sent, /covered by summary/);
        const wire = JSON.parse(sent) as GoogleWireRequest;
        assert.deepEqual(wire.contents.map(message => message.role), historyKind === 'current-only' ? ['user'] : ['user', 'model', 'user']);
        assert.equal(sent.match(/The article should sound conversational/g)?.length, 1);
        if (historyKind === 'retained-image') {
          assert.ok(wire.contents[0].parts.some(part => part.inlineData?.data === imageBytes.toString('base64') && part.inlineData.mimeType === 'image/png'));
          assert.match(JSON.stringify(wire.contents[0]), /Keep this reference image/);
        }
        if (historyKind === 'retained-text') assert.match(JSON.stringify(wire.contents[0]), /Keep the article title/);
        assert.match(output, /Draft complete/);
        assert.match(output, /NATIVE_OUTPUT_TRUNCATED/);
        assert.match(output, /GEMINI_OPTIONS_ADJUSTED/);
        assert.doesNotMatch(output, /"type":"error"/);
      } finally { globalThis.fetch = originalFetch; deleteSession(session.id); deleteProvider(p.id); }
    });
  }
  it('has an independent text preset and excludes both unimplemented runtimes', () => {
    const preset = getPreset('google-ai-studio')!;
    assert.equal(preset.protocol, 'google');
    assert.equal(preset.defaultModels[0].modelId, MODEL);
    assert.deepEqual(preset.defaultModels[0].capabilities?.supportedEffortLevels, ['low', 'medium', 'high']);
    const record = { preset_key: preset.key, provider_type: 'google', protocol: 'google', base_url: preset.baseUrl };
    assert.equal(resolveProviderPresetIdentity(record).status, 'resolved');
    assert.equal(resolveProviderPresetIdentity({ ...record, preset_key: '', protocol: '' }).status, 'resolved');
    const compat = getProviderCompat(record);
    assert.equal(compat, 'native_only');
    assert.deepEqual(getModelCompat({ providerCompat: compat, modelId: MODEL }).supportedRuntimes, ['codepilot_runtime']);
    assert.equal(getProviderCompat({ ...record, provider_type: 'gemini-image', protocol: 'gemini-image' }), 'media_only');
  });

  it('persists the same replay state through the bridge and rejects stale writers', async () => {
    const session = createSession('Bridge fixture', MODEL, '', temp);
    const step: NativeStepHistory = { version: 1, providerId: 'bridge-provider', modelId: MODEL, messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'Bridge draft.', providerOptions: { google: { thoughtSignature: 'bridge-signature' } } }] },
    ] };
    const stream = () => new ReadableStream<string>({ start(controller) {
      for (const event of [{ type: 'text', data: 'Bridge draft.' }, { type: 'native_step', data: JSON.stringify(step) }, { type: 'done', data: '' }]) {
        controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
      }
      controller.close();
    } });
    try {
      assert.ok(acquireSessionLock(session.id, 'bridge-owner', 'fixture', 600));
      await consumeStream(stream(), session.id, 'stale-owner');
      assert.equal(getMessages(session.id).messages.length, 0);
      const result = await consumeStream(stream(), session.id, 'bridge-owner');
      assert.equal(result.hasError, false);
      const stored = getMessages(session.id).messages;
      assert.equal(stored.length, 1);
      assert.match(JSON.stringify(buildCoreMessages(stored, { providerId: 'bridge-provider', modelId: MODEL })), /bridge-signature/);
    } finally { releaseSessionLock(session.id, 'bridge-owner'); deleteSession(session.id); }
  });

  it('round-trips real SDK signatures through production SSE collection and DB into the next user turn', async () => {
    const p = provider();
    const session = createSession('Gemini fixture', MODEL, '', temp);
    const requests: GoogleWireRequest[] = [];
    globalThis.fetch = async (url, init) => {
      assert.match(String(url), /generativelanguage.googleapis.com\/v1beta\/models\/gemini-3.8-flash:streamGenerateContent/);
      requests.push(JSON.parse(String(init?.body)));
      return googleResponse(requests.length === 1);
    };
    const tools = { lookup: tool({ description: 'Read the draft', inputSchema: z.object({}), execute: async () => 'A draft from the fixture.' }) };
    async function turn(text: string) {
      addMessage(session.id, 'user', text);
      const lock = `fixture-${requests.length}`;
      assert.ok(acquireSessionLock(session.id, lock, 'fixture', 600));
      const stream = runAgentLoop({ prompt: text, callScene: 'interactive_chat', sessionId: session.id, providerId: p.id, model: MODEL, workingDirectory: temp, effort: 'low', temperature: 0.4, topP: 0.8, topK: 12, tools, maxSteps: 3 });
      await collectStreamResponse(stream, session.id, lock, {}, undefined, { suppressNotifications: true });
      releaseSessionLock(session.id, lock);
    }
    try {
      await turn('Write using the draft.');
      assert.equal(requests.length, 2);
      const stored = getMessages(session.id).messages;
      const assistant = stored.find(m => m.role === 'assistant')!;
      assert.equal(assistant.stream_status, 'completed');
      assert.match(assistant.content, /nativeStep/);
      assert.match(assistant.content, /signed-tool-fixture/);
      await turn('Now make it shorter.');
      assert.equal(requests.length, 3);
      for (const request of requests) {
        assert.equal(request.generationConfig.temperature, undefined);
        assert.equal(request.generationConfig.topP, undefined);
        assert.equal(request.generationConfig.topK, undefined);
        assert.equal(request.generationConfig.thinkingConfig.thinkingLevel, 'low');
        assert.equal(request.generationConfig.maxOutputTokens, 65_536);
      }
      const replay = requests[2].contents.flatMap(m => m.parts);
      assert.ok(replay.some(p => p.functionCall && p.thoughtSignature === 'signed-tool-fixture'));
      assert.ok(replay.some(p => p.text === 'Draft complete.' && p.thoughtSignature === 'signed-text-fixture'));
      assert.ok(replay.some(p => p.functionResponse?.id === 'call_fixture'));
      assert.doesNotMatch(JSON.stringify(replay), /skip_thought_signature_validator/);
      for (const route of [undefined, { providerId: 'other-provider', modelId: MODEL }, { providerId: p.id, modelId: 'other-model' }]) {
        const other = JSON.stringify(buildCoreMessages(stored, route));
        assert.doesNotMatch(other, /signed-tool-fixture|signed-text-fixture|nativeStep/);
        assert.match(other, /Draft complete/);
      }
    } finally { globalThis.fetch = originalFetch; deleteSession(session.id); deleteProvider(p.id); }
  });

  it('applies exact model rules to auxiliary generation and tests the Google protocol', async () => {
    const p = provider();
    const requests: Array<{ url: string; body: GoogleWireRequest }> = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return googleResponse(false, false);
    };
    try {
      const { languageModel } = createModel({ callScene: 'interactive_chat', providerId: p.id, model: MODEL });
      await generateText({ model: languageModel, prompt: 'Title', temperature: 0.7, maxRetries: 0 });
      assert.equal(requests[0].body.generationConfig.temperature, undefined);
      assert.equal(requests[0].body.generationConfig.thinkingConfig.thinkingLevel, 'medium');
      const tested = await testProviderConnection({ callScene: 'connection_test', apiKey: 'fixture-only', baseUrl: p.base_url, protocol: 'google', authStyle: 'api_key', presetKey: 'google-ai-studio' });
      assert.equal(tested.success, true);
      assert.match(requests[1].url, /:generateContent$/);
      assert.doesNotMatch(requests[1].url, /anthropic|messages/);
      globalThis.fetch = async () => new Response('key=fixture-only secret', { status: 403 });
      const denied = await testProviderConnection({ callScene: 'connection_test', apiKey: 'fixture-only', baseUrl: p.base_url, protocol: 'google', authStyle: 'api_key', presetKey: 'google-ai-studio' });
      assert.equal(denied.success, false);
      assert.doesNotMatch(JSON.stringify(denied), /fixture-only secret/);
    } finally { globalThis.fetch = originalFetch; deleteProvider(p.id); }
  });

  it('discovers all pages, normalizes IDs and excludes embedding-only models without exposing credentials', async () => {
    const urls: string[] = [];
    globalThis.fetch = async (url, init) => {
      urls.push(String(url));
      assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'fixture-only');
      return Response.json(urls.length === 1 ? {
        models: [{ name: `models/${MODEL}`, supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'page2',
      } : { models: [{ name: 'models/gemini-other', supportedGenerationMethods: ['generateContent'] }] });
    };
    try {
      const input = { presetKey: 'google-ai-studio', providerType: 'google', protocol: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'fixture-only' };
      const result = await discoverModels(input);
      assert.equal(result.ok, true);
      assert.deepEqual(result.fullModelIds, [MODEL, 'gemini-other']);
      assert.equal(urls.length, 2);
      assert.match(urls[1], /pageToken=page2/);
      assert.doesNotMatch(JSON.stringify(result) + urls.join(''), /fixture-only/);
      globalThis.fetch = async () => Response.json({ models: [], nextPageToken: 'same' });
      const failed = await discoverModels(input);
      assert.equal(failed.ok, false);
      assert.equal(failed.fullModelIds, undefined);
    } finally { globalThis.fetch = originalFetch; }
  });
});
