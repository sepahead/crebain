import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_IOU_THRESHOLD,
  DEFAULT_MAX_DETECTIONS,
} from '../../detection/types'
import { normalizeNativeDetectionResult } from '../../detection/nativeDetectionResult'
import { runNativeDetectionRequest } from '../../detection/nativeDetectionRequest'
import { imageDataToRGBA } from '../../hooks/useDetectionLoop'
import { calculateLatencyStats } from '../../lib/diagnostics'
import { logger } from '../../lib/logger'
import { TAURI_COMMANDS } from '../../lib/tauriCommands'
import type { ConsoleMessage } from './types'

const log = logger.scope('NativeDetectorDiagnostics')
const TEST_WIDTH = 640
const TEST_HEIGHT = 480
const BENCHMARK_ITERATIONS = 100
const BENCHMARK_PROGRESS_STEP = 10

interface DetectionSummary {
  inferenceTimeMs: number
  preprocessTimeMs?: number
  postprocessTimeMs?: number
  detectionCount: number
}

interface NativeDetectorDiagnosticsOptions {
  nativeAvailable: boolean
  viewerMountedRef: { readonly current: boolean }
  addMessage: (type: ConsoleMessage['type'], message: string) => void
  onDetectionComplete?: (result: DetectionSummary) => void
  onDetectionError?: (message: string) => void
  onRefreshSystemInfo?: () => void | Promise<void>
}

type DiagnosticOperation = 'idle' | 'test' | 'benchmark'

function notifyObserver(label: string, operation: () => void): void {
  try {
    operation()
  } catch (error) {
    log.warn(`${label} observer failed`, { error })
  }
}

function notifyAsyncObserver(label: string, operation: () => void | Promise<void>): void {
  try {
    void Promise.resolve(operation()).catch((error: unknown) => {
      log.warn(`${label} observer failed`, { error })
    })
  } catch (error) {
    log.warn(`${label} observer failed`, { error })
  }
}

function syntheticDetectorInput(): {
  rgbaData: Uint8Array
  width: number
  height: number
} {
  const canvas = document.createElement('canvas')
  canvas.width = TEST_WIDTH
  canvas.height = TEST_HEIGHT
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas context not available')

  const gradient = context.createLinearGradient(0, 0, 0, TEST_HEIGHT)
  gradient.addColorStop(0, '#87CEEB')
  gradient.addColorStop(1, '#228B22')
  context.fillStyle = gradient
  context.fillRect(0, 0, TEST_WIDTH, TEST_HEIGHT)

  context.fillStyle = '#8B4513'
  context.fillRect(100, 280, 40, 100)
  context.fillStyle = '#FFE4C4'
  context.beginPath()
  context.arc(120, 265, 20, 0, Math.PI * 2)
  context.fill()

  context.fillStyle = '#333'
  context.beginPath()
  context.moveTo(300, 100)
  context.lineTo(320, 110)
  context.lineTo(280, 110)
  context.closePath()
  context.fill()

  context.fillStyle = '#C41E3A'
  context.fillRect(400, 350, 120, 50)
  return {
    rgbaData: imageDataToRGBA(context.getImageData(0, 0, TEST_WIDTH, TEST_HEIGHT)),
    width: TEST_WIDTH,
    height: TEST_HEIGHT,
  }
}

function nativeRequest(input: ReturnType<typeof syntheticDetectorInput>): Promise<unknown> {
  return invoke<unknown>(TAURI_COMMANDS.detection.nativeRaw, {
    rgbaData: input.rgbaData,
    width: input.width,
    height: input.height,
    confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    iouThreshold: DEFAULT_IOU_THRESHOLD,
    maxDetections: DEFAULT_MAX_DETECTIONS,
  })
}

