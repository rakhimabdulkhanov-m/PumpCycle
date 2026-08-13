import { useEffect, useRef, useState } from 'react'
import { nextDue, daysUntilDue, dueStatus, formatDate, isCommercial } from '../lib/dates.js'
import { pinSource } from '../lib/location.js'
import { useDismissLayer } from '../lib/dismissLayer.js'

const STATUS_STYLES = {
  overdue: 'bg-red-100 text-red-800',
  'due-soon': 'bg-amber-100 text-amber-800',
  ok: 'bg-green-100 text-green-800',
}

function Row({ label, children }) {
  return (
    <div className="py-1.5">
      <div className="text-sm font-medium uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div className="text-lg text-gray-900">{children}</div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <label className="block py-1.5">
      <span className="text-sm font-medium uppercase tracking-wide text-gray-500">
        {label}
      </span>
      {children}
    </label>
  )
}

const inputCls =
  'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-lg focus:border-blue-600 focus:outline-none'

/**
 * One line, no banner. The card is what he reads before driving out, so it is
 * the last honest moment to say where this pin came from - a town centroid can
 * be several miles from the yard, and a pin he put on the lid himself is worth
 * knowing about too, because it is the one he can trust. A banner would be
 * shouting; a line under the address is read at the same time as the address.
 *
 * The five unsettled cases are pinConfirmCase's, unchanged in meaning; only the
 * instruction moved, because pins are no longer dragged. "Move pin" below is the
 * one way to fix any of them.
 */
const PIN_NOTE = {
  no_location: 'No pin yet - place it on the lid.',
  address_changed: 'Address was edited - the pin is still at the old one.',
  locality: 'Pin is town-level - nobody has put it on the lid.',
  road: 'Pin is road-level - nobody has put it on the lid.',
  no_precision: 'Nobody has checked this pin.',
  placed: 'Pin placed by you on the lid.',
  lookup: 'Pin from the address lookup.',
}

// The two settled cases are not a warning, so they are not dressed as one.
const SETTLED_NOTE = new Set(['placed', 'lookup'])

