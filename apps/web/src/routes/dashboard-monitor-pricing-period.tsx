import { requireDashboardSession } from './guards';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { PricingPeriodCard } from '../components/upstream-editor/pricing-period-card';
import { useTranslation } from '../i18n/translation';

export async function clientLoader() {
  requireDashboardSession();
  return null;
}

export default function DashboardMonitorPricingPeriod() {
  const { t } = useTranslation();
  return (
    <section className="dashboard-page max-w-[1200px]">
      <DashboardPageHeader description={t('dashboard.pages.pricingPeriod')} title={t('dashboard.nav.pricingPeriod')} />
      <PricingPeriodCard />
    </section>
  );
}
