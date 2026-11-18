import { describe, expect, it, vi } from 'vitest';
import { createSemanticAssessor, parseSemanticRecommendation, type SemanticAssessorInput } from './semantic-assessor';

const input:SemanticAssessorInput={candidate:'The meeting is at 16:00.',existingTopics:[{key:'Meeting',value:'13:00',status:'confirmed',revision:1}],context:[{id:'m1',role:'user',sequence:1,content:'The meeting is at 16:00.'}]};
describe('isolated semantic assessor contract',()=>{
  it.each([
    {action:'ADD',proposedContent:'New topic',reason:'New information'},
    {action:'UPDATE',targetKey:'Meeting',proposedContent:'16:00',reason:'New time'},
    {action:'DUPLICATE',targetKey:'Meeting',reason:'Already represented'},
    {action:'SKIP',reason:'Not meaningful'},
  ])('accepts a valid $action recommendation',async recommendation=>{
    const assessor=createSemanticAssessor(async()=>JSON.stringify(recommendation));
    expect(await assessor.assess(input)).toEqual({ok:true,recommendation});
  });
  it('rejects invalid action, missing fields, malformed JSON and unknown targets',()=>{
    expect(parseSemanticRecommendation(input,'{')).toEqual({ok:false,error:{code:'INVALID_JSON'}});
    expect(parseSemanticRecommendation(input,JSON.stringify({action:'DELETE',reason:'x'}))).toMatchObject({ok:false,error:{code:'INVALID_RESPONSE',field:'action'}});
    expect(parseSemanticRecommendation(input,JSON.stringify({action:'ADD',reason:'x'}))).toMatchObject({ok:false,error:{code:'INVALID_RESPONSE',field:'proposedContent'}});
    expect(parseSemanticRecommendation(input,JSON.stringify({action:'SKIP'}))).toMatchObject({ok:false,error:{code:'INVALID_RESPONSE',field:'reason'}});
    for(const targetKey of [undefined,'','Other'])expect(parseSemanticRecommendation(input,JSON.stringify({action:'UPDATE',targetKey,proposedContent:'16:00',reason:'x'}))).toMatchObject({ok:false,error:{code:'INVALID_TARGET'}});
  });
  it('rejects conflicting fields and multiple recommendations',()=>{
    for(const value of [{action:'SKIP',targetKey:'Meeting',reason:'x'},{action:'ADD',targetKey:'Meeting',proposedContent:'x',reason:'x'},{action:'DUPLICATE',targetKey:'Meeting',proposedContent:'x',reason:'x'},[{action:'SKIP',reason:'x'},{action:'ADD',proposedContent:'x',reason:'x'}]])expect(parseSemanticRecommendation(input,JSON.stringify(value))).toMatchObject({ok:false,error:{code:'INVALID_RESPONSE'}});
  });
  it('rejects an empty candidate before execution and sanitizes execution failures',async()=>{
    const producer=vi.fn(async()=>{throw Error('provider detail');});const assessor=createSemanticAssessor(producer);
    expect(await assessor.assess({...input,candidate:'  '})).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});expect(producer).not.toHaveBeenCalled();
    expect(await assessor.assess(input)).toEqual({ok:false,error:{code:'EXECUTION_FAILED'}});
  });
  it('rejects malformed context and case-equivalent catalog keys before execution',async()=>{
    const producer=vi.fn(async()=>'{"action":"SKIP","reason":"test"}');const assessor=createSemanticAssessor(producer);
    expect(await assessor.assess({...input,existingTopics:[...input.existingTopics,{...input.existingTopics[0],key:'meeting'}]})).toMatchObject({ok:false,error:{code:'INVALID_INPUT',field:'existingTopics'}});
    expect(await assessor.assess({...input,context:[{...input.context[0],sequence:0}]})).toMatchObject({ok:false,error:{code:'INVALID_INPUT',field:'context'}});
    expect(producer).not.toHaveBeenCalled();
  });
  it('does not mutate caller data even if the response producer does',async()=>{
    const original=structuredClone(input);const assessor=createSemanticAssessor(async copy=>{(copy.existingTopics[0] as {value:string}).value='changed';return JSON.stringify({action:'SKIP',reason:'test'});});
    expect(await assessor.assess(input)).toMatchObject({ok:true});expect(input).toEqual(original);
  });
});
