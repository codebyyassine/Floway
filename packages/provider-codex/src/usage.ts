// Codex usage state has two sources, and they project into the same slot:
//
//   1. `x-codex-*` response headers, set by the Codex data plane on every
//      `/codex/responses` call. This is the passive source: it costs nothing
//      and tracks consumption from every client sharing the seat, not just
//      ours (see quota.ts).
//   2. `GET /wham/usage` on the ChatGPT backend, the operator-driven refresh
//      below. This is the active source: a token-free read — unlike a minimal
//      `/responses` call it consumes no quota — and the only source for an
//      upstream that has not served a request yet.
//
// Both project into `CodexQuotaSnapshot` so the dashboard renders one shape
// regardless of which path filled the slot. The active read carries no
// `active_limit`, so `putCodexQuota` projects it into the latest named bucket
// when one exists rather than forking an `unknown` card beside it; only an
// account with no named reading yet keeps the `unknown` key.
//
// Body shape (every field optional; three independent third-party gateways
// describe the same wire):
// https://github.com/james-6-23/codex2api/blob/main/proxy/usage_wham.go
// https://github.com/can1357/oh-my-pi/blob/main/packages/ai/src/usage/openai-codex.ts
// https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/service/openai_quota_service.go
//
// Three facts shape how the body is read:
//
// - `used_percent` is 0..100 already, matching the quota headers beside it —
//   rescaling here would be a 100x error, so the body is stored verbatim and
//   never normalized. Blank rather than absent is how this backend reports a
//   field that does not apply, and `Number('')` is 0, so a blank reading is
//   "not observed", never a confident zero.
// - `reset_at` is unix seconds on the wire today. The quota headers once
//   arrived as RFC 3339 for three days after they landed, so the same
//   tolerance applies here: unix seconds, millisecond-scale epochs, and RFC
//   3339 strings all date the reset, and `reset_after_seconds` is the fallback
//   when `reset_at` is absent.
// - A present-but-wrong-typed field is malformed input, not a default: it
//   throws rather than projecting a guess. Absent, null, and blank stay
//   "not observed", and a body that reports nothing projects to null so the
//   refresh leaves a previously persisted snapshot untouched.

import { ensureCodexAccessToken, mintCodexAccessToken } from './access-token.ts';
import {
  CODEX_BACKEND_BASE,
  CODEX_USAGE_PATH,
  CODEX_USER_AGENT,
} from './constants.ts';
import { hasCodexQuotaReading, putCodexQuota } from './quota.ts';
import {
  findCodexAccountIndex,
  persistCodexRefreshTokenRotation,
  readCodexUpstreamState,
  replaceCodexAccount,
  type CodexAccountCredential,
  type CodexQuotaSnapshot,
  type CodexUpstreamState,
} from './state.ts';
import { getProviderRepo, type Fetcher } from '@floway-dev/provider';

// The endpoint is a live backend read per call, so this is deliberately
// coarse: a busy upstream refreshes every five minutes, an idle one not at
// all. A failed probe advances the same stamp, so a broken credential
// retries on this cadence instead of every tick.
export const CODEX_USAGE_PROBE_MIN_INTERVAL_MS = 5 * 60_000;

// One rolling window. The upstream sends numbers; blank strings read as
// absent (see the header convention in quota.ts) and anything else
// string-typed is validated rather than coerced silently.
export interface CodexUsageWindowPayload {
  used_percent?: number | string | null;
  limit_window_seconds?: number | string | null;
  reset_after_seconds?: number | string | null;
  // Unix seconds on the wire; RFC 3339 strings and millisecond-scale epochs
  // are tolerated when projecting.
  reset_at?: number | string | null;
}

export interface CodexUsageRateLimitPayload {
  allowed?: boolean | null;
  limit_reached?: boolean | null;
  primary_window?: CodexUsageWindowPayload | null;
  secondary_window?: CodexUsageWindowPayload | null;
}

export interface CodexUsageCreditsPayload {
  has_credits?: boolean | null;
  unlimited?: boolean | null;
  overage_limit_reached?: boolean | null;
  balance?: string | number | null;
}

