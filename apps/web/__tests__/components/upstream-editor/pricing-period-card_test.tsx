import { describe, expect, it } from 'vitest';

import { PricingPeriodCard } from '../../../src/components/upstream-editor/pricing-period-card';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';
import { DEEPSEEK_HOLIDAY_DATES } from '@floway-dev/protocols/common';

const key = (leaf: string): string => i18n.t(`dashboard.upstreamEditor.models.pricingPeriodCard.${leaf}`);

// Tuesday 2026-09-29, clear of the Mid-Autumn/National Day holiday weeks.
const PEAK_NOW = Date.parse('2026-09-29T07:00:00Z');
const OFF_PEAK_NOW = Date.parse('2026-09-29T05:00:00Z');
// Thursday 2026-10-01, inside the National Day holiday week.
const HOLIDAY_NOW = Date.parse('2026-10-01T07:00:00Z');

describe('pricing period card', () => {
  it('reads peak from the injected clock with a countdown to the next switch', () => {
    const view = renderInApp(<PricingPeriodCard scheduleId="deepseek" now={PEAK_NOW} />);

    expect(view.getByText(key('title'))).toBeTruthy();
    // Badge plus the two peak rows share the word.
    expect(view.getAllByText(i18n.t('dashboard.upstreamEditor.models.pricingPeriodValues.peak'))).toHaveLength(3);
    expect(view.getByText('3:00:00')).toBeTruthy();
    expect(view.getByText(key('remainingLabel'))).toBeTruthy();
    expect(view.container.textContent).toContain('10:00');
  });

  it('reads off-peak from the injected clock', () => {
    const view = renderInApp(<PricingPeriodCard scheduleId="deepseek" now={OFF_PEAK_NOW} />);

    expect(view.getByText(key('stateOffPeak'))).toBeTruthy();
    expect(view.getByText('1:00:00')).toBeTruthy();
    expect(view.container.textContent).toContain('06:00');
  });

  it('treats a statutory-holiday Beijing day as off-peak with a holiday note', () => {
    const view = renderInApp(<PricingPeriodCard scheduleId="deepseek" now={HOLIDAY_NOW} />);

    expect(view.getByText(key('stateOffPeak'))).toBeTruthy();
    expect(view.getByText(/Beijing|北京时间/)).toBeTruthy();
  });

  it('reads another schedule on its own hours', () => {
    // 05:00 UTC is DeepSeek off-peak but Qwen-night peak (00:00-14:00 UTC).
    const view = renderInApp(<PricingPeriodCard scheduleId="qwen-night" now={OFF_PEAK_NOW} />);

    expect(view.getAllByText(i18n.t('dashboard.upstreamEditor.models.pricingPeriodValues.peak')).length).toBeGreaterThan(0);
    expect(view.getByText('9:00:00')).toBeTruthy();
  });

  it('draws the nominal window list and the now-marker', () => {
    const view = renderInApp(<PricingPeriodCard scheduleId="deepseek" now={OFF_PEAK_NOW} />);

    const rows = [...view.container.querySelectorAll('li')].map(row => row.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('01:00-04:00');
    expect(rows[0]).toContain(i18n.t('dashboard.upstreamEditor.models.pricingPeriodValues.peak'));
    expect(rows[0]).toContain(key('scopeDaily'));
    expect(rows[1]).toContain('06:00-10:00');
    expect(rows[1]).toContain(key('scopeWeekdays'));

    // The peak segments are the only styled spans carrying a width; their
    // parent is the track, and the marker is the track's sibling.
    const segment = [...view.container.querySelectorAll<HTMLElement>('[style]')]
      .find(element => element.style.width !== '');
    const marker = segment?.parentElement?.parentElement?.lastElementChild;
    expect(marker).not.toBeUndefined();
    expect(Number.parseFloat((marker as HTMLElement).style.left)).toBeCloseTo((5 / 24) * 100, 2);
  });

  it('reads the shared holiday calendar the gateway classifies against', () => {
    expect([...DEEPSEEK_HOLIDAY_DATES].sort()).toContain('2026-10-01');
  });
});
