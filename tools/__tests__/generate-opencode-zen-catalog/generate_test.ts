import { test } from 'vitest';

import {
  buildOpencodeZenSnapshot,
  OPENCODE_ZEN_PROVIDER_BLOCK,
} from '../../src/generate-opencode-zen-catalog/generate.ts';
import { priceRequest } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const docsRow = (id: string, url: string): string =>
  `<tr><td>Example</td><td>${id}</td><td><code dir="auto">${url}</code></td><td><code dir="auto">@ai-sdk/openai</code></td></tr>`;

const docsHtml = (rows: string): string =>
  `<html><body><table><thead><tr><th>Model</th><th>Model ID</th><th>Endpoint</th><th>AI SDK Package</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;

const registryPayload = (models: Record<string, unknown>): unknown => ({ opencode: { models } });

const registryModel = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Example',
  limit: { context: 262144, output: 131072 },
  modalities: { input: ['text', 'image'], output: ['text'] },
  cost: { input: 2, output: 6, cache_read: 0.25, cache_write: 2.5 },
  reasoning_options: [{ type: 'toggle' }],
  ...overrides,
});

test('buildOpencodeZenSnapshot routes each model from its own Zen docs-table row', () => {
  // The two gateways disagree per-model on shared ids: qwen3.8-max and the
  // minimax rows are messages on Go but chat/completions on Zen. The Zen
  // snapshot follows the Zen table.
  const snapshot = buildOpencodeZenSnapshot({
    registryPayload: registryPayload({
      'gpt-5.5': registryModel(),
      'claude-opus-5-5': registryModel(),
      'qwen3.8-max': registryModel(),
      'minimax-m3': registryModel(),
    }),
    liveIds: ['gpt-5.5', 'claude-opus-5-5', 'qwen3.8-max', 'minimax-m3'],
    docsHtml: docsHtml([
      docsRow('gpt-5.5', 'https://opencode.ai/zen/v1/responses'),
      docsRow('claude-opus-5-5', 'https://opencode.ai/zen/v1/messages'),
      docsRow('qwen3.8-max', 'https://opencode.ai/zen/v1/chat/completions'),
      docsRow('minimax-m3', 'https://opencode.ai/zen/v1/chat/completions'),
    ].join('')),
  });
  assertEquals(snapshot.catalog.models.map(model => [model.id, model.endpoint]), [
    ['gpt-5.5', 'openaiResponses'],
    ['claude-opus-5-5', 'anthropicMessages'],
    ['qwen3.8-max', 'openaiChatCompletions'],
    ['minimax-m3', 'openaiChatCompletions'],
  ]);
  assertEquals(snapshot.excluded, []);
});

test('buildOpencodeZenSnapshot excludes the unroutable Jev rows and reports them', () => {
  const snapshot = buildOpencodeZenSnapshot({
    registryPayload: registryPayload({ 'kimi-k3': registryModel() }),
    liveIds: ['kimi-k3', 'jev-1.13', 'jev-1.13-free'],
    docsHtml: docsHtml([
      docsRow('kimi-k3', 'https://opencode.ai/zen/v1/chat/completions'),
      docsRow('jev-1.13', 'https://opencode.ai/zen/v1/systemone'),
      docsRow('jev-1.13-free', 'https://opencode.ai/zen/v1/systemone'),
    ].join('')),
  });
  assertEquals(snapshot.catalog.models.map(model => model.id), ['kimi-k3']);
  assertEquals(snapshot.excluded, [
    { id: 'jev-1.13', endpointPath: 'systemone' },
    { id: 'jev-1.13-free', endpointPath: 'systemone' },
  ]);
});

test('buildOpencodeZenSnapshot keeps deprecated-but-live rows and drops deprecated rows with no live counterpart', () => {
  const snapshot = buildOpencodeZenSnapshot({
    registryPayload: registryPayload({
      'mimo-v2.5-free': registryModel({ status: 'deprecated', cost: { input: 0, output: 0, cache_read: 0 } }),
      'retired-model': registryModel({ status: 'deprecated' }),
    }),
    liveIds: ['mimo-v2.5-free'],
    docsHtml: docsHtml(docsRow('mimo-v2.5-free', 'https://opencode.ai/zen/v1/chat/completions')),
  });
  // Live availability is the id set: a deprecated row that is still served
  // stays, while one with no live counterpart leaves the catalog (its
  // pricing row remains for historical usage rows).
  assertEquals(snapshot.catalog.models.map(model => model.id), ['mimo-v2.5-free']);
  assertEquals(Object.keys(snapshot.pricing.base).toSorted(), ['mimo-v2.5-free', 'retired-model']);
});

test('buildOpencodeZenSnapshot preserves free-tier zero rates and ignores input_audio', () => {
  const snapshot = buildOpencodeZenSnapshot({
    registryPayload: registryPayload({
      'space-bunny-free': registryModel({ cost: { input: 0, output: 0, cache_read: 0 } }),
      'gemini-3.8-flash': registryModel({ cost: { input: 1.5, output: 7.5, cache_read: 0.15, input_audio: 1.5 } }),
    }),
    liveIds: ['space-bunny-free'],
    docsHtml: docsHtml([
      docsRow('space-bunny-free', 'https://opencode.ai/zen/v1/chat/completions'),
      docsRow('gemini-3.8-flash', 'https://opencode.ai/zen/v1/models/gemini-3.8-flash'),
    ].join('')),
  });
  const free = snapshot.catalog.models.find(model => model.id === 'space-bunny-free')!;
  assertEquals(priceRequest(free.pricing!, { inputTokens: 0 }).rates, {
    input_tokens: '0',
    output_tokens: '0',
    input_cache_read_tokens: '0',
  });
  // The Gemini row is not live, so it never reaches the catalog, but its
  // pricing row keeps the shared four-key shape without input_audio.
  assertEquals(snapshot.pricing.base['gemini-3.8-flash'], { input: '1.5', output: '7.5', cacheRead: '0.15' });
});

test('buildOpencodeZenSnapshot refuses live ids absent from the registry', () => {
  const snapshot = buildOpencodeZenSnapshot({
    registryPayload: registryPayload({ 'kimi-k3': registryModel() }),
    liveIds: ['kimi-k3', 'future-model-unknown'],
    docsHtml: docsHtml(docsRow('kimi-k3', 'https://opencode.ai/zen/v1/chat/completions')),
  });
  assertEquals(snapshot.catalog.models.map(model => model.id), ['kimi-k3']);
});

test('the Zen adapter reads the opencode registry block', () => {
  assertEquals(OPENCODE_ZEN_PROVIDER_BLOCK, 'opencode');
});
