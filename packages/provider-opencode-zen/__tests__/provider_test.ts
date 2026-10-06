import { test } from 'vitest';

import { createOpencodeZenProvider } from '../src/provider.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, noopAnthropicMessagesUpstreamCallOptions, noopUpstreamCallOptions, sseResponse, testFetcher, withMockedFetch } from '@floway-dev/test-utils';

const buildRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_opencode',
  kind: 'opencode',
  name: 'OpenCode Zen',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-19T00:00:00.000Z',
  config: { baseUrl: 'https://opencode.ai/zen', apiKey: 'opencode_test' },
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
    { id: 'gpt-5.5', object: 'model' },
    { id: 'qwen3.8-max', object: 'model' },
    { id: 'kimi-k3', object: 'model' },
    { id: 'claude-sonnet-4', object: 'model' },
    { id: 'future-model-unknown', object: 'model' },
  ],
};

const respond = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname.endsWith('/v1/models')) return jsonResponse(modelsBody);
  return new Response('unexpected', { status: 500 });
};

test('getProvidedModels selects the per-model wire from the Floway OpenCode Zen snapshot', async () => {
  const instance = createOpencodeZenProvider(buildRecord());
  await withMockedFetch(respond, async () => {
    const models = await instance.instance.getProvidedModels(testFetcher);
    assertEquals(models.map(m => m.id), ['gpt-5.5', 'qwen3.8-max', 'kimi-k3', 'claude-sonnet-4']);

    const gpt = models.find(m => m.id === 'gpt-5.5')!;
    assertEquals(gpt.kind, 'chat');
    assertEquals(Object.keys(gpt.endpoints), ['openaiResponses']);
    assertEquals(gpt.opaqueBlobCompatibilityScope, { bindToUpstream: true });

    // The Zen table wires qwen3.8-max to chat/completions even though the Go
    // table wires the same id to messages: each gateway follows its own docs.
    const qwen = models.find(m => m.id === 'qwen3.8-max')!;
    assertEquals(Object.keys(qwen.endpoints), ['openaiChatCompletions']);

    const kimi = models.find(m => m.id === 'kimi-k3')!;
    assertEquals(Object.keys(kimi.endpoints), ['openaiChatCompletions']);
  });
});

test('getProvidedModels merges snapshot metadata, generated registry pricing, and reasoning presets', async () => {
  const instance = createOpencodeZenProvider(buildRecord());
  await withMockedFetch(respond, async () => {
    const models = await instance.instance.getProvidedModels(testFetcher);
    const gpt = models.find(m => m.id === 'gpt-5.5')!;
    // Snapshot limits and display name flow through.
    assertEquals(gpt.display_name, 'GPT-5.5');
    assertEquals(gpt.limits.max_context_window_tokens, 1050000);
    assertEquals(gpt.limits.max_output_tokens, 128000);
    assertEquals(gpt.chat?.modalities, { input: ['text', 'image'], output: ['text'] });
    // Generated registry pricing wins over the snapshot's own pricing.
    assertEquals(gpt.pricing?.entries[0]?.rates.input_tokens, '0.000005');
    assertEquals(gpt.pricing?.entries.length, 2);
    // Effort presets come from the generated capabilities table.
    assertEquals(gpt.chat?.reasoning?.effort?.supported, ['none', 'low', 'medium', 'high', 'xhigh']);
    assertEquals(gpt.chat?.reasoning?.effort?.default, 'high');
  });
});

test('getProvidedModels surfaces toggle-only registry reasoning as adaptive', async () => {
  const instance = createOpencodeZenProvider(buildRecord());
  await withMockedFetch(respond, async () => {
    const models = await instance.instance.getProvidedModels(testFetcher);
    const qwen = models.find(m => m.id === 'qwen3.8-max')!;
    assertEquals(qwen.chat?.reasoning, { adaptive: true });
  });
});

test('getProvidedModels never emits registry rows with no live counterpart', async () => {
  const instance = createOpencodeZenProvider(buildRecord());
  await withMockedFetch(respond, async () => {
    const models = await instance.instance.getProvidedModels(testFetcher);
    // gemini-3.8-flash lingers in the registry but is excluded from the
    // snapshot as unroutable, so it has no catalog row.
    assertEquals(models.some(m => m.id === 'gemini-3.8-flash'), false);
    assertEquals(models.some(m => m.id === 'jev-1.13'), false);
  });
});

