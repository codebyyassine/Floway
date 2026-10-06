import { test } from 'vitest';

import catalogJson from '../src/catalog.generated.json' with { type: 'json' };
import { OPENCODE_ZEN_UNROUTABLE_MODEL_IDS, opencodeZenCatalogModelForId, opencodeZenCatalogModels } from '../src/catalog.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('opencodeZenCatalogModels routes representative ids to their documented Zen wires', () => {
  // The two gateways disagree per-model on shared ids: qwen3.8-max and the
  // minimax rows are messages on Go but chat/completions on Zen. The Zen
  // snapshot follows the Zen table.
  assertEquals(opencodeZenCatalogModelForId('gpt-5.5')?.endpoint, 'openaiResponses');
  assertEquals(opencodeZenCatalogModelForId('claude-opus-5-5')?.endpoint, 'anthropicMessages');
  assertEquals(opencodeZenCatalogModelForId('kimi-k3')?.endpoint, 'openaiChatCompletions');
  assertEquals(opencodeZenCatalogModelForId('qwen3.8-max')?.endpoint, 'openaiChatCompletions');
  assertEquals(opencodeZenCatalogModelForId('minimax-m3')?.endpoint, 'openaiChatCompletions');
  assertEquals(opencodeZenCatalogModelForId('space-bunny-free')?.endpoint, 'openaiChatCompletions');
});

test('opencodeZenCatalogModels carries no endpoint for live models the docs table does not document', () => {
  // claude-sonnet-4 is live on Zen but has no row in the Zen endpoint table:
  // it stays in the catalog with full metadata but no endpoint field at all.
  const model = opencodeZenCatalogModelForId('claude-sonnet-4');
  assertEquals(model?.endpoint, undefined);
  assertEquals(model?.name, 'Claude Sonnet 4');
  assertEquals('endpoint' in (model ?? {}), false);
});

test('opencodeZenCatalogModels excludes the unroutable Gemini and Jev rows', () => {
  // The docs table wires gemini-* to /v1/models/{id} and jev-* to
  // /v1/systemone, which have no Floway endpoint family, so they have no
  // catalog row even though they are served upstream.
  assertEquals(opencodeZenCatalogModelForId('gemini-3.8-flash'), undefined);
  assertEquals(opencodeZenCatalogModelForId('jev-1.13'), undefined);
  assertEquals(opencodeZenCatalogModelForId('jev-1.13-free'), undefined);
  assertEquals(opencodeZenCatalogModels().some(model => model.id.startsWith('gemini-')), false);
  assertEquals(opencodeZenCatalogModels().some(model => model.id.startsWith('jev-')), false);
});

test('opencodeZenCatalogModels keeps deprecated-but-live rows and drops the rest', () => {
  // mimo-v2.5-free is deprecated in the registry but still served upstream,
  // so it stays; a deprecated row with no live counterpart has no row.
  assertEquals(opencodeZenCatalogModelForId('mimo-v2.5-free')?.endpoint, 'openaiChatCompletions');
});

test('OPENCODE_ZEN_UNROUTABLE_MODEL_IDS tracks the generator excluded set', () => {
  // The provider drops these live ids before the chat-completions fallback can
  // misroute them, so the set must move with the generator: a refresh that
  // names a new excluded id fails here until the set grows with it.
  const comments = (catalogJson as { $comment: string[] }).$comment;
  const excludedLine = comments.find(line => line.startsWith('Excluded live ids'));
  const generated = new Set(
    [...(excludedLine ?? '').matchAll(/(\S+) \(\/v1\//g)].map(match => match[1]!),
  );
  assertEquals(excludedLine !== undefined, generated.size > 0);
  assertEquals([...OPENCODE_ZEN_UNROUTABLE_MODEL_IDS].toSorted(), [...generated].toSorted());
});
