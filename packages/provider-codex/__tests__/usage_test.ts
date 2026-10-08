import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from './upstream-state-repo.ts';
import { CODEX_BACKEND_BASE, CODEX_USAGE_PATH } from '../src/constants.ts';
import { codexQuotaActiveLimitKey } from '../src/quota.ts';
import { readCodexUpstreamState, type CodexUpstreamState } from '../src/state.ts';
import {
  CODEX_USAGE_PROBE_MIN_INTERVAL_MS,
  fetchCodexUsage,
  isCodexUsageProbeDue,
  projectCodexUsageResponse,
  refreshCodexUsageProbe,
  type CodexUsageResponse,
} from '../src/usage.ts';
import { initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';
import { testFetcher } from '@floway-dev/test-utils';

const accountId = 'acc_1';
const upstreamId = 'up_a';
const usageUrl = `${CODEX_BACKEND_BASE}${CODEX_USAGE_PATH}`;

const makeRecord = (state: CodexUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  kind: 'codex',
  name: 'Codex',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', chatgptAccountId: accountId, chatgptUserId: 'usr', planType: 'plus' }] },
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
});

const baseAccount = {
  chatgptAccountId: accountId,
  refresh_token: 'rt_v1',
  state: 'active' as const,
  state_updated_at: '2026-06-01T00:00:00.000Z',
  openaiDeviceId: '11111111-2222-4333-8444-555555555555',
  accessToken: null,
  quotaSnapshot: null,
  usageProbeAttemptedAt: null as number | null,
  usageProbeError: null as string | null,
};

// A cached bearer comfortably inside the refresh skew, so the probe exercises
// the usage read without minting through the OAuth token endpoint.
const liveAccessToken = {
  token: 'at_live',
  expiresAt: Date.now() + 60 * 60 * 1000,
  refreshedAt: '2026-06-05T00:00:00.000Z',
};

let current: UpstreamRecord | null;
let repo: UpstreamStateRepoStub;

beforeEach(() => {
  current = makeRecord({ accounts: [{ ...baseAccount }] });
  repo = createUpstreamStateRepoStub(() => current, state => {
    current = { ...current!, state: state as CodexUpstreamState };
  });
  initProviderRepo(() => ({ upstreams: repo }));
});

afterEach(() => vi.restoreAllMocks());

const accountState = (): CodexUpstreamState => current!.state as CodexUpstreamState;

