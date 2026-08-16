import { useCallback, useMemo, useState } from 'react'
import Topbar from './components/Topbar.jsx'
import TabNav from './components/TabNav.jsx'
import LeadModal from './components/LeadModal.jsx'
import MapTab from './components/MapTab.jsx'
import DueTab from './components/DueTab.jsx'
import RemindersTab from './components/RemindersTab.jsx'
import AddCustomerModal from './components/AddCustomerModal.jsx'
import ExportModal from './components/ExportModal.jsx'
import PrintLabels from './components/PrintLabels.jsx'
import PrintPostcards from './components/PrintPostcards.jsx'
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

function AuthGate({ snapshot }) {
  const setup = snapshot.storeStatus === 'setup-required'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (setup) await store.setup(password)
      else await store.login(email, password)
    } catch (caught) {
      setError(caught?.message || (setup ? 'Could not set your password.' : 'Could not sign in.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-gray-50 text-gray-900">
      <Topbar demo={false} />
      <main className="flex flex-1 items-center justify-center px-4 py-8 sm:px-6">
        <form onSubmit={submit} className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
          <p className="text-base font-semibold text-blue-800">{snapshot.company || 'PumpCycle'}</p>
          <h1 className="mt-1 text-3xl font-bold">{setup ? 'Set your password' : 'Sign in'}</h1>
          <p className="mt-2 text-base leading-6 text-gray-600">
            {setup ? 'Choose a password with at least 12 characters. A long phrase is fine.' : 'Use the owner email and password for this company.'}
          </p>
          {!setup && (
            <label className="mt-6 block text-base font-semibold">
              Email
              <input
                type="email" name="email" autoComplete="username" required maxLength={320}
                value={email} onChange={(event) => setEmail(event.target.value)}
                className="mt-2 w-full rounded-lg border border-gray-400 px-4 py-3 text-lg outline-none focus:border-blue-700 focus:ring-2 focus:ring-blue-200"
              />
            </label>
          )}
          <label className="mt-5 block text-base font-semibold">
            {setup ? 'New password' : 'Password'}
            <input
              type="password" name="password" autoComplete={setup ? 'new-password' : 'current-password'}
              required minLength={setup ? 12 : undefined} maxLength={1024}
              value={password} onChange={(event) => setPassword(event.target.value)}
              className="mt-2 w-full rounded-lg border border-gray-400 px-4 py-3 text-lg outline-none focus:border-blue-700 focus:ring-2 focus:ring-blue-200"
            />
          </label>
          {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-base font-semibold text-red-800">{error}</p>}
          <button
            type="submit" disabled={busy}
            className="mt-6 w-full rounded-lg bg-blue-700 px-5 py-3 text-lg font-bold text-white hover:bg-blue-800 disabled:cursor-wait disabled:opacity-60"
          >
            {busy ? 'Please wait…' : setup ? 'Set password and continue' : 'Sign in'}
          </button>
        </form>
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
  const [exportOpen, setExportOpen] = useState(false)
  const [printLabelsData, setPrintLabelsData] = useState(() => {
    if (typeof window !== 'undefined' && window.location.pathname === '/print/labels') {
      return 'all'
    }
    return null
  })
  const [printPostcardsData, setPrintPostcardsData] = useState(() => {
    if (typeof window !== 'undefined' && window.location.pathname === '/print/postcards') {
      return 'all'
    }
    return null
  })
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
  const recordVisit = useCallback((visit) => store.recordVisit(visit), [])
  const updateVisit = useCallback((visitId, changes) => store.updateVisit(visitId, changes), [])
  const archiveVisit = useCallback((visitId) => store.archiveVisit(visitId), [])
  const recordPhoto = useCallback((photo) => store.recordPhoto(photo), [])
  const archivePhoto = useCallback((photoId) => store.archivePhoto(photoId), [])

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

  const activeCustomers = useMemo(
    () => (data.customers || []).filter((c) => !c.archivedAt),
    [data.customers]
  )

  if (mode === 'live' && ['auth-required', 'setup-required'].includes(data.storeStatus)) {
    return <AuthGate snapshot={data} />
  }

  if (data.blocked || !mode) {
    return <StoreGate snapshot={data} mode={mode} />
  }

  return (
    <div className="flex h-dvh flex-col bg-gray-50 text-gray-900">
      <Topbar
        demo={mode === 'demo'}
        onGetThis={() => setModalOpen(true)}
        onSignOut={mode === 'live' ? () => void store.logout().catch(() => {}) : undefined}
      />
      <SyncNotice snapshot={data} />
      <TabNav active={tab} onChange={setTab} />
      <main className="min-h-0 flex-1 overflow-auto">
        {tab === 'map' && (
          <MapTab
            customers={activeCustomers}
            visits={data.visits || []}
            photos={data.photos || []}
            onUpdateCustomer={updateCustomer}
            onMarkPumped={markPumped}
            onRecordVisit={recordVisit}
            onUpdateVisit={updateVisit}
            onArchiveVisit={archiveVisit}
            onRecordPhoto={recordPhoto}
            onArchivePhoto={archivePhoto}
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
            customers={activeCustomers}
            visits={data.visits || []}
            photos={data.photos || []}
            settings={data.settings}
            sentReminders={data.sentReminders}
            onUpdateCustomer={updateCustomer}
            onMarkPumped={markPumped}
            onRecordVisit={recordVisit}
            onUpdateVisit={updateVisit}
            onArchiveVisit={archiveVisit}
            onRecordPhoto={recordPhoto}
            onArchivePhoto={archivePhoto}
            onSetAvgJobPrice={setAvgJobPrice}
            onRequestAdd={() => setAddOpen(true)}
            onRequestExport={() => setExportOpen(true)}
            onNavigateCustomer={navigateToCustomer}
            view={dueView}
            onViewChange={setDueView}
          />
        )}
        {tab === 'reminders' && (
          <RemindersTab
            company={data.company}
            customers={activeCustomers}
            visits={data.visits || []}
            photos={data.photos || []}
            sentReminders={data.sentReminders}
            sentAt={data.sentAt}
            reminderLog={data.reminderLog}
            settings={data.settings}
            onMarkSent={markReminderSent}
            onUpdateCustomer={updateCustomer}
            onMarkPumped={markPumped}
            onRecordVisit={recordVisit}
            onUpdateVisit={updateVisit}
            onArchiveVisit={archiveVisit}
            onRecordPhoto={recordPhoto}
            onArchivePhoto={archivePhoto}
            onNavigateCustomer={navigateToCustomer}
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
      {exportOpen && (
        <ExportModal
          customers={activeCustomers}
          onClose={() => setExportOpen(false)}
          onOpenPrintLabels={(list) => setPrintLabelsData(list)}
          onOpenPrintPostcards={(list) => setPrintPostcardsData(list)}
        />
      )}
      {printLabelsData && (
        <PrintLabels
          customers={printLabelsData === 'all' ? activeCustomers : printLabelsData}
          onClose={() => {
            setPrintLabelsData(null)
            if (typeof window !== 'undefined' && window.location.pathname === '/print/labels') {
              window.history.replaceState(null, '', '/')
            }
          }}
        />
      )}
      {printPostcardsData && (
        <PrintPostcards
          customers={printPostcardsData === 'all' ? activeCustomers : printPostcardsData}
          company={data.company || 'PumpCycle'}
          phone={data.settings?.companyPhone || ''}
          onClose={() => {
            setPrintPostcardsData(null)
            if (typeof window !== 'undefined' && window.location.pathname === '/print/postcards') {
              window.history.replaceState(null, '', '/')
            }
          }}
        />
      )}
      {mode === 'demo' && (
        <LeadModal open={modalOpen} onClose={() => setModalOpen(false)} />
      )}
    </div>
  )
}

export default App
