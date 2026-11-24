import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionChat } from './week2-agent-tool-lab';
import { createManagerConversation } from './manager-agent';
import { createBuiltInToolRegistry } from './tool-runtime';
import { ProviderRegistry } from './provider-registry';

it('renders Week 3 full-context chat without the Week 2 strategy selector',()=>{
  const conversation=createManagerConversation();conversation.conversation.fullContext=true;
  const html=renderToStaticMarkup(<SessionChat week3 initialConversation={conversation} title="Week 3" toolRegistry={createBuiltInToolRegistry()} registry={new ProviderRegistry()} openAIModel="gpt-5.6-terra" onOpenAIModelChange={()=>{}} openAIKey="" openCodeKeys={{'opencode-console':'','opencode-go':''}} />);
  expect(html).toContain('Week 3 conversation history');
  expect(html).toContain('Session stats');
  expect(html).not.toContain('aria-label="Context strategy"');
});

it('offers session MCP selection below the active chat title only in Week 4',()=>{
  const props={initialConversation:createManagerConversation(),title:"Session placement fixture",toolRegistry:createBuiltInToolRegistry(),
    registry:new ProviderRegistry(),openAIModel:"gpt-5.6-terra",onOpenAIModelChange:()=>{},openAIKey:"",openCodeKeys:{"opencode-console":"","opencode-go":""}};
  for(const flags of [{week3:true},{week3:false,week4:true},{week3:true,week4:true,active:false}])
    expect(renderToStaticMarkup(<SessionChat {...props} {...flags}/>)).not.toContain('Add Tools');
  const html=renderToStaticMarkup(<SessionChat {...props} week3 week4/>);
  const title=html.indexOf(">Session placement fixture<"), tools=html.indexOf(">Add Tools<");
  expect(title).toBeGreaterThan(-1);
  expect(tools).toBeGreaterThan(title);
  expect(html.indexOf("Start a conversation.")).toBeGreaterThan(tools);
});
