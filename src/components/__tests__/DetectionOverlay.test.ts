import { describe, expect, it, vi } from 'vitest'
import type { BoundingBox, Detection } from '../../detection/types'
import { drawDetectionsOnCanvas } from '../DetectionOverlay'

const DRAW_OPTIONS = {
  showLabels: false,
  showConfidence: false,
  showCornerMarkers: false,
}

function makeDetection(bbox: BoundingBox): Detection {
  return {
    id: '',
    class: 'drone',
    confidence: 0.9,
    bbox,
    timestamp: 0,
  }
}

function makeContext(): {
  context: CanvasRenderingContext2D
  fillRect: ReturnType<typeof vi.fn>
  strokeRect: ReturnType<typeof vi.fn>
} {
  const fillRect = vi.fn()
  const strokeRect = vi.fn()
  const context = {
    save: vi.fn(),
    restore: vi.fn(),
    fillRect,
    strokeRect,
  } as unknown as CanvasRenderingContext2D
  return { context, fillRect, strokeRect }
}

describe('drawDetectionsOnCanvas', () => {
  it('clips both horizontal endpoints before calculating width', () => {
    const { context, fillRect, strokeRect } = makeContext()

    drawDetectionsOnCanvas(context, [makeDetection([-100, 0, 10, 10])], 100, 100, DRAW_OPTIONS)

    expect(fillRect).toHaveBeenCalledWith(0, 0, 10, 10)
    expect(strokeRect).toHaveBeenCalledWith(0, 0, 10, 10)
  })

  it('clips both bottom-right endpoints to the canvas', () => {
    const { context, fillRect } = makeContext()

    drawDetectionsOnCanvas(context, [makeDetection([90, 80, 120, 130])], 100, 100, DRAW_OPTIONS)

    expect(fillRect).toHaveBeenCalledWith(90, 80, 10, 20)
  })

  it('does not draw inverted bounding boxes', () => {
    const { context, fillRect } = makeContext()

    drawDetectionsOnCanvas(context, [makeDetection([20, 10, 10, 30])], 100, 100, DRAW_OPTIONS)

    expect(fillRect).not.toHaveBeenCalled()
  })

  it('does not draw non-finite bounding boxes', () => {
    const { context, fillRect } = makeContext()
    const detections = [
      makeDetection([Number.NaN, 0, 10, 10]),
      makeDetection([0, Number.POSITIVE_INFINITY, 10, 10]),
      makeDetection([0, 0, Number.NEGATIVE_INFINITY, 10]),
    ]

    drawDetectionsOnCanvas(context, detections, 100, 100, DRAW_OPTIONS)

    expect(fillRect).not.toHaveBeenCalled()
  })

  it('does not draw boxes fully outside the canvas', () => {
    const { context, fillRect } = makeContext()

    drawDetectionsOnCanvas(context, [makeDetection([-20, -20, -10, -10])], 100, 100, DRAW_OPTIONS)

    expect(fillRect).not.toHaveBeenCalled()
  })
})
