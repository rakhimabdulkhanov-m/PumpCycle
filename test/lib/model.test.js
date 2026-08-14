import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMutation, updateCustomerState } from '../../src/lib/model.js'

const state = () => ({
  customers: [
    {
      id: 'a', name: 'A', address: '1 Main St', cycleMonths: 36,
      lastPumped: '2024-01-01', lat: 35.2, lng: -81.17,
      locationPrecision: 'manual', locationConfirmedAt: 100, addressChangedAt: null,
      cycleSeq: 2,
    },
    { id: 'b', name: 'B', cycleMonths: 36 },
  ],
  visits: [],
  reminderLog: [{ id: 'r', customerId: 'a' }, { id: 'rb', customerId: 'b' }],
  sentReminders: ['a:60', 'a:14', 'b:60'],
  sentAt: { 'a:60': '2024-01-01', 'a:14': '2024-01-02', 'b:60': '2024-01-01' },
  settings: { avgJobPrice: 450 },
})

const mutation = (type, payload, createdAt = 500) => ({
  mutationId: `m:${type}`, type, payload, createdAt,
})

describe('canonical model mutations', () => {
  it('updates exactly one customer and stamps a genuinely changed address deterministically', () => {
    const before = state()
    const next = applyMutation(before, mutation('customer.update', {
      customerId: 'a', changes: { address: '2 Main St', phone: '704-555-0100' },
    }))
    expect(next.customers[0]).toMatchObject({ address: '2 Main St', phone: '704-555-0100', addressChangedAt: 500 })
    expect(next.customers[1]).toBe(before.customers[1])
  })

  it('cycle changes advance live cycle and preserve other customers while resetting compatibility rows', () => {
    const next = applyMutation(state(), mutation('customer.update', {
      customerId: 'a', changes: { cycleMonths: 3 },
    }))
    expect(next.customers[0].cycleSeq).toBe(3)
    expect(next.sentReminders).toEqual(['b:60'])
    expect(next.sentAt).toEqual({ 'b:60': '2024-01-01' })
    expect(next.reminderLog).toEqual([{ id: 'r', customerId: 'a' }, { id: 'rb', customerId: 'b' }])
  })

  it('pin.set and pin.restore write only the pin vocabulary', () => {
    const saved = applyMutation(state(), mutation('pin.set', {
      customerId: 'a', lat: 35.3, lng: -81.2,
    }, 700))
    expect(saved.customers[0]).toMatchObject({
      address: '1 Main St', lat: 35.3, lng: -81.2,
      locationPrecision: 'manual', locationConfirmedAt: 700,
    })
    const restored = applyMutation(saved, mutation('pin.restore', {
      customerId: 'a', lat: 35.2, lng: -81.17,
      locationPrecision: 'house', locationConfirmedAt: 100,
    }, 800))
    expect(restored.customers[0]).toMatchObject({
      address: '1 Main St', lat: 35.2, lng: -81.17,
      locationPrecision: 'house', locationConfirmedAt: 100,
    })
  })

  it('legacy update API delegates last-pumped correction and preserves exact compatibility semantics', () => {
    const next = updateCustomerState(state(), 'a', { lastPumped: '2026-08-13' }, {
      createdAt: 900, mutationId: 'legacy:a',
    })
    expect(next.customers[0].lastPumped).toBe('2026-08-13')
    expect(next.customers[1].name).toBe('B')
    expect(next.sentReminders).toEqual(['b:60'])
    expect(next.visits.at(-1)).toMatchObject({ id: 'legacy:a:visit', visitedOn: '2026-08-13' })
  })

  it('clears an unknown last-pumped date without inventing a null visit', () => {
    const before = state()
    before.visits = [{
      id: 'old', customerId: 'a', visitedOn: '2024-01-01', setsLastPumped: true, archivedAt: null,
    }]
    const next = applyMutation(before, mutation('last_pumped.correct', {
      id: 'unused', customerId: 'a', lastPumped: null,
    }))
    expect(next.customers[0]).toMatchObject({ lastPumped: null, cycleSeq: 3 })
    expect(next.visits).toEqual([{ ...before.visits[0], setsLastPumped: false }])
    expect(next.sentReminders).toEqual(['b:60'])
  })

  it('settings are dollars in UI and cents in the canonical payload', () => {
    const next = applyMutation(state(), mutation('setting.set_avg_job_price', { avgJobPriceCents: 57500 }))
    expect(next.settings).toMatchObject({ avgJobPrice: 575, avgJobPriceCents: 57500 })
  })

  // The server resets deliverability on a real address change (worker/api/mutations.js).
  // The optimistic apply has to reach the same answer by the same rule, or the red
  // row disappears and comes back on the next sync - or never disappears at all.
  it('re-arms a bounced customer optimistically only when the address really changes', () => {
    const before = state()
    before.customers[0] = {
      ...before.customers[0], email: 'earl@oldhost.com', emailStatus: 'bounced', softBounceCount: 2,
    }
    const corrected = applyMutation(before, mutation('customer.update', {
      customerId: 'a', changes: { email: 'earl@newhost.com' },
    }))
    expect(corrected.customers[0]).toMatchObject({ emailStatus: 'ok', softBounceCount: 0 })

    const cleared = applyMutation(before, mutation('customer.update', {
      customerId: 'a', changes: { email: '' },
    }))
    expect(cleared.customers[0]).toMatchObject({ emailStatus: 'ok', softBounceCount: 0 })

    const retyped = applyMutation(before, mutation('customer.update', {
      customerId: 'a', changes: { email: '  Earl@OldHost.com ' },
    }))
    expect(retyped.customers[0]).toMatchObject({ emailStatus: 'bounced', softBounceCount: 2 })

    const renamed = applyMutation(before, mutation('customer.update', {
      customerId: 'a', changes: { name: 'Earl Renamed' },
    }))
    expect(renamed.customers[0]).toMatchObject({ emailStatus: 'bounced', softBounceCount: 2 })
  })

  // worker/api/mutations.js requires previous.email_status !== 'complained'
  // before re-arming. Without the same clause here the operator corrects a
  // complainant's address, the red "marked your email as spam - call this one
  // instead" row vanishes, and the next sync puts it back: for a few seconds he
  // is told the one unfixable problem is fixed.
  it('never re-arms a spam complainant, exactly as the server refuses to', () => {
    const before = state()
    before.customers[0] = {
      ...before.customers[0], email: 'earl@oldhost.com', emailStatus: 'complained', softBounceCount: 0,
    }
    const corrected = applyMutation(before, mutation('customer.update', {
      customerId: 'a', changes: { email: 'earl@newhost.com' },
    }))
    expect(corrected.customers[0]).toMatchObject({
      email: 'earl@newhost.com',
      emailStatus: 'complained',
    })

    // Emptying the address is not an escape hatch either.
    const cleared = applyMutation(before, mutation('customer.update', {
      customerId: 'a', changes: { email: '' },
    }))
    expect(cleared.customers[0]).toMatchObject({ emailStatus: 'complained' })
  })
})

// A manual send is recorded against the operator's calendar day. TZ is pinned
// here because the defect only exists where local time and UTC disagree: on a
// UTC machine both the old and the fixed code return the same string.
describe('manual send dates use the local calendar day', () => {
  const originalTz = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'America/New_York'
  })
  afterAll(() => {
    process.env.TZ = originalTz
  })

  it('dates a text marked sent at 21:30 Eastern as that evening, not tomorrow', () => {
    // 2026-08-15T01:30Z is 2026-08-14 21:30 in New York.
    const at = Date.UTC(2026, 7, 15, 1, 30)
    expect(new Date(at).getHours()).toBe(21) // the pinned zone really took effect
    const next = applyMutation(state(), mutation('reminder.mark_manual_sent', {
      customerId: 'a', reminderKey: 'sms', channel: 'sms',
    }, at))
    expect(next.sentAt['a:sms']).toBe('2026-08-14')
  })
})
