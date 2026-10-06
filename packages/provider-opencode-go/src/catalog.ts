// Typed reader for the checked-in OpenCode Go model snapshot
// (`src/catalog.generated.json`).
//
// Provenance: generated from https://models.opencode.ai/api.json, provider
// block `opencode-go` — the same registry OpenCode itself reads — joined
// against the live `GET https://opencode.ai/zen/go/v1/models` availability
// signal, with per-model endpoints from that model's own row of the vendor
// endpoint table (see https://opencode.ai/docs/go/). Refresh with:
//   pnpm tools:generate-opencode-go-catalog
//
// Each snapshot entry carries the registry display name, context/output
// limits, input modalities, and the registry's own pricing (USD per one
// token). The per-model wire (`endpoint`) is present only when the docs table
// names that model's row; a live model with no row carries no endpoint, and
// the provider falls back to the chat-completions wire (see provider.ts). The
// provider joins this static metadata against the live `/v1/models`
// availability signal: a live model id absent from the snapshot (no registry
// metadata) is refused — filtered out, never emitted.

import catalogJson from './catalog.generated.json' with { type: 'json' };
import type { ModelPricing } from '@floway-dev/protocols/common';
import { pricingField } from '@floway-dev/provider';

export type OpencodeGoEndpointKey = 'openaiResponses' | 'anthropicMessages' | 'openaiChatCompletions';

const ENDPOINT_KEYS: ReadonlySet<string> = new Set<string>(['openaiResponses', 'anthropicMessages', 'openaiChatCompletions']);

export interface OpencodeGoCatalogModel {
  id: string;
  // Present only when the docs table names this model's row; absent for live
  // models the table does not document. The provider falls back to the
  // chat-completions wire for those.
  endpoint?: OpencodeGoEndpointKey;
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
  if (value.endpoint !== undefined && (typeof value.endpoint !== 'string' || !ENDPOINT_KEYS.has(value.endpoint))) return null;
  const model: OpencodeGoCatalogModel = { id: value.id };
  if (typeof value.endpoint === 'string' && ENDPOINT_KEYS.has(value.endpoint)) {
    model.endpoint = value.endpoint as OpencodeGoEndpointKey;
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
      const pricing = pricingField(value.pricing, `opencode-go catalog model ${value.id}.pricing`);
      if (pricing) model.pricing = pricing;
    } catch {
      // A malformed snapshot pricing row drops its pricing, not the model —
      // the row still carries trusted registry metadata.
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
