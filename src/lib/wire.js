const COLLECTIONS = ['customers', 'visits', 'photos', 'reminderLog']

const FIELD_NAMES = {
  external_ref: 'externalRef',
  email_status: 'emailStatus',
  soft_bounce_count: 'softBounceCount',
  location_precision: 'locationPrecision',
  location_confirmed_at: 'locationConfirmedAt',
  address_changed_at: 'addressChangedAt',
  tank_size_gal: 'tankSizeGal',
  last_pumped: 'lastPumped',
  cycle_months: 'cycleMonths',
  cycle_seq: 'cycleSeq',
  edited_in_app: 'editedInApp',
  reminder_baseline_at: 'reminderBaselineAt',
  field_ts: 'fieldTs',
  archived_at: 'archivedAt',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  customer_id: 'customerId',
  visit_id: 'visitId',
  visited_on: 'visitedOn',
  sets_last_pumped: 'setsLastPumped',
  price_cents: 'priceCents',
  r2_key: 'r2Key',
  content_type: 'contentType',
  blob_state: 'blobState',
  reminder_key: 'reminderKey',
  provider_message_id: 'providerMessageId',
  to_email: 'toEmail',
  claimed_at: 'claimedAt',
  sent_at: 'sentAt',
  avg_job_price_cents: 'avgJobPriceCents',
}

const camelRecord = (record) => Object.fromEntries(
  Object.entries(record || {}).map(([key, value]) => [FIELD_NAMES[key] || key, value])
)

export const emptySnapshot = (extra = {}) => ({
  customers: [],
  visits: [],
  photos: [],
  reminderLog: [],
  settings: { avgJobPrice: 450, avgJobPriceCents: 45000 },
  sentReminders: [],
  sentAt: {},
  cursor: 0,
  ...extra,
})

export function normalizeSettings(settings = {}) {
  const next = camelRecord(settings)
  if (Number.isFinite(next.avgJobPriceCents)) next.avgJobPrice = next.avgJobPriceCents / 100
  else if (Number.isFinite(next.avgJobPrice)) next.avgJobPriceCents = Math.round(next.avgJobPrice * 100)
  return next
}

/** The sole browser boundary that accepts wire/D1 names and returns UI names. */
export function decodeSyncResponse(response) {
  if (!response || response.ok === false) throw new TypeError(response?.error || 'Invalid sync response')
  return {
    ok: true,
    cursor: Number.isSafeInteger(response.cursor) ? response.cursor : 0,
    customers: (response.customers || []).map(camelRecord),
    visits: (response.visits || []).map(camelRecord),
    photos: (response.photos || []).map(camelRecord),
    reminderLog: (response.reminderLog || response.reminder_log || []).map(camelRecord),
    settings: normalizeSettings(response.settings),
    sentReminders: [...(response.sentReminders || response.sent_reminders || [])],
    sentAt: { ...(response.sentAt || response.sent_at || {}) },
  }
}

/**
 * Mutations remain the Worker's canonical camelCase envelope. The only UI/wire
 * unit conversion is dollars to integer cents.
 */
export function encodeMutation(mutation) {
  const payload = { ...(mutation.payload || {}) }
  if (mutation.type === 'setting.set_avg_job_price') {
    if (!Number.isFinite(payload.avgJobPriceCents) && Number.isFinite(payload.avgJobPrice)) {
      payload.avgJobPriceCents = Math.round(payload.avgJobPrice * 100)
    }
    delete payload.avgJobPrice
  }
  // IndexedDB adds local replay metadata (`order`, `status`, and possibly
  // `error`) to an outbox record. The Worker accepts an exact four-field
  // envelope, so local bookkeeping must never cross the HTTP boundary.
  return {
    mutationId: mutation.mutationId,
    type: mutation.type,
    createdAt: mutation.createdAt,
    payload,
  }
}

function mergeRows(baseRows, deltaRows) {
  const order = []
  const rows = new Map()
  for (const row of baseRows || []) {
    if (row.archivedAt != null) continue
    order.push(row.id)
    rows.set(row.id, row)
  }
  for (const row of deltaRows || []) {
    if (row.archivedAt != null) {
      rows.delete(row.id)
      continue
    }
    if (!rows.has(row.id)) order.push(row.id)
    rows.set(row.id, { ...(rows.get(row.id) || {}), ...row })
  }
  return order.filter((id) => rows.has(id)).map((id) => rows.get(id))
}

/** Merge a bounded sync delta without ever treating it as a full replacement. */
export function mergeSyncDelta(base, response) {
  const delta = decodeSyncResponse(response)
  const next = { ...emptySnapshot(), ...base, cursor: delta.cursor }
  for (const key of COLLECTIONS) next[key] = mergeRows(base?.[key], delta[key])
  next.settings = { ...(base?.settings || {}), ...delta.settings }
  // These are complete current-cycle projections on every sync response.
  next.sentReminders = delta.sentReminders
  next.sentAt = delta.sentAt
  return next
}
