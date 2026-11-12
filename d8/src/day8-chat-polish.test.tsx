import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeProvider } from '@mui/material';
import { theme } from './theme';
import { SessionRow } from './session-row';
import { ChatRunLog } from './chat-run-log';
import { CredentialFeedback, CredentialIndicator } from './credential-indicator';
import { ProviderStatus } from './provider-status';
import { SessionChat } from './week2-agent-tool-lab';
import { createManagerConversation } from './manager-agent';
import { ProviderRegistry } from './provider-registry';
import { createBuiltInToolRegistry } from './tool-runtime';

it('ellipsizes an unbroken sidebar title while retaining its full accessible name and action', () => {
  const title = 'UnbrokenSessionTitle'.repeat(10);
  const html = renderToStaticMarkup(<SessionRow id="long" title={title} selected menuOpen={false}
    disabled={false} onSelect={() => {}} onActions={() => {}} />);
  expect(html).toContain('white-space:nowrap');
  expect(html).toContain('text-overflow:ellipsis');
  expect(html).toContain(`title="${title}"`);
  expect(html).toContain(`aria-label="Actions for ${title}"`);
});

it('renders the entire unbroken header title separately from the fixed icon group', () => {
  const title = 'UnbrokenSessionTitle'.repeat(10);
  const html = renderToStaticMarkup(<SessionChat initialConversation={createManagerConversation()}
    title={title} toolRegistry={createBuiltInToolRegistry()} registry={new ProviderRegistry()}
    openAIModel="gpt-5.6-terra" onOpenAIModelChange={() => {}} openAIKey=""
    openCodeKeys={{ 'opencode-console': '', 'opencode-go': '' }} />);
  expect(html).toMatch(new RegExp(`<h3[^>]*>${title}</h3>`));
  expect(html).toContain('overflow-wrap:anywhere');
  expect(html).toContain('flex-shrink:0');
  expect(html.indexOf(title)).toBeLessThan(html.indexOf('aria-label="Session stats"'));
  expect(html.indexOf('aria-label="Session stats"')).toBeGreaterThan(html.indexOf('aria-label="Open chat settings"'));
    expect(html).not.toContain('aria-haspopup="dialog"');
    expect(html).toContain('minmax(0, 1fr) 430px');
});

it('uses the selected-session blue for user bubbles and leaves agent replies plain', () => {
  const message = { kind: 'message' as const, id: 'user', runId: 'run', createdAt: 1,
    role: 'user' as const, text: 'Question' };
  const render = (role: 'user' | 'assistant') => renderToStaticMarkup(<ThemeProvider theme={theme}>
    <ChatRunLog events={[{ ...message, role }]} />
  </ThemeProvider>);
  expect(render('user')).toContain(`background-color:${theme.palette.action.selected}`);
  expect(render('user')).toContain('border:1px solid');
  expect(render('user')).toContain('text-align:left');
  expect(render('assistant')).not.toContain(`background-color:${theme.palette.action.selected}`);
  expect(render('assistant')).not.toContain('border:1px solid');
});

it('restores Day 7 green and neutral credential colors in both status renderers', () => {
  for (const verified of [true, false]) {
    const status = { saved: verified, verification: verified ? 'verified' as const : 'unchecked' as const };
    for (const content of [<ProviderStatus verification="unverified" savedStatus={status} />,
      <CredentialIndicator status={status} showProvider={false} />]) {
      const html = renderToStaticMarkup(<ThemeProvider theme={theme}>{content}</ThemeProvider>);
      expect(html).toContain(verified ? 'background-color:#2e7d32' : 'background-color:transparent');
      expect(html).toContain(verified ? 'color:#fff' : 'color:#1F2937');
    }
  }
});

it('distinguishes temporary failure from rejection without exposing arbitrary reason text', () => {
  const transient = renderToStaticMarkup(<CredentialFeedback status={{ saved: false, verification: 'retryable', reason: 'http-503' }} />);
  expect(transient).toContain('temporarily unavailable');
  expect(transient).toContain('No new key was saved');
  expect(transient).not.toContain('rejected');
  const rejected = renderToStaticMarkup(<CredentialFeedback status={{ saved: true, verification: 'not-authorized', reason: 'placeholder-private-reason' }} />);
  expect(rejected).toContain('provider rejected this key');
  expect(rejected).toContain('saved key has not been replaced');
  expect(rejected).not.toContain('placeholder-private-reason');
});
