import { describe, expect, test } from 'vitest';

import { isPeakPricedModel, peakBlockAfter } from '../../../src/data-plane/providers/peak-gate.ts';
import { modelPricing, tokenPricingEntry } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const PEAK_RATES = { input_tokens: '1.32', output_tokens: '3.96' };
const OFF_PEAK_RATES = { input_tokens: '0.66', output_tokens: '1.98' };

describe('isPeakPricedModel', () => {
  test('an unpriced model is not peak-priced', () => {
    assertEquals(isPeakPricedModel(undefined), false);
  });

  test('a Base-only model is not peak-priced', () => {
    assertEquals(isPeakPricedModel(modelPricing(tokenPricingEntry(PEAK_RATES))), false);
  });

  test('a model with an off-peak entry is peak-priced', () => {
    const pricing = modelPricing(
      tokenPricingEntry(PEAK_RATES),
      tokenPricingEntry(OFF_PEAK_RATES, { pricingPeriod: 'off-peak' }),
    );
    assertEquals(isPeakPricedModel(pricing), true);
  });
});

describe('peakBlockAfter', () => {
  test('off-peak requests pass with no block', () => {
    // Tuesday 2026-09-29, between the two peak windows.
    assertEquals(peakBlockAfter(new Date('2026-09-29T05:00:00Z')), null);
  });

  test('a statutory-holiday Beijing day never blocks', () => {
    // Thursday 2026-10-01 sits inside the National Day holiday week: the
    // weekday window would be peak, but the whole Beijing day is off-peak.
    assertEquals(peakBlockAfter(new Date('2026-10-01T07:00:00Z')), null);
  });

  test('a weekday-morning peak blocks until 10:00 UTC', () => {
    assertEquals(peakBlockAfter(new Date('2026-09-29T07:00:00Z')), {
      retryAfterSeconds: 10_800,
      nextOffPeak: '2026-09-29T10:00:00.000Z',
    });
  });

  test('the daily window blocks until 04:00 UTC', () => {
    assertEquals(peakBlockAfter(new Date('2026-09-28T02:30:00Z')), {
      retryAfterSeconds: 5_400,
      nextOffPeak: '2026-09-28T04:00:00.000Z',
    });
  });

  test('the block ends on a minute boundary in the future', () => {
    const now = new Date('2026-09-29T09:59:30Z');
    const block = peakBlockAfter(now);
    expect(block).not.toBeNull();
    assertEquals(block!.nextOffPeak, '2026-09-29T10:00:00.000Z');
    assertEquals(block!.retryAfterSeconds, 30);
  });
});
