import { json } from '../lib/json.js'
import { projectPhoto } from '../lib/projection.js'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const MAX_PHOTO_BYTES = 5 * 1024 * 1024 // 5 MB safety cap
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
])

function reserveSeqs(db, count) {
  return db.prepare('UPDATE seq_counter SET value = value + ? WHERE id = 1').bind(count)
}

function seqValue(count, index) {
  const offset = count - index - 1
  return `(SELECT value${offset ? ` - ${offset}` : ''} FROM seq_counter WHERE id = 1)`
}

function audit(db, now, actorUserId, entity, entityId, action, before, after) {
  return db
    .prepare(
      `INSERT INTO audit_log (at, actor, entity, entity_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(now, actorUserId, entity, entityId, action, JSON.stringify(before), JSON.stringify(after))
}

export async function upload(request, env, ctx, tenant, auth) {
  if (!tenant.r2) {
    return json({ ok: false, error: 'photo storage not configured' }, 503)
  }

  let customerId
  let visitId
  let photoId
  let caption
  let width
  let height
  let contentType = 'image/jpeg'
  let fileBytes = null

  const contentTypeHeader = request.headers.get('content-type') || ''
  if (contentTypeHeader.includes('multipart/form-data')) {
    const formData = await request.formData()
    const file = formData.get('file')
    customerId = String(formData.get('customerId') || '').trim()
    const rawVisit = formData.get('visitId')
    visitId = rawVisit ? String(rawVisit).trim() : null
    const rawPhotoId = formData.get('photoId')
    photoId = rawPhotoId ? String(rawPhotoId).trim() : null
    caption = String(formData.get('caption') || '').trim()
    width = parseInt(formData.get('width'), 10) || 0
    height = parseInt(formData.get('height'), 10) || 0
    if (file && typeof file.arrayBuffer === 'function') {
      fileBytes = await file.arrayBuffer()
      if (file.type && ALLOWED_CONTENT_TYPES.has(file.type)) {
        contentType = file.type
      }
    }
  } else {
    customerId = String(request.headers.get('x-customer-id') || '').trim()
    const rawVisit = request.headers.get('x-visit-id')
    visitId = rawVisit ? String(rawVisit).trim() : null
    const rawPhotoId = request.headers.get('x-photo-id')
    photoId = rawPhotoId ? String(rawPhotoId).trim() : null
    caption = String(request.headers.get('x-caption') || '').trim()
    width = parseInt(request.headers.get('x-width'), 10) || 0
    height = parseInt(request.headers.get('x-height'), 10) || 0
    if (ALLOWED_CONTENT_TYPES.has(contentTypeHeader)) {
      contentType = contentTypeHeader
    }
    fileBytes = await request.arrayBuffer()
  }

  if (!customerId || !ID_RE.test(customerId)) {
    return json({ ok: false, error: 'customerId is invalid' }, 400)
  }

  const customerRow = await tenant.db
    .prepare('SELECT id FROM customers WHERE id = ?')
    .bind(customerId)
    .first()
  if (!customerRow) {
    return json({ ok: false, error: 'customer not found' }, 404)
  }

  if (visitId) {
    if (!ID_RE.test(visitId)) {
      return json({ ok: false, error: 'visitId is invalid' }, 400)
    }
    const visitRow = await tenant.db
      .prepare('SELECT id FROM visits WHERE id = ? AND customer_id = ?')
      .bind(visitId, customerId)
      .first()
    if (!visitRow) {
      return json({ ok: false, error: 'visit not found for this customer' }, 404)
    }
  }

  if (!fileBytes || fileBytes.byteLength === 0) {
    return json({ ok: false, error: 'file is empty' }, 400)
  }

  if (fileBytes.byteLength > MAX_PHOTO_BYTES) {
    return json({ ok: false, error: 'file exceeds 5MB limit' }, 400)
  }

  const finalPhotoId = photoId && ID_RE.test(photoId)
    ? photoId
    : `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const r2Key = `photos/${customerId}/${finalPhotoId}.jpg`

  await tenant.r2.put(r2Key, fileBytes, {
    httpMetadata: { contentType },
    customMetadata: { customerId, photoId: finalPhotoId },
  })

  const now = Date.now()
  const bytes = fileBytes.byteLength
  await tenant.db.batch([
    reserveSeqs(tenant.db, 1),
    tenant.db.prepare(
      `INSERT INTO photos
       (id, customer_id, visit_id, r2_key, content_type, bytes, width, height,
        caption, blob_state, created_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored', ?, ${seqValue(1, 0)})`
    ).bind(finalPhotoId, customerId, visitId, r2Key, contentType, bytes, width, height, caption, now),
    audit(tenant.db, now, auth.user.id, 'photo', finalPhotoId, 'photo.upload', null, {
      id: finalPhotoId,
      customerId,
      visitId,
      r2Key,
      bytes,
      contentType,
    }),
  ])

  const inserted = await tenant.db
    .prepare('SELECT * FROM photos WHERE id = ?')
    .bind(finalPhotoId)
    .first()

  return json({ ok: true, photo: projectPhoto(inserted) })
}

export async function getPhoto(request, env, ctx, tenant) {
  const url = new URL(request.url)
  const segments = url.pathname.split('/')
  const photoId = segments[segments.length - 1]

  if (!photoId || !ID_RE.test(photoId)) {
    return json({ ok: false, error: 'invalid photo id' }, 400)
  }

  const photo = await tenant.db
    .prepare('SELECT * FROM photos WHERE id = ? AND archived_at IS NULL')
    .bind(photoId)
    .first()

  if (!photo) {
    return json({ ok: false, error: 'photo not found' }, 404)
  }

  if (!tenant.r2) {
    return json({ ok: false, error: 'photo storage not configured' }, 503)
  }

  const object = await tenant.r2.get(photo.r2_key)
  if (!object) {
    return json({ ok: false, error: 'photo content not found' }, 404)
  }

  const headers = new Headers()
  headers.set('Content-Type', photo.content_type || 'image/jpeg')
  headers.set('Content-Length', String(photo.bytes || object.size))
  headers.set('Cache-Control', 'private, max-age=86400, immutable')

  return new Response(object.body, {
    status: 200,
    headers,
  })
}
