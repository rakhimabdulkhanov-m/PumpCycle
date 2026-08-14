// Whitespace and letter case are not a different recipient: re-typing
// "Earl@Host.com" as " earl@host.com " is the same mailbox. Anything else is.
const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()

/**
 * True when these two address strings are genuinely different recipients.
 *
 * This is what decides whether a correction re-arms sending. A bounce or a spam
 * complaint is evidence against an ADDRESS, not against a customer, so a real
 * change resets email_status and the soft-bounce streak - and an incidental
 * re-typing of the same dead address must not, or the next cron mails it again.
 *
 * The Worker (worker/api/mutations.js) and the optimistic local apply
 * (src/lib/model.js) both call this. They have to agree exactly: if the browser
 * clears the red Reminders row and the server does not, the row comes back on
 * the next sync.
 */
export const isDifferentEmail = (a, b) => normalizeEmail(a) !== normalizeEmail(b)
