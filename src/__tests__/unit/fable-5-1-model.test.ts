import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { ENV_CLAUDE_CODE_MODELS } from '@/lib/provider-catalog';
import { sanitizeClaudeModelOptions } from '@/lib/claude-model-options';
import { getContextWindow } from '@/lib/model-context';
import { buildCoreMessages } from '@/lib/message-builder';
import { runAgentLoop } from '@/lib/agent-loop';
import { createProvider, createSession, addMessage, getMessages, deleteSession, deleteProvider } from '@/lib/db';

const MODEL='claude-fable-5-1';
const originalFetch=globalThis.fetch;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codepilot-fable51-'));
after(()=>{ globalThis.fetch=originalFetch; fs.rmSync(temp,{recursive:true,force:true}); });

type Block = Record<string,unknown>;
type Wire = { model:string; messages:Array<{role:string;content:Block[]}>; system:unknown; tools:unknown; thinking?:Block; output_config?:{effort:string}; tool_choice?:{type:string} };
function response(toolCall: boolean, model = MODEL): Response {
  const events: Block[]=[{type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}}];
  const block=(index:number,content:Block,deltas:Block[])=>{
    events.push({type:'content_block_start',index,content_block:content},...deltas.map(delta=>({type:'content_block_delta',index,delta})),{type:'content_block_stop',index});
  };
  if(toolCall){
    block(0,{type:'thinking',thinking:''},[{type:'thinking_delta',thinking:'Fixture reasoning.'},{type:'signature_delta',signature:'fixture-signature'}]);
    block(1,{type:'tool_use',id:'tool_fixture',name:'lookup',input:{}},[{type:'input_json_delta',partial_json:'{}'}]);
  }else block(0,{type:'text',text:''},[{type:'text_delta',text:'Fixture done.'}]);
  events.push({type:'message_delta',delta:{stop_reason:toolCall?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:10}},{type:'message_stop'});
  return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}
async function consume(stream:ReadableStream<string>){
  const reader=stream.getReader();let raw='';
  while(true){const r=await reader.read();if(r.done)break;raw+=r.value;}
  assert.doesNotMatch(raw,/"type":"error"/,raw);
  return raw;
}

describe('Fable 5.1 explicit catalog and protocol',()=>{
  it('adds a separate choice without replacing Fable 5 or role defaults',()=>{
    const model=ENV_CLAUDE_CODE_MODELS.find(m=>m.modelId==='fable-5-1');
    assert.equal(model?.upstreamModelId,MODEL); assert.equal(model?.role,undefined);
    assert.equal(model.capabilities?.defaultEffortLevel,'high');
    assert.deepEqual(model.capabilities?.supportedEffortLevels,['low','medium','high','xhigh','max']);
    assert.equal(model.capabilities?.vision,true);
    assert.equal(ENV_CLAUDE_CODE_MODELS.find(m=>m.modelId==='fable-5')?.upstreamModelId,'claude-fable-5');
    assert.equal(ENV_CLAUDE_CODE_MODELS.find(m=>m.modelId==='opus')?.upstreamModelId,'claude-opus-4-7');
    assert.equal(getContextWindow(MODEL),1_000_000);
  });
  it('keeps always-on adaptive thinking and rejects manual-budget semantics',()=>{
    const off=sanitizeClaudeModelOptions({model:MODEL,thinking:{type:'disabled'},effort:'max'});
    assert.equal(off.thinkingForcedOn,true);assert.equal(off.thinking,undefined);assert.equal(off.effort,'max');
    const manual=sanitizeClaudeModelOptions({model:MODEL,thinking:{type:'enabled',budgetTokens:8000},context1m:true});
    assert.deepEqual(manual.thinking,{type:'adaptive',display:'summarized'});assert.equal(manual.applyContext1mBeta,false);
    assert.equal(sanitizeClaudeModelOptions({model:'claude-opus-5',thinking:{type:'disabled'}}).thinkingForcedOn,false);
  });
  it('production Native tool loop preserves the signed history prefix across steps',async()=>{
    const provider=createProvider({name:'Fable fixture',provider_type:'anthropic',protocol:'anthropic',preset_key:'anthropic-official',base_url:'https://api.anthropic.com',api_key:'fixture-only'});
    const session=createSession('Fable fixture','fable-5-1','',temp);
    addMessage(session.id,'user','Retain the requirement');
    const requests:Wire[]=[];
    globalThis.fetch=async (_url,init)=>{const body=JSON.parse(init?.body as string) as Wire;requests.push(body);return response(requests.length===1);};
    try{
      await consume(runAgentLoop({prompt:'Retain the requirement',callScene:'interactive_chat',sessionId:session.id,providerId:provider.id,model:'fable-5-1',workingDirectory:temp,effort:'max',thinking:{type:'enabled',budgetTokens:8000},maxSteps:3,
        tools:{lookup:tool({description:'Fixture lookup',inputSchema:z.object({}),execute:async()=> 'Fixture lookup result'})}}));
      assert.equal(requests.length,2);
      for(const r of requests){assert.equal(r.model,MODEL);assert.equal(r.thinking?.type,'adaptive');assert.equal(r.output_config?.effort,'max');assert.equal(r.tool_choice?.type,'auto');}
      assert.deepEqual(requests[1].system,requests[0].system);
      assert.deepEqual(requests[1].tools,requests[0].tools);
      assert.deepEqual(requests[1].messages.slice(0,requests[0].messages.length),requests[0].messages);
      assert.ok(requests[1].messages.some(m=>m.content.some(b=>b.type==='thinking' && b.signature==='fixture-signature')));
      assert.ok(requests[1].messages.some(m=>m.content.some(b=>b.type==='tool_result')));
      // Stored cross-turn history (including after a summary/model switch)
      // replays user-visible content, never stale provider-bound signatures.
      addMessage(session.id,'assistant',JSON.stringify([{type:'thinking',thinking:'old',signature:'stale'},{type:'text',text:'visible answer'}]));
      const history=buildCoreMessages(getMessages(session.id,{limit:200}).messages);
      assert.doesNotMatch(JSON.stringify(history),/stale|"thinking"/);
      assert.match(JSON.stringify(history),/visible answer|Retain the requirement/);
      for(const model of ['fable-5','fable-5-1','opus']){
        requests.length=0;globalThis.fetch=async(_url,init)=>{const body=JSON.parse(init?.body as string);requests.push(body);return response(false,body.model);};
        await consume(runAgentLoop({prompt:'Continue',autoTrigger:true,callScene:'interactive_chat',sessionId:session.id,providerId:provider.id,model,workingDirectory:temp,tools:{},maxSteps:1}));
        assert.equal(requests.length,1);
        assert.equal(requests[0].model,ENV_CLAUDE_CODE_MODELS.find(m=>m.modelId===model)?.upstreamModelId);
        assert.ok(!requests[0].tool_choice || requests[0].tool_choice.type==='none');
        assert.doesNotMatch(JSON.stringify(requests[0].messages),/stale|fixture-signature/);
        assert.match(JSON.stringify(requests[0].messages),/visible answer/);
      }
    }finally{globalThis.fetch=originalFetch;deleteSession(session.id);deleteProvider(provider.id);}
  });
});
