import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexAccountCard } from '../../../src/components/upstream-editor/codex-account-card';
import type { CodexRecord } from '../../../src/components/upstreams/codex-account';
import { UpstreamSignals } from '../../../src/components/upstreams/signals';
import { upstreamRecord } from '../../api/upstream-fixture';
import { stubLocalStorage } from '../../local-storage-stub';
import { renderInApp } from '../../render';

stubLocalStorage();

const observed = '2026-07-28T11:00:00.000Z';
const primaryReset = '2026-07-28T13:00:00.000Z';
const secondaryReset = '2026-08-01T12:00:00.000Z';
const nextReset = '2026-09-01T00:00:00.000Z';
const record = upstreamRecord('', {
  kind: 'codex',
  config: { accounts: [{ email: 'fixture@example.com', chatgptAccountId: 'fixture', chatgptUserId: 'fixture', planType: 'plus' }] },
  state: { accounts: [{ chatgptAccountId: 'fixture', state: 'active', state_updated_at: observed }] },
}) as CodexRecord;

// `after` is what both surfaces read once `until` passes, in window order, and
// `resets` is how many reset instants are still advertised then; list and card
// share the projection, so they cannot disagree.
const cases = [
  { name: 'primary only', primary: 100, secondary: 35, until: primaryReset, after: [0, 35], resets: 1 },
  { name: 'secondary only', primary: 35, secondary: 100, until: secondaryReset, after: [0, 0], resets: 0 },
  { name: 'both known', primary: 100, secondary: 100, until: secondaryReset, after: [0, 0], resets: 0 },
  { name: 'unknown secondary percentage', primary: 100, secondary: undefined, until: primaryReset, after: [0], resets: 0 },
  { name: 'exhausted secondary without reset', primary: 100, secondary: 100, secondaryReset: undefined, until: primaryReset, after: [0, 100], resets: 0 },
  { name: 'unknown primary percentage', primary: undefined, secondary: 100, until: secondaryReset, after: [0], resets: 0 },
];

afterEach(() => vi.useRealTimers());

describe('Codex projected quota on list and card', () => {
  it.each(cases)('expires the known timer without new traffic: $name', async ({ primary, secondary, until, after, resets, ...scenario }) => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-07-28T12:00:00.000Z');
    const quota = {
      observed_at: observed,
      active_limit: 'premium',
      primary_used_percent: primary,
      primary_window_minutes: 300,
      primary_reset_after_at: primaryReset,
      secondary_used_percent: secondary,
      secondary_window_minutes: 10_080,
      secondary_reset_after_at: 'secondaryReset' in scenario ? scenario.secondaryReset : secondaryReset,
      ratelimited_until: until,
    };
    const projected = { ...record, codex_quota: { premium: quota } };
    const view = renderInApp(<><div data-testid="list"><UpstreamSignals record={projected} /></div><div data-testid="card"><CodexAccountCard record={projected} /></div></>);
    const list = within(screen.getByTestId('list'));
    const card = within(screen.getByTestId('card'));
    expect(list.getByText('Rate limited')).toBeTruthy();
    expect(card.getAllByText(/^Rate-limited until/)).toHaveLength(2);

    // Passing the short reset must not clear a genuine later exhausted window.
    await act(async () => {
      vi.setSystemTime(Date.parse(primaryReset) + 1);
      vi.advanceTimersByTime(60_000);
    });
    expect(list.queryByText('Rate limited') !== null).toBe(until === secondaryReset);

    await act(async () => {
      vi.setSystemTime(Date.parse(until) + 1);
      vi.advanceTimersByTime(60_000);
    });
    expect(list.queryByText('Rate limited')).toBeNull();
    expect(card.queryByText(/^Rate-limited until/)).toBeNull();

    // An elapsed window reads fresh on both surfaces; a window the snapshot
    // never dated keeps the reading it was last seen with.
    for (const percent of new Set(after)) {
      expect(list.getAllByText(`${percent}%`).length).toBeGreaterThan(0);
      expect(card.getAllByText(`${percent}%`).length).toBeGreaterThan(0);
    }
    const stillHeavy = after.some(percent => percent >= 80);
    expect(list.queryByText('100%') !== null).toBe(after.includes(100));
    expect(card.queryByText('100%') !== null).toBe(after.includes(100));
    expect(card.queryByText(/^Heavy usage/) !== null).toBe(stillHeavy);
    expect(card.queryByText('Active') !== null).toBe(!stillHeavy);
    // A rolled-over window no longer advertises the reset instant it passed.
    expect(card.queryAllByText(/^Resets at/)).toHaveLength(resets);
    expect(projected.codex_quota.premium).toEqual(quota);

    // A fresh reading repopulates the window with a real percent.
    const fresh = { ...projected, codex_quota: { premium: { ...quota, primary_used_percent: 12, secondary_used_percent: 35, primary_reset_after_at: nextReset, secondary_reset_after_at: nextReset, ratelimited_until: undefined } } };
    view.rerender(<><div data-testid="list"><UpstreamSignals record={fresh} /></div><div data-testid="card"><CodexAccountCard record={fresh} /></div></>);
    expect(card.getByText('Active')).toBeTruthy();
    expect(list.getByText('12%')).toBeTruthy();
    expect(list.getByText('35%')).toBeTruthy();
    expect(list.queryByText('100%')).toBeNull();
  });

  it('does not invent a timed restriction or zero usage when no exhausted reset is known', () => {
    const projected = { ...record, codex_quota: { premium: { observed_at: observed, primary_used_percent: 100 } } };
    renderInApp(<><UpstreamSignals record={projected} /><CodexAccountCard record={projected} /></>);
    expect(screen.queryByText('Rate limited')).toBeNull();
    expect(screen.queryByText(/^Rate-limited until/)).toBeNull();
    expect(screen.getByText('Heavy usage (100%)')).toBeTruthy();
    expect(screen.queryByText('0%')).toBeNull();
  });
});
