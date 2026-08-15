import { newCustomerId } from '../ids.js'
import { applyMutation } from '../model.js'
import { channelForRungKey } from '../reminderView.js'
import { decodeSyncResponse, emptySnapshot, encodeMutation, mergeSyncDelta } from '../wire.js'
import { createIdbStorage } from './idb.js'
import {
  createMutation,
  failedRecord,
  isPermanentMutationFailure,
  MutationHttpError,
  replayOutbox,
  sortOutbox,
} from './outbox.js'

let fallbackId = 0
const defaultIdFactory = () => {
  if (globalThis.crypto?.randomUUID) return `m-${globalThis.crypto.randomUUID()}`
  fallbackId += 1
  return `m-${Date.now()}-${fallbackId}`
}

async function responseJson(response) {
  let body
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok || body?.ok === false) {
    throw new MutationHttpError(body?.error || `Request failed (${response.status})`, response.status)
  }
  return body
}

export function createHttpClient(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required')
  return {
    async mutate(mutation) {
      return responseJson(await fetchImpl('/api/mutations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(encodeMutation(mutation)),
      }))
    },
    async sync(cursor) {
      return responseJson(await fetchImpl(`/api/sync?since=${encodeURIComponent(cursor)}`))
    },
  }
}

const parseReminderId = (reminderId) => {
  const split = reminderId.lastIndexOf(':')
  if (split < 1) throw new TypeError('Reminder id must be customerId:key')
  const customerId = reminderId.slice(0, split)
  const reminderKey = reminderId.slice(split + 1)
  // See demoStore.js: the channel is derived from the canonical rung key. The
  // old '14' offset test sent channel 'email' for the 'sms' rung, which the
  // Worker rejects as a key/channel mismatch.
  return { customerId, reminderKey, channel: channelForRungKey(reminderKey) }
}

const UPDATE_FIELDS = new Set([
  'name', 'address', 'phone', 'email', 'tankSizeGal', 'cycleMonths', 'notes',
])
const PIN_FIELDS = new Set(['lat', 'lng', 'locationPrecision', 'locationConfirmedAt'])

