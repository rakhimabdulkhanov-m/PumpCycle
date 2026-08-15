import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { upload, getPhoto } from '../../worker/api/photos.js'
import { nextSeq } from '../../worker/lib/seq.js'

const db = () => env.DB_DEV
const r2 = () => env.R2_DEV
let serial = 0
const unique = (prefix) => `${prefix}-${++serial}`

async function insertCustomer(id, seq, overrides = {}) {
  await db()
    .prepare(
      `INSERT INTO customers
       (id, name, address, phone, email, lat, lng, location_precision,
        tank_size_gal, last_pumped, cycle_months, archived_at, created_at, updated_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      overrides.name ?? 'Photo Test Customer',
      overrides.address ?? '',
      overrides.phone ?? '',
      overrides.email ?? '',
      overrides.lat ?? null,
      overrides.lng ?? null,
      overrides.locationPrecision ?? '',
      overrides.tankSizeGal ?? 0,
      overrides.lastPumped ?? null,
      overrides.cycleMonths ?? 36,
      overrides.archivedAt ?? null,
      1,
      1,
      seq
    )
    .run()
}

async function insertVisit(id, customerId, seq) {
  await db()
    .prepare(
      `INSERT INTO visits
       (id, customer_id, visited_on, sets_last_pumped, created_at, seq)
       VALUES (?, ?, '2026-08-15', 1, 1, ?)`
    )
    .bind(id, customerId, seq)
    .run()
}

describe('photos API (upload & streaming retrieval)', () => {
  it('rejects uploads if R2 is not configured on the tenant', async () => {
    const tenant = { db: db(), r2: null }
    const auth = { user: { id: 'u1' } }
    const req = new Request('https://app.pumpcycle.net/api/photos/upload', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
      headers: { 'x-customer-id': 'c1', 'content-type': 'image/jpeg' },
    })
    const res = await upload(req, env, {}, tenant, auth)
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toContain('photo storage not configured')
  })

  it('rejects upload for unknown customer', async () => {
    const tenant = { db: db(), r2: r2() }
    const auth = { user: { id: 'u1' } }
    const req = new Request('https://app.pumpcycle.net/api/photos/upload', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
      headers: { 'x-customer-id': 'non-existent-c', 'content-type': 'image/jpeg' },
    })
    const res = await upload(req, env, {}, tenant, auth)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('customer not found')
  })

  it('rejects empty file payload', async () => {
    const [seq] = await nextSeq(db())
    const customerId = unique('c_photo_empty')
    await insertCustomer(customerId, seq)

    const tenant = { db: db(), r2: r2() }
    const auth = { user: { id: 'u1' } }
    const req = new Request('https://app.pumpcycle.net/api/photos/upload', {
      method: 'POST',
      body: new Uint8Array([]),
      headers: { 'x-customer-id': customerId, 'content-type': 'image/jpeg' },
    })
    const res = await upload(req, env, {}, tenant, auth)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('empty')
  })

  it('successfully uploads photo via binary stream, writes to R2 and D1, and serves via getPhoto', async () => {
    const [cSeq, vSeq] = await nextSeq(db(), 2)
    const customerId = unique('c_photo_bin')
    const visitId = unique('v_photo_bin')
    await insertCustomer(customerId, cSeq)
    await insertVisit(visitId, customerId, vSeq)

    const tenant = { db: db(), r2: r2() }
    const auth = { user: { id: 'u1' } }
    const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]) // sample jpeg magic

    const req = new Request('https://app.pumpcycle.net/api/photos/upload', {
      method: 'POST',
      body: imageBytes,
      headers: {
        'x-customer-id': customerId,
        'x-visit-id': visitId,
        'x-caption': 'Lid located under porch',
        'x-width': '1600',
        'x-height': '1200',
        'content-type': 'image/jpeg',
      },
    })

    const uploadRes = await upload(req, env, {}, tenant, auth)
    expect(uploadRes.status).toBe(200)
    const uploadBody = await uploadRes.json()
    expect(uploadBody.ok).toBe(true)
    expect(uploadBody.photo).toBeDefined()
    expect(uploadBody.photo.customerId).toBe(customerId)
    expect(uploadBody.photo.visitId).toBe(visitId)
    expect(uploadBody.photo.caption).toBe('Lid located under porch')
    expect(uploadBody.photo.width).toBe(1600)
    expect(uploadBody.photo.height).toBe(1200)
    expect(uploadBody.photo.bytes).toBe(imageBytes.byteLength)
    expect(uploadBody.photo.blobState).toBe('stored')

    const photoId = uploadBody.photo.id

    // Now retrieve via getPhoto
    const getReq = new Request(`https://app.pumpcycle.net/api/photos/${photoId}`)
    const getRes = await getPhoto(getReq, env, {}, tenant)
    expect(getRes.status).toBe(200)
    expect(getRes.headers.get('content-type')).toBe('image/jpeg')
    expect(getRes.headers.get('content-length')).toBe(String(imageBytes.byteLength))
    expect(getRes.headers.get('cache-control')).toContain('private, max-age=86400')

    const downloadedBytes = new Uint8Array(await getRes.arrayBuffer())
    expect(downloadedBytes).toEqual(imageBytes)
  })

  it('successfully uploads photo via FormData', async () => {
    const [cSeq] = await nextSeq(db())
    const customerId = unique('c_photo_form')
    await insertCustomer(customerId, cSeq)

    const tenant = { db: db(), r2: r2() }
    const auth = { user: { id: 'u1' } }
    const imageBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

    const formData = new FormData()
    formData.append('file', new File([imageBytes], 'lid.jpg', { type: 'image/jpeg' }))
    formData.append('customerId', customerId)
    formData.append('caption', 'Front yard cleanout')
    formData.append('width', '800')
    formData.append('height', '600')

    const req = new Request('https://app.pumpcycle.net/api/photos/upload', {
      method: 'POST',
      body: formData,
    })

    const uploadRes = await upload(req, env, {}, tenant, auth)
    expect(uploadRes.status).toBe(200)
    const uploadBody = await uploadRes.json()
    expect(uploadBody.ok).toBe(true)
    expect(uploadBody.photo.customerId).toBe(customerId)
    expect(uploadBody.photo.caption).toBe('Front yard cleanout')
    expect(uploadBody.photo.width).toBe(800)
    expect(uploadBody.photo.height).toBe(600)
  })
})