describe('projectCodexUsageResponse', () => {
  test('projects both windows with minute conversion and unix-seconds resets', () => {
    const snapshot = projectCodexUsageResponse({
      plan_type: 'plus',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_after_seconds: 18000, reset_at: 1780272000 },
        secondary_window: { used_percent: 94, limit_window_seconds: 604800, reset_after_seconds: 486400, reset_at: 1780358400 },
      },
      credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: 0 },
    }, new Date('2026-06-05T00:00:00.000Z'));
    expect(snapshot).toMatchObject({
      observed_at: '2026-06-05T00:00:00.000Z',
      plan_type: 'plus',
      primary_used_percent: 42,
      primary_window_minutes: 300,
      primary_reset_after_at: new Date(1780272000 * 1000).toISOString(),
      secondary_used_percent: 94,
      secondary_window_minutes: 10080,
      secondary_reset_after_at: new Date(1780358400 * 1000).toISOString(),
      credits_has_credits: false,
      credits_balance: 0,
    });
    // The active read names no limit, so it files under the existing unknown
    // key rather than forking the dashboard card by source.
    expect(snapshot?.active_limit).toBeUndefined();
    expect(codexQuotaActiveLimitKey(snapshot!)).toBe('unknown');
  });

  // The upstream sends unix seconds; RFC 3339 and millisecond-scale epochs
  // are tolerated the way the quota headers tolerate both.
  test.each([
    ['unix seconds', 1780272000],
    ['millisecond epoch', 1780272000 * 1000],
    ['RFC 3339', new Date(1780272000 * 1000).toISOString()],
    ['numeric string', '1780272000'],
  ])('dates the reset from a %s instant', (_name, resetAt) => {
    const snapshot = projectCodexUsageResponse({
      rate_limit: { primary_window: { used_percent: 10, reset_at: resetAt } },
    }, new Date('2026-06-05T00:00:00.000Z'));
    expect(snapshot?.primary_reset_after_at).toBe(new Date(1780272000 * 1000).toISOString());
  });

  test('falls back to reset_after_seconds when reset_at is absent', () => {
    const snapshot = projectCodexUsageResponse({
      rate_limit: { primary_window: { used_percent: 10, reset_after_seconds: 7200 } },
    }, new Date('2026-06-05T00:00:00.000Z'));
    expect(snapshot?.primary_reset_after_at).toBe('2026-06-05T02:00:00.000Z');
  });

  test('treats zero and blank reset instants as no reset rather than resetting now', () => {
    const snapshot = projectCodexUsageResponse({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 0, reset_after_seconds: 3600 },
        secondary_window: { used_percent: 10, limit_window_seconds: 0, reset_at: '', reset_after_seconds: 0 },
      },
    }, new Date('2026-06-05T00:00:00.000Z'));
    expect(snapshot?.primary_reset_after_at).toBe('2026-06-05T01:00:00.000Z');
    expect(snapshot?.secondary_reset_after_at).toBeUndefined();
    expect(snapshot?.secondary_window_minutes).toBe(0);
  });

  // Blank rather than absent is how this backend reports a field that does
  // not apply, and `Number('')` is 0, which would render as a confident zero.
  test('reads blank or absent usage as not observed rather than as zero', () => {
    const snapshot = projectCodexUsageResponse({
      rate_limit: {
        primary_window: { used_percent: '', limit_window_seconds: 18000 },
        secondary_window: {},
      },
    }, new Date('2026-06-05T00:00:00.000Z'));
    expect(snapshot).not.toBeNull();
    expect(snapshot).not.toHaveProperty('primary_used_percent');
    expect(snapshot?.primary_window_minutes).toBe(300);
    expect(snapshot).not.toHaveProperty('secondary_used_percent');
  });

  test('projects credit balances sent as strings', () => {
    const snapshot = projectCodexUsageResponse({
      credits: { has_credits: true, balance: '12.5' },
    }, new Date('2026-06-05T00:00:00.000Z'));
    expect(snapshot).toMatchObject({ credits_has_credits: true, credits_balance: 12.5 });
  });

  test('forwards plan_type verbatim', () => {
    const snapshot = projectCodexUsageResponse({ plan_type: 'team_ultra' }, new Date('2026-06-05T00:00:00.000Z'));
    expect(snapshot?.plan_type).toBe('team_ultra');
  });

  test.each([
    ['empty body', {}],
    ['null sections', { plan_type: null, rate_limit: null, credits: null }],
    ['blank plan', { plan_type: '   ' }],
    ['empty windows', { rate_limit: { primary_window: null, secondary_window: {} } }],
    ['unprojected fields only', {
      rate_limit: { allowed: true, limit_reached: false },
      additional_rate_limits: [{ limit_name: 'future', metered_feature: 'x', rate_limit: {} }],
      spend_control: { reached: false },
      rate_limit_reset_credits: { available_count: 1, applicable_available_count: 1 },
    }],
  ])('returns null when the body reports nothing: %s', (_name, body) => {
    expect(projectCodexUsageResponse(body, new Date('2026-06-05T00:00:00.000Z'))).toBeNull();
  });

  // A present-but-wrong-typed field is malformed input, not a default: it
  // throws rather than projecting a guess.
  test.each([
    ['used_percent text', { rate_limit: { primary_window: { used_percent: 'lots' } } }, /used_percent/],
    ['used_percent boolean', { rate_limit: { primary_window: { used_percent: true } } }, /used_percent/],
    ['negative usage', { rate_limit: { primary_window: { used_percent: -1 } } }, /used_percent/],
    ['negative window', { rate_limit: { primary_window: { limit_window_seconds: -5 } } }, /limit_window_seconds/],
    ['unparseable reset', { rate_limit: { primary_window: { reset_at: 'tomorrow-ish' } } }, /reset_at/],
    ['window scalar', { rate_limit: { primary_window: 'x' } }, /primary_window/],
    ['rate_limit array', { rate_limit: [] }, /rate_limit/],
    ['plan_type number', { plan_type: 42 }, /plan_type/],
    ['has_credits text', { credits: { has_credits: 'yes' } }, /has_credits/],
    ['balance text', { credits: { balance: 'plenty' } }, /balance/],
    ['credits array', { credits: [] }, /credits/],
  ] as Array<[string, unknown, RegExp]>)('throws on malformed input: %s', (_name, body, message) => {
    expect(() => projectCodexUsageResponse(body as CodexUsageResponse, new Date('2026-06-05T00:00:00.000Z'))).toThrow(message);
  });
});

