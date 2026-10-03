import { expect, test, vi } from 'vitest';

import { prepareCodexSessionAffinity } from '../../../../src/data-plane/chat/shared/codex-session-affinity.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { stubModelCandidate } from '@floway-dev/test-utils';
import { TranslatorInputError } from '@floway-dev/translate';

const candidate = (id: string, kind: 'custom' | 'codex') => {
  const base = stubModelCandidate();
  return { ...base, provider: { ...base.provider, upstreamId: id, kind } };
};
const payload: CanonicalOpenAIResponsesPayload = { model: 'gpt-5.4', input: [], stream: true };
const headers = new Headers({ 'session-id': 'session' });

test.each(['session-id', 'session_id', 'x-codex-turn-metadata'])('explicit %s identity bypasses translated payload preparation', async header => {
  initRepo(new InMemoryRepo());
  const ctx = mockChatGatewayCtx();
  const a = candidate('a', 'codex');
  const b = candidate('b', 'codex');
  const produce = vi.fn(() => { throw new TranslatorInputError('not translatable'); });
  const explicit = new Headers({ [header]: header === 'x-codex-turn-metadata' ? '{"session_id":"session"}' : 'session' });
  await prepareCodexSessionAffinity([a, b], ctx, headers, payload);
  const selection = await prepareCodexSessionAffinity([b, a], ctx, explicit, produce);
  expect(selection.candidates).toEqual([a, b]);
  expect(produce).not.toHaveBeenCalled();
});

test('untranslatable conversation identity leaves candidate dispatch and selection intact', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const claim = vi.spyOn(repo.codexSessionAffinity, 'claim');
  const candidates = [candidate('custom', 'custom'), candidate('codex', 'codex')];
  const produce = vi.fn(() => { throw new TranslatorInputError('not translatable'); });
  const selection = await prepareCodexSessionAffinity(candidates, mockChatGatewayCtx(), new Headers(), produce);
  expect(produce).toHaveBeenCalledOnce();
  expect(selection.candidates).toBe(candidates);
  await selection.succeeded(candidates[0]);
  expect(claim).not.toHaveBeenCalled();
});

test('canonical body identity retains precedence over headers', async () => {
  initRepo(new InMemoryRepo());
  const ctx = mockChatGatewayCtx();
  const a = candidate('a', 'codex');
  const b = candidate('b', 'codex');
  await prepareCodexSessionAffinity([a, b], ctx, headers, payload);
  const selection = await prepareCodexSessionAffinity([b, a], ctx, new Headers({ 'session-id': 'other' }), {
    ...payload, client_metadata: { session_id: 'session' },
  });
  expect(selection.candidates).toEqual([a, b]);
});

test('other providers retain exact selection and never evaluate Codex identity or access its repository', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const claim = vi.spyOn(repo.codexSessionAffinity, 'claim');
  const produce = vi.fn(() => payload);
  const candidates = [candidate('custom-a', 'custom'), candidate('custom-b', 'custom')];
  const selection = await prepareCodexSessionAffinity(candidates, mockChatGatewayCtx(), headers, produce);
  expect(selection.candidates).toBe(candidates);
  await selection.succeeded(candidates[0]);
  expect(produce).not.toHaveBeenCalled();
  expect(claim).not.toHaveBeenCalled();
});

test('Codex affinity reorders only Codex slots and never restores a filtered account', async () => {
  initRepo(new InMemoryRepo());
  const ctx = mockChatGatewayCtx();
  const a = candidate('a', 'codex');
  const b = candidate('b', 'codex');
  const customA = candidate('custom-a', 'custom');
  const customB = candidate('custom-b', 'custom');
  await prepareCodexSessionAffinity([a, b], ctx, headers, () => payload);
  const reordered = await prepareCodexSessionAffinity([customA, b, customB, a], ctx, headers, () => payload);
  expect(reordered.candidates).toEqual([customA, a, customB, b]);
  const filtered = await prepareCodexSessionAffinity([b], ctx, headers, () => payload);
  expect(filtered.candidates).toEqual([b]);
  await filtered.succeeded(b);
  const next = await prepareCodexSessionAffinity([a, b], ctx, headers, () => payload);
  expect(next.candidates).toEqual([b, a]);
});

test('a late success from an older failover attempt cannot undo the winning replacement', async () => {
  initRepo(new InMemoryRepo());
  const ctx = mockChatGatewayCtx();
  const a = candidate('a', 'codex');
  const b = candidate('b', 'codex');
  const c = candidate('c', 'codex');
  const older = await prepareCodexSessionAffinity([a, b, c], ctx, headers, () => payload);
  const newer = await prepareCodexSessionAffinity([a, b, c], ctx, headers, () => payload);
  await newer.succeeded(b);
  await older.succeeded(c);
  const next = await prepareCodexSessionAffinity([a, b, c], ctx, headers, () => payload);
  expect(next.candidates).toEqual([b, a, c]);
});
