import { useCallback, useState } from 'react'
import Topbar from './components/Topbar.jsx'
import TabNav from './components/TabNav.jsx'
import LeadModal from './components/LeadModal.jsx'
import MapTab from './components/MapTab.jsx'
import DueTab from './components/DueTab.jsx'
import RemindersTab from './components/RemindersTab.jsx'
import AddCustomerModal from './components/AddCustomerModal.jsx'
import { todayISO } from './lib/dates.js'
import { DEFAULT_MAP_STATUS_VISIBILITY } from './lib/mapScale.js'
import {
  addCustomerNavigationKind,
  freshAddCustomerDraft,
} from './lib/addCustomerDraft.js'
import { store, useStore } from './lib/store/useStore.js'

let fallbackVisitId = 0
const newVisitId = () => {
  if (globalThis.crypto?.randomUUID) return `v-${globalThis.crypto.randomUUID()}`
  fallbackVisitId += 1
  return `v-${Date.now()}-${fallbackVisitId}`
}

function StoreGate({ snapshot, mode }) {
  const booting = snapshot.storeStatus === 'booting'
  const failed = snapshot.storeStatus === 'error'
  const company = snapshot.company?.trim()

  return (
    <div className="flex h-dvh flex-col bg-gray-50 text-gray-900">
      <Topbar demo={false} />
      <main className="flex flex-1 items-center justify-center px-5 py-10">
        <section className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-2xl font-bold text-gray-900">
            {booting
              ? 'Loading PumpCycle...'
              : failed
                ? 'PumpCycle could not start'
                : company
                  ? `${company} is not ready to open yet`
                  : 'This customer book is not ready to open yet'}
          </h1>
          <p className="mt-3 text-lg text-gray-600">
            {booting
              ? 'Checking which customer book belongs here.'
              : mode === 'live'
                ? 'Sign-in and data access still need to be connected for this company.'
                : snapshot.storeError?.message || 'Could not identify this PumpCycle site.'}
          </p>
          {failed && (
            <button
              type="button"
              onClick={() => void store.retry().catch(() => {})}
              className="mt-5 rounded-lg bg-blue-700 px-5 py-3 text-lg font-semibold text-white hover:bg-blue-800"
            >
              Try again
            </button>
          )}
        </section>
      </main>
    </div>
  )
}

function SyncNotice({ snapshot }) {
  if (snapshot.failedMutation) {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-center gap-2 bg-red-50 px-4 py-2 text-center text-sm font-semibold text-red-800">
        <span>A saved change could not sync. {snapshot.failedMutation.error?.message || 'Please try again.'}</span>
        <button type="button" className="rounded border border-red-400 px-2 py-1" onClick={() => void store.retryFailedMutation().catch(() => {})}>
          Retry
        </button>
        <button type="button" className="rounded border border-red-400 px-2 py-1" onClick={() => void store.discardFailedMutation().catch(() => {})}>
          Discard failed change
        </button>
      </div>
    )
  }
  if (snapshot.storeStatus === 'offline') {
    return (
      <div role="status" className="bg-amber-50 px-4 py-2 text-center text-sm font-semibold text-amber-900">
        Changes are saved on this device and will sync when the connection returns.
      </div>
    )
  }
  if (snapshot.pendingCount > 0) {
    return (
      <div role="status" className="bg-blue-50 px-4 py-2 text-center text-sm font-semibold text-blue-900">
        Saved on this device. Syncing {snapshot.pendingCount} {snapshot.pendingCount === 1 ? 'change' : 'changes'}...
      </div>
    )
  }
  return null
}

