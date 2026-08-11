#!/usr/bin/env node
/**
 * migrate.mjs - apply pending D1 schema migrations to one named tenant.
 *
 * Usage:
 *   node scripts/migrate.mjs --tenant=dev [--local] [--dry-run]
 *
 * --tenant   REQUIRED. Tenant key from scripts/tenants.config.mjs.
 * --local    Run against the local wrangler dev database instead of the remote.
 * --dry-run  Print what would be applied and exit 0 WITHOUT writing anything.
 *            It still reads the database and still runs every safety check
 *            below, so it exits 1 on a check that fails. A dry run that skipped
 *            the checks would report "1 pending migration" for a tree the real
 *            run refuses to touch.
 *
 * Safety checks, all of them fail-closed (exit 1) in both modes:
 *
 * 1. One file per migration number. Two files numbered 0002 are ambiguous about
 *    what "version 2" contains and about which one ran.
 *
 * 2. Migration immutability. Numbered files must never change after they have
 *    been applied. The sha256 of every applied file is stored in the
 *    'migration_hashes' settings row (JSON array of {num, sha256}); each run
 *    compares the on-disk content against it.
 *
 * 3. A stored hash must EXIST for every applied migration. Missing is a hard
 *    failure, not a warning: it used to print "Skipping verify" and continue,
 *    which meant deleting one settings row turned check 2 off entirely and left
 *    a line in a log nobody reads as the only trace. Re-record deliberately
 *    (see the message the failure prints) rather than by running the tool.
 */

import { createHash } from 'crypto'
import { readdirSync, readFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { resolve, join, dirname } from 'path'
import { fileURLToPath } from 'url'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')
const MIGRATIONS_DIR = join(ROOT, 'migrations')
// Invoke wrangler's JS entrypoint through this same node binary rather than the
// node_modules/.bin shim. The shim is a .cmd on Windows, Node refuses to spawn
// a .cmd without shell:true, and shell:true does not quote arguments - so any
// --command SQL containing a space gets split across argv and wrangler answers
// "Unknown arguments: INTO, schema_meta, ...". Going straight to the .js file
// lets us spawn with shell:false, where argv is passed through verbatim.
const WRANGLER_JS = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const tenantArg = args.find((a) => a.startsWith('--tenant='))
const local = args.includes('--local')
const dryRun = args.includes('--dry-run')

if (!tenantArg) {
  console.error('ERROR: --tenant=<name> is required.')
  console.error('Usage: node scripts/migrate.mjs --tenant=dev [--local] [--dry-run]')
  process.exit(1)
}

const tenantKey = tenantArg.slice('--tenant='.length).trim()
if (!tenantKey) {
  console.error('ERROR: --tenant value must not be empty.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Tenant config
// ---------------------------------------------------------------------------
const { TENANTS } = await import('./tenants.config.mjs')
const tenant = TENANTS[tenantKey]
if (!tenant) {
  console.error(`ERROR: Unknown tenant '${tenantKey}'. Known tenants: ${Object.keys(TENANTS).join(', ')}`)
  process.exit(1)
}

const dbname = tenant.d1
console.log(`Tenant:   ${tenantKey}`)
console.log(`Database: ${dbname}`)
console.log(`Host:     ${tenant.host}`)
console.log(`Mode:     ${dryRun ? 'dry-run' : local ? 'local' : 'remote'}`)
console.log()

// ---------------------------------------------------------------------------
// Wrangler helpers
// ---------------------------------------------------------------------------
function wranglerRun(wArgs) {
  return spawnSync(process.execPath, [WRANGLER_JS, ...wArgs], {
    encoding: 'utf8',
    cwd: ROOT,
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  })
}

/**
 * Read rows back from D1.
 *
 * Must use --command, not --file: `d1 execute --file --json` is bulk-import
 * mode and returns a summary ("Total queries executed", "Rows read") instead of
 * the selected rows. Verified against the live database. --command is safe here
 * only because wranglerRun spawns with shell:false; see WRANGLER_JS above.
 */
function wranglerQuery(sql) {
  const wArgs = ['d1', 'execute', dbname, '--command', sql, '--json']
  if (local) wArgs.push('--local')
  else wArgs.push('--remote')
  const result = wranglerRun(wArgs)
  if (result.error) throw result.error
  const text = (result.stdout || '').trim()
  const err = (result.stderr || '') + text
  // "the table does not exist yet" is the one failure that legitimately means
  // "nothing has been migrated". Everything else - no such database, bad auth,
  // no network - must NOT be mistaken for a fresh database, because that would
  // re-apply migrations against a database whose real state is unknown.
  if (result.status !== 0 || !text) {
    if (/no such table/i.test(err)) return { missingTable: true, rows: [] }
    throw new Error(
      `wrangler d1 execute --json failed (exit ${result.status}):\n${result.stderr || text}`
    )
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`wrangler d1 execute --json returned unparseable output:\n${text}`)
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed
  if (!first || !first.success) {
    if (/no such table/i.test(JSON.stringify(parsed))) return { missingTable: true, rows: [] }
    throw new Error(`query reported failure:\n${text}`)
  }
  return { missingTable: false, rows: first.results || [] }
}

function wranglerExecuteFile(filePath) {
  const wArgs = ['d1', 'execute', dbname, '--file', filePath]
  if (local) wArgs.push('--local')
  else wArgs.push('--remote')
  const result = wranglerRun(wArgs)
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `wrangler d1 execute failed (exit ${result.status}):\n${result.stderr || result.stdout}`
    )
  }
}

function wranglerExecuteSQL(sql) {
  const wArgs = ['d1', 'execute', dbname, '--command', sql]
  if (local) wArgs.push('--local')
  else wArgs.push('--remote')
  const result = wranglerRun(wArgs)
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `wrangler d1 execute failed (exit ${result.status}):\n${result.stderr || result.stdout}`
    )
  }
}

