import { test, vi } from 'vitest';

import { MODEL_CATALOG_REVISION } from '../../../../src/repo/models-cache-contract.ts';
import { modelsRefreshIdentity, seedModelsCache } from '../../../repo/models-cache-fixture.ts';
import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, requestApp, setupAppTest, sseOpenAIChatCompletionsResponse } from '../../../test-utils/app.ts';
import { projectCustomModels } from '@floway-dev/provider-custom';
import { assertEquals, withMockedFetch } from '@floway-dev/test-utils';

// Tuesday 2026-09-29T07:00:00Z is inside the weekday peak window and clear of
// the National Day holiday week, so the peak gate is pinned without the test
// depending on when it runs.
const PEAK_NOW = new Date('2026-09-29T07:00:00Z');

const PEAK_PRICING = {
  entries: [
    { rates: { input_tokens: '1.32', output_tokens: '3.96' } },
    { selector: { pricingPeriod: 'off-peak' }, rates: { input_tokens: '0.66', output_tokens: '1.98' } },
  ],
};

const seedPeakChatUpstream = async (
  repo: Awaited<ReturnType<typeof setupAppTest>>['repo'],
  blockPeakPricedModels: boolean,
) => {
  const upstream = buildCustomUpstreamRecord({
    config: {
      baseUrl: 'https://custom.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-custom',
      endpoints: { openaiChatCompletions: {} },
      modelsFetch: { enabled: false },
      models: [{
        upstreamModelId: 'peak-chat',
        kind: 'chat',
        endpoints: { openaiChatCompletions: {} },
        pricing: PEAK_PRICING,
      }],
    },
    blockPeakPricedModels,
  });
  await saveUpstreamForTest(repo.upstreams, upstream);
  const stored = await repo.upstreams.getById(upstream.id);
  if (stored === null) throw new Error(`Upstream ${upstream.id} was not saved`);
  assertEquals(await seedModelsCache(repo.upstreams, upstream.id, modelsRefreshIdentity(stored), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: Date.now(),
    models: projectCustomModels(stored),
  }), true);
};

const postChatCompletions = (apiKey: string) => requestApp('/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
  body: JSON.stringify({ model: 'peak-chat', messages: [{ role: 'user', content: 'Hello' }] }),
});

test('peak + toggle on rejects chat completions with 429 and a retry time', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await seedPeakChatUpstream(repo, true);

  vi.useFakeTimers();
  vi.setSystemTime(PEAK_NOW);
  try {
    const response = await postChatCompletions(apiKey.key);
    assertEquals(response.status, 429);
    assertEquals(response.headers.get('retry-after'), '10800');
    assertEquals(await response.json(), {
      error: {
        message: 'Model peak-chat is blocked during DeepSeek peak pricing. Off-peak starts at 2026-09-29T10:00:00.000Z (retry in 10800s).',
        type: 'invalid_request_error',
        param: 'model',
        code: null,
      },
    });
  } finally {
    vi.useRealTimers();
  }
});

test('peak + toggle off serves chat completions from the upstream', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await seedPeakChatUpstream(repo, false);

  await withMockedFetch(async request => {
    if (new URL(request.url).hostname === 'custom.example.com') {
      return sseOpenAIChatCompletionsResponse({
        id: 'chatcmpl-peak-off',
        model: 'peak-chat',
        created: 0,
        choices: [{ message: { role: 'assistant', content: 'Served at peak' }, finish_reason: 'stop' }],
      });
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(PEAK_NOW);
    try {
      const response = await postChatCompletions(apiKey.key);
      assertEquals(response.status, 200);
      await response.json();
    } finally {
      vi.useRealTimers();
    }
  });
});
