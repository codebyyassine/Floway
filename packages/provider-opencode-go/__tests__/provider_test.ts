import { test } from 'vitest';

import { createOpencodeGoProvider } from '../src/provider.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, noopAnthropicMessagesUpstreamCallOptions, noopUpstreamCallOptions, sseResponse, testFetcher, withMockedFetch } from '@floway-dev/test-utils';

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

const modelsBody = {
  object: 'list',
  data: [
    { id: 'grok-4.7', object: 'model' },
    { id: 'minimax-m3', object: 'model' },
    { id: 'kimi-k3', object: 'model' },
    { id: 'future-model-unknown', object: 'model' },
  ],
};

const respond = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname.endsWith('/v1/models')) return jsonResponse(modelsBody);
  return new Response('unexpected', { status: 500 });
};

test('getProvidedModels selects the per-model wire from the Floway OpenCode Go snapshot', async () => {
  const instance = createOpencodeGoProvider(buildRecord());
  await withMockedFetch(respond, async () => {
    const models = await instance.instance.getProvidedModels(testFetcher);
    assertEquals(models.map(m => m.id), ['grok-4.7', 'minimax-m3', 'kimi-k3']);

    const grok = models.find(m => m.id === 'grok-4.7')!;
    assertEquals(grok.kind, 'chat');
    assertEquals(Object.keys(grok.endpoints), ['openaiResponses']);
    assertEquals(grok.opaqueBlobCompatibilityScope, { bindToUpstream: true });

    const minimax = models.find(m => m.id === 'minimax-m3')!;
    assertEquals(Object.keys(minimax.endpoints), ['anthropicMessages']);

    const kimi = models.find(m => m.id === 'kimi-k3')!;
    assertEquals(Object.keys(kimi.endpoints), ['openaiChatCompletions']);
  });
});

test('getProvidedModels merges snapshot metadata, generated registry pricing, and reasoning presets', async () => {
  const instance = createOpencodeGoProvider(buildRecord());
  await withMockedFetch(respond, async () => {
    const models = await instance.instance.getProvidedModels(testFetcher);
    const grok = models.find(m => m.id === 'grok-4.7')!;
    // Snapshot limits and display name flow through.
    assertEquals(grok.display_name, 'Grok 4.7');
    assertEquals(grok.limits.max_context_window_tokens, 500000);
    assertEquals(grok.limits.max_output_tokens, 500000);
    assertEquals(grok.chat?.modalities, { input: ['text', 'image'], output: ['text'] });
    // Generated registry pricing wins over the snapshot's own pricing.
    assertEquals(grok.pricing?.entries[0]?.rates.input_tokens, '0.000002');
    assertEquals(grok.pricing?.entries.length, 2);
    // Effort presets come from the generated capabilities table.
    assertEquals(grok.chat?.reasoning?.effort?.supported, ['low', 'medium', 'high', 'xhigh']);
    assertEquals(grok.chat?.reasoning?.effort?.default, 'high');
  });
});

test('getProvidedModels surfaces toggle-only registry reasoning as adaptive', async () => {
  const instance = createOpencodeGoProvider(buildRecord());
  await withMockedFetch(respond, async () => {
    const models = await instance.instance.getProvidedModels(testFetcher);
    const minimax = models.find(m => m.id === 'minimax-m3')!;
    assertEquals(minimax.chat?.reasoning, { adaptive: true });
  });
});

test('getProvidedModels never emits registry rows with no live counterpart', async () => {
  const instance = createOpencodeGoProvider(buildRecord());
  await withMockedFetch(respond, async () => {
    const models = await instance.instance.getProvidedModels(testFetcher);
    // space-bunny-free lingers in the registry but is not served upstream.
    assertEquals(models.some(m => m.id === 'space-bunny-free'), false);
  });
});

test('getProvidedModels refuses upstream ids absent from the snapshot', async () => {
  const instance = createOpencodeGoProvider(buildRecord());
  await withMockedFetch(respond, async () => {
    const models = await instance.instance.getProvidedModels(testFetcher);
    // future-model-unknown is live upstream but has no registry metadata, so
    // it is filtered out rather than emitted on a fallback wire. Manual
    // `config.models[]` entries still let operators opt such ids in.
    assertEquals(models.some(m => m.id === 'future-model-unknown'), false);
    assertEquals(models.map(m => m.id), ['grok-4.7', 'minimax-m3', 'kimi-k3']);
  });
});

