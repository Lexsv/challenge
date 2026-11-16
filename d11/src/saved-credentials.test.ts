import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CredentialFeedback, CredentialIndicator } from './credential-indicator';
import { ProviderStatus } from './provider-status';
import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionServer } from '../server/sessions.mjs';
import { createManagerLlmAdapter } from './manager-llm-adapter';
import { ProviderRegistry } from './provider-registry';
import { CredentialController, credentialLabel, type SavedCredentialStatus, type SavedProvider } from './saved-credentials';
import { ManagerAgent } from './manager-agent';
import { createBuiltInToolRegistry } from './tool-runtime';
import { emptySession } from './session-api';
import { restoreHistory, type HistoryEvent } from './conversation-history';
import { buildWeek2Timeline } from './week2-agent-tool-lab';

async function fixture(run: (ctx: {
  call: (provider?: string, action?: string, method?: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
  api: (path: string, method?: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
  restart: () => Promise<void>;
  values: Map<string, string>;
  store: { status: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; forget: ReturnType<typeof vi.fn> };
  upstream: ReturnType<typeof vi.fn<typeof fetch>>;
}) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), 'd7-credentials-'));
  const values = new Map<string, string>();
  const store = {
    status: vi.fn(async (provider: string) => values.has(provider)),
    read: vi.fn(async (provider: string) => values.get(provider)!),
    save: vi.fn(async (provider: string, key: string) => { values.set(provider, key); }),
    forget: vi.fn(async (provider: string) => { values.delete(provider); }),
  };
  const upstream = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { status: 200 }));
  let server: ReturnType<typeof createSessionServer> | undefined;
  let base = '';
  const start = async () => {
    server = createSessionServer(join(folder, 'sessions.sqlite'), { credentialStore: store, fetcher: upstream });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    base = `http://127.0.0.1:${address.port}`;
  };
  const stop = () => new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  const api = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/${path}`, { method, headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const call = (provider = 'openai', action = '', method = 'GET', body?: unknown, headers?: Record<string, string>) => api(`credentials${provider ? `/${provider}` : ''}${action}`, method, body, headers);
  try { await start(); await run({ api, call, restart: async () => { await stop(); await start(); }, values, store, upstream }); }
  finally { if (server?.listening) await stop(); await rm(folder, { recursive: true, force: true }); }
}

it('publishes the same successful OpenAI Verify result to header and dialog after a retryable 503', async () => {
  await fixture(async ({ call, store, upstream }) => {
    const controller = new CredentialController(async (provider, action = '', init) => {
      const response = await call(provider, action, init?.method ?? 'GET', init?.body ? JSON.parse(String(init.body)) : undefined);
      return response.json();
    });
    upstream.mockResolvedValueOnce(new Response('placeholder-private-upstream-body', { status: 503 }));
    const failed = await controller.verify('openai', 'placeholder-review-only');
    expect(failed).toEqual({ saved: false, verification: 'retryable', reason: 'http-503' });
    expect(store.save).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(createElement(CredentialFeedback, { status: failed! }))).toContain('temporarily unavailable');
    expect(upstream.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
    expect(upstream.mock.calls[0][1]?.method).toBe('GET');
    const result = await controller.verify('openai', 'placeholder-review-only');
    expect(result).toEqual({ saved: true, verification: 'verified' });
    expect(store.save).toHaveBeenCalledTimes(1);
    const status = controller.getSnapshot().openai!;
    const header = renderToStaticMarkup(createElement(ProviderStatus, { verification: 'unverified', savedStatus: status }));
    const dialog = renderToStaticMarkup(createElement(CredentialIndicator, { status, showProvider: false }));
    expect(header).toContain('OpenAI · Verified');
    expect(dialog).toContain('>Verified<');
    expect(header + dialog).not.toContain('placeholder-review-only');
    expect(header + dialog).not.toContain('placeholder-private-upstream-body');
  });
});

it('forwards structured generation fields through saved provider requests', async () => {
  await fixture(async ({call,values,upstream}) => {
    values.set('openai','placeholder'); values.set('opencode-console','placeholder');
    const format = {type:'json_schema',name:'lab_output',strict:true,schema:{type:'object'}};
    expect((await call('openai','/request','POST',{model:'model',input:'test',instructions:'architect',text:{format},max_output_tokens:100})).status).toBe(200);
    expect(JSON.parse(String(upstream.mock.calls.at(-1)?.[1]?.body))).toMatchObject({input:'test',instructions:'architect',text:{format},max_output_tokens:100});
    const response_format = {type:'json_schema',json_schema:format};
    expect((await call('opencode-console','/request','POST',{model:'model',messages:[],response_format})).status).toBe(200);
    expect(JSON.parse(String(upstream.mock.calls.at(-1)?.[1]?.body))).toMatchObject({messages:[],response_format});
  });
});

it('saves only after successful verification, rechecks on reload, and retains an old key after rejection or transient errors', async () => {
  await fixture(async ({ call, restart, values, store, upstream }) => {
    expect((await call('openai', '', 'POST', { key: 'placeholder-unverified' })).status).toBe(405);
    expect(await (await call('openai', '/verify', 'POST', {})).json()).toEqual({ saved: false, verification: 'unchecked' });
    expect(upstream).not.toHaveBeenCalled();
    const result = await (await call('openai', '/verify', 'POST', { key: 'placeholder-original' })).text();
    expect(JSON.parse(result)).toEqual({ saved: true, verification: 'verified' });
    expect(result).not.toContain('placeholder-original');
    expect(upstream.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
    expect(upstream.mock.calls[0][1]?.redirect).toBe('error');
    expect(store.save).toHaveBeenCalledTimes(1);
    await restart();
    expect(await (await call()).json()).toEqual({ saved: true, verification: 'unchecked' });
    expect(await (await call('openai', '/verify', 'POST', {})).json()).toEqual({ saved: true, verification: 'verified' });
    expect(store.save).toHaveBeenCalledTimes(1);
    for (const [code, expected, reason] of [[401, 'not-authorized', 'http-401'], [429, 'retryable', 'rate-limit'], [403, 'retryable', 'permission'], [503, 'retryable', 'http-503']] as const) {
      upstream.mockResolvedValueOnce(new Response('placeholder-upstream-error-body', { status: code }));
      expect(await (await call('openai', '/verify', 'POST', { key: 'placeholder-replacement' })).json()).toEqual({ saved: true, verification: expected, reason });
      expect(values.get('openai')).toBe('placeholder-original');
    }
    upstream.mockRejectedValueOnce(new DOMException('placeholder-private-message', 'TimeoutError'));
    expect(await (await call('openai', '/verify', 'POST', {})).json()).toMatchObject({ verification: 'retryable', reason: 'timeout' });
    upstream.mockRejectedValueOnce(new Error('placeholder-private-message'));
    const network = await (await call('openai', '/verify', 'POST', {})).text();
    expect(network).not.toContain('placeholder-private-message');
    expect(JSON.parse(network)).toMatchObject({ verification: 'retryable' });
    await call('opencode-console', '/verify', 'POST', { key: 'placeholder-console' });
    expect(upstream.mock.calls.at(-1)?.[0]).toBe('https://opencode.ai/inference/openai/v1/chat/completions');
    expect(JSON.parse(upstream.mock.calls.at(-1)?.[1]?.body as string).max_tokens).toBe(1);
    expect(values.get('opencode-console')).toBe('placeholder-console');
    upstream.mockResolvedValueOnce(new Response(JSON.stringify({ echo: 'placeholder-original' }), { status: 200 }));
    expect(await (await call('openai', '/request', 'POST', { model: 'test-model', input: [] })).text()).not.toContain('placeholder-original');
  });
});

it('does not save or mark Verified when Forget wins a pending verification, and reports failed removals', async () => {
  await fixture(async ({ call, values, store, upstream }) => {
    values.set('openai', 'placeholder-old');
    let finish!: (response: Response) => void;
    upstream.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = call('openai', '/verify', 'POST', { key: 'placeholder-new' });
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
    expect(await (await call('openai', '', 'DELETE')).json()).toEqual({ saved: false, verification: 'unchecked' });
    finish(new Response('{}', { status: 200 }));
    expect((await pending).status).toBe(409);
    expect(values.has('openai')).toBe(false);
    expect(store.save).not.toHaveBeenCalled();
    // A request initiated earlier can reach the server after Forget because of network reordering.
    await call('openai', '', 'DELETE', undefined, { 'X-Credential-Client': 'test-client', 'X-Credential-Revision': '2' });
    expect((await call('openai', '/verify', 'POST', { key: 'placeholder-delayed', clientId: 'test-client', revision: 1 })).status).toBe(409);
    expect(store.save).not.toHaveBeenCalled();
    expect(await (await call()).json()).toEqual({ saved: false, verification: 'unchecked' });
    values.set('opencode-console', 'placeholder-console');
    store.forget.mockImplementationOnce(async () => { throw new Error('placeholder-private-error'); });
    expect(await (await call('opencode-console', '', 'DELETE')).json()).toMatchObject({ saved: true, removalFailed: true, verification: 'retryable' });
    expect(values.has('opencode-console')).toBe(true);
    values.set('openai', 'placeholder-for-removal-failure');
    store.forget.mockImplementationOnce(async () => { throw new Error('placeholder-private-error'); });
    const all = await (await call('', '', 'DELETE')).json();
    expect(all.failed).toEqual(['openai']);
    expect(all.results['opencode-console']).toEqual({ saved: false, verification: 'unchecked' });
    expect(values.has('opencode-console')).toBe(false);
  });
});

it('Forget all preserves a calculation session and full chat/Timeline after backend restart and reload', async () => {
  await fixture(async ({ api, call, restart, values }) => {
    await call('openai', '/verify', 'POST', { key: 'placeholder-openai' });
    await call('opencode-console', '/verify', 'POST', { key: 'placeholder-console' });
    const session = await (await api('sessions', 'POST')).json();
    const tools = createBuiltInToolRegistry();
    const execute = vi.spyOn(tools, 'executeById');
    const llm = { complete: vi.fn().mockResolvedValueOnce({ toolCalls: [{ id: 'calc-call', toolId: 'builtin.tax_calculator', arguments: { amount: 100, taxRate: 15 } }] }).mockResolvedValueOnce({ text: 'Total: 115' }) };
    await new ManagerAgent(llm, tools).run({ state: emptySession(session), userText: 'Calculate tax', onEvent: async (event) => {
      expect((await api(`sessions/${session.id}/events`, 'POST', event)).ok).toBe(true);
    } });
    const before: HistoryEvent[] = await (await api(`sessions/${session.id}/events`)).json();
    expect(before.find((event) => event.type === 'tool-result')?.payload).toMatchObject({ output: { total: 115 } });
    expect(await (await call('openai', '', 'DELETE')).json()).toEqual({ saved: false, verification: 'unchecked' });
    expect(await (await api(`sessions/${session.id}/events`)).json()).toEqual(before);
    await call('openai', '/verify', 'POST', { key: 'placeholder-openai-again' });
    expect((await (await call('', '', 'DELETE')).json()).failed).toEqual([]);
    expect(values.size).toBe(0);
    await restart();
    expect(await (await call('openai', '/verify', 'POST', {})).json()).toEqual({ saved: false, verification: 'unchecked' });
    expect(await (await api('sessions')).json()).toContainEqual(expect.objectContaining({...session, updatedAt: expect.any(Number)}));
    const after = await (await api(`sessions/${session.id}/events`)).json();
    expect(after).toEqual(before);
    const restored = restoreHistory(emptySession(session), after);
    expect(restored.messages.map((message) => message.text)).toEqual(['Calculate tax', 'Total: 115']);
    expect(buildWeek2Timeline(restored, tools).find((event) => event.kind === 'tool')).toMatchObject({ status: 'completed', output: { total: 115 } });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

it('makes zero verification requests on startup with an empty store, including repeated mounts', async () => {
  const request = vi.fn(async (): Promise<SavedCredentialStatus> => ({ saved: false, verification: 'unchecked' }));
  const controller = new CredentialController(request);
  controller.start(); controller.start();
  await vi.waitFor(() => expect(credentialLabel(controller.getSnapshot().openai)).toBe('Not verified'));
  expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.calls).toEqual([['openai'], ['opencode-console'], ['opencode-go']]);
  expect(Object.values(controller.getSnapshot()).every((status) => !status.saved && credentialLabel(status) === 'Not verified')).toBe(true);
});

it('checks presence before one saved-key verification per startup/reload and ignores stale results after Forget', async () => {
  let finish!: (value: SavedCredentialStatus) => void;
  const deferred = new Promise<SavedCredentialStatus>((resolve) => { finish = resolve; });
  const request = vi.fn(async (provider: SavedProvider, action = ''): Promise<SavedCredentialStatus> => {
    if (provider === 'openai' && action === '/verify') return deferred;
    return { saved: provider === 'openai', verification: 'unchecked' };
  });
  const all = vi.fn(async () => ({ results: Object.fromEntries(['openai', 'opencode-console', 'opencode-go'].map((id) => [id, { saved: false, verification: 'unchecked' }])) as Record<SavedProvider, SavedCredentialStatus>, failed: [] }));
  const controller = new CredentialController(request, all);
  controller.start(); controller.start();
  await vi.waitFor(() => expect(request.mock.calls.filter(([, action]) => action === '/verify')).toHaveLength(1));
  expect(request.mock.calls.filter(([, action]) => !action)).toHaveLength(3);
  expect(request.mock.calls.findIndex(([provider, action]) => provider === 'openai' && action === '/verify')).toBeGreaterThan(request.mock.calls.findIndex(([provider, action]) => provider === 'openai' && !action));
  expect(credentialLabel(controller.getSnapshot().openai)).toBe('Checking…');
  await controller.forget('openai');
  await controller.forgetAll();
  finish({ saved: true, verification: 'verified' });
  await deferred; await new Promise((resolve) => setTimeout(resolve, 0));
  expect(controller.getSnapshot().openai).toEqual({ saved: false, verification: 'unchecked' });
  const reloaded = new CredentialController(request, all);
  reloaded.start(); reloaded.start();
  await vi.waitFor(() => expect(credentialLabel(reloaded.getSnapshot().openai)).toBe('Verified'));
  expect(request.mock.calls.filter(([, action]) => action === '/verify')).toHaveLength(2);
  expect(request.mock.calls.filter(([provider, action]) => action === '/verify' && provider !== 'openai')).toHaveLength(0);
});

it('manual Verify accepts a newly entered placeholder even after startup found no saved key', async () => {
  await fixture(async ({ call, store, values }) => {
    const request = vi.fn(async (provider: SavedProvider, action = '', init?: RequestInit): Promise<SavedCredentialStatus> => {
      const response = await call(provider, action, init?.method ?? 'GET', init?.body ? JSON.parse(init.body as string) : undefined);
      expect(response.ok).toBe(true);
      return response.json();
    });
    const controller = new CredentialController(request);
    controller.start();
    await vi.waitFor(() => expect(Object.keys(controller.getSnapshot()).length).toBe(3));
    await vi.waitFor(() => expect(Object.values(controller.getSnapshot()).every((status) => status.verification === 'unchecked')).toBe(true));
    expect(request.mock.calls.filter(([, action]) => action === '/verify')).toHaveLength(0);
    expect(store.save).not.toHaveBeenCalled();
    const result = await controller.verify('openai', 'placeholder-manual-key');
    expect(result).toEqual({ saved: true, verification: 'verified' });
    expect(store.save).toHaveBeenCalledExactlyOnceWith('openai', 'placeholder-manual-key');
    expect(values.get('openai')).toBe('placeholder-manual-key');
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('placeholder-manual-key');
  });
});

it('a failed presence check is retryable and never triggers verification', async () => {
  const request = vi.fn(async () => { throw new Error('backend unavailable'); });
  const controller = new CredentialController(request);
  controller.start();
  await vi.waitFor(() => expect(controller.getSnapshot().openai?.verification).toBe('retryable'));
  expect(request.mock.calls).toEqual([['openai'], ['opencode-console'], ['opencode-go']]);
});

it('a delayed presence result cannot start verification after Forget', async () => {
  let complete!: (status: SavedCredentialStatus) => void;
  const presence = new Promise<SavedCredentialStatus>((resolve) => { complete = resolve; });
  const request = vi.fn(async (provider: SavedProvider, action = '', init?: RequestInit): Promise<SavedCredentialStatus> => {
    if (provider === 'openai' && !action && !init) return presence;
    return { saved: false, verification: 'unchecked' };
  });
  const controller = new CredentialController(request);
  controller.start();
  await controller.forget('openai');
  complete({ saved: true, verification: 'unchecked' });
  await presence; await new Promise((resolve) => setTimeout(resolve, 0));
  expect(request.mock.calls.some(([, action]) => action === '/verify')).toBe(false);
  expect(controller.getSnapshot().openai).toEqual({ saved: false, verification: 'unchecked' });
});

it('saved-key manager requests contain no browser key or Authorization header', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ output: [] }), { status: 200 }));
  const registry = new ProviderRegistry();
  vi.spyOn(registry, 'endpointFor').mockReturnValue('https://api.openai.com/v1/responses');
  await createManagerLlmAdapter({ providerId: 'openai', model: 'test-model', apiKey: '', useSavedKey: true, registry, fetcher }).complete({ messages: [], tools: [] });
  expect(fetcher.mock.calls[0][0]).toBe('/api/credentials/openai/request');
  expect(fetcher.mock.calls[0][1]?.headers).toEqual({ 'Content-Type': 'application/json' });
});

it('Forget all waits for a Keychain save already in progress and removes its key', async () => {
  await fixture(async ({ call, values, store }) => {
    values.set('openai', 'placeholder-old');
    let releaseSave!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseSave = resolve; });
    store.save.mockImplementationOnce(async (provider: string, key: string) => { await blocked; values.set(provider, key); });
    const verify = call('openai', '/verify', 'POST', { key: 'placeholder-new' });
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
    const removing = call('', '', 'DELETE');
    await vi.waitFor(async () => expect(await (await call()).json()).toMatchObject({ verification: 'unchecked' }));
    releaseSave();
    expect((await verify).status).toBe(409);
    expect((await (await removing).json()).failed).toEqual([]);
    expect(values.size).toBe(0);
  });
});

it('keeps Not verified visible without a spinner throughout a delayed empty-store presence lookup', async () => {
  let resolvePresence!: (status: SavedCredentialStatus) => void;
  const presence = new Promise<SavedCredentialStatus>((resolve) => { resolvePresence = resolve; });
  const request = vi.fn(async (_provider: SavedProvider, _action = '') => presence);
  const controller = new CredentialController(request);
  controller.start(); controller.start();
  const markup = () => Object.entries(controller.getSnapshot()).map(([provider, status]) => renderToStaticMarkup(createElement(CredentialIndicator, { provider, status })));
  expect(request).toHaveBeenCalledTimes(3);
  for (const html of markup()) {
    expect(html).toContain('Not verified');
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain('Checking for a saved key in Providers.');
    expect(html).toContain('tabindex="0"');
  }
  resolvePresence({ saved: false, verification: 'unchecked' });
  await vi.waitFor(() => expect(Object.values(controller.getSnapshot()).every((status) => !status.presencePending)).toBe(true));
  expect(request.mock.calls.every(([, action]) => !action)).toBe(true);
  for (const html of markup()) {
    expect(html).toContain('Not verified');
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain('No key is saved. Add a key in Providers and select Verify.');
  }
});

it('shows a spinner only for the provider with a saved key and a pending Verify request', async () => {
  let openAIAvailable!: (status: SavedCredentialStatus) => void;
  let consoleAvailable!: (status: SavedCredentialStatus) => void;
  let verified!: (status: SavedCredentialStatus) => void;
  const openAIPresence = new Promise<SavedCredentialStatus>((resolve) => { openAIAvailable = resolve; });
  const consolePresence = new Promise<SavedCredentialStatus>((resolve) => { consoleAvailable = resolve; });
  const verification = new Promise<SavedCredentialStatus>((resolve) => { verified = resolve; });
  const request = vi.fn(async (provider: SavedProvider, action = ''): Promise<SavedCredentialStatus> => {
    if (action === '/verify') return verification;
    if (provider === 'openai') return openAIPresence;
    if (provider === 'opencode-console') return consolePresence;
    return { saved: false, verification: 'unchecked' };
  });
  const controller = new CredentialController(request);
  const markup = (provider: SavedProvider) => renderToStaticMarkup(createElement(CredentialIndicator, { provider, status: controller.getSnapshot()[provider]! }));
  controller.start(); controller.start();
  expect(markup('openai')).not.toContain('role="progressbar"');
  expect(markup('opencode-console')).toContain('Not verified');
  openAIAvailable({ saved: true, verification: 'unchecked' });
  await vi.waitFor(() => expect(request.mock.calls.filter(([, action]) => action === '/verify')).toHaveLength(1));
  expect(markup('openai')).toContain('role="progressbar"');
  expect(markup('opencode-console')).toContain('Not verified');
  expect(markup('opencode-console')).not.toContain('role="progressbar"');
  consoleAvailable({ saved: false, verification: 'unchecked' });
  await vi.waitFor(() => expect(controller.getSnapshot()['opencode-console']?.presencePending).toBeUndefined());
  expect(request.mock.calls.filter(([provider, action]) => provider === 'opencode-console' && action === '/verify')).toHaveLength(0);
  verified({ saved: true, verification: 'verified' });
  await vi.waitFor(() => expect(controller.getSnapshot().openai?.verification).toBe('verified'));
  expect(markup('openai')).toContain('Verified');
  expect(markup('openai')).not.toContain('role="progressbar"');
  expect(markup('opencode-console')).toContain('Not verified');
  expect(request.mock.calls.filter(([, action]) => action === '/verify')).toHaveLength(1);
});
