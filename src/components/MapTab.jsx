import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, LayersControl, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { dueStatus, todayISO } from '../lib/dates.js'
import { hasLocation } from '../lib/storage.js'
import {
  canSavePlacement,
  customersNeedingPin,
  manualLocationPatch,
  needsPinConfirmation,
  pinConfirmCase,
  pinSnapshot,
  placementView,
  PLACEMENT_MOVE_METERS,
} from '../lib/location.js'
import CustomerCard from './CustomerCard.jsx'
import NewLidPanel from './NewLidPanel.jsx'
import PinPlacer from './PinPlacer.jsx'

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

// What the "Needs a pin" list says about each row. Which problem it is decides
// what he does next: no pin means find the property from the address, a town or
// road pin means pan a short way onto the right roof, a changed address means
// the pin is at a house this customer no longer lives at, and an unchecked pin
// means nothing on the record says where the coordinate came from.
const PIN_CASE_LABEL = {
  no_location: 'No pin yet',
  address_changed: 'Address changed - pin not moved',
  locality: 'Town-level pin',
  road: 'Road-level pin',
  no_precision: 'Pin never checked',
}

// Blue draft pin — visually distinct from the red/yellow/green customer pins,
// and the only thing it marks is a spot already aimed at with the crosshair
// while the new customer's name is being typed.
const DRAFT_ICON = makeIcon('#2563eb')

// Anything past this is a different part of the country, not the next street:
// flying it takes 8-10 s of swooping, so jump there instead.
const FLY_MAX_METERS = 50000

// Long enough to notice the toast, read it and reach for it one-handed in a
// truck; short enough that it is gone before the next thing he does.
const UNDO_MS = 10000

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

/**
 * The two map-side halves of placement mode. Lives inside MapContainer because
 * that is where a map instance exists.
 *
 * A click anywhere pans that spot under the crosshair. It is the fast path on a
 * desktop, where a mouse can point at a lid directly and panning across a
 * screen with a trackpad is slow; on a phone the same tap does the same thing
 * and is simply less useful than dragging the map. It is deliberately a PAN and
 * not a placement: the crosshair stays where it is, the answer is still whatever
 * the middle of the screen shows when Save is pressed, and there is exactly one
 * of those.
 *
 * `moveend` is what tells the session the map has actually moved. It is measured
 * against the coordinate placement opened on, not counted as events, so the
 * opening setView, a nudge and a nudge back, or an invalidateSize do not add up
 * to "he aimed at something".
 */
function PlacementMap({ active, origin, onMoved }) {
  const map = useMapEvents({
    click: (e) => {
      if (active) map.panTo(e.latlng)
    },
    moveend: () => {
      if (!active || !origin) return
      if (map.getCenter().distanceTo(origin) > PLACEMENT_MOVE_METERS) onMoved()
    },
  })
  return null
}

