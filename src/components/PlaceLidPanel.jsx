/**
 * Confirm step for placing the pin of a customer who already exists.
 *
 * Deliberately has no name / address / service-type inputs and, more to the
 * point, no way to reach addCustomer: it is handed one customer and one
 * onConfirm, so the flow that starts from "No pin yet" cannot end in a second
 * copy of the same person. Creating customers is NewLidPanel's job and stays
 * there.
 */
export default function PlaceLidPanel({ customer, pinPlaced, onConfirm, onCancel }) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-[1050] flex h-[min(75dvh,calc(100%-6rem))] flex-col rounded-t-xl bg-white shadow-2xl sm:inset-x-auto sm:right-4 sm:top-4 sm:bottom-4 sm:h-auto sm:w-96 sm:rounded-xl">
      <div className="flex items-start justify-between gap-3 border-b border-gray-200 p-5 pb-3">
        <h2 className="text-2xl font-bold text-gray-900">Place lid pin</h2>
        <button
          onClick={onCancel}
          aria-label="Close"
          className="text-3xl leading-none text-gray-400 hover:text-gray-600"
        >
          &times;
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5 pt-3">
        <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Customer
        </p>
        <p className="text-2xl font-bold text-gray-900" data-testid="placing-name">
          {customer.name}
        </p>
        <p className="mt-1 text-lg text-gray-600">
          {customer.address || 'No address on file'}
        </p>
        <p className="mt-4 text-base text-gray-600">
          Tap his tank lid on the map, or drag the blue pin onto it, then save.
          Nothing else about this customer changes.
        </p>
      </div>

      <div className="border-t border-gray-200 p-5">
        {/* Save records "a human put this pin here". Until he has actually put it
            somewhere, there is no such thing to record: the pin is only sitting
            at the middle of the map. */}
        {!pinPlaced && (
          <p className="mb-3 text-base font-semibold text-amber-700">
            Put the pin on the lid first.
          </p>
        )}
        <div className="flex gap-3">
        <button
          onClick={onConfirm}
          disabled={!pinPlaced}
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
    </div>
  )
}
