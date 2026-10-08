// Schedule-aware peak/off-peak readout. Period math lives in the shared
// pricing-schedule module; this file keeps the dashboard's clock
// subscription, holiday-stretch ranges, and locale formatting, parameterized
// by schedule id so the card beside a Pricing Period field (or the monitor
// page) states what the gateway will record for that schedule.

import { useMemo, useSyncExternalStore } from 'react';

import { useTranslation } from '../../i18n/translation';
import { useLocale } from '../../lib/use-locale';
import {
  DEEPSEEK_HOLIDAY_DATES,
  nextScheduleSwitch,
  pricingScheduleById,
  schedulePricingPeriod,
  type PricingPeriod,
} from '@floway-dev/protocols/common';

export type { PricingPeriod };

export type HolidayStretch = { first: string; last: string };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// A Beijing calendar day begins eight hours before UTC midnight.
const BEIJING_OFFSET_MS = 8 * HOUR_MS;
const CLOCK_TICK_MS = 1_000;

const pad = (part: number): string => String(part).padStart(2, '0');

// A calendar date read as UTC midnight, so date arithmetic stays in the frame
// the rule is written in whatever zone the operator's browser sits in.
const dateInstant = (date: string): number => Date.parse(`${date}T00:00:00Z`);

const shiftDate = (date: string, days: number): string =>
  new Date(dateInstant(date) + days * DAY_MS).toISOString().slice(0, 10);

// Beijing-time (UTC+8) calendar date of the instant, as YYYY-MM-DD.
const beijingDateOf = (now: number): string => {
  const beijing = new Date(now + BEIJING_OFFSET_MS);
  return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())}`;
};

const utcDateOf = (now: number): string => new Date(now).toISOString().slice(0, 10);

type HolidayRun = { first: string; last: string };

// Contiguous Beijing days off, in order: the stretches the DeepSeek rule pins
// off-peak, and the date range the card reports for the one it is standing
// in. Only the DeepSeek preset carries a holiday calendar; other schedules
// never match a stretch.
const HOLIDAY_RUNS: readonly HolidayRun[] = (() => {
  const runs: HolidayRun[] = [];
  for (const date of [...DEEPSEEK_HOLIDAY_DATES].sort()) {
    const run = runs.at(-1);
    if (run !== undefined && shiftDate(run.last, 1) === date) run.last = date;
    else runs.push({ first: date, last: date });
  }
  return runs;
})();

const scheduleOf = (scheduleId: string) => {
  const def = pricingScheduleById(scheduleId);
  if (def === undefined) throw new Error(`Unknown peak schedule ${JSON.stringify(scheduleId)}`);
  return def;
};

export const pricingPeriodAt = (scheduleId: string, now: number): PricingPeriod =>
  schedulePricingPeriod(scheduleOf(scheduleId), new Date(now));

// The first instant after `now` at which the period flips.
export const nextPricingSwitch = (scheduleId: string, now: number): number =>
  nextScheduleSwitch(scheduleOf(scheduleId), new Date(now)).getTime();

// The run of statutory-holiday Beijing days `now` stands in, or null when
// today is not one (or the schedule carries no holiday calendar).
export const holidayStretchAt = (scheduleId: string, now: number): HolidayStretch | null => {
  if (pricingScheduleById(scheduleId)?.holidays.kind !== 'cn-statutory') return null;
  const today = beijingDateOf(now);
  return HOLIDAY_RUNS.find(run => run.first <= today && today <= run.last) ?? null;
};

// The switch is always named with its date: it can be days away, and a bare
// clock time would not say which day.
const switchFormat = (locale: string): Intl.DateTimeFormat => new Intl.DateTimeFormat(locale, {
  day: 'numeric',
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  month: 'short',
  timeZone: 'UTC',
  weekday: 'short',
});

const holidayDayFormat = (locale: string): Intl.DateTimeFormat => new Intl.DateTimeFormat(locale, {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
  weekday: 'short',
});

const holidayRangeText = (stretch: HolidayStretch, format: Intl.DateTimeFormat): string => {
  const first = format.format(new Date(dateInstant(stretch.first)));
  if (stretch.first === stretch.last) return first;
  return `${first} - ${format.format(new Date(dateInstant(stretch.last)))}`;
};

const subscribeToClock = (onChange: () => void): (() => void) => {
  // A hidden tab has no reader: hold the heartbeat, then catch the reading up
  // the moment it is shown rather than waiting out a tick.
  const beat = (): void => {
    if (!document.hidden) onChange();
  };
  const timer = window.setInterval(beat, CLOCK_TICK_MS);
  document.addEventListener('visibilitychange', beat);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', beat);
  };
};

// An injected clock subscribes to nothing, so a test never races a timer.
const subscribeToNothing = (): (() => void) => () => undefined;

// Snapshots are quantized to the second: an unrounded Date.now() never settles.
const quantizedNow = (injected: number | undefined): number =>
  injected ?? Math.floor(Date.now() / CLOCK_TICK_MS) * CLOCK_TICK_MS;

const usePeriodNow = (injected: number | undefined): number => useSyncExternalStore(
  injected === undefined ? subscribeToClock : subscribeToNothing,
  () => quantizedNow(injected),
  () => injected ?? 0,
);

export type PricingPeriodReading = {
  /** Formatted holiday line, present only while the Beijing day is a statutory holiday. */
  holidayNote: string | null;
  /** Fractional UTC hour of the instant, for the card's now-marker. */
  hour: number;
  /** Formatted line naming the next switch. */
  next: string;
  period: PricingPeriod;
  /** Milliseconds until the next switch, for the card's countdown. */
  remainingMs: number;
};

export const usePricingPeriod = (scheduleId: string, injected?: number): PricingPeriodReading => {
  const { t } = useTranslation();
  const locale = useLocale();
  const now = usePeriodNow(injected);
  const formatSwitch = useMemo(() => switchFormat(locale), [locale]);
  const formatHolidayDay = useMemo(() => holidayDayFormat(locale), [locale]);

  const period = pricingPeriodAt(scheduleId, now);
  const stretch = holidayStretchAt(scheduleId, now);
  const switchAt = nextPricingSwitch(scheduleId, now);

  return {
    holidayNote: stretch === null
      ? null
      : t(
          'dashboard.upstreamEditor.models.pricingPeriodCard.holidayNote',
          { range: holidayRangeText(stretch, formatHolidayDay) },
        ),
    hour: (now - dateInstant(utcDateOf(now))) / HOUR_MS,
    next: t(
      period === 'peak'
        ? 'dashboard.upstreamEditor.models.pricingPeriodCard.nextOffPeak'
        : 'dashboard.upstreamEditor.models.pricingPeriodCard.nextPeak',
      { when: formatSwitch.format(new Date(switchAt)) },
    ),
    period,
    remainingMs: Math.max(0, switchAt - now),
  };
};
