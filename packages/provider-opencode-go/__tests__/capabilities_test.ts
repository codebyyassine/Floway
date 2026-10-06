import { test } from 'vitest';

import { effortForOpencodeGoModelKey, reasoningForOpencodeGoModelKey } from '../src/capabilities.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('effortForOpencodeGoModelKey prefers high as the default when the registry offers it', () => {
  assertEquals(effortForOpencodeGoModelKey('grok-4.7'), { supported: ['low', 'medium', 'high', 'xhigh'], default: 'high' });
  assertEquals(effortForOpencodeGoModelKey('space-bunny-free'), { supported: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' });
});

test('effortForOpencodeGoModelKey falls back to the last preset when high is absent', () => {
  assertEquals(effortForOpencodeGoModelKey('kimi-k3'), { supported: ['max'], default: 'max' });
  assertEquals(effortForOpencodeGoModelKey('qwen3.8-flash')?.default, 'xhigh');
});

test('reasoningForOpencodeGoModelKey maps a toggle-only registry row to adaptive reasoning', () => {
  assertEquals(reasoningForOpencodeGoModelKey('minimax-m3'), { adaptive: true });
  assertEquals(reasoningForOpencodeGoModelKey('longcat-2.0'), { adaptive: true });
  assertEquals(effortForOpencodeGoModelKey('minimax-m3'), null);
});

test('reasoningForOpencodeGoModelKey maps registry budget bounds onto budget_tokens', () => {
  assertEquals(reasoningForOpencodeGoModelKey('qwen3.7-max'), { adaptive: true, budget_tokens: { max: 262144 } });
  assertEquals(reasoningForOpencodeGoModelKey('qwen3.6-plus'), { adaptive: true, budget_tokens: { max: 81920 } });
});

test('reasoningForOpencodeGoModelKey returns null for models without registry reasoning options', () => {
  assertEquals(reasoningForOpencodeGoModelKey('mimo-v2.6-pro'), null);
  assertEquals(reasoningForOpencodeGoModelKey('kimi-k2.6'), null);
  assertEquals(reasoningForOpencodeGoModelKey('unknown-model'), null);
  assertEquals(effortForOpencodeGoModelKey('unknown-model'), null);
});
