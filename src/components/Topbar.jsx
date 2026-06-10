export default function Topbar({ onGetThis }) {
  return (
    <header className="bg-white border-b border-gray-200 px-4 py-3 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-2xl font-bold text-blue-800">PumpCycle</span>
        <span className="rounded-full bg-amber-100 text-amber-900 text-sm font-medium px-3 py-1">
          Live demo — sample data
        </span>
        <button
          onClick={onGetThis}
          className="w-full rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-lg font-semibold px-5 py-2.5 sm:ml-auto sm:w-auto"
        >
          Get this for your company
        </button>
      </div>
    </header>
  )
}
