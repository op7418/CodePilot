import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import { getContextWindow } from '../../lib/model-context';

const originalDataDir = process.env.CLAUDE_GUI_DATA_DIR;
const originalFetch = globalThis.fetch;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-oauth-compat-'));
process.env.CLAUDE_GUI_DATA_DIR = temp;
/* eslint-disable @typescript-eslint/no-require-imports */
const db = require('../../lib/db') as typeof import('../../lib/db');
const manager = require('../../lib/openai-oauth-manager') as typeof import('../../lib/openai-oauth-manager');
const catalog = require('../../lib/openai-oauth-models') as typeof import('../../lib/openai-oauth-models');
/* eslint-enable @typescript-eslint/no-require-imports */
const jwt = (data: unknown) => `h.${Buffer.from(JSON.stringify(data)).toString('base64url')}.s`;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const tokens = () => ({ access_token: jwt({chatgpt_account_id:'new-account'}), id_token: jwt({}), refresh_token: 'rotated', expires_in: 3600 });
function seed(fresh = false) {
  db.setSetting('openai_oauth_access_token', 'fake-access');
  db.setSetting('openai_oauth_refresh_token', 'fake-refresh');
  db.setSetting('openai_oauth_expires_at', String(fresh ? Date.now() + 3600000 : 1));
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
beforeEach(() => { globalThis.fetch = originalFetch; manager.clearOAuthTokens(); });
after(() => {
  globalThis.fetch = originalFetch;
  db.closeDb();
  if (originalDataDir === undefined) delete process.env.CLAUDE_GUI_DATA_DIR;
  else process.env.CLAUDE_GUI_DATA_DIR = originalDataDir;
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('OpenAI OAuth lifecycle regressions', () => {
  it('shares concurrent refresh and atomically saves rotated token/account fallback', async () => {
    seed(); let calls = 0; const gate = deferred<Response>();
    globalThis.fetch = async () => { calls++; return gate.promise; };
    const a = manager.ensureTokenFresh(); const b = manager.ensureTokenFresh();
    assert.equal(calls, 1); gate.resolve(json(tokens()));
    const [first, second] = await Promise.all([a,b]);
    assert.deepEqual(first, second); assert.equal(first?.accountId, 'new-account');
    assert.equal(db.getSetting('openai_oauth_refresh_token'), 'rotated');
  });
  for (const status of [429, 500, 503]) it(`preserves login on transient ${status}`, async () => {
    seed(); globalThis.fetch = async () => json({ error: 'temporarily_unavailable' }, status);
    await assert.rejects(manager.ensureTokenFresh(), /temporarily failed/);
    assert.equal(db.getSetting('openai_oauth_refresh_token'), 'fake-refresh');
    assert.equal(manager.getOAuthStatus().authenticated, true);
  });
  it('preserves credentials after network failure and allows retry', async () => {
    seed(); globalThis.fetch = async () => { throw new TypeError('offline'); };
    await assert.rejects(manager.ensureTokenFresh(), /temporarily failed/);
    globalThis.fetch = async () => json(tokens());
    assert.ok(await manager.ensureTokenFresh());
  });
  it('clears only a definitively invalid grant', async () => {
    seed(); globalThis.fetch = async () => json({ error: 'invalid_grant' }, 400);
    assert.equal(await manager.ensureTokenFresh(), undefined);
    assert.equal(manager.getOAuthStatus().authenticated, false);
  });
  for (const status of [400, 401, 403]) it(`retains an unknown ${status} instead of assuming revocation`, async () => {
    seed(); globalThis.fetch = async () => json({ error: 'unknown' }, status);
    await assert.rejects(manager.ensureTokenFresh());
    assert.equal(db.getSetting('openai_oauth_refresh_token'), 'fake-refresh');
  });
  for (const failure of [false, true]) it(`logout/new login cannot be overwritten by late ${failure ? 'failure' : 'success'}`, async () => {
    seed(); const gate = deferred<Response>(); globalThis.fetch = async () => gate.promise;
    const result = manager.ensureTokenFresh();
    manager.clearOAuthTokens(); seed(true);
    db.setSetting('openai_oauth_access_token', 'other-account');
    gate.resolve(failure ? json({ error: 'invalid_grant' },400) : json(tokens()));
    assert.equal(await result, undefined);
    assert.equal(db.getSetting('openai_oauth_access_token'), 'other-account');
  });
  it('rolls back the whole token update if one field cannot be saved', async () => {
    seed();
    db.getDb().exec("CREATE TRIGGER reject_refresh BEFORE UPDATE ON settings WHEN NEW.key='openai_oauth_refresh_token' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
    globalThis.fetch = async () => json(tokens());
    try {
      await assert.rejects(manager.ensureTokenFresh());
      assert.equal(db.getSetting('openai_oauth_access_token'), 'fake-access');
      assert.equal(db.getSetting('openai_oauth_refresh_token'), 'fake-refresh');
    } finally { db.getDb().exec('DROP TRIGGER reject_refresh'); }
  });
});

const astra = { slug: 'gpt-6-astra', display_name: 'Astra', visibility: 'list', context_window: 272000,
  effective_context_window_percent: 95, input_modalities: ['text','image'], default_reasoning_level: 'medium',
  supported_reasoning_levels: ['low','medium','high','xhigh','max','ultra'].map(effort => ({effort})) };

describe('OAuth catalog and actual SDK request', () => {
  it('parses visible models and real capabilities, excluding hidden/duplicate/ultra', () => {
    const result = catalog.parseOpenAIOAuthModels({ models: [astra,astra,{ ...astra,slug:'hidden',visibility:'hide' }] });
    assert.equal(result.length,1); assert.equal(result[0].capabilities?.contextWindow,258400);
    assert.deepEqual(result[0].capabilities?.supportedEffortLevels,['low','medium','high','xhigh','max']);
    assert.equal(result[0].capabilities?.vision,true);
    assert.throws(() => catalog.parseOpenAIOAuthModels({ data: [] }));
  });
  it('uses only this OAuth account and preserves an authoritative empty catalog', async () => {
    seed(true); let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++; assert.equal(String(url),'https://chatgpt.com/backend-api/codex/models?client_version=0.153.1');
      assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fake-access');
      assert.equal(init?.redirect,'error'); return json({ models: [] });
    };
    await Promise.all([catalog.refreshOpenAIOAuthModels(),catalog.refreshOpenAIOAuthModels()]);
    assert.equal(calls,1); assert.deepEqual(catalog.getOpenAIOAuthModels(),[]);
    manager.clearOAuthTokens();
    assert.ok(catalog.getOpenAIOAuthModels().some(m=>m.modelId==='gpt-6-astra'));
  });
  it('does not populate another login with a late model discovery response', async () => {
    seed(true); const gate = deferred<Response>(); globalThis.fetch = async () => gate.promise;
    const request = catalog.refreshOpenAIOAuthModels(); await new Promise(r=>setImmediate(r));
    manager.clearOAuthTokens(); seed(true); gate.resolve(json({models:[]})); await request;
    assert.ok(catalog.getOpenAIOAuthModels().length > 0);
  });
  it('does not request models while logged out', async () => {
    globalThis.fetch = async () => { throw Error('Unexpected network'); };
    await catalog.refreshOpenAIOAuthModels();
  });
  it('real SDK sends Astra max and keeps unknown-model reasoning disabled', async () => {
    let body: Record<string, unknown> = {};
    const openai = createOpenAI({ apiKey:'fixture', fetch: async (_url,init) => {
      body = JSON.parse(init?.body as string); throw Error('capture');
    }});
    await assert.rejects(async () => await openai.responses('gpt-6-astra').doStream({
      prompt: [{role:'user',content:[{type:'text',text:'test'}]}],
      providerOptions: {openai:catalog.buildOpenAIOAuthOptions('gpt-6-astra','max')},
    }), /capture/);
    assert.equal((body.reasoning as {effort:string}).effort,'max'); assert.equal(body.store,false);
    assert.equal(catalog.buildOpenAIOAuthOptions('unknown').forceReasoning,undefined);
    assert.throws(()=>catalog.buildOpenAIOAuthOptions('gpt-6-astra','ultra'));
  });
  it('production Native loop forwards selected Astra max, fresh bearer and residency', async () => {
    seed(true);
    const token = jwt({ 'https://api.openai.com/auth': { chatgpt_compute_residency: 'eu' } });
    db.setSetting('openai_oauth_access_token',token);
    db.setSetting('openai_oauth_account_id','test-account');
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    globalThis.fetch = async (url,init) => {
      captured = { url:String(url),headers:new Headers(init?.headers),body:JSON.parse(init?.body as string) };
      return json({error:{message:'fixture terminal error',type:'invalid_request_error'}},400);
    };
    const {runAgentLoop} = await import('../../lib/agent-loop');
    const reader = runAgentLoop({prompt:'fixture',callScene:'interactive_chat',sessionId:'oauth-wire-fixture',
      providerId:'openai-oauth',model:'gpt-6-astra',effort:'max',tools:{},workingDirectory:temp,maxSteps:1}).getReader();
    while (!(await reader.read()).done) { /* consume the expected terminal error */ }
    assert.ok(captured);
    assert.equal(captured.url,'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(captured.headers.get('authorization'),`Bearer ${token}`);
    assert.equal(captured.headers.get('chatgpt-account-id'),'test-account');
    assert.equal(captured.headers.get('x-openai-internal-codex-residency'),'eu');
    assert.equal((captured.body.reasoning as {effort:string}).effort,'max');
  });
  it('separates API capacity, Codex usable input and missing transport facts', () => {
    assert.equal(getContextWindow('gpt-6-astra',{channel:'api'}),1050000);
    assert.equal(getContextWindow('gpt-6-astra',{channel:'codex',context1m:true}),258400);
    assert.equal(getContextWindow('gpt-6-astra'),null);
  });
});

describe('review follow-up regressions', () => {
  it('rejects missing/unknown visibility but accepts real empty and hidden-only catalogs', () => {
    for (const visibility of [undefined, 'unknown']) {
      assert.throws(() => catalog.parseOpenAIOAuthModels({models:[{...astra,visibility}]}), /visibility/);
    }
    assert.deepEqual(catalog.parseOpenAIOAuthModels({models:[]}), []);
    assert.deepEqual(catalog.parseOpenAIOAuthModels({models:[{...astra,visibility:'hide'}]}), []);
  });
  it('retains the last valid same-account catalog on schema drift and retries after cooldown', async () => {
    seed(true);
    const now = Date.now;
    let time = now(); Date.now = () => time;
    try {
      globalThis.fetch = async () => json({models:[astra]});
      await catalog.refreshOpenAIOAuthModels();
      time += 300001;
      globalThis.fetch = async () => json({models:[{...astra,visibility:undefined}]});
      await catalog.refreshOpenAIOAuthModels();
      assert.equal(catalog.getOpenAIOAuthModels()[0].modelId, 'gpt-6-astra');
      time += 30001;
      globalThis.fetch = async () => json({models:[]});
      await catalog.refreshOpenAIOAuthModels();
      assert.deepEqual(catalog.getOpenAIOAuthModels(), []);
      const {resolveProvider} = await import('../../lib/provider-resolver');
      assert.throws(() => resolveProvider({providerId:'openai-oauth',runtime:'codepilot_runtime'}), /OPENAI_OAUTH_CATALOG_EMPTY/);
      assert.equal(resolveProvider({providerId:'openai-oauth',model:'gpt-6-astra',runtime:'codepilot_runtime'}).model,'gpt-6-astra');
    } finally { Date.now = now; }
  });
  it('returns the global feed while expired-token discovery is still pending', async () => {
    const {GET} = await import('../../app/api/providers/models/route');
    const {NextRequest} = await import('next/server');
    seed(); const gate = deferred<Response>();
    globalThis.fetch = async url => String(url).includes('/oauth/token') ? gate.promise : json({models:[astra]});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        GET(new NextRequest('http://localhost/api/providers/models')),
        new Promise<never>((_,reject) => { timer=setTimeout(()=>reject(Error('global feed blocked on OAuth')),1000); }),
      ]);
      assert.equal(response.status,200);
      const body = await response.json();
      assert.equal(body.model_discovery_pending,true);
      assert.ok(body.groups.some((g:{provider_id:string})=>g.provider_id==='openai-oauth'));
    } finally {
      if(timer) clearTimeout(timer);
      gate.resolve(json(tokens()));
      await catalog.refreshOpenAIOAuthModels();
    }
  });
  it('production Codex proxy forwards Astra max and headers, and contains stale-effort errors', async () => {
    seed(true);
    const token = jwt({'https://api.openai.com/auth':{chatgpt_compute_residency:'eu'}});
    db.setSetting('openai_oauth_access_token',token); db.setSetting('openai_oauth_account_id','proxy-account');
    let captured: {headers:Headers;body:Record<string,unknown>;url:string}|undefined;
    globalThis.fetch = async (url,init) => {
      captured={url:String(url),headers:new Headers(init?.headers),body:JSON.parse(init?.body as string)};
      return json({error:{message:'fixture terminal error',type:'invalid_request_error'}},400);
    };
    const {handleProxyRequest} = await import('../../lib/codex/proxy/adapter');
    const input = {targetProviderId:'openai-oauth',sessionId:'',workspacePath:temp,signal:new AbortController().signal,
      body:{model:'gpt-6-astra',input:[{type:'message' as const,role:'user' as const,content:[{type:'input_text' as const,text:'fixture'}]}],
        reasoning:{effort:'max' as const},stream:true}};
    const result = await handleProxyRequest(input);
    assert.equal(result.kind,'stream');
    if(result.kind==='stream') {
      const reader=result.body.getReader(); while(!(await reader.read()).done) { /* capture actual SDK wire */ }
    }
    assert.ok(captured);
    assert.equal(captured.url,'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(captured.headers.get('authorization'),`Bearer ${token}`);
    assert.equal(captured.headers.get('chatgpt-account-id'),'proxy-account');
    assert.equal(captured.headers.get('x-openai-internal-codex-residency'),'eu');
    assert.deepEqual(captured.body.reasoning && (captured.body.reasoning as {effort:string}).effort,'max');
    assert.equal(captured.body.store,false);
    captured=undefined;
    globalThis.fetch = async () => json({models:[{...astra,supported_reasoning_levels:[{effort:'low'}]}]});
    await catalog.refreshOpenAIOAuthModels();
    const rejected=await handleProxyRequest(input);
    assert.equal(rejected.kind,'error');
    if(rejected.kind==='error') { assert.equal(rejected.error.code,'invalid_request'); assert.match(rejected.error.message,/OPENAI_OAUTH_EFFORT_UNAVAILABLE/); }
    assert.equal(captured,undefined);
  });
  it('localizes actionable errors and preserves unknown diagnostics', async () => {
    const {ModelSelectionError} = await import('../../lib/model-selection-error');
    const {localizeModelSelectionError} = await import('../../lib/model-selection-error-i18n');
    const {translate} = await import('../../i18n');
    const error=new ModelSelectionError('OPENAI_OAUTH_EFFORT_UNAVAILABLE');
    assert.match(localizeModelSelectionError(error.message,key=>translate('zh',key)),/重新选择/);
    assert.match(localizeModelSelectionError(error.message,key=>translate('en',key)),/Choose/);
    assert.equal(localizeModelSelectionError('unknown failure'),'unknown failure');
  });
});
