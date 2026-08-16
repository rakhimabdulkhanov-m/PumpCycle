import { nextDue, formatDate } from './dates.js'

/**
 * Escapes a single value for standard RFC 4180 CSV output.
 */
export function escapeCSVValue(value) {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

/**
 * Formats a 2D array of rows into an RFC 4180 CSV string.
 */
export function formatCSV(rows) {
  return rows.map((row) => row.map(escapeCSVValue).join(',')).join('\r\n')
}

/**
 * Parses a US single-line address into components: { street, city, state, zip }.
 */
export function parseUSAddress(addressStr) {
  if (!addressStr || typeof addressStr !== 'string') {
    return { street: '', city: '', state: '', zip: '' }
  }
  const clean = addressStr.trim()
  const parts = clean.split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return { street: '', city: '', state: '', zip: '' }
  if (parts.length === 1) {
    // E.g. "1248 Dallas Cherryville Hwy Bessemer City NC 28016" (no commas)
    const stateZipMatch = clean.match(/\b([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/)
    if (stateZipMatch) {
      const state = stateZipMatch[1].toUpperCase()
      const zip = stateZipMatch[2] || ''
      const beforeState = clean.slice(0, stateZipMatch.index).trim()
      return { street: beforeState, city: '', state, zip }
    }
    return { street: parts[0], city: '', state: '', zip: '' }
  }

  const street = parts[0]
  let city
  let state
  let zip

  if (parts.length === 2) {
    // E.g. "123 Main St, NC 28052" or "123 Main St, Gastonia NC"
    const lastPart = parts[1]
    const stateZipMatch = lastPart.match(/([A-Za-z]{2})\s*(\d{5}(?:-\d{4})?)?$/)
    if (stateZipMatch) {
      state = stateZipMatch[1].toUpperCase()
      zip = stateZipMatch[2] || ''
      city = lastPart.slice(0, stateZipMatch.index).trim()
    } else {
      city = lastPart
      state = ''
      zip = ''
    }
  } else {
    // 3 or more parts: "123 Main St, Gastonia, NC 28052"
    city = parts[1]
    const stateZipPart = parts.slice(2).join(', ').trim()
    const match = stateZipPart.match(/^([A-Za-z]{2,})\s*(\d{5}(?:-\d{4})?)?/)
    if (match) {
      state = match[1].toUpperCase()
      zip = match[2] || ''
    } else {
      state = stateZipPart
      zip = ''
    }
  }

  return { street, city, state, zip }
}

/**
 * Parses a person/company name into { firstName, lastName, displayName }.
 */
export function parseCustomerName(nameStr) {
  if (!nameStr || typeof nameStr !== 'string') {
    return { firstName: '', lastName: '', displayName: '' }
  }
  const clean = nameStr.trim()
  if (clean.includes(',')) {
    // "Smith, John"
    const [last, ...rest] = clean.split(',')
    const first = rest.join(' ').trim()
    return { firstName: first, lastName: last.trim(), displayName: clean }
  }
  const parts = clean.split(/\s+/)
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: '', displayName: clean }
  }
  const firstName = parts.slice(0, -1).join(' ')
  const lastName = parts[parts.length - 1]
  return { firstName, lastName, displayName: clean }
}

/**
 * Generates standard full Customer CSV export.
 */
export function exportCustomersCSV(customers = []) {
  const headers = [
    'ID',
    'Name',
    'Phone',
    'Email',
    'Address',
    'Tank Size (Gal)',
    'Last Pumped',
    'Cycle (Months)',
    'Next Due',
    'Pin Note',
    'Notes',
    'Latitude',
    'Longitude',
    'Location Precision',
  ]

  const rows = [headers]

  for (const c of customers) {
    let nextDueStr = ''
    try {
      const d = nextDue(c)
      if (d) nextDueStr = formatDate(d)
    } catch {
      nextDueStr = ''
    }

    rows.push([
      c.id || '',
      c.name || '',
      c.phone || '',
      c.email || '',
      c.address || '',
      c.tankSizeGal != null ? String(c.tankSizeGal) : '',
      c.lastPumped || '',
      c.cycleMonths != null ? String(c.cycleMonths) : '',
      nextDueStr,
      c.pinNote || '',
      c.notes || '',
      c.lat != null ? String(c.lat) : '',
      c.lng != null ? String(c.lng) : '',
      c.locationPrecision || '',
    ])
  }

  return formatCSV(rows)
}

/**
 * Generates QuickBooks-import-shaped customer CSV.
 * Standard format for QuickBooks Customer Contact Import.
 */
export function exportQuickBooksCSV(customers = []) {
  const headers = [
    'Customer',
    'Company',
    'First Name',
    'Last Name',
    'Phone',
    'Email',
    'Street',
    'City',
    'State',
    'ZIP',
    'Country',
    'Notes',
  ]

  const rows = [headers]

  for (const c of customers) {
    const { firstName, lastName, displayName } = parseCustomerName(c.name)
    const { street, city, state, zip } = parseUSAddress(c.address)

    const notesParts = []
    if (c.tankSizeGal) notesParts.push(`Tank: ${c.tankSizeGal} gal`)
    if (c.lastPumped) notesParts.push(`Last pumped: ${c.lastPumped}`)
    if (c.cycleMonths) notesParts.push(`Cycle: ${c.cycleMonths}m`)
    if (c.pinNote) notesParts.push(`Lid location: ${c.pinNote}`)
    if (c.notes) notesParts.push(`Notes: ${c.notes}`)

    const notes = notesParts.join(' | ')

    rows.push([
      displayName,
      '', // Company (blank for residential unless specified)
      firstName,
      lastName,
      c.phone || '',
      c.email || '',
      street,
      city,
      state,
      zip,
      'USA',
      notes,
    ])
  }

  return formatCSV(rows)
}

/**
 * Triggers a browser file download of CSV content.
 */
export function downloadCSV(filename, csvContent) {
  if (typeof document === 'undefined') return
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.setAttribute('href', url)
  link.setAttribute('download', filename)
  link.style.visibility = 'hidden'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
