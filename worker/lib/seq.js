/**
 * Monotonic sequence allocator backed by the seq_counter table.
 *
 * ## Batching rules
 *
 * nextSeq() CANNOT be called inside a db.batch() invocation. db.batch()
 * requires all statements to be constructed before submission, so the caller
 * cannot use the return value of nextSeq() to build other batch statements
 * within the same call. The correct pattern is:
 *
 *   const seqs = await nextSeq(db, 2)   // allocates [5, 6]
 *   await db.batch([
 *     db.prepare('INSERT INTO customers (..., seq) VALUES (?, ...)').bind(..., seqs[0]),
 *     db.prepare('INSERT INTO visits    (..., seq) VALUES (?, ...)').bind(..., seqs[1]),
 *   ])
 *
 * Allocated but unused seqs (e.g. because the batch fails after allocation)
 * create gaps in the sequence. Gaps are acceptable — only duplicates are not.
 * The counter is append-only and never resets.
 *
 * @param {D1Database} db
 * @param {number} [count=1] - How many sequential numbers to allocate.
 * @returns {Promise<number[]>} Ascending array of allocated sequence numbers.
 */
export async function nextSeq(db, count = 1) {
  if (count < 1) throw new RangeError('nextSeq: count must be >= 1')

  const row = await db
    .prepare('UPDATE seq_counter SET value = value + ? WHERE id = 1 RETURNING value')
    .bind(count)
    .first()

  if (!row) {
    throw new Error('nextSeq: seq_counter row missing — was the migration applied?')
  }

  const end = row.value
  const start = end - count + 1
  return Array.from({ length: count }, (_, i) => start + i)
}
