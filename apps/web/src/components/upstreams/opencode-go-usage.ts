// OpenCode Go subscription usage. The gateway stores the upstream body
// verbatim in the probe observation, and each window states its own
// percentage, status, and reset, so a window is those three facts and nothing
// else. The endpoint is undocumented, so every read below is defensive:
// unexpected input yields no windows rather than a throw.

import { FIVE_HOUR_WINDOW_MINUTES, SEVEN_DAY_WINDOW_MINUTES } from './subscription-quota';
import type { UpstreamRecord } from '../../api/types';

export type OpencodeGoRecord = Extract<UpstreamRecord, { kind: 'opencode-go' }>;

// A calendar month runs 28-31 days and the upstream reports no length for the
// monthly window, so thirty days is an approximation the label owns rather
// than a length the upstream stated.
const THIRTY_DAY_WINDOW_MINUTES = 30 * 24 * 60;

// The field name is what selects the length: the rolling window is the five
// hours every other subscription upstream names the same way, and the weekly
// one its seven days.
const WINDOW_MINUTES = {
  rolling: FIVE_HOUR_WINDOW_MINUTES,
  weekly: SEVEN_DAY_WINDOW_MINUTES,
  monthly: THIRTY_DAY_WINDOW_MINUTES,
} as const;

export interface UsageWindow {
  key: keyof typeof WINDOW_MINUTES;
  minutes: number;
  // Already 0..100 as the upstream stated it, unlike the 0..1 fraction the
  // Ollama endpoint reports: it is read, never multiplied.
  percent: number;
  resetAt: string | null;
  // A window whose status is not `ok` is spent but stays on the row: a block
  // and a full window are different facts, and the signal states the block
  // rather than inferring it from the percentage.
  blocked: boolean;
}

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// `resetsAt` names the reset instant; `resetInSec` counts down to it in whole
// seconds. The former wins when both arrive, and a reset this dashboard cannot
// read leaves the window unqualified rather than dropping a percentage the
// upstream did state.
const readResetAt = (value: Record<string, unknown>): string | null => {
  const resetsAt = value.resetsAt;
  if (typeof resetsAt === 'string' && !Number.isNaN(Date.parse(resetsAt))) return resetsAt;
  const resetInSec = value.resetInSec;
  if (typeof resetInSec !== 'number' || !Number.isFinite(resetInSec) || resetInSec < 0) return null;
  return new Date(Date.now() + resetInSec * 1000).toISOString();
};

const readWindow = (key: UsageWindow['key'], value: unknown): UsageWindow | null => {
  if (!isRecordValue(value)) return null;
  const percent = value.percent;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  return { key, minutes: WINDOW_MINUTES[key], percent, resetAt: readResetAt(value), blocked: value.status !== 'ok' };
};

// Each window may be absent independently; absence is not zero, so a window
// the upstream did not send is omitted rather than shown as one.
export const readWindows = (data: unknown): UsageWindow[] => {
  const usage = isRecordValue(data) ? data.usage : null;
  if (!isRecordValue(usage)) return [];
  return [readWindow('rolling', usage.rolling), readWindow('weekly', usage.weekly), readWindow('monthly', usage.monthly)]
    .filter((usageWindow): usageWindow is UsageWindow => usageWindow !== null);
};
