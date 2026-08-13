import { describe, expect, it, vi } from 'vitest'
import { createApiStore } from '../../src/lib/store/apiStore.js'
import { createStore } from '../../src/lib/store/index.js'
import { encodeMutation, mergeSyncDelta } from '../../src/lib/wire.js'

const base = (name = 'Server') => ({
  customers: [{ id: 'a', name, address: '', phone: '', email: '', tankSizeGal: 1000, lastPumped: '2025-01-01', cycleMonths: 36, notes: '' }],
  visits: [], photos: [], reminderLog: [], settings: { avgJobPrice: 450, avgJobPriceCents: 45000 },
  sentReminders: [], sentAt: {}, cursor: 1,
})

function memoryStorage(cached = {}) {
  let record = { base: cached.base || base(), cursor: cached.cursor || 1, outbox: cached.outbox || [] }
  return {
    load: vi.fn(async () => record),
    enqueue: vi.fn(async (mutation) => {
      const queued = { ...mutation, order: record.outbox.length + 1, status: 'pending' }
      record.outbox.push(queued)
      return queued
    }),
    writeBase: vi.fn(async (next, cursor) => { record = { ...record, base: next, cursor } }),
    acknowledge: vi.fn(async (id, next, cursor) => {
      record = { base: next, cursor, outbox: record.outbox.filter((row) => row.mutationId !== id) }
    }),
    markFailed: vi.fn(async (failed) => {
      record.outbox = record.outbox.map((row) => row.mutationId === failed.mutationId ? failed : row)
    }),
    discard: vi.fn(async (id) => {
      record.outbox = record.outbox.filter((row) => row.mutationId !== id)
    }),
    read: () => record,
  }
}

const update = (id, name, order = 1) => ({
  mutationId: id, type: 'customer.update', createdAt: order,
  payload: { customerId: 'a', changes: { name } }, order, status: 'pending',
})

