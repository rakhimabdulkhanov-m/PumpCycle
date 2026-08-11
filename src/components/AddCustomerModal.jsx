import { useRef, useState } from 'react'
import { todayISO } from '../lib/dates.js'
import { geocodeAddress } from '../lib/geocode.js'
import { zoomForPrecision } from '../lib/location.js'

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

/**
 * Copy per precision. Road is styled as a SUCCESS: landing on the right road is
 * most of the job when the next step is dragging the pin onto a tank lid anyway.
 * Both road and town are saved AND flagged - the map lists them under "Needs a
 * pin" until someone puts the pin on the lid - so the copy promises exactly that
 * rather than implying the address is finished.
 */
const PRECISION_COPY = {
  house: { good: true, line: '' },
  house_approx: { good: true, line: '' },
  road: {
    good: true,
    line: 'Found the road, not the house. Drag the pin onto the property after saving.',
  },
  locality: {
    good: false,
    line: 'Found the town, not the address. Saved as town-level: it stays under "Needs a pin" on the map until you drop the pin on the lid.',
  },
}

// What happens after Save when there is no location: he lands under "Needs a
// pin" on the map, which is a button that lists him and puts the map into
// placement mode for him. The copy names that button, because "drop the pin on
// the map" used to describe a flow that did not exist.
const NO_PIN_NEXT_STEP = 'Save, then tap "Needs a pin" on the map to place him.'
const MISS_COPY = {
  ungeocodable_po_box: `That is a mailing address, not a street address. ${NO_PIN_NEXT_STEP}`,
  ungeocodable_rural_route: `That is a mailing address, not a street address. ${NO_PIN_NEXT_STEP}`,
  rate_limited: 'Too many address lookups just now. Wait a minute and press Find.',
}
const MISS_DEFAULT = `Couldn't find it. ${NO_PIN_NEXT_STEP}`

const milesFromKm = (km) => Math.round(km * 0.621371)

