-- D1 schema migration 0002 — customers: address_changed_at + US-box coordinate CHECK
--
-- Rules (same as 0001): no BEGIN/COMMIT (D1 rejects them in --file mode).
-- Moments = INTEGER ms epoch UTC.
--
-- Two changes to `customers`, and nothing else in the database is touched:
--
-- (a) NEW COLUMN address_changed_at INTEGER (nullable, ms epoch UTC).
--     Stamped by the client when someone edits a customer's address. A customer
--     reads as "not confirmed" while this stamp is newer than
--     location_confirmed_at: the pin is kept, it just stops looking settled.
--     Without the column the flag does not survive a round trip through D1 and a
--     typo fix in an address silently re-promotes a stale pin to "confirmed".
--
-- (b) REPLACED CHECK on lat/lng. 0001 had the globe-wide
--       CHECK (lat IS NULL OR lat BETWEEN -90 AND 90)
--       CHECK (lng IS NULL OR lng BETWEEN -180 AND 180)
--     which accepts (35.2, 0) off the coast of Algeria and (0, -81.17) in the
--     Gulf of Guinea and draws both as confident pins. Every address this
--     product stores is a US property, so those are not distant customers, they
--     are junk: a half-parsed geocoder response, a swapped pair, a 0 where a
--     number was missing. The client (src/lib/point.js) and the Worker
--     (worker/lib/geocode/geo.js) already reject them; this makes the database
--     agree, so the three cannot disagree about what a sane coordinate is.
--
--     The boxes below are transcribed from US_BOXES in worker/lib/geocode/geo.js
--     and must stay identical to it. If one changes, change all three (and add a
--     migration - this one is immutable).
--
-- NOT changed: lat/lng stay nullable and stay paired. "We do not know where this
-- is" is a legal state; half a coordinate is not.
--
-- ---------------------------------------------------------------------------
-- Why a table rebuild: SQLite cannot add, drop or alter a CHECK constraint.
-- The 12-step rebuild is the only way, and `customers` is the parent of foreign
-- keys in visits, photos and reminder_log.
--
-- D1 enforces foreign keys by default, so DROP TABLE customers does an implicit
-- delete of every parent row and the child references make it fail.
-- PRAGMA defer_foreign_keys = on holds enforcement until the end of the
-- transaction, by which point the rebuilt table is back under the name
-- `customers` and every child row resolves again. The children are NOT touched:
-- their REFERENCES clauses name `customers` and keep naming `customers`, which
-- is also why the new table is created under a temporary name and renamed LAST
-- (renaming the old table out of the way first would rewrite those clauses to
-- point at the temporary name, which is the silent-integrity-loss version of
-- this migration).
--
-- No FK here uses ON DELETE CASCADE - checked before writing this. If one ever
-- does, this pattern deletes the child rows for real, deferred or not.
--
-- ---------------------------------------------------------------------------
-- RE-RUNNING, AND RECOVERING FROM A HALF-FINISHED RUN
--
-- Normally neither happens: both runners apply a numbered file at most once
-- (scripts/migrate.mjs by schema_meta.version, vitest-pool-workers'
-- applyD1Migrations by name), so the ladder converges. The rest of this section
-- is for when the file is executed by hand anyway.
--
-- There is deliberately NO guard statement and NO `DROP TABLE IF EXISTS
-- customers_0002_new` in this file. Both were tried and both were removed: the
-- guard was the source of more defects than it prevented, and the conditional
-- DROP was the worst of them - in the one-statement window below it deleted the
-- only surviving copy of the book. What is left refuses by itself, because
-- `CREATE TABLE customers_0002_new` is unconditional and fails when that table
-- is already there. Do not add either back.
--
-- RE-RUN OF AN ALREADY-APPLIED FILE
--   It completes: it copies from `customers` (which by then has the new column),
--   rebuilds and renames. The schema is identical afterwards. It is NOT a no-op
--   though - the copy writes a literal NULL into address_changed_at, because on a
--   first run that column does not exist to read - so every address_changed_at
--   stamp is cleared. Nothing else changes and no customer is lost. No database
--   holds such a stamp today; if that stops being true, do not hand-run this file.
--
-- A run can die in three places.
--
-- DEATH A - at `DROP TABLE customers`, with
--       FOREIGN KEY constraint failed
--   which needs BOTH that PRAGMA defer_foreign_keys did not survive to that point
--   AND that visits/photos/reminder_log actually have rows. With those tables
--   empty the DROP succeeds instead, which is why an empty database cannot
--   rehearse this failure and one with history can hit it.
--
--   The database is INTACT: `customers` is still the 0001 table with every row,
--   every child row still points at it, and the residue is a leftover, fully
--   populated `customers_0002_new`. Confirm with
--       SELECT count(*) FROM "customers";
--       PRAGMA foreign_key_check;
--   Recover by dropping the leftover and running the file again:
--       DROP TABLE "customers_0002_new";
--   The import_flags rows the dead run wrote are not written twice.
--
-- DEATH B - between `DROP TABLE customers` and `ALTER TABLE ... RENAME`. One
--   statement wide, and the one that matters: `customers` is gone and every
--   customer row exists ONLY in `customers_0002_new`. Re-running the file stops
--   on its FIRST data statement, the import_flags insert, with
--       no such table: customers
--   (measured - it does not get as far as `CREATE TABLE customers_0002_new` and
--   its "already exists"), and it touches nothing. That error is itself the
--   signature of this state: `customers` missing is the whole diagnosis.
--   Recover with the rename the dead run did not reach:
--       ALTER TABLE "customers_0002_new" RENAME TO "customers";
--   which leaves you in DEATH C.
--
-- DEATH C - after the RENAME. The rebuild succeeded and only some of the three
--   CREATE INDEX statements at the bottom are missing. Run all three by hand;
--   they are `IF NOT EXISTS`, so that is right whichever of them got through.
--
-- Telling A from B: A has both tables, B has only `customers_0002_new`.
--       SELECT name FROM sqlite_master WHERE name IN ('customers', 'customers_0002_new');

