import type { ChatGatewayCtx } from './gateway-ctx.ts';
import { getRepo } from '../../../repo/index.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ModelCandidate } from '@floway-dev/provider';
import { resolveCodexSessionId } from '@floway-dev/provider-codex';
import { TranslatorInputError } from '@floway-dev/translate';

export const prepareCodexSessionAffinity = async (
  candidates: readonly ModelCandidate[],
  ctx: ChatGatewayCtx,
  headers: Headers,
  payload: CanonicalOpenAIResponsesPayload | (() => Promise<CanonicalOpenAIResponsesPayload | null> | CanonicalOpenAIResponsesPayload | null),
): Promise<{
  readonly candidates: readonly ModelCandidate[];
  readonly succeeded: (candidate: ModelCandidate) => Promise<void>;
}> => {
  const firstCodex = candidates.find(candidate => candidate.provider.kind === 'codex');
  const unchanged = { candidates, succeeded: async () => {} };
  if (firstCodex === undefined) return unchanged;
  let sessionId: string | null;
  if (typeof payload === 'function') {
    sessionId = resolveCodexSessionId({ input: [] }, headers);
    if (sessionId === null) {
      try {
        const translated = await payload();
        sessionId = translated === null ? null : resolveCodexSessionId(translated, headers);
      } catch (error) {
        if (!(error instanceof TranslatorInputError)) throw error;
        return unchanged;
      }
    }
  } else {
    sessionId = resolveCodexSessionId(payload, headers);
  }
  // A request without caller identity or a first user message has no reusable
  // session. Keep the existing fresh-ID and initial-selection behavior.
  if (sessionId === null) return unchanged;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionId));
  const sessionKey = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const repo = getRepo().codexSessionAffinity;
  const existing = await repo.get(ctx.apiKeyId, sessionKey);
  const binding = existing ?? (candidates[0]?.provider.kind === 'codex'
    ? await repo.claim(ctx.apiKeyId, sessionKey, firstCodex.provider.upstreamId)
    : null);
  if (binding === null) {
    return {
      candidates,
      succeeded: async candidate => {
        if (candidate.provider.kind === 'codex') {
          await repo.claim(ctx.apiKeyId, sessionKey, candidate.provider.upstreamId);
        }
      },
    };
  }
  const upstreamId = binding.upstreamId;
  const isBound = (candidate: ModelCandidate) => candidate.provider.kind === 'codex' && candidate.provider.upstreamId === upstreamId;
  return {
    candidates: existing === null && upstreamId === firstCodex.provider.upstreamId
      ? candidates
      : [...candidates.filter(isBound), ...candidates.filter(candidate => !isBound(candidate))],
    succeeded: async candidate => {
      if (candidate.provider.kind === 'codex' && candidate.provider.upstreamId !== upstreamId) {
        // Failover remains available. Only a successful replacement rebinds the
        // session; a stale in-flight request cannot overwrite a newer binding.
        await repo.replace(ctx.apiKeyId, sessionKey, binding.revision, candidate.provider.upstreamId);
      }
    },
  };
};
