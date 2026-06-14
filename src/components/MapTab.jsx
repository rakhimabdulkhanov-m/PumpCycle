import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, LayersControl } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { dueStatus } from '../lib/dates.js'
import CustomerCard from './CustomerCard.jsx'

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

export default function MapTab({ customers, onUpdateCustomer }) {
  const [selectedId, setSelectedId] = useState(null)
  const mapRef = useRef(null)
  const wrapperRef = useRef(null)
  const selected = customers.find((c) => c.id === selectedId)

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
  }, [selectedId])

  return (
    <div className="relative h-full">
      <div
        ref={wrapperRef}
        className={
          'absolute inset-x-0 top-0 ' +
          (selected ? 'bottom-[min(75dvh,calc(100%-6rem))] sm:bottom-0' : 'bottom-0')
        }
      >
        <MapContainer
          ref={mapRef}
          center={[35.28, -81.17]}
          zoom={11}
          className="h-full w-full"
          scrollWheelZoom
        >
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
          {customers.map((c) => (
            <Marker
              key={c.id}
              position={[c.lat, c.lng]}
              icon={ICONS[dueStatus(c)]}
              eventHandlers={{ click: () => setSelectedId(c.id) }}
            />
          ))}
        </MapContainer>
        <Legend customers={customers} hiddenOnMobile={!!selected} />
      </div>
      {selected && (
        <CustomerCard
          customer={selected}
          onClose={() => setSelectedId(null)}
          onUpdate={(patch) => onUpdateCustomer(selected.id, patch)}
        />
      )}
    </div>
  )
}
