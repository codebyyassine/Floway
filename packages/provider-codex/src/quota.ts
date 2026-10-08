import { isUnsafeObjectKey } from './auth/guards.ts';
import { findCodexAccountIndex, readCodexUpstreamState, replaceCodexAccount, type CodexQuotaSnapshot, type CodexQuotaSnapshotMap } from './state.ts';
import { getProviderRepo } from '@floway-dev/provider';

export const CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT = 'unknown';

export const codexQuotaActiveLimitKey = (snapshot: CodexQuotaSnapshot): string => {
  const key = snapshot.active_limit?.trim();
  return key && !isUnsafeObjectKey(key) ? key : CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT;
};

// Each window has independent usage and optional reset metadata.
// https://github.com/openai/codex/blob/602d2add6e6df7e2c301c0507434b02a7463337d/codex-rs/codex-api/src/rate_limits.rs
// This is the latest KNOWN timed quota restriction, not a recovery guarantee:
// an exhausted window without a reset remains in the snapshot but cannot date it.
const codexQuotaRestrictionUntil = (snapshot: CodexQuotaSnapshot): string | undefined => {
  const horizons = [
    [snapshot.primary_used_percent, snapshot.primary_reset_after_at],
    [snapshot.secondary_used_percent, snapshot.secondary_reset_after_at],
  ] as const;
  const resets = horizons.flatMap(([used, reset]) => {
    if (used === undefined || !Number.isFinite(used) || used < 100 || reset === undefined) return [];
    const instant = Date.parse(reset);
    return Number.isFinite(instant) && instant > 0 ? [instant] : [];
  });
  return resets.length > 0 ? new Date(Math.max(...resets)).toISOString() : undefined;
};

const projectCodexQuota = (snapshot: CodexQuotaSnapshot): CodexQuotaSnapshot => {
  if (snapshot.ratelimited_until === undefined) return snapshot;
  const { ratelimited_until: _legacyUntil, ...reading } = snapshot;
  const until = codexQuotaRestrictionUntil(reading);
  return until === undefined ? reading : { ...reading, ratelimited_until: until };
};

interface ParseCodexQuotaOptions {
  now: Date;
  isRateLimited: boolean;
}

export const parseCodexQuotaHeaders = (headers: Headers, options: ParseCodexQuotaOptions): CodexQuotaSnapshot => {
  const snapshot: CodexQuotaSnapshot = { observed_at: options.now.toISOString() };
  const assign = snapshot as unknown as Record<string, unknown>;

  const setString = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header);
    if (v === null) return;
    const trimmed = v.trim();
    if (trimmed !== '') assign[key] = trimmed;
  };
  const setNumber = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header);
    if (v === null) return;
    // Blank rather than absent is how this backend reports a field that does
    // not apply -- a plan with no secondary window, an account with no credit
    // balance -- and `Number('')` is 0, which would render as a confident zero.
    if (v.trim() === '') return;
    const n = Number(v);
    if (Number.isFinite(n)) assign[key] = n;
  };
  const setBool = (key: keyof CodexQuotaSnapshot, header: string): void => {
    const v = headers.get(header);
    if (v === null) return;
    const lower = v.toLowerCase();
    if (lower === 'true') assign[key] = true;
    else if (lower === 'false') assign[key] = false;
  };
  // Upstream renamed this reading on 2025-10-17: `-reset-at` states the instant
  // outright, where `-reset-after-seconds` states the offset from receipt. Both
  // are still sent, and a capture from 2025-09 carries only the offset, so the
  // rename added a header rather than replacing one. The instant is preferred
  // and the offset is the fallback, which is the shape the third-party clients
  // that read both settled on -- and which keeps this working on the day the
  // offset stops being sent.
  // https://github.com/openai/codex/commit/0e08dd605
  //
  // Zero and blank both mean "this plan has no such window" rather than "it
  // resets now": a capture pairs a blank `-reset-at` with a zero
  // `-reset-after-seconds` on a plan whose secondary window is 0 minutes wide.
  const resetInstant = (prefix: string): string | undefined => {
    const at = headers.get(`${prefix}-reset-at`)?.trim();
    if (at !== undefined && at !== '') {
      const epochSeconds = Number(at);
      // Epoch seconds today; RFC 3339 in builds from the three days after the
      // header landed, which is why clients that read it accept both.
      const instant = Number.isFinite(epochSeconds) ? epochSeconds * 1000 : Date.parse(at);
      if (Number.isFinite(instant) && instant > 0) return new Date(instant).toISOString();
    }
    const after = headers.get(`${prefix}-reset-after-seconds`)?.trim();
    if (after === undefined || after === '') return undefined;
    const seconds = Number(after);
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    return new Date(options.now.getTime() + seconds * 1000).toISOString();
  };

  const setReset = (key: keyof CodexQuotaSnapshot, prefix: string): void => {
    const instant = resetInstant(prefix);
    if (instant !== undefined) assign[key] = instant;
  };

  setString('active_limit', 'x-codex-active-limit');
  setString('plan_type', 'x-codex-plan-type');
  setNumber('primary_used_percent', 'x-codex-primary-used-percent');
  setNumber('primary_window_minutes', 'x-codex-primary-window-minutes');
  setReset('primary_reset_after_at', 'x-codex-primary');
  setNumber('secondary_used_percent', 'x-codex-secondary-used-percent');
  setNumber('secondary_window_minutes', 'x-codex-secondary-window-minutes');
  setReset('secondary_reset_after_at', 'x-codex-secondary');
  setBool('credits_has_credits', 'x-codex-credits-has-credits');
  setNumber('credits_balance', 'x-codex-credits-balance');

  if (options.isRateLimited) {
    const until = codexQuotaRestrictionUntil(snapshot);
    if (until !== undefined) snapshot.ratelimited_until = until;
  }

  return snapshot;
};

