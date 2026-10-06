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
} from '../generate-opencode-catalog/generate.ts';

export { OPENCODE_REGISTRY_URL as OPENCODE_GO_REGISTRY_URL };
export const OPENCODE_GO_LIVE_MODELS_URL = 'https://opencode.ai/zen/go/v1/models';
export const OPENCODE_GO_DOCS_URL = 'https://opencode.ai/docs/go';
export const OPENCODE_GO_PROVIDER_BLOCK = 'opencode-go';

export const OPENCODE_GO_SOURCE: OpencodeProviderSource = {
  block: OPENCODE_GO_PROVIDER_BLOCK,
  docsUrl: OPENCODE_GO_DOCS_URL,
  liveModelsUrl: OPENCODE_GO_LIVE_MODELS_URL,
  refreshCommand: 'pnpm tools:generate-opencode-go-catalog',
};

export type OpencodeGoEndpointKey = OpencodeEndpointKey;
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