describe('fetchCodexUsage', () => {
  test('sends the bearer and account header to the WHAM usage path', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ plan_type: 'plus' }));
    const body = await fetchCodexUsage({ accessToken: 'at_test', accountId: 'acc_test', fetcher: testFetcher });
    expect(body).toEqual({ plan_type: 'plus' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(url).toBe(usageUrl);
    expect(init?.method).toBe('GET');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer at_test');
    expect(headers.get('chatgpt-account-id')).toBe('acc_test');
  });

  test('omits the account header for credentials without an account ID', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}));
    await fetchCodexUsage({ accessToken: 'at_test', accountId: null, fetcher: testFetcher });
    expect(new Headers(fetchSpy.mock.calls[0][1]?.headers).has('chatgpt-account-id')).toBe(false);
  });

  test('names a rejected bearer instead of returning the generic status line', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('expired', { status: 401 }));
    await expect(fetchCodexUsage({ accessToken: 'at_test', accountId, fetcher: testFetcher }))
      .rejects.toThrow(/rejected the access token \(401\)/);
  });

  test('throws on other non-2xx responses without parsing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('slow down', { status: 429 }));
    await expect(fetchCodexUsage({ accessToken: 'at_test', accountId, fetcher: testFetcher }))
      .rejects.toThrow(/returned 429/);
  });

  test.each([
    ['non-JSON', 'not json', /non-JSON/],
    ['array', '[1, 2]', /non-object/],
    ['scalar', '"str"', /non-object/],
    ['null', 'null', /non-object/],
  ])('throws on %s bodies', async (_name, raw, message) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(raw, { status: 200 }));
    await expect(fetchCodexUsage({ accessToken: 'at_test', accountId, fetcher: testFetcher })).rejects.toThrow(message);
  });
});

describe('isCodexUsageProbeDue', () => {
  test('is due when never attempted, including legacy rows without the probe keys', () => {
    expect(isCodexUsageProbeDue(readCodexUpstreamState(current!.state), Date.now())).toBe(true);
    const { usageProbeAttemptedAt: _attempted, usageProbeError: _error, ...legacy } = baseAccount;
    expect(isCodexUsageProbeDue(readCodexUpstreamState({ accounts: [legacy] }), Date.now())).toBe(true);
  });

  test.each([
    ['at the bound', CODEX_USAGE_PROBE_MIN_INTERVAL_MS, true],
    ['above the bound', CODEX_USAGE_PROBE_MIN_INTERVAL_MS + 1, true],
    ['below the bound', CODEX_USAGE_PROBE_MIN_INTERVAL_MS - 1, false],
    ['just attempted', 0, false],
  ])('debounces the probe %s', (_name, age, expected) => {
    const now = 1_800_000_000_000;
    const state = readCodexUpstreamState({
      accounts: [{ ...baseAccount, usageProbeAttemptedAt: now - age, usageProbeError: null }],
    });
    expect(isCodexUsageProbeDue(state, now)).toBe(expected);
  });

  test('stays debounced after a failure until the bound passes', () => {
    const now = 1_800_000_000_000;
    const failed = (attemptedAt: number): CodexUpstreamState => readCodexUpstreamState({
      accounts: [{ ...baseAccount, usageProbeAttemptedAt: attemptedAt, usageProbeError: 'boom' }],
    });
    expect(isCodexUsageProbeDue(failed(now - 1000), now)).toBe(false);
    expect(isCodexUsageProbeDue(failed(now - CODEX_USAGE_PROBE_MIN_INTERVAL_MS), now)).toBe(true);
  });
});

