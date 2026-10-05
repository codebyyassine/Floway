import { describe, expect, it } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { readWindows, type OpencodeGoRecord } from '../../../src/components/upstreams/opencode-go-usage';
import { upstreamReadout } from '../../../src/components/upstreams/signals';
import en from '../../../src/i18n/locales/en';
import type { TFunction } from '../../../src/i18n/translation';

// The real resources rather than a key echo, so a key this row needs but the
// locales do not define fails here rather than rendering as itself.
const resolve = (key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en.translation);

const t = ((key: string, values?: Record<string, unknown>) => {
  const template = resolve(key);
  if (typeof template !== 'string') throw new Error(`Missing i18n key: ${key}`);
  return template.replace(/\{\{(\w+)[^}]*\}\}/g, (_, name: string) => String(values?.[name]));
}) as unknown as TFunction;

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const OBSERVED = Date.parse('2026-07-28T11:00:00.000Z');

const windowBody = (overrides: Record<string, unknown> = {}) => ({
  usage: {
    rolling: { status: 'ok', percent: 4, resetsAt: '2026-08-13T16:27:38.287Z' },
    weekly: { status: 'ok', percent: 3, resetsAt: '2026-08-17T00:00:00.287Z' },
    monthly: { status: 'ok', percent: 1, resetsAt: '2026-09-13T06:06:01.287Z' },
    ...overrides,
  },
});

const recordWith = (data: unknown): OpencodeGoRecord => ({
  kind: 'opencode-go',
  state: {
    usageProbe: {
      attemptedAt: OBSERVED,
      error: null,
      observation: { fetchedAt: OBSERVED, data },
    },
  },
}) as unknown as OpencodeGoRecord;

describe('opencode-go usage windows', () => {
  // `percent` arrives already 0..100, unlike the 0..1 fraction the Ollama
  // endpoint reports: reading it as a fraction would overstate every window a
  // hundredfold.
  it('reads each window percent as stated, under its own length', () => {
    expect(readWindows(windowBody())).toEqual([
      { key: 'rolling', minutes: 300, percent: 4, resetAt: '2026-08-13T16:27:38.287Z', blocked: false },
      { key: 'weekly', minutes: 10080, percent: 3, resetAt: '2026-08-17T00:00:00.287Z', blocked: false },
      { key: 'monthly', minutes: 43200, percent: 1, resetAt: '2026-09-13T06:06:01.287Z', blocked: false },
    ]);
  });

  it('parses both reset forms, preferring the named instant', () => {
    const both = readWindows(windowBody({
      rolling: { status: 'ok', percent: 4, resetsAt: '2026-08-13T16:27:38.287Z', resetInSec: 3600 },
    }));
    expect(both[0]?.resetAt).toBe('2026-08-13T16:27:38.287Z');

    const countdown = readWindows(windowBody({
      rolling: { status: 'ok', percent: 4, resetInSec: 90 },
    }));
    const resetAt = countdown[0]?.resetAt;
    expect(resetAt).not.toBeNull();
    expect(Math.abs(Date.parse(resetAt!) - (Date.now() + 90 * 1000))).toBeLessThan(5000);
  });

  // A spent window is a different fact from a full one: it stays on the row
  // with the block stated, rather than reading as zero or disappearing.
  it('keeps a rate-limited window with the block stated', () => {
    const windows = readWindows(windowBody({
      rolling: { status: 'rate-limited', percent: 96, resetsAt: '2026-08-13T16:27:38.287Z' },
    }));
    expect(windows).toHaveLength(3);
    expect(windows[0]).toMatchObject({ key: 'rolling', percent: 96, blocked: true });
    expect(windows.slice(1).map(window => window.blocked)).toEqual([false, false]);
  });

  it('omits a missing window rather than showing it as zero', () => {
    expect(readWindows({ usage: { rolling: { status: 'ok', percent: 4, resetsAt: '2026-08-13T16:27:38.287Z' } } }))
      .toEqual([{ key: 'rolling', minutes: 300, percent: 4, resetAt: '2026-08-13T16:27:38.287Z', blocked: false }]);
  });

  it('yields no windows from garbage without throwing', () => {
    for (const data of [null, undefined, 42, 'usage', [], {}, { usage: null }, { usage: [] },
      { usage: { rolling: null, weekly: 'half', monthly: { status: 'ok' } } },
      { usage: { rolling: { status: 'ok', percent: Number.NaN, resetsAt: '2026-08-13T16:27:38.287Z' } } },
      { usage: { rolling: { status: 'ok', percent: Number.POSITIVE_INFINITY } } }]) {
      expect(readWindows(data)).toEqual([]);
    }
  });

  it('leaves a window unqualified when its reset cannot be read', () => {
    const windows = readWindows(windowBody({
      rolling: { status: 'ok', percent: 4, resetsAt: 'not a date', resetInSec: -12 },
    }));
    expect(windows[0]).toMatchObject({ key: 'rolling', percent: 4, resetAt: null, blocked: false });
  });
});

describe('opencode-go row readout', () => {
  it('renders the three quota windows the way the Ollama card does', () => {
    const { plan, signals } = upstreamReadout(recordWith(windowBody()), t, 'en', NOW);
    expect(plan).toBe('OpenCode Go');
    expect(signals.map(signal => [signal.value, signal.label].filter(Boolean).join(' ')))
      .toEqual(['4% 5h', '3% 7d', '1% 30d']);
    expect(signals[0]?.detail).toContain('5h: 4% used');
    expect(signals[0]?.detail).toContain('Resets ');
    expect(signals.every(signal => signal.blocked === false)).toBe(true);
  });

  it('paints a spent window red while keeping its percentage', () => {
    const { signals } = upstreamReadout(
      recordWith(windowBody({ rolling: { status: 'rate-limited', percent: 96, resetsAt: '2026-08-13T16:27:38.287Z' } })),
      t,
      'en',
      NOW,
    );
    expect(signals[0]).toMatchObject({ value: '96%', label: '5h', blocked: true });
  });

  it('reports nothing before the first observation arrives', () => {
    expect(upstreamReadout({ kind: 'opencode-go', state: null } as unknown as UpstreamRecord, t, 'en', NOW))
      .toEqual({ plan: 'OpenCode Go', signals: [] });
  });
});
