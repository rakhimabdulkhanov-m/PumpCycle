import { useEffect, useMemo, useState } from 'react'
import { nextDue, formatDate, isCommercial } from '../lib/dates.js'
import { SMS_KEY } from '../lib/reminders.js'
import {
  customersNeedingEmail,
  groupSchedule,
  markSentOutcome,
  nothingToDoLine,
  repeatWarning,
  sentActivity,
  sentLabel,
  todaysAutomaticActivity,
} from '../lib/reminderView.js'
import { useDismissLayer } from '../lib/dismissLayer.js'
import CustomerCard from './CustomerCard.jsx'
import { hasLocation } from '../lib/point.js'

const NEEDS_ADDRESS_PREVIEW = 5

const VIEWS = [
  { id: 'today', label: 'Today' },
  { id: 'sent', label: 'Sent' },
]

function firstName(name) {
  return name.split(' ')[0]
}

// Only texts are previewed: the emails write themselves in the Worker and are
// never composed here.
function messageText(customer, company = 'Hawkins Septic', phone = '(704) 922-0440') {
  const due = formatDate(nextDue(customer))
  const sender = (company || 'PumpCycle').trim()
  const callPhone = (phone || '').trim()
  const phoneSnippet = callPhone ? ` Call or text ${callPhone} to schedule.` : ''

  if (isCommercial(customer)) {
    const cycleDays = customer.cycleMonths * 30
    return (
      `${sender}: ${customer.name} grease trap is due for its ${cycleDays}-day ` +
      `pump-out by ${due} to stay compliant.${phoneSnippet} ` +
      `Reply STOP to opt out.`
    )
  }
  const callLine = callPhone
    ? ` Call or text ${callPhone} to get on the schedule.`
    : ' Contact us to get on the schedule.'
  return (
    `${sender}: Hi ${firstName(customer.name)}, your septic tank is due ` +
    `for pumping around ${due}.${callLine} Reply STOP to opt out.`
  )
}

function Toast({ message }) {
  return (
    <div className="fixed bottom-6 left-1/2 z-[1300] -translate-x-1/2 rounded-lg bg-gray-900 px-5 py-3 text-lg font-medium text-white shadow-xl">
      {message}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <section className="mt-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
      <div className="mt-2 divide-y divide-gray-200 overflow-hidden rounded-xl border border-gray-200 bg-white">
        {children}
      </div>
    </section>
  )
}

function Quiet({ children }) {
  return <div className="px-4 py-3 text-base text-gray-600">{children}</div>
}

/**
 * The text-message panel. Registered with dismissLayer like every other layer in
 * the app, so the hardware Back gesture closes it instead of leaving PumpCycle.
 * One guard entry for the whole stack - the repeat question opens as a second
 * layer, never as a second history entry.
 */
