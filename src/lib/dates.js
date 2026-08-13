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

export function daysUntilDue(customer) {
  const due = nextDue(customer)
  if (!due) return Number.NEGATIVE_INFINITY
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((due - today) / 86400000)
}

// 'overdue' | 'due-soon' (within 60 days) | 'ok'
export function dueStatus(customer) {
  const days = daysUntilDue(customer)
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
