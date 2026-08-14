/**
 * Pure deploy-time checks, kept out of the scripts that run them so they can be
 * tested without spawning wrangler.
 *
 * Everything here reads files and objects and returns values. Nothing here talks
 * to Cloudflare, and nothing here prints. scripts/migrate.mjs and
 * scripts/preflight.mjs do the talking and the printing.
 */

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Migrations on disk
//
// migrate.mjs and preflight.mjs used to scan the directory separately - one
// sorted the filenames and took the last, the other took Math.max. They agreed
// by luck. They are the two halves of one contract ("the version a migration run
// records" and "the version a deploy expects to find"), so they read it from the
// same function now.
// ---------------------------------------------------------------------------

const MIGRATION_FILE = /^\d{4}_.*\.sql$/

/**
 * @returns {{num:number,name:string,path:string}[]} ascending by number,
 *          or null if the directory cannot be read.
 */
export function scanMigrations(dir) {
  let files
  try {
    files = readdirSync(dir)
  } catch {
    return null
  }
  return files
    .filter((f) => MIGRATION_FILE.test(f))
    .sort()
    .map((f) => ({ num: parseInt(f.split('_')[0], 10), name: f, path: join(dir, f) }))
}

/** The version a fully-migrated database must record. 0 when there are none. */
export function highestMigrationNumber(dir) {
  const migrations = scanMigrations(dir)
  if (!migrations || migrations.length === 0) return 0
  return Math.max(...migrations.map((m) => m.num))
}

/** Migration numbers used by more than one file. Ambiguous about what "version N" is. */
export function duplicateMigrationNumbers(dir) {
  const migrations = scanMigrations(dir) || []
  const byNum = new Map()
  for (const m of migrations) {
    if (!byNum.has(m.num)) byNum.set(m.num, [])
    byNum.get(m.num).push(m.name)
  }
  return [...byNum.entries()].filter(([, names]) => names.length > 1)
}

// ---------------------------------------------------------------------------
// wrangler.jsonc
// ---------------------------------------------------------------------------

/**
 * JSONC -> object. Comments only, which is all wrangler.jsonc uses, plus trailing
 * commas because JSONC allows them and a future edit may add one.
 *
 * String-aware on purpose: a naive regex would cut a "//" inside a URL out of the
 * middle of a value and produce config that parses but is wrong, which is a worse
 * failure than not parsing at all.
 */
export function stripJsonComments(text) {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (inLine) {
      if (c === '\n') { inLine = false; out += c }
      continue
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i++ }
      continue
    }
    if (inString) {
      out += c
      if (c === '\\') { out += next ?? ''; i++ } else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (c === '/' && next === '/') { inLine = true; i++; continue }
    if (c === '/' && next === '*') { inBlock = true; i++; continue }
    out += c
  }
  // Trailing commas: only outside strings, which is where we are by now.
  return out.replace(/,(\s*[}\]])/g, '$1')
}

export function readWranglerConfig(path) {
  return JSON.parse(stripJsonComments(readFileSync(path, 'utf8')))
}

// ---------------------------------------------------------------------------
// Tenant timezone
// ---------------------------------------------------------------------------

/**
 * Would the runtime accept this string as a timezone?
 *
 * Asked the way the runtime asks it - construct an Intl.DateTimeFormat and let
 * a RangeError be the answer - rather than against a hardcoded list of zones,
 * which would go stale the first time the IANA database gains an entry and
 * would fail a tenant whose zone is perfectly good.
 *
 * This runs under Node while the code it protects runs under workerd. Both ship
 * full ICU (test/worker/icu_probe.test.js is the workerd half of that guard), so
 * the two answers agree for every real zone; a zone so new that only one of them
 * knows it would be the one gap, and it is a far smaller gap than not checking.
 *
 * Only RangeError means "invalid". Anything else is a runtime without ICU at
 * all, and swallowing that would turn a broken toolchain into a green deploy.
 */
export function isValidTimeZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch (error) {
    if (error instanceof RangeError) return false
    throw error
  }
}

