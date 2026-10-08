// Row-hydration helpers for the `upstreams` table. Centralised so a
// poisoned upstream row surfaces the same diagnostic on every read path —
// error attribution and validation policy stay uniform across SELECT
// shapes.

import { normalizePeakScheduleOverride } from '@floway-dev/protocols/common';
import type { UpstreamProviderKind } from '@floway-dev/provider';
import { assertUpstreamProviderKind, normalizeUpstreamHue } from '@floway-dev/provider';

export const parseUpstreamKind = (id: string, value: string | null): UpstreamProviderKind => {
  try {
    return assertUpstreamProviderKind(value ?? '');
  } catch (cause) {
    throw new Error(`Invalid upstream provider kind for ${id}`, { cause });
  }
};

export const parseUpstreamHue = (id: string, value: unknown): number => {
  try {
    return normalizeUpstreamHue(value);
  } catch (cause) {
    throw new Error(`Invalid upstream hue for ${id}`, { cause });
  }
};

export const parseUpstreamPeakBlock = (id: string, value: unknown): boolean => {
  if (value === 0 || value === 1) return value === 1;
  throw new Error(`Invalid upstream block_peak_priced_models for ${id}`);
};

export const parseUpstreamPeakSchedule = (id: string, value: unknown): string => {
  try {
    return normalizePeakScheduleOverride(value);
  } catch (cause) {
    throw new Error(`Invalid upstream peak_schedule_override for ${id}`, { cause });
  }
};
