import { test } from 'vitest';

import { SqlRepo } from '../../src/repo/sql.ts';
import { createSqlJsDatabase, migrationSqlByFilename, wrapSqlJsDatabase } from '../repo/test-sqlite.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('migration 0089 adds block_peak_priced_models defaulting off', async () => {
  const db = await createSqlJsDatabase();
  try {
    for (const [, sql] of migrationSqlByFilename) db.run(sql);

    db.run(`INSERT INTO upstreams (id, provider, name, enabled, sort_order, created_at, updated_at, config_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json, hue)
            VALUES ('up_peak', 'custom', 'Peak', 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}', '{}', '[]', '[]', 210)`);
    const repo = new SqlRepo(wrapSqlJsDatabase(db)).upstreams;
    assertEquals((await repo.getById('up_peak'))?.blockPeakPricedModels, false);

    db.run(`UPDATE upstreams SET block_peak_priced_models = 1 WHERE id = 'up_peak'`);
    assertEquals((await repo.getById('up_peak'))?.blockPeakPricedModels, true);

    assertThrows(() => db.run(`UPDATE upstreams SET block_peak_priced_models = 2 WHERE id = 'up_peak'`), Error);
  } finally {
    db.close();
  }
});
