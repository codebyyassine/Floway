import { test } from 'vitest';

import { assertOpencodeZenUpstreamRecord, OPENCODE_ZEN_DEFAULT_BASE_URL } from '../src/config.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const baseRecord: UpstreamRecord = {
  id: 'up_opencode_test',
  kind: 'custom',
  name: 'OpenCode Zen',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-19T00:00:00.000Z',
  config: {
    baseUrl: 'https://opencode.ai/zen',
    apiKey: 'opencode_test',
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
};

test('assertOpencodeZenUpstreamRecord parses a bearer-keyed Floway OpenCode Zen config', () => {
  const { kind, config } = assertOpencodeZenUpstreamRecord({ ...baseRecord, kind: 'opencode' as UpstreamRecord['kind'] });
  assertEquals(kind, 'opencode');
  assertEquals(config.baseUrl, 'https://opencode.ai/zen');
  assertEquals(config.apiKey, 'opencode_test');
  assertEquals(config.models, []);
});

test('assertOpencodeZenUpstreamRecord defaults the base URL to the public gateway', () => {
  const { config } = assertOpencodeZenUpstreamRecord({
    ...baseRecord,
    kind: 'opencode' as UpstreamRecord['kind'],
    config: { apiKey: 'opencode_test' },
  });
  assertEquals(config.baseUrl, OPENCODE_ZEN_DEFAULT_BASE_URL);
});

test('assertOpencodeZenUpstreamRecord parses manual model overrides', () => {
  const { config } = assertOpencodeZenUpstreamRecord({
    ...baseRecord,
    kind: 'opencode' as UpstreamRecord['kind'],
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      models: [
        { upstreamModelId: 'gpt-5.5', endpoints: { openaiResponses: {} }, display_name: 'GPT-5.5' },
      ],
    },
  });
  assertEquals(config.models.length, 1);
  assertEquals(config.models[0].upstreamModelId, 'gpt-5.5');
  assertEquals(config.models[0].display_name, 'GPT-5.5');
});

test('assertOpencodeZenUpstreamRecord rejects a non-http(s) base URL', () => {
  assertThrows(() => assertOpencodeZenUpstreamRecord({
    ...baseRecord,
    kind: 'opencode' as UpstreamRecord['kind'],
    config: { baseUrl: 'ftp://example.com' },
  }));
});

test('assertOpencodeZenUpstreamRecord rejects a record of another provider kind', () => {
  assertThrows(() => assertOpencodeZenUpstreamRecord(baseRecord));
});

test('assertOpencodeZenUpstreamRecord rejects rerank models', () => {
  assertThrows(
    () => assertOpencodeZenUpstreamRecord({
      ...baseRecord,
      kind: 'opencode' as UpstreamRecord['kind'],
      config: {
        ...(baseRecord.config as Record<string, unknown>),
        models: [{
          upstreamModelId: 'reranker',
          kind: 'rerank',
          endpoints: { rerank: {} },
          rerankTarget: { protocol: 'cohere-v2' },
        }],
      },
    }),
    Error,
    'rerank models require a custom upstream',
  );
});
