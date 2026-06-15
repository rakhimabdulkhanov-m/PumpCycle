import { useState } from 'react'
import Topbar from './components/Topbar.jsx'
import TabNav from './components/TabNav.jsx'
import LeadModal from './components/LeadModal.jsx'
import MapTab from './components/MapTab.jsx'
import DueTab from './components/DueTab.jsx'
import RemindersTab from './components/RemindersTab.jsx'
import { loadState, saveState } from './lib/storage.js'
import { todayISO } from './lib/dates.js'

function App() {
  const [tab, setTab] = useState('map')
  const [modalOpen, setModalOpen] = useState(false)
  const [data, setData] = useState(loadState)

  function persist(next) {
    setData(next)
    saveState(next)
  }

  function updateCustomer(id, patch) {
    const prev = data.customers.find((c) => c.id === id)
    // A new lastPumped OR a changed cycle length means a new/different cycle:
    // the cycle also flips the email reminder id (commercial :15 vs residential
    // :60), so clear on either to avoid stranded sent ids / reverted statuses.
    const lastPumpedChanged =
      patch.lastPumped !== undefined && patch.lastPumped !== prev?.lastPumped
    const cycleChanged =
      patch.cycleMonths !== undefined && patch.cycleMonths !== prev?.cycleMonths
    const cycleReset = prev && (lastPumpedChanged || cycleChanged)
    const keep = (k) => !k.startsWith(`${id}:`)
    persist({
      ...data,
      customers: data.customers.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      sentReminders: cycleReset
        ? data.sentReminders.filter(keep)
        : data.sentReminders,
      sentAt: cycleReset
        ? Object.fromEntries(Object.entries(data.sentAt).filter(([k]) => keep(k)))
        : data.sentAt,
    })
  }

  function addCustomer(fields) {
    persist({
      ...data,
      customers: [...data.customers, { ...fields, id: `c-${Date.now()}` }],
    })
  }

  function setAvgJobPrice(price) {
    persist({ ...data, settings: { ...data.settings, avgJobPrice: price } })
  }

  function markReminderSent(reminderId) {
    if (data.sentReminders.includes(reminderId)) return
    persist({
      ...data,
      sentReminders: [...data.sentReminders, reminderId],
      sentAt: { ...data.sentAt, [reminderId]: todayISO() },
    })
  }

  return (
    <div className="flex h-dvh flex-col bg-gray-50 text-gray-900">
      <Topbar onGetThis={() => setModalOpen(true)} />
      <TabNav active={tab} onChange={setTab} />
      <main className="min-h-0 flex-1 overflow-auto">
        {tab === 'map' && (
          <MapTab
            customers={data.customers}
            onUpdateCustomer={updateCustomer}
            onAddCustomer={addCustomer}
          />
        )}
        {tab === 'due' && (
          <DueTab
            customers={data.customers}
            settings={data.settings}
            sentReminders={data.sentReminders}
            onUpdateCustomer={updateCustomer}
            onAddCustomer={addCustomer}
            onSetAvgJobPrice={setAvgJobPrice}
          />
        )}
        {tab === 'reminders' && (
          <RemindersTab
            customers={data.customers}
            sentReminders={data.sentReminders}
            sentAt={data.sentAt}
            onMarkSent={markReminderSent}
          />
        )}
      </main>
      <LeadModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  )
}

export default App
