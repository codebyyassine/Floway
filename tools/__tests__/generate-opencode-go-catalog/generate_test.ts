import { test } from 'vitest';

import {
  buildOpencodeGoSnapshot,
  OPENCODE_GO_PROVIDER_BLOCK,
  parseOpencodeDocsEndpoints,
  pricingForRegistryCost,
} from '../../src/generate-opencode-go-catalog/generate.ts';
import { assertEquals } from '@floway-dev/test-utils';

const docsRow = (id: string, url: string): string =>
  `<tr><td>Example</td><td>${id}</td><td><code dir="auto">${url}</code></td><td><code dir="auto">@ai-sdk/openai</code></td></tr>`;

const docsHtml = (rows: string): string =>
  `<html><body><table><thead><tr><th>Model</th><th>Model ID</th><th>Endpoint</th><th>AI SDK Package</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;

const registryPayload = (models: Record<string, unknown>): unknown => ({ 'opencode-go': { models } });

const registryModel = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Example',
  limit: { context: 1000000, output: 65536 },
  modalities: { input: ['text', 'image', 'video'], output: ['text'] },
  cost: { input: 1, output: 2, cache_read: 0.1 },
  reasoning_options: [],
  ...overrides,
});

test('buildOpencodeGoSnapshot routes each model from its own docs-table row', () => {
  const snapshot = buildOpencodeGoSnapshot({
    registryPayload: registryPayload({
      'grok-4.7': registryModel(),
      'minimax-m3': registryModel(),
      'kimi-k3': registryModel(),
    }),
    liveIds: ['grok-4.7', 'minimax-m3', 'kimi-k3'],
    docsHtml: docsHtml([
      docsRow('grok-4.7', 'https://opencode.ai/zen/go/v1/responses'),
      docsRow('minimax-m3', 'https://opencode.ai/zen/go/v1/messages'),
      docsRow('kimi-k3', 'https://opencode.ai/zen/go/v1/chat/completions'),
    ].join('')),
  });
  assertEquals(snapshot.catalog.models.map(model => [model.id, model.endpoint]), [
    ['grok-4.7', 'openaiResponses'],
    ['minimax-m3', 'anthropicMessages'],
    ['kimi-k3', 'openaiChatCompletions'],
  ]);
  assertEquals(snapshot.excluded, []);
});

test('buildOpencodeGoSnapshot keeps a live model with no docs row but carries no endpoint', () => {
  // qwen3.7-max is live on Go but has no row in the Go endpoint table: it
  // stays in the catalog with no endpoint field at all — never an inferred
  // one — and the provider falls back to the chat-completions wire.
  const snapshot = buildOpencodeGoSnapshot({
    registryPayload: registryPayload({ 'qwen3.7-max': registryModel({ name: 'Qwen3.7 Max' }) }),
    liveIds: ['qwen3.7-max'],
    docsHtml: docsHtml(docsRow('kimi-k3', 'https://opencode.ai/zen/go/v1/chat/completions')),
  });
  assertEquals(snapshot.catalog.models, [{
    id: 'qwen3.7-max',
    name: 'Qwen3.7 Max',
    source: 'opencode-go',
    maxContextTokens: 1000000,
    maxOutputTokens: 65536,
    modalities: ['text', 'image'],
    pricing: pricingForRegistryCost({ input: 1, output: 2, cache_read: 0.1 }, 'qwen3.7-max'),
  }]);
});

test('buildOpencodeGoSnapshot emits live ids absent from the registry with minimal metadata', () => {
  const snapshot = buildOpencodeGoSnapshot({
    registryPayload: registryPayload({}),
    liveIds: ['omen-alpha'],
    docsHtml: docsHtml(docsRow('kimi-k3', 'https://opencode.ai/zen/go/v1/chat/completions')),
  });
  assertEquals(snapshot.catalog.models, [{ id: 'omen-alpha' }]);
});

test('buildOpencodeGoSnapshot excludes registry rows with no live counterpart', () => {
  const snapshot = buildOpencodeGoSnapshot({
    registryPayload: registryPayload({ 'retired-model': registryModel() }),
    liveIds: ['live-model'],
    docsHtml: docsHtml(docsRow('live-model', 'https://opencode.ai/zen/go/v1/chat/completions')),
  });
  assertEquals(snapshot.catalog.models, [{ id: 'live-model', endpoint: 'openaiChatCompletions' }]);
  // Pricing and capabilities still cover every registry row, so historical
  // usage rows for retired ids keep resolving.
  assertEquals(Object.keys(snapshot.pricing.base), ['retired-model']);
});

test('buildOpencodeGoSnapshot keeps retired and replacement pricing rows distinct', () => {
  const snapshot = buildOpencodeGoSnapshot({
    registryPayload: registryPayload({
      'space-bunny': registryModel({ cost: { input: 0.15, output: 0.6, cache_read: 0.03 } }),
      'space-bunny-free': registryModel({ cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } }),
    }),
    liveIds: ['space-bunny'],
    docsHtml: docsHtml(docsRow('space-bunny', 'https://opencode.ai/zen/go/v1/chat/completions')),
  });
  assertEquals(snapshot.pricing.base['space-bunny']?.input, '0.15');
  assertEquals(snapshot.pricing.base['space-bunny-free']?.input, '0');
});

test('the Go adapter reads the opencode-go registry block', () => {
  assertEquals(OPENCODE_GO_PROVIDER_BLOCK, 'opencode-go');
  assertEquals(
    parseOpencodeDocsEndpoints(
      docsHtml(docsRow('qwen3.8-max', 'https://opencode.ai/zen/go/v1/messages')),
      'https://opencode.ai/docs/go',
    ).endpoints.get('qwen3.8-max'),
    'anthropicMessages',
  );
});
