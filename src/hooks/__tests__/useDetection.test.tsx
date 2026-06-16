import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Detection } from '../../detection/types'
import { useDetection } from '../useDetection'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let hook: ReturnType<typeof useDetection>
let workers: MockWorker[] = []
const originalWorker = globalThis.Worker

class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  messages: unknown[] = []
  terminated = false

  constructor(_url: URL, _options?: WorkerOptions) {
    workers.push(this)
  }

  postMessage(message: unknown) {
    this.messages.push(message)
  }

  terminate() {
    this.terminated = true
  }

  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent)
  }

  fail(message: string) {
    this.onerror?.({ message } as ErrorEvent)
  }
}

function Harness({ autoInit = false }: { autoInit?: boolean }) {
  hook = useDetection({ autoInit })
  return null
}

async function renderHarness(autoInit = false) {
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => {
    root.render(<Harness autoInit={autoInit} />)
  })
  return root
}

function imageData(): ImageData {
  return {
    width: 1,
    height: 1,
    colorSpace: 'srgb',
    data: new Uint8ClampedArray([1, 2, 3, 4]),
  }
}

function detection(id: string): Detection {
  return {
    id,
    class: 'drone',
    confidence: 0.9,
    bbox: [0, 0, 1, 1],
    timestamp: 1,
  }
}

