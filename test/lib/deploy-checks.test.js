/**
 * The deploy gate's pure half.
 *
 * These are the checks that decide "is this tree safe to deploy" - the recorded
 * schema version, and whether the three lists that pick a client's database
 * agree. They run against the real repo files here, so the assertions are about
 * THIS tree, not about a fixture.
 *
 * The half that talks to Cloudflare (does the database exist, what version does
 * it report) cannot run here and is preflight.mjs's job.
 */
import { describe, it, expect } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  scanMigrations,
  highestMigrationNumber,
  duplicateMigrationNumbers,
  stripJsonComments,
  readWranglerConfig,
  checkTenantWiring,
  isValidTimeZone,
} from '../../scripts/deploy_checks.mjs'
import { TENANTS } from '../../scripts/tenants.config.mjs'
import { LIVE_TENANTS } from '../../worker/tenants.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const MIGRATIONS = path.join(ROOT, 'migrations')
const WRANGLER = path.join(ROOT, 'wrangler.jsonc')

// ---------------------------------------------------------------------------
// The recorded schema version
// ---------------------------------------------------------------------------
describe('migrations on disk', () => {
  it('is 0001 then 0002 then 0003 then 0004, in order', () => {
    const found = scanMigrations(MIGRATIONS)
    expect(found.map((m) => m.num)).toEqual([1, 2, 3, 4])
    expect(found[0].name).toMatch(/^0001_/)
    expect(found[1].name).toMatch(/^0002_/)
    expect(found[2].name).toMatch(/^0003_/)
    expect(found[3].name).toMatch(/^0004_/)
  })

  /**
   * migrate.mjs records `pending[pending.length - 1].num` and preflight.mjs
   * expects `highestMigrationNumber`. Both read this one function, and both
   * numbers are asserted to be 4, so "the version a migration run writes" and
   * "the version a deploy demands" cannot drift apart.
   */
  it('a full run records version 4, and a deploy expects version 4', () => {
    const found = scanMigrations(MIGRATIONS)
    const versionAfterFullRun = found[found.length - 1].num // what migrate.mjs writes
    const versionPreflightExpects = highestMigrationNumber(MIGRATIONS)

    expect(versionAfterFullRun).toBe(4)
    expect(versionPreflightExpects).toBe(4)
    expect(versionAfterFullRun).toBe(versionPreflightExpects)
  })

  it('no migration number is used by two files', () => {
    expect(duplicateMigrationNumbers(MIGRATIONS)).toEqual([])
  })

  it('reports an unreadable directory as null rather than as "nothing applied"', () => {
    expect(scanMigrations(path.join(ROOT, 'no-such-directory'))).toBeNull()
    expect(highestMigrationNumber(path.join(ROOT, 'no-such-directory'))).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// wrangler.jsonc parsing
// ---------------------------------------------------------------------------
describe('stripJsonComments', () => {
  it('removes line and block comments', () => {
    expect(JSON.parse(stripJsonComments('{"a":1 // hi\n, "b":2 /* there */ }'))).toEqual({
      a: 1,
      b: 2,
    })
  })

  it('does not cut a // out of the middle of a string', () => {
    const src = '{"url":"https://example.com/x", "n":1}'
    expect(JSON.parse(stripJsonComments(src))).toEqual({ url: 'https://example.com/x', n: 1 })
  })

  it('survives an escaped quote before a comment marker', () => {
    const src = '{"a":"say \\"hi\\" // not a comment", "b":2}'
    expect(JSON.parse(stripJsonComments(src))).toEqual({ a: 'say "hi" // not a comment', b: 2 })
  })

  it('tolerates trailing commas', () => {
    expect(JSON.parse(stripJsonComments('{"a":[1,2,],}'))).toEqual({ a: [1, 2] })
  })

  it('parses the real wrangler.jsonc', () => {
    const cfg = readWranglerConfig(WRANGLER)
    expect(cfg.name).toBe('pumpcycle')
    expect(cfg.d1_databases.map((d) => d.binding)).toContain('DB_DEV')
  })
})

// ---------------------------------------------------------------------------
// Tenant wiring
// ---------------------------------------------------------------------------
describe('checkTenantWiring on this repo', () => {
  const wranglerConfig = readWranglerConfig(WRANGLER)

  it('the tree as committed is consistent', () => {
    expect(
      checkTenantWiring({ liveTenants: LIVE_TENANTS, tenants: TENANTS, wranglerConfig })
    ).toEqual([])
  })

  it('app.pumpcycle.net really does resolve to the database preflight checks', () => {
    // Spelled out rather than left to the function: binding -> database_name -> tenant.
    const binding = wranglerConfig.d1_databases.find(
      (d) => d.binding === LIVE_TENANTS['app.pumpcycle.net'].db
    )
    expect(binding.database_name).toBe(TENANTS.dev.d1)
    expect(TENANTS.dev.host).toBe('app.pumpcycle.net')
  })
})

describe('checkTenantWiring catches each way the three lists can disagree', () => {
  const wranglerConfig = {
    d1_databases: [
      { binding: 'DB_DEV', database_name: 'pumpcycle-dev' },
      { binding: 'DB_CLIENT2', database_name: 'pumpcycle-client2' },
    ],
    r2_buckets: [],
  }
  const tenants = {
    dev: { d1: 'pumpcycle-dev', host: 'app.pumpcycle.net' },
  }
  const liveTenants = { 'app.pumpcycle.net': { db: 'DB_DEV' } }

  it('passes when everything agrees', () => {
    expect(checkTenantWiring({ liveTenants, tenants, wranglerConfig })).toEqual([])
  })

  it('a live host with no tenants.config entry is caught', () => {
    const problems = checkTenantWiring({
      liveTenants: { ...liveTenants, 'client2.example': { db: 'DB_CLIENT2' } },
      tenants,
      wranglerConfig,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('client2.example')
    expect(problems[0]).toContain('never checked')
  })

  it('a live host whose binding is not in wrangler.jsonc is caught', () => {
    const problems = checkTenantWiring({
      liveTenants: { 'app.pumpcycle.net': { db: 'DB_NOT_DECLARED' } },
      tenants,
      wranglerConfig,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('DB_NOT_DECLARED')
    expect(problems[0]).toContain('503')
  })

  /**
   * The one host-string matching alone cannot see, and the reason this check
   * exists: a second client is added, its tenants.config entry still names the
   * dev database, and its binding resolves somewhere else. Preflight would
   * migrate and version-check pumpcycle-dev, report OK, and the database the
   * client's hostname actually reads would never be looked at.
   */
  it('a tenant entry naming a different database than the binding resolves to is caught', () => {
    const problems = checkTenantWiring({
      liveTenants: {
        'app.pumpcycle.net': { db: 'DB_DEV' },
        'client2.example': { db: 'DB_CLIENT2' },
      },
      tenants: {
        ...tenants,
        client2: { d1: 'pumpcycle-dev', host: 'client2.example' }, // wrong database
      },
      wranglerConfig,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('pumpcycle-client2')
    expect(problems[0]).toContain('pumpcycle-dev')
    expect(problems[0]).toContain('Preflight would migrate')
  })

  /**
   * The worst wiring failure this product can have: two paying clients reading
   * and writing one customer book. Every per-host check passes, because each
   * host is individually consistent - which is exactly why it needs a check of
   * its own, and why it has to exist before the second client does.
   */
  it('TWO LIVE HOSTS ON ONE BINDING is caught, even with matching TENANTS entries', () => {
    const problems = checkTenantWiring({
      liveTenants: {
        'app.pumpcycle.net': { db: 'DB_DEV' },
        'bobs-septic.pumpcycle.net': { db: 'DB_DEV' },
      },
      tenants: {
        dev: { d1: 'pumpcycle-dev', host: 'app.pumpcycle.net' },
        bobs: { d1: 'pumpcycle-dev', host: 'bobs-septic.pumpcycle.net' },
      },
      wranglerConfig,
    })
    const shared = problems.find((p) => p.includes('share the D1 binding'))
    expect(shared).toBeDefined()
    expect(shared).toContain('app.pumpcycle.net')
    expect(shared).toContain('bobs-septic.pumpcycle.net')
    expect(shared).toContain('DB_DEV')
  })

  it('two TENANTS entries for one host are caught, not resolved to whichever is first', () => {
    const problems = checkTenantWiring({
      liveTenants,
      tenants: {
        dev: { d1: 'pumpcycle-dev', host: 'app.pumpcycle.net' },
        devTypo: { d1: 'pumpcycle-clientX', host: 'app.pumpcycle.net' },
      },
      wranglerConfig,
    })
    const dup = problems.find((p) => p.includes('entries for host'))
    expect(dup).toBeDefined()
    expect(dup).toContain('dev')
    expect(dup).toContain('devTypo')
  })

  it('the same binding declared twice in wrangler.jsonc is caught', () => {
    const problems = checkTenantWiring({
      liveTenants,
      tenants,
      wranglerConfig: {
        d1_databases: [
          { binding: 'DB_DEV', database_name: 'pumpcycle-dev' },
          { binding: 'DB_DEV', database_name: 'pumpcycle-somebody-else' },
        ],
        r2_buckets: [],
      },
    })
    const dup = problems.find((p) => p.includes('declares the D1 binding'))
    expect(dup).toBeDefined()
    expect(dup).toContain('pumpcycle-somebody-else')
  })

  it('a declared but unbound R2 bucket is caught', () => {
    const problems = checkTenantWiring({
      liveTenants: { 'app.pumpcycle.net': { db: 'DB_DEV', r2: 'R2_MISSING' } },
      tenants,
      wranglerConfig,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('R2_MISSING')
  })
})

// ---------------------------------------------------------------------------
// Tenant timezone
//
// A bogus timezone string in LIVE_TENANTS is a one-word typo that no per-host
// wiring check can see, and its cost is not "mail is late": the reminder cron
// formats the tenant's calendar with ICU and no offset fallback, so that host's
// scheduled send fails outright. The fail-loud send behaviour is deliberate - a
// silent fallback would hide a misconfigured tenant and mail that client's book
// at the wrong hour, and mail at 3am reads as a compromised account - so the
// typo is caught here, at deploy, where it costs a red preflight.
//
// This check covers the TENANT CONFIG only, which is the value that LOSES to the
// client's own settings row at every read site. A typo in that row is data and
// no deploy check can see it; worker/api/sync.js validates the resolved zone at
// read time instead, so the app always opens. Do not read this check as a
// guarantee that the zone actually in use is valid.
//
// Like the two-hosts-one-binding check, this protects a client who does not
// exist yet: today's single tenant is 'America/New_York' and correct, and the
// zone for client two gets typed into this file on the day he is provisioned.
// ---------------------------------------------------------------------------
describe('checkTenantWiring validates every tenant timezone', () => {
  const wranglerConfig = {
    d1_databases: [{ binding: 'DB_DEV', database_name: 'pumpcycle-dev' }],
    r2_buckets: [],
  }
  const tenants = { dev: { d1: 'pumpcycle-dev', host: 'app.pumpcycle.net' } }
  const withZone = (timezone) => ({ 'app.pumpcycle.net': { db: 'DB_DEV', timezone } })

  const problemsFor = (liveTenants) => checkTenantWiring({ liveTenants, tenants, wranglerConfig })

  it('a bogus IANA zone is caught, with the host and the value in the message', () => {
    const problems = problemsFor(withZone('America/New York')) // space, not underscore
    const zone = problems.find((p) => p.includes('timezone'))
    expect(zone).toBeDefined()
    expect(zone).toContain('app.pumpcycle.net')
    expect(zone).toContain('America/New York')
  })

  it('catches the shapes a hand-typed zone actually takes', () => {
    for (const bad of ['EST5EDT_NOPE', 'america/new_york_', 'US/Notazone', 'GMT+25', ' ']) {
      expect(problemsFor(withZone(bad)).some((p) => p.includes('timezone'))).toBe(true)
    }
  })

  it('accepts every zone a US client book can land in', () => {
    for (const good of [
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
      'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC',
    ]) {
      expect(problemsFor(withZone(good))).toEqual([])
    }
  })

  it('no timezone at all is not a failure - the resolved default applies', () => {
    expect(problemsFor({ 'app.pumpcycle.net': { db: 'DB_DEV' } })).toEqual([])
    // '' is falsy at every read site (settings -> tenant config -> default), so
    // it never reaches ICU and is not a misconfiguration either.
    expect(problemsFor(withZone(''))).toEqual([])
  })

  it('a bad zone is reported alongside, not instead of, the wiring problems', () => {
    const problems = checkTenantWiring({
      liveTenants: {
        'app.pumpcycle.net': { db: 'DB_DEV', timezone: 'America/New_York' },
        'bobs-septic.pumpcycle.net': { db: 'DB_DEV', timezone: 'Mars/Olympus_Mons' },
      },
      tenants: {
        dev: { d1: 'pumpcycle-dev', host: 'app.pumpcycle.net' },
        bobs: { d1: 'pumpcycle-dev', host: 'bobs-septic.pumpcycle.net' },
      },
      wranglerConfig,
    })
    expect(problems.some((p) => p.includes('share the D1 binding'))).toBe(true)
    expect(problems.some((p) => p.includes('Mars/Olympus_Mons'))).toBe(true)
  })
})

describe('isValidTimeZone', () => {
  it('answers the question the runtime asks, by asking ICU the same way', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true)
    expect(isValidTimeZone('Not/A_Zone')).toBe(false)
  })

  it('is true for every zone LIVE_TENANTS configures today', () => {
    for (const cfg of Object.values(LIVE_TENANTS)) {
      if (cfg.timezone) expect(isValidTimeZone(cfg.timezone)).toBe(true)
    }
  })
})
