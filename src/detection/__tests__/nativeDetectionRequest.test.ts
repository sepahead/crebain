import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  NATIVE_DETECTION_REQUEST_TIMEOUT_MS,
  runNativeDetectionRequest,
} from '../nativeDetectionRequest'

describe('runNativeDetectionRequest', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a current response', async () => {
    await expect(runNativeDetectionRequest(async () => 'ready')).resolves.toBe('ready')
  })

  it('rejects an invocation that never settles at the renderer deadline', async () => {
    vi.useFakeTimers()
    const result = runNativeDetectionRequest(() => new Promise<never>(() => undefined))
    const rejection = expect(result).rejects.toThrow('Native detection request timed out')

    await vi.advanceTimersByTimeAsync(NATIVE_DETECTION_REQUEST_TIMEOUT_MS)

    await rejection
  })

  it('releases the caller immediately when its signal is cancelled', async () => {
    const controller = new AbortController()
    const result = runNativeDetectionRequest(() => new Promise<never>(() => undefined), {
      signal: controller.signal,
    })
    const rejection = expect(result).rejects.toThrow('viewer closed')

    controller.abort(new Error('viewer closed'))

    await rejection
  })

  it('rejects a late result from a superseded owner', async () => {
    let current = true
    let resolve!: (value: string) => void
    const result = runNativeDetectionRequest(
      () =>
        new Promise<string>((complete) => {
          resolve = complete
        }),
      { isCurrent: () => current }
    )
    const rejection = expect(result).rejects.toThrow('Native detection request was superseded')

    await Promise.resolve()
    current = false
    resolve('stale')

    await rejection
  })
})
