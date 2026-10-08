import { afterEach, expect, test, vi } from 'vitest';

import { initRepo } from '../../src/repo/index.ts';
import { scheduleUsageProbeRefreshes } from '../../src/scheduled/usage-refresh.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import { saveUpstreamForTest } from '../repo/upstreams.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { readCodexUpstreamState } from '@floway-dev/provider-codex';
import { readOpencodeGoUpstreamState } from '@floway-dev/provider-opencode-go';
import { withMockedFetch } from '@floway-dev/test-utils';

afterEach(() => {
  vi.restoreAllMocks();
});

const TIMESTAMP = '2026-08-01T00:00:00.000Z';

const freshCodexAccount = () => ({
  chatgptAccountId: 'acc',
  refresh_token: 'rt_v1',
  state: 'active' as const,
  state_updated_at: TIMESTAMP,
  openaiDeviceId: '11111111-2222-4333-8444-555555555555',
  // A seeded access token keeps the OAuth refresh off the fetch mock's path.
  accessToken: { token: 'codex-access-token', expiresAt: Date.parse('2100-01-01T00:00:00.000Z'), refreshedAt: TIMESTAMP },
  quotaSnapshot: null,
  usageProbeAttemptedAt: null as number | null,
  usageProbeError: null as string | null,
});

const codexUpstream = (id: string, overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id,
  kind: 'codex',
  name: id,
  enabled: true,
  sortOrder: 0,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  config: {
    accounts: [{ email: `${id}@example.com`, chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'plus' }],
  },
  state: { accounts: [freshCodexAccount()] },
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [{ id: 'direct_fetch' }],
  modelsCache: null,
  modelPrefix: null,
  hue: 210,
  ...overrides,
});

const opencodeGoUpstream = (id: string, overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id,
  kind: 'opencode-go',
  name: id,
  enabled: true,
  sortOrder: 0,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  config: { baseUrl: `https://${id}.example.com`, apiKey: 'opencode_go_test', models: [] },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [{ id: 'direct_fetch' }],
  modelsCache: null,
  modelPrefix: null,
  hue: 210,
  ...overrides,
});

const customUpstream = (id: string, enabled: boolean): UpstreamRecord => ({
  id,
  kind: 'custom',
  name: id,
  enabled,
  sortOrder: 0,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  config: {
    baseUrl: `https://${id}.example.com`,
    authStyle: 'bearer',
    apiKey: 'key',
    endpoints: { openaiChatCompletions: {} },
    ingressHeadersRules: [],
  },
  state: null,
  modelsCache: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [{ id: 'direct_fetch' }],
  modelPrefix: null,
  hue: 210,
});

const CODEX_USAGE_BODY = {
  rate_limit: { primary_window: { used_percent: 42 } },
};

const OPENCODE_GO_USAGE_BODY = {
  usage: {
    rolling: { status: 'ok', percent: 4, resetsAt: '2026-08-13T16:27:38.287Z' },
    weekly: { status: 'ok', percent: 3, resetsAt: '2026-08-17T00:00:00.287Z' },
    monthly: { status: 'ok', percent: 1, resetsAt: '2026-09-13T06:06:01.287Z' },
  },
};

const recordRequests = (requested: string[]) => (request: Request): Response => {
  const url = new URL(request.url);
  requested.push(`${url.hostname}${url.pathname}`);
  if (url.hostname === 'chatgpt.com') return Response.json(CODEX_USAGE_BODY);
  return Response.json(OPENCODE_GO_USAGE_BODY);
};

test('a codex upstream with no prior probe is probed; one inside the debounce window is not', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await saveUpstreamForTest(repo.upstreams, codexUpstream('due'));
  const probedAt = Date.now();
  await saveUpstreamForTest(repo.upstreams, codexUpstream('fresh', {
    state: { accounts: [{ ...freshCodexAccount(), usageProbeAttemptedAt: probedAt }] },
  }));
  const requested: string[] = [];

  await withMockedFetch(
    recordRequests(requested),
    async () => {
      const background: Promise<unknown>[] = [];
      await scheduleUsageProbeRefreshes('TEST', promise => { background.push(promise); });
      expect(background).toHaveLength(1);
      await Promise.all(background);
    },
  );

  expect(requested).toEqual(['chatgpt.com/backend-api/wham/usage']);
  const dueState = readCodexUpstreamState((await repo.upstreams.getById('due'))?.state);
  expect(dueState.accounts[0].usageProbeError).toBeNull();
  expect(typeof dueState.accounts[0].usageProbeAttemptedAt).toBe('number');
  expect(dueState.accounts[0].quotaSnapshot?.unknown?.data).toMatchObject({ primary_used_percent: 42 });
  const freshState = readCodexUpstreamState((await repo.upstreams.getById('fresh'))?.state);
  expect(freshState.accounts[0].usageProbeAttemptedAt).toBe(probedAt);
  expect(freshState.accounts[0].quotaSnapshot).toBeNull();
});

