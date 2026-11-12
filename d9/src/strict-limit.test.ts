import {it,expect,vi} from 'vitest';
import {ManagerAgent,createManagerConversation} from './manager-agent';
import {createManagerLlmAdapter,estimateManagerRequest} from './manager-llm-adapter';
import {createProviderRegistry} from './provider-registry';
import {createBuiltInToolRegistry,ToolRegistry} from './tool-runtime';
import {aggregateSessionStats} from './session-stats';

it('enforces 200 tokens locally after compaction and keeps previous answer metrics when blocked',async()=>{
 const state=createManagerConversation();const tools=new ToolRegistry();
 const seed=new ManagerAgent({complete:async()=>({text:'A prior answer.'})},tools);
 for(let i=0;i<4;i++)await seed.run({state,userText:'Prior discussion about the project and the requested design. '.repeat(120),onEvent:async()=>{}});
 const bodies:any[]=[];
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  const body=JSON.parse(String(init?.body));bodies.push(body);
  const summary=body.input.some((m:any)=>m.role==='system');
  return new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:summary?'The team discussed the project.':'The requested answer.'}]}],usage:{input_tokens:80,output_tokens:10,total_tokens:90}}));
 }) as typeof fetch;
 const registry=createProviderRegistry();const config={providerId:'openai' as const,model:'gpt-4o-mini',registry,requestTokenLimit:200,apiKey:'placeholder',fetcher};
 const manager=new ManagerAgent(createManagerLlmAdapter(config),tools);
 const result=await manager.run({state,userText:'Continue.',onEvent:async()=>{}});
 expect(result.error).toBeUndefined();
 const answer=bodies.filter(body=>!body.input.some((m:any)=>m.role==='system')).at(-1);
 expect(answer).toBeDefined();expect(JSON.stringify(answer)).not.toContain('Saved conversation summary');
 expect(answer).not.toHaveProperty('max_output_tokens');expect(answer).not.toHaveProperty('max_completion_tokens');
 const stats=aggregateSessionStats(state);const prior=stats.lastAnswer;
 expect(prior?.sentInputTokens).toBeLessThanOrEqual(200);
 const count=bodies.length;
 const blocked=await manager.run({state,userText:'The required current message is lengthy. '.repeat(500),onEvent:async()=>{}});
 expect(blocked.error).toBeUndefined();
 expect(bodies.slice(count).filter(body=>!body.input.some((m:any)=>m.role==='system'))).toHaveLength(1);
 expect(aggregateSessionStats(state).lastAnswer).not.toEqual(prior);
 const standard=await estimateManagerRequest({...config,messages:[{role:'user',content:'Continue.'}],tools:createBuiltInToolRegistry().listBuiltIn().filter(t=>t.executable)});
 console.info(`200-token test: compacted answer=${prior?.sentInputTokens}, blocked=${blocked.error}; standard built-in payload=${standard.estimatedInputTokens}`);
});

it('blocks the standard built-in tools at 200 and does not send a provider request',async()=>{
 const state=createManagerConversation();const tools=createBuiltInToolRegistry();const fetcher=vi.fn(async()=>new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'Completed.'}]}]}))) as unknown as typeof fetch;
 const adapter=createManagerLlmAdapter({providerId:'openai',model:'gpt-4o-mini',registry:createProviderRegistry(),requestTokenLimit:200,apiKey:'placeholder',fetcher});
 const before=aggregateSessionStats(state).lastAnswer;
 const result=await new ManagerAgent(adapter,tools).run({state,userText:'Continue.',onEvent:async()=>{}});
 expect(result.error).toBeUndefined();
 expect(fetcher).toHaveBeenCalledOnce();expect(aggregateSessionStats(state).lastAnswer).not.toEqual(before);
});

