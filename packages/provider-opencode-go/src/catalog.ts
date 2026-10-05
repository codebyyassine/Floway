// Typed reader for the checked-in OpenCode Go model snapshot
// (`src/catalog.generated.json`).
//
// Provenance: generated from https://models.dev/api.json, provider block
// `opencode-go` — the same registry OpenCode itself reads (see
// https://opencode.ai/docs/go/). Refresh with:
//   pnpm --filter @floway-dev/provider-opencode-go run generate:catalog
//
// Each snapshot entry carries the per-model wire (`endpoint`), display name,
// context/output limits, input modalities, and the registry's own pricing
// (USD per one token). The provider joins this static metadata against the
// live `/v1/models` availability signal: a model id present upstream but
// absent here is still emitted with minimal metadata.

import catalogJson from './catalog.generated.json' with { type: 'json' };
import type { ModelPricing } from '@floway-dev/protocols/common';
import { pricingField } from '@floway-dev/provider';

export type OpencodeGoEndpointKey = 'openaiResponses' | 'anthropicMessages' | 'openaiChatCompletions';

const ENDPOINT_KEYS: ReadonlySet<string> = new Set<string>(['openaiResponses', 'anthropicMessages', 'openaiChatCompletions']);

export interface OpencodeGoCatalogModel {
  id: string;
  endpoint: OpencodeGoEndpointKey;
  endpointInferred?: boolean;
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

const parseCatalogModel = (value: unknown): OpencodeGoCatalogModel | null => {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id === '') return null;
  if (typeof value.endpoint !== 'string' || !ENDPOINT_KEYS.has(value.endpoint)) return null;
  const model: OpencodeGoCatalogModel = {
    id: value.id,
    endpoint: value.endpoint as OpencodeGoEndpointKey,
  };
  if (value.endpointInferred === true) model.endpointInferred = true;
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
      const pricing = pricingField(value.pricing, `opencode-go catalog model ${value.id}.pricing`);
      if (pricing) model.pricing = pricing;
    } catch {
      // A malformed snapshot pricing row drops its pricing, not the model —
      // availability outranks metadata completeness.
    }
  }
  return model;
};

const parseCatalog = (value: unknown): OpencodeGoCatalogModel[] => {
  if (!isRecord(value) || !Array.isArray(value.models)) throw new Error('Malformed opencode-go catalog snapshot: expected { models: [] }');
  const models: OpencodeGoCatalogModel[] = [];
  for (const entry of value.models) {
    const model = parseCatalogModel(entry);
    if (model) models.push(model);
  }
  return models;
};

const OPENCODE_GO_CATALOG_MODELS: readonly OpencodeGoCatalogModel[] = parseCatalog(catalogJson as unknown);

const OPENCODE_GO_CATALOG_BY_ID: ReadonlyMap<string, OpencodeGoCatalogModel> = new Map(
  OPENCODE_GO_CATALOG_MODELS.map(model => [model.id, model]),
);

export const opencodeGoCatalogModels = (): readonly OpencodeGoCatalogModel[] => OPENCODE_GO_CATALOG_MODELS;

export const opencodeGoCatalogModelForId = (id: string): OpencodeGoCatalogModel | undefined => OPENCODE_GO_CATALOG_BY_ID.get(id);
