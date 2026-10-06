// OpenCode Zen upstream — the OpenAI-compatible gateway at
// https://opencode.ai/zen (see https://opencode.ai/docs/zen). One base URL
// serves models over three wires (/v1/chat/completions, /v1/responses,
// /v1/messages), publishes its live model list at /v1/models, and
// authenticates every call with a bearer API key (`OPENCODE_API_KEY`).
//
// Auth is a single bearer token, sent as `Authorization: Bearer <key>` when
// set and omitted entirely when blank. The base URL defaults to the public
// gateway when the operator leaves it out; a manual `models[]` entry wins
// over an auto-fetched row carrying the same upstream id.

import type { UpstreamModelConfig, UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';
import { modelsField } from '@floway-dev/provider';

export const OPENCODE_ZEN_DEFAULT_BASE_URL = 'https://opencode.ai/zen';

// The upstream config kind, registered in `UpstreamProviderKind`
// (`packages/provider/src/model.ts`).
export const OPENCODE_ZEN_PROVIDER_KIND: UpstreamProviderKind = 'opencode';

export interface OpencodeZenUpstreamConfig {
  baseUrl: string;
  // Bearer API key for the gateway. Sent as `Authorization: Bearer <apiKey>`
  // when set; omitted entirely when blank.
  apiKey?: string;
  models: UpstreamModelConfig[];
}

export type OpencodeZenUpstreamRecord = Omit<UpstreamRecord, 'kind'> & {
  kind: 'opencode';
  config: OpencodeZenUpstreamConfig;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyStringField = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Malformed opencode upstream config: ${field} must be a non-empty string`);
  return value;
};

const baseUrlField = (value: unknown): string => {
  if (value === undefined || value === null) return OPENCODE_ZEN_DEFAULT_BASE_URL;
  const baseUrl = nonEmptyStringField(value, 'baseUrl').trim();
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('invalid protocol');
    }
  } catch {
    throw new Error('Malformed opencode upstream config: baseUrl must be an http(s) URL');
  }
  return baseUrl;
};

const apiKeyField = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('Malformed opencode upstream config: apiKey must be a string');
  return value;
};

// Parses an upstream's stored/draft config object.
export const parseOpencodeZenUpstreamConfig = (config: unknown): OpencodeZenUpstreamConfig => {
  if (!isRecord(config)) throw new Error('Malformed opencode upstream config: config must be an object');

  const apiKey = apiKeyField(config.apiKey);
  const models = modelsField(config.models ?? [], 'opencode');
  if (models.some(model => model.kind === 'rerank')) {
    throw new Error('Malformed opencode upstream config: rerank models require a custom upstream');
  }
  return {
    baseUrl: baseUrlField(config.baseUrl),
    ...(apiKey !== undefined ? { apiKey } : {}),
    models,
  };
};

export const assertOpencodeZenUpstreamRecord = (record: UpstreamRecord): OpencodeZenUpstreamRecord => {
  if ((record.kind as string) !== OPENCODE_ZEN_PROVIDER_KIND) throw new Error(`Expected opencode upstream record, got ${record.kind}`);
  return { ...record, kind: 'opencode', config: parseOpencodeZenUpstreamConfig(record.config) };
};
