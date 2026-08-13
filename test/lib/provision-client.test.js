import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { parseArgs, runCli, setupSql } from '../../scripts/provision_client.mjs'

describe('local owner provisioning CLI', () => {
  it('requires explicit tenant/email and an explicit rotate flag is parsed', () => {
    expect(() => parseArgs([])).toThrow(/tenant/i)
    expect(() => parseArgs(['--tenant', 'dev'])).toThrow(/email/i)
    expect(parseArgs(['--tenant', 'dev', '--email', 'OWNER@EXAMPLE.COM', '--rotate', '--dry-run']))
      .toMatchObject({ tenant: 'dev', email: 'owner@example.com', rotate: true, dryRun: true })
  })

  it('puts only the token hash in SQL and dry-run performs no D1 operation', () => {
    const sql = setupSql({ email: 'owner@example.com', userId: 'u1', tokenHash: 'h'.repeat(64), expiresAt: 2, now: 1, existing: null })
    expect(sql).toContain('h'.repeat(64))
    expect(sql).not.toMatch(/password/i)
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const result = runCli(['--tenant', 'dev', '--email', 'owner@example.com', '--dry-run'])
    const printed = write.mock.calls.map(([value]) => String(value)).join('')
    expect(printed.split(result.token)).toHaveLength(2)
    expect(printed).toContain('"mode":"dry-run"')
    write.mockRestore()
  })

  it('has no remote/browser/password handling path', () => {
    const source = readFileSync(new URL('../../scripts/provision_client.mjs', import.meta.url), 'utf8')
    expect(source).not.toMatch(/--remote|localStorage|\bfetch\s*\(/)
    expect(source).not.toContain('--password')
  })
})
