import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, LayersControl, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { dueStatus, todayISO } from '../lib/dates.js'
import { hasLocation } from '../lib/point.js'
import { useDismissLayer } from '../lib/dismissLayer.js'
import {
  customersNeedingPin,
  manualLocationPatch,
  needsPinConfirmation,
  pinConfirmCase,
  pinSnapshot,
  placementSaveBlock,
  placementView,
  PLACEMENT_MOVE_METERS,
} from '../lib/location.js'
import {
  clusterGrid,
  MAP_STATUS_COLORS,
  pointsInPaddedBounds,
  visibleScalePoints,
} from '../lib/mapScale.js'
import CustomerCard from './CustomerCard.jsx'
import NewLidPanel from './NewLidPanel.jsx'
import PinPlacer from './PinPlacer.jsx'

/**
 * hollow = this pin is not settled yet (see pinConfirmCase): a town or road
 * level geocode nobody has moved onto the lid. Same colour, so the due status
 * still reads at a glance; outline instead of a solid body, so "we are not sure
 * this is the yard" is visible on the map and not only in a list.
 */
function makeIcon(color, { hollow = false, status = 'draft', demoted = false } = {}) {
  const svg = `
    <svg width="30" height="42" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg">
      <path d="M15 1 C7.3 1 1 7.4 1 15.3 C1 25.5 15 41 15 41 C15 41 29 25.5 29 15.3 C29 7.4 22.7 1 15 1 Z"
        fill="${hollow ? 'white' : color}" stroke="${hollow ? color : 'white'}" stroke-width="${hollow ? 3 : 2}"
        opacity="${demoted ? 0.58 : 1}"
        ${hollow ? 'stroke-dasharray="5 3"' : ''}/>
      <circle cx="15" cy="15" r="5" fill="${hollow ? color : 'white'}"/>
    </svg>`
  return L.divIcon({
    html: `<span style="display:flex;width:44px;height:44px;justify-content:center;align-items:flex-start">${svg}</span>`,
    className:
      `map-customer-marker map-customer-marker--${status} ` +
      (hollow ? 'pin-unconfirmed' : ''),
    iconSize: [44, 44],
    iconAnchor: [22, 42],
  })
}

const ICONS = {
  overdue: makeIcon(MAP_STATUS_COLORS.overdue, { status: 'overdue' }),
  'due-soon': makeIcon(MAP_STATUS_COLORS['due-soon'], { status: 'due-soon' }),
  ok: makeIcon(MAP_STATUS_COLORS.ok, { status: 'ok', demoted: true }),
}

