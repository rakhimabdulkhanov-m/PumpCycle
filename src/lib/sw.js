/**
 * Registers the service worker in browser environments that support it.
 */
export function registerServiceWorker() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return Promise.resolve(null)
  }

  if (!('serviceWorker' in navigator)) {
    return Promise.resolve(null)
  }

  return navigator.serviceWorker
    .register('/sw.js')
    .then((registration) => {
      return registration
    })
    .catch((error) => {
      // Non-fatal: app continues to work without SW
      console.warn('Service worker registration failed:', error)
      return null
    })
}
