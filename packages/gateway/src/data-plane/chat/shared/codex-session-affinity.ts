import type { ChatGatewayCtx } from './gateway-ctx.ts';
import { getRepo } from '../../../repo/index.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ModelCandidate } from '@floway-dev/provider';
import { resolveCodexSessionId } from '@floway-dev/provider-codex';

export const prepareCodexSessionAffinity = async (
  candidates: readonly ModelCandidate[],
  ctx: ChatGatewayCtx,
  headers: Headers,
  payload: () => Promise<CanonicalOpenAIResponsesPayload> | CanonicalOpenAIResponsesPayload,
): Promise<{
  readonly candidates: readonly ModelCandidate[];
  readonly succeeded: (candidate: ModelCandidate) => Promise<void>;
}> => {
  const firstCodex = candidates.find(candidate => candidate.provider.kind === 'codex');
  const unchanged = { candidates, succeeded: async () => {} };
  if (firstCodex === undefined) return unchanged;
  const sessionId = resolveCodexSessionId(await payload(), headers);
  // A request without caller identity or a first user message has no reusable
  // session. Keep the existing fresh-ID and initial-selection behavior.
  if (sessionId === null) return unchanged;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionId));
  const sessionKey = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const repo = getRepo().codexSessionAffinity;
  const binding = await repo.claim(ctx.apiKeyId, sessionKey, firstCodex.provider.upstreamId);
  const upstreamId = binding.upstreamId;
  const codex = candidates.filter(candidate => candidate.provider.kind === 'codex');
  const ordered = [
    ...codex.filter(candidate => candidate.provider.upstreamId === upstreamId),
    ...codex.filter(candidate => candidate.provider.upstreamId !== upstreamId),
  ];
  let index = 0;
  return {
    // Other providers keep their slots and order. Required opaque-state
    // affinity and model/access restrictions have already narrowed this list.
    candidates: candidates.map(candidate => candidate.provider.kind === 'codex' ? ordered[index++]! : candidate),
    succeeded: async candidate => {
      if (candidate.provider.kind === 'codex' && candidate.provider.upstreamId !== upstreamId) {
        // Failover remains available. Only a successful replacement rebinds the
        // session; a stale in-flight request cannot overwrite a newer binding.
        await repo.replace(ctx.apiKeyId, sessionKey, binding.revision, candidate.provider.upstreamId);
      }
    },
  };
};
