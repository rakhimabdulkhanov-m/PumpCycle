import { json } from '../lib/json.js'
import {
  projectCustomer,
  projectPhoto,
  projectReminder,
  projectSettings,
  projectVisit,
  reminderCompatibility,
} from '../lib/projection.js'

function parseSince(request) {
  const raw = new URL(request.url).searchParams.get('since')
  if (raw === null || raw === '') return 0
  if (!/^\d+$/.test(raw)) return null
  const since = Number(raw)
  return Number.isSafeInteger(since) ? since : null
}

async function rows(db, sql, ...bindings) {
  return (await db.prepare(sql).bind(...bindings).all()).results
}

/** Read a bounded delta directly from D1. Exported for adapter and D1 tests. */
export async function syncSince(db, since = 0) {
  // seq_counter is an allocator, not a commit marker. A failed caller batch leaves
  // a gap there, so advancing to it would make a later committed row invisible.
  const high = await db.prepare(
    `SELECT MAX(seq) AS high_water FROM (
       SELECT seq FROM customers
       UNION ALL SELECT seq FROM visits
       UNION ALL SELECT seq FROM photos
       UNION ALL SELECT seq FROM reminder_log
     )`
  ).first()
  const cursor = high?.high_water ?? 0

  const [customerRows, visitRows, photoRows, reminderRows, settingRows, currentReminderRows] =
    await Promise.all([
      rows(db, 'SELECT * FROM customers WHERE seq > ? AND seq <= ? ORDER BY seq, id', since, cursor),
      rows(db, 'SELECT * FROM visits WHERE seq > ? AND seq <= ? ORDER BY seq, id', since, cursor),
      rows(db, 'SELECT * FROM photos WHERE seq > ? AND seq <= ? ORDER BY seq, id', since, cursor),
      rows(db, 'SELECT * FROM reminder_log WHERE seq > ? AND seq <= ? ORDER BY seq, id', since, cursor),
      rows(db, 'SELECT key, value, updated_at FROM settings ORDER BY key'),
      rows(
        db,
        `SELECT r.customer_id, r.reminder_key, r.sent_at
           FROM reminder_log r
           JOIN customers c ON c.id = r.customer_id AND c.cycle_seq = r.cycle_seq
          WHERE c.archived_at IS NULL AND r.status = 'sent'
          ORDER BY r.customer_id, r.reminder_key`
      ),
    ])

  return {
    ok: true,
    cursor,
    customers: customerRows.map(projectCustomer),
    visits: visitRows.map(projectVisit),
    photos: photoRows.map(projectPhoto),
    reminderLog: reminderRows.map(projectReminder),
    settings: projectSettings(settingRows),
    ...reminderCompatibility(currentReminderRows),
  }
}

export async function get(request, env, ctx, tenant) {
  const since = parseSince(request)
  if (since === null) return json({ ok: false, error: 'since must be a nonnegative safe integer' }, 400)
  return json(await syncSince(tenant.db, since))
}
