import { test } from 'vitest';

import { assertOpencodeGoUpstreamRecord, OPENCODE_GO_DEFAULT_BASE_URL } from '../src/config.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const baseRecord: UpstreamRecord = {
  id: 'up_opencode_go_test',
  kind: 'custom',
  name: 'OpenCode Go',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-19T00:00:00.000Z',
  config: {
    baseUrl: 'https://opencode.ai/zen/go',
    apiKey: 'opencode_go_test',
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
};

test('assertOpencodeGoUpstreamRecord parses a bearer-keyed Floway OpenCode Go config', () => {
  const { kind, config } = assertOpencodeGoUpstreamRecord({ ...baseRecord, kind: 'opencode-go' as UpstreamRecord['kind'] });
  assertEquals(kind, 'opencode-go');
  assertEquals(config.baseUrl, 'https://opencode.ai/zen/go');
  assertEquals(config.apiKey, 'opencode_go_test');
  assertEquals(config.models, []);
});

test('assertOpencodeGoUpstreamRecord defaults the base URL to the public gateway', () => {
  const { config } = assertOpencodeGoUpstreamRecord({
    ...baseRecord,
    kind: 'opencode-go' as UpstreamRecord['kind'],
    config: { apiKey: 'opencode_go_test' },
  });
  assertEquals(config.baseUrl, OPENCODE_GO_DEFAULT_BASE_URL);
});

test('assertOpencodeGoUpstreamRecord parses manual model overrides', () => {
  const { config } = assertOpencodeGoUpstreamRecord({
    ...baseRecord,
    kind: 'opencode-go' as UpstreamRecord['kind'],
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      models: [
        { upstreamModelId: 'grok-4.7', endpoints: { openaiResponses: {} }, display_name: 'Grok 4.7' },
      ],
    },
  });
  assertEquals(config.models.length, 1);
  assertEquals(config.models[0].upstreamModelId, 'grok-4.7');
  assertEquals(config.models[0].display_name, 'Grok 4.7');
});

test('assertOpencodeGoUpstreamRecord rejects a non-http(s) base URL', () => {
  assertThrows(() => assertOpencodeGoUpstreamRecord({
    ...baseRecord,
    kind: 'opencode-go' as UpstreamRecord['kind'],
    config: { baseUrl: 'ftp://example.com' },
  }));
});

test('assertOpencodeGoUpstreamRecord rejects a record of another provider kind', () => {
  assertThrows(() => assertOpencodeGoUpstreamRecord(baseRecord));
});

test('assertOpencodeGoUpstreamRecord rejects rerank models', () => {
  assertThrows(
    () => assertOpencodeGoUpstreamRecord({
      ...baseRecord,
      kind: 'opencode-go' as UpstreamRecord['kind'],
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
