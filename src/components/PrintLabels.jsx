import { parseUSAddress } from '../lib/export.js'
import { useDismissLayer } from '../lib/dismissLayer.js'

/**
 * Avery 5160 geometry:
 * - Page: US Letter (8.5in x 11in)
 * - Margins: Top 0.5in, Bottom 0.5in, Left 0.1875in, Right 0.1875in
 * - 3 columns, 10 rows = 30 labels per page
 * - Label dimensions: 2.625in width x 1.0in height
 * - Horizontal pitch / gap: 2.75in pitch (0.125in gap)
 * - Vertical pitch / gap: 1.0in pitch (0 gap)
 */
export default function PrintLabels({ customers = [], onClose }) {
  useDismissLayer(true, onClose)

  // Chunk customers into pages of 30
  const pages = []
  for (let i = 0; i < customers.length; i += 30) {
    pages.push(customers.slice(i, i + 30))
  }
  if (pages.length === 0) pages.push([])

  return (
    <div className="fixed inset-0 z-[1300] overflow-y-auto bg-gray-900/80 p-4 text-gray-900 print:static print:inset-auto print:bg-white print:p-0">
      {/* Screen toolbar (hidden when printing) */}
      <div className="mx-auto mb-4 flex max-w-4xl items-center justify-between rounded-xl bg-white p-4 shadow-lg print:hidden">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Avery 5160 Mailing Labels</h2>
          <p className="text-sm text-gray-600">
            {customers.length} {customers.length === 1 ? 'customer' : 'customers'} ({pages.length} {pages.length === 1 ? 'sheet' : 'sheets'} of 30)
          </p>
          <p className="mt-1 text-xs text-amber-900">
            <strong>Print tip:</strong> Set Scale to 100% (turn off &ldquo;Fit to page&rdquo;) and uncheck &ldquo;Headers and footers&rdquo;.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-lg bg-blue-700 px-5 py-2.5 text-base font-bold text-white shadow hover:bg-blue-800 active:bg-blue-900"
          >
            Print labels
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-base font-semibold text-gray-700 hover:bg-gray-100"
          >
            Close
          </button>
        </div>
      </div>

      {/* Printable Sheet Container */}
      <div className="print-sheets mx-auto flex flex-col items-center gap-8 print:gap-0">
        <style dangerouslySetInnerHTML={{ __html: `
          @media screen {
            .avery-sheet {
              width: 8.5in;
              height: 11in;
              background: white;
              box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
              padding: 0.5in 0.1875in;
              box-sizing: border-box;
            }
          }
          @media print {
            @page {
              size: 8.5in 11in;
              margin: 0;
            }
            body {
              margin: 0;
              background: white;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }
            .avery-sheet {
              width: 8.5in;
              height: 11in;
              padding: 0.5in 0.1875in;
              box-sizing: border-box;
              page-break-after: always;
              break-after: page;
            }
            .avery-sheet:last-child {
              page-break-after: auto;
              break-after: auto;
            }
          }
          .avery-grid {
            display: grid;
            grid-template-columns: repeat(3, 2.625in);
            grid-template-rows: repeat(10, 1.0in);
            column-gap: 0.125in;
            row-gap: 0;
            width: 8.125in;
            height: 10in;
          }
          .avery-label {
            width: 2.625in;
            height: 1.0in;
            box-sizing: border-box;
            padding: 0.08in 0.15in;
            overflow: hidden;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.25;
            font-size: 10pt;
          }
          .calibration-bar {
            width: 1.0in;
            height: 2px;
            background: #000;
            margin: 0 auto 4px auto;
          }
        ` }} />

        {pages.map((pageCustomers, pageIdx) => (
          <div key={pageIdx} className="avery-sheet">
            {/* Calibration Bar for Print Alignment Verification */}
            <div className="mb-1 flex items-center justify-between text-[8px] text-gray-500 print:text-black">
              <span>Sheet {pageIdx + 1} of {pages.length}</span>
              <div className="flex items-center gap-1">
                <span>1-inch calibration:</span>
                <div className="calibration-bar inline-block !m-0" />
              </div>
            </div>

            <div className="avery-grid">
              {Array.from({ length: 30 }).map((_, slotIdx) => {
                const customer = pageCustomers[slotIdx]
                if (!customer) {
                  return <div key={slotIdx} className="avery-label" />
                }

                const { street, city, state, zip } = parseUSAddress(customer.address)
                const cityStateZip = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')

                return (
                  <div key={slotIdx} className="avery-label flex flex-col justify-center">
                    <div className="font-bold text-gray-900">{customer.name}</div>
                    <div className="text-gray-800">{street || customer.address}</div>
                    {cityStateZip && <div className="text-gray-800">{cityStateZip}</div>}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
