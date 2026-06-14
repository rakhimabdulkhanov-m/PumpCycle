export default function NewLidPanel({
  draftType,
  onPickType,
  name,
  onName,
  address,
  onAddress,
  canSave,
  onSave,
  onCancel,
}) {
  const block = (active) =>
    'w-full text-left p-4 rounded-xl border-2 ' +
    (active ? 'border-blue-600 bg-blue-50 text-blue-900' : 'border-gray-200')

  return (
    <div className="absolute inset-x-0 bottom-0 z-[1050] flex h-[min(75dvh,calc(100%-6rem))] flex-col rounded-t-xl bg-white shadow-2xl sm:inset-x-auto sm:right-4 sm:top-4 sm:bottom-4 sm:h-auto sm:w-96 sm:rounded-xl">
      <div className="flex items-start justify-between gap-3 border-b border-gray-200 p-5 pb-3">
        <h2 className="text-2xl font-bold text-gray-900">New lid</h2>
        <button
          onClick={onCancel}
          aria-label="Close"
          className="text-3xl leading-none text-gray-400 hover:text-gray-600"
        >
          &times;
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5 pt-3">
        <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Service type
        </p>
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => onPickType('residential')}
            className={block(draftType === 'residential')}
          >
            <div className="text-lg font-bold">Residential — 3-Year Cycle</div>
            <div className="text-sm text-gray-600">Standard home septic tank</div>
          </button>
          <button
            type="button"
            onClick={() => onPickType('commercial')}
            className={block(draftType === 'commercial')}
          >
            <div className="text-lg font-bold">Commercial Grease Trap — 90-Day Cycle</div>
            <div className="text-sm text-gray-600">
              FOG interceptor on a 90-day municipal cycle
            </div>
          </button>
        </div>

        <input
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder="Customer name"
          className="mt-4 w-full rounded-lg border-2 border-gray-300 px-4 py-3 text-lg"
        />
        <input
          value={address}
          onChange={(e) => onAddress(e.target.value)}
          placeholder="Address (optional)"
          className="mt-3 w-full rounded-lg border-2 border-gray-300 px-4 py-3 text-lg"
        />
      </div>

      <div className="flex gap-3 border-t border-gray-200 p-5">
        <button
          onClick={onSave}
          disabled={!canSave}
          className="flex-1 rounded-lg bg-green-600 px-4 py-3 text-lg font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          Save pin
        </button>
        <button
          onClick={onCancel}
          className="flex-1 rounded-lg border-2 border-gray-300 px-4 py-3 text-lg font-semibold text-gray-700 hover:bg-gray-100"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
