/**
 * CREBAIN Application Root
 * Adaptive Response & Awareness System (ARAS)
 *
 * Main application component that composes the viewer with UI panels.
 * Uses UIScaleProvider for centralized UI scaling management.
 */

import { useCallback, useEffect, useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
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
import { getBackendHealth, normalizeSystemInfo, type SystemInfo } from './lib/diagnostics'
import { logger } from './lib/logger'
import type { FilterAlgorithm } from './detection/AdvancedSensorFusion'
import { RENDERER_ROSBRIDGE_AVAILABLE } from '#renderer-rosbridge'

const log = logger.scope('App')
const PRODUCTION_CUSTOM_SENSOR_NOTICE =
  'Custom ROS sensor topics are available only in the Vite development profile; packaged builds remain on native Zenoh telemetry.'

export default function App() {
  const performanceTracker = usePerformanceTracker({ maxHistory: 100 })
  const { recordSample } = performanceTracker
  const [detectionError, setDetectionError] = useState<string | null>(null)
  const [showPerformancePanel, setShowPerformancePanel] = useState(true)
  const [showROSPanel, setShowROSPanel] = useState(false)
  const [showFusionPanel, setShowFusionPanel] = useState(true)
  const [showAbout, setShowAbout] = useState(false)
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null)
  const [fusionAlgorithm, setFusionAlgorithm] = useState<FilterAlgorithm>('ExtendedKalman')
  const [systemInfo, setSystemInfo] = useState<SystemInfo>(() => normalizeSystemInfo(null))
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
      await setAlgorithm(algorithm)
      setFusionAlgorithm(algorithm)
    },
    [setAlgorithm]
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
        setShowROSPanel((prev) => !prev)
      }
      if (key === APP_SHORTCUTS.toggleFusionPanel) {
        setShowFusionPanel((prev) => !prev)
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    // The native menu does not exist in browser/Vite mode. Guarding this call
    // avoids a rejected Tauri IPC promise on every browser mount.
    if (isTauri()) {
      void listen('show-about', () => {
        setShowAbout(true)
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
  }, [])

  useEffect(() => {
    if (!isTauri()) return

    let cancelled = false

    const refreshSystemInfo = async () => {
      try {
        const info = await invoke<unknown>(TAURI_COMMANDS.detection.systemInfo)
        if (!cancelled) {
          setSystemInfo(normalizeSystemInfo(info))
        }
      } catch (error) {
        log.warn('Failed to refresh system info', { error })
        if (!cancelled) {
          setSystemInfo(normalizeSystemInfo(null))
        }
      }
    }

    void refreshSystemInfo()

    return () => {
      cancelled = true
    }
  }, [])

  const backendHealth = getBackendHealth(systemInfo)

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
          />
          {showPerformancePanel && (
            <PerformancePanel
              data={performanceTracker.currentData}
              history={performanceTracker.history}
              isReady={backendHealth === 'ready'}
              error={detectionError}
              backend={systemInfo.backend}
              backendDetail={systemInfo.mode !== 'unknown' ? systemInfo.mode : undefined}
            />
          )}
          {showROSPanel && (
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
            tracks={sensors.tracks}
            stats={sensors.fusionStats}
            sensorStatus={sensors.sensorStatus}
            isExpanded={showFusionPanel}
            onToggleExpand={() => setShowFusionPanel((prev) => !prev)}
            onSelectTrack={setSelectedTrackId}
            selectedTrackId={selectedTrackId}
            connectionState={sensors.connectionState}
            connectionError={sensors.fusionError ?? sensors.connectionError}
            onOpenConnection={() => {
              if (RENDERER_ROSBRIDGE_AVAILABLE && gazebo.transport !== 'websocket') {
                gazebo.setTransport('websocket')
              }
              setShowROSPanel(true)
            }}
            algorithm={fusionAlgorithm}
            onAlgorithmChange={handleFusionAlgorithmChange}
            fusionAvailable={sensors.fusionAvailable}
          />
          <AboutModal isOpen={showAbout} onClose={handleCloseAbout} />
        </div>
      </UIScaleProvider>
    </ErrorBoundary>
  )
}
