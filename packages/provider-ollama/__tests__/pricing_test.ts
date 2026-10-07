import { test } from 'vitest';

import { deepseekPricingPeriod, isDeepSeekPeak } from '../src/deepseek-peak.ts';
import { pricingForOllamaModelKey } from '../src/pricing.ts';
import { perMillionTokenRates, priceRequest, type PriceVector } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const published = (rates: PriceVector): PriceVector => perMillionTokenRates(rates);

test('pricingForOllamaModelKey returns table rates for known model ids', () => {
  const gptOss = pricingForOllamaModelKey('gpt-oss:120b');
  assertEquals(gptOss?.entries[0]?.rates.input_tokens, '0.00000015');
  assertEquals(gptOss?.entries[0]?.rates.output_tokens, '0.0000006');
});

test('pricingForOllamaModelKey matches regex-keyed families', () => {
  // GLM 5 split: bare `glm-5` is cheaper than `glm-5.1` / `glm-5.2`.
  assertEquals(pricingForOllamaModelKey('glm-5')?.entries[0]?.rates.input_tokens, '0.000001');
  assertEquals(pricingForOllamaModelKey('glm-5')?.entries[0]?.rates.output_tokens, '0.0000032');
  assertEquals(pricingForOllamaModelKey('glm-5.1')?.entries[0]?.rates.input_tokens, '0.0000014');
  assertEquals(pricingForOllamaModelKey('glm-5.2')?.entries[0]?.rates.output_tokens, '0.0000044');

  // MiniMax split: m2 / m2.1 / m2.5 carry cache_read 0.03; m2.7 / m3 carry
  // cache_read 0.06. Input/output are identical across both branches.
  assertEquals(pricingForOllamaModelKey('minimax-m2.1')?.entries[0]?.rates.input_cache_read_tokens, '0.00000003');
  assertEquals(pricingForOllamaModelKey('minimax-m2.5')?.entries[0]?.rates.input_cache_read_tokens, '0.00000003');
  assertEquals(pricingForOllamaModelKey('minimax-m2.7')?.entries[0]?.rates.input_cache_read_tokens, '0.00000006');
  const m3 = pricingForOllamaModelKey('minimax-m3');
  assertEquals(priceRequest(m3, { inputTokens: 512000 }).rates, { input_tokens: '0.0000003', input_cache_read_tokens: '0.00000006', output_tokens: '0.0000012' });
  assertEquals(priceRequest(m3, { inputTokens: 512001 }).rates, { input_tokens: '0.0000006', input_cache_read_tokens: '0.00000012', output_tokens: '0.0000024' });
});

test('pricingForOllamaModelKey returns null for ids without a defensible reference', () => {
  // Mistral Labs free tier — deliberately omitted; no commercial per-token
  // rate published.
  assertEquals(pricingForOllamaModelKey('devstral-small-2:24b'), null);
  // Version that does not map to any upstream release.
  assertEquals(pricingForOllamaModelKey('qwen3.5'), null);
  // Gemma 3 stays unpriced: Google sells it by Vertex GPU-hour rather than
  // per token, and it is not an Ollama Cloud SKU, so no host meters it the
  // way this table records.
  assertEquals(pricingForOllamaModelKey('gemma3:27b'), null);
});

test('Ollama prices Gemma 4 31B from the commodity floor', () => {
  // This reverses an earlier omission that reasoned only about Google's own
  // surface. Gemma 4 is open-weights-only, which is the case the table
  // already answers with the cheapest credible commodity host — the same
  // branch that prices gpt-oss from Groq and Nemotron from DeepInfra — and
  // `gemma4:31b` is a live Ollama Cloud SKU rather than a self-host-only tag.
  const rates = published({ input_tokens: '0.13', output_tokens: '0.38' });
  assertEquals(priceRequest(pricingForOllamaModelKey('gemma4:31b'), { inputTokens: 0 }).rates, rates);
  assertEquals(priceRequest(pricingForOllamaModelKey('gemma4'), { inputTokens: 0 }).rates, rates);
  // Ollama Cloud serves no other Gemma 4 size, and the cheaper 26B and E4B
  // builds must not inherit 31B's rate on a self-hosted deployment.
  assertEquals(pricingForOllamaModelKey('gemma4:26b'), null);
});

test('Ollama prices a dated DeepSeek V4-Flash tag as the undated one', () => {
  const rates = published({ input_tokens: '0.14', input_cache_read_tokens: '0.0028', output_tokens: '0.28' });
  assertEquals(priceRequest(pricingForOllamaModelKey('deepseek-v4-flash'), { inputTokens: 0 }).rates, rates);
  assertEquals(priceRequest(pricingForOllamaModelKey('deepseek-v4-flash:0731'), { inputTokens: 0 }).rates, rates);
});