-- ---------------------------------------------------------------------------
-- Rebuild `customers` with the US-box CHECK.
-- ---------------------------------------------------------------------------
PRAGMA defer_foreign_keys = on;

-- Any coordinate already stored outside the boxes cannot be copied into the new
-- table - it is exactly what the new CHECK rejects. It is dropped rather than
-- allowed to fail the migration, which matches what the app already does with
-- such a pin (src/lib/storage.js drops it on load, so it is invisible today
-- anyway) and keeps the customer's name, dates and notes. The pin is not lost
-- silently: one import_flags row per dropped pin records the coordinates, and
-- scripts/migrate.mjs prints a count and the customer ids at the end of the run,
-- so the operator sees it happen rather than finding it in a table years later.
INSERT INTO import_flags (import_run_id, customer_id, field, severity, message, created_at)
SELECT
  'migration_0002',
  id,
  'lat/lng',
  'warn',
  'Coordinates dropped by migration 0002: (' || lat || ', ' || lng ||
    ') is outside the US boxes. The customer needs a pin.',
  CAST(strftime('%s','now') AS INTEGER) * 1000
FROM customers
WHERE lat IS NOT NULL
  AND NOT (
       (lat >= 24.4 AND lat <= 49.4 AND lng >= -125.0 AND lng <= -66.9)
    OR (lat >= 51.0 AND lat <= 71.6 AND lng >= -180.0 AND lng <= -129.0)
    OR (lat >= 51.0 AND lat <= 53.0 AND lng >= 172.0  AND lng <= 180.0)
    OR (lat >= 18.8 AND lat <= 22.3 AND lng >= -160.3 AND lng <= -154.7)
    OR (lat >= 17.6 AND lat <= 18.6 AND lng >= -67.4  AND lng <= -64.5)
  )
  -- A run that died at the DROP (DEATH A) already wrote these rows and they were
  -- committed. Re-running the file must warn the operator once, not once per attempt.
  AND NOT EXISTS (
    SELECT 1 FROM import_flags f
    WHERE f.import_run_id = 'migration_0002' AND f.customer_id = customers.id
  );

