// OpenCode Go usage action under the record-body contract. This is the
// operator's unconditional read, so it probes on every press.
//
// The config travels in the request body rather than being read back from the
// row: the edit form holds the plaintext API key, which lets an operator verify
// a key before saving it. A draft with no row yet is probed and reported
// without being persisted.

import { resolveControlPlaneFetcher } from './proxy-resolution.ts';
import { upstreamErrorMessage as errorMessage } from './shared.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import type { opencodeGoUsageBody } from '../schemas.ts';
import type { Fetcher } from '@floway-dev/provider';
import {
  fetchOpencodeGoUsageProbe,
  isOpencodeGoUsageEnabled,
  parseOpencodeGoUpstreamConfig,
  refreshOpencodeGoUsageProbe,
  type OpencodeGoUpstreamConfig,
} from '@floway-dev/provider-opencode-go';

export const opencodeGoUsage = async (c: CtxWithJson<typeof opencodeGoUsageBody>) => {
  const { record } = c.req.valid('json');
  if (record.kind !== 'opencode-go') return c.json({ error: 'Upstream is not an OpenCode Go upstream' }, 400);

  let config: OpencodeGoUpstreamConfig;
  let fetcher: Fetcher;
  try {
    config = parseOpencodeGoUpstreamConfig(record.config);
    fetcher = await resolveControlPlaneFetcher({
      override: record.proxy_fallback_list,
      upstreamId: record.id || undefined,
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
  if (!isOpencodeGoUsageEnabled(config)) {
    return c.json({ error: 'This upstream does not have an API key' }, 400);
  }

  try {
    const observation = record.id === ''
      ? await fetchOpencodeGoUsageProbe(config, fetcher)
      : await refreshOpencodeGoUsageProbe(record.id, config, fetcher);
    return c.json({ observation });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 502);
  }
};
