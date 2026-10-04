import { expect, test, vi } from 'vitest';

import type { ListedUpstreamModel, UpstreamRecord } from '../../../src/control-plane/upstreams/types.ts';
import { createProvider } from '../../../src/data-plane/providers/registry.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { MODEL_CATALOG_REVISION } from '../../../src/repo/models-cache-contract.ts';
import { SqlRepo } from '../../../src/repo/sql.ts';
import { modelsRefreshIdentity } from '../../repo/models-cache-fixture.ts';
import { createSqliteTestDb } from '../../repo/test-sqlite.ts';
import { buildCodexUpstreamRecord, requestApp, setupAppTest } from '../../test-utils/app.ts';
import type { ProviderModel } from '@floway-dev/provider';

const rawModel: ProviderModel = {
  id: 'gpt-6.1-sol', upstreamModelId: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', kind: 'chat',
  endpoints: { openaiResponses: {} }, limits: { max_context_window_tokens: 872_000 },
  providerData: { contextWindow: 272_000, useResponsesLite: false }, enabledFlags: new Set(),
  opaqueBlobCompatibilityScope: { bindToUpstream: true, key: 'openai' },
};

test('Codex HTTP override saves survive SQL readback and reach public and private catalogs without changing raw defaults', async () => {
  const setup = await setupAppTest();
  const db = await createSqliteTestDb();
  let repo = new SqlRepo(db);
  initRepo(repo);
  await repo.users.save((await setup.repo.users.getById(2))!);
  await repo.apiKeys.save(setup.apiKey);
  const adminSession = (await repo.sessions.create(1)).id;
  const adminHeaders = { 'content-type': 'application/json', 'x-floway-session': adminSession };
  const publicHeaders = { authorization: `Bearer ${setup.apiKey.key}` };
  const fixture = buildCodexUpstreamRecord();
  const createdResponse = await requestApp('/api/upstreams', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ kind: 'codex', name: 'Codex', hue: 210, config: fixture.config, state: fixture.state }),
  });
  expect(createdResponse.status).toBe(201);
  const created = await createdResponse.json() as { id: string };
  const current = (await repo.upstreams.getById(created.id))!;
  expect(await repo.upstreams.publishModelsRefresh({
    id: current.id, ...modelsRefreshIdentity(current),
    cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now(), models: [rawModel] },
  })).toBe(true);

  const publicModel = async () => {
    const response = await requestApp('/v1/models', { headers: publicHeaders });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { id: string; limits: Record<string, number>; codexDefaults?: unknown; codexOperationalContextWindow?: unknown }[] };
    const model = body.data.find(model => model.id === rawModel.id)!;
    expect(model).toBeDefined();
    expect(model.codexDefaults).toBeUndefined();
    expect(model.codexOperationalContextWindow).toBeUndefined();
    return model.limits;
  };
  const privateWindow = async () => {
    // Only the external client-template download is substituted; the HTTP catalog route stays real.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ models: [] }));
    try {
      const response = await requestApp('/v1/models', { headers: { ...publicHeaders, 'user-agent': 'codex_cli_rs/99.88.77' } });
      expect(response.status).toBe(200);
      const body = await response.json() as { models: { slug: string; context_window: number; max_context_window: number }[] };
      const model = body.models.find(model => model.slug === rawModel.id)!;
      expect(model).toBeDefined();
      return { context_window: model.context_window, max_context_window: model.max_context_window };
    } finally {
      fetchMock.mockRestore();
    }
  };
  const dashboardModel = async () => {
    const response = await requestApp(`/api/upstreams/${created.id}`, { headers: adminHeaders });
    expect(response.status).toBe(200);
    const record = await response.json() as UpstreamRecord & { cachedModels: ListedUpstreamModel[] };
    expect(record.cachedModels[0]!.codexDefaults?.limits).toEqual(rawModel.limits);
    expect(record.cachedModels[0]!.codexOperationalContextWindow).toBe(272_000);
    return record;
  };
  const patch = async (modelOverrides: unknown) => await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ config: { modelOverrides } }),
  });

  expect(await publicModel()).toEqual(rawModel.limits);
  expect(await privateWindow()).toEqual({ context_window: 272_000, max_context_window: 872_000 });
  expect((await dashboardModel()).cachedModels[0]!.limits).toEqual(rawModel.limits);

  const limits = { max_context_window_tokens: 999_999, max_output_tokens: 123_456 };
  const overrides = { [rawModel.id]: { limits } };
  expect((await patch(overrides)).status).toBe(200);
  repo = new SqlRepo(db);
  initRepo(repo);
  const reopened = await dashboardModel();
  expect((reopened.config as Extract<UpstreamRecord, { kind: 'codex' }>['config']).modelOverrides).toEqual(overrides);
  expect(reopened.cachedModels[0]!.limits).toEqual(limits);
  expect(createProvider((await repo.upstreams.getById(created.id))!).modelsCache!.models[0]!.limits).toEqual(limits);
  expect(await publicModel()).toEqual(limits);
  expect(await privateWindow()).toEqual({ context_window: 999_999, max_context_window: 999_999 });
  expect((await repo.upstreams.getById(created.id))!.modelsCache!.models[0]!.limits).toEqual(rawModel.limits);

  expect((await patch({ [rawModel.id]: { limits: { max_context_window_tokens: 0 } } })).status).toBe(400);
  expect(await publicModel()).toEqual(limits);
  expect(await privateWindow()).toEqual({ context_window: 999_999, max_context_window: 999_999 });
  expect((await patch({ 'different-model': overrides[rawModel.id] })).status).toBe(200);
  expect(await publicModel()).toEqual(rawModel.limits);
  expect(await privateWindow()).toEqual({ context_window: 272_000, max_context_window: 872_000 });
  expect((await patch(overrides)).status).toBe(200);
  expect(await publicModel()).toEqual(limits);
  expect((await patch({})).status).toBe(200);
  expect(await publicModel()).toEqual(rawModel.limits);
  expect(await privateWindow()).toEqual({ context_window: 272_000, max_context_window: 872_000 });
  expect((await dashboardModel()).cachedModels[0]!.limits).toEqual(rawModel.limits);
});
