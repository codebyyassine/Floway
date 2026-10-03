import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { modelsRefreshIdentity } from './models-cache-fixture.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { saveUpstreamForTest } from './upstreams.ts';
import { cachedModelsForDashboard } from '../../src/control-plane/upstreams/models-cache-projection.ts';
import { createProvider } from '../../src/data-plane/providers/registry.ts';
import { MODEL_CATALOG_REVISION } from '../../src/repo/models-cache-contract.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo, StoredUpstreamRecord } from '../../src/repo/types.ts';
import type { ProviderModel } from '@floway-dev/provider';
import { applyCodexModelOverrides, codexModelContextWindow, type CodexUpstreamConfig } from '@floway-dev/provider-codex';

const rawModel = (context = 200_000): ProviderModel => ({
  id: 'model-a', upstreamModelId: 'model-a', display_name: 'A', kind: 'chat', endpoints: { openaiResponses: {} },
  limits: { max_context_window_tokens: context * 2 }, providerData: { contextWindow: context, useResponsesLite: false },
  chat: { image_detail_original: true }, enabledFlags: new Set(), opaqueBlobCompatibilityScope: { bindToUpstream: true, key: 'openai' },
});
const config: CodexUpstreamConfig = { accounts: [{ email: null, chatgptAccountId: null, chatgptUserId: null, planType: null }] };
const record: StoredUpstreamRecord = {
  id: 'codex-overrides', kind: 'codex', name: 'Codex overrides', config, state: { accounts: [{ chatgptAccountId: null, refresh_token: 'fixture', accessToken: null, openaiDeviceId: 'fixture-device', quotaSnapshot: null, state: 'active', state_updated_at: '2026-01-01T00:00:00.000Z' }] },
  enabled: true, sortOrder: 0, createdAt: '', updatedAt: '', configVersion: 1, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null, hue: 0,
  modelsCache: { revision: MODEL_CATALOG_REVISION, fetchedAt: 100, lastError: null, models: [rawModel()] },
};

describe.each<[string, () => Promise<Repo>]>([
  ['memory', async () => new InMemoryRepo()],
  ['SQL', async () => new SqlRepo(await createSqliteTestDb())],
])('%s Codex model override persistence', (_name, factory) => {
  test('saves sparse overrides without clearing the raw catalog; reset and refresh retain current defaults', async () => {
    const repo = (await factory()).upstreams;
    await saveUpstreamForTest(repo, record);
    const inserted = (await repo.getById(record.id))!;
    await expect(repo.publishModelsRefresh({ id: inserted.id, ...modelsRefreshIdentity(inserted), cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: 100, models: [rawModel()] } })).resolves.toBe(true);
    const current = (await repo.getById(record.id))!;
    const overrides = { 'model-a': { limits: { max_context_window_tokens: 300_000, max_output_tokens: 100 }, imageDetailOriginal: false } };
    const saved = (await repo.replaceForModels({ previous: current, upstream: { ...current, config: { ...config, modelOverrides: overrides } } }))!;
    expect((saved.config as CodexUpstreamConfig).modelOverrides).toEqual(overrides);
    expect(saved.modelsCache?.models[0]?.chat?.image_detail_original).toBe(true);
    const runtime = createProvider(saved).modelsCache!.models[0]!;
    expect(runtime.limits.max_output_tokens).toBe(100);
    expect(runtime.chat?.image_detail_original).toBe(false);
    expect(codexModelContextWindow(runtime).context_window).toBe(300_000);
    const displayed = cachedModelsForDashboard(saved)![0]!;
    expect(displayed.limits).toEqual(runtime.limits);
    expect(displayed.chat?.image_detail_original).toBe(false);

    await expect(repo.publishModelsRefresh({ id: saved.id, ...modelsRefreshIdentity(saved), cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: 200, models: [rawModel(600_000)] } })).resolves.toBe(true);
    const refreshed = (await repo.getById(saved.id))!;
    const effective = createProvider(refreshed).modelsCache!.models[0]!;
    expect(effective.limits.max_context_window_tokens).toBe(300_000);
    expect(effective.limits.max_output_tokens).toBe(100);
    const resetContext = (await repo.replaceForModels({ previous: refreshed, upstream: { ...refreshed, config: { ...config, modelOverrides: { 'model-a': { limits: { max_output_tokens: 100 } } } } } }))!;
    expect(codexModelContextWindow(createProvider(resetContext).modelsCache!.models[0]!).context_window).toBe(600_000);
    expect(createProvider(resetContext).modelsCache!.models[0]!.limits.max_output_tokens).toBe(100);
    const reset = (await repo.replaceForModels({ previous: resetContext, upstream: { ...resetContext, config: { ...config, modelOverrides: {} } } }))!;
    expect(createProvider(reset).modelsCache!.models[0]!.limits).toEqual({ max_context_window_tokens: 1_200_000 });
    expect(createProvider(reset).modelsCache!.models[0]!.chat?.image_detail_original).toBe(true);
    expect(applyCodexModelOverrides(reset.modelsCache!.models[0]!, {})).toBe(reset.modelsCache!.models[0]);
  });

  test('still invalidates the catalog for account edits and unrelated providers', async () => {
    const repo = (await factory()).upstreams;
    await saveUpstreamForTest(repo, record);
    const inserted = (await repo.getById(record.id))!;
    await expect(repo.publishModelsRefresh({ id: inserted.id, ...modelsRefreshIdentity(inserted), cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: 100, models: [rawModel()] } })).resolves.toBe(true);
    const current = (await repo.getById(record.id))!;
    expect(current.modelsCache?.models).toHaveLength(1);
    const changed = await repo.replaceForModels({ previous: current, upstream: { ...current, config: { accounts: [{ ...config.accounts[0], email: 'updated@example.com' }] } } });
    expect(changed?.modelsCache).toBeNull();
    const custom = { ...record, id: 'custom-other', kind: 'custom' as const, state: null, config: { models: [] } };
    await saveUpstreamForTest(repo, custom);
    const customInserted = (await repo.getById(custom.id))!;
    await expect(repo.publishModelsRefresh({ id: custom.id, ...modelsRefreshIdentity(customInserted), cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: 100, models: [rawModel()] } })).resolves.toBe(true);
    const customCurrent = (await repo.getById(custom.id))!;
    expect(customCurrent.modelsCache?.models).toHaveLength(1);
    const customChanged = await repo.replaceForModels({ previous: customCurrent, upstream: { ...customCurrent, config: { models: [], modelOverrides: {} } } });
    expect(customChanged?.modelsCache).toBeNull();
  });
});
