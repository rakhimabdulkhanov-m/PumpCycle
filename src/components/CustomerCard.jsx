import { useEffect, useRef, useState } from 'react'
import { nextDue, daysUntilDue, dueStatus, formatDate, todayISO, isCommercial } from '../lib/dates.js'

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

export default function CustomerCard({ customer, onClose, onUpdate }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(null)
  const bodyRef = useRef(null)

  useEffect(() => {
    bodyRef.current.scrollTop = 0
  }, [editing])

  const status = dueStatus(customer)
  const commercial = isCommercial(customer)
  const days = daysUntilDue(customer)
  const dueLabel =
    status === 'overdue'
      ? `${formatDate(nextDue(customer))} — ${-days} days overdue`
      : `${formatDate(nextDue(customer))} — in ${days} days`

  function startEdit() {
    setDraft({ ...customer })
    setEditing(true)
  }

  function saveEdit() {
    onUpdate({
      name: draft.name,
      address: draft.address,
      phone: draft.phone,
      tankSizeGal: Number(draft.tankSizeGal),
      lastPumped: draft.lastPumped,
      cycleMonths: Number(draft.cycleMonths),
      notes: draft.notes,
    })
    setEditing(false)
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
          <Row label="Phone">
            {customer.phone ? (
              <a href={`tel:${customer.phone}`} className="text-blue-700 underline">
                {customer.phone}
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

          <div className="mt-4 flex flex-col gap-2">
            <button
              onClick={() => onUpdate({ lastPumped: todayISO() })}
              className="w-full rounded-lg bg-green-700 px-4 py-3 text-lg font-semibold text-white hover:bg-green-800"
            >
              Mark pumped today
            </button>
            <button
              onClick={startEdit}
              className="w-full rounded-lg border-2 border-gray-300 px-4 py-3 text-lg font-semibold text-gray-700 hover:bg-gray-100"
            >
              Edit
            </button>
          </div>
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
              value={draft.lastPumped}
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

          <div className="mt-4 flex gap-2">
            <button
              onClick={saveEdit}
              className="flex-1 rounded-lg bg-blue-700 px-4 py-3 text-lg font-semibold text-white hover:bg-blue-800"
            >
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="flex-1 rounded-lg border-2 border-gray-300 px-4 py-3 text-lg font-semibold text-gray-700 hover:bg-gray-100"
            >
              Cancel
            </button>
          </div>
        </>
      )}
      </div>
    </div>
  )
}
