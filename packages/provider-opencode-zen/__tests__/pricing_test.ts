import { test } from 'vitest';

import { pricingForOpencodeZenModelKey } from '../src/pricing.ts';
import { perMillionTokenRates, priceRequest, type PriceVector } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const published = (rates: PriceVector): PriceVector => perMillionTokenRates(rates);

test('pricingForOpencodeZenModelKey returns the generated registry rate for gpt-5.5 with its long-context tier', () => {
  const pricing = pricingForOpencodeZenModelKey('gpt-5.5');
  assertEquals(pricing?.entries[0]?.rates.input_tokens, '0.000005');
  assertEquals(pricing?.entries[0]?.rates.output_tokens, '0.00003');
  assertEquals(pricing?.entries[0]?.rates.input_cache_read_tokens, '0.0000005');
  // The >272000 tier entry exists alongside the base entry.
  assertEquals(pricing?.entries.length, 2);
  assertEquals(pricing?.entries[1]?.selector, { inputTokens: { operator: 'gte', value: 272000 } });
  assertEquals(priceRequest(pricing, { inputTokens: 271999 }).rates, published({ input_tokens: '5.00', output_tokens: '30.00', input_cache_read_tokens: '0.50' }));
  assertEquals(priceRequest(pricing, { inputTokens: 272000 }).rates, published({ input_tokens: '10.00', output_tokens: '45.00', input_cache_read_tokens: '1.00' }));
});

test('pricingForOpencodeZenModelKey prices cache-write models with the full metric set', () => {
  assertEquals(
    priceRequest(pricingForOpencodeZenModelKey('qwen3.8-max'), { inputTokens: 0 }).rates,
    published({ input_tokens: '2.00', output_tokens: '6.00', input_cache_read_tokens: '0.25', input_cache_write_tokens: '2.50' }),
  );
  assertEquals(
    priceRequest(pricingForOpencodeZenModelKey('claude-opus-5-5'), { inputTokens: 0 }).rates,
    published({ input_tokens: '4.00', output_tokens: '20.00', input_cache_read_tokens: '0.20', input_cache_write_tokens: '5.00' }),
  );
});

test('pricingForOpencodeZenModelKey prices free models at zero rather than leaving them unpriced', () => {
  assertEquals(
    priceRequest(pricingForOpencodeZenModelKey('space-bunny-free'), { inputTokens: 0 }).rates,
    { input_tokens: '0', output_tokens: '0', input_cache_read_tokens: '0', input_cache_write_tokens: '0' },
  );
  assertEquals(
    priceRequest(pricingForOpencodeZenModelKey('mimo-v2.5-free'), { inputTokens: 0 }).rates,
    { input_tokens: '0', output_tokens: '0', input_cache_read_tokens: '0' },
  );
});

test('pricingForOpencodeZenModelKey returns null for ids outside the generated table', () => {
  assertEquals(pricingForOpencodeZenModelKey('unknown-model'), null);
  assertEquals(pricingForOpencodeZenModelKey(''), null);
});
