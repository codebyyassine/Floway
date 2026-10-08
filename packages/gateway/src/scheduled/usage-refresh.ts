import { createPerRequestFetcher } from '../dial/per-request.ts';
import { getRepo } from '../repo/index.ts';
import { hasLocationIndependentEgress } from '../repo/proxy-fallback-list.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { isCodexUsageProbeDue, readCodexUpstreamState, refreshCodexUsageProbe } from '@floway-dev/provider-codex';
import { assertOpencodeGoUpstreamRecord, isOpencodeGoUsageEnabled, isOpencodeGoUsageProbeDue, readOpencodeGoUpstreamState, refreshOpencodeGoUsageProbe } from '@floway-dev/provider-opencode-go';

export const scheduleUsageProbeRefreshes = async (runtimeLocation: string | null, scheduler: BackgroundScheduler): Promise<void> => {
  const upstreams = await getRepo().upstreams.list();
  const resolveFetcher = await createPerRequestFetcher(runtimeLocation, upstreams);
  const now = Date.now();
  for (const upstream of upstreams) {
    if (!upstream.enabled
      || (runtimeLocation === null && !hasLocationIndependentEgress(upstream.proxyFallbackList))) continue;
    if (upstream.kind !== 'codex' && upstream.kind !== 'opencode-go') continue;
    try {
      if (upstream.kind === 'codex') {
        if (!isCodexUsageProbeDue(readCodexUpstreamState(upstream.state), now)) continue;
        const fetcher = resolveFetcher(upstream.id);
        scheduler(refreshCodexUsageProbe(upstream.id, { fetcher }).catch((error: unknown) => {
          console.error(`[scheduled] usage.refresh ${upstream.id} failed`, error);
        }));
      } else {
        const { config } = assertOpencodeGoUpstreamRecord(upstream);
        if (!isOpencodeGoUsageEnabled(config)
          || !isOpencodeGoUsageProbeDue(readOpencodeGoUpstreamState(upstream.state), now)) continue;
        const fetcher = resolveFetcher(upstream.id);
        scheduler(refreshOpencodeGoUsageProbe(upstream.id, config, fetcher).catch((error: unknown) => {
          console.error(`[scheduled] usage.refresh ${upstream.id} failed`, error);
        }));
      }
    } catch (error) {
      console.error(`[scheduled] usage.refresh ${upstream.id} failed`, error);
    }
  }
};
