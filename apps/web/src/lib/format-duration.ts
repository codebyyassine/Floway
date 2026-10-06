import { NO_READING } from './no-reading';

// A latency percentile is an instrument reading, so it keeps an SI-style ladder
// every locale spells the same way.
export const formatDuration = (ms: number | null): string => {
  if (ms === null || !Number.isFinite(ms)) return NO_READING;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
};

const unit = (value: number, name: 'day' | 'hour' | 'minute' | 'second', locale: string): string =>
  new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'narrow' }).format(value);

// A live countdown keeps its seconds all the way down, so it cannot go through
// `formatDuration` -- a bin ladder would render the last three minutes as `2.9m`
// and never tick.
export const formatCountdown = (seconds: number, locale: string): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = unit(whole % 60, 'second', locale);
  return minutes > 0 ? `${unit(minutes, 'minute', locale)} ${rest}` : rest;
};

const MINUTES_PER_DAY = 24 * 60;

// How long a wait still has to run, for a reading that is about the wait rather
// than about the instant it ends. The operator set the largest unit: "if more
// than 23h show 1 day" -- a 30-day cooldown was reading as `720h`.
//
// Under a day the ladder is minutes, then hours (`45m`, `2h 30m`). At 24h or
// more it is days, with the hours kept and the minutes dropped (`1d`, `1d 3h`),
// so the label is two parts wide on either side of the boundary.
//
// Minutes round up, so a wait with any time left never reads as none left.
export const formatRemaining = (ms: number, locale: string): string => {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  const days = Math.floor(minutes / MINUTES_PER_DAY);
  const hours = Math.floor((minutes % MINUTES_PER_DAY) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours === 0 ? unit(days, 'day', locale) : `${unit(days, 'day', locale)} ${unit(hours, 'hour', locale)}`;
  if (hours === 0) return unit(minutes, 'minute', locale);
  return rest === 0 ? unit(hours, 'hour', locale) : `${unit(hours, 'hour', locale)} ${unit(rest, 'minute', locale)}`;
};
