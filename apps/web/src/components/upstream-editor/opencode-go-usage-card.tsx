// OpenCode Go subscription usage, read inside the editor. The gateway keeps
// the last probe on the upstream, so this card is current on open; the action
// is the operator's unconditional read, and it carries the key out of the edit
// form, so an unsaved key can be tried before it is stored.
//
// OpenCode Go publishes no account -- its state is the probe alone -- so the
// three windows are the whole reading, and a reading never taken is stated as
// that rather than rendered as nothing: an empty card is the defect this one
// exists to remove.

import { useCallback, useState } from 'react';

import { api, callApi } from '../../api/client';
import type { OpencodeGoUsageRefresh, UpstreamRecordEnvelope } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime } from '../../lib/format-time';
import { clampPercent } from '../../lib/percent';
import { useLocale } from '../../lib/use-locale';
import { useDangerTextClass } from '../ui/danger';
import { SECTION_STACK_CLASS } from '../ui/layout';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { ResourceListActions } from '../ui/resource-list';
import { SectionHeader } from '../ui/section-header';
import { useRefresh } from '../ui/use-refresh';
import { type OpencodeGoRecord, readWindows } from '../upstreams/opencode-go-usage';
import { quotaBarColor, windowLengthLabel } from '../upstreams/subscription-quota';

const { ProgressBar, Text } = fluentComponents;

export function OpencodeGoUsageCard({ probeRecord, record }: { probeRecord: UpstreamRecordEnvelope; record: OpencodeGoRecord }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const dangerText = useDangerTextClass();
  // A manual refresh persists server-side too; this local copy only avoids
  // re-fetching the whole record to display the reading it just produced.
  const [refreshed, setRefreshed] = useState<OpencodeGoUsageRefresh | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stored = record.state?.usageProbe ?? null;
  const observation = refreshed?.observation ?? stored?.observation ?? null;
  const windows = readWindows(observation?.data);
  // A background probe records its failure on the upstream rather than
  // interrupting the request that armed it, so this is where it surfaces. A
  // manual refresh that succeeded has already answered the question.
  const backgroundError = refreshed === null ? stored?.error ?? null : null;

  const { refresh: load, refreshing: loading } = useRefresh(useCallback(async (signal: AbortSignal) => {
    setError(null);
    const { data, error: failure } = await callApi(
      () => api.api.upstreams['opencode-go'].usage.$post({ json: { record: probeRecord } }, { init: { signal } }),
    );
    if (signal.aborted) return;
    if (failure) {
      setError(failure.message);
      return;
    }
    setRefreshed(data);
  }, [probeRecord]));

  return <section className={SECTION_STACK_CLASS}>
    <SectionHeader level={3} title={t('dashboard.upstreamEditor.opencodeGo.usage.title')} actions={
      <ResourceListActions
        appearance="subtle"
        onRefresh={() => void load()}
        refreshLabel={t(`dashboard.upstreamEditor.opencodeGo.usage.${observation ? 'refresh' : 'load'}`)}
        refreshing={loading}
      />
    } />

    {/* Each window is named by the length it covers, so one window reads the
        same here as on the row beside this editor. A refused window paints its
        number in the critical fill -- the block is stated, never inferred from
        how full the bar is, which is how the list row says it too. */}
    {windows.map(usageWindow => <div className="grid gap-1" key={usageWindow.key}>
      <div className="flex items-baseline justify-between gap-3">
        <Text size={300}>{windowLengthLabel(usageWindow.minutes)}</Text>
        <Text size={200} className={usageWindow.blocked ? dangerText : 'text-fui-fg2'}>
          {t('dashboard.upstreamEditor.opencodeGo.usage.usedPercent', { percent: usageWindow.percent })}
        </Text>
      </div>
      <ProgressBar color={quotaBarColor(usageWindow.percent)} max={100} thickness="large" value={clampPercent(usageWindow.percent) ?? undefined} />
      {usageWindow.resetAt !== null && <Text size={200} className="text-fui-fg3">
        {t('dashboard.upstreams.signals.resets', { time: dateTime(usageWindow.resetAt, locale) })}
      </Text>}
    </div>)}

    {observation && <Text size={200} className="text-fui-fg3">
      {t('dashboard.upstreams.signals.observed', { time: dateTime(observation.fetchedAt, locale) })}
    </Text>}

    {observation && windows.length === 0 && <Text size={200} className="text-fui-fg3">
      {t('dashboard.upstreamEditor.opencodeGo.usage.unreadable')}
    </Text>}

    {!observation && !loading && <Text size={200} className="text-fui-fg3">
      {t('dashboard.upstreamEditor.opencodeGo.usage.empty')}
    </Text>}

    {backgroundError !== null && <OutcomeMessageBar intent="warning">
      {t('dashboard.upstreamEditor.opencodeGo.usage.backgroundFailed', { message: backgroundError })}
    </OutcomeMessageBar>}

    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
  </section>;
}
