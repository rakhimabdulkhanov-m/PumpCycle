export default function Topbar({ demo = false, onGetThis, onSignOut }) {
  return (
    <header className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-2.5 sm:gap-3 sm:px-6">
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="text-xl font-bold text-blue-800 sm:text-2xl">PumpCycle</span>
          {demo && (
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900 sm:px-3 sm:py-1 sm:text-sm">
              Live demo
            </span>
          )}
        </div>
        {demo && (
          <button
            onClick={onGetThis}
            className="rounded-lg bg-blue-700 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-blue-800 sm:px-5 sm:py-2.5 sm:text-lg"
          >
            Get this for your company
          </button>
        )}
        {!demo && onSignOut && (
          <button
            type="button"
            onClick={onSignOut}
            className="ml-auto rounded-lg border border-gray-300 bg-white px-4 py-2 text-base font-semibold text-gray-800 hover:bg-gray-50"
          >
            Sign out
          </button>
        )}
      </div>
    </header>
  )
}
