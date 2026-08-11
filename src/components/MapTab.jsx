import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, LayersControl, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { dueStatus, todayISO } from '../lib/dates.js'
import { hasLocation } from '../lib/storage.js'
import {
  customersNeedingPin,
  manualLocationPatch,
  needsPinConfirmation,
  pinConfirmCase,
  zoomForPrecision,
} from '../lib/location.js'
import CustomerCard from './CustomerCard.jsx'
import NewLidPanel from './NewLidPanel.jsx'
import PlaceLidPanel from './PlaceLidPanel.jsx'

const STATUS_COLORS = {
  overdue: '#dc2626',
  'due-soon': '#f59e0b',
  ok: '#16a34a',
}

/**
 * hollow = this pin is not settled yet (see pinConfirmCase): a town or road
 * level geocode nobody has moved onto the lid. Same colour, so the due status
 * still reads at a glance; outline instead of a solid body, so "we are not sure
 * this is the yard" is visible on the map and not only in a list.
 */
function makeIcon(color, { hollow = false } = {}) {
  const svg = `
    <svg width="30" height="42" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg">
      <path d="M15 1 C7.3 1 1 7.4 1 15.3 C1 25.5 15 41 15 41 C15 41 29 25.5 29 15.3 C29 7.4 22.7 1 15 1 Z"
        fill="${hollow ? 'white' : color}" stroke="${hollow ? color : 'white'}" stroke-width="${hollow ? 3 : 2}"
        ${hollow ? 'stroke-dasharray="5 3"' : ''}/>
      <circle cx="15" cy="15" r="5" fill="${hollow ? color : 'white'}"/>
    </svg>`
  return L.divIcon({
    html: svg,
    className: hollow ? 'pin-unconfirmed' : '',
    iconSize: [30, 42],
    iconAnchor: [15, 42],
  })
}

const ICONS = {
  overdue: makeIcon(STATUS_COLORS.overdue),
  'due-soon': makeIcon(STATUS_COLORS['due-soon']),
  ok: makeIcon(STATUS_COLORS.ok),
}

const UNCONFIRMED_ICONS = {
  overdue: makeIcon(STATUS_COLORS.overdue, { hollow: true }),
  'due-soon': makeIcon(STATUS_COLORS['due-soon'], { hollow: true }),
  ok: makeIcon(STATUS_COLORS.ok, { hollow: true }),
}

