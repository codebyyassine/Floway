import { test } from 'vitest';

import { assertOpencodeGoUpstreamRecord } from '../src/config.ts';
import { readOpencodeGoUpstreamState } from '../src/state.ts';
import {
  OPENCODE_GO_USAGE_PROBE_MIN_INTERVAL_MS,
  fetchOpencodeGoUsageProbe,
  isOpencodeGoUsageEnabled,
  refreshOpencodeGoUsageProbe,
  scheduleOpencodeGoUsageProbe,
} from '../src/usage-probe.ts';
import { directFetcher, initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertRejects, withMockedFetch } from '@floway-dev/test-utils';

const UPSTREAM_ID = 'up_opencode_go_usage';

const keyedRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: UPSTREAM_ID,
  kind: 'opencode-go',
  name: 'OpenCode Go',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  config: { baseUrl: 'https://opencode.ai/zen/go', apiKey: 'opencode_go_test', models: [] },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  ...overrides,
});

// The upstream's quota shape: three windows, each with a status, a 0..100
// percent, and a reset timestamp.
const USAGE_BODY = {
  usage: {
    rolling: { status: 'ok', percent: 4, resetsAt: '2026-08-13T16:27:38.287Z' },
    weekly: { status: 'ok', percent: 3, resetsAt: '2026-08-17T00:00:00.287Z' },
    monthly: { status: 'ok', percent: 1, resetsAt: '2026-09-13T06:06:01.287Z' },
  },
};

// Installs a repo whose single row starts from `state` and records every write.
const withStateRepo = (state: unknown = null) => {
  let current = state;
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => ({ ...keyedRecord(), state: current }),
      saveState: async (_id, mutate) => {
        current = mutate(current);
      },
    },
  }));
  return { read: () => readOpencodeGoUpstreamState(current) };
};

test('the usage probe reads the quota endpoint with the upstream API key', async () => {
  const { config } = assertOpencodeGoUpstreamRecord(keyedRecord());
  await withMockedFetch(
    request => {
      assertEquals(request.url, 'https://opencode.ai/zen/go/v1/usage');
      assertEquals(request.method, 'GET');
      assertEquals(request.headers.get('authorization'), 'Bearer opencode_go_test');
      return new Response(JSON.stringify(USAGE_BODY), { status: 200 });
    },
    async () => {
      const observation = await fetchOpencodeGoUsageProbe(config, directFetcher);
      assertEquals(observation.data, USAGE_BODY);
    },
  );
});

test('the stored percent is the upstream 0..100 value, never rescaled', async () => {
  const { config } = assertOpencodeGoUpstreamRecord(keyedRecord());
  const repo = withStateRepo();
  await withMockedFetch(
    () => new Response(JSON.stringify(USAGE_BODY), { status: 200 }),
    () => refreshOpencodeGoUsageProbe(UPSTREAM_ID, config, directFetcher),
  );
  // The Ollama windows beside this one report a 0..1 fraction; this endpoint
  // reports 0..100. Dividing here would understate every window a hundredfold,
  // so the stored body must carry the upstream's own numbers.
  const stored = repo.read().usageProbe?.observation?.data as typeof USAGE_BODY;
  assertEquals(stored.usage.rolling.percent, 4);
  assertEquals(stored.usage.weekly.percent, 3);
  assertEquals(stored.usage.monthly.percent, 1);
});

test('a rate-limited window is retained as a spent reading, not dropped', async () => {
  const { config } = assertOpencodeGoUpstreamRecord(keyedRecord());
  const repo = withStateRepo();
  const spent = {
    usage: {
      ...USAGE_BODY.usage,
      weekly: { status: 'rate-limited', percent: 100, resetsAt: '2026-08-17T00:00:00.287Z' },
    },
  };
  await withMockedFetch(
    () => new Response(JSON.stringify(spent), { status: 200 }),
    () => refreshOpencodeGoUsageProbe(UPSTREAM_ID, config, directFetcher),
  );
  // A status other than `ok` means the window is exhausted. Keeping the reading
  // lets the dashboard name the spent window; dropping it would show a gap.
  assertEquals(repo.read().usageProbe?.observation?.data, spent);
});

