/**
 * CREBAIN Performance Panel
 * Adaptive Response & Awareness System (ARAS)
 *
 * Real-time performance monitoring HUD for CoreML inference
 */

import { useState, useMemo, useCallback } from 'react'
import { useDraggablePanel } from '../hooks/useDraggablePanel'
import { PANEL_POSITIONS } from './BasePanel'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface PerformanceData {
  inferenceTimeMs: number
  preprocessTimeMs?: number
  postprocessTimeMs?: number
  detectionCount: number
  timestamp: number
}

interface PerformancePanelProps {
  /** Current performance data */
  data: PerformanceData | null
  /** History of performance data for sparkline */
  history: PerformanceData[]
  /** Maximum history length */
  maxHistory?: number
  /** Whether CoreML is ready */
  isReady: boolean
  /** Current error if any */
  error: string | null
  /** Backend name */
  backend?: string
  /** Backend mode or execution detail */
  backendDetail?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// SPARKLINE COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

interface SparklineProps {
  data: number[]
  width?: number
  height?: number
  color?: string
  maxValue?: number
}

function Sparkline({
  data,
  width = 120,
  height = 32,
  color = '#10b981',
  maxValue: providedMax,
}: SparklineProps) {
  const points = useMemo(() => {
    if (data.length === 0) return ''

    const max = providedMax ?? Math.max(...data, 1)
    const min = 0
    const range = max - min || 1

    const stepX = width / Math.max(data.length - 1, 1)

    return data
      .map((value, index) => {
        const x = index * stepX
        const y = height - ((value - min) / range) * height
        return `${x},${y}`
      })
      .join(' ')
  }, [data, width, height, providedMax])

  const avgLine = useMemo(() => {
    if (data.length === 0) return height / 2
    const avg = data.reduce((a, b) => a + b, 0) / data.length
    const max = providedMax ?? Math.max(...data, 1)
    return height - (avg / max) * height
  }, [data, height, providedMax])

  return (
    <svg width={width} height={height} className="opacity-80" style={{ overflow: 'visible' }}>
      {/* Grid lines */}
      <line
        x1={0}
        y1={height * 0.25}
        x2={width}
        y2={height * 0.25}
        stroke="rgba(255,255,255,0.1)"
        strokeDasharray="2,2"
      />
      <line
        x1={0}
        y1={height * 0.5}
        x2={width}
        y2={height * 0.5}
        stroke="rgba(255,255,255,0.1)"
        strokeDasharray="2,2"
      />
      <line
        x1={0}
        y1={height * 0.75}
        x2={width}
        y2={height * 0.75}
        stroke="rgba(255,255,255,0.1)"
        strokeDasharray="2,2"
      />

      {/* Average line */}
      <line
        x1={0}
        y1={avgLine}
        x2={width}
        y2={avgLine}
        stroke="rgba(251, 191, 36, 0.5)"
        strokeWidth={1}
        strokeDasharray="4,2"
      />

      {/* Data line */}
      {data.length > 1 && (
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}

      {/* Latest point */}
      {data.length > 0 && (
        <circle
          cx={width}
          cy={height - (data[data.length - 1] / (providedMax ?? Math.max(...data, 1))) * height}
          r={3}
          fill={color}
          className="animate-pulse"
        />
      )}
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// STAT DISPLAY COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

interface StatProps {
  label: string
  value: string | number
  unit?: string
  color?: string
  small?: boolean
}

function Stat({ label, value, unit, color = 'text-emerald-400', small = false }: StatProps) {
  return (
    <div className={`flex flex-col ${small ? 'gap-0' : 'gap-0.5'}`}>
      <span className="text-[1em] uppercase tracking-wider text-gray-500 font-medium">{label}</span>
      <div className="flex items-baseline gap-1">
        <span
          className={`${small ? 'text-[1.25em]' : 'text-[1.75em]'} font-mono font-bold ${color}`}
        >
          {value}
        </span>
        {unit && <span className="text-[1em] text-gray-500">{unit}</span>}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS INDICATOR
// ─────────────────────────────────────────────────────────────────────────────

interface StatusIndicatorProps {
  isReady: boolean
  error: string | null
}

function StatusIndicator({ isReady, error }: StatusIndicatorProps) {
  if (error) {
    return (
      <div className="flex items-center gap-1.5">
        <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
        <span className="text-[1em] text-red-400 uppercase tracking-wider">Error</span>
      </div>
    )
  }

  if (!isReady) {
    return (
      <div className="flex items-center gap-1.5">
        <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
        <span className="text-[1em] text-yellow-400 uppercase tracking-wider">Loading</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5">
      <div className="w-2 h-2 rounded-full bg-emerald-500" />
      <span className="text-[1em] text-emerald-400 uppercase tracking-wider">Ready</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export function PerformancePanel({
  data,
  history,
  isReady,
  error,
  backend = 'Unknown',
  backendDetail,
}: PerformancePanelProps) {
  const [isExpanded, setIsExpanded] = useState(true)

  // Use combined draggable panel hook
  // Use centralized position from PANEL_POSITIONS
  const perfPosition = PANEL_POSITIONS.performance
  const { panelStyle, handleMouseDown, handleHeaderClick, elementRef } = useDraggablePanel({
    initialPosition: perfPosition.initialPosition,
    snapDistance: perfPosition.snapDistance,
    edgePadding: perfPosition.edgePadding,
    side: perfPosition.side,
    onHeaderClick: () => setIsExpanded((prev) => !prev),
  })

  // Calculate FPS from history
  const fps = useMemo(() => {
    if (history.length < 2) return 0
    const timeSpan = history[history.length - 1].timestamp - history[0].timestamp
    if (timeSpan <= 0) return 0
    const completedIntervals = history.length - 1
    return Math.round((completedIntervals / (timeSpan / 1000)) * 10) / 10
  }, [history])

  // Get inference times for sparkline
  const inferenceTimes = useMemo(() => {
    return history.map((h) => h.inferenceTimeMs)
  }, [history])

  // Calculate statistics
  const stats = useMemo(() => {
    if (inferenceTimes.length === 0) {
      return { avg: 0, min: 0, max: 0, p95: 0 }
    }

    const sorted = [...inferenceTimes].sort((a, b) => a - b)
    const avg = inferenceTimes.reduce((a, b) => a + b, 0) / inferenceTimes.length
    const p95Index = Math.floor(sorted.length * 0.95)

    return {
      avg: Math.round(avg * 100) / 100,
      min: Math.round(sorted[0] * 100) / 100,
      max: Math.round(sorted[sorted.length - 1] * 100) / 100,
      p95: Math.round(sorted[p95Index] * 100) / 100,
    }
  }, [inferenceTimes])

  // Format nanoseconds display
  const formatNs = useCallback((ms: number) => {
    const ns = ms * 1_000_000
    if (ns >= 1_000_000) {
      return `${(ns / 1_000_000).toFixed(2)}ms`
    }
    if (ns >= 1_000) {
      return `${(ns / 1_000).toFixed(0)}μs`
    }
    return `${ns.toFixed(0)}ns`
  }, [])

  const currentInference = data?.inferenceTimeMs ?? 0
  const detectionCount = data?.detectionCount ?? 0

  return (
    <div
      ref={elementRef}
      className="absolute top-0 right-3 z-50"
      style={panelStyle}
      onMouseDown={handleMouseDown}
    >
      <div
        className={`
          bg-black/80 backdrop-blur-sm border border-gray-700/50 rounded-lg
          shadow-xl transition-all duration-200
          ${isExpanded ? 'w-72' : 'w-auto'}
        `}
      >
        {/* Header - Drag Handle */}
        <div
          data-drag-handle
          className="flex items-center justify-between px-3 py-2 border-b border-gray-700/50 cursor-grab hover:bg-gray-800/30 select-none"
          onClick={handleHeaderClick}
        >
          <div className="flex items-center gap-2">
            <svg
              className="w-4 h-4 text-emerald-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>
            <span className="text-[1.25em] font-medium text-gray-300 uppercase tracking-wider">
              Performance
            </span>
          </div>

          <div className="flex items-center gap-3">
            <StatusIndicator isReady={isReady} error={error} />
            <svg
              className={`w-4 h-4 text-gray-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </div>
        </div>

        {/* Expanded Content */}
        {isExpanded && (
          <div className="p-3 space-y-3">
            {/* Backend Badge */}
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 text-[1em] font-medium bg-emerald-900/50 text-emerald-400 rounded uppercase tracking-wider">
                {backend}
              </span>
              {backendDetail && <span className="text-[1em] text-gray-500">{backendDetail}</span>}
            </div>

            {/* Main Stats Row */}
            <div className="grid grid-cols-3 gap-3">
              <Stat
                label="Inference"
                value={currentInference.toFixed(2)}
                unit="ms"
                color={
                  currentInference < 10
                    ? 'text-emerald-400'
                    : currentInference < 33
                      ? 'text-yellow-400'
                      : 'text-red-400'
                }
              />
              <Stat
                label="FPS"
                value={fps.toFixed(1)}
                color={
                  fps > 30 ? 'text-emerald-400' : fps > 15 ? 'text-yellow-400' : 'text-red-400'
                }
              />
              <Stat label="Detections" value={detectionCount} color="text-blue-400" />
            </div>

            {/* Sparkline */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[1em] text-gray-500 uppercase tracking-wider">
                  Inference History ({history.length} samples)
                </span>
                <span className="text-[1em] text-gray-500 font-mono">
                  {formatNs(currentInference)}
                </span>
              </div>
              <div className="bg-gray-900/50 rounded p-2">
                <Sparkline
                  data={inferenceTimes}
                  width={240}
                  height={40}
                  color={
                    currentInference < 10
                      ? '#10b981'
                      : currentInference < 33
                        ? '#fbbf24'
                        : '#ef4444'
                  }
                  maxValue={Math.max(50, stats.max * 1.2)}
                />
              </div>
            </div>

            {/* Detailed Stats */}
            <div className="grid grid-cols-4 gap-2 pt-2 border-t border-gray-700/50">
              <Stat label="Avg" value={stats.avg.toFixed(1)} unit="ms" small />
              <Stat
                label="Min"
                value={stats.min.toFixed(1)}
                unit="ms"
                small
                color="text-green-400"
              />
              <Stat
                label="Max"
                value={stats.max.toFixed(1)}
                unit="ms"
                small
                color="text-orange-400"
              />
              <Stat
                label="P95"
                value={stats.p95.toFixed(1)}
                unit="ms"
                small
                color="text-purple-400"
              />
            </div>

            {/* Preprocess/Postprocess if available */}
            {(data?.preprocessTimeMs !== undefined || data?.postprocessTimeMs !== undefined) && (
              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-gray-700/50">
                {data?.preprocessTimeMs !== undefined && (
                  <Stat
                    label="Preprocess"
                    value={data.preprocessTimeMs.toFixed(2)}
                    unit="ms"
                    small
                    color="text-cyan-400"
                  />
                )}
                {data?.postprocessTimeMs !== undefined && (
                  <Stat
                    label="Postprocess"
                    value={data.postprocessTimeMs.toFixed(2)}
                    unit="ms"
                    small
                    color="text-indigo-400"
                  />
                )}
              </div>
            )}

            {/* Error Display */}
            {error && (
              <div className="p-2 bg-red-900/30 border border-red-700/50 rounded text-base text-red-400">
                {error}
              </div>
            )}
          </div>
        )}

        {/* Collapsed View - Just show key metrics */}
        {!isExpanded && (
          <div className="px-3 py-2 flex items-center gap-4">
            <div className="flex items-center gap-1">
              <span className="text-base font-mono font-bold text-emerald-400">
                {currentInference.toFixed(1)}
              </span>
              <span className="text-[1em] text-gray-500">ms</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-base font-mono font-bold text-blue-400">{fps.toFixed(0)}</span>
              <span className="text-[1em] text-gray-500">fps</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-base font-mono font-bold text-purple-400">
                {detectionCount}
              </span>
              <span className="text-[1em] text-gray-500">det</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default PerformancePanel