export function createApiStore(options = {}) {
  const storage = options.storage || createIdbStorage(options.idb)
  const client = options.client || createHttpClient(options.fetch)
  const clock = options.clock || Date.now
  const idFactory = options.mutationIdFactory || defaultIdFactory
  const customerIdFactory = options.customerIdFactory || newCustomerId
  const autoSync = options.autoSync !== false
  const onlineTarget = options.onlineTarget ?? globalThis
  const onAuthRequired = options.onAuthRequired || (() => {})
  let base = emptySnapshot()
  let outbox = []
  let snapshot = { ...base, mode: 'live', storeStatus: 'booting', pendingCount: 0 }
  let initPromise = null
  let flushPromise = null
  let refreshPromise = null
  const listeners = new Set()

  const emit = () => {
    for (const listener of listeners) listener()
  }

  const publish = (status = 'ready', error = null) => {
    snapshot = {
      ...replayOutbox(base, outbox),
      mode: 'live',
      storeStatus: status,
      blocked: status === 'auth-required',
      company: options.company || '',
      timezone: options.timezone || '',
      pendingCount: outbox.length,
      failedMutation: outbox.find((row) => row.status === 'failed') || null,
      storeError: error ? { message: error.message || String(error), status: error.status || 0 } : null,
    }
    emit()
  }

  const envelope = (type, payload, overrides = {}) => createMutation(type, payload, {
    mutationId: overrides.mutationId || idFactory(),
    createdAt: overrides.createdAt ?? clock(),
  })

  function pull() {
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
      try {
        const response = decodeSyncResponse(await client.sync(base.cursor || 0))
        const nextBase = mergeSyncDelta(base, response)
        await storage.writeBase(nextBase, nextBase.cursor)
        base = nextBase
        publish('ready')
        return true
      } catch (error) {
        if (error?.status === 401) {
          publish('auth-required', error)
          onAuthRequired(error)
        } else publish('offline', error)
        return false
      } finally {
        refreshPromise = null
      }
    })()
    return refreshPromise
  }

  function refresh() {
    return outbox.length ? flush() : pull()
  }

  function flush() {
    if (flushPromise) return flushPromise
    flushPromise = (async () => {
      try {
        while (outbox.length) {
          const head = outbox[0]
          if (head.status === 'failed') break
          try {
            await client.mutate(encodeMutation(head))
          } catch (error) {
            if (error?.status === 401) {
              publish('auth-required', error)
              onAuthRequired(error)
            } else if (isPermanentMutationFailure(error)) {
              const failed = failedRecord(head, error)
              await storage.markFailed(failed)
              outbox = [failed, ...outbox.slice(1)]
              publish('error', error)
            } else {
              publish('offline', error)
            }
            break
          }

          // Acknowledgement makes this optimistic application authoritative.
          // Promote it atomically with deleting the outbox head, so a reload in
          // the gap before sync cannot make the accepted edit disappear.
          const acknowledgedBase = applyMutation(base, head)
          await storage.acknowledge(head.mutationId, acknowledgedBase, acknowledgedBase.cursor || 0)
          base = acknowledgedBase
          outbox = outbox.slice(1)
          publish('ready')
          await pull()
        }
        return outbox.length === 0
      } finally {
        flushPromise = null
      }
    })()
    return flushPromise
  }

  async function enqueue(mutation) {
    // Persistence is deliberately first. If this rejects, neither the in-memory
    // outbox nor the visible optimistic snapshot changes.
    const record = await storage.enqueue(mutation)
    outbox = sortOutbox([...outbox, record])
    publish('ready')
    if (autoSync) void flush()
    return mutation
  }

  async function init() {
    if (initPromise) return initPromise
    initPromise = (async () => {
      try {
        const cached = await storage.load()
        base = cached.base ? { ...emptySnapshot(), ...cached.base, cursor: cached.cursor } : emptySnapshot()
        outbox = sortOutbox(cached.outbox)
        publish('ready')
        if (autoSync) void (outbox.length ? flush() : pull())
        return snapshot
      } catch (error) {
        publish('error', error)
        initPromise = null
        throw error
      }
    })()
    return initPromise
  }


  const reconnect = () => {
    if (autoSync) void (outbox.length ? flush() : pull())
  }
  onlineTarget?.addEventListener?.('online', reconnect)

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    getMode: () => 'live',
    init,
    refresh,
    flush,
    async resumeAfterAuth() {
      publish('ready')
      // auth-required is published inside pull/flush catches, immediately
      // before their finally blocks clear the single-flight promises. A fast
      // sign-in can arrive in that small window. Wait for the dying flight,
      // then start a genuinely new replay instead of returning the old 401.
      const settling = [flushPromise, refreshPromise].filter(Boolean)
      if (settling.length) await Promise.allSettled(settling)
      return refresh()
    },
    destroy() {
      onlineTarget?.removeEventListener?.('online', reconnect)
    },
    async retryFailedMutation() {
      const failed = outbox.find((row) => row.status === 'failed')
      if (!failed) return false
      const pending = { ...failed, status: 'pending' }
      delete pending.error
      await storage.markFailed(pending)
      outbox = outbox.map((row) => row.mutationId === pending.mutationId ? pending : row)
      publish('ready')
      return flush()
    },
    async discardFailedMutation() {
      const failed = outbox.find((row) => row.status === 'failed')
      if (!failed) return false
      await storage.discard(failed.mutationId)
      outbox = outbox.filter((row) => row.mutationId !== failed.mutationId)
      publish('ready')
      await pull()
      if (autoSync) void flush()
      return true
    },
    mutate: enqueue,

    async addCustomer(fields) {
      const id = fields.id || customerIdFactory()
      await enqueue(envelope('customer.add', { ...fields, id }))
      return id
    },

    async updateCustomer(customerId, patch) {
      const changes = Object.fromEntries(
        Object.entries(patch).filter(([key]) => UPDATE_FIELDS.has(key))
      )
      if (Object.keys(changes).length) {
        await enqueue(envelope('customer.update', { customerId, changes }))
      }
      if (Object.hasOwn(patch, 'lastPumped')) {
        const customer = snapshot.customers.find((row) => row.id === customerId)
        if (customer && customer.lastPumped !== patch.lastPumped) {
          await enqueue(envelope('last_pumped.correct', {
            id: idFactory(), customerId, lastPumped: patch.lastPumped,
          }))
        }
      }
      if (Object.keys(patch).some((key) => PIN_FIELDS.has(key))) {
        const current = snapshot.customers.find((row) => row.id === customerId)
        if (current) {
          await enqueue(envelope('pin.restore', {
            customerId,
            lat: Object.hasOwn(patch, 'lat') ? patch.lat : current.lat,
            lng: Object.hasOwn(patch, 'lng') ? patch.lng : current.lng,
            locationPrecision: Object.hasOwn(patch, 'locationPrecision')
              ? patch.locationPrecision : current.locationPrecision || '',
            locationConfirmedAt: Object.hasOwn(patch, 'locationConfirmedAt')
              ? patch.locationConfirmedAt : current.locationConfirmedAt ?? null,
          }))
        }
      }
    },

    setPin: (customerId, point) => enqueue(envelope('pin.set', { customerId, ...point })),
    restorePin: (customerId, pin) => enqueue(envelope('pin.restore', { customerId, ...pin })),
    recordVisit: (visit) => enqueue(envelope('visit.record', visit)),
    updateVisit: (visitId, changes) => enqueue(envelope('visit.update', { visitId, changes })),
    archiveVisit: (visitId) => enqueue(envelope('visit.archive', { visitId })),
    recordPhoto: (photo) => enqueue(envelope('photo.record', photo)),
    archivePhoto: (photoId) => enqueue(envelope('photo.archive', { photoId })),
    correctLastPumped: (customerId, lastPumped, id = idFactory()) =>
      enqueue(envelope('last_pumped.correct', { id, customerId, lastPumped })),
    setAvgJobPrice: (avgJobPrice) => {
      const cents = Math.round(avgJobPrice * 100)
      if (!Number.isSafeInteger(cents) || cents < 1) {
        return Promise.reject(new TypeError('Average job price must be at least $0.01'))
      }
      return enqueue(envelope('setting.set_avg_job_price', { avgJobPriceCents: cents }))
    },
    markReminderSent: (reminderId) => enqueue(envelope(
      'reminder.mark_manual_sent', parseReminderId(reminderId)
    )),
  }
}
