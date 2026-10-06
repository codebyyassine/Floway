// Gateway-managed OpenCode Go upstream state, persisted in upstreams.state_json.
// One slot: the most recent OpenCode Go quota probe. Writes go through
// UpstreamRepo.saveState as a mutator that spreads the state it is handed and
// replaces its own slot, so a concurrent write on another slot survives.

// The probe's outcome, kept as three fields rather than one nullable snapshot
// because the data-plane trigger needs all three:
//
// - `attemptedAt` (unix ms) anchors the debounce. It advances on failures too,
//   so an upstream whose probe is failing is retried on the same cadence as one
//   that succeeds instead of re-probing on every request.
// - `observation` is the last successful read, kept across later failures: a
//   usage window measured in days stays informative while a transient upstream
//   failure resolves, and the dashboard renders its age from `fetchedAt`.
// - `error` carries the most recent failure and is cleared by the next success,
//   so a probe that has silently stopped working is visible to the operator
//   rather than showing as an indefinitely fresh-looking card.
export interface OpencodeGoUsageProbeEntry {
  attemptedAt: number;
  observation: OpencodeGoUsageObservation | null;
  error: string | null;
}

// `data` is the upstream body verbatim. The quota endpoint is undocumented
// (OpenCode's docs cover the model endpoints only) and independent
// implementations already report its reset field arriving under two names —
// `resetsAt` as an ISO string or `resetInSec` as integer seconds — so the
// gateway stores what it received and lets the dashboard walk the keys it
// knows. `fetchedAt` is unix ms.
export interface OpencodeGoUsageObservation {
  fetchedAt: number;
  data: unknown;
}

export interface OpencodeGoUpstreamState {
  usageProbe: OpencodeGoUsageProbeEntry | null;
}

const ALLOWED_STATE_KEYS_MAP: Record<keyof OpencodeGoUpstreamState, true> = {
  usageProbe: true,
};

const ALLOWED_PROBE_KEYS_MAP: Record<keyof OpencodeGoUsageProbeEntry, true> = {
  attemptedAt: true,
  observation: true,
  error: true,
};

const ALLOWED_OBSERVATION_KEYS_MAP: Record<keyof OpencodeGoUsageObservation, true> = {
  fetchedAt: true,
  data: true,
};

const assertClosedObject = (value: unknown, where: string, allowed: Record<string, true>): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  // state_json round-trips through canonical serialization, so any surviving
  // key is persisted. Reject unknown keys to keep the on-disk shape closed.
  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(allowed, key)) throw new TypeError(`${where} has unexpected key '${key}'`);
  }
  return obj;
};

const assertUnixMs = (value: unknown, where: string): void => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${where} must be a finite number`);
  }
};

const assertOpencodeGoUsageObservation = (value: unknown, where: string): void => {
  const obj = assertClosedObject(value, where, ALLOWED_OBSERVATION_KEYS_MAP);
  assertUnixMs(obj.fetchedAt, `${where}.fetchedAt`);
  // The body's inner shape is upstream-owned; confirming it is a plain object
  // is the whole contract the dashboard relies on.
  if (typeof obj.data !== 'object' || obj.data === null || Array.isArray(obj.data)) {
    throw new TypeError(`${where}.data must be a plain object`);
  }
};

const assertOptionalString = (value: unknown, where: string): void => {
  if (value !== null && value !== undefined && typeof value !== 'string') {
    throw new TypeError(`${where} must be a string`);
  }
};

const assertOpencodeGoUsageProbeEntry = (value: unknown, where: string): void => {
  const obj = assertClosedObject(value, where, ALLOWED_PROBE_KEYS_MAP);
  assertUnixMs(obj.attemptedAt, `${where}.attemptedAt`);
  if (obj.observation !== null && obj.observation !== undefined) {
    assertOpencodeGoUsageObservation(obj.observation, `${where}.observation`);
  }
  assertOptionalString(obj.error, `${where}.error`);
};

export function assertOpencodeGoUpstreamState(value: unknown): asserts value is OpencodeGoUpstreamState {
  const obj = assertClosedObject(value, 'OpencodeGoUpstreamState', ALLOWED_STATE_KEYS_MAP);
  if (obj.usageProbe !== null && obj.usageProbe !== undefined) {
    assertOpencodeGoUsageProbeEntry(obj.usageProbe, 'OpencodeGoUpstreamState.usageProbe');
  }
}

export const emptyOpencodeGoUpstreamState = (): OpencodeGoUpstreamState => ({ usageProbe: null });

// The asserter treats an absent optional key as null, so the entry is rebuilt
// here rather than passed through: readers get the three fields the type
// promises instead of `undefined` behind a `| null`.
export const readOpencodeGoUpstreamState = (raw: unknown): OpencodeGoUpstreamState => {
  if (raw === null || raw === undefined) return emptyOpencodeGoUpstreamState();
  assertOpencodeGoUpstreamState(raw);
  const probe = raw.usageProbe;
  return {
    usageProbe: probe
      ? { attemptedAt: probe.attemptedAt, observation: probe.observation ?? null, error: probe.error ?? null }
      : null,
  };
};
