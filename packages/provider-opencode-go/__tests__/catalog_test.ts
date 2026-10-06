import { test } from 'vitest';

import { opencodeGoCatalogModelForId, opencodeGoCatalogModels } from '../src/catalog.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('opencodeGoCatalogModels carries no endpoint for live models the docs table does not document', () => {
  // qwen3.7-max is live on Go but has no row in the Go endpoint table: it
  // stays in the catalog with full metadata but no endpoint field at all —
  // never an inferred wire. The provider falls back to chat-completions.
  const model = opencodeGoCatalogModelForId('qwen3.7-max');
  assertEquals(model?.endpoint, undefined);
  assertEquals(model?.name, 'Qwen3.7 Max');
  assertEquals(model?.maxContextTokens, 1000000);
  assertEquals('endpoint' in (model ?? {}), false);
});

test('opencodeGoCatalogModels routes representative ids to their documented wires', () => {
  assertEquals(opencodeGoCatalogModelForId('grok-4.7')?.endpoint, 'openaiResponses');
  assertEquals(opencodeGoCatalogModelForId('gpt-6-luna')?.endpoint, 'openaiResponses');
  assertEquals(opencodeGoCatalogModelForId('muse-spark-1.3-contributor')?.endpoint, 'openaiResponses');
  assertEquals(opencodeGoCatalogModelForId('minimax-m3')?.endpoint, 'anthropicMessages');
  assertEquals(opencodeGoCatalogModelForId('qwen3.7-plus')?.endpoint, 'anthropicMessages');
  assertEquals(opencodeGoCatalogModelForId('qwen3.8-max')?.endpoint, 'anthropicMessages');
  assertEquals(opencodeGoCatalogModelForId('kimi-k3')?.endpoint, 'openaiChatCompletions');
  assertEquals(opencodeGoCatalogModelForId('space-bunny')?.endpoint, 'openaiChatCompletions');
});

test('opencodeGoCatalogModels refuses live ids absent from the registry', () => {
  assertEquals(opencodeGoCatalogModelForId('deepseek-flash'), undefined);
  assertEquals(opencodeGoCatalogModelForId('omen-alpha'), undefined);
  assertEquals(opencodeGoCatalogModels().some(model => model.id === 'deepseek-flash'), false);
  assertEquals(opencodeGoCatalogModels().some(model => model.id === 'omen-alpha'), false);
});

test('opencodeGoCatalogModels excludes registry rows with no live counterpart', () => {
  // space-bunny-free remains in the registry (and stays resolvable for
  // historical usage pricing) but is no longer served upstream, so it has
  // no catalog row.
  assertEquals(opencodeGoCatalogModelForId('space-bunny-free'), undefined);
  assertEquals(opencodeGoCatalogModels().some(model => model.id === 'space-bunny-free'), false);
});