// The rest of the wire is enumerated so the next feature that wants one of
// these can see it is already described. Nothing below is projected: the
// dashboard's only reader is quota-shaped, and projecting one into the
// snapshot would mean a field that silently blanks out whenever the passive
// path wins the race.
export interface CodexUsageAdditionalRateLimitPayload {
  limit_name?: string | null;
  metered_feature?: string | null;
  rate_limit?: unknown;
}

export interface CodexUsageSpendControlPayload {
  reached?: boolean | null;
}

export interface CodexUsageRateLimitResetCreditsPayload {
  available_count?: number | null;
  applicable_available_count?: number | null;
}

export interface CodexUsageResponse {
  plan_type?: string | null;
  rate_limit?: CodexUsageRateLimitPayload | null;
  additional_rate_limits?: CodexUsageAdditionalRateLimitPayload[] | null;
  credits?: CodexUsageCreditsPayload | null;
  spend_control?: CodexUsageSpendControlPayload | null;
  rate_limit_reset_credits?: CodexUsageRateLimitResetCreditsPayload | null;
}

const headersFor = (accessToken: string, accountId: string | null): Headers => new Headers({
  authorization: `Bearer ${accessToken}`,
  // A null account id omits the header rather than sending an empty one: the
  // upstream reads absence as "whichever account this bearer belongs to".
  ...(accountId === null ? {} : { 'chatgpt-account-id': accountId }),
  'user-agent': CODEX_USER_AGENT,
  accept: 'application/json',
});

export const fetchCodexUsage = async (opts: {
  accessToken: string;
  accountId: string | null;
  fetcher: Fetcher;
  signal?: AbortSignal;
}): Promise<CodexUsageResponse> => {
  const response = await opts.fetcher(`${CODEX_BACKEND_BASE}${CODEX_USAGE_PATH}`, {
    method: 'GET',
    headers: headersFor(opts.accessToken, opts.accountId),
    signal: opts.signal,
  });
  // The body is the operator-facing half of each message, so it is trimmed
  // and capped: an upstream error page is not the quota card.
  const rawText = await response.text();
  const body = rawText.trim().slice(0, 256);
  if (response.status === 401) {
    throw new Error(`Codex /wham/usage rejected the access token (401): ${body}`);
  }
  if (!response.ok) {
    throw new Error(`Codex /wham/usage returned ${response.status}: ${body}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    throw new Error(`Codex /wham/usage returned a non-JSON body (${response.status})`, { cause: cause as Error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Codex /wham/usage returned a non-object body (${response.status})`);
  }
  return parsed as CodexUsageResponse;
};

