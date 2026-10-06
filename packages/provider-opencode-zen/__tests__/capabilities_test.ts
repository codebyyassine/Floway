import { test } from 'vitest';

import { effortForOpencodeZenModelKey, reasoningForOpencodeZenModelKey } from '../src/capabilities.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('effortForOpencodeZenModelKey prefers high as the default when the registry offers it', () => {
  assertEquals(effortForOpencodeZenModelKey('gpt-5.5'), { supported: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'high' });
  assertEquals(effortForOpencodeZenModelKey('space-bunny-free'), { supported: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' });
});

test('effortForOpencodeZenModelKey falls back to the last preset when high is absent', () => {
  assertEquals(effortForOpencodeZenModelKey('kimi-k3'), { supported: ['max'], default: 'max' });
});

test('reasoningForOpencodeZenModelKey maps a toggle-only registry row to adaptive reasoning', () => {
  assertEquals(reasoningForOpencodeZenModelKey('qwen3.8-max'), { adaptive: true });
  assertEquals(reasoningForOpencodeZenModelKey('kimi-k2.6'), { adaptive: true });
  assertEquals(effortForOpencodeZenModelKey('qwen3.8-max'), null);
});

test('reasoningForOpencodeZenModelKey returns null for models without registry reasoning options', () => {
  assertEquals(reasoningForOpencodeZenModelKey('minimax-m3'), null);
  assertEquals(reasoningForOpencodeZenModelKey('mimo-v2.6-pro'), null);
  assertEquals(reasoningForOpencodeZenModelKey('unknown-model'), null);
  assertEquals(effortForOpencodeZenModelKey('unknown-model'), null);
});
