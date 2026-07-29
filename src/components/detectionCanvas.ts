import { type Detection, THREAT_LEVEL_COLORS, getThreatLevel } from '../detection/types'

const CLASS_DISPLAY_NAMES: Record<string, string> = {
  drone: 'DROHNE',
  bird: 'VOGEL',
  aircraft: 'FLUGZEUG',
  helicopter: 'HELIKOPTER',
  unknown: 'UNBEKANNT',
}

interface DrawDetectionOptions {
  showLabels?: boolean
  showConfidence?: boolean
  showCornerMarkers?: boolean
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function clipDetectionBox(
  bbox: Detection['bbox'],
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number; width: number; height: number } | null {
  const [x1, y1, x2, y2] = bbox
  if (
    !Number.isFinite(canvasWidth) ||
    !Number.isFinite(canvasHeight) ||
    canvasWidth <= 0 ||
    canvasHeight <= 0 ||
    !Number.isFinite(x1) ||
    !Number.isFinite(y1) ||
    !Number.isFinite(x2) ||
    !Number.isFinite(y2) ||
    x2 <= x1 ||
    y2 <= y1
  ) {
    return null
  }

  const clippedX1 = Math.max(0, Math.min(x1, canvasWidth))
  const clippedY1 = Math.max(0, Math.min(y1, canvasHeight))
  const clippedX2 = Math.max(0, Math.min(x2, canvasWidth))
  const clippedY2 = Math.max(0, Math.min(y2, canvasHeight))
  const width = clippedX2 - clippedX1
  const height = clippedY2 - clippedY1
  if (width <= 0 || height <= 0) return null

  return { x: clippedX1, y: clippedY1, width, height }
}

function drawDetectionBox(
  ctx: CanvasRenderingContext2D,
  detection: Detection,
  canvasWidth: number,
  canvasHeight: number,
  showLabels: boolean,
  showConfidence: boolean,
  showCornerMarkers: boolean
): void {
  const clippedBox = clipDetectionBox(detection.bbox, canvasWidth, canvasHeight)
  if (!clippedBox) return
  const { x: boxX, y: boxY, width: boxW, height: boxH } = clippedBox

  const threatLevel = detection.threatLevel ?? getThreatLevel(detection.class, detection.confidence)
  const baseColor = THREAT_LEVEL_COLORS[threatLevel]
  const colors = {
    border: baseColor,
    fill: hexToRgba(baseColor, 0.1),
    text: baseColor,
  }

  ctx.save()
  ctx.fillStyle = colors.fill
  ctx.fillRect(boxX, boxY, boxW, boxH)
  ctx.strokeStyle = colors.border
  ctx.lineWidth = 2
  ctx.strokeRect(boxX, boxY, boxW, boxH)

  if (showCornerMarkers) {
    const cornerLength = Math.min(15, boxW / 4, boxH / 4)
    ctx.lineWidth = 3
    ctx.strokeStyle = colors.border

    ctx.beginPath()
    ctx.moveTo(boxX, boxY + cornerLength)
    ctx.lineTo(boxX, boxY)
    ctx.lineTo(boxX + cornerLength, boxY)
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(boxX + boxW - cornerLength, boxY)
    ctx.lineTo(boxX + boxW, boxY)
    ctx.lineTo(boxX + boxW, boxY + cornerLength)
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(boxX, boxY + boxH - cornerLength)
    ctx.lineTo(boxX, boxY + boxH)
    ctx.lineTo(boxX + cornerLength, boxY + boxH)
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(boxX + boxW - cornerLength, boxY + boxH)
    ctx.lineTo(boxX + boxW, boxY + boxH)
    ctx.lineTo(boxX + boxW, boxY + boxH - cornerLength)
    ctx.stroke()
  }

  if (showLabels || showConfidence) {
    const className = CLASS_DISPLAY_NAMES[detection.class] || detection.class.toUpperCase()
    const confidenceText = showConfidence ? ` ${Math.round(detection.confidence * 100)}%` : ''
    const labelText = showLabels ? className + confidenceText : confidenceText.trim()

    if (labelText) {
      ctx.font = 'bold 10px monospace'
      const padding = 4
      const labelWidth = ctx.measureText(labelText).width + padding * 2
      const labelHeight = 12 + padding
      const labelX = boxX
      const labelY = boxY - labelHeight - 2 < 0 ? boxY + 2 : boxY - labelHeight - 2

      ctx.fillStyle = 'rgba(0, 0, 0, 0.8)'
      ctx.fillRect(labelX, labelY, labelWidth, labelHeight)
      ctx.strokeStyle = colors.border
      ctx.lineWidth = 1
      ctx.strokeRect(labelX, labelY, labelWidth, labelHeight)
      ctx.fillStyle = colors.text
      ctx.textBaseline = 'middle'
      ctx.fillText(labelText, labelX + padding, labelY + labelHeight / 2)
    }
  }

  if (showConfidence && boxW > 30) {
    const barHeight = 3
    const barY = boxY + boxH - barHeight - 2
    const barWidth = boxW - 4
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
    ctx.fillRect(boxX + 2, barY, barWidth, barHeight)
    ctx.fillStyle = colors.border
    ctx.fillRect(boxX + 2, barY, barWidth * detection.confidence, barHeight)
  }

  if (detection.id) {
    ctx.font = '8px monospace'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)'
    ctx.textBaseline = 'top'
    ctx.fillText(detection.id.slice(-6), boxX + 3, boxY + boxH - 12)
  }

  ctx.restore()
}

export function drawDetectionsOnCanvas(
  ctx: CanvasRenderingContext2D,
  detections: Detection[],
  canvasWidth: number,
  canvasHeight: number,
  options: DrawDetectionOptions = {}
): void {
  const { showLabels = true, showConfidence = true, showCornerMarkers = true } = options

  for (const detection of detections) {
    drawDetectionBox(
      ctx,
      detection,
      canvasWidth,
      canvasHeight,
      showLabels,
      showConfidence,
      showCornerMarkers
    )
  }
}
