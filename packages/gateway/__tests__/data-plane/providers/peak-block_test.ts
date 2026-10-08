import { test } from 'vitest';

import { enumerateModelCandidates } from '../../../src/data-plane/providers/resolution.ts';
import { MODEL_CATALOG_REVISION } from '../../../src/repo/models-cache-contract.ts';
import { modelsRefreshIdentity, seedModelsCache } from '../../repo/models-cache-fixture.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, setupAppTest } from '../../test-utils/app.ts';
import { projectCustomModels } from '@floway-dev/provider-custom';
import { assertEquals } from '@floway-dev/test-utils';

// Tuesday 2026-09-29: 07:00 UTC is inside the weekday peak window and clear
// of the National Day holiday week; 05:00 UTC is off-peak.
const PEAK = new Date('2026-09-29T07:00:00Z');
const OFF_PEAK = new Date('2026-09-29T05:00:00Z');

const PEAK_PRICING = {
  entries: [
    { rates: { input_tokens: '1.32', output_tokens: '3.96' } },
    { selector: { pricingPeriod: 'off-peak' }, rates: { input_tokens: '0.66', output_tokens: '1.98' } },
  ],
};

const BASE_PRICING = {
  entries: [{ rates: { input_tokens: '1.32', output_tokens: '3.96' } }],
};

const chatModel = (upstreamModelId: string, pricing: typeof PEAK_PRICING) => ({
  upstreamModelId,
  kind: 'chat' as const,
  endpoints: { openaiChatCompletions: {} },
  pricing,
});

const testScheduler = (promise: Promise<unknown>): void => {
  promise.catch(error => console.error('[background]', error));
};

const seedPeakUpstream = async (
  repo: Awaited<ReturnType<typeof setupAppTest>>['repo'],
  overrides: Parameters<typeof buildCustomUpstreamRecord>[0],
) => {
  const upstream = buildCustomUpstreamRecord(overrides);
  await saveUpstreamForTest(repo.upstreams, upstream);
  const stored = await repo.upstreams.getById(upstream.id);
  if (stored === null) throw new Error(`Upstream ${upstream.id} was not saved`);
  assertEquals(await seedModelsCache(repo.upstreams, upstream.id, modelsRefreshIdentity(stored), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: Date.now(),
    models: projectCustomModels(stored),
  }), true);
};

const resolve = (model: string, now: Date) => enumerateModelCandidates({
  upstreamIds: null,
  model,
  kind: 'chat',
  scheduler: testScheduler,
  runtimeLocation: 'TEST',
  now,
});

const customConfig = (models: ReturnType<typeof chatModel>[]) => ({
  baseUrl: 'https://custom.example.com',
  authStyle: 'bearer',
  ingressHeadersRules: [],
  apiKey: 'sk-custom',
  endpoints: { openaiChatCompletions: {} },
  modelsFetch: { enabled: false },
  models,
});

test('peak + toggle on blocks a peak-priced model with retry timing', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await seedPeakUpstream(repo, {
    config: customConfig([chatModel('peak-chat', PEAK_PRICING)]),
    blockPeakPricedModels: true,
  });

  const resolved = await resolve('peak-chat', PEAK);
  assertEquals(resolved.candidates.length, 0);
  assertEquals(resolved.sawModel, true);
  assertEquals(resolved.peakBlock, {
    retryAfterSeconds: 10_800,
    nextOffPeak: '2026-09-29T10:00:00.000Z',
  });
});

test('peak + toggle on still serves a Base-only model', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await seedPeakUpstream(repo, {
    config: customConfig([chatModel('plain-chat', BASE_PRICING)]),
    blockPeakPricedModels: true,
  });

  const resolved = await resolve('plain-chat', PEAK);
  assertEquals(resolved.candidates.length, 1);
  assertEquals(resolved.peakBlock, null);
});

test('peak + toggle off serves a peak-priced model', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await seedPeakUpstream(repo, {
    config: customConfig([chatModel('peak-chat', PEAK_PRICING)]),
    blockPeakPricedModels: false,
  });

  const resolved = await resolve('peak-chat', PEAK);
  assertEquals(resolved.candidates.length, 1);
  assertEquals(resolved.peakBlock, null);
});

test('off-peak + toggle on serves a peak-priced model', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await seedPeakUpstream(repo, {
    config: customConfig([chatModel('peak-chat', PEAK_PRICING)]),
    blockPeakPricedModels: true,
  });

  const resolved = await resolve('peak-chat', OFF_PEAK);
  assertEquals(resolved.candidates.length, 1);
  assertEquals(resolved.peakBlock, null);
});

test('peak serves through a sibling upstream without the toggle', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await seedPeakUpstream(repo, {
    id: 'up_blocked',
    config: customConfig([chatModel('peak-chat', PEAK_PRICING)]),
    blockPeakPricedModels: true,
  });
  await seedPeakUpstream(repo, {
    id: 'up_open',
    name: 'Open Provider',
    sortOrder: 101,
    config: { ...customConfig([chatModel('peak-chat', PEAK_PRICING)]), baseUrl: 'https://open.example.com' },
    blockPeakPricedModels: false,
  });

  const resolved = await resolve('peak-chat', PEAK);
  assertEquals(resolved.candidates.length, 1);
  assertEquals(resolved.peakBlock, null);
});
