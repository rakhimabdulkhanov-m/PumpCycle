#!/usr/bin/env node

/**
 * Turn an explicit pumpcycle-demo-v4 localStorage export into reviewable SQL.
 *
 * This program only reads the named JSON file and (unless --dry-run) writes the
 * named SQL file. It never opens a browser, invokes deployment tooling, connects to D1, or
 * executes the generated SQL.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSanePoint } from '../src/lib/point.js'
import { PRE_DUE_KEY, SMS_KEY } from '../src/lib/reminders.js'
import { channelForRungKey } from '../src/lib/reminderView.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SEED = JSON.parse(readFileSync(resolve(ROOT, 'src/data/seed.json'), 'utf8'))
const STORAGE_KEY = 'pumpcycle-demo-v4'
const PRECISIONS = new Set(['', 'house', 'house_approx', 'road', 'locality', 'manual'])
const LIVE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const DAY_MS = 86_400_000

/**
 * Every rung key a manual-send projection can hold, mapped onto the canonical
 * key the live app writes today (src/lib/reminders.js).
 *
 * A book exported before the rungs were re-keyed carries the day offsets: '60'
 * and '15' are the residential and commercial lead times of the ONE pre-due
 * email rung, and '14' is the text rung. A book exported by the current app
 * already carries 'pre'/'sms'. This program has to accept both, because it is
 * the path that carries a paying client's book during setup week and the client
 * may have been running either build.
 *
 * The overdue rungs (od1/od2/od3) are deliberately absent: they are sent by the
 * Worker and recorded directly in reminder_log, so they never appear in the
 * localStorage manual-send projection. An id keyed with one is a corrupt export
 * and is refused rather than guessed at.
 */
const CANONICAL_RUNG_KEYS = new Map([
  ['60', PRE_DUE_KEY],
  ['15', PRE_DUE_KEY],
  ['14', SMS_KEY],
  [PRE_DUE_KEY, PRE_DUE_KEY],
  [SMS_KEY, SMS_KEY],
])

export class InputError extends Error {}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function sqlText(value) {
  const text = String(value)
  if (text.includes('\0')) throw new InputError('Strings containing NUL bytes cannot be represented safely in SQL.')
  return `'${text.replaceAll("'", "''")}'`
}

function sqlNullable(value) {
  return value === null ? 'NULL' : sqlText(value)
}

function requireDay(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InputError(`${label} must be a real YYYY-MM-DD calendar day${nullable ? ' or null' : ''}.`)
  }
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new InputError(`${label} is not a real calendar day: ${value}`)
  }
  return value
}

function scalarString(value, fallback, label, { trim = false, max = null } = {}) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'object' || typeof value === 'symbol') {
    throw new InputError(`${label} must be a string or scalar value.`)
  }
  const text = trim ? String(value).trim() : String(value)
  if (text.includes('\0')) throw new InputError(`${label} contains a NUL byte.`)
  if (max !== null && text.length > max) throw new InputError(`${label} exceeds ${max} characters.`)
  return text
}

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new InputError(`${label} must be a positive whole number.`)
  }
  return number
}

function moment(value, label, flags, customerId) {
  if (value === undefined || value === null || value === '') return null
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (!Number.isSafeInteger(number) || number < 0) {
    flags.push({ customerId, field: label, kind: 'invalid_moment', message: `${label} was cleared because it was not a non-negative integer millisecond timestamp.` })
    return null
  }
  return number
}

function coordinate(value) {
  if (value === undefined || value === null) return { present: false, valid: false, value: null }
  if (typeof value === 'string' && value.trim() === '') return { present: false, valid: false, value: null }
  const number = typeof value === 'string' ? Number(value.trim()) : value
  return { present: true, valid: typeof number === 'number' && Number.isFinite(number), value: number }
}

