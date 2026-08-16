const TABS = [
  { id: 'map', label: 'Map' },
  { id: 'due', label: 'Due list' },
  { id: 'reminders', label: 'Reminders' },
]

export default function TabNav({ active, onChange }) {
  return (
    <nav className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-5xl gap-2 px-4 sm:px-6">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={
              'px-5 py-3 text-lg font-semibold border-b-4 ' +
              (active === tab.id
                ? 'border-blue-700 text-blue-800'
                : 'border-transparent text-gray-500 hover:text-gray-800')
            }
          >
            {tab.label}
          </button>
        ))}
      </div>
    </nav>
  )
}
