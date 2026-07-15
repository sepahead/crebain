import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWithOperationDeadline } from '../operationDeadline'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('runWithOperationDeadline', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects at the deadline even when the wrapped operation never settles', async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    const result = runWithOperationDeadline(() => new Promise<never>(() => undefined), {
      timeoutMs: 100,
      timeoutMessage: 'Scene restore timed out',
      supersededMessage: 'Scene restore was superseded',
      onTimeout,
    })

    const rejection = expect(result).rejects.toThrow('Scene restore timed out')
    await vi.advanceTimersByTimeAsync(100)

    await rejection
    expect(onTimeout).toHaveBeenCalledOnce()
  })

  it('fences mutation when an uncancellable operation completes after timeout cleanup', async () => {
    vi.useFakeTimers()
    const pending = deferred<string>()
    const mutations: string[] = []
    let generation = 1

    const result = runWithOperationDeadline(
      async ({ assertActive }) => {
        const value = await pending.promise
        assertActive()
        mutations.push(value)
      },
      {
        timeoutMs: 100,
        timeoutMessage: 'Scene restore timed out',
        supersededMessage: 'Scene restore was superseded',
        isCurrent: () => generation === 1,
        onTimeout: () => {
          generation += 1
          mutations.splice(0)
        },
      }
    )

    const rejection = expect(result).rejects.toThrow('Scene restore timed out')
    await vi.advanceTimersByTimeAsync(100)
    await rejection

    pending.resolve('late result')
    await Promise.resolve()
    await Promise.resolve()

    expect(mutations).toEqual([])
  })

  it('does not run timeout cleanup against a superseding operation', async () => {
    vi.useFakeTimers()
    let generation = 1
    const onTimeout = vi.fn()
    const result = runWithOperationDeadline(() => new Promise<never>(() => undefined), {
      timeoutMs: 100,
      timeoutMessage: 'Scene restore timed out',
      supersededMessage: 'Scene restore was superseded',
      isCurrent: () => generation === 1,
      onTimeout,
    })

    generation = 2
    const rejection = expect(result).rejects.toThrow('Scene restore was superseded')
    await vi.advanceTimersByTimeAsync(100)

    await rejection
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('rejects invalid deadlines before starting the operation', async () => {
    const operation = vi.fn(async () => undefined)

    await expect(
      runWithOperationDeadline(operation, {
        timeoutMs: 0,
        timeoutMessage: 'timed out',
        supersededMessage: 'superseded',
        onTimeout: vi.fn(),
      })
    ).rejects.toThrow('positive safe integer')
    expect(operation).not.toHaveBeenCalled()
  })
})
