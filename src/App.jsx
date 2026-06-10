import { useState } from 'react'
import Topbar from './components/Topbar.jsx'
import TabNav from './components/TabNav.jsx'
import LeadModal from './components/LeadModal.jsx'

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

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <Topbar onGetThis={() => setModalOpen(true)} />
      <TabNav active={tab} onChange={setTab} />
      <main>
        {tab === 'map' && <Placeholder title="Map" />}
        {tab === 'due' && <Placeholder title="Due list" />}
        {tab === 'reminders' && <Placeholder title="Reminders" />}
      </main>
      <LeadModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  )
}

export default App