-- Column definitions below are 0001's verbatim, with three deliberate changes:
-- address_changed_at added, the two old per-column coordinate CHECKs replaced by
-- the US-box CHECK, and `id` made NOT NULL.
--
-- That last one is not cosmetic. `id TEXT PRIMARY KEY` in 0001 does NOT imply
-- NOT NULL: SQLite's long-standing rowid-table quirk allows a NULL in any
-- primary key that is not INTEGER, so `INSERT INTO customers (id, ...) VALUES
-- (NULL, ...)` is accepted by 0001 as shipped. A customer with no id is broken
-- data - nothing can reference it, update it or delete it by id - and it also
-- breaks any copy step that has to ask "which rows have I already taken",
-- because every comparison against NULL answers NULL. After this migration it is
-- impossible; a database that already holds one fails at the copy below, loudly,
-- with everything still intact. That is the right outcome: such a row needs a
-- human to decide what its id should be, not a migration guessing.
CREATE TABLE customers_0002_new (
  id                   TEXT    NOT NULL PRIMARY KEY,
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
  lat                  REAL,
  lng                  REAL,
  -- How the pin got where it is, so the UI can tell an exact parcel from a road
  -- guess: '' | 'house' | 'house_approx' | 'road' | 'locality' | 'manual'.
  location_precision   TEXT    NOT NULL DEFAULT '',
  -- Stamped when a human drags the pin and accepts it. Lets the app surface
  -- "N pins were never confirmed" instead of silently trusting a geocoder.
  location_confirmed_at INTEGER,
  -- Stamped when someone edits the address. While this is newer than
  -- location_confirmed_at the pin is kept but reads as unconfirmed.
  address_changed_at   INTEGER,
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
  CHECK ((lat IS NULL) = (lng IS NULL)),
  -- The US-box rule. Transcribed from US_BOXES in worker/lib/geocode/geo.js:
  --   contiguous 48 + DC / Alaska east of the antimeridian / the Aleutians that
  --   cross it / Hawaii / Puerto Rico and the USVI.
  -- Coarse on purpose: a junk filter, not a service area.
  CHECK (
    lat IS NULL OR (
         (lat >= 24.4 AND lat <= 49.4 AND lng >= -125.0 AND lng <= -66.9)
      OR (lat >= 51.0 AND lat <= 71.6 AND lng >= -180.0 AND lng <= -129.0)
      OR (lat >= 51.0 AND lat <= 53.0 AND lng >= 172.0  AND lng <= 180.0)
      OR (lat >= 18.8 AND lat <= 22.3 AND lng >= -160.3 AND lng <= -154.7)
      OR (lat >= 17.6 AND lat <= 18.6 AND lng >= -67.4  AND lng <= -64.5)
    )
  )
);