function normalizePoint(raw, id, flags) {
  const lat = coordinate(raw.lat)
  const lng = coordinate(raw.lng)
  let point = null
  if (!lat.present && !lng.present) {
    point = null
  } else if (lat.present !== lng.present) {
    flags.push({ customerId: id, field: 'lat/lng', kind: 'half_coordinate', message: 'Half a coordinate pair was dropped; this customer needs a pin.' })
  } else if (!lat.valid || !lng.valid) {
    flags.push({ customerId: id, field: 'lat/lng', kind: 'malformed_coordinate', message: 'Malformed coordinates were dropped; this customer needs a pin.' })
  } else if (!isSanePoint(lat.value, lng.value)) {
    flags.push({ customerId: id, field: 'lat/lng', kind: 'outside_us', message: 'Coordinates outside the supported US boxes were dropped; this customer needs a pin.' })
  } else {
    point = { lat: lat.value, lng: lng.value }
  }

  let precision = scalarString(raw.locationPrecision, '', `customer ${id} locationPrecision`, { trim: true })
  if (!PRECISIONS.has(precision)) {
    flags.push({ customerId: id, field: 'locationPrecision', kind: 'invalid_precision', message: 'Unknown location precision was cleared.' })
    precision = ''
  }
  let confirmed = moment(raw.locationConfirmedAt, 'locationConfirmedAt', flags, id)
  let addressChanged = moment(raw.addressChangedAt, 'addressChangedAt', flags, id)
  if (!point) {
    precision = ''
    confirmed = null
    addressChanged = null
  }
  return { lat: point?.lat ?? null, lng: point?.lng ?? null, locationPrecision: precision, locationConfirmedAt: confirmed, addressChangedAt: addressChanged }
}

function contentKey(customer) {
  const normalize = (value) => value.trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ')
  return `${normalize(customer.name)}\u0000${normalize(customer.address)}`
}

function seedComparable(customer) {
  return {
    id: customer.id,
    name: customer.name ?? '',
    address: customer.address ?? '',
    phone: customer.phone ?? '',
    email: customer.email ?? '',
    lat: customer.lat,
    lng: customer.lng,
    tankSizeGal: Number(customer.tankSizeGal),
    cycleMonths: Number(customer.cycleMonths),
    notes: customer.notes ?? '',
  }
}

/** Refuses the fictional seed even when every pump date was shifted by one common number of days. */
export function isDemoSeed(customers) {
  if (!Array.isArray(customers) || customers.length !== SEED.customers.length) return false
  const candidate = new Map(customers.map((customer) => [customer?.id, customer]))
  if (candidate.size !== SEED.customers.length) return false
  let shift = null
  for (const seeded of SEED.customers) {
    const current = candidate.get(seeded.id)
    if (!current || JSON.stringify(seedComparable(current)) !== JSON.stringify(seedComparable(seeded))) return false
    if (typeof current.lastPumped !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(current.lastPumped)) return false
    const delta = (Date.parse(`${current.lastPumped}T00:00:00Z`) - Date.parse(`${seeded.lastPumped}T00:00:00Z`)) / DAY_MS
    if (!Number.isInteger(delta)) return false
    if (shift === null) shift = delta
    else if (shift !== delta) return false
  }
  return true
}

