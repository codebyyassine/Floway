import { OPENCODE_ZEN_DEFAULT_FLAGS } from './defaults.ts';
import { createOpencodeZenProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const opencodeZenProviderModule: ProviderModule = {
  create: createOpencodeZenProvider,
  defaultFlags: OPENCODE_ZEN_DEFAULT_FLAGS,
};

export { createOpencodeZenProvider } from './provider.ts';
export { assertOpencodeZenUpstreamRecord, parseOpencodeZenUpstreamConfig, OPENCODE_ZEN_DEFAULT_BASE_URL, OPENCODE_ZEN_PROVIDER_KIND, type OpencodeZenUpstreamConfig, type OpencodeZenUpstreamRecord } from './config.ts';
export { pricingForOpencodeZenModelKey } from './pricing.ts';
export { effortForOpencodeZenModelKey, reasoningForOpencodeZenModelKey, type OpencodeZenEffortConfig, type OpencodeZenReasoningConfig } from './capabilities.ts';
export { opencodeZenCatalogModelForId, opencodeZenCatalogModels, OPENCODE_ZEN_UNROUTABLE_MODEL_IDS, type OpencodeZenCatalogModel, type OpencodeZenEndpointKey } from './catalog.ts';
export { fetchOpencodeZenModelIds } from './fetch-models.ts';
