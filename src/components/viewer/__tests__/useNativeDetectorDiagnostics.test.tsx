import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNativeDetectorDiagnostics } from '../useNativeDetectorDiagnostics'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriMocks.invoke }))

const SUCCESS_RESPONSE = {
  success: true,
  detections: [],
  inferenceTimeMs: 5,
  preprocessTimeMs: null,
  postprocessTimeMs: null,
  backend: 'test-backend',
  error: null,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

type DiagnosticsHook = ReturnType<typeof useNativeDetectorDiagnostics>
type DiagnosticsOptions = Parameters<typeof useNativeDetectorDiagnostics>[0]
let diagnostics!: DiagnosticsHook
let root!: Root
let viewerMountedRef!: { current: boolean }
let addMessage!: DiagnosticsOptions['addMessage']
let onDetectionComplete!: NonNullable<DiagnosticsOptions['onDetectionComplete']>
let onDetectionError!: NonNullable<DiagnosticsOptions['onDetectionError']>
let onRefreshSystemInfo!: NonNullable<DiagnosticsOptions['onRefreshSystemInfo']>

function Harness({ nativeAvailable = true }: { nativeAvailable?: boolean }) {
  diagnostics = useNativeDetectorDiagnostics({
    nativeAvailable,
    viewerMountedRef,
    addMessage,
    onDetectionComplete,
    onDetectionError,
    onRefreshSystemInfo,
  })
  return null
}

async function mount(nativeAvailable = true): Promise<void> {
  root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Harness nativeAvailable={nativeAvailable} />))
}

describe('useNativeDetectorDiagnostics', () => {
  beforeEach(() => {
    viewerMountedRef = { current: true }
    addMessage = vi.fn<DiagnosticsOptions['addMessage']>()
    onDetectionComplete = vi.fn<NonNullable<DiagnosticsOptions['onDetectionComplete']>>()
    onDetectionError = vi.fn<NonNullable<DiagnosticsOptions['onDetectionError']>>()
    onRefreshSystemInfo = vi.fn<NonNullable<DiagnosticsOptions['onRefreshSystemInfo']>>(
      async () => undefined
    )
    tauriMocks.invoke.mockReset()

    const context = {
      arc: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      fill: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: '',
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(640 * 480 * 4),
        height: 480,
        width: 640,
      })),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never)
  })

  afterEach(async () => {
    if (root) {
      viewerMountedRef.current = false
      await act(async () => root.unmount())
    }
    vi.restoreAllMocks()
  })

  it('admits only one manual detector operation at a time', async () => {
    const pending = deferred<unknown>()
    tauriMocks.invoke.mockReturnValue(pending.promise)
    await mount()

    let first!: Promise<void>
    let duplicate!: Promise<void>
    await act(async () => {
      first = diagnostics.testDetector()
      duplicate = diagnostics.testDetector()
      await duplicate
    })

    expect(tauriMocks.invoke).toHaveBeenCalledTimes(1)
    expect(diagnostics.isTesting).toBe(true)

    await act(async () => {
      pending.resolve(SUCCESS_RESPONSE)
      await first
    })

    expect(diagnostics.isTesting).toBe(false)
    expect(onDetectionComplete).toHaveBeenCalledWith({
      detectionCount: 0,
      inferenceTimeMs: 5,
      postprocessTimeMs: undefined,
      preprocessTimeMs: undefined,
    })
    expect(onRefreshSystemInfo).toHaveBeenCalledTimes(1)
  })

  it('stops after a failed benchmark warm-up', async () => {
    tauriMocks.invoke.mockResolvedValue({
      ...SUCCESS_RESPONSE,
      success: false,
      error: 'backend unavailable',
    })
    await mount()

    await act(async () => diagnostics.runBenchmark())

    expect(tauriMocks.invoke).toHaveBeenCalledTimes(1)
    expect(onDetectionError).toHaveBeenCalledWith('backend unavailable')
    expect(diagnostics.isBenchmarking).toBe(false)
    expect(diagnostics.benchmarkProgress).toBe(0)
  })

  it('reports an actual inference detection count after a completed benchmark', async () => {
    tauriMocks.invoke.mockResolvedValue({
      ...SUCCESS_RESPONSE,
      detections: [
        {
          id: 'benchmark-1',
          bbox: { x1: 0, y1: 0, x2: 10, y2: 10 },
          classIndex: 0,
          classLabel: 'person',
          confidence: 0.9,
          timestamp: 1,
        },
      ],
    })
    await mount()

    await act(async () => diagnostics.runBenchmark())

    expect(tauriMocks.invoke).toHaveBeenCalledTimes(101)
    expect(onDetectionComplete).toHaveBeenCalledWith({
      detectionCount: 1,
      inferenceTimeMs: 5,
    })
  })

  it('cancels a pending benchmark without reporting a detector failure', async () => {
    const pending = deferred<unknown>()
    tauriMocks.invoke.mockReturnValue(pending.promise)
    await mount()

    let benchmark!: Promise<void>
    await act(async () => {
      benchmark = diagnostics.runBenchmark()
      await Promise.resolve()
    })
    await act(async () => {
      diagnostics.cancelBenchmark()
      await benchmark
    })

    expect(onDetectionError).not.toHaveBeenCalled()
    expect(addMessage).toHaveBeenCalledWith('warning', 'BENCHMARK: Abbruch angefordert')
    expect(diagnostics.isBenchmarking).toBe(false)
  })

  it('honors cancellation before React commits the benchmarking state', async () => {
    const pending = deferred<unknown>()
    tauriMocks.invoke.mockReturnValue(pending.promise)
    await mount()

    let benchmark!: Promise<void>
    await act(async () => {
      benchmark = diagnostics.runBenchmark()
      diagnostics.cancelBenchmark()
      await benchmark
    })

    expect(tauriMocks.invoke).toHaveBeenCalledTimes(1)
    expect(addMessage).toHaveBeenCalledWith('warning', 'BENCHMARK: Abbruch angefordert')
    expect(onDetectionError).not.toHaveBeenCalled()
    expect(diagnostics.isBenchmarking).toBe(false)
  })

  it('reports browser-only use without constructing a native request', async () => {
    await mount(false)

    await act(async () => diagnostics.testDetector())

    expect(tauriMocks.invoke).not.toHaveBeenCalled()
    expect(onDetectionError).toHaveBeenCalledWith(
      'Native detection is available only in the desktop app'
    )
  })
})
