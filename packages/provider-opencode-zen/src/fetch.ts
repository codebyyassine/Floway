// HTTP transport for the OpenCode Zen upstream
// (https://opencode.ai/zen; see https://opencode.ai/docs/zen).
//
// Endpoint paths are fixed: the gateway serves its OpenAI-compat routes
// (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`) and its model
// list (`/v1/models`) from the one base URL, so there is no pathOverrides
// escape hatch the way the generic custom provider needs. Authentication is
// a single bearer API key.

import type { OpencodeZenUpstreamConfig } from './config.ts';
import { type FetchInit, type UpstreamFetchOptions, joinBaseAndPath } from '@floway-dev/provider';

const opencodeZenFetchInternal = async (
  config: OpencodeZenUpstreamConfig,
  path: string,
  init: FetchInit,
  options: UpstreamFetchOptions,
): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (config.apiKey) headers.set('Authorization', `Bearer ${config.apiKey}`);
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (options.extraHeaders) {
    for (const [k, v] of options.extraHeaders) headers.set(k, v);
  }
  return await options.wrapUpstreamCall(() => options.fetcher(joinBaseAndPath(config.baseUrl, path), { ...init, headers }));
};

export const opencodeZenFetchModels = (config: OpencodeZenUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  opencodeZenFetchInternal(config, '/v1/models', init, options);
export const opencodeZenFetchOpenAIChatCompletions = (config: OpencodeZenUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  opencodeZenFetchInternal(config, '/v1/chat/completions', init, options);
export const opencodeZenFetchOpenAIResponses = (config: OpencodeZenUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  opencodeZenFetchInternal(config, '/v1/responses', init, options);
export const opencodeZenFetchOpenAIResponsesCompact = (config: OpencodeZenUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  opencodeZenFetchInternal(config, '/v1/responses/compact', init, options);
export const opencodeZenFetchAnthropicMessages = (config: OpencodeZenUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  opencodeZenFetchInternal(config, '/v1/messages', init, options);
export const opencodeZenFetchAnthropicMessagesCountTokens = (config: OpencodeZenUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  opencodeZenFetchInternal(config, '/v1/messages/count_tokens', init, options);
