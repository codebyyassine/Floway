import { describe, expect, it } from 'vitest';

import { formatCountdown, formatDuration, formatRemaining } from '../../src/lib/format-duration';
import { NO_READING } from '../../src/lib/no-reading';

describe('latency durations', () => {
  it('promotes a unit only once the reading reaches it', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1_000)).toBe('1.0s');
    expect(formatDuration(1_500)).toBe('1.5s');
    expect(formatDuration(59_999)).toBe('60.0s');
    expect(formatDuration(60_000)).toBe('1.0m');
    expect(formatDuration(90_000)).toBe('1.5m');
  });

  it('reports no reading rather than a zero one', () => {
    expect(formatDuration(null)).toBe(NO_READING);
    expect(formatDuration(Number.NaN)).toBe(NO_READING);
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe(NO_READING);
  });
});

describe('countdowns', () => {
  it('keeps counting seconds however long is left', () => {
    expect(formatCountdown(0, 'en')).toBe('0s');
    expect(formatCountdown(59, 'en')).toBe('59s');
    expect(formatCountdown(60, 'en')).toBe('1m 0s');
    expect(formatCountdown(3_599, 'en')).toBe('59m 59s');
    expect(formatCountdown(3_600, 'en')).toBe('60m 0s');
  });

  it('floors a partial second and never counts below zero', () => {
    expect(formatCountdown(5.9, 'en')).toBe('5s');
    expect(formatCountdown(-3, 'en')).toBe('0s');
  });

  it('takes its unit names from the locale', () => {
    expect(formatCountdown(61, 'zh-Hans')).toBe('1分钟 1秒');
    expect(formatCountdown(30, 'zh-Hans')).toBe('30秒');
  });
});

describe('remaining time', () => {
  it('climbs from minutes to hours while the wait is under a day', () => {
    expect(formatRemaining(45 * 60_000, 'en')).toBe('45m');
    expect(formatRemaining(4 * 3_600_000, 'en')).toBe('4h');
    expect(formatRemaining(2 * 3_600_000 + 30 * 60_000, 'en')).toBe('2h 30m');
    // One minute short of the boundary is still an hours reading.
    expect(formatRemaining(23 * 3_600_000 + 59 * 60_000, 'en')).toBe('23h 59m');
  });

  it('reads 24 hours and beyond in days, never in hours', () => {
    expect(formatRemaining(24 * 3_600_000, 'en')).toBe('1d');
    expect(formatRemaining(48 * 3_600_000, 'en')).toBe('2d');
    expect(formatRemaining(30 * 24 * 3_600_000, 'en')).toBe('30d');
  });

  it('keeps the hours of a fractional day and drops the minutes', () => {
    expect(formatRemaining(24 * 3_600_000 + 3 * 3_600_000, 'en')).toBe('1d 3h');
    expect(formatRemaining(8 * 24 * 3_600_000 + 13 * 3_600_000, 'en')).toBe('8d 13h');
    expect(formatRemaining(24 * 3_600_000 + 30 * 60_000, 'en')).toBe('1d');
  });

  it('rounds minutes up so any time left never reads as none left', () => {
    expect(formatRemaining(1, 'en')).toBe('1m');
    expect(formatRemaining(59_999, 'en')).toBe('1m');
    expect(formatRemaining(60_001, 'en')).toBe('2m');
    expect(formatRemaining(-1, 'en')).toBe('0m');
  });

  it('takes its unit names from the locale', () => {
    expect(formatRemaining(45 * 60_000, 'zh-Hans')).toBe('45分钟');
    expect(formatRemaining(2 * 3_600_000 + 30 * 60_000, 'zh-Hans')).toBe('2小时 30分钟');
    expect(formatRemaining(24 * 3_600_000, 'zh-Hans')).toBe('1天');
    expect(formatRemaining(30 * 24 * 3_600_000, 'zh-Hans')).toBe('30天');
    expect(formatRemaining(27 * 3_600_000, 'zh-Hans')).toBe('1天 3小时');
  });
});
