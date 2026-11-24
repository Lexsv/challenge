import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { cloneElement, createElement } from 'react';
import { beginMeter, finishMeter, tokenPricing, verifiedEncoding, type RequestMeter } from './token-meter';
import { createManagerLlmAdapter } from './manager-llm-adapter';
import { ProviderRegistry } from './provider-registry';
import { RequestMeterCard } from './request-meter-card';
import { createBuiltInToolRegistry } from './tool-runtime';
import { toolExecutionTypeMeta } from './tool-execution-type';

const endpoint = 'https://api.openai.com/v1/responses';
it('uses verified mappings only and counts instructions, history and tool definitions in the full input', async () => {
  expect(verifiedEncoding('gpt-4o-mini')).toBe('o200k_base');
  expect(verifiedEncoding('gpt-5.6-terra')).toBe('o200k_base');
  expect(verifiedEncoding('gpt-5-made-up')).toBeUndefined();
  expect(verifiedEncoding('deepseek-v4.1-flash')).toBeUndefined();
  const partial = await beginMeter('openai', 'gpt-4o-mini', { input: 'Hello' }, endpoint);
  const full = await beginMeter('openai', 'gpt-4o-mini', {
    instructions: 'Be precise. '.repeat(20),
    input: [{ role: 'user', content: 'Prior question. '.repeat(20) }, { role: 'assistant', content: 'Prior answer. '.repeat(20) }, { role: 'user', content: 'Hello <|endoftext|>' }],
    tools: [{ name: 'calculator', description: 'Apply a precise tax calculation. '.repeat(20), parameters: { type: 'object', properties: { amount: { type: 'number' } } } }],
  }, endpoint);
  expect(full.estimatedInputTokens).toBeGreaterThan(partial.estimatedInputTokens! + 100);
  expect(full.estimatedInputCost).toBe(full.estimatedInputTokens! * 0.15 / 1_000_000);
  expect(JSON.stringify(full)).not.toContain('Prior question');
  expect(JSON.stringify(full)).not.toContain('calculator');
  const unknown = await beginMeter('opencode-console', 'deepseek-v4.1-flash', { input: 'Hello' }, 'https://opencode.ai/inference/openai/v1/chat/completions');
  expect(unknown.estimatedInputTokens).toBeUndefined();
  expect(unknown.encoding).toBeUndefined();
});

it('preserves missing versus zero usage, parses both provider formats and prices cached input correctly', async () => {
  const initial = await beginMeter('openai', 'gpt-4o-mini', { input: 'Hello' }, endpoint);
  const completed = finishMeter(initial, { model: 'gpt-4o-mini', usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 40 } } }, endpoint);
  expect(completed.actualInputTokens).toBe(100);
  expect(completed.actualOutputTokens).toBe(20);
  expect(completed.actualTotalTokens).toBe(120);
  expect(completed.estimatedRequestCost).toBeCloseTo((60 * 0.15 + 40 * 0.075 + 20 * 0.60) / 1_000_000);
  const chat = finishMeter(initial, { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }, endpoint);
  expect(chat.actualInputTokens).toBe(0);
  expect(chat.actualOutputTokens).toBe(0);
  expect(chat.actualTotalTokens).toBe(0);
  expect(chat.estimatedRequestCost).toBe(0);
  const missing = finishMeter(initial, {}, endpoint);
  expect(missing.actualInputTokens).toBeUndefined();
  expect(missing.actualOutputTokens).toBeUndefined();
  expect(missing.actualTotalTokens).toBeUndefined();
  expect(missing.estimatedRequestCost).toBeUndefined();
  const partial = finishMeter(initial, { usage: { input_tokens: 10 } }, endpoint);
  expect(partial.actualOutputTokens).toBeUndefined();
  expect(partial.estimatedRequestCost).toBeUndefined();
  const invalid = finishMeter(initial, { usage: { input_tokens: -1, output_tokens: '0', total_tokens: null } }, endpoint);
  expect(invalid.actualInputTokens).toBeUndefined();
  expect(invalid.actualOutputTokens).toBeUndefined();
});

