import { json } from '../lib/json.js'
import { isSanePoint } from '../lib/geocode/geo.js'
import { projectCustomer, projectReminder } from '../lib/projection.js'
import { STALE_CLAIM_MS } from '../lib/reminder_send.js'
import { isDifferentAddress } from '../../src/lib/location.js'
import { isDifferentEmail } from '../../src/lib/email.js'
import { hasLocation } from '../../src/lib/point.js'
import { occasionStamp } from '../../src/lib/reminders.js'

const MAX_BODY_BYTES = 32 * 1024
const TYPES = new Set([
  'customer.add',
  'customer.update',
  'pin.set',
  'pin.restore',
  'visit.record',
  'last_pumped.correct',
  'setting.set_avg_job_price',
  'reminder.mark_manual_sent',
])
const PRECISIONS = new Set(['', 'house', 'house_approx', 'road', 'locality', 'manual'])
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

class MutationError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

const ownObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function exactKeys(object, allowed, label, required = []) {
  if (!ownObject(object)) throw new MutationError(`${label} must be an object`)
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new MutationError(`${label}.${key} is not allowed`)
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) throw new MutationError(`${label}.${key} is required`)
  }
}

function id(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new MutationError(`${label} is invalid`)
  return value
}

function string(value, label, { required = false, max = 2000 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new MutationError(`${label} is required`)
    return ''
  }
  if (typeof value !== 'string' || value.length > max || (required && value.trim() === '')) {
    throw new MutationError(`${label} is invalid`)
  }
  return value
}

function integer(value, label, { min = 0, optional = false } = {}) {
  if (optional && value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < min) throw new MutationError(`${label} is invalid`)
  return value
}

function moment(value, label, nullable = false) {
  if (nullable && value === null) return null
  return integer(value, label)
}

function date(value, label, nullable = false) {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new MutationError(`${label} must be YYYY-MM-DD`)
  }
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new MutationError(`${label} is not a real calendar date`)
  }
  return value
}

function coordinates(lat, lng, { nullable = false } = {}) {
  if (nullable && lat === null && lng === null) return { lat: null, lng: null }
  if (lat === null || lng === null || lat === undefined || lng === undefined) {
    throw new MutationError('lat and lng must be provided together')
  }
  if (typeof lat !== 'number' || typeof lng !== 'number' || !isSanePoint(lat, lng)) {
    throw new MutationError('lat and lng must be a valid US point')
  }
  return { lat, lng }
}

function precision(value, label = 'payload.locationPrecision') {
  if (typeof value !== 'string' || !PRECISIONS.has(value)) throw new MutationError(`${label} is invalid`)
  return value
}

function validateEnvelope(input) {
  exactKeys(input, ['mutationId', 'type', 'createdAt', 'payload'], 'mutation', [
    'mutationId',
    'type',
    'createdAt',
    'payload',
  ])
  id(input.mutationId, 'mutation.mutationId')
  if (typeof input.type !== 'string' || !TYPES.has(input.type)) {
    throw new MutationError('mutation.type is not supported')
  }
  moment(input.createdAt, 'mutation.createdAt')
  if (!ownObject(input.payload)) throw new MutationError('mutation.payload must be an object')
  return input
}

async function customer(db, customerId) {
  const row = await db.prepare('SELECT * FROM customers WHERE id = ?').bind(customerId).first()
  if (!row || row.archived_at !== null) throw new MutationError('customer not found', 404)
  return row
}

async function replay(db, mutationId) {
  const row = await db
    .prepare('SELECT result_json FROM applied_mutations WHERE mutation_id = ?')
    .bind(mutationId)
    .first()
  if (!row) return null
  try {
    return JSON.parse(row.result_json)
  } catch {
    throw new Error('stored mutation result is invalid')
  }
}

const snapshotCustomer = projectCustomer

function reserveSeqs(db, count) {
  return db.prepare('UPDATE seq_counter SET value = value + ? WHERE id = 1').bind(count)
}