describe('api store rebase/outbox', () => {
  it('boots cached base replayed through pending FIFO and keeps it optimistic across sync', async () => {
    const storage = memoryStorage({ outbox: [update('m1', 'Pending')] })
    const client = {
      sync: vi.fn(async () => ({ ok: true, cursor: 2, customers: [{ id: 'a', phone: '222' }], visits: [], photos: [], reminderLog: [], settings: {}, sentReminders: [], sentAt: {} })),
      mutate: vi.fn(async () => ({ ok: true })),
    }
    const store = createApiStore({ storage, client, autoSync: false })
    await store.init()
    expect(store.getSnapshot().customers[0].name).toBe('Pending')
    await store.refresh()
    expect(store.getSnapshot().customers[0]).toMatchObject({ name: 'Pending', phone: '222' })
  })

  it('does not publish when atomic enqueue fails', async () => {
    const storage = memoryStorage()
    storage.enqueue.mockRejectedValueOnce(new Error('disk full'))
    const store = createApiStore({ storage, client: {}, autoSync: false })
    await store.init()
    const before = store.getSnapshot()
    await expect(store.updateCustomer('a', { name: 'Lost' })).rejects.toThrow('disk full')
    expect(store.getSnapshot()).toBe(before)
  })

  it('flush is single-flight FIFO and a network failure retains the optimistic head', async () => {
    const storage = memoryStorage()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const client = {
      mutate: vi.fn(async (mutation) => { await gate; return { ok: true, mutationId: mutation.mutationId } }),
      sync: vi.fn(async () => ({ ok: true, cursor: 1, customers: [], visits: [], photos: [], reminderLog: [], settings: {}, sentReminders: [], sentAt: {} })),
    }
    const store = createApiStore({ storage, client, autoSync: false })
    await store.init()
    await store.mutate(update('m1', 'First'))
    await store.mutate(update('m2', 'Second', 2))
    const one = store.flush()
    const two = store.flush()
    expect(one).toBe(two)
    release()
    await one
    expect(client.mutate.mock.calls.map(([row]) => row.mutationId)).toEqual(['m1', 'm2'])
  })

  it('a permanent 4xx marks and stops the head without sending the tail', async () => {
    const storage = memoryStorage({ outbox: [update('m1', 'Bad'), update('m2', 'Tail', 2)] })
    const error = Object.assign(new Error('invalid'), { status: 400 })
    const client = { mutate: vi.fn(async () => { throw error }), sync: vi.fn() }
    const store = createApiStore({ storage, client, autoSync: false })
    await store.init()
    await store.flush()
    expect(client.mutate).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().failedMutation).toMatchObject({ mutationId: 'm1', status: 'failed' })
    expect(store.getSnapshot().customers[0].name).toBe('Tail')
  })

  it('lost response replay retains the same mutation id after reload', async () => {
    const storage = memoryStorage({ outbox: [update('same-id', 'Pending')] })
    const sent = []
    const store = createApiStore({ storage, client: {
      mutate: async (row) => { sent.push(row.mutationId); throw new Error('lost response') },
      sync: vi.fn(),
    }, autoSync: false })
    await store.init()
    await store.flush()
    const reloaded = createApiStore({ storage, client: {
      mutate: async (row) => { sent.push(row.mutationId); return { ok: true } },
      sync: async () => ({ ok: true, cursor: 1, customers: [], visits: [], photos: [], reminderLog: [], settings: {}, sentReminders: [], sentAt: {} }),
    }, autoSync: false })
    await reloaded.init()
    await reloaded.flush()
    expect(sent).toEqual(['same-id', 'same-id'])
  })

  it('flushes a lost-response outbox before pulling the authoritative row', async () => {
    const pendingVisit = {
      mutationId: 'same-visit', type: 'visit.record', createdAt: 2, order: 1, status: 'pending',
      payload: { id: 'v1', customerId: 'a', visitedOn: '2026-08-13' },
    }
    const storage = memoryStorage({ outbox: [pendingVisit] })
    const calls = []
    const store = createApiStore({ storage, client: {
      mutate: async () => { calls.push('mutate'); return { ok: true } },
      sync: async () => {
        calls.push('sync')
        return { ok: true, cursor: 2, customers: [], visits: [{ id: 'v1', customerId: 'a', visitedOn: '2026-08-13' }], photos: [], reminderLog: [], settings: {}, sentReminders: [], sentAt: {} }
      },
    } })
    await store.init()
    await store.flush()
    expect(calls.slice(0, 2)).toEqual(['mutate', 'sync'])
    expect(store.getSnapshot().visits.map((row) => row.id)).toEqual(['v1'])
    expect(storage.read().base.visits.map((row) => row.id)).toEqual(['v1'])
  })

  it('automatically retries pending work on the online event', async () => {
    let online
    const onlineTarget = {
      addEventListener: vi.fn((name, callback) => { if (name === 'online') online = callback }),
      removeEventListener: vi.fn(),
    }
    const storage = memoryStorage({ outbox: [update('m1', 'Pending')] })
    let connected = false
    const client = {
      mutate: vi.fn(async () => {
        if (!connected) throw new Error('offline')
        return { ok: true }
      }),
      sync: vi.fn(async () => ({ ok: true, cursor: 1, customers: [], visits: [], photos: [], reminderLog: [], settings: {}, sentReminders: [], sentAt: {} })),
    }
    const store = createApiStore({ storage, client, onlineTarget })
    await store.init()
    await store.flush()
    expect(store.getSnapshot()).toMatchObject({ storeStatus: 'offline', pendingCount: 1 })
    connected = true
    online()
    await vi.waitFor(() => expect(store.getSnapshot().pendingCount).toBe(0))
    store.destroy()
    expect(onlineTarget.removeEventListener).toHaveBeenCalledWith('online', online)
  })

  it('can discard a permanent failed head and continue the tail', async () => {
    const storage = memoryStorage({ outbox: [update('m1', 'Bad'), update('m2', 'Tail', 2)] })
    const client = {
      mutate: vi.fn(async (row) => {
        if (row.mutationId === 'm1') throw Object.assign(new Error('invalid'), { status: 400 })
        return { ok: true }
      }),
      sync: vi.fn(async () => ({ ok: true, cursor: 1, customers: [], visits: [], photos: [], reminderLog: [], settings: {}, sentReminders: [], sentAt: {} })),
    }
    const store = createApiStore({ storage, client, autoSync: false })
    await store.init()
    await store.flush()
    await store.discardFailedMutation()
    await store.flush()
    expect(store.getSnapshot()).toMatchObject({ failedMutation: null, pendingCount: 0 })
    expect(client.mutate.mock.calls.map(([row]) => row.mutationId)).toEqual(['m1', 'm2'])
  })

  it('rejects a non-positive average price before it can poison the outbox', async () => {
    const storage = memoryStorage()
    const store = createApiStore({ storage, client: {}, autoSync: false })
    await store.init()
    await expect(store.setAvgJobPrice(0)).rejects.toThrow(/at least/)
    expect(storage.enqueue).not.toHaveBeenCalled()
    expect(store.getSnapshot().pendingCount).toBe(0)
  })
})

