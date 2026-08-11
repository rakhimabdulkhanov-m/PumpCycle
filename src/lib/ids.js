/**
 * Ids must be unique, because an id is the only thing that says which customer a
 * pin placement belongs to: updateCustomer patches EVERY customer whose id
 * matches, so two customers sharing one id are one customer with two rows on
 * screen - place a pin on either and both get the coordinate, both stamped
 * "a human placed this".
 *
 * `c-${Date.now()}` was the old minter and it collides whenever two customers
 * are created in the same millisecond, which is one paste of an import loop or
 * two fast clicks. That build shipped, so an operator's localStorage can already
 * hold the collision; minting better ids from now on does not repair it, which
 * is why loadState also de-duplicates what it reads.
 *
 * The 'c-' prefix stays so already-stored ids and the seed's c001.. keep working
 * unchanged; nothing parses what comes after it. randomUUID needs a secure
 * context (https or localhost), which production and the dev server both are;
 * the fallback exists so an http LAN address degrades to a near-unique id
 * instead of a TypeError in the middle of adding a customer.
 */
export function newCustomerId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `c-${crypto.randomUUID()}`
  }
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
