import { describe, expect, it, vi } from 'vitest';
import { createLlmSemanticAssessor } from '../server/semantic-assessor';
import { createServerManagerLlmAdapter } from '../server/manager-llm-adapter';
import { createProviderRegistry } from './provider-registry';
import { createSavedProviderTransport, type CredentialStore } from '../server/credentials.mjs';
import type { ManagerLlmAdapter } from './manager-agent';
import type { SemanticAssessorInput } from './semantic-assessor';

const input:SemanticAssessorInput={candidate:'Meeting at 16:00.',existingTopics:[{key:'Meeting',value:'13:00',status:'confirmed',revision:1}],context:[{id:'m1',role:'user',sequence:1,content:'Meeting at 16:00.'}]};
const makeAdapter=(text:string):ManagerLlmAdapter=>({context:{assess:async()=>({tokens:100,modelInputBudget:1000}),summarize:async()=>''},complete:vi.fn(async()=>({text}))});

describe('LLM semantic assessor producer',()=>{
  it.each([
    {action:'ADD',proposedContent:'New topic',reason:'New'},
    {action:'UPDATE',targetKey:'Meeting',proposedContent:'16:00',reason:'Changed'},
    {action:'DUPLICATE',targetKey:'Meeting',reason:'Already stored'},
    {action:'SKIP',reason:'Noise'},
  ])('validates $action and passes untrusted input as data',async recommendation=>{
    const adapter=makeAdapter(JSON.stringify(recommendation));const result=await createLlmSemanticAssessor(adapter).assess(input);
    expect(result).toEqual({ok:true,recommendation});
    const request=vi.mocked(adapter.complete).mock.calls[0][0];expect(request.tools).toEqual([]);
    expect(request.messages[0].content).toContain('untrusted data');expect(JSON.parse(request.messages[1].content!)).toEqual(input);
  });
  it('rejects malformed JSON, invalid actions and unknown targets',async()=>{
    for(const [text,code] of [['{','INVALID_JSON'],['{"action":"DELETE","reason":"x"}','INVALID_RESPONSE'],['{"action":"UPDATE","targetKey":"Other","proposedContent":"x","reason":"x"}','INVALID_TARGET']] as const){expect(await createLlmSemanticAssessor(makeAdapter(text)).assess(input)).toMatchObject({ok:false,error:{code}});}
  });
  it('returns sanitized failures without retries for provider errors, missing estimates and tools',async()=>{
    const adapter=makeAdapter('');vi.mocked(adapter.complete).mockRejectedValue(Error('test-secret-placeholder'));
    expect(await createLlmSemanticAssessor(adapter).assess(input)).toEqual({ok:false,error:{code:'EXECUTION_FAILED'}});expect(adapter.complete).toHaveBeenCalledTimes(1);
    const missing=makeAdapter('');missing.context!.assess=async()=>({});expect(await createLlmSemanticAssessor(missing).assess(input)).toMatchObject({ok:false,error:{code:'EXECUTION_FAILED'}});expect(missing.complete).not.toHaveBeenCalled();
    const tool=makeAdapter('');vi.mocked(tool.complete).mockResolvedValue({text:'{}',toolCalls:[{id:'call',toolId:'tool',arguments:{}}]});expect(await createLlmSemanticAssessor(tool).assess(input)).toMatchObject({ok:false,error:{code:'EXECUTION_FAILED'}});
  });
  it('uses trusted server configuration and the mocked saved-key broker without exposing the credential',async()=>{
    const placeholder='test-credential-placeholder';const store:CredentialStore={status:async()=>true,read:async()=>placeholder,save:async()=>{},forget:async()=>{}};
    const recommendation={action:'SKIP',reason:'Noise'};const fetcher=vi.fn(async()=>new Response(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(recommendation)}]}]}),{status:200}));
    const registry=createProviderRegistry(undefined,{}, {catalogStorage:()=>undefined});const adapter=createServerManagerLlmAdapter({providerId:'openai',model:'gpt-5.6-terra'},registry,createSavedProviderTransport(store,fetcher as typeof fetch));
    const result=await createLlmSemanticAssessor(adapter).assess(input);expect(result).toEqual({ok:true,recommendation});expect(JSON.stringify(result)).not.toContain(placeholder);expect(fetcher).toHaveBeenCalledTimes(1);
    expect(()=>createServerManagerLlmAdapter({providerId:'unknown',model:'x'},registry)).toThrow('Unsupported server provider');
    expect(()=>createServerManagerLlmAdapter({providerId:'openai',model:'unknown'},registry)).toThrow('Unsupported server model');
  });
  it('sanitizes authentication failure through the real adapter and mocked broker',async()=>{
    const placeholder='test-credential-placeholder';const store:CredentialStore={status:async()=>true,read:async()=>placeholder,save:async()=>{},forget:async()=>{}};
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({error:{message:placeholder}}),{status:401}));
    const adapter=createServerManagerLlmAdapter({providerId:'openai',model:'gpt-5.6-terra'},createProviderRegistry(undefined,{}, {catalogStorage:()=>undefined}),createSavedProviderTransport(store,fetcher as typeof fetch));
    const result=await createLlmSemanticAssessor(adapter).assess(input);expect(result).toEqual({ok:false,error:{code:'EXECUTION_FAILED'}});expect(JSON.stringify(result)).not.toContain(placeholder);expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
