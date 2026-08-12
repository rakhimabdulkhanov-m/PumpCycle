// What the Save button says while it is shut, keyed by placementSaveBlock's
// answer. A greyed-out button with no reason on it is a dead end, so each of
// these names the single thing he has to do to open it. 'zoom' is the one he
// reaches by zooming out for context and not coming back in, so it says come
// back in, rather than telling him he is wrong.
const BLOCKED_LABEL = {
  zoom: 'Zoom in until you can see the lid',
  move: 'Move the map onto the lid',
  no_session: 'Move the map onto the lid',
}

/**
 * Placement mode: a crosshair nailed to the middle of the map, and the map
 * moving under it.
 *
 * The old model was a draggable pin, and it had two problems that this shape
 * does not have. On a phone his thumb covers the thing he is aiming at, and the
 * target he has to grab is smaller than his fingertip. On a desktop a drag and a
 * pan are the same gesture, so a pan that happened to start over a pin moved
 * that customer's lid and recorded it as a human placement.
 *
 * Here nothing on the map is grabbable. The reticle never moves, the map does,
 * and the only thing that writes a coordinate is the Save button below.
 */
export default function PinPlacer({
  title,
  address,
  blocked,
  saveLabel,
  onSave,
  onCancel,
}) {
  const canSave = !blocked
  return (
    <>
      {/* Dead to the touch on purpose: every gesture in this mode belongs to the
          map underneath, including the ones that land on the crosshair. */}
      <div className="pointer-events-none absolute inset-0 z-[1000] flex items-center justify-center">
        <svg width="120" height="120" viewBox="0 0 120 120" aria-hidden="true">
          <g stroke="white" strokeWidth="6" strokeLinecap="round" opacity="0.85">
            <line x1="60" y1="14" x2="60" y2="42" />
            <line x1="60" y1="78" x2="60" y2="106" />
            <line x1="14" y1="60" x2="42" y2="60" />
            <line x1="78" y1="60" x2="106" y2="60" />
            <circle cx="60" cy="60" r="24" fill="none" />
          </g>
          <g stroke="#dc2626" strokeWidth="2.5" strokeLinecap="round">
            <line x1="60" y1="14" x2="60" y2="42" />
            <line x1="60" y1="78" x2="60" y2="106" />
            <line x1="14" y1="60" x2="42" y2="60" />
            <line x1="78" y1="60" x2="106" y2="60" />
            <circle cx="60" cy="60" r="24" fill="none" />
          </g>
          <circle cx="60" cy="60" r="2.5" fill="#dc2626" />
        </svg>
      </div>

      <div className="absolute top-3 left-1/2 z-[1100] max-w-[calc(100vw-1.5rem)] -translate-x-1/2 rounded-2xl bg-gray-900 px-4 py-2 text-center text-white shadow-lg">
        <div className="text-base font-bold" data-testid="placing-name">
          {title}
        </div>
        {address && <div className="text-sm text-gray-300">{address}</div>}
        <div className="text-sm">Move the map so the cross sits on his tank lid.</div>
      </div>

      {/* Thumb-sized, at the bottom edge, where a hand holding a phone already
          is. Save is the ONLY path to a recorded coordinate. */}
      <div className="absolute inset-x-0 bottom-0 z-[1200] flex gap-3 bg-white/95 p-3 shadow-[0_-2px_10px_rgba(0,0,0,0.25)]">
        <button
          type="button"
          onClick={onCancel}
          className="min-h-[3.5rem] flex-1 rounded-xl border-2 border-gray-300 px-4 py-4 text-lg font-bold text-gray-700 hover:bg-gray-100"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          className="min-h-[3.5rem] flex-[2] rounded-xl bg-green-600 px-4 py-4 text-lg font-bold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {canSave ? saveLabel : BLOCKED_LABEL[blocked]}
        </button>
      </div>
    </>
  )
}
