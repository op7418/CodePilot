import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';
import { ModelSelectionError } from '../../lib/model-selection-error';

test('old chat switches Fable versions in place, refreshes pending catalog, and localizes recovery', async ({page,request})=>{
  const dataDir=process.env.CODEPILOT_E2E_DATA_DIR;
  if(!dataDir || !path.basename(dataDir).startsWith('codepilot-playwright-db-'))throw Error('Requires isolated DB');
  await request.put('/api/settings/app',{data:{settings:{locale:'zh'}}});
  const created=await request.post('/api/providers',{data:{name:'Fable review fixture',provider_type:'anthropic',protocol:'anthropic',preset_key:'anthropic-official',base_url:'https://api.anthropic.com',api_key:'fixture-only'}});
  expect(created.ok()).toBe(true);const {provider}=await created.json();
  const sessionResponse=await request.post('/api/chat/sessions',{data:{working_directory:dataDir,runtime_id:'codepilot_runtime',provider_id:provider.id,model:'fable-5'}});
  expect(sessionResponse.status()).toBe(201);const {session}=await sessionResponse.json();
  const db=new Database(path.join(dataDir,'codepilot.db'));
  try{
    db.prepare("UPDATE chat_sessions SET runtime_binding_state='bound',runtime_binding_source='legacy_pin' WHERE id=?").run(session.id);
    db.prepare('INSERT INTO messages (id,session_id,role,content) VALUES (?,?,?,?)').run(`history-${session.id}`,session.id,'user','Historical requirement');
    db.prepare('INSERT INTO messages (id,session_id,role,content) VALUES (?,?,?,?)').run(`error-${session.id}`,session.id,'assistant',`**Error:** ${new ModelSelectionError('OPENAI_OAUTH_EFFORT_UNAVAILABLE').message}`);
    const before=db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY rowid').all(session.id);
    const count=db.prepare('SELECT COUNT(*) AS n FROM chat_sessions').get();
    let catalogReads=0;
    await page.route('**/api/providers/models',async route=>{
      const response=await route.fetch();const data=await response.json();catalogReads++;
      // A delayed OAuth discovery must update the mounted picker without a
      // new chat/navigation. All model identities still come from real GET.
      data.model_discovery_pending=catalogReads<2;
      if(catalogReads===1){for(const group of data.groups) group.models=group.models.filter((m:{value:string})=>m.value!=='fable-5-1');}
      await route.fulfill({response,json:data});
    });
    await page.goto(`/chat/${session.id}`);
    await expect(page.getByText('当前 OpenAI 账号已不支持所选推理档位。请在模型选择器中重新选择可用档位后重试。')).toBeVisible();
    for(const [label,model] of [['Fable 5.1','fable-5-1'],['Fable 5','fable-5'],['Opus 4.7','opus']]){
      await page.getByRole('button',{name:/Choose runtime and model|选择 Runtime 和模型/}).click();
      const pending=page.waitForResponse(r=>r.url().endsWith(`/api/chat/sessions/${session.id}/route`) && r.request().method()==='PATCH');
      await page.locator(`[data-model-provider-section="${provider.id}"]`).getByRole('button',{name:new RegExp(`^${label.replaceAll('.','\\.')} ${model}`)}).click();
      const response=await pending;expect(response.status(),await response.text()).toBe(200);
      const data=await response.json();expect(data.session.model).toBe(model);expect(data.session.id).toBe(session.id);
      await expect(page).toHaveURL(new RegExp(`/chat/${session.id}$`));
    }
    expect(catalogReads).toBeGreaterThanOrEqual(2);
    expect(db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY rowid').all(session.id)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_sessions').get()).toEqual(count);
    // Counterexample: a failed background poll retains the loaded provider
    // instead of replacing it with synthetic env models.
    await page.unroute('**/api/providers/models');
    let failRefresh=false;
    await page.route('**/api/providers/models',async route=>{
      if(failRefresh){await route.fulfill({status:503,json:{error:'fixture offline'}});return;}
      const response=await route.fetch();const data=await response.json();
      await route.fulfill({response,json:{...data,model_discovery_pending:true}});
    });
    const failedPoll=page.waitForResponse(r=>r.url().endsWith('/api/providers/models') && r.status()===503);
    await page.reload();
    await page.getByRole('button',{name:/Choose runtime and model|选择 Runtime 和模型/}).click();
    const retainedModel=page.locator(`[data-model-provider-section="${provider.id}"]`).getByRole('button',{name:/^Fable 5\.1 fable-5-1/});
    await expect(retainedModel).toBeVisible();
    failRefresh=true;await failedPoll;
    await expect(retainedModel).toBeVisible();
  }finally{
    db.close();await request.delete(`/api/chat/sessions/${session.id}`);await request.delete(`/api/providers/${provider.id}`);
  }
});
