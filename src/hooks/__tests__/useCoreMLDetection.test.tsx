import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useCoreMLDetection } from '../useCoreMLDetection'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let hook: ReturnType<typeof useCoreMLDetection>

function Harness() {
  hook = useCoreMLDetection()
  return null
}

function createTestImageData(): ImageData {
  return {
    width: 2,
    height: 1,
    colorSpace: 'srgb',
    data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]),
  } as ImageData
}

async function renderHarness() {
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => {
    root.render(<Harness />)
  })
  return root
}

describe('useCoreMLDetection', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('routes system info through the centralized command and normalizes the response', async () => {
    invokeMock.mockResolvedValue({
      platform: 'macos',
      arch: 'aarch64',
      coremlAvailable: true,
      onnxAvailable: false,
      backend: 'CoreML Native FFI',
      mode: 'raw-rgba',
    })
    const root = await renderHarness()

    const info = await hook.getSystemInfo()

    expect(invokeMock).toHaveBeenCalledWith('get_system_info')
    expect(info).toMatchObject({ platform: 'macos', backend: 'CoreML Native FFI', coremlAvailable: true })

    await act(async () => root.unmount())
  })

  it('routes image detection through the native raw command and updates state', async () => {
    invokeMock.mockResolvedValue({
      success: true,
      detections: [
        {
          id: 'det-1',
          classLabel: 'drone',
          classIndex: 0,
          confidence: 0.9,
          bbox: { x1: 0, y1: 0, x2: 2, y2: 1 },
          timestamp: 123,
        },
      ],
      inferenceTimeMs: 12,
      preprocessTimeMs: 1,
      postprocessTimeMs: 2,
      error: null,
      backend: 'ONNX Runtime',
    })
    const root = await renderHarness()

    let detections = [] as Awaited<ReturnType<typeof hook.detect>>
    await act(async () => {
      detections = await hook.detect(createTestImageData())
    })

    expect(invokeMock).toHaveBeenCalledWith('detect_native_raw', {
      rgbaData: [255, 0, 0, 255, 0, 255, 0, 255],
      width: 2,
      height: 1,
      confidenceThreshold: 0.25,
      iouThreshold: 0.45,
      maxDetections: 100,
    })
    expect(detections).toHaveLength(1)
    expect(hook.detections).toHaveLength(1)
    expect(hook.inferenceTime).toBe(12)
    expect(hook.backend).toBe('ONNX Runtime')

    await act(async () => root.unmount())
  })

  it('stores detection errors and rethrows failures', async () => {
    invokeMock.mockResolvedValue({
      success: false,
      detections: [],
      inferenceTimeMs: 0,
      preprocessTimeMs: null,
      postprocessTimeMs: null,
      error: 'backend unavailable',
    })
    const root = await renderHarness()

    let error: unknown
    await act(async () => {
      try {
        await hook.detect(createTestImageData())
      } catch (caught) {
        error = caught
      }
    })

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('backend unavailable')
    expect(hook.error).toBe('backend unavailable')
    expect(hook.detections).toEqual([])

    await act(async () => root.unmount())
  })

  it('detects from canvas data through the native raw command', async () => {
    invokeMock.mockResolvedValue({
      success: true,
      detections: [],
      inferenceTimeMs: 5,
      preprocessTimeMs: 1,
      postprocessTimeMs: 1,
      error: null,
      backend: 'ONNX Runtime',
    })
    const root = await renderHarness()
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 1
    vi.spyOn(canvas, 'getContext').mockImplementation((() => ({
      getImageData: vi.fn(() => createTestImageData()),
    })) as unknown as HTMLCanvasElement['getContext'])

    await act(async () => {
      await expect(hook.detectFromCanvas(canvas)).resolves.toEqual([])
    })

    expect(invokeMock).toHaveBeenCalledWith('detect_native_raw', {
      rgbaData: [255, 0, 0, 255, 0, 255, 0, 255],
      width: 2,
      height: 1,
      confidenceThreshold: 0.25,
      iouThreshold: 0.45,
      maxDetections: 100,
    })
    expect(hook.inferenceTime).toBe(5)

    await act(async () => root.unmount())
  })

  it('surfaces canvas extraction failures without invoking detection', async () => {
    const root = await renderHarness()
    const canvas = document.createElement('canvas')
    vi.spyOn(canvas, 'getContext').mockReturnValue(null)

    let error: unknown
    await act(async () => {
      try {
        await hook.detectFromCanvas(canvas)
      } catch (caught) {
        error = caught
      }
    })

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Failed to get 2D context')
    expect(hook.error).toBe('Failed to get 2D context')
    expect(invokeMock).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })
})
