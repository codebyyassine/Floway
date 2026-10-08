import { test } from 'vitest';

import { openAICacheTokensFromUsage, pricingPeriodForSchedule, recordTokenUsage, recordUsage, tokenUsageMeasurement } from '../../../../src/data-plane/shared/telemetry/usage.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { basePricing, modelPricing, pricingEntry } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

test('OpenAI canonical shape — prompt_tokens_details.cached_tokens lands in cacheRead', () => {
  assertEquals(
    openAICacheTokensFromUsage({ prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 80 } }),
    { cacheRead: 80, cacheWrite: 0 },
  );
});

test('DeepSeek shape — prompt_cache_hit_tokens at usage root lands in cacheRead', () => {
  // DeepSeek emits `prompt_cache_hit_tokens` + `prompt_cache_miss_tokens` at
  // the usage root; prompt_tokens is hit + miss.
  assertEquals(
    openAICacheTokensFromUsage({ prompt_tokens: 200, completion_tokens: 5, prompt_cache_hit_tokens: 128, prompt_cache_miss_tokens: 72 }),
    { cacheRead: 128, cacheWrite: 0 },
  );
});

test('Flat shape — top-level cached_tokens (Moonshot / Cohere v2 / Qwen Singapore legacy)', () => {
  assertEquals(
    openAICacheTokensFromUsage({ prompt_tokens: 50, completion_tokens: 3, cached_tokens: 32 }),
    { cacheRead: 32, cacheWrite: 0 },
  );
});

test('OpenAI canonical wins when both nested and flat are present (the wrapped form is authoritative)', () => {
  assertEquals(
    openAICacheTokensFromUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 64 }, cached_tokens: 999 }),
    { cacheRead: 64, cacheWrite: 0 },
  );
});

test('Cache-write — Anthropic-style cache_creation_input_tokens under the wrapper', () => {
  assertEquals(
    openAICacheTokensFromUsage({ prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 30, cache_creation_input_tokens: 50 } }),
    { cacheRead: 30, cacheWrite: 50 },
  );
});

test('Cache-write — OpenRouter cache_write_tokens under the wrapper', () => {
  assertEquals(
    openAICacheTokensFromUsage({ prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 50 } }),
    { cacheRead: 30, cacheWrite: 50 },
  );
});

test('cache_creation_input_tokens wins over cache_write_tokens when both are present (Anthropic-native name is authoritative)', () => {
  assertEquals(
    openAICacheTokensFromUsage({ prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cache_creation_input_tokens: 20, cache_write_tokens: 50 } }),
    { cacheRead: 0, cacheWrite: 20 },
  );
});

test('Zero on missing / malformed / fields-absent usage blocks', () => {
  assertEquals(openAICacheTokensFromUsage(null), { cacheRead: 0, cacheWrite: 0 });
  assertEquals(openAICacheTokensFromUsage(undefined), { cacheRead: 0, cacheWrite: 0 });
  assertEquals(openAICacheTokensFromUsage('not an object'), { cacheRead: 0, cacheWrite: 0 });
  assertEquals(openAICacheTokensFromUsage({}), { cacheRead: 0, cacheWrite: 0 });
  assertEquals(openAICacheTokensFromUsage({ prompt_tokens: 10, completion_tokens: 2 }), { cacheRead: 0, cacheWrite: 0 });
  // Gemini OpenAI-compat emits `prompt_tokens_details: null` on cache miss
  // (not an empty object); the optional chain has to absorb that.
  assertEquals(openAICacheTokensFromUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: null }), { cacheRead: 0, cacheWrite: 0 });
  // Non-numeric noise falls through.
  assertEquals(openAICacheTokensFromUsage({ prompt_tokens_details: { cached_tokens: 'no' } }), { cacheRead: 0, cacheWrite: 0 });
  assertEquals(openAICacheTokensFromUsage({ prompt_cache_hit_tokens: null }), { cacheRead: 0, cacheWrite: 0 });
});

test('Zero is a valid count, not a missing signal', () => {
  // vLLM with --enable-prompt-tokens-details emits cached_tokens: 0 on a cold
  // request after PR #44383; an honest zero must not fall through to the
  // next candidate.
  assertEquals(
    openAICacheTokensFromUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 }, cached_tokens: 999 }),
    { cacheRead: 0, cacheWrite: 0 },
  );
});

test('recordUsage persists caller-supplied metrics with resolved prices', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  await recordUsage(
    'key-a',
    {
      model: 'metered-model',
      upstream: 'upstream-a',
      modelKey: 'metered-model',
      pricing: basePricing({ input_tokens: '0.6' }),
    },
    { input_tokens: '90' },
    {},
  );

  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].requests, 1);
  assertEquals(rows[0].metrics, [{ metric: 'input_tokens', quantity: '90', unitPrice: '0.6' }]);
});

