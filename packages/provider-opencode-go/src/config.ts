// OpenCode Go upstream — the OpenAI-compatible gateway at
// https://opencode.ai/zen/go (see https://opencode.ai/docs/go/). One base URL
// serves models over three wires (/v1/chat/completions, /v1/responses,
// /v1/messages), publishes its live model list at /v1/models, and
// authenticates every call with a bearer API key.
//
// Auth is a single bearer token, sent as `Authorization: Bearer <key>` when
// set and omitted entirely when blank. The base URL defaults to the public
// gateway when the operator leaves it out; a manual `models[]` entry wins
// over an auto-fetched row carrying the same upstream id.

import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/provider';
import { modelsField } from '@floway-dev/provider';

export const OPENCODE_GO_DEFAULT_BASE_URL = 'https://opencode.ai/zen/go';

export interface OpencodeGoUpstreamConfig {
  baseUrl: string;
  // Bearer API key for the gateway. Sent as `Authorization: Bearer <apiKey>`
  // when set; omitted entirely when blank.
  apiKey?: string;
  models: UpstreamModelConfig[];
}

export type OpencodeGoUpstreamRecord = Omit<UpstreamRecord, 'kind'> & {
  kind: 'opencode-go';
  config: OpencodeGoUpstreamConfig;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyStringField = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Malformed opencode-go upstream config: ${field} must be a non-empty string`);
  return value;
};

const baseUrlField = (value: unknown): string => {
  if (value === undefined || value === null) return OPENCODE_GO_DEFAULT_BASE_URL;
  const baseUrl = nonEmptyStringField(value, 'baseUrl').trim();
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('invalid protocol');
    }
  } catch {
    throw new Error('Malformed opencode-go upstream config: baseUrl must be an http(s) URL');
  }
  return baseUrl;
};

const apiKeyField = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('Malformed opencode-go upstream config: apiKey must be a string');
  return value;
};

// Parses an upstream's stored/draft config object.
export const parseOpencodeGoUpstreamConfig = (config: unknown): OpencodeGoUpstreamConfig => {
  if (!isRecord(config)) throw new Error('Malformed opencode-go upstream config: config must be an object');

  const apiKey = apiKeyField(config.apiKey);
  const models = modelsField(config.models ?? [], 'opencode-go');
  if (models.some(model => model.kind === 'rerank')) {
    throw new Error('Malformed opencode-go upstream config: rerank models require a custom upstream');
  }
  return {
    baseUrl: baseUrlField(config.baseUrl),
    ...(apiKey !== undefined ? { apiKey } : {}),
    models,
  };
};

export const assertOpencodeGoUpstreamRecord = (record: UpstreamRecord): OpencodeGoUpstreamRecord => {
  if ((record.kind as string) !== 'opencode-go') throw new Error(`Expected opencode-go upstream record, got ${record.kind}`);
  return { ...record, kind: 'opencode-go', config: parseOpencodeGoUpstreamConfig(record.config) };
};
