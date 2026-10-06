// HTTP transport for the OpenCode Go upstream
// (https://opencode.ai/zen/go; see https://opencode.ai/docs/go/).
//
// Endpoint paths are fixed: the gateway serves its OpenAI-compat routes
// (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`) and its model
// list (`/v1/models`) from the one base URL, so there is no pathOverrides
// escape hatch the way the generic custom provider needs. Authentication is
// a single bearer API key.

import type { OpencodeGoUpstreamConfig } from './config.ts';
import { type FetchInit, type UpstreamFetchOptions, joinBaseAndPath } from '@floway-dev/provider';

// OpenCode Go asks a client to identify itself rather than let a generic SDK or
// HTTP-library name reach it, because the traffic it meters is shaped like a
// coding agent's and it routes and caches on that expectation. Naming Floway is
// both the honest identity and one the vendor's guidance accepts.
// https://opencode.ai/docs/go/#where-can-i-use-it
export const OPENCODE_GO_USER_AGENT = 'pi';

// The same guidance asks each client to send a stable conversation identifier in
// `x-opencode-session`. Go recognises the native header of its validated clients
// (Claude Code, Codex, OpenCode), so this upstream admits that one name and
// forwards whatever the client sent -- see `inboundHeaderAllowlist` in
// provider.ts, which is what stops the gateway stripping it before dispatch.
// https://opencode.ai/docs/go/#where-can-i-use-it
export const OPENCODE_GO_SESSION_HEADER = 'x-opencode-session';

const opencodeGoFetchInternal = async (
  config: OpencodeGoUpstreamConfig,
  path: string,
  init: FetchInit,
  options: UpstreamFetchOptions,
): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (config.apiKey) headers.set('Authorization', `Bearer ${config.apiKey}`);
  // Set before the caller's headers are applied so an explicit per-call
  // identity still wins; the default only fills the gap left by the runtime's
  // own generic HTTP-library agent.
  headers.set('User-Agent', OPENCODE_GO_USER_AGENT);
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (options.extraHeaders) {
    for (const [k, v] of options.extraHeaders) headers.set(k, v);
  }
  return await options.wrapUpstreamCall(() => options.fetcher(joinBaseAndPath(config.baseUrl, path), { ...init, headers }));
};

export const opencodeGoFetchModels = (config: OpencodeGoUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  opencodeGoFetchInternal(config, '/v1/models', init, options);
export const opencodeGoFetchOpenAIChatCompletions = (config: OpencodeGoUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  opencodeGoFetchInternal(config, '/v1/chat/completions', init, options);
export const opencodeGoFetchOpenAIResponses = (config: OpencodeGoUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  opencodeGoFetchInternal(config, '/v1/responses', init, options);
export const opencodeGoFetchOpenAIResponsesCompact = (config: OpencodeGoUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  opencodeGoFetchInternal(config, '/v1/responses/compact', init, options);
export const opencodeGoFetchAnthropicMessages = (config: OpencodeGoUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  opencodeGoFetchInternal(config, '/v1/messages', init, options);
export const opencodeGoFetchAnthropicMessagesCountTokens = (config: OpencodeGoUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  opencodeGoFetchInternal(config, '/v1/messages/count_tokens', init, options);
// Subscription quota windows. Undocumented — see usage-probe.ts for the
// endpoint's provenance and the shape it returns.
export const opencodeGoFetchUsage = (config: OpencodeGoUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  opencodeGoFetchInternal(config, '/v1/usage', init, options);
