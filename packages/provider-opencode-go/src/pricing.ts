// Generated OpenCode Go pricing, read off the checked-in registry snapshot
// (`src/pricing.generated.json`).
//
// Every rate below is the registry's own published USD-per-1M-token table,
// converted to USD-per-token with the repo's `tokenBasePricing` /
// `tokenPricingEntry` helpers. Tiered entries bill a higher rate once the
// request's input tokens reach the threshold.
//
// DeepSeek peak/off-peak split: `base` carries the authored peak rate (Base
// billing) and `offPeak` the registry-published off-peak rate, selected by
// the `pricingPeriod` axis the gateway stamps at request time. Peak rates
// come from DeepSeek's own pricing page; peak windows follow Beijing time
// with Chinese statutory holidays fully off-peak. Cache writes are free
// upstream, so no `input_cache_write` metric is recorded.
// https://api-docs.deepseek.com/quick_start/pricing
// https://github.com/NateScarlet/holiday-cn
//
// Provenance: generated from https://models.opencode.ai/api.json, provider
// block `opencode-go` — the same registry OpenCode itself reads. Refresh with:
//   pnpm tools:generate-opencode-go-catalog

import pricingJson from './pricing.generated.json' with { type: 'json' };
import { modelPricing, parseNonNegativeDecimalString, tokenBasePricing, tokenPricingEntry, type ModelPricing } from '@floway-dev/protocols/common';

interface PublishedRates {
  input: string;
  output: string;
  cacheRead?: string;
  cacheWrite?: string;
}

interface TierRates extends PublishedRates {
  threshold: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const canonicalRate = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new Error(`Malformed opencode-go pricing snapshot: ${label} must be a string`);
  const canonical = parseNonNegativeDecimalString(value, label);
  if (canonical !== value) throw new Error(`Malformed opencode-go pricing snapshot: ${label} must be canonical`);
  return value;
};

const ratesOf = (value: unknown, label: string): PublishedRates => {
  if (!isRecord(value)) throw new Error(`Malformed opencode-go pricing snapshot: ${label} must be an object`);
  const cacheRead = value.cacheRead === undefined ? undefined : canonicalRate(value.cacheRead, `${label}.cacheRead`);
  const cacheWrite = value.cacheWrite === undefined ? undefined : canonicalRate(value.cacheWrite, `${label}.cacheWrite`);
  return {
    input: canonicalRate(value.input, `${label}.input`),
    output: canonicalRate(value.output, `${label}.output`),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
};

const parseTables = (value: unknown): { base: ReadonlyMap<string, PublishedRates>; tiers: ReadonlyMap<string, TierRates>; offPeak: ReadonlyMap<string, PublishedRates> } => {
  if (!isRecord(value) || !isRecord(value.base) || !isRecord(value.tiers)) {
    throw new Error('Malformed opencode-go pricing snapshot: expected { base, tiers }');
  }
  const base = new Map<string, PublishedRates>();
  for (const [id, rates] of Object.entries(value.base)) base.set(id, ratesOf(rates, `opencode-go pricing base ${id}`));
  const tiers = new Map<string, TierRates>();
  for (const [id, rates] of Object.entries(value.tiers)) {
    if (!isRecord(rates)) throw new Error(`Malformed opencode-go pricing snapshot: opencode-go pricing tier ${id} must be an object`);
    const threshold = rates.threshold;
    if (typeof threshold !== 'number' || !Number.isSafeInteger(threshold) || threshold <= 0) {
      throw new Error(`Malformed opencode-go pricing snapshot: opencode-go pricing tier ${id}.threshold must be a positive safe integer`);
    }
    tiers.set(id, { threshold, ...ratesOf(rates, `opencode-go pricing tier ${id}`) });
  }
  const offPeak = new Map<string, PublishedRates>();
  if (value.offPeak !== undefined) {
    if (!isRecord(value.offPeak)) throw new Error('Malformed opencode-go pricing snapshot: offPeak must be an object');
    for (const [id, rates] of Object.entries(value.offPeak)) offPeak.set(id, ratesOf(rates, `opencode-go pricing off-peak ${id}`));
  }
  return { base, tiers, offPeak };
};

const { base: OPENCODE_GO_BASE_RATES, tiers: OPENCODE_GO_TIER_RATES, offPeak: OPENCODE_GO_OFF_PEAK_RATES } = parseTables(pricingJson as unknown);

const toPublishedRates = (rates: PublishedRates): Record<string, string> => ({
  input_tokens: rates.input,
  output_tokens: rates.output,
  ...(rates.cacheRead !== undefined ? { input_cache_read_tokens: rates.cacheRead } : {}),
  ...(rates.cacheWrite !== undefined ? { input_cache_write_tokens: rates.cacheWrite } : {}),
});

const pricingForEntry = (id: string): ModelPricing => {
  const base = OPENCODE_GO_BASE_RATES.get(id)!;
  const offPeak = OPENCODE_GO_OFF_PEAK_RATES.get(id);
  const tier = OPENCODE_GO_TIER_RATES.get(id);
  if (offPeak === undefined && tier === undefined) return tokenBasePricing(toPublishedRates(base));
  const entries = [tokenPricingEntry(toPublishedRates(base))];
  // DeepSeek peak/off-peak split: the authored peak rate is Base, and the
  // registry-published off-peak rate bills the `off-peak` pricingPeriod the
  // gateway stamps at request time.
  // https://api-docs.deepseek.com/quick_start/pricing
  if (offPeak !== undefined) entries.push(tokenPricingEntry(toPublishedRates(offPeak), { pricingPeriod: 'off-peak' }));
  if (tier !== undefined) {
    entries.push(tokenPricingEntry(toPublishedRates(tier), { inputTokens: { operator: 'gte', value: tier.threshold } }));
  }
  return modelPricing(...entries);
};

const OPENCODE_GO_MODEL_PRICING: ReadonlyMap<string, ModelPricing> = new Map(
  [...OPENCODE_GO_BASE_RATES.keys()].map(id => [id, pricingForEntry(id)] as const),
);

// Model keys persisted in `usage.model_key` for the OpenCode Go provider are
// the raw upstream ids from `GET /v1/models` — direct lookup against the
// table, no variant-suffix munging. Historical `space-bunny-free` rows keep
// resolving to their own zero-rate row, distinct from the priced
// `space-bunny` row that replaced it upstream.
export const pricingForOpencodeGoModelKey = (modelKey: string): ModelPricing | null =>
  OPENCODE_GO_MODEL_PRICING.get(modelKey) ?? null;
