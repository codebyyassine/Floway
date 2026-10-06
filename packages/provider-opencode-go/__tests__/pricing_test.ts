import { test } from 'vitest';

import { pricingForOpencodeGoModelKey } from '../src/pricing.ts';
import { perMillionTokenRates, priceRequest, type PriceVector } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const published = (rates: PriceVector): PriceVector => perMillionTokenRates(rates);

test('pricingForOpencodeGoModelKey returns the generated registry rate for grok-4.7 with its long-context tier', () => {
  const pricing = pricingForOpencodeGoModelKey('grok-4.7');
  assertEquals(pricing?.entries[0]?.rates.input_tokens, '0.000002');
  assertEquals(pricing?.entries[0]?.rates.output_tokens, '0.000006');
  assertEquals(pricing?.entries[0]?.rates.input_cache_read_tokens, '0.0000005');
  // The >200000 tier entry exists alongside the base entry.
  assertEquals(pricing?.entries.length, 2);
  assertEquals(pricing?.entries[1]?.selector, { inputTokens: { operator: 'gte', value: 200000 } });
  assertEquals(priceRequest(pricing, { inputTokens: 199999 }).rates, published({ input_tokens: '2.00', output_tokens: '6.00', input_cache_read_tokens: '0.50' }));
  assertEquals(priceRequest(pricing, { inputTokens: 200000 }).rates, published({ input_tokens: '4.00', output_tokens: '12.00', input_cache_read_tokens: '1.00' }));
});

test('pricingForOpencodeGoModelKey bills minimax-m3 at the tier rate above 512000 input tokens', () => {
  const pricing = pricingForOpencodeGoModelKey('minimax-m3');
  assertEquals(pricing?.entries.length, 2);
  assertEquals(pricing?.entries[1]?.selector, { inputTokens: { operator: 'gte', value: 512000 } });
  assertEquals(priceRequest(pricing, { inputTokens: 511999 }).rates, published({ input_tokens: '0.30', output_tokens: '1.20', input_cache_read_tokens: '0.06' }));
  assertEquals(priceRequest(pricing, { inputTokens: 512000 }).rates, published({ input_tokens: '0.60', output_tokens: '2.40', input_cache_read_tokens: '0.12' }));
});

test('pricingForOpencodeGoModelKey resolves space-bunny and space-bunny-free to different rates', () => {
  assertEquals(
    priceRequest(pricingForOpencodeGoModelKey('space-bunny'), { inputTokens: 0 }).rates,
    published({ input_tokens: '0.15', output_tokens: '0.60', input_cache_read_tokens: '0.03', input_cache_write_tokens: '0' }),
  );
  assertEquals(
    priceRequest(pricingForOpencodeGoModelKey('space-bunny-free'), { inputTokens: 0 }).rates,
    { input_tokens: '0', output_tokens: '0', input_cache_read_tokens: '0', input_cache_write_tokens: '0' },
  );
});

test('pricingForOpencodeGoModelKey prices qwen3.6-plus and qwen3.7-max from the registry', () => {
  const qwen36 = pricingForOpencodeGoModelKey('qwen3.6-plus');
  assertEquals(qwen36?.entries.length, 2);
  assertEquals(priceRequest(qwen36, { inputTokens: 0 }).rates, published({ input_tokens: '0.50', output_tokens: '3.00', input_cache_read_tokens: '0.05', input_cache_write_tokens: '0.625' }));
  assertEquals(priceRequest(qwen36, { inputTokens: 256000 }).rates, published({ input_tokens: '2.00', output_tokens: '6.00', input_cache_read_tokens: '0.20', input_cache_write_tokens: '2.50' }));
  assertEquals(
    priceRequest(pricingForOpencodeGoModelKey('qwen3.7-max'), { inputTokens: 0 }).rates,
    published({ input_tokens: '2.50', output_tokens: '7.50', input_cache_read_tokens: '0.50', input_cache_write_tokens: '3.125' }),
  );
});

test('pricingForOpencodeGoModelKey prices cache-write models with the full metric set', () => {
  assertEquals(
    priceRequest(pricingForOpencodeGoModelKey('gpt-6-luna'), { inputTokens: 0 }).rates,
    published({ input_tokens: '0.10', output_tokens: '0.50', input_cache_read_tokens: '0.01', input_cache_write_tokens: '0.125' }),
  );
  assertEquals(
    priceRequest(pricingForOpencodeGoModelKey('gpt-6-luna'), { inputTokens: 272000 }).rates,
    published({ input_tokens: '0.20', output_tokens: '0.75', input_cache_read_tokens: '0.02', input_cache_write_tokens: '0.25' }),
  );
});

test('pricingForOpencodeGoModelKey prices free models at zero rather than leaving them unpriced', () => {
  assertEquals(
    priceRequest(pricingForOpencodeGoModelKey('space-bunny-free'), { inputTokens: 0 }).rates,
    { input_tokens: '0', output_tokens: '0', input_cache_read_tokens: '0', input_cache_write_tokens: '0' },
  );
});

test('pricingForOpencodeGoModelKey returns null for ids outside the generated table', () => {
  assertEquals(pricingForOpencodeGoModelKey('unknown-model'), null);
  assertEquals(pricingForOpencodeGoModelKey(''), null);
});
