import { useEffect, useRef } from 'react'

/**
 * One dismissal contract for every layer that sits over the book: the customer
 * sheet, Add customer, its discard confirmation, the lid-placement session and
 * the demo lead form.
 *
 * The phone is why this exists. On a handset the reflex for "close this" is the
 * system Back gesture, and this is a single-page app with no routes - so Back
 * left PumpCycle entirely, and doing it over a half-typed customer threw the
 * typing away without the discard question the X button asks. So one history
 * entry - the guard - exists for as long as anything is open, and Back spends
 * that entry instead of leaving the app. Escape does the same on a desktop.
 *
 * Back runs the layer's OWN close request, not a raw close, so a layer that
 * answers with a question (Discard this customer?) still asks it.
 *
 * ONE entry for the whole stack, never one per layer. Layers open and close in
 * any order - a card closes underneath a placement session - and handing back an
 * entry that is no longer the top of the browser's own stack walks the operator
 * out of the app.
 *
 * Everything below about ordering exists because `history.back()` is an async
 * traversal. A verifier reproduced both ways that bites:
 *
 *   1. A `pushState` issued while a traversal was still in flight landed the
 *      traversal one entry too low, and the NEXT release walked out of the app -
 *      on an ordinary Cancel press, no Back involved, about one run in five.
 *      Hence `traversing`: no push may overtake a traversal, it queues.
 *   2. A reload with a layer open leaves the guard entry behind with none of
 *      this module's state, so the operator's first Back afterwards was a press
 *      that did nothing. Hence the stale-guard check at import.
 */
const stack = []
let guardOwned = false
// Our own history.back() is in flight. Nothing may push until it lands.
let traversing = false
let pushQueued = false
let ignorePops = 0

const top = () => stack[stack.length - 1] || null

function pushGuard() {
  if (guardOwned) return
  if (traversing) {
    pushQueued = true
    return
  }
  try {
    window.history.pushState({ pumpcycleLayer: true }, '')
    guardOwned = true
  } catch {
    // A history quota or a sandboxed frame is not a reason to break the app.
    guardOwned = false
  }
}

function releaseGuard() {
  if (!guardOwned || traversing) return
  guardOwned = false
  traversing = true
  ignorePops += 1
  try {
    window.history.back()
  } catch {
    ignorePops -= 1
    traversing = false
  }
}

function onPopState() {
  if (ignorePops > 0) {
    ignorePops -= 1
    traversing = false
    if (pushQueued) {
      pushQueued = false
      pushGuard()
    }
    return
  }
  // The browser has spent the guard entry.
  guardOwned = false
  const layer = top()
  // Nothing open: Back means what it always meant. Leave.
  if (!layer) return
  // Put the entry back in the same tick, before anything else can happen. Two
  // Back presses in the same frame then close two layers instead of the second
  // one escaping the app while React is still rendering the first close.
  pushGuard()
  layer.close()
  // React has not re-rendered yet, so what is still open can only be read after
  // this tick.
  setTimeout(releaseIfEmpty, 0)
}

function releaseIfEmpty() {
  if (!stack.length) releaseGuard()
}

function onKeyDown(event) {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  const layer = top()
  if (!layer) return
  event.preventDefault()
  layer.close()
}

if (typeof window !== 'undefined' && window.history) {
  window.addEventListener('popstate', onPopState)
  window.addEventListener('keydown', onKeyDown)
  if (window.history.state?.pumpcycleLayer) {
    // Reloaded while a layer was open. Spend the orphan now, with nothing else
    // in flight, so Back is never a dead press.
    guardOwned = true
    releaseGuard()
  }
}

/**
 * @param {boolean} active whether this layer is currently open
 * @param {() => void} onRequestClose the same handler the layer's own X runs
 */
export function useDismissLayer(active, onRequestClose) {
  // Read through a ref so a handler rebuilt on every keystroke does not tear
  // down and re-push the history entry underneath the operator.
  const handler = useRef(onRequestClose)
  useEffect(() => {
    handler.current = onRequestClose
  })

  useEffect(() => {
    if (!active) return undefined
    const layer = { close: () => handler.current() }
    stack.push(layer)
    pushGuard()
    return () => {
      const at = stack.indexOf(layer)
      if (at >= 0) stack.splice(at, 1)
      // Only the last layer to close gives the entry back; while anything is
      // still open the guard has to stay, or the next Back leaves the app. The
      // check is deferred because closing one layer often opens another in the
      // same commit (Add customer -> its discard question).
      setTimeout(releaseIfEmpty, 0)
    }
  }, [active])
}
