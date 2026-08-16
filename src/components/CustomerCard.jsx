import { useEffect, useRef, useState } from 'react'
import { nextDue, daysUntilDue, dueStatus, formatDate, isCommercial, todayISO } from '../lib/dates.js'
import { pinSource } from '../lib/location.js'
import { hasLocation } from '../lib/point.js'
import { calculateNavigation, formatAccuracy } from '../lib/navigation.js'
import { useDismissLayer } from '../lib/dismissLayer.js'
import { downscaleImage, newPhotoId, newVisitId } from '../lib/photo.js'
import PhotoStrip from './PhotoStrip.jsx'
import PhotoModal from './PhotoModal.jsx'

const STATUS_STYLES = {
  overdue: 'bg-red-100 text-red-800',
  'due-soon': 'bg-amber-100 text-amber-800',
  ok: 'bg-green-100 text-green-800',
}

function Row({ label, children }) {
  return (
    <div className="py-1.5">
      <div className="text-sm font-medium uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div className="text-lg text-gray-900">{children}</div>
    </div>
  )
}

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

const inputCls =
  'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-lg focus:border-blue-600 focus:outline-none'

const PIN_NOTE = {
  no_location: 'No pin yet - place it on the lid.',
  address_changed: 'Address was edited - the pin is still at the old one.',
  locality: 'Pin is town-level - nobody has put it on the lid.',
  road: 'Pin is road-level - nobody has put it on the lid.',
  no_precision: 'Nobody has checked this pin.',
  placed: 'Pin placed by you on the lid.',
  lookup: 'Pin from the address lookup.',
}

const SETTLED_NOTE = new Set(['placed', 'lookup'])