export const hasCodexQuotaReading = (snapshot: CodexQuotaSnapshot): boolean => {
  const { observed_at: _observationTime, ...reading } = snapshot;
  return Object.keys(reading).length > 0;
};

// Every quota snapshot this account has observed, keyed by active limit.
//
// No TTL, which is the rule the other three providers state at their own slots:
// a reading rendered with the instant it was taken tells an operator more than
// an empty card does, and any traffic on the upstream replaces it. Only the
// dashboard reads this -- the data plane routes without consulting it -- so
// withholding a reading buys nothing and costs the page the only answer it has.
export const getCodexQuota = async (
  upstreamId: string,
  accountId: string | null,
): Promise<CodexQuotaSnapshotMap | null> => {
  const fresh = await getProviderRepo().upstreams.getById(upstreamId);
  if (!fresh) return null;
  const state = readCodexUpstreamState(fresh.state);
  const account = state.accounts.find(a => a.chatgptAccountId === accountId);
  const snapshots = account?.quotaSnapshot;
  if (!snapshots || Object.keys(snapshots).length === 0) return null;
  return Object.fromEntries(Object.entries(snapshots).map(([key, entry]) => [key, projectCodexQuota(entry.data)]));
};

export const putCodexQuota = async (
  upstreamId: string,
  accountId: string | null,
  snapshot: CodexQuotaSnapshot,
): Promise<void> => {
  // Stamped before the write so a replay against a winning sibling produces
  // the same document rather than a later `fetchedAt`.
  const fetchedAt = Date.now();
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readCodexUpstreamState(current);
    const idx = findCodexAccountIndex(state, accountId);
    if (idx < 0) throw new Error(`putCodexQuota: Codex account ${accountId} not found in upstream ${upstreamId}`);
    const existing = state.accounts[idx].quotaSnapshot ?? {};
    const incomingKey = codexQuotaActiveLimitKey(snapshot);
    let key = incomingKey;
    let data = snapshot;
    const namedKeys = Object.keys(existing).filter(candidate => candidate !== CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT);
    if (incomingKey === CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT && namedKeys.length > 0) {
      // The token-free usage probe carries no `active_limit`, while the
      // passive response headers name one. Writing the probe under `unknown`
      // alongside a named bucket forks the dashboard card by source rather
      // than by limit, so project it into the latest named bucket instead.
      const latestKey = namedKeys.toSorted((left, right) => {
        const leftObserved = Date.parse(existing[left].data.observed_at);
        const rightObserved = Date.parse(existing[right].data.observed_at);
        if (Number.isFinite(leftObserved) && Number.isFinite(rightObserved) && leftObserved !== rightObserved) {
          return rightObserved - leftObserved;
        }
        if (existing[left].fetchedAt !== existing[right].fetchedAt) return existing[right].fetchedAt - existing[left].fetchedAt;
        return left.localeCompare(right);
      })[0]!;
      key = latestKey;
      data = { ...snapshot, active_limit: existing[latestKey].data.active_limit ?? latestKey };
    }
    const next: Record<string, { fetchedAt: number; data: CodexQuotaSnapshot }> = { ...existing, [key]: { fetchedAt, data } };
    if (incomingKey !== CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT && next[CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT] !== undefined) {
      // The first named reading supersedes the placeholder `unknown` the probe
      // wrote before any header named a limit.
      delete next[CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT];
    }
    return replaceCodexAccount(state, idx, account => ({
      ...account,
      quotaSnapshot: next,
    }));
  });
};

// A successful earned reset invalidates every locally observed window. Do not
// synthesize zeroes: OpenAI explicitly requires clients to refetch limits after
// redemption, and the next Codex response will repopulate the same slot.
// https://github.com/openai/codex/blob/ac7634b9f73ec1bf96466be7a5869f0949d20b30/codex-rs/app-server/README.md#8-earned-rate-limit-resets-chatgpt
export const clearCodexQuota = async (
  upstreamId: string,
  accountId: string | null,
): Promise<void> => {
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readCodexUpstreamState(current);
    const idx = findCodexAccountIndex(state, accountId);
    if (idx < 0) throw new Error(`clearCodexQuota: Codex account ${accountId} not found in upstream ${upstreamId}`);
    if (state.accounts[idx].quotaSnapshot === null) return current;
    return replaceCodexAccount(state, idx, account => ({ ...account, quotaSnapshot: null }));
  });
};
