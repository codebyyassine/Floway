import { test } from 'vitest';

import {
  buildOpencodeSnapshot,
  parseOpencodeDocsEndpoints,
  pricingForRegistryCost,
  reasoningForRegistryReasoningOptions,
  type OpencodeProviderSource,
} from '../../src/generate-opencode-catalog/generate.ts';
import { priceRequest } from '@floway-dev/protocols/common';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const SOURCE: OpencodeProviderSource = {
  block: 'opencode-test',
  docsUrl: 'https://example.test/docs',
  liveModelsUrl: 'https://example.test/v1/models',
  refreshCommand: 'pnpm tools:test-refresh',
};

const docsRow = (id: string, url: string): string =>
  `<tr><td>Example</td><td>${id}</td><td><code dir="auto">${url}</code></td><td><code dir="auto">@ai-sdk/openai</code></td></tr>`;

const docsHtml = (rows: string): string =>
  `<html><body><table><thead><tr><th>Model</th><th>Model ID</th><th>Endpoint</th><th>AI SDK Package</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;

const registryPayload = (models: Record<string, unknown>): unknown => ({ 'opencode-test': { models } });

const registryModel = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Example',
  limit: { context: 1000000, output: 65536 },
  modalities: { input: ['text', 'image', 'video'], output: ['text'] },
  cost: { input: 1, output: 2, cache_read: 0.1 },
  reasoning_options: [],
  ...overrides,
});

test('parseOpencodeDocsEndpoints derives each model wire from its own row URL path after /v1/', () => {
  const parsed = parseOpencodeDocsEndpoints(
    docsHtml([
      docsRow('grok-4.7', 'https://opencode.ai/zen/go/v1/responses'),
      docsRow('minimax-m3', 'https://opencode.ai/zen/go/v1/messages'),
      docsRow('kimi-k3', 'https://opencode.ai/zen/go/v1/chat/completions'),
    ].join('')),
    SOURCE.docsUrl,
  );
  assertEquals([...parsed.endpoints], [
    ['grok-4.7', 'openaiResponses'],
    ['minimax-m3', 'anthropicMessages'],
    ['kimi-k3', 'openaiChatCompletions'],
  ]);
  assertEquals([...parsed.unroutable], []);
});

test('parseOpencodeDocsEndpoints reads the wire regardless of the gateway URL prefix', () => {
  const parsed = parseOpencodeDocsEndpoints(
    docsHtml(docsRow('qwen3.8-max', 'https://opencode.ai/zen/v1/chat/completions')),
    SOURCE.docsUrl,
  );
  assertEquals(parsed.endpoints.get('qwen3.8-max'), 'openaiChatCompletions');
});

test('parseOpencodeDocsEndpoints ignores the other tables on the docs page', () => {
  const html = `<html><body><table><thead><tr><th>Model</th><th>Input</th><th>Output</th></tr></thead><tbody><tr><td>Kimi K3</td><td>$3.00</td><td>$15.00</td></tr></tbody></table>${docsHtml(docsRow('kimi-k3', 'https://opencode.ai/zen/v1/chat/completions')).slice('<html><body>'.length, -'</body></html>'.length)}</body></html>`;
  const parsed = parseOpencodeDocsEndpoints(html, SOURCE.docsUrl);
  assertEquals([...parsed.endpoints], [['kimi-k3', 'openaiChatCompletions']]);
});

test('parseOpencodeDocsEndpoints classifies Gemini and Jev paths as unroutable instead of dropping them', () => {
  const parsed = parseOpencodeDocsEndpoints(
    docsHtml([
      docsRow('gemini-3.8-flash', 'https://opencode.ai/zen/v1/models/gemini-3.8-flash'),
      docsRow('jev-1.13', 'https://opencode.ai/zen/v1/systemone'),
    ].join('')),
    SOURCE.docsUrl,
  );
  assertEquals([...parsed.endpoints], []);
  assertEquals([...parsed.unroutable], [
    ['gemini-3.8-flash', 'models/gemini-3.8-flash'],
    ['jev-1.13', 'systemone'],
  ]);
});

test('parseOpencodeDocsEndpoints fails loudly on a path that maps to no endpoint family', () => {
  assertThrows(
    () => parseOpencodeDocsEndpoints(docsHtml(docsRow('embed-1', 'https://opencode.ai/zen/v1/embeddings')), SOURCE.docsUrl),
    Error,
    'which maps to no Floway endpoint family',
  );
});

test('parseOpencodeDocsEndpoints fails when the page has no endpoint table or no rows', () => {
  assertThrows(
    () => parseOpencodeDocsEndpoints('<html><body><p>No tables here</p></body></html>', SOURCE.docsUrl),
    Error,
    'No Model ID/Endpoint table found',
  );
  assertThrows(
    () => parseOpencodeDocsEndpoints(docsHtml(''), SOURCE.docsUrl),
    Error,
    'has no model rows',
  );
});

test('parseOpencodeDocsEndpoints fails on conflicting duplicate rows for one id', () => {
  assertThrows(
    () => parseOpencodeDocsEndpoints(
      docsHtml([
        docsRow('kimi-k3', 'https://opencode.ai/zen/v1/chat/completions'),
        docsRow('kimi-k3', 'https://opencode.ai/zen/v1/messages'),
      ].join('')),
      SOURCE.docsUrl,
    ),
    Error,
    'Conflicting endpoint rows',
  );
});

test('buildOpencodeSnapshot keeps a live model with no docs row but carries no endpoint', () => {
  const snapshot = buildOpencodeSnapshot({
    registryPayload: registryPayload({
      'kimi-k3': registryModel({ name: 'Kimi K3' }),
      'qwen3.7-max': registryModel({ name: 'Qwen3.7 Max' }),
    }),
    liveIds: ['kimi-k3', 'qwen3.7-max'],
    docsHtml: docsHtml(docsRow('kimi-k3', 'https://opencode.ai/zen/go/v1/chat/completions')),
    source: SOURCE,
  });
  assertEquals(snapshot.catalog.models, [
    {
      id: 'kimi-k3',
      endpoint: 'openaiChatCompletions',
      name: 'Kimi K3',
      source: 'opencode-test',
      maxContextTokens: 1000000,
      maxOutputTokens: 65536,
      modalities: ['text', 'image'],
      pricing: pricingForRegistryCost({ input: 1, output: 2, cache_read: 0.1 }, 'kimi-k3'),
    },
    {
      id: 'qwen3.7-max',
      name: 'Qwen3.7 Max',
      source: 'opencode-test',
      maxContextTokens: 1000000,
      maxOutputTokens: 65536,
      modalities: ['text', 'image'],
      pricing: pricingForRegistryCost({ input: 1, output: 2, cache_read: 0.1 }, 'qwen3.7-max'),
    },
  ]);
  assertEquals(snapshot.excluded, []);
});

test('buildOpencodeSnapshot refuses live ids absent from the registry', () => {
  const snapshot = buildOpencodeSnapshot({
    registryPayload: registryPayload({ 'kimi-k3': registryModel() }),
    liveIds: ['kimi-k3', 'omen-alpha'],
    docsHtml: docsHtml(docsRow('kimi-k3', 'https://opencode.ai/zen/go/v1/chat/completions')),
    source: SOURCE,
  });
  assertEquals(snapshot.catalog.models.map(model => model.id), ['kimi-k3']);
});

test('buildOpencodeSnapshot excludes live ids the docs table wires to an unroutable path', () => {
  const snapshot = buildOpencodeSnapshot({
    registryPayload: registryPayload({ 'kimi-k3': registryModel() }),
    liveIds: ['kimi-k3', 'jev-1.13'],
    docsHtml: docsHtml([
      docsRow('kimi-k3', 'https://opencode.ai/zen/v1/chat/completions'),
      docsRow('jev-1.13', 'https://opencode.ai/zen/v1/systemone'),
    ].join('')),
    source: SOURCE,
  });
  assertEquals(snapshot.catalog.models.map(model => model.id), ['kimi-k3']);
  assertEquals(snapshot.excluded, [{ id: 'jev-1.13', endpointPath: 'systemone' }]);
});

test('pricingForRegistryCost bills the tier rate once input tokens reach the threshold', () => {
  const pricing = pricingForRegistryCost(
    { input: 0.3, output: 1.2, cache_read: 0.06, tiers: [{ input: 0.6, output: 2.4, cache_read: 0.12, tier: { type: 'context', size: 512000 } }] },
    'minimax-m3',
  );
  assertEquals(pricing.entries.length, 2);
  assertEquals(priceRequest(pricing, { inputTokens: 511999 }).rates?.input_tokens, '0.0000003');
  assertEquals(priceRequest(pricing, { inputTokens: 512000 }).rates?.input_tokens, '0.0000006');
});

test('pricingForRegistryCost preserves zero rates and ignores vendor-specific cost keys', () => {
  // Free-tier models bill 0/0/0: zero is a real rate, not missing data. The
  // Gemini-only `input_audio` key is ignored so the row keeps the shared
  // four-key shape.
  const pricing = pricingForRegistryCost(
    { input: 0, output: 0, cache_read: 0, cache_write: 0, input_audio: 1.5 },
    'space-bunny-free',
    'opencode',
  );
  assertEquals(priceRequest(pricing, { inputTokens: 0 }).rates, {
    input_tokens: '0',
    output_tokens: '0',
    input_cache_read_tokens: '0',
    input_cache_write_tokens: '0',
  });
});

test('pricingForRegistryCost names the provider block in its errors', () => {
  assertThrows(
    () => pricingForRegistryCost({ input: 1 }, 'example', 'opencode'),
    Error,
    'Malformed opencode registry cost for example',
  );
});

test('reasoningForRegistryReasoningOptions maps effort, toggle, and budget options', () => {
  assertEquals(reasoningForRegistryReasoningOptions([]), null);
  assertEquals(reasoningForRegistryReasoningOptions(undefined), null);
  assertEquals(
    reasoningForRegistryReasoningOptions([{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] }]),
    { effort: { supported: ['low', 'medium', 'high', 'xhigh'], default: 'high' } },
  );
  assertEquals(
    reasoningForRegistryReasoningOptions([{ type: 'effort', values: ['low', 'medium', 'xhigh'] }]),
    { effort: { supported: ['low', 'medium', 'xhigh'], default: 'xhigh' } },
  );
  assertEquals(reasoningForRegistryReasoningOptions([{ type: 'toggle' }]), { adaptive: true });
  assertEquals(
    reasoningForRegistryReasoningOptions([{ type: 'toggle' }, { type: 'budget_tokens', max: 262144 }]),
    { adaptive: true, budget_tokens: { max: 262144 } },
  );
});

test('pricingForRegistryCost rejects a second context tier instead of diverging from the tier table', () => {
  const tier = (size: number): unknown => ({ input: 1, output: 1, tier: { type: 'context', size } });
  assertThrows(() => pricingForRegistryCost({ input: 1, output: 1, tiers: [tier(100), tier(200)] }, 'example'));
});

test('buildOpencodeSnapshot excludes registry rows with no live counterpart', () => {
  const snapshot = buildOpencodeSnapshot({
    registryPayload: registryPayload({ 'retired-model': registryModel(), 'live-model': registryModel() }),
    liveIds: ['live-model'],
    docsHtml: docsHtml(docsRow('live-model', 'https://example.test/v1/chat/completions')),
    source: SOURCE,
  });
  assertEquals(snapshot.catalog.models, [{ id: 'live-model', endpoint: 'openaiChatCompletions', name: 'Example', source: 'opencode-test', maxContextTokens: 1000000, maxOutputTokens: 65536, modalities: ['text', 'image'], pricing: pricingForRegistryCost({ input: 1, output: 2, cache_read: 0.1 }, 'live-model') }]);
  // Pricing and capabilities still cover every registry row, so historical
  // usage rows for retired ids keep resolving.
  assertEquals(Object.keys(snapshot.pricing.base).toSorted(), ['live-model', 'retired-model']);
});
