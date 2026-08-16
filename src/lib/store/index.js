import { emptySnapshot } from '../wire.js'

export class StoreUnavailableError extends Error {
  constructor(message, code = 'store-unavailable') {
    super(message)
    this.name = 'StoreUnavailableError'
    this.code = code
  }
}

const neutral = (extra = {}) => emptySnapshot({
  mode: null,
  storeStatus: 'booting',
  blocked: true,
  storeError: null,
  ...extra,
})

const LAST_BOOTSTRAP_KEY = 'pumpcycle-last-bootstrap'

function getCachedBootstrap() {
  if (typeof localStorage === 'undefined') return null
  try {
    const cached = JSON.parse(localStorage.getItem(LAST_BOOTSTRAP_KEY) || 'null')
    if (cached && ['demo', 'live'].includes(cached.mode)) {
      return { ...cached, offline: true }
    }
  } catch {
    // Ignore parse errors
  }
  return null
}

async function readBootstrap(fetchImpl) {
  let response
  try {
    response = await fetchImpl('/api/bootstrap')
  } catch {
    // Network is offline. Check if we have a cached bootstrap in localStorage
    const cached = getCachedBootstrap()
    if (cached) return cached
    throw new StoreUnavailableError('Network is offline and no cached session was found', 'offline')
  }

  let body
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok || body?.ok !== true || !['demo', 'live'].includes(body.mode)) {
    // Server or proxy returned 5xx/4xx error while offline. Fall back to cached session if available.
    const cached = getCachedBootstrap()
    if (cached) return cached

    throw new StoreUnavailableError(
      body?.error || `Bootstrap failed (${response.status || 'invalid response'})`,
      'bootstrap-failed'
    )
  }

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(LAST_BOOTSTRAP_KEY, JSON.stringify(body))
    } catch {
      // Ignore quota errors
    }
  }

  return body
}

async function readJson(fetchImpl, path, init) {
  let response
  try {
    response = await fetchImpl(path, init)
  } catch (netErr) {
    const error = new StoreUnavailableError(netErr?.message || 'Network request failed', 'network-failed')
    error.status = 0
    throw error
  }
  let body
  try { body = await response.json() } catch { body = null }
  if (!response.ok || body?.ok === false) {
    const error = new StoreUnavailableError(body?.error || `Request failed (${response.status})`, response.status === 401 ? 'auth-required' : 'request-failed')
    error.status = response.status
    throw error
  }
  return body
}

