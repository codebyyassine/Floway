import { defineConfig } from 'vitest/config';

// The dashboard reads local time on purpose -- a reader's traffic is bucketed
// into their own day -- so a suite that exercises it samples whatever zone the
// machine is in. Pinning one here is what makes a green run here mean a green
// run anywhere: a fixture written against the ambient zone has passed locally
// and failed in CI, which reports the machine, not the code.
export default defineConfig({
  test: {
    env: { TZ: 'UTC' },
    // Vitest otherwise starts `availableParallelism() - 1` workers, so a
    // 16-core machine runs 15 happy-dom workers at once and one full workspace
    // run can exhaust RAM and swap. Two keeps every run inside a machine's
    // budget; each project config repeats the cap so a standalone package run
    // is bounded too.
    maxWorkers: 2,
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts', 'tools/vitest.config.ts'],
  },
});
