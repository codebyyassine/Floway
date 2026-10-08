import { describe, expect, it, vi } from 'vitest';

import { PricingEditor } from '../../../src/components/upstream-editor/pricing-editor';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

describe('read-only pricing editor', () => {
  it('keeps one visible pricing rule selected', () => {
    const view = renderInApp(
      <PricingEditor
        kind="chat"
        onChange={vi.fn()}
        readOnly
        upstreamKind="custom"
        value={{
          entries: [
            { rates: { input_tokens: '0.000001' } },
            { selector: { serviceTier: 'priority' }, rates: { input_tokens: '0.000002' } },
          ],
        }}
      />,
    );

    const selected = view.container.querySelectorAll('[aria-selected="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain(i18n.t('dashboard.upstreamEditor.models.pricingBase'));
  });

  it('reads the rule list as Base against Off-peak and explains the period field', () => {
    const view = renderInApp(
      <PricingEditor
        kind="chat"
        onChange={vi.fn()}
        readOnly
        upstreamKind="custom"
        value={{
          entries: [
            { rates: { input_tokens: '0.000001' } },
            { selector: { pricingPeriod: 'off-peak' }, rates: { input_tokens: '0.0000005' } },
          ],
        }}
      />,
    );

    const rows = [...view.container.querySelectorAll('[role="option"], .fui-ListItem')];
    const rowText = (fragment: string): string =>
      rows.find(row => row.textContent?.includes(fragment))?.textContent ?? '';

    expect(rowText(i18n.t('dashboard.upstreamEditor.models.pricingBase'))).toContain(
      i18n.t('dashboard.upstreamEditor.models.basePricingSummary'),
    );
    const offPeakRow = rowText(i18n.t('dashboard.upstreamEditor.models.pricingPeriodValues.offPeak'));
    expect(offPeakRow).toContain(i18n.t('dashboard.upstreamEditor.models.overridePricingSummary'));
    expect(offPeakRow).not.toContain(i18n.t('dashboard.upstreamEditor.models.pricingBase'));

    expect(view.getByText(i18n.t('dashboard.upstreamEditor.models.pricingPeriodHint'))).toBeTruthy();
    expect(view.getByPlaceholderText(i18n.t('dashboard.upstreamEditor.models.pricingPeriodPlaceholder'))).toBeTruthy();
  });

  it('hides the DeepSeek pricing period field on a Codex model without off-peak pricing', () => {
    const view = renderInApp(
      <PricingEditor
        kind="chat"
        onChange={vi.fn()}
        readOnly
        upstreamKind="codex"
        value={{
          entries: [
            { rates: { input_tokens: '0.000001' } },
            { selector: { serviceTier: 'priority' }, rates: { input_tokens: '0.000002' } },
          ],
        }}
      />,
    );

    expect(() => view.getByText(i18n.t('dashboard.upstreamEditor.models.pricingPeriodHint'))).toThrow();
    expect(() => view.getByPlaceholderText(i18n.t('dashboard.upstreamEditor.models.pricingPeriodPlaceholder'))).toThrow();
  });

  it('keeps an existing off-peak entry editable on a Codex model that already uses it', () => {
    const view = renderInApp(
      <PricingEditor
        kind="chat"
        onChange={vi.fn()}
        readOnly
        upstreamKind="codex"
        value={{
          entries: [
            { rates: { input_tokens: '0.000001' } },
            { selector: { pricingPeriod: 'off-peak' }, rates: { input_tokens: '0.0000005' } },
          ],
        }}
      />,
    );

    expect(view.getByText(i18n.t('dashboard.upstreamEditor.models.pricingPeriodHint'))).toBeTruthy();
  });
});
