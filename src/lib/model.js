import { toISODate } from './dates.js'
import { isDifferentEmail } from './email.js'
import { stampAddressChange } from './location.js'

export const MUTATION_TYPES = Object.freeze([
  'customer.add',
  'customer.update',
  'pin.set',
  'pin.restore',
  'visit.record',
  'visit.update',
  'visit.archive',
  'last_pumped.correct',
  'photo.record',
  'photo.archive',
  'setting.set_avg_job_price',
  'reminder.mark_manual_sent',
])

const MUTATION_TYPE_SET = new Set(MUTATION_TYPES)
const CUSTOMER_UPDATE_FIELDS = new Set([
  'name', 'address', 'phone', 'email', 'tankSizeGal', 'cycleMonths', 'notes',
])
const PIN_FIELDS = new Set(['lat', 'lng', 'locationPrecision', 'locationConfirmedAt'])

const array = (value) => (Array.isArray(value) ? value : [])
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

function withoutCustomerReminders(snapshot, customerId) {
  const keep = (key) => !key.startsWith(`${customerId}:`)
  const sentReminders = array(snapshot.sentReminders).filter(keep)
  const sentAt = Object.fromEntries(
    Object.entries(snapshot.sentAt || {}).filter(([key]) => keep(key))
  )
  // reminderLog is durable history. Only the legacy/current-cycle projection
  // resets; the server selects the matching cycle back into sentReminders.
  return { ...snapshot, sentReminders, sentAt }
}

function replaceCustomer(snapshot, customerId, transform) {
  let found = false
  const customers = array(snapshot.customers).map((customer) => {
    if (customer.id !== customerId) return customer
    found = true
    return transform(customer)
  })
  return found ? { ...snapshot, customers } : snapshot
}

function addCustomer(snapshot, mutation) {
  const customer = { ...mutation.payload }
  let next = { ...snapshot, customers: [...array(snapshot.customers), customer] }
  if (Array.isArray(snapshot.visits) && customer.lastPumped) {
    next = {
      ...next,
      visits: [
        ...snapshot.visits,
        {
          id: `${mutation.mutationId}:baseline`,
          customerId: customer.id,
          visitedOn: customer.lastPumped,
          setsLastPumped: true,
          gallons: 0,
          priceCents: 0,
          tech: '',
          notes: '',
          archivedAt: null,
          createdAt: mutation.createdAt,
        },
      ],
    }
  }
  return next
}

function updateCustomer(snapshot, mutation) {
  const { customerId, changes } = mutation.payload
  const previous = array(snapshot.customers).find((customer) => customer.id === customerId)
  if (!previous) return snapshot
  const patch = stampAddressChange(previous, changes, mutation.createdAt)
  const cycleChanged = own(changes, 'cycleMonths') && changes.cycleMonths !== previous.cycleMonths
  // The same rule the Worker applies (worker/api/mutations.js): a genuinely
  // different address is a different recipient, so a BOUNCE recorded against the
  // old one stops applying. Applied optimistically so the red row on the
  // Reminders tab clears the moment he saves the correction rather than after
  // the next sync - which means it must match the server exactly, or the row
  // flickers back.
  //
  // A COMPLAINT IS NOT A BOUNCE and is not lifted by any edit, on either side.
  // The server keeps email_status 'complained' whatever the address becomes, so
  // clearing it here would tell him for a few seconds that the one problem the
  // app cannot fix is fixed, and then take it back on the next sync.
  const emailChanged =
    own(changes, 'email') &&
    isDifferentEmail(changes.email, previous.email) &&
    previous.emailStatus !== 'complained'
  let next = replaceCustomer(snapshot, customerId, (customer) => ({
    ...customer,
    ...patch,
    ...(emailChanged ? { emailStatus: 'ok', softBounceCount: 0 } : {}),
    ...(cycleChanged && own(customer, 'cycleSeq')
      ? { cycleSeq: (customer.cycleSeq || 0) + 1 }
      : {}),
  }))
  if (cycleChanged) next = withoutCustomerReminders(next, customerId)
  return next
}

function changePin(snapshot, mutation, restore) {
  const { customerId, lat, lng } = mutation.payload
  const patch = restore
    ? {
        lat,
        lng,
        locationPrecision: mutation.payload.locationPrecision,
        locationConfirmedAt: mutation.payload.locationConfirmedAt,
      }
    : {
        lat,
        lng,
        locationPrecision: 'manual',
        locationConfirmedAt: mutation.createdAt,
      }
  return replaceCustomer(snapshot, customerId, (customer) => ({ ...customer, ...patch }))
}

