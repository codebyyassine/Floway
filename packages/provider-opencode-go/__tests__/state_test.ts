import { test } from 'vitest';

import { assertOpencodeGoUpstreamState, emptyOpencodeGoUpstreamState, readOpencodeGoUpstreamState } from '../src/state.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('readOpencodeGoUpstreamState treats absent state as an empty slot', () => {
  assertEquals(readOpencodeGoUpstreamState(null), { usageProbe: null });
  assertEquals(readOpencodeGoUpstreamState(undefined), { usageProbe: null });
  assertEquals(emptyOpencodeGoUpstreamState(), { usageProbe: null });
});

test('readOpencodeGoUpstreamState round-trips a full probe entry', () => {
  const entry = {
    usageProbe: {
      attemptedAt: 1_786_000_000_000,
      observation: { fetchedAt: 1_786_000_000_000, data: { usage: {} } },
      error: null,
    },
  };
  assertEquals(readOpencodeGoUpstreamState(entry), entry);
  assertOpencodeGoUpstreamState(entry);
});

test('readOpencodeGoUpstreamState normalizes absent optional fields to null', () => {
  assertEquals(
    readOpencodeGoUpstreamState({ usageProbe: { attemptedAt: 1_786_000_000_000 } }),
    { usageProbe: { attemptedAt: 1_786_000_000_000, observation: null, error: null } },
  );
  assertEquals(readOpencodeGoUpstreamState({}), { usageProbe: null });
});

test('readOpencodeGoUpstreamState rejects unknown keys to keep the on-disk shape closed', () => {
  assertThrows(() => readOpencodeGoUpstreamState({ usageProbe: null, account: null }));
  assertThrows(() => readOpencodeGoUpstreamState({ usageProbe: { attemptedAt: 1, observation: null, error: null, extra: 1 } }));
  assertThrows(() => readOpencodeGoUpstreamState({ usageProbe: { attemptedAt: 1, observation: { fetchedAt: 1, data: {}, extra: 1 }, error: null } }));
});

test('readOpencodeGoUpstreamState rejects a non-finite attempt time', () => {
  assertThrows(() => readOpencodeGoUpstreamState({ usageProbe: { attemptedAt: Number.NaN, observation: null, error: null } }));
  assertThrows(() => readOpencodeGoUpstreamState({ usageProbe: { attemptedAt: 'now', observation: null, error: null } }));
});

test('readOpencodeGoUpstreamState requires the stored body to be a plain object', () => {
  assertThrows(() => readOpencodeGoUpstreamState({ usageProbe: { attemptedAt: 1, observation: { fetchedAt: 1, data: [1] }, error: null } }));
  assertThrows(() => readOpencodeGoUpstreamState({ usageProbe: { attemptedAt: 1, observation: { fetchedAt: 1, data: 'usage' }, error: null } }));
});