describe('refreshCodexUsageProbe', () => {
  const usageBody = {
    plan_type: 'plus',
    rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: 1780272000 } },
  };

  test('projects the live reading into the quota slot and clears the probe error', async () => {
    current = makeRecord({
      accounts: [{
        ...baseAccount,
        accessToken: { ...liveAccessToken },
        usageProbeAttemptedAt: 1,
        usageProbeError: 'previous failure',
      }],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(usageBody));
    const before = Date.now();

    const snapshot = await refreshCodexUsageProbe(upstreamId, { fetcher: testFetcher });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(usageUrl);
    expect(snapshot).toMatchObject({ plan_type: 'plus', primary_used_percent: 42, primary_window_minutes: 300 });
    const account = accountState().accounts[0];
    expect(account.quotaSnapshot?.unknown.data).toMatchObject({ plan_type: 'plus', primary_used_percent: 42 });
    expect(account.usageProbeAttemptedAt).toBeGreaterThanOrEqual(before);
    expect(account.usageProbeError).toBeNull();
    // One write for the quota reading, one for the probe outcome.
    expect(repo.writes).toHaveLength(2);
  });

  test('returns null without touching quota when the body reports nothing', async () => {
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: { ...liveAccessToken } }] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}));

    const snapshot = await refreshCodexUsageProbe(upstreamId, { fetcher: testFetcher });

    expect(snapshot).toBeNull();
    const account = accountState().accounts[0];
    expect(account.quotaSnapshot).toBeNull();
    expect(typeof account.usageProbeAttemptedAt).toBe('number');
    expect(account.usageProbeError).toBeNull();
    expect(repo.writes).toHaveLength(1);
  });

  test('persists the failure and advances the attempt on a non-2xx response', async () => {
    current = makeRecord({
      accounts: [{ ...baseAccount, accessToken: { ...liveAccessToken }, usageProbeAttemptedAt: 1 }],
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('slow down', { status: 500 }));

    await expect(refreshCodexUsageProbe(upstreamId, { fetcher: testFetcher })).rejects.toThrow(/returned 500/);
    const account = accountState().accounts[0];
    expect(account.usageProbeError).toMatch(/returned 500/);
    expect(account.usageProbeAttemptedAt).toBeGreaterThan(1);
    expect(account.quotaSnapshot).toBeNull();
  });

  test('persists malformed bodies as probe errors and rethrows', async () => {
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: { ...liveAccessToken } }] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[1, 2]', { status: 200 }));

    await expect(refreshCodexUsageProbe(upstreamId, { fetcher: testFetcher })).rejects.toThrow(/non-object/);
    expect(accountState().accounts[0].usageProbeError).toMatch(/non-object/);
  });

  test('persists terminal credential failures without flipping account state', async () => {
    // Access-only with no usable bearer: nothing to mint from, so the ensure
    // fails before any upstream call.
    current = makeRecord({ accounts: [{ ...baseAccount, refresh_token: null, accessToken: null }] });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(refreshCodexUsageProbe(upstreamId, { fetcher: testFetcher })).rejects.toThrow(/re-import/);
    const account = accountState().accounts[0];
    expect(account.usageProbeError).toMatch(/re-import/);
    expect(typeof account.usageProbeAttemptedAt).toBe('number');
    // The probe records its own signal; terminal transitions stay owned by
    // the data plane and the operator refresh path.
    expect(account.state).toBe('active');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('is a no-op on a terminal credential: no call, no write', async () => {
    current = makeRecord({
      accounts: [{
        ...baseAccount,
        state: 'refresh_failed',
        state_message: 'refresh_token is revoked',
      }],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(refreshCodexUsageProbe(upstreamId, { fetcher: testFetcher })).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(repo.writes).toEqual([]);
    const account = accountState().accounts[0];
    expect(account.usageProbeAttemptedAt).toBeNull();
    expect(account.usageProbeError).toBeNull();
  });

  test('throws when the upstream row is gone', async () => {
    current = null;
    await expect(refreshCodexUsageProbe(upstreamId, { fetcher: testFetcher })).rejects.toThrow(/not found/);
    expect(repo.writes).toEqual([]);
  });
});

describe('probe state boundary', () => {
  test('normalizes absent probe keys to null and accepts populated ones', () => {
    const { usageProbeAttemptedAt: _attempted, usageProbeError: _error, ...legacy } = baseAccount;
    const normalized = readCodexUpstreamState({ accounts: [legacy] });
    expect(normalized.accounts[0].usageProbeAttemptedAt).toBeNull();
    expect(normalized.accounts[0].usageProbeError).toBeNull();
    const populated = readCodexUpstreamState({
      accounts: [{ ...baseAccount, usageProbeAttemptedAt: 123, usageProbeError: 'boom' }],
    });
    expect(populated.accounts[0].usageProbeAttemptedAt).toBe(123);
    expect(populated.accounts[0].usageProbeError).toBe('boom');
  });

  test('rejects malformed probe keys', () => {
    expect(() => readCodexUpstreamState({
      accounts: [{ ...baseAccount, usageProbeAttemptedAt: 'soon' }],
    })).toThrow(/usageProbeAttemptedAt/);
    expect(() => readCodexUpstreamState({
      accounts: [{ ...baseAccount, usageProbeError: 42 }],
    })).toThrow(/usageProbeError/);
  });
});
