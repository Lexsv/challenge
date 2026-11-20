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
