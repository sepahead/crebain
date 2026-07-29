/**
 * CREBAIN Detection Overlay Component
 * Draws tactical-styled bounding boxes on camera feeds
 */

import { useEffect, useRef, useCallback } from 'react'
import type { Detection } from '../detection/types'
import { drawDetectionsOnCanvas } from './detectionCanvas'

interface DetectionOverlayProps {
  detections: Detection[]
  width: number
  height: number
  showLabels?: boolean
  showConfidence?: boolean
  showCornerMarkers?: boolean
  className?: string
}

/**
 * Detection Overlay Component
 * Renders as a canvas layer positioned over the camera feed
 */
export function DetectionOverlay({
  detections,
  width,
  height,
  showLabels = true,
  showConfidence = true,
  showCornerMarkers = true,
  className = '',
}: DetectionOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const drawOverlay = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Clear previous frame
    ctx.clearRect(0, 0, width, height)

    drawDetectionsOnCanvas(ctx, detections, width, height, {
      showLabels,
      showConfidence,
      showCornerMarkers,
    })
  }, [detections, width, height, showLabels, showConfidence, showCornerMarkers])

  useEffect(() => {
    drawOverlay()
  }, [drawOverlay])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={`pointer-events-none ${className}`}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
      }}
    />
  )
}

export default DetectionOverlay