export function extractState(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new InputError('The JSON root must be an object.')
  if (Object.hasOwn(parsed, STORAGE_KEY)) {
    if (Object.keys(parsed).length !== 1) throw new InputError(`A ${STORAGE_KEY} wrapper must contain that key only.`)
    let state = parsed[STORAGE_KEY]
    if (typeof state === 'string') {
      try { state = JSON.parse(state) } catch { throw new InputError(`The ${STORAGE_KEY} wrapper value is not valid JSON.`) }
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new InputError(`The ${STORAGE_KEY} value must be a state object.`)
    return state
  }
  if (!Array.isArray(parsed.customers)) throw new InputError(`Expected a state object with a customers array, or a wrapper containing only ${STORAGE_KEY}.`)
  return parsed
}

export function normalizeExport(parsed, { tenantId, sourceHash }) {
  if (typeof tenantId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(tenantId)) {
    throw new InputError('tenantId may contain only letters, numbers, dot, underscore, and hyphen.')
  }
  if (typeof sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(sourceHash)) {
    throw new InputError('sourceHash must be a lowercase SHA-256 hex digest.')
  }
  const state = extractState(parsed)
  if (!Array.isArray(state.customers) || state.customers.length === 0) throw new InputError('The export must contain at least one customer.')
  if (isDemoSeed(state.customers)) throw new InputError('Refusing the fictional PumpCycle demo seed (including a uniformly date-shifted copy). Export a real, non-seed customer book.')
  const baseDate = requireDay(state.baseDate, 'baseDate')
  const importAt = Date.parse(`${baseDate}T12:00:00.000Z`)
  const flags = []
  const seenIds = new Set()
  const seenContent = new Map()
  const customers = state.customers.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError(`customer[${index}] must be an object.`)
    if (typeof raw.id !== 'string' || !LIVE_ID_RE.test(raw.id.trim())) throw new InputError(`customer[${index}] has an invalid or missing id; live identity is never minted silently.`)
    const id = raw.id.trim()
    if (seenIds.has(id)) throw new InputError(`Duplicate customer id: ${id}`)
    seenIds.add(id)
    const customer = {
      id,
      name: scalarString(raw.name, '', `customer ${id} name`, { trim: true, max: 300 }),
      address: scalarString(raw.address, '', `customer ${id} address`, { trim: true, max: 500 }),
      phone: scalarString(raw.phone, '', `customer ${id} phone`, { trim: true, max: 100 }),
      email: scalarString(raw.email, '', `customer ${id} email`, { trim: true, max: 320 }),
      tankSizeGal: positiveInteger(raw.tankSizeGal, 1000, `customer ${id} tankSizeGal`),
      lastPumped: requireDay(raw.lastPumped, `customer ${id} lastPumped`, { nullable: true }),
      cycleMonths: positiveInteger(raw.cycleMonths, 36, `customer ${id} cycleMonths`),
      notes: scalarString(raw.notes, '', `customer ${id} notes`, { max: 2000 }),
      ...normalizePoint(raw, id, flags),
    }
    if (!customer.name) throw new InputError(`customer ${id} name must not be blank.`)
    const key = contentKey(customer)
    if (seenContent.has(key)) throw new InputError(`Duplicate customer content identity (normalized name + address) for ids ${seenContent.get(key)} and ${id}.`)
    seenContent.set(key, id)
    return customer
  })

  if (state.settings !== undefined && (!state.settings || typeof state.settings !== 'object' || Array.isArray(state.settings))) {
    throw new InputError('settings must be an object when present.')
  }
  const avgRaw = state.settings?.avgJobPrice ?? 450
  const avg = typeof avgRaw === 'string' && avgRaw.trim() !== '' ? Number(avgRaw) : avgRaw
  if (!Number.isFinite(avg) || avg < 0 || !Number.isSafeInteger(Math.round(avg * 100))) throw new InputError('settings.avgJobPrice must be a non-negative dollar amount.')
  const avgJobPriceCents = Math.round(avg * 100)
  const runId = `localstorage-${sha256(`${tenantId}\0${sourceHash}`).slice(0, 24)}`
  const visits = customers.filter((customer) => customer.lastPumped).map((customer) => ({
    id: `baseline-${sha256(`${tenantId}\0${customer.id}\0${customer.lastPumped}`).slice(0, 32)}`,
    customerId: customer.id,
    visitedOn: customer.lastPumped,
  }))
  if (state.sentReminders !== undefined && !Array.isArray(state.sentReminders)) {
    throw new InputError('sentReminders must be an array when present.')
  }
  if (state.sentAt !== undefined && (!state.sentAt || typeof state.sentAt !== 'object' || Array.isArray(state.sentAt))) {
    throw new InputError('sentAt must be an object when present.')
  }
  const byId = new Map(customers.map((customer) => [customer.id, customer]))
  const seenReminderIds = new Set()
  // Keyed by the NORMALISED compatibility id, so two key generations for the
  // same rung meet here rather than on the database's uniqueness index.
  // Each entry keeps the exported day beside the row so a collision can be
  // described in the flag without converting the moment back to a date.
  const byCanonicalId = new Map()
  for (const compatibilityId of state.sentReminders || []) {
    if (typeof compatibilityId !== 'string' || seenReminderIds.has(compatibilityId)) {
      throw new InputError(`Invalid or duplicate sent reminder id: ${String(compatibilityId)}`)
    }
    seenReminderIds.add(compatibilityId)
    const split = compatibilityId.lastIndexOf(':')
    const customerId = compatibilityId.slice(0, split)
    const reminderKey = CANONICAL_RUNG_KEYS.get(compatibilityId.slice(split + 1))
    const customer = byId.get(customerId)
    if (!customer || !reminderKey) {
      throw new InputError(`Sent reminder does not match an imported customer/key: ${compatibilityId}`)
    }
    const sentDay = requireDay(state.sentAt?.[compatibilityId], `sentAt.${compatibilityId}`, { nullable: true }) || baseDate
    if (!state.sentAt?.[compatibilityId]) {
      flags.push({ customerId, field: `sentAt.${reminderKey}`, kind: 'missing_sent_at', message: `Manual reminder ${reminderKey} had no sent date; the export base date was used.` })
    }
    // The row id is hashed from the NORMALISED id rather than the id as
    // exported, so one send is one row whichever generation of key the book was
    // written with: re-importing the same book after the client re-exports it
    // from the current app converges instead of writing a second row.
    const canonicalId = `${customerId}:${reminderKey}`
    // channelForRungKey is the canonical definition (src/lib/reminderView.js).
    const channel = channelForRungKey(reminderKey)
    const reminder = {
      id: `reminder-${sha256(`${tenantId}\0${canonicalId}`).slice(0, 32)}`,
      customerId,
      reminderKey,
      channel,
      toEmail: channel === 'sms' ? '' : customer.email,
      sentAt: Date.parse(`${sentDay}T12:00:00.000Z`),
    }
    const entry = { reminder, sentDay }
    const existing = byCanonicalId.get(canonicalId)
    if (!existing) {
      byCanonicalId.set(canonicalId, entry)
      continue
    }
    // A book holding both `c1:60` and `c1:pre` normalises to one row, and the
    // duplicate would violate uq_reminder_log_send and fail the whole import.
    // Keep the newer send - it is the one the customer actually received last -
    // and flag the drop so it lands in the review printout instead of vanishing.
    const kept = entry.reminder.sentAt > existing.reminder.sentAt ? entry : existing
    const dropped = kept === entry ? existing : entry
    byCanonicalId.set(canonicalId, kept)
    flags.push({
      customerId,
      field: `sentReminders.${reminderKey}`,
      kind: 'duplicate_reminder_key',
      message: `Two sent reminders normalised onto the ${reminderKey} rung; kept the ${kept.sentDay} send and dropped the duplicate dated ${dropped.sentDay}.`,
    })
  }
  const reminders = [...byCanonicalId.values()].map((entry) => entry.reminder)
  return { tenantId, sourceHash, baseDate, importAt, runId, customers, visits, reminders, flags, avgJobPriceCents }
}

