import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createStore } from '../../src/lib/store/index.js'
import { registerServiceWorker } from '../../src/lib/sw.js'

describe('offline & PWA layer', () => {
  it('validates manifest.webmanifest structure', () => {
    const manifestPath = resolve(process.cwd(), 'public/manifest.webmanifest')
    const raw = readFileSync(manifestPath, 'utf8')
    const manifest = JSON.parse(raw)

    expect(manifest.name).toBe('PumpCycle')
    expect(manifest.short_name).toBe('PumpCycle')
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
    expect(manifest.theme_color).toBe('#1d4ed8')
    expect(manifest.icons).toBeDefined()
    expect(manifest.icons.length).toBeGreaterThan(0)
    expect(manifest.icons[0].src).toBe('/favicon.svg')
  })

  it('validates service worker file exists and has expected cache configuration', () => {
    const swPath = resolve(process.cwd(), 'public/sw.js')
    const swContent = readFileSync(swPath, 'utf8')

    expect(swContent).toContain('pumpcycle-shell-v1')
    expect(swContent).toContain('/manifest.webmanifest')
    expect(swContent).toContain('/api/bootstrap')
    expect(swContent).toContain('caches.open')
    expect(swContent).toContain('skipWaiting')
    expect(swContent).toContain('clients.claim')
  })

  it('registerServiceWorker does not crash in test/node environment', async () => {
    const res = await registerServiceWorker()
    expect(res).toBeNull()
  })

  it('createStore falls back to cached bootstrap when offline', async () => {
    // Seed localStorage with previous bootstrap session
    const fakeLocalStorage = {
      store: {
        'pumpcycle-last-bootstrap': JSON.stringify({
          ok: true,
          mode: 'live',
          company: 'Hawkins Septic',
          timezone: 'America/New_York',
        }),
      },
      getItem(key) {
        return this.store[key] || null
      },
      setItem(key, val) {
        this.store[key] = String(val)
      },
    }

    const failingFetch = async () => {
      throw new TypeError('Failed to fetch (offline)')
    }

    const fakeApiStore = {
      init: async () => {},
      getSnapshot: () => ({
        mode: 'live',
        company: 'Hawkins Septic',
        storeStatus: 'offline',
        customers: [{ id: 'c1', name: 'Bob', address: '123 Main' }],
        pendingCount: 0,
      }),
      getMode: () => 'live',
      subscribe: () => () => {},
      destroy: () => {},
    }

    const originalLocalStorage = globalThis.localStorage
    globalThis.localStorage = fakeLocalStorage

    try {
      const store = createStore({
        fetch: failingFetch,
        apiLoader: async () => ({
          createApiStore: () => fakeApiStore,
        }),
      })

      await store.init()
      expect(store.getMode()).toBe('live')
      const snapshot = store.getSnapshot()
      expect(snapshot.company).toBe('Hawkins Septic')
      expect(snapshot.customers.length).toBe(1)
    } finally {
      globalThis.localStorage = originalLocalStorage
    }
  })

  it('createStore falls back to offline store when session endpoint returns 500/502/504', async () => {
    const fetchImpl = async (url) => {
      if (url === '/api/bootstrap') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, mode: 'live', company: 'Hawkins Septic', timezone: 'America/New_York' }),
        }
      }
      if (url === '/api/auth/session') {
        return {
          ok: false,
          status: 502,
          json: async () => ({ error: 'Bad Gateway' }),
        }
      }
      throw new Error(`Unexpected url: ${url}`)
    }

    const fakeApiStore = {
      init: async () => {},
      getSnapshot: () => ({
        mode: 'live',
        company: 'Hawkins Septic',
        storeStatus: 'offline',
        customers: [{ id: 'c1', name: 'Bob', address: '123 Main' }],
        pendingCount: 0,
      }),
      getMode: () => 'live',
      subscribe: () => () => {},
      destroy: () => {},
    }

    const store = createStore({
      fetch: fetchImpl,
      apiLoader: async () => ({
        createApiStore: () => fakeApiStore,
      }),
    })

    await store.init()
    expect(store.getMode()).toBe('live')
    const snapshot = store.getSnapshot()
    expect(snapshot.company).toBe('Hawkins Septic')
    expect(snapshot.customers.length).toBe(1)
  })
})
