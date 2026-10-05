// OpenCode Go subscription quota probe.
//
// The gateway serves `GET /v1/usage` behind the same API key the data plane
// already uses. It answers with the subscription's three rolling windows —
// `rolling` (5 hours), `weekly` (7 days), and `monthly` (a calendar month),
// which OpenCode's own docs describe as budgeted at 20%/50%/100% of the
// monthly allowance:
// https://opencode.ai/docs/go
//
//   {"usage": {
//     "rolling": {"status": "ok", "percent": 4, "resetsAt": "2026-08-13T16:27:38.287Z"},
//     "weekly":  {"status": "ok", "percent": 3, "resetsAt": "2026-08-17T00:00:00.287Z"},
//     "monthly": {"status": "ok", "percent": 1, "resetsAt": "2026-09-13T06:06:01.287Z"}}}
//
// Three facts shape how the body is read:
//
// - `percent` is 0..100 already. This is the opposite of the Ollama windows
//   beside it, whose `usage` field is a 0..1 fraction — rescaling here would
//   be a 100x error, so the body is stored verbatim and never normalized.
// - `status` is `"ok" | "rate-limited"`. A window reporting anything but `ok`
//   is spent, not missing: the spent reading is retained so the dashboard can
//   name the exhausted window rather than showing a gap.
// - The endpoint is undocumented (OpenCode's docs cover the model endpoints
//   only) and independent implementations already report the reset field
//   arriving under two names — `resetsAt` as an ISO string or `resetInSec` as
//   integer seconds. The body is therefore persisted verbatim and the
//   dashboard walks the keys it knows, so a third naming does not reject a
//   live account.
//
// A 401 rejects the key; a 403 accepts the key but reports no Go subscription
// behind it. Both name the operator's next step, so each gets its own message
// rather than the generic status line.

import { type OpencodeGoUpstreamConfig } from './config.ts';
import { opencodeGoFetchUsage } from './fetch.ts';
import { type OpencodeGoUsageObservation, type OpencodeGoUsageProbeEntry, type OpencodeGoUpstreamState, readOpencodeGoUpstreamState } from './state.ts';
import { type Fetcher, getProviderRepo, identityWrapUpstreamCall } from '@floway-dev/provider';

// Reading the windows takes only a key to authenticate with: every OpenCode Go
// upstream is a subscription account, so there is no separate toggle to state
// the way the Ollama cloud-usage option does — the presence of the bearer key
// is the whole gate.
export const isOpencodeGoUsageEnabled = (config: OpencodeGoUpstreamConfig): boolean =>
  config.apiKey !== undefined;

// The endpoint is an unmemoized multi-table join per call and integrators are
// asked to poll sparingly, so this is deliberately coarser than the
// minute-wide cadence the Ollama windows beside it use: a busy upstream
// refreshes every five minutes, an idle one not at all.
export const OPENCODE_GO_USAGE_PROBE_MIN_INTERVAL_MS = 5 * 60_000;

export const fetchOpencodeGoUsageProbe = async (
  config: OpencodeGoUpstreamConfig,
  fetcher: Fetcher,
): Promise<OpencodeGoUsageObservation> => {
  const response = await opencodeGoFetchUsage(
    config,
    { method: 'GET', headers: new Headers({ accept: 'application/json' }) },
    { fetcher, wrapUpstreamCall: identityWrapUpstreamCall },
  );
  const rawText = await response.text();
  // The body is the operator-facing half of each message, so it is trimmed and
  // capped: an upstream error page is not the quota card.
  const body = rawText.trim().slice(0, 256);
  if (response.status === 401) {
    throw new Error(`OpenCode Go /v1/usage rejected the API key (401): ${body}`);
  }
  if (response.status === 403) {
    throw new Error(`OpenCode Go /v1/usage: the API key has no Go subscription (403): ${body}`);
  }
  if (!response.ok) {
    throw new Error(`OpenCode Go /v1/usage returned ${response.status}: ${body}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    throw new Error(`OpenCode Go /v1/usage returned a non-JSON body (${response.status})`, { cause: cause as Error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`OpenCode Go /v1/usage returned a non-object body (${response.status})`);
  }
  return { fetchedAt: Date.now(), data: parsed };
};

// The entry is written under saveState's read-modify-CAS, and the mutator is
// re-run against whoever won a concurrent write. Two probes racing therefore
// resolve by attempt time rather than by write order, so the loser of the race
// cannot roll the slot back to its older reading. Equal stamps are not a
// rollback — the clock is coarser than the two attempts, and the later arrival
// is no staler — so only a strictly newer stored attempt wins.
const persistProbeEntry = async (upstreamId: string, entry: OpencodeGoUsageProbeEntry): Promise<void> => {
  await getProviderRepo().upstreams.saveState(upstreamId, current => {
    const state = readOpencodeGoUpstreamState(current);
    if (state.usageProbe && state.usageProbe.attemptedAt > entry.attemptedAt) return current;
    return {
      ...state,
      usageProbe: {
        attemptedAt: entry.attemptedAt,
        // A failed probe keeps the last good reading rather than blanking the
        // card; only a success replaces it.
        observation: entry.observation ?? state.usageProbe?.observation ?? null,
        error: entry.error,
      },
    } satisfies OpencodeGoUpstreamState;
  });
};

// Runs the probe and records its outcome. Used directly by the operator's
// refresh action, which wants the failure to travel back to the dashboard, and
// through `scheduleOpencodeGoUsageProbe` by the data plane, which does not.
export const refreshOpencodeGoUsageProbe = async (
  upstreamId: string,
  config: OpencodeGoUpstreamConfig,
  fetcher: Fetcher,
): Promise<OpencodeGoUsageObservation> => {
  const attemptedAt = Date.now();
  let observation: OpencodeGoUsageObservation;
  try {
    observation = await fetchOpencodeGoUsageProbe(config, fetcher);
  } catch (error) {
    await persistProbeEntry(upstreamId, {
      attemptedAt,
      observation: null,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  await persistProbeEntry(upstreamId, { attemptedAt, observation, error: null });
  return observation;
};

const isOpencodeGoUsageProbeDue = (state: OpencodeGoUpstreamState, now: number): boolean => {
  const probe = state.usageProbe;
  return probe === null || now - probe.attemptedAt >= OPENCODE_GO_USAGE_PROBE_MIN_INTERVAL_MS;
};

// Fire-and-forget refresh behind the debounce, scheduled by the data plane
// once an upstream call that consumes the subscription's windows has been made.
// Every read the debounce needs is already in hand: `state` is the record this
// request was routed with, which the repo reads per request, so a probe that is
// not due costs nothing at all.
//
// Best-effort by construction: the response is already the caller's, and a
// usage card is strictly better-than-nothing information. A failure is
// recorded on the upstream — where the operator sees it — and never reaches
// the request.
export const scheduleOpencodeGoUsageProbe = (
  upstreamId: string,
  config: OpencodeGoUpstreamConfig,
  state: OpencodeGoUpstreamState,
  fetcher: Fetcher,
  waitUntil: (promise: Promise<unknown>) => void,
): void => {
  if (!isOpencodeGoUsageEnabled(config)) return;
  if (!isOpencodeGoUsageProbeDue(state, Date.now())) return;
  waitUntil(refreshOpencodeGoUsageProbe(upstreamId, config, fetcher).catch((error: unknown) => {
    console.warn(`Failed to refresh OpenCode Go usage for ${upstreamId}:`, error);
  }));
};
