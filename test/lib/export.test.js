import { describe, expect, it } from 'vitest'
import {
  escapeCSVValue,
  formatCSV,
  parseUSAddress,
  parseCustomerName,
  exportCustomersCSV,
  exportQuickBooksCSV,
} from '../../src/lib/export.js'

describe('src/lib/export.js', () => {
  describe('escapeCSVValue', () => {
    it('handles null and undefined', () => {
      expect(escapeCSVValue(null)).toBe('')
      expect(escapeCSVValue(undefined)).toBe('')
    })

    it('leaves simple strings untouched', () => {
      expect(escapeCSVValue('John Smith')).toBe('John Smith')
      expect(escapeCSVValue(1234)).toBe('1234')
    })

    it('wraps strings containing commas in double quotes', () => {
      expect(escapeCSVValue('Smith, John')).toBe('"Smith, John"')
    })

    it('escapes internal quotes and wraps in quotes', () => {
      expect(escapeCSVValue('John "Jack" Smith')).toBe('"John ""Jack"" Smith"')
    })

    it('escapes newlines', () => {
      expect(escapeCSVValue('Line 1\nLine 2')).toBe('"Line 1\nLine 2"')
    })
  })

  describe('formatCSV', () => {
    it('formats 2D array with CRLF line endings', () => {
      const rows = [
        ['Name', 'City'],
        ['John Smith', 'Gastonia, NC'],
      ]
      expect(formatCSV(rows)).toBe('Name,City\r\nJohn Smith,"Gastonia, NC"')
    })
  })

  describe('parseUSAddress', () => {
    it('handles empty or missing address', () => {
      expect(parseUSAddress('')).toEqual({ street: '', city: '', state: '', zip: '' })
      expect(parseUSAddress(null)).toEqual({ street: '', city: '', state: '', zip: '' })
    })

    it('parses standard 3-part address', () => {
      const res = parseUSAddress('123 Main St, Gastonia, NC 28052')
      expect(res.street).toBe('123 Main St')
      expect(res.city).toBe('Gastonia')
      expect(res.state).toBe('NC')
      expect(res.zip).toBe('28052')
    })

    it('parses 2-part address with state zip', () => {
      const res = parseUSAddress('123 Main St, Gastonia NC 28052')
      expect(res.street).toBe('123 Main St')
      expect(res.city).toBe('Gastonia')
      expect(res.state).toBe('NC')
      expect(res.zip).toBe('28052')
    })

    it('handles single part address gracefully', () => {
      const res = parseUSAddress('123 Main St')
      expect(res.street).toBe('123 Main St')
      expect(res.city).toBe('')
      expect(res.state).toBe('')
      expect(res.zip).toBe('')
    })
  })

  describe('parseCustomerName', () => {
    it('handles empty name', () => {
      expect(parseCustomerName('')).toEqual({ firstName: '', lastName: '', displayName: '' })
    })

    it('parses "First Last"', () => {
      const res = parseCustomerName('John Smith')
      expect(res.firstName).toBe('John')
      expect(res.lastName).toBe('Smith')
      expect(res.displayName).toBe('John Smith')
    })

    it('parses "First Middle Last"', () => {
      const res = parseCustomerName('John Robert Smith')
      expect(res.firstName).toBe('John Robert')
      expect(res.lastName).toBe('Smith')
    })

    it('parses "Last, First"', () => {
      const res = parseCustomerName('Smith, John')
      expect(res.firstName).toBe('John')
      expect(res.lastName).toBe('Smith')
      expect(res.displayName).toBe('Smith, John')
    })

    it('handles single word name', () => {
      const res = parseCustomerName('Hank')
      expect(res.firstName).toBe('Hank')
      expect(res.lastName).toBe('')
    })
  })

  describe('exportCustomersCSV', () => {
    it('generates full CSV with correct headers and values', () => {
      const customers = [
        {
          id: 'c-1',
          name: 'Hank Hill',
          phone: '704-555-0199',
          email: 'hank@example.com',
          address: '123 Main St, Gastonia, NC 28052',
          tankSizeGal: 1000,
          lastPumped: '2023-05-10',
          cycleMonths: 36,
          pinNote: 'Under back deck',
          notes: 'Watch for dog',
          lat: 35.26,
          lng: -81.18,
          locationPrecision: 'manual',
        },
      ]

      const csv = exportCustomersCSV(customers)
      expect(csv).toContain('ID,Name,Phone,Email,Address')
      expect(csv).toContain('Hank Hill,704-555-0199,hank@example.com,"123 Main St, Gastonia, NC 28052",1000,2023-05-10,36,')
      expect(csv).toContain('Under back deck,Watch for dog,35.26,-81.18,manual')
    })

    it('handles empty customer array', () => {
      const csv = exportCustomersCSV([])
      expect(csv).toBe('ID,Name,Phone,Email,Address,Tank Size (Gal),Last Pumped,Cycle (Months),Next Due,Pin Note,Notes,Latitude,Longitude,Location Precision')
    })

    it('handles missing fields gracefully', () => {
      const customers = [{ id: 'c-empty', name: 'Unknown' }]
      const csv = exportCustomersCSV(customers)
      expect(csv).toContain('c-empty,Unknown,,,,,,,,,,,')
    })
  })

  describe('exportQuickBooksCSV', () => {
    it('handles empty customer array', () => {
      const csv = exportQuickBooksCSV([])
      expect(csv).toBe('Customer,Company,First Name,Last Name,Phone,Email,Street,City,State,ZIP,Country,Notes')
    })

    it('handles customer with commas and quotes in notes', () => {
      const customers = [
        {
          name: 'Bob',
          notes: 'Has "big" dog, beware!',
        },
      ]
      const csv = exportQuickBooksCSV(customers)
      expect(csv).toContain('"Notes: Has ""big"" dog, beware!"')
    })

    it('generates QuickBooks formatted CSV with parsed columns', () => {
      const customers = [
        {
          id: 'c-1',
          name: 'John Smith',
          phone: '704-555-1234',
          email: 'john@smith.com',
          address: '456 Oak Rd, Dallas, NC 28034',
          tankSizeGal: 1500,
          lastPumped: '2024-01-15',
          cycleMonths: 24,
          pinNote: '2ft left of maple tree',
          notes: 'Gate code 1234',
        },
      ]

      const csv = exportQuickBooksCSV(customers)
      expect(csv).toContain('Customer,Company,First Name,Last Name,Phone,Email,Street,City,State,ZIP,Country,Notes')
      expect(csv).toContain('John Smith,,John,Smith,704-555-1234,john@smith.com,456 Oak Rd,Dallas,NC,28034,USA')
      expect(csv).toContain('Tank: 1500 gal | Last pumped: 2024-01-15 | Cycle: 24m | Lid location: 2ft left of maple tree | Notes: Gate code 1234')
    })
  })
})
