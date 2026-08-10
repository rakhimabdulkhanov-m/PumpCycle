import { useRef, useState } from 'react'
import { todayISO } from '../lib/dates.js'

const inputCls =
  'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-lg focus:border-blue-600 focus:outline-none'

function Field({ label, children }) {
  return (
    <label className="block py-1.5">
      <span className="text-sm font-medium uppercase tracking-wide text-gray-500">
        {label}
      </span>
      {children}
    </label>
  )
}

// Fallback: place a new pin near Gastonia when no address is geocoded.
function jitteredLocation() {
  return {
    lat: 35.26 + (Math.random() - 0.5) * 0.12,
    lng: -81.18 + (Math.random() - 0.5) * 0.18,
  }
}

// Geocode a US address via Nominatim (no API key, CORS-enabled with access-control-allow-origin: *).
// Returns { lat, lng } on success, null on any failure or timeout.
async function geocodeAddress(address) {
  const params = new URLSearchParams({
    q: address,
    format: 'json',
    limit: '1',
    countrycodes: 'us',
    // Nominatim usage policy: identify the app via email when Referer/User-Agent can't be set.
    email: 'rakhimabdulkhanov@gmail.com',
  })
  const url = `https://nominatim.openstreetmap.org/search?${params}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000) // 4 s hard timeout
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null
    const data = await res.json()
    if (!data.length) return null
    const lat = parseFloat(data[0].lat)
    const lng = parseFloat(data[0].lon)
    // A 200 with a body is not automatically a location: a captive portal, a
    // proxy or a changed upstream shape gives NaN here. A NaN coordinate saved
    // to localStorage becomes null on reload and kills the whole app, so
    // anything that isn't a real point on earth counts as "not found".
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
    return { lat, lng }
  } catch {
    // Covers network errors, AbortError (timeout), and JSON parse failures.
    return null
  } finally {
    clearTimeout(timer)
  }
}

export default function AddCustomerModal({ onAdd, onClose }) {
  const [form, setForm] = useState({
    name: '',
    address: '',
    phone: '',
    email: '',
    tankSizeGal: '1000',
    lastPumped: todayISO(),
    cycleMonths: '36',
    notes: '',
  })
  const [geocoding, setGeocoding] = useState(false)
  // A geocode outcome is always stored together with the address it belongs to:
  // { address, found: bool, lat?, lng? }. Nothing downstream reads it without
  // checking that address against what is in the field right now, so a late
  // answer can never label or locate a different address than it was asked about.
  const [geo, setGeo] = useState(null)
  // Every lookup gets a number; only the newest one is allowed to write state.
  // Editing the address bumps it too, which retires whatever is in flight.
  const requestId = useRef(0)

  const address = form.address.trim()
  const geoForCurrentAddress = geo && geo.address === address ? geo : null

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })

  function handleAddressChange(e) {
    const next = e.target.value
    // Only a genuinely different address invalidates a lookup. Typing a trailing
    // space is not a new address, so it must not throw away a good result, and
    // the binding above already hides a result once the address really changes.
    if (next.trim() !== address) {
      requestId.current++ // retire any in-flight lookup: its answer is now stale
      setGeocoding(false) // ...and re-enable Find for the address being typed
    }
    setForm({ ...form, address: next })
  }

  async function findOnMap() {
    if (!address || geocoding) return
    const id = ++requestId.current
    setGeocoding(true)
    setGeo(null)
    const hit = await geocodeAddress(address)
    if (id !== requestId.current) return // superseded: drop the answer entirely
    setGeocoding(false)
    setGeo(hit ? { address, found: true, ...hit } : { address, found: false })
  }

  function submit(e) {
    e.preventDefault()
    const hit = geoForCurrentAddress?.found ? geoForCurrentAddress : null
    onAdd({
      ...form,
      tankSizeGal: Number(form.tankSizeGal),
      cycleMonths: Number(form.cycleMonths) || 36,
      ...(hit ? { lat: hit.lat, lng: hit.lng } : jitteredLocation()),
      // Signal to App that this pin has a real geocoded location (triggers map fly-to).
      geocoded: !!hit,
      // The lookup ran and missed, so the amber line has just told him to open
      // the Map tab and drag this pin onto the lid. Ask App to park the map on
      // it: after any earlier fly the map still sits at zoom 19 over the
      // previous customer's yard, and the fallback pin lands kilometres
      // off-screen where he can't drag what he can't see.
      revealPin: geoForCurrentAddress?.found === false,
    })
  }

  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        // A stray Enter in a text field used to submit the whole form, saving the
        // customer before the address was ever geocoded. Saving is a deliberate
        // click on "Add customer". Textareas (Notes) keep their newlines, and the
        // address field's own Enter handler still runs "Find" before this fires.
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault()
        }}
        className="flex max-h-full w-full max-w-md flex-col rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-gray-200 p-6 pb-3">
          <h2 className="text-2xl font-bold text-gray-900">Add customer</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-3xl leading-none text-gray-400 hover:text-gray-600"
          >
            &times;
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-6 pt-2">
          <Field label="Name">
            <input className={inputCls} value={form.name} onChange={set('name')} required />
          </Field>

          {/* Address row: input + "Find on map" button side by side */}
          <label className="block py-1.5">
            <span className="text-sm font-medium uppercase tracking-wide text-gray-500">
              Address
            </span>
            <div className="flex gap-2">
              <input
                className={inputCls + ' flex-1'}
                value={form.address}
                onChange={handleAddressChange}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); findOnMap() } }}
                placeholder="Street, City, State"
              />
              <button
                type="button"
                onClick={findOnMap}
                disabled={!address || geocoding}
                className="mt-1 rounded-lg bg-blue-700 px-3 py-2 text-base font-semibold text-white hover:bg-blue-800 disabled:opacity-40"
              >
                {geocoding ? '...' : 'Find'}
              </button>
            </div>
            {geoForCurrentAddress?.found && (
              <p className="mt-1 text-sm font-semibold text-green-700">
                Found — map will fly here on save.
              </p>
            )}
            {geoForCurrentAddress?.found === false && (
              <p className="mt-1 text-sm text-amber-700">
                Address not found. The pin goes near Gastonia. Open the Map tab and drag it
                onto the lid.
              </p>
            )}
          </label>

          <Field label="Phone">
            <input className={inputCls} value={form.phone} onChange={set('phone')} />
          </Field>
          <Field label="Email">
            <input type="email" className={inputCls} value={form.email} onChange={set('email')} />
          </Field>
          <Field label="Tank size (gal)">
            <select className={inputCls} value={form.tankSizeGal} onChange={set('tankSizeGal')}>
              <option value="1000">1,000</option>
              <option value="1250">1,250</option>
              <option value="1500">1,500</option>
            </select>
          </Field>
          <Field label="Last pumped">
            <input
              type="date"
              className={inputCls}
              value={form.lastPumped}
              onChange={set('lastPumped')}
              required
            />
          </Field>
          <Field label="Cycle (months)">
            <input
              type="number"
              min="1"
              className={inputCls}
              value={form.cycleMonths}
              onChange={set('cycleMonths')}
            />
          </Field>
          <Field label="Notes">
            <textarea rows="2" className={inputCls} value={form.notes} onChange={set('notes')} />
          </Field>

          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              className="flex-1 rounded-lg bg-blue-700 px-4 py-3 text-lg font-semibold text-white hover:bg-blue-800"
            >
              Add customer
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border-2 border-gray-300 px-4 py-3 text-lg font-semibold text-gray-700 hover:bg-gray-100"
            >
              Cancel
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
