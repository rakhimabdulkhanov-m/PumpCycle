import { describe, expect, it } from 'vitest'
import { newPhotoId, newVisitId, photoUrl, MAX_PHOTO_EDGE, JPEG_QUALITY } from '../../src/lib/photo.js'

describe('photo utilities', () => {
  it('generates well-formed photo and visit IDs', () => {
    const p1 = newPhotoId()
    const p2 = newPhotoId()
    expect(p1).toMatch(/^p_[0-9a-z]+_[0-9a-z]+$/)
    expect(p2).toMatch(/^p_[0-9a-z]+_[0-9a-z]+$/)
    expect(p1).not.toBe(p2)

    const v1 = newVisitId()
    const v2 = newVisitId()
    expect(v1).toMatch(/^v_[0-9a-z]+_[0-9a-z]+$/)
    expect(v2).toMatch(/^v_[0-9a-z]+_[0-9a-z]+$/)
    expect(v1).not.toBe(v2)
  })

  it('computes correct photo URL with dataUrl or ID', () => {
    expect(photoUrl(null)).toBe('')
    expect(photoUrl({})).toBe('')
    expect(photoUrl({ dataUrl: 'data:image/jpeg;base64,123' })).toBe('data:image/jpeg;base64,123')
    expect(photoUrl({ id: 'p_abc_123' })).toBe('/api/photos/p_abc_123')
    expect(photoUrl({ id: 'p_abc_123', dataUrl: 'data:image/jpeg;base64,override' })).toBe(
      'data:image/jpeg;base64,override'
    )
  })

  it('exposes standard max edge and quality constants', () => {
    expect(MAX_PHOTO_EDGE).toBe(1600)
    expect(JPEG_QUALITY).toBe(0.8)
  })
})
