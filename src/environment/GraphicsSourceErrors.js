// This import-light module runs unchanged in Node, Bun, and the browser owner.
const integrityFailures = new WeakSet()

/** A private metadata or byte join failed; this is not an actual acquisition failure. */
export class GraphicsSourceIntegrityError extends Error {
  constructor(message, cause) {
    super(message, { cause })
    this.name = 'GraphicsSourceIntegrityError'
    integrityFailures.add(this)
  }
}

/** Only the closed private worker protocol can supply the acquisition category. */
export class SourceGraphicsTransferError extends Error {
  constructor(category, message, cause) {
    super(message, { cause })
    if (!['acquisition', 'integrity'].includes(category))
      throw new Error('Unknown source transfer error category')
    this.name = 'SourceGraphicsTransferError'
    this.category = category
    if (category === 'integrity') integrityFailures.add(this)
  }
}

/** Local identity is required. JSON fields and error names cannot recreate this classification. */
export function isGraphicsSourceIntegrityError(value) {
  return typeof value === 'object' && value !== null && integrityFailures.has(value)
}

export function sourceCleanupFailure(primary, cleanup, message) {
  return new SourceGraphicsTransferError(
    'integrity',
    message,
    new AggregateError([primary, cleanup], message, { cause: primary })
  )
}
