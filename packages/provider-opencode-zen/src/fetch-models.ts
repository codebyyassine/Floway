// OpenCode Zen catalog discovery. The gateway publishes its live model list
// at `GET /v1/models` in the OpenAI shape (`{ data: [{ id, ... }] }`). This
// response is the availability signal — which model ids are actually served
// right now — while limits, modalities, wire selection, and fallback pricing
// come from the checked-in snapshot (see catalog.ts).

import type { OpencodeZenUpstreamConfig } from './config.ts';
import { opencodeZenFetchModels } from './fetch.ts';
import { fetchUpstreamModels, type Fetcher, identityWrapUpstreamCall } from '@floway-dev/provider';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const parseModelsResponse = (value: unknown): string[] | null => {
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  const ids: string[] = [];
  for (const item of value.data) {
    if (isRecord(item) && typeof item.id === 'string' && item.id !== '') ids.push(item.id);
  }
  return ids;
};

export const fetchOpencodeZenModelIds = async (config: OpencodeZenUpstreamConfig, fetcher: Fetcher): Promise<string[]> =>
  // Through the shared scaffold so network / non-2xx / shape errors surface
  // as ProviderModelsUnavailableError — the same envelope every other
  // provider's catalog fetch produces.
  await fetchUpstreamModels(
    () => opencodeZenFetchModels(config, { method: 'GET' }, { fetcher, wrapUpstreamCall: identityWrapUpstreamCall }),
    parseModelsResponse,
  );
