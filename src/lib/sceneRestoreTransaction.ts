export interface SceneRestoreTransactionOptions {
  /** Prevents a superseded restore from clearing or committing a newer one. */
  isCurrent: () => boolean
  /** Invalidates nested work and clears/rolls back every partial scene mutation. */
  rollback: () => void
  /** Applies success-only state such as the requested physics pause mode. */
  commit: () => void
}

/**
 * Give scene restore one success boundary independent of how its operation
 * fails. Timeouts, callback loader failures, thrown spawn errors, and aggregate
 * "returned false" failures all follow the same rollback path. A superseded
 * transaction never rolls back or commits the newer generation.
 */
export async function runSceneRestoreTransaction(
  operation: () => Promise<void>,
  options: SceneRestoreTransactionOptions
): Promise<void> {
  try {
    await operation()
  } catch (operationError) {
    if (options.isCurrent()) {
      try {
        options.rollback()
      } catch (rollbackError) {
        throw new AggregateError(
          [operationError, rollbackError],
          'Scene restore and its rollback both failed',
          { cause: rollbackError }
        )
      }
    }
    throw operationError
  }

  if (options.isCurrent()) options.commit()
}
