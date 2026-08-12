import { stampAddressChange } from './location.js'

/**
 * The write funnel for "change one customer", as a pure function of the state.
 *
 * It lives here rather than inside App so that what actually runs when a pin is
 * saved - or put back by Undo - can be tested directly. The rules it enforces
 * are the ones every screen depends on:
 *
 *  - exactly the customer with this id changes. Every other customer comes back
 *    as the same object, so "saving a pin wrote one customer" is checkable by
 *    identity and not by eyeballing a list;
 *  - a new lastPumped OR a changed cycle length means a new/different cycle: the
 *    cycle also flips the email reminder id (commercial :15 vs residential :60),
 *    so both clear this customer's sent-reminder keys to avoid stranded ids and
 *    reverted statuses;
 *  - a new address means the pin is at the OLD one. The coordinate is kept - the
 *    edit may have been a typo fix and the lid pin may still be right - but it
 *    stops counting as checked, so the customer shows up under "Needs a pin" and
 *    his card says why. Without this the operator drives to the pin: a confirmed
 *    customer moved from Dallas NC to Erie PA still showed a settled pin in
 *    Dallas, 500 miles away.
 *
 * The address rule sits in the funnel rather than in the Edit form because every
 * path that can change an address comes through here, so a second edit screen
 * cannot forget it.
 */
export function updateCustomerState(data, id, patch) {
  const prev = data.customers.find((c) => c.id === id)
  const lastPumpedChanged =
    patch.lastPumped !== undefined && patch.lastPumped !== prev?.lastPumped
  const cycleChanged =
    patch.cycleMonths !== undefined && patch.cycleMonths !== prev?.cycleMonths
  const cycleReset = prev && (lastPumpedChanged || cycleChanged)
  const finalPatch = stampAddressChange(prev, patch)
  const keep = (k) => !k.startsWith(`${id}:`)
  return {
    ...data,
    customers: data.customers.map((c) => (c.id === id ? { ...c, ...finalPatch } : c)),
    sentReminders: cycleReset ? data.sentReminders.filter(keep) : data.sentReminders,
    sentAt: cycleReset
      ? Object.fromEntries(Object.entries(data.sentAt).filter(([k]) => keep(k)))
      : data.sentAt,
  }
}
