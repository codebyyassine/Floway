// DeepSeek's peak/off-peak rule, read here so the card beside the Pricing
// Period field states what the gateway will record. The gateway keeps its own
// copy in packages/provider-ollama/src/deepseek-peak.ts, and apps/web must not
// runtime-import a provider package, so the rule is mirrored and the holiday
// calendar it reads is vendored beside this file; the card's test compares the
// two calendars rather than trusting the copy.
//
// Windows are UTC: 01:00-04:00 daily is peak, and 06:00-10:00 Monday-Friday
// is peak; everything else is off-peak. A Chinese statutory holiday is
// off-peak for its whole Beijing (UTC+8) calendar day, even inside those
// windows.
// https://api-docs.deepseek.com/quick_start/pricing

import { useMemo, useSyncExternalStore } from 'react';

import { PRICING_PERIOD_HOLIDAY_DATES } from './pricing-period-holidays.generated';
import { useTranslation } from '../../i18n/translation';
import { useLocale } from '../../lib/use-locale';

export type PricingPeriod = 'peak' | 'off-peak';

export type HolidayStretch = { first: string; last: string };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// A Beijing calendar day begins eight hours before UTC midnight.
const BEIJING_OFFSET_MS = 8 * HOUR_MS;
// Every instant at which a part of the rule can change: the UTC weekday, the
// four window edges, and Beijing midnight, which starts and ends a holiday.
const SWITCH_HOURS_UTC = [0, 1, 4, 6, 10, 16] as const;
const CLOCK_TICK_MS = 1_000;

const HOLIDAY_DATES: ReadonlySet<string> = new Set<string>(PRICING_PERIOD_HOLIDAY_DATES);

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

// Contiguous Beijing days off, in order: the stretches the rule pins off-peak,
// and the date range the card reports for the one it is standing in.
const HOLIDAY_RUNS: readonly HolidayRun[] = (() => {
  const runs: HolidayRun[] = [];
  for (const date of [...PRICING_PERIOD_HOLIDAY_DATES].sort()) {
    const run = runs.at(-1);
    if (run !== undefined && shiftDate(run.last, 1) === date) run.last = date;
    else runs.push({ first: date, last: date });
  }
  return runs;
})();

const daysInRun = (run: HolidayStretch): number =>
  Math.round((dateInstant(run.last) - dateInstant(run.first)) / DAY_MS) + 1;

// The next switch never falls further than the longest run plus the day it
// ends: a run holds the period off-peak until Beijing midnight, and the first
// edge that can flip it after that is on the following UTC day. A horizon that
// cannot be met means the vendored calendar has stopped being a calendar, so
// the scan throws rather than letting the card claim nothing ever changes.
const SWITCH_HORIZON_DAYS = HOLIDAY_RUNS.reduce((days, run) => Math.max(days, daysInRun(run)), 0) + 1;

export const pricingPeriodAt = (now: number): PricingPeriod => {
  // A Chinese statutory holiday is off-peak for the whole Beijing day.
  if (HOLIDAY_DATES.has(beijingDateOf(now))) return 'off-peak';
  const date = new Date(now);
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  // 01:00-04:00 UTC daily.
  if (minutes >= 60 && minutes < 240) return 'peak';
  // 06:00-10:00 UTC Monday-Friday (getUTCDay: 1 = Monday … 5 = Friday).
  const day = date.getUTCDay();
  if (day >= 1 && day <= 5 && minutes >= 360 && minutes < 600) return 'peak';
  return 'off-peak';
};

// The first instant after `now` at which the period flips.
export const nextPricingSwitch = (now: number): number => {
  const firstDay = utcDateOf(now);
  for (let day = 0; day <= SWITCH_HORIZON_DAYS; day += 1) {
    const midnight = dateInstant(shiftDate(firstDay, day));
    for (const hour of SWITCH_HOURS_UTC) {
      const at = midnight + hour * HOUR_MS;
      if (at <= now) continue;
      if (pricingPeriodAt(at) !== pricingPeriodAt(at - 1)) return at;
    }
  }
  throw new Error(`No DeepSeek pricing-period switch within ${SWITCH_HORIZON_DAYS} days of ${new Date(now).toISOString()}`);
};

// The run of statutory-holiday Beijing days `now` stands in, or null when
// today is not one.
export const holidayStretchAt = (now: number): HolidayStretch | null => {
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

export const usePricingPeriod = (injected?: number): PricingPeriodReading => {
  const { t } = useTranslation();
  const locale = useLocale();
  const now = usePeriodNow(injected);
  const formatSwitch = useMemo(() => switchFormat(locale), [locale]);
  const formatHolidayDay = useMemo(() => holidayDayFormat(locale), [locale]);

  const period = pricingPeriodAt(now);
  const stretch = holidayStretchAt(now);
  const switchAt = nextPricingSwitch(now);

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