function seqValue(count, index) {
  const offset = count - index - 1
  return `(SELECT value${offset ? ` - ${offset}` : ''} FROM seq_counter WHERE id = 1)`
}

function audit(db, now, actorUserId, entity, entityId, action, before, after) {
  return db
    .prepare(
      `INSERT INTO audit_log (at, actor, entity, entity_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(now, actorUserId, entity, entityId, action, JSON.stringify(before), JSON.stringify(after))
}

function applied(db, envelope, now, actorUserId, result) {
  return db
    .prepare(
      `INSERT INTO applied_mutations (mutation_id, user_id, applied_at, result_json)
       VALUES (?, ?, ?, ?)`
    )
    .bind(envelope.mutationId, actorUserId, now, JSON.stringify(result))
}

function ack(envelope) {
  return { mutationId: envelope.mutationId, type: envelope.type }
}

async function addCustomer(db, envelope, now, actorUserId) {
  const p = envelope.payload
  exactKeys(
    p,
    [
      'id', 'name', 'address', 'phone', 'email', 'tankSizeGal', 'lastPumped',
      'cycleMonths', 'notes', 'lat', 'lng', 'locationPrecision', 'locationConfirmedAt',
    ],
    'payload',
    ['id', 'name', 'address', 'phone', 'email', 'tankSizeGal', 'lastPumped', 'cycleMonths', 'notes', 'lat', 'lng', 'locationPrecision', 'locationConfirmedAt']
  )
  const customerId = id(p.id, 'payload.id')
  const name = string(p.name, 'payload.name', { required: true, max: 300 })
  const address = string(p.address, 'payload.address', { max: 500 })
  const phone = string(p.phone, 'payload.phone', { max: 100 })
  const email = string(p.email, 'payload.email', { max: 320 })
  const tankSizeGal = integer(p.tankSizeGal, 'payload.tankSizeGal')
  const lastPumped = date(p.lastPumped, 'payload.lastPumped', true)
  const cycleMonths = integer(p.cycleMonths, 'payload.cycleMonths', { min: 1 })
  const notes = string(p.notes, 'payload.notes')
  const point = coordinates(p.lat, p.lng, { nullable: true })
  const locationPrecision = precision(p.locationPrecision)
  const locationConfirmedAt = moment(p.locationConfirmedAt, 'payload.locationConfirmedAt', true)
  if (point.lat === null && (locationPrecision !== '' || locationConfirmedAt !== null)) {
    throw new MutationError('an unlocated customer cannot have pin metadata')
  }

  const seqCount = lastPumped ? 2 : 1
  const after = {
    id: customerId, name, address, phone, email, lat: point.lat, lng: point.lng,
    locationPrecision, locationConfirmedAt, tankSizeGal, lastPumped, cycleMonths,
    cycleSeq: 0, notes,
  }
  const statements = [
    db.prepare(
      `INSERT INTO customers
       (id, name, address, phone, email, lat, lng, location_precision,
        location_confirmed_at, tank_size_gal, last_pumped, cycle_months, cycle_seq,
        notes, edited_in_app, created_at, updated_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ${seqValue(seqCount, 0)})`
    ).bind(
      customerId, name, address, phone, email, point.lat, point.lng, locationPrecision,
      locationConfirmedAt, tankSizeGal, lastPumped, cycleMonths, notes, now, now
    ),
  ]
  if (lastPumped) {
    statements.push(
      db.prepare(
        `INSERT INTO visits
         (id, customer_id, visited_on, sets_last_pumped, created_at, seq)
         VALUES (?, ?, ?, 1, ?, ${seqValue(seqCount, 1)})`
      ).bind(`${envelope.mutationId}:baseline`, customerId, lastPumped, now)
    )
  }
  const result = ack(envelope)
  statements.push(audit(db, now, actorUserId, 'customer', customerId, envelope.type, null, after))
  statements.push(applied(db, envelope, now, actorUserId, result))
  await db.batch([reserveSeqs(db, seqCount), ...statements])
  return result
}

async function updateCustomer(db, envelope, now, actorUserId) {
  const p = envelope.payload
  exactKeys(p, ['customerId', 'changes'], 'payload', ['customerId', 'changes'])
  const customerId = id(p.customerId, 'payload.customerId')
  const previous = await customer(db, customerId)
  const allowed = ['name', 'address', 'phone', 'email', 'tankSizeGal', 'cycleMonths', 'notes', 'archivedAt']
  exactKeys(p.changes, allowed, 'payload.changes')
  if (Object.keys(p.changes).length === 0) throw new MutationError('payload.changes must not be empty')

  const columns = {
    name: ['name', (v) => string(v, 'payload.changes.name', { required: true, max: 300 })],
    address: ['address', (v) => string(v, 'payload.changes.address', { max: 500 })],
    phone: ['phone', (v) => string(v, 'payload.changes.phone', { max: 100 })],
    email: ['email', (v) => string(v, 'payload.changes.email', { max: 320 })],
    tankSizeGal: ['tank_size_gal', (v) => integer(v, 'payload.changes.tankSizeGal')],
    cycleMonths: ['cycle_months', (v) => integer(v, 'payload.changes.cycleMonths', { min: 1 })],
    notes: ['notes', (v) => string(v, 'payload.changes.notes')],
    archivedAt: ['archived_at', (v) => (v === null ? null : integer(v, 'payload.changes.archivedAt', { min: 0 }))],
  }
  const assignments = []
  const bindings = []
  const after = snapshotCustomer(previous)
  for (const [key, raw] of Object.entries(p.changes)) {
    const [column, validate] = columns[key]
    const next = validate(raw)
    assignments.push(`${column} = ?`)
    bindings.push(next)
    after[key] = next
  }
  const cycleChanged = Object.hasOwn(p.changes, 'cycleMonths') && after.cycleMonths !== previous.cycle_months
  if (cycleChanged) {
    assignments.push('cycle_seq = cycle_seq + 1')
    after.cycleSeq = previous.cycle_seq + 1
  }
  // Correcting a dead address re-arms the automatic sender.
  //
  // reminder_send.js skips any customer whose email_status is not 'ok', and
  // nothing else in the system ever sets it back, so without this a single hard
  // bounce silences a customer for the life of the account and the Reminders
  // tab's Fix button leads nowhere. A BOUNCE is evidence against an ADDRESS, not
  // against a customer: a different address is a different recipient, including
  // an emptied one (there is nothing left to be bad, and the tab surfaces "no
  // email address on file" separately). Being wrong here costs exactly one
  // bounce - the webhook re-suppresses a genuinely dead new address on the next
  // send.
  //
  // A COMPLAINT IS NOT A BOUNCE AND IS NOT LIFTED HERE, by any edit, ever.
  // webhooks.js: "A complaint is a spam report. Permanent, no escalation ladder,
  // no second chance - continuing to mail someone who reported you is how a
  // sending domain dies." It is also doubly wrong to re-open the rung: a
  // complaint means the mail was DELIVERED and then reported, so there is no
  // undelivered reminder to resume. The Reminders tab tells him the action that
  // does work (ADDRESS_PROBLEMS.complained: call them), because nothing in the
  // app clears this one.
  const emailCorrected =
    Object.hasOwn(p.changes, 'email') &&
    isDifferentEmail(after.email, previous.email) &&
    previous.email_status !== 'complained'
  if (emailCorrected) {
    assignments.push("email_status = 'ok'", 'soft_bounce_count = 0')
    after.emailStatus = 'ok'
    after.softBounceCount = 0
  }
  // ...and it re-opens the undelivered rungs of the cycle he is standing in.
  //
  // Clearing email_status alone changes nothing, for two independent reasons:
  // the bounced row still holds (customer, rung, cycle, channel) in the
  // uniqueness index, so claimReminder's ON CONFLICT DO NOTHING can never win a
  // fresh claim for this cycle; and runTenantReminders' repeat guard filters
  // out any rung already sent for this pumping, bounced ones included. Without
  // this the operator corrects the address, watches the red warning disappear,
  // and the customer still receives nothing - worse than the original bug,
  // because now he believes he fixed it.
  //
  // Only genuine non-deliveries are re-opened. A 'sent' rung reached the
  // customer and re-sending it would mail a second copy of something they
  // already have; a 'complained' rung reached them and was reported as spam,
  // which is permanent; a 'sending' row is mid-flight and belongs to the reaper;
  // an SMS rung was never blocked by an email address; a previous cycle's moment
  // passed with the cycle. And when the cycle itself just rolled over, the
  // bumped cycle_seq has already freed the index, so there is nothing to do.
  //
  // AT MOST ONE ROW, the most recently failed. A customer whose pre, od1 and od2
  // all bounced in one cycle is the designed path, not a corruption - webhooks.js
  // only flips email_status on the THIRD soft bounce - and re-opening all three
  // mailed a homeowner three times in one morning, on top of whatever rung the
  // ladder earned today. dueReminders sends only the newest earned rung for
  // exactly this reason; this path used to walk around that rule. One
  // correction, at most one email.
  const reopen = emailCorrected && after.email.trim() !== '' && !cycleChanged
    ? ((await db
        .prepare(
          `SELECT * FROM reminder_log
            WHERE customer_id = ? AND cycle_seq = ? AND channel = 'email'
              AND status IN ('bounced', 'failed')
            ORDER BY seq DESC LIMIT 1`
        )
        .bind(customerId, previous.cycle_seq)
        .all()).results || [])
    : []
  if (
    Object.hasOwn(p.changes, 'address') &&
    hasLocation(snapshotCustomer(previous)) &&
    isDifferentAddress(after.address, previous.address)
  ) {
    assignments.push('address_changed_at = ?')
    bindings.push(now)
    after.addressChangedAt = now
  }
  const seqCount = 1 + reopen.length
  assignments.push('edited_in_app = 1', 'updated_at = ?', `seq = ${seqValue(seqCount, 0)}`)
  bindings.push(now, customerId)
  const result = ack(envelope)
  // Replaced rather than updated in place, because the row id IS the Resend
  // Idempotency-Key. Resend honours a key for 24 hours and answers a reuse
  // carrying a different payload with 409 invalid_idempotent_request - and the
  // payload is exactly what changed here, that being the whole point. Reusing
  // the id would turn a same-day correction into a hard failure. The delete has
  // to precede the insert: the uniqueness index is the thing being freed.
  //
  // claimed_at is stamped one second past the reaper's staleness cutoff, not 0.
  // Both read as "reap me now", and the reaper is the only thing that reads this
  // moment now that the repeat guard is anchored to the occasion rather than to
  // the clock - but a row claiming to have been claimed at the epoch is a lie
  // that every future reader of this table would have to work around.
  // STALE_CLAIM_MS is imported rather than restated so the two cannot drift
  // apart.
  //
  // What keeps this row from becoming a second email is for_last_pumped below:
  // it names the same occasion as the row it replaces, so a same-afternoon
  // cycle_seq bump cannot win a fresh claim beside it. That pair - the re-opened
  // row retrying at the old cycle_seq while a fresh claim won at the new one -
  // is how a corrected address once produced two identical emails.
  //
  // reported_at starts NULL. Carrying it over meant that if this second attempt
  // also failed, the new row was 'failed' with reported_at already set, and
  // owner_digest.js selects on reported_at IS NULL alone - so that failure
  // reached nobody, and 'failed' does not touch email_status either, so the
  // weekly's standing bad-address list missed it too. The row starts 'sending',
  // not failed, so the problem mail cannot select it until it actually fails,
  // and the deleted row's failure was already reported. The rule is "every
  // failure is reported at least once and never lost", not "exactly once":
  // given a choice between losing a failure and repeating one, repeat.
  const claimedAt = now - STALE_CLAIM_MS - 1000
  const requeues = reopen.flatMap((row, index) => {
    const replacementId = `${envelope.mutationId}:requeue:${index}`
    const before = { ...projectReminder(row), reportedAt: row.reported_at ?? null }
    const occasion = occasionStamp(row.for_last_pumped, row.for_visit_id)
    // The DELETE takes the bounce out of reminder_log, and reminder_log has no
    // archived_at - so mergeRows in src/lib/wire.js, which only drops rows
    // carrying archivedAt, leaves a browser that already synced the bounce
    // holding it while a fresh device never sees it. Server-side it would be
    // recoverable from nowhere at all. The audit row is where it survives.
    return [
      db.prepare('DELETE FROM reminder_log WHERE id = ?').bind(row.id),
      db.prepare(
        `INSERT INTO reminder_log
           (id, customer_id, reminder_key, cycle_seq, channel, provider, provider_message_id,
            to_email, status, attempts, claimed_at, sent_at, error, reported_at,
            for_last_pumped, for_visit_id, seq)
         VALUES (?, ?, ?, ?, 'email', 'resend', '', ?, 'sending', 0, ?, NULL, '', NULL, ?, ?,
                 ${seqValue(seqCount, index + 1)})`
      ).bind(
        replacementId,
        customerId,
        row.reminder_key,
        previous.cycle_seq,
        after.email,
        claimedAt,
        // The SAME occasion as the row being replaced - this is one attempt at
        // one reminder about one pumping, and only the address changed. Copied
        // rather than re-read from the customer so a replacement can never
        // silently re-label itself as being about something newer.
        occasion.forLastPumped,
        occasion.forVisitId
      ),
      audit(db, now, actorUserId, 'reminder', row.id, 'reminder.requeued', before, {
        ...before,
        id: replacementId,
        toEmail: after.email,
        status: 'sending',
        attempts: 0,
        claimedAt,
        sentAt: null,
        error: '',
        reportedAt: null,
        providerMessageId: '',
      }),
    ]
  })
  await db.batch([
    reserveSeqs(db, seqCount),
    db.prepare(`UPDATE customers SET ${assignments.join(', ')} WHERE id = ?`).bind(...bindings),
    ...requeues,
    audit(db, now, actorUserId, 'customer', customerId, envelope.type, snapshotCustomer(previous), after),
    applied(db, envelope, now, actorUserId, result),
  ])
  return result
}

async function changePin(db, envelope, now, restore, actorUserId) {
  const p = envelope.payload
  const keys = restore
    ? ['customerId', 'lat', 'lng', 'locationPrecision', 'locationConfirmedAt']
    : ['customerId', 'lat', 'lng']
  exactKeys(p, keys, 'payload', keys)
  const customerId = id(p.customerId, 'payload.customerId')
  const previous = await customer(db, customerId)
  const point = coordinates(p.lat, p.lng, { nullable: restore })
  const locationPrecision = restore ? precision(p.locationPrecision) : 'manual'
  const locationConfirmedAt = restore
    ? moment(p.locationConfirmedAt, 'payload.locationConfirmedAt', true)
    : now
  if (point.lat === null && (locationPrecision !== '' || locationConfirmedAt !== null)) {
    throw new MutationError('an empty pin cannot have pin metadata')
  }
  const before = snapshotCustomer(previous)
  const after = { ...before, ...point, locationPrecision, locationConfirmedAt }
  const result = ack(envelope)
  await db.batch([
    reserveSeqs(db, 1),
    db.prepare(
      `UPDATE customers SET lat = ?, lng = ?, location_precision = ?,
       location_confirmed_at = ?, edited_in_app = 1, updated_at = ?, seq = ${seqValue(1, 0)} WHERE id = ?`
    ).bind(point.lat, point.lng, locationPrecision, locationConfirmedAt, now, customerId),
    audit(db, now, actorUserId, 'customer', customerId, envelope.type, before, after),
    applied(db, envelope, now, actorUserId, result),
  ])
  return result
}

async function recordVisit(db, envelope, now, actorUserId) {
  const p = envelope.payload
  const keys = ['id', 'customerId', 'visitedOn', 'gallons', 'priceCents', 'tech', 'notes']
  exactKeys(p, keys, 'payload', ['id', 'customerId', 'visitedOn'])
  const visitId = id(p.id, 'payload.id')
  const customerId = id(p.customerId, 'payload.customerId')
  const previous = await customer(db, customerId)
  const visitedOn = date(p.visitedOn, 'payload.visitedOn')
  const gallons = integer(p.gallons, 'payload.gallons', { optional: true })
  const priceCents = integer(p.priceCents, 'payload.priceCents', { optional: true })
  const tech = string(p.tech, 'payload.tech', { max: 300 })
  const notes = string(p.notes, 'payload.notes')
  const maxRow = await db
    .prepare(
      `SELECT MAX(visited_on) AS last_pumped FROM visits
       WHERE customer_id = ? AND sets_last_pumped = 1 AND archived_at IS NULL`
    )
    .bind(customerId)
    .first()
  const effective = [previous.last_pumped, maxRow?.last_pumped, visitedOn].filter(Boolean).sort().at(-1)
  const changed = effective !== previous.last_pumped
  // Reserve the customer slot even when this visit is older. The conditional
  // UPDATE below makes the final date monotonic across concurrent devices;
  // an unused reserved value is a harmless permanent gap.
  const seqCount = 2
  const statements = [
    db.prepare(
      `INSERT INTO visits
       (id, customer_id, visited_on, sets_last_pumped, gallons, price_cents, tech, notes,
        created_at, seq) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ${seqValue(seqCount, 0)})`
    ).bind(visitId, customerId, visitedOn, gallons, priceCents, tech, notes, now),
  ]
  const before = snapshotCustomer(previous)
  const after = changed
    ? { ...before, lastPumped: effective, cycleSeq: previous.cycle_seq + 1 }
    : before
  statements.push(
    db.prepare(
      `UPDATE customers SET last_pumped = ?, cycle_seq = cycle_seq + 1,
       edited_in_app = 1, updated_at = ?, seq = ${seqValue(seqCount, 1)}
       WHERE id = ? AND (last_pumped IS NULL OR last_pumped < ?)`
    ).bind(visitedOn, now, customerId, visitedOn)
  )
  const visit = { id: visitId, customerId, visitedOn, setsLastPumped: true, gallons, priceCents, tech, notes }
  const result = ack(envelope)
  statements.push(audit(db, now, actorUserId, 'visit', visitId, envelope.type, null, { visit, customer: after }))
  statements.push(applied(db, envelope, now, actorUserId, result))
  await db.batch([reserveSeqs(db, seqCount), ...statements])
  return result
}

async function correctLastPumped(db, envelope, now, actorUserId) {
  const p = envelope.payload
  exactKeys(p, ['id', 'customerId', 'lastPumped'], 'payload', ['id', 'customerId', 'lastPumped'])
  const visitId = id(p.id, 'payload.id')
  const customerId = id(p.customerId, 'payload.customerId')
  const previous = await customer(db, customerId)
  const lastPumped = date(p.lastPumped, 'payload.lastPumped', true)
  const priorDrivers = (
    await db.prepare(
      `SELECT id, visited_on AS visitedOn FROM visits
       WHERE customer_id = ? AND sets_last_pumped = 1 AND archived_at IS NULL ORDER BY id`
    ).bind(customerId).all()
  ).results
  const seqCount = lastPumped ? 3 : 2
  const after = {
    ...snapshotCustomer(previous),
    lastPumped,
    cycleSeq: previous.cycle_seq + 1,
  }
  const result = ack(envelope)
  const statements = [
    reserveSeqs(db, seqCount),
    db.prepare(
      `UPDATE visits SET sets_last_pumped = 0, seq = ${seqValue(seqCount, 0)}
       WHERE customer_id = ? AND sets_last_pumped = 1 AND archived_at IS NULL`
    ).bind(customerId),
  ]
  if (lastPumped) {
    statements.push(db.prepare(
      `INSERT INTO visits (id, customer_id, visited_on, sets_last_pumped, created_at, seq)
       VALUES (?, ?, ?, 1, ?, ${seqValue(seqCount, 1)})`
    ).bind(visitId, customerId, lastPumped, now))
  }
  statements.push(
    db.prepare(
      `UPDATE customers SET last_pumped = ?, cycle_seq = cycle_seq + 1,
       edited_in_app = 1, updated_at = ?, seq = ${seqValue(seqCount, seqCount - 1)} WHERE id = ?`
    ).bind(lastPumped, now, customerId),
    audit(db, now, actorUserId, 'customer', customerId, envelope.type,
      { customer: snapshotCustomer(previous), drivingVisits: priorDrivers },
      { customer: after, drivingVisit: lastPumped ? visitId : null }),
    applied(db, envelope, now, actorUserId, result),
  )
  await db.batch(statements)
  return result
}

async function setAvgJobPrice(db, envelope, now, actorUserId) {
  const p = envelope.payload
  exactKeys(p, ['avgJobPriceCents'], 'payload', ['avgJobPriceCents'])
  const cents = integer(p.avgJobPriceCents, 'payload.avgJobPriceCents', { min: 1 })
  const previous = await db.prepare("SELECT value FROM settings WHERE key = 'avg_job_price_cents'").first()
  const result = ack(envelope)
  await db.batch([
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('avg_job_price_cents', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(String(cents), now),
    audit(db, now, actorUserId, 'setting', 'avg_job_price_cents', envelope.type,
      { avgJobPriceCents: Number(previous?.value ?? 0) }, { avgJobPriceCents: cents }),
    applied(db, envelope, now, actorUserId, result),
  ])
  return result
}

async function markManualSent(db, envelope, now, actorUserId) {
  const p = envelope.payload
  exactKeys(p, ['customerId', 'reminderKey', 'channel'], 'payload', ['customerId', 'reminderKey', 'channel'])
  const customerId = id(p.customerId, 'payload.customerId')
  const current = await customer(db, customerId)
  // Canonical rung keys from src/lib/reminders.js, not day offsets. The
  // automatic sender writes the same keys, so a manual "mark sent" and a cron
  // send now meet on the uniqueness index instead of silently recording the same
  // reminder twice - and the Reminders tab, which reads these back through
  // reminderCompatibility, sees a cron send as sent.
  if (!['pre', 'sms'].includes(p.reminderKey)) throw new MutationError('payload.reminderKey is invalid')
  if (!['email', 'sms'].includes(p.channel)) throw new MutationError('payload.channel is invalid')
  if ((p.reminderKey === 'sms') !== (p.channel === 'sms')) {
    throw new MutationError('payload reminder key and channel do not match')
  }
  const latestVisit = await db
    .prepare(
      `SELECT id FROM visits
       WHERE customer_id = ? AND sets_last_pumped = 1 AND archived_at IS NULL
       ORDER BY visited_on DESC, created_at DESC LIMIT 1`
    )
    .bind(customerId)
    .first()
  const occasion = occasionStamp(current.last_pumped, latestVisit?.id)
  const reminderId = `${envelope.mutationId}:reminder`
  const reminder = {
    id: reminderId, customerId, reminderKey: p.reminderKey, cycleSeq: current.cycle_seq,
    channel: p.channel, provider: 'manual', status: 'sent', sentAt: now,
  }
  const result = ack(envelope)
  try {
    await db.batch([
      reserveSeqs(db, 1),
      db.prepare(
        `INSERT INTO reminder_log
         (id, customer_id, reminder_key, cycle_seq, channel, provider, to_email,
          status, attempts, claimed_at, sent_at, for_last_pumped, for_visit_id, seq)
         VALUES (?, ?, ?, ?, ?, 'manual', ?, 'sent', 1, ?, ?, ?, ?, ${seqValue(1, 0)})`
      ).bind(
        reminderId, customerId, p.reminderKey, current.cycle_seq, p.channel,
        p.channel === 'email' ? current.email : '', now, now,
        // The occasion this rung was marked sent for, through the one function
        // every writer of this table uses. Without it the cron cannot tell the
        // operator's own send apart from a duplicate it owes the customer.
        occasion.forLastPumped,
        occasion.forVisitId
      ),
      audit(db, now, actorUserId, 'reminder', reminderId, envelope.type, null, reminder),
      applied(db, envelope, now, actorUserId, result),
    ])
  } catch (error) {
    const stored = await replay(db, envelope.mutationId)
    if (stored) return stored
    const existing = await db.prepare(
      `SELECT id FROM reminder_log
       WHERE customer_id = ? AND reminder_key = ? AND cycle_seq = ? AND channel = ?`
    ).bind(customerId, p.reminderKey, current.cycle_seq, p.channel).first()
    if (existing) throw new MutationError('reminder already marked sent', 409)
    throw error
  }
  return result
}

const APPLY = {
  'customer.add': addCustomer,
  'customer.update': updateCustomer,
  'pin.set': (db, envelope, now, actorUserId) => changePin(db, envelope, now, false, actorUserId),
  'pin.restore': (db, envelope, now, actorUserId) => changePin(db, envelope, now, true, actorUserId),
  'visit.record': recordVisit,
  'last_pumped.correct': correctLastPumped,
  'setting.set_avg_job_price': setAvgJobPrice,
  'reminder.mark_manual_sent': markManualSent,
}

/** Apply one validated mutation. The effect, audit, and replay record share one batch. */
export async function applyMutation(db, input, now = Date.now(), actorUserId = '') {
  const envelope = validateEnvelope(input)
  const stored = await replay(db, envelope.mutationId)
  if (stored) return { ok: true, status: 'replayed', result: stored }
  try {
    const result = await APPLY[envelope.type](db, envelope, now, actorUserId)
    return { ok: true, status: 'applied', result }
  } catch (error) {
    if (error instanceof MutationError) throw error
    // The concurrent duplicate path: both requests may pass the first read, one
    // batch wins, and the other's applied_mutations insert loses its constraint.
    const won = await replay(db, envelope.mutationId)
    if (won) return { ok: true, status: 'replayed', result: won }
    const entityId = envelope.payload?.id
    const table = envelope.type === 'customer.add' ? 'customers'
      : ['visit.record', 'last_pumped.correct'].includes(envelope.type) ? 'visits'
        : null
    if (table && entityId) {
      const existing = await db.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(entityId).first()
      if (existing) throw new MutationError(`${table === 'customers' ? 'customer' : 'visit'} id already exists`, 409)
    }
    throw error
  }
}

async function readBody(request) {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new MutationError('request body is too large')
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new MutationError('request body is too large')
  }
  if (!text) throw new MutationError('request body is required')
  try {
    return JSON.parse(text)
  } catch {
    throw new MutationError('request body must be valid JSON')
  }
}

export async function post(request, env, ctx, tenant, auth) {
  try {
    return json(await applyMutation(tenant.db, await readBody(request), Date.now(), auth.user.id))
  } catch (error) {
    if (error instanceof MutationError) return json({ ok: false, error: error.message }, error.status)
    throw error
  }
}
