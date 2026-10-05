// Hand-authored OpenCode Go pricing. This table OVERRIDES the generated
// snapshot's own pricing: the vendor's published rates are authoritative for
// what Floway operators actually pay, while the snapshot's models.dev rates
// may be first-party vendor rates or third-party mirrors that differ.
//
// Every rate below is the vendor's own published USD-per-1M-token table,
// converted to USD-per-token with the repo's `tokenBasePricing` /
// `tokenPricingEntry` helpers. Tiered entries bill a higher rate once the
// request's input tokens reach the threshold.
//
// Refresh procedure: compare against the pricing table and re-port any
// changed rows; the snapshot generator documents the same source.

import { modelPricing, tokenBasePricing, tokenPricingEntry, type ModelPricing } from '@floway-dev/protocols/common';

// Base USD-per-1M-token rates from the vendor's published pricing table.
// https://opencode.ai/docs/go/
const OPENCODE_GO_BASE_RATES: Readonly<Record<string, { input: string; output: string; cacheRead?: string; cacheWrite?: string }>> = {
  'glm-5.3-flash': { input: '0.15', output: '0.50', cacheRead: '0.03' },
  'glm-5.3': { input: '1.40', output: '4.40', cacheRead: '0.26' },
  'glm-5.2': { input: '1.40', output: '4.40', cacheRead: '0.26' },
  'kimi-k3': { input: '3.00', output: '15.00', cacheRead: '0.30' },
  'kimi-k2.7-code': { input: '0.95', output: '4.00', cacheRead: '0.19' },
  'kimi-k2.6': { input: '0.95', output: '4.00', cacheRead: '0.16' },
  'longcat-2.0': { input: '0.30', output: '1.20', cacheRead: '0.006' },
  'longcat-2.5-preview-free': { input: '0', output: '0', cacheRead: '0', cacheWrite: '0' },
  'mimo-v2.6-flash': { input: '0.14', output: '0.28', cacheRead: '0.0028' },
  'mimo-v2.6-pro': { input: '0.435', output: '0.87', cacheRead: '0.003625' },
  'mimo-v2.5': { input: '0.14', output: '0.28', cacheRead: '0.0028' },
  'mimo-v2.5-pro': { input: '0.435', output: '0.87', cacheRead: '0.003625' },
  'minimax-m3': { input: '0.30', output: '1.20', cacheRead: '0.06' },
  'minimax-m2.7': { input: '0.30', output: '1.20', cacheRead: '0.06' },
  'minimax-m2.5': { input: '0.30', output: '1.20', cacheRead: '0.06' },
  'muse-spark-1.3-contributor': { input: '0.10', output: '0.20', cacheRead: '0.002' },
  'muse-spark-1.2-contributor': { input: '0.10', output: '0.20', cacheRead: '0.002' },
  'qwen3.8-max': { input: '2.00', output: '6.00', cacheRead: '0.25', cacheWrite: '2.50' },
  'qwen3.8-flash': { input: '0.15', output: '0.47', cacheRead: '0.016', cacheWrite: '0.20' },
  'qwen3.7-plus': { input: '0.40', output: '1.60', cacheRead: '0.04', cacheWrite: '0.50' },
  'deepseek-v4.1-flash': { input: '0.15', output: '0.60', cacheRead: '0.003' },
  'deepseek-v4-pro': { input: '0.66', output: '1.98', cacheRead: '0.022' },
  'deepseek-v4-flash': { input: '0.15', output: '0.60', cacheRead: '0.003' },
  'deepseek-v4-flash-vision-exp': { input: '0.15', output: '0.60', cacheRead: '0.003' },
  'hy4-preview': { input: '0.834', output: '2.501', cacheRead: '0.042' },
  'hy3': { input: '0.14', output: '0.58', cacheRead: '0.035' },
  'space-bunny-free': { input: '0', output: '0', cacheRead: '0', cacheWrite: '0' },
  'gpt-5.6-luna': { input: '0.20', output: '1.20', cacheRead: '0.02', cacheWrite: '0.25' },
  'gpt-6-luna': { input: '0.10', output: '0.50', cacheRead: '0.01', cacheWrite: '0.125' },
  'grok-4.7': { input: '2.00', output: '6.00', cacheRead: '0.50' },
  'grok-4.6': { input: '2.00', output: '6.00', cacheRead: '0.50' },
  'grok-4.5': { input: '2.00', output: '6.00', cacheRead: '0.30' },
};

// Long-context surcharge tiers from the same vendor table: once the request's
// input tokens reach the threshold, the whole request bills at the tier rate.
// https://opencode.ai/docs/go/
const OPENCODE_GO_TIER_RATES: Readonly<Record<string, { threshold: number; input: string; output: string; cacheRead?: string; cacheWrite?: string }>> = {
  'qwen3.7-plus': { threshold: 256000, input: '1.20', output: '4.80', cacheRead: '0.12', cacheWrite: '1.50' },
  'gpt-6-luna': { threshold: 272000, input: '0.20', output: '0.75', cacheRead: '0.02', cacheWrite: '0.25' },
  'gpt-5.6-luna': { threshold: 272000, input: '0.40', output: '1.80', cacheRead: '0.04', cacheWrite: '0.50' },
  'grok-4.7': { threshold: 200000, input: '4.00', output: '12.00', cacheRead: '1.00' },
  'grok-4.6': { threshold: 200000, input: '4.00', output: '12.00', cacheRead: '1.00' },
  'grok-4.5': { threshold: 200000, input: '4.00', output: '12.00', cacheRead: '0.60' },
};

const toPublishedRates = (rates: { input: string; output: string; cacheRead?: string; cacheWrite?: string }): Record<string, string> => ({
  input_tokens: rates.input,
  output_tokens: rates.output,
  ...(rates.cacheRead !== undefined ? { input_cache_read_tokens: rates.cacheRead } : {}),
  ...(rates.cacheWrite !== undefined ? { input_cache_write_tokens: rates.cacheWrite } : {}),
});

const pricingForEntry = (id: string): ModelPricing => {
  const base = OPENCODE_GO_BASE_RATES[id]!;
  const tier = OPENCODE_GO_TIER_RATES[id];
  if (tier === undefined) return tokenBasePricing(toPublishedRates(base));
  return modelPricing(
    tokenPricingEntry(toPublishedRates(base)),
    tokenPricingEntry(toPublishedRates(tier), { inputTokens: { operator: 'gte', value: tier.threshold } }),
  );
};

const OPENCODE_GO_MODEL_PRICING: ReadonlyMap<string, ModelPricing> = new Map(
  Object.keys(OPENCODE_GO_BASE_RATES).map(id => [id, pricingForEntry(id)] as const),
);

// Model keys persisted in `usage.model_key` for the OpenCode Go provider are
// the raw upstream ids from `GET /v1/models` — direct lookup against the
// table, no variant-suffix munging.
export const pricingForOpencodeGoModelKey = (modelKey: string): ModelPricing | null =>
  OPENCODE_GO_MODEL_PRICING.get(modelKey) ?? null;
