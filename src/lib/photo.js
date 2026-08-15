export const MAX_PHOTO_EDGE = 1600
export const JPEG_QUALITY = 0.8
export const MAX_FILE_BYTES = 5 * 1024 * 1024

export function newPhotoId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function newVisitId() {
  return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Downscale and compress an image file to max 1600px on the long edge and ~300-500KB JPEG.
 * Automatically honors EXIF orientation.
 *
 * @param {File|Blob} file
 * @param {object} [options]
 * @param {number} [options.maxEdge=1600]
 * @param {number} [options.quality=0.8]
 * @returns {Promise<{ blob: Blob, dataUrl: string, width: number, height: number, bytes: number }>}
 */
export async function downscaleImage(file, { maxEdge = MAX_PHOTO_EDGE, quality = JPEG_QUALITY } = {}) {
  if (!file) throw new Error('No file provided')

  let bitmap = null
  let image = null
  let srcWidth = 0
  let srcHeight = 0

  if (typeof createImageBitmap === 'function') {
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      srcWidth = bitmap.width
      srcHeight = bitmap.height
    } catch {
      // Fall back to Image element if createImageBitmap fails
    }
  }

  if (!bitmap) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })

    image = await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = reject
      img.src = dataUrl
    })
    srcWidth = image.naturalWidth || image.width
    srcHeight = image.naturalHeight || image.height
  }

  const scale = Math.min(maxEdge / srcWidth, maxEdge / srcHeight, 1)
  const targetWidth = Math.max(1, Math.round(srcWidth * scale))
  const targetHeight = Math.max(1, Math.round(srcHeight * scale))

  let canvas
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(targetWidth, targetHeight)
  } else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight
  } else {
    throw new Error('Canvas not supported in this environment')
  }

  const ctx = canvas.getContext('2d')
  if (bitmap) {
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight)
    bitmap.close?.()
  } else if (image) {
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight)
  }

  let blob
  let dataUrl
  if (canvas.convertToBlob) {
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
    dataUrl = await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.readAsDataURL(blob)
    })
  } else {
    dataUrl = canvas.toDataURL('image/jpeg', quality)
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  }

  return {
    blob,
    dataUrl,
    width: targetWidth,
    height: targetHeight,
    bytes: blob ? blob.size : 0,
  }
}

/**
 * Returns a displayable URL for a photo object.
 * Uses local dataUrl if present (e.g. demo mode or offline outbox cache),
 * otherwise defaults to the authenticated /api/photos/:id streaming endpoint.
 */
export function photoUrl(photo) {
  if (!photo) return ''
  if (photo.dataUrl) return photo.dataUrl
  if (photo.id) return `/api/photos/${encodeURIComponent(photo.id)}`
  return ''
}
