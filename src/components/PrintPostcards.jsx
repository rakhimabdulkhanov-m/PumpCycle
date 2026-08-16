import { formatDate, nextDue } from '../lib/dates.js'
import { parseUSAddress } from '../lib/export.js'
import { useDismissLayer } from '../lib/dismissLayer.js'

/**
 * 4-up Reminder Postcards geometry:
 * - Page: US Letter (8.5in x 11in)
 * - 2 columns x 2 rows = 4 postcards per sheet (each 4.25in x 5.5in)
 */
export default function PrintPostcards({ customers = [], company = 'PumpCycle Septic Service', phone = '', onClose }) {
  useDismissLayer(true, onClose)

  // Chunk customers into pages of 4
  const pages = []
  for (let i = 0; i < customers.length; i += 4) {
    pages.push(customers.slice(i, i + 4))
  }
  if (pages.length === 0) pages.push([])

  return (
    <div className="fixed inset-0 z-[1300] overflow-y-auto bg-gray-900/80 p-4 text-gray-900 print:static print:inset-auto print:bg-white print:p-0">
      {/* Screen toolbar (hidden when printing) */}
      <div className="mx-auto mb-4 flex max-w-4xl items-center justify-between rounded-xl bg-white p-4 shadow-lg print:hidden">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Reminder Postcards (4-up)</h2>
          <p className="text-sm text-gray-600">
            {customers.length} {customers.length === 1 ? 'customer' : 'customers'} ({pages.length} {pages.length === 1 ? 'sheet' : 'sheets'} of 4)
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
            Print postcards
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

      {/* Printable Postcard Sheets */}
      <div className="print-sheets mx-auto flex flex-col items-center gap-8 print:gap-0">
        <style dangerouslySetInnerHTML={{ __html: `
          @media screen {
            .postcard-sheet {
              width: 8.5in;
              height: 11in;
              background: white;
              box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
              padding: 0.25in;
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
            .postcard-sheet {
              width: 8.5in;
              height: 11in;
              padding: 0.25in;
              box-sizing: border-box;
              page-break-after: always;
              break-after: page;
            }
            .postcard-sheet:last-child {
              page-break-after: auto;
              break-after: auto;
            }
          }
          .postcard-grid {
            display: grid;
            grid-template-columns: repeat(2, 4.0in);
            grid-template-rows: repeat(2, 5.25in);
            gap: 0;
            width: 8.0in;
            height: 10.5in;
          }
          .postcard-card {
            width: 4.0in;
            height: 5.25in;
            box-sizing: border-box;
            padding: 0.25in;
            border: 1px dashed #ccc;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
          }
          @media print {
            .postcard-card {
              border: 1px dashed #bbb;
            }
          }
          .calibration-bar {
            width: 1.0in;
            height: 2px;
            background: #000;
          }
        ` }} />

        {pages.map((pageCustomers, pageIdx) => (
          <div key={pageIdx} className="postcard-sheet">
            {/* Calibration Bar for Print Alignment Verification */}
            <div className="mb-1 flex items-center justify-between text-[8px] text-gray-500 print:text-black">
              <span>Sheet {pageIdx + 1} of {pages.length}</span>
              <div className="flex items-center gap-1">
                <span>1-inch calibration:</span>
                <div className="calibration-bar inline-block" />
              </div>
            </div>

            <div className="postcard-grid">
              {Array.from({ length: 4 }).map((_, slotIdx) => {
                const customer = pageCustomers[slotIdx]
                if (!customer) {
                  return <div key={slotIdx} className="postcard-card" />
                }

                let nextDueFormatted = ''
                try {
                  const d = nextDue(customer)
                  if (d) nextDueFormatted = formatDate(d)
                } catch {
                  nextDueFormatted = ''
                }

                const { street, city, state, zip } = parseUSAddress(customer.address)
                const cityStateZip = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')

                return (
                  <div key={slotIdx} className="postcard-card">
                    {/* Top message / reminder info */}
                    <div>
                      <div className="border-b border-gray-300 pb-2">
                        <div className="text-xs font-bold uppercase tracking-wider text-blue-900">
                          {company}
                        </div>
                        {phone && <div className="text-[10px] text-gray-600">{phone}</div>}
                      </div>

                      <div className="mt-2 text-center">
                        <div className="text-xs font-bold uppercase text-red-800">
                          Septic Service Reminder
                        </div>
                        <div className="mt-1 text-[10px] leading-tight text-gray-700">
                          Hi {customer.name}, regular septic pumping protects your tank and drainfield from expensive failure.
                        </div>
                      </div>

                      <div className="mt-2 rounded bg-gray-50 p-2 text-[10px] leading-snug">
                        <div><span className="font-semibold">Last pumped:</span> {customer.lastPumped || 'Not recorded'}</div>
                        {customer.tankSizeGal && <div><span className="font-semibold">Tank size:</span> {customer.tankSizeGal} gal</div>}
                        {nextDueFormatted && <div><span className="font-semibold text-red-700">Recommended service:</span> {nextDueFormatted}</div>}
                      </div>
                    </div>

                    {/* Bottom mailing area: return info + recipient + stamp */}
                    <div className="border-t border-gray-300 pt-2">
                      <div className="flex items-start justify-between">
                        <div className="text-[8px] text-gray-500">
                          <div className="font-bold">{company}</div>
                          <div>Service Department</div>
                          {phone && <div>Call/Text: {phone}</div>}
                        </div>
                        <div className="flex h-10 w-10 items-center justify-center border border-gray-400 text-center text-[7px] text-gray-500">
                          POSTAGE<br />STAMP
                        </div>
                      </div>

                      <div className="mt-3 pl-8 text-[11px] font-medium leading-tight">
                        <div className="font-bold">{customer.name}</div>
                        <div>{street || customer.address}</div>
                        {cityStateZip && <div>{cityStateZip}</div>}
                      </div>
                    </div>
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
