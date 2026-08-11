import { useCallback, useState } from 'react'
import Topbar from './components/Topbar.jsx'
import TabNav from './components/TabNav.jsx'
import LeadModal from './components/LeadModal.jsx'
import MapTab from './components/MapTab.jsx'
import DueTab from './components/DueTab.jsx'
import RemindersTab from './components/RemindersTab.jsx'
import { loadState, saveState } from './lib/storage.js'
import { todayISO } from './lib/dates.js'
import { stampAddressChange } from './lib/location.js'
import { newCustomerId } from './lib/ids.js'

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
    // A new address means the pin is at the OLD one. The coordinate is kept -
    // the edit may have been a typo fix and the lid pin may still be right - but
    // it stops counting as checked, so the customer shows up under "Needs a pin"
    // and his card says why. Without this the operator drives to the pin: the
    // verifier moved a confirmed customer from Dallas NC to Erie PA and the map
    // still showed a settled pin in Dallas, 500 miles away.
    //
    // It lives in the write funnel rather than in the Edit form: every path that
    // can change an address comes through here, so a second edit screen cannot
    // forget the rule.
    const finalPatch = stampAddressChange(prev, patch)
    const keep = (k) => !k.startsWith(`${id}:`)
    persist({
      ...data,
      customers: data.customers.map((c) => (c.id === id ? { ...c, ...finalPatch } : c)),
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
