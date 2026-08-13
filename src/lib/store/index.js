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

async function readBootstrap(fetchImpl) {
  const response = await fetchImpl('/api/bootstrap')
  let body
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok || body?.ok !== true || !['demo', 'live'].includes(body.mode)) {
    throw new StoreUnavailableError(
      body?.error || `Bootstrap failed (${response.status || 'invalid response'})`,
      'bootstrap-failed'
    )
  }
  return body
}

export function createStore(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch
  const demoLoader = options.demoLoader || (() => import('./demoStore.js'))
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

        // Step 1A deliberately has no public live data routes. Do not probe
        // unregistered endpoints or render sample customers on a client host.
        const blocked = new StoreUnavailableError(
          'This client book is waiting for sign-in and data-route setup.',
          'live-auth-required'
        )
        setSnapshot(neutral({
          mode: 'live',
          company: bootstrap.company || '',
          timezone: bootstrap.timezone || '',
          storeStatus: 'auth-required',
          storeError: { message: blocked.message, code: blocked.code },
        }))
        return snapshot
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
