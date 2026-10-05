import { test } from 'vitest';

import { parseOpencodeGoUpstreamConfig } from '../src/config.ts';
import { createOpencodeGoProvider } from '../src/provider.ts';
import { emptyOpencodeGoUpstreamState } from '../src/state.ts';
import { fetchOpencodeGoUsageProbe } from '../src/usage-probe.ts';
import type { ProviderModel, UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, noopAnthropicMessagesUpstreamCallOptions, noopUpstreamCallOptions, sseResponse, testFetcher, withMockedFetch } from '@floway-dev/test-utils';

// The probe is armed from the data plane, not only from the operator's refresh
// press: every metered call moves the vendor's 5-hour, weekly and monthly
// windows, so a dashboard that only refreshed on demand would sit stale exactly
// while an operator is watching it. `waitUntil` is the seam the runtime hands
// us for background work, so asserting on it observes the arming itself rather
// than the state it eventually writes.

const buildRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_opencode_go',
  kind: 'opencode-go',
  name: 'OpenCode Go',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-19T00:00:00.000Z',
  config: { baseUrl: 'https://opencode.ai/zen/go', apiKey: 'opencode_go_test' },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  ...overrides,
} as UpstreamRecord);

const usageBody = {
  usage: {
    rolling: { status: 'ok', percent: 4, resetsAt: '2026-08-13T16:27:38.287Z' },
    weekly: { status: 'ok', percent: 3, resetsAt: '2026-08-17T00:00:00.287Z' },
    monthly: { status: 'ok', percent: 1, resetsAt: '2026-09-13T06:06:01.287Z' },
  },
};

const manualModel = (): ProviderModel => ({
  id: 'kimi-k3',
  upstreamModelId: 'kimi-k3',
  kind: 'chat',
  limits: {},
  endpoints: { openaiChatCompletions: {} },
  providerData: 'kimi-k3',
  enabledFlags: new Set(),
  opaqueBlobCompatibilityScope: { bindToUpstream: true },
});

const armCounter = () => {
  const state = { armed: 0 };
  return { state, waitUntil: () => { state.armed += 1; } };
};

test('a dispatched chat completion arms a background usage refresh', async () => {
  const paths: string[] = [];
  const respond = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    paths.push(url.pathname);
    if (url.pathname.endsWith('/v1/models')) {
      return jsonResponse({ object: 'list', data: [{ id: 'kimi-k3', object: 'model' }] });
    }
    if (url.pathname.endsWith('/v1/usage')) return jsonResponse(usageBody);
    return sseResponse('data: {"choices":[]}\n\n');
  };

  const instance = createOpencodeGoProvider(buildRecord());
  await withMockedFetch(respond, async () => {
    const { state, waitUntil } = armCounter();
    await instance.instance.callOpenAIChatCompletions!(
      manualModel(),
      { messages: [] },
      undefined,
      noopUpstreamCallOptions({ waitUntil }),
    );
    assertEquals(state.armed, 1);
  });
});

test('a rate-limited response still arms, since that is when the windows matter', async () => {
  const respond = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/v1/usage')) return jsonResponse(usageBody);
    return new Response('rate limited', { status: 429 });
  };

  const instance = createOpencodeGoProvider(buildRecord());
  await withMockedFetch(respond, async () => {
    const { state, waitUntil } = armCounter();
    await instance.instance.callOpenAIChatCompletions!(
      manualModel(),
      { messages: [] },
      undefined,
      noopUpstreamCallOptions({ waitUntil }),
    );
    assertEquals(state.armed, 1);
  });
});

test('token counting arms no refresh, because it reaches no model', async () => {
  const respond = async (): Promise<Response> => jsonResponse({ input_tokens: 12 });

  const instance = createOpencodeGoProvider(buildRecord());
  await withMockedFetch(respond, async () => {
    const { state, waitUntil } = armCounter();
    await instance.instance.callAnthropicMessagesCountTokens!(
      manualModel(),
      { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      noopAnthropicMessagesUpstreamCallOptions({ waitUntil }),
    );
    assertEquals(state.armed, 0);
  });
});

test('a transport failure arms nothing, because the account was never reached', async () => {
  const instance = createOpencodeGoProvider(buildRecord());
  await withMockedFetch(() => { throw new Error('network down'); }, async () => {
    const { state, waitUntil } = armCounter();
    await instance.instance.callOpenAIChatCompletions!(
      manualModel(),
      { messages: [] },
      undefined,
      noopUpstreamCallOptions({ waitUntil }),
    ).catch(() => undefined);
    assertEquals(state.armed, 0);
  });
});

test('the probe reads the vendor endpoint with the bearer and keeps the body verbatim', async () => {
  const seen: Request[] = [];
  const respond = async (request: Request): Promise<Response> => {
    seen.push(request);
    return jsonResponse(usageBody);
  };
  const config = parseOpencodeGoUpstreamConfig({ baseUrl: 'https://opencode.ai/zen/go', apiKey: 'opencode_go_test' });
  await withMockedFetch(respond, async () => {
    const observation = await fetchOpencodeGoUsageProbe(config, testFetcher);
    // Verbatim, not normalised: the endpoint is undocumented and has already
    // varied its field naming, so the dashboard is what walks known keys.
    assertEquals(observation.data, usageBody);
    assertEquals(seen[0]?.url, 'https://opencode.ai/zen/go/v1/usage');
    assertEquals(seen[0]?.headers.get('authorization'), 'Bearer opencode_go_test');
  });
});

test('an upstream with no observation yet reads as no probe at all', () => {
  assertEquals(emptyOpencodeGoUpstreamState(), { usageProbe: null });
});
