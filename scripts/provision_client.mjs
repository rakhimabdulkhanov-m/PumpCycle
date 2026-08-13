#!/usr/bin/env node

/**
 * Create or rotate one owner's 24-hour setup token in a LOCAL tenant D1.
 * Raw passwords never enter this program. The raw token is printed exactly once;
 * only its SHA-256 hash is sent to D1. Remote execution is intentionally unsupported.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TENANTS } from './tenants.config.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const DAY_MS = 24 * 60 * 60 * 1000

export class ProvisionError extends Error {}

const sqlText = (value) => `'${String(value).replaceAll("'", "''")}'`

export function parseArgs(argv) {
  const out = { rotate: false, dryRun: false, persistTo: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--rotate') out.rotate = true
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg.startsWith('--')) {
      const split = arg.indexOf('=')
      const key = arg.slice(2, split < 0 ? undefined : split)
      if (!['tenant', 'email', 'persist-to'].includes(key)) throw new ProvisionError(`Unknown argument: ${arg}`)
      const value = split < 0 ? argv[++i] : arg.slice(split + 1)
      if (!value || value.startsWith('--')) throw new ProvisionError(`--${key} requires a value.`)
      if (out[key] !== undefined) throw new ProvisionError(`--${key} was provided more than once.`)
      out[key] = value
    } else throw new ProvisionError(`Unexpected positional argument: ${arg}`)
  }
  if (!out.tenant) throw new ProvisionError('--tenant is required.')
  if (!out.email) throw new ProvisionError('--email is required.')
  out.email = out.email.trim().toLowerCase()
  if (out.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new ProvisionError('--email must be a valid email address.')
  if (!TENANTS[out.tenant]) throw new ProvisionError(`Unknown tenant '${out.tenant}'.`)
  return out
}

function wrangler(database, args, persistTo) {
  const full = ['d1', 'execute', database, '--local', ...args]
  if (persistTo) full.push('--persist-to', resolve(persistTo))
  const result = spawnSync(process.execPath, [WRANGLER, ...full], { cwd: ROOT, encoding: 'utf8', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new ProvisionError(result.stderr || result.stdout || 'Local D1 command failed.')
  return result.stdout
}

function existingOwner(database, email, persistTo) {
  const stdout = wrangler(database, ['--command', `SELECT id, password_hash, setup_token_hash, setup_token_expires_at FROM users WHERE email = ${sqlText(email)}`, '--json'], persistTo)
  const parsed = JSON.parse(stdout)
  return (Array.isArray(parsed) ? parsed[0] : parsed)?.results?.[0] || null
}

export function setupSql({ email, userId, tokenHash, expiresAt, now, existing }) {
  if (existing) {
    return `UPDATE users SET setup_token_hash=${sqlText(tokenHash)}, setup_token_expires_at=${expiresAt}, setup_token_used_at=NULL WHERE id=${sqlText(existing.id)};`
  }
  return `INSERT INTO users (id, email, role, setup_token_hash, setup_token_expires_at, created_at) VALUES (${sqlText(userId)}, ${sqlText(email)}, 'owner', ${sqlText(tokenHash)}, ${expiresAt}, ${now});`
}

export function runCli(argv) {
  const options = parseArgs(argv)
  const tenant = TENANTS[options.tenant]
  const token = randomBytes(32).toString('hex')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const now = Date.now()
  let existing = null
  if (!options.dryRun) {
    existing = existingOwner(tenant.d1, options.email, options['persist-to'])
    if (existing && !options.rotate && (existing.password_hash || existing.setup_token_hash)) {
      throw new ProvisionError('This owner already has a password or setup token. Pass --rotate to replace the setup token explicitly.')
    }
  }
  const sql = setupSql({ email: options.email, userId: `u-${randomUUID()}`, tokenHash, expiresAt: now + DAY_MS, now, existing })
  if (!options.dryRun) wrangler(tenant.d1, ['--command', sql], options['persist-to'])
  process.stdout.write(`${JSON.stringify({ mode: options.dryRun ? 'dry-run' : 'local-write', tenant: options.tenant, email: options.email, expiresAt: now + DAY_MS })}\n`)
  process.stdout.write(`Setup token: ${token}\n`)
  return { token, sql }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCli(process.argv.slice(2)) } catch (error) {
    console.error(`ERROR: ${error.message}`)
    process.exitCode = 1
  }
}