function recordVisit(snapshot, mutation) {
  const visit = {
    setsLastPumped: true,
    gallons: 0,
    priceCents: 0,
    tech: '',
    notes: '',
    archivedAt: null,
    createdAt: mutation.createdAt,
    ...mutation.payload,
  }
  const visits = Array.isArray(snapshot.visits) ? [...snapshot.visits, visit] : snapshot.visits
  const previous = array(snapshot.customers).find((customer) => customer.id === visit.customerId)
  if (!previous || !visit.setsLastPumped) {
    return { ...snapshot, ...(visits ? { visits } : {}) }
  }
  const effective = [previous.lastPumped, visit.visitedOn].filter(Boolean).sort().at(-1)
  if (effective === previous.lastPumped) return { ...snapshot, ...(visits ? { visits } : {}) }
  let next = replaceCustomer(
    { ...snapshot, ...(visits ? { visits } : {}) },
    visit.customerId,
    (customer) => ({
      ...customer,
      lastPumped: effective,
      ...(own(customer, 'cycleSeq') ? { cycleSeq: (customer.cycleSeq || 0) + 1 } : {}),
    })
  )
  next = withoutCustomerReminders(next, visit.customerId)
  return next
}

function correctLastPumped(snapshot, mutation) {
  const { id, customerId, lastPumped } = mutation.payload
  const visits = Array.isArray(snapshot.visits)
    ? snapshot.visits.map((visit) =>
        visit.customerId === customerId && visit.setsLastPumped && visit.archivedAt == null
          ? { ...visit, setsLastPumped: false }
          : visit
      )
    : snapshot.visits
  if (Array.isArray(visits) && lastPumped) {
    visits.push({
      id,
      customerId,
      visitedOn: lastPumped,
      setsLastPumped: true,
      gallons: 0,
      priceCents: 0,
      tech: '',
      notes: '',
      archivedAt: null,
      createdAt: mutation.createdAt,
    })
  }
  let next = replaceCustomer(
    { ...snapshot, ...(visits ? { visits } : {}) },
    customerId,
    (customer) => ({
      ...customer,
      lastPumped,
      ...(own(customer, 'cycleSeq') ? { cycleSeq: (customer.cycleSeq || 0) + 1 } : {}),
    })
  )
  next = withoutCustomerReminders(next, customerId)
  return next
}

function setAvgJobPrice(snapshot, mutation) {
  const cents = mutation.payload.avgJobPriceCents
  return {
    ...snapshot,
    settings: {
      ...(snapshot.settings || {}),
      avgJobPriceCents: cents,
      avgJobPrice: cents / 100,
    },
  }
}

function markReminderSent(snapshot, mutation) {
  const { customerId, reminderKey, channel } = mutation.payload
  const compatibilityId = `${customerId}:${reminderKey}`
  const sentReminders = array(snapshot.sentReminders).includes(compatibilityId)
    ? snapshot.sentReminders
    : [...array(snapshot.sentReminders), compatibilityId]
  const sentAt = {
    ...(snapshot.sentAt || {}),
    // The operator's calendar day, not UTC's: a text marked sent at 20:30
    // Eastern was sent today, and the tab prints this date back at him in the
    // repeat question. The server projection (worker/lib/projection.js) formats
    // the same moment in the tenant's zone, so the value that replaces this one
    // on the next sync agrees with it.
    [compatibilityId]: toISODate(new Date(mutation.createdAt)),
  }
  if (!Array.isArray(snapshot.reminderLog)) return { ...snapshot, sentReminders, sentAt }
  const customer = array(snapshot.customers).find((row) => row.id === customerId)
  return {
    ...snapshot,
    sentReminders,
    sentAt,
    reminderLog: [
      ...snapshot.reminderLog,
      {
        id: `${mutation.mutationId}:reminder`,
        customerId,
        reminderKey,
        cycleSeq: customer?.cycleSeq || 0,
        channel,
        provider: 'manual',
        status: 'sent',
        attempts: 1,
        claimedAt: mutation.createdAt,
        sentAt: mutation.createdAt,
      },
    ],
  }
}

function updateVisit(snapshot, mutation) {
  const { visitId, changes } = mutation.payload
  if (!Array.isArray(snapshot.visits)) return snapshot
  const target = snapshot.visits.find((v) => v.id === visitId)
  if (!target) return snapshot

  const updatedVisit = { ...target, ...changes }
  const visits = snapshot.visits.map((v) => (v.id === visitId ? updatedVisit : v))

  // Recompute customer lastPumped if setsLastPumped, visitedOn, or archivedAt changed
  const customerId = target.customerId
  const customer = array(snapshot.customers).find((c) => c.id === customerId)
  if (!customer) return { ...snapshot, visits }

  const activeDates = visits
    .filter(
      (v) =>
        v.customerId === customerId &&
        v.setsLastPumped &&
        v.archivedAt == null &&
        v.visitedOn
    )
    .map((v) => v.visitedOn)
    .sort()

  const newLastPumped = activeDates.length > 0 ? activeDates[activeDates.length - 1] : null
  if (newLastPumped === customer.lastPumped) {
    return { ...snapshot, visits }
  }

  let next = replaceCustomer({ ...snapshot, visits }, customerId, (c) => ({
    ...c,
    lastPumped: newLastPumped,
    ...(own(c, 'cycleSeq') ? { cycleSeq: (c.cycleSeq || 0) + 1 } : {}),
  }))
  next = withoutCustomerReminders(next, customerId)
  return next
}

