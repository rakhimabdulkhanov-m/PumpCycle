import { useEffect, useState } from 'react'
import { nextDue, formatDate } from '../lib/dates.js'
import { allReminders } from '../lib/reminders.js'

const COMPANY_PHONE = '(704) 922-0440'

const FILTERS = ['Scheduled', 'Sent', 'All']

const CHANNEL_STYLES = {
  Email: 'bg-purple-100 text-purple-800',
  SMS: 'bg-sky-100 text-sky-800',
}

const STATUS_STYLES = {
  Scheduled: 'bg-blue-100 text-blue-800',
  Sent: 'bg-gray-200 text-gray-600',
}

function firstName(name) {
  return name.split(' ')[0]
}

function messageText(reminder, customer) {
  const due = formatDate(nextDue(customer))
  if (reminder.channel === 'SMS') {
    return (
      `Hawkins Septic: Hi ${firstName(customer.name)}, your septic tank is due ` +
      `for pumping around ${due}. Call or text ${COMPANY_PHONE} to get on the ` +
      `schedule. Reply STOP to opt out.`
    )
  }
  return (
    `Subject: Your septic pumping is coming due — Hawkins Septic Co\n\n` +
    `Hi ${firstName(customer.name)},\n\n` +
    `Our records show the septic tank at ${customer.address} is due for ` +
    `pumping around ${due}. Regular pumping keeps your system healthy and ` +
    `avoids expensive backups.\n\n` +
    `Reply to this email or call us at ${COMPANY_PHONE} and we'll find a ` +
    `time that works.\n\n` +
    `— Mike Hawkins, Hawkins Septic Co`
  )
}

function Toast({ message }) {
  return (
    <div className="fixed bottom-6 left-1/2 z-[1300] -translate-x-1/2 rounded-lg bg-gray-900 px-5 py-3 text-lg font-medium text-white shadow-xl">
      {message}
    </div>
  )
}

function PreviewPanel({ reminder, customer, onSendNow, onClose }) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-[1050] max-h-[75%] overflow-y-auto rounded-t-xl bg-white p-5 shadow-2xl sm:inset-x-auto sm:right-4 sm:top-4 sm:bottom-4 sm:max-h-none sm:w-96 sm:rounded-xl">
      <div className="sticky top-0 z-10 -mx-5 -mt-5 mb-1 flex items-start justify-between gap-3 bg-white px-5 pt-5 pb-2">
        <h2 className="text-2xl font-bold text-gray-900">{customer.name}</h2>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-3xl leading-none text-gray-400 hover:text-gray-600"
        >
          &times;
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-3 py-0.5 text-base font-semibold ${CHANNEL_STYLES[reminder.channel]}`}
        >
          {reminder.channel}
        </span>
        <span
          className={`rounded-full px-3 py-0.5 text-base font-semibold ${STATUS_STYLES[reminder.status]}`}
        >
          {reminder.status}
        </span>
        <span className="text-base text-gray-600">
          Send date: {formatDate(reminder.sendDate)}
        </span>
      </div>

      <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <div className="text-sm font-medium uppercase tracking-wide text-gray-500">
          Message preview
        </div>
        <p className="mt-2 whitespace-pre-line text-lg text-gray-800">
          {messageText(reminder, customer)}
        </p>
      </div>

      {reminder.status === 'Scheduled' && (
        <button
          onClick={onSendNow}
          className="mt-4 w-full rounded-lg bg-blue-700 px-4 py-3 text-lg font-semibold text-white hover:bg-blue-800"
        >
          Send now
        </button>
      )}
    </div>
  )
}

export default function RemindersTab({ customers, sentReminders, onMarkSent }) {
  const [filter, setFilter] = useState('Scheduled')
  const [selectedId, setSelectedId] = useState(null)
  const [toast, setToast] = useState(null)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(t)
  }, [toast])

  const reminders = allReminders(customers, sentReminders)
    .filter((r) => filter === 'All' || r.status === filter)
    .sort((a, b) => a.sendDate - b.sendDate)

  const selected = allReminders(customers, sentReminders).find(
    (r) => r.id === selectedId
  )
  const selectedCustomer =
    selected && customers.find((c) => c.id === selected.customerId)

  function sendNow(reminder, customer) {
    onMarkSent(reminder.id)
    setToast(`${reminder.channel} sent to ${customer.name} (simulated)`)
    setSelectedId(null)
  }

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl p-4 sm:p-6">
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={
                  'rounded-full px-4 py-2 text-base font-semibold ' +
                  (filter === f
                    ? 'bg-blue-700 text-white'
                    : 'border-2 border-gray-300 text-gray-700 hover:bg-gray-100')
                }
              >
                {f}
              </button>
            ))}
          </div>

          <div className="mt-4 divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white">
            {reminders.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-gray-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-lg font-semibold text-gray-900">
                    {r.customerName}
                  </div>
                  <div className="text-base text-gray-500">
                    Send {formatDate(r.sendDate)}
                  </div>
                </div>
                <span
                  className={`rounded-full px-3 py-0.5 text-base font-semibold ${CHANNEL_STYLES[r.channel]}`}
                >
                  {r.channel}
                </span>
                <span
                  className={`rounded-full px-3 py-0.5 text-base font-semibold ${STATUS_STYLES[r.status]}`}
                >
                  {r.status}
                </span>
              </button>
            ))}
            {reminders.length === 0 && (
              <div className="px-4 py-8 text-center text-lg text-gray-500">
                No reminders match this filter.
              </div>
            )}
          </div>
        </div>
      </div>

      {selected && selectedCustomer && (
        <PreviewPanel
          reminder={selected}
          customer={selectedCustomer}
          onSendNow={() => sendNow(selected, selectedCustomer)}
          onClose={() => setSelectedId(null)}
        />
      )}
      {toast && <Toast message={toast} />}
    </div>
  )
}