test('either reset field naming is stored verbatim', async () => {
  const { config } = assertOpencodeGoUpstreamRecord(keyedRecord());
  const repo = withStateRepo();
  const resetInSec = {
    usage: {
      rolling: { status: 'ok', percent: 4, resetInSec: 3600 },
      weekly: { status: 'ok', percent: 3, resetInSec: 86400 },
      monthly: { status: 'ok', percent: 1, resetInSec: 2_592_000 },
    },
  };
  await withMockedFetch(
    () => new Response(JSON.stringify(resetInSec), { status: 200 }),
    () => refreshOpencodeGoUsageProbe(UPSTREAM_ID, config, directFetcher),
  );
  assertEquals(repo.read().usageProbe?.observation?.data, resetInSec);
});

test('a probe failure keeps the last reading and records the error', async () => {
  const { config } = assertOpencodeGoUpstreamRecord(keyedRecord());
  const repo = withStateRepo();

  await withMockedFetch(
    () => new Response(JSON.stringify(USAGE_BODY), { status: 200 }),
    () => refreshOpencodeGoUsageProbe(UPSTREAM_ID, config, directFetcher),
  );
  const observed = repo.read().usageProbe?.observation;
  assertEquals(observed?.data, USAGE_BODY);

  await withMockedFetch(
    () => new Response('{"error":"invalid api key"}', { status: 401 }),
    async () => {
      await assertRejects(() => refreshOpencodeGoUsageProbe(UPSTREAM_ID, config, directFetcher));
    },
  );
  const after = repo.read().usageProbe;
  assertEquals(after?.observation, observed);
  assertEquals(after?.error, 'OpenCode Go /v1/usage rejected the API key (401): {"error":"invalid api key"}');
});

test('a key without a Go subscription names the missing subscription', async () => {
  const { config } = assertOpencodeGoUpstreamRecord(keyedRecord());
  await withMockedFetch(
    () => new Response('{"error":"no subscription"}', { status: 403 }),
    async () => {
      const error = await assertRejects(() => fetchOpencodeGoUsageProbe(config, directFetcher));
      assertEquals(error.message, 'OpenCode Go /v1/usage: the API key has no Go subscription (403): {"error":"no subscription"}');
    },
  );
});

test('usage is probed when a key is configured, and not otherwise', () => {
  const enabled = (config: Record<string, unknown>) =>
    isOpencodeGoUsageEnabled(assertOpencodeGoUpstreamRecord(keyedRecord({ config })).config);

  assertEquals(enabled({ baseUrl: 'https://opencode.ai/zen/go', apiKey: 'k', models: [] }), true);
  // No key to authenticate the read with. There is no separate toggle: every
  // OpenCode Go upstream is a subscription account, so the key is the gate.
  assertEquals(enabled({ baseUrl: 'https://opencode.ai/zen/go', models: [] }), false);
});

test('the probe polls sparingly behind a five-minute interval', () => {
  // The endpoint is an unmemoized multi-table join per call, so the debounce
  // is five times the minute-wide cadence the Ollama windows beside it use.
  assertEquals(OPENCODE_GO_USAGE_PROBE_MIN_INTERVAL_MS, 5 * 60_000);
});

test('the scheduler probes once, then debounces on the stored attempt time', async () => {
  const { config } = assertOpencodeGoUpstreamRecord(keyedRecord());
  withStateRepo();
  const pending: Promise<unknown>[] = [];
  const waitUntil = (promise: Promise<unknown>) => { pending.push(promise); };
  let probes = 0;
  const handler = () => {
    probes++;
    return new Response(JSON.stringify(USAGE_BODY), { status: 200 });
  };

  await withMockedFetch(handler, async () => {
    scheduleOpencodeGoUsageProbe(UPSTREAM_ID, config, readOpencodeGoUpstreamState(null), directFetcher, waitUntil);
    await Promise.all(pending);
  });
  assertEquals(probes, 1);

  const justProbed = { usageProbe: { attemptedAt: Date.now(), observation: null, error: null } };
  await withMockedFetch(handler, async () => {
    scheduleOpencodeGoUsageProbe(UPSTREAM_ID, config, readOpencodeGoUpstreamState(justProbed), directFetcher, waitUntil);
    await Promise.all(pending);
  });
  assertEquals(probes, 1);

  const stale = { usageProbe: { attemptedAt: Date.now() - OPENCODE_GO_USAGE_PROBE_MIN_INTERVAL_MS, observation: null, error: null } };
  await withMockedFetch(handler, async () => {
    scheduleOpencodeGoUsageProbe(UPSTREAM_ID, config, readOpencodeGoUpstreamState(stale), directFetcher, waitUntil);
    await Promise.all(pending);
  });
  assertEquals(probes, 2);
});
