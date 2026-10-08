// Time-of-day peak/off-peak schedules shared by gateway billing, the peak
// gate, and the dashboard. Previously this was DeepSeek-only logic duplicated
// in `packages/provider-ollama` (which the gateway runtime-imported) and
// mirrored in `apps/web`; a second vendor would have touched ~15 files.
// Vendors now contribute one preset entry each, and operators pick a preset
// per upstream (override) or per manual model (explicit choice).
//
// Billing still stamps the single generic `pricingPeriod` axis (`Base` =
// peak, `off-peak` entry = discount): a schedule only decides *when* a given
// model is off-peak. The effective schedule resolves per candidate as
// manual-model choice, then upstream override, then the catalog default the
// provider emitted — so a mirror that charges a flat rate overrides to `none`
// while DeepSeek-direct upstreams inherit the model default.
//
// Determination point is request-receipt time throughout (DeepSeek and Tencent
// both bill the instant the server receives the request); call duration never
// matters.

import { DEEPSEEK_HOLIDAY_DATES } from './deepseek-holidays.generated.ts';
import type { ModelPricing } from './pricing.ts';

// Vendored Chinese statutory-holiday dates behind the `deepseek` preset's
// `cn-statutory` calendar, for surfaces that name the stretches (dashboard
// holiday notes). The evaluator above is the peak/off-peak source of truth;
// this list only feeds display ranges.
export { DEEPSEEK_HOLIDAY_DATES };

export type PricingPeriod = 'peak' | 'off-peak';

// Which UTC calendar days a window applies to. `weekdays` is Monday-Friday,
// `weekends` Saturday-Sunday; both read `getUTCDay`.
export type PricingScheduleDayScope = 'daily' | 'weekdays' | 'weekends';

export interface PricingScheduleWindow {
  // Minutes since UTC midnight. `endMinuteUtc` is exclusive and may be <=
  // `startMinuteUtc` to span midnight (e.g. Qwen's 22:00-08:00 Beijing
  // off-peak complements a 00:00-14:00 UTC peak window).
  startMinuteUtc: number;
  endMinuteUtc: number;
  days: PricingScheduleDayScope;
}

export type PricingScheduleHolidays =
  | { kind: 'none' }
  // Chinese statutory holidays (`isOffDay` only): the whole reference-tz
  // calendar day is off-peak, even inside a peak window.
  | { kind: 'cn-statutory' };

export interface PricingScheduleDef {
  id: string;
  label: string;
  // IANA-less offset label of the vendor's reference zone, for display
  // (windows themselves are stored in UTC).
  referenceTz: string;
  windows: readonly PricingScheduleWindow[];
  holidays: PricingScheduleHolidays;
}

// DeepSeek: peak 01:00-04:00 UTC daily + 06:00-10:00 UTC Mon-Fri (Beijing
// 09:00-12:00 / 14:00-18:00), excluding Chinese public holidays; off-peak is
// half price. https://api-docs.deepseek.com/quick_start/pricing
const deepseekSchedule: PricingScheduleDef = {
  id: 'deepseek',
  label: 'DeepSeek',
  referenceTz: 'UTC+8 (Beijing)',
  windows: [
    { startMinuteUtc: 60, endMinuteUtc: 240, days: 'daily' },
    { startMinuteUtc: 360, endMinuteUtc: 600, days: 'weekdays' },
  ],
  holidays: { kind: 'cn-statutory' },
};

// Z.ai GLM Coding Plan: peak Mon-Fri 14:00-18:00 Beijing (06:00-10:00 UTC);
// off-peak calls burn 50% of the base credits. Weekends are off-peak by
// day-scope; no holiday calendar is published. https://docs.z.ai
const zhipuCodingSchedule: PricingScheduleDef = {
  id: 'zhipu-coding',
  label: 'Zhipu coding',
  referenceTz: 'UTC+8 (Beijing)',
  windows: [
    { startMinuteUtc: 360, endMinuteUtc: 600, days: 'weekdays' },
  ],
  holidays: { kind: 'none' },
};

// Qwen3.7 Max/Plus off-peak promo: 22:00-08:00 Beijing daily (14:00-24:00
// UTC), weekends and holidays included by day-scope. Stored as its peak
// complement 00:00-14:00 UTC daily.
// https://www.alibabacloud.com/blog/qwen3-7-off-peak-rates_603404
const qwenNightSchedule: PricingScheduleDef = {
  id: 'qwen-night',
  label: 'Qwen night',
  referenceTz: 'UTC+8 (Beijing)',
  windows: [
    { startMinuteUtc: 0, endMinuteUtc: 840, days: 'daily' },
  ],
  holidays: { kind: 'none' },
};

const PRESETS: readonly PricingScheduleDef[] = [deepseekSchedule, zhipuCodingSchedule, qwenNightSchedule];

export const KNOWN_PRICING_SCHEDULE_IDS: readonly string[] = PRESETS.map(preset => preset.id);

export const pricingScheduleById = (id: string): PricingScheduleDef | undefined =>
  PRESETS.find(preset => preset.id === id);

export const pricingScheduleLabel = (id: string): string =>
  pricingScheduleById(id)?.label ?? id;

