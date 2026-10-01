CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  broadcaster_id TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  display_name TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT 'AFFILIATE PLUS erreichen!',
  label TEXT NOT NULL DEFAULT 'Neue Abo-Punkte',
  target INTEGER NOT NULL DEFAULT 100,
  icon_url TEXT NOT NULL DEFAULT '',
  needs_reauth INTEGER NOT NULL DEFAULT 0,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS monthly_points (
  broadcaster_id TEXT NOT NULL,
  month_key TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (broadcaster_id, month_key)
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  broadcaster_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seen_events (
  event_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
