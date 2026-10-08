import { test } from 'vitest';

import {
  hasOffPeakPricingEntry,
  isSchedulePeak,
  nextOffPeakAfter,
  nextScheduleSwitch,
  normalizePeakScheduleOverride,
  PEAK_SCHEDULE_INHERIT,
  PEAK_SCHEDULE_NONE,
  pricingScheduleById,
  resolvePeakScheduleId,
  schedulePricingPeriod,
} from '../../src/common/pricing-schedule.ts';
import { modelPricing, tokenPricingEntry } from '../../src/common/pricing.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const at = (iso: string): Date => new Date(iso);

const deepseek = pricingScheduleById('deepseek')!;

test('the deepseek preset follows the UTC peak windows', () => {
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
    assertEquals(isSchedulePeak(deepseek, at(iso)), peak);
    assertEquals(schedulePricingPeriod(deepseek, at(iso)), peak ? 'peak' : 'off-peak');
  }
});

test('the deepseek preset treats Chinese public holidays as full Beijing-day off-peak', () => {
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
    assertEquals(isSchedulePeak(deepseek, at(iso)), peak);
    assertEquals(schedulePricingPeriod(deepseek, at(iso)), peak ? 'peak' : 'off-peak');
  }
});

test('single-window and overnight presets evaluate on their own hours', () => {
  const zhipu = pricingScheduleById('zhipu-coding')!;
  // 02:30 UTC is DeepSeek daily-window peak but before Zhipu's only window.
  assertEquals(isSchedulePeak(zhipu, at('2026-09-28T02:30:00Z')), false);
  assertEquals(isSchedulePeak(zhipu, at('2026-09-29T07:00:00Z')), true);
  // Weekends are off-peak by day-scope, with no holiday calendar.
  assertEquals(isSchedulePeak(zhipu, at('2026-10-10T07:00:00Z')), false);

  const qwen = pricingScheduleById('qwen-night')!;
  // Peak is 00:00-14:00 UTC daily (complement of 22:00-08:00 Beijing).
  assertEquals(isSchedulePeak(qwen, at('2026-09-29T13:59:00Z')), true);
  assertEquals(isSchedulePeak(qwen, at('2026-09-29T14:00:00Z')), false);
  assertEquals(isSchedulePeak(qwen, at('2026-09-29T00:00:00Z')), true);
});

test('nextOffPeakAfter and nextScheduleSwitch bracket the windows', () => {
  assertEquals(nextOffPeakAfter(deepseek, at('2026-09-29T07:00:00Z')), {
    retryAfterSeconds: 10_800,
    nextOffPeak: '2026-09-29T10:00:00.000Z',
  });
  assertEquals(nextOffPeakAfter(deepseek, at('2026-09-29T05:00:00Z')), null);
  assertEquals(nextScheduleSwitch(deepseek, at('2026-09-29T07:00:00Z')).toISOString(), '2026-09-29T10:00:00.000Z');
  assertEquals(nextScheduleSwitch(deepseek, at('2026-09-29T05:00:00Z')).toISOString(), '2026-09-29T06:00:00.000Z');
  // Overnight wrap: 13:59 UTC on Qwen night ends at 14:00 UTC.
  const qwen = pricingScheduleById('qwen-night')!;
  assertEquals(nextOffPeakAfter(qwen, at('2026-09-29T13:59:00Z'))?.nextOffPeak, '2026-09-29T14:00:00.000Z');
});

test('resolvePeakScheduleId prefers manual, then upstream, then catalog', () => {
  const base = { modelId: 'm', modelScheduleId: 'deepseek' as string | null };
  assertEquals(resolvePeakScheduleId(base), 'deepseek');
  assertEquals(resolvePeakScheduleId({ ...base, upstreamOverride: 'none' }), null);
  assertEquals(resolvePeakScheduleId({ ...base, upstreamOverride: 'zhipu-coding' }), 'zhipu-coding');
  assertEquals(
    resolvePeakScheduleId({ ...base, upstreamOverride: 'none', manualSchedules: { m: 'qwen-night' } }),
    'qwen-night',
  );
  assertEquals(
    resolvePeakScheduleId({ ...base, upstreamOverride: 'deepseek', manualSchedules: { m: null } }),
    null,
  );
  assertEquals(resolvePeakScheduleId({ modelId: 'm' }), null);
});

test('normalizePeakScheduleOverride defaults to inherit and rejects unknown ids', () => {
  assertEquals(normalizePeakScheduleOverride(undefined), PEAK_SCHEDULE_INHERIT);
  assertEquals(normalizePeakScheduleOverride('none'), PEAK_SCHEDULE_NONE);
  assertEquals(normalizePeakScheduleOverride('deepseek'), 'deepseek');
  assertThrows(() => normalizePeakScheduleOverride('nope'), Error);
  assertThrows(() => normalizePeakScheduleOverride(null), Error);
});

test('pricingScheduleById returns undefined for unknown ids', () => {
  assertEquals(pricingScheduleById('nope'), undefined);
});

test('hasOffPeakPricingEntry matches on the pricing shape', () => {
  assertEquals(hasOffPeakPricingEntry(null), false);
  assertEquals(hasOffPeakPricingEntry(undefined), false);
  assertEquals(hasOffPeakPricingEntry(modelPricing(tokenPricingEntry({ input_tokens: '1' }))), false);
  assertEquals(
    hasOffPeakPricingEntry(modelPricing(
      tokenPricingEntry({ input_tokens: '1' }),
      tokenPricingEntry({ input_tokens: '0.5' }, { pricingPeriod: 'off-peak' }),
    )),
    true,
  );
});
