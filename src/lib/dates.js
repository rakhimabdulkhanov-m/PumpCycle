function parseISO(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const [y, m, d] = s.split('-').map(Number)
  const parsed = new Date(y, m - 1, d)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function toISO(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function todayISO() {
  return toISO(new Date())
}

// The calendar date it currently is in a named IANA zone, as YYYY-MM-DD.
//
// A Worker's ambient clock is UTC, so at 20:00 Eastern it already believes it
// is tomorrow. Every send decision has to be made against the tenant's own
// calendar instead. workerd ships ICU timezone data (guarded by
// test/worker/icu_probe.test.js), and 'en-CA' formats as YYYY-MM-DD directly.
// An unknown zone throws RangeError out of Intl rather than quietly becoming
// UTC, which is the behaviour we want: a misconfigured tenant must fail loudly,
// not mail at the wrong hour forever.
export function todayISOInZone(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

// The hour (0-23) it currently is in a named IANA zone.
export function hourInZone(timeZone) {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).format(new Date())
  // 'en-US' renders midnight as '24' in some ICU versions; normalise to 0.
  return Number(hour) % 24
}

// Resolves the optional trailing `today` argument carried by the due-date
// functions below. Undefined means "use the ambient clock", which is what the
// browser wants and what every existing caller gets. An explicitly supplied
// value is always a YYYY-MM-DD string and is parsed strictly: a caller that
// passes a bad date is the Worker, and silently falling back to a UTC clock
// there sends mail on the wrong day without anyone noticing.
export function startOfDay(today) {
  if (today === undefined || today === null) {
    const now = new Date()
    now.setHours(0, 0, 0, 0)
    return now
  }
  const parsed = parseISO(today)
  if (!parsed) throw new TypeError(`today must be a YYYY-MM-DD string, got ${JSON.stringify(today)}`)
  return parsed
}

export function shiftISO(iso, days) {
  const d = parseISO(iso)
  if (!d) return null
  d.setDate(d.getDate() + days)
  return toISO(d)
}

export function daysBetween(fromISO, toISOStr) {
  const from = parseISO(fromISO)
  const to = parseISO(toISOStr)
  return from && to ? Math.round((to - from) / 86400000) : 0
}

// Commercial (grease-trap) accounts run a tight cycle; residential run 36 months.
// There is no `type` field — commercial-ness is derived solely from the cycle.
export function isCommercial(customer) {
  return customer.cycleMonths <= 3
}

export function nextDue(customer) {
  const d = parseISO(customer.lastPumped)
  if (!d) return null
  d.setMonth(d.getMonth() + customer.cycleMonths)
  return d
}

// `today` is optional and defaults to the ambient clock. The Worker passes the
// tenant's local date so a send decision is never made against UTC.
export function daysUntilDue(customer, today) {
  const due = nextDue(customer)
  if (!due) return Number.NEGATIVE_INFINITY
  return Math.round((due - startOfDay(today)) / 86400000)
}

// 'overdue' | 'due-soon' (within 60 days) | 'ok'
export function dueStatus(customer, today) {
  const days = daysUntilDue(customer, today)
  if (days < 0) return 'overdue'
  if (days <= 60) return 'due-soon'
  return 'ok'
}

export function formatDate(value) {
  const d = typeof value === 'string' ? parseISO(value) : value
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return 'Unknown'
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}