function guardStatement(condition, label, runId) {
  if (Buffer.byteLength(condition, 'utf8') > 80_000) {
    throw new InputError(`The ${label} guard would exceed the safe 80,000-byte SQL budget. Split this export into a smaller reviewed book.`)
  }
  return [
    `-- Fail closed: ${label}`,
    `INSERT INTO import_runs (id, source, row_count, note, started_at)`,
    `SELECT ${sqlText(`guard-${runId}-${sha256(label).slice(0, 8)}`)}, 'guard', NULL, ${sqlText(label)}, 0`,
    `WHERE ${condition};`,
  ].join('\n')
}

function customerValues(customer, model, seqExpression) {
  return [
    sqlText(customer.id), "''", sqlText(customer.name), sqlText(customer.address), sqlText(customer.phone), sqlText(customer.email), "'ok'", '0',
    customer.lat ?? 'NULL', customer.lng ?? 'NULL', sqlText(customer.locationPrecision), customer.locationConfirmedAt ?? 'NULL', customer.addressChangedAt ?? 'NULL',
    customer.tankSizeGal, sqlNullable(customer.lastPumped), customer.cycleMonths, '0', sqlText(customer.notes), '0', model.importAt, "'{}'", 'NULL', model.importAt, model.importAt, seqExpression,
  ].join(', ')
}

