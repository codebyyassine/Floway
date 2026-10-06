// Generated reasoning-capability table for the OpenCode Zen provider, read off
// the checked-in registry snapshot (`src/capabilities.generated.json`).
//
// The registry's per-model `reasoning_options` map onto the Floway reasoning
// shape: named `effort` presets (defaulting to `high` when offered, else the
// last preset), `budget_tokens` bounds for the operator-supplied budget, and
// `adaptive` when the model decides its own reasoning depth.
//
// Provenance: generated from https://models.opencode.ai/api.json, provider
// block `opencode` — the same registry OpenCode itself reads. Refresh with:
//   pnpm tools:generate-opencode-zen-catalog

import capabilitiesJson from './capabilities.generated.json' with { type: 'json' };
import type { ChatModelInfo } from '@floway-dev/protocols/common';

export interface OpencodeZenEffortConfig {
  readonly supported: readonly string[];
  readonly default: string;
}

export type OpencodeZenReasoningConfig = NonNullable<ChatModelInfo['reasoning']>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalNonNegativeInt = (value: unknown, label: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Malformed opencode capabilities snapshot: ${label} must be a non-negative safe integer`);
  }
  return value;
};

const reasoningOf = (value: unknown, label: string): OpencodeZenReasoningConfig | null => {
  if (!isRecord(value)) throw new Error(`Malformed opencode capabilities snapshot: ${label} must be an object`);
  const reasoning: { effort?: { supported: string[]; default: string }; budget_tokens?: { min?: number; max?: number }; adaptive?: boolean } = {};
  if (value.effort !== undefined) {
    if (!isRecord(value.effort) || !Array.isArray(value.effort.supported)) {
      throw new Error(`Malformed opencode capabilities snapshot: ${label}.effort must be an object with a supported array`);
    }
    const supported = value.effort.supported.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
    if (supported.length === 0) throw new Error(`Malformed opencode capabilities snapshot: ${label}.effort.supported must be non-empty`);
    if (typeof value.effort.default !== 'string' || !supported.includes(value.effort.default)) {
      throw new Error(`Malformed opencode capabilities snapshot: ${label}.effort.default must be one of supported`);
    }
    reasoning.effort = { supported, default: value.effort.default };
  }
  if (value.budget_tokens !== undefined) {
    if (!isRecord(value.budget_tokens)) throw new Error(`Malformed opencode capabilities snapshot: ${label}.budget_tokens must be an object`);
    const min = optionalNonNegativeInt(value.budget_tokens.min, `${label}.budget_tokens.min`);
    const max = optionalNonNegativeInt(value.budget_tokens.max, `${label}.budget_tokens.max`);
    if (min !== undefined && max !== undefined && max < min) {
      throw new Error(`Malformed opencode capabilities snapshot: ${label}.budget_tokens.max must be >= min`);
    }
    reasoning.budget_tokens = { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  }
  if (value.adaptive !== undefined) {
    if (value.adaptive !== true) throw new Error(`Malformed opencode capabilities snapshot: ${label}.adaptive must be true when present`);
    reasoning.adaptive = true;
  }
  if (reasoning.effort === undefined && reasoning.budget_tokens === undefined && reasoning.adaptive === undefined) return null;
  return reasoning;
};

const parseCapabilities = (value: unknown): ReadonlyMap<string, OpencodeZenReasoningConfig> => {
  if (!isRecord(value) || !isRecord(value.models)) {
    throw new Error('Malformed opencode capabilities snapshot: expected { models }');
  }
  const capabilities = new Map<string, OpencodeZenReasoningConfig>();
  for (const [id, entry] of Object.entries(value.models)) {
    const reasoning = reasoningOf(entry, `opencode capabilities model ${id}`);
    if (reasoning !== null) capabilities.set(id, reasoning);
  }
  return capabilities;
};

const OPENCODE_ZEN_REASONING: ReadonlyMap<string, OpencodeZenReasoningConfig> = parseCapabilities(capabilitiesJson as unknown);

export const reasoningForOpencodeZenModelKey = (modelKey: string): OpencodeZenReasoningConfig | null =>
  OPENCODE_ZEN_REASONING.get(modelKey) ?? null;

export const effortForOpencodeZenModelKey = (modelKey: string): OpencodeZenEffortConfig | null =>
  reasoningForOpencodeZenModelKey(modelKey)?.effort ?? null;