it('does not invent prices for unknown providers/models, custom endpoints, or a different actual model', async () => {
  expect(tokenPricing('openai', 'unknown', endpoint)).toBeUndefined();
  expect(tokenPricing('openai', 'gpt-4o-mini', 'https://example.com/v1/responses')).toBeUndefined();
  expect(tokenPricing('opencode-go', 'gpt-4o-mini', 'https://opencode.ai/inference/go/openai/v1/chat/completions')).toBeUndefined();
  const initial = await beginMeter('openai', 'gpt-4o-mini', { input: 'Hi' }, endpoint);
  const changed = finishMeter(initial, { model: 'unknown-model', usage: { input_tokens: 100, output_tokens: 10 } }, endpoint);
  expect(changed.estimatedRequestCost).toBeUndefined();
  expect(changed.actualPricing).toBeUndefined();
  expect(changed.estimatedInputCost).toBe(initial.estimatedInputCost);
  expect(changed.pricing).toEqual(initial.pricing);
  const unsupported = await beginMeter('openai', 'gpt-6.1-terra', { input: 'Hello' }, endpoint);
  const usage = finishMeter(unsupported, { usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } }, endpoint);
  expect(usage.actualTotalTokens).toBe(9);
  expect(usage.estimatedInputTokens).toBeUndefined();
  expect(usage.estimatedRequestCost).toBeUndefined();
});

it('publishes a pre-request estimate before network access and updates the same request ID with usage', async () => {
  const meters: RequestMeter[] = [];
  const registry = new ProviderRegistry();
  vi.spyOn(registry, 'endpointFor').mockReturnValue(endpoint);
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    expect(meters).toHaveLength(1);
    expect(meters[0].estimatedInputTokens).toBeGreaterThan(0);
    expect(meters[0].status).toBe('running');
    expect(JSON.parse(init!.body as string).input).toEqual([{ role: 'system', content: 'Instructions' }, { role: 'user', content: 'History and followup' }]);
    expect(JSON.stringify(meters)).not.toContain('placeholder-key');
    return new Response(JSON.stringify({ model: 'gpt-4o-mini', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer' }] }], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } }));
  });
  const adapter = createManagerLlmAdapter({ providerId: 'openai', model: 'gpt-4o-mini', apiKey: 'placeholder-key', registry, fetcher });
  await adapter.complete({ messages: [{ role: 'system', content: 'Instructions' }, { role: 'user', content: 'History and followup' }], tools: [], onMeter: async (meter) => { meters.push(meter); } });
  expect(meters).toHaveLength(2);
  expect(meters[1].id).toBe(meters[0].id);
  expect(meters[1]).toMatchObject({ actualInputTokens: 12, actualOutputTokens: 3, actualTotalTokens: 15, status: 'completed' });
  expect(meters[1].estimatedRequestCost).toBeGreaterThan(0);
});

it('does not send a model request if persisting its pre-request Library item fails', async () => {
  const registry = new ProviderRegistry();
  vi.spyOn(registry, 'endpointFor').mockReturnValue(endpoint);
  const fetcher = vi.fn<typeof fetch>();
  const adapter = createManagerLlmAdapter({ providerId: 'openai', model: 'gpt-4o-mini', apiKey: 'placeholder', registry, fetcher });
  await expect(adapter.complete({ messages: [], tools: [], onMeter: async () => { throw new Error('disk unavailable'); } })).rejects.toThrow('disk unavailable');
  expect(fetcher).not.toHaveBeenCalled();
});

it('renders the Library item with missing values distinct from zero, currency and a distinct catalog type', async () => {
  const initial = await beginMeter('openai', 'unknown', {}, endpoint);
  const missing = renderToStaticMarkup(createElement(RequestMeterCard, { meter: { ...initial, sessionId: 's1', runId: 'r1' } }));
  expect(missing).toContain('>Library<');
  expect(missing).toContain('>js-tiktoken<');
  expect(missing).toContain('Estimate unavailable');
  expect(missing).toContain('Not reported');
  expect(missing).toContain('Cost unavailable');
  const zero = finishMeter(await beginMeter('openai', 'gpt-4o-mini', {}, endpoint), { usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }, endpoint);
  const html = renderToStaticMarkup(createElement(RequestMeterCard, { meter: { ...zero, sessionId: 's1', runId: 'r1' } }));
  expect(html).toContain('Actual input: 0');
  expect(html).toContain('Actual output: 0');
  expect(html).toContain('Total: 0');
  expect(html).toContain('USD');
  const catalog = createBuiltInToolRegistry().listBuiltIn();
  expect(catalog.find((tool) => tool.id === 'library.js-tiktoken')).toMatchObject({ executable: false, executionType: 'library' });
  expect(new Set(Object.values(toolExecutionTypeMeta).map((type) => type.color)).size).toBe(4);
});

it('records failure once on the same Library item without copying a provider error body', async () => {
  const registry = new ProviderRegistry();
  vi.spyOn(registry, 'endpointFor').mockReturnValue(endpoint);
  const meters: RequestMeter[] = [];
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('raw-provider-response-placeholder', { status: 429 }));
  const adapter = createManagerLlmAdapter({ providerId: 'openai', model: 'unknown-model', apiKey: 'placeholder-key', registry, fetcher });
  await expect(adapter.complete({ messages: [], tools: [], onMeter: async (meter) => { meters.push(meter); } })).rejects.toThrow('429');
  expect(meters).toHaveLength(2);
  expect(meters[0].id).toBe(meters[1].id);
  expect(meters[1].status).toBe('failed');
  expect(meters[1].estimatedInputTokens).toBeUndefined();
  expect(meters[1].actualInputTokens).toBeUndefined();
  expect(JSON.stringify(meters)).not.toContain('raw-provider-response');
  expect(JSON.stringify(meters)).not.toContain('placeholder-key');
});

