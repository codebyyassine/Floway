import type { CodexSessionAffinityRepo, CodexSessionBinding } from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';

export class SqlCodexSessionAffinityRepo implements CodexSessionAffinityRepo {
  constructor(private readonly db: SqlDatabase) {}

  async claim(apiKeyId: string, sessionKey: string, upstreamId: string): Promise<CodexSessionBinding> {
    // The insert arbitrates concurrent first turns across Node processes and D1
    // isolates. Read the winner, never overwrite it with this request's order.
    await this.db.prepare(
      'INSERT INTO codex_session_affinity (api_key_id, session_key, upstream_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    ).bind(apiKeyId, sessionKey, upstreamId).run();
    const row = await this.db.prepare(
      'SELECT upstream_id, revision FROM codex_session_affinity WHERE api_key_id = ? AND session_key = ?',
    ).bind(apiKeyId, sessionKey).first<{ upstream_id: string; revision: number }>();
    if (row === null) throw new Error('Codex session affinity disappeared after claiming its account');
    return { upstreamId: row.upstream_id, revision: row.revision };
  }

  async replace(apiKeyId: string, sessionKey: string, expectedRevision: number, upstreamId: string): Promise<void> {
    await this.db.prepare(
      'UPDATE codex_session_affinity SET upstream_id = ?, revision = revision + 1 WHERE api_key_id = ? AND session_key = ? AND revision = ?',
    ).bind(upstreamId, apiKeyId, sessionKey, expectedRevision).run();
  }
}