export function generateSql(model) {
  const customerIds = model.customers.map((customer) => sqlText(customer.id)).join(', ')
  const visitIds = model.visits.map((visit) => sqlText(visit.id)).join(', ') || "''"
  const reminderMatches = model.reminders.length
    ? model.reminders.map((reminder) =>
        `(id = ${sqlText(reminder.id)} AND customer_id = ${sqlText(reminder.customerId)} AND reminder_key = ${sqlText(reminder.reminderKey)} AND cycle_seq = 0 AND channel = ${sqlText(reminder.channel)} AND provider = 'manual' AND status = 'sent' AND sent_at = ${reminder.sentAt})`
      ).join(' OR ')
    : '0'
  const source = `localstorage:${model.sourceHash}`
  const totalSeqs = model.customers.length + model.visits.length + model.reminders.length
  const statements = [
    '-- PumpCycle localStorage -> D1 generated import',
    `-- tenant_id: ${model.tenantId}`,
    `-- source_sha256: ${model.sourceHash}`,
    `-- source_rows: ${model.customers.length}`,
    `-- point_in_time: ${model.baseDate} (dates are preserved; never shifted)`,
    '-- Safety: generated only. Review, back up, then apply with the repository-approved D1 workflow.',
    '-- Safety: non-destructive and transaction-wrapper-free. Exact replays converge.',
    '-- Safety: the guards admit an empty tenant or a partial/exact replay of this run only.',
    '',
    guardStatement(`NOT EXISTS (SELECT 1 FROM schema_meta WHERE id = 1 AND tenant_id = ${sqlText(model.tenantId)} AND version >= 2)`, 'schema_meta must identify this tenant at schema version 2 or newer', model.runId),
    '',
    guardStatement(`EXISTS (SELECT 1 FROM customers) AND NOT EXISTS (SELECT 1 FROM import_runs WHERE id = ${sqlText(model.runId)} AND source = ${sqlText(source)} AND row_count = ${model.customers.length})`, 'existing customers do not belong to this exact import run', model.runId),
    '',
    guardStatement(`EXISTS (SELECT 1 FROM customers WHERE id NOT IN (${customerIds}) OR edited_in_app <> 0 OR created_at <> ${model.importAt} OR updated_at <> ${model.importAt})`, 'an existing customer is foreign to this artifact or was edited after import', model.runId),
    '',
    guardStatement(`EXISTS (SELECT 1 FROM visits WHERE id NOT IN (${visitIds}) OR created_at <> ${model.importAt})`, 'existing visits are foreign to this artifact or were changed after import', model.runId),
    '',
    guardStatement(`EXISTS (SELECT 1 FROM photos)`, 'photos already exist, so this is no longer an empty/replay-only tenant', model.runId),
    '',
    guardStatement(`EXISTS (SELECT 1 FROM reminder_log WHERE NOT (${reminderMatches}))`, 'existing reminder history is foreign to this exact import artifact', model.runId),
    '',
    guardStatement(`EXISTS (SELECT 1 FROM settings WHERE key = 'avg_job_price_cents' AND NOT ((value = '45000' AND updated_at = 0) OR (value = ${sqlText(model.avgJobPriceCents)} AND updated_at = ${model.importAt})))`, 'avg_job_price_cents was already changed outside this artifact', model.runId),
    '',
    `-- Reserve one monotonic block once. A crash before the run row can leave a harmless gap.`,
    `UPDATE seq_counter SET value = value + ${totalSeqs}`,
    `WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM import_runs WHERE id = ${sqlText(model.runId)});`,
    '',
    `INSERT INTO import_runs (id, source, row_count, note, started_at, completed_at)`,
    `SELECT ${sqlText(model.runId)}, ${sqlText(source)}, ${model.customers.length}, 'seq_end:' || value, ${model.importAt}, NULL FROM seq_counter WHERE id = 1`,
    `ON CONFLICT(id) DO NOTHING;`,
  ]

  model.customers.forEach((customer, index) => {
    const seq = `(SELECT CAST(substr(note, 9) AS INTEGER) - ${totalSeqs - 1 - index} FROM import_runs WHERE id = ${sqlText(model.runId)})`
    statements.push('', `INSERT INTO customers (`,
      `  id, external_ref, name, address, phone, email, email_status, soft_bounce_count,`,
      `  lat, lng, location_precision, location_confirmed_at, address_changed_at,`,
      `  tank_size_gal, last_pumped, cycle_months, cycle_seq, notes, edited_in_app,`,
      `  reminder_baseline_at, field_ts, archived_at, created_at, updated_at, seq`,
      `) VALUES (${customerValues(customer, model, seq)})`,
      `ON CONFLICT(id) DO UPDATE SET`,
      `  external_ref=excluded.external_ref, name=excluded.name, address=excluded.address,`,
      `  phone=excluded.phone, email=excluded.email, email_status=excluded.email_status,`,
      `  soft_bounce_count=excluded.soft_bounce_count, lat=excluded.lat, lng=excluded.lng,`,
      `  location_precision=excluded.location_precision, location_confirmed_at=excluded.location_confirmed_at,`,
      `  address_changed_at=excluded.address_changed_at, tank_size_gal=excluded.tank_size_gal,`,
      `  last_pumped=excluded.last_pumped, cycle_months=excluded.cycle_months, cycle_seq=excluded.cycle_seq,`,
      `  notes=excluded.notes, reminder_baseline_at=excluded.reminder_baseline_at, field_ts=excluded.field_ts,`,
      `  updated_at=excluded.updated_at`,
      `WHERE customers.edited_in_app = 0 AND customers.created_at = ${model.importAt} AND customers.updated_at = ${model.importAt};`)
  })

  model.visits.forEach((visit, index) => {
    const offset = model.customers.length + index
    const seq = `(SELECT CAST(substr(note, 9) AS INTEGER) - ${totalSeqs - 1 - offset} FROM import_runs WHERE id = ${sqlText(model.runId)})`
    statements.push('',
      `INSERT INTO visits (id, customer_id, visited_on, sets_last_pumped, gallons, price_cents, tech, notes, archived_at, created_at, seq)`,
      `VALUES (${sqlText(visit.id)}, ${sqlText(visit.customerId)}, ${sqlText(visit.visitedOn)}, 1, 0, 0, '', 'Imported localStorage baseline', NULL, ${model.importAt}, ${seq})`,
      `ON CONFLICT(id) DO NOTHING;`)
  })

  model.reminders.forEach((reminder, index) => {
    const offset = model.customers.length + model.visits.length + index
    const seq = `(SELECT CAST(substr(note, 9) AS INTEGER) - ${totalSeqs - 1 - offset} FROM import_runs WHERE id = ${sqlText(model.runId)})`
    statements.push('',
      `INSERT INTO reminder_log (id, customer_id, reminder_key, cycle_seq, channel, provider, provider_message_id, to_email, status, attempts, claimed_at, sent_at, error, seq)`,
      `VALUES (${sqlText(reminder.id)}, ${sqlText(reminder.customerId)}, ${sqlText(reminder.reminderKey)}, 0, ${sqlText(reminder.channel)}, 'manual', '', ${sqlText(reminder.toEmail)}, 'sent', 1, ${reminder.sentAt}, ${reminder.sentAt}, '', ${seq})`,
      `ON CONFLICT(id) DO NOTHING;`)
  })

  for (const flag of model.flags) {
    statements.push('',
      `INSERT INTO import_flags (import_run_id, customer_id, field, severity, message, created_at)`,
      `SELECT ${sqlText(model.runId)}, ${sqlText(flag.customerId)}, ${sqlText(flag.field)}, 'warn', ${sqlText(flag.message)}, ${model.importAt}`,
      `WHERE NOT EXISTS (SELECT 1 FROM import_flags WHERE import_run_id = ${sqlText(model.runId)} AND customer_id = ${sqlText(flag.customerId)} AND field = ${sqlText(flag.field)} AND message = ${sqlText(flag.message)});`)
  }

  statements.push('',
    `INSERT INTO settings (key, value, updated_at) VALUES ('avg_job_price_cents', ${sqlText(model.avgJobPriceCents)}, ${model.importAt})`,
    `ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;`,
    '',
    `UPDATE import_runs SET completed_at = ${model.importAt} WHERE id = ${sqlText(model.runId)};`,
    '')
  return statements.join('\n')
}

