// Shared builder for the OpenCode generated snapshot files (Go and Zen).
//
// No network, no filesystem here: the caller supplies the fetched registry
// payload (`https://models.opencode.ai/api.json`), the live model id list
// (`GET <gateway>/v1/models`), and the gateway's docs page HTML, and this
// module returns the exact JSON-serializable structures the thin CLIs write to
// the checked-in `*.generated.json` files. Every model value originates from
// those three payloads; only the endpoint routing below is authored, and it
// comes from the vendor's own per-model endpoint tables:
// https://opencode.ai/docs/go
// https://opencode.ai/docs/zen

import { modelPricing, parseNonNegativeDecimalString, tokenBasePricing, tokenPricingEntry, type ModelPricing } from '@floway-dev/protocols/common';

export const OPENCODE_REGISTRY_URL = 'https://models.opencode.ai/api.json';

export type OpencodeEndpointKey = 'openaiResponses' | 'anthropicMessages' | 'openaiChatCompletions';

// One gateway's generation inputs: the registry provider block its models are
// read from plus the gateway's own docs table and live availability signal.
// The two gateways disagree per-model on shared ids (qwen3.8-max and the
// minimax rows are messages on Go, chat/completions on Zen), so each provider
// carries its own source rather than sharing one table.
export interface OpencodeProviderSource {
  /** Registry provider block this gateway's models are read from. */
  readonly block: string;
  /** Docs page carrying this gateway's per-model endpoint table. */
  readonly docsUrl: string;
  /** Live gateway availability signal (`GET <gateway>/v1/models`). */
  readonly liveModelsUrl: string;
  /** Refresh command recorded in the generated files' comments. */
  readonly refreshCommand: string;
}

export interface OpencodeGeneratedCatalogModel {
  id: string;
  // Present only when the gateway's docs table names this model's own row.
  // A live model with no row carries no endpoint at all — never an inferred
  // one — and the provider falls back to the chat-completions wire at runtime.
  endpoint?: OpencodeEndpointKey;
  name?: string;
  source?: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  modalities?: readonly ('text' | 'image')[];
  pricing?: ModelPricing;
}

export interface OpencodeGeneratedCatalog {
  models: readonly OpencodeGeneratedCatalogModel[];
}

// Per-1M-token published rates, mirroring the shape the provider's pricing
// reader consumes: base rates plus an optional long-context tier that bills
// the whole request once input tokens reach the threshold.
export interface OpencodeGeneratedPricingTables {
  base: Readonly<Record<string, { input: string; output: string; cacheRead?: string; cacheWrite?: string }>>;
  tiers: Readonly<Record<string, { threshold: number; input: string; output: string; cacheRead?: string; cacheWrite?: string }>>;
}

export interface OpencodeGeneratedReasoning {
  effort?: { supported: readonly string[]; default: string };
  budget_tokens?: { min?: number; max?: number };
  adaptive?: boolean;
}

export type OpencodeGeneratedCapabilities = Readonly<Record<string, OpencodeGeneratedReasoning>>;

// A live model id dropped from the catalog because the docs table wires it to
// a path Floway cannot route.
export interface OpencodeExcludedModel {
  /** Live model id dropped from the catalog. */
  readonly id: string;
  /** Docs-table URL path after `/v1/` that Floway cannot route. */
  readonly endpointPath: string;
}

