// OpenCode Go adapter over the shared OpenCode catalog builder
// (`../generate-opencode-catalog/generate.ts`). The builder is parameterized
// by provider source; this module fixes the Go source and keeps the
// Go-specific exported names the CLI and the tests import.

import {
  buildOpencodeSnapshot,
  OPENCODE_REGISTRY_URL,
  type OpencodeEndpointKey,
  type OpencodeExcludedModel,
  type OpencodeGeneratedCapabilities,
  type OpencodeGeneratedCatalog,
  type OpencodeGeneratedCatalogModel,
  type OpencodeGeneratedPricingTables,
  type OpencodeGeneratedReasoning,
  type OpencodeGeneratedSnapshot,
  type OpencodeProviderSource,
  type OpencodePublishedRates,
} from '../generate-opencode-catalog/generate.ts';

export { OPENCODE_REGISTRY_URL as OPENCODE_GO_REGISTRY_URL };
export const OPENCODE_GO_LIVE_MODELS_URL = 'https://opencode.ai/zen/go/v1/models';
export const OPENCODE_GO_DOCS_URL = 'https://opencode.ai/docs/go';
export const OPENCODE_GO_PROVIDER_BLOCK = 'opencode-go';

// Authored DeepSeek peak rates (USD per 1M tokens) for the Go gateway. The
// live registry publishes only flat off-peak rates for these ids, so peak
// (Base) rates are authored from DeepSeek's own pricing page — peak is Base,
// and the registry row bills the `off-peak` pricingPeriod entry the gateway
// already stamps at request time. Cache writes are free upstream, so no
// cacheWrite metric is recorded, matching the Ollama provider's DeepSeek
// table. Peak windows follow Beijing time with Chinese statutory holidays
// fully off-peak.
// https://api-docs.deepseek.com/quick_start/pricing
// https://github.com/NateScarlet/holiday-cn
export const OPENCODE_GO_DEEPSEEK_PEAK_RATES: Readonly<Record<string, OpencodePublishedRates>> = {
  'deepseek-v4-flash': { input: '0.3', output: '1.2', cacheRead: '0.006' },
  'deepseek-v4-flash-vision-exp': { input: '0.3', output: '1.2', cacheRead: '0.006' },
  'deepseek-v4.1-flash': { input: '0.3', output: '1.2', cacheRead: '0.006' },
  'deepseek-v4-pro': { input: '1.32', output: '3.96', cacheRead: '0.044' },
};

export const OPENCODE_GO_SOURCE: OpencodeProviderSource = {
  block: OPENCODE_GO_PROVIDER_BLOCK,
  docsUrl: OPENCODE_GO_DOCS_URL,
  liveModelsUrl: OPENCODE_GO_LIVE_MODELS_URL,
  refreshCommand: 'pnpm tools:generate-opencode-go-catalog',
  deepseekPeakRates: OPENCODE_GO_DEEPSEEK_PEAK_RATES,
};

export type OpencodeGoEndpointKey = OpencodeEndpointKey;
export type OpencodeGoPublishedRates = OpencodePublishedRates;
export type OpencodeGoGeneratedCatalogModel = OpencodeGeneratedCatalogModel;
export type OpencodeGoGeneratedCatalog = OpencodeGeneratedCatalog;
export type OpencodeGoGeneratedPricingTables = OpencodeGeneratedPricingTables;
export type OpencodeGoGeneratedReasoning = OpencodeGeneratedReasoning;
export type OpencodeGoGeneratedCapabilities = OpencodeGeneratedCapabilities;
export type OpencodeGoExcludedModel = OpencodeExcludedModel;
export type OpencodeGoGeneratedSnapshot = OpencodeGeneratedSnapshot;

export { parseOpencodeDocsEndpoints, pricingForRegistryCost, reasoningForRegistryReasoningOptions } from '../generate-opencode-catalog/generate.ts';

// Joins the live Go availability signal against registry metadata and the Go
// docs-table endpoints. A live id absent from the registry is refused
// (filtered out); a live id with no docs-table row is kept but carries no
// endpoint; a live id the docs table wires to a path Floway cannot route is
// excluded and reported in `excluded`.
export const buildOpencodeGoSnapshot = (args: {
  registryPayload: unknown;
  liveIds: readonly unknown[];
  docsHtml: string;
}): OpencodeGoGeneratedSnapshot =>
  buildOpencodeSnapshot({ ...args, source: OPENCODE_GO_SOURCE });