test('getProvidedModels merges manual overrides in front of auto-fetched models and drops the auto duplicate', async () => {
  const instance = createOpencodeGoProvider(buildRecord({
    config: {
      baseUrl: 'https://opencode.ai/zen/go',
      apiKey: 'opencode_go_test',
      models: [{
        upstreamModelId: 'kimi-k3',
        kind: 'chat',
        endpoints: { openaiChatCompletions: {} },
        display_name: 'Pinned K3',
        pricing: { entries: [{ rates: { input_tokens: '99', output_tokens: '99' } }] },
      }],
    },
  } as Partial<UpstreamRecord>));
  await withMockedFetch(respond, async () => {
    const models = await instance.instance.getProvidedModels(testFetcher);
    assertEquals(models[0].id, 'kimi-k3');
    assertEquals(models[0].display_name, 'Pinned K3');
    assertEquals(models[0].pricing, { entries: [{ rates: { input_tokens: '99', output_tokens: '99' } }] });
    assertEquals(models.filter(m => m.id === 'kimi-k3').length, 1);
  });
});

test('getProvidedModels still emits manual entries for ids absent from the snapshot', async () => {
  const instance = createOpencodeGoProvider(buildRecord({
    config: {
      baseUrl: 'https://opencode.ai/zen/go',
      apiKey: 'opencode_go_test',
      models: [{
        upstreamModelId: 'future-model-unknown',
        kind: 'chat',
        endpoints: { openaiChatCompletions: {} },
        display_name: 'Pinned Unknown',
      }],
    },
  } as Partial<UpstreamRecord>));
  await withMockedFetch(respond, async () => {
    const models = await instance.instance.getProvidedModels(testFetcher);
    // The manual entry is the operator's explicit choice: it emits ahead of
    // the auto rows even though the auto path refuses the same id.
    assertEquals(models[0].id, 'future-model-unknown');
    assertEquals(models[0].display_name, 'Pinned Unknown');
    assertEquals(models.filter(m => m.id === 'future-model-unknown').length, 1);
  });
});

test('callOpenAIChatCompletions POSTs to /v1/chat/completions with the upstream model id and Bearer header', async () => {
  const instance = createOpencodeGoProvider(buildRecord());
  let chatRequest: Request | null = null;
  let chatBody: unknown = null;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/v1/models')) return jsonResponse(modelsBody);
      if (url.pathname.endsWith('/v1/chat/completions')) {
        chatRequest = request;
        chatBody = await request.json();
        return sseResponse();
      }
      return new Response('unexpected', { status: 500 });
    },
    async () => {
      const models = await instance.instance.getProvidedModels(testFetcher);
      const kimi = models.find(m => m.id === 'kimi-k3')!;
      const result = await instance.instance.callOpenAIChatCompletions(
        kimi,
        { messages: [{ role: 'user', content: 'hi' }] },
        undefined,
        noopUpstreamCallOptions(),
      );
      assertEquals(result.modelKey, 'kimi-k3');
    },
  );

  assertEquals(chatRequest!.url, 'https://opencode.ai/zen/go/v1/chat/completions');
  assertEquals(chatRequest!.headers.get('Authorization'), 'Bearer opencode_go_test');
  const body = chatBody as { model: string; stream: boolean };
  assertEquals(body.model, 'kimi-k3');
  assertEquals(body.stream, true);
});

test('Anthropic Messages methods serialize typed anthropic-beta metadata only on Anthropic Messages wire calls', async () => {
  const instance = createOpencodeGoProvider(buildRecord());
  const betas: Record<string, string | null> = {};

  await withMockedFetch(
    async request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/v1/models')) return jsonResponse(modelsBody);
      if (path.endsWith('/v1/messages/count_tokens')) {
        betas['/v1/messages/count_tokens'] = request.headers.get('anthropic-beta');
        return jsonResponse({ input_tokens: 1 });
      }
      if (path.endsWith('/v1/messages')) {
        betas['/v1/messages'] = request.headers.get('anthropic-beta');
        return sseResponse();
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await instance.instance.getProvidedModels(testFetcher);
      const minimax = models.find(m => m.id === 'minimax-m3')!;
      const opts = noopAnthropicMessagesUpstreamCallOptions({ anthropicBeta: ['context-1m'] });
      await instance.instance.callAnthropicMessages(minimax, { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, undefined, opts);
      await instance.instance.callAnthropicMessagesCountTokens(minimax, { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, undefined, opts);
    },
  );

  assertEquals(betas, {
    '/v1/messages': 'context-1m',
    '/v1/messages/count_tokens': 'context-1m',
  });
});
