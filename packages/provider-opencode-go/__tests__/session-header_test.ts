import { test } from 'vitest';

import { OPENCODE_GO_USER_AGENT } from '../src/fetch.ts';
import { createOpencodeGoProvider } from '../src/provider.ts';
import type { ProviderModel, UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, noopUpstreamCallOptions, sseResponse, withMockedFetch } from '@floway-dev/test-utils';

// OpenCode Go meters traffic that looks like a coding agent's, routes it, and
// caches on the conversation, and its guidance asks a client for two things to
// make that work: a stable conversation identifier in `x-opencode-session`, and
// a user agent that names the client rather than a generic HTTP library. Both
// are transport facts, so they are asserted on the request that actually went
// out rather than on the configuration that intends to send them.
// https://opencode.ai/docs/go/#where-can-i-use-it

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

const chatModel = (): ProviderModel => ({
  id: 'kimi-k3',
  upstreamModelId: 'kimi-k3',
  kind: 'chat',
  limits: {},
  endpoints: { openaiChatCompletions: {} },
  providerData: 'kimi-k3',
  enabledFlags: new Set(),
  opaqueBlobCompatibilityScope: { bindToUpstream: true },
});

const dispatchChat = async (headers: Headers): Promise<Request> => {
  // Scoped to the chat path on purpose: dispatching arms a background usage
  // refresh, so the last request seen is the quota read, which carries no
  // client headers of its own.
  let sent: Request | null = null;
  const respond = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/v1/chat/completions')) sent = request;
    return path.endsWith('/v1/usage')
      ? jsonResponse({ usage: {} })
      : sseResponse('data: {"choices":[]}\n\n');
  };
  const provider = createOpencodeGoProvider(buildRecord());
  await withMockedFetch(respond, async () => {
    await provider.instance.callOpenAIChatCompletions!(
      chatModel(),
      { messages: [{ role: 'user', content: 'hi' }] },
      undefined,
      noopUpstreamCallOptions({ headers }),
    );
  });
  if (sent === null) throw new Error('no chat completion request was observed');
  return sent;
};

test('the provider admits the conversation header, so the gateway forwards it', () => {
  const provider = createOpencodeGoProvider(buildRecord());
  // The gateway filters the client's request through this list before the
  // provider is called, so a header missing here is stripped, not defaulted.
  assertEquals([...provider.inboundHeaderAllowlist], ['x-opencode-session']);
});

test('a client-supplied conversation header reaches the upstream', async () => {
  const headers = new Headers({ 'x-opencode-session': 'session-abc-123' });
  const sent = await dispatchChat(headers);
  assertEquals(sent.headers.get('x-opencode-session'), 'session-abc-123');
});

test('Floway names itself rather than letting a generic HTTP agent through', async () => {
  const sent = await dispatchChat(new Headers());
  assertEquals(sent.headers.get('user-agent'), OPENCODE_GO_USER_AGENT);
  assertEquals(sent.headers.get('user-agent'), 'pi');
});

test('an explicit per-call identity still wins over the default', async () => {
  const headers = new Headers({ 'user-agent': 'claude-cli/2.0 (external, cli)' });
  const sent = await dispatchChat(headers);
  assertEquals(sent.headers.get('user-agent'), 'claude-cli/2.0 (external, cli)');
});

test('a client that sends no conversation header dispatches without one', async () => {
  // Nothing is fabricated: a made-up id would be attributed to the operator's
  // traffic and would defeat the routing it is meant to improve.
  const sent = await dispatchChat(new Headers());
  assertEquals(sent.headers.get('x-opencode-session'), null);
});

test('the bearer is still sent alongside the conversation header', async () => {
  const sent = await dispatchChat(new Headers({ 'x-opencode-session': 'session-abc-123' }));
  assertEquals(sent.headers.get('authorization'), 'Bearer opencode_go_test');
});