function PreviewPanel({
  customer,
  warning,
  saving,
  company,
  phone,
  onMarkSent,
  onCopy,
  onClose,
}) {
  const [confirming, setConfirming] = useState(false)
  const message = messageText(customer, company, phone)
  const isTouch = window.matchMedia('(pointer: coarse)').matches
  const smsHref = `sms:${customer.phone.replace(/\D/g, '')}?&body=${encodeURIComponent(message)}`

  useDismissLayer(!confirming, onClose)
  useDismissLayer(confirming, () => setConfirming(false))

  return (
    <div className="absolute inset-x-0 bottom-0 z-[1050] flex max-h-[75%] flex-col rounded-t-xl bg-white shadow-2xl sm:inset-x-auto sm:right-4 sm:top-4 sm:bottom-4 sm:max-h-none sm:w-96 sm:rounded-xl">
      <div className="flex items-start justify-between gap-3 border-b border-gray-200 p-5 pb-3">
        <h2 className="text-2xl font-bold text-gray-900">{customer.name}</h2>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-3xl leading-none text-gray-400 hover:text-gray-600"
        >
          &times;
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5 pt-3">
        <p className="text-base text-gray-600">
          You text this one. Due {formatDate(nextDue(customer))}.
        </p>

        <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="text-sm font-medium uppercase tracking-wide text-gray-500">
            Message
          </div>
          <p className="mt-2 whitespace-pre-line text-lg text-gray-800">{message}</p>
        </div>

        {confirming ? (
          <div className="mt-4 rounded-lg border-2 border-amber-300 bg-amber-50 p-4">
            <p className="text-lg font-semibold text-amber-900">
              This customer got this on {warning?.on}. Send another copy?
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <button
                onClick={onMarkSent}
                disabled={saving}
                className="w-full rounded-lg bg-green-700 px-4 py-3 text-lg font-semibold text-white hover:bg-green-800 disabled:opacity-60"
              >
                {saving ? 'Saving...' : 'Yes, send another copy'}
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="w-full rounded-lg border-2 border-gray-300 px-4 py-3 text-lg font-semibold text-gray-700 hover:bg-gray-100"
              >
                No, leave it
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-2">
            {isTouch && customer.phone.trim() !== '' && (
              <a
                href={smsHref}
                className="w-full rounded-lg bg-blue-700 px-4 py-3 text-center text-lg font-semibold text-white hover:bg-blue-800"
              >
                Text from my phone
              </a>
            )}
            <button
              onClick={() => onCopy(message)}
              className="w-full rounded-lg border-2 border-gray-300 px-4 py-3 text-lg font-semibold text-gray-700 hover:bg-gray-100"
            >
              Copy text
            </button>
            <button
              onClick={() => (warning ? setConfirming(true) : onMarkSent())}
              disabled={saving}
              className="w-full rounded-lg bg-green-700 px-4 py-3 text-lg font-semibold text-white hover:bg-green-800 disabled:opacity-60"
            >
              {saving ? 'Saving...' : 'Mark as sent'}
            </button>
            <p className="text-sm text-gray-500">
              Text it yourself, then tap “Mark as sent.”
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function TextRow({ item, onOpen }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-lg font-semibold text-gray-900">{item.customerName}</div>
        <div className="text-base text-gray-500">You text this one</div>
      </div>
      <button
        onClick={() => onOpen(item.id)}
        className="rounded-lg bg-blue-700 px-4 py-2 text-base font-semibold text-white hover:bg-blue-800"
      >
        Text this one
      </button>
    </div>
  )
}

function DayBlock({ day, onOpenText }) {
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-lg font-semibold text-gray-900">{day.label}</span>
        {day.emailCount > 0 && (
          <span className="text-base text-gray-600">
            {day.emailCount === 1 ? '1 email sends' : `${day.emailCount} emails send`}{' '}
            automatically
          </span>
        )}
      </div>
      {day.texts.map((item) => (
        <button
          key={item.id}
          onClick={() => onOpenText(item.id)}
          className="mt-1 block w-full text-left text-base text-gray-700 underline-offset-2 hover:underline"
        >
          {item.customerName} - you text this one
        </button>
      ))}
    </div>
  )
}

export default function RemindersTab({
  customers,
  visits = [],
  photos = [],
  sentReminders,
  sentAt,
  reminderLog,
  settings,
  onMarkSent,
  onUpdateCustomer,
  onMarkPumped,
  onRecordVisit,
  onUpdateVisit,
  onArchiveVisit,
  onRecordPhoto,
  onArchivePhoto,
  onNavigateCustomer,
}) {
  const [view, setView] = useState('today')
  const [selectedId, setSelectedId] = useState(null)
  const [cardId, setCardId] = useState(null)
  const [cardEditing, setCardEditing] = useState(false)
  const [toast, setToast] = useState(null)
  const [saving, setSaving] = useState(false)
  const [beyondOpen, setBeyondOpen] = useState(false)
  const [allAddresses, setAllAddresses] = useState(false)
  const [openMonths, setOpenMonths] = useState(() => new Set())

  useEffect(() => {
    if (!toast) return undefined
    const t = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(t)
  }, [toast])

  const needsAddress = useMemo(() => customersNeedingEmail(customers), [customers])
  // An imported paper book can arrive with hundreds of missing addresses. The
  // section is a fix queue, not a list to read, so it stays a handful of rows
  // until he asks for the rest - otherwise it buries Today under a wall.
  const visibleNeedsAddress = allAddresses
    ? needsAddress
    : needsAddress.slice(0, NEEDS_ADDRESS_PREVIEW)
  const schedule = useMemo(
    () => groupSchedule(customers, sentReminders, sentAt),
    [customers, sentReminders, sentAt]
  )
  const automatic = useMemo(
    () => todaysAutomaticActivity({ reminderLog, customers }),
    [reminderLog, customers]
  )
  const sent = useMemo(
    () => sentActivity({ reminderLog, customers, sentReminders, sentAt }),
    [reminderLog, customers, sentReminders, sentAt]
  )

  const selected = schedule.todayTexts
    .concat(...schedule.week.map((day) => day.texts))
    .concat(...schedule.beyond.months.flatMap((month) => month.days.map((day) => day.texts)))
    .find((item) => item.id === selectedId)
  const selectedCustomer = selected && customers.find((c) => c.id === selected.customerId)
  const cardCustomer = customers.find((c) => c.id === cardId)

  const warning = selected
    ? repeatWarning(selected.customerId, SMS_KEY, { reminderLog, sentAt })
    : null

  // Await the write before saying anything. `saving` also guards the button: a
  // double tap on a slow phone would otherwise queue the send twice.
  async function markSent(item, customer) {
    if (saving) return
    setSaving(true)
    try {
      const outcome = await markSentOutcome(onMarkSent, item.id, customer.name)
      setToast(outcome.toast)
      if (outcome.close) setSelectedId(null)
    } finally {
      setSaving(false)
    }
  }

  function copyMessage(message) {
    navigator.clipboard.writeText(message)
    setToast('Message copied')
  }

  function toggleMonth(key) {
    setOpenMonths((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const quietMorning =
    schedule.todayTexts.length === 0 && automatic.problems.length === 0

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl p-4 sm:p-6">
          {settings?.emailEnabled === false && (
            <div
              role="status"
              className="rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 text-base font-semibold text-amber-900"
            >
              Automatic emails are switched off for this account, so nothing on this
              schedule will actually send yet.
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                onClick={() => setView(v.id)}
                className={
                  'flex min-h-11 items-center rounded-full px-5 py-2 text-base font-semibold ' +
                  (view === v.id
                    ? 'bg-blue-700 text-white'
                    : 'border-2 border-gray-300 text-gray-700 hover:bg-gray-100')
                }
              >
                {v.label}
              </button>
            ))}
          </div>

          {view === 'today' ? (
            <>
              {needsAddress.length > 0 && (
                <section className="mt-5">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-red-700">
                    Needs a good email address
                  </h2>
                  <div className="mt-2 divide-y divide-red-200 overflow-hidden rounded-xl border-2 border-red-300 bg-red-50">
                    {visibleNeedsAddress.map(({ customer, message }) => (
                      <button
                        key={customer.id}
                        onClick={() => {
                          setCardId(customer.id)
                          setCardEditing(true)
                        }}
                        className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-red-100"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-lg font-semibold text-gray-900">
                            {customer.name}
                          </div>
                          <div className="text-base text-red-800">{message}</div>
                        </div>
                        <span className="text-base font-semibold text-red-800">Fix</span>
                      </button>
                    ))}
                    {needsAddress.length > NEEDS_ADDRESS_PREVIEW && (
                      <button
                        onClick={() => setAllAddresses(!allAddresses)}
                        className="w-full px-4 py-3 text-left text-base font-semibold text-red-800 hover:bg-red-100"
                      >
                        {allAddresses
                          ? 'Show fewer'
                          : `Show all ${needsAddress.length}`}
                      </button>
                    )}
                  </div>
                </section>
              )}

              <Section title="Today">
                {schedule.todayTexts.map((item) => (
                  <TextRow key={item.id} item={item} onOpen={setSelectedId} />
                ))}
                {automatic.problems.map((row) => (
                  <button
                    key={row.key}
                    onClick={() => setCardId(row.customerId)}
                    className="flex w-full items-center gap-x-4 px-4 py-3 text-left hover:bg-gray-50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-lg font-semibold text-gray-900">
                        {row.customerName}
                      </div>
                      <div className="text-base text-red-700">{sentLabel(row)}</div>
                    </div>
                  </button>
                ))}
                {quietMorning ? (
                  <Quiet>{nothingToDoLine(automatic.sentCount)}</Quiet>
                ) : (
                  automatic.sentCount > 0 && (
                    <Quiet>
                      {automatic.sentCount} reminder
                      {automatic.sentCount === 1 ? '' : 's'} went out this morning.
                    </Quiet>
                  )
                )}
                {schedule.todayEmailCount > 0 && (
                  <Quiet>
                    {schedule.todayEmailCount} email
                    {schedule.todayEmailCount === 1 ? '' : 's'} still to go out today,
                    automatically.
                  </Quiet>
                )}
              </Section>

              <Section title="Next 7 days">
                {schedule.week.map((day) => (
                  <DayBlock key={day.dateISO} day={day} onOpenText={setSelectedId} />
                ))}
                {schedule.week.length === 0 && <Quiet>Nothing in the next week.</Quiet>}
              </Section>

              {schedule.beyond.total > 0 && (
                <Section title="Everything beyond">
                  <button
                    onClick={() => setBeyondOpen(!beyondOpen)}
                    className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
                  >
                    <span className="text-lg text-gray-800">
                      {schedule.beyond.total} more scheduled
                      {schedule.beyond.lastDateISO
                        ? ` through ${schedule.beyond.lastDateISO.slice(0, 4)}`
                        : ''}
                    </span>
                    <span className="text-base font-semibold text-blue-700">
                      {beyondOpen ? 'Hide' : 'Show'}
                    </span>
                  </button>
                  {beyondOpen &&
                    schedule.beyond.months.map((month) => (
                      <div key={month.key}>
                        <button
                          onClick={() => toggleMonth(month.key)}
                          className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
                        >
                          <span className="text-lg font-semibold text-gray-900">
                            {month.label}
                          </span>
                          <span className="text-base text-gray-600">
                            {month.total} {openMonths.has(month.key) ? '▾' : '▸'}
                          </span>
                        </button>
                        {openMonths.has(month.key) &&
                          month.days.map((day) => (
                            <div key={day.dateISO} className="border-t border-gray-100 bg-gray-50">
                              <DayBlock day={day} onOpenText={setSelectedId} />
                            </div>
                          ))}
                      </div>
                    ))}
                </Section>
              )}
            </>
          ) : (
            <Section title="Sent">
              {sent.map((row) => (
                <div key={row.key} className="px-4 py-3">
                  <div className="text-lg font-semibold text-gray-900">{row.customerName}</div>
                  <div className="text-base text-gray-500">{sentLabel(row)}</div>
                </div>
              ))}
              {sent.length === 0 && <Quiet>Nothing has gone out yet.</Quiet>}
            </Section>
          )}
        </div>
      </div>

      {selected && selectedCustomer && (
        <PreviewPanel
          customer={selectedCustomer}
          warning={warning}
          saving={saving}
          company={settings?.companyName || 'Hawkins Septic'}
          phone={settings?.companyPhone || '(704) 922-0440'}
          onMarkSent={() => markSent(selected, selectedCustomer)}
          onCopy={copyMessage}
          onClose={() => setSelectedId(null)}
        />
      )}
      {cardCustomer && (
        <CustomerCard
          customer={cardCustomer}
          visits={visits}
          photos={photos}
          initialEditing={cardEditing}
          onClose={() => {
            setCardId(null)
            setCardEditing(false)
          }}
          onUpdate={(patch) => onUpdateCustomer(cardCustomer.id, patch)}
          onMarkPumped={() => onMarkPumped(cardCustomer.id)}
          onRecordVisit={onRecordVisit}
          onUpdateVisit={onUpdateVisit}
          onArchiveVisit={onArchiveVisit}
          onRecordPhoto={onRecordPhoto}
          onArchivePhoto={onArchivePhoto}
          onMapAction={() =>
            onNavigateCustomer(hasLocation(cardCustomer) ? 'show' : 'place', cardCustomer.id)
          }
        />
      )}
      {toast && <Toast message={toast} />}
    </div>
  )
}