// ---------------------------------------------------------------------------
// Scan migration files
// ---------------------------------------------------------------------------
function scanMigrations() {
  let files
  try {
    files = readdirSync(MIGRATIONS_DIR)
  } catch {
    console.error(`ERROR: Cannot read migrations directory: ${MIGRATIONS_DIR}`)
    process.exit(1)
  }
  return files
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .map((f) => {
      const num = parseInt(f.split('_')[0], 10)
      const path = join(MIGRATIONS_DIR, f)
      return { num, name: f, path }
    })
}

// ---------------------------------------------------------------------------
// Hash helper
// ---------------------------------------------------------------------------
function sha256File(filePath) {
  const content = readFileSync(filePath, 'utf8')
  return createHash('sha256').update(content).digest('hex')
}

// ---------------------------------------------------------------------------
// Read current version from schema_meta
// ---------------------------------------------------------------------------
function getCurrentVersion() {
  // Deliberately NOT wrapped in a catch-all. An unreachable database or a bad
  // credential must abort, not read as "fresh database, apply everything".
  const { missingTable, rows } = wranglerQuery(
    'SELECT version FROM schema_meta WHERE id = 1'
  )
  if (missingTable || rows.length === 0) return 0
  return rows[0].version ?? 0
}

// ---------------------------------------------------------------------------
// Read stored migration hashes from settings
// ---------------------------------------------------------------------------
function getStoredHashes() {
  // An empty result is legitimate (nothing applied yet). A malformed value is
  // not: silently returning [] there would skip the immutability check, which
  // is the one thing this function exists to enforce.
  const { missingTable, rows } = wranglerQuery(
    "SELECT value FROM settings WHERE key = 'migration_hashes'"
  )
  if (missingTable || rows.length === 0) return []
  try {
    return JSON.parse(rows[0].value)
  } catch {
    throw new Error(
      `settings.migration_hashes is not valid JSON. Refusing to run: the ` +
        `migration immutability check cannot be performed. Value: ${rows[0].value}`
    )
  }
}

