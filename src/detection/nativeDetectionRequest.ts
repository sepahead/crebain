import { runWithOperationDeadline } from '../lib/operationDeadline'

export const NATIVE_DETECTION_REQUEST_TIMEOUT_MS = 30_000

export interface NativeDetectionRequestOptions {
  signal?: AbortSignal
  isCurrent?: () => boolean
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Native detection request was cancelled', 'AbortError')
}

/**
 * Bound one renderer-side native inference request.
 *
 * Tauri does not cancel native work when this race ends. The Rust admission
 * permit therefore remains responsible for retaining backend capacity until
 * the blocking job actually exits. This wrapper bounds renderer liveness and
 * rejects late results after cancellation or component replacement.
 */
export async function runNativeDetectionRequest<T>(
  request: () => Promise<T>,
  options: NativeDetectionRequestOptions = {}
): Promise<T> {
  const { signal } = options
  if (signal?.aborted) throw abortReason(signal)

  let removeAbortListener = (): void => undefined
  const cancellation = signal
    ? new Promise<never>((_, reject) => {
        const onAbort = () => reject(abortReason(signal))
        signal.addEventListener('abort', onAbort, { once: true })
        removeAbortListener = () => signal.removeEventListener('abort', onAbort)
      })
    : null

  try {
    return await runWithOperationDeadline(
      async ({ assertActive }) => {
        const pendingRequest = Promise.resolve().then(request)
        const response = cancellation
          ? await Promise.race([pendingRequest, cancellation])
          : await pendingRequest
        assertActive()
        return response
      },
      {
        timeoutMs: NATIVE_DETECTION_REQUEST_TIMEOUT_MS,
        timeoutMessage: 'Native detection request timed out',
        supersededMessage: 'Native detection request was superseded',
        isCurrent: options.isCurrent,
        onTimeout: () => undefined,
      }
    )
  } finally {
    removeAbortListener()
  }
}