export function reviewSummary(model, { output, dryRun }) {
  const flagCounts = {}
  for (const flag of model.flags) flagCounts[flag.kind] = (flagCounts[flag.kind] || 0) + 1
  return {
    mode: dryRun ? 'dry-run' : 'generated',
    tenantId: model.tenantId,
    sourceSha256: model.sourceHash,
    sourceRows: model.customers.length,
    outputCustomers: model.customers.length,
    baselineVisits: model.visits.length,
    manualReminders: model.reminders.length,
    locationDropped: model.flags.filter((flag) => ['half_coordinate', 'malformed_coordinate', 'outside_us'].includes(flag.kind)).length,
    flagCount: model.flags.length,
    flagsByKind: flagCounts,
    settings: { avg_job_price_cents: model.avgJobPriceCents },
    output: dryRun ? null : output,
  }
}

function parseArgs(argv) {
  const result = { force: false, dryRun: false }
  const valued = new Set(['input', 'tenant-id', 'output'])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--force') result.force = true
    else if (arg === '--dry-run') result.dryRun = true
    else if (arg.startsWith('--')) {
      const equal = arg.indexOf('=')
      const key = arg.slice(2, equal === -1 ? undefined : equal)
      if (!valued.has(key)) throw new InputError(`Unknown argument: ${arg}`)
      const value = equal === -1 ? argv[++index] : arg.slice(equal + 1)
      if (!value || value.startsWith('--')) throw new InputError(`--${key} requires a value.`)
      if (result[key] !== undefined) throw new InputError(`--${key} was provided more than once.`)
      result[key] = value
    } else throw new InputError(`Unexpected positional argument: ${arg}`)
  }
  for (const key of valued) if (!result[key]) throw new InputError(`--${key} is required.`)
  return result
}

