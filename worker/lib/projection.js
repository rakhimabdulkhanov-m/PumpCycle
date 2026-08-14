/**
 * The D1 schema is snake_case; the browser read model is camelCase. Keep that
 * translation in this file so endpoint code never grows a second, partial map.
 */

import { isoDateInZone } from '../../src/lib/dates.js'

const value = (row, key, fallback = '') => row[key] ?? fallback

export function projectCustomer(row) {
  return {
    id: row.id,
    externalRef: value(row, 'external_ref'),
    name: value(row, 'name'),
    address: value(row, 'address'),
    phone: value(row, 'phone'),
    email: value(row, 'email'),
    emailStatus: value(row, 'email_status', 'ok'),
    softBounceCount: value(row, 'soft_bounce_count', 0),
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    locationPrecision: value(row, 'location_precision'),
    locationConfirmedAt: row.location_confirmed_at ?? null,
    addressChangedAt: row.address_changed_at ?? null,
    tankSizeGal: value(row, 'tank_size_gal', 0),
    lastPumped: row.last_pumped ?? null,
    cycleMonths: value(row, 'cycle_months', 0),
    cycleSeq: value(row, 'cycle_seq', 0),
    notes: value(row, 'notes'),
    editedInApp: Boolean(row.edited_in_app),
    reminderBaselineAt: row.reminder_baseline_at ?? null,
    fieldTs: value(row, 'field_ts', '{}'),
    archivedAt: row.archived_at ?? null,
    createdAt: value(row, 'created_at', 0),
    updatedAt: value(row, 'updated_at', 0),
    seq: value(row, 'seq', 0),
  }
}

export function projectVisit(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    visitedOn: value(row, 'visited_on'),
    setsLastPumped: Boolean(row.sets_last_pumped),
    gallons: value(row, 'gallons', 0),
    priceCents: value(row, 'price_cents', 0),
    tech: value(row, 'tech'),
    notes: value(row, 'notes'),
    archivedAt: row.archived_at ?? null,
    createdAt: value(row, 'created_at', 0),
    seq: value(row, 'seq', 0),
  }
}

export function projectPhoto(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    visitId: row.visit_id ?? null,
    r2Key: value(row, 'r2_key'),
    contentType: value(row, 'content_type'),
    bytes: value(row, 'bytes', 0),
    width: value(row, 'width', 0),
    height: value(row, 'height', 0),
    caption: value(row, 'caption'),
    blobState: value(row, 'blob_state', 'pending'),
    archivedAt: row.archived_at ?? null,
    createdAt: value(row, 'created_at', 0),
    seq: value(row, 'seq', 0),
  }
}

export function projectReminder(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    reminderKey: value(row, 'reminder_key'),
    cycleSeq: value(row, 'cycle_seq', 0),
    channel: value(row, 'channel'),
    provider: value(row, 'provider'),
    providerMessageId: value(row, 'provider_message_id'),
    toEmail: value(row, 'to_email'),
    status: value(row, 'status'),
    attempts: value(row, 'attempts', 0),
    claimedAt: value(row, 'claimed_at', 0),
    sentAt: row.sent_at ?? null,
    error: value(row, 'error'),
    seq: value(row, 'seq', 0),
  }
}

const SETTING_TYPES = {
  reminder_send_hour: Number,
  overdue_reminders_enabled: (v) => v === '1',
  max_sends_per_run: Number,
  email_enabled: (v) => v === '1',
  avg_job_price_cents: Number,
}

export function projectSettings(rows) {
  const projected = {}
  for (const row of rows) {
    const key = row.key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
    const convert = SETTING_TYPES[row.key]
    projected[key] = convert ? convert(row.value) : row.value
  }
  return projected
}

/**
 * The manual-send projection the browser reads back as "this one is sent".
 *
 * `timeZone` is the tenant's IANA zone and is required, because the Worker's own
 * clock is UTC: formatting here with toISOString() dated every send after 20:00
 * Eastern as tomorrow, and this value REPLACES the browser's optimistic one on
 * the next sync, so the Reminders tab printed tomorrow's date back at the
 * operator this evening. An unknown zone throws out of Intl rather than quietly
 * becoming UTC - the same fail-loud policy as src/lib/dates.js.
 */
export function reminderCompatibility(rows, timeZone) {
  const dateInZone = isoDateInZone(timeZone)
  const sentReminders = []
  const sentAt = {}
  for (const row of rows) {
    const id = `${row.customer_id}:${row.reminder_key}`
    sentReminders.push(id)
    if (row.sent_at != null) sentAt[id] = dateInZone(row.sent_at)
  }
  return { sentReminders, sentAt }
}
