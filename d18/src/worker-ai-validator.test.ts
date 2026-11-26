import { describe, expect, it, vi } from 'vitest';
import { createWorkerAiValidator, parseWorkerEvaluation, type WorkerEvaluationContext } from '../server/worker-ai-validator';
import { createProviderRegistry } from './provider-registry';

const context:WorkerEvaluationContext={sessionId:'session-1',revision:4,snapshot:{id:'template-1',name:'Worker',description:'Two steps',rules:'Apply the supplied criteria.',version:1,document:{schemaVersion:1,steps:[{id:'q1',type:'question',prompt:'Which language?',options:[{id:'a',text:'Java'},{id:'b',text:'Rust'}]},{id:'s2',type:'action',prompt:'Inspect production'}]}},results:[{stepId:'q1',result:'Rust',criteria:'Rust is correct.'},{stepId:'s2',result:'Beans checked and sound.',criteria:'Beans must be checked and sound.'}]};
const good={evaluable:true,success:true,reason:'Both tasks were completed accurately.',errorCount:0,findings:[{stepId:'q1',passed:true,reason:'Correct language.',evidence:'Rust'},{stepId:'s2',passed:true,reason:'Inspection completed.',evidence:'Beans checked and sound.'}]};
const response=(text:string)=>({output:[{type:'message',content:[{type:'output_text',text}]}]});
const registry=()=>createProviderRegistry(undefined,{}, {catalogStorage:()=>undefined});
const config={providerId:'openai',model:'gpt-5.6-terra'};
const current=async()=>true;

describe('trusted Worker evaluator',()=>{
 it('uses the server adapter, bounded structured output and no tools',async()=>{
  const transport=vi.fn(async()=>({status:200,body:response(JSON.stringify(good))}));
  const result=await createWorkerAiValidator(config,registry(),{isCurrent:current,transport}).evaluate(context);
  expect(result).toEqual({ok:true,evaluation:{success:true,reason:good.reason,errorCount:0,findings:good.findings}});
  const [provider,body]=transport.mock.calls[0] as unknown as [string,Record<string,unknown>];
  expect(provider).toBe('openai');expect(body).toMatchObject({model:config.model,tools:[],tool_choice:'none',max_output_tokens:2048,text:{format:{type:'json_schema',strict:true}}});
  expect(JSON.stringify(body)).not.toContain('Authorization');
 });
 it('returns a failure assessment with detailed per-step evidence',()=>{
  const bad={...good,success:false,reason:'The inspection was incomplete.',errorCount:1,findings:[good.findings[0],{...good.findings[1],passed:false,reason:'The record lacks a complete inspection.'}]};
  expect(parseWorkerEvaluation(context,JSON.stringify(bad))).toMatchObject({ok:true,evaluation:{success:false,errorCount:1,reason:bad.reason}});
 });
 it.each([
  ['{','invalid_json'],
  [JSON.stringify({...good,success:'true'}),'invalid_response'],
  [JSON.stringify({...good,reason:''}),'invalid_response'],
  [JSON.stringify({...good,errorCount:1}),'invalid_response'],
  [JSON.stringify({...good,findings:[good.findings[0]]}),'invalid_response'],
  [JSON.stringify({...good,findings:[{...good.findings[0],evidence:'invented'},good.findings[1]]}),'invalid_response'],
  [JSON.stringify({...good,findings:[{...good.findings[0],stepId:'wrong'},good.findings[1]]}),'invalid_response'],
  [JSON.stringify({...good,evaluable:false}),'insufficient_criteria'],
 ])('rejects malformed or ungrounded responses', (raw,error)=>expect(parseWorkerEvaluation(context,raw)).toEqual({ok:false,error}));
 it('requires exact ordered results and explicit evaluation criteria before provider use',async()=>{
  const transport=vi.fn();const validator=createWorkerAiValidator(config,registry(),{isCurrent:current,transport});
  expect(await validator.evaluate({...context,results:[{...context.results[0],stepId:'wrong'},context.results[1]]})).toEqual({ok:false,error:'invalid_context'});
  expect(await validator.evaluate({...context,results:[{...context.results[0],criteria:''},context.results[1]]})).toEqual({ok:false,error:'insufficient_criteria'});
  expect(transport).not.toHaveBeenCalled();
 });
 it('rejects stale contexts before and after the provider call',async()=>{
  const transport=vi.fn(async()=>({status:200,body:response(JSON.stringify(good))}));
  const stale=vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await createWorkerAiValidator(config,registry(),{isCurrent:stale,transport}).evaluate(context)).toEqual({ok:false,error:'stale_context'});
  expect(stale).toHaveBeenCalledTimes(2);
  expect(await createWorkerAiValidator(config,registry(),{isCurrent:async()=>false,transport}).evaluate(context)).toEqual({ok:false,error:'stale_context'});
  expect(transport).toHaveBeenCalledTimes(1);
 });
 it.each([[401,'authentication_error'],[503,'provider_unavailable']] as const)('sanitizes provider failure %i',async(status,error)=>{
  const result=await createWorkerAiValidator(config,registry(),{isCurrent:current,transport:async()=>({status,body:{secret:'private upstream text'}})}).evaluate(context);
  expect(result).toEqual({ok:false,error});expect(JSON.stringify(result)).not.toContain('private upstream text');
 });
 it('returns controlled timeout without a fabricated verdict',async()=>{
  const validator=createWorkerAiValidator(config,registry(),{isCurrent:current,timeoutMs:5,transport:async()=>new Promise(()=>{})});
  expect(await validator.evaluate(context)).toEqual({ok:false,error:'timeout'});
 });
 it('fails closed on unsupported configuration',async()=>{
  const validator=createWorkerAiValidator({providerId:'unknown',model:'x'},registry(),{isCurrent:current,transport:vi.fn()});
  expect(await validator.evaluate(context)).toEqual({ok:false,error:'configuration_error'});
 });
});
