import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useCoreMLDiagnostics, type CoreMLDiagnosticsConfig } from '../useCoreMLDiagnostics'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let hook: ReturnType<typeof useCoreMLDiagnostics>
let onMessage: NonNullable<CoreMLDiagnosticsConfig['onMessage']>
let onDetectionComplete: NonNullable<CoreMLDiagnosticsConfig['onDetectionComplete']>
let getContextSpy: ReturnType<typeof vi.spyOn>

function Harness() {
  hook = useCoreMLDiagnostics({ onMessage, onDetectionComplete })
  return null
}

function mockCanvasContext() {
  const context = {
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    getImageData: vi.fn(() => ({
      data: new Uint8ClampedArray(640 * 640 * 4),
    })),
    set fillStyle(_value: unknown) {},
    set strokeStyle(_value: unknown) {},
    set lineWidth(_value: unknown) {},
    set font(_value: unknown) {},
  } as unknown as CanvasRenderingContext2D
  getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(((contextId: string) => (contextId === '2d' ? context : null)) as HTMLCanvasElement['getContext'])
}

async function renderHarness() {
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => {
    root.render(<Harness />)
  })
  return root
}

describe('useCoreMLDiagnostics', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    onMessage = vi.fn()
    onDetectionComplete = vi.fn()
    mockCanvasContext()
  })

  afterEach(() => {
    getContextSpy.mockRestore()
  })

  it('runs detector test through the native raw command', async () => {
    invokeMock.mockResolvedValue({
      success: true,
      detections: [{ id: 'det-1' }],
      inferenceTimeMs: 10,
      preprocessTimeMs: 1,
      postprocessTimeMs: 2,
      error: null,
      backend: 'ONNX Runtime',
    })
    const root = await renderHarness()

    await act(async () => {
      await hook.runTest()
    })

    expect(invokeMock).toHaveBeenCalledWith('detect_native_raw', {
      rgbaData: expect.any(Array),
      width: 640,
      height: 640,
      confidenceThreshold: 0.25,
      maxDetections: 100,
    })
    expect(onMessage).toHaveBeenCalledWith('success', 'DETECTOR TEST: 1 detections in 10.0ms (ONNX Runtime)')
    expect(onDetectionComplete).toHaveBeenCalledWith({
      inferenceTimeMs: 10,
      preprocessTimeMs: 1,
      postprocessTimeMs: 2,
      detectionCount: 1,
    })

    await act(async () => root.unmount())
  })

  it('runs benchmark warmup and measured iterations through native raw detection', async () => {
    invokeMock.mockResolvedValue({
      success: true,
      detections: [],
      inferenceTimeMs: 20,
      preprocessTimeMs: null,
      postprocessTimeMs: null,
      error: null,
    })
    const root = await renderHarness()

    await act(async () => {
      await hook.runBenchmark(2)
    })

    expect(invokeMock).toHaveBeenCalledTimes(7)
    expect(onMessage).toHaveBeenCalledWith('success', expect.stringContaining('mean=20.0ms'))
    expect(onDetectionComplete).toHaveBeenCalledWith({ inferenceTimeMs: 20, detectionCount: 2 })

    await act(async () => root.unmount())
  })

  it('surfaces detector test failures without completion callbacks', async () => {
    invokeMock.mockResolvedValue({
      success: false,
      detections: [],
      inferenceTimeMs: 0,
      preprocessTimeMs: null,
      postprocessTimeMs: null,
      error: 'model missing',
    })
    const root = await renderHarness()

    await act(async () => {
      await hook.runTest()
    })

    expect(onMessage).toHaveBeenCalledWith('error', 'DETECTOR TEST FAILED: model missing')
    expect(onDetectionComplete).not.toHaveBeenCalled()
    expect(hook.isTesting).toBe(false)

    await act(async () => root.unmount())
  })

  it('reports benchmark failures when no measured iterations succeed', async () => {
    invokeMock.mockResolvedValue({
      success: false,
      detections: [],
      inferenceTimeMs: 0,
      preprocessTimeMs: null,
      postprocessTimeMs: null,
      error: 'backend unavailable',
    })
    const root = await renderHarness()

    await act(async () => {
      await hook.runBenchmark(2)
    })

    expect(invokeMock).toHaveBeenCalledTimes(7)
    expect(onMessage).toHaveBeenCalledWith('error', 'BENCHMARK: No successful runs')
    expect(onDetectionComplete).not.toHaveBeenCalled()
    expect(hook.isBenchmarking).toBe(false)
    expect(hook.benchmarkProgress).toBe(0)

    await act(async () => root.unmount())
  })
})
