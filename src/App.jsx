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
    persist({
      ...data,
      customers: data.customers.map((c) => (c.id === id ? { ...c, ...patch } : c)),
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
