/**
 * CREBAIN Application Root
 * Adaptive Response & Awareness System (ARAS)
 *
 * Main application component that composes the viewer with UI panels.
 * Uses UIScaleProvider for centralized UI scaling management.
 */

import { useState, useEffect } from 'react'
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
import { useROSSensors } from './ros/useROSSensors'

export default function App() {
  const performanceTracker = usePerformanceTracker({ maxHistory: 100 })
  const [detectionError, setDetectionError] = useState<string | null>(null)
  const [showPerformancePanel, setShowPerformancePanel] = useState(true)
  const [showROSPanel, setShowROSPanel] = useState(false)
  const [showFusionPanel, setShowFusionPanel] = useState(true)
  const [showAbout, setShowAbout] = useState(false)
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null)

  // ROS-Gazebo simulation
  const gazebo = useGazeboSimulation({
    rosUrl: 'ws://localhost:9090',
    autoConnect: false,
  })

  // Multi-sensor fusion
  const sensors = useROSSensors({
    rosUrl: 'ws://localhost:9090',
    autoConnect: false,
    algorithm: 'ExtendedKalman',
  })

  // Handle detection results from CrebainViewer
  const onDetectionComplete = (result: {
    inferenceTimeMs: number
    preprocessTimeMs?: number
    postprocessTimeMs?: number
    detectionCount: number
  }) => {
    performanceTracker.recordSample(result)
    // Clear any previous error on successful detection
    if (detectionError) setDetectionError(null)
  }

  // Keyboard shortcuts and Menu Events
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      
      if (e.key.toLowerCase() === 'p') {
        setShowPerformancePanel(prev => !prev)
      }
      if (e.key.toLowerCase() === 'n') {
        setShowROSPanel(prev => !prev)
      }
      if (e.key.toLowerCase() === 'u') {
        setShowFusionPanel(prev => !prev)
      }
    }
    
    window.addEventListener('keydown', handleKeyDown)
    
    // Listen for the "show-about" event from the backend menu
    const unlistenPromise = listen('show-about', () => {
      setShowAbout(true)
    })
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      unlistenPromise.then(unlisten => unlisten())
    }
  }, [])

  return (
    <ErrorBoundary>
      <UIScaleProvider persist={true}>
        <div className="w-full h-full relative">
          <CrebainViewer onDetectionComplete={onDetectionComplete} />
          {showPerformancePanel && (
            <PerformancePanel
              data={performanceTracker.currentData}
              history={performanceTracker.history}
              isReady={true}
              error={detectionError}
              backend="CoreML (Metal/Neural Engine)"
            />
          )}
          {showROSPanel && (
            <ROSConnectionPanel
              connectionState={gazebo.connectionState}
              transport={gazebo.transport}
              onTransportChange={gazebo.setTransport}
              rosUrl={gazebo.rosUrl}
              onUrlChange={gazebo.setRosUrl}
              onConnect={gazebo.connect}
              onDisconnect={gazebo.disconnect}
              error={gazebo.connectionError}
              drones={gazebo.allDrones}
              activeMissions={gazebo.activeMissions}
              onInitiateIntercept={gazebo.initiateIntercept}
              onAbortMission={gazebo.abortMission}
            />
          )}
          <SensorFusionPanel
            tracks={sensors.tracks}
            stats={sensors.fusionStats}
            sensorStatus={sensors.sensorStatus}
            isExpanded={showFusionPanel}
            onToggleExpand={() => setShowFusionPanel(prev => !prev)}
            onSelectTrack={setSelectedTrackId}
            selectedTrackId={selectedTrackId}
          />
          <AboutModal isOpen={showAbout} onClose={() => setShowAbout(false)} />
        </div>
      </UIScaleProvider>
    </ErrorBoundary>
  )
}
