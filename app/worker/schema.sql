CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  credential_id   TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  public_key      TEXT NOT NULL,
  counter         INTEGER NOT NULL DEFAULT 0,
  transports      TEXT,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  device_label TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS challenges (
  token      TEXT PRIMARY KEY,
  challenge  TEXT NOT NULL,
  user_id    TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game_state (
  user_id     TEXT NOT NULL REFERENCES users(id),
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  data        TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_game_state_user ON game_state(user_id);
