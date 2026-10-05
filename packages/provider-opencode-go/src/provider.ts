// OpenCode Go provider. Builds a ProviderModel catalog from the live
// `GET /v1/models` availability signal (see fetch-models.ts) joined against
// the checked-in snapshot (see catalog.ts), and routes inference through the
// gateway's three native wires — `/v1/chat/completions`, `/v1/responses`,
// and `/v1/messages` — plus `/v1/messages/count_tokens` for token counting.
// Authentication is a single bearer API key.
//
// Endpoint → wire mapping comes from the snapshot's per-model `endpoint` key:
// this is the whole point of the provider — one upstream serves all three
// wires, and each model declares which one it speaks. A model id present
// upstream but absent from the snapshot is still emitted with minimal
// metadata (availability outranks metadata completeness) on the default
// chat-completions wire.
//
// Pricing prefers the hand-authored vendor table (see pricing.ts) and falls
// back to the snapshot's own pricing when the table has no entry.
// Reasoning-effort presets come from the hand-authored capabilities table
// (see capabilities.ts); input modalities come from the snapshot.
//
// Manual config.models[] entries are emitted ahead of the auto-fetched
// catalog, and an auto row carrying the same upstreamModelId is dropped so
// the manual copy is the only one for that id.

import { effortForOpencodeGoModelKey } from './capabilities.ts';
import { opencodeGoCatalogModelForId, type OpencodeGoCatalogModel, type OpencodeGoEndpointKey } from './catalog.ts';
import { assertOpencodeGoUpstreamRecord, type OpencodeGoUpstreamConfig } from './config.ts';
import { OPENCODE_GO_DEFAULT_FLAGS } from './defaults.ts';
import { fetchOpencodeGoModelIds } from './fetch-models.ts';
import { opencodeGoFetchOpenAIChatCompletions, opencodeGoFetchAnthropicMessages, opencodeGoFetchAnthropicMessagesCountTokens, opencodeGoFetchOpenAIResponses, opencodeGoFetchOpenAIResponsesCompact } from './fetch.ts';
import { pricingForOpencodeGoModelKey } from './pricing.ts';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { type ModelEndpoints, kindForEndpoints } from '@floway-dev/protocols/common';
import { parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream, type OpenAIResponsesCompactionResult, toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import { headersForAnthropicMessagesCall, jsonRequestBody, publicModelId, resolveEffectiveFlags, streamingProviderCall, type FetchInit, type FlagId, type HttpHeaderLines, type ProviderInstance, type Provider, type ProviderCallResult, type ProviderModel, type ProviderStreamParser, type UpstreamCallOptions, type UpstreamFetchOptions, type UpstreamProviderKind, type UpstreamRecord } from '@floway-dev/provider';

// providerData carries the raw upstream id verbatim — the same value
// /v1/models returns and the same value the gateway must send back on every
// inference call.
const rawModelIdOf = (model: ProviderModel): string => model.providerData as string;

// One upstream, three wires: each snapshot endpoint key selects exactly one
// outbound route. Unknown ids (absent from the snapshot) default to the
// chat-completions wire with no further metadata.
const ENDPOINTS_BY_KEY: Readonly<Record<OpencodeGoEndpointKey, ModelEndpoints>> = {
  openaiResponses: { openaiResponses: {} },
  anthropicMessages: { anthropicMessages: {} },
  openaiChatCompletions: { openaiChatCompletions: {} },
};

const chatForCatalogModel = (snapshot: OpencodeGoCatalogModel | undefined, id: string): ProviderModel['chat'] => {
  const modalities = snapshot?.modalities;
  const effort = effortForOpencodeGoModelKey(id);
  if (modalities === undefined && effort === null) return undefined;
  return {
    ...(modalities !== undefined ? { modalities: { input: [...modalities], output: ['text'] as const } } : {}),
    ...(effort !== null ? { reasoning: { effort } } : {}),
  };
};

const finalizeOpencodeGoModels = (
  ids: readonly string[],
  enabledFlags: ReadonlySet<FlagId>,
): ProviderModel[] => {
  const models: ProviderModel[] = [];
  for (const id of ids) {
    const snapshot = opencodeGoCatalogModelForId(id);
    const endpoints = ENDPOINTS_BY_KEY[snapshot?.endpoint ?? 'openaiChatCompletions'];
    const limits: ProviderModel['limits'] = {};
    if (snapshot?.maxContextTokens !== undefined) limits.max_context_window_tokens = snapshot.maxContextTokens;
    if (snapshot?.maxOutputTokens !== undefined) limits.max_output_tokens = snapshot.maxOutputTokens;
    const model: ProviderModel = {
      id,
      upstreamModelId: id,
      owned_by: 'opencode-go',
      limits,
      kind: kindForEndpoints(endpoints),
      endpoints,
      providerData: id,
      enabledFlags,
      opaqueBlobCompatibilityScope: { bindToUpstream: true },
    };
    if (snapshot?.name !== undefined) model.display_name = snapshot.name;
    const pricing = pricingForOpencodeGoModelKey(id) ?? snapshot?.pricing;
    if (pricing) model.pricing = pricing;
    const chat = chatForCatalogModel(snapshot, id);
    if (chat) model.chat = chat;
    models.push(model);
  }
  return models;
};

export const createOpencodeGoProvider = (record: UpstreamRecord): Provider => {
  const { config } = assertOpencodeGoUpstreamRecord(record);
  const upstreamFlags = resolveEffectiveFlags([OPENCODE_GO_DEFAULT_FLAGS, record.flagOverrides]);

  // Manual models always emit.
  const overriddenIds = new Set(config.models.map(m => m.upstreamModelId));
  const manualModels: ProviderModel[] = config.models.map(model => {
    const enabledFlags = resolveEffectiveFlags([OPENCODE_GO_DEFAULT_FLAGS, record.flagOverrides, model.flagOverrides]);
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
    const pricing = model.pricing ?? pricingForOpencodeGoModelKey(model.upstreamModelId);
    if (pricing) internal.pricing = pricing;
    if (kind === 'chat' && model.chat) internal.chat = model.chat;
    return internal;
  });
  const call = (
    transport: (config: OpencodeGoUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions) => Promise<Response>,
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
    transport: (config: OpencodeGoUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions) => Promise<Response>,
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
    Promise.reject(new Error(`OpenCode Go provider does not implement ${capability}`));

  const instance: ProviderInstance = {
    getProvidedModels: async fetcher => {
      const ids = await fetchOpencodeGoModelIds(config, fetcher);
      const auto = finalizeOpencodeGoModels(
        ids.filter(id => !overriddenIds.has(id)),
        upstreamFlags,
      );
      return [...manualModels, ...auto];
    },
    callOpenAIChatCompletions: (model, body, signal, opts) => callStreaming(opencodeGoFetchOpenAIChatCompletions, model, body, signal, [...opts.headers], parseOpenAIChatCompletionsStream, opts),
    callOpenAIResponses: async (model, body, action, signal, opts) => {
      switch (action) {
      case 'generate': {
        const stream = await callStreaming(opencodeGoFetchOpenAIResponses, model, body, signal, [...opts.headers], parseOpenAIResponsesStream, opts);
        return stream.ok
          ? { action: 'generate', ok: true, events: stream.events, modelKey: stream.modelKey, ...(stream.headers ? { headers: stream.headers } : {}) }
          : { action: 'generate', ok: false, response: stream.response, modelKey: stream.modelKey };
      }
      case 'compact': {
        const rawModelId = rawModelIdOf(model);
        const response = await opencodeGoFetchOpenAIResponsesCompact(
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
    callAnthropicMessages: (model, body, signal, opts) => callStreaming(opencodeGoFetchAnthropicMessages, model, body, signal, headersForAnthropicMessagesCall([...opts.headers], opts.anthropicBeta), parseAnthropicMessagesStream, opts),
    callAnthropicMessagesCountTokens: (model, body, signal, opts) => call(opencodeGoFetchAnthropicMessagesCountTokens, model, body, signal, headersForAnthropicMessagesCall([...opts.headers], opts.anthropicBeta), opts),
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
    kind: 'opencode-go' as UpstreamProviderKind,
    name: record.name,
    inboundHeaderAllowlist: [],
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    instance,
  };
};
