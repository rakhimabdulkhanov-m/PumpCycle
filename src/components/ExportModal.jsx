import { useState, useMemo } from 'react'
import { daysUntilDue } from '../lib/dates.js'
import {
  exportCustomersCSV,
  exportQuickBooksCSV,
  downloadCSV,
} from '../lib/export.js'
import { useDismissLayer } from '../lib/dismissLayer.js'

export default function ExportModal({
  customers = [],
  onClose,
  onOpenPrintLabels,
  onOpenPrintPostcards,
}) {
  useDismissLayer(true, onClose)

  const [filter, setFilter] = useState('all')

  const counts = useMemo(() => {
    let overdue = 0
    let due30 = 0
    let due60 = 0
    let due90 = 0
    for (const c of customers) {
      const d = daysUntilDue(c)
      if (d !== null && Number.isFinite(d)) {
        if (d < 0) overdue += 1
        if (d >= 0 && d <= 30) due30 += 1
        if (d >= 0 && d <= 60) due60 += 1
        if (d >= 0 && d <= 90) due90 += 1
      }
    }
    return {
      all: customers.length,
      overdue,
      30: due30,
      60: due60,
      90: due90,
    }
  }, [customers])

  const filteredCustomers = useMemo(() => {
    if (filter === 'all') return customers
    if (filter === 'overdue') {
      return customers.filter((c) => {
        const d = daysUntilDue(c)
        return d !== null && Number.isFinite(d) && d < 0
      })
    }
    const days = Number(filter)
    if (Number.isFinite(days)) {
      return customers.filter((c) => {
        const d = daysUntilDue(c)
        return d !== null && Number.isFinite(d) && d >= 0 && d <= days
      })
    }
    return customers
  }, [customers, filter])

  const count = filteredCustomers.length

  const handleExportCSV = () => {
    const csv = exportCustomersCSV(filteredCustomers)
    const filename = `pumpcycle-customers-${filter}-${new Date().toISOString().slice(0, 10)}.csv`
    downloadCSV(filename, csv)
  }

  const handleExportQuickBooks = () => {
    const csv = exportQuickBooksCSV(filteredCustomers)
    const filename = `quickbooks-customers-${filter}-${new Date().toISOString().slice(0, 10)}.csv`
    downloadCSV(filename, csv)
  }

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/60 p-4 text-gray-900"
    >
      <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl sm:p-8">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 pb-4">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Export & Print</h2>
            <p className="mt-1 text-sm text-gray-600">
              Download spreadsheets or format print-ready reminder mailings.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-2xl text-gray-400 hover:bg-gray-100 hover:text-gray-700 active:bg-gray-200"
          >
            &times;
          </button>
        </div>

        {/* Filter selection */}
        <div className="mt-5">
          <label className="block text-sm font-semibold text-gray-700">
            Select customers to include:
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {[
              { id: 'all', label: `All (${counts.all})` },
              { id: 'overdue', label: `Overdue (${counts.overdue})` },
              { id: '30', label: `Due in 30d (${counts[30]})` },
              { id: '60', label: `Due in 60d (${counts[60]})` },
              { id: '90', label: `Due in 90d (${counts[90]})` },
            ].map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setFilter(opt.id)}
                className={`min-h-11 rounded-lg border px-3 py-2 text-sm font-semibold transition ${
                  filter === opt.id
                    ? 'border-blue-700 bg-blue-50 text-blue-800 ring-2 ring-blue-600'
                    : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-gray-500">
            {count} {count === 1 ? 'customer' : 'customers'} selected
          </p>
        </div>

        {/* Action Sections */}
        <div className="mt-6 space-y-4">
          {/* CSV Exports */}
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            <h3 className="text-sm font-bold uppercase tracking-wider text-gray-600">
              CSV Spreadsheets
            </h3>
            <div className="mt-3 flex flex-col gap-2.5">
              <button
                type="button"
                disabled={count === 0}
                onClick={handleExportCSV}
                className="flex min-h-11 w-full items-center justify-between rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-left font-semibold text-gray-800 shadow-sm hover:bg-gray-100 disabled:opacity-50"
              >
                <span>Download Customer CSV</span>
                <span className="text-xs text-gray-500">Standard</span>
              </button>

              <button
                type="button"
                disabled={count === 0}
                onClick={handleExportQuickBooks}
                className="flex min-h-11 w-full flex-col justify-center rounded-lg border border-blue-200 bg-white px-4 py-2.5 text-left shadow-sm hover:bg-blue-50/50 disabled:opacity-50"
              >
                <div className="flex items-center justify-between font-semibold text-blue-900">
                  <span>Export for QuickBooks (CSV)</span>
                  <span className="text-xs font-normal text-blue-700">QuickBooks Online / Desktop</span>
                </div>
                <div className="mt-0.5 text-xs text-gray-500">
                  Exports a file QuickBooks can import. This is not a live sync.
                </div>
              </button>
            </div>
          </div>

          {/* Print views */}
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            <h3 className="text-sm font-bold uppercase tracking-wider text-gray-600">
              Print Mailings (Browser Print)
            </h3>
            <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <button
                type="button"
                disabled={count === 0}
                onClick={() => {
                  onClose()
                  onOpenPrintLabels(filteredCustomers)
                }}
                className="flex min-h-11 flex-col justify-center rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-left shadow-sm hover:bg-gray-100 disabled:opacity-50"
              >
                <span className="font-semibold text-gray-900">Avery 5160 Labels</span>
                <span className="text-xs text-gray-500">30 labels / sheet (3x10)</span>
              </button>

              <button
                type="button"
                disabled={count === 0}
                onClick={() => {
                  onClose()
                  onOpenPrintPostcards(filteredCustomers)
                }}
                className="flex min-h-11 flex-col justify-center rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-left shadow-sm hover:bg-gray-100 disabled:opacity-50"
              >
                <span className="font-semibold text-gray-900">Reminder Postcards</span>
                <span className="text-xs text-gray-500">4 postcards / sheet</span>
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-base font-semibold text-gray-700 hover:bg-gray-100"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