export function useNativeDetectorDiagnostics({
  nativeAvailable,
  viewerMountedRef,
  addMessage,
  onDetectionComplete,
  onDetectionError,
  onRefreshSystemInfo,
}: NativeDetectorDiagnosticsOptions) {
  const [isTesting, setIsTesting] = useState(false)
  const [isBenchmarking, setIsBenchmarking] = useState(false)
  const [benchmarkProgress, setBenchmarkProgress] = useState(0)
  const activeOperationRef = useRef<DiagnosticOperation>('idle')
  const benchmarkAbortRef = useRef(false)
  const benchmarkRunIdRef = useRef(0)
  const requestControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      activeOperationRef.current = 'idle'
      benchmarkAbortRef.current = true
      benchmarkRunIdRef.current += 1
      requestControllerRef.current?.abort(new DOMException('Viewer closed', 'AbortError'))
      requestControllerRef.current = null
    }
  }, [])

  const reportUnavailable = useCallback(() => {
    const message = 'Native detection is available only in the desktop app'
    addMessage('error', 'NATIVE DETEKTION NUR IN DER DESKTOP-APP VERFÜGBAR (nicht im Browser)')
    notifyObserver('Detection error', () => onDetectionError?.(message))
  }, [addMessage, onDetectionError])

  const testDetector = useCallback(async () => {
    if (activeOperationRef.current !== 'idle') return
    if (!nativeAvailable) {
      reportUnavailable()
      return
    }

    activeOperationRef.current = 'test'
    setIsTesting(true)
    const controller = new AbortController()
    requestControllerRef.current?.abort(
      new DOMException('Native detector test superseded', 'AbortError')
    )
    requestControllerRef.current = controller
    addMessage('info', 'NATIVE DETECTOR TEST: Generiere Testbild...')

    try {
      const input = syntheticDetectorInput()
      addMessage('info', 'NATIVE DETECTOR TEST: Starte Inferenz...')
      const startTime = performance.now()
      const result = normalizeNativeDetectionResult(
        await runNativeDetectionRequest(() => nativeRequest(input), {
          signal: controller.signal,
          isCurrent: () => viewerMountedRef.current && requestControllerRef.current === controller,
        }),
        input.width,
        input.height
      )
      const totalTime = performance.now() - startTime

      if (!result.success) {
        const message = result.error || 'Native detector test failed'
        addMessage('error', `NATIVE DETECTOR TEST FEHLER: ${message}`)
        notifyObserver('Detection error', () => onDetectionError?.(message))
        return
      }

      const detectionCount = result.detections.length
      const backendText = result.backend ? ` [${result.backend}]` : ''
      addMessage(
        'success',
        `NATIVE DETECTOR TEST ERFOLGREICH${backendText}: ${detectionCount} Detektionen in ${result.inferenceTimeMs.toFixed(2)}ms (Gesamt: ${totalTime.toFixed(2)}ms)`
      )
      if (detectionCount > 0) {
        addMessage(
          'info',
          `Erkannt: ${result.detections.map((item) => item.classLabel).join(', ')}`
        )
      }
      notifyObserver('Detection result', () =>
        onDetectionComplete?.({
          inferenceTimeMs: result.inferenceTimeMs,
          preprocessTimeMs: result.preprocessTimeMs ?? undefined,
          postprocessTimeMs: result.postprocessTimeMs ?? undefined,
          detectionCount,
        })
      )
    } catch (error) {
      if (viewerMountedRef.current && requestControllerRef.current === controller) {
        const message = error instanceof Error ? error.message : String(error)
        addMessage('error', `NATIVE DETECTOR TEST FEHLER: ${message}`)
        notifyObserver('Detection error', () => onDetectionError?.(message))
      }
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null
        activeOperationRef.current = 'idle'
      }
      if (viewerMountedRef.current && activeOperationRef.current === 'idle') {
        setIsTesting(false)
        notifyAsyncObserver('System diagnostics refresh', () => onRefreshSystemInfo?.())
      }
    }
  }, [
    addMessage,
    nativeAvailable,
    onDetectionComplete,
    onDetectionError,
    onRefreshSystemInfo,
    reportUnavailable,
    viewerMountedRef,
  ])

  const cancelBenchmark = useCallback(() => {
    if (activeOperationRef.current !== 'benchmark') return
    benchmarkAbortRef.current = true
    requestControllerRef.current?.abort(
      new DOMException('Native detector benchmark cancelled', 'AbortError')
    )
    addMessage('warning', 'BENCHMARK: Abbruch angefordert')
  }, [addMessage])

  const runBenchmark = useCallback(async () => {
    if (activeOperationRef.current !== 'idle') return
    if (!nativeAvailable) {
      reportUnavailable()
      return
    }

    activeOperationRef.current = 'benchmark'
    const runId = benchmarkRunIdRef.current + 1
    benchmarkRunIdRef.current = runId
    benchmarkAbortRef.current = false
    const controller = new AbortController()
    requestControllerRef.current?.abort(
      new DOMException('Native detector benchmark superseded', 'AbortError')
    )
    requestControllerRef.current = controller
    const isCurrent = () =>
      viewerMountedRef.current &&
      benchmarkRunIdRef.current === runId &&
      !benchmarkAbortRef.current &&
      requestControllerRef.current === controller

    setIsBenchmarking(true)
    setBenchmarkProgress(0)
    addMessage('info', `BENCHMARK: Starte ${BENCHMARK_ITERATIONS} Inferenzen...`)
    const latencies: number[] = []
    let latestDetectionCount = 0

    try {
      const input = syntheticDetectorInput()
      addMessage('info', 'BENCHMARK: Aufwärmphase...')
      const warmup = normalizeNativeDetectionResult(
        await runNativeDetectionRequest(() => nativeRequest(input), {
          signal: controller.signal,
          isCurrent,
        }),
        input.width,
        input.height
      )
      if (!warmup.success) {
        throw new Error(warmup.error || 'Native detector warm-up failed')
      }
      if (benchmarkAbortRef.current) {
        addMessage('warning', 'BENCHMARK: Abgebrochen')
        return
      }

      addMessage('info', `BENCHMARK: Führe ${BENCHMARK_ITERATIONS} Iterationen aus...`)
      const benchmarkStart = performance.now()
      for (let index = 0; index < BENCHMARK_ITERATIONS; index += 1) {
        if (benchmarkAbortRef.current) break
        const result = normalizeNativeDetectionResult(
          await runNativeDetectionRequest(() => nativeRequest(input), {
            signal: controller.signal,
            isCurrent,
          }),
          input.width,
          input.height
        )
        if (result.success && Number.isFinite(result.inferenceTimeMs)) {
          latencies.push(result.inferenceTimeMs)
          latestDetectionCount = result.detections.length
        } else {
          addMessage('warning', `BENCHMARK: Iteration ${index + 1} ohne Messwert übersprungen`)
        }
        if ((index + 1) % BENCHMARK_PROGRESS_STEP === 0 || index + 1 === BENCHMARK_ITERATIONS) {
          setBenchmarkProgress(((index + 1) / BENCHMARK_ITERATIONS) * 100)
        }
      }

      if (benchmarkAbortRef.current) {
        addMessage('warning', 'BENCHMARK: Abgebrochen')
        return
      }
      if (latencies.length === 0) throw new Error('No successful benchmark measurements')

      const totalTimeMs = performance.now() - benchmarkStart
      const stats = calculateLatencyStats(latencies)
      const variance = latencies.reduce(
        (average, latency, index) =>
          average + ((latency - stats.mean) ** 2 - average) / (index + 1),
        0
      )
      const standardDeviation = Math.sqrt(Math.max(0, variance))
      const throughputFps = totalTimeMs > 0 ? (latencies.length / totalTimeMs) * 1000 : 0

      setBenchmarkProgress(100)
      addMessage('success', '═══════════════════════════════════════')
      addMessage(
        'success',
        `BENCHMARK ERGEBNISSE (${latencies.length}/${BENCHMARK_ITERATIONS} Iterationen)`
      )
      addMessage('info', `MIN:    ${stats.min.toFixed(2)} ms`)
      addMessage('info', `MAX:    ${stats.max.toFixed(2)} ms`)
      addMessage('info', `MEAN:   ${stats.mean.toFixed(2)} ms`)
      addMessage('info', `MEDIAN: ${stats.p50.toFixed(2)} ms`)
      addMessage('info', `P95:    ${stats.p95.toFixed(2)} ms`)
      addMessage('info', `P99:    ${stats.p99.toFixed(2)} ms`)
      addMessage('info', `STD:    ${standardDeviation.toFixed(2)} ms`)
      addMessage('tactical', `DURCHSATZ: ${throughputFps.toFixed(1)} FPS`)
      addMessage('tactical', `GESAMT:    ${totalTimeMs.toFixed(0)} ms`)
      addMessage('success', '═══════════════════════════════════════')
      notifyObserver('Detection result', () =>
        onDetectionComplete?.({
          inferenceTimeMs: stats.mean,
          detectionCount: latestDetectionCount,
        })
      )
    } catch (error) {
      if (viewerMountedRef.current && benchmarkRunIdRef.current === runId) {
        if (benchmarkAbortRef.current) addMessage('warning', 'BENCHMARK: Abgebrochen')
        else {
          const message = error instanceof Error ? error.message : String(error)
          addMessage('error', `BENCHMARK FEHLER: ${message}`)
          notifyObserver('Detection error', () => onDetectionError?.(message))
        }
      }
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null
      if (benchmarkRunIdRef.current === runId) {
        activeOperationRef.current = 'idle'
        setIsBenchmarking(false)
        setBenchmarkProgress(0)
      }
      if (viewerMountedRef.current) {
        notifyAsyncObserver('System diagnostics refresh', () => onRefreshSystemInfo?.())
      }
    }
  }, [
    addMessage,
    nativeAvailable,
    onDetectionComplete,
    onDetectionError,
    onRefreshSystemInfo,
    reportUnavailable,
    viewerMountedRef,
  ])

  return {
    benchmarkProgress,
    cancelBenchmark,
    isBenchmarking,
    isTesting,
    runBenchmark,
    testDetector,
  }
}
