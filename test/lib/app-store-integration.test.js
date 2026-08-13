import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

describe('App store plumbing', () => {
  it('uses the singleton async store and has no direct legacy persistence path', () => {
    const app = source('src/App.jsx')
    expect(app).toContain("from './lib/store/useStore.js'")
    expect(app).toContain('const data = useStore()')
    expect(app).not.toMatch(/\b(?:loadState|saveState|persist|updateCustomerState)\b/)
    expect(source('src/components/MapTab.jsx')).not.toContain("from '../lib/storage.js'")
    expect(source('src/components/DueTab.jsx')).not.toContain("from '../lib/storage.js'")
  })

  it('routes distinct durable mutations through their canonical store methods', () => {
    const app = source('src/App.jsx')
    for (const method of [
      'addCustomer',
      'updateCustomer',
      'setPin',
      'restorePin',
      'recordVisit',
      'setAvgJobPrice',
      'markReminderSent',
    ]) {
      expect(app).toContain(`store.${method}`)
    }
  })

  it('gates demo-only acquisition UI on the bootstrap-selected mode', () => {
    const app = source('src/App.jsx')
    const topbar = source('src/components/Topbar.jsx')
    expect(app).toContain("mode === 'demo'")
    expect(app).toContain('data.blocked || !mode')
    expect(topbar).toContain('{demo && (')
  })

  it('uses dedicated pin and visit callbacks instead of ambiguous customer patches', () => {
    const map = source('src/components/MapTab.jsx')
    const card = source('src/components/CustomerCard.jsx')
    expect(map).toContain('await onSetPin(c.id, crosshairPoint())')
    expect(map).toContain('await onRestorePin(undo.id, undo.patch)')
    expect(card).toContain('await onMarkPumped()')
  })

  it('hard-caps the Due list at 100 rows and asks the operator to search', () => {
    const due = source('src/components/DueTab.jsx')
    expect(due).toContain('rows.slice(0, Math.min(limit, 100))')
    expect(due).toContain('Showing first 100. Search to narrow the list.')
    expect(due).not.toContain('Show 100 more')
  })
})