function archiveVisit(snapshot, mutation) {
  const { visitId } = mutation.payload
  return updateVisit(snapshot, {
    ...mutation,
    type: 'visit.update',
    payload: { visitId, changes: { archivedAt: mutation.createdAt } },
  })
}

function recordPhoto(snapshot, mutation) {
  const photo = {
    visitId: null,
    r2Key: '',
    contentType: 'image/jpeg',
    bytes: 0,
    width: 0,
    height: 0,
    caption: '',
    blobState: 'stored',
    archivedAt: null,
    createdAt: mutation.createdAt,
    ...mutation.payload,
  }
  const existing = array(snapshot.photos).find((p) => p.id === photo.id)
  const photos = existing
    ? snapshot.photos.map((p) => (p.id === photo.id ? { ...p, ...photo } : p))
    : [...array(snapshot.photos), photo]
  return { ...snapshot, photos }
}

function archivePhoto(snapshot, mutation) {
  const { photoId } = mutation.payload
  if (!Array.isArray(snapshot.photos)) return snapshot
  const photos = snapshot.photos.map((p) =>
    p.id === photoId ? { ...p, archivedAt: mutation.createdAt } : p
  )
  return { ...snapshot, photos }
}

const APPLY = {
  'customer.add': addCustomer,
  'customer.update': updateCustomer,
  'pin.set': (snapshot, mutation) => changePin(snapshot, mutation, false),
  'pin.restore': (snapshot, mutation) => changePin(snapshot, mutation, true),
  'visit.record': recordVisit,
  'visit.update': updateVisit,
  'visit.archive': archiveVisit,
  'last_pumped.correct': correctLastPumped,
  'photo.record': recordPhoto,
  'photo.archive': archivePhoto,
  'setting.set_avg_job_price': setAvgJobPrice,
  'reminder.mark_manual_sent': markReminderSent,
}

/** Apply one canonical mutation without I/O or ambient time/id reads. */
export function applyMutation(snapshot, mutation) {
  if (!mutation || !MUTATION_TYPE_SET.has(mutation.type)) {
    throw new TypeError(`Unsupported mutation type: ${mutation?.type || ''}`)
  }
  if (!Number.isFinite(mutation.createdAt)) throw new TypeError('Mutation createdAt is required')
  return APPLY[mutation.type](snapshot, mutation)
}

export function mutationEnvelope(type, payload, { mutationId, createdAt } = {}) {
  if (!MUTATION_TYPE_SET.has(type)) throw new TypeError(`Unsupported mutation type: ${type}`)
  if (!mutationId) throw new TypeError('mutationId is required')
  if (!Number.isFinite(createdAt)) throw new TypeError('createdAt is required')
  return { mutationId, type, createdAt, payload }
}

/**
 * Compatibility funnel for existing components. It decomposes the old patch
 * API into the same mutation vocabulary used by the Worker.
 */
export function updateCustomerState(data, id, patch, options = {}) {
  const createdAt = options.createdAt ?? Date.now()
  const mutationId = options.mutationId || `legacy:${id}:${createdAt}`
  let next = data
  const changes = Object.fromEntries(
    Object.entries(patch).filter(([key]) => CUSTOMER_UPDATE_FIELDS.has(key))
  )
  if (Object.keys(changes).length) {
    next = applyMutation(next, { mutationId, type: 'customer.update', createdAt, payload: { customerId: id, changes } })
  }
  if (own(patch, 'lastPumped')) {
    const previous = array(next.customers).find((customer) => customer.id === id)
    if (previous && patch.lastPumped !== previous.lastPumped) {
      next = applyMutation(next, {
        mutationId: `${mutationId}:last-pumped`,
        type: 'last_pumped.correct',
        createdAt,
        payload: { id: `${mutationId}:visit`, customerId: id, lastPumped: patch.lastPumped },
      })
    }
  }
  const pinPatch = Object.keys(patch).some((key) => PIN_FIELDS.has(key))
  if (pinPatch) {
    const current = array(next.customers).find((customer) => customer.id === id)
    if (current) {
      next = applyMutation(next, {
        mutationId: `${mutationId}:pin`,
        type: 'pin.restore',
        createdAt,
        payload: {
          customerId: id,
          lat: own(patch, 'lat') ? patch.lat : current.lat,
          lng: own(patch, 'lng') ? patch.lng : current.lng,
          locationPrecision: own(patch, 'locationPrecision')
            ? patch.locationPrecision
            : current.locationPrecision || '',
          locationConfirmedAt: own(patch, 'locationConfirmedAt')
            ? patch.locationConfirmedAt
            : current.locationConfirmedAt ?? null,
        },
      })
    }
  }
  return next
}
