#!/usr/bin/env node
/**
 * preflight.mjs — verify all tenants have matching schema versions.
 *
 * For every tenant in tenants.config.mjs:
 *   1. Assert the D1 database exists (wrangler d1 info).
 *   2. Assert schema_meta.version equals the highest migration number on disk.
 *   3. Assert schema_meta.tenant_id equals the tenant key.
 *
 * Exits non-zero if any check fails.
 * --local variant is not supported (remote only).
 */

import { readdirSync } from 'fs'
import { spawnSync } from 'child_process'
import { resolve, join, dirname } from 'path'
import { fileURLToPath } from 'url'

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
// Scan migration files for highest number on disk
// ---------------------------------------------------------------------------
function highestMigrationOnDisk() {
  let files
  try {
    files = readdirSync(MIGRATIONS_DIR)
  } catch {
    return 0
  }
  const nums = files
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .map((f) => parseInt(f.split('_')[0], 10))
  return nums.length ? Math.max(...nums) : 0
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const { TENANTS } = await import('./tenants.config.mjs')
const expectedVersion = highestMigrationOnDisk()

console.log(`Expected schema version (highest migration on disk): ${expectedVersion}`)
console.log()

const rows = []
let anyFailed = false

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
    anyFailed = true
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
    anyFailed = true
    rows.push(result)
    continue
  }

  const meta = metaRows[0]
  result.version = meta.version ?? 0
  result.tenantId = meta.tenant_id ?? null

  if (result.version !== expectedVersion) {
    result.notes.push(`version ${result.version}, expected ${expectedVersion}`)
    anyFailed = true
  }

  if (result.tenantId !== key) {
    result.notes.push(`tenant_id '${result.tenantId}', expected '${key}'`)
    anyFailed = true
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

if (anyFailed) {
  console.error('PREFLIGHT FAILED: one or more tenants are not at the expected schema version.')
  process.exit(1)
}

console.log('Preflight passed.')
