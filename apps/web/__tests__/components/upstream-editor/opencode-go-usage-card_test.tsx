import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { previewRecord, valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { OpencodeGoUsageCard } from '../../../src/components/upstream-editor/opencode-go-usage-card';
import type { OpencodeGoRecord } from '../../../src/components/upstreams/opencode-go-usage';
import { i18n } from '../../../src/i18n';
import { localeForLanguage } from '../../../src/i18n/languages';
import { dateTime } from '../../../src/lib/format-time';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';
import { settle } from '../../settle';

const BASE = 'https://opencode.ai/zen/go';
const locale = localeForLanguage(i18n.language);
const RESET = '2026-11-04T23:17:00.000Z';
const OBSERVED_AT = 1_780_000_000_000;

const usage = (key: string) => i18n.t(`dashboard.upstreamEditor.opencodeGo.usage.${key}`);
const usedPercent = (percent: number) => i18n.t('dashboard.upstreamEditor.opencodeGo.usage.usedPercent', { percent });
const resets = () => i18n.t('dashboard.upstreams.signals.resets', { time: dateTime(RESET, locale) });
const observed = () => i18n.t('dashboard.upstreams.signals.observed', { time: dateTime(OBSERVED_AT, locale) });

const windowsBody = {
  usage: {
    rolling: { status: 'ok', percent: 4, resetsAt: RESET },
    weekly: { status: 'ok', percent: 40, resetsAt: RESET },
    monthly: { status: 'rate-limited', percent: 96, resetsAt: RESET },
  },
};

const record = (state: OpencodeGoRecord['state']) =>
  upstreamRecord('up_ocg', {
    kind: 'opencode-go',
    config: { baseUrl: BASE, apiKeySet: true, models: [] },
    state,
  }) as OpencodeGoRecord;

const renderCard = (state: OpencodeGoRecord['state']) => {
  const rec = record(state);
  renderInApp(<OpencodeGoUsageCard probeRecord={previewRecord(rec, valuesFromRecord(rec))} record={rec} />);
};

const reading = (data: unknown) => ({ usageProbe: { attemptedAt: OBSERVED_AT, observation: { fetchedAt: OBSERVED_AT, data }, error: null } });

// The card reaches the network only from its action, so every suite states the
// transport it wants rather than letting a stray click leave the process.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected request'); }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OpenCode Go usage card', () => {
  it('states that no reading has been taken yet rather than rendering nothing', async () => {
    renderCard(null);
    await settle();

    expect(screen.getByText(usage('empty'))).not.toBeNull();
    expect(screen.getByRole('button', { name: usage('load') })).not.toBeNull();
    // The distinction the operator hit: never fetched must not read as spent.
    expect(screen.queryByText(/\d+%/)).toBeNull();
  });

  it('renders every window a stored reading reports, each with its own reset', async () => {
    renderCard(reading(windowsBody));
    await settle();

    // Named by the length each window covers, so one window reads the same
    // here as on the list row beside this editor.
    for (const label of ['5h', '7d', '30d']) expect(screen.getByText(label)).not.toBeNull();
    for (const percent of [4, 40, 96]) expect(screen.getByText(usedPercent(percent))).not.toBeNull();

    expect(screen.getAllByText(resets())).toHaveLength(3);
    expect(screen.getByText(observed())).not.toBeNull();
    expect(screen.queryByText(usage('empty'))).toBeNull();
    expect(screen.getByRole('button', { name: usage('refresh') })).not.toBeNull();
  });

  it('paints a refused window as refused rather than as an ordinary reading', async () => {
    renderCard(reading(windowsBody));
    await settle();

    // The percentage still reads -- a block and a full window are different
    // facts -- but it stops wearing the quiet foreground every reading wears.
    expect(screen.getByText(usedPercent(96)).className).not.toContain('text-fui-fg2');
    expect(screen.getByText(usedPercent(4)).className).toContain('text-fui-fg2');
  });

  it('reports a probe that failed in the background instead of showing a blank card', async () => {
    renderCard({ usageProbe: { attemptedAt: OBSERVED_AT, observation: null, error: 'upstream refused the key' } });
    await settle();

    expect(screen.getByText(i18n.t('dashboard.upstreamEditor.opencodeGo.usage.backgroundFailed', { message: 'upstream refused the key' }))).not.toBeNull();
    expect(screen.getByText(usage('empty'))).not.toBeNull();
  });

  it('says the reading could not be read when an observation carries no window', async () => {
    renderCard(reading({ usage: {} }));
    await settle();

    expect(screen.getByText(usage('unreadable'))).not.toBeNull();
    expect(screen.getByText(observed())).not.toBeNull();
  });

  it('sends the form record so an unsaved key can be tried before it is stored', async () => {
    const rec = record(null);
    const values = valuesFromRecord(rec);
    (values.config as OpencodeGoRecord['config']).apiKey = 'sk-draft';
    const bodies: Array<{ record: { config: { apiKey?: string } } }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { record: { config: { apiKey?: string } } });
      return Response.json({ observation: { fetchedAt: OBSERVED_AT, data: windowsBody } });
    }));

    renderInApp(<OpencodeGoUsageCard probeRecord={previewRecord(rec, values)} record={rec} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: usage('load') }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]?.record.config.apiKey).toBe('sk-draft');
    // The reading the press produced replaces the state that invited it.
    await waitFor(() => expect(screen.getByText('5h')).not.toBeNull());
    expect(screen.queryByText(usage('empty'))).toBeNull();
  });

  it('shows the gateway failure rather than reading it as an empty result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'This upstream does not have an API key' }, { status: 400 })));

    renderCard(null);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: usage('load') }));

    await waitFor(() => expect(screen.getByText('This upstream does not have an API key')).not.toBeNull());
    expect(screen.getByText(usage('empty'))).not.toBeNull();
  });
});
