import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionServer } from '../server/sessions.mjs';
import { createManagerLlmAdapter } from './manager-llm-adapter';
import { ManagerAgent, createManagerConversation } from './manager-agent';
import { createBuiltInToolRegistry } from './tool-runtime';
import { ProviderRegistry } from './provider-registry';

it.each([false, true])('uses Console Chat Completions schemas after switching providers with retained history (saved key: %s)', async (useSavedKey) => {
  const folder = await mkdtemp(join(tmpdir(), 'd7-console-schema-'));
  const store = {
    status: vi.fn(async () => true),
    read: vi.fn(async (provider: string) => `placeholder-${provider}-key`),
    save: vi.fn(async () => {}), forget: vi.fn(async () => {}),
  };
  const requests: { url: string; body: Record<string, any>; headers: Headers }[] = [];
  let consoleCalls = 0;
  const upstream = vi.fn<typeof fetch>(async (url, init) => {
    const body = JSON.parse(init!.body as string);
    requests.push({ url: String(url), body, headers: new Headers(init?.headers) });
    if (String(url) === 'https://api.openai.com/v1/responses') {
      // The existing Responses format stays flat. Reject an accidental migration to Chat format.
      if (!body.tools.every((tool: any) => tool.type === 'function' && tool.name && tool.parameters && !tool.function)) return new Response('{}', { status: 400 });
      return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'OpenAI previous answer: total 110.' }] }] }));
    }
    // Reproduces the provider's 400 for flat Responses-style function definitions.
    if (!body.tools.every((tool: any) => tool.type === 'function' && tool.function?.name && tool.function.parameters && !tool.name && !tool.parameters)) return new Response('{}', { status: 400 });
    consoleCalls++;
    return new Response(JSON.stringify({ choices: [{ message: consoleCalls === 1
      ? { tool_calls: [{ id: 'console-tax-call', type: 'function', function: { name: 'builtin_tax_calculator', arguments: JSON.stringify({ amount: 100, taxRate: 10 }) } }] }
      : { content: 'Console answer: total 110.' } }] }));
  });
  const server = createSessionServer(join(folder, 'sessions.sqlite'), { credentialStore: store, fetcher: upstream });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;
    const browserRequests: { url: string; body: Record<string, any>; headers: Headers }[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      browserRequests.push({ url: String(url), body: JSON.parse(init!.body as string), headers: new Headers(init?.headers) });
      if (String(url).startsWith('/api/credentials/')) return fetch(`${base}${url}`, { ...init, headers: { ...init?.headers, Origin: base } });
      return upstream(url, init);
    });
    const registry = new ProviderRegistry();
    registry.setEndpoint('openai', 'https://api.openai.com/v1/responses', true);
    registry.setEndpoint('opencode-console', 'https://opencode.ai/inference/openai/v1/chat/completions', true);
    const tools = createBuiltInToolRegistry();
    const execute = vi.spyOn(tools, 'executeById');
    const state = createManagerConversation();
    const originalId = state.conversation.id;
    const question = 'Apply 10% tax to 100.';
    const openai = createManagerLlmAdapter({ providerId: 'openai', model: 'gpt-5.6-terra', apiKey: useSavedKey ? '' : 'placeholder-openai-key', useSavedKey, registry, fetcher });
    expect((await new ManagerAgent(openai, tools).run({ state, userText: question })).run.status).toBe('completed');
    // SessionChat constructs a fresh adapter per Send from the newly selected provider/model,
    // while retaining the same conversation state.
    const consoleAdapter = createManagerLlmAdapter({ providerId: 'opencode-console', model: 'gpt-6-luna', apiKey: useSavedKey ? '' : 'placeholder-opencode-console-key', useSavedKey, registry, fetcher });
    const result = await new ManagerAgent(consoleAdapter, tools).run({ state, userText: question });
    expect(result.error).toBeUndefined();
    expect(result.run.status).toBe('completed');
    expect(state.conversation.id).toBe(originalId);
    expect(requests).toHaveLength(3);
    const executable = tools.listBuiltIn().filter((tool) => tool.executable);
    expect(requests[0].body.tools).toEqual(executable.map((tool) => ({ type: 'function', name: tool.id.replaceAll('.', '_'), description: tool.description, parameters: tool.inputSchema })));
    for (const request of requests.slice(1)) {
      expect(request.url).toBe('https://opencode.ai/inference/openai/v1/chat/completions');
      expect(request.body.model).toBe('gpt-6-luna');
      expect(request.body.input).toBeUndefined();
      expect(request.body.tools).toEqual(executable.map((tool) => ({ type: 'function', function: { name: tool.id.replaceAll('.', '_'), description: tool.description, parameters: tool.inputSchema } })));
    }
    expect(requests[1].body.messages).toEqual([
      { role: 'user', content: question }, { role: 'assistant', content: 'OpenAI previous answer: total 110.' }, { role: 'user', content: question },
    ]);
    expect(requests[2].body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'console-tax-call', name: 'builtin_tax_calculator' });
    expect(execute).toHaveBeenCalledExactlyOnceWith('builtin.tax_calculator', { amount: 100, taxRate: 10 });
    if (useSavedKey) {
      expect(browserRequests.map((request) => request.url)).toEqual(['/api/credentials/openai/request', '/api/credentials/opencode-console/request', '/api/credentials/opencode-console/request']);
      expect(browserRequests.every((request) => !request.headers.has('Authorization'))).toBe(true);
      expect(JSON.stringify(browserRequests)).not.toContain('placeholder-');
      expect(requests[1].headers.get('Authorization')).toBe('Bearer placeholder-opencode-console-key');
      expect(store.read.mock.calls.map(([provider]) => provider)).toEqual(['openai', 'opencode-console', 'opencode-console']);
    } else expect(store.read).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(folder, { recursive: true, force: true });
  }
});
