import type { Attempt, Settings } from './models';
import { parseOpenAIResponses, parseOpenAIChatCompletions } from './manager-llm-adapter';
import { parameterPayload } from './api-parameters';

/** Use the local saved-key proxy without ever exposing the key to the browser. */
export async function executeWithSavedProvider(provider: string, settings: Settings, instructions: string, input: string, schema?: object): Promise<Omit<Attempt, 'id'>> {
  const started = performance.now();
  if (!['openai', 'opencode-console', 'opencode-go'].includes(provider)) return {status:'failed',text:'',error:'Saved credentials are unavailable for this provider.',ms:0};
  try {
    const params = settings.parameters ? parameterPayload(settings.parameters) : {};
    if (['model','store','instructions','input','messages','text','response_format','tools','tool_choice','max_completion_tokens','reasoning'].some(name => Object.hasOwn(params,name))) throw new Error('Parameter conflicts with managed request fields.');
    const {max_output_tokens,reasoning_effort,...parameters} = params;
    if (reasoning_effort !== undefined && settings.reasoning) throw new Error('Conflicting reasoning settings.');
    const body = provider === 'openai'
      ? {model:settings.model, instructions, input, parameters, ...(reasoning_effort !== undefined || settings.reasoning ? {reasoning:{effort:reasoning_effort ?? settings.reasoning}} : {}), max_output_tokens:max_output_tokens ?? settings.maxTokens, ...(schema ? {text:{format:{type:'json_schema',name:'lab_output',strict:true,schema}}} : {})}
      : {model:settings.model, messages:[{role:'system',content:instructions},{role:'user',content:input}],parameters:{...parameters,...(reasoning_effort !== undefined ? {reasoning_effort} : {})},max_completion_tokens:max_output_tokens ?? settings.maxTokens,...(schema ? {response_format:{type:'json_schema',json_schema:{name:'lab_output',strict:true,schema}}} : {})};
    const response = await fetch(`/api/credentials/${provider}/request`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if (!response.ok) return {status:'failed',text:'',error:`Saved provider request failed (${response.status}).`,ms:performance.now()-started};
    const data: unknown = await response.json();
    const result = data as {status?:string; choices?:{finish_reason?:string}[]; usage?:{input_tokens?:number;output_tokens?:number;prompt_tokens?:number;completion_tokens?:number}};
    if (result.status === 'incomplete' || result.choices?.some(choice => choice.finish_reason === 'length')) return {status:'incomplete',text:'',error:'The provider response was incomplete. Please retry.',ms:performance.now()-started};
    const text = (provider === 'openai' ? parseOpenAIResponses(data) : parseOpenAIChatCompletions(data)).text ?? '';
    if (!text.trim()) return {status:'failed',text:'',error:'The provider returned no response text.',ms:performance.now()-started};
    const usage = result.usage ? {input:result.usage.input_tokens ?? result.usage.prompt_tokens,output:result.usage.output_tokens ?? result.usage.completion_tokens} : undefined;
    return {status:'succeeded',text,usage,ms:performance.now()-started};
  } catch { return {status:'failed',text:'',error:'Saved provider request could not complete. Check settings and retry.',ms:performance.now()-started}; }
}
