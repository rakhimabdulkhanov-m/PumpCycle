import { useCallback, useState } from 'react'
import Topbar from './components/Topbar.jsx'
import TabNav from './components/TabNav.jsx'
import LeadModal from './components/LeadModal.jsx'
import MapTab from './components/MapTab.jsx'
import DueTab from './components/DueTab.jsx'
import RemindersTab from './components/RemindersTab.jsx'
import { loadState, saveState } from './lib/storage.js'
import { todayISO } from './lib/dates.js'

/**
 * Ids must be unique, because they are the only thing that says which customer a
 * pin placement belongs to: updateCustomer patches EVERY customer whose id
 * matches, so two customers sharing one id are one customer with two rows on
 * screen. `c-${Date.now()}` collides whenever two are created in the same
 * millisecond, which is one paste of an import loop or two fast clicks.
 *
 * The 'c-' prefix stays so already-stored ids and the seed's c001.. keep working
 * unchanged; nothing parses what comes after it. randomUUID needs a secure
 * context (https or localhost), which production and the dev server both are;
 * the fallback exists so an http LAN address degrades to a near-unique id
 * instead of a TypeError in the middle of adding a customer.
 */
function newCustomerId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `c-${crypto.randomUUID()}`
  }
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function App() {
  const [tab, setTab] = useState('map')
  const [modalOpen, setModalOpen] = useState(false)
  const [data, setData] = useState(loadState)
  // When a customer is added with a geocoded address, store the target here so
  // MapTab can fly to it.  Consumed (set back to null) by MapTab after flying.
  const [flyTarget, setFlyTarget] = useState(null)
  // Stable identity on purpose: MapTab keeps the target alive until the map has
  // actually arrived, and a fresh callback on every render would restart that
  // effect and lose the listener it is waiting on.
  const clearFlyTarget = useCallback(() => setFlyTarget(null), [])
  // Where the map was left. MapTab unmounts on every tab switch, so it hands
  // its view back on the way out and starts there the next time it mounts.
  const [mapView, setMapView] = useState({ center: [35.28, -81.17], zoom: 11 })

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
    // Strip the map-routing flags before persisting: they aren't customer data.
    const { geocoded, flyZoom, ...customerFields } = fields
    persist({
      ...data,
      customers: [...data.customers, { ...customerFields, id: newCustomerId() }],
    })
    const { lat, lng } = customerFields
    if (geocoded) {
      // Switch to the map tab and fly to the geocoded address so the seller can
      // see the yard on satellite and place/confirm the lid pin position. How
      // close depends on what was actually found: zoom 19 shows one yard, which
      // is right for a house match and useless for a town match. The modal
      // decides; App just carries it.
      setFlyTarget({ lat, lng, zoom: flyZoom })
      setTab('map')
    }
    // No geocode means no pin and nowhere to fly. The map deliberately does not
    // move: nothing was invented for it to move to.
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
            flyTarget={flyTarget}
            onFlyConsumed={clearFlyTarget}
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
            onAddCustomer={addCustomer}
            onSetAvgJobPrice={setAvgJobPrice}
            // Where the map is right now, so a geocode hit on the other side of
            // the country comes back flagged instead of silently flying there.
            mapCenter={mapView.center}
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
