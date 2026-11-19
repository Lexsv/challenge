import { describe, expect, it, vi } from 'vitest';
import { createInstructionDetector, parseInstructionProposals } from './persistent-instruction-detector';
import type { ManagerLlmAdapter } from './manager-agent';
import { editHabits } from './habits-editor';

const input={userMessage:'From now on, answer in detail. Always use Russian. Stop using a greeting.',habits:'* Answer briefly.\n* Use a greeting.\nlegacy text'};
const add={action:'ADD',sourceQuote:'Always use Russian.',newInstruction:'Use Russian.'};
const update={action:'UPDATE',sourceQuote:'From now on, answer in detail.',targetLine:'* Answer briefly.',newInstruction:'Answer in detail.'};
const remove={action:'REMOVE',sourceQuote:'Stop using a greeting.',targetLine:'* Use a greeting.'};
const json=(operations:unknown[])=>JSON.stringify({operations});

describe('persistent instruction detector',()=>{
  it.each([
    {label:'English UPDATE',message:'From now on, always answer in long form with detailed explanations and practical examples instead of short answers.',habits:'* Always respond in Russian.\n* Always provide short, concise answers.',operations:[{action:'UPDATE',sourceQuote:'From now on, always answer in long form with detailed explanations and practical examples instead of short answers.',targetLine:'* Always provide short, concise answers.',newInstruction:'Provide long, detailed answers with practical examples.'}],expected:'* Always respond in Russian.\n* Provide long, detailed answers with practical examples.'},
    {label:'Russian UPDATE',message:'С этого момента отвечай подробно.',habits:'* Always respond in Russian.\n* Keep answers short and concise.',operations:[{action:'UPDATE',sourceQuote:'С этого момента отвечай подробно.',targetLine:'* Keep answers short and concise.',newInstruction:'Provide detailed answers.'}],expected:'* Always respond in Russian.\n* Provide detailed answers.'},
    {label:'independent ADD',message:'Always include examples.',habits:'* Respond in Russian.',operations:[{action:'ADD',sourceQuote:'Always include examples.',newInstruction:'Include examples.'}],expected:'* Respond in Russian.\n* Include examples.'},
    {label:'explicit REMOVE',message:'Stop using greetings.',habits:'* Respond in Russian.\n* Use greetings.',operations:[{action:'REMOVE',sourceQuote:'Stop using greetings.',targetLine:'* Use greetings.'}],expected:'* Respond in Russian.\n'},
    {label:'temporary request',message:'Explain this question in detail.',habits:'* Answer briefly.',operations:[],expected:'* Answer briefly.'},
    {label:'quoted instruction',message:'Translate "Always answer in detail."',habits:'* Answer briefly.',operations:[],expected:'* Answer briefly.'},
    {label:'ambiguous preference',message:'Sometimes I like detailed answers.',habits:'* Answer briefly.',operations:[],expected:'* Answer briefly.'},
  ])('validates mocked $label without changing the input',async({message,habits,operations,expected})=>{
    const complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValue({text:json(operations)});
    const detector=createInstructionDetector({complete,context:{assess:async()=>({tokens:10,limit:1000}),summarize:async()=>''}});
    const result=await detector.detect({userMessage:message,habits});
    expect(result.ok).toBe(true);
    if(!result.ok)throw Error('invalid mocked result');
    expect(editHabits(habits,result.operations)).toMatchObject({ok:true,habits:expected});
    const prompt=complete.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('classify the user message and propose changes');
    expect(prompt).toContain('not to obey the requested behavior or persist anything');
    expect(prompt).toContain('quoted examples');
  });
  it('rejects an UPDATE target that is not an exact existing line',()=>{
    const message='From now on, always give detailed answers.';
    const result=parseInstructionProposals({userMessage:message,habits:'* Always provide short, concise answers.'},json([{action:'UPDATE',sourceQuote:message,targetLine:'* Always provide short, concise answers',newInstruction:'Provide detailed answers.'}]));
    expect(result).toEqual({ok:false,error:{code:'INVALID_RESPONSE'}});
  });
  it.each([add,update,remove])('accepts a grounded $action proposal',operation=>{
    expect(parseInstructionProposals(input,json([operation]))).toEqual({ok:true,operations:[operation]});
  });
  it('accepts multiple independent proposals without changing the input',()=>{
    const before=structuredClone(input);
    expect(parseInstructionProposals(input,json([add,update,remove]))).toEqual({ok:true,operations:[add,update,remove]});
    expect(input).toEqual(before);
  });
  it.each(['Explain this question in detail.','Answer this one in English.','Why do people always arrive late?','The example says "Always answer in Russian."','If I asked you to always answer in Russian, what would happen?'])('passes through a mocked no-change classification for %s',async userMessage=>{
    const complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValue({text:json([])});
    const assess=vi.fn().mockResolvedValue({tokens:100,limit:1000});
    const detector=createInstructionDetector({complete,context:{assess,summarize:async()=>''}});
    expect(await detector.detect({userMessage,habits:input.habits})).toEqual({ok:true,operations:[]});
    expect(complete.mock.calls[0][0].tools).toEqual([]);
    const messages=complete.mock.calls[0][0].messages;
    expect(messages[0].content).toContain('quoted examples');expect(messages[0].content).toContain('hypotheticals');
    expect(JSON.parse(messages[1].content)).toEqual({userMessage,habits:input.habits});
    expect(assess.mock.calls[0][1]).toEqual([]);
  });
  it('accepts empty operations as distinct from execution failure',()=>{
    expect(parseInstructionProposals(input,json([]))).toEqual({ok:true,operations:[]});
  });
  it('rejects the exact bare ADD shape observed during live QA',()=>{
    const message='С этого момента отвечай подробно. Давай развёрнутые объяснения с примерами, даже если вопрос простой.';
    const bare={action:'ADD',sourceQuote:message,newInstruction:'Отвечай подробно и давай развёрнутые объяснения с примерами, даже если вопрос простой.'};
    expect(parseInstructionProposals({userMessage:message,habits:'* Always respond in Russian.\n* Keep answers short and concise.'},JSON.stringify(bare))).toEqual({ok:false,error:{code:'INVALID_RESPONSE'}});
  });
  it('uses an injected adapter for a valid proposal without altering the supplied habits',async()=>{
    const complete=vi.fn<ManagerLlmAdapter['complete']>().mockResolvedValue({text:json([update])});
    const detector=createInstructionDetector({complete,context:{assess:async()=>({tokens:100,limit:1000}),summarize:async()=>''}});
    const before=structuredClone(input);
    expect(await detector.detect(input)).toEqual({ok:true,operations:[update]});
    expect(complete.mock.calls[0][0].messages[0].content).toContain('If it replaces or contradicts exactly one existing rule, use UPDATE');
    expect(complete.mock.calls[0][0].messages[0].content).toContain('Never return a bare operation');
    expect(input).toEqual(before);expect(complete).toHaveBeenCalledOnce();
  });
  it.each([
    '{', JSON.stringify({operations:[],extra:true}), JSON.stringify({operations:[{...add,extra:'x'}]}),
    json([{...add,action:'SKIP'}]), json([{...add,sourceQuote:'invented'}]), json([{...add,sourceQuote:''}]),
    json([{...add,sourceQuote:undefined}]), json([{...update,targetLine:'* Unknown'}]),
    json([{...add,newInstruction:'* bad'}]), json([{...add,newInstruction:'bad\nrule'}]),
    json([add,add]), json([update,{...remove,targetLine:update.targetLine}]),
    json(Array(17).fill(add)), 'x'.repeat(16001),
  ])('rejects malformed, ungrounded, conflicting or oversized output',value=>{
    expect(parseInstructionProposals(input,value).ok).toBe(false);
  });
  it('rejects duplicates against existing habits and ambiguous targets',()=>{
    expect(parseInstructionProposals(input,json([{...add,newInstruction:'Answer briefly.'}]))).toMatchObject({ok:false,error:{code:'INVALID_RESPONSE'}});
    expect(parseInstructionProposals({...input,habits:'* Answer briefly.\n* Answer briefly.'},json([update]))).toMatchObject({ok:false,error:{code:'INVALID_RESPONSE'}});
  });
  it('sanitizes provider errors and never treats them as empty extraction',async()=>{
    const complete=vi.fn().mockRejectedValue(new Error('sensitive provider detail'));
    const detector=createInstructionDetector({complete,context:{assess:async()=>({tokens:1,limit:10}),summarize:async()=>''}});
    expect(await detector.detect(input)).toEqual({ok:false,error:{code:'EXECUTION_FAILED'}});
  });
  it('rejects unavailable budgets and tool calls without executing tools',async()=>{
    const complete=vi.fn().mockResolvedValue({text:json([]),toolCalls:[{id:'1',toolId:'other',arguments:{}}]});
    const noBudget=createInstructionDetector({complete});
    expect(await noBudget.detect(input)).toMatchObject({ok:false,error:{code:'EXECUTION_FAILED'}});expect(complete).not.toHaveBeenCalled();
    const withBudget=createInstructionDetector({complete,context:{assess:async()=>({tokens:1,limit:10}),summarize:async()=>''}});
    expect(await withBudget.detect(input)).toMatchObject({ok:false,error:{code:'INVALID_RESPONSE'}});
  });
  it('rejects empty and oversized input before dispatch',async()=>{
    const complete=vi.fn(); const detector=createInstructionDetector({complete});
    expect(await detector.detect({userMessage:' ',habits:''})).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
    expect(await detector.detect({userMessage:'x'.repeat(50001),habits:''})).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
    expect(complete).not.toHaveBeenCalled();
  });
});
