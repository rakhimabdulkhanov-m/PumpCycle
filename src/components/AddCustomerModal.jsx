import { useState } from 'react'
import { todayISO } from '../lib/dates.js'

const inputCls =
  'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-lg focus:border-blue-600 focus:outline-none'

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

// New customers get a pin near Gastonia; the demo doesn't geocode addresses.
function jitteredLocation() {
  return {
    lat: 35.26 + (Math.random() - 0.5) * 0.12,
    lng: -81.18 + (Math.random() - 0.5) * 0.18,
  }
}

export default function AddCustomerModal({ onAdd, onClose }) {
  const [form, setForm] = useState({
    name: '',
    address: '',
    phone: '',
    tankSizeGal: '1000',
    lastPumped: todayISO(),
    cycleMonths: '36',
    notes: '',
  })

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })

  function submit(e) {
    e.preventDefault()
    onAdd({
      ...form,
      tankSizeGal: Number(form.tankSizeGal),
      cycleMonths: Number(form.cycleMonths) || 36,
      ...jitteredLocation(),
    })
  }

  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        className="flex max-h-full w-full max-w-md flex-col rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-gray-200 p-6 pb-3">
          <h2 className="text-2xl font-bold text-gray-900">Add customer</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-3xl leading-none text-gray-400 hover:text-gray-600"
          >
            &times;
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-6 pt-2">
        <Field label="Name">
          <input className={inputCls} value={form.name} onChange={set('name')} required />
        </Field>
        <Field label="Address">
          <input className={inputCls} value={form.address} onChange={set('address')} />
        </Field>
        <Field label="Phone">
          <input className={inputCls} value={form.phone} onChange={set('phone')} />
        </Field>
        <Field label="Tank size (gal)">
          <select className={inputCls} value={form.tankSizeGal} onChange={set('tankSizeGal')}>
            <option value="1000">1,000</option>
            <option value="1250">1,250</option>
            <option value="1500">1,500</option>
          </select>
        </Field>
        <Field label="Last pumped">
          <input
            type="date"
            className={inputCls}
            value={form.lastPumped}
            onChange={set('lastPumped')}
            required
          />
        </Field>
        <Field label="Cycle (months)">
          <input
            type="number"
            min="1"
            className={inputCls}
            value={form.cycleMonths}
            onChange={set('cycleMonths')}
          />
        </Field>
        <Field label="Notes">
          <textarea rows="2" className={inputCls} value={form.notes} onChange={set('notes')} />
        </Field>

        <div className="mt-4 flex gap-2">
          <button
            type="submit"
            className="flex-1 rounded-lg bg-blue-700 px-4 py-3 text-lg font-semibold text-white hover:bg-blue-800"
          >
            Add customer
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border-2 border-gray-300 px-4 py-3 text-lg font-semibold text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
        </div>
        </div>
      </form>
    </div>
  )
}
