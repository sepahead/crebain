import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { convertDetection, imageDataToRGBA, useDetectionLoop } from '../useDetectionLoop'
import type { CoreMLDetection } from '../../detection/types'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function imageData(): ImageData {
  return {
    data: new Uint8ClampedArray([1, 2, 3, 4]),
    width: 1,
    height: 1,
    colorSpace: 'srgb',
  } as ImageData
}

function renderDetectionLoop({
  enabled = true,
  exportCameraFeed = vi.fn(() => imageData()),
  onDetection = vi.fn(),
  onError = vi.fn(),
  onPerformance = vi.fn(),
}: {
  enabled?: boolean
  exportCameraFeed?: (cameraId: string) => ImageData | null | Promise<ImageData | null>
  onDetection?: (cameraId: string, detections: ReturnType<typeof convertDetection>[], inferenceTimeMs: number) => void
  onError?: (error: string, cameraId?: string) => void
  onPerformance?: (metrics: { inferenceTimeMs: number; preprocessTimeMs: number; postprocessTimeMs: number; detectionCount: number; cameraId: string }) => void
} = {}) {
  function Harness({ active }: { active: boolean }) {
    useDetectionLoop({
      cameras: [{ id: 'cam-1', name: 'Camera 1', isActive: true }],
      exportCameraFeed,
      enabled: active,
      intervalMs: 1_000,
      onDetection,
      onError,
      onPerformance,
    })
    return null
  }

  const container = document.createElement('div')
  const root = createRoot(container)
  return {
    root,
    render: (active = enabled) => root.render(createElement(Harness, { active })),
    onDetection,
    onError,
    onPerformance,
  }
}

describe('useDetectionLoop helpers', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('maps native detections to tactical detections', () => {
    const nativeDetection: CoreMLDetection = {
      id: 'det-1',
      classLabel: 'kite',
      classIndex: 33,
      confidence: 0.9,
      bbox: { x1: 10, y1: 20, x2: 30, y2: 40 },
      timestamp: 1234,
    }

    const detection = convertDetection(nativeDetection, 640, 480)

    expect(detection).toMatchObject({
      id: 'det-1',
      class: 'drone',
      confidence: 0.9,
      bbox: [10, 20, 30, 40],
      timestamp: 1234,
      threatLevel: 4,
      frameWidth: 640,
      frameHeight: 480,
    })
  })

  it('maps aerial and unknown detection labels consistently', () => {
    expect(convertDetection({
      id: 'aircraft-1',
      classLabel: 'airplane',
      classIndex: 4,
      confidence: 0.99,
      bbox: { x1: 0, y1: 0, x2: 1, y2: 1 },
      timestamp: 1,
    }, 10, 10)).toMatchObject({
      class: 'aircraft',
      threatLevel: 2,
    })
    expect(convertDetection({
      id: 'unknown-1',
      classLabel: 'balloon',
      classIndex: 0,
      confidence: 0.8,
      bbox: { x1: 1, y1: 2, x2: 3, y2: 4 },
      timestamp: 2,
    }, 20, 20)).toMatchObject({
      class: 'unknown',
      threatLevel: 3,
      frameWidth: 20,
      frameHeight: 20,
    })
  })

  it('creates a raw RGBA Uint8Array view over ImageData', () => {
    const imageData = {
      data: new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]),
      width: 1,
      height: 2,
      colorSpace: 'srgb',
    } as ImageData
    const rgba = imageDataToRGBA(imageData)

    expect(rgba).toBeInstanceOf(Uint8Array)
    expect(Array.from(rgba)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    imageData.data[0] = 9
    expect(rgba[0]).toBe(9)
  })

  it('preserves byte offsets when creating RGBA views', () => {
    const source = new Uint8ClampedArray([0, 1, 2, 3, 4, 5, 6, 7])
    const imageData = {
      data: new Uint8ClampedArray(source.buffer, 4, 4),
      width: 1,
      height: 1,
      colorSpace: 'srgb',
    } as ImageData

    const rgba = imageDataToRGBA(imageData)

    expect(Array.from(rgba)).toEqual([4, 5, 6, 7])
    imageData.data[1] = 9
    expect(rgba[1]).toBe(9)
  })

  it('reports malformed native detection responses instead of dispatching detections', async () => {
    invokeMock.mockResolvedValue({
      success: true,
      detections: [{ id: 'bad', classLabel: 'drone', classIndex: 0, confidence: 0.9, timestamp: 1 }],
      inferenceTimeMs: 1,
      preprocessTimeMs: null,
      postprocessTimeMs: null,
      error: null,
    })
    const { root, render, onDetection, onError } = renderDetectionLoop()

    await act(async () => {
      render()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onDetection).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      'Invalid native detection response: detections[0].bbox must be an object',
      'cam-1'
    )

    await act(async () => root.unmount())
  })

  it('does not invoke native detection after cancellation during feed export', async () => {
    let resolveFeed!: (value: ImageData) => void
    const exportCameraFeed = vi.fn(() => new Promise<ImageData>((resolve) => {
      resolveFeed = resolve
    }))
    const { root, render, onDetection, onError } = renderDetectionLoop({ exportCameraFeed })

    await act(async () => {
      render(true)
      await Promise.resolve()
    })
    await act(async () => {
      render(false)
      await Promise.resolve()
    })
    await act(async () => {
      resolveFeed(imageData())
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(invokeMock).not.toHaveBeenCalled()
    expect(onDetection).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })
})