// ---------------------------------------------------------------------------
// Tenant wiring
// ---------------------------------------------------------------------------

/**
 * Are the three lists that decide which database a client's hostname reads
 * actually describing the same database?
 *
 *   worker/tenants.js LIVE_TENANTS  host -> binding name    (what the Worker routes on)
 *   wrangler.jsonc    d1_databases  binding -> database     (what the deploy binds)
 *   scripts/tenants.config.mjs      tenant key -> database  (what preflight migrates and checks)
 *
 * Any two of them can agree while the third points somewhere else. The failures
 * that produces are all silent until a client is on the phone:
 *
 *   - host in LIVE_TENANTS, no entry in tenants.config -> preflight never checks
 *     that database, so an unmigrated tenant deploys green.
 *   - host in LIVE_TENANTS, binding not in wrangler.jsonc -> resolveTenant fails
 *     closed and every /api path on that hostname answers 503.
 *   - all three present but the binding resolves to a DIFFERENT database than the
 *     one tenants.config names -> preflight checks the wrong database and passes
 *     while the real one is at version 0. This is the one host-string matching
 *     alone cannot see.
 *
 *   - host configured with a timezone ICU does not know -> that host's GET /api/sync
 *     throws, the operator's app does not load, and the reminder cron stops mailing
 *     that book. Not a wiring mismatch, but the same shape of failure: a deploy-time
 *     typo nothing downstream sees. This config value is the tenant's ONLY calendar
 *     input, so rejecting it here is what keeps a bad zone off a live tenant.
 *
 *   - TWO LIVE HOSTS ON ONE BINDING -> two paying clients reading and writing one
 *     customer book. This is the worst failure this product can have, it is
 *     invisible to every per-host check (each host is individually consistent),
 *     and it protects clients who do not exist yet and so cannot be tested for
 *     later. It is checked separately, below the per-host loop.
 *
 * Everything here looks for the SECOND match, not the first. Each of these bugs
 * is a list with a duplicate in it, and a `.find()` walks straight past the entry
 * that is wrong.
 *
 * @returns {string[]} one sentence per problem; empty means consistent.
 */
