import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';

import { TEST_OPENAI_RESPONSES_RETENTION_SECONDS } from './test-policy.ts';
import { anthropicMessagesHttp } from '../../../../src/data-plane/chat/anthropic-messages/http.ts';
import { geminiGenerateContentHttp } from '../../../../src/data-plane/chat/gemini-generate-content/http.ts';
import { openaiChatCompletionsHttp } from '../../../../src/data-plane/chat/openai-chat-completions/http.ts';
import { openaiResponsesHttp } from '../../../../src/data-plane/chat/openai-responses/http.ts';
import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { MODEL_CATALOG_REVISION } from '../../../../src/repo/models-cache-contract.ts';
import { SqlRepo } from '../../../../src/repo/sql.ts';
import type { ApiKey, User } from '../../../../src/repo/types.ts';
import { seedModelsCache, storedModelsRefreshIdentity } from '../../../repo/models-cache-fixture.ts';
import { createSqliteTestDb } from '../../../repo/test-sqlite.ts';
import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import { isReplayableBody } from '@floway-dev/http';
import { getFetch, initFetch } from '@floway-dev/platform';
import { openaiResponsesResultToEvents, type OpenAIResponsesResult } from '@floway-dev/protocols/openai-responses';
import type { UpstreamRecord } from '@floway-dev/provider';
import type { CodexUpstreamState } from '@floway-dev/provider-codex';
import { stubProviderModel } from '@floway-dev/test-utils';

const originalFetch = getFetch();

const key: ApiKey = {
  id: 'codex-affinity-key', userId: 1, name: 'affinity', key: 'sk-affinity', serverSecret: '00'.repeat(32),
  createdAt: '2026-01-01T00:00:00Z', upstreamIds: null, deletedAt: null,
  dumpRetentionSeconds: null, openaiResponsesRetentionSeconds: TEST_OPENAI_RESPONSES_RETENTION_SECONDS,
};
const user: User = {
  id: 1, username: 'admin', passwordHash: null, isAdmin: true, upstreamIds: null,
  createdAt: key.createdAt, deletedAt: null,
};
const upstream = (id: string, sortOrder: number): UpstreamRecord => ({
  id, kind: 'codex', name: id, enabled: true, sortOrder, createdAt: key.createdAt, updatedAt: key.createdAt,
  config: { accounts: [{ chatgptAccountId: id, chatgptUserId: id, email: null, planType: 'plus' }] },
  state: {
    accounts: [{
      chatgptAccountId: id, refresh_token: null, state: 'active', state_updated_at: key.createdAt,
      openaiDeviceId: '11111111-2222-4333-8444-555555555555', quotaSnapshot: null,
      accessToken: { token: `token-${id}`, expiresAt: Date.now() + 3600_000, refreshedAt: key.createdAt },
    }],
  } satisfies CodexUpstreamState,
  flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [{ id: 'direct_fetch' }], hue: 210,
  modelPrefix: { prefix: `${id}/`, addressable: ['prefixed'], listed: ['prefixed'] },
  modelsCache: {
    revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now(), lastError: null,
    models: [stubProviderModel({ id: 'gpt-5.4', endpoints: { openaiResponses: {} } })],
  },
});

