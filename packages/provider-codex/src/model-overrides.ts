import type { PublicModelLimits } from '@floway-dev/protocols/common';
import type { ProviderModel } from '@floway-dev/provider';

export interface CodexModelOverride {
  limits?: PublicModelLimits;
  imageInput?: boolean;
  imageDetailOriginal?: boolean;
  reasoningEffort?: { supported: readonly string[]; default: string };
}

export type CodexModelOverrides = Record<string, CodexModelOverride>;

// A local metadata bound, not an allowance advertised by the Codex service.
export const CODEX_OVERRIDE_MAX_TOKENS = 100_000_000;

const objectWithKeys = (value: unknown, label: string, keys: readonly string[]): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!keys.includes(key)) throw new TypeError(`${label}: unknown field ${key}`);
  }
  return object;
};

export const parseCodexModelOverrides = (value: unknown): CodexModelOverrides => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Codex modelOverrides must be an object');
  }
  const entries = Object.entries(value).map(([id, raw]): [string, CodexModelOverride] => {
    if (id.trim().length === 0) throw new TypeError('Codex modelOverrides model ID must not be empty');
    const label = `Codex modelOverrides.${id}`;
    const object = objectWithKeys(raw, label, ['limits', 'imageInput', 'imageDetailOriginal', 'reasoningEffort']);
    const override: CodexModelOverride = {};
    if (object.limits !== undefined) {
      const limits = objectWithKeys(object.limits, `${label}.limits`, ['max_context_window_tokens', 'max_prompt_tokens', 'max_output_tokens']);
      override.limits = {};
      for (const key of ['max_context_window_tokens', 'max_prompt_tokens', 'max_output_tokens'] as const) {
        const tokens = limits[key];
        if (tokens === undefined) continue;
        if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 1 || tokens > CODEX_OVERRIDE_MAX_TOKENS) {
          throw new TypeError(`${label}.limits.${key} must be a whole number between 1 and ${CODEX_OVERRIDE_MAX_TOKENS}`);
        }
        override.limits[key] = tokens;
      }
    }
    for (const key of ['imageInput', 'imageDetailOriginal'] as const) {
      const capability = object[key];
      if (capability === undefined) continue;
      if (typeof capability !== 'boolean') throw new TypeError(`${label}.${key} must be a boolean`);
      override[key] = capability;
    }
    if (object.reasoningEffort !== undefined) {
      const effort = objectWithKeys(object.reasoningEffort, `${label}.reasoningEffort`, ['supported', 'default']);
      if (!Array.isArray(effort.supported) || effort.supported.length === 0
        || effort.supported.some(entry => typeof entry !== 'string' || entry.trim().length === 0)) {
        throw new TypeError(`${label}.reasoningEffort.supported must be a non-empty array of non-empty strings`);
      }
      if (typeof effort.default !== 'string' || !effort.supported.includes(effort.default)) {
        throw new TypeError(`${label}.reasoningEffort.default must be one of the supported efforts`);
      }
      override.reasoningEffort = { supported: [...new Set(effort.supported as string[])], default: effort.default };
    }
    return [id, override];
  });
  return Object.fromEntries(entries);
};

// Apply to the raw cached catalog at read time. Never store this projection in
// the catalog: reset must reveal current upstream metadata, not an old overlay.
export const applyCodexModelOverrides = (model: ProviderModel, overrides: CodexModelOverrides | undefined): ProviderModel => {
  const override = overrides !== undefined && Object.hasOwn(overrides, model.upstreamModelId) ? overrides[model.upstreamModelId] : undefined;
  if (override === undefined || model.kind !== 'chat') return model;
  const contextWindow = override.limits?.max_context_window_tokens;
  const chat = { ...model.chat };
  if (override.imageInput !== undefined) {
    chat.modalities = {
      ...chat.modalities,
      input: override.imageInput ? ['text', 'image'] : ['text'],
      output: chat.modalities?.output ?? ['text'],
    };
  }
  if (override.imageDetailOriginal !== undefined) chat.image_detail_original = override.imageDetailOriginal;
  if (override.reasoningEffort !== undefined) chat.reasoning = { ...chat.reasoning, effort: override.reasoningEffort };
  return {
    ...model,
    limits: { ...model.limits, ...override.limits },
    ...(Object.keys(chat).length > 0 ? { chat } : {}),
    ...(contextWindow === undefined ? {} : { providerData: { ...model.providerData as Record<string, unknown>, contextWindow } }),
  };
};