it('prices reported Console usage even when its model has no verified tokenizer', async () => {
  const url = 'https://opencode.ai/inference/openai/v1/chat/completions';
  const initial = await beginMeter('opencode-console', 'deepseek-v4.1-flash', {}, url);
  expect(initial.estimatedInputTokens).toBeUndefined();
  expect(initial.estimatedInputCost).toBeUndefined();
  const result = finishMeter(initial, { model: 'deepseek-v4.1-flash', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }, url);
  expect(result.actualInputTokens).toBe(100);
  expect(result.actualTotalTokens).toBe(120);
  expect(result.actualPricing).toMatchObject({ source: 'opencode-catalog', currency: 'USD' });
  expect(result.estimatedRequestCost).toBeGreaterThan(0);
});

it('uses the collapsed tool accordion pattern with an accessible summary and metric details', async () => {
  const initial = await beginMeter('openai', 'gpt-4o-mini', {}, endpoint);
  const completed = finishMeter(initial, { usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } }, endpoint);
  const meter = { ...completed, sessionId: 'session-test', runId: 'run-test' };
  const before = structuredClone(meter);
  const card = RequestMeterCard({ meter });
  expect(card.props.defaultExpanded).toBe(false);
  const html = renderToStaticMarkup(card);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('MuiCollapse-hidden');
  expect(html).toContain('data-testid="ExpandMoreIcon"');
  expect(html).toContain(`aria-controls="meter-${meter.id}-details"`);
  expect(html).toContain(`id="meter-${meter.id}-details"`);
  expect(html).toContain('role="region"');
  expect(html).toContain('>Library<');
  expect(html).toContain('>js-tiktoken<');
  expect(html).toContain('>completed<');
  expect(html).toContain('MuiChip-colorSuccess');
  for (const label of ['Model:', 'Estimated input tokens:', 'Estimated input cost:', 'Actual input: 12', 'Actual output: 3', 'Total: 15', 'Estimated request cost:']) expect(html).toContain(label);
  expect(html).not.toContain('Request:');
  expect(html).not.toContain('Request ID');
  expect(html).not.toContain('Local JSON input estimate');
  expect(html).toContain('border-radius:8px');
  const expanded = renderToStaticMarkup(cloneElement(card, { defaultExpanded: true }));
  expect(expanded).toContain('aria-expanded="true"');
  expect(expanded).toContain('MuiCollapse-entered');
  expect(expanded).toContain('Actual input: 12');
  expect(expanded).toContain('Actual output: 3');
  expect(expanded).toContain('Total: 15');
  expect(expanded).toContain('Estimated request cost:');
  expect(meter).toEqual(before);
});