export interface OpencodeGeneratedSnapshot {
  catalog: OpencodeGeneratedCatalog;
  pricing: OpencodeGeneratedPricingTables;
  capabilities: OpencodeGeneratedCapabilities;
  excluded: readonly OpencodeExcludedModel[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Wire selected by the URL path after `/v1/` in a docs-table Endpoint cell:
// `responses` is the OpenAI Responses wire, `chat/completions` the OpenAI
// chat-completions wire, `messages` the Anthropic Messages wire. Returns null
// for the paths Floway cannot route — `models/*` (per-model Gemini paths
// under `/v1/models/…`) and `systemone` (the Jev decision endpoint) — which
// have no family in ModelEndpoints
// (packages/protocols/src/common/endpoints.ts). Any other path fails loudly:
// silently dropping a wire the vendor documents would misroute traffic.
// https://opencode.ai/docs/go
// https://opencode.ai/docs/zen
const endpointKeyForDocsSubpath = (subpath: string, id: string, docsUrl: string): OpencodeEndpointKey | null => {
  if (subpath === 'responses') return 'openaiResponses';
  if (subpath === 'chat/completions') return 'openaiChatCompletions';
  if (subpath === 'messages') return 'anthropicMessages';
  if (subpath === 'models' || subpath.startsWith('models/') || subpath === 'systemone') return null;
  throw new Error(`Unsupported endpoint path in ${docsUrl}: model ${JSON.stringify(id)} wires to /v1/${subpath}, which maps to no Floway endpoint family`);
};

const stripTags = (html: string): string => html.replace(/<[^>]*>/g, ' ');

const decodeEntities = (value: string): string =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, '\'')
    .replace(/&#39;/g, '\'');

const cellTextOf = (cellHtml: string): string =>
  decodeEntities(stripTags(cellHtml)).replace(/\s+/g, ' ').trim();

export interface OpencodeDocsEndpoints {
  /** Model id to wire, one entry per docs-table row naming a supported path. */
  readonly endpoints: ReadonlyMap<string, OpencodeEndpointKey>;
  /** Model id to `/v1/` subpath for rows Floway cannot route. */
  readonly unroutable: ReadonlyMap<string, string>;
}

// Parses the per-model endpoint table out of a gateway docs page. The table is
// the one whose header names `Model ID` and `Endpoint`; each row is
// `Name | id | full URL | @ai-sdk/…`, and the wire comes from that row's own
// URL path after `/v1/`. A model id with no row is simply absent from both
// maps — the builder emits it with no endpoint — while a row naming a path
// that maps to no supported endpoint family fails loudly instead of dropping
// silently. Duplicate rows for one id must agree or the parse fails.
// https://opencode.ai/docs/go
// https://opencode.ai/docs/zen
export const parseOpencodeDocsEndpoints = (docsHtml: string, docsUrl: string): OpencodeDocsEndpoints => {
  const tables = docsHtml.match(/<table[\s>][\s\S]*?<\/table\s*>/gi) ?? [];
  const endpoints = new Map<string, OpencodeEndpointKey>();
  const unroutable = new Map<string, string>();
  let found = false;
  let rows = 0;
  for (const table of tables) {
    const trs = table.match(/<tr[\s>][\s\S]*?<\/tr\s*>/gi) ?? [];
    const cellRows = trs.map(tr => (tr.match(/<t[hd][\s>][\s\S]*?<\/t[hd]\s*>/gi) ?? []).map(cellTextOf));
    const headerIndex = cellRows.findIndex(
      cells => cells.some(cell => cell.toLowerCase() === 'model id') && cells.some(cell => cell.toLowerCase() === 'endpoint'),
    );
    if (headerIndex === -1) continue;
    found = true;
    for (const cells of cellRows.slice(headerIndex + 1)) {
      if (cells.length === 0 || cells.every(cell => cell === '')) continue;
      rows += 1;
      if (cells.length < 3) {
        throw new Error(`Malformed endpoint table in ${docsUrl}: expected at least 3 cells per row, got ${cells.length}`);
      }
      const id = cells[1]!;
      const url = cells[2]!;
      if (id === '') throw new Error(`Malformed endpoint table in ${docsUrl}: a row has an empty model id`);
      const marker = '/v1/';
      const markerIndex = url.indexOf(marker);
      if (markerIndex === -1) {
        throw new Error(`Malformed endpoint table in ${docsUrl}: model ${JSON.stringify(id)} has no /v1/ endpoint URL, got ${JSON.stringify(url)}`);
      }
      const subpath = url.slice(markerIndex + marker.length);
      if (subpath === '') throw new Error(`Malformed endpoint table in ${docsUrl}: model ${JSON.stringify(id)} has an empty path after /v1/`);
      const key = endpointKeyForDocsSubpath(subpath, id, docsUrl);
      if (key === null) {
        const known = unroutable.get(id);
        if (known !== undefined && known !== subpath) {
          throw new Error(`Conflicting endpoint rows in ${docsUrl}: model ${JSON.stringify(id)} wires to both /v1/${known} and /v1/${subpath}`);
        }
        unroutable.set(id, subpath);
      } else {
        const known = endpoints.get(id);
        if (known !== undefined && known !== key) {
          throw new Error(`Conflicting endpoint rows in ${docsUrl}: model ${JSON.stringify(id)} wires to both ${known} and ${key}`);
        }
        endpoints.set(id, key);
      }
      if (endpoints.has(id) && unroutable.has(id)) {
        throw new Error(`Conflicting endpoint rows in ${docsUrl}: model ${JSON.stringify(id)} is both routable and unroutable`);
      }
    }
  }
  if (!found) throw new Error(`No Model ID/Endpoint table found in ${docsUrl}`);
  if (rows === 0) throw new Error(`Model ID/Endpoint table in ${docsUrl} has no model rows`);
  return { endpoints, unroutable };
};

interface RegistryReasoningOption {
  type: string;
  values?: unknown;
  min?: unknown;
  max?: unknown;
}

// Maps one model's registry `reasoning_options` onto the Floway reasoning
// shape. `effort` carries the named presets with the established default
// rule (prefer `high`, else the last entry); `toggle` means the model
// decides its own depth (`adaptive`); `budget_tokens` bounds the
// operator-supplied budget when the registry states them.
export const reasoningForRegistryReasoningOptions = (options: unknown): OpencodeGeneratedReasoning | null => {
  if (!Array.isArray(options) || options.length === 0) return null;
  const reasoning: { effort?: { supported: string[]; default: string }; budget_tokens?: { min?: number; max?: number }; adaptive?: boolean } = {};
  for (const raw of options) {
    if (!isRecord(raw) || typeof raw.type !== 'string') continue;
    const option: RegistryReasoningOption = { type: raw.type, values: raw.values, min: raw.min, max: raw.max };
    if (option.type === 'effort' && Array.isArray(option.values)) {
      const supported = option.values.filter((value): value is string => typeof value === 'string' && value !== '');
      if (supported.length > 0) {
        reasoning.effort = { supported, default: supported.includes('high') ? 'high' : supported[supported.length - 1]! };
      }
    } else if (option.type === 'budget_tokens') {
      const budget: { min?: number; max?: number } = {};
      if (typeof option.min === 'number' && Number.isSafeInteger(option.min) && option.min >= 0) budget.min = option.min;
      if (typeof option.max === 'number' && Number.isSafeInteger(option.max) && option.max >= 0) budget.max = option.max;
      reasoning.budget_tokens = { ...reasoning.budget_tokens, ...budget };
    } else if (option.type === 'toggle') {
      reasoning.adaptive = true;
    }
  }
  if (reasoning.effort === undefined && reasoning.budget_tokens === undefined && reasoning.adaptive === undefined) return null;
  return reasoning;
};

const canonicalPublishedRate = (value: unknown, label: string): string => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Malformed ${label} must be a non-negative number, got ${JSON.stringify(value)}`);
  }
  return parseNonNegativeDecimalString(String(value), label);
};

const publishedRatesOf = (cost: Record<string, unknown>, label: string): { input: string; output: string; cacheRead?: string; cacheWrite?: string } => {
  // Only the four OpenAI-billing keys are read. Vendor-specific keys the
  // registry carries on some rows (notably `input_audio` on the Gemini rows of
  // the `opencode` block) are ignored — those models are excluded from the
  // catalog anyway, and their pricing rows keep the shared four-key shape.
  const rates: { input: string; output: string; cacheRead?: string; cacheWrite?: string } = {
    input: canonicalPublishedRate(cost.input, `${label}.input`),
    output: canonicalPublishedRate(cost.output, `${label}.output`),
  };
  if (cost.cache_read !== undefined) rates.cacheRead = canonicalPublishedRate(cost.cache_read, `${label}.cache_read`);
  if (cost.cache_write !== undefined) rates.cacheWrite = canonicalPublishedRate(cost.cache_write, `${label}.cache_write`);
  return rates;
};

// Builds the per-token ModelPricing for one registry `cost` block via the
// same helpers the provider calls at runtime. `tiers` entries bill the whole
// request at the tier rate once input tokens reach the threshold;
// `context_over_200k` is a redundant duplicate of `tiers` and is ignored.
// `block` names the registry provider block for error messages.
export const pricingForRegistryCost = (cost: unknown, label: string, block = 'opencode-go'): ModelPricing => {
  if (!isRecord(cost)) throw new Error(`Malformed ${block} registry cost for ${label}: must be an object`);
  const costLabel = `${block} registry cost for ${label}`;
  const base = publishedRatesOf(cost, costLabel);
  const toTokenRates = (rates: { input: string; output: string; cacheRead?: string; cacheWrite?: string }): Record<string, string> => ({
    input_tokens: rates.input,
    output_tokens: rates.output,
    ...(rates.cacheRead !== undefined ? { input_cache_read_tokens: rates.cacheRead } : {}),
    ...(rates.cacheWrite !== undefined ? { input_cache_write_tokens: rates.cacheWrite } : {}),
  });
  if (!Array.isArray(cost.tiers) || cost.tiers.length === 0) return tokenBasePricing(toTokenRates(base));
  const contextTiers = cost.tiers.filter((rawTier): rawTier is Record<string, unknown> => {
    if (!isRecord(rawTier) || !isRecord(rawTier.tier)) return false;
    if (rawTier.tier.type !== 'context') return false;
    return typeof rawTier.tier.size === 'number' && Number.isSafeInteger(rawTier.tier.size) && rawTier.tier.size > 0;
  });
  if (contextTiers.length > 1) throw new Error(`Malformed ${costLabel}: expected at most one context tier`);
  const entries = [tokenPricingEntry(toTokenRates(base))];
  for (const rawTier of contextTiers) {
    const size = (rawTier.tier as Record<string, unknown>).size as number;
    const tier = publishedRatesOf(rawTier, `${costLabel}.tiers[${size}]`);
    entries.push(tokenPricingEntry(toTokenRates(tier), { inputTokens: { operator: 'gte', value: size } }));
  }
  return modelPricing(...entries);
};

const registryModelsOf = (registryPayload: unknown, source: OpencodeProviderSource): Record<string, Record<string, unknown>> => {
  if (!isRecord(registryPayload)) throw new Error(`Malformed ${source.block} registry: expected an object`);
  const block = registryPayload[source.block];
  if (!isRecord(block)) throw new Error(`Malformed ${source.block} registry: missing provider block ${JSON.stringify(source.block)}`);
  if (!isRecord(block.models)) throw new Error(`Malformed ${source.block} registry: ${source.block}.models must be an object`);
  const models: Record<string, Record<string, unknown>> = {};
  for (const [id, model] of Object.entries(block.models)) {
    if (isRecord(model)) models[id] = model;
  }
  return models;
};

const liveIdsOf = (liveIds: readonly unknown[]): string[] => {
  const ids: string[] = [];
  for (const id of liveIds) {
    if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id);
  }
  return ids;
};

const CATALOG_MODALITIES: ReadonlySet<string> = new Set(['text', 'image']);

const catalogModelForRegistryEntry = (
  id: string,
  entry: Record<string, unknown>,
  endpoint: OpencodeEndpointKey | undefined,
  source: OpencodeProviderSource,
): OpencodeGeneratedCatalogModel => {
  const model: { id: string; endpoint?: OpencodeEndpointKey; name?: string; source?: string; maxContextTokens?: number; maxOutputTokens?: number; modalities?: ('text' | 'image')[]; pricing?: ModelPricing } = { id };
  // The endpoint comes only from this model's own docs-table row. A model
  // with no row carries no endpoint field at all — never an inferred one.
  if (endpoint !== undefined) model.endpoint = endpoint;
  if (typeof entry.name === 'string' && entry.name !== '') model.name = entry.name;
  model.source = source.block;
  if (isRecord(entry.limit)) {
    if (typeof entry.limit.context === 'number' && Number.isSafeInteger(entry.limit.context) && entry.limit.context > 0) {
      model.maxContextTokens = entry.limit.context;
    }
    if (typeof entry.limit.output === 'number' && Number.isSafeInteger(entry.limit.output) && entry.limit.output > 0) {
      model.maxOutputTokens = entry.limit.output;
    }
  }
  if (isRecord(entry.modalities) && Array.isArray(entry.modalities.input)) {
    const modalities = entry.modalities.input.filter((mod): mod is 'text' | 'image' => typeof mod === 'string' && CATALOG_MODALITIES.has(mod));
    if (modalities.length > 0) model.modalities = modalities;
  }
  if (entry.cost !== undefined) model.pricing = pricingForRegistryCost(entry.cost, `${source.block} model ${id}`, source.block);
  return model;
};

// Joins the live availability signal against registry metadata and the
// gateway's docs-table endpoints. A live id absent from the registry is
// refused (filtered out) — only registry-described models are emitted —
// while a registry row with no live counterpart is excluded (which is also
// what filters deprecated rows: they linger in the registry but are no
// longer served). A live id whose docs row wires it to a path Floway cannot
// route is excluded from the catalog and reported in `excluded`; a live id
// with no docs row at all is kept but carries no endpoint.
export const buildOpencodeSnapshot = (args: {
  registryPayload: unknown;
  liveIds: readonly unknown[];
  docsHtml: string;
  source: OpencodeProviderSource;
}): OpencodeGeneratedSnapshot => {
  const registryModels = registryModelsOf(args.registryPayload, args.source);
  const live = liveIdsOf(args.liveIds);
  const docs = parseOpencodeDocsEndpoints(args.docsHtml, args.source.docsUrl);
  const models: OpencodeGeneratedCatalogModel[] = [];
  const excluded: OpencodeExcludedModel[] = [];
  for (const id of live) {
    const endpointPath = docs.unroutable.get(id);
    if (endpointPath !== undefined) {
      excluded.push({ id, endpointPath });
      continue;
    }
    const endpoint = docs.endpoints.get(id);
    const entry = registryModels[id];
    if (entry === undefined) {
      // Refused: a live id the registry does not describe carries no
      // metadata Floway can trust, so it never reaches the catalog. Manual
      // `config.models[]` entries still let operators opt such ids in.
      continue;
    }
    models.push(catalogModelForRegistryEntry(id, entry, endpoint, args.source));
  }
  const base: Record<string, { input: string; output: string; cacheRead?: string; cacheWrite?: string }> = {};
  const tiers: Record<string, { threshold: number; input: string; output: string; cacheRead?: string; cacheWrite?: string }> = {};
  const capabilities: Record<string, OpencodeGeneratedReasoning> = {};
  for (const id of Object.keys(registryModels).toSorted()) {
    const entry = registryModels[id]!;
    if (entry.cost !== undefined) {
      if (!isRecord(entry.cost)) throw new Error(`Malformed ${args.source.block} registry cost for ${args.source.block} model ${id}: must be an object`);
      base[id] = publishedRatesOf(entry.cost, `${args.source.block} registry cost for ${args.source.block} model ${id}`);
      if (Array.isArray(entry.cost.tiers)) {
        const contextTiers = entry.cost.tiers.filter((rawTier): rawTier is Record<string, unknown> => {
          if (!isRecord(rawTier) || !isRecord(rawTier.tier)) return false;
          if (rawTier.tier.type !== 'context') return false;
          return typeof rawTier.tier.size === 'number' && Number.isSafeInteger(rawTier.tier.size) && rawTier.tier.size > 0;
        });
        // The provider's tier table carries a single long-context band per
        // model, matching every tier the registry publishes today. A second
        // band must fail loudly here rather than silently diverge from the
        // catalog pricing built below.
        if (contextTiers.length > 1) throw new Error(`Malformed ${args.source.block} registry cost for ${args.source.block} model ${id}: expected at most one context tier`);
        const [tier] = contextTiers;
        if (tier !== undefined && isRecord(tier.tier)) {
          const size = tier.tier.size as number;
          tiers[id] = { threshold: size, ...publishedRatesOf(tier, `${args.source.block} registry cost for ${args.source.block} model ${id}.tiers[${size}]`) };
        }
      }
    }
    const reasoning = reasoningForRegistryReasoningOptions(entry.reasoning_options);
    if (reasoning !== null) capabilities[id] = reasoning;
  }
  return { catalog: { models }, pricing: { base, tiers }, capabilities, excluded };
};