-- The copy is TWO statements, split on the box test, rather than one statement
-- with CASE expressions per column. That is not a style choice:
-- wrangler's SQL splitter (unstable_splitSqlQuery, which both `wrangler d1
-- execute --file` and the vitest pool use to cut this file into statements)
-- pushes a frame on `CASE` and only pops it on `END` followed by a space or a
-- semicolon. `END,` - a CASE in the middle of a select list - never pops, so
-- every following `;` in the file stops being a statement boundary and the whole
-- rest of the migration is handed over as ONE query. Measured, not guessed.
-- Keep CASE out of this file. test/worker/migration-ladder.test.js fails if any
-- migration ever glues itself together like that again.
--
-- address_changed_at is NULL in both copies: the column did not exist before this
-- migration, so no row can have a stamp yet. The guard at the top is what stops a
-- re-run from writing these NULLs over real stamps.

-- (a) Rows that HAVE a real location: everything is carried over untouched.
INSERT INTO customers_0002_new (
  id, external_ref, name, address, phone, email, email_status, soft_bounce_count,
  lat, lng, location_precision, location_confirmed_at, address_changed_at,
  tank_size_gal, last_pumped, cycle_months, cycle_seq, notes, edited_in_app,
  reminder_baseline_at, field_ts, archived_at, created_at, updated_at, seq
)
SELECT
  id, external_ref, name, address, phone, email, email_status, soft_bounce_count,
  lat, lng, location_precision, location_confirmed_at, NULL,
  tank_size_gal, last_pumped, cycle_months, cycle_seq, notes, edited_in_app,
  reminder_baseline_at, field_ts, archived_at, created_at, updated_at, seq
FROM customers
WHERE lat IS NOT NULL
  AND (
       (lat >= 24.4 AND lat <= 49.4 AND lng >= -125.0 AND lng <= -66.9)
    OR (lat >= 51.0 AND lat <= 71.6 AND lng >= -180.0 AND lng <= -129.0)
    OR (lat >= 51.0 AND lat <= 53.0 AND lng >= 172.0  AND lng <= 180.0)
    OR (lat >= 18.8 AND lat <= 22.3 AND lng >= -160.3 AND lng <= -154.7)
    OR (lat >= 17.6 AND lat <= 18.6 AND lng >= -67.4  AND lng <= -64.5)
  );

-- (b) EVERY OTHER ROW: no pin at all, or a pin outside every box. The customer is
-- kept, the location is not, and neither is anything that describes it. A
-- precision label and a confirm stamp with no coordinates under them read as
-- "someone stood in that yard and accepted this" about a pin that does not
-- exist, which is the class of lie this migration exists to stop - so a row that
-- arrives here with a stale 'house'/confirmed pair and no coordinates loses it
-- too, not only the rows whose pin was junk.
--
-- The predicate is an anti-join on what (a) already took, NOT the negation of
-- (a)'s WHERE clause. Negating it would compare NULLs: for a row with lat set and
-- lng NULL every box test is NULL, so both a positive and a negated form would
-- skip it and the row would silently vanish from the rebuilt table. 0001's
-- CHECK ((lat IS NULL) = (lng IS NULL)) makes that row impossible today, but
-- "impossible" is not a good enough reason to write a copy step that can drop a
-- customer.
--
-- The anti-join uses `NOT EXISTS (... WHERE nt.id IS customers.id)`, with SQLite's
-- null-safe `IS`, and NOT `id NOT IN (SELECT id FROM customers_0002_new)`. The
-- NOT IN form has the identical NULL hazard one level up and it is reachable
-- without any broken constraint: 0001 permits a NULL id (see the NOT NULL note on
-- the new table above), and a single NULL-id row taken by (a) puts a NULL in that
-- subquery, after which `x NOT IN (..., NULL)` is NULL for EVERY x and (b)
-- inserts nothing at all. Measured: 3 rows in, 1 row out, run reports success.
-- With `IS`, a NULL id compares as a value like any other and every row is taken
-- exactly once - and the NOT NULL on the rebuilt table then stops the run before
-- the original is dropped.
INSERT INTO customers_0002_new (
  id, external_ref, name, address, phone, email, email_status, soft_bounce_count,
  lat, lng, location_precision, location_confirmed_at, address_changed_at,
  tank_size_gal, last_pumped, cycle_months, cycle_seq, notes, edited_in_app,
  reminder_baseline_at, field_ts, archived_at, created_at, updated_at, seq
)
SELECT
  id, external_ref, name, address, phone, email, email_status, soft_bounce_count,
  NULL, NULL, '', NULL, NULL,
  tank_size_gal, last_pumped, cycle_months, cycle_seq, notes, edited_in_app,
  reminder_baseline_at, field_ts, archived_at, created_at, updated_at, seq
FROM customers
WHERE NOT EXISTS (
  SELECT 1 FROM customers_0002_new nt WHERE nt.id IS customers.id
);

DROP TABLE customers;

ALTER TABLE customers_0002_new RENAME TO customers;

-- DROP TABLE took the indexes with it. These three are byte-identical to 0001.
CREATE INDEX IF NOT EXISTS idx_customers_seq         ON customers (seq);
CREATE INDEX IF NOT EXISTS idx_customers_last_pumped ON customers (last_pumped);
CREATE INDEX IF NOT EXISTS idx_customers_archived_at ON customers (archived_at);

PRAGMA defer_foreign_keys = off;
