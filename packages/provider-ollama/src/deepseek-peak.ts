// DeepSeek peak/off-peak pricing-period classifier for the Ollama provider's
// notional DeepSeek pricing table. DeepSeek discounts its API during off-peak
// hours; the gateway records the period at request time and projects it onto
// the `pricingPeriod` pricing axis (Base entry = peak).
//
// Windows are UTC: 01:00-04:00 daily is peak, and 06:00-10:00 Monday-Friday
// is peak; everything else is off-peak. Those UTC windows are exactly
// DeepSeek's Beijing-time (UTC+8) discount windows — weekdays (Monday-Friday,
// excluding Chinese statutory holidays) 9:00-12:00 and 14:00-18:00 — so a
// Chinese public holiday turns the full Beijing calendar day off-peak, all
// 24h, even inside the UTC windows.
// https://api-docs.deepseek.com/quick_start/pricing
//
// Holiday dates are vendored from https://github.com/NateScarlet/holiday-cn
// (MIT; auto-scrapes the State Council notices, e.g.
// https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm) — see
// `./deepseek-holidays.generated.json` for the per-year notice URLs and the
// refresh step. Only official holidays (upstream `isOffDay`) count; adjusted
// workdays bill by their normal weekday/weekend rule.

import holidaysJson from './deepseek-holidays.generated.json' with { type: 'json' };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string');

const holidayDatesOf = (value: unknown): ReadonlySet<string> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Malformed DeepSeek holiday snapshot: expected { years }');
  }
  const years = (value as { years?: unknown }).years;
  if (typeof years !== 'object' || years === null || Array.isArray(years)) {
    throw new Error('Malformed DeepSeek holiday snapshot: expected years to be an object');
  }
  const dates = new Set<string>();
  for (const [year, block] of Object.entries(years)) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      throw new Error(`Malformed DeepSeek holiday snapshot: year ${year} must be an object`);
    }
    const yearDates = (block as { dates?: unknown }).dates;
    if (!isStringArray(yearDates)) {
      throw new Error(`Malformed DeepSeek holiday snapshot: year ${year} dates must be a string array`);
    }
    for (const date of yearDates) {
      if (!DATE_PATTERN.test(date)) {
        throw new Error(`Malformed DeepSeek holiday snapshot: year ${year} has a non-date entry ${date}`);
      }
      dates.add(date);
    }
  }
  return dates;
};

const HOLIDAY_DATES = holidayDatesOf(holidaysJson);

// Beijing-time (UTC+8) calendar date of the instant, as `YYYY-MM-DD`.
const beijingDateOf = (now: Date): string => {
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())}`;
};

export const isDeepSeekPeak = (now: Date): boolean => {
  // A Chinese statutory holiday is off-peak for the whole Beijing day.
  if (HOLIDAY_DATES.has(beijingDateOf(now))) return false;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  // 01:00-04:00 UTC daily.
  if (minutes >= 60 && minutes < 240) return true;
  // 06:00-10:00 UTC Monday-Friday (getUTCDay: 1 = Monday … 5 = Friday).
  const day = now.getUTCDay();
  if (day >= 1 && day <= 5 && minutes >= 360 && minutes < 600) return true;
  return false;
};

export const deepseekPricingPeriod = (now: Date): 'peak' | 'off-peak' =>
  isDeepSeekPeak(now) ? 'peak' : 'off-peak';