function App() {
  const [tab, setTab] = useState('map')
  const [modalOpen, setModalOpen] = useState(false)
  const data = useStore()
  const mode = store.getMode()
  const [addOpen, setAddOpen] = useState(false)
  const [addDefaults, setAddDefaults] = useState(freshAddCustomerDraft)
  const [addDraft, setAddDraft] = useState(addDefaults)
  // One navigation primitive for every cross-tab customer handoff. It stays in
  // App while Map unmounts and is cleared only by the Map after it has opened
  // the exact card or started the exact placement session.
  const [navigationIntent, setNavigationIntent] = useState(null)
  const consumeNavigationIntent = useCallback((consumed) => {
    setNavigationIntent((current) => (current === consumed ? null : current))
  }, [])
  // Where the map was left. MapTab unmounts on every tab switch, so it hands
  // its view back on the way out and starts there the next time it mounts.
  const [mapView, setMapView] = useState({ center: [35.28, -81.17], zoom: 11 })
  const [mapStatusVisibility, setMapStatusVisibility] = useState({
    ...DEFAULT_MAP_STATUS_VISIBILITY,
  })
  const [dueView, setDueView] = useState({
    filter: 'overdue',
    searchQuery: '',
    scrollTop: 0,
    limit: 100,
  })

  const updateCustomer = useCallback((id, patch) => store.updateCustomer(id, patch), [])
  const setPin = useCallback((id, point) => store.setPin(id, point), [])
  const restorePin = useCallback((id, pin) => store.restorePin(id, pin), [])
  const markPumped = useCallback((customerId) => store.recordVisit({
    id: newVisitId(),
    customerId,
    visitedOn: todayISO(),
  }), [])

  const addCustomer = useCallback(async (fields) => {
    // Strip the map-routing flags before persisting: they aren't customer data.
    const customerFields = { ...fields }
    const geocoded = customerFields.geocoded
    delete customerFields.geocoded
    delete customerFields.flyZoom
    const id = await store.addCustomer(customerFields)
    // Only AddCustomerModal carries the geocoded routing flag. The separate
    // map-first "Drop lid pin" flow already ends on its manually aimed point
    // and must not start a second navigation after saving.
    if (typeof geocoded === 'boolean') {
      setNavigationIntent({
        kind: addCustomerNavigationKind({
          geocoded,
          locationPrecision: customerFields.locationPrecision,
        }),
        customerId: id,
      })
      setTab('map')
    }
    return id
  }, [])

  const addFromModal = useCallback(async (fields) => {
    await addCustomer(fields)
    const fresh = freshAddCustomerDraft()
    setAddDefaults(fresh)
    setAddDraft(fresh)
    setAddOpen(false)
  }, [addCustomer])

  const discardAddDraft = useCallback(() => {
    const fresh = freshAddCustomerDraft()
    setAddDefaults(fresh)
    setAddDraft(fresh)
    setAddOpen(false)
  }, [])

  const navigateToCustomer = useCallback((kind, customerId) => {
    setNavigationIntent({ kind, customerId })
    setTab('map')
  }, [])

  const setAvgJobPrice = useCallback((price) => store.setAvgJobPrice(price), [])
  const markReminderSent = useCallback((reminderId) => store.markReminderSent(reminderId), [])

  if (data.blocked || !mode) {
    return <StoreGate snapshot={data} mode={mode} />
  }

  return (
    <div className="flex h-dvh flex-col bg-gray-50 text-gray-900">
      <Topbar demo={mode === 'demo'} onGetThis={() => setModalOpen(true)} />
      <SyncNotice snapshot={data} />
      <TabNav active={tab} onChange={setTab} />
      <main className="min-h-0 flex-1 overflow-auto">
        {tab === 'map' && (
          <MapTab
            customers={data.customers}
            onUpdateCustomer={updateCustomer}
            onMarkPumped={markPumped}
            onSetPin={setPin}
            onRestorePin={restorePin}
            onAddCustomer={addCustomer}
            navigationIntent={navigationIntent}
            onNavigationConsumed={consumeNavigationIntent}
            statusVisibility={mapStatusVisibility}
            onStatusVisibilityChange={setMapStatusVisibility}
            initialView={mapView}
            onLeaveView={setMapView}
          />
        )}
        {tab === 'due' && (
          <DueTab
            customers={data.customers}
            settings={data.settings}
            sentReminders={data.sentReminders}
            onUpdateCustomer={updateCustomer}
            onMarkPumped={markPumped}
            onSetAvgJobPrice={setAvgJobPrice}
            onRequestAdd={() => setAddOpen(true)}
            onNavigateCustomer={navigateToCustomer}
            view={dueView}
            onViewChange={setDueView}
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
      {addOpen && (
        <AddCustomerModal
          draft={addDraft}
          defaults={addDefaults}
          onDraftChange={setAddDraft}
          onAdd={addFromModal}
          onClose={() => setAddOpen(false)}
          onDiscard={discardAddDraft}
          mapCenter={mapView.center}
        />
      )}
      {mode === 'demo' && (
        <LeadModal open={modalOpen} onClose={() => setModalOpen(false)} />
      )}
    </div>
  )
}

export default App
