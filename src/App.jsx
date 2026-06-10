import { useState } from 'react'
import Topbar from './components/Topbar.jsx'
import TabNav from './components/TabNav.jsx'
import LeadModal from './components/LeadModal.jsx'
import MapTab from './components/MapTab.jsx'
import { loadState, saveState } from './lib/storage.js'

function Placeholder({ title }) {
  return (
    <div className="p-8 text-center">
      <h2 className="text-2xl font-bold text-gray-900">{title}</h2>
      <p className="mt-2 text-lg text-gray-500">Coming soon.</p>
    </div>
  )
}

function App() {
  const [tab, setTab] = useState('map')
  const [modalOpen, setModalOpen] = useState(false)
  const [customers, setCustomers] = useState(() => loadState().customers)

  function updateCustomer(id, patch) {
    const next = customers.map((c) => (c.id === id ? { ...c, ...patch } : c))
    setCustomers(next)
    saveState({ customers: next })
  }

  return (
    <div className="flex h-dvh flex-col bg-gray-50 text-gray-900">
      <Topbar onGetThis={() => setModalOpen(true)} />
      <TabNav active={tab} onChange={setTab} />
      <main className="min-h-0 flex-1 overflow-auto">
        {tab === 'map' && (
          <MapTab customers={customers} onUpdateCustomer={updateCustomer} />
        )}
        {tab === 'due' && <Placeholder title="Due list" />}
        {tab === 'reminders' && <Placeholder title="Reminders" />}
      </main>
      <LeadModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  )
}

export default App