// ---------------------------------------------------------------------------
// Upsert schema_meta and migration_hashes after applying migrations
// ---------------------------------------------------------------------------
function recordApplied(version, hashes) {
  const appliedAt = Date.now()

  // Upsert schema_meta (seeded by runner)
  const escapedTenant = tenantKey.replace(/'/g, "''")
  wranglerExecuteSQL(
    `INSERT INTO schema_meta (id, version, tenant_id, applied_at)` +
    ` VALUES (1, ${version}, '${escapedTenant}', ${appliedAt})` +
    ` ON CONFLICT(id) DO UPDATE SET version=${version},` +
    ` tenant_id='${escapedTenant}', applied_at=${appliedAt}`
  )

  // Store hashes in settings
  const hashesJson = JSON.stringify(hashes).replace(/'/g, "''")
  wranglerExecuteSQL(
    `INSERT INTO settings (key, value, updated_at)` +
    ` VALUES ('migration_hashes', '${hashesJson}', ${appliedAt})` +
    ` ON CONFLICT(key) DO UPDATE SET value='${hashesJson}', updated_at=${appliedAt}`
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const migrations = scanMigrations()
if (migrations.length === 0) {
  console.log('No migration files found.')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Check 1: one file per number. Runs before anything touches the database, so
// the message is about the tree in front of you and not about the schema.
//
// Without it, a NEW file that reuses an applied number is caught further down by
// the hash check and reported as "0001 has been modified after it was applied",
// which is a different accident with a different fix and sends whoever reads it
// looking for an edit that never happened.
// ---------------------------------------------------------------------------
const byNum = new Map()
for (const m of migrations) {
  if (!byNum.has(m.num)) byNum.set(m.num, [])
  byNum.get(m.num).push(m.name)
}
const duplicates = [...byNum.entries()].filter(([, names]) => names.length > 1)
if (duplicates.length > 0) {
  for (const [num, names] of duplicates) {
    console.error(
      `ERROR: migration number ${String(num).padStart(4, '0')} is used by ${names.length} files: ${names.join(', ')}`
    )
  }
  console.error('Each migration number must belong to exactly one file. Renumber the new one.')
  process.exit(1)
}

const highestOnDisk = migrations[migrations.length - 1].num

// Reads the database in every mode, dry-run included. Only a missing table
// reads as version 0; an unreachable database or a bad credential throws (see
// wranglerQuery), because "I could not ask" must never look like "nothing is
// applied".
const currentVersion = getCurrentVersion()
console.log(`Current schema version: ${currentVersion}`)
console.log(`Highest migration on disk: ${highestOnDisk}`)
console.log()

const applied = migrations.filter((m) => m.num <= currentVersion)
const pending = migrations.filter((m) => m.num > currentVersion)

// ---------------------------------------------------------------------------
// Checks 2 and 3: immutability of applied migrations (skip only if none applied
// yet). Runs in dry-run too - a dry run is how you find out whether the real run
// is safe, so a dry run that skips the safety checks answers the wrong question.
// ---------------------------------------------------------------------------
if (applied.length > 0) {
  const storedHashes = getStoredHashes()
  const storedMap = new Map(storedHashes.map((h) => [h.num, h.sha256]))

  for (const m of applied) {
    const onDisk = sha256File(m.path)
    const stored = storedMap.get(m.num)
    if (stored === undefined) {
      console.error(`ERROR: No stored hash for applied migration ${m.name}.`)
      console.error(
        '  The immutability check cannot run without it, and continuing would mean ' +
          'applying migrations against a schema whose history is unverifiable.'
      )
      console.error(
        `  Either settings.migration_hashes was deleted or edited, or ${m.name} was ` +
          'applied by something other than this script.'
      )
      console.error(
        `  If the file on disk is definitely what was applied, record it deliberately:\n` +
          `    on-disk sha256 of ${m.name}: ${onDisk}\n` +
          `    then add {"num": ${m.num}, "sha256": "${onDisk}"} to the JSON array in the ` +
          `settings row with key 'migration_hashes'.`
      )
      process.exit(1)
    }
    if (stored !== onDisk) {
      console.error(`ERROR: Migration ${m.name} has been modified after it was applied!`)
      console.error(`  Stored sha256:  ${stored}`)
      console.error(`  On-disk sha256: ${onDisk}`)
      console.error('Migrations are immutable. Do not edit applied files.')
      process.exit(1)
    }
  }
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------
if (dryRun) {
  if (pending.length === 0) {
    console.log('Schema is up to date. Nothing to apply.')
  } else {
    console.log(`Pending migrations (${pending.length}):`)
    for (const m of pending) {
      console.log(`  [${m.num}] ${m.name}`)
    }
    console.log()
    console.log('(dry-run: nothing was applied)')
  }
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Apply pending migrations
// ---------------------------------------------------------------------------
if (pending.length === 0) {
  console.log('Schema is already up to date.')
  process.exit(0)
}

console.log(`Applying ${pending.length} migration(s)...`)
const storedHashes = getStoredHashes()
const hashesMap = new Map(storedHashes.map((h) => [h.num, h.sha256]))

for (const m of pending) {
  console.log(`  Applying: ${m.name}`)
  wranglerExecuteFile(m.path)
  hashesMap.set(m.num, sha256File(m.path))
  console.log(`  Applied:  ${m.name} ✓`)
}

// Collect all hashes (applied + newly applied) in ascending order
const allHashes = migrations
  .filter((m) => m.num <= highestOnDisk)
  .map((m) => ({ num: m.num, sha256: hashesMap.get(m.num) || sha256File(m.path) }))

const newVersion = pending[pending.length - 1].num
recordApplied(newVersion, allHashes)

console.log()
console.log(`Schema version is now: ${newVersion}`)