describe('useDetection', () => {
  beforeEach(() => {
    workers = []
    globalThis.Worker = MockWorker as unknown as typeof Worker
  })

  afterEach(() => {
    globalThis.Worker = originalWorker
    vi.useRealTimers()
  })

  it('initializes a worker and handles ready status', async () => {
    const root = await renderHarness()

    await act(async () => {
      await hook.initialize()
    })

    expect(workers).toHaveLength(1)
    expect(workers[0].messages[0]).toEqual({ type: 'init', payload: { config: undefined } })
    expect(hook.isLoading).toBe(true)

    await act(async () => {
      workers[0].emit({
        type: 'ready',
        payload: { status: { isReady: true, modelLoaded: true, averageLatency: 12 } },
      })
    })

    expect(hook.isReady).toBe(true)
    expect(hook.isLoading).toBe(false)
    expect(hook.averageLatency).toBe(12)

    await act(async () => root.unmount())
  })

  it('rejects detection before the worker is ready', async () => {
    const root = await renderHarness()

    await expect(hook.detect(imageData())).rejects.toThrow('Detector not ready')
    expect(workers).toHaveLength(0)

    await act(async () => root.unmount())
  })

  it('resolves concurrent detection calls by request id regardless of response order', async () => {
    const root = await renderHarness()
    await act(async () => {
      await hook.initialize()
      workers[0].emit({
        type: 'ready',
        payload: { status: { isReady: true, modelLoaded: true, averageLatency: 0 } },
      })
    })

    const first = hook.detect(imageData())
    const second = hook.detect(imageData())

    const sent = workers[0].messages.slice(1) as Array<{ type: string; requestId: number }>
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'detect',
        requestId: expect.any(Number),
        payload: expect.objectContaining({ imageWidth: 1, imageHeight: 1 }),
      }),
      expect.objectContaining({
        type: 'detect',
        requestId: expect.any(Number),
        payload: expect.objectContaining({ imageWidth: 1, imageHeight: 1 }),
      }),
    ])
    const firstId = sent[0].requestId
    const secondId = sent[1].requestId
    expect(firstId).not.toBe(secondId)

    // Respond to the SECOND request FIRST: results must not be swapped.
    await act(async () => {
      workers[0].emit({
        type: 'detections',
        requestId: secondId,
        payload: { detections: [detection('second')], inferenceTime: 7 },
      })
      await expect(second).resolves.toEqual([detection('second')])
    })
    expect(hook.inferenceTime).toBe(7)

    await act(async () => {
      workers[0].emit({
        type: 'detections',
        requestId: firstId,
        payload: { detections: [detection('first')], inferenceTime: 5 },
      })
      await expect(first).resolves.toEqual([detection('first')])
    })
    expect(hook.inferenceTime).toBe(5)

    await act(async () => root.unmount())
  })

  it('rejects only the call its error id targets and keeps other calls pending', async () => {
    const root = await renderHarness()
    await act(async () => {
      await hook.initialize()
      workers[0].emit({
        type: 'ready',
        payload: { status: { isReady: true, modelLoaded: true, averageLatency: 0 } },
      })
    })

    const first = hook.detect(imageData())
    const second = hook.detect(imageData())
    const sent = workers[0].messages.slice(1) as Array<{ requestId: number }>
    const firstId = sent[0].requestId
    const secondId = sent[1].requestId

    await act(async () => {
      workers[0].emit({ type: 'error', requestId: firstId, payload: { error: 'worker failed' } })
      await expect(first).rejects.toThrow('worker failed')
    })

    expect(hook.error).toBe('worker failed')

    await act(async () => {
      workers[0].emit({
        type: 'detections',
        requestId: secondId,
        payload: { detections: [detection('second')], inferenceTime: 9 },
      })
      await expect(second).resolves.toEqual([detection('second')])
    })

    await act(async () => root.unmount())
  })

  it('ignores global (id-less) errors for in-flight detect calls', async () => {
    const root = await renderHarness()
    await act(async () => {
      await hook.initialize()
      workers[0].emit({
        type: 'ready',
        payload: { status: { isReady: true, modelLoaded: true, averageLatency: 0 } },
      })
    })

    const pending = hook.detect(imageData())
    const requestId = (workers[0].messages.slice(1)[0] as { requestId: number }).requestId

    // A global error (e.g. "Already initializing") carries no requestId and must
    // NOT reject an unrelated in-flight detect() call.
    await act(async () => {
      workers[0].emit({ type: 'error', payload: { error: 'Already initializing' } })
    })
    expect(hook.error).toBe('Already initializing')

    // The call is still alive and resolves on its own response.
    await act(async () => {
      workers[0].emit({
        type: 'detections',
        requestId,
        payload: { detections: [detection('ok')], inferenceTime: 1 },
      })
      await expect(pending).resolves.toEqual([detection('ok')])
    })

    await act(async () => root.unmount())
  })

  it('rejects pending calls and terminates the worker on dispose', async () => {
    const root = await renderHarness()
    await act(async () => {
      await hook.initialize()
      workers[0].emit({
        type: 'ready',
        payload: { status: { isReady: true, modelLoaded: true, averageLatency: 0 } },
      })
    })
    const worker = workers[0]
    const pending = hook.detect(imageData())

    await act(async () => {
      hook.dispose()
      await expect(pending).rejects.toThrow('Worker disposed')
    })

    expect(worker.messages.at(-1)).toEqual({ type: 'dispose' })
    expect(worker.terminated).toBe(true)
    expect(hook.isReady).toBe(false)
    expect(hook.detections).toEqual([])

    await act(async () => root.unmount())
  })

  it('rejects pending calls and terminates the worker on fatal worker errors', async () => {
    const root = await renderHarness()
    await act(async () => {
      await hook.initialize()
      workers[0].emit({
        type: 'ready',
        payload: { status: { isReady: true, modelLoaded: true, averageLatency: 0 } },
      })
    })
    const worker = workers[0]
    const pending = hook.detect(imageData())

    await act(async () => {
      worker.fail('boom')
      await expect(pending).rejects.toThrow('Worker error: boom')
    })

    expect(worker.terminated).toBe(true)
    expect(hook.isReady).toBe(false)
    expect(hook.error).toBe('Worker error: boom')

    await act(async () => root.unmount())
  })

  it('auto-initializes and cleans up the worker on unmount', async () => {
    const root = await renderHarness(true)

    expect(workers).toHaveLength(1)
    expect(workers[0].messages[0]).toEqual({ type: 'init', payload: { config: undefined } })

    await act(async () => root.unmount())

    expect(workers[0].terminated).toBe(true)
  })

  it('terminates the worker when initialization times out', async () => {
    vi.useFakeTimers()
    const root = await renderHarness()

    await act(async () => {
      await hook.initialize()
    })

    await act(async () => {
      vi.advanceTimersByTime(30_000)
    })

    expect(workers[0].terminated).toBe(true)
    expect(hook.error).toBe('Worker initialization timed out after 30 seconds')
    expect(hook.isLoading).toBe(false)

    await act(async () => root.unmount())
  })
})
