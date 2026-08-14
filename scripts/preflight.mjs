#!/usr/bin/env node
/**
 * preflight.mjs — the deploy gate.
 *
 *   0. Assert worker/tenants.js, wrangler.jsonc and tenants.config.mjs describe
 *      the SAME database for every live host, and that every configured tenant
 *      timezone is one ICU knows (checkTenantWiring, no network).
 *
 * Then, for every tenant in tenants.config.mjs:
 *   1. Assert the D1 database exists (wrangler d1 info).
 *   2. Assert schema_meta.version equals the highest migration number on disk.
 *   3. Assert schema_meta.tenant_id equals the tenant key.
 *
 * Exits non-zero if any check fails, and says WHICH check failed: "one or more
 * tenants are not at the expected schema version" is the wrong diagnosis for a
 * wiring problem and sends whoever reads it to migrate a database that is fine.
 * --local variant is not supported (remote only).
 */

import { spawnSync } from 'child_process'
import { resolve, join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  highestMigrationNumber,
  readWranglerConfig,
  checkTenantWiring,
} from './deploy_checks.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')
const MIGRATIONS_DIR = join(ROOT, 'migrations')
// Spawn wrangler's JS entrypoint through this node binary, never the .bin shim.
// The shim is a .cmd on Windows, which Node will only spawn with shell:true,
// and shell:true does not quote arguments - so --command SQL gets split across
// argv and the query fails. shell:false passes argv through verbatim.
const WRANGLER_JS = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')

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

function wranglerInfo(dbname) {
  const result = wranglerRun(['d1', 'info', dbname, '--json'])
  if (result.error || result.status !== 0) return null
  try {
    return JSON.parse((result.stdout || '').trim())
  } catch {
    return null
  }
}

// --command, not --file: `d1 execute --file --json` is bulk-import mode and
// returns a summary instead of the selected rows.
function wranglerQuery(dbname, sql) {
  const result = wranglerRun(['d1', 'execute', dbname, '--command', sql, '--json', '--remote'])
  if (result.error) return null
  const text = (result.stdout || '').trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    if (!first || !first.success) return null
    return first.results || []
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const { TENANTS } = await import('./tenants.config.mjs')
const expectedVersion = highestMigrationNumber(MIGRATIONS_DIR)

console.log(`Expected schema version (highest migration on disk): ${expectedVersion}`)
console.log()

const rows = []
// Each check pushes its own sentence. The exit message is built from these, so a
// wiring failure never gets reported as a schema-version failure.
const failures = []

// ---------------------------------------------------------------------------
// Check 0: worker/tenants.js, wrangler.jsonc and tenants.config.mjs describe the
// SAME database for every live host. No network; see checkTenantWiring for what
// each kind of mismatch costs.
//
// Matching on the host string alone is not enough. A tenants.config entry can
// name a database that the hostname's binding does not resolve to, and then
// every check below inspects a database nobody serves: the table prints OK while
// the database the client actually reads sits at version 0.
// ---------------------------------------------------------------------------
const { LIVE_TENANTS } = await import('../worker/tenants.js')
const wiringProblems = checkTenantWiring({
  liveTenants: LIVE_TENANTS,
  tenants: TENANTS,
  wranglerConfig: readWranglerConfig(join(ROOT, 'wrangler.jsonc')),
})
for (const problem of wiringProblems) console.error(`ERROR: ${problem}`)
if (wiringProblems.length > 0) {
  console.log()
  failures.push(
    `tenant wiring is inconsistent (${wiringProblems.length} problem(s) listed above). ` +
      `worker/tenants.js, wrangler.jsonc and scripts/tenants.config.mjs do not agree on ` +
      `which database a live hostname reads. Do NOT migrate anything until they do.`
  )
}

for (const [key, cfg] of Object.entries(TENANTS)) {
  const dbname = cfg.d1
  const result = {
    tenant: key,
    database: dbname,
    dbExists: false,
    version: null,
    tenantId: null,
    pass: false,
    notes: [],
  }

  // Check 1: database exists
  const info = wranglerInfo(dbname)
  if (!info) {
    result.notes.push('DB not found or unreachable')
    rows.push(result)
    failures.push(`database '${dbname}' (tenant '${key}') was not found or was unreachable.`)
    continue
  }
  result.dbExists = true

  // Check 2 + 3: read schema_meta
  const metaRows = wranglerQuery(
    dbname,
    'SELECT version, tenant_id FROM schema_meta WHERE id = 1'
  )
  if (!metaRows || metaRows.length === 0) {
    result.version = 0
    result.tenantId = null
    result.notes.push(`version 0 (schema_meta missing or empty), expected ${expectedVersion}`)
    rows.push(result)
    failures.push(
      `tenant '${key}' (${dbname}) has no schema_meta row: it is at version 0, expected ` +
        `${expectedVersion}. Run: node scripts/migrate.mjs --tenant=${key}`
    )
    continue
  }

  const meta = metaRows[0]
  result.version = meta.version ?? 0
  result.tenantId = meta.tenant_id ?? null

  if (result.version !== expectedVersion) {
    result.notes.push(`version ${result.version}, expected ${expectedVersion}`)
    failures.push(
      `tenant '${key}' (${dbname}) is at schema version ${result.version}, expected ` +
        `${expectedVersion}. Run: node scripts/migrate.mjs --tenant=${key}`
    )
  }

  if (result.tenantId !== key) {
    result.notes.push(`tenant_id '${result.tenantId}', expected '${key}'`)
    failures.push(
      `tenant '${key}' (${dbname}) records tenant_id '${result.tenantId}'. That database was ` +
        `migrated as a different tenant - check you are pointed at the right one before ` +
        `touching it.`
    )
  }

  result.pass = result.version === expectedVersion && result.tenantId === key
  rows.push(result)
}

// ---------------------------------------------------------------------------
// Print table
// ---------------------------------------------------------------------------
const colWidths = {
  tenant:   Math.max(6,  ...rows.map((r) => r.tenant.length)),
  database: Math.max(8,  ...rows.map((r) => r.database.length)),
  version:  Math.max(7,  ...rows.map((r) => String(r.version ?? '-').length)),
  tenantId: Math.max(9,  ...rows.map((r) => String(r.tenantId ?? '-').length)),
  status:   Math.max(6,  ...rows.map((r) => (r.pass ? 'OK' : 'FAIL').length)),
  notes:    8,
}

function pad(s, w) {
  return String(s).padEnd(w)
}

const header = [
  pad('TENANT',    colWidths.tenant),
  pad('DATABASE',  colWidths.database),
  pad('VERSION',   colWidths.version),
  pad('TENANT_ID', colWidths.tenantId),
  pad('STATUS',    colWidths.status),
  'NOTES',
].join('  ')

const sep = '-'.repeat(header.length)
console.log(sep)
console.log(header)
console.log(sep)

for (const r of rows) {
  console.log([
    pad(r.tenant,              colWidths.tenant),
    pad(r.database,            colWidths.database),
    pad(r.version ?? '-',      colWidths.version),
    pad(r.tenantId ?? '-',     colWidths.tenantId),
    pad(r.pass ? 'OK' : 'FAIL', colWidths.status),
    r.notes.join('; ') || (r.pass ? 'ok' : ''),
  ].join('  '))
}

console.log(sep)
console.log()

if (failures.length > 0) {
  console.error('PREFLIGHT FAILED:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

console.log('Preflight passed.')
