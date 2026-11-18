import { createSavedProviderTransport } from './credentials.mjs';
import { createServerManagerLlmAdapter } from './manager-llm-adapter.ts';
import { createInstructionDetector } from '../src/persistent-instruction-detector.ts';
import type { ProviderRegistry } from '../src/provider-registry.ts';
import type { RequestMeter } from '../src/token-meter.ts';

type Transport = (provider:string,body:Record<string,unknown>)=>Promise<{status:number;body:unknown}>;
const OUTPUT_TOKEN_LIMIT=512;

// Strict Responses API schema; local validation remains authoritative for grounding and edits.
const operationSchema = (action:'ADD'|'UPDATE'|'REMOVE') => {
  const properties:Record<string,unknown> = {action:{type:'string',enum:[action]},sourceQuote:{type:'string'}};
  if (action!=='ADD') properties.targetLine={type:'string'};
  if (action!=='REMOVE') properties.newInstruction={type:'string'};
  return {type:'object',properties,required:Object.keys(properties),additionalProperties:false};
};
const responseFormat = {type:'json_schema',name:'persistent_instruction_operations',strict:true,schema:{
  type:'object',properties:{operations:{type:'array',items:{anyOf:['ADD','UPDATE','REMOVE'].map(action=>operationSchema(action as 'ADD'|'UPDATE'|'REMOVE'))}}},
  required:['operations'],additionalProperties:false,
}};

/** Server-owned configuration only; do not construct this from a browser payload. */
export function createServerInstructionDetector(
  config:{providerId:string;model:string},
  registry:ProviderRegistry,
  onMeter:(meter:RequestMeter)=>Promise<void>,
  transport:Transport=createSavedProviderTransport(),
) {
  if (typeof onMeter!=='function') throw new Error('Detector metering is required.');
  const adapter=createServerManagerLlmAdapter(config,registry,(provider,body)=>transport(provider,{
    ...body,
    ...(provider==='openai' ? {max_output_tokens:OUTPUT_TOKEN_LIMIT,text:{format:responseFormat}} : {max_completion_tokens:OUTPUT_TOKEN_LIMIT}),
  }));
  return createInstructionDetector(adapter,onMeter);
}