describe('wire/bootstrap boundaries', () => {
  it('never sends IndexedDB outbox metadata in the exact mutation envelope', () => {
    expect(encodeMutation({
      ...update('persisted-row', 'Safe'),
      error: { status: 401, message: 'old local state' },
    })).toEqual({
      mutationId: 'persisted-row',
      type: 'customer.update',
      createdAt: 1,
      payload: { customerId: 'a', changes: { name: 'Safe' } },
    })
  })

  it('removes archived rows by id and converts avg price cents to dollars', () => {
    const merged = mergeSyncDelta(base(), {
      ok: true, cursor: 2, customers: [{ id: 'a', archived_at: 99 }], visits: [], photos: [],
      reminder_log: [], settings: { avg_job_price_cents: 57500 }, sent_reminders: [], sent_at: {},
    })
    expect(merged.customers).toEqual([])
    expect(merged.settings).toMatchObject({ avgJobPrice: 575, avgJobPriceCents: 57500 })
  })

  it('bootstrap fails closed and demo selection stays dynamically injected', async () => {
    const fail = createStore({ fetch: async () => ({ ok: false, status: 503, json: async () => ({ ok: false }) }) })
    await expect(fail.init()).rejects.toThrow('Bootstrap failed')
    expect(fail.getSnapshot()).toMatchObject({ blocked: true, storeStatus: 'error', customers: [] })

    const demo = { init: vi.fn(), subscribe: () => () => {}, getSnapshot: () => ({ customers: ['demo'] }), getMode: () => 'demo' }
    const loader = vi.fn(async () => ({ createDemoStore: () => demo }))
    const selected = createStore({
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, mode: 'demo' }) }),
      demoLoader: loader,
    })
    await selected.init()
    expect(loader).toHaveBeenCalledTimes(1)
    expect(selected.getSnapshot()).toEqual({ customers: ['demo'] })
  })

  it('live bootstrap remains neutral and never imports demo data', async () => {
    const loader = vi.fn()
    const store = createStore({
      fetch: async (path) => path === '/api/bootstrap'
        ? { ok: true, status: 200, json: async () => ({ ok: true, mode: 'live', company: 'Client' }) }
        : { ok: false, status: 401, json: async () => ({ ok: false, error: 'authentication required' }) },
      demoLoader: loader,
    })
    await store.init()
    expect(loader).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toMatchObject({ mode: 'live', blocked: true, storeStatus: 'auth-required', customers: [] })
  })

  it('live unauthenticated and setup URLs select the correct gates', async () => {
    const fetch = vi.fn(async (path) => path === '/api/bootstrap'
      ? { ok: true, status: 200, json: async () => ({ ok: true, mode: 'live', company: 'Client' }) }
      : { ok: false, status: 401, json: async () => ({ ok: false, error: 'authentication required' }) })
    const signIn = createStore({ fetch, locationSearch: '' })
    await signIn.init()
    expect(signIn.getSnapshot()).toMatchObject({ storeStatus: 'auth-required', setupToken: null })

    const setup = createStore({ fetch, locationSearch: '?t=' + 'a'.repeat(64) })
    await setup.init()
    expect(setup.getSnapshot()).toMatchObject({ storeStatus: 'setup-required', setupToken: 'a'.repeat(64) })
  })

  it('authenticated live bootstrap creates the API store and starts it', async () => {
    const api = { init: vi.fn(), subscribe: () => () => {}, getSnapshot: () => ({ mode: 'live', storeStatus: 'ready', customers: ['live'] }), getMode: () => 'live' }
    const apiLoader = vi.fn(async () => ({ createApiStore: () => api }))
    const store = createStore({
      fetch: async (path) => ({ ok: true, status: 200, json: async () => path === '/api/bootstrap' ? { ok: true, mode: 'live' } : { ok: true, authenticated: true } }),
      apiLoader,
    })
    await store.init()
    expect(apiLoader).toHaveBeenCalledTimes(1)
    expect(api.init).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().customers).toEqual(['live'])
  })

  it('a mutation 401 retains the outbox and can resume after re-login', async () => {
    const storage = memoryStorage({ outbox: [update('session-expired', 'Pending')] })
    let authenticated = false
    const client = {
      mutate: vi.fn(async () => {
        if (!authenticated) throw Object.assign(new Error('authentication required'), { status: 401 })
        return { ok: true }
      }),
      sync: vi.fn(async () => ({ ok: true, cursor: 1, customers: [], visits: [], photos: [], reminderLog: [], settings: {}, sentReminders: [], sentAt: {} })),
    }
    const store = createApiStore({ storage, client, autoSync: false })
    await store.init()
    await store.flush()
    expect(store.getSnapshot()).toMatchObject({ storeStatus: 'auth-required', pendingCount: 1, failedMutation: null })
    expect(storage.read().outbox).toHaveLength(1)
    authenticated = true
    await store.resumeAfterAuth()
    expect(store.getSnapshot()).toMatchObject({ storeStatus: 'ready', pendingCount: 0 })
    expect(storage.read().outbox).toHaveLength(0)
  })

  it('replays after auth even when re-login races the old 401 flight cleanup', async () => {
    const storage = memoryStorage({ outbox: [update('lost-auth-response', 'Persisted')] })
    let calls = 0
    let resume
    let store
    const client = {
      mutate: vi.fn(async () => {
        calls += 1
        if (calls === 1) throw Object.assign(new Error('authentication required'), { status: 401 })
        return { ok: true, status: 'replayed' }
      }),
      sync: vi.fn(async () => ({ ok: true, cursor: 1, customers: [], visits: [], photos: [], reminderLog: [], settings: {}, sentReminders: [], sentAt: {} })),
    }
    store = createApiStore({
      storage,
      client,
      autoSync: false,
      // This callback runs while flushPromise still points at the first flight.
      onAuthRequired: () => { resume = store.resumeAfterAuth() },
    })
    await store.init()
    await store.flush()
    await resume
    expect(client.mutate).toHaveBeenCalledTimes(2)
    expect(storage.read().outbox).toHaveLength(0)
    expect(store.getSnapshot()).toMatchObject({ storeStatus: 'ready', pendingCount: 0 })
  })
})
