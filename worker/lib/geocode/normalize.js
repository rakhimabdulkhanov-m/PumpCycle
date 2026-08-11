/**
 * Pure text handling for the geocoder: no network, no Workers APIs, no state.
 * Everything here is directly unit-testable and is exercised by
 * test/lib/geocode-normalize.test.js in the node pool.
 */

/**
 * Mailing addresses that are not places.
 *
 * A PO Box or a legacy rural-route box number has no parcel behind it. Asking
 * Census or Nominatim about one burns a round trip and, at best, answers with
 * the post office - a pin in the wrong yard is worse than no pin. Both forms are
 * common in this niche: rural customers give the address their mail goes to, not
 * the one the truck drives to.
 */
const PO_BOX_RE = /\b(?:p\.?\s*o\.?\s*box|post\s+office\s+box|pob)\b\.?\s*#?\s*\d/i

/**
 * RR 2 Box 145 / HC 61 Box 9. The "Box <n>" part is required on purpose: without
 * it "Route 66" and "RR crossing" would be swallowed too.
 */
const RURAL_ROUTE_RE =
  /\b(?:rr|r\.\s*r\.|hc|h\.\s*c\.|rural\s+route|highway\s+contract)\s*#?\s*\d+[\s,]+box\b/i

/**
 * Unit designators, stripped before the address goes upstream. Census and
 * Nominatim both do worse with them attached, and the unit is never what decides
 * where the tank lid is.
 *
 * The token after the designator must contain a digit or be a single letter
 * ("2", "B", "300", "12A"). Without that rule "100 Suite Ln" loses its street
 * type. The (?![a-z]) after the designator stops "Roomy Ln" being read as
 * room + unit Y, while still allowing the unspaced "Apt2". "fl" is deliberately
 * absent from the list: it would eat the state in "Miami, FL 33131".
 */
const UNIT_RE =
  /(?:^|[\s,])(?:#\s*[a-z0-9][a-z0-9-]*|(?:apt|apartment|unit|ste|suite|rm|room|bldg|building|trlr|trailer)(?![a-z])\.?\s*#?\s*(?:[a-z]?\d[a-z0-9-]*|[a-z]))(?=$|[\s,])/gi

/** Collapses whitespace and tidies the separator debris a strip leaves behind. */
function tidy(s) {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;])/g, '$1')
    .replace(/([,;])\s*(?=[,;])/g, '')
    .replace(/^[,;\s]+/, '')
    .replace(/[,;\s]+$/, '')
    .trim()
}

/** Whitespace-normalised, trimmed version of whatever the user typed. */
export function normalizeQuery(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @returns {'ungeocodable_po_box'|'ungeocodable_rural_route'|null}
 */
export function detectUngeocodable(query) {
  if (PO_BOX_RE.test(query)) return 'ungeocodable_po_box'
  if (RURAL_ROUTE_RE.test(query)) return 'ungeocodable_rural_route'
  return null
}

/** Removes unit designators. The original string is kept and echoed separately. */
export function stripUnits(query) {
  return tidy(query.replace(UNIT_RE, ' '))
}

/**
 * Cache key form: case, punctuation and spacing collapsed away, so
 * "1184 Philadelphia Church Rd., Dallas, NC" and
 * "1184 philadelphia church rd  dallas nc" are one cache entry.
 */
export function canonicalKey(query) {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Pulls a two-letter state and a ZIP off the end of the last comma-separated
 * chunk. Anchored to the end on purpose: an unanchored two-letter match reads
 * "North Carolina" as state "NO".
 */
const STATE_TAIL_RE = /\b([A-Za-z]{2})\b\s*(\d{5})?(?:-\d{4})?\s*$/

function splitTail(last) {
  const m = STATE_TAIL_RE.exec(last)
  if (m) return { rest: last.slice(0, m.index).trim(), state: m[1].toUpperCase(), zip: m[2] || '' }
  const z = /^(\d{5})(?:-\d{4})?$/.exec(last)
  if (z) return { rest: '', state: '', zip: z[1] }
  return { rest: last, state: '', zip: '' }
}

/**
 * Best-effort split of a one-line US address. Ported from
 * onboarding/scripts/import.py parse_address_parts(), minus its DEFAULT_STATE
 * fallback: that script knew its client was in NC, this endpoint serves whoever
 * is typing, and guessing a state is exactly how a pin lands in another state.
 *
 * @returns {{street:string, city:string, state:string, zip:string}}
 */
export function parseAddressParts(address) {
  const parts = String(address || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  const street = parts[0] || ''
  let city = ''
  let state = ''
  let zip = ''
  if (parts.length > 1) {
    const tail = splitTail(parts[parts.length - 1])
    state = tail.state
    zip = tail.zip
    const middle = parts.slice(1, parts.length - 1)
    city = middle.length ? middle[0] : tail.rest
  }
  return { street, city, state, zip }
}

/** "4384 Jennifer Lane" -> "Jennifer Lane". Used to build the suggestion query. */
export function stripHouseNumber(street) {
  return String(street || '')
    .replace(/^\s*\d+[a-z]?(?:\s*[-/]\s*\d+[a-z]?)?\s+/i, '')
    .trim()
}
