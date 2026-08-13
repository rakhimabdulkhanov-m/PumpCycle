import { applyMutation } from '../model.js'

export class MutationHttpError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'MutationHttpError'
    this.status = status
  }
}

export function createMutation(type, payload, options = {}) {
  const createdAt = options.createdAt ?? Date.now()
  const mutationId = options.mutationId || options.idFactory?.()
  if (!mutationId) throw new TypeError('A mutation id factory is required')
  return { mutationId, type, createdAt, payload }
}

export const sortOutbox = (records) => [...(records || [])].sort(
  (a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt) ||
    String(a.mutationId).localeCompare(String(b.mutationId))
)

export function replayOutbox(base, records) {
  return sortOutbox(records).reduce((snapshot, record) => applyMutation(snapshot, record), base)
}

export const isPermanentMutationFailure = (error) =>
  Number.isInteger(error?.status) && error.status >= 400 && error.status < 500

export function failedRecord(record, error) {
  return {
    ...record,
    status: 'failed',
    error: {
      status: error?.status || 0,
      message: error?.message || 'Mutation failed',
    },
  }
}