const UNCONFIRMED_ICONS = {
  overdue: makeIcon(MAP_STATUS_COLORS.overdue, { hollow: true, status: 'overdue' }),
  'due-soon': makeIcon(MAP_STATUS_COLORS['due-soon'], {
    hollow: true,
    status: 'due-soon',
  }),
  ok: makeIcon(MAP_STATUS_COLORS.ok, { hollow: true, status: 'ok', demoted: true }),
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
const DRAFT_ICON = L.divIcon({
  ...makeIcon('#2563eb').options,
  className: 'map-draft-marker',
})

const USER_POSITION_ICON = L.divIcon({
  html: `<div style="position:relative;width:24px;height:24px;display:flex;align-items:center;justify-content:center">
    <span style="position:absolute;width:24px;height:24px;border-radius:9999px;background-color:#3b82f6;opacity:0.4;animation:ping 1.5s cubic-bezier(0,0,0.2,1) infinite;"></span>
    <span style="width:14px;height:14px;border-radius:9999px;background-color:#1d4ed8;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.3);"></span>
  </div>`,
  className: 'user-gps-marker',
  iconSize: [24, 24],
  iconAnchor: [12, 12],
})

// Anything past this is a different part of the country, not the next street:
// flying it takes 8-10 s of swooping, so jump there instead.
const FLY_MAX_METERS = 50000

// Long enough to notice the toast, read it and reach for it one-handed in a
// truck; short enough that it is gone before the next thing he does.
const UNDO_MS = 10000

// App owns the intent, so tab switches cannot lose it. Map consumes a `show`
// only after arriving and opening the exact card; `place` only after the exact
// placement session has begun. The live customer is resolved again here, so a
// coordinate removed during the transition is never reused from stale state.
function NavigationTarget({ intent, customer, onShow, onPlace }) {
  const map = useMap()
  useEffect(() => {
    if (!intent || !customer) return
    if (intent.kind === 'place') {
      onPlace(intent)
      return
    }
    if (!hasLocation(customer)) {
      map.stop()
      onShow(intent)
      return
    }
    const to = [customer.lat, customer.lng]
    const settled = () => {
      if (map.getCenter().distanceTo(to) < 1) onShow(intent)
    }
    map.on('moveend', settled)
    if (map.distance(map.getCenter(), to) > FLY_MAX_METERS) map.setView(to, 19)
    else map.flyTo(to, 19)
    return () => map.off('moveend', settled)
  }, [intent, customer, customer?.lat, customer?.lng, map, onShow, onPlace])
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
 *
 * `zoomend` keeps the session's idea of how close he is standing in step with
 * the map, because how close he is standing is half of whether Save is a claim
 * he can make (see placementSaveBlock). Both events report it: a wheel zoom
 * fires zoomend, and a pinch or a keyboard +/- can settle through moveend alone.
 */
function PlacementMap({ active, origin, onMoved, onZoom }) {
  const map = useMapEvents({
    click: (e) => {
      if (active) map.panTo(e.latlng)
    },
    zoomend: () => {
      if (active) onZoom(map.getZoom())
    },
    moveend: () => {
      if (!active || !origin) return
      onZoom(map.getZoom())
      if (map.getCenter().distanceTo(origin) > PLACEMENT_MOVE_METERS) onMoved()
    },
  })
  return null
}

function makeScaleRenderer() {
  const CountCanvas = L.Canvas.extend({
    _updateCircle(layer) {
      L.Canvas.prototype._updateCircle.call(this, layer)
      if (!this._drawing || layer._empty() || layer.options.clusterCount === undefined) return
      const label = String(layer.options.clusterCount)
      const context = this._ctx
      context.save()
      context.fillStyle = 'white'
      context.font = `700 ${label.length > 3 ? 11 : 14}px system-ui, sans-serif`
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(label, layer._point.x, layer._point.y + 0.5)
      context.restore()
    },
  })
  return new CountCanvas({ padding: 0.5, tolerance: 16 })
}

function mapBoundsSnapshot(map) {
  const bounds = map.getBounds()
  return {
    south: bounds.getSouth(),
    west: bounds.getWest(),
    north: bounds.getNorth(),
    east: bounds.getEast(),
  }
}

function zoomIntoCluster(map, cluster) {
  const bounds = L.latLngBounds(
    [cluster.bounds.south, cluster.bounds.west],
    [cluster.bounds.north, cluster.bounds.east]
  )
  let nextZoom = 13
  if (cluster.count > 1) {
    const boundsZoom = map.getBoundsZoom(bounds.pad(0.2), false, L.point(48, 48))
    if (Number.isFinite(boundsZoom)) {
      nextZoom = Math.min(13, Math.max(map.getZoom() + 1, boundsZoom))
    }
  }
  map.setView(bounds.getCenter(), nextZoom)
}

/**
 * One imperative owner for every customer visual. React does not reconcile a
 * thousand children on map movement: Leaflet moves one canvas at low/mid zoom,
 * and only the padded local high-zoom subset becomes exact DOM teardrops.
 */
function ScaleMarkers({ points, statusVisibility, directCustomerId, placing, onSelect }) {
  const map = useMap()
  const latest = useRef({ points, statusVisibility, directCustomerId, placing, onSelect })
  const refresh = useRef(null)

  useEffect(() => {
    const renderer = makeScaleRenderer().addTo(map)
    const canvasLayers = L.layerGroup().addTo(map)
    const domLayers = L.layerGroup().addTo(map)
    const container = map.getContainer()
    let frame = null

    const render = () => {
      frame = null
      canvasLayers.clearLayers()
      domLayers.clearLayers()

      const current = latest.current
      const zoom = map.getZoom()
      const visible = visibleScalePoints(
        current.points,
        current.statusVisibility,
        current.directCustomerId
      )
      let visualCount
      let pointCount = visible.length
      let mode = 'clusters'

      if (zoom <= 12) {
        const clusters = clusterGrid(
          visible,
          (point) => map.project([point.lat, point.lng], zoom),
          72
        )
        visualCount = clusters.length
        for (const cluster of clusters) {
          const latLng = map.unproject(cluster.point, zoom)
          const radius = Math.min(30, 22 + Math.log10(Math.max(1, cluster.count)) * 4)
          const circle = L.circleMarker(latLng, {
            renderer,
            radius,
            color: 'white',
            weight: 2,
            fillColor: cluster.color,
            fillOpacity: cluster.status === 'ok' ? 0.65 : 0.92,
            interactive: !current.placing,
            clusterCount: cluster.count,
          })
          if (!current.placing) circle.on('click', () => zoomIntoCluster(map, cluster))
          canvasLayers.addLayer(circle)
        }
      } else if (zoom <= 15) {
        mode = 'points'
        visualCount = visible.length
        const drawOrder = { ok: 0, 'due-soon': 1, overdue: 2 }
        const ordered = [...visible].sort((a, b) => drawOrder[a.status] - drawOrder[b.status])
        for (const point of ordered) {
          const unsettled = point.unconfirmed
          const circle = L.circleMarker([point.lat, point.lng], {
            renderer,
            radius: 10,
            color: unsettled ? MAP_STATUS_COLORS[point.status] : 'white',
            weight: unsettled ? 3 : 2.5,
            dashArray: unsettled ? '4 3' : undefined,
            fillColor: unsettled ? 'white' : MAP_STATUS_COLORS[point.status],
            fillOpacity: 1.0,
            opacity: 1.0,
            interactive: !current.placing,
          })
          if (!current.placing) circle.on('click', () => current.onSelect(point.id))
          canvasLayers.addLayer(circle)
        }
      } else {
        mode = 'pins'
        const local = pointsInPaddedBounds(
          visible,
          mapBoundsSnapshot(map),
          0.25,
          current.directCustomerId
        )
        pointCount = local.length
        visualCount = local.length
        for (const point of local) {
          const marker = L.marker([point.lat, point.lng], {
            icon: point.unconfirmed ? UNCONFIRMED_ICONS[point.status] : ICONS[point.status],
            interactive: !current.placing,
            keyboard: !current.placing,
            title: point.name,
          })
          if (!current.placing) marker.on('click', () => current.onSelect(point.id))
          marker.on('add', () => {
            const element = marker.getElement()
            if (element) element.dataset.customerId = String(point.id)
          })
          domLayers.addLayer(marker)
        }
      }

      container.dataset.mapScaleMode = mode
      container.dataset.mapScaleEligibleCount = String(visible.length)
      container.dataset.mapScaleRenderedPointCount = String(pointCount)
      container.dataset.mapScaleVisualCount = String(visualCount)
      container.dataset.mapScaleDomMarkerCount = String(domLayers.getLayers().length)
    }

    const schedule = () => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(render)
    }
    refresh.current = schedule
    map.on('moveend zoomend', schedule)
    render()

    return () => {
      refresh.current = null
      map.off('moveend zoomend', schedule)
      if (frame !== null) cancelAnimationFrame(frame)
      canvasLayers.remove()
      domLayers.remove()
      renderer.remove()
      delete container.dataset.mapScaleMode
      delete container.dataset.mapScaleEligibleCount
      delete container.dataset.mapScaleRenderedPointCount
      delete container.dataset.mapScaleVisualCount
      delete container.dataset.mapScaleDomMarkerCount
    }
  }, [map])

  useEffect(() => {
    latest.current = { points, statusVisibility, directCustomerId, placing, onSelect }
    refresh.current?.()
  }, [points, statusVisibility, directCustomerId, placing, onSelect])

  return null
}

// The undo line is deliberately part of the toast rather than a promise the app
// keeps somewhere else. The write is already saved; the undo is a courtesy that
// lives as long as this box does, and anything that dismisses the box - the ten
// seconds running out, or leaving the Map tab - ends it. Saying so is cheaper
// and more honest than carrying a pending undo across tabs, which would mean an
// operator on the Due list holding an invisible ten-second window over a
// customer he can no longer see.
function Toast({ message, actionLabel, onAction, busy }) {
  return (
    <div className="fixed right-3 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] left-3 z-[1300] flex items-center gap-3 rounded-lg bg-gray-900 px-3 py-3 text-lg font-medium text-white shadow-xl sm:right-auto sm:left-1/2 sm:max-w-[min(36rem,calc(100vw-3rem))] sm:-translate-x-1/2 sm:px-5">
      <span className="min-w-0 flex-1 leading-snug [overflow-wrap:anywhere]">
        {message}
        {onAction && (
          <span className="block text-sm font-normal text-gray-300">
            Saved. Undo only while this is showing.
          </span>
        )}
      </span>
      {onAction && (
        <button
          type="button"
          onClick={onAction}
          disabled={busy}
          className="min-h-[3.25rem] shrink-0 rounded-lg bg-white px-5 py-2 text-xl font-bold text-gray-900 disabled:opacity-60"
        >
          {busy ? 'Undoing...' : actionLabel}
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
function Legend({
  located,
  statusVisibility,
  onToggleStatus,
  needsPinCount,
  onShowNeedsPin,
  hiddenOnMobile,
}) {
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
      {rows.map(([status, label]) => {
        const active = statusVisibility[status]
        return (
          <button
            key={status}
            type="button"
            aria-pressed={active}
            onClick={() => onToggleStatus(status)}
            className={
              'flex min-h-11 w-full items-center gap-2 rounded px-1 text-left transition-opacity ' +
              (status === 'ok' ? 'opacity-65 ' : '') +
              (!active ? 'line-through opacity-35' : '')
            }
          >
            <span
              className="inline-block h-4 w-4 rounded-full border-2 border-white shadow"
              style={{ backgroundColor: active ? MAP_STATUS_COLORS[status] : '#9ca3af' }}
            />
            <span className="text-base font-semibold text-gray-900">
              {label} ({counts[status]})
            </span>
          </button>
        )
      })}
      {needsPinCount > 0 && (
        <button
          type="button"
          onClick={onShowNeedsPin}
          className="mt-1 flex min-h-11 w-full items-center gap-2 border-t border-gray-200 px-1 py-1.5 text-left"
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
          className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-3xl leading-none text-gray-400 hover:bg-gray-100 hover:text-gray-600"
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
  visits = [],
  photos = [],
  onUpdateCustomer,
  onMarkPumped,
  onRecordVisit,
  onUpdateVisit,
  onArchiveVisit,
  onRecordPhoto,
  onArchivePhoto,
  onSetPin,
  onRestorePin,
  onAddCustomer,
  navigationIntent,
  onNavigationConsumed,
  statusVisibility,
  onStatusVisibilityChange,
  initialView,
  onLeaveView,
}) {
  const [selectedId, setSelectedId] = useState(null)
  // The placement session, or null. One state, not a set of booleans, so "a new
  // customer" and "for Harold" cannot both be true - that pair is what a
  // duplicate customer would be made of.
  //
  //   {mode:'new'|'existing', customerId?, origin:{lat,lng}, confirmable, moved,
  //    zoom, returnTo:{center,zoom}}
  //
  // confirmable: the map opened on a coordinate somebody already stands behind,
  // so Save alone is a meaningful answer. moved: the map has since moved off it.
  // zoom: how close he is standing right now. Between them they are the whole
  // rule for whether Save is a claim about a lid or about wherever the map
  // happened to be pointing from however far away.
  const [placing, setPlacing] = useState(null)
  const [listOpen, setListOpen] = useState(false)
  // The spot the crosshair was on when a NEW customer's placement was accepted,
  // held while his name and service type are typed. For an existing customer
  // there is no such gap: Save writes.
  const [newPoint, setNewPoint] = useState(null)
  const [draftType, setDraftType] = useState('residential') // 'residential'|'commercial'
  const [draftName, setDraftName] = useState('')
  const [draftPhone, setDraftPhone] = useState('')
  const [draftAddress, setDraftAddress] = useState('')
  // {message} | {message, undo:{id, patch}} - the undo carries VALUES, not a
  // closure over the state at save time, so pressing it ten seconds later
  // reverts the pin and nothing else that happened in between.
  const [toast, setToast] = useState(null)
  const [writeBusy, setWriteBusy] = useState(false)
  const [userLocation, setUserLocation] = useState(null)
  const [locating, setLocating] = useState(false)
  const mapRef = useRef(null)
  const satelliteRef = useRef(null)
  const streetRef = useRef(null)
  const wrapperRef = useRef(null)
  const viewRef = useRef(initialView)
  const selected = customers.find((c) => c.id === selectedId)
  const navigationCustomer = navigationIntent
    ? customers.find((c) => c.id === navigationIntent.customerId)
    : null
  // Only customers with a real location get a pin. The rest are listed behind
  // the legend; nothing here invents a coordinate to draw.
  const located = useMemo(() => customers.filter(hasLocation), [customers])
  const needsPin = useMemo(() => customersNeedingPin(customers), [customers])
  const scalePoints = useMemo(
    () =>
      located.map((customer) => ({
        id: customer.id,
        name: customer.name,
        lat: customer.lat,
        lng: customer.lng,
        status: dueStatus(customer),
        unconfirmed: needsPinConfirmation(customer),
      })),
    [located]
  )
  const directCustomerId = selectedId ?? navigationIntent?.customerId ?? null
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

  const selectCustomer = useCallback((customerId) => setSelectedId(customerId), [])
  const toggleStatus = useCallback((status) => {
    onStatusVisibilityChange((current) => ({ ...current, [status]: !current[status] }))
  }, [onStatusVisibilityChange])

  const locateUser = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setToast({ message: 'GPS location is not supported on this device' })
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false)
        const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        setUserLocation(coords)
        mapRef.current?.flyTo([coords.lat, coords.lng], 18)
      },
      (err) => {
        setLocating(false)
        setToast({ message: err.message || 'Could not acquire GPS position' })
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    )
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.undo ? UNDO_MS : 2500)
    return () => clearTimeout(t)
  }, [toast])

  // A lid is only visible in imagery, so placement mode takes him to imagery.
  // Once. If he switches to the street map himself while placing - to read a
  // house number, which is a real thing he does - nothing switches him back.
  const showSatellite = useCallback((map) => {
    const sat = satelliteRef.current
    const street = streetRef.current
    if (!sat || map.hasLayer(sat)) return
    if (street && map.hasLayer(street)) map.removeLayer(street)
    map.addLayer(sat)
  }, [])

  // The one entrance to moving a pin. Both callers are explicit, named acts: the
  // FAB for a new lid, and "Move pin" / "Place pin" on a customer's own card.
  // Nothing on the map itself can start this.
  const beginPlacing = useCallback((next, consumedIntent = navigationIntent) => {
    const map = mapRef.current
    // A show-on-map flight can still be in the air when the operator deliberately
    // starts another placement. Freeze it before taking the current view.
    map.stop()
    const existing =
      next.mode === 'existing' ? customers.find((c) => c.id === next.customerId) : null
    if (next.mode === 'existing' && !existing) return
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
    setDraftType('residential')
    setDraftName('')
    setDraftPhone('')
    setDraftAddress('')
    setPlacing({
      ...next,
      origin: { lat: view.center[0], lng: view.center[1] },
      confirmable: view.confirmable,
      moved: false,
      zoom: view.zoom,
      returnTo,
    })
    if (consumedIntent) onNavigationConsumed(consumedIntent)
  }, [customers, navigationIntent, onNavigationConsumed, showSatellite])

  const showNavigation = useCallback((intent) => {
    setSelectedId(intent.customerId)
    onNavigationConsumed(intent)
  }, [onNavigationConsumed])

  const placeNavigation = useCallback((intent) => {
    beginPlacing({ mode: 'existing', customerId: intent.customerId }, intent)
  }, [beginPlacing])

  function resetPlacing() {
    setPlacing(null)
    setNewPoint(null)
    setDraftType('residential')
    setDraftName('')
    setDraftPhone('')
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

  // Back out of an aiming session the way Cancel does - writing nothing and
  // putting the view back - rather than out of the app.
  useDismissLayer(!!placing, cancelPlacing)

  const crosshairPoint = () => {
    const c = mapRef.current.getCenter()
    return { lat: c.lat, lng: c.lng }
  }

  // Moving (or first placing) the pin of a customer who already exists. This is
  // an update and only an update: it touches his coordinates and nothing else -
  // and it is reversible for ten seconds, because the operator who is afraid of
  // breaking his own book is the one who never touches the map at all.
  async function savePlacedPin() {
    if (writeBusy) return
    const c = placingCustomer
    const before = pinSnapshot(c)
    setWriteBusy(true)
    try {
      await onSetPin(c.id, crosshairPoint())
      setToast({ message: `Pin saved for ${c.name}`, undo: { id: c.id, patch: before } })
      // Stay where he is looking: the pin he just placed is under the crosshair.
      resetPlacing()
    } catch {
      setToast({ message: 'Could not save the pin. Try again.' })
    } finally {
      setWriteBusy(false)
    }
  }

  async function undoPin() {
    if (writeBusy || !toast?.undo) return
    const undo = toast.undo
    setWriteBusy(true)
    try {
      await onRestorePin(undo.id, undo.patch)
      setToast({ message: 'Pin put back' })
    } catch {
      setToast({ message: 'Could not undo the pin. Try again.', undo })
    } finally {
      setWriteBusy(false)
    }
  }

  async function saveNewCustomer() {
    if (writeBusy) return
    setWriteBusy(true)
    try {
      await onAddCustomer({
        name: draftName.trim(),
        address: draftAddress.trim(),
        phone: draftPhone.trim(),
        email: '',
        // Aimed at by hand on the satellite image, which is the strongest signal
        // this app has about where a lid actually is.
        ...manualLocationPatch(newPoint),
        tankSizeGal: 1000,
        lastPumped: todayISO(),
        cycleMonths: draftType === 'commercial' ? 3 : 36,
        notes: '',
      })
      setToast({ message: `Lid pinned for ${draftName.trim()}` })
      resetPlacing()
    } catch {
      setToast({ message: 'Could not save this customer. Try again.' })
    } finally {
      setWriteBusy(false)
    }
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
          maxZoom={21}
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
          <NavigationTarget
            intent={navigationIntent}
            customer={navigationCustomer}
            onShow={showNavigation}
            onPlace={placeNavigation}
          />
          <LayersControl position="topright">
            <LayersControl.BaseLayer checked name="Satellite">
              <TileLayer
                ref={satelliteRef}
                key="satellite"
                url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                attribution="Tiles &copy; Esri"
                maxNativeZoom={19}
                maxZoom={21}
              />
            </LayersControl.BaseLayer>
            <LayersControl.BaseLayer name="Map">
              <TileLayer
                ref={streetRef}
                key="street"
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                maxNativeZoom={19}
                maxZoom={21}
              />
            </LayersControl.BaseLayer>
          </LayersControl>
          <PlacementMap
            active={aiming}
            origin={placing?.origin}
            onMoved={() => setPlacing((p) => (p && !p.moved ? { ...p, moved: true } : p))}
            onZoom={(z) => setPlacing((p) => (p && p.zoom !== z ? { ...p, zoom: z } : p))}
          />
          {/* Customer visuals are scenery while aiming. The scale owner keeps
              them non-interactive then, so a tap reaches PlacementMap and pans
              the crosshair instead of opening a card. */}
          <ScaleMarkers
            points={scalePoints}
            statusVisibility={statusVisibility}
            directCustomerId={directCustomerId}
            placing={!!placing}
            onSelect={selectCustomer}
          />
          {naming && (
            <Marker position={[newPoint.lat, newPoint.lng]} icon={DRAFT_ICON} interactive={false} />
          )}
          {userLocation && (
            <Marker position={[userLocation.lat, userLocation.lng]} icon={USER_POSITION_ICON} interactive={false} />
          )}
        </MapContainer>
        {!placing && (
          <button
            type="button"
            onClick={locateUser}
            disabled={locating}
            title="Locate my position (GPS)"
            aria-label="Locate my position (GPS)"
            className={
              'absolute top-14 right-2.5 z-[1000] flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-gray-300 bg-white p-2.5 shadow-md hover:bg-gray-50 disabled:opacity-50 ' +
              (locating ? 'text-blue-600' : 'text-gray-700')
            }
          >
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="7" strokeWidth="2" />
              <circle cx="12" cy="12" r="2" fill="currentColor" />
              <path strokeWidth="2" strokeLinecap="round" d="M12 2v3m0 14v3M2 12h3m14 0h3" />
            </svg>
          </button>
        )}
        {!placing &&
          (showList ? (
            <NeedsPinList
              customers={needsPin}
              onPick={(c) => beginPlacing({ mode: 'existing', customerId: c.id })}
              onClose={() => setListOpen(false)}
              hiddenOnMobile={sheetOpen || !!toast}
            />
          ) : (
            <Legend
              located={located}
              statusVisibility={statusVisibility}
              onToggleStatus={toggleStatus}
              needsPinCount={needsPin.length}
              onShowNeedsPin={() => setListOpen(true)}
              hiddenOnMobile={sheetOpen || !!toast}
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
            blocked={placementSaveBlock(placing)}
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
            className={
              'absolute bottom-6 right-3 z-[1100] rounded-2xl bg-blue-700 px-5 py-3 text-base font-bold text-white shadow-lg hover:bg-blue-800 ' +
              (toast ? 'hidden sm:block' : '')
            }
          >
            + Drop lid pin
          </button>
        )}
      </div>
      {selected && !placing && (
        <CustomerCard
          key={selected.id}
          customer={selected}
          visits={visits}
          photos={photos}
          onClose={() => setSelectedId(null)}
          onUpdate={(patch) => onUpdateCustomer(selected.id, patch)}
          onMarkPumped={() => onMarkPumped(selected.id)}
          onRecordVisit={onRecordVisit}
          onUpdateVisit={onUpdateVisit}
          onArchiveVisit={onArchiveVisit}
          onRecordPhoto={onRecordPhoto}
          onArchivePhoto={onArchivePhoto}
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
          phone={draftPhone}
          onPhone={setDraftPhone}
          address={draftAddress}
          onAddress={setDraftAddress}
          canSave={draftName.trim() !== ''}
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
          busy={writeBusy}
        />
      )}
    </div>
  )
}
