-- One row per caption request. Files live in R2 (retention: see r2-lifecycle);
-- this table is the durable record that outlives them.
CREATE TABLE IF NOT EXISTS requests (
  job_id           TEXT PRIMARY KEY,
  channel          TEXT NOT NULL,           -- 'telegram' | 'api'
  chat_id          INTEGER,
  source_type      TEXT NOT NULL,           -- 'url' | 'upload'
  source_url       TEXT,                    -- set for links only
  telegram_file_id TEXT,                    -- set for uploads only (metadata, not the file)
  post_caption     TEXT,
  status           TEXT NOT NULL,           -- 'running' | 'done' | 'failed'
  error            TEXT,
  duration         REAL,
  settings         TEXT,                    -- JSON, what the latest burn used
  script_srt       TEXT,                    -- the .srt: transcript + translation
  segments         TEXT,                    -- JSON StoredCues
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_chat ON requests (chat_id, created_at DESC);
