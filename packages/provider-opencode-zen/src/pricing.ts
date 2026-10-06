// Generated OpenCode Zen pricing, read off the checked-in registry snapshot
// (`src/pricing.generated.json`).
//
// Every rate below is the registry's own published USD-per-1M-token table,
// converted to USD-per-token with the repo's `tokenBasePricing` /
// `tokenPricingEntry` helpers. Tiered entries bill a higher rate once the
// request's input tokens reach the threshold. Free-tier rows bill 0/0/0: zero
// is a real rate, not missing data.
//
// Provenance: generated from https://models.opencode.ai/api.json, provider
// block `opencode` — the same registry OpenCode itself reads. Refresh with:
//   pnpm tools:generate-opencode-zen-catalog

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
  if (typeof value !== 'string') throw new Error(`Malformed opencode pricing snapshot: ${label} must be a string`);
  const canonical = parseNonNegativeDecimalString(value, label);
  if (canonical !== value) throw new Error(`Malformed opencode pricing snapshot: ${label} must be canonical`);
  return value;
};

const ratesOf = (value: unknown, label: string): PublishedRates => {
  if (!isRecord(value)) throw new Error(`Malformed opencode pricing snapshot: ${label} must be an object`);
  const cacheRead = value.cacheRead === undefined ? undefined : canonicalRate(value.cacheRead, `${label}.cacheRead`);
  const cacheWrite = value.cacheWrite === undefined ? undefined : canonicalRate(value.cacheWrite, `${label}.cacheWrite`);
  return {
    input: canonicalRate(value.input, `${label}.input`),
    output: canonicalRate(value.output, `${label}.output`),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
};

const parseTables = (value: unknown): { base: ReadonlyMap<string, PublishedRates>; tiers: ReadonlyMap<string, TierRates> } => {
  if (!isRecord(value) || !isRecord(value.base) || !isRecord(value.tiers)) {
    throw new Error('Malformed opencode pricing snapshot: expected { base, tiers }');
  }
  const base = new Map<string, PublishedRates>();
  for (const [id, rates] of Object.entries(value.base)) base.set(id, ratesOf(rates, `opencode pricing base ${id}`));
  const tiers = new Map<string, TierRates>();
  for (const [id, rates] of Object.entries(value.tiers)) {
    if (!isRecord(rates)) throw new Error(`Malformed opencode pricing snapshot: opencode pricing tier ${id} must be an object`);
    const threshold = rates.threshold;
    if (typeof threshold !== 'number' || !Number.isSafeInteger(threshold) || threshold <= 0) {
      throw new Error(`Malformed opencode pricing snapshot: opencode pricing tier ${id}.threshold must be a positive safe integer`);
    }
    tiers.set(id, { threshold, ...ratesOf(rates, `opencode pricing tier ${id}`) });
  }
  return { base, tiers };
};

const { base: OPENCODE_ZEN_BASE_RATES, tiers: OPENCODE_ZEN_TIER_RATES } = parseTables(pricingJson as unknown);

const toPublishedRates = (rates: PublishedRates): Record<string, string> => ({
  input_tokens: rates.input,
  output_tokens: rates.output,
  ...(rates.cacheRead !== undefined ? { input_cache_read_tokens: rates.cacheRead } : {}),
  ...(rates.cacheWrite !== undefined ? { input_cache_write_tokens: rates.cacheWrite } : {}),
});

const pricingForEntry = (id: string): ModelPricing => {
  const base = OPENCODE_ZEN_BASE_RATES.get(id)!;
  const tier = OPENCODE_ZEN_TIER_RATES.get(id);
  if (tier === undefined) return tokenBasePricing(toPublishedRates(base));
  return modelPricing(
    tokenPricingEntry(toPublishedRates(base)),
    tokenPricingEntry(toPublishedRates(tier), { inputTokens: { operator: 'gte', value: tier.threshold } }),
  );
};

const OPENCODE_ZEN_MODEL_PRICING: ReadonlyMap<string, ModelPricing> = new Map(
  [...OPENCODE_ZEN_BASE_RATES.keys()].map(id => [id, pricingForEntry(id)] as const),
);

// Model keys persisted in `usage.model_key` for the OpenCode Zen provider are
// the raw upstream ids from `GET /v1/models` — direct lookup against the
// table, no variant-suffix munging.
export const pricingForOpencodeZenModelKey = (modelKey: string): ModelPricing | null =>
  OPENCODE_ZEN_MODEL_PRICING.get(modelKey) ?? null;
