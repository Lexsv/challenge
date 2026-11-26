import { describe, expect, it, vi } from 'vitest';
import { createSavedProviderTransport, type CredentialStore } from '../server/credentials.mjs';

const placeholder='test-placeholder-key';
const store=(saved=true):CredentialStore=>({status:vi.fn(async()=>saved),read:vi.fn(async()=>placeholder),save:vi.fn(async()=>{}),forget:vi.fn(async()=>{})});
const request={model:'mock-model',input:[{role:'user',content:'Synthetic'}]};

describe('internal saved provider transport',()=>{
  it('uses a fixed endpoint and sanitizes nested response values and keys',async()=>{
    const mockStore=store();const fetcher=vi.fn(async(_input:string|URL|Request,_init?:RequestInit)=>new Response(JSON.stringify({output:[{text:`echo ${placeholder}`}],[placeholder]:'hidden'}),{status:200}));
    const result=await createSavedProviderTransport(mockStore,fetcher as typeof fetch)('openai',request);
    expect(result).toEqual({status:200,body:{output:[{text:'echo [redacted]'}],'[redacted]':'hidden'}});
    expect(fetcher.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
    const init=fetcher.mock.calls[0][1] as RequestInit;expect(init.redirect).toBe('error');expect(JSON.parse(init.body as string)).toMatchObject({model:'mock-model',store:false});
    expect(JSON.stringify(result)).not.toContain(placeholder);
  });
  it('refuses missing credentials and unsupported provider identifiers before forwarding',async()=>{
    const fetcher=vi.fn();const missing=store(false);const transport=createSavedProviderTransport(missing,fetcher);
    expect((await transport('openai',request)).status).toBe(404);expect(missing.read).not.toHaveBeenCalled();
    expect((await transport('https://example.invalid',request)).status).toBe(404);expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([[401,'authentication'],[429,'rate-limit']] as const)('returns sanitized provider status %i',async(status,kind)=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({error:{message:`secret ${placeholder}`,headers:{authorization:placeholder}}}),{status}));
    const result=await createSavedProviderTransport(store(),fetcher as typeof fetch)('openai',request);
    expect(result).toEqual({status:502,body:{error:`Provider request failed (${status}).`,providerError:{kind,status}}});expect(JSON.stringify(result)).not.toContain(placeholder);
  });
  it('sanitizes network and credential failures and disallows reserved parameters',async()=>{
    const fetcher=vi.fn(async()=>{throw Error(`Authorization ${placeholder}`);});const transport=createSavedProviderTransport(store(),fetcher as typeof fetch);
    const result=await transport('openai',request);expect(result).toEqual({status:503,body:{error:'Saved credential operation unavailable.'}});expect(JSON.stringify(result)).not.toContain(placeholder);
    expect((await transport('openai',{...request,parameters:{model:'override'}})).status).toBe(400);
    const broken=store();broken.read=async()=>{throw Error(placeholder);};expect(JSON.stringify(await createSavedProviderTransport(broken,fetcher as typeof fetch)('openai',request))).not.toContain(placeholder);
  });
  it('retains OpenCode request shape and rejects superseded operations',async()=>{
    const fetcher=vi.fn(async(_input:string|URL|Request,_init?:RequestInit)=>new Response('{}',{status:200}));const transport=createSavedProviderTransport(store(),fetcher as typeof fetch);
    expect((await transport('opencode-console',{model:'mock-model',messages:[]})).status).toBe(200);
    expect(fetcher.mock.calls[0][0]).toBe('https://opencode.ai/inference/openai/v1/chat/completions');
    expect((await transport('openai',request,()=>false)).status).toBe(409);expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