export function runCli(argv) {
  const options = parseArgs(argv)
  const input = resolve(options.input)
  const output = resolve(options.output)
  if (input === output || (existsSync(output) && realpathSync(input) === realpathSync(output))) throw new InputError('Input and output must be different files.')
  if (existsSync(output) && !options.force && !options.dryRun) throw new InputError('Output already exists; pass --force to overwrite it explicitly.')
  const sourceBytes = readFileSync(input)
  const sourceHash = sha256(sourceBytes)
  let parsed
  try { parsed = JSON.parse(sourceBytes.toString('utf8')) } catch (error) { throw new InputError(`Input is not valid JSON: ${error.message}`) }
  const tenantId = scalarString(options['tenant-id'], '', 'tenant-id', { trim: true })
  if (!tenantId) throw new InputError('--tenant-id must not be empty.')
  const model = normalizeExport(parsed, { tenantId, sourceHash })
  const sql = generateSql(model)
  if (!options.dryRun) writeFileSync(output, sql, { encoding: 'utf8', flag: options.force ? 'w' : 'wx' })
  const summary = reviewSummary(model, { output, dryRun: options.dryRun })
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  return summary
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCli(process.argv.slice(2)) } catch (error) {
    console.error(`ERROR: ${error.message}`)
    process.exitCode = 1
  }
}
