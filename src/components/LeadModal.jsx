export default function LeadModal({ open, onClose }) {
  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <h2 className="text-2xl font-bold text-gray-900">
            Get this for your company
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-3xl leading-none text-gray-400 hover:text-gray-600"
          >
            &times;
          </button>
        </div>
        <p className="mt-4 text-lg text-gray-600">Coming soon.</p>
      </div>
    </div>
  )
}
