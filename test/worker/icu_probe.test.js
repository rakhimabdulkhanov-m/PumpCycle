// Guard: workerd must ship ICU timezone data.
//
// The reminder send-hour design computes a tenant's local date and hour with
// Intl.DateTimeFormat(..., { timeZone }) rather than a hand-rolled US DST
// offset table. Probed 2026-08-13 and confirmed. If a future runtime drops the
// tz database these fail loudly here, instead of every tenant silently
// collapsing to UTC and mail going out at the wrong hour.
import { describe, expect, it } from 'vitest'

describe('workerd ICU timezone data', () => {
  it('formats a UTC instant into a named US zone as YYYY-MM-DD', () => {
    // 2026-08-13T02:30:00Z is 2026-08-12 22:30 in New York (EDT, UTC-4).
    // A workerd without tz data either throws or silently returns UTC.
    const instant = new Date('2026-08-13T02:30:00Z')
    const nyDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant)
    expect(nyDate).toBe('2026-08-12')
  })

  it('reports the local hour in a named zone', () => {
    const instant = new Date('2026-08-13T02:30:00Z')
    const hour = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hour12: false,
    }).format(instant)
    expect(hour).toBe('22')
  })

  it('observes DST, not a fixed offset', () => {
    // Same wall-clock UTC instant, six months apart. EDT (UTC-4) in August,
    // EST (UTC-5) in January. A fixed-offset fake would return the same hour.
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hour12: false,
    })
    const summer = fmt.format(new Date('2026-08-13T12:00:00Z'))
    const winter = fmt.format(new Date('2026-01-13T12:00:00Z'))
    expect(summer).toBe('08')
    expect(winter).toBe('07')
  })

  it('handles the other zones a US client book can land in', () => {
    const instant = new Date('2026-08-13T02:30:00Z')
    const zones = {
      'America/Chicago': '2026-08-12',
      'America/Denver': '2026-08-12',
      'America/Phoenix': '2026-08-12',
      'America/Los_Angeles': '2026-08-12',
      'America/Anchorage': '2026-08-12',
      'Pacific/Honolulu': '2026-08-12',
    }
    for (const [timeZone, expected] of Object.entries(zones)) {
      const got = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(instant)
      expect(got, timeZone).toBe(expected)
    }
  })

  it('rejects a bogus zone rather than silently falling back to UTC', () => {
    expect(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Mars/Olympus' }))
      .toThrow(RangeError)
  })
})
