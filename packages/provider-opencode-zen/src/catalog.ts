// Typed reader for the checked-in OpenCode Zen model snapshot
// (`src/catalog.generated.json`).
//
// Provenance: generated from https://models.opencode.ai/api.json, provider
// block `opencode` — the same registry OpenCode itself reads — joined against
// the live `GET https://opencode.ai/zen/v1/models` availability signal, with
// per-model endpoints from that model's own row of the vendor endpoint table
// (see https://opencode.ai/docs/zen). Refresh with:
//   pnpm tools:generate-opencode-zen-catalog
//
// Each snapshot entry carries the registry display name, context/output
// limits, input modalities, and the registry's own pricing (USD per one
// token). The per-model wire (`endpoint`) is present only when the docs table
// names that model's row; a live model with no row carries no endpoint, and
// the provider falls back to the chat-completions wire (see provider.ts). The
// provider joins this static metadata against the live `/v1/models`
// availability signal: a model id present upstream but absent here is still
// emitted with minimal metadata.

import catalogJson from './catalog.generated.json' with { type: 'json' };
import type { ModelPricing } from '@floway-dev/protocols/common';
import { pricingField } from '@floway-dev/provider';

export type OpencodeZenEndpointKey = 'openaiResponses' | 'anthropicMessages' | 'openaiChatCompletions';

const ENDPOINT_KEYS: ReadonlySet<string> = new Set<string>(['openaiResponses', 'anthropicMessages', 'openaiChatCompletions']);

export interface OpencodeZenCatalogModel {
  id: string;
  // Present only when the docs table names this model's row; absent for live
  // models the table does not document. The provider falls back to the
  // chat-completions wire for those.
  endpoint?: OpencodeZenEndpointKey;
  name?: string;
  source?: string | null;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  modalities?: readonly ('text' | 'image')[];
  pricing?: ModelPricing;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalPositiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

const parseCatalogModel = (value: unknown): OpencodeZenCatalogModel | null => {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id === '') return null;
  if (value.endpoint !== undefined && (typeof value.endpoint !== 'string' || !ENDPOINT_KEYS.has(value.endpoint))) return null;
  const model: OpencodeZenCatalogModel = { id: value.id };
  if (typeof value.endpoint === 'string' && ENDPOINT_KEYS.has(value.endpoint)) {
    model.endpoint = value.endpoint as OpencodeZenEndpointKey;
  }
  if (typeof value.name === 'string' && value.name !== '') model.name = value.name;
  if (value.source === null) model.source = null;
  else if (typeof value.source === 'string' && value.source !== '') model.source = value.source;
  const maxContextTokens = optionalPositiveInt(value.maxContextTokens);
  if (maxContextTokens !== undefined) model.maxContextTokens = maxContextTokens;
  const maxOutputTokens = optionalPositiveInt(value.maxOutputTokens);
  if (maxOutputTokens !== undefined) model.maxOutputTokens = maxOutputTokens;
  if (Array.isArray(value.modalities)) {
    const modalities = value.modalities.filter(mod => mod === 'text' || mod === 'image');
    if (modalities.length > 0) model.modalities = modalities;
  }
  if (value.pricing !== undefined) {
    try {
      const pricing = pricingField(value.pricing, `opencode catalog model ${value.id}.pricing`);
      if (pricing) model.pricing = pricing;
    } catch {
      // A malformed snapshot pricing row drops its pricing, not the model —
      // availability outranks metadata completeness.
    }
  }
  return model;
};

const parseCatalog = (value: unknown): OpencodeZenCatalogModel[] => {
  if (!isRecord(value) || !Array.isArray(value.models)) throw new Error('Malformed opencode catalog snapshot: expected { models: [] }');
  const models: OpencodeZenCatalogModel[] = [];
  for (const entry of value.models) {
    const model = parseCatalogModel(entry);
    if (model) models.push(model);
  }
  return models;
};

const OPENCODE_ZEN_CATALOG_MODELS: readonly OpencodeZenCatalogModel[] = parseCatalog(catalogJson as unknown);

const OPENCODE_ZEN_CATALOG_BY_ID: ReadonlyMap<string, OpencodeZenCatalogModel> = new Map(
  OPENCODE_ZEN_CATALOG_MODELS.map(model => [model.id, model]),
);

export const opencodeZenCatalogModels = (): readonly OpencodeZenCatalogModel[] => OPENCODE_ZEN_CATALOG_MODELS;

export const opencodeZenCatalogModelForId = (id: string): OpencodeZenCatalogModel | undefined => OPENCODE_ZEN_CATALOG_BY_ID.get(id);

// Live model ids the Zen docs table wires to a path Floway cannot route
// (https://opencode.ai/docs/zen): the gemini-* rows to `/v1/models/{id}` and
// jev-* to `/v1/systemone`. The generator excludes them from the snapshot
// (see catalog.generated.json `$comment`), so without this set the
// provider's unknown-id fallback would emit them on the chat-completions
// wire they cannot serve. Mirrors the generator's excluded set: when a
// refresh names a new excluded id, the drift test in
// `__tests__/catalog_test.ts` fails until this set grows with it.
export const OPENCODE_ZEN_UNROUTABLE_MODEL_IDS: ReadonlySet<string> = new Set([
  'gemini-3.6-flash',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.1-pro',
  'gemini-3-flash',
  'jev-1.13',
  'jev-1.13-free',
]);