test('getProvidedModels emits snapshot rows with no endpoint on the default wire', async () => {
  const instance = createOpencodeZenProvider(buildRecord());
  await withMockedFetch(respond, async () => {
    const models = await instance.instance.getProvidedModels(testFetcher);
    // claude-sonnet-4 is live but has no row in the Zen endpoint table: it
    // keeps its snapshot metadata and falls back to chat-completions.
    const sonnet = models.find(m => m.id === 'claude-sonnet-4')!;
    assertEquals(sonnet.kind, 'chat');
    assertEquals(Object.keys(sonnet.endpoints), ['openaiChatCompletions']);
    assertEquals(sonnet.display_name, 'Claude Sonnet 4');
  });
});

test('getProvidedModels drops live ids the docs table wires to a path Floway cannot route', async () => {
  const instance = createOpencodeZenProvider(buildRecord());
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/v1/models')) {
        return jsonResponse({
          object: 'list',
          data: [
            { id: 'kimi-k3', object: 'model' },
            { id: 'jev-1.13', object: 'model' },
            { id: 'jev-1.13-free', object: 'model' },
            { id: 'gemini-3.8-flash', object: 'model' },
          ],
        });
      }
      return new Response('unexpected', { status: 500 });
    },
    async () => {
      const models = await instance.instance.getProvidedModels(testFetcher);
      // jev-* route to /v1/systemone and gemini-* to /v1/models/{id}: neither
      // has a Floway endpoint family, so listing them on the
      // chat-completions fallback would advertise models no wire can serve.
      assertEquals(models.map(m => m.id), ['kimi-k3']);
    },
  );
});

test('getProvidedModels refuses upstream ids absent from the snapshot', async () => {
  const instance = createOpencodeZenProvider(buildRecord());
  await withMockedFetch(respond, async () => {
    const models = await instance.instance.getProvidedModels(testFetcher);
    // future-model-unknown is live upstream but has no registry metadata, so
    // it is filtered out rather than emitted on a fallback wire. Manual
    // `config.models[]` entries still let operators opt such ids in.
    assertEquals(models.some(m => m.id === 'future-model-unknown'), false);
    assertEquals(models.map(m => m.id), ['gpt-5.5', 'qwen3.8-max', 'kimi-k3', 'claude-sonnet-4']);
  });
});

test('getProvidedModels merges manual overrides in front of auto-fetched models and drops the auto duplicate', async () => {
  const instance = createOpencodeZenProvider(buildRecord({
    config: {
      baseUrl: 'https://opencode.ai/zen',
      apiKey: 'opencode_test',
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
  const instance = createOpencodeZenProvider(buildRecord({
    config: {
      baseUrl: 'https://opencode.ai/zen',
      apiKey: 'opencode_test',
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
  const instance = createOpencodeZenProvider(buildRecord());
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

  assertEquals(chatRequest!.url, 'https://opencode.ai/zen/v1/chat/completions');
  assertEquals(chatRequest!.headers.get('Authorization'), 'Bearer opencode_test');
  const body = chatBody as { model: string; stream: boolean };
  assertEquals(body.model, 'kimi-k3');
  assertEquals(body.stream, true);
});

test('Anthropic Messages methods serialize typed anthropic-beta metadata only on Anthropic Messages wire calls', async () => {
  const instance = createOpencodeZenProvider(buildRecord());
  const betas: Record<string, string | null> = {};

  await withMockedFetch(
    async request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/v1/models')) {
        return jsonResponse({ object: 'list', data: [{ id: 'claude-opus-5-5', object: 'model' }] });
      }
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
      const opus = models.find(m => m.id === 'claude-opus-5-5')!;
      const opts = noopAnthropicMessagesUpstreamCallOptions({ anthropicBeta: ['context-1m'] });
      await instance.instance.callAnthropicMessages(opus, { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, undefined, opts);
      await instance.instance.callAnthropicMessagesCountTokens(opus, { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, undefined, opts);
    },
  );

  assertEquals(betas, {
    '/v1/messages': 'context-1m',
    '/v1/messages/count_tokens': 'context-1m',
  });
});
