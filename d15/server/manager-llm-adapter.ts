import {verifyProposalFormat,strictProposalFormat} from "./memory-proposal-provider.ts";
import { createSavedProviderTransport } from './credentials.mjs';
import { createManagerLlmAdapter, parseOpenAIResponses, parseOpenAIChatCompletions, type ProviderId } from '../src/manager-llm-adapter.ts';
import { DEFAULT_ENDPOINTS } from '../src/provider-endpoints.ts';
import type { ProviderRegistry } from '../src/provider-registry';
import type { ManagerLlmAdapter } from '../src/manager-agent';

type InternalTransport = (provider:string,request:Record<string,unknown>)=>Promise<{status:number;body:unknown}>;

/** Configuration and dependencies must originate from trusted server code, never a memory request. */
export function createServerManagerLlmAdapter(
  config:{providerId:string;model:string},
  registry:ProviderRegistry,
  transport:InternalTransport=createSavedProviderTransport(),
  requestTokenLimit?:number,
):ManagerLlmAdapter {
  if (!config || Object.keys(config).some(key=>key!=='providerId' && key!=='model')) throw new Error('Invalid server provider configuration.');
  const {providerId,model}=config;
  if (!['openai','opencode-console','opencode-go'].includes(providerId)) throw new Error('Unsupported server provider.');
  const provider=providerId as ProviderId;
  if (typeof model!=='string' || !model.trim() || !registry.get(provider) || !registry.modelOptionsFor(provider).includes(model)) throw new Error('Unsupported server model.');
  if(registry.endpointFor(provider)!==DEFAULT_ENDPOINTS[provider])throw new Error('Server provider requires the fixed endpoint.');
  return createManagerLlmAdapter({proposalFormat:async()=>await verifyProposalFormat(provider,model,transport) ? strictProposalFormat(provider) : {},providerId:provider,model,apiKey:'',registry,requestTokenLimit,transport:async(id,body)=>{
    const result=await transport(id,body);
    if(result.status===200){
      const value=result.body;
      if(!value || typeof value!=='object' || Array.isArray(value) || (id==='openai' ? !Array.isArray((value as {output?:unknown}).output) : !Array.isArray((value as {choices?:unknown}).choices)))throw new Error('Malformed provider response.');
      const parsed=id==='openai'?parseOpenAIResponses(value):parseOpenAIChatCompletions(value);
      if(!parsed.text && !parsed.toolCalls?.length)throw new Error('Malformed provider response.');
    }
    return result;
  }});
}