it.each(['openai','opencode-console'] as const)('omits app-imposed token limits from %s summary and answer payloads',async providerId=>{
 const bodies:Record<string,unknown>[]=[];
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  bodies.push(JSON.parse(String(init?.body)));
  return new Response(JSON.stringify(providerId==='openai'?{output:[{type:'message',content:[{type:'output_text',text:'Summary or answer.'}]}]}:{choices:[{message:{content:'Summary or answer.'}}]}));
 }) as typeof fetch;
 const adapter=createManagerLlmAdapter({providerId,model:providerId==='openai'?'gpt-4o-mini':'unknown',registry:createProviderRegistry(),apiKey:'placeholder',fetcher});
 await adapter.context!.summarize('Saved discussion.',async()=>{},32);
 await adapter.complete({messages:[{role:'user',content:'Continue.'}],tools:[]});
 expect(bodies).toHaveLength(2);
 for(const body of bodies){expect(body).not.toHaveProperty('max_output_tokens');expect(body).not.toHaveProperty('max_completion_tokens');expect(body).not.toHaveProperty('max_tokens');}
});

it.each(['openai','opencode-console'] as const)('omits token-limit fields during %s overflow recovery',async providerId=>{
 const state=createManagerConversation(),tools=new ToolRegistry();
 const seed=new ManagerAgent({complete:async()=>({text:'Earlier answer. '.repeat(200)})},tools);
 for(let i=0;i<3;i++)await seed.run({state,userText:'Prior discussion. '.repeat(150),onEvent:async()=>{}});
 const registry=createProviderRegistry();
 if(providerId==='opencode-console')registry.get(providerId)!.limits=()=>({contextWindow:128000,maxOutputTokens:4096});
 const bodies:Record<string,any>[]=[];let answers=0;
 const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  const body=JSON.parse(String(init?.body));bodies.push(body);
  const messages=body.input??body.messages;const summary=messages.some((message:any)=>message.role==='system');
  if(!summary && ++answers===1)return new Response(JSON.stringify({error:{code:'context_length_exceeded',message:'mock overflow'}}),{status:400});
  return new Response(JSON.stringify(providerId==='openai'?{output:[{type:'message',content:[{type:'output_text',text:summary?'Earlier discussion summarized.':'Recovered.'}]}]}:{choices:[{message:{content:summary?'Earlier discussion summarized.':'Recovered.'}}]}));
 }) as typeof fetch;
 const adapter=createManagerLlmAdapter({providerId,model:providerId==='openai'?'gpt-4o-mini':'deepseek-v4.1-flash',registry,apiKey:'placeholder',fetcher});
 const result=await new ManagerAgent(adapter,tools).run({state,userText:'Continue',onEvent:async()=>{}});
 expect(result.error).toBeUndefined();expect(answers).toBe(2);
 expect(bodies.some(body=>(body.input??body.messages).some((m:any)=>m.role==='system'))).toBe(false);
 for(const body of bodies)for(const field of ['max_tokens','max_output_tokens','max_completion_tokens'])expect(body).not.toHaveProperty(field);
});

it('blocks when required tools cannot fit the model input budget',async()=>{
 const state=createManagerConversation();const registry=createProviderRegistry();registry.get('opencode-console')!.limits=()=>({contextWindow:5120,maxOutputTokens:4096});
 const fetcher=vi.fn(async()=>new Response('{}')) as unknown as typeof fetch;
 const result=await new ManagerAgent(createManagerLlmAdapter({providerId:'opencode-console',model:'deepseek-v4.1-flash',registry,requestTokenLimit:200,apiKey:'placeholder',fetcher}),createBuiltInToolRegistry()).run({state,userText:'Continue.'});
 expect(result.error).toContain('exceeds the model input budget');expect(fetcher).not.toHaveBeenCalled();
});

it.each(['openai','opencode-console'] as const)('does not save an incomplete %s answer as completed',async providerId=>{
 const state=createManagerConversation();const fetcher=vi.fn(async()=>new Response(JSON.stringify(providerId==='openai'?{status:'incomplete',output:[{type:'message',content:[{type:'output_text',text:'Partial.'}]}]}:{choices:[{finish_reason:'length',message:{content:'Partial.'}}]}))) as typeof fetch;
 const result=await new ManagerAgent(createManagerLlmAdapter({providerId,model:providerId==='openai'?'gpt-4o-mini':'unknown',registry:createProviderRegistry(),apiKey:'placeholder',fetcher}),new ToolRegistry()).run({state,userText:'Continue.'});
 expect(result.run.status).toBe('failed');expect(result.error).toContain('incomplete answer');expect(state.messages.some(m=>m.text==='Partial.')).toBe(false);
});
