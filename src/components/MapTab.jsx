import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, LayersControl, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { dueStatus, todayISO } from '../lib/dates.js'
import CustomerCard from './CustomerCard.jsx'
import NewLidPanel from './NewLidPanel.jsx'

const STATUS_COLORS = {
  overdue: '#dc2626',
  'due-soon': '#f59e0b',
  ok: '#16a34a',
}

function makeIcon(color) {
  const svg = `
    <svg width="30" height="42" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg">
      <path d="M15 1 C7.3 1 1 7.4 1 15.3 C1 25.5 15 41 15 41 C15 41 29 25.5 29 15.3 C29 7.4 22.7 1 15 1 Z"
        fill="${color}" stroke="white" stroke-width="2"/>
      <circle cx="15" cy="15" r="5" fill="white"/>
    </svg>`
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [30, 42],
    iconAnchor: [15, 42],
  })
}

const ICONS = {
  overdue: makeIcon(STATUS_COLORS.overdue),
  'due-soon': makeIcon(STATUS_COLORS['due-soon']),
  ok: makeIcon(STATUS_COLORS.ok),
}

// Blue draft pin — visually distinct from the red/yellow/green customer pins
// so the "new one" reads clearly while it's being placed.
const DRAFT_ICON = makeIcon('#2563eb')

// Anything past this is a different part of the country, not the next street:
// flying it takes 8-10 s of swooping, so jump there instead.
const FLY_MAX_METERS = 50000

// Fly to a location saved from Add Customer (Due tab). Lives INSIDE
// MapContainer on purpose: children only render once the map exists, so useMap()
// always returns a real instance. A parent effect would miss the common case
// where the map mounts with a target already waiting (MapContainer's forwarded
// ref is still null on the first commit). The effect runs once per target
// object: App hands back a stable onConsumed, so a re-render can't re-fly.
function FlyToTarget({ target, onConsumed }) {
  const map = useMap()
  useEffect(() => {
    if (!target) return
    const to = [target.lat, target.lng]
    // The target is consumed on arrival, not at take-off. Flipping to the Due
    // list during the ~3 s animation unmounts the map mid-flight; holding the
    // target means the next mount flies to the same yard instead of stranding
    // the seller at the view he started from with nothing left to re-fly.
    // Only an arrival counts - an invalidateSize can also fire moveend.
    const settled = () => {
      if (map.getCenter().distanceTo(to) < 1) onConsumed()
    }
    map.on('moveend', settled)
    if (map.distance(map.getCenter(), to) > FLY_MAX_METERS) map.setView(to, target.zoom)
    else map.flyTo(to, target.zoom)
    return () => map.off('moveend', settled)
  }, [target, map, onConsumed])
  return null
}

// The seller flips to the Due list mid-call and comes back; MapTab unmounts on
// every tab switch, so the view is stashed in a ref App owns and outlives it.
// Written after every settled move/zoom rather than on unmount, where the map
// instance is already being torn down.
function RememberView({ storeRef }) {
  const map = useMapEvents({
    moveend: () => {
      const c = map.getCenter()
      storeRef.current = { center: [c.lat, c.lng], zoom: map.getZoom() }
    },
  })
  return null
}

function Toast({ message }) {
  return (
    <div className="fixed bottom-6 left-1/2 z-[1300] -translate-x-1/2 rounded-lg bg-gray-900 px-5 py-3 text-lg font-medium text-white shadow-xl">
      {message}
    </div>
  )
}

function Legend({ customers, hiddenOnMobile }) {
  const counts = { overdue: 0, 'due-soon': 0, ok: 0 }
  customers.forEach((c) => counts[dueStatus(c)]++)
  const rows = [
    ['overdue', 'Overdue'],
    ['due-soon', 'Due in 60 days'],
    ['ok', 'On schedule'],
  ]
  return (
    <div
      className={
        'absolute bottom-6 left-3 z-[1000] rounded-lg bg-white px-3 py-2 shadow-md ' +
        (hiddenOnMobile ? 'hidden sm:block' : '')
      }
    >
      {rows.map(([status, label]) => (
        <div key={status} className="flex items-center gap-2 py-0.5">
          <span
            className="inline-block h-4 w-4 rounded-full border-2 border-white shadow"
            style={{ backgroundColor: STATUS_COLORS[status] }}
          />
          <span className="text-base font-semibold text-gray-900">
            {label} ({counts[status]})
          </span>
        </div>
      ))}
    </div>
  )
}

