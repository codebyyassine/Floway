import { OPENCODE_GO_DEFAULT_FLAGS } from './defaults.ts';
import { createOpencodeGoProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const opencodeGoProviderModule: ProviderModule = {
  create: createOpencodeGoProvider,
  defaultFlags: OPENCODE_GO_DEFAULT_FLAGS,
};

export { createOpencodeGoProvider } from './provider.ts';
export { assertOpencodeGoUpstreamRecord, parseOpencodeGoUpstreamConfig, OPENCODE_GO_DEFAULT_BASE_URL, type OpencodeGoUpstreamConfig, type OpencodeGoUpstreamRecord } from './config.ts';
export { pricingForOpencodeGoModelKey } from './pricing.ts';
export { effortForOpencodeGoModelKey, reasoningForOpencodeGoModelKey, type OpencodeGoEffortConfig, type OpencodeGoReasoningConfig } from './capabilities.ts';
export { opencodeGoCatalogModelForId, opencodeGoCatalogModels, type OpencodeGoCatalogModel, type OpencodeGoEndpointKey } from './catalog.ts';
export { fetchOpencodeGoModelIds } from './fetch-models.ts';
export { assertOpencodeGoUpstreamState, emptyOpencodeGoUpstreamState, readOpencodeGoUpstreamState, type OpencodeGoUpstreamState, type OpencodeGoUsageObservation, type OpencodeGoUsageProbeEntry } from './state.ts';
export { OPENCODE_GO_USAGE_PROBE_MIN_INTERVAL_MS, fetchOpencodeGoUsageProbe, isOpencodeGoUsageEnabled, refreshOpencodeGoUsageProbe, scheduleOpencodeGoUsageProbe } from './usage-probe.ts';
