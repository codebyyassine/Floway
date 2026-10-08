import { usePricingPeriod, type PricingPeriod } from './pricing-period';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { formatRemaining } from '../../lib/format-duration';
import { useLocale } from '../../lib/use-locale';
import { PANEL_STACK_CLASS } from '../ui/layout';
import { Panel } from '../ui/panel';
import { StatusBadge } from '../ui/status-badge';
import { pricingScheduleById } from '@floway-dev/protocols/common';

const { Text, makeStyles } = fluentComponents;

const DAY_MINUTES = 1_440;

// A switch-day countdown reads as a clock, not a duration ladder: H:MM:SS
// down to the switch, with the hours uncapped across multi-day holiday runs.
const clockCountdown = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const pad2 = (part: number): string => String(part).padStart(2, '0');
  return `${Math.floor(total / 3_600)}:${pad2(Math.floor(total / 60) % 60)}:${pad2(total % 60)}`;
};

const RULER_HOURS = [0, 6, 12, 18] as const;

// Only the clock face is read, so the date behind it is a stand-in.
const clockFormat = (locale: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(locale, { hour: '2-digit', hourCycle: 'h23', minute: '2-digit', timeZone: 'UTC' });

const clockAt = (format: Intl.DateTimeFormat, minutes: number): string =>
  format.format(new Date(minutes * 60_000));

const useStyles = makeStyles({
  // The rail is drawn here rather than handed to ProgressBar: a progress bar
  // fills from zero, and a day can carry several separate peak windows. Its
  // thickness is Fluent's own large step -- `barThicknessValues.large` is 4px
  // in @fluentui/react-progress's useProgressBarStyles -- and the 1.5px
  // corner is WinUI's ProgressBarCornerRadius, written as the length it is
  // rather than a multiplier, so the corner holds at whatever thickness the
  // band takes.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ProgressBar/ProgressBar_themeresources.xaml#L29-L32
  track: {
    backgroundColor: 'var(--winui-solid-background-fill-base-alt)',
    borderRadius: '1.5px',
    height: '4px',
    position: 'relative',
    width: '100%',
  },
  peak: {
    backgroundColor: 'var(--winui-accent-fill-default)',
    borderRadius: '1.5px',
    bottom: 0,
    position: 'absolute',
    top: 0,
  },
  // Three bands tall so the marker clears the track it crosses by one band on
  // either side; it would be lost inside a 4px peak segment otherwise.
  rail: {
    alignItems: 'center',
    display: 'flex',
    height: '12px',
    position: 'relative',
  },
  marker: {
    backgroundColor: 'var(--winui-text-fill-primary)',
    bottom: 0,
    position: 'absolute',
    top: 0,
    width: '2px',
  },
});

// Peak windows as rail segments, splitting a midnight-spanning window in two.
const peakSegmentsOf = (scheduleId: string): ReadonlyArray<{ key: string; left: number; width: number }> => {
  const def = pricingScheduleById(scheduleId);
  if (def === undefined) throw new Error(`Unknown peak schedule ${JSON.stringify(scheduleId)}`);
  return def.windows.flatMap((window, index) => {
    const span = (window.endMinuteUtc - window.startMinuteUtc + DAY_MINUTES) % DAY_MINUTES;
    const base = { key: `${window.startMinuteUtc}-${index}` };
    if (window.endMinuteUtc > window.startMinuteUtc) {
      return [{ ...base, left: (window.startMinuteUtc / DAY_MINUTES) * 100, width: (span / DAY_MINUTES) * 100 }];
    }
    return [
      { ...base, key: `${base.key}-a`, left: (window.startMinuteUtc / DAY_MINUTES) * 100, width: ((DAY_MINUTES - window.startMinuteUtc) / DAY_MINUTES) * 100 },
      { ...base, key: `${base.key}-b`, left: 0, width: (window.endMinuteUtc / DAY_MINUTES) * 100 },
    ];
  });
};

export function PricingPeriodCard({ scheduleId, now }: {
  /** Pricing-schedule preset id the card reads. */
  scheduleId: string;
  /** Injected clock for tests; live time otherwise. */
  now?: number;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const styles = useStyles();
  const reading = usePricingPeriod(scheduleId, now);
  const { holidayNote, hour, next, period, remainingMs } = reading;
  const clock = clockFormat(locale);
  const nowPercent = Math.min(100, Math.max(0, (hour / 24) * 100));
  const def = pricingScheduleById(scheduleId);
  if (def === undefined) throw new Error(`Unknown peak schedule ${JSON.stringify(scheduleId)}`);
  const segments = peakSegmentsOf(scheduleId);

  // The peak badge is the field's own word; the off-peak one carries the rate
  // it implies, which only the state cares about -- the windows below are
  // periods, not prices.
  const badge = period === 'peak'
    ? t('dashboard.upstreamEditor.models.pricingPeriodValues.peak')
    : t('dashboard.upstreamEditor.models.pricingPeriodCard.stateOffPeak');
  const periodLabel = (value: PricingPeriod): string =>
    value === 'peak'
      ? t('dashboard.upstreamEditor.models.pricingPeriodValues.peak')
      : t('dashboard.upstreamEditor.models.pricingPeriodValues.offPeak');
  const scopeLabel = (scope: 'daily' | 'weekdays' | 'weekends'): string =>
    scope === 'daily'
      ? t('dashboard.upstreamEditor.models.pricingPeriodCard.scopeDaily')
      : scope === 'weekdays'
        ? t('dashboard.upstreamEditor.models.pricingPeriodCard.scopeWeekdays')
        : t('dashboard.upstreamEditor.models.pricingPeriodCard.scopeWeekends');

  return <Panel className={`min-w-0 ${PANEL_STACK_CLASS}`}>
    <div className="flex items-center justify-between gap-2">
      <Text as="h4" className="m-0 min-w-0" size={300} truncate weight="semibold" wrap={false}>
        {t('dashboard.upstreamEditor.models.pricingPeriodCard.title')}
      </Text>
      <StatusBadge className="flex-none" tone={period === 'peak' ? 'accent' : 'success'}>{badge}</StatusBadge>
    </div>

    <div aria-atomic="true" aria-live="polite">
      <Text block className="text-fui-fg2" size={200}>{next}</Text>
      {holidayNote !== null && <Text block className="text-fui-fg2" size={200}>{holidayNote}</Text>}
    </div>

    {/* Ticking digits announce nothing: the line above already carries the
    switch for assistive tech, and a per-second live region would talk over it. */}
    <div aria-hidden="true" className="flex items-baseline gap-2">
      <Text className="font-mono tabular-nums" size={700} weight="semibold">{clockCountdown(remainingMs)}</Text>
      <Text className="text-fui-fg2" size={200}>{t('dashboard.upstreamEditor.models.pricingPeriodCard.remainingLabel')}</Text>
    </div>

    <div className="grid gap-1">
      <Text block className="text-fui-fg3" size={200} weight="semibold">
        {t('dashboard.upstreamEditor.models.pricingPeriodCard.windowsHeading')}
      </Text>
      <ul className="m-0 grid list-none gap-1 p-0">
        {def.windows.map((row, index) => {
          const span = (row.endMinuteUtc - row.startMinuteUtc + DAY_MINUTES) % DAY_MINUTES;
          return <li className="flex items-baseline justify-between gap-3" key={`${row.startMinuteUtc}-${index}`}>
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="font-mono mono-size-xs">{`${clockAt(clock, row.startMinuteUtc)}-${clockAt(clock, row.endMinuteUtc)}`}</span>
              <Text size={200}>{periodLabel('peak')}</Text>
            </span>
            <span className="flex flex-none items-baseline gap-2">
              <Text size={200} className="text-fui-fg2">
                {formatRemaining(span * 60_000, locale)}
              </Text>
              <Text size={200} className="text-fui-fg3">
                {scopeLabel(row.days)}
              </Text>
            </span>
          </li>;
        })}
      </ul>
    </div>

    {/* The bar repeats the list as ink; every number above is already read out. */}
    <div aria-hidden="true" className="grid gap-1">
      <div className={styles.rail}>
        <div className={styles.track}>
          {segments.map(segment => <span
            className={styles.peak}
            key={segment.key}
            style={{
              left: `${segment.left}%`,
              width: `${segment.width}%`,
            }}
          />)}
        </div>
        <span className={styles.marker} style={{ left: `${nowPercent}%` }} />
      </div>
      <div className="grid grid-cols-4">
        {RULER_HOURS.map(hourMark => <span className="font-mono mono-size-xs text-fui-fg3" key={hourMark}>
          {clockAt(clock, hourMark * 60)}
        </span>)}
      </div>
    </div>
  </Panel>;
}