export function checkTenantWiring({ liveTenants, tenants, wranglerConfig }) {
  const problems = []
  const d1 = wranglerConfig.d1_databases || []
  const r2 = wranglerConfig.r2_buckets || []

  // ---- duplicates that make the per-host checks below meaningless -----------

  // Two clients, one book. Nothing downstream catches this as itself: preflight
  // would report it, if at all, as "was migrated as a different tenant".
  const hostsByBinding = new Map()
  for (const [host, cfg] of Object.entries(liveTenants)) {
    if (!hostsByBinding.has(cfg.db)) hostsByBinding.set(cfg.db, [])
    hostsByBinding.get(cfg.db).push(host)
  }
  for (const [binding, hosts] of hostsByBinding) {
    if (hosts.length > 1) {
      problems.push(
        `${hosts.length} live hosts share the D1 binding '${binding}': ${hosts.join(', ')}. ` +
          `Every one of them reads and writes the same customer book. If these are different ` +
          `clients this is a data breach in both directions; give each host its own binding ` +
          `and its own database.`
      )
    }
  }

  // A second TENANTS entry for the same host is invisible to a lookup by host,
  // so the wrong one can be the one that is actually checked.
  const keysByHost = new Map()
  for (const [key, t] of Object.entries(tenants)) {
    if (!keysByHost.has(t.host)) keysByHost.set(t.host, [])
    keysByHost.get(t.host).push(key)
  }
  for (const [host, keys] of keysByHost) {
    if (keys.length > 1) {
      problems.push(
        `scripts/tenants.config.mjs has ${keys.length} entries for host '${host}': ` +
          `${keys.join(', ')}. Which database gets migrated and version-checked for that host ` +
          `is then decided by object order. Keep one entry per host.`
      )
    }
  }

  // Same binding declared twice in wrangler.jsonc: the deploy binds one of them
  // and every lookup here would find the other.
  const bindingCounts = new Map()
  for (const b of d1) bindingCounts.set(b.binding, (bindingCounts.get(b.binding) || 0) + 1)
  for (const [binding, count] of bindingCounts) {
    if (count > 1) {
      const names = d1.filter((b) => b.binding === binding).map((b) => b.database_name)
      problems.push(
        `wrangler.jsonc declares the D1 binding '${binding}' ${count} times, for databases ` +
          `${names.join(', ')}. Only one of them is what the Worker gets. Remove the duplicate.`
      )
    }
  }

  // ---- per-host wiring -----------------------------------------------------

  for (const [host, cfg] of Object.entries(liveTenants)) {
    const entries = Object.entries(tenants).filter(([, t]) => t.host === host)
    const entry = entries.length === 1 ? entries[0] : null

    if (entries.length === 0) {
      problems.push(
        `'${host}' is a live tenant in worker/tenants.js, but no entry in ` +
          `scripts/tenants.config.mjs has that host, so its schema version is never checked. ` +
          `Add it to TENANTS in the same change that puts it in LIVE_TENANTS.`
      )
    }

    const bindings = d1.filter((b) => b.binding === cfg.db)
    const binding = bindings.length === 1 ? bindings[0] : null

    if (bindings.length === 0) {
      problems.push(
        `'${host}' routes to the D1 binding '${cfg.db}', which is not declared in ` +
          `wrangler.jsonc. That host would resolve misconfigured and answer 503 on every ` +
          `/api path. Add the binding in the same deploy.`
      )
    }

    // Skipped when either side is ambiguous - the duplicate is already reported
    // above, and comparing against an arbitrary one of two would be noise.
    if (entry && binding && binding.database_name !== entry[1].d1) {
      const [key, tenant] = entry
      problems.push(
        `'${host}' routes to binding '${cfg.db}', which wrangler.jsonc binds to database ` +
          `'${binding.database_name}', but tenant '${key}' in scripts/tenants.config.mjs names ` +
          `database '${tenant.d1}'. Preflight would migrate and version-check ` +
          `'${tenant.d1}' while the hostname actually reads '${binding.database_name}'. ` +
          `Make them the same database.`
      )
    }

    // A tenant timezone ICU does not recognise is a one-word typo with a cost
    // out of all proportion to it. The send path formats the tenant calendar
    // with ICU and no offset fallback - deliberately, because a silent fallback
    // would hide a misconfigured tenant and send that client's mail on the wrong
    // day, and mail at 3am reads as a compromised account.
    //
    // THIS CHECK IS THE WHOLE GUARANTEE. `cfg.timezone` is the tenant config,
    // and since the settings-row override was removed it is the ONLY input to a
    // tenant's calendar (worker/tenants.js tenantZone; the `timezone` row in the
    // client's D1 is dead data that nothing reads). Everything downstream - the
    // app's bootstrap, the sent-history dates, the send hour and the local day
    // the cron mails on - is computed from the string checked here, so a zone
    // this rejects can never reach a running tenant.
    //
    // That is why the check must stay even though app.pumpcycle.net's zone is
    // obviously fine: it protects the client who does not exist yet, whose zone
    // gets typed on the day he is provisioned. Same reason as the
    // two-hosts-one-binding check above.
    //
    // Absent or empty is NOT a failure: both are falsy in tenantZone, so the
    // product default applies and ICU is never handed the value.
    if (cfg.timezone !== undefined && cfg.timezone !== '' && !isValidTimeZone(cfg.timezone)) {
      problems.push(
        `'${host}' is configured with the timezone '${cfg.timezone}', which is not a timezone ` +
          `this runtime knows. The reminder cron formats every tenant-local date and hour with ` +
          `ICU and has no offset fallback, so this host's scheduled send would fail rather than ` +
          `mail at the wrong hour. Use an IANA zone name such as 'America/New_York'.`
      )
    }

    if (cfg.r2 && !r2.some((b) => b.binding === cfg.r2)) {
      problems.push(
        `'${host}' names the R2 binding '${cfg.r2}', which is not declared in wrangler.jsonc. ` +
          `That host would resolve misconfigured and answer 503.`
      )
    }
  }

  return problems
}
