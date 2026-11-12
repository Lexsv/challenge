import { it, expect, vi, afterEach } from 'vitest';
import { ProviderRegistry } from './provider-registry';
import { estimateNextSessionContext } from './session-stats';
import { createManagerConversation } from './manager-agent';
import { createBuiltInToolRegistry } from './tool-runtime';
afterEach(()=>vi.unstubAllGlobals());
it('uses the explicit session value for every provider/model without inheriting legacy provider storage', async () => {
 vi.stubGlobal('localStorage',{getItem:()=> '9999'});
 const registry=new ProviderRegistry();
 const state=createManagerConversation();
 for (const limit of [1000,0]) {
  for (const [providerId,model] of [['openai','gpt-4o-mini'],['opencode-console','deepseek-v4.1-flash']] as const) {
   const result=await estimateNextSessionContext({state,draft:'Draft',tools:createBuiltInToolRegistry(),providerId,model,registry,requestTokenLimit:limit});
   expect(result.requestTokenLimit).toBe(limit);
  }
 }
});
it('counts empty dialogue as zero independently of draft, tools and full request',async()=>{
 const result=await estimateNextSessionContext({state:createManagerConversation(),draft:'Draft words',tools:createBuiltInToolRegistry(),providerId:'openai',model:'gpt-4o-mini',registry:new ProviderRegistry()});
 expect(result.dialogueTokens).toBe(0);
 expect(result.estimatedInputTokens).toBeGreaterThan(0);
 expect(result.contextWindow).toBeGreaterThan(0);
 expect(result.requestTokenLimit).toBe(0);
});
