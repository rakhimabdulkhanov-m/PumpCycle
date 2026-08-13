import { todayISO } from './dates.js'

export function freshAddCustomerDraft(today = todayISO()) {
  return {
    name: '',
    address: '',
    phone: '',
    email: '',
    tankSizeGal: '1000',
    lastPumped: today,
    cycleMonths: '36',
    notes: '',
  }
}

export function isAddCustomerDraftDirty(draft, defaults) {
  return Object.keys(defaults).some((key) => String(draft[key] ?? '') !== String(defaults[key]))
}

const STATE_CODES = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA',
  Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS',
  Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA',
  Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT',
  Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND',
  Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX',
  Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV',
  Wisconsin: 'WI', Wyoming: 'WY', 'District of Columbia': 'DC',
}

const isCountry = (part) => /^(united states(?: of america)?|usa|us)$/i.test(part)
const isCounty = (part) => /\b(county|parish|borough|census area)\b/i.test(part)

/** Remove provider-only hierarchy while retaining the road/locality/state/ZIP a human checks. */
export function compactMatchedAddress(value) {
  const parts = String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !isCountry(part))
  if (parts.length <= 1) return parts[0] || ''

  let zip = ''
  let state = ''
  let stateIndex = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    const zipMatch = parts[i].match(/\b\d{5}(?:-\d{4})?\b/)
    if (!zip && zipMatch) zip = zipMatch[0]
    const withoutZip = parts[i].replace(/\b\d{5}(?:-\d{4})?\b/, '').trim()
    const code = STATE_CODES[withoutZip] || (/^[A-Z]{2}$/i.test(withoutZip) ? withoutZip.toUpperCase() : '')
    if (!state && code) {
      state = code
      stateIndex = i
    }
  }

  const first = parts[0].replace(/\s+/g, ' ')
  let city = ''
  const beforeState = stateIndex >= 0 ? parts.slice(1, stateIndex) : parts.slice(1)
  for (let i = beforeState.length - 1; i >= 0; i--) {
    const candidate = beforeState[i]
    if (!isCounty(candidate) && !/\b(township|district|industrial park)\b/i.test(candidate)) {
      city = candidate
      break
    }
  }
  if (city.toLowerCase() === first.toLowerCase()) city = ''
  const region = [state, zip].filter(Boolean).join(' ')
  return [first, city, region].filter(Boolean).join(', ')
}

export function addCustomerNavigationKind({ geocoded, locationPrecision }) {
  if (geocoded && (locationPrecision === 'house' || locationPrecision === 'house_approx')) {
    return 'show'
  }
  return 'place'
}
