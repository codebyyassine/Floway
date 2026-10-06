// Refreshes the OpenCode Go generated snapshot files from the live sources:
// the public model registry (`https://models.opencode.ai/api.json`, provider
// block `opencode-go`) joined against the live gateway availability signal
// (`GET https://opencode.ai/zen/go/v1/models`), with per-model endpoints from
// the Go docs table (`https://opencode.ai/docs/go`).
//
// Usage:
//   pnpm tools:generate-opencode-go-catalog
//   pnpm tools:generate-opencode-go-catalog --check
//
// `--check` fails without writing when the checked-in output drifts, for CI.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OPENCODE_GO_SOURCE } from './generate.ts';
import { runOpencodeCatalogRefresh } from '../generate-opencode-catalog/refresh.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_SRC_DIR = resolve(HERE, '../../../packages/provider-opencode-go/src');

try {
  await runOpencodeCatalogRefresh({ argv: process.argv.slice(2), source: OPENCODE_GO_SOURCE, packageSrcDir: PACKAGE_SRC_DIR });
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}
