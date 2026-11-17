import { describe, expect, it, vi } from 'vitest';
import { createServerManagerLlmAdapter } from '../server/manager-llm-adapter';
import { createProviderRegistry } from './provider-registry';
import { createSavedProviderTransport, type CredentialStore } from '../server/credentials.mjs';
import type { RequestMeter } from './token-meter';
import { spawnSync } from 'node:child_process';

const registry=()=>createProviderRegistry(undefined,{}, {catalogStorage:()=>undefined});
const config={providerId:'openai',model:'gpt-5.6-terra'};
const messages=[{role:'user' as const,content:'Synthetic question'}];
const response={output:[{type:'message',content:[{type:'output_text',text:'Synthetic answer'}]}],usage:{input_tokens:42,output_tokens:7,total_tokens:49}};

describe('server Manager adapter',()=>{
  it('imports the real registry and executes both providers under native Node without resolution hooks',()=>{
    const script=`import {createProviderRegistry} from './src/provider-registry.ts';
      import {createServerManagerLlmAdapter} from './server/manager-llm-adapter.ts';
      const registry=createProviderRegistry();
      for(const [providerId,model] of [['openai','gpt-5.6-terra'],['opencode-console','kimi-k3']]){
        let calls=0;const adapter=createServerManagerLlmAdapter({providerId,model},registry,async(id,body)=>{if(id!==providerId||body.model!==model)throw Error('wrong selection');calls++;return {status:200,body:id==='openai'?{output:[{type:'message',content:[{type:'output_text',text:'ok'}]}]}:{choices:[{message:{content:'ok'}}]}}});
        const result=await adapter.complete({messages:[{role:'user',content:'synthetic'}],tools:[]});if(result.text!=='ok'||calls!==1)throw Error('unexpected result');
      }
      for(const config of [{providerId:'unknown',model:'x'},{providerId:'openai',model:'unknown'}]){let rejected=false;try{createServerManagerLlmAdapter(config,registry,async()=>{throw Error('unexpected call')})}catch{rejected=true}if(!rejected)throw Error('invalid configuration accepted');}`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),encoding:'utf8'});
    expect(result.status,result.stderr).toBe(0);
  });
  it('uses the internal broker and reuses request formatting, parsing, and metering',async()=>{
    const placeholder='test-credential-placeholder';
    const store:CredentialStore={status:async()=>true,read:async()=>placeholder,save:async()=>{},forget:async()=>{}};
    const fetcher=vi.fn(async(_url:string|URL|Request,_init?:RequestInit)=>new Response(JSON.stringify(response),{status:200}));
    const broker=createSavedProviderTransport(store,fetcher as typeof fetch);
    const seen:RequestMeter[]=[];const adapter=createServerManagerLlmAdapter(config,registry(),broker);
    const result=await adapter.complete({messages,tools:[],onMeter:async meter=>{seen.push(meter);}});
    expect(result.text).toBe('Synthetic answer');expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
    const body=JSON.parse(fetcher.mock.calls[0][1]!.body as string);expect(body).toMatchObject({model:config.model,store:false,input:[{role:'user',content:'Synthetic question'}]});
    expect(JSON.stringify(body)).not.toContain(placeholder);expect(JSON.stringify({result,seen})).not.toContain(placeholder);
    expect(seen.at(-1)).toMatchObject({actualInputTokens:42,actualOutputTokens:7,actualTotalTokens:49});
  });
  it('rejects untrusted config fields, unsupported provider and unsupported model before dispatch',()=>{
    const send=vi.fn();expect(()=>createServerManagerLlmAdapter({providerId:'invalid',model:'x'},registry(),send)).toThrow('Unsupported server provider');
    expect(()=>createServerManagerLlmAdapter({providerId:'openai',model:'not-a-model'},registry(),send)).toThrow('Unsupported server model');
    expect(()=>createServerManagerLlmAdapter({...config,apiKey:'placeholder'} as typeof config,registry(),send)).toThrow('Invalid server provider configuration');expect(send).not.toHaveBeenCalled();
  });
  it('uses the configured OpenCode model and parses chat responses',async()=>{
    const transport=vi.fn(async()=>({status:200,body:{choices:[{message:{content:'Chat answer'}}],usage:{prompt_tokens:11,completion_tokens:4,total_tokens:15}}}));
    const adapter=createServerManagerLlmAdapter({providerId:'opencode-console',model:'kimi-k3'},registry(),transport);
    expect(await adapter.complete({messages,tools:[]})).toMatchObject({text:'Chat answer'});
    expect(transport).toHaveBeenCalledWith('opencode-console',expect.objectContaining({model:'kimi-k3',messages:[{role:'user',content:'Synthetic question'}]}));
  });
  it.each([[404,'request'],[401,'authentication'],[429,'rate-limit']] as const)('handles broker failure %i',async(status,kind)=>{
    const transport=vi.fn(async()=>status===404?{status:404,body:{error:'No saved credential'}}:{status:502,body:{providerError:{status,kind}}});
    const adapter=createServerManagerLlmAdapter(config,registry(),transport);
    await expect(adapter.complete({messages,tools:[]})).rejects.toMatchObject({metadata:{kind,status}});
  });
  it('sanitizes thrown network errors and rejects malformed provider output',async()=>{
    const adapter=createServerManagerLlmAdapter(config,registry(),async()=>{throw Error('test-placeholder-secret');});
    await expect(adapter.complete({messages,tools:[]})).rejects.toThrow('Manager provider request could not complete');
    const malformed=createServerManagerLlmAdapter(config,registry(),async()=>({status:200,body:{output:[{type:'message'}]}}));
    await expect(malformed.complete({messages,tools:[]})).rejects.toThrow('Manager provider request could not complete');
  });
});