const where = 'Codex /wham/usage response';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Absent, null, and blank are "not observed". Anything else must be a finite
// number: a present-but-unparseable value is malformed input and throws
// rather than projecting a guess.
const finiteNumberOrNull = (value: unknown, path: string): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new TypeError(`${where}.${path} must be a finite number`);
    return parsed;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${where}.${path} must be a finite number`);
  }
  return value;
};

// Millisecond-scale epochs stay at or above 1e12 until the year 33658, while
// second-scale epochs stay below it; the comparison is what tells them apart.
const MILLISECONDS_EPOCH_THRESHOLD = 1_000_000_000_000;

const usageResetAtInstant = (value: unknown, path: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    // Zero and negative mean "this plan has no such window" rather than "it
    // resets now" — the same convention as the quota headers in quota.ts.
    if (!Number.isFinite(value) || value <= 0) return undefined;
    const millis = value >= MILLISECONDS_EPOCH_THRESHOLD ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return usageResetAtInstant(Number(trimmed), path);
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) throw new TypeError(`${where}.${path} must be unix seconds or an RFC 3339 instant`);
    return new Date(parsed).toISOString();
  }
  throw new TypeError(`${where}.${path} must be unix seconds or an RFC 3339 instant`);
};

const usageResetAfterSeconds = (value: unknown, path: string): number | undefined => {
  const seconds = finiteNumberOrNull(value, path);
  if (seconds === null || seconds <= 0) return undefined;
  return seconds;
};

type CodexUsageWindowPrefix = 'primary' | 'secondary';

const windowKeys = {
  primary: {
    used: 'primary_used_percent',
    minutes: 'primary_window_minutes',
    reset: 'primary_reset_after_at',
  },
  secondary: {
    used: 'secondary_used_percent',
    minutes: 'secondary_window_minutes',
    reset: 'secondary_reset_after_at',
  },
} as const;

const projectCodexUsageWindow = (
  window: unknown,
  prefix: CodexUsageWindowPrefix,
  snapshot: CodexQuotaSnapshot,
  now: Date,
): void => {
  if (window === undefined || window === null) return;
  if (!isRecord(window)) throw new TypeError(`${where}.rate_limit.${prefix}_window must be an object when present`);
  const keys = windowKeys[prefix];
  const path = `rate_limit.${prefix}_window`;

  const used = finiteNumberOrNull(window.used_percent, `${path}.used_percent`);
  if (used !== null) {
    if (used < 0) throw new TypeError(`${where}.${path}.used_percent must be a finite number at or above zero`);
    snapshot[keys.used] = used;
  }

  const windowSeconds = finiteNumberOrNull(window.limit_window_seconds, `${path}.limit_window_seconds`);
  if (windowSeconds !== null) {
    if (windowSeconds < 0) throw new TypeError(`${where}.${path}.limit_window_seconds must be a finite number at or above zero`);
    snapshot[keys.minutes] = windowSeconds / 60;
  }

  // The absolute instant is preferred and the offset is the fallback, which
  // is the shape the quota headers in quota.ts settled on.
  const resetAt = usageResetAtInstant(window.reset_at, `${path}.reset_at`);
  if (resetAt !== undefined) {
    snapshot[keys.reset] = resetAt;
    return;
  }
  const resetAfter = usageResetAfterSeconds(window.reset_after_seconds, `${path}.reset_after_seconds`);
  if (resetAfter !== undefined) snapshot[keys.reset] = new Date(now.getTime() + resetAfter * 1000).toISOString();
};

const projectCodexUsageCredits = (
  credits: unknown,
  snapshot: CodexQuotaSnapshot,
): void => {
  if (credits === undefined || credits === null) return;
  if (!isRecord(credits)) throw new TypeError(`${where}.credits must be an object when present`);
  if (credits.has_credits !== undefined && credits.has_credits !== null) {
    if (typeof credits.has_credits !== 'boolean') throw new TypeError(`${where}.credits.has_credits must be a boolean`);
    snapshot.credits_has_credits = credits.has_credits;
  }
  const balance = finiteNumberOrNull(credits.balance, 'credits.balance');
  if (balance !== null) snapshot.credits_balance = balance;
  // `unlimited` and `overage_limit_reached` have no CodexQuotaSnapshot slot
  // and are left unread; see the interface comment above.
};

// Same null contract as the passive header parser: a body that reports
// nothing is "nothing observed", not "everything is zero". Returning a
// well-formed empty snapshot here would let an operator's refresh overwrite
// a good reading the header path had already harvested.
export const projectCodexUsageResponse = (body: CodexUsageResponse, now: Date): CodexQuotaSnapshot | null => {
  if (!isRecord(body)) throw new TypeError(`${where} must be an object`);
  const snapshot: CodexQuotaSnapshot = { observed_at: now.toISOString() };

  if (body.plan_type !== undefined && body.plan_type !== null) {
    if (typeof body.plan_type !== 'string') throw new TypeError(`${where}.plan_type must be a string`);
    // Open-string protocol values travel verbatim; blank is "not observed".
    if (body.plan_type.trim() !== '') snapshot.plan_type = body.plan_type;
  }

  const rateLimit = body.rate_limit;
  if (rateLimit !== undefined && rateLimit !== null) {
    if (!isRecord(rateLimit)) throw new TypeError(`${where}.rate_limit must be an object when present`);
    // `allowed` and `limit_reached` have no CodexQuotaSnapshot slot and are
    // left unread; see the interface comment above.
    projectCodexUsageWindow(rateLimit.primary_window, 'primary', snapshot, now);
    projectCodexUsageWindow(rateLimit.secondary_window, 'secondary', snapshot, now);
  }

  projectCodexUsageCredits(body.credits, snapshot);

  if (!hasCodexQuotaReading(snapshot)) return null;
  return snapshot;
};

export const isCodexUsageProbeDue = (state: CodexUpstreamState, now: number): boolean => {
  const account: CodexAccountCredential | undefined = state.accounts[0];
  if (!account) return true;
  // Absent is never-attempted: legacy rows predate the probe slots and
  // `readCodexUpstreamState` normalizes them to null at the boundary.
  const attemptedAt = account.usageProbeAttemptedAt ?? null;
  if (attemptedAt === null) return true;
  return now - attemptedAt >= CODEX_USAGE_PROBE_MIN_INTERVAL_MS;
};

// The entry is written under saveState's read-modify-CAS, and the mutator is
// re-run against whoever won a concurrent write. `attemptedAt` is stamped
// outside the mutator so a replay resolves to the same document rather than
// a later timestamp.
const persistCodexUsageProbeOutcome = async (
  upstreamId: string,
  accountId: string | null,
  attemptedAt: number,
  error: string | null,
): Promise<void> => {
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readCodexUpstreamState(current);
    const idx = findCodexAccountIndex(state, accountId);
    if (idx < 0) throw new Error(`refreshCodexUsageProbe: Codex account ${accountId} not found in upstream ${upstreamId}`);
    return replaceCodexAccount(state, idx, account => ({
      ...account,
      usageProbeAttemptedAt: attemptedAt,
      usageProbeError: error,
    }));
  });
};

// Runs the active probe and records its outcome in the same quotaSnapshot
// slot the passive header path fills. Used directly by the operator's
// refresh action, which wants the failure to travel back to the dashboard.
//
// Returns the projected snapshot, or null when the account is not active
// (the row already shows `state_message`, so a second signal adds nothing —
// no upstream call, no error write) or when the body reports nothing (which
// must not blank a reading the passive path already harvested). Any other
// failure — network, non-2xx, malformed body, terminal or refresh-failed
// credential — persists its message to the error slot, advances the attempt
// stamp so the retry stays on the probe cadence, and rethrows the original
// error with its chain intact.
export const refreshCodexUsageProbe = async (
  upstreamId: string,
  opts: { fetcher: Fetcher; signal?: AbortSignal },
): Promise<CodexQuotaSnapshot | null> => {
  const row = await getProviderRepo().upstreams.getById(upstreamId);
  if (!row) throw new Error(`Codex upstream ${upstreamId} not found`);
  const state = readCodexUpstreamState(row.state);
  const account = state.accounts[0];
  if (!account) throw new Error(`Codex upstream ${upstreamId} state has no Codex account`);
  if (account.state !== 'active') return null;
  const accountId = account.chatgptAccountId;
  const attemptedAt = Date.now();
  try {
    const entry = await ensureCodexAccessToken(
      upstreamId,
      accountId,
      refreshToken => mintCodexAccessToken(
        refreshToken,
        opts.fetcher,
        newRefresh => persistCodexRefreshTokenRotation(upstreamId, accountId, newRefresh, { onMissing: 'throw' }),
      ),
    );
    const body = await fetchCodexUsage({
      accessToken: entry.token,
      accountId,
      fetcher: opts.fetcher,
      signal: opts.signal,
    });
    const snapshot = projectCodexUsageResponse(body, new Date());
    if (snapshot !== null) await putCodexQuota(upstreamId, accountId, snapshot);
    await persistCodexUsageProbeOutcome(upstreamId, accountId, attemptedAt, null);
    return snapshot;
  } catch (error) {
    await persistCodexUsageProbeOutcome(
      upstreamId,
      accountId,
      attemptedAt,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
};
