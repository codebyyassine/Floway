// Shared refresh entrypoint for the OpenCode catalog generators (Go and Zen).
// Each gateway keeps its own thin `cli.ts` (own output paths and usage text);
// everything that touches the network or the filesystem lives here, driven by
// the gateway's OpencodeProviderSource.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  buildOpencodeSnapshot,
  OPENCODE_REGISTRY_URL,
  type OpencodeGeneratedSnapshot,
  type OpencodeProviderSource,
} from './generate.ts';

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with status ${response.status}`);
  return (await response.json()) as unknown;
};

const fetchText = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with status ${response.status}`);
  return await response.text();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const liveIdsOf = (payload: unknown, liveModelsUrl: string): string[] => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error(`GET ${liveModelsUrl} returned an unexpected shape: expected { data: [{ id }] }`);
  }
  const ids: string[] = [];
  for (const item of payload.data) {
    if (isRecord(item) && typeof item.id === 'string' && item.id !== '' && !ids.includes(item.id)) ids.push(item.id);
  }
  return ids;
};

const catalogDocumentOf = (snapshot: OpencodeGeneratedSnapshot, source: OpencodeProviderSource): unknown => {
  const comment = [
    `Generated from ${OPENCODE_REGISTRY_URL} (provider block \`${source.block}\`) joined against ${source.liveModelsUrl}, with per-model endpoints from ${source.docsUrl}.`,
    `Refresh: ${source.refreshCommand}`,
    'A model id present upstream but absent from the registry is refused (filtered out); a live model with no row in the docs table carries no endpoint.',
  ];
  if (snapshot.excluded.length > 0) {
    const dropped = snapshot.excluded.map(entry => `${entry.id} (/v1/${entry.endpointPath})`).join(', ');
    comment.push(`Excluded live ids the docs table wires to a path Floway cannot route: ${dropped}.`);
  }
  return {
    $comment: comment,
    models: snapshot.catalog.models,
  };
};

const pricingDocumentOf = (snapshot: OpencodeGeneratedSnapshot, source: OpencodeProviderSource): unknown => ({
  $comment: [
    `Generated from ${OPENCODE_REGISTRY_URL} (provider block \`${source.block}\` cost blocks, USD per 1M tokens).`,
    `Refresh: ${source.refreshCommand}`,
    'Read by src/pricing.ts, which converts these published rates to USD per token.',
  ],
  base: snapshot.pricing.base,
  tiers: snapshot.pricing.tiers,
});

const capabilitiesDocumentOf = (snapshot: OpencodeGeneratedSnapshot, source: OpencodeProviderSource): unknown => ({
  $comment: [
    `Generated from ${OPENCODE_REGISTRY_URL} (provider block \`${source.block}\` reasoning_options).`,
    `Refresh: ${source.refreshCommand}`,
    'Read by src/capabilities.ts, which serves reasoning presets to the provider.',
  ],
  models: snapshot.capabilities,
});

const serialize = (document: unknown): string => `${JSON.stringify(document, null, 2)}\n`;

const reportExcluded = (snapshot: OpencodeGeneratedSnapshot): string | null => {
  if (snapshot.excluded.length === 0) return null;
  return snapshot.excluded
    .map(entry => `Excluded ${entry.id}: the docs table wires it to /v1/${entry.endpointPath}, which Floway cannot route.`)
    .join('\n');
};

// Refreshes one gateway's generated snapshot files from the live sources, or
// (`--check`) fails without writing when the checked-in output drifts, for CI.
export const runOpencodeCatalogRefresh = async (args: {
  argv: readonly string[];
  source: OpencodeProviderSource;
  packageSrcDir: string;
}): Promise<void> => {
  const filtered = args.argv.filter(arg => arg !== '--');
  if (filtered.includes('--help') || filtered.includes('-h')) {
    process.stdout.write(`Usage:\n  ${args.source.refreshCommand} [--check]\n\nRefreshes the ${args.source.block} generated snapshot files from ${OPENCODE_REGISTRY_URL}\n(provider block \`${args.source.block}\`) joined against ${args.source.liveModelsUrl},\nwith per-model endpoints from ${args.source.docsUrl}.\n`);
    return;
  }
  const check = filtered.includes('--check');
  const unexpected = filtered.filter(arg => arg !== '--check');
  if (unexpected.length > 0) throw new Error(`Unexpected arguments: ${unexpected.join(' ')}`);
  const [registryPayload, livePayload, docsHtml] = await Promise.all([
    fetchJson(OPENCODE_REGISTRY_URL),
    fetchJson(args.source.liveModelsUrl),
    fetchText(args.source.docsUrl),
  ]);
  const snapshot = buildOpencodeSnapshot({
    registryPayload,
    liveIds: liveIdsOf(livePayload, args.source.liveModelsUrl),
    docsHtml,
    source: args.source,
  });
  const outputs: ReadonlyArray<readonly [string, string]> = [
    [resolve(args.packageSrcDir, 'catalog.generated.json'), serialize(catalogDocumentOf(snapshot, args.source))],
    [resolve(args.packageSrcDir, 'pricing.generated.json'), serialize(pricingDocumentOf(snapshot, args.source))],
    [resolve(args.packageSrcDir, 'capabilities.generated.json'), serialize(capabilitiesDocumentOf(snapshot, args.source))],
  ];
  if (check) {
    for (const [path, fresh] of outputs) {
      const current = await readFile(path, 'utf8').catch(() => null);
      if (current !== fresh) throw new Error(`Checked-in output drifts from the live sources: ${path}\nRun \`${args.source.refreshCommand}\` to refresh it.`);
    }
    const report = reportExcluded(snapshot);
    if (report !== null) process.stdout.write(`${report}\n`);
    process.stdout.write(`${args.source.block} catalog is current.\n`);
    return;
  }
  for (const [path, fresh] of outputs) {
    await writeFile(path, fresh, 'utf8');
    process.stdout.write(`Wrote ${path}\n`);
  }
  const report = reportExcluded(snapshot);
  if (report !== null) process.stdout.write(`${report}\n`);
};
