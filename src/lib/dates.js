function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
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
  d.setDate(d.getDate() + days)
  return toISO(d)
}

export function daysBetween(fromISO, toISOStr) {
  return Math.round((parseISO(toISOStr) - parseISO(fromISO)) / 86400000)
}

// Commercial (grease-trap) accounts run a tight cycle; residential run 36 months.
// There is no `type` field — commercial-ness is derived solely from the cycle.
export function isCommercial(customer) {
  return customer.cycleMonths <= 3
}

export function nextDue(customer) {
  const d = parseISO(customer.lastPumped)
  d.setMonth(d.getMonth() + customer.cycleMonths)
  return d
}

export function daysUntilDue(customer) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((nextDue(customer) - today) / 86400000)
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
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}
