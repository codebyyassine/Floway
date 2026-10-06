// OpenCode Zen adapter over the shared OpenCode catalog builder
// (`../generate-opencode-catalog/generate.ts`). The builder is parameterized
// by provider source; this module fixes the Zen source and keeps the
// Zen-specific exported names the CLI and the tests import.

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
} from '../generate-opencode-catalog/generate.ts';

export { OPENCODE_REGISTRY_URL as OPENCODE_ZEN_REGISTRY_URL };
export const OPENCODE_ZEN_LIVE_MODELS_URL = 'https://opencode.ai/zen/v1/models';
export const OPENCODE_ZEN_DOCS_URL = 'https://opencode.ai/docs/zen';
export const OPENCODE_ZEN_PROVIDER_BLOCK = 'opencode';

export const OPENCODE_ZEN_SOURCE: OpencodeProviderSource = {
  block: OPENCODE_ZEN_PROVIDER_BLOCK,
  docsUrl: OPENCODE_ZEN_DOCS_URL,
  liveModelsUrl: OPENCODE_ZEN_LIVE_MODELS_URL,
  refreshCommand: 'pnpm tools:generate-opencode-zen-catalog',
};

export type OpencodeZenEndpointKey = OpencodeEndpointKey;
export type OpencodeZenGeneratedCatalogModel = OpencodeGeneratedCatalogModel;
export type OpencodeZenGeneratedCatalog = OpencodeGeneratedCatalog;
export type OpencodeZenGeneratedPricingTables = OpencodeGeneratedPricingTables;
export type OpencodeZenGeneratedReasoning = OpencodeGeneratedReasoning;
export type OpencodeZenGeneratedCapabilities = OpencodeGeneratedCapabilities;
export type OpencodeZenExcludedModel = OpencodeExcludedModel;
export type OpencodeZenGeneratedSnapshot = OpencodeGeneratedSnapshot;

export { parseOpencodeDocsEndpoints, pricingForRegistryCost, reasoningForRegistryReasoningOptions } from '../generate-opencode-catalog/generate.ts';

// Joins the live Zen availability signal against registry metadata and the
// Zen docs-table endpoints. The live id set is what filters deprecated
// registry rows, matching what OpenCode's own client lists. A live id absent
// from the registry is refused (filtered out); a live id with no docs-table
// row is kept but carries no endpoint; a live id the docs table wires to a
// path Floway cannot route (the `models/*` Gemini paths, the `systemone` Jev
// endpoint) is excluded and reported in `excluded`.
export const buildOpencodeZenSnapshot = (args: {
  registryPayload: unknown;
  liveIds: readonly unknown[];
  docsHtml: string;
}): OpencodeZenGeneratedSnapshot =>
  buildOpencodeSnapshot({ ...args, source: OPENCODE_ZEN_SOURCE });