export function createStore(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch
  const demoLoader = options.demoLoader || (() => import('./demoStore.js'))
  const apiLoader = options.apiLoader || (() => import('./apiStore.js'))
  const locationSearch = options.locationSearch ?? globalThis.location?.search ?? ''
  let delegate = null
  let mode = null
  let snapshot = neutral()
  let initPromise = null
  let unsubscribeDelegate = null
  const listeners = new Set()

  const emit = () => {
    for (const listener of listeners) listener()
  }
  const setSnapshot = (next) => {
    snapshot = next
    emit()
  }


  const authGate = (bootstrap, code = 'auth-required', message = 'Sign in to open this customer book.') => {
    setSnapshot(neutral({
      mode: 'live', company: bootstrap.company || '', timezone: bootstrap.timezone || '',
      storeStatus: code, storeError: { message, code }, setupToken: code === 'setup-required' ? new URLSearchParams(locationSearch).get('t') : null,
    }))
  }

  async function startApi(bootstrap) {
    if (!delegate) {
      const module = await apiLoader()
      delegate = module.createApiStore({
        ...options.apiOptions,
        fetch: fetchImpl,
        company: bootstrap.company || '',
        timezone: bootstrap.timezone || '',
      })
      await delegate.init()
      unsubscribeDelegate = delegate.subscribe(emit)
    } else await delegate.resumeAfterAuth()
    snapshot = delegate.getSnapshot()
    emit()
    return snapshot
  }

  async function init() {
    if (initPromise) return initPromise
    initPromise = (async () => {
      setSnapshot(neutral({ storeStatus: 'booting' }))
      try {
        const bootstrap = await readBootstrap(fetchImpl)
        mode = bootstrap.mode
        if (bootstrap.mode === 'demo') {
          const module = await demoLoader()
          delegate = module.createDemoStore(options.demoOptions)
          await delegate.init()
          unsubscribeDelegate = delegate.subscribe(emit)
          snapshot = delegate.getSnapshot()
          emit()
          return snapshot
        }

        try {
          await readJson(fetchImpl, '/api/auth/session')
          return startApi(bootstrap)
        } catch (error) {
          if (error.status !== 401) {
            if (bootstrap.offline || error.status === 0 || error.code === 'network-failed') {
              return startApi(bootstrap)
            }
            throw error
          }
          const token = new URLSearchParams(locationSearch).get('t')
          authGate(bootstrap, token ? 'setup-required' : 'auth-required')
          return snapshot
        }
      } catch (error) {
        mode = null
        setSnapshot(neutral({
          storeStatus: 'error',
          storeError: { message: error.message || String(error), code: error.code || 'bootstrap-failed' },
        }))
        initPromise = null
        throw error
      }
    })()
    return initPromise
  }

  const unavailable = () => Promise.reject(new StoreUnavailableError(
    snapshot.storeError?.message || 'The store is not ready',
    snapshot.storeError?.code
  ))
  const call = (method, args) => delegate ? delegate[method](...args) : unavailable()

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => delegate ? delegate.getSnapshot() : snapshot,
    getMode: () => delegate ? delegate.getMode() : mode,
    init,
    retry: init,
    async login(email, password) {
      const bootstrap = { company: snapshot.company, timezone: snapshot.timezone }
      await readJson(fetchImpl, '/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
      })
      return startApi(bootstrap)
    },
    async setup(password) {
      const token = snapshot.setupToken
      const bootstrap = { company: snapshot.company, timezone: snapshot.timezone }
      await readJson(fetchImpl, '/api/auth/setup', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password }),
      })
      if (globalThis.history?.replaceState && globalThis.location) {
        globalThis.history.replaceState(null, '', globalThis.location.pathname)
      }
      return startApi(bootstrap)
    },
    async logout() {
      await readJson(fetchImpl, '/api/auth/logout', { method: 'POST' })
      const company = delegate?.getSnapshot().company || snapshot.company || ''
      const timezone = delegate?.getSnapshot().timezone || snapshot.timezone || ''
      unsubscribeDelegate?.()
      unsubscribeDelegate = null
      delegate?.destroy?.()
      delegate = null
      authGate({ company, timezone })
    },
    destroy() {
      unsubscribeDelegate?.()
      unsubscribeDelegate = null
      delegate?.destroy?.()
    },
    mutate: (...args) => call('mutate', args),
    addCustomer: (...args) => call('addCustomer', args),
    updateCustomer: (...args) => call('updateCustomer', args),
    setPin: (...args) => call('setPin', args),
    restorePin: (...args) => call('restorePin', args),
    recordVisit: (...args) => call('recordVisit', args),
    updateVisit: (...args) => call('updateVisit', args),
    archiveVisit: (...args) => call('archiveVisit', args),
    recordPhoto: (...args) => call('recordPhoto', args),
    archivePhoto: (...args) => call('archivePhoto', args),
    correctLastPumped: (...args) => call('correctLastPumped', args),
    setAvgJobPrice: (...args) => call('setAvgJobPrice', args),
    markReminderSent: (...args) => call('markReminderSent', args),
    retryFailedMutation: (...args) => call('retryFailedMutation', args),
    discardFailedMutation: (...args) => call('discardFailedMutation', args),
  }
}

let singleton
export const getStore = () => {
  if (!singleton) singleton = createStore()
  return singleton
}
