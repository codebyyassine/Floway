// Refreshes the OpenCode Zen generated snapshot files from the live sources:
// the public model registry (`https://models.opencode.ai/api.json`, provider
// block `opencode`) joined against the live gateway availability signal
// (`GET https://opencode.ai/zen/v1/models`), with per-model endpoints from
// the Zen docs table (`https://opencode.ai/docs/zen`).
//
// Usage:
//   pnpm tools:generate-opencode-zen-catalog
//   pnpm tools:generate-opencode-zen-catalog --check
//
// `--check` fails without writing when the checked-in output drifts, for CI.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OPENCODE_ZEN_SOURCE } from './generate.ts';
import { runOpencodeCatalogRefresh } from '../generate-opencode-catalog/refresh.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_SRC_DIR = resolve(HERE, '../../../packages/provider-opencode-zen/src');

try {
  await runOpencodeCatalogRefresh({ argv: process.argv.slice(2), source: OPENCODE_ZEN_SOURCE, packageSrcDir: PACKAGE_SRC_DIR });
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}
