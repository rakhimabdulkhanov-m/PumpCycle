export class IndexedDbUnavailableError extends Error {
  constructor(message = 'IndexedDB is unavailable') {
    super(message)
    this.name = 'IndexedDbUnavailableError'
  }
}

const requestResult = (request) => {
  if (request && typeof request.then === 'function') return request
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'))
  })
}

const transactionResult = (transaction) => {
  if (transaction.done && typeof transaction.done.then === 'function') return transaction.done
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'))
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'))
  })
}

export function defaultOpenFactory({ indexedDB, name, version, upgrade }) {
  if (!indexedDB || typeof indexedDB.open !== 'function') {
    throw new IndexedDbUnavailableError()
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = () => upgrade(request.result, request.transaction)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Unable to open IndexedDB'))
    request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked'))
  })
}

function upgradeDatabase(db) {
  if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' })
  if (!db.objectStoreNames.contains('base')) db.createObjectStore('base', { keyPath: 'key' })
  if (!db.objectStoreNames.contains('outbox')) {
    const store = db.createObjectStore('outbox', { keyPath: 'mutationId' })
    store.createIndex('order', 'order', { unique: true })
  }
}

async function runTransaction(db, names, mode, work) {
  const transaction = db.transaction(names, mode)
  const done = transactionResult(transaction)
  try {
    const result = await work((name) => transaction.objectStore(name))
    await done
    return result
  } catch (error) {
    try {
      transaction.abort()
    } catch {
      // A native transaction may already have aborted with the useful error.
    }
    try {
      await done
    } catch {
      // Preserve the operation error that explains which write failed.
    }
    throw error
  }
}

export function createIdbStorage(options = {}) {
  const name = options.name || 'pumpcycle-live-v1'
  const version = options.version || 1
  const openFactory = options.openFactory || defaultOpenFactory
  const indexedDB = options.indexedDB ?? globalThis.indexedDB
  let databasePromise

  const open = () => {
    if (!databasePromise) {
      try {
        databasePromise = Promise.resolve(openFactory({ indexedDB, name, version, upgrade: upgradeDatabase }))
      } catch (error) {
        databasePromise = Promise.reject(error)
      }
    }
    return databasePromise
  }

  const transaction = async (names, mode, work) => runTransaction(await open(), names, mode, work)

  return {
    open,
    transaction,

    async load() {
      return transaction(['meta', 'base', 'outbox'], 'readonly', async (store) => {
        const [baseRow, cursorRow, outbox] = await Promise.all([
          requestResult(store('base').get('snapshot')),
          requestResult(store('meta').get('cursor')),
          requestResult(store('outbox').getAll()),
        ])
        return {
          base: baseRow?.value || null,
          cursor: cursorRow?.value || 0,
          outbox: (outbox || []).sort((a, b) => a.order - b.order),
        }
      })
    },

    async writeBase(base, cursor) {
      return transaction(['base', 'meta'], 'readwrite', async (store) => {
        await Promise.all([
          requestResult(store('base').put({ key: 'snapshot', value: base })),
          requestResult(store('meta').put({ key: 'cursor', value: cursor })),
        ])
      })
    },

    async enqueue(mutation) {
      return transaction(['meta', 'outbox'], 'readwrite', async (store) => {
        const counter = await requestResult(store('meta').get('nextOutboxOrder'))
        const order = counter?.value || 1
        const record = { ...mutation, order, status: 'pending' }
        await requestResult(store('outbox').add(record))
        await requestResult(store('meta').put({ key: 'nextOutboxOrder', value: order + 1 }))
        return record
      })
    },

    async acknowledge(mutationId, base, cursor) {
      return transaction(['base', 'meta', 'outbox'], 'readwrite', async (store) => {
        await Promise.all([
          requestResult(store('outbox').delete(mutationId)),
          requestResult(store('base').put({ key: 'snapshot', value: base })),
          requestResult(store('meta').put({ key: 'cursor', value: cursor })),
        ])
      })
    },

    async markFailed(record) {
      return transaction(['outbox'], 'readwrite', async (store) => {
        await requestResult(store('outbox').put(record))
      })
    },

    async discard(mutationId) {
      return transaction(['outbox'], 'readwrite', async (store) => {
        await requestResult(store('outbox').delete(mutationId))
      })
    },
  }
}
