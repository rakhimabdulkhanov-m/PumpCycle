import { photoUrl } from '../lib/photo.js'

export default function PhotoStrip({ photos = [], onSelectPhoto, onAddPhotoClick }) {
  const activePhotos = photos.filter((p) => !p.archivedAt)

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {activePhotos.map((photo) => {
        const src = photoUrl(photo)
        return (
          <button
            key={photo.id}
            type="button"
            onClick={() => onSelectPhoto(photo)}
            className="group relative h-16 w-16 overflow-hidden rounded-lg border border-gray-300 bg-gray-100 shadow-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
            aria-label="View photo"
          >
            {src ? (
              <img
                src={src}
                alt={photo.caption || 'Lid photo'}
                className="h-full w-full object-cover transition-transform group-hover:scale-105"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-gray-500">
                Photo
              </div>
            )}
          </button>
        )
      })}

      {onAddPhotoClick && (
        <button
          type="button"
          onClick={onAddPhotoClick}
          className="flex h-16 w-16 flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 text-gray-600 hover:border-gray-400 hover:bg-gray-100 focus:ring-2 focus:ring-blue-600 focus:outline-none"
          aria-label="Take photo"
        >
          <span className="text-xl leading-none font-bold">+</span>
          <span className="text-[10px] font-semibold uppercase tracking-wider">Photo</span>
        </button>
      )}
    </div>
  )
}
