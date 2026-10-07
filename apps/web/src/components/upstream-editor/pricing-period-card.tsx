import { usePricingPeriod } from './pricing-period';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { formatRemaining } from '../../lib/format-duration';
import { useLocale } from '../../lib/use-locale';
import { PANEL_STACK_CLASS } from '../ui/layout';
import { Panel } from '../ui/panel';
import { StatusBadge } from '../ui/status-badge';

const { Text, makeStyles } = fluentComponents;

type PricingPeriod = 'peak' | 'off-peak';

// A switch-day countdown reads as a clock, not a duration ladder: H:MM:SS
// down to the switch, with the hours uncapped across multi-day holiday runs.
const clockCountdown = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const pad2 = (part: number): string => String(part).padStart(2, '0');
  return `${Math.floor(total / 3_600)}:${pad2(Math.floor(total / 60) % 60)}:${pad2(total % 60)}`;
};

// The schedule the card draws: two peak windows in UTC and the off-peak run
// between them. `scope` is what the window is measured against -- the daily
// band applies to every calendar day, the weekday one only to Monday-Friday.
const WINDOWS: readonly { endHour: number; period: PricingPeriod; scope: 'daily' | 'weekdays'; startHour: number }[] = [
  { endHour: 4, period: 'peak', scope: 'daily', startHour: 1 },
  { endHour: 6, period: 'off-peak', scope: 'daily', startHour: 4 },
  { endHour: 10, period: 'peak', scope: 'weekdays', startHour: 6 },
];

const PEAK_SEGMENTS = WINDOWS.filter(row => row.period === 'peak');
const RULER_HOURS = [0, 6, 12, 18] as const;

// Only the clock face is read, so the date behind it is a stand-in.
const clockFormat = (locale: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(locale, { hour: '2-digit', hourCycle: 'h23', minute: '2-digit', timeZone: 'UTC' });

const clockAt = (format: Intl.DateTimeFormat, hour: number): string => format.format(new Date(hour * 3_600_000));

const useStyles = makeStyles({
  // The rail is drawn here rather than handed to ProgressBar: a progress bar
  // fills from zero, and this day carries two separate windows. Its thickness
  // is Fluent's own large step -- `barThicknessValues.large` is 4px in
  // @fluentui/react-progress's useProgressBarStyles -- and the 1.5px corner is
  // WinUI's ProgressBarCornerRadius, written as the length it is rather than a
  // multiplier, so the corner holds at whatever thickness the band takes.
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

export function PricingPeriodCard({ now }: {
  /** Injected clock for tests; live time otherwise. */
  now?: number;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const styles = useStyles();
  const reading = usePricingPeriod(now);
  const { holidayNote, hour, next, period, remainingMs } = reading;
  const clock = clockFormat(locale);
  const nowPercent = Math.min(100, Math.max(0, (hour / 24) * 100));

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
        {WINDOWS.map(row => <li className="flex items-baseline justify-between gap-3" key={row.startHour}>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="font-mono mono-size-xs">{`${clockAt(clock, row.startHour)}-${clockAt(clock, row.endHour)}`}</span>
            <Text size={200}>{periodLabel(row.period)}</Text>
          </span>
          <span className="flex flex-none items-baseline gap-2">
            <Text size={200} className="text-fui-fg2">
              {formatRemaining((row.endHour - row.startHour) * 3_600_000, locale)}
            </Text>
            <Text size={200} className="text-fui-fg3">
              {row.scope === 'daily'
                ? t('dashboard.upstreamEditor.models.pricingPeriodCard.scopeDaily')
                : t('dashboard.upstreamEditor.models.pricingPeriodCard.scopeWeekdays')}
            </Text>
          </span>
        </li>)}
      </ul>
    </div>

    {/* The bar repeats the list as ink; every number above is already read out. */}
    <div aria-hidden="true" className="grid gap-1">
      <div className={styles.rail}>
        <div className={styles.track}>
          {PEAK_SEGMENTS.map(segment => <span
            className={styles.peak}
            key={segment.startHour}
            style={{
              left: `${(segment.startHour / 24) * 100}%`,
              width: `${((segment.endHour - segment.startHour) / 24) * 100}%`,
            }}
          />)}
        </div>
        <span className={styles.marker} style={{ left: `${nowPercent}%` }} />
      </div>
      <div className="grid grid-cols-4">
        {RULER_HOURS.map(hourMark => <span className="font-mono mono-size-xs text-fui-fg3" key={hourMark}>
          {clockAt(clock, hourMark)}
        </span>)}
      </div>
    </div>
  </Panel>;
}