test('recordUsage prices audio duration and token metrics together', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  await recordUsage(
    'key-a',
    {
      model: 'composite-audio-model',
      upstream: 'upstream-a',
      modelKey: 'composite-audio-model',
      pricing: basePricing({ input_audio_seconds: '0.0001', input_audio_tokens: '0.000005' }),
    },
    { input_audio_seconds: '90.5', input_audio_tokens: '2400' },
    { inputTokens: 2400 },
  );

  const [row] = await repo.usage.listAll();
  assertEquals(row.metrics, [
    { metric: 'input_audio_tokens', quantity: '2400', unitPrice: '0.000005' },
    { metric: 'input_audio_seconds', quantity: '90.5', unitPrice: '0.0001' },
  ]);
});

test('pricingPeriodForSchedule stamps off-peak and omits peak and missing timestamps', () => {
  // Peak windows (pinned in full by the shared schedule): 01:00-04:00
  // UTC daily, plus 06:00-10:00 UTC Monday-Friday. Fixtures use Monday
  // 2026-09-28 and Tuesday 2026-09-29, clear of the Mid-Autumn (09-25–09-27)
  // and National Day (10-01–10-07) holiday weeks, so the plain window rule
  // applies.
  assertEquals(pricingPeriodForSchedule('deepseek', new Date('2026-09-28T00:59:00Z')), 'off-peak');
  assertEquals(pricingPeriodForSchedule('deepseek', new Date('2026-09-28T01:00:00Z')), undefined);
  assertEquals(pricingPeriodForSchedule('deepseek', new Date('2026-09-28T03:59:00Z')), undefined);
  assertEquals(pricingPeriodForSchedule('deepseek', new Date('2026-09-28T04:00:00Z')), 'off-peak');
  assertEquals(pricingPeriodForSchedule('deepseek', new Date('2026-09-29T05:59:00Z')), 'off-peak');
  assertEquals(pricingPeriodForSchedule('deepseek', new Date('2026-09-29T06:00:00Z')), undefined);
  assertEquals(pricingPeriodForSchedule('deepseek', new Date('2026-09-29T09:59:00Z')), undefined);
  assertEquals(pricingPeriodForSchedule('deepseek', new Date('2026-09-29T10:00:00Z')), 'off-peak');
  // Weekend morning skips the weekday peak window.
  assertEquals(pricingPeriodForSchedule('deepseek', new Date('2026-10-10T07:00:00Z')), 'off-peak');
  // A flat schedule never stamps, whatever the hour.
  assertEquals(pricingPeriodForSchedule(null, new Date('2026-09-28T00:59:00Z')), undefined);
  assertEquals(pricingPeriodForSchedule('deepseek', undefined), undefined);
  assertEquals(pricingPeriodForSchedule('deepseek', null), undefined);
});

test('tokenUsageMeasurement stamps off-peak pricingPeriod while preserving serviceTier and inputTokens', () => {
  const measurement = tokenUsageMeasurement(
    { input: 100, input_cache_read: 20, output: 50, tier: 'flex' },
    new Date('2026-09-28T00:59:00Z'),
    'deepseek',
  );
  assertEquals(measurement.pricingFacts, { serviceTier: 'flex', inputTokens: 120, pricingPeriod: 'off-peak' });
  assertEquals(measurement.quantities, { input_tokens: '100', input_cache_read_tokens: '20', output_tokens: '50' });
});

test('tokenUsageMeasurement omits pricingPeriod at peak hours and when the timestamp is absent', () => {
  const peak = tokenUsageMeasurement({ input: 100, output: 50 }, new Date('2026-09-28T01:00:00Z'), 'deepseek');
  assertEquals(peak.pricingFacts, { serviceTier: undefined, inputTokens: 100 });
  assertEquals('pricingPeriod' in peak.pricingFacts, false);
  for (const measurement of [
    tokenUsageMeasurement({ input: 100 }),
    tokenUsageMeasurement({ input: 100 }, null),
    tokenUsageMeasurement(null),
  ]) {
    assertEquals('pricingPeriod' in measurement.pricingFacts, false);
  }
});

test('recordTokenUsage resolves the off-peak entry inside the window and Base outside it', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const pricing = modelPricing(
    pricingEntry({ input_tokens: '5', output_tokens: '30' }),
    pricingEntry({ input_tokens: '2', output_tokens: '12' }, { pricingPeriod: 'off-peak' }),
  );
  const identity = { model: 'period-model', upstream: 'upstream-a', modelKey: 'period-model', pricing, peakScheduleId: 'deepseek' };

  await recordTokenUsage('key-a', identity, { input: 10, output: 4 }, new Date('2026-09-28T00:59:00Z'));
  await recordTokenUsage('key-a', identity, { input: 10, output: 4 }, new Date('2026-09-28T01:00:00Z'));

  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 2);
  const bySelector = new Map(rows.map(row => [JSON.stringify(row.pricingSelector), row]));
  const offPeak = bySelector.get(JSON.stringify({ pricingPeriod: 'off-peak' }));
  const base = bySelector.get(JSON.stringify({}));
  assertEquals(offPeak?.metrics, [
    { metric: 'input_tokens', quantity: '10', unitPrice: '2' },
    { metric: 'output_tokens', quantity: '4', unitPrice: '12' },
  ]);
  assertEquals(base?.metrics, [
    { metric: 'input_tokens', quantity: '10', unitPrice: '5' },
    { metric: 'output_tokens', quantity: '4', unitPrice: '30' },
  ]);
});
