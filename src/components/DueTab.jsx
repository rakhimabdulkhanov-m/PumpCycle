import { useState } from 'react'
import { daysUntilDue, nextDue, dueStatus, formatDate } from '../lib/dates.js'
import { scheduledCount } from '../lib/reminders.js'
import CustomerCard from './CustomerCard.jsx'
import AddCustomerModal from './AddCustomerModal.jsx'

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'overdue', label: 'Overdue' },
  { id: '30', label: '30 days' },
  { id: '60', label: '60 days' },
  { id: '90', label: '90 days' },
]

const CHIP_STYLES = {
  overdue: 'bg-red-100 text-red-800',
  'due-soon': 'bg-amber-100 text-amber-800',
  ok: 'bg-green-100 text-green-800',
}

function matchesFilter(filter, days) {
  if (filter === 'all') return true
  if (filter === 'overdue') return days < 0
  return days >= 0 && days <= Number(filter)
}

function money(n) {
  return '$' + n.toLocaleString('en-US')
}

function Counter({ label, value, className }) {
  return (
    <div className={`rounded-lg px-4 py-3 ${className}`}>
      <div className="text-sm font-medium uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  )
}

function PriceSettings({ avgJobPrice, onChange }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="rounded-lg border-2 border-gray-300 px-3 py-2 text-base font-medium text-gray-700 hover:bg-gray-100"
      >
        Avg job: {money(avgJobPrice)} ✎
      </button>
      {open && (
        <div className="absolute right-0 z-[1100] mt-2 w-64 rounded-lg border border-gray-200 bg-white p-4 shadow-xl">
          <label className="block">
            <span className="text-sm font-medium uppercase tracking-wide text-gray-500">
              Average job price ($)
            </span>
            <input
              type="number"
              min="0"
              value={avgJobPrice}
              onChange={(e) => onChange(Number(e.target.value) || 0)}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-lg focus:border-blue-600 focus:outline-none"
            />
          </label>
          <button
            onClick={() => setOpen(false)}
            className="mt-3 w-full rounded-lg bg-blue-700 px-3 py-2 text-base font-semibold text-white hover:bg-blue-800"
          >
            Done
          </button>
        </div>
      )}
    </div>
  )
}

export default function DueTab({
  customers,
  settings,
  sentReminders,
  onUpdateCustomer,
  onAddCustomer,
  onSetAvgJobPrice,
}) {
  const [filter, setFilter] = useState('all')
  const [selectedId, setSelectedId] = useState(null)
  const [adding, setAdding] = useState(false)

  const selected = customers.find((c) => c.id === selectedId)

  const overdue = customers.filter((c) => daysUntilDue(c) < 0)
  const due30 = customers.filter((c) => {
    const d = daysUntilDue(c)
    return d >= 0 && d <= 30
  })

  const rows = customers
    .filter((c) => matchesFilter(filter, daysUntilDue(c)))
    .sort((a, b) => nextDue(a) - nextDue(b))

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl p-4 sm:p-6">
          <div className="flex flex-wrap items-start gap-3">
            <Counter
              label="Overdue"
              value={`${overdue.length} — ${money(overdue.length * settings.avgJobPrice)}`}
              className="bg-red-100 text-red-900"
            />
            <Counter
              label="Due in 30d"
              value={`${due30.length} — ${money(due30.length * settings.avgJobPrice)}`}
              className="bg-amber-100 text-amber-900"
            />
            <Counter
              label="Reminders scheduled"
              value={scheduledCount(customers, sentReminders)}
              className="bg-blue-100 text-blue-900"
            />
            <div className="ml-auto flex flex-col items-end gap-2">
              <PriceSettings
                avgJobPrice={settings.avgJobPrice}
                onChange={onSetAvgJobPrice}
              />
              <button
                onClick={() => setAdding(true)}
                className="rounded-lg bg-blue-700 px-4 py-2 text-base font-semibold text-white hover:bg-blue-800"
              >
                + Add customer
              </button>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={
                  'rounded-full px-4 py-2 text-base font-semibold ' +
                  (filter === f.id
                    ? 'bg-blue-700 text-white'
                    : 'border-2 border-gray-300 text-gray-700 hover:bg-gray-100')
                }
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="mt-4 divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white">
            {rows.map((c) => {
              const days = daysUntilDue(c)
              const chip =
                days < 0 ? `${-days} days overdue` : `in ${days} days`
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-gray-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-lg font-semibold text-gray-900">
                      {c.name}
                    </div>
                    <div className="truncate text-base text-gray-500">
                      {c.address} • {c.phone}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-base font-medium text-gray-700">
                      {formatDate(nextDue(c))}
                    </div>
                    <span
                      className={`inline-block rounded-full px-3 py-0.5 text-sm font-semibold ${CHIP_STYLES[dueStatus(c)]}`}
                    >
                      {chip}
                    </span>
                  </div>
                </button>
              )
            })}
            {rows.length === 0 && (
              <div className="px-4 py-8 text-center text-lg text-gray-500">
                No customers match this filter.
              </div>
            )}
          </div>
        </div>
      </div>

      {selected && (
        <CustomerCard
          customer={selected}
          onClose={() => setSelectedId(null)}
          onUpdate={(patch) => onUpdateCustomer(selected.id, patch)}
        />
      )}
      {adding && (
        <AddCustomerModal
          onAdd={(fields) => {
            onAddCustomer(fields)
            setAdding(false)
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  )
}
