import { formatDate } from '../lib/dates.js'
import { photoUrl } from '../lib/photo.js'
import { useDismissLayer } from '../lib/dismissLayer.js'

export default function PhotoModal({ photo, onClose, onArchive }) {
  useDismissLayer(true, onClose)

  if (!photo) return null

  const src = photoUrl(photo)

  async function handleDelete() {
    if (!window.confirm('Delete this photo?')) return
    if (onArchive) {
      await onArchive(photo.id)
    }
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[1200] flex flex-col items-center justify-center bg-black/90 p-4 text-white">
      <div className="absolute top-4 right-4 flex items-center gap-4">
        {onArchive && (
          <button
            type="button"
            onClick={handleDelete}
            className="flex min-h-11 items-center justify-center rounded-lg bg-red-800/90 px-4 py-2 text-base font-semibold text-white hover:bg-red-700 active:bg-red-900"
          >
            Delete
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close photo"
          className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-white/20 text-3xl leading-none text-white hover:bg-white/30 active:bg-white/40"
        >
          &times;
        </button>
      </div>

      <div className="flex max-h-[80vh] max-w-full flex-col items-center justify-center">
        {src ? (
          <img
            src={src}
            alt={photo.caption || 'Lid photo'}
            className="max-h-[70vh] max-w-full rounded-lg object-contain shadow-2xl"
          />
        ) : (
          <div className="flex h-64 w-64 items-center justify-center rounded-lg bg-gray-800 text-gray-400">
            No image data
          </div>
        )}

        {(photo.caption || photo.createdAt) && (
          <div className="mt-3 max-w-md text-center">
            {photo.caption && <p className="text-lg font-medium text-white">{photo.caption}</p>}
            {photo.createdAt && (
              <p className="text-sm text-gray-400">
                {formatDate(new Date(photo.createdAt).toISOString().slice(0, 10))}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