export default function AddCustomerModal({ onAdd, onClose, mapCenter }) {
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
  // { address, result, suggestions, reason, farOk }. Nothing downstream reads it
  // without checking that address against what is in the field right now, so a
  // late answer can never label or locate a different address than it was asked
  // about.
  const [geo, setGeo] = useState(null)
  // Every lookup gets a number; only the newest one is allowed to write state.
  // Editing the address bumps it too, which retires whatever is in flight.
  const requestId = useRef(0)
  // The lookup that is in the air right now, as {address, promise}, so that a
  // save can wait for the answer it already asked for. Same address-bound shape
  // as `geo`: a promise for one address is never read as an answer about
  // another. Cleared when it settles.
  const pending = useRef(null)
  // Guards the await below. Without it a second click on "Add customer" during
  // that await runs submit twice and saves the customer twice - the modal
  // normally unmounts before a second click can land, and awaiting keeps it up.
  const [submitting, setSubmitting] = useState(false)

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

  /** Resolves to the geo state this lookup produced, or null if it was retired. */
  async function runLookup(forAddress, id) {
    try {
      const res = await geocodeAddress(forAddress, { near: mapCenter })
      if (id !== requestId.current) return null // superseded: drop the answer entirely
      const next = {
        address: forAddress,
        result: res.results[0] || null,
        suggestions: res.suggestions,
        reason: res.reason,
        farOk: false,
      }
      setGeocoding(false)
      setGeo(next)
      return next
    } finally {
      // Nothing is in the air for this id any more. Cleared here rather than off
      // a .finally() on the caller's side, which would leave a second promise
      // around with nobody to catch it.
      if (pending.current && pending.current.id === id) pending.current = null
    }
  }

  /**
   * force=false is the blur path: it must not re-ask for an address that already
   * has an answer, or every click on Cancel would fire another lookup.
   * force=true is the Find button and Enter - an explicit retry.
   */
  function findOnMap({ force = false } = {}) {
    if (!address || geocoding) return
    if (!force && geoForCurrentAddress) return
    const id = ++requestId.current
    setGeocoding(true)
    setGeo(null)
    pending.current = { address, id, promise: runLookup(address, id) }
  }

  function pickSuggestion(s) {
    requestId.current++ // an explicit choice beats anything still in flight
    setGeocoding(false)
    const label = s.label
    setForm({ ...form, address: label })
    setGeo({
      address: label.trim(),
      // A suggestion is a deliberate pick off a list that spells out the county
      // and state, so it is never treated as a surprise long-distance jump.
      result: {
        lat: s.lat,
        lng: s.lng,
        precision: s.precision || 'road',
        matched: label,
        far_from_near: false,
        distance_km: null,
      },
      suggestions: [],
      reason: null,
      farOk: false,
    })
  }

  const g = geoForCurrentAddress
  // A far match is not used until he says so. Everything else about the form
  // keeps working meanwhile - the save button is never blocked on a lookup.
  const hit = g && g.result && (!g.result.far_from_near || g.farOk) ? g.result : null

  /**
   * Clicking "Add customer" straight out of the address field blurs the field
   * first, and that blur starts the lookup. Measured in headless Chromium: the
   * click's submit then ran before any answer could arrive - at a 30 ms upstream
   * latency, not only a slow one - and saved a perfectly good address with
   * lat:null, because `hit` was still null. Nothing on screen said why.
   *
   * So a save waits for the answer it just asked for. Only for the address being
   * saved (the promise carries its own address), and only while one is actually
   * in flight: with no lookup pending this function never awaits at all and
   * behaves exactly as before.
   *
   * A far-away match still is not used silently - that is the whole point of the
   * far guard - so in that case the customer is saved with no pin and lands on
   * the map's "Needs a pin" list with his address intact.
   */
  async function submit(e) {
    e.preventDefault()
    if (submitting) return
    let effective = hit
    const inFlight = pending.current
    if (!effective && inFlight && inFlight.address === address) {
      setSubmitting(true)
      const answered = await inFlight.promise
      if (answered && answered.address === address && answered.result) {
        effective = answered.result.far_from_near ? null : answered.result
      }
    }
    save(effective)
  }

  /** @param {object|null} found - the location to save with, already vetted. */
  function save(found) {
    onAdd({
      ...form,
      tankSizeGal: Number(form.tankSizeGal),
      cycleMonths: Number(form.cycleMonths) || 36,
      // No pin is invented. A customer with no location is a real state: he is
      // absent from the map until someone drops the pin, which beats a random
      // pin near Gastonia landing in the wrong state for a Pennsylvania client.
      lat: found ? found.lat : null,
      lng: found ? found.lng : null,
      // A town centroid is stored, because a map in the right town beats no map
      // at all. It is stored WITH the precision that says what it is and with no
      // confirmation, which is what puts him on the "Needs a pin" list until a
      // human moves the pin onto the lid. Saving the coordinate and forgetting
      // how good it was is the failure being avoided here.
      locationPrecision: found ? found.precision : '',
      locationConfirmedAt: null,
      // Signals to App that there is somewhere to fly to, and how close.
      geocoded: !!found,
      flyZoom: found ? zoomForPrecision(found.precision) : null,
    })
  }

  const precisionCopy = hit ? PRECISION_COPY[hit.precision] : null

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

          {/* Address row: input + "Find on map" button side by side. The outcome
              lines live outside the <label> so that tapping a suggestion is not
              also forwarded to the input as a focus. */}
          <div className="py-1.5">
            <label className="block">
              <span className="text-sm font-medium uppercase tracking-wide text-gray-500">
                Address
              </span>
              <div className="flex gap-2">
                <input
                  className={inputCls + ' flex-1'}
                  value={form.address}
                  onChange={handleAddressChange}
                  // Auto-lookup on blur: the address is complete the moment he
                  // moves to the next field. Find stays as a visible retry - this
                  // owner is 55-65 and a button he can point at beats magic.
                  onBlur={() => findOnMap()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      findOnMap({ force: true })
                    }
                  }}
                  placeholder="Street, City, State"
                />
                <button
                  type="button"
                  onClick={() => findOnMap({ force: true })}
                  disabled={!address || geocoding}
                  className="mt-1 rounded-lg bg-blue-700 px-3 py-2 text-base font-semibold text-white hover:bg-blue-800 disabled:opacity-40"
                >
                  {geocoding ? '...' : 'Find'}
                </button>
              </div>
            </label>

            {geocoding && (
              <p className="mt-1 text-sm text-gray-500">Looking up the address...</p>
            )}

            {!geocoding && hit && (
              <div className="mt-1">
                {precisionCopy.line && (
                  <p
                    className={
                      'text-sm font-semibold ' +
                      (precisionCopy.good ? 'text-green-700' : 'text-amber-700')
                    }
                  >
                    {precisionCopy.line}
                  </p>
                )}
                {/* Echoing what the geocoder actually matched is the whole guard
                    against Census's fuzzy suffix matching: it will happily answer
                    "Dr" for a "Rd" you typed, one street over. */}
                <p
                  className={
                    'text-sm ' +
                    (precisionCopy.good ? 'text-green-700' : 'text-amber-700') +
                    (precisionCopy.line ? '' : ' font-semibold')
                  }
                >
                  Found: {hit.matched}
                </p>
              </div>
            )}

            {!geocoding && g && g.result && g.result.far_from_near && !g.farOk && (
              <div className="mt-1 rounded-lg bg-amber-50 px-3 py-2">
                <p className="text-sm font-semibold text-amber-900">
                  This is {milesFromKm(g.result.distance_km)} miles from your other
                  customers. Use it anyway?
                </p>
                <p className="mt-0.5 text-sm text-amber-800">{g.result.matched}</p>
                <button
                  type="button"
                  onClick={() => setGeo({ ...g, farOk: true })}
                  className="mt-2 rounded-lg bg-amber-600 px-3 py-1.5 text-base font-semibold text-white hover:bg-amber-700"
                >
                  Use it anyway
                </button>
              </div>
            )}

            {!geocoding && g && !g.result && g.suggestions.length > 0 && (
              <div className="mt-1">
                <p className="text-sm font-semibold text-amber-700">
                  Couldn&apos;t find that exact address. Did you mean:
                </p>
                <div className="mt-1 divide-y divide-gray-200 overflow-hidden rounded-lg border border-gray-300">
                  {g.suggestions.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      onClick={() => pickSuggestion(s)}
                      className="block w-full px-3 py-2 text-left text-base text-blue-800 hover:bg-blue-50"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {!geocoding && g && !g.result && g.suggestions.length === 0 && (
              <p className="mt-1 text-sm text-amber-700">
                {MISS_COPY[g.reason] || MISS_DEFAULT}
              </p>
            )}
          </div>

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
              disabled={submitting}
              className="flex-1 rounded-lg bg-blue-700 px-4 py-3 text-lg font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
            >
              {submitting ? 'Saving...' : 'Add customer'}
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