function Toast({ message, actionLabel, onAction }) {
  return (
    <div className="fixed bottom-6 left-1/2 z-[1300] flex -translate-x-1/2 items-center gap-4 rounded-lg bg-gray-900 px-5 py-3 text-lg font-medium text-white shadow-xl">
      <span>{message}</span>
      {onAction && (
        <button
          type="button"
          onClick={onAction}
          className="min-h-[3.25rem] rounded-lg bg-white px-5 py-2 text-xl font-bold text-gray-900"
        >
          {actionLabel}
        </button>
      )}
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
        Pick a customer, then line the cross up on his lid.
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
  // The placement session, or null. One state, not a set of booleans, so "a new
  // customer" and "for Harold" cannot both be true - that pair is what a
  // duplicate customer would be made of.
  //
  //   {mode:'new'|'existing', customerId?, origin:{lat,lng}, confirmable, moved,
  //    returnTo:{center,zoom}}
  //
  // confirmable: the map opened on a coordinate somebody already stands behind,
  // so Save alone is a meaningful answer. moved: the map has since moved off it.
  // Between them they are the whole rule for whether Save is a claim about a lid
  // or about wherever the map happened to be pointing.
  const [placing, setPlacing] = useState(null)
  const [listOpen, setListOpen] = useState(false)
  // The spot the crosshair was on when a NEW customer's placement was accepted,
  // held while his name and service type are typed. For an existing customer
  // there is no such gap: Save writes.
  const [newPoint, setNewPoint] = useState(null)
  const [draftType, setDraftType] = useState(null) // 'residential'|'commercial'|null
  const [draftName, setDraftName] = useState('')
  const [draftAddress, setDraftAddress] = useState('')
  // {message} | {message, undo:{id, patch}} - the undo carries VALUES, not a
  // closure over the state at save time, so pressing it ten seconds later
  // reverts the pin and nothing else that happened in between.
  const [toast, setToast] = useState(null)
  const mapRef = useRef(null)
  const satelliteRef = useRef(null)
  const streetRef = useRef(null)
  const wrapperRef = useRef(null)
  const viewRef = useRef(initialView)
  const selected = customers.find((c) => c.id === selectedId)
  // Only customers with a real location get a pin. The rest are listed behind
  // the legend; nothing here invents a coordinate to draw.
  const located = customers.filter(hasLocation)
  const needsPin = customersNeedingPin(customers)
  // Resolved from the live list rather than copied into state, so the banner
  // always names the customer the pin is actually going to.
  const placingCustomer =
    placing?.mode === 'existing'
      ? customers.find((c) => c.id === placing.customerId)
      : null
  // Naming the new customer: the aiming is done, the map is a backdrop again.
  const naming = placing?.mode === 'new' && !!newPoint
  const aiming = !!placing && !naming
  const sheetOpen = !!selected || naming
  const showList = listOpen && needsPin.length > 0 && !placing

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.undo ? UNDO_MS : 2500)
    return () => clearTimeout(t)
  }, [toast])

  // A lid is only visible in imagery, so placement mode takes him to imagery.
  // Once. If he switches to the street map himself while placing - to read a
  // house number, which is a real thing he does - nothing switches him back.
  function showSatellite(map) {
    const sat = satelliteRef.current
    const street = streetRef.current
    if (!sat || map.hasLayer(sat)) return
    if (street && map.hasLayer(street)) map.removeLayer(street)
    map.addLayer(sat)
  }

  // The one entrance to moving a pin. Both callers are explicit, named acts: the
  // FAB for a new lid, and "Move pin" / "Place pin" on a customer's own card.
  // Nothing on the map itself can start this.
  function beginPlacing(next) {
    const map = mapRef.current
    // A flyTo from "add customer" can still be in the air. Its centre is a
    // moving target, and placement is about a fixed one. Freeze the map where he
    // can see it, and give the target back - he interrupted the flight on
    // purpose, so nothing should fly to it later. FlyToTarget's own contract is
    // untouched: it is still the only thing that flies, and it still consumes on
    // arrival.
    map.stop()
    onFlyConsumed()
    const existing =
      next.mode === 'existing' ? customers.find((c) => c.id === next.customerId) : null
    const here = map.getCenter()
    const returnTo = { center: [here.lat, here.lng], zoom: map.getZoom() }
    const view = placementView(existing, returnTo)
    showSatellite(map)
    // No animation: the session's origin has to be the view he is actually
    // given, or the tail of the animation reads as him aiming.
    map.setView(view.center, view.zoom, { animate: false })
    setSelectedId(null) // close any open customer card
    setListOpen(false)
    setNewPoint(null)
    setDraftType(null)
    setDraftName('')
    setDraftAddress('')
    setPlacing({
      ...next,
      origin: { lat: view.center[0], lng: view.center[1] },
      confirmable: view.confirmable,
      moved: false,
      returnTo,
    })
  }

  function resetPlacing() {
    setPlacing(null)
    setNewPoint(null)
    setDraftType(null)
    setDraftName('')
    setDraftAddress('')
  }

  // Cancel writes nothing, so the only thing there is to put back is the view
  // placement took him away from - which it zoomed and switched to satellite
  // without asking. Leaving him at zoom 19 over a stranger's roof after he said
  // no is its own small betrayal.
  function cancelPlacing() {
    if (placing) mapRef.current?.setView(placing.returnTo.center, placing.returnTo.zoom)
    resetPlacing()
  }

  const crosshairPoint = () => {
    const c = mapRef.current.getCenter()
    return { lat: c.lat, lng: c.lng }
  }

  // Moving (or first placing) the pin of a customer who already exists. This is
  // an update and only an update: it touches his coordinates and nothing else -
  // and it is reversible for ten seconds, because the operator who is afraid of
  // breaking his own book is the one who never touches the map at all.
  function savePlacedPin() {
    const c = placingCustomer
    const before = pinSnapshot(c)
    onUpdateCustomer(c.id, manualLocationPatch(crosshairPoint()))
    setToast({ message: `Pin saved for ${c.name}`, undo: { id: c.id, patch: before } })
    // Stay where he is looking: the pin he just placed is under the crosshair.
    resetPlacing()
  }

  function undoPin() {
    onUpdateCustomer(toast.undo.id, toast.undo.patch)
    setToast({ message: 'Pin put back' })
  }

  function saveNewCustomer() {
    onAddCustomer({
      name: draftName,
      address: draftAddress,
      phone: '',
      email: '',
      // Aimed at by hand on the satellite image, which is the strongest signal
      // this app has about where a lid actually is.
      ...manualLocationPatch(newPoint),
      tankSizeGal: 1000,
      lastPumped: todayISO(),
      cycleMonths: draftType === 'residential' ? 36 : 3,
      notes: '',
    })
    setToast({ message: `Lid pinned for ${draftName}` })
    resetPlacing()
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
  }, [selectedId, naming])

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
                ref={satelliteRef}
                key="satellite"
                url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                attribution="Tiles &copy; Esri"
                maxZoom={19}
              />
            </LayersControl.BaseLayer>
            <LayersControl.BaseLayer name="Map">
              <TileLayer
                ref={streetRef}
                key="street"
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              />
            </LayersControl.BaseLayer>
          </LayersControl>
          <PlacementMap
            active={aiming}
            origin={placing?.origin}
            onMoved={() => setPlacing((p) => (p && !p.moved ? { ...p, moved: true } : p))}
          />
          {/* No pin on this map is draggable, in either mode and on either kind
              of screen. A drag and a pan are the same gesture, so a draggable pin
              turns an accidental hand movement into a recorded human placement
              that outranks the geocoder everywhere afterwards. Pins answer a
              click by opening their customer's card, and that is all they do. */}
          {located.map((c) => (
            <Marker
              key={c.id}
              position={[c.lat, c.lng]}
              icon={
                needsPinConfirmation(c) ? UNCONFIRMED_ICONS[dueStatus(c)] : ICONS[dueStatus(c)]
              }
              eventHandlers={{
                click: () => {
                  // While aiming, a pin is scenery: opening a card would bury
                  // the crosshair under a sheet mid-placement.
                  if (!placing) setSelectedId(c.id)
                },
              }}
            />
          ))}
          {naming && (
            <Marker position={[newPoint.lat, newPoint.lng]} icon={DRAFT_ICON} interactive={false} />
          )}
        </MapContainer>
        {!placing &&
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
        {aiming && (
          <PinPlacer
            title={
              placingCustomer
                ? `Placing pin for ${placingCustomer.name}`
                : 'Placing a new lid pin'
            }
            address={placingCustomer?.address}
            canSave={canSavePlacement(placing)}
            saveLabel={placingCustomer ? 'Save pin here' : 'Use this spot'}
            onSave={
              placingCustomer ? savePlacedPin : () => setNewPoint(crosshairPoint())
            }
            onCancel={cancelPlacing}
          />
        )}
        {!placing && !selected && (
          <button
            onClick={() => beginPlacing({ mode: 'new' })}
            className="absolute bottom-6 right-3 z-[1100] rounded-2xl bg-blue-700 px-5 py-3 text-base font-bold text-white shadow-lg hover:bg-blue-800"
          >
            + Drop lid pin
          </button>
        )}
      </div>
      {selected && !placing && (
        <CustomerCard
          customer={selected}
          onClose={() => setSelectedId(null)}
          onUpdate={(patch) => onUpdateCustomer(selected.id, patch)}
          onMovePin={() => beginPlacing({ mode: 'existing', customerId: selected.id })}
        />
      )}
      {/* The only panel wired to onAddCustomer, and it is only reachable from
          the FAB. That is why placing a pin for an existing customer cannot
          produce a second copy of him. */}
      {naming && (
        <NewLidPanel
          draftType={draftType}
          onPickType={setDraftType}
          name={draftName}
          onName={setDraftName}
          address={draftAddress}
          onAddress={setDraftAddress}
          canSave={draftName.trim() !== '' && draftType !== null}
          onSave={saveNewCustomer}
          onBack={() => setNewPoint(null)}
          onCancel={cancelPlacing}
        />
      )}
      {toast && (
        <Toast
          message={toast.message}
          actionLabel="Undo"
          onAction={toast.undo ? undoPin : undefined}
        />
      )}
    </div>
  )
}
