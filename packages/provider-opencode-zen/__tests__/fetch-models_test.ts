import { test } from 'vitest';

import { assertOpencodeZenUpstreamRecord, type OpencodeZenUpstreamConfig } from '../src/config.ts';
import { fetchOpencodeZenModelIds } from '../src/fetch-models.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';
import { assertEquals, assertRejects, jsonResponse, testFetcher, withMockedFetch } from '@floway-dev/test-utils';

const config: OpencodeZenUpstreamConfig = assertOpencodeZenUpstreamRecord({
  id: 'up_opencode',
  kind: 'opencode',
  name: 'OpenCode Zen',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-19T00:00:00.000Z',
  config: { baseUrl: 'https://opencode.ai/zen', apiKey: 'opencode_test' },
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
    { id: 'gpt-5.5', object: 'model', owned_by: 'opencode' },
    { id: 'claude-opus-5-5', object: 'model', owned_by: 'opencode' },
    { id: 'kimi-k3', object: 'model', owned_by: 'opencode' },
  ],
};

test('fetchOpencodeZenModelIds returns the live upstream model ids in order', async () => {
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/v1/models')) {
        assertEquals(request.headers.get('Authorization'), 'Bearer opencode_test');
        return jsonResponse(modelsBody);
      }
      return new Response('unexpected', { status: 500 });
    },
    async () => {
      assertEquals(await fetchOpencodeZenModelIds(config, testFetcher), ['gpt-5.5', 'claude-opus-5-5', 'kimi-k3']);
    },
  );
});

test('fetchOpencodeZenModelIds skips entries without a usable id', async () => {
  await withMockedFetch(
    async () => jsonResponse({ object: 'list', data: [{ id: 'gpt-5.5' }, { id: '' }, { object: 'model' }, 'gpt-5.4'] }),
    async () => {
      assertEquals(await fetchOpencodeZenModelIds(config, testFetcher), ['gpt-5.5']);
    },
  );
});

test('fetchOpencodeZenModelIds rejects with ProviderModelsUnavailableError when /v1/models returns a shape it cannot parse', async () => {
  await withMockedFetch(
    async () => jsonResponse({ unexpected: 'shape' }),
    async () => {
      await assertRejects(
        () => fetchOpencodeZenModelIds(config, testFetcher),
        ProviderModelsUnavailableError,
      );
    },
  );
});