const success = (): Response => {
  const result: OpenAIResponsesResult = {
    id: 'resp_upstream', object: 'response', model: 'gpt-5.4', status: 'completed',
    output: [], output_text: '', error: null, incomplete_details: null,
  };
  const frames = openaiResponsesResultToEvents(result);
  return new Response(`${frames.map(({ event }) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
};

const setup = async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  await repo.apiKeys.save(key);
  for (const [id, sortOrder] of [['a', 0], ['b', 1]] as const) {
    const record = upstream(id, sortOrder);
    await saveUpstreamForTest(repo.upstreams, record);
    expect(await seedModelsCache(repo.upstreams, id, await storedModelsRefreshIdentity(repo.upstreams, id), record.modelsCache!)).toBe(true);
  }
  await repo.modelAliases.insert({
    id: 'alias-affinity', name: 'codex', kind: 'chat', selection: 'random', displayName: null,
    visibleInModelsList: true, announcedMetadata: null, sortOrder: 0, createdAt: key.createdAt, updatedAt: key.createdAt,
    targets: [{ target_model_id: 'a/gpt-5.4', rules: {} }, { target_model_id: 'b/gpt-5.4', rules: {} }],
  });
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', async (c, next) => {
    c.set('apiKey', key);
    c.set('user', user);
    await next();
  });
  app.post('/v1/responses', openaiResponsesHttp.generate);
  app.post('/v1/responses/compact', openaiResponsesHttp.compact);
  app.post('/v1/chat/completions', openaiChatCompletionsHttp.generate);
  app.post('/v1/messages', anthropicMessagesHttp.generate);
  app.post('/v1beta/models/:modelAction', geminiGenerateContentHttp);
  const calls: string[] = [];
  let handler: (account: string) => Response | Promise<Response> = () => success();
  initFetch(async (_input, init) => {
    const account = new Headers(init?.headers).get('chatgpt-account-id');
    if (account !== 'a' && account !== 'b') throw new Error(`Unexpected upstream fetch for account ${account}`);
    calls.push(account);
    return await handler(account);
  });
  const order = vi.spyOn(Math, 'random').mockReturnValue(0.99);
  const send = async (session: string | null, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(session === null ? {} : { 'session-id': session }), ...headers },
      body: JSON.stringify({ model: 'codex', input: [{ role: 'user', content: 'first turn' }], stream: true, store: false, ...body }),
    });
    const text = await response.text();
    return { status: response.status, text };
  };
  return { app, calls, repo, db, order, send, handle: (next: typeof handler) => { handler = next; } };
};

afterEach(() => {
  vi.restoreAllMocks();
  initFetch(originalFetch);
});

test('real HTTP resolver and Codex provider pin a session across random alias order and repository reconstruction', async () => {
  const fixture = await setup();
  const first = await fixture.send('session-a');
  expect(first.status, first.text).toBe(200);
  fixture.order.mockReturnValue(0);
  initRepo(new SqlRepo(fixture.db));
  expect((await fixture.send('session-a')).status).toBe(200);
  expect((await fixture.send('session-b')).status).toBe(200);
  fixture.order.mockReturnValue(0.99);
  expect((await fixture.send('session-b')).status).toBe(200);
  expect(fixture.calls).toEqual(['a', 'a', 'b', 'b']);
});

test('mixed-provider HTTP sessions prioritize a bound Codex account while preserving unbound selection and fallbacks', async () => {
  const fixture = await setup();
  const native: UpstreamRecord = {
    ...upstream('native', 2), kind: 'custom',
    config: { baseUrl: 'https://native.example', authStyle: 'none', ingressHeadersRules: [], endpoints: { openaiResponses: {} } },
    state: {},
  };
  await saveUpstreamForTest(fixture.repo.upstreams, native);
  expect(await seedModelsCache(fixture.repo.upstreams, native.id, await storedModelsRefreshIdentity(fixture.repo.upstreams, native.id), native.modelsCache!)).toBe(true);
  await fixture.repo.modelAliases.insert({
    id: 'mixed', name: 'mixed', kind: 'chat', selection: 'random', displayName: null,
    visibleInModelsList: true, announcedMetadata: null, sortOrder: 1, createdAt: key.createdAt, updatedAt: key.createdAt,
    targets: [{ target_model_id: 'a/gpt-5.4', rules: {} }, { target_model_id: 'native/gpt-5.4', rules: {} }],
  });
  let failCodex = false;
  initFetch(async (_input, init) => {
    const account = new Headers(init?.headers).get('chatgpt-account-id');
    fixture.calls.push(account ?? 'native');
    return account !== null && failCodex
      ? Response.json({ error: { message: 'unavailable' } }, { status: 503 })
      : success();
  });
  const send = async (session: string) => {
    const response = await fixture.send(session, { model: 'mixed' });
    expect(response.status, response.text).toBe(200);
  };
  await send('bound');
  fixture.order.mockReturnValue(0);
  await send('bound');
  failCodex = true;
  await send('bound');
  failCodex = false;
  await send('bound');
  await send('unbound');
  fixture.order.mockReturnValue(0.99);
  await send('unbound');
  fixture.order.mockReturnValue(0);
  await send('unbound');
  expect(fixture.calls).toEqual(['a', 'a', 'a', 'native', 'a', 'native', 'a', 'a']);
});

test('concurrent first requests share the first claimed account despite independent alias order', async () => {
  const fixture = await setup();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  fixture.handle(async () => { await waiting; return success(); });
  fixture.order.mockReturnValueOnce(0.99).mockReturnValueOnce(0);
  const requests = [fixture.send('concurrent'), fixture.send('concurrent')];
  await vi.waitFor(() => expect(fixture.calls).toHaveLength(2));
  expect(new Set(fixture.calls).size).toBe(1);
  release();
  expect((await Promise.all(requests)).map(response => response.status)).toEqual([200, 200]);
});

test('body identity overrides frozen headers and header aliases use the same session binding', async () => {
  const fixture = await setup();
  await fixture.send('body-session');
  fixture.order.mockReturnValue(0);
  await fixture.send('frozen-header', { client_metadata: { session_id: 'body-session' } });
  await fixture.send(null, {}, { session_id: 'body-session' });
  await fixture.send('frozen-header', { client_metadata: { 'x-codex-turn-metadata': '{"session_id":"body-session"}' } });
  expect(fixture.calls).toEqual(['a', 'a', 'a', 'a']);
});

test('stateless full-history turns share their derived session while different first messages keep initial selection', async () => {
  const fixture = await setup();
  await fixture.send(null);
  fixture.order.mockReturnValue(0);
  await fixture.send(null, { input: [{ role: 'user', content: 'first turn' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'next turn' }] });
  await fixture.send(null, { input: [{ role: 'user', content: 'independent conversation' }] });
  expect(fixture.calls).toEqual(['a', 'a', 'b']);
});

test('previous_response_id continuation keeps the hydrated conversation session account', async () => {
  const fixture = await setup();
  const first = await fixture.send(null, { stream: false, store: true });
  expect(first.status, first.text).toBe(200);
  const previous = JSON.parse(first.text) as { id: string };
  fixture.order.mockReturnValue(0);
  const second = await fixture.send(null, {
    previous_response_id: previous.id, input: [{ role: 'user', content: 'next turn' }], stream: false, store: true,
  });
  expect(second.status, second.text).toBe(200);
  expect(fixture.calls).toEqual(['a', 'a']);
});

test.each([429, 503])('existing %i failover rebinds only after a successful replacement', async status => {
  const fixture = await setup();
  await fixture.send('recovering');
  fixture.handle(account => account === 'a' ? new Response('{"error":{"message":"unavailable"}}', { status, headers: { 'content-type': 'application/json' } }) : success());
  expect((await fixture.send('recovering')).status).toBe(200);
  fixture.handle(() => success());
  expect((await fixture.send('recovering')).status).toBe(200);
  expect(fixture.calls).toEqual(['a', 'a', 'b', 'b']);
});

test('authentication termination retains provider recovery policy and moves the session to a healthy account', async () => {
  const fixture = await setup();
  await fixture.send('auth-recovery');
  fixture.handle(account => account === 'a' ? new Response('{"error":{"code":"token_invalidated","message":"re-import required"}}', { status: 401, headers: { 'content-type': 'application/json' } }) : success());
  expect((await fixture.send('auth-recovery')).status).toBe(200);
  const record = await fixture.repo.upstreams.getById('a');
  expect((record!.state as CodexUpstreamState).accounts[0].state).toBe('session_terminated');
  expect((await fixture.send('auth-recovery')).status).toBe(200);
  expect(fixture.calls).toEqual(['a', 'a', 'b', 'b']);
});

test('disabled accounts are never restored by affinity and successful replacement remains sticky', async () => {
  const fixture = await setup();
  await fixture.send('disabled');
  await saveUpstreamForTest(fixture.repo.upstreams, { ...(await fixture.repo.upstreams.getById('a'))!, enabled: false });
  expect((await fixture.send('disabled')).status).toBe(200);
  await saveUpstreamForTest(fixture.repo.upstreams, { ...(await fixture.repo.upstreams.getById('a'))!, enabled: true });
  expect((await fixture.send('disabled')).status).toBe(200);
  expect(fixture.calls).toEqual(['a', 'b', 'b']);
});

test('exhausted failures preserve the last upstream response and do not bind a failed replacement', async () => {
  const fixture = await setup();
  await fixture.send('all-failed');
  fixture.handle(account => new Response(JSON.stringify({ error: { message: account } }), { status: account === 'a' ? 503 : 429, headers: { 'content-type': 'application/json' } }));
  const failed = await fixture.send('all-failed');
  expect(failed.status).toBe(429);
  expect(failed.text).toContain('b');
  fixture.handle(() => success());
  fixture.order.mockReturnValue(0);
  expect((await fixture.send('all-failed')).status).toBe(200);
  expect(fixture.calls).toEqual(['a', 'a', 'b', 'a']);
});

test.each([
  ['/v1/chat/completions', { model: 'codex', messages: [{ role: 'user', content: 'first turn' }], stream: true }],
  ['/v1/messages', { model: 'codex', messages: [{ role: 'user', content: 'first turn' }], max_tokens: 100, stream: true }],
  ['/v1beta/models/codex:streamGenerateContent', { contents: [{ role: 'user', parts: [{ text: 'first turn' }] }] }],
])('translated %s requests keep their derived Codex session account', async (path, body) => {
  const fixture = await setup();
  for (const order of [0.99, 0]) {
    fixture.order.mockReturnValue(order);
    const response = await fixture.app.request(path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
  }
  expect(fixture.calls).toEqual(['a', 'a']);
});

test.each([
  { fileData: { mimeType: 'text/plain', fileUri: 'gs://example/file' } },
  { executableCode: { language: 'PYTHON', code: 'print(1)' } },
  { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '1' } },
])('Gemini affinity preserves source preprocessing for %j', async unsupported => {
  const fixture = await setup();
  for (const session of [null, 'explicit-gemini']) {
    for (const order of [0.99, 0]) {
      fixture.order.mockReturnValue(order);
      const response = await fixture.app.request('/v1beta/models/codex:streamGenerateContent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(session === null ? {} : { 'session-id': session }) },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'first turn', ...unsupported }, unsupported] }],
          systemInstruction: { parts: [{ text: 'system', ...unsupported }, unsupported] },
        }),
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
    }
  }
  expect(fixture.calls).toEqual(['a', 'a', 'a', 'a']);
});

test('optional Codex identity translation does not reject a native Anthropic document request', async () => {
  const fixture = await setup();
  const native: UpstreamRecord = {
    ...upstream('native', 0), kind: 'custom',
    config: { baseUrl: 'https://native.example', authStyle: 'none', ingressHeadersRules: [], endpoints: { anthropicMessages: {} } },
    state: {},
    modelsCache: {
      revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now(), lastError: null,
      models: [stubProviderModel({ id: 'gpt-5.4', endpoints: { anthropicMessages: {} } })],
    },
  };
  await saveUpstreamForTest(fixture.repo.upstreams, native);
  expect(await seedModelsCache(fixture.repo.upstreams, native.id, await storedModelsRefreshIdentity(fixture.repo.upstreams, native.id), native.modelsCache!)).toBe(true);
  await fixture.repo.modelAliases.insert({
    id: 'native-first', name: 'native-first', kind: 'chat', selection: 'random', displayName: null,
    visibleInModelsList: true, announcedMetadata: null, sortOrder: 1, createdAt: key.createdAt, updatedAt: key.createdAt,
    targets: [{ target_model_id: 'native/gpt-5.4', rules: {} }, { target_model_id: 'a/gpt-5.4', rules: {} }],
  });
  const document = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ=' } };
  const fetch = vi.fn<ReturnType<typeof getFetch>>(async (_input, init) => {
    expect(new Headers(init?.headers).get('chatgpt-account-id')).toBeNull();
    const body = init!.body;
    const text = await new Response(isReplayableBody(body) ? body.open() : body).text();
    expect(JSON.parse(text).messages[0].content).toEqual([document]);
    return new Response([
      { type: 'message_start', message: { id: 'msg_native', type: 'message', role: 'assistant', model: 'gpt-5.4', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } },
      { type: 'message_stop' },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  initFetch(fetch);
  const response = await fixture.app.request('/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'native-first', messages: [{ role: 'user', content: [document] }], max_tokens: 100, stream: true }),
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  expect(text).toContain('message_stop');
  expect(fetch).toHaveBeenCalledOnce();
});

test('Responses compaction shares the generation session account', async () => {
  const fixture = await setup();
  await fixture.send('compacting');
  fixture.order.mockReturnValue(0);
  fixture.handle(() => Response.json({
    id: 'cmp_upstream', object: 'response.compaction', output: [],
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 11 },
  }));
  const response = await fixture.app.request('/v1/responses/compact', {
    method: 'POST', headers: { 'content-type': 'application/json', 'session-id': 'compacting' },
    body: JSON.stringify({ model: 'codex', input: [{ role: 'user', content: 'first turn' }] }),
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  expect(fixture.calls).toEqual(['a', 'a']);
});

test('requests with neither session identity nor a first user message retain initial selection', async () => {
  const fixture = await setup();
  await fixture.send(null, { input: [] });
  fixture.order.mockReturnValue(0);
  await fixture.send(null, { input: [] });
  expect(fixture.calls).toEqual(['a', 'b']);
});