test('Ollama prices Kimi K3 from Moonshot international', () => {
  assertEquals(
    priceRequest(pricingForOllamaModelKey('kimi-k3'), { inputTokens: 0 }).rates,
    published({ input_tokens: '3.0', input_cache_read_tokens: '0.3', output_tokens: '15.0' }),
  );
});

test('isDeepSeekPeak follows the UTC peak windows', () => {
  // Fixtures use the last week of September 2026: 2026-09-28 is a Monday and
  // 2026-09-29 a Tuesday, both clear of the Mid-Autumn (09-25–09-27) and
  // National Day (10-01–10-07) holiday weeks, so the plain window rule applies.
  // 01:00-04:00 UTC daily peak (Monday 2026-09-28).
  const cases: ReadonlyArray<readonly [iso: string, peak: boolean]> = [
    ['2026-09-28T00:59:00Z', false],
    ['2026-09-28T01:00:00Z', true],
    ['2026-09-28T03:59:00Z', true],
    ['2026-09-28T04:00:00Z', false],
    // 06:00-10:00 UTC weekday peak (Tuesday 2026-09-29).
    ['2026-09-29T05:59:00Z', false],
    ['2026-09-29T06:00:00Z', true],
    ['2026-09-29T09:59:00Z', true],
    ['2026-09-29T10:00:00Z', false],
    // Weekend morning is off-peak even inside the weekday window …
    ['2026-10-10T07:00:00Z', false],
    // … while the same clock time on a weekday is peak.
    ['2026-09-29T07:00:00Z', true],
  ];
  for (const [iso, peak] of cases) {
    const at = new Date(iso);
    assertEquals(isDeepSeekPeak(at), peak);
    assertEquals(deepseekPricingPeriod(at), peak ? 'peak' : 'off-peak');
  }
});

test('isDeepSeekPeak treats Chinese public holidays as full Beijing-day off-peak', () => {
  // National Day 2026-10-01 is a Thursday: the weekday 06:00-10:00 UTC window
  // would be peak, but the Beijing calendar day is a statutory holiday.
  const cases: ReadonlyArray<readonly [iso: string, peak: boolean]> = [
    // Holiday Thursday inside the weekday window → off-peak …
    ['2026-10-01T07:00:00Z', false],
    // … while the same clock time the Wednesday before is peak.
    ['2026-09-30T07:00:00Z', true],
    // The holiday also overrides the daily 01:00-04:00 UTC window (Beijing
    // 09:00-12:00 on National Day).
    ['2026-10-01T02:00:00Z', false],
    // Beijing-midnight boundary: 16:00 UTC is 00:00 in Beijing, so the
    // instant already belongs to the 10-01 holiday.
    ['2026-09-30T16:00:00Z', false],
    // The Thursday after the holiday week resumes peak pricing.
    ['2026-10-08T07:00:00Z', true],
    // Spring Festival weekday control (2026-02-17 Tuesday).
    ['2026-02-17T07:00:00Z', false],
  ];
  for (const [iso, peak] of cases) {
    const at = new Date(iso);
    assertEquals(isDeepSeekPeak(at), peak);
    assertEquals(deepseekPricingPeriod(at), peak ? 'peak' : 'off-peak');
  }
});

test('Ollama prices DeepSeek peak at Base with a half-price off-peak entry', () => {
  const v4Pro = pricingForOllamaModelKey('deepseek-v4-pro');
  assertEquals(
    priceRequest(v4Pro, {}).rates,
    published({ input_tokens: '1.32', input_cache_read_tokens: '0.044', output_tokens: '3.96' }),
  );
  assertEquals(
    priceRequest(v4Pro, { pricingPeriod: 'off-peak' }).rates,
    published({ input_tokens: '0.66', input_cache_read_tokens: '0.022', output_tokens: '1.98' }),
  );
  const flash = pricingForOllamaModelKey('deepseek-flash');
  assertEquals(
    priceRequest(flash, {}).rates,
    published({ input_tokens: '0.3', input_cache_read_tokens: '0.006', output_tokens: '1.2' }),
  );
  assertEquals(
    priceRequest(flash, { pricingPeriod: 'off-peak' }).rates,
    published({ input_tokens: '0.15', input_cache_read_tokens: '0.003', output_tokens: '0.6' }),
  );
});
