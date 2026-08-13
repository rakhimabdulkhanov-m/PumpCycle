import { useEffect, useSyncExternalStore } from 'react'
import { getStore } from './index.js'

// Constructed at module scope: React StrictMode may mount twice, but it cannot
// create two stores, two IndexedDB boots, or two flush loops.
export const store = getStore()

export function useStore() {
  useEffect(() => {
    void store.init().catch(() => {
      // The explicit error snapshot is the UI contract; avoid an unhandled
      // rejection while still letting direct callers observe init failure.
    })
  }, [])
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