export default function MapTab({
  customers,
  onUpdateCustomer,
  onAddCustomer,
  flyTarget,
  onFlyConsumed,
  initialView,
  onLeaveView,
}) {
  const [selectedId, setSelectedId] = useState(null)
  const [placingPin, setPlacingPin] = useState(false)
  const [locating, setLocating] = useState(false) // mobile step 1: position pin, no form yet
  const [draftPin, setDraftPin] = useState(null) // {lat,lng}|null
  const [draftType, setDraftType] = useState(null) // 'residential'|'commercial'|null
  const [draftName, setDraftName] = useState('')
  const [draftAddress, setDraftAddress] = useState('')
  const [toast, setToast] = useState(null)
  const mapRef = useRef(null)
  const wrapperRef = useRef(null)
  const viewRef = useRef(initialView)
  const selected = customers.find((c) => c.id === selectedId)
  const isTouch = window.matchMedia('(pointer: coarse)').matches
  // Mobile-only "locate" step: full map + draggable pin, form not yet shown.
  const mobileLocate = isTouch && placingPin && locating
  const sheetOpen = !!selected || (placingPin && !mobileLocate)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(t)
  }, [toast])

  function startPlacing() {
    const c = mapRef.current.getCenter()
    setDraftPin({ lat: c.lat, lng: c.lng })
    setDraftType(null)
    setDraftName('')
    setDraftAddress('')
    setSelectedId(null) // close any open customer card
    setPlacingPin(true)
    // On touch devices start in the locate step (map only, no form); on
    // desktop the side panel shows immediately as before.
    setLocating(isTouch)
  }

  function resetDraft() {
    setPlacingPin(false)
    setLocating(false)
    setDraftPin(null)
    setDraftType(null)
    setDraftName('')
    setDraftAddress('')
  }

  function savePin() {
    onAddCustomer({
      name: draftName,
      address: draftAddress,
      phone: '',
      email: '',
      lat: draftPin.lat,
      lng: draftPin.lng,
      tankSizeGal: 1000,
      lastPumped: todayISO(),
      cycleMonths: draftType === 'residential' ? 36 : 3,
      notes: '',
    })
    setToast(`Lid pinned for ${draftName}`)
    resetDraft()
  }

  // Hand the last view back to App on the way out. Read from a ref the map
  // fills in on moveend, not from Leaflet itself, which is already being torn
  // down by the time this runs.
  useEffect(() => () => onLeaveView(viewRef.current), [onLeaveView])

  // Leaflet caches its container size; without invalidateSize after the
  // wrapper resizes (bottom sheet, iOS toolbar/keyboard, rotation) tiles
  // stay gray and tap hit-testing lands on the wrong spot.
  useEffect(() => {
    const observer = new ResizeObserver(() => mapRef.current?.invalidateSize())
    observer.observe(wrapperRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    mapRef.current?.invalidateSize()
    const t = setTimeout(() => mapRef.current?.invalidateSize(), 300)
    return () => clearTimeout(t)
  }, [selectedId, placingPin, locating])

  return (
    <div className="relative h-full">
      <div
        ref={wrapperRef}
        className={
          'absolute inset-x-0 top-0 ' +
          (sheetOpen ? 'bottom-[min(75dvh,calc(100%-6rem))] sm:bottom-0' : 'bottom-0')
        }
      >
        <MapContainer
          ref={mapRef}
          center={initialView.center}
          zoom={initialView.zoom}
          className="h-full w-full"
          scrollWheelZoom
          // A second click on the save button lands here once the modal closes;
          // dblclick-zoom would hijack the fly-to. Wheel, pinch and +/- still zoom.
          doubleClickZoom={false}
          attributionControl={false}
        >
          {/* RememberView first on purpose: sibling effects run in this order, and a
              >50 km target arrives via setView, whose moveend fires synchronously
              inside FlyToTarget's effect. Subscribed second, RememberView would miss
              the only moveend that jump ever fires and hand back the pre-jump view. */}
          <RememberView storeRef={viewRef} />
          <FlyToTarget target={flyTarget} onConsumed={onFlyConsumed} />
          <LayersControl position="topright">
            <LayersControl.BaseLayer checked name="Satellite">
              <TileLayer
                key="satellite"
                url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                attribution="Tiles &copy; Esri"
                maxZoom={19}
              />
            </LayersControl.BaseLayer>
            <LayersControl.BaseLayer name="Map">
              <TileLayer
                key="street"
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              />
            </LayersControl.BaseLayer>
          </LayersControl>
          {/* Pins are draggable so the lid can be nudged onto the actual tank while
              the customer is on the phone ("side of the house? here?"). On touch
              only the open card's pin drags, the same way the draft pin waits for
              its own step: otherwise a pan that starts on a pin would move it. */}
          {customers.map((c) => (
            <Marker
              key={c.id}
              position={[c.lat, c.lng]}
              icon={ICONS[dueStatus(c)]}
              draggable={!isTouch || selectedId === c.id}
              eventHandlers={{
                click: () => setSelectedId(c.id),
                dragend: (e) => {
                  const ll = e.target.getLatLng()
                  onUpdateCustomer(c.id, { lat: ll.lat, lng: ll.lng })
                  setToast(`Lid moved for ${c.name}`)
                },
              }}
            />
          ))}
          {placingPin && draftPin && (
            <Marker
              draggable={!isTouch || mobileLocate}
              position={[draftPin.lat, draftPin.lng]}
              icon={DRAFT_ICON}
              eventHandlers={{
                dragend: (e) => {
                  const ll = e.target.getLatLng()
                  setDraftPin({ lat: ll.lat, lng: ll.lng })
                },
              }}
            />
          )}
        </MapContainer>
        {!(placingPin && isTouch) && <Legend customers={customers} hiddenOnMobile={sheetOpen} />}
        {mobileLocate ? (
          <div className="absolute top-3 left-1/2 z-[1100] -translate-x-1/2 rounded-full bg-gray-900 px-4 py-2 text-center text-sm font-semibold text-white shadow-lg">
            Drag the pin onto the lid
          </div>
        ) : (
          placingPin &&
          !isTouch && (
            <div className="absolute top-3 left-1/2 z-[1100] -translate-x-1/2 rounded-full bg-gray-900 px-4 py-2 text-center text-sm font-semibold text-white shadow-lg">
              Drag the blue pin onto the lid, then pick a service type below.
            </div>
          )
        )}
        {mobileLocate && (
          <button
            onClick={() => setLocating(false)}
            className="fixed inset-x-0 bottom-0 z-[1200] w-full bg-blue-700 py-4 text-lg font-bold text-white"
          >
            Next →
          </button>
        )}
        {!placingPin && !selected && (
          <button
            onClick={startPlacing}
            className="absolute bottom-6 right-3 z-[1100] rounded-2xl bg-blue-700 px-5 py-3 text-base font-bold text-white shadow-lg hover:bg-blue-800"
          >
            + Drop lid pin
          </button>
        )}
      </div>
      {selected && !placingPin && (
        <CustomerCard
          customer={selected}
          onClose={() => setSelectedId(null)}
          onUpdate={(patch) => onUpdateCustomer(selected.id, patch)}
        />
      )}
      {placingPin && !mobileLocate && (
        <NewLidPanel
          draftType={draftType}
          onPickType={setDraftType}
          name={draftName}
          onName={setDraftName}
          address={draftAddress}
          onAddress={setDraftAddress}
          canSave={draftName.trim() !== '' && draftType !== null}
          onSave={savePin}
          onCancel={resetDraft}
        />
      )}
      {toast && <Toast message={toast} />}
    </div>
  )
}
