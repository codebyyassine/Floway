import { test } from 'vitest';

import { SqlRepo } from '../../src/repo/sql.ts';
import { createSqlJsDatabase, migrationSqlByFilename, wrapSqlJsDatabase } from '../repo/test-sqlite.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

test('migration 0090 adds peak_schedule_override defaulting to inherit', async () => {
  const db = await createSqlJsDatabase();
  try {
    for (const [, sql] of migrationSqlByFilename) db.run(sql);

    db.run(`INSERT INTO upstreams (id, provider, name, enabled, sort_order, created_at, updated_at, config_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json, hue)
            VALUES ('up_peak', 'custom', 'Peak', 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}', '{}', '[]', '[]', 210)`);
    const repo = new SqlRepo(wrapSqlJsDatabase(db)).upstreams;
    assertEquals((await repo.getById('up_peak'))?.peakScheduleOverride, undefined);

    db.run(`UPDATE upstreams SET peak_schedule_override = 'deepseek' WHERE id = 'up_peak'`);
    assertEquals((await repo.getById('up_peak'))?.peakScheduleOverride, 'deepseek');

    db.run(`UPDATE upstreams SET peak_schedule_override = 'none' WHERE id = 'up_peak'`);
    assertEquals((await repo.getById('up_peak'))?.peakScheduleOverride, 'none');

    db.run(`UPDATE upstreams SET peak_schedule_override = 'nope' WHERE id = 'up_peak'`);
    await assertRejects(() => repo.getById('up_peak'), Error, 'peak_schedule_override');
  } finally {
    db.close();
  }
});