test('an opencode-go upstream with no prior probe is probed; debounced and keyless ones are not', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await saveUpstreamForTest(repo.upstreams, opencodeGoUpstream('due'));
  await saveUpstreamForTest(repo.upstreams, opencodeGoUpstream('fresh', {
    state: { usageProbe: { attemptedAt: Date.now(), observation: null, error: null } },
  }));
  await saveUpstreamForTest(repo.upstreams, opencodeGoUpstream('keyless', {
    config: { baseUrl: 'https://keyless.example.com', models: [] },
  }));
  const requested: string[] = [];

  await withMockedFetch(
    recordRequests(requested),
    async () => {
      const background: Promise<unknown>[] = [];
      await scheduleUsageProbeRefreshes('TEST', promise => { background.push(promise); });
      expect(background).toHaveLength(1);
      await Promise.all(background);
    },
  );

  expect(requested).toEqual(['due.example.com/v1/usage']);
  const dueState = readOpencodeGoUpstreamState((await repo.upstreams.getById('due'))?.state);
  expect(dueState.usageProbe?.error).toBeNull();
  expect(dueState.usageProbe?.observation?.data).toEqual(OPENCODE_GO_USAGE_BODY);
  const freshState = readOpencodeGoUpstreamState((await repo.upstreams.getById('fresh'))?.state);
  expect(freshState.usageProbe?.observation).toBeNull();
  const keylessState = readOpencodeGoUpstreamState((await repo.upstreams.getById('keyless'))?.state);
  expect(keylessState.usageProbe).toBeNull();
});

test('upstreams of any other kind are never probed', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await saveUpstreamForTest(repo.upstreams, customUpstream('custom', true));
  const requested: string[] = [];

  await withMockedFetch(
    recordRequests(requested),
    async () => {
      const background: Promise<unknown>[] = [];
      await scheduleUsageProbeRefreshes('TEST', promise => { background.push(promise); });
      await Promise.all(background);
      expect(background).toHaveLength(0);
    },
  );

  expect(requested).toEqual([]);
});

test('disabled upstreams are skipped', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await saveUpstreamForTest(repo.upstreams, codexUpstream('codex-off', { enabled: false }));
  await saveUpstreamForTest(repo.upstreams, opencodeGoUpstream('go-off', { enabled: false }));
  const requested: string[] = [];

  await withMockedFetch(
    recordRequests(requested),
    async () => {
      const background: Promise<unknown>[] = [];
      await scheduleUsageProbeRefreshes('TEST', promise => { background.push(promise); });
      await Promise.all(background);
      expect(background).toHaveLength(0);
    },
  );

  expect(requested).toEqual([]);
});

test('locationless sweeps skip colo-scoped-only egress policies', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await saveUpstreamForTest(repo.upstreams, opencodeGoUpstream('scoped', {
    proxyFallbackList: [{ id: 'direct_fetch', colos: ['HKG'] }],
  }));
  await saveUpstreamForTest(repo.upstreams, opencodeGoUpstream('global', {
    proxyFallbackList: [{ id: 'direct_fetch' }],
  }));
  const requested: string[] = [];

  await withMockedFetch(
    recordRequests(requested),
    async () => {
      const background: Promise<unknown>[] = [];
      await scheduleUsageProbeRefreshes(null, promise => { background.push(promise); });
      expect(background).toHaveLength(1);
      await Promise.all(background);
    },
  );

  expect(requested).toEqual(['global.example.com/v1/usage']);
  expect(readOpencodeGoUpstreamState((await repo.upstreams.getById('scoped'))?.state).usageProbe).toBeNull();
});

test("one upstream's refresh rejecting does not stop the others", async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await saveUpstreamForTest(repo.upstreams, opencodeGoUpstream('bad'));
  await saveUpstreamForTest(repo.upstreams, opencodeGoUpstream('good'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const requested: string[] = [];

  try {
    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        requested.push(`${url.hostname}${url.pathname}`);
        if (url.hostname === 'bad.example.com') throw new Error('boom');
        return Response.json(OPENCODE_GO_USAGE_BODY);
      },
      async () => {
        const background: Promise<unknown>[] = [];
        await scheduleUsageProbeRefreshes('TEST', promise => { background.push(promise); });
        expect(background).toHaveLength(2);
        const settled = await Promise.allSettled(background);
        expect(settled.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
        // Assert before the finally-block restore: mockRestore clears the spy history.
        expect(error).toHaveBeenCalledTimes(1);
      },
    );
  } finally {
    error.mockRestore();
  }

  expect([...requested].sort()).toEqual(['bad.example.com/v1/usage', 'good.example.com/v1/usage']);
  const goodState = readOpencodeGoUpstreamState((await repo.upstreams.getById('good'))?.state);
  expect(goodState.usageProbe?.observation?.data).toEqual(OPENCODE_GO_USAGE_BODY);
  const badState = readOpencodeGoUpstreamState((await repo.upstreams.getById('bad'))?.state);
  expect(badState.usageProbe?.observation).toBeNull();
  expect(badState.usageProbe?.error).toContain('boom');
});

test('the fetcher is resolved once per batch', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await saveUpstreamForTest(repo.upstreams, opencodeGoUpstream('a'));
  await saveUpstreamForTest(repo.upstreams, opencodeGoUpstream('b'));
  const list = vi.spyOn(repo.upstreams, 'list');
  const requested: string[] = [];

  await withMockedFetch(
    recordRequests(requested),
    async () => {
      const background: Promise<unknown>[] = [];
      await scheduleUsageProbeRefreshes('TEST', promise => { background.push(promise); });
      expect(background).toHaveLength(2);
      await Promise.all(background);
    },
  );

  expect(list).toHaveBeenCalledTimes(1);
  expect([...requested].sort()).toEqual(['a.example.com/v1/usage', 'b.example.com/v1/usage']);
});
