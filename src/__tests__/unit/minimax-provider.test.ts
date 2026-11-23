import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { ClaudeCodeCompatModel } from '../../lib/claude-code-compat';

const MODEL_ID = 'MiniMax-M3';
const API_KEY = 'test-key-not-real';

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function anthropicResponse(): Response {
  return new Response(JSON.stringify({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: MODEL_ID,
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function openAiResponse(): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl_test',
    object: 'chat.completion',
    created: 0,
    model: MODEL_ID,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('MiniMax endpoint request capture', () => {
  it('routes regional Anthropic bases to /anthropic/v1/messages', async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(requestUrl(input));
      return anthropicResponse();
    }) as typeof fetch;

    try {
      for (const baseUrl of [
        'https://api.minimaxi.com/anthropic',
        'https://api.minimax.io/anthropic',
      ]) {
        const model = new ClaudeCodeCompatModel({
          baseUrl,
          modelId: MODEL_ID,
          authToken: API_KEY,
        });
        await generateText({ model, prompt: 'ping' });
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(urls, [
      'https://api.minimaxi.com/anthropic/v1/messages',
      'https://api.minimax.io/anthropic/v1/messages',
    ]);
  });

  it('routes regional OpenAI bases to /v1/chat/completions', async () => {
    const urls: string[] = [];
    const captureFetch = (async (input: RequestInfo | URL) => {
      urls.push(requestUrl(input));
      return openAiResponse();
    }) as typeof fetch;

    for (const baseURL of [
      'https://api.minimaxi.com/v1',
      'https://api.minimax.io/v1',
    ]) {
      const openai = createOpenAI({ apiKey: API_KEY, baseURL, fetch: captureFetch });
      await generateText({ model: openai.chat(MODEL_ID), prompt: 'ping' });
    }

    assert.deepEqual(urls, [
      'https://api.minimaxi.com/v1/chat/completions',
      'https://api.minimax.io/v1/chat/completions',
    ]);
  });
});
