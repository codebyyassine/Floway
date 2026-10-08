import { useState } from 'react';

import { requireDashboardSession } from './guards';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { Dropdown } from '../components/ui/fluent-form-controls';
import { PEAK_SCHEDULE_PRESET_IDS, type PeakSchedulePresetId } from '../components/upstream-editor/peak-schedules';
import { PricingPeriodCard } from '../components/upstream-editor/pricing-period-card';
import { fluentComponents } from '../fluent';
import { useTranslation } from '../i18n/translation';

const { Field, Option } = fluentComponents;

export async function clientLoader() {
  requireDashboardSession();
  return null;
}

export default function DashboardMonitorPricingPeriod() {
  const { t } = useTranslation();
  const [scheduleId, setScheduleId] = useState<PeakSchedulePresetId>('deepseek');
  return (
    <section className="dashboard-page max-w-[1200px]">
      <DashboardPageHeader description={t('dashboard.pages.pricingPeriod')} title={t('dashboard.nav.pricingPeriod')} />
      <Field className="min-w-0 max-w-[420px]" label={t('dashboard.upstreamEditor.peakPricing.schedule')}>
        <Dropdown
          aria-label={t('dashboard.upstreamEditor.peakPricing.schedule')}
          selectedOptions={[scheduleId]}
          value={t(`dashboard.upstreamEditor.peakSchedules.${scheduleId}`)}
          onOptionSelect={(_, data) => {
            if (data.optionValue !== undefined) setScheduleId(data.optionValue as PeakSchedulePresetId);
          }}
        >
          {PEAK_SCHEDULE_PRESET_IDS.map(id => <Option key={id} value={id}>{t(`dashboard.upstreamEditor.peakSchedules.${id}`)}</Option>)}
        </Dropdown>
      </Field>
      <PricingPeriodCard scheduleId={scheduleId} />
    </section>
  );
}
