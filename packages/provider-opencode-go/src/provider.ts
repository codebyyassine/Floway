// OpenCode Go provider. Builds a ProviderModel catalog from the live
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
// chat-completions wire.
//
// Pricing prefers the generated registry table (see pricing.ts) and falls
// back to the snapshot's own pricing when the table has no entry.
// Reasoning presets come from the generated capabilities table
// (see capabilities.ts); input modalities come from the snapshot.
//
// Manual config.models[] entries are emitted ahead of the auto-fetched
// catalog, and an auto row carrying the same upstreamModelId is dropped so
// the manual copy is the only one for that id.

import { reasoningForOpencodeGoModelKey } from './capabilities.ts';
import { opencodeGoCatalogModelForId, type OpencodeGoCatalogModel, type OpencodeGoEndpointKey } from './catalog.ts';
import { assertOpencodeGoUpstreamRecord, type OpencodeGoUpstreamConfig } from './config.ts';
import { OPENCODE_GO_DEFAULT_FLAGS } from './defaults.ts';
import { fetchOpencodeGoModelIds } from './fetch-models.ts';
import { OPENCODE_GO_SESSION_HEADER, opencodeGoFetchOpenAIChatCompletions, opencodeGoFetchAnthropicMessages, opencodeGoFetchAnthropicMessagesCountTokens, opencodeGoFetchOpenAIResponses, opencodeGoFetchOpenAIResponsesCompact } from './fetch.ts';
import { pricingForOpencodeGoModelKey } from './pricing.ts';
import { readOpencodeGoUpstreamState } from './state.ts';
import { scheduleOpencodeGoUsageProbe } from './usage-probe.ts';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { hasOffPeakPricingEntry, type ModelEndpoints, kindForEndpoints } from '@floway-dev/protocols/common';
import { parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream, type OpenAIResponsesCompactionResult, toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import { headersForAnthropicMessagesCall, jsonRequestBody, manualPeakSchedulesOf, publicModelId, resolveEffectiveFlags, streamingProviderCall, type FetchInit, type FlagId, type HttpHeaderLines, type ProviderInstance, type Provider, type ProviderCallResult, type ProviderModel, type ProviderStreamParser, type UpstreamCallOptions, type UpstreamFetchOptions, type UpstreamProviderKind, type UpstreamRecord } from '@floway-dev/provider';

// providerData carries the raw upstream id verbatim — the same value
// /v1/models returns and the same value the gateway must send back on every
// inference call.
const rawModelIdOf = (model: ProviderModel): string => model.providerData as string;

// One upstream, three wires: each snapshot endpoint key selects exactly one
// outbound route. Live ids absent from the snapshot are refused upstream of
// here (see finalizeOpencodeGoModels); the chat-completions fallback below
// covers only snapshot rows with no endpoint, because the vendor documents
// no row for them.
const ENDPOINTS_BY_KEY: Readonly<Record<OpencodeGoEndpointKey, ModelEndpoints>> = {
  openaiResponses: { openaiResponses: {} },
  anthropicMessages: { anthropicMessages: {} },
  openaiChatCompletions: { openaiChatCompletions: {} },
};

const chatForCatalogModel = (snapshot: OpencodeGoCatalogModel | undefined, id: string): ProviderModel['chat'] => {
  const modalities = snapshot?.modalities;
  const reasoning = reasoningForOpencodeGoModelKey(id);
  if (modalities === undefined && reasoning === null) return undefined;
  return {
    ...(modalities !== undefined ? { modalities: { input: [...modalities], output: ['text'] as const } } : {}),
    ...(reasoning !== null ? { reasoning } : {}),
  };
};

const finalizeOpencodeGoModels = (
  ids: readonly string[],
  enabledFlags: ReadonlySet<FlagId>,
): ProviderModel[] => {
  const models: ProviderModel[] = [];
  for (const id of ids) {
    const snapshot = opencodeGoCatalogModelForId(id);
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
    // `off-peak` entries in this table are the DeepSeek peak/off-peak split
    // (authored peak as Base, registry row as off-peak), so an off-peak
    // entry implies the DeepSeek schedule.
    // https://api-docs.deepseek.com/quick_start/pricing
    if (pricing && hasOffPeakPricingEntry(pricing)) model.peakScheduleId = 'deepseek';
    const chat = chatForCatalogModel(snapshot, id);
    if (chat) model.chat = chat;
    models.push(model);
  }
  return models;
};

export const createOpencodeGoProvider = (record: UpstreamRecord): Provider => {
  const { config } = assertOpencodeGoUpstreamRecord(record);
  const upstreamFlags = resolveEffectiveFlags([OPENCODE_GO_DEFAULT_FLAGS, record.flagOverrides]);
  const state = readOpencodeGoUpstreamState(record.state);

  // Every metered call moves the 5-hour, weekly and monthly windows, and the
  // vendor exposes them only on a separate account endpoint, so each dispatched
  // call arms a debounced background refresh. The interval behind that debounce
  // is deliberately long: the endpoint is an unmemoized join per call, so
  // reading it on every request would cost more than the reading is worth.
  const armProbes = (opts: UpstreamCallOptions): void => {
    scheduleOpencodeGoUsageProbe(record.id, config, state, opts.fetcher, opts.waitUntil);
  };

  // Arms once the upstream round-trip has produced a response, so the reading
  // accounts for the call that just happened. A rate-limited response arms it
  // too -- that is exactly when an operator wants the windows on screen. A
  // transport that threw never reached the account and arms nothing, and token
  // counting never reaches a model at all.
  const withProbes = <T>(opts: UpstreamCallOptions, dispatched: Promise<T>): Promise<T> =>
    dispatched.then(result => {
      armProbes(opts);
      return result;
    });

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
    if (model.peakScheduleId !== undefined) internal.peakScheduleId = model.peakScheduleId;
    else if (pricing && hasOffPeakPricingEntry(pricing)) internal.peakScheduleId = 'deepseek';
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
    callOpenAIChatCompletions: (model, body, signal, opts) => withProbes(opts, callStreaming(opencodeGoFetchOpenAIChatCompletions, model, body, signal, [...opts.headers], parseOpenAIChatCompletionsStream, opts)),
    callOpenAIResponses: async (model, body, action, signal, opts) => {
      switch (action) {
      case 'generate': {
        const stream = await withProbes(opts, callStreaming(opencodeGoFetchOpenAIResponses, model, body, signal, [...opts.headers], parseOpenAIResponsesStream, opts));
        return stream.ok
          ? { action: 'generate', ok: true, events: stream.events, modelKey: stream.modelKey, ...(stream.headers ? { headers: stream.headers } : {}) }
          : { action: 'generate', ok: false, response: stream.response, modelKey: stream.modelKey };
      }
      case 'compact': {
        const rawModelId = rawModelIdOf(model);
        const response = await withProbes(opts, opencodeGoFetchOpenAIResponsesCompact(
          config,
          { method: 'POST', body: jsonRequestBody({ ...toCompactPayloadShape(body), model: rawModelId }), signal },
          { extraHeaders: [...opts.headers], fetcher: opts.fetcher, wrapUpstreamCall: opts.wrapUpstreamCall },
        ));
        return response.ok
          ? { action: 'compact', ok: true, result: (await response.json()) as OpenAIResponsesCompactionResult, modelKey: rawModelId }
          : { action: 'compact', ok: false, response, modelKey: rawModelId };
      }
      default:
        action satisfies never;
        throw new Error(`Unhandled OpenAIResponsesAction: ${action as string}`);
      }
    },
    callAnthropicMessages: (model, body, signal, opts) => withProbes(opts, callStreaming(opencodeGoFetchAnthropicMessages, model, body, signal, headersForAnthropicMessagesCall([...opts.headers], opts.anthropicBeta), parseAnthropicMessagesStream, opts)),
    // Token counting reaches no model and leaves the windows untouched, so it
    // arms nothing.
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
    // The gateway filters the client's request through this allowlist before
    // the provider sees it, so an empty list silently strips the conversation
    // identifier OpenCode Go routes and caches on. Admitting the one name lets a
    // validated client supply its native session header; a client that sends
    // none simply dispatches without it rather than having a fabricated one
    // attributed to it.
    inboundHeaderAllowlist: [OPENCODE_GO_SESSION_HEADER],
    disabledPublicModelIds: record.disabledPublicModelIds,
    blockPeakPricedModels: record.blockPeakPricedModels ?? false,
    peakScheduleOverride: record.peakScheduleOverride,
    manualPeakSchedules: manualPeakSchedulesOf(config),
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    instance,
  };
};
