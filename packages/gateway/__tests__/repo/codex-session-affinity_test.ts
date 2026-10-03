import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo } from '../../src/repo/types.ts';

const factories: ReadonlyArray<readonly [string, () => Promise<Repo>]> = [
  ['memory', async () => new InMemoryRepo()],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
];

const setup = async (factory: () => Promise<Repo>) => {
  const repo = await factory();
  for (const id of ['key-a', 'key-b']) {
    await repo.apiKeys.save({
      id, userId: 1, key: `sk-${id}`, name: id, serverSecret: (id === 'key-a' ? '00' : '11').repeat(32),
      createdAt: '2026-01-01T00:00:00Z', upstreamIds: null, deletedAt: null,
      dumpRetentionSeconds: null, openaiResponsesRetentionSeconds: 0,
    });
  }
  return repo.codexSessionAffinity;
};

describe.each(factories)('Codex session affinity (%s)', (_name, factory) => {
  test('first claim wins across concurrent request orders', async () => {
    const repo = await setup(factory);
    const bindings = await Promise.all([
      repo.claim('key-a', 'session', 'a'),
      repo.claim('key-a', 'session', 'b'),
    ]);
    expect(bindings).toEqual([{ upstreamId: 'a', revision: 0 }, { upstreamId: 'a', revision: 0 }]);
  });

  test('sessions and API keys remain independent', async () => {
    const repo = await setup(factory);
    await repo.claim('key-a', 'session-a', 'a');
    expect(await repo.claim('key-a', 'session-b', 'b')).toEqual({ upstreamId: 'b', revision: 0 });
    expect(await repo.claim('key-b', 'session-a', 'b')).toEqual({ upstreamId: 'b', revision: 0 });
    expect(await repo.claim('key-a', 'session-a', 'b')).toEqual({ upstreamId: 'a', revision: 0 });
  });

  test('stale failover cannot overwrite a newer binding even after the original account returns', async () => {
    const repo = await setup(factory);
    const initial = await repo.claim('key-a', 'session', 'a');
    await repo.replace('key-a', 'session', initial.revision, 'b');
    const replacement = await repo.claim('key-a', 'session', 'a');
    await repo.replace('key-a', 'session', replacement.revision, 'a');
    await repo.replace('key-a', 'session', initial.revision, 'c');
    expect(await repo.claim('key-a', 'session', 'c')).toEqual({ upstreamId: 'a', revision: 2 });
  });

  test('replacement cannot invent a missing session', async () => {
    const repo = await setup(factory);
    await repo.replace('key-a', 'session', 0, 'b');
    expect(await repo.claim('key-a', 'session', 'a')).toEqual({ upstreamId: 'a', revision: 0 });
  });
});
