/**
 * CREBAIN Application Root
 * Adaptive Response & Awareness System (ARAS)
 *
 * Main application component that composes the viewer with UI panels.
 * Uses UIScaleProvider for centralized UI scaling management.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import CrebainViewer from './components/CrebainViewer'
import ErrorBoundary from './components/ErrorBoundary'
import PerformancePanel from './components/PerformancePanel'
import ROSConnectionPanel from './components/ROSConnectionPanel'
import SensorFusionPanel from './components/SensorFusionPanel'
import { AboutModal } from './components/AboutModal'
import { UIScaleProvider } from './context/UIScaleContext'
import { usePerformanceTracker } from './hooks/usePerformanceTracker'
import { useGazeboSimulation } from './hooks/useGazeboSimulation'
import { ROS_SENSOR_WEBSOCKET_REQUIRED, useROSSensors } from './ros/useROSSensors'
import { APP_SHORTCUTS, isTextInputTarget, normalizeShortcutKey } from './lib/shortcuts'
import { TAURI_COMMANDS } from './lib/tauriCommands'
import { runWithOperationDeadline } from './lib/operationDeadline'
import {
  getBackendHealth,
  normalizeSystemInfo,
  type DiagnosticsStatus,
  type SystemInfo,
} from './lib/diagnostics'
import { logger } from './lib/logger'
import { isEngramEmbeddedMode, isNativeBackendAvailable } from './integrations/engramHost'
import type { FilterAlgorithm } from './detection/AdvancedSensorFusion'
import { RENDERER_ROSBRIDGE_AVAILABLE } from '#renderer-rosbridge'

const log = logger.scope('App')
const PRODUCTION_CUSTOM_SENSOR_NOTICE =
  'Custom ROS sensor topics are available only in the Vite development profile; packaged builds remain on native Zenoh telemetry.'
const DIAGNOSTICS_POLL_INTERVAL_MS = 500
const DIAGNOSTICS_REQUEST_TIMEOUT_MS = 10_000
const TRANSIENT_DIAGNOSTICS_STATUSES: ReadonlySet<DiagnosticsStatus> = new Set([
  'loading',
  'initializing',
  'busy',
])

export default function App() {
  const embeddedInEngram = isEngramEmbeddedMode()
  const [nativeBackendAvailable] = useState(() => isNativeBackendAvailable())
  const performanceTracker = usePerformanceTracker({ maxHistory: 100 })
  const { recordSample } = performanceTracker
  const [detectionError, setDetectionError] = useState<string | null>(null)
  const [showPerformancePanel, setShowPerformancePanel] = useState(true)
  const [showROSPanel, setShowROSPanel] = useState(false)
  const [showFusionPanel, setShowFusionPanel] = useState(() => !embeddedInEngram)
  const [showAbout, setShowAbout] = useState(false)
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null)
  const [fusionAlgorithm, setFusionAlgorithm] = useState<FilterAlgorithm>('ExtendedKalman')
  const [systemInfo, setSystemInfo] = useState<SystemInfo>(() => normalizeSystemInfo(null))
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<DiagnosticsStatus>(() =>
    nativeBackendAvailable ? 'loading' : 'unavailable'
  )
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null)
  const diagnosticsRequestRef = useRef(0)
  const diagnosticsInFlightRef = useRef<Promise<DiagnosticsStatus | null> | null>(null)
  const handleCloseAbout = useCallback(() => setShowAbout(false), [])

  // ROS-Gazebo simulation
  const gazebo = useGazeboSimulation({
    rosUrl: 'ws://localhost:9090',
    autoConnect: false,
  })

  // Multi-sensor fusion
  const sensors = useROSSensors({
    rosUrl: 'ws://localhost:9090',
    autoConnect: false,
    algorithm: fusionAlgorithm,
    externalConnection:
      RENDERER_ROSBRIDGE_AVAILABLE && gazebo.transport === 'websocket'
        ? {
            bridge: gazebo.bridge,
            connectionState: gazebo.connectionState,
            connectionError: gazebo.connectionError,
          }
        : {
            bridge: null,
            connectionState: 'disconnected',
            unsupportedReason: RENDERER_ROSBRIDGE_AVAILABLE
              ? ROS_SENSOR_WEBSOCKET_REQUIRED
              : PRODUCTION_CUSTOM_SENSOR_NOTICE,
          },
  })
  const { addVisualDetection, setAlgorithm } = sensors
  const handleFusionAlgorithmChange = useCallback(
    async (algorithm: FilterAlgorithm) => {
      if (embeddedInEngram) return
      await setAlgorithm(algorithm)
      setFusionAlgorithm(algorithm)
    },
    [embeddedInEngram, setAlgorithm]
  )

  const onVisualTrack = useCallback(
    (track: {
      id: string
      position: [number, number, number]
      confidence: number
      classLabel: string
      timestampMs: number
    }) => {
      addVisualDetection(
        `visual:${track.id}`,
        track.position,
        track.confidence,
        track.classLabel,
        track.timestampMs
      )
    },
    [addVisualDetection]
  )

  // Handle detection results from CrebainViewer
  const onDetectionComplete = useCallback(
    (result: {
      inferenceTimeMs: number
      preprocessTimeMs?: number
      postprocessTimeMs?: number
      detectionCount: number
    }) => {
      recordSample(result)
      // React ignores the update when the error is already clear.
      setDetectionError(null)
    },
    [recordSample]
  )

  const onDetectionError = useCallback((message: string) => {
    setDetectionError(message)
  }, [])

  const loadSystemInfo = useCallback(
    (showLoading: boolean): Promise<DiagnosticsStatus | null> => {
      if (!nativeBackendAvailable) {
        setSystemInfo(normalizeSystemInfo(null))
        setDiagnosticsStatus('unavailable')
        setDiagnosticsError(null)
        return Promise.resolve('unavailable')
      }

      if (showLoading) setDiagnosticsStatus('loading')
      setDiagnosticsError(null)
      const inFlight = diagnosticsInFlightRef.current
      if (inFlight !== null) return inFlight

      const request = diagnosticsRequestRef.current + 1
      diagnosticsRequestRef.current = request
      const operation = (async (): Promise<DiagnosticsStatus | null> => {
        try {
          const info = normalizeSystemInfo(
            await runWithOperationDeadline(
              async (guard) => {
                const result = await invoke<unknown>(TAURI_COMMANDS.detection.systemInfo)
                guard.assertActive()
                return result
              },
              {
                timeoutMs: DIAGNOSTICS_REQUEST_TIMEOUT_MS,
                timeoutMessage: 'Backend diagnostics request timed out',
                supersededMessage: 'Backend diagnostics request was superseded',
                isCurrent: () => diagnosticsRequestRef.current === request,
                onTimeout: () => undefined,
              }
            )
          )
          if (diagnosticsRequestRef.current !== request) return null
          const status = getBackendHealth(info)
          setSystemInfo(info)
          setDiagnosticsStatus(status)
          setDiagnosticsError(status === 'unavailable' ? info.inferenceInitializationError : null)
          return status
        } catch (error) {
          log.warn('Failed to refresh system info', { error })
          if (diagnosticsRequestRef.current !== request) return null
          setSystemInfo(normalizeSystemInfo(null))
          setDiagnosticsStatus('error')
          setDiagnosticsError('Backend diagnostics are unavailable')
          return 'error'
        }
      })()
      diagnosticsInFlightRef.current = operation
      void operation.then(() => {
        if (diagnosticsInFlightRef.current === operation) diagnosticsInFlightRef.current = null
      })
      return operation
    },
    [nativeBackendAvailable]
  )

  const refreshSystemInfo = useCallback(async () => {
    await loadSystemInfo(true)
  }, [loadSystemInfo])

  // Keyboard shortcuts and Menu Events
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if typing in an input
      if (isTextInputTarget(e.target)) return

      const key = normalizeShortcutKey(e.key)

      if (key === APP_SHORTCUTS.togglePerformancePanel) {
        setShowPerformancePanel((prev) => !prev)
      }
      if (key === APP_SHORTCUTS.toggleROSPanel) {
        if (!embeddedInEngram) setShowROSPanel((prev) => !prev)
      }
      if (key === APP_SHORTCUTS.toggleFusionPanel) {
        setShowFusionPanel((prev) => !prev)
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    // The native menu does not exist in browser/Vite mode. Guarding this call
    // avoids a rejected Tauri IPC promise on every browser mount.
    if (nativeBackendAvailable) {
      void listen('show-about', () => {
        if (!disposed) setShowAbout(true)
      })
        .then((cleanup) => {
          if (disposed) {
            cleanup()
          } else {
            unlisten = cleanup
          }
        })
        .catch((error) => {
          log.warn('Failed to register native menu listener', { error })
        })
    }

    return () => {
      disposed = true
      window.removeEventListener('keydown', handleKeyDown)
      unlisten?.()
    }
  }, [embeddedInEngram, nativeBackendAvailable])

  useEffect(() => {
    void loadSystemInfo(true)

    return () => {
      diagnosticsRequestRef.current += 1
      diagnosticsInFlightRef.current = null
    }
  }, [loadSystemInfo])

  useEffect(() => {
    if (!nativeBackendAvailable || !TRANSIENT_DIAGNOSTICS_STATUSES.has(diagnosticsStatus)) {
      return
    }

    let disposed = false
    let timeout: number | null = null
    const poll = async () => {
      const nextStatus = await loadSystemInfo(false)
      if (!disposed && nextStatus !== null && TRANSIENT_DIAGNOSTICS_STATUSES.has(nextStatus)) {
        timeout = window.setTimeout(() => void poll(), DIAGNOSTICS_POLL_INTERVAL_MS)
      }
    }
    timeout = window.setTimeout(() => void poll(), DIAGNOSTICS_POLL_INTERVAL_MS)
    return () => {
      disposed = true
      if (timeout !== null) window.clearTimeout(timeout)
    }
  }, [diagnosticsStatus, loadSystemInfo, nativeBackendAvailable])

  return (
    <ErrorBoundary>
      <UIScaleProvider persist={true}>
        <div className="w-full h-full relative">
          <CrebainViewer
            onDetectionComplete={onDetectionComplete}
            onVisualTrack={onVisualTrack}
            performancePanelVisible={showPerformancePanel}
            onPerformancePanelVisibleChange={setShowPerformancePanel}
            rosConnectionState={gazebo.connectionState}
            rosTransport={gazebo.transport}
            systemInfo={systemInfo}
            diagnosticsStatus={diagnosticsStatus}
            onRefreshSystemInfo={refreshSystemInfo}
            onDetectionError={onDetectionError}
          />
          {showPerformancePanel && (
            <PerformancePanel
              data={performanceTracker.currentData}
              history={performanceTracker.history}
              status={diagnosticsStatus}
              error={detectionError ?? diagnosticsError}
              backend={systemInfo.backend}
              backendDetail={systemInfo.mode !== 'unknown' ? systemInfo.mode : undefined}
              initiallyExpanded={!embeddedInEngram}
            />
          )}
          {showROSPanel && !embeddedInEngram && (
            <ROSConnectionPanel
              connectionState={gazebo.connectionState}
              transport={gazebo.transport}
              onTransportChange={gazebo.setTransport}
              rosUrl={gazebo.rosUrl}
              onUrlChange={gazebo.setRosUrl}
              onConnect={() => void gazebo.connect()}
              onDisconnect={gazebo.disconnect}
              error={gazebo.connectionError}
              drones={gazebo.allDrones}
            />
          )}
          <SensorFusionPanel
            readOnly={embeddedInEngram}
            tracks={sensors.tracks}
            stats={sensors.fusionStats}
            sensorStatus={sensors.sensorStatus}
            isExpanded={showFusionPanel}
            onToggleExpand={() => setShowFusionPanel((prev) => !prev)}
            onSelectTrack={setSelectedTrackId}
            selectedTrackId={selectedTrackId}
            connectionState={sensors.connectionState}
            connectionError={sensors.fusionError ?? sensors.connectionError}
            onOpenConnection={
              embeddedInEngram
                ? undefined
                : () => {
                    if (RENDERER_ROSBRIDGE_AVAILABLE && gazebo.transport !== 'websocket') {
                      gazebo.setTransport('websocket')
                    }
                    setShowROSPanel(true)
                  }
            }
            algorithm={fusionAlgorithm}
            onAlgorithmChange={handleFusionAlgorithmChange}
            fusionAvailable={!embeddedInEngram && sensors.fusionAvailable}
          />
          <AboutModal isOpen={showAbout} onClose={handleCloseAbout} />
          {embeddedInEngram && (
            <div
              role="status"
              data-testid="engram-embedded-boundary"
              className="fixed bottom-3 left-1/2 z-[90] -translate-x-1/2 border border-[#8a6a2f] bg-[#151108]/95 px-3 py-1 font-mono text-[10px] tracking-[0.16em] text-[#d5ad5c] shadow-lg pointer-events-none"
            >
              EMBEDDED SAFE MODE · NATIVE / TELEMETRY / ARTIFACT / NCP OFF
            </div>
          )}
        </div>
      </UIScaleProvider>
    </ErrorBoundary>
  )
}