export const parsePricingScheduleId = (value: unknown, label = 'pricing schedule'): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Malformed ${label}: must be a non-empty string`);
  if (pricingScheduleById(value) === undefined) {
    throw new Error(`Malformed ${label}: unknown schedule ${JSON.stringify(value)} (expected one of ${KNOWN_PRICING_SCHEDULE_IDS.join(', ')})`);
  }
  return value;
};

// An upstream-level schedule reference: `'inherit'` follows each model's
// catalog default, `'none'` bills every model flat (mirrors that ignore the
// vendor's off-peak discount), otherwise a preset id.
export const PEAK_SCHEDULE_INHERIT = 'inherit';
export const PEAK_SCHEDULE_NONE = 'none';

export const normalizePeakScheduleOverride = (value: unknown): string => {
  if (value === undefined) return PEAK_SCHEDULE_INHERIT;
  if (value === PEAK_SCHEDULE_INHERIT || value === PEAK_SCHEDULE_NONE) return value;
  return parsePricingScheduleId(value, 'peak schedule override');
};

// Effective schedule for one candidate, per the locked Option A precedence:
// an explicit manual-model choice wins, then the upstream override, then the
// catalog default the provider emitted. `null` means flat (no time axis).
export const resolvePeakScheduleId = (args: {
  // Catalog default from `ProviderModel.peakScheduleId` (auto rows) or the
  // manual row's own value when the operator left it on inherit.
  modelScheduleId?: string | null;
  // Explicit manual-model choice by public model id (absent = inherit).
  manualSchedules?: Readonly<Record<string, string | null>>;
  modelId: string;
  upstreamOverride?: string;
}): string | null => {
  const manual = args.manualSchedules?.[args.modelId];
  if (manual !== undefined) return manual;
  const override = normalizePeakScheduleOverride(args.upstreamOverride);
  if (override !== PEAK_SCHEDULE_INHERIT) return override === PEAK_SCHEDULE_NONE ? null : override;
  return args.modelScheduleId ?? null;
};

// Whether a pricing table is peak-priced at all: it carries an `off-peak`
// entry (Base bills peak, the entry bills the discount). Providers use this
// to attach the matching catalog-default schedule; the gate uses its own
// copy in the gateway (kept shape-based so any future family works).
export const hasOffPeakPricingEntry = (pricing: ModelPricing | null | undefined): boolean =>
  pricing?.entries.some(entry => entry.selector?.pricingPeriod === 'off-peak') ?? false;

const CN_HOLIDAY_DATES: ReadonlySet<string> = new Set<string>(DEEPSEEK_HOLIDAY_DATES);

const pad = (part: number): string => String(part).padStart(2, '0');

// Reference-tz (UTC+8) calendar date of the instant, as `YYYY-MM-DD`. Only
// Beijing-anchored calendars exist today; a second zone adds an offset field
// on the holiday calendar rather than a branch here.
const beijingDateOf = (now: Date): string => {
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())}`;
};

const windowIsPeakAt = (window: PricingScheduleWindow, minutes: number, day: number): boolean => {
  if (window.days === 'weekdays' && (day < 1 || day > 5)) return false;
  if (window.days === 'weekends' && day !== 0 && day !== 6) return false;
  if (window.startMinuteUtc <= window.endMinuteUtc) {
    return minutes >= window.startMinuteUtc && minutes < window.endMinuteUtc;
  }
  return minutes >= window.startMinuteUtc || minutes < window.endMinuteUtc;
};

export const isSchedulePeak = (def: PricingScheduleDef, now: Date): boolean => {
  if (def.holidays.kind === 'cn-statutory' && CN_HOLIDAY_DATES.has(beijingDateOf(now))) return false;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const day = now.getUTCDay();
  return def.windows.some(window => windowIsPeakAt(window, minutes, day));
};

export const schedulePricingPeriod = (def: PricingScheduleDef, now: Date): PricingPeriod =>
  isSchedulePeak(def, now) ? 'peak' : 'off-peak';

// First off-peak minute at or after `now`, or null when already off-peak.
// Found by minute scan; the horizon covers the longest statutory-holiday run
// (9 days in the vendored calendar) plus margin, so exhausting it means the
// calendar stopped being a calendar.
export const nextOffPeakAfter = (def: PricingScheduleDef, now: Date): { retryAfterSeconds: number; nextOffPeak: string } | null => {
  if (!isSchedulePeak(def, now)) return null;
  const at = new Date(now.getTime());
  at.setUTCSeconds(0, 0);
  for (let step = 0; step <= 11 * 24 * 60; step += 1) {
    if (!isSchedulePeak(def, at)) {
      return {
        retryAfterSeconds: Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 1000)),
        nextOffPeak: at.toISOString(),
      };
    }
    at.setUTCMinutes(at.getUTCMinutes() + 1);
  }
  throw new Error(`No ${def.id} off-peak minute within 11 days of ${now.toISOString()}`);
};

// First instant after `now` at which the period flips, for countdowns.
export const nextScheduleSwitch = (def: PricingScheduleDef, now: Date): Date => {
  const at = new Date(now.getTime());
  at.setUTCSeconds(0, 0);
  const current = isSchedulePeak(def, now);
  for (let step = 1; step <= 11 * 24 * 60; step += 1) {
    at.setUTCMinutes(at.getUTCMinutes() + 1);
    if (isSchedulePeak(def, at) !== current) return new Date(at.getTime());
  }
  throw new Error(`No ${def.id} pricing-period switch within 11 days of ${now.toISOString()}`);
};
