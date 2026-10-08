// OpenCode Zen provider. Builds a ProviderModel catalog from the live
// `GET /v1/models` availability signal (see fetch-models.ts) joined against
// the checked-in snapshot (see catalog.ts), and routes inference through the
// gateway's three native wires — `/v1/chat/completions`, `/v1/responses`,
// and `/v1/messages` — plus `/v1/messages/count_tokens` for token counting.
// Authentication is a single bearer API key.
//
// Endpoint → wire mapping comes from the snapshot's per-model `endpoint` key:
// this is the whole point of the provider — one upstream serves all three
// wires, and each model declares which one it speaks. A live model id absent
// from the snapshot (no registry metadata) is refused — filtered out, never
// emitted on a fallback wire. A snapshot row with no endpoint, because the
// vendor's endpoint table documents no row for it, falls back to the default
// chat-completions wire. The one exception is a live id the endpoint table
// wires to a path Floway cannot route (`OPENCODE_ZEN_UNROUTABLE_MODEL_IDS`):
// emitting it would list a model no wire can serve, so it is dropped.
//
// Pricing prefers the generated registry table (see pricing.ts) and falls
// back to the snapshot's own pricing when the table has no entry.
// Reasoning presets come from the generated capabilities table
// (see capabilities.ts); input modalities come from the snapshot.
//
// Manual config.models[] entries are emitted ahead of the auto-fetched
// catalog, and an auto row carrying the same upstreamModelId is dropped so
// the manual copy is the only one for that id.

