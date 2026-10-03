CREATE TABLE codex_session_affinity (
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  session_key TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (api_key_id, session_key)
) WITHOUT ROWID;
