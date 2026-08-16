/**
 * PumpCycle Service Worker — Offline app shell & asset caching.
 */

const CACHE_NAME = 'pumpcycle-shell-v1'
const API_CACHE_NAME = 'pumpcycle-api-v1'

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.webmanifest',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch(() => {
        // Precache failures in dev or partial environments shouldn't block install
      })
    }).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  const allowedCaches = new Set([CACHE_NAME, API_CACHE_NAME])
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (!allowedCaches.has(key)) {
            return caches.delete(key)
          }
        })
      )
    }).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // API endpoints strategy
  if (url.pathname.startsWith('/api/')) {
    // Only /api/bootstrap is cached for offline initial tenant mode resolution
    if (url.pathname === '/api/bootstrap') {
      event.respondWith(
        fetch(request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone()
              caches.open(API_CACHE_NAME).then((cache) => cache.put(request, clone))
            }
            return response
          })
          .catch(() => {
            return caches.match(request).then((cached) => {
              if (cached) return cached
              // Offline fallback JSON
              return new Response(
                JSON.stringify({ ok: true, mode: 'live', offline: true }),
                { headers: { 'Content-Type': 'application/json' } }
              )
            })
          })
      )
    }
    // All other API endpoints (mutations, sync, auth) are network-only
    return
  }

  // Navigation requests (HTML SPA navigation)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
          }
          return response
        })
        .catch(() => {
          return caches.match('/index.html').then((cached) => {
            return cached || caches.match('/')
          })
        })
    )
    return
  }

  // Static assets (JS, CSS, images, fonts, icons) -> Stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone()
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseToCache)
            })
          }
          return networkResponse
        })
        .catch(() => cachedResponse)

      return cachedResponse || fetchPromise
    })
  )
})
