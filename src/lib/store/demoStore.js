import { newCustomerId } from '../ids.js'
import { channelForRungKey } from '../reminderView.js'
import { applyMutation, updateCustomerState } from '../model.js'
import { loadState, saveState } from '../storage.js'
import { createMutation } from './outbox.js'

let fallbackId = 0
const mutationId = () => {
  if (globalThis.crypto?.randomUUID) return `m-${globalThis.crypto.randomUUID()}`
  fallbackId += 1
  return `m-${Date.now()}-${fallbackId}`
}

const parseReminderId = (reminderId) => {
  const split = reminderId.lastIndexOf(':')
  if (split < 1) throw new TypeError('Reminder id must be customerId:key')
  const customerId = reminderId.slice(0, split)
  const reminderKey = reminderId.slice(split + 1)
  // The channel comes from the canonical rung key, never from the old day
  // offsets. Keying on '14' predates the rung keys and sent channel 'email' for
  // the 'sms' rung, which the Worker rejects outright ("payload reminder key and
  // channel do not match") - marking a text sent could not succeed on a live
  // book.
  return { customerId, reminderKey, channel: channelForRungKey(reminderKey) }
}

/** The existing pumpcycle-demo-v4 behavior behind the async store contract. */
export function createDemoStore(options = {}) {
  const load = options.load || loadState
  const save = options.save || saveState
  const customerIdFactory = options.customerIdFactory || newCustomerId
  const mutationIdFactory = options.mutationIdFactory || mutationId
  const clock = options.clock || Date.now
  let snapshot = load()
  const listeners = new Set()

  const publish = (next) => {
    save(next)
    snapshot = next
    for (const listener of listeners) listener()
  }

  const envelope = (type, payload, overrides = {}) => createMutation(type, payload, {
    mutationId: overrides.mutationId || mutationIdFactory(),
    createdAt: overrides.createdAt ?? clock(),
  })

  const mutate = async (mutation) => {
    publish(applyMutation(snapshot, mutation))
    return mutation
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    getMode: () => 'demo',
    init: async () => snapshot,
    mutate,

    async addCustomer(fields) {
      const id = fields.id || customerIdFactory()
      await mutate(envelope('customer.add', { ...fields, id }))
      return id
    },

    async updateCustomer(id, patch) {
      const createdAt = clock()
      const next = updateCustomerState(snapshot, id, patch, {
        createdAt,
        mutationId: mutationIdFactory(),
      })
      publish(next)
    },

    setPin: (customerId, point) => mutate(envelope('pin.set', { customerId, ...point })),
    restorePin: (customerId, pin) => mutate(envelope('pin.restore', { customerId, ...pin })),
    recordVisit: (visit) => mutate(envelope('visit.record', visit)),
    correctLastPumped: (customerId, lastPumped, id = mutationIdFactory()) =>
      mutate(envelope('last_pumped.correct', { id, customerId, lastPumped })),
    setAvgJobPrice: (avgJobPrice) => mutate(envelope('setting.set_avg_job_price', {
      avgJobPriceCents: Math.round(avgJobPrice * 100),
    })),
    markReminderSent: (reminderId) => mutate(envelope(
      'reminder.mark_manual_sent', parseReminderId(reminderId)
    )),
  }
}

