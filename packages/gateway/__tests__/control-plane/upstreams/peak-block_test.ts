import { test } from 'vitest';

import { blueprintUpstreamRecord } from '../../../src/control-plane/upstreams/serialize.ts';
import { MOCKED_FETCH_EGRESS, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals } from '@floway-dev/test-utils';

type JsonObject = Record<string, any>;

const customConfig = {
  baseUrl: 'https://custom.example.com',
  authStyle: 'bearer',
  ingressHeadersRules: [],
  apiKey: 'sk-test',
  endpoints: { openaiChatCompletions: {} },
};

const createBody = (overrides: Record<string, unknown> = {}) => ({
  kind: 'custom',
  name: 'Peak upstream',
  hue: 210,
  config: customConfig,
  proxy_fallback_list: MOCKED_FETCH_EGRESS,
  ...overrides,
});

const authedPost = (adminSession: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
  body: JSON.stringify(body),
});

const authedPatch = (adminSession: string, body: unknown): RequestInit => ({
  method: 'PATCH',
  headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
  body: JSON.stringify(body),
});

test('peak blocking defaults off, round-trips on create, and patches', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const omitted = await requestApp('/api/upstreams', authedPost(adminSession, createBody()));
  assertEquals(omitted.status, 201);
  const createdDefault = (await omitted.json()) as JsonObject;
  assertEquals(createdDefault.block_peak_priced_models, false);
  assertEquals((await repo.upstreams.getById(createdDefault.id))?.blockPeakPricedModels, false);

  const enabled = await requestApp('/api/upstreams', authedPost(adminSession, createBody({ block_peak_priced_models: true })));
  assertEquals(enabled.status, 201);
  const createdOn = (await enabled.json()) as JsonObject;
  assertEquals(createdOn.block_peak_priced_models, true);
  assertEquals((await repo.upstreams.getById(createdOn.id))?.blockPeakPricedModels, true);

  const patched = await requestApp(`/api/upstreams/${createdOn.id}`, authedPatch(adminSession, { block_peak_priced_models: false }));
  assertEquals(patched.status, 200);
  assertEquals(((await patched.json()) as JsonObject).block_peak_priced_models, false);
  assertEquals((await repo.upstreams.getById(createdOn.id))?.blockPeakPricedModels, false);
});

test('peak blocking rejects a non-boolean wire value', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp('/api/upstreams', authedPost(adminSession, createBody({ block_peak_priced_models: 'yes' })));
  assertEquals(resp.status, 400);
});

test('blueprints open with peak blocking off', () => {
  assertEquals(blueprintUpstreamRecord('custom').block_peak_priced_models, false);
});
