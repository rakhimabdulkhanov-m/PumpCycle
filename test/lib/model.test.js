import { describe, expect, it } from 'vitest'
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
})
