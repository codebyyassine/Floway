import { test } from 'vitest';

import { blueprintUpstreamRecord, upstreamRecordToFullJson } from '../../../src/control-plane/upstreams/serialize.ts';
import type { StoredUpstreamRecord } from '../../../src/repo/types.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { MOCKED_FETCH_EGRESS, requestApp, setupAppTest } from '../../test-utils/app.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

type JsonObject = Record<string, any>;

const OPENCODE_GO_API_KEY = 'og_test_key';

const opencodeGoConfig = {
  baseUrl: 'https://opencode.ai/zen/go',
  apiKey: OPENCODE_GO_API_KEY,
  models: [],
};

// The upstream-owned usage body from the verified contract: three windows,
// percents already 0..100, reset as an ISO timestamp.
const sampleOpencodeGoUsageBody = {
  usage: {
    rolling: { status: 'ok', percent: 4, resetsAt: '2026-08-13T16:27:38.287Z' },
    weekly: { status: 'ok', percent: 3, resetsAt: '2026-08-17T00:00:00.287Z' },
    monthly: { status: 'ok', percent: 1, resetsAt: '2026-09-13T06:06:01.287Z' },
  },
};

const buildOpencodeGoUpstreamRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => {
  const { config: overrideConfig, ...rest } = overrides;
  return {
    id: 'up_opencode_go',
    kind: 'opencode-go',
    name: 'OpenCode Go',
    enabled: true,
    sortOrder: 300,
    createdAt: '2026-03-15T00:00:00.000Z',
    updatedAt: '2026-03-15T00:00:00.000Z',
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: MOCKED_FETCH_EGRESS,
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    ...rest,
    config: overrideConfig ?? opencodeGoConfig,
  };
};

const envelopeFromRecord = (record: UpstreamRecord): Record<string, unknown> => upstreamRecordToFullJson(record) as unknown as Record<string, unknown>;

const getRecord = async (repo: { upstreams: { getById: (id: string) => Promise<StoredUpstreamRecord | null> } }, id: string): Promise<StoredUpstreamRecord> => {
  const record = await repo.upstreams.getById(id);
  if (!record) throw new Error(`Expected upstream ${id} to exist`);
  return record;
};

const authed = (adminSession: string, body?: unknown): RequestInit => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: {
    'content-type': 'application/json',
    'x-floway-session': adminSession,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

// The mock answers whatever usage-shaped path the provider probes so the test
// stays bound to the endpoint contract (GET {baseUrl}/v1/usage with a bearer
// key) rather than to the provider's URL-join spelling.
const mockOpencodeGoUsage = (handler: (request: Request) => Response): ((request: Request) => Promise<Response>) => {
  return async (request: Request) => {
    if (request.url.includes('/v1/usage')) {
      assertEquals(request.headers.get('authorization'), `Bearer ${OPENCODE_GO_API_KEY}`);
      return handler(request);
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  };
};

test('POST /api/upstreams/opencode-go/usage probes the account and persists the observation into upstream state', async () => {
  const { repo, adminSession } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, buildOpencodeGoUpstreamRecord());
  const envelope = envelopeFromRecord(await getRecord(repo, 'up_opencode_go'));

  await withMockedFetch(
    mockOpencodeGoUsage(() => jsonResponse(sampleOpencodeGoUsageBody)),
    async () => {
      const resp = await requestApp('/api/upstreams/opencode-go/usage', authed(adminSession, { record: envelope }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { observation: JsonObject };
      assertEquals(typeof body.observation, 'object');
    },
  );

  // The refresh writes the row's state slot through the same compare-and-swap
  // path the data plane will use, so the dashboard reads one snapshot.
  const stored = await repo.upstreams.getById('up_opencode_go');
  assertEquals(stored?.state !== null, true);
});

test('POST /api/upstreams/opencode-go/usage probes a draft without persisting a row', async () => {
  const { repo, adminSession } = await setupAppTest();
  const draft = {
    ...blueprintUpstreamRecord('opencode-go'),
    proxy_fallback_list: MOCKED_FETCH_EGRESS,
    config: { ...opencodeGoConfig },
  };

  await withMockedFetch(
    mockOpencodeGoUsage(() => jsonResponse(sampleOpencodeGoUsageBody)),
    async () => {
      const resp = await requestApp('/api/upstreams/opencode-go/usage', authed(adminSession, { record: draft }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { observation: JsonObject };
      assertEquals(typeof body.observation, 'object');
    },
  );

  assertEquals(await repo.upstreams.getById(''), null);
});

test('POST /api/upstreams/opencode-go/usage rejects a record missing its API key with 400', async () => {
  const { adminSession } = await setupAppTest();
  // The blueprint carries apiKey: '' — the handler's presence check rejects
  // with 400 before any upstream call.
  const draft = {
    ...blueprintUpstreamRecord('opencode-go'),
    proxy_fallback_list: MOCKED_FETCH_EGRESS,
  };
  const resp = await requestApp('/api/upstreams/opencode-go/usage', authed(adminSession, { record: draft }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('api key'), true);
});

test('POST /api/upstreams/opencode-go/usage rejects a non-opencode-go record with 400', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp('/api/upstreams/opencode-go/usage', authed(adminSession, {
    record: {
      ...blueprintUpstreamRecord('custom'),
      proxy_fallback_list: MOCKED_FETCH_EGRESS,
    },
  }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('OpenCode Go'), true);
});

test('POST /api/upstreams/opencode-go/usage remaps an upstream 401 to 502', async () => {
  const { repo, adminSession } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, buildOpencodeGoUpstreamRecord());
  const envelope = envelopeFromRecord(await getRecord(repo, 'up_opencode_go'));

  await withMockedFetch(
    mockOpencodeGoUsage(() => jsonResponse({ error: 'invalid api key' }, 401)),
    async () => {
      const resp = await requestApp('/api/upstreams/opencode-go/usage', authed(adminSession, { record: envelope }));
      // 401 is remapped so the dashboard's auth client doesn't interpret
      // an upstream auth failure as a session logout.
      assertEquals(resp.status, 502);
    },
  );
});

test('GET /api/upstreams redacts the OpenCode Go bearer while carrying the usage observation', async () => {
  const { repo, adminSession } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, buildOpencodeGoUpstreamRecord());
  const envelope = envelopeFromRecord(await getRecord(repo, 'up_opencode_go'));

  await withMockedFetch(
    mockOpencodeGoUsage(() => jsonResponse(sampleOpencodeGoUsageBody)),
    async () => {
      const resp = await requestApp('/api/upstreams/opencode-go/usage', authed(adminSession, { record: envelope }));
      assertEquals(resp.status, 200);
    },
  );

  const list = await requestApp('/api/upstreams', { headers: { 'x-floway-session': adminSession } });
  assertEquals(list.status, 200);
  const items = (await list.json()) as JsonObject[];
  const row = items.find(item => item.id === 'up_opencode_go');
  if (!row) throw new Error('Expected the opencode-go row in the list response');
  assertEquals(row.kind, 'opencode-go');
  // The bearer stays server-only; only its presence crosses.
  assertEquals(row.config.apiKey, undefined);
  assertEquals(row.config.apiKeySet, true);
  assertEquals(row.state !== null, true);
  assertEquals(JSON.stringify(row).includes(OPENCODE_GO_API_KEY), false);
});