export default function CustomerCard({
  customer,
  visits = [],
  photos = [],
  onClose,
  onUpdate,
  onMarkPumped,
  onRecordVisit,
  onArchiveVisit,
  onRecordPhoto,
  onArchivePhoto,
  onMovePin,
  onMapAction,
}) {
  const [tab, setTab] = useState('details') // 'details' | 'history'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(null)
  const [savingAction, setSavingAction] = useState(null)
  const [writeError, setWriteError] = useState('')
  const [activePhoto, setActivePhoto] = useState(null)
  const [addingVisit, setAddingVisit] = useState(false)
  const [visitDraft, setVisitDraft] = useState({
    visitedOn: todayISO(),
    gallons: customer.tankSizeGal || '',
    price: '',
    tech: '',
    notes: '',
  })
  const [targetVisitIdForPhoto, setTargetVisitIdForPhoto] = useState(null)
  const [navigating, setNavigating] = useState(false)
  const [userPosition, setUserPosition] = useState(null)
  const [userAccuracy, setUserAccuracy] = useState(null)
  const [navError, setNavError] = useState('')

  const bodyRef = useRef(null)
  const fileInputRef = useRef(null)
  const watchIdRef = useRef(null)

  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current)
        watchIdRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    stopNavigation()
  }, [customer?.id])

  function startNavigation() {
    setNavigating(true)
    setNavError('')
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setNavError('Geolocation is not supported on this device.')
      return
    }
    try {
      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          setUserPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude })
          setUserAccuracy(pos.coords.accuracy)
          setNavError('')
        },
        (err) => {
          setNavError(err.message || 'Could not acquire GPS position.')
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      )
    } catch (err) {
      setNavError(err?.message || 'Could not start GPS navigation.')
    }
  }

  function stopNavigation() {
    if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
    setNavigating(false)
    setUserPosition(null)
    setUserAccuracy(null)
    setNavError('')
  }

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0
    }
  }, [editing, tab, addingVisit])

  useDismissLayer(true, () => {
    if (activePhoto) {
      setActivePhoto(null)
    } else if (addingVisit) {
      setAddingVisit(false)
    } else if (editing) {
      setEditing(false)
    } else {
      onClose()
    }
  })

  const status = dueStatus(customer)
  const source = pinSource(customer)
  const pinNote = PIN_NOTE[source]
  const hasPin = source !== 'no_location'
  const commercial = isCommercial(customer)
  const days = daysUntilDue(customer)
  const dueLabel = !Number.isFinite(days)
    ? 'Pump date unknown'
    : status === 'overdue'
      ? `${formatDate(nextDue(customer))} — ${-days} days overdue`
      : `${formatDate(nextDue(customer))} — in ${days} days`

  const customerVisits = visits
    .filter((v) => v.customerId === customer.id && !v.archivedAt)
    .sort((a, b) => (b.visitedOn || '').localeCompare(a.visitedOn || ''))

  const customerPhotos = photos.filter((p) => p.customerId === customer.id && !p.archivedAt)
  const standalonePhotos = customerPhotos.filter((p) => !p.visitId)

  const navData =
    userPosition && hasLocation(customer)
      ? calculateNavigation(userPosition, { lat: customer.lat, lng: customer.lng })
      : null

  function startEdit() {
    setDraft({ ...customer })
    setEditing(true)
  }

  async function saveEdit() {
    if (savingAction) return
    setSavingAction('edit')
    setWriteError('')
    try {
      await onUpdate({
        name: draft.name,
        address: draft.address,
        phone: draft.phone,
        email: draft.email,
        tankSizeGal: Number(draft.tankSizeGal),
        lastPumped: draft.lastPumped || null,
        cycleMonths: Number(draft.cycleMonths) || 36,
        notes: draft.notes,
      })
      setEditing(false)
    } catch {
      setWriteError('Could not save. Try again.')
    } finally {
      setSavingAction(null)
    }
  }

  async function archiveCustomer() {
    if (savingAction) return
    if (
      !window.confirm(
        'Archive this customer? They will be hidden from your map and reminder schedule.'
      )
    ) {
      return
    }
    setSavingAction('archive')
    setWriteError('')
    try {
      await onUpdate({ archivedAt: Date.now() })
      onClose()
    } catch {
      setWriteError('Could not archive this customer. Try again.')
      setSavingAction(null)
    }
  }

  async function markPumped() {
    if (savingAction) return
    setSavingAction('pumped')
    setWriteError('')
    try {
      await onMarkPumped()
    } catch {
      setWriteError('Could not mark this customer pumped. Try again.')
    } finally {
      setSavingAction(null)
    }
  }

  async function handleSaveVisit(e) {
    e.preventDefault()
    if (savingAction || !onRecordVisit) return
    setSavingAction('visit')
    setWriteError('')
    try {
      const visitId = newVisitId()
      const gallons = parseInt(visitDraft.gallons, 10) || 0
      const priceCents = Math.round((parseFloat(visitDraft.price) || 0) * 100)
      await onRecordVisit({
        id: visitId,
        customerId: customer.id,
        visitedOn: visitDraft.visitedOn,
        gallons,
        priceCents,
        tech: visitDraft.tech.trim(),
        notes: visitDraft.notes.trim(),
      })
      setAddingVisit(false)
      setVisitDraft({
        visitedOn: todayISO(),
        gallons: customer.tankSizeGal || '',
        price: '',
        tech: '',
        notes: '',
      })
    } catch {
      setWriteError('Could not record visit. Try again.')
    } finally {
      setSavingAction(null)
    }
  }

  function triggerPhotoCapture(visitId = null) {
    setTargetVisitIdForPhoto(visitId)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
      fileInputRef.current.click()
    }
  }

  async function handlePhotoSelected(e) {
    const file = e.target.files?.[0]
    if (!file || !onRecordPhoto) return
    setSavingAction('photo')
    setWriteError('')
    try {
      const processed = await downscaleImage(file)
      const photoId = newPhotoId()
      await onRecordPhoto({
        id: photoId,
        customerId: customer.id,
        visitId: targetVisitIdForPhoto || null,
        dataUrl: processed.dataUrl,
        bytes: processed.bytes,
        width: processed.width,
        height: processed.height,
        caption: targetVisitIdForPhoto ? 'Service photo' : 'Lid location photo',
        blobState: 'stored',
      })
    } catch {
      setWriteError('Could not attach photo. Try again.')
    } finally {
      setSavingAction(null)
      setTargetVisitIdForPhoto(null)
    }
  }

  const set = (key) => (e) => setDraft({ ...draft, [key]: e.target.value })

  return (
    <div className="absolute inset-x-0 bottom-0 z-[1050] flex h-[min(82dvh,calc(100%-4rem))] flex-col rounded-t-xl bg-white shadow-2xl sm:inset-x-auto sm:right-4 sm:top-4 sm:bottom-4 sm:h-auto sm:w-96 sm:rounded-xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-gray-200 p-5 pb-3">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold text-gray-900">{customer.name}</h2>
          {commercial && (
            <span className="mt-1 inline-block rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
              Commercial · Grease trap
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="flex min-h-11 min-w-11 -mr-2 -mt-2 items-center justify-center rounded-lg text-3xl leading-none text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        >
          &times;
        </button>
      </div>

      {/* Segmented Control */}
      {!editing && (
        <div className="flex border-b border-gray-200 bg-gray-50 px-3 pt-1">
          <button
            type="button"
            onClick={() => {
              setTab('details')
              setAddingVisit(false)
            }}
            className={`min-h-11 flex-1 py-2 text-center text-base font-bold transition-colors ${
              tab === 'details'
                ? 'rounded-t-lg border-b-2 border-blue-600 bg-white text-blue-700 shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            Details
          </button>
          <button
            type="button"
            onClick={() => setTab('history')}
            className={`min-h-11 flex-1 py-2 text-center text-base font-bold transition-colors ${
              tab === 'history'
                ? 'rounded-t-lg border-b-2 border-blue-600 bg-white text-blue-700 shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            History {customerVisits.length > 0 && `(${customerVisits.length})`}
          </button>
        </div>
      )}

      {/* Hidden camera file input */}
      <input
        type="file"
        accept="image/*"
        capture="environment"
        ref={fileInputRef}
        onChange={handlePhotoSelected}
        className="hidden"
      />

      {/* Body */}
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto p-5 pt-2">
        {/* DETAILS TAB */}
        {tab === 'details' && !editing && (
          <>
            <Row label="Address">{customer.address}</Row>
            <p
              className={
                '-mt-1 pb-1 text-base font-semibold ' +
                (SETTLED_NOTE.has(source) ? 'text-gray-500' : 'text-amber-700')
              }
            >
              {pinNote}
            </p>
            <Row label="Phone">
              {customer.phone ? (
                <div className="flex flex-wrap items-center gap-3">
                  <a href={`tel:${customer.phone}`} className="text-blue-700 underline">
                    {customer.phone}
                  </a>
                  <a
                    href={`sms:${customer.phone}`}
                    className="rounded bg-blue-50 px-2 py-0.5 text-sm font-semibold text-blue-700 hover:bg-blue-100"
                  >
                    Text
                  </a>
                </div>
              ) : (
                <span className="text-gray-400">—</span>
              )}
            </Row>
            <Row label="Email">
              {customer.email ? (
                <a href={`mailto:${customer.email}`} className="text-blue-700 underline">
                  {customer.email}
                </a>
              ) : (
                <span className="text-gray-400">—</span>
              )}
            </Row>
            <Row label="Tank size">{customer.tankSizeGal.toLocaleString()} gal</Row>
            <Row label="Last pumped">{formatDate(customer.lastPumped)}</Row>
            <Row label="Cycle">
              {commercial
                ? `Every ${customer.cycleMonths * 30} days (grease trap / FOG)`
                : `Every ${customer.cycleMonths} months`}
            </Row>
            <Row label="Next due">
              <span
                className={`inline-block rounded-full px-3 py-0.5 font-semibold ${STATUS_STYLES[status]}`}
              >
                {dueLabel}
              </span>
            </Row>
            <Row label="Notes">{customer.notes || '—'}</Row>

            {/* Offline Lid Navigation / GPS Finder */}
            {hasLocation(customer) && (
              <div className="my-2 rounded-xl border border-blue-200 bg-blue-50/70 p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-bold uppercase tracking-wide text-blue-900">
                    Lid Finder (GPS)
                  </span>
                  {!navigating ? (
                    <button
                      type="button"
                      onClick={startNavigation}
                      className="flex min-h-11 items-center justify-center rounded-lg bg-blue-700 px-4 py-2 text-sm font-bold text-white hover:bg-blue-800"
                    >
                      Find lid in yard
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={stopNavigation}
                      className="flex min-h-11 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                    >
                      Stop
                    </button>
                  )}
                </div>

                {navigating && (
                  <div className="mt-3">
                    {navError ? (
                      <p className="text-sm font-semibold text-red-700">{navError}</p>
                    ) : !userPosition ? (
                      <div className="flex items-center gap-2 text-sm text-blue-800">
                        <span className="inline-block h-2.5 w-2.5 animate-ping rounded-full bg-blue-600" />
                        <span>Acquiring GPS fix...</span>
                      </div>
                    ) : navData ? (
                      <div>
                        {navData.isAtLid ? (
                          <div className="rounded-lg bg-green-100 p-2.5 text-center font-bold text-green-900">
                            At lid! ({navData.distanceFormatted})
                          </div>
                        ) : (
                          <div className="flex items-center gap-3">
                            <div
                              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-blue-700 text-2xl font-bold text-white shadow"
                              style={{
                                transform: `rotate(${navData.bearingDegrees}deg)`,
                                transition: 'transform 0.3s ease',
                              }}
                              title={`Heading ${navData.bearingDegrees}°`}
                            >
                              ↑
                            </div>
                            <div className="min-w-0">
                              <div className="text-lg font-extrabold text-blue-950">
                                {navData.distanceFormatted} {navData.cardinal}
                              </div>
                              <div className="text-xs text-blue-800">
                                Bearing: {navData.cardinalLong} ({navData.bearingDegrees}°)
                                {userAccuracy && ` · Accuracy ${formatAccuracy(userAccuracy)}`}
                              </div>
                            </div>
                          </div>
                        )}
                        <p className="mt-2 text-xs text-blue-900/80">
                          Offline compass & distance based on phone GPS. No cell signal required.
                        </p>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            )}

            {/* Standalone Lid Photos Preview */}
            <div className="py-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium uppercase tracking-wide text-gray-500">
                  Lid Photos
                </span>
                <button
                  type="button"
                  onClick={() => triggerPhotoCapture(null)}
                  className="text-sm font-semibold text-blue-700 hover:underline"
                >
                  + Add Lid Photo
                </button>
              </div>
              <PhotoStrip
                photos={standalonePhotos}
                onSelectPhoto={setActivePhoto}
                onAddPhotoClick={() => triggerPhotoCapture(null)}
              />
            </div>

            {status === 'overdue' && (customer.phone || customer.email) && (
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-red-50 px-3 py-2">
                <span className="text-base font-semibold text-red-800">
                  Overdue — reach out:
                </span>
                {customer.phone && (
                  <>
                    <a
                      href={`tel:${customer.phone}`}
                      className="text-base font-semibold text-blue-700 underline"
                    >
                      Call
                    </a>
                    <a
                      href={`sms:${customer.phone}`}
                      className="text-base font-semibold text-blue-700 underline"
                    >
                      Text
                    </a>
                  </>
                )}
                {customer.email && (
                  <a
                    href={`mailto:${customer.email}`}
                    className="text-base font-semibold text-blue-700 underline"
                  >
                    Email
                  </a>
                )}
              </div>
            )}
          </>
        )}

        {/* EDITING DETAILS */}
        {tab === 'details' && editing && (
          <>
            <Field label="Name">
              <input className={inputCls} value={draft.name} onChange={set('name')} />
            </Field>
            <Field label="Address">
              <input className={inputCls} value={draft.address} onChange={set('address')} />
            </Field>
            <Field label="Phone">
              <input className={inputCls} value={draft.phone} onChange={set('phone')} />
            </Field>
            <Field label="Email">
              <input
                type="email"
                className={inputCls}
                value={draft.email || ''}
                onChange={set('email')}
              />
            </Field>
            <Field label="Tank size (gal)">
              <select
                className={inputCls}
                value={draft.tankSizeGal}
                onChange={set('tankSizeGal')}
              >
                <option value="1000">1,000</option>
                <option value="1250">1,250</option>
                <option value="1500">1,500</option>
              </select>
            </Field>
            <Field label="Last pumped">
              <input
                type="date"
                className={inputCls}
                value={draft.lastPumped || ''}
                onChange={set('lastPumped')}
              />
            </Field>
            <Field label="Cycle (months)">
              <input
                type="number"
                min="1"
                className={inputCls}
                value={draft.cycleMonths}
                onChange={set('cycleMonths')}
              />
            </Field>
            <Field label="Notes">
              <textarea
                rows="3"
                className={inputCls}
                value={draft.notes}
                onChange={set('notes')}
              />
            </Field>

            <div className="mt-6 border-t border-gray-200 pt-4 pb-2 text-center">
              <button
                type="button"
                onClick={archiveCustomer}
                disabled={!!savingAction}
                className="text-sm font-medium text-red-600 hover:text-red-800 hover:underline disabled:opacity-60"
              >
                {savingAction === 'archive' ? 'Archiving...' : 'Archive this customer'}
              </button>
            </div>
          </>
        )}

        {/* HISTORY TAB */}
        {tab === 'history' && (
          <div className="space-y-4">
            {!addingVisit ? (
              <div className="flex items-center justify-between pb-2 border-b border-gray-100">
                <span className="text-base font-bold text-gray-800">
                  Service Records ({customerVisits.length})
                </span>
                <button
                  type="button"
                  onClick={() => setAddingVisit(true)}
                  className="rounded-lg bg-blue-50 px-3 py-1.5 text-sm font-semibold text-blue-700 hover:bg-blue-100"
                >
                  + Log Visit
                </button>
              </div>
            ) : (
              <form onSubmit={handleSaveVisit} className="rounded-lg border border-blue-200 bg-blue-50/50 p-3">
                <h3 className="text-base font-bold text-gray-900 mb-2">Log Pumping Visit</h3>
                <Field label="Date Pumped">
                  <input
                    type="date"
                    required
                    className={inputCls}
                    value={visitDraft.visitedOn}
                    onChange={(e) => setVisitDraft({ ...visitDraft, visitedOn: e.target.value })}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Gallons">
                    <input
                      type="number"
                      className={inputCls}
                      placeholder="e.g. 1000"
                      value={visitDraft.gallons}
                      onChange={(e) => setVisitDraft({ ...visitDraft, gallons: e.target.value })}
                    />
                  </Field>
                  <Field label="Price ($)">
                    <input
                      type="number"
                      step="0.01"
                      className={inputCls}
                      placeholder="e.g. 450"
                      value={visitDraft.price}
                      onChange={(e) => setVisitDraft({ ...visitDraft, price: e.target.value })}
                    />
                  </Field>
                </div>
                <Field label="Tech Name">
                  <input
                    type="text"
                    className={inputCls}
                    placeholder="e.g. Hank"
                    value={visitDraft.tech}
                    onChange={(e) => setVisitDraft({ ...visitDraft, tech: e.target.value })}
                  />
                </Field>
                <Field label="Service Notes">
                  <textarea
                    rows="2"
                    className={inputCls}
                    placeholder="Lid depth, riser condition, access notes..."
                    value={visitDraft.notes}
                    onChange={(e) => setVisitDraft({ ...visitDraft, notes: e.target.value })}
                  />
                </Field>
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setAddingVisit(false)}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!!savingAction}
                    className="rounded-lg bg-blue-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
                  >
                    {savingAction === 'visit' ? 'Saving...' : 'Save Visit'}
                  </button>
                </div>
              </form>
            )}

            {customerVisits.length === 0 && !addingVisit && (
              <div className="py-8 text-center text-gray-500">
                <p className="text-lg font-medium text-gray-700">No service visits recorded yet.</p>
                <p className="text-sm mt-1">Tap &ldquo;Mark pumped today&rdquo; or &ldquo;+ Log Visit&rdquo; to add past service history.</p>
              </div>
            )}

            {customerVisits.map((visit) => {
              const visitPhotos = customerPhotos.filter((p) => p.visitId === visit.id)
              return (
                <div
                  key={visit.id}
                  className="rounded-xl border border-gray-200 bg-gray-50/70 p-3.5 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-lg font-bold text-gray-900">
                        {formatDate(visit.visitedOn)}
                      </div>
                      {visit.tech && (
                        <div className="text-sm font-medium text-gray-600">
                          Tech: {visit.tech}
                        </div>
                      )}
                    </div>
                    {(visit.gallons > 0 || visit.priceCents > 0) && (
                      <div className="text-right">
                        {visit.gallons > 0 && (
                          <div className="text-sm font-semibold text-gray-700">
                            {visit.gallons.toLocaleString()} gal
                          </div>
                        )}
                        {visit.priceCents > 0 && (
                          <div className="text-sm font-semibold text-green-700">
                            ${(visit.priceCents / 100).toFixed(0)}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {visit.notes && (
                    <p className="mt-2 text-base text-gray-800 bg-white p-2 rounded border border-gray-100">
                      {visit.notes}
                    </p>
                  )}

                  {/* Visit photos */}
                  <div className="mt-2">
                    <PhotoStrip
                      photos={visitPhotos}
                      onSelectPhoto={setActivePhoto}
                      onAddPhotoClick={() => triggerPhotoCapture(visit.id)}
                    />
                  </div>

                  {onArchiveVisit && (
                    <div className="mt-3 flex justify-end">
                      <button
                        type="button"
                        onClick={async () => {
                          if (!window.confirm('Delete this service record?')) return
                          await onArchiveVisit(visit.id)
                        }}
                        className="text-xs font-medium text-red-600 hover:text-red-800 hover:underline"
                      >
                        Delete record
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Fixed bottom actions */}
      <div className="border-t border-gray-200 p-4 pt-3">
        {writeError && (
          <p role="alert" className="mb-2 text-base font-semibold text-red-700">
            {writeError}
          </p>
        )}
        {!editing ? (
          <div className="flex flex-col gap-2">
            <button
              onClick={markPumped}
              disabled={!!savingAction}
              className="min-h-12 w-full rounded-lg bg-green-700 px-4 py-3 text-lg font-semibold text-white hover:bg-green-800 disabled:opacity-60"
            >
              {savingAction === 'pumped' ? 'Saving...' : 'Mark pumped today'}
            </button>
            <div className="flex gap-2">
              {onMapAction && (
                <button
                  onClick={onMapAction}
                  className="min-h-12 flex-1 rounded-lg bg-blue-700 px-3 py-3 text-lg font-semibold text-white hover:bg-blue-800"
                >
                  {hasPin ? 'Show on map' : 'Place pin on map'}
                </button>
              )}
              {onMovePin && hasPin && (
                <button
                  onClick={onMovePin}
                  className="min-h-12 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-3 text-lg font-semibold text-gray-800 hover:bg-gray-50"
                >
                  Move pin
                </button>
              )}
              <button
                onClick={startEdit}
                className="min-h-12 rounded-lg border border-gray-300 bg-white px-4 py-3 text-lg font-semibold text-gray-800 hover:bg-gray-50"
              >
                Edit
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={!!savingAction}
              className="min-h-12 flex-1 rounded-lg border border-gray-300 bg-white px-4 py-3 text-lg font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveEdit}
              disabled={!!savingAction}
              className="min-h-12 flex-1 rounded-lg bg-blue-700 px-4 py-3 text-lg font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
            >
              {savingAction === 'edit' ? 'Saving...' : 'Save changes'}
            </button>
          </div>
        )}
      </div>

      {/* Photo fullscreen modal */}
      {activePhoto && (
        <PhotoModal
          photo={activePhoto}
          onClose={() => setActivePhoto(null)}
          onArchive={onArchivePhoto}
        />
      )}
    </div>
  )
}