export default function CustomerCard({
  customer,
  onClose,
  onUpdate,
  onMarkPumped,
  onMovePin,
  onMapAction,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(null)
  const [savingAction, setSavingAction] = useState(null)
  const [writeError, setWriteError] = useState('')
  const bodyRef = useRef(null)

  useEffect(() => {
    bodyRef.current.scrollTop = 0
  }, [editing])

  // Back on a phone, Escape on a desktop: leave the edit form first, then the
  // card. Neither ever walks out of the app.
  useDismissLayer(true, () => (editing ? setEditing(false) : onClose()))

  const status = dueStatus(customer)
  const source = pinSource(customer)
  const pinNote = PIN_NOTE[source]
  const hasPin = source !== 'no_location'
  const commercial = isCommercial(customer)
  const days = daysUntilDue(customer)
  const dueLabel = !Number.isFinite(days)
    ? 'Pump date unknown'
    : status === 'overdue'
      ? `${formatDate(nextDue(customer))} — ${-days} days overdue`
      : `${formatDate(nextDue(customer))} — in ${days} days`

  function startEdit() {
    setDraft({ ...customer })
    setEditing(true)
  }

  async function saveEdit() {
    if (savingAction) return
    setSavingAction('edit')
    setWriteError('')
    try {
      await onUpdate({
        name: draft.name,
        address: draft.address,
        phone: draft.phone,
        email: draft.email,
        tankSizeGal: Number(draft.tankSizeGal),
        lastPumped: draft.lastPumped || null,
        cycleMonths: Number(draft.cycleMonths) || 36,
        notes: draft.notes,
      })
      setEditing(false)
    } catch {
      setWriteError('Could not save. Try again.')
    } finally {
      setSavingAction(null)
    }
  }

  async function markPumped() {
    if (savingAction) return
    setSavingAction('pumped')
    setWriteError('')
    try {
      await onMarkPumped()
    } catch {
      setWriteError('Could not mark this customer pumped. Try again.')
    } finally {
      setSavingAction(null)
    }
  }

  const set = (key) => (e) => setDraft({ ...draft, [key]: e.target.value })

  return (
    <div className="absolute inset-x-0 bottom-0 z-[1050] flex h-[min(75dvh,calc(100%-6rem))] flex-col rounded-t-xl bg-white shadow-2xl sm:inset-x-auto sm:right-4 sm:top-4 sm:bottom-4 sm:h-auto sm:w-96 sm:rounded-xl">
      <div className="flex items-start justify-between gap-3 border-b border-gray-200 p-5 pb-3">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold text-gray-900">{customer.name}</h2>
          {commercial && (
            <span className="mt-1 inline-block rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
              Commercial · Grease trap
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-3xl leading-none text-gray-400 hover:text-gray-600"
        >
          &times;
        </button>
      </div>

      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto p-5 pt-2">
      {!editing && (
        <>
          <Row label="Address">{customer.address}</Row>
          <p
            className={
              '-mt-1 pb-1 text-base font-semibold ' +
              (SETTLED_NOTE.has(source) ? 'text-gray-500' : 'text-amber-700')
            }
          >
            {pinNote}
          </p>
          <Row label="Phone">
            {customer.phone ? (
              <a href={`tel:${customer.phone}`} className="text-blue-700 underline">
                {customer.phone}
              </a>
            ) : (
              <span className="text-gray-400">—</span>
            )}
          </Row>
          <Row label="Email">
            {customer.email ? (
              <a href={`mailto:${customer.email}`} className="text-blue-700 underline">
                {customer.email}
              </a>
            ) : (
              <span className="text-gray-400">—</span>
            )}
          </Row>
          <Row label="Tank size">{customer.tankSizeGal.toLocaleString()} gal</Row>
          <Row label="Last pumped">{formatDate(customer.lastPumped)}</Row>
          <Row label="Cycle">
            {commercial
              ? `Every ${customer.cycleMonths * 30} days (grease trap / FOG)`
              : `Every ${customer.cycleMonths} months`}
          </Row>
          <Row label="Next due">
            <span
              className={`inline-block rounded-full px-3 py-0.5 font-semibold ${STATUS_STYLES[status]}`}
            >
              {dueLabel}
            </span>
          </Row>
          <Row label="Notes">{customer.notes}</Row>

          {/* Overdue customers have no auto-reminder by design, so give the
              operator a manual nudge path - only for contacts that exist. */}
          {status === 'overdue' && (customer.phone || customer.email) && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-red-50 px-3 py-2">
              <span className="text-base font-semibold text-red-800">
                Overdue — reach out:
              </span>
              {customer.phone && (
                <a
                  href={`tel:${customer.phone}`}
                  className="text-base font-semibold text-blue-700 underline"
                >
                  Call
                </a>
              )}
              {customer.email && (
                <a
                  href={`mailto:${customer.email}`}
                  className="text-base font-semibold text-blue-700 underline"
                >
                  Email
                </a>
              )}
            </div>
          )}

        </>
      )}

      {editing && (
        <>
          <Field label="Name">
            <input className={inputCls} value={draft.name} onChange={set('name')} />
          </Field>
          <Field label="Address">
            <input className={inputCls} value={draft.address} onChange={set('address')} />
          </Field>
          <Field label="Phone">
            <input className={inputCls} value={draft.phone} onChange={set('phone')} />
          </Field>
          <Field label="Email">
            <input
              type="email"
              className={inputCls}
              value={draft.email || ''}
              onChange={set('email')}
            />
          </Field>
          <Field label="Tank size (gal)">
            <select
              className={inputCls}
              value={draft.tankSizeGal}
              onChange={set('tankSizeGal')}
            >
              <option value="1000">1,000</option>
              <option value="1250">1,250</option>
              <option value="1500">1,500</option>
            </select>
          </Field>
          <Field label="Last pumped">
            <input
              type="date"
              className={inputCls}
              value={draft.lastPumped || ''}
              onChange={set('lastPumped')}
            />
          </Field>
          <Field label="Cycle (months)">
            <input
              type="number"
              min="1"
              className={inputCls}
              value={draft.cycleMonths}
              onChange={set('cycleMonths')}
            />
          </Field>
          <Field label="Notes">
            <textarea
              rows="3"
              className={inputCls}
              value={draft.notes}
              onChange={set('notes')}
            />
          </Field>

        </>
      )}
      </div>

      {/* The actions sit outside the scrolling body on purpose. On a 390x780
          phone this sheet is about 500px tall, so a stack at the end of the
          address, phone, tank, cycle and notes was never on screen when the card
          opened: every "mark pumped" and every "show on map" started with a
          scroll past reference data he was not reading. */}
      <div className="border-t border-gray-200 p-4 pt-3">
        {/* Beside the button that failed, not at the end of a scroll. */}
        {writeError && (
          <p role="alert" className="mb-2 text-base font-semibold text-red-700">
            {writeError}
          </p>
        )}
        {!editing ? (
          <div className="flex flex-col gap-2">
            <button
              onClick={markPumped}
              disabled={!!savingAction}
              className="min-h-12 w-full rounded-lg bg-green-700 px-4 py-3 text-lg font-semibold text-white hover:bg-green-800 disabled:opacity-60"
            >
              {savingAction === 'pumped' ? 'Saving...' : 'Mark pumped today'}
            </button>
            <div className="flex gap-2">
              {onMapAction && (
                <button
                  onClick={onMapAction}
                  className="min-h-12 flex-1 rounded-lg bg-blue-700 px-3 py-3 text-lg font-semibold text-white hover:bg-blue-800"
                >
                  {hasPin ? 'Show on map' : 'Place pin on map'}
                </button>
              )}
              {/* The one entrance to placing or moving a pin: named, and pressed
                  on purpose. Nothing on the map itself can start it, which is why
                  a pan can no longer move a customer's lid. Absent on the Due
                  tab, where this card opens with no map behind it to aim on. */}
              {onMovePin && (
                <button
                  onClick={onMovePin}
                  className="min-h-12 flex-1 rounded-lg bg-blue-700 px-3 py-3 text-lg font-semibold text-white hover:bg-blue-800"
                >
                  {hasPin ? 'Move pin' : 'Place pin'}
                </button>
              )}
              <button
                onClick={startEdit}
                className="min-h-12 flex-1 rounded-lg border-2 border-gray-300 px-3 py-3 text-lg font-semibold text-gray-700 hover:bg-gray-100"
              >
                Edit
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={saveEdit}
              disabled={!!savingAction}
              className="min-h-12 flex-1 rounded-lg bg-blue-700 px-4 py-3 text-lg font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
            >
              {savingAction === 'edit' ? 'Saving...' : 'Save'}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="min-h-12 flex-1 rounded-lg border-2 border-gray-300 px-4 py-3 text-lg font-semibold text-gray-700 hover:bg-gray-100"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
