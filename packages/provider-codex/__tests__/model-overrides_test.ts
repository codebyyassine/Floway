import { describe, expect, test } from 'vitest';

import { assertCodexUpstreamRecord, patchCodexIdentityMetadata } from '../src/config.ts';
import { applyCodexModelOverrides, CODEX_OVERRIDE_MAX_TOKENS, parseCodexModelOverrides } from '../src/model-overrides.ts';
import { codexModelContextWindow, codexRawToProviderModel } from '../src/models.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

const raw = { id: 'gpt-a', display_name: 'A', context_window: 200_000, max_context_window: 400_000, input_modalities: ['text', 'image'] as const, image_detail_original: true, reasoning_efforts: ['low', 'high'], default_reasoning_effort: 'high' };
const model = codexRawToProviderModel(raw, new Set());
const config = { accounts: [{ email: null, chatgptAccountId: null, chatgptUserId: null, planType: null }] };

const record = (value: unknown): UpstreamRecord => ({
  id: 'up', kind: 'codex', name: 'Codex', config: value, state: null, modelsCache: null,
  enabled: true, sortOrder: 0, createdAt: '', updatedAt: '', flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null, hue: 0,
});

describe('Codex model overrides', () => {
  test('partial overrides preserve untouched metadata and explicit false', () => {
    const overrides = parseCodexModelOverrides({ 'gpt-a': { limits: { max_output_tokens: 20_000 }, imageInput: false, imageDetailOriginal: false } });
    const effective = applyCodexModelOverrides(model, overrides);
    expect(effective.limits).toEqual({ max_context_window_tokens: 400_000, max_output_tokens: 20_000 });
    expect(effective.chat?.modalities?.input).toEqual(['text']);
    expect(effective.chat?.image_detail_original).toBe(false);
    expect(effective.chat?.reasoning).toEqual(model.chat?.reasoning);
    expect(effective.pricing).toEqual(model.pricing);
    expect(codexModelContextWindow(effective).context_window).toBe(200_000);
    expect(model.chat?.image_detail_original).toBe(true);
  });

  test('context override reaches the private Codex default as well as public limits', () => {
    const effective = applyCodexModelOverrides(model, { 'gpt-a': { limits: { max_context_window_tokens: 300_000, max_prompt_tokens: 250_000 } } });
    expect(codexModelContextWindow(effective)).toEqual({ context_window: 300_000, max_context_window: 300_000 });
    expect(effective.limits.max_prompt_tokens).toBe(250_000);
  });

  test('catalog updates survive for unset fields, field reset reveals latest defaults', () => {
    const overrides = { 'gpt-a': { limits: { max_output_tokens: 15_000 }, imageDetailOriginal: false } };
    const refreshed = codexRawToProviderModel({ ...raw, context_window: 600_000, max_context_window: 800_000 }, new Set());
    const effective = applyCodexModelOverrides(refreshed, overrides);
    expect(effective.limits).toEqual({ max_context_window_tokens: 800_000, max_output_tokens: 15_000 });
    expect(codexModelContextWindow(effective).context_window).toBe(600_000);
    expect(applyCodexModelOverrides(refreshed, { 'gpt-a': { imageDetailOriginal: false } }).limits.max_output_tokens).toBeUndefined();
    expect(applyCodexModelOverrides(refreshed, {})).toBe(refreshed);
  });

  test('uses stable upstream ID, does not affect other models or images', () => {
    const overrides = { 'gpt-a': { limits: { max_output_tokens: 10 }, imageInput: false } };
    expect(applyCodexModelOverrides({ ...model, id: 'prefix/gpt-a' }, overrides).limits.max_output_tokens).toBe(10);
    const other = { ...model, upstreamModelId: 'gpt-b' };
    expect(applyCodexModelOverrides(other, overrides)).toBe(other);
    const image = { ...model, kind: 'image' as const };
    expect(applyCodexModelOverrides(image, overrides)).toBe(image);
  });

  test('retains open-string reasoning effort values and validates the paired default', () => {
    const overrides = parseCodexModelOverrides({ 'gpt-a': { reasoningEffort: { supported: ['future', 'high', 'future'], default: 'future' } } });
    expect(applyCodexModelOverrides(model, overrides).chat?.reasoning?.effort).toEqual({ supported: ['future', 'high'], default: 'future' });
  });

  test('config patch persists overrides independently of identity and resets the map', () => {
    const overrides = { 'gpt-a': { imageDetailOriginal: false, limits: { max_output_tokens: 100 } } };
    const patched = patchCodexIdentityMetadata(config as Parameters<typeof patchCodexIdentityMetadata>[0], { modelOverrides: overrides });
    const roundTrip = JSON.parse(JSON.stringify(patched));
    expect(() => assertCodexUpstreamRecord(record(roundTrip))).not.toThrow();
    expect(roundTrip.modelOverrides).toEqual(overrides);
    expect(patchCodexIdentityMetadata(patched, { accounts: [{ email: 'operator@example.com' }] }).modelOverrides).toEqual(overrides);
    expect(patchCodexIdentityMetadata(patched, { modelOverrides: {} }).modelOverrides).toEqual({});
    expect(patched.accounts).toEqual(config.accounts);
  });

  test.each([0, -1, 1.5, Number.NaN, Infinity, '100', null, CODEX_OVERRIDE_MAX_TOKENS + 1])('rejects invalid token count %s', value => {
    expect(() => parseCodexModelOverrides({ a: { limits: { max_output_tokens: value } } })).toThrow(/whole number/);
  });
  test.each([
    null, [], { '': {} }, { a: null }, { a: { unexpected: 1 } },
    { a: { limits: { unknown: 1 } } }, { a: { imageInput: 'false' } }, { a: { imageDetailOriginal: 0 } },
    { a: { reasoningEffort: { supported: [], default: '' } } },
    { a: { reasoningEffort: { supported: ['high'], default: 'low' } } },
    { a: { reasoningEffort: { supported: [1], default: '1' } } },
  ])('rejects malformed overrides %j', value => {
    expect(() => parseCodexModelOverrides(value)).toThrow();
  });
  test('accepts numeric boundaries and prototype-like model IDs without leaking inherited properties', () => {
    const overrides = parseCodexModelOverrides(JSON.parse('{"__proto__":{"limits":{"max_output_tokens":1}},"constructor":{"limits":{"max_output_tokens":100000000}}}'));
    expect(Object.keys(overrides)).toEqual(['__proto__', 'constructor']);
    expect(parseCodexModelOverrides({ a: { limits: { max_output_tokens: CODEX_OVERRIDE_MAX_TOKENS } } }).a?.limits?.max_output_tokens).toBe(CODEX_OVERRIDE_MAX_TOKENS);
  });
});
