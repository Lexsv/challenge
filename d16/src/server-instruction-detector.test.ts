import { describe, expect, it, vi } from 'vitest';
import { createServerInstructionDetector } from '../server/instruction-detector-config';
import { createProviderRegistry } from './provider-registry';
import type { RequestMeter } from './token-meter';
import { createSavedProviderTransport } from '../server/credentials.mjs';

const input={userMessage:'Always use examples.',habits:''};
const payload=JSON.stringify({operations:[{action:'ADD',sourceQuote:'Always use examples.',newInstruction:'Use examples.'}]});
const registry=()=>createProviderRegistry(undefined,{}, {catalogStorage:()=>undefined});
const config={providerId:'openai',model:'gpt-5.6-terra'};
const openaiResponse=(text:string)=>({output:[{type:'message',content:[{type:'output_text',text}]}],usage:{input_tokens:42,output_tokens:7,total_tokens:49}});

describe('server instruction detector configuration',()=>{
  it('dispatches a bounded, tool-free request and records extraction usage',async()=>{
    const transport=vi.fn(async()=>({status:200,body:openaiResponse(payload)})),meters:RequestMeter[]=[];
    const detector=createServerInstructionDetector(config,registry(),async meter=>{meters.push(meter);},transport);
    expect(await detector.detect(input)).toEqual({ok:true,operations:[{action:'ADD',sourceQuote:'Always use examples.',newInstruction:'Use examples.'}]});
    expect(transport).toHaveBeenCalledOnce();
    const [provider,body]=transport.mock.calls[0] as unknown as [string,Record<string,unknown>];
    expect(provider).toBe('openai');expect(body).toMatchObject({model:config.model,max_output_tokens:512,tools:[],tool_choice:'none'});
    expect(body).toMatchObject({text:{format:{type:'json_schema',name:'persistent_instruction_operations',strict:true,schema:{type:'object',required:['operations'],additionalProperties:false,properties:{operations:{type:'array',items:{anyOf:[{properties:{action:{enum:['ADD']}}},{properties:{action:{enum:['UPDATE']}}},{properties:{action:{enum:['REMOVE']}}}]}}}}}}});
    expect(JSON.stringify(body)).not.toContain('Authorization');
    expect(meters.length).toBeGreaterThan(0);expect(meters.every(meter=>meter.requestKind==='extraction')).toBe(true);
    expect(meters.at(-1)).toMatchObject({actualInputTokens:42,actualOutputTokens:7,actualTotalTokens:49});
  });
  it('forwards the structured-output schema through the saved-provider transport',async()=>{
    let sent:Record<string,unknown>|undefined;
    const store={status:async()=>true,read:async()=> 'dummy-test-key',save:async()=>{},forget:async()=>{}};
    const fetcher:typeof fetch=async(_url,init)=>{sent=JSON.parse(String(init?.body));return new Response(JSON.stringify(openaiResponse(payload)),{status:200});};
    const detector=createServerInstructionDetector(config,registry(),async()=>{},createSavedProviderTransport(store,fetcher));
    expect((await detector.detect(input)).ok).toBe(true);
    expect(sent).toMatchObject({text:{format:{type:'json_schema',strict:true,schema:{required:['operations'],additionalProperties:false}}}});
  });
  it.each(['opencode-console','opencode-go'] as const)('uses the %s chat output limit for a configured model with known server limits',async providerId=>{
    const reg=registry(),provider=reg.get(providerId)!;
    provider.limits=()=>({contextWindow:32000,maxOutputTokens:4096});
    const transport=vi.fn(async()=>({status:200,body:{choices:[{message:{content:JSON.stringify({operations:[]})}}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}}}));
    const detector=createServerInstructionDetector({providerId,model:'kimi-k3'},reg,async()=>{},transport);
    expect(await detector.detect(input)).toEqual({ok:true,operations:[]});
    const body=(transport.mock.calls[0] as unknown as [string,Record<string,unknown>])[1];
    expect(body).toMatchObject({model:'kimi-k3',max_completion_tokens:512,tools:[],tool_choice:'none'});
  });
  it('rejects unsupported or untrusted configuration before dispatch',()=>{
    const transport=vi.fn();
    expect(()=>createServerInstructionDetector({providerId:'unknown',model:'x'},registry(),async()=>{},transport)).toThrow('Unsupported server provider');
    expect(()=>createServerInstructionDetector({providerId:'openai',model:'not-a-model'},registry(),async()=>{},transport)).toThrow('Unsupported server model');
    expect(()=>createServerInstructionDetector({...config,apiKey:'placeholder'} as typeof config,registry(),async()=>{},transport)).toThrow('Invalid server provider configuration');
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([404,401,429,503])('sanitizes provider or credential failure %i',async status=>{
    const meters:RequestMeter[]=[];
    const detector=createServerInstructionDetector(config,registry(),async meter=>{meters.push(meter);},async()=>({status,body:{error:'internal sensitive detail'}}));
    const result=await detector.detect(input);
    expect(result).toEqual({ok:false,error:{code:'EXECUTION_FAILED'}});
    expect(meters.every(meter=>meter.requestKind==='extraction')).toBe(true);
    expect(JSON.stringify({result,meters})).not.toContain('internal sensitive detail');
  });
  it('rejects malformed provider responses and malformed detector JSON',async()=>{
    const malformed=createServerInstructionDetector(config,registry(),async()=>{},async()=>({status:200,body:{output:[{type:'message'}]}}));
    expect(await malformed.detect(input)).toEqual({ok:false,error:{code:'EXECUTION_FAILED'}});
    const invalidJson=createServerInstructionDetector(config,registry(),async()=>{},async()=>({status:200,body:openaiResponse('{')}));
    expect(await invalidJson.detect(input)).toEqual({ok:false,error:{code:'INVALID_JSON'}});
  });
});