// What the "Needs a pin" list says about each row. Which of the two problems it
// is decides what he does next: no pin means find the property from the address,
// a town or road pin means pan a short way onto the right roof.
const PIN_CASE_LABEL = {
  no_location: 'No pin yet',
  locality: 'Town-level pin',
  road: 'Road-level pin',
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

// Tapping the map during placement puts the pin there. Lives inside
// MapContainer because that is where a map instance exists. It is the cheap half
// of "Save needs a human decision": on a satellite image the lid is a thing you
// point at, and pointing at it is a decision in a way that "the pin happened to
// start here" is not.
function PlacementClicks({ active, onPlace }) {
  useMapEvents({
    click: (e) => {
      if (active) onPlace({ lat: e.latlng.lat, lng: e.latlng.lng, placed: true })
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

// The legend explains the pins, so it counts the pins - customers with no
// location are not on the map and are reported separately rather than folded
// into a status they cannot be seen under. Saying "3 need a pin" out loud is the
// honest version of what the old code did silently, which was to make a location
// up so the number would look complete.
//
// "Needs a pin" rather than "No pin yet" because it is now two problems with one
// answer: a customer with no coordinates at all, and a customer sitting on a
// town or road centroid nobody has moved onto his lid. Both are the same job -
// put the pin where the tank is - and the row names the job, not the state.
//
// It is a button: a count he cannot act on is just a complaint, and the Add
// Customer modal promises him he can drop the pin later.
function Legend({ located, needsPinCount, onShowNeedsPin, hiddenOnMobile }) {
  const counts = { overdue: 0, 'due-soon': 0, ok: 0 }
  located.forEach((c) => counts[dueStatus(c)]++)
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
      {needsPinCount > 0 && (
        <button
          type="button"
          onClick={onShowNeedsPin}
          className="mt-1 flex w-full items-center gap-2 border-t border-gray-200 pt-1 text-left"
        >
          <span className="inline-block h-4 w-4 rounded-full border-2 border-dashed border-gray-400" />
          <span className="text-base font-semibold text-blue-800 underline">
            Needs a pin ({needsPinCount})
          </span>
        </button>
      )}
    </div>
  )
}

// The list behind that number. Name and address, because the address is what he
// reads off the screen while hunting for the right roof on the satellite image,
// plus which of the two problems this row is: "No pin yet" is a different hunt
// from "Town-level pin", which already has the map in the right town.
function NeedsPinList({ customers, onPick, onClose, hiddenOnMobile }) {
  return (
    <div
      className={
        'absolute bottom-6 left-3 z-[1100] flex max-h-[70%] w-[min(22rem,calc(100vw-1.5rem))] flex-col rounded-lg bg-white shadow-xl ' +
        (hiddenOnMobile ? 'hidden sm:flex' : '')
      }
    >
      <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-4 py-3">
        <h3 className="text-lg font-bold text-gray-900">
          Needs a pin ({customers.length})
        </h3>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-3xl leading-none text-gray-400 hover:text-gray-600"
        >
          &times;
        </button>
      </div>
      <div className="min-h-0 flex-1 divide-y divide-gray-200 overflow-y-auto">
        {customers.map((c) => (
          <button
            key={c.id}
            onClick={() => onPick(c)}
            className="block w-full px-4 py-3 text-left hover:bg-blue-50"
          >
            <div className="text-lg font-semibold text-gray-900">{c.name}</div>
            <div className="text-base text-gray-600">
              {c.address || 'No address on file'}
            </div>
            <div className="text-sm font-semibold uppercase tracking-wide text-amber-700">
              {PIN_CASE_LABEL[pinConfirmCase(c)]}
            </div>
          </button>
        ))}
      </div>
      <p className="border-t border-gray-200 px-4 py-2 text-sm text-gray-500">
        Pick a customer, then drag the pin onto his lid.
      </p>
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
  // What the draft pin is for: nothing, a brand-new customer, or an existing one
  // who has no location yet. One state, not two booleans, so "new" and "for
  // Harold" cannot both be true - that pair is what a duplicate customer would
  // be made of.
  const [placing, setPlacing] = useState(null) // null | {mode:'new'} | {mode:'existing', customerId}
  const [listOpen, setListOpen] = useState(false)
  const [locating, setLocating] = useState(false) // mobile step 1: position pin, no form yet
  // {lat,lng,placed}|null. placed=false means "this is where the pin was put
  // down to start with", which is not a coordinate anybody chose. Saving one of
  // those stamps locationPrecision:'manual' and locationConfirmedAt on the
  // middle of whatever the map happened to be showing, and it then looks like
  // the strongest location this app has. So it is one state, not two: the
  // coordinate and whether a human is behind it cannot drift apart.
  const [draftPin, setDraftPin] = useState(null)
  const [draftType, setDraftType] = useState(null) // 'residential'|'commercial'|null
  const [draftName, setDraftName] = useState('')
  const [draftAddress, setDraftAddress] = useState('')
  const [toast, setToast] = useState(null)
  const mapRef = useRef(null)
  const wrapperRef = useRef(null)
  const viewRef = useRef(initialView)
  const selected = customers.find((c) => c.id === selectedId)
  // Only customers with a real location get a pin. The rest are listed behind
  // the legend; nothing here invents a coordinate to draw.
  const located = customers.filter(hasLocation)
  const needsPin = customersNeedingPin(customers)
  // Resolved from the live list rather than copied into state, so the panel and
  // the banner always name the customer the pin is actually going to.
  const placingCustomer =
    placing?.mode === 'existing'
      ? customers.find((c) => c.id === placing.customerId)
      : null
  const placingPin = placing?.mode === 'new' || !!placingCustomer
  const isTouch = window.matchMedia('(pointer: coarse)').matches
  // Mobile-only "locate" step: full map + draggable pin, form not yet shown.
  const mobileLocate = isTouch && placingPin && locating
  const sheetOpen = !!selected || (placingPin && !mobileLocate)
  const showList = listOpen && needsPin.length > 0 && !placingPin
  // Nothing is saved off a pin nobody moved.
  const pinPlaced = !!draftPin && draftPin.placed

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(t)
  }, [toast])

  // Both entry points start the same way: a draft pin at the middle of what he
  // is looking at, everything else cleared, the map to itself. That starting
  // coordinate is a convenience, never an answer - Save stays disabled until the
  // pin is dragged or the lid is tapped.
  function beginPlacing(next) {
    const map = mapRef.current
    // A flyTo from "add customer" can still be in the air. Its centre is a
    // moving target: a pin seeded from it is left behind by the rest of the
    // animation and ends up off-screen. Freeze the map where he can see it, and
    // give the target back - he interrupted the flight on purpose, so nothing
    // should fly to it later. FlyToTarget's own contract is untouched: it is
    // still the only thing that flies, and it still consumes on arrival.
    map.stop()
    onFlyConsumed()
    const existing =
      next.mode === 'existing' ? customers.find((c) => c.id === next.customerId) : null
    // He may already have a pin that is simply not trustworthy (a town or road
    // centroid). Start from it rather than from wherever the map is: the job is
    // to move that pin onto the lid, not to find the property all over again.
    // No animation - getCenter below must read the view he is actually given.
    if (existing && hasLocation(existing)) {
      map.setView([existing.lat, existing.lng], zoomForPrecision(existing.locationPrecision), {
        animate: false,
      })
    }
    const c = map.getCenter()
    setDraftPin({ lat: c.lat, lng: c.lng, placed: false })
    setDraftType(null)
    setDraftName('')
    setDraftAddress('')
    setSelectedId(null) // close any open customer card
    setListOpen(false)
    setPlacing(next)
    // On touch devices start in the locate step (map only, no form); on
    // desktop the side panel shows immediately as before.
    setLocating(isTouch)
  }

  function resetDraft() {
    setPlacing(null)
    setLocating(false)
    setDraftPin(null)
    setDraftType(null)
    setDraftName('')
    setDraftAddress('')
  }

  // Placing the first pin for someone who already exists. This is an update and
  // only an update: it touches his coordinates and nothing else.
  function savePlacedPin() {
    onUpdateCustomer(placingCustomer.id, manualLocationPatch(draftPin))
    setToast(`Lid pinned for ${placingCustomer.name}`)
    resetDraft()
  }

  function savePin() {
    onAddCustomer({
      name: draftName,
      address: draftAddress,
      phone: '',
      email: '',
      // Placed by hand on the satellite image, which is the strongest signal
      // this app has about where a lid actually is.
      ...manualLocationPatch(draftPin),
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
          <PlacementClicks active={placingPin} onPlace={setDraftPin} />
          {/* While placing a pin FOR someone, his own pin is not drawn: it sits
              under the blue draft pin at the coordinate being replaced, and two
              pins on one spot read as two customers. */}
          {located
            .filter((c) => c.id !== placing?.customerId)
            .map((c) => (
            <Marker
              key={c.id}
              position={[c.lat, c.lng]}
              icon={
                needsPinConfirmation(c) ? UNCONFIRMED_ICONS[dueStatus(c)] : ICONS[dueStatus(c)]
              }
              draggable={!isTouch || selectedId === c.id}
              eventHandlers={{
                click: () => setSelectedId(c.id),
                dragend: (e) => {
                  const ll = e.target.getLatLng()
                  // A human just put this pin where the lid is. That outranks any
                  // geocoder guess, so record it as such.
                  onUpdateCustomer(c.id, manualLocationPatch({ lat: ll.lat, lng: ll.lng }))
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
                  setDraftPin({ lat: ll.lat, lng: ll.lng, placed: true })
                },
              }}
            />
          )}
        </MapContainer>
        {!(placingPin && isTouch) &&
          (showList ? (
            <NeedsPinList
              customers={needsPin}
              onPick={(c) => beginPlacing({ mode: 'existing', customerId: c.id })}
              onClose={() => setListOpen(false)}
              hiddenOnMobile={sheetOpen}
            />
          ) : (
            <Legend
              located={located}
              needsPinCount={needsPin.length}
              onShowNeedsPin={() => setListOpen(true)}
              hiddenOnMobile={sheetOpen}
            />
          ))}
        {/* Whose pin is this? The banner answers that for the whole placement,
            including the mobile step where no panel is on screen. */}
        {(mobileLocate || (placingPin && !isTouch)) && (
          <div className="absolute top-3 left-1/2 z-[1100] max-w-[calc(100vw-1.5rem)] -translate-x-1/2 rounded-2xl bg-gray-900 px-4 py-2 text-center text-sm font-semibold text-white shadow-lg">
            {placingCustomer ? (
              <>
                <div className="text-base">Placing pin for {placingCustomer.name}</div>
                {placingCustomer.address && (
                  <div className="font-normal text-gray-300">
                    {placingCustomer.address}
                  </div>
                )}
                <div className="font-normal">
                  Tap his lid, or drag the blue pin onto it, then save.
                </div>
              </>
            ) : mobileLocate ? (
              'Tap the lid, or drag the pin onto it'
            ) : (
              'Tap the lid, or drag the blue pin onto it, then pick a service type below.'
            )}
          </div>
        )}
        {/* Disabled until the pin is on the lid, and it says so. This step exists
            for exactly one purpose; tapping through it would carry the middle of
            the map into the next step as if it had been chosen. */}
        {mobileLocate && (
          <button
            onClick={() => setLocating(false)}
            disabled={!pinPlaced}
            className="fixed inset-x-0 bottom-0 z-[1200] w-full bg-blue-700 py-4 text-lg font-bold text-white disabled:bg-gray-400"
          >
            {pinPlaced ? 'Next →' : 'Tap the lid to place the pin'}
          </button>
        )}
        {!placingPin && !selected && (
          <button
            onClick={() => beginPlacing({ mode: 'new' })}
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
      {/* Two panels, one entry point each, and the one reached from "No pin yet"
          is not wired to onAddCustomer at all. That is why placing a pin for an
          existing customer cannot produce a second copy of him. */}
      {placingCustomer && !mobileLocate && (
        <PlaceLidPanel
          customer={placingCustomer}
          pinPlaced={pinPlaced}
          onConfirm={savePlacedPin}
          onCancel={resetDraft}
        />
      )}
      {placing?.mode === 'new' && !mobileLocate && (
        <NewLidPanel
          draftType={draftType}
          onPickType={setDraftType}
          name={draftName}
          onName={setDraftName}
          address={draftAddress}
          onAddress={setDraftAddress}
          pinPlaced={pinPlaced}
          canSave={draftName.trim() !== '' && draftType !== null && pinPlaced}
          onSave={savePin}
          onCancel={resetDraft}
        />
      )}
      {toast && <Toast message={toast} />}
    </div>
  )
}
