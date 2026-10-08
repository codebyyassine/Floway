import { describe, expect, it } from 'vitest';

import { flowayTokenStorageKey } from '../../src/auth/session';
import { i18n } from '../../src/i18n';
import DashboardMonitorPricingPeriod, { clientLoader } from '../../src/routes/dashboard-monitor-pricing-period';
import { stubLocalStorage } from '../local-storage-stub';
import { renderInApp } from '../render';

const store = stubLocalStorage();

describe('monitor pricing period page', () => {
  it('renders the live pricing period card under its own header', () => {
    const view = renderInApp(<DashboardMonitorPricingPeriod />);

    expect(view.getByRole('heading', { name: i18n.t('dashboard.nav.pricingPeriod') })).toBeTruthy();
    expect(view.getByText(i18n.t('dashboard.upstreamEditor.models.pricingPeriodCard.title'))).toBeTruthy();
  });

  it('loads for a signed-in session without fetching', async () => {
    store.set(flowayTokenStorageKey, 'operator-session');

    await expect(clientLoader()).resolves.toBeNull();
  });

  it('redirects a signed-out session to sign-in', async () => {
    await expect(clientLoader()).rejects.toMatchObject({ status: 302 });
  });
});
