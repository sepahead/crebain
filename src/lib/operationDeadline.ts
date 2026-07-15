export interface OperationDeadlineGuard {
  isActive: () => boolean
  assertActive: () => void
}

export interface OperationDeadlineOptions {
  timeoutMs: number
  timeoutMessage: string
  supersededMessage: string
  isCurrent?: () => boolean
  onTimeout: () => void
}

/**
 * Run an asynchronous operation behind a real deadline.
 *
 * The operation may wrap APIs that cannot be cancelled themselves. Callers must
 * therefore use the supplied guard after every await and invalidate the
 * underlying operation in `onTimeout` (for example with an AbortController or
 * generation counter). The returned promise still rejects at the deadline even
 * when the wrapped promise never settles.
 */
export async function runWithOperationDeadline<T>(
  operation: (guard: OperationDeadlineGuard) => Promise<T>,
  options: OperationDeadlineOptions
): Promise<T> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('Operation deadline must be a positive safe integer')
  }

  const timeoutError = new Error(options.timeoutMessage)
  const supersededError = new Error(options.supersededMessage)
  let timedOut = false
  let closed = false
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const isCurrent = () => options.isCurrent?.() ?? true
  const guard: OperationDeadlineGuard = {
    isActive: () => !closed && !timedOut && isCurrent(),
    assertActive: () => {
      if (timedOut) throw timeoutError
      if (closed || !isCurrent()) throw supersededError
    },
  }

  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      if (!isCurrent()) {
        reject(supersededError)
        return
      }
      timedOut = true
      try {
        options.onTimeout()
        reject(timeoutError)
      } catch (error) {
        reject(
          new AggregateError(
            [timeoutError, error],
            `${options.timeoutMessage}; deadline cleanup also failed`
          )
        )
      }
    }, options.timeoutMs)
  })

  try {
    let guardedOperation: Promise<T>
    try {
      guard.assertActive()
      // Async functions run synchronously until their first await. Starting the
      // operation here lets callers invalidate prior generations immediately,
      // without opening a microtask-sized window before their cleanup begins.
      guardedOperation = operation(guard)
    } catch (error) {
      guardedOperation = Promise.reject(
        error instanceof Error
          ? error
          : new Error('Operation failed before its first await', { cause: error })
      )
    }
    return await Promise.race([guardedOperation, deadline])
  } finally {
    closed = true
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}
