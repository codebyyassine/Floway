import { test, vi } from 'vitest';

import { MODEL_CATALOG_REVISION } from '../../../src/repo/models-cache-contract.ts';
import { modelsRefreshIdentity, seedModelsCache } from '../../repo/models-cache-fixture.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { projectCustomModels } from '@floway-dev/provider-custom';
import { assertEquals } from '@floway-dev/test-utils';

// The passthrough endpoints (embeddings, images, audio, /completions) share
// one serve scaffold, so one 429 here covers the branch for all of them.
test('/v1/embeddings rejects a peak-priced model with 429 during peak', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const upstream = buildCustomUpstreamRecord({
    config: {
      baseUrl: 'https://custom.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-custom',
      endpoints: { openaiEmbeddings: {} },
      modelsFetch: { enabled: false },
      models: [{
        upstreamModelId: 'peak-embed',
        kind: 'embedding',
        endpoints: { openaiEmbeddings: {} },
        pricing: {
          entries: [
            { rates: { input_tokens: '0.15' } },
            { selector: { pricingPeriod: 'off-peak' }, rates: { input_tokens: '0.075' } },
          ],
        },
      }],
    },
    blockPeakPricedModels: true,
  });
  await saveUpstreamForTest(repo.upstreams, upstream);
  const stored = await repo.upstreams.getById(upstream.id);
  if (stored === null) throw new Error(`Upstream ${upstream.id} was not saved`);
  assertEquals(await seedModelsCache(repo.upstreams, upstream.id, modelsRefreshIdentity(stored), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: Date.now(),
    models: projectCustomModels(stored),
  }), true);

  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T07:00:00Z'));
  try {
    const response = await requestApp('/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
      body: JSON.stringify({ model: 'peak-embed', input: 'hello' }),
    });
    assertEquals(response.status, 429);
    assertEquals(response.headers.get('retry-after'), '10800');
    assertEquals(await response.json(), {
      error: {
        message: 'Model peak-embed is blocked during DeepSeek peak pricing. Off-peak starts at 2026-09-29T10:00:00.000Z (retry in 10800s).',
        type: 'api_error',
      },
    });
  } finally {
    vi.useRealTimers();
  }
});
