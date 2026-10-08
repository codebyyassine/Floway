import { describe, expect, test } from 'vitest';

import { candidatePassesPeakGate, isPeakPricedModel, peakBlockForSchedule, peakBlockedMessage } from '../../../src/data-plane/providers/peak-gate.ts';
import { modelPricing, tokenPricingEntry } from '@floway-dev/protocols/common';
import { peakScheduleIdOfCandidate, type FlagId, type ModelCandidate } from '@floway-dev/provider';
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

describe('peakBlockForSchedule', () => {
  test('a flat schedule never blocks', () => {
    assertEquals(peakBlockForSchedule(null, new Date('2026-09-29T07:00:00Z')), null);
  });

  test('off-peak requests pass with no block', () => {
    // Tuesday 2026-09-29, between the two peak windows.
    assertEquals(peakBlockForSchedule('deepseek', new Date('2026-09-29T05:00:00Z')), null);
  });

  test('a statutory-holiday Beijing day never blocks', () => {
    // Thursday 2026-10-01 sits inside the National Day holiday week: the
    // weekday window would be peak, but the whole Beijing day is off-peak.
    assertEquals(peakBlockForSchedule('deepseek', new Date('2026-10-01T07:00:00Z')), null);
  });

  test('a weekday-morning peak blocks until 10:00 UTC', () => {
    assertEquals(peakBlockForSchedule('deepseek', new Date('2026-09-29T07:00:00Z')), {
      retryAfterSeconds: 10_800,
      nextOffPeak: '2026-09-29T10:00:00.000Z',
      scheduleId: 'deepseek',
    });
  });

  test('the daily window blocks until 04:00 UTC', () => {
    assertEquals(peakBlockForSchedule('deepseek', new Date('2026-09-28T02:30:00Z')), {
      retryAfterSeconds: 5_400,
      nextOffPeak: '2026-09-28T04:00:00.000Z',
      scheduleId: 'deepseek',
    });
  });

  test('the block ends on a minute boundary in the future', () => {
    const now = new Date('2026-09-29T09:59:30Z');
    const block = peakBlockForSchedule('deepseek', now);
    expect(block).not.toBeNull();
    assertEquals(block!.nextOffPeak, '2026-09-29T10:00:00.000Z');
    assertEquals(block!.retryAfterSeconds, 30);
  });

  test('an unknown schedule fails loudly', () => {
    let error: unknown;
    try {
      peakBlockForSchedule('nope', new Date('2026-09-29T07:00:00Z'));
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(Error);
  });

  test('a single-window schedule blocks on its own hours', () => {
    // Zhipu coding peak is weekdays 06:00-10:00 UTC only: 02:00 UTC is
    // off-peak there while DeepSeek's daily window is peak.
    assertEquals(peakBlockForSchedule('zhipu-coding', new Date('2026-09-28T02:30:00Z')), null);
    assertEquals(peakBlockForSchedule('zhipu-coding', new Date('2026-09-29T07:00:00Z'))?.nextOffPeak, '2026-09-29T10:00:00.000Z');
  });

  test('an overnight schedule wraps past midnight', () => {
    // Qwen night peak is 00:00-14:00 UTC daily: 13:59 blocks briefly while
    // 15:00 (DeepSeek weekday-peak) is off-peak.
    assertEquals(peakBlockForSchedule('qwen-night', new Date('2026-09-29T13:59:00Z'))?.nextOffPeak, '2026-09-29T14:00:00.000Z');
    assertEquals(peakBlockForSchedule('qwen-night', new Date('2026-09-29T07:00:00Z'))?.nextOffPeak, '2026-09-29T14:00:00.000Z');
  });
});

describe('peakBlockedMessage', () => {
  test('names the schedule of the block', () => {
    assertEquals(
      peakBlockedMessage({ model: 'm', retryAfterSeconds: 60, nextOffPeak: '2026-09-29T10:00:00.000Z', scheduleId: 'deepseek' }),
      'Model m is blocked during DeepSeek peak pricing. Off-peak starts at 2026-09-29T10:00:00.000Z (retry in 60s).',
    );
  });
});

const candidateWith = (overrides: {
  blockPeakPricedModels?: boolean;
  peakScheduleOverride?: string;
  manualPeakSchedules?: Record<string, string | null>;
  modelScheduleId?: string | null;
}): ModelCandidate => {
  const pricing = modelPricing(
    tokenPricingEntry(PEAK_RATES),
    tokenPricingEntry(OFF_PEAK_RATES, { pricingPeriod: 'off-peak' }),
  );
  const providerModel = {
    id: 'peak-chat',
    upstreamModelId: 'peak-chat',
    limits: {},
    kind: 'chat' as const,
    pricing,
    endpoints: { openaiChatCompletions: {} },
    opaqueBlobCompatibilityScope: { bindToUpstream: true },
    providerData: 'peak-chat',
    enabledFlags: new Set<FlagId>(),
    ...(overrides.modelScheduleId !== undefined ? { peakScheduleId: overrides.modelScheduleId } : {}),
  };
  return {
    provider: {
      upstreamId: 'up',
      kind: 'custom' as const,
      name: 'Up',
      inboundHeaderAllowlist: [],
      disabledPublicModelIds: [],
      blockPeakPricedModels: overrides.blockPeakPricedModels ?? true,
      peakScheduleOverride: overrides.peakScheduleOverride,
      manualPeakSchedules: overrides.manualPeakSchedules,
      modelsCache: null,
      modelPrefix: null,
      instance: undefined as never,
    },
    model: {
      id: 'peak-chat',
      limits: {},
      kind: 'chat' as const,
      pricing,
      endpoints: { openaiChatCompletions: {} },
      providerModels: { up: providerModel },
    },
    fetcher: undefined as never,
  };
};

describe('candidatePassesPeakGate', () => {
  // Tuesday 2026-09-29T07:00:00Z is DeepSeek peak and Zhipu-coding peak.
  const PEAK = new Date('2026-09-29T07:00:00Z');

  test('a legacy row with no schedule falls back to DeepSeek windows', () => {
    const candidate = candidateWith({});
    assertEquals(peakScheduleIdOfCandidate(candidate), 'deepseek');
    assertEquals(candidatePassesPeakGate(candidate, PEAK), false);
  });

  test('an upstream flat override serves through peak', () => {
    const candidate = candidateWith({ peakScheduleOverride: 'none' });
    assertEquals(peakScheduleIdOfCandidate(candidate), null);
    assertEquals(candidatePassesPeakGate(candidate, PEAK), true);
  });

  test('an explicit manual choice wins over the upstream override', () => {
    const candidate = candidateWith({
      peakScheduleOverride: 'none',
      manualPeakSchedules: { 'peak-chat': 'deepseek' },
    });
    assertEquals(peakScheduleIdOfCandidate(candidate), 'deepseek');
    assertEquals(candidatePassesPeakGate(candidate, PEAK), false);
  });

  test('an explicit manual flat wins over a peak upstream override', () => {
    const candidate = candidateWith({
      peakScheduleOverride: 'deepseek',
      manualPeakSchedules: { 'peak-chat': null },
    });
    assertEquals(peakScheduleIdOfCandidate(candidate), null);
    assertEquals(candidatePassesPeakGate(candidate, PEAK), true);
  });

  test('without the toggle nothing blocks', () => {
    assertEquals(candidatePassesPeakGate(candidateWith({ blockPeakPricedModels: false }), PEAK), true);
  });
});
