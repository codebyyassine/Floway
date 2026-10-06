import { test } from 'vitest';

import { assertOpencodeGoUpstreamRecord, type OpencodeGoUpstreamConfig } from '../src/config.ts';
import { fetchOpencodeGoModelIds } from '../src/fetch-models.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';
import { assertEquals, assertRejects, jsonResponse, testFetcher, withMockedFetch } from '@floway-dev/test-utils';

const config: OpencodeGoUpstreamConfig = assertOpencodeGoUpstreamRecord({
  id: 'up_opencode_go',
  kind: 'opencode-go',
  name: 'OpenCode Go',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-19T00:00:00.000Z',
  config: { baseUrl: 'https://opencode.ai/zen/go', apiKey: 'opencode_go_test' },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
} as unknown as UpstreamRecord).config;

const modelsBody = {
  object: 'list',
  data: [
    { id: 'grok-4.7', object: 'model', owned_by: 'xai' },
    { id: 'minimax-m3', object: 'model', owned_by: 'minimax' },
    { id: 'kimi-k3', object: 'model', owned_by: 'moonshot' },
  ],
};

test('fetchOpencodeGoModelIds returns the live upstream model ids in order', async () => {
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/v1/models')) {
        assertEquals(request.headers.get('Authorization'), 'Bearer opencode_go_test');
        return jsonResponse(modelsBody);
      }
      return new Response('unexpected', { status: 500 });
    },
    async () => {
      assertEquals(await fetchOpencodeGoModelIds(config, testFetcher), ['grok-4.7', 'minimax-m3', 'kimi-k3']);
    },
  );
});

test('fetchOpencodeGoModelIds skips entries without a usable id', async () => {
  await withMockedFetch(
    async () => jsonResponse({ object: 'list', data: [{ id: 'grok-4.7' }, { id: '' }, { object: 'model' }, 'grok-4.6'] }),
    async () => {
      assertEquals(await fetchOpencodeGoModelIds(config, testFetcher), ['grok-4.7']);
    },
  );
});

test('fetchOpencodeGoModelIds rejects with ProviderModelsUnavailableError when /v1/models returns a shape it cannot parse', async () => {
  await withMockedFetch(
    async () => jsonResponse({ unexpected: 'shape' }),
    async () => {
      await assertRejects(
        () => fetchOpencodeGoModelIds(config, testFetcher),
        ProviderModelsUnavailableError,
      );
    },
  );
});
