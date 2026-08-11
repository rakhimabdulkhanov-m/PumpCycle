-- D1 schema migration 0001 — initial schema
-- Rules: no BEGIN/COMMIT (D1 rejects them in --file mode).
-- Moments = INTEGER ms epoch UTC. Calendar days = TEXT 'YYYY-MM-DD'.
-- Money = INTEGER cents. Booleans = INTEGER 0/1.
-- Anything rendered unguarded in the UI is NOT NULL DEFAULT '' / DEFAULT 0.

-- ---------------------------------------------------------------------------
-- Sequence counter: one row, allocated via UPDATE ... RETURNING.
-- The migration seeds the single row; the runner never touches this table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seq_counter (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO seq_counter (id, value) VALUES (1, 0);

-- ---------------------------------------------------------------------------
-- schema_meta: seeded by the migration runner, not by this file.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_meta (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  version    INTEGER NOT NULL,
  tenant_id  TEXT    NOT NULL,
  applied_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id                   TEXT    PRIMARY KEY,
  external_ref         TEXT    NOT NULL DEFAULT '',
  name                 TEXT    NOT NULL DEFAULT '',
  address              TEXT    NOT NULL DEFAULT '',
  phone                TEXT    NOT NULL DEFAULT '',
  email                TEXT    NOT NULL DEFAULT '',
  email_status         TEXT    NOT NULL DEFAULT 'ok'
                               CHECK (email_status IN ('ok','unverified','bounced','complained')),
  soft_bounce_count    INTEGER NOT NULL DEFAULT 0,
  -- Nullable on purpose. "We do not know where this is" is a real state: an
  -- address that geocodes to nothing must NOT get an invented pin (the old
  -- client code dropped a random one near Gastonia, which lands in the wrong
  -- state for any client outside NC). A customer with no coordinates is simply
  -- absent from the pin layer until someone drops the pin on the map.
  -- lat and lng are set and cleared together; neither is ever half-known.
  lat                  REAL    CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng                  REAL    CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  -- How the pin got where it is, so the UI can tell an exact parcel from a road
  -- guess: '' | 'house' | 'house_approx' | 'road' | 'locality' | 'manual'.
  location_precision   TEXT    NOT NULL DEFAULT '',
  -- Stamped when a human drags the pin and accepts it. Lets the app surface
  -- "N pins were never confirmed" instead of silently trusting a geocoder.
  location_confirmed_at INTEGER,
  tank_size_gal        INTEGER NOT NULL DEFAULT 1000,
  last_pumped          TEXT,
  cycle_months         INTEGER NOT NULL DEFAULT 36 CHECK (cycle_months > 0),
  cycle_seq            INTEGER NOT NULL DEFAULT 0,
  notes                TEXT    NOT NULL DEFAULT '',
  edited_in_app        INTEGER NOT NULL DEFAULT 0,
  reminder_baseline_at INTEGER,
  field_ts             TEXT    NOT NULL DEFAULT '{}',
  archived_at          INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  seq                  INTEGER NOT NULL,
  CHECK (last_pumped IS NULL OR last_pumped GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Half a coordinate is worse than none: it renders as a pin at lat,0 in the
  -- Gulf of Guinea. Either both are known or neither is.
  CHECK ((lat IS NULL) = (lng IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_customers_seq         ON customers (seq);
CREATE INDEX IF NOT EXISTS idx_customers_last_pumped ON customers (last_pumped);
CREATE INDEX IF NOT EXISTS idx_customers_archived_at ON customers (archived_at);

-- ---------------------------------------------------------------------------
-- Visits
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS visits (
  id               TEXT    PRIMARY KEY,
  customer_id      TEXT    NOT NULL REFERENCES customers(id),
  visited_on       TEXT    NOT NULL,
  sets_last_pumped INTEGER NOT NULL DEFAULT 1,
  gallons          INTEGER NOT NULL DEFAULT 0,
  price_cents      INTEGER NOT NULL DEFAULT 0,
  tech             TEXT    NOT NULL DEFAULT '',
  notes            TEXT    NOT NULL DEFAULT '',
  archived_at      INTEGER,
  created_at       INTEGER NOT NULL,
  seq              INTEGER NOT NULL,
  CHECK (visited_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);

CREATE INDEX IF NOT EXISTS idx_visits_customer_visited ON visits (customer_id, visited_on);
CREATE INDEX IF NOT EXISTS idx_visits_seq              ON visits (seq);

-- ---------------------------------------------------------------------------
-- Photos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS photos (
  id           TEXT    PRIMARY KEY,
  customer_id  TEXT    NOT NULL REFERENCES customers(id),
  visit_id     TEXT    REFERENCES visits(id),
  r2_key       TEXT    NOT NULL DEFAULT '',
  content_type TEXT    NOT NULL DEFAULT '',
  bytes        INTEGER NOT NULL DEFAULT 0,
  width        INTEGER NOT NULL DEFAULT 0,
  height       INTEGER NOT NULL DEFAULT 0,
  caption      TEXT    NOT NULL DEFAULT '',
  blob_state   TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (blob_state IN ('pending','stored')),
  archived_at  INTEGER,
  created_at   INTEGER NOT NULL,
  seq          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_customer_id ON photos (customer_id);
CREATE INDEX IF NOT EXISTS idx_photos_seq         ON photos (seq);
CREATE INDEX IF NOT EXISTS idx_photos_blob_state  ON photos (blob_state);

-- ---------------------------------------------------------------------------
-- Reminder log — double-send guard is the unique index below
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reminder_log (
  id                  TEXT    PRIMARY KEY,
  customer_id         TEXT    NOT NULL REFERENCES customers(id),
  reminder_key        TEXT    NOT NULL,
  cycle_seq           INTEGER NOT NULL,
  channel             TEXT    NOT NULL CHECK (channel IN ('email','sms')),
  provider            TEXT    NOT NULL DEFAULT '',
  provider_message_id TEXT    NOT NULL DEFAULT '',
  to_email            TEXT    NOT NULL DEFAULT '',
  status              TEXT    NOT NULL
                              CHECK (status IN ('sending','sent','failed','bounced','complained','delayed')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  claimed_at          INTEGER NOT NULL,
  sent_at             INTEGER,
  error               TEXT    NOT NULL DEFAULT '',
  seq                 INTEGER NOT NULL
);

-- This is the double-send guard: exactly one row per (customer, reminder, cycle, channel).
CREATE UNIQUE INDEX IF NOT EXISTS uq_reminder_log_send
  ON reminder_log (customer_id, reminder_key, cycle_seq, channel);

CREATE INDEX IF NOT EXISTS idx_reminder_log_customer_cycle ON reminder_log (customer_id, cycle_seq);
CREATE INDEX IF NOT EXISTS idx_reminder_log_status_claimed ON reminder_log (status, claimed_at);
CREATE INDEX IF NOT EXISTS idx_reminder_log_seq            ON reminder_log (seq);

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                    TEXT    PRIMARY KEY,
  email                 TEXT    NOT NULL UNIQUE,
  password_hash         TEXT    NOT NULL DEFAULT '',
  password_salt         TEXT    NOT NULL DEFAULT '',
  password_algo         TEXT    NOT NULL DEFAULT 'pbkdf2-sha256',
  password_iters        INTEGER NOT NULL DEFAULT 0,
  role                  TEXT    NOT NULL DEFAULT 'owner'
                                CHECK (role IN ('owner','tech')),
  failed_attempts       INTEGER NOT NULL DEFAULT 0,
  locked_until          INTEGER,
  setup_token_hash      TEXT    NOT NULL DEFAULT '',
  setup_token_expires_at INTEGER,
  setup_token_used_at   INTEGER,
  last_login_at         INTEGER,
  disabled_at           INTEGER,
  created_at            INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Sessions — id is sha256(token) hex; raw token is never stored
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  rotated_to   TEXT,
  grace_until  INTEGER,
  user_agent   TEXT    NOT NULL DEFAULT '',
  ip           TEXT    NOT NULL DEFAULT '',
  revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id   ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Settings — key/value store; seeded below
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('company_name',              '',                 0),
  ('timezone',                  'America/New_York',  0),
  ('reminder_send_hour',        '9',                0),
  ('overdue_reminders_enabled', '0',                0),
  ('max_sends_per_run',         '50',               0),
  ('email_enabled',             '0',                0),
  ('avg_job_price_cents',       '45000',            0),
  ('from_name',                 '',                 0),
  ('reply_to',                  '',                 0);

-- ---------------------------------------------------------------------------
-- Applied mutations log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS applied_mutations (
  mutation_id TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL DEFAULT '',
  applied_at  INTEGER NOT NULL,
  result_json TEXT    NOT NULL DEFAULT '{}'
);

-- ---------------------------------------------------------------------------
-- Webhook events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  svix_id      TEXT    PRIMARY KEY,
  event_type   TEXT    NOT NULL DEFAULT '',
  received_at  INTEGER NOT NULL,
  processed_at INTEGER,
  payload      TEXT    NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------------------
-- Import runs and flags
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_runs (
  id           TEXT    PRIMARY KEY,
  source       TEXT    NOT NULL DEFAULT '',
  row_count    INTEGER NOT NULL DEFAULT 0,
  note         TEXT    NOT NULL DEFAULT '',
  started_at   INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS import_flags (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  import_run_id TEXT    NOT NULL DEFAULT '',
  customer_id   TEXT    NOT NULL DEFAULT '',
  field         TEXT    NOT NULL DEFAULT '',
  severity      TEXT    NOT NULL DEFAULT 'info',
  message       TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  actor       TEXT    NOT NULL DEFAULT '',
  entity      TEXT    NOT NULL DEFAULT '',
  entity_id   TEXT    NOT NULL DEFAULT '',
  action      TEXT    NOT NULL DEFAULT '',
  before_json TEXT    NOT NULL DEFAULT '',
  after_json  TEXT    NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------------------
-- Job runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_runs (
  id           TEXT    PRIMARY KEY,
  job          TEXT    NOT NULL DEFAULT '',
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  status       TEXT    NOT NULL DEFAULT 'running',
  sent_count   INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  detail       TEXT    NOT NULL DEFAULT ''
);
