import { useState } from 'react'
import Topbar from './components/Topbar.jsx'
import TabNav from './components/TabNav.jsx'
import LeadModal from './components/LeadModal.jsx'
import MapTab from './components/MapTab.jsx'
import DueTab from './components/DueTab.jsx'
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

  return (
    <div className="flex h-dvh flex-col bg-gray-50 text-gray-900">
      <Topbar onGetThis={() => setModalOpen(true)} />
      <TabNav active={tab} onChange={setTab} />
      <main className="min-h-0 flex-1 overflow-auto">
        {tab === 'map' && (
          <MapTab customers={data.customers} onUpdateCustomer={updateCustomer} />
        )}
        {tab === 'due' && (
          <DueTab
            customers={data.customers}
            settings={data.settings}
            onUpdateCustomer={updateCustomer}
            onAddCustomer={addCustomer}
            onSetAvgJobPrice={setAvgJobPrice}
          />
        )}
        {tab === 'reminders' && <Placeholder title="Reminders" />}
      </main>
      <LeadModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  )
}

export default App