import { reasoningForOpencodeZenModelKey } from './capabilities.ts';
import { OPENCODE_ZEN_UNROUTABLE_MODEL_IDS, opencodeZenCatalogModelForId, type OpencodeZenCatalogModel, type OpencodeZenEndpointKey } from './catalog.ts';
import { assertOpencodeZenUpstreamRecord, OPENCODE_ZEN_PROVIDER_KIND, type OpencodeZenUpstreamConfig } from './config.ts';
import { OPENCODE_ZEN_DEFAULT_FLAGS } from './defaults.ts';
import { fetchOpencodeZenModelIds } from './fetch-models.ts';
import { opencodeZenFetchOpenAIChatCompletions, opencodeZenFetchAnthropicMessages, opencodeZenFetchAnthropicMessagesCountTokens, opencodeZenFetchOpenAIResponses, opencodeZenFetchOpenAIResponsesCompact } from './fetch.ts';
import { pricingForOpencodeZenModelKey } from './pricing.ts';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { type ModelEndpoints, kindForEndpoints } from '@floway-dev/protocols/common';
import { parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream, type OpenAIResponsesCompactionResult, toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import { headersForAnthropicMessagesCall, jsonRequestBody, publicModelId, resolveEffectiveFlags, streamingProviderCall, type FetchInit, type FlagId, type HttpHeaderLines, type ProviderInstance, type Provider, type ProviderCallResult, type ProviderModel, type ProviderStreamParser, type UpstreamCallOptions, type UpstreamFetchOptions, type UpstreamRecord } from '@floway-dev/provider';

// providerData carries the raw upstream id verbatim — the same value
// /v1/models returns and the same value the gateway must send back on every
// inference call.
const rawModelIdOf = (model: ProviderModel): string => model.providerData as string;

// One upstream, three wires: each snapshot endpoint key selects exactly one
// outbound route. Live ids absent from the snapshot are refused (see
// finalizeOpencodeZenModels); the chat-completions fallback below covers
// only snapshot rows with no endpoint, because the vendor documents no row
// for them — except the ids in OPENCODE_ZEN_UNROUTABLE_MODEL_IDS, whose
// docs-table rows name a path Floway cannot route and which are dropped
// instead of misrouted.
const ENDPOINTS_BY_KEY: Readonly<Record<OpencodeZenEndpointKey, ModelEndpoints>> = {
  openaiResponses: { openaiResponses: {} },
  anthropicMessages: { anthropicMessages: {} },
  openaiChatCompletions: { openaiChatCompletions: {} },
};

const chatForCatalogModel = (snapshot: OpencodeZenCatalogModel | undefined, id: string): ProviderModel['chat'] => {
  const modalities = snapshot?.modalities;
  const reasoning = reasoningForOpencodeZenModelKey(id);
  if (modalities === undefined && reasoning === null) return undefined;
  return {
    ...(modalities !== undefined ? { modalities: { input: [...modalities], output: ['text'] as const } } : {}),
    ...(reasoning !== null ? { reasoning } : {}),
  };
};

const finalizeOpencodeZenModels = (
  ids: readonly string[],
  enabledFlags: ReadonlySet<FlagId>,
): ProviderModel[] => {
  const models: ProviderModel[] = [];
  for (const id of ids) {
    const snapshot = opencodeZenCatalogModelForId(id);
    // Refused: a live id the snapshot does not describe carries no metadata
    // Floway can trust, so it is filtered out rather than emitted on a
    // fallback wire. Manual `config.models[]` entries bypass this path and
    // always emit (see manualModels above).
    if (snapshot === undefined) continue;
    const endpoints = ENDPOINTS_BY_KEY[snapshot.endpoint ?? 'openaiChatCompletions'];
    const limits: ProviderModel['limits'] = {};
    if (snapshot?.maxContextTokens !== undefined) limits.max_context_window_tokens = snapshot.maxContextTokens;
    if (snapshot?.maxOutputTokens !== undefined) limits.max_output_tokens = snapshot.maxOutputTokens;
    const model: ProviderModel = {
      id,
      upstreamModelId: id,
      owned_by: 'opencode',
      limits,
      kind: kindForEndpoints(endpoints),
      endpoints,
      providerData: id,
      enabledFlags,
      opaqueBlobCompatibilityScope: { bindToUpstream: true },
    };
    if (snapshot?.name !== undefined) model.display_name = snapshot.name;
    const pricing = pricingForOpencodeZenModelKey(id) ?? snapshot?.pricing;
    if (pricing) model.pricing = pricing;
    const chat = chatForCatalogModel(snapshot, id);
    if (chat) model.chat = chat;
    models.push(model);
  }
  return models;
};

export const createOpencodeZenProvider = (record: UpstreamRecord): Provider => {
  const { config } = assertOpencodeZenUpstreamRecord(record);
  const upstreamFlags = resolveEffectiveFlags([OPENCODE_ZEN_DEFAULT_FLAGS, record.flagOverrides]);

  // Manual models always emit.
  const overriddenIds = new Set(config.models.map(m => m.upstreamModelId));
  const manualModels: ProviderModel[] = config.models.map(model => {
    const enabledFlags = resolveEffectiveFlags([OPENCODE_ZEN_DEFAULT_FLAGS, record.flagOverrides, model.flagOverrides]);
    const endpoints = model.endpoints;
    const kind = kindForEndpoints(endpoints);
    const internal: ProviderModel = {
      id: publicModelId(model),
      upstreamModelId: model.upstreamModelId,
      limits: { ...(model.limits ?? {}) },
      kind,
      endpoints,
      providerData: model.upstreamModelId,
      enabledFlags,
      opaqueBlobCompatibilityScope: model.opaqueBlobCompatibilityScope ?? { bindToUpstream: true },
    };
    if (model.display_name !== undefined) internal.display_name = model.display_name;
    const pricing = model.pricing ?? pricingForOpencodeZenModelKey(model.upstreamModelId);
    if (pricing) internal.pricing = pricing;
    if (kind === 'chat' && model.chat) internal.chat = model.chat;
    return internal;
  });
  const call = (
    transport: (config: OpencodeZenUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions) => Promise<Response>,
    model: ProviderModel,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    headers: HttpHeaderLines,
    opts: UpstreamCallOptions,
  ): Promise<ProviderCallResult> => {
    const rawModelId = rawModelIdOf(model);
    return transport(
      config,
      { method: 'POST', body: jsonRequestBody({ ...body, model: rawModelId }), signal },
      { extraHeaders: headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
    ).then(response => ({ response, modelKey: rawModelId }));
  };

  const callStreaming = <TEvent>(
    transport: (config: OpencodeZenUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions) => Promise<Response>,
    model: ProviderModel,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    headers: HttpHeaderLines,
    parser: ProviderStreamParser<TEvent>,
    opts: UpstreamCallOptions,
  ) => {
    const rawModelId = rawModelIdOf(model);
    return streamingProviderCall(
      transport(
        config,
        { method: 'POST', body: jsonRequestBody({ ...body, stream: true, model: rawModelId }), signal },
        { extraHeaders: headers, fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
      ),
      parser,
      rawModelId,
      signal,
    );
  };

  const rejectUnsupported = (capability: string) => () =>
    Promise.reject(new Error(`OpenCode Zen provider does not implement ${capability}`));

  const instance: ProviderInstance = {
    getProvidedModels: async fetcher => {
      const ids = await fetchOpencodeZenModelIds(config, fetcher);
      const auto = finalizeOpencodeZenModels(
        // Manual entries are the operator's explicit choice and always emit;
        // auto rows for ids the docs table wires to a path Floway cannot
        // route (see OPENCODE_ZEN_UNROUTABLE_MODEL_IDS) are dropped rather
        // than misrouted on the chat-completions fallback. Live ids absent
        // from the snapshot are refused inside finalizeOpencodeZenModels.
        ids.filter(id => !overriddenIds.has(id) && !OPENCODE_ZEN_UNROUTABLE_MODEL_IDS.has(id)),
        upstreamFlags,
      );
      return [...manualModels, ...auto];
    },
    callOpenAIChatCompletions: (model, body, signal, opts) => callStreaming(opencodeZenFetchOpenAIChatCompletions, model, body, signal, [...opts.headers], parseOpenAIChatCompletionsStream, opts),
    callOpenAIResponses: async (model, body, action, signal, opts) => {
      switch (action) {
      case 'generate': {
        const stream = await callStreaming(opencodeZenFetchOpenAIResponses, model, body, signal, [...opts.headers], parseOpenAIResponsesStream, opts);
        return stream.ok
          ? { action: 'generate', ok: true, events: stream.events, modelKey: stream.modelKey, ...(stream.headers ? { headers: stream.headers } : {}) }
          : { action: 'generate', ok: false, response: stream.response, modelKey: stream.modelKey };
      }
      case 'compact': {
        const rawModelId = rawModelIdOf(model);
        const response = await opencodeZenFetchOpenAIResponsesCompact(
          config,
          { method: 'POST', body: jsonRequestBody({ ...toCompactPayloadShape(body), model: rawModelId }), signal },
          { extraHeaders: [...opts.headers], fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
        );
        return response.ok
          ? { action: 'compact', ok: true, result: (await response.json()) as OpenAIResponsesCompactionResult, modelKey: rawModelId }
          : { action: 'compact', ok: false, response, modelKey: rawModelId };
      }
      default:
        action satisfies never;
        throw new Error(`Unhandled OpenAIResponsesAction: ${action as string}`);
      }
    },
    callAnthropicMessages: (model, body, signal, opts) => callStreaming(opencodeZenFetchAnthropicMessages, model, body, signal, headersForAnthropicMessagesCall([...opts.headers], opts.anthropicBeta), parseAnthropicMessagesStream, opts),
    callAnthropicMessagesCountTokens: (model, body, signal, opts) => call(opencodeZenFetchAnthropicMessagesCountTokens, model, body, signal, headersForAnthropicMessagesCall([...opts.headers], opts.anthropicBeta), opts),
    callAlphaSearch: rejectUnsupported('callAlphaSearch'),
    callOpenAICompletions: rejectUnsupported('callOpenAICompletions'),
    callOpenAIEmbeddings: rejectUnsupported('callOpenAIEmbeddings'),
    callOpenAIImagesGenerations: rejectUnsupported('callOpenAIImagesGenerations'),
    callOpenAIImagesEdits: rejectUnsupported('callOpenAIImagesEdits'),
    callOpenAIAudioTranscriptions: rejectUnsupported('callOpenAIAudioTranscriptions'),
    callRerank: rejectUnsupported('callRerank'),
  };

  return {
    upstreamId: record.id,
    kind: OPENCODE_ZEN_PROVIDER_KIND,
    name: record.name,
    inboundHeaderAllowlist: [],
    disabledPublicModelIds: record.disabledPublicModelIds,
    blockPeakPricedModels: record.blockPeakPricedModels ?? false,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    instance,
  };
};
