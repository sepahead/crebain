import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import * as THREE from 'three'
import { SplatMesh } from '@sparkjsdev/spark'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import {
  hasFiniteMultiCameraTriangulation,
  SensorFusion,
  type FusionStats,
} from '../detection/SensorFusion'
import {
  BROWSER_FUSION_BATCH_WINDOW_MS,
  BrowserFusionBatcher,
} from '../detection/BrowserFusionBatcher'
import type { Detection, FusedTrack, CameraParams } from '../detection/types'
import { drawDetectionsOnCanvas } from './detectionCanvas'
import { useDetectionLoop } from '../hooks/useDetectionLoop'
import { useDroneController } from '../hooks/useDroneController'
import { useSceneState, type CrebainCamera } from '../hooks/useSceneState'
import { useDraggable } from '../hooks/useDraggable'
import { useDraggable3D } from '../hooks/useDraggable3D'
import { useObjectSelection } from '../hooks/useObjectSelection'
import { useUIScale } from '../context/useUIScale'
import DroneSpawnPanel from './DroneSpawnPanel'
import SaveLoadPanel from './SaveLoadPanel'
import ObjectTransformControls from './ObjectTransformControls'
import { PANEL_POSITIONS } from './panelPositions'
import { createTacticalGrid, createGridLabels } from './viewer/TacticalGrid'
import DetectionPanel from './viewer/DetectionPanel'
import HeaderBar from './viewer/HeaderBar'
import {
  CameraDetailsOverlay,
  CameraFeedsOverlay,
  ViewerEventLog,
  ViewerOverlayRail,
  ViewerFooter,
  ViewerLoadingOverlay,
} from './viewer/ViewerChrome'
import { useNativeDetectorDiagnostics } from './viewer/useNativeDetectorDiagnostics'
import {
  DEFAULT_SECURITY_CONFIGURATION_STATUS,
  getSecurityConfigurationStatusLabel,
  type SecurityConfigurationStatus,
} from './viewer/securityConfigurationStatus'
import { captureCameraPixels, withCameraRenderTarget } from './viewer/cameraCapture'
import { activateFloorMesh } from './viewer/floorMeshOwnership'
import {
  detachAllSurveillanceCameras,
  disposeAllSurveillanceCamerasOnce,
  disposeSurveillanceCamera,
  removeSurveillanceCameraOnce,
  restoreDetachedSurveillanceCameras,
  updateSurveillanceCameraPtz,
} from './viewer/surveillanceCameraState'
import {
  attachObject3DToScene,
  disposeObject3D,
  forEachMesh,
  isObject3DInScene,
  objectLabel,
} from '../lib/three/sceneObjects'
import { fetchAssetWithLimit, readFileAsArrayBuffer } from '../lib/boundedFetch'
import { inspectPngJpegDimensions, validateSelfContainedGlb } from '../lib/glbValidation'
import {
  MAX_GLB_SOURCE_BYTES,
  reserveGlbSceneResources,
  reserveGlbSceneSourceBytes,
} from '../lib/glbSceneBudget'
import {
  createProceduralFloor,
  createTerrainMesh,
  type FloorStyle,
} from './viewer/ProceduralTerrain'
import {
  getBackendHealth,
  getDiagnosticsStatusLabel,
  getConnectionStatusLabel,
  normalizeSystemInfo,
  type DiagnosticsConnectionState,
  type DiagnosticsStatus,
  type SystemInfo,
} from '../lib/diagnostics'
import { runWithOperationDeadline } from '../lib/operationDeadline'
import { runSceneRestoreTransaction } from '../lib/sceneRestoreTransaction'
import { isTextInputTarget, VIEWER_SHORTCUTS } from '../lib/shortcuts'
import {
  MAX_SURVEILLANCE_CAMERA_NAME_BYTES,
  normalizeSurveillanceCameraName,
} from '../lib/surveillanceCameraLimits'
import {
  isReloadableGlbSource,
  isReloadableSceneSource,
  isReloadableSplatSource,
  type CameraState,
  type DetectionState,
  type SceneAssetState,
  type SceneState,
  type SplatSceneState,
} from '../state/SceneState'
import {
  isBoundedSceneName,
  MAX_CAMERA_RENDER_PIXELS,
  MAX_SCENE_ASSETS,
  MAX_SCENE_CAMERAS,
  MAX_SCENE_NAME_BYTES,
} from '../lib/sceneLimits'

import type {
  LoadedAsset,
  ConsoleMessage,
  CameraType,
  ThreatLevel,
  SurveillanceCamera,
  RendererWithAsync,
} from './viewer/types'
import { sceneLogger as log } from '../lib/logger'
import { isSplatFormat, isGlbFormat, generateCameraDesignation } from './viewer/types'
import { isEngramEmbeddedMode, isNativeBackendAvailable } from '../integrations/engramHost'

/**
 * Main CREBAIN visualization and local-simulation surface.
 *
 * Native ROS and Zenoh integrations are telemetry-only. Detection uses the
 * browser pipeline or registered Tauri inference IPC. This component does not
 * own a vehicle-command, plant-authority, or external artifact-exchange path.
 */

interface CrebainViewerProps {
  onDetectionComplete?: (result: {
    inferenceTimeMs: number
    preprocessTimeMs?: number
    postprocessTimeMs?: number
    detectionCount: number
  }) => void
  onVisualTrack?: (track: {
    id: string
    position: [number, number, number]
    confidence: number
    classLabel: string
    timestampMs: number
  }) => void
  performancePanelVisible?: boolean
  onPerformancePanelVisibleChange?: (visible: boolean) => void
  rosConnectionState?: DiagnosticsConnectionState
  rosTransport?: 'websocket' | 'zenoh'
  systemInfo?: SystemInfo
  diagnosticsStatus?: DiagnosticsStatus
  onRefreshSystemInfo?: () => void | Promise<void>
  onDetectionError?: (message: string) => void
}

const MAX_SPLAT_BYTES = 256 * 1024 * 1024
const MAX_FLOOR_TEXTURE_BYTES = 32 * 1024 * 1024
const MAX_FLOOR_TEXTURE_PIXELS = 16_777_216
const ASSET_DOWNLOAD_TIMEOUT_MS = 30_000
const IMAGE_DECODE_TIMEOUT_MS = 30_000
const GLB_PARSE_TIMEOUT_MS = 60_000
const SPLAT_LOAD_TIMEOUT_MS = 120_000
const SCENE_RESTORE_TIMEOUT_MS = 120_000
const MAX_CONSOLE_MESSAGES = 9
// No runtime source currently attests transport security configuration.
const SECURITY_CONFIGURATION_STATUS: SecurityConfigurationStatus =
  DEFAULT_SECURITY_CONFIGURATION_STATUS
const UNKNOWN_SYSTEM_INFO = normalizeSystemInfo(null)

function normalizeOperationError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value })
}

function notifyObserver(label: string, operation: () => void): void {
  try {
    operation()
  } catch (error) {
    log.warn(`${label} observer failed`, { error })
  }
}

export default function CrebainViewer({
  onDetectionComplete,
  onVisualTrack,
  performancePanelVisible = true,
  onPerformancePanelVisibleChange,
  rosConnectionState = 'disconnected',
  rosTransport = 'zenoh',
  systemInfo = UNKNOWN_SYSTEM_INFO,
  diagnosticsStatus,
  onRefreshSystemInfo,
  onDetectionError,
}: CrebainViewerProps) {
  const { increaseScale, decreaseScale, scalePercent, isDocked, isAtMin, isAtMax, cssVar } =
    useUIScale()
  const embeddedInEngram = useMemo(() => isEngramEmbeddedMode(), [])

  const containerRef = useRef<HTMLDivElement>(null)

  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const rendererRef = useRef<RendererWithAsync | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const gridRef = useRef<THREE.Mesh | null>(null)
  const gridLabelsRef = useRef<THREE.Group | null>(null)
  const floorMeshRef = useRef<THREE.Mesh | null>(null)
  const splatMeshRef = useRef<SplatMesh | null>(null)
  const glbLoaderRef = useRef<GLTFLoader | null>(null)
  const raycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster())
  const mouseRef = useRef<THREE.Vector2>(new THREE.Vector2())
  // Scratch vector for patrol logic to avoid GC thrashing in render loop
  const patrolScratchVec = useRef<THREE.Vector3>(new THREE.Vector3())

  const [isLoading, setIsLoading] = useState(false)
  const [loadingName, setLoadingName] = useState<string | null>(null)
  const [loadingProgress, setLoadingProgress] = useState(0) // 0-100
  const [loadingStage, setLoadingStage] = useState<'reading' | 'processing' | 'rendering'>(
    'reading'
  )
  const loadingOperationsRef = useRef<Map<symbol, string>>(new Map())
  const beginLoading = useCallback((name: string): symbol => {
    const token = Symbol(name)
    loadingOperationsRef.current.set(token, name)
    setIsLoading(true)
    setLoadingName(name)
    setLoadingProgress(0)
    setLoadingStage('reading')
    return token
  }, [])
  const isLatestLoading = useCallback((token: symbol): boolean => {
    const tokens = Array.from(loadingOperationsRef.current.keys())
    return tokens.at(-1) === token
  }, [])
  const finishLoading = useCallback((token: symbol): void => {
    if (!loadingOperationsRef.current.delete(token)) return
    const remaining = Array.from(loadingOperationsRef.current.values())
    const nextName = remaining.at(-1) ?? null
    setIsLoading(remaining.length > 0)
    setLoadingName(nextName)
    setLoadingProgress(0)
  }, [])
  const cancelLoadingOperations = useCallback((): void => {
    loadingOperationsRef.current.clear()
    setIsLoading(false)
    setLoadingName(null)
    setLoadingProgress(0)
  }, [])
  const [currentAsset, setCurrentAsset] = useState<string | null>(null)
  const currentAssetRef = useRef<string | null>(null)
  const commitCurrentAsset = useCallback((value: string | null): void => {
    currentAssetRef.current = value
    setCurrentAsset(value)
  }, [])
  const [loadedAssets, setLoadedAssets] = useState<LoadedAsset[]>([])
  const loadedAssetsRef = useRef<LoadedAsset[]>([])
  const viewerMountedRef = useRef(false)
  const floorLoadGenerationRef = useRef(0)
  const floorAbortControllerRef = useRef<AbortController | null>(null)
  const floorLoadingTokenRef = useRef<symbol | null>(null)
  const assetLoadGenerationRef = useRef(0)
  const sceneRestoreGenerationRef = useRef(0)
  const sceneRestoreInFlightRef = useRef(false)
  const splatCancellationRef = useRef<(() => void) | null>(null)
  const assetAbortControllersRef = useRef<Set<AbortController>>(new Set())
  const pendingAssetReservationsRef = useRef<Map<symbol, number>>(new Map())
  const pendingAssetResourceReservationsRef = useRef(
    new Map<symbol, ReturnType<typeof validateSelfContainedGlb>>()
  )
  const [isDragging, setIsDragging] = useState(false)
  const [consoleMessages, setConsoleMessages] = useState<ConsoleMessage[]>([])
  const consoleMessagesRef = useRef<ConsoleMessage[]>([])

  const [cameras, setCameras] = useState<SurveillanceCamera[]>([])
  const camerasRef = useRef<SurveillanceCamera[]>([])
  const [selectedCamera, setSelectedCamera] = useState<string | null>(null)
  const [cameraPlacementMode, setCameraPlacementMode] = useState<CameraType | null>(null)
  const [dronePlacementMode, setDronePlacementMode] = useState<boolean>(false)
  const dronePlacementModeRef = useRef(false)

  useEffect(() => {
    dronePlacementModeRef.current = dronePlacementMode
  }, [dronePlacementMode])

  useEffect(() => {
    loadedAssetsRef.current = loadedAssets
  }, [loadedAssets])

  useEffect(() => {
    camerasRef.current = cameras
  }, [cameras])

  const pendingDroneType = useRef<string | null>(null)
  const pendingDroneName = useRef<string | null>(null)
  const [showCameraFeeds, setShowCameraFeeds] = useState(true)
  const [activeTab, setActiveTab] = useState<'sensoren' | 'objekte' | 'system'>('sensoren')

  const [currentTime, setCurrentTime] = useState(new Date())
  const [threatLevel, setThreatLevel] = useState<ThreatLevel>(1)
  const handleThreatLevelChange = useCallback(
    (level: ThreatLevel) => {
      if (embeddedInEngram) return
      setThreatLevel(level)
    },
    [embeddedInEngram]
  )
  const [showGrid, setShowGrid] = useState(true)
  const simulatedOperatorPosition = { lat: 52.52, lon: 13.405, alt: 34 }
  const [bearing, setBearing] = useState(0)
  const [altitude, setAltitude] = useState(0)

  // Detection system state
  const [detectionEnabled, setDetectionEnabled] = useState(() => !embeddedInEngram)
  const [cameraDetections, setCameraDetections] = useState<Map<string, Detection[]>>(new Map())
  const cameraDetectionsRef = useRef<Map<string, Detection[]>>(new Map())
  const [fusedTracks, setFusedTracks] = useState<FusedTrack[]>([])
  const [fusionStats, setFusionStats] = useState<FusionStats | null>(null)
  const fusionBatcherRef = useRef(new BrowserFusionBatcher())
  const fusionBatchTimerRef = useRef<number | null>(null)
  const [fusionBatchDispatch, setFusionBatchDispatch] = useState(0)
  const fusionBatchDispatchSequenceRef = useRef(0)
  const lastFusionBatchDispatchRef = useRef(0)
  const onVisualTrackRef = useRef(onVisualTrack)
  onVisualTrackRef.current = onVisualTrack
  const [showDetectionPanel, setShowDetectionPanel] = useState(true)
  const [showDronePanel, setShowDronePanel] = useState(true)
  const [showSaveLoadPanel, setShowSaveLoadPanel] = useState(true)
  const [editingCameraId, setEditingCameraId] = useState<string | null>(null)
  const [editingCameraName, setEditingCameraName] = useState('')
  const cameraRenameCancelledRef = useRef(false)
  const [showControlPanel, setShowControlPanel] = useState(true)

  const controlPanelDrag = useDraggable({
    initialPosition: { x: 12, y: 80 },
    snapDistance: 20,
    edgePadding: 12,
    side: 'left',
  })
  const sensorFusionRef = useRef<SensorFusion | null>(null)
  const cameraCounterRef = useRef({ static: 0, ptz: 0, patrol: 0 })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const feedCanvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map())
  // Reusable buffers for camera feed rendering (avoids allocation per frame)
  const feedBuffersRef = useRef<Map<string, Uint8Array>>(new Map())
  // Reusable ImageData per camera (avoids ~1MB createImageData alloc each feed tick)
  const feedImageDataRef = useRef<Map<string, ImageData>>(new Map())
  // Timestamp (performance.now) of each camera's last render-to-target, so a
  // detection can reuse a fresh target or refresh only its selected stale target.
  const feedLastRenderAtRef = useRef<Map<string, number>>(new Map())
  // Round-robin cursor: feed render + pixel readback process ONE camera per tick
  // so per-frame GPU cost stays bounded regardless of how many cameras are placed.
  const feedRoundRobinRef = useRef(0)
  // Frame-budget governor for feeds: EMA (ms) of the heavy feed work (scene render
  // to target + synchronous pixel readback), and a tick counter. When the measured
  // cost exceeds the per-tick budget, the heavy path runs only every Nth tick
  // (N grows with cost) so feeds yield to the main render loop under load.
  const feedCostEmaRef = useRef(0)
  const feedHeavyTickRef = useRef(0)

  const moveState = useRef({
    forward: false,
    backward: false,
    left: false,
    right: false,
    up: false,
    down: false,
    sprint: false,
    precision: false,
    rotateLeft: false,
    rotateRight: false,
    lookUp: false,
    lookDown: false,
  })
  const velocity = useRef(new THREE.Vector3())
  const lastFrameTime = useRef(performance.now())
  // Splat performance mode (key 'p'): cap splats loaded to bound GPU render cost on
  // multi-million-splat scenes (render scales with count). 0 = unlimited (full quality).
  const perfMaxSplatsRef = useRef(0)
  // Last splat source/name so toggling performance mode can reload it in place.
  const lastSplatSourceRef = useRef<File | string | ArrayBuffer | null>(null)
  const lastSplatNameRef = useRef<string | undefined>(undefined)
  const persistenceWarningActiveRef = useRef(false)
  // Splat load generation: bumped per loadSplat call so callbacks of a
  // superseded load (onLoad/timeout/interval/error) can detect they are stale
  // and must not touch the scene or loading UI.
  const splatLoadGenRef = useRef(0)
  const scratchVectors = useRef({
    forward: new THREE.Vector3(),
    right: new THREE.Vector3(),
    targetVelocity: new THREE.Vector3(),
    velocityDiff: new THREE.Vector3(),
    movement: new THREE.Vector3(),
    camDir: new THREE.Vector3(),
  })

  // Configurable movement parameters
  const MOVE_CONFIG = useMemo(
    () => ({
      baseSpeed: 8.0, // meters per second
      sprintMultiplier: 3.0, // 3x speed when sprinting
      precisionMultiplier: 0.2, // 0.2x speed for precision mode
      acceleration: 25.0, // m/s² - how fast we reach target speed
      deceleration: 20.0, // m/s² - how fast we stop
      maxVelocity: 50.0, // m/s - absolute max
      rotateSpeed: 90.0, // degrees per second for keyboard look
      verticalSpeed: 6.0, // m/s for vertical movement
    }),
    []
  )

  const resetViewerMovement = useCallback(() => {
    for (const key of Object.keys(moveState.current)) {
      ;(moveState.current as Record<string, boolean>)[key] = false
    }
    velocity.current.set(0, 0, 0)
    lastFrameTime.current = performance.now()
  }, [])

  // Camera feed update interval (~12 FPS)
  const CAMERA_FEED_INTERVAL_MS = 83
  // Frame-budget governor: target max cost (ms) of one heavy feed tick, and the
  // hardest the feed may be throttled (every Nth tick). At MAX_FEED_STRIDE=6 and
  // an 83 ms interval, a worst-case feed still refreshes ~every 0.5 s.
  const FEED_FRAME_BUDGET_MS = 6
  const MAX_FEED_STRIDE = 6
  // Fresh-cache window (ms) for detection exports. Once exceeded, the one
  // camera selected by the detection scheduler is rendered on demand before
  // readback so stale pixels are never paired with current poses.
  const FEED_EXPORT_MAX_AGE_MS = 500
  // Default patrol camera speed
  const DEFAULT_PATROL_SPEED = 0.015
  // Patrol waypoint arrival threshold in meters
  const PATROL_ARRIVAL_THRESHOLD = 0.1

  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 1000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (embeddedInEngram) return
    if (!sensorFusionRef.current) {
      sensorFusionRef.current = new SensorFusion({
        correlationThreshold: 0.5,
        maxTrackAge: 3000,
        minConfirmationFrames: 3,
      })
    }
    return () => {
      sensorFusionRef.current = null
    }
  }, [embeddedInEngram])

  const resetVisualFusion = useCallback((clearTracks: boolean): void => {
    if (fusionBatchTimerRef.current !== null) {
      window.clearTimeout(fusionBatchTimerRef.current)
      fusionBatchTimerRef.current = null
    }
    fusionBatcherRef.current.reset()
    lastFusionBatchDispatchRef.current = fusionBatchDispatchSequenceRef.current
    if (clearTracks) {
      sensorFusionRef.current?.clearTracks()
      setFusedTracks([])
      setFusionStats(sensorFusionRef.current?.getStats() ?? null)
    }
  }, [])

  useEffect(() => {
    return () => resetVisualFusion(false)
  }, [resetVisualFusion])

  useEffect(() => {
    if (!detectionEnabled) resetVisualFusion(true)
  }, [detectionEnabled, resetVisualFusion])

  const messageTimeoutsRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    const messageTimeouts = messageTimeoutsRef.current
    return () => {
      messageTimeouts.forEach((id) => clearTimeout(id))
      messageTimeouts.clear()
    }
  }, [])

  const addMessage = useCallback((type: ConsoleMessage['type'], message: string) => {
    const timestamp = Date.now()
    const newMessage: ConsoleMessage = { id: crypto.randomUUID(), type, message, timestamp }
    const previous = consoleMessagesRef.current
    const next = [...previous, newMessage].slice(-MAX_CONSOLE_MESSAGES)
    const retainedIds = new Set(next.map((entry) => entry.id))
    for (const dropped of previous) {
      if (retainedIds.has(dropped.id)) continue
      const timeoutId = messageTimeoutsRef.current.get(dropped.id)
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      messageTimeoutsRef.current.delete(dropped.id)
    }
    consoleMessagesRef.current = next
    setConsoleMessages(next)

    const timeoutId = window.setTimeout(() => {
      const remaining = consoleMessagesRef.current.filter((entry) => entry.id !== newMessage.id)
      consoleMessagesRef.current = remaining
      setConsoleMessages(remaining)
      messageTimeoutsRef.current.delete(newMessage.id)
    }, 10000)
    messageTimeoutsRef.current.set(newMessage.id, timeoutId)
  }, [])

  // Native detection runs through the Tauri backend. When the app is opened in a
  // plain browser (e.g. the Vite dev server) the IPC bridge is absent and every
  // `invoke` rejects with "Failed to fetch". Detect that up front so the UI can
  // disable the native buttons and show a clear message instead.
  const nativeAvailable = useMemo(() => isNativeBackendAvailable(), [])
  const backendStatus = diagnosticsStatus ?? getBackendHealth(systemInfo)
  const nativeDetectorReady = nativeAvailable && backendStatus === 'ready'

  const {
    benchmarkProgress,
    cancelBenchmark: cancelCoreMLBenchmark,
    isBenchmarking,
    isTesting: isTestingCoreML,
    runBenchmark: runCoreMLBenchmark,
    testDetector: testCoreMLInference,
  } = useNativeDetectorDiagnostics({
    nativeAvailable,
    viewerMountedRef,
    addMessage,
    onDetectionComplete,
    onDetectionError,
    onRefreshSystemInfo,
  })

  const {
    drones: managedDrones,
    physicsReady,
    selectedDroneId,
    spawnDrone,
    removeDrone,
    selectDrone,
    setRoute,
    clearRoute,
    toggleRoute,
    renameDrone,
    physicsWorld,
    isPaused,
    togglePause,
    setSimulationPaused,
    resetSimulation,
    suspendDronesForSceneRestore,
    restoreSuspendedDrones,
    disposeSuspendedDrones,
  } = useDroneController({
    scene: sceneRef.current,
    enabled: !embeddedInEngram,
  })
  const { saveCurrentState } = useSceneState({ autosaveInterval: 0 })

  // Mirrors selectedDroneId for the window-level key handlers (registered in
  // effects that must not re-run on selection changes).
  const droneControlActiveRef = useRef(false)
  useEffect(() => {
    droneControlActiveRef.current = selectedDroneId !== null
    if (selectedDroneId !== null) resetViewerMovement()
  }, [resetViewerMovement, selectedDroneId])

  const handleSpawnRequest = useCallback(
    (typeId: string, name?: string) => {
      if (embeddedInEngram) return
      pendingDroneType.current = typeId
      pendingDroneName.current = name || null
      setDronePlacementMode(true)
      setCameraPlacementMode(null) // Cancel other modes
      addMessage('tactical', 'DROHNE PLATZIEREN: ZIEL WÄHLEN')
    },
    [addMessage, embeddedInEngram]
  )

  const handleDetection = useCallback(
    (cameraId: string, detections: Detection[]) => {
      if (embeddedInEngram) return
      const updated = new Map(cameraDetectionsRef.current)
      updated.set(cameraId, detections)
      cameraDetectionsRef.current = updated
      setCameraDetections(updated)

      // Display retention and fusion work are deliberately separate. A camera
      // result enters this one-shot batcher exactly once; later React renders may
      // continue to show it without replaying it into the tracker.
      const enqueueStatus = fusionBatcherRef.current.enqueue(cameraId, detections, Date.now())
      if (enqueueStatus !== 'accepted') {
        log.warn('Visual fusion pending queue applied its bounded input policy', {
          cameraId,
          status: enqueueStatus,
        })
      }
      if (enqueueStatus === 'rejected_invalid' || enqueueStatus === 'rejected_capacity') {
        return
      }
      if (fusionBatchTimerRef.current === null) {
        fusionBatchTimerRef.current = window.setTimeout(() => {
          fusionBatchTimerRef.current = null
          fusionBatchDispatchSequenceRef.current += 1
          setFusionBatchDispatch(fusionBatchDispatchSequenceRef.current)
        }, BROWSER_FUSION_BATCH_WINDOW_MS)
      }
    },
    [embeddedInEngram]
  )

  const handlePerformance = useCallback(
    (metrics: {
      inferenceTimeMs: number
      preprocessTimeMs: number
      postprocessTimeMs: number
      detectionCount: number
      cameraId: string
    }) => {
      if (embeddedInEngram) return
      if (onDetectionComplete) {
        notifyObserver('Detection result', () =>
          onDetectionComplete({
            inferenceTimeMs: metrics.inferenceTimeMs,
            preprocessTimeMs: metrics.preprocessTimeMs,
            postprocessTimeMs: metrics.postprocessTimeMs,
            detectionCount: metrics.detectionCount,
          })
        )
      }
    },
    [embeddedInEngram, onDetectionComplete]
  )

  useEffect(() => {
    if (embeddedInEngram) return
    const win = window as Window & { crebainDetectionHandler?: typeof handleDetection }
    win.crebainDetectionHandler = handleDetection
    return () => {
      delete win.crebainDetectionHandler
    }
  }, [embeddedInEngram, handleDetection])

  useEffect(() => {
    if (embeddedInEngram) return
    if (fusionBatchDispatch === lastFusionBatchDispatchRef.current) return
    lastFusionBatchDispatchRef.current = fusionBatchDispatch

    const batch = fusionBatcherRef.current.takeBatch()
    if (sensorFusionRef.current && batch && camerasRef.current.length > 1) {
      const cameraParams = new Map<string, CameraParams>()
      camerasRef.current.forEach((cam) => {
        cameraParams.set(cam.id, {
          id: cam.id,
          position: cam.camera.position.clone(),
          rotation: cam.camera.rotation.clone(),
          fov: cam.camera.fov,
          aspectRatio: cam.camera.aspect,
          near: cam.camera.near,
          far: cam.camera.far,
        })
      })

      const tracks = sensorFusionRef.current.processFrame(
        batch.detections,
        cameraParams,
        batch.context
      )
      setFusedTracks(tracks)
      setFusionStats(sensorFusionRef.current.getStats())
      for (const track of sensorFusionRef.current.getLastFrameObservedTracks()) {
        const position = track.triangulatedPosition
        if (hasFiniteMultiCameraTriangulation(track)) {
          notifyObserver('Visual track', () =>
            onVisualTrackRef.current?.({
              id: track.id,
              position: [position.x, position.y, position.z],
              confidence: track.fusedConfidence,
              classLabel: track.class,
              timestampMs: track.updatedAt,
            })
          )
        }
      }

      const highThreatTracks = tracks.filter((t) => t.threatLevel >= 3)
      if (highThreatTracks.length > 0) {
        setThreatLevel((current) => (current < 3 ? 3 : current))
      }
    }
  }, [embeddedInEngram, fusionBatchDispatch])

  const totalDetections = useMemo(() => {
    let count = 0
    cameraDetections.forEach((dets) => (count += dets.length))
    return count
  }, [cameraDetections])

  const highestThreat = useMemo((): Detection | null => {
    let highest: Detection | null = null
    for (const dets of cameraDetections.values()) {
      for (const det of dets) {
        if (!highest || (det.threatLevel ?? 0) > (highest.threatLevel ?? 0)) {
          highest = det
        }
      }
    }
    return highest
  }, [cameraDetections])

  const createCameraMesh = useCallback((type: CameraType): THREE.Group => {
    const group = new THREE.Group()

    const bodyGeom = new THREE.BoxGeometry(0.12, 0.08, 0.18)
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a1a,
      metalness: 0.9,
      roughness: 0.3,
    })
    const body = new THREE.Mesh(bodyGeom, bodyMat)
    group.add(body)

    const lensGeom = new THREE.CylinderGeometry(0.03, 0.04, 0.06, 16)
    const lensMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0a,
      metalness: 0.95,
      roughness: 0.05,
    })
    const lens = new THREE.Mesh(lensGeom, lensMat)
    lens.rotation.x = Math.PI / 2
    lens.position.z = 0.12
    group.add(lens)

    const glassGeom = new THREE.CircleGeometry(0.025, 16)
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x333333,
      emissive: 0x222222,
      emissiveIntensity: 0.2,
      transparent: true,
      opacity: 0.9,
    })
    const glass = new THREE.Mesh(glassGeom, glassMat)
    glass.position.z = 0.15
    group.add(glass)

    const ledGeom = new THREE.SphereGeometry(0.006, 8, 8)
    const ledMat = new THREE.MeshBasicMaterial({ color: type === 'patrol' ? 0x4a4a4a : 0x3a3a3a })
    const led = new THREE.Mesh(ledGeom, ledMat)
    led.position.set(0.05, 0.03, 0.04)
    group.add(led)

    if (type !== 'patrol') {
      const mountGeom = new THREE.CylinderGeometry(0.015, 0.015, 0.12, 8)
      const mountMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.8 })
      const mount = new THREE.Mesh(mountGeom, mountMat)
      mount.position.y = 0.1
      group.add(mount)
      const baseGeom = new THREE.CylinderGeometry(0.04, 0.04, 0.02, 16)
      const base = new THREE.Mesh(baseGeom, mountMat)
      base.position.y = 0.17
      group.add(base)
    }

    return group
  }, [])

  const placeCamera = useCallback(
    (position: THREE.Vector3, type: CameraType, restored?: CameraState) => {
      if (embeddedInEngram) return
      const scene = sceneRef.current
      if (!scene || !rendererRef.current) return

      const resolution: [number, number] = restored?.resolution ?? [640, 360]
      const existingCameras = camerasRef.current
      const allocatedPixels = existingCameras.reduce(
        (total, camera) => total + camera.renderTarget.width * camera.renderTarget.height,
        0
      )
      const requestedPixels = resolution[0] * resolution[1]
      if (
        existingCameras.length >= MAX_SCENE_CAMERAS ||
        allocatedPixels + requestedPixels > MAX_CAMERA_RENDER_PIXELS
      ) {
        addMessage('error', 'KAMERA-LIMIT ERREICHT: GPU-RENDERTARGET-BUDGET ÜBERSCHRITTEN')
        return
      }

      const nextCameraNumber = cameraCounterRef.current[type] + 1
      const designation = restored?.name ?? generateCameraDesignation(type, nextCameraNumber)

      let helper: THREE.CameraHelper | null = null
      let mesh: THREE.Group | null = null
      let renderTarget: THREE.WebGLRenderTarget | null = null
      let newCamera: SurveillanceCamera
      try {
        const restoredPan = restored?.pan ?? 0
        const restoredTilt = restored?.tilt ?? 0
        const restoredZoom = restored?.zoom ?? restored?.fov ?? 60
        const feedCamera = new THREE.PerspectiveCamera(
          type === 'ptz' ? restoredZoom : (restored?.fov ?? 60),
          resolution[0] / resolution[1],
          restored?.near ?? 0.1,
          restored?.far ?? 500
        )
        feedCamera.position.copy(position)
        if (restored) {
          if (type === 'ptz' && (restored.pan !== undefined || restored.tilt !== undefined)) {
            feedCamera.rotation.set(
              THREE.MathUtils.degToRad(-restoredTilt),
              THREE.MathUtils.degToRad(restoredPan),
              0,
              'YXZ'
            )
          } else {
            feedCamera.rotation.set(restored.rotation.x, restored.rotation.y, restored.rotation.z)
          }
        } else {
          feedCamera.lookAt(position.x, position.y - 0.5, position.z - 2)
        }

        renderTarget = new THREE.WebGLRenderTarget(resolution[0], resolution[1], {
          format: THREE.RGBAFormat,
          type: THREE.UnsignedByteType,
        })
        helper = new THREE.CameraHelper(feedCamera)
        helper.visible = false
        scene.add(helper)

        mesh = createCameraMesh(type)
        mesh.position.copy(position)
        mesh.quaternion.copy(feedCamera.quaternion)
        scene.add(mesh)

        newCamera = {
          id: restored?.id ?? crypto.randomUUID(),
          name: designation,
          type,
          camera: feedCamera,
          helper,
          mesh,
          renderTarget,
          pan: restoredPan,
          tilt: restoredTilt,
          zoom: restoredZoom,
          isActive: restored?.isActive ?? true,
          // Camera feeds are live previews; no recorder is implemented.
          isRecording: false,
          patrolPoints:
            restored?.patrolPoints?.map((point) => new THREE.Vector3(point.x, point.y, point.z)) ??
            (type === 'patrol'
              ? [position.clone(), position.clone().add(new THREE.Vector3(5, 0, 0))]
              : undefined),
          patrolIndex: 0,
          patrolSpeed: THREE.MathUtils.clamp(restored?.patrolSpeed ?? 0.015, 0, 1),
          patrolDirection: 1,
        }
      } catch (error) {
        const cleanupErrors: unknown[] = []
        const attempt = (operation: () => void) => {
          try {
            operation()
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError)
          }
        }
        if (helper) {
          const rejectedHelper = helper
          attempt(() => scene.remove(rejectedHelper))
        }
        if (mesh) {
          const rejectedMesh = mesh
          attempt(() => scene.remove(rejectedMesh))
        }
        const cameraObjectsDetached =
          (!helper || helper.parent === null) && (!mesh || mesh.parent === null)
        if (!cameraObjectsDetached) {
          cleanupErrors.push(
            new Error('Rejected camera resources remain attached to a scene graph')
          )
        } else {
          if (helper) {
            const rejectedHelper = helper
            attempt(() => rejectedHelper.dispose())
          }
          if (mesh) {
            const rejectedMesh = mesh
            attempt(() => disposeObject3D(rejectedMesh))
          }
        }
        if (renderTarget && cameraObjectsDetached) {
          const rejectedRenderTarget = renderTarget
          attempt(() => rejectedRenderTarget.dispose())
        }
        log.error('Camera placement failed before ownership transfer', {
          error,
          cleanupErrors,
        })
        addMessage('error', `KAMERA KONNTE NICHT AKTIVIERT WERDEN: ${designation}`)
        return undefined
      }

      const nextCameras = [...existingCameras, newCamera]
      camerasRef.current = nextCameras
      setCameras(nextCameras)
      cameraCounterRef.current[type] = nextCameraNumber
      addMessage('tactical', `${designation} AKTIVIERT`)
      return newCamera
    },
    [addMessage, createCameraMesh, embeddedInEngram]
  )

  const updateCameraPTZ = useCallback(
    (cameraId: string, pan?: number, tilt?: number, zoom?: number) => {
      if (embeddedInEngram) return
      updateSurveillanceCameraPtz(camerasRef, setCameras, cameraId, pan, tilt, zoom)
    },
    [embeddedInEngram]
  )

  const removeCamera = useCallback(
    (cameraId: string) => {
      if (embeddedInEngram) return
      try {
        removeSurveillanceCameraOnce(sceneRef.current, camerasRef, setCameras, cameraId, (camera) =>
          addMessage('system', `${camera.name} DEAKTIVIERT`)
        )
      } catch (error) {
        // Disposal can report a listener/GPU cleanup failure after the camera
        // has already left the graph. Reconcile the caches from the authoritative
        // registry instead of abandoning the remainder of the transition.
        log.warn('Camera removal completed with cleanup failures', { cameraId, error })
      }
      if (camerasRef.current.some((camera) => camera.id === cameraId)) return
      setSelectedCamera((current) => (current === cameraId ? null : current))
      // Free the per-camera feed state: the canvas ref callback also deletes
      // its entry on unmount, but the pixel-readback buffer and pooled
      // ImageData (~0.9 MB each at 640x360) plus the last-render timestamp
      // have no unmount hook, so clear everything here.
      feedCanvasRefs.current.delete(cameraId)
      feedBuffersRef.current.delete(cameraId)
      feedImageDataRef.current.delete(cameraId)
      feedLastRenderAtRef.current.delete(cameraId)
      fusionBatcherRef.current.removeCamera(cameraId)
      // Purge retained detections for the removed camera (the Map grows otherwise).
      const currentDetections = cameraDetectionsRef.current
      if (currentDetections.has(cameraId)) {
        const next = new Map(currentDetections)
        next.delete(cameraId)
        cameraDetectionsRef.current = next
        setCameraDetections(next)
      }
    },
    [addMessage, embeddedInEngram]
  )

  const clearAllCameras = useCallback(() => {
    if (embeddedInEngram) return
    try {
      disposeAllSurveillanceCamerasOnce(sceneRef.current, camerasRef, setCameras)
    } catch (error) {
      log.warn('Bulk camera removal completed with cleanup failures', { error })
    }
    const retainedIds = new Set(camerasRef.current.map((camera) => camera.id))
    resetVisualFusion(true)
    setSelectedCamera((current) => (current && retainedIds.has(current) ? current : null))
    for (const cameraId of feedCanvasRefs.current.keys()) {
      if (!retainedIds.has(cameraId)) feedCanvasRefs.current.delete(cameraId)
    }
    for (const cameraId of feedBuffersRef.current.keys()) {
      if (!retainedIds.has(cameraId)) feedBuffersRef.current.delete(cameraId)
    }
    for (const cameraId of feedImageDataRef.current.keys()) {
      if (!retainedIds.has(cameraId)) feedImageDataRef.current.delete(cameraId)
    }
    for (const cameraId of feedLastRenderAtRef.current.keys()) {
      if (!retainedIds.has(cameraId)) feedLastRenderAtRef.current.delete(cameraId)
    }
    cameraDetectionsRef.current = new Map()
    setCameraDetections(new Map())
  }, [embeddedInEngram, resetVisualFusion])

  const renameCamera = useCallback(
    (cameraId: string, newName: string): boolean => {
      if (embeddedInEngram) return false
      const normalizedName = normalizeSurveillanceCameraName(newName)
      if (!normalizedName) {
        addMessage(
          'warning',
          `KAMERANAME MUSS 1–${MAX_SURVEILLANCE_CAMERA_NAME_BYTES} UTF-8-BYTES ENTHALTEN`
        )
        return false
      }
      const current = camerasRef.current
      if (!current.some((camera) => camera.id === cameraId)) return false
      const next = current.map((camera) =>
        camera.id === cameraId ? { ...camera, name: normalizedName } : camera
      )
      camerasRef.current = next
      setCameras(next)
      return true
    },
    [addMessage, embeddedInEngram]
  )

  const beginCameraRename = useCallback((camera: SurveillanceCamera): void => {
    cameraRenameCancelledRef.current = false
    setEditingCameraId(camera.id)
    setEditingCameraName(camera.name)
  }, [])

  // GPU pixel readback is synchronous; the Promise contract is kept for API
  // stability and to match async camera-capture backends. Reuses the pooled
  // per-camera buffer/ImageData (shared with updateFeeds) instead of
  // allocating ~1.8 MB per call at the 100 ms detection tick.
  const exportCameraFeed = useCallback(
    (cameraId: string, maxAgeMs: number = FEED_EXPORT_MAX_AGE_MS): Promise<ImageData | null> => {
      const cam = cameras.find((c) => c.id === cameraId)
      const renderer = rendererRef.current
      const scene = sceneRef.current
      if (!cam || !renderer || !scene) return Promise.resolve(null)
      const renderedAt = feedLastRenderAtRef.current.get(cameraId)
      const width = cam.renderTarget.width
      const height = cam.renderTarget.height
      const bufferSize = width * height * 4
      let buffer = feedBuffersRef.current.get(cameraId)
      if (!buffer || buffer.length !== bufferSize) {
        buffer = new Uint8Array(bufferSize)
        feedBuffersRef.current.set(cameraId, buffer)
      }
      const capture = captureCameraPixels({
        renderer,
        scene,
        camera: cam.camera,
        renderTarget: cam.renderTarget,
        buffer,
        renderedAt,
        maxAgeMs,
      })
      if (capture.refreshed) {
        feedLastRenderAtRef.current.set(cameraId, capture.renderedAt)
      }
      let imageData = feedImageDataRef.current.get(cameraId)
      if (!imageData || imageData.width !== width || imageData.height !== height) {
        imageData = new ImageData(width, height)
        feedImageDataRef.current.set(cameraId, imageData)
      }
      // Row-wise vertical flip (GPU readback is bottom-up).
      const data = imageData.data
      for (let y = 0; y < height; y++) {
        const srcRowStart = (height - 1 - y) * width * 4
        data.set(buffer.subarray(srcRowStart, srcRowStart + width * 4), y * width * 4)
      }
      return Promise.resolve(imageData)
    },
    [cameras]
  )

  const downloadCameraFeed = useCallback(
    async (cameraId: string) => {
      if (embeddedInEngram) {
        addMessage('warning', 'ARTEFAKTEXPORT IM ENGRAM-MODUS DEAKTIVIERT')
        return
      }
      // User-initiated export: accept any rendered frame, however stale.
      const imageData = await exportCameraFeed(cameraId, Infinity)
      if (!imageData) return
      const canvas = document.createElement('canvas')
      canvas.width = imageData.width
      canvas.height = imageData.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.putImageData(imageData, 0, 0)
      const cam = cameras.find((c) => c.id === cameraId)
      const link = document.createElement('a')
      link.download = `${cam?.name}_${Date.now()}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
      addMessage('success', `EXPORT: ${cam?.name}`)
    },
    [addMessage, cameras, embeddedInEngram, exportCameraFeed]
  )

  const detectionCameras = useMemo(
    () =>
      cameras.map((camera) => ({
        id: camera.id,
        name: camera.name,
        isActive: camera.isActive,
        instanceId: camera.camera.uuid,
      })),
    [cameras]
  )

  useDetectionLoop({
    cameras: detectionCameras,
    exportCameraFeed,
    enabled:
      !embeddedInEngram &&
      nativeDetectorReady &&
      detectionEnabled &&
      !isTestingCoreML &&
      !isBenchmarking &&
      cameras.length > 0,
    intervalMs: 100,
    confidenceThreshold: 0.25,
    onDetection: handleDetection,
    onPerformance: handlePerformance,
    onError: (error, cameraId) => {
      addMessage('error', `DETEKTION${cameraId ? ` [${cameraId}]` : ''}: ${error}`)
      notifyObserver('Detection error', () => onDetectionError?.(error))
    },
  })

  const selectableObjects = useMemo(() => {
    const objects: THREE.Object3D[] = []
    cameras.forEach((cam) => {
      if (cam.mesh) objects.push(cam.mesh)
    })
    managedDrones.forEach((drone) => {
      if (drone.mesh) objects.push(drone.mesh)
    })
    loadedAssets.forEach((asset) => {
      if (asset.object) objects.push(asset.object)
    })
    return objects
  }, [cameras, managedDrones, loadedAssets])

  const handleDeleteSelectedObject = useCallback(
    (object: THREE.Object3D) => {
      if (embeddedInEngram) return
      const camera = cameras.find((c) => c.mesh === object)
      if (camera) {
        removeCamera(camera.id)
        return
      }

      const drone = managedDrones.find((d) => d.mesh === object)
      if (drone) {
        if (removeDrone(drone.id)) {
          addMessage('system', `${drone.name} ENTFERNT`)
        } else {
          addMessage('warning', `${drone.name} BLEIBT WEGEN EINES BEREINIGUNGSFEHLERS AKTIV`)
        }
        return
      }

      const asset = loadedAssets.find((a) => a.object === object)
      if (asset && sceneRef.current) {
        const scene = sceneRef.current
        let removalError: unknown
        try {
          scene.remove(asset.object)
        } catch (error) {
          removalError = error
        }
        if (asset.object.parent !== null) {
          log.warn('Loaded asset remains attached after removal failed', {
            id: asset.id,
            error: removalError,
          })
          addMessage('error', `ENTFERNEN FEHLGESCHLAGEN: ${asset.name}`)
          return
        }

        // Detachment is the ownership transfer point. Retire the registry
        // before disposal so a disposal failure cannot resurrect a dead asset.
        const nextAssets = loadedAssetsRef.current.filter((entry) => entry.id !== asset.id)
        loadedAssetsRef.current = nextAssets
        setLoadedAssets(nextAssets)
        if (removalError !== undefined) {
          log.warn('Loaded asset removal threw after detaching the object', {
            id: asset.id,
            error: removalError,
          })
        }
        try {
          disposeObject3D(asset.object)
        } catch (error) {
          log.warn('Loaded asset disposal failed after detachment', { id: asset.id, error })
        }
        addMessage('system', `ENTFERNT: ${asset.name}`)
      }
    },
    [addMessage, cameras, embeddedInEngram, loadedAssets, managedDrones, removeCamera, removeDrone]
  )

  const { selectedObjects, primarySelection, select, clearSelection } = useObjectSelection({
    containerRef,
    cameraRef,
    sceneRef,
    selectableObjects,
    multiSelect: false,
    showSelectionRing: true,
    ringColor: 0x4a8b5a,
    onSelectionChange: (selected) => {
      if (selected.length > 0) {
        const obj = selected[0]
        addMessage('tactical', `AUSGEWÄHLT: ${objectLabel(obj)}`)
      }
    },
    onDelete: handleDeleteSelectedObject,
    enabled: !embeddedInEngram && !cameraPlacementMode,
  })

  const { isDragging: isDragging3D } = useDraggable3D({
    containerRef,
    cameraRef,
    sceneRef,
    controlsRef,
    draggableObjects: selectableObjects,
    floorY: 0,
    snapThreshold: 0.3,
    enableFloorSnap: true,
    onDragStart: (obj) => {
      addMessage('info', `BEWEGEN: ${objectLabel(obj)}`)
    },
    onDragEnd: (obj, position) => {
      const name = objectLabel(obj)
      addMessage(
        'success',
        `POSITION: ${name} -> ${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`
      )

      const cam = cameras.find((c) => c.mesh === obj)
      if (cam) {
        cam.camera.position.copy(position)
      }

      const drone = managedDrones.find((d) => d.mesh === obj)
      if (drone && physicsWorld) {
        drone.physicsBody.state.position.copy(position)
        drone.physicsBody.state.velocity.set(0, 0, 0)

        if (drone.physicsBody.rigidBody) {
          drone.physicsBody.rigidBody.setTranslation(position, true)
          drone.physicsBody.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
        }
      }
    },
    enabled: !embeddedInEngram && !cameraPlacementMode && selectedObjects.length > 0,
  })

  const handleTransformChange = useCallback(
    (object: THREE.Object3D) => {
      if (embeddedInEngram) return
      const cam = cameras.find((c) => c.mesh === object)
      if (cam) {
        cam.camera.position.copy(object.position)
        cam.camera.quaternion.copy(object.quaternion)
      }

      const drone = managedDrones.find((d) => d.mesh === object)
      if (drone && physicsWorld) {
        drone.physicsBody.state.position.copy(object.position)
        drone.physicsBody.state.orientation.copy(object.quaternion)

        if (drone.physicsBody.rigidBody) {
          drone.physicsBody.rigidBody.setTranslation(object.position, true)
          drone.physicsBody.rigidBody.setRotation(object.quaternion, true)
          drone.physicsBody.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
          drone.physicsBody.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true)
        }
      }
    },
    [cameras, embeddedInEngram, managedDrones, physicsWorld]
  )

  const loadSplat = useCallback(
    async (
      source: File | string | ArrayBuffer,
      name?: string,
      restoredTransform?: SplatSceneState
    ): Promise<boolean> => {
      if (embeddedInEngram) {
        addMessage('warning', 'ARTEFAKTIMPORT IM ENGRAM-MODUS DEAKTIVIERT')
        return false
      }
      if (!sceneRef.current) return false
      if (typeof source === 'string' && !isReloadableSplatSource(source)) {
        addMessage('error', 'FEHLER: SPLAT-URL ODER -FORMAT NICHT ERLAUBT')
        return false
      }
      splatCancellationRef.current?.()
      // Bump the load generation: any callback belonging to an older, still
      // in-flight load becomes stale and must not touch the scene or UI.
      const generation = ++splatLoadGenRef.current
      const scene = sceneRef.current
      const isStale = () =>
        !viewerMountedRef.current ||
        sceneRef.current !== scene ||
        splatLoadGenRef.current !== generation
      const displayName = name || (source instanceof File ? source.name : 'OBJEKT')
      if (!isBoundedSceneName(displayName)) {
        addMessage('error', 'FEHLER: ASSETNAME IST LEER ODER ZU LANG')
        return false
      }
      const loadingToken = beginLoading(displayName)

      let loadTimeout: ReturnType<typeof setTimeout> | undefined
      let progressInterval: ReturnType<typeof setInterval> | undefined
      const acquisitionController = new AbortController()
      let cancelRenderer: (() => void) | null = null
      const cancelCurrentLoad = () => {
        if (!acquisitionController.signal.aborted) {
          acquisitionController.abort(new DOMException('Splat load superseded', 'AbortError'))
        }
        cancelRenderer?.()
      }
      // Install cancellation before URL or File acquisition starts. A newer
      // load, restore, or unmount can now stop the full byte-read phase too.
      splatCancellationRef.current = cancelCurrentLoad
      assetAbortControllersRef.current.add(acquisitionController)

      try {
        let fileBytes: ArrayBuffer

        if (typeof source === 'string') {
          const downloadTimeout = setTimeout(
            () => acquisitionController.abort(new Error('Asset download timed out')),
            ASSET_DOWNLOAD_TIMEOUT_MS
          )
          try {
            fileBytes = await fetchAssetWithLimit(
              source,
              MAX_SPLAT_BYTES,
              acquisitionController.signal,
              (received, total) => {
                if (!isStale() && isLatestLoading(loadingToken)) {
                  setLoadingProgress(total ? Math.round((received / total) * 50) : 25)
                }
              }
            )
          } finally {
            clearTimeout(downloadTimeout)
          }
        } else if (source instanceof File) {
          if (source.size > MAX_SPLAT_BYTES) {
            throw new Error(`Asset exceeds maximum size of ${MAX_SPLAT_BYTES} bytes`)
          }
          fileBytes = await readFileAsArrayBuffer(
            source,
            acquisitionController.signal,
            (received, total) => {
              if (!isStale() && isLatestLoading(loadingToken)) {
                setLoadingProgress(Math.round((received / total) * 50))
              }
            }
          )
        } else {
          if (source.byteLength > MAX_SPLAT_BYTES) {
            throw new Error(`Asset exceeds maximum size of ${MAX_SPLAT_BYTES} bytes`)
          }
          fileBytes = source
          if (isLatestLoading(loadingToken)) setLoadingProgress(50)
        }

        if (isStale()) return false

        if (isLatestLoading(loadingToken)) setLoadingStage('processing')
        const fileSizeMB = (fileBytes.byteLength / 1024 / 1024).toFixed(1)
        addMessage('system', `VERARBEITE: ${fileSizeMB} MB`)

        await new Promise((resolve) => setTimeout(resolve, 16))
        if (isStale()) return false

        let loadSettled = false
        let resolveCompletion: (success: boolean) => void = () => undefined
        const completion = new Promise<boolean>((resolve) => {
          resolveCompletion = resolve
        })
        const finish = (success: boolean) => {
          if (loadSettled) return
          loadSettled = true
          if (splatCancellationRef.current === cancelCurrentLoad) {
            splatCancellationRef.current = null
          }
          resolveCompletion(success)
        }

        progressInterval = setInterval(() => {
          if (isStale() || !isLatestLoading(loadingToken)) return
          const increment = Math.random() * 5
          setLoadingProgress((prev) => {
            if (prev >= 95) return prev
            return prev + increment
          })
        }, 200)

        if (isLatestLoading(loadingToken)) setLoadingStage('rendering')

        // Spark needs a filename (or explicit fileType) to identify the splat
        // format when loading from raw bytes — headerless formats like the
        // antimatter15 `.splat` have no magic bytes to sniff, so without this
        // it throws "Unknown splat file type: undefined".
        const splatFileName =
          source instanceof File
            ? source.name
            : typeof source === 'string'
              ? source.split('?')[0].split('/').pop() || displayName
              : displayName

        let newSplat: SplatMesh | null = null
        let loadCallbackPending = false
        const releaseCandidateSplat = () => {
          const candidate = newSplat
          if (!candidate) return
          // Ownership has transferred to the live scene registry. A duplicate
          // or late renderer callback must not tear down the committed splat.
          if (splatMeshRef.current === candidate) return
          let removalError: unknown
          try {
            scene.remove(candidate)
          } catch (error) {
            removalError = error
          }
          if (candidate.parent !== null) {
            log.warn('Candidate splat remains attached after removal failed; keeping it live', {
              error: removalError,
            })
            return
          }
          if (removalError !== undefined) {
            log.warn('Candidate splat removal threw after detaching the object', {
              error: removalError,
            })
          }
          try {
            candidate.dispose?.()
          } catch (error) {
            log.warn('Failed to dispose candidate splat scene', { error })
          }
        }
        const handleSplatLoad = () => {
          const candidate = newSplat
          if (!candidate) {
            // A renderer is permitted to report an already-resident asset
            // from its constructor. Defer that callback until the candidate
            // reference has transferred out of the constructor assignment.
            loadCallbackPending = true
            return
          }
          if (loadSettled) {
            // Spark cannot cancel its byte-to-splat worker. A candidate can
            // finish after our timeout or cancellation, so dispose it again
            // after initialization releases the newly created GPU resources.
            releaseCandidateSplat()
            return
          }
          clearTimeout(loadTimeout)
          clearInterval(progressInterval)
          if (isStale()) {
            releaseCandidateSplat()
            finish(false)
            return
          }
          if (isLatestLoading(loadingToken)) setLoadingProgress(100)

          // Splats are captured in arbitrary world coords, so at the origin they
          // often land off-center or underground and out of frame. Recenter on
          // the origin, sit the scene on the ground plane, and frame the camera
          // so it starts well-posed (no manual reset/focus needed).
          try {
            if (restoredTransform) {
              candidate.position.set(
                restoredTransform.position.x,
                restoredTransform.position.y,
                restoredTransform.position.z
              )
              candidate.rotation.set(
                restoredTransform.rotation.x,
                restoredTransform.rotation.y,
                restoredTransform.rotation.z
              )
              candidate.scale.set(
                restoredTransform.scale.x,
                restoredTransform.scale.y,
                restoredTransform.scale.z
              )
              candidate.updateMatrixWorld(true)
            } else {
              candidate.updateMatrixWorld(true)
              const lb = candidate.getBoundingBox(true)
              if (lb && Number.isFinite(lb.min.x) && !lb.isEmpty()) {
                const wb = lb.clone().applyMatrix4(candidate.matrixWorld)
                const center = wb.getCenter(new THREE.Vector3())
                const size = wb.getSize(new THREE.Vector3())
                candidate.position.x -= center.x
                candidate.position.z -= center.z
                candidate.position.y -= wb.min.y // rest on the grid
                const dist = Math.max(size.x, size.y, size.z, 1) * 1.4
                if (cameraRef.current && controlsRef.current) {
                  cameraRef.current.position.set(dist, size.y * 0.5 + dist * 0.5, dist)
                  controlsRef.current.target.set(0, size.y * 0.5, 0)
                  velocity.current.set(0, 0, 0)
                  controlsRef.current.update()
                }
              }
            }
          } catch {
            /* framing is best-effort; never block the load */
          }

          // Commit only after the candidate has initialized. The previous
          // splat remains visible and recoverable through acquisition,
          // parsing, timeout, and format errors.
          const replacedSplat = splatMeshRef.current
          try {
            const attachment = attachObject3DToScene(scene, candidate, 'splat scene')
            if (!attachment.attached) {
              throw new AggregateError(attachment.errors, 'The splat scene did not attach', {
                cause: attachment.errors[0],
              })
            }
            if (attachment.errors.length > 0) {
              log.warn('Splat scene attached with scene-event failures', {
                count: attachment.errors.length,
                firstError: attachment.errors[0],
              })
            }
            if (replacedSplat && replacedSplat !== candidate) {
              let removalError: unknown
              try {
                scene.remove(replacedSplat)
              } catch (error) {
                removalError = error
              }
              if (replacedSplat.parent !== null) {
                throw new AggregateError(
                  removalError === undefined ? [] : [removalError],
                  'The previous splat scene remains attached and cannot be disposed safely'
                )
              }
              if (removalError !== undefined) {
                log.warn('Replaced splat removal threw after detaching the object', {
                  error: removalError,
                })
              }
            }
            splatMeshRef.current = candidate
            lastSplatSourceRef.current = source
            lastSplatNameRef.current = name
          } catch (error) {
            releaseCandidateSplat()
            if (!isStale()) {
              addMessage(
                'error',
                `FEHLER: ${error instanceof Error ? error.message : 'Splat konnte nicht aktiviert werden'}`
              )
            }
            finish(false)
            return
          }
          if (replacedSplat && replacedSplat !== candidate) {
            try {
              replacedSplat.dispose?.()
            } catch (error) {
              log.warn('Failed to dispose replaced splat scene', { error })
            }
          }

          commitCurrentAsset(displayName)
          addMessage('success', `GELADEN: ${displayName}`)
          finish(true)
        }
        newSplat = new SplatMesh({
          fileBytes,
          fileName: splatFileName,
          ...(perfMaxSplatsRef.current > 0 ? { maxSplats: perfMaxSplatsRef.current } : {}),
          onLoad: handleSplatLoad,
        })
        cancelRenderer = () => {
          if (loadSettled) return
          clearTimeout(loadTimeout)
          clearInterval(progressInterval)
          releaseCandidateSplat()
          finish(false)
        }
        if (!loadSettled) {
          loadTimeout = setTimeout(() => {
            if (loadSettled) return
            cancelCurrentLoad()
            if (!isStale()) addMessage('error', `ZEITÜBERSCHREITUNG: ${displayName}`)
          }, SPLAT_LOAD_TIMEOUT_MS)
        }
        newSplat.position.set(0, 0, 0)
        if (restoredTransform) {
          newSplat.position.set(
            restoredTransform.position.x,
            restoredTransform.position.y,
            restoredTransform.position.z
          )
          newSplat.rotation.set(
            restoredTransform.rotation.x,
            restoredTransform.rotation.y,
            restoredTransform.rotation.z
          )
          newSplat.scale.set(
            restoredTransform.scale.x,
            restoredTransform.scale.y,
            restoredTransform.scale.z
          )
        } else {
          newSplat.rotation.set(Math.PI, 0, 0)
        }
        // A renderer can invoke onLoad from its constructor for resident data.
        // Apply the requested transform before replaying that deferred callback
        // so bounding and camera framing observe the same pose as async loads.
        if (loadCallbackPending) handleSplatLoad()
        // Spark has no onError option; `initialized` rejects on load failure
        // (e.g. unknown splat format), so clean up and surface it from there.
        newSplat.initialized.catch((error: unknown) => {
          if (loadSettled) {
            releaseCandidateSplat()
            return
          }
          clearTimeout(loadTimeout)
          clearInterval(progressInterval)
          releaseCandidateSplat()
          if (!isStale()) {
            addMessage('error', `FEHLER: ${error instanceof Error ? error.message : 'Unbekannt'}`)
          }
          finish(false)
        })
        return await completion
      } catch (error) {
        clearTimeout(loadTimeout)
        clearInterval(progressInterval)
        if (!isStale()) {
          addMessage('error', `FEHLER: ${error instanceof Error ? error.message : 'Unbekannt'}`)
        }
        return false
      } finally {
        assetAbortControllersRef.current.delete(acquisitionController)
        if (splatCancellationRef.current === cancelCurrentLoad) {
          splatCancellationRef.current = null
        }
        finishLoading(loadingToken)
      }
    },
    [addMessage, beginLoading, commitCurrentAsset, embeddedInEngram, finishLoading, isLatestLoading]
  )

  const loadGlb = useCallback(
    async (
      source: File | string,
      name?: string,
      restored?: SceneAssetState
    ): Promise<LoadedAsset | null> => {
      if (embeddedInEngram) {
        addMessage('warning', 'ARTEFAKTIMPORT IM ENGRAM-MODUS DEAKTIVIERT')
        return null
      }
      if (!sceneRef.current || !glbLoaderRef.current) return null
      const displayName = name || (source instanceof File ? source.name : 'MODELL')
      if (!isBoundedSceneName(displayName)) {
        addMessage('error', 'FEHLER: ASSETNAME IST LEER ODER ZU LANG')
        return null
      }
      const reservation = Symbol(displayName)
      const pendingReservations = pendingAssetReservationsRef.current
      const pendingResourceReservations = pendingAssetResourceReservationsRef.current
      if (loadedAssetsRef.current.length + pendingReservations.size >= MAX_SCENE_ASSETS) {
        addMessage('error', `FEHLER: MAXIMAL ${MAX_SCENE_ASSETS} GLB-ASSETS PRO SZENE`)
        return null
      }
      pendingReservations.set(reservation, 0)
      const loadingToken = beginLoading(displayName)
      const reserveBytes = (byteLength: number) => {
        reserveGlbSceneSourceBytes(
          loadedAssetsRef.current.map((asset) => asset.byteSize ?? 0),
          pendingReservations,
          reservation,
          byteLength
        )
      }
      const scene = sceneRef.current
      const loader = glbLoaderRef.current
      const generation = assetLoadGenerationRef.current
      const isStale = () =>
        !viewerMountedRef.current ||
        sceneRef.current !== scene ||
        assetLoadGenerationRef.current !== generation
      let candidateModel: THREE.Object3D | null = null
      const releaseCandidateModel = () => {
        const model = candidateModel
        if (!model) return
        let removalError: unknown
        try {
          scene.remove(model)
        } catch (error) {
          removalError = error
        }
        if (model.parent !== null) {
          log.warn('Rejected GLB model remains attached after removal failed; keeping it live', {
            error: removalError,
          })
          return
        }
        candidateModel = null
        if (removalError !== undefined) {
          log.warn('Rejected GLB removal threw after detaching the object', {
            error: removalError,
          })
        }
        try {
          disposeObject3D(model)
        } catch (error) {
          log.warn('Failed to dispose rejected GLB model', { error })
        }
      }

      try {
        if (typeof source === 'string' && !isReloadableGlbSource(source)) {
          throw new Error('GLB URL or format is not allowed')
        }
        const sourcePath = source instanceof File ? source.name : source.split(/[?#]/, 1)[0]
        if (!sourcePath.toLowerCase().endsWith('.glb')) {
          throw new Error('Only self-contained .glb imports are supported')
        }

        let bytes: ArrayBuffer
        if (source instanceof File) {
          if (source.size > MAX_GLB_SOURCE_BYTES) {
            throw new Error(`Asset exceeds maximum size of ${MAX_GLB_SOURCE_BYTES} bytes`)
          }
          reserveBytes(source.size)
          bytes = await source.arrayBuffer()
        } else {
          // Reserve the full per-source ceiling before acquisition. Waiting
          // until fetch completion would allow many large ArrayBuffers to be
          // materialized concurrently before the aggregate check runs.
          reserveBytes(MAX_GLB_SOURCE_BYTES)
          const controller = new AbortController()
          assetAbortControllersRef.current.add(controller)
          const timeout = setTimeout(
            () => controller.abort(new Error('Asset download timed out')),
            ASSET_DOWNLOAD_TIMEOUT_MS
          )
          try {
            bytes = await fetchAssetWithLimit(source, MAX_GLB_SOURCE_BYTES, controller.signal)
          } finally {
            clearTimeout(timeout)
            assetAbortControllersRef.current.delete(controller)
          }
        }
        if (isStale()) return null

        if (!(source instanceof File)) reserveBytes(bytes.byteLength)
        const glbValidation = validateSelfContainedGlb(bytes)
        reserveGlbSceneResources(
          loadedAssetsRef.current.flatMap((asset) =>
            asset.glbValidation ? [asset.glbValidation] : []
          ),
          pendingResourceReservations,
          reservation,
          glbValidation
        )

        const gltf = await new Promise<GLTF>((resolve, reject) => {
          let settled = false
          let acceptedScene: THREE.Object3D | null = null
          const timeout = setTimeout(() => {
            settled = true
            reject(new Error(`GLB parsing exceeded ${GLB_PARSE_TIMEOUT_MS} milliseconds`))
          }, GLB_PARSE_TIMEOUT_MS)
          try {
            loader.parse(
              bytes,
              '',
              (parsed) => {
                if (settled) {
                  // A broken loader can invoke the success callback twice with
                  // the same graph. Never dispose the graph already transferred
                  // to the first completion; reclaim only a distinct late graph.
                  if (parsed.scene !== acceptedScene) {
                    try {
                      disposeObject3D(parsed.scene)
                    } catch (error) {
                      log.warn('Failed to dispose a GLB model that completed after its deadline', {
                        error,
                      })
                    }
                  }
                  return
                }
                settled = true
                acceptedScene = parsed.scene
                clearTimeout(timeout)
                resolve(parsed)
              },
              (error) => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                reject(normalizeOperationError(error, 'GLB parser returned a non-Error failure'))
              }
            )
          } catch (error) {
            settled = true
            clearTimeout(timeout)
            reject(normalizeOperationError(error, 'GLB parser threw a non-Error failure'))
          }
        })
        const model = gltf.scene
        candidateModel = model
        if (isStale()) {
          releaseCandidateModel()
          return null
        }
        model.name = displayName
        const assetId = restored?.id ?? crypto.randomUUID()
        model.userData.assetId = assetId
        forEachMesh(model, (mesh) => {
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          materials.forEach((mat) => {
            if (mat instanceof THREE.MeshStandardMaterial) {
              mat.needsUpdate = true
              if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace
            }
          })
        })
        const camera = cameraRef.current
        if (restored) {
          model.position.set(restored.position.x, restored.position.y, restored.position.z)
          model.rotation.set(restored.rotation.x, restored.rotation.y, restored.rotation.z)
          model.scale.set(restored.scale.x, restored.scale.y, restored.scale.z)
        } else if (camera) {
          const dir = new THREE.Vector3()
          camera.getWorldDirection(dir)
          model.position.copy(camera.position).add(dir.multiplyScalar(3))
          model.position.y = 0
        }
        const asset: LoadedAsset = {
          id: assetId,
          name: displayName,
          type: 'glb',
          object: model,
          source: typeof source === 'string' ? source : undefined,
          byteSize: bytes.byteLength,
          glbValidation,
        }
        const attachment = attachObject3DToScene(scene, model, `GLB asset ${assetId}`)
        if (!attachment.attached) {
          throw new AggregateError(attachment.errors, `Cannot activate GLB asset ${assetId}`, {
            cause: attachment.errors[0],
          })
        }
        if (attachment.errors.length > 0) {
          log.warn('GLB asset attached with scene-event failures', {
            id: assetId,
            count: attachment.errors.length,
            firstError: attachment.errors[0],
          })
        }
        const nextAssets = [...loadedAssetsRef.current, asset]
        loadedAssetsRef.current = nextAssets
        // The live asset registry now owns the scene object. The rejection
        // cleanup path must not release it after this transfer point.
        candidateModel = null
        setLoadedAssets(nextAssets)
        addMessage('success', `GELADEN: ${displayName}`)
        return asset
      } catch (error) {
        releaseCandidateModel()
        if (!isStale()) {
          addMessage('error', `FEHLER: ${error instanceof Error ? error.message : 'Unbekannt'}`)
        }
        return null
      } finally {
        pendingReservations.delete(reservation)
        pendingResourceReservations.delete(reservation)
        finishLoading(loadingToken)
      }
    },
    [addMessage, beginLoading, embeddedInEngram, finishLoading]
  )

  const loadFloorTexture = useCallback(
    async (source: File | string, name?: string): Promise<void> => {
      if (embeddedInEngram) {
        addMessage('warning', 'ARTEFAKTIMPORT IM ENGRAM-MODUS DEAKTIVIERT')
        return
      }
      if (!sceneRef.current) return
      const displayName = name || (source instanceof File ? source.name : 'BODEN')
      if (!isBoundedSceneName(displayName)) {
        addMessage('error', 'FEHLER: TEXTURNAME IST LEER ODER ZU LANG')
        return
      }
      const loadingToken = beginLoading(displayName)
      floorLoadingTokenRef.current = loadingToken

      const generation = ++floorLoadGenerationRef.current
      const scene = sceneRef.current
      floorAbortControllerRef.current?.abort(new Error('Superseded floor texture load'))
      const isStale = () =>
        !viewerMountedRef.current ||
        sceneRef.current !== scene ||
        floorLoadGenerationRef.current !== generation

      try {
        let bytes: ArrayBuffer
        if (source instanceof File) {
          if (source.size > MAX_FLOOR_TEXTURE_BYTES) {
            throw new Error(`Texture exceeds ${MAX_FLOOR_TEXTURE_BYTES} bytes`)
          }
          bytes = await source.arrayBuffer()
        } else {
          if (!isReloadableSceneSource(source)) throw new Error('Texture URL is not allowed')
          const controller = new AbortController()
          floorAbortControllerRef.current = controller
          assetAbortControllersRef.current.add(controller)
          const timeout = setTimeout(
            () => controller.abort(new Error('Texture download timed out')),
            ASSET_DOWNLOAD_TIMEOUT_MS
          )
          try {
            bytes = await fetchAssetWithLimit(source, MAX_FLOOR_TEXTURE_BYTES, controller.signal)
          } finally {
            clearTimeout(timeout)
            assetAbortControllersRef.current.delete(controller)
            if (floorAbortControllerRef.current === controller)
              floorAbortControllerRef.current = null
          }
        }
        if (isStale()) return
        const [width, height] = inspectPngJpegDimensions(new Uint8Array(bytes))
        const pixels = width * height
        if (
          width < 1 ||
          height < 1 ||
          width > 8192 ||
          height > 8192 ||
          !Number.isSafeInteger(pixels) ||
          pixels > MAX_FLOOR_TEXTURE_PIXELS
        ) {
          throw new Error(`Texture dimensions exceed ${MAX_FLOOR_TEXTURE_PIXELS} pixels`)
        }
        const bitmap = await runWithOperationDeadline(
          async (guard) => {
            const decoded = await createImageBitmap(new Blob([bytes]))
            if (!guard.isActive()) {
              try {
                decoded.close()
              } finally {
                guard.assertActive()
              }
            }
            return decoded
          },
          {
            timeoutMs: IMAGE_DECODE_TIMEOUT_MS,
            timeoutMessage: `Texture decoding exceeded ${IMAGE_DECODE_TIMEOUT_MS} milliseconds`,
            supersededMessage: 'Texture decoding was superseded',
            isCurrent: () => !isStale(),
            onTimeout: () => undefined,
          }
        )
        if (isStale()) {
          bitmap.close()
          return
        }
        let texture: THREE.Texture | null = null
        let geometry: THREE.PlaneGeometry | null = null
        let material: THREE.MeshStandardMaterial | null = null
        let candidate: THREE.Mesh | null = null
        try {
          texture = new THREE.Texture(bitmap)
          texture.needsUpdate = true
          texture.colorSpace = THREE.SRGBColorSpace
          texture.wrapS = THREE.RepeatWrapping
          texture.wrapT = THREE.RepeatWrapping

          const aspect = width / height
          const size = 200
          geometry = new THREE.PlaneGeometry(size * aspect, size)
          geometry.rotateX(-Math.PI / 2)
          material = new THREE.MeshStandardMaterial({
            map: texture,
            roughness: 0.8,
            metalness: 0.2,
          })
          candidate = new THREE.Mesh(geometry, material)
          candidate.position.y = -0.05
          candidate.receiveShadow = true
          candidate.userData.isFloor = true
        } catch (error) {
          const cleanupErrors: unknown[] = []
          const attempt = (operation: () => void) => {
            try {
              operation()
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError)
            }
          }
          if (candidate) {
            const rejectedCandidate = candidate
            attempt(() => scene.remove(rejectedCandidate))
            attempt(() => disposeObject3D(rejectedCandidate))
          } else {
            const rejectedMaterial = material
            const rejectedGeometry = geometry
            const rejectedTexture = texture
            if (rejectedMaterial) attempt(() => rejectedMaterial.dispose())
            if (rejectedGeometry) attempt(() => rejectedGeometry.dispose())
            if (rejectedTexture) attempt(() => rejectedTexture.dispose())
            attempt(() => bitmap.close())
          }
          if (cleanupErrors.length > 0) {
            throw new AggregateError(
              [error, ...cleanupErrors],
              'Floor texture activation and cleanup failed',
              { cause: error }
            )
          }
          throw error
        }

        const cleanupFailures = activateFloorMesh(scene, floorMeshRef.current, candidate)
        floorMeshRef.current = candidate
        for (const failure of cleanupFailures) {
          log.warn('Floor activation completed with a recoverable lifecycle failure', {
            phase: failure.phase,
            error: failure.error,
          })
        }

        addMessage('success', `BODENTEXTUR: ${displayName}`)
      } catch (error) {
        if (isStale()) return
        addMessage(
          'error',
          `FEHLER: ${error instanceof Error ? error.message : 'Textur konnte nicht geladen werden'}`
        )
      } finally {
        finishLoading(loadingToken)
        if (floorLoadingTokenRef.current === loadingToken) floorLoadingTokenRef.current = null
      }
    },
    [addMessage, beginLoading, embeddedInEngram, finishLoading]
  )

  const handleSetFloorType = useCallback(
    (type: FloorStyle) => {
      if (embeddedInEngram) return
      if (!sceneRef.current) return
      floorLoadGenerationRef.current += 1
      floorAbortControllerRef.current?.abort(new Error('Floor texture replaced'))
      floorAbortControllerRef.current = null
      if (floorLoadingTokenRef.current) {
        finishLoading(floorLoadingTokenRef.current)
        floorLoadingTokenRef.current = null
      }

      const scene = sceneRef.current
      let candidate: THREE.Mesh
      try {
        candidate = type === 'terrain' ? createTerrainMesh() : createProceduralFloor(type)
      } catch (error) {
        addMessage(
          'error',
          `BODEN KONNTE NICHT AKTIVIERT WERDEN: ${error instanceof Error ? error.message : type}`
        )
        return
      }

      try {
        const cleanupFailures = activateFloorMesh(scene, floorMeshRef.current, candidate)
        floorMeshRef.current = candidate
        for (const failure of cleanupFailures) {
          log.warn('Procedural floor activation completed with a recoverable lifecycle failure', {
            phase: failure.phase,
            error: failure.error,
          })
        }
      } catch (error) {
        addMessage(
          'error',
          `BODEN KONNTE NICHT AKTIVIERT WERDEN: ${error instanceof Error ? error.message : type}`
        )
        return
      }
      addMessage('success', `BODEN: ${type.toUpperCase()}`)
    },
    [addMessage, embeddedInEngram, finishLoading]
  )

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const files = Array.from(e.target.files ?? [])
      e.target.value = ''
      if (files.length === 0) return
      if (embeddedInEngram) {
        addMessage('warning', 'ARTEFAKTIMPORT IM ENGRAM-MODUS DEAKTIVIERT')
        return
      }
      const finalSplatIndex = files.reduce(
        (last, file, index) => (isSplatFormat(file.name) ? index : last),
        -1
      )
      const finalFloorIndex = files.reduce(
        (last, file, index) => (/\.(jpg|jpeg|png)$/i.test(file.name) ? index : last),
        -1
      )
      for (const [index, file] of files.entries()) {
        if (isSplatFormat(file.name)) {
          if (index === finalSplatIndex) await loadSplat(file, file.name)
        } else if (isGlbFormat(file.name)) await loadGlb(file, file.name)
        else if (/\.(jpg|jpeg|png)$/i.test(file.name)) {
          if (index === finalFloorIndex) await loadFloorTexture(file, file.name)
        } else addMessage('warning', `NICHT UNTERSTÜTZT: ${file.name}`)
      }
    },
    [addMessage, embeddedInEngram, loadFloorTexture, loadGlb, loadSplat]
  )

  const resetCamera = useCallback(() => {
    if (!cameraRef.current || !controlsRef.current) return
    cameraRef.current.position.set(0, 1.6, 5)
    controlsRef.current.target.set(0, 0, 0)
    velocity.current.set(0, 0, 0)
    controlsRef.current.update()
    addMessage('system', 'ANSICHT ZURÜCKGESETZT')
  }, [addMessage])

  const removeCurrentSplat = useCallback(() => {
    const splat = splatMeshRef.current
    const scene = sceneRef.current
    if (!splat || !scene) return

    let removalError: unknown
    try {
      scene.remove(splat)
    } catch (error) {
      removalError = error
    }
    if (splat.parent !== null) {
      log.warn('Splat remains attached after removal failed', { error: removalError })
      addMessage('error', 'SPLAT KONNTE NICHT ENTFERNT WERDEN')
      return
    }

    // Retire live ownership before disposal. The reload source must retire at
    // the same point or performance-mode reload can resurrect removed bytes.
    splatMeshRef.current = null
    lastSplatSourceRef.current = null
    lastSplatNameRef.current = undefined
    commitCurrentAsset(null)
    if (removalError !== undefined) {
      log.warn('Splat removal threw after detaching the object', { error: removalError })
    }
    try {
      splat.dispose?.()
    } catch (error) {
      log.warn('Splat disposal failed after detachment', { error })
    }
    addMessage('system', 'ENTFERNT')
  }, [addMessage, commitCurrentAsset])

  const focusOnContent = useCallback(() => {
    if (!cameraRef.current || !controlsRef.current || !sceneRef.current) return
    const box = new THREE.Box3()
    let hasContent = false
    if (splatMeshRef.current) {
      // Spark keeps splat positions in GPU textures, not a THREE positions
      // attribute, so box.expandByObject() yields an empty (±Inf) box and the
      // framing math becomes NaN. Use Spark's own bounds API and transform the
      // local-space box into world space.
      const splat = splatMeshRef.current
      const splatBox = splat.getBoundingBox(true)
      if (splatBox && Number.isFinite(splatBox.min.x) && !splatBox.isEmpty()) {
        splat.updateWorldMatrix(true, false)
        splatBox.applyMatrix4(splat.matrixWorld)
        box.union(splatBox)
        hasContent = true
      }
    }
    loadedAssets.forEach((asset) => {
      box.expandByObject(asset.object)
      hasContent = true
    })
    if (!hasContent || box.isEmpty()) {
      addMessage('warning', 'KEIN ZIEL')
      return
    }
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const distance = Math.max(size.x, size.y, size.z, 1) * 1.5
    cameraRef.current.position.set(
      center.x + distance,
      center.y + distance * 0.5,
      center.z + distance
    )
    controlsRef.current.target.copy(center)
    velocity.current.set(0, 0, 0)
    controlsRef.current.update()
    addMessage('system', 'ZIEL ERFASST')
  }, [loadedAssets, addMessage])

  const handleSceneClick = useCallback(
    (event: MouseEvent) => {
      if (embeddedInEngram) return
      if (
        (!cameraPlacementMode && !dronePlacementMode) ||
        !containerRef.current ||
        !sceneRef.current ||
        !cameraRef.current
      )
        return
      const rect = containerRef.current.getBoundingClientRect()
      const viewportWidth = Math.max(rect.width, 1)
      const viewportHeight = Math.max(rect.height, 1)
      mouseRef.current.x = ((event.clientX - rect.left) / viewportWidth) * 2 - 1
      mouseRef.current.y = -((event.clientY - rect.top) / viewportHeight) * 2 + 1
      raycasterRef.current.setFromCamera(mouseRef.current, cameraRef.current)
      const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
      const intersection = new THREE.Vector3()
      const hit = raycasterRef.current.ray.intersectPlane(groundPlane, intersection)

      if (hit) {
        if (cameraPlacementMode) {
          intersection.y = 2.5
          placeCamera(intersection, cameraPlacementMode)
          setCameraPlacementMode(null)
        } else if (dronePlacementMode && pendingDroneType.current) {
          // Offset Y slightly to avoid ground collision on spawn
          intersection.y = 0.5

          const type = pendingDroneType.current
          const name = pendingDroneName.current

          spawnDrone(type, name || undefined, intersection)
            .then((id) => {
              if (id) {
                addMessage('success', `DROHNE PLATZIERT: ${type}`)
              } else {
                addMessage('error', 'FEHLER: KONNTE DROHNE NICHT ERSTELLEN')
              }
            })
            .catch((err) => {
              addMessage('error', `FEHLER: ${err}`)
            })

          setDronePlacementMode(false)
          pendingDroneType.current = null
        }
      }
    },
    [addMessage, cameraPlacementMode, dronePlacementMode, embeddedInEngram, placeCamera, spawnDrone]
  )

  useEffect(() => {
    if (!containerRef.current) return
    viewerMountedRef.current = true
    const container = containerRef.current
    const assetAbortControllers = assetAbortControllersRef.current
    const width = Math.max(container.clientWidth, 1)
    const height = Math.max(container.clientHeight, 1)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0a0a0a)
    scene.fog = new THREE.Fog(0x0a0a0a, 100, 400)
    sceneRef.current = scene

    const ambientLight = new THREE.AmbientLight(0x404040, 1.2)
    scene.add(ambientLight)
    const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.5)
    dirLight1.position.set(5, 10, 5)
    dirLight1.castShadow = true
    scene.add(dirLight1)
    const dirLight2 = new THREE.DirectionalLight(0x8080a0, 0.2)
    dirLight2.position.set(-5, 5, -5)
    scene.add(dirLight2)

    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000)
    camera.position.set(0, 1.6, 5)
    cameraRef.current = camera

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    }) as RendererWithAsync
    addMessage('system', 'BACKEND: WebGL')

    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

    // Common settings where possible, check availability for WebGPU vs WebGL differences
    if (renderer.outputColorSpace !== undefined) renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 0.7
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap

    container.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.rotateSpeed = 0.6
    controls.panSpeed = 0.8
    controls.zoomSpeed = 1.0
    controls.minDistance = 0.1
    controls.maxDistance = 500
    controls.enablePan = true
    controls.screenSpacePanning = true
    controls.maxPolarAngle = Math.PI * 0.95
    controlsRef.current = controls

    glbLoaderRef.current = new GLTFLoader()

    gridRef.current = createTacticalGrid(scene)
    gridLabelsRef.current = createGridLabels(scene)

    const ghostDroneGeometry = new THREE.BoxGeometry(0.5, 0.1, 0.5)
    const ghostDroneMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ff00,
      transparent: true,
      opacity: 0.3,
      wireframe: true,
    })
    const ghostDroneRef = new THREE.Mesh(ghostDroneGeometry, ghostDroneMaterial)
    scene.add(ghostDroneRef)
    ghostDroneRef.visible = false

    // Pre-allocate objects used in the animation loop to avoid per-frame GC pressure
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const planeIntersection = new THREE.Vector3()

    // Throttle HUD state updates to ~4Hz instead of every frame
    let lastHudUpdateTime = 0
    const HUD_UPDATE_INTERVAL = 250 // ms

    const animate = () => {
      if (dronePlacementModeRef.current) {
        raycasterRef.current.setFromCamera(mouseRef.current, camera)
        if (raycasterRef.current.ray.intersectPlane(groundPlane, planeIntersection)) {
          ghostDroneRef.position.copy(planeIntersection)
          ghostDroneRef.position.y += 0.2
          ghostDroneRef.visible = true
        } else {
          ghostDroneRef.visible = false
        }
      } else {
        ghostDroneRef.visible = false
      }

      const now = performance.now()
      const deltaTime = Math.max(0, Math.min((now - lastFrameTime.current) / 1000, 0.1))
      lastFrameTime.current = now

      const ms = moveState.current
      const cfg = MOVE_CONFIG

      let speedMultiplier = 1.0
      if (ms.sprint) speedMultiplier = cfg.sprintMultiplier
      if (ms.precision) speedMultiplier = cfg.precisionMultiplier
      const targetSpeed = cfg.baseSpeed * speedMultiplier

      const { forward, right, targetVelocity, velocityDiff, movement, camDir } =
        scratchVectors.current
      camera.getWorldDirection(forward)
      forward.y = 0
      forward.normalize()
      right.crossVectors(forward, camera.up).normalize()

      targetVelocity.set(0, 0, 0)
      if (ms.forward) targetVelocity.addScaledVector(forward, targetSpeed)
      if (ms.backward) targetVelocity.addScaledVector(forward, -targetSpeed)
      if (ms.left) targetVelocity.addScaledVector(right, -targetSpeed)
      if (ms.right) targetVelocity.addScaledVector(right, targetSpeed)
      if (ms.up) targetVelocity.y += cfg.verticalSpeed * speedMultiplier
      if (ms.down) targetVelocity.y -= cfg.verticalSpeed * speedMultiplier

      const isMoving = targetVelocity.lengthSq() > 0.000001
      const accelRate = isMoving ? cfg.acceleration : cfg.deceleration
      velocityDiff.subVectors(targetVelocity, velocity.current)
      const maxDelta = accelRate * deltaTime

      if (velocityDiff.lengthSq() <= maxDelta * maxDelta) {
        velocity.current.copy(targetVelocity)
      } else {
        velocity.current.addScaledVector(velocityDiff.normalize(), maxDelta)
      }

      if (velocity.current.lengthSq() > cfg.maxVelocity * cfg.maxVelocity) {
        velocity.current.normalize().multiplyScalar(cfg.maxVelocity)
      }

      if (velocity.current.lengthSq() > 0.000001) {
        movement.copy(velocity.current).multiplyScalar(deltaTime)
        camera.position.add(movement)
        controls.target.add(movement)
      }

      const rotateAmount = THREE.MathUtils.degToRad(cfg.rotateSpeed * deltaTime)
      if (ms.rotateLeft) {
        camera.rotation.y += rotateAmount
        controls.target.sub(camera.position)
        controls.target.applyAxisAngle(camera.up, rotateAmount)
        controls.target.add(camera.position)
      }
      if (ms.rotateRight) {
        camera.rotation.y -= rotateAmount
        controls.target.sub(camera.position)
        controls.target.applyAxisAngle(camera.up, -rotateAmount)
        controls.target.add(camera.position)
      }

      camera.getWorldDirection(camDir)

      // Throttle HUD state updates to avoid 60fps React re-renders
      if (now - lastHudUpdateTime > HUD_UPDATE_INTERVAL) {
        lastHudUpdateTime = now
        setBearing((Math.atan2(camDir.x, camDir.z) * (180 / Math.PI) + 360) % 360)
        setAltitude(camera.position.y)
      }

      controls.update()
      renderer.render(scene, camera)
    }
    renderer.setAnimationLoop(animate)

    let containerRect = container.getBoundingClientRect()

    const handleResize = () => {
      const w = Math.max(container.clientWidth, 1)
      const h = Math.max(container.clientHeight, 1)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
      containerRect = container.getBoundingClientRect()
    }
    window.addEventListener('resize', handleResize)

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTextInputTarget(e.target)) return
      // While a drone is selected its control scheme owns W/A/S/D/Q/E/Space/Shift.
      if (droneControlActiveRef.current) return

      if (e.shiftKey) moveState.current.sprint = true
      if (e.ctrlKey || e.metaKey) moveState.current.precision = true

      switch (e.key.toLowerCase()) {
        case 'w':
          moveState.current.forward = true
          break
        case 's':
          moveState.current.backward = true
          break
        case 'a':
          moveState.current.left = true
          break
        case 'd':
          moveState.current.right = true
          break
        case 'q':
          moveState.current.down = true
          break
        case 'e':
          moveState.current.up = true
          break
        case 'z':
          moveState.current.rotateLeft = true
          break
        case 'x':
          moveState.current.rotateRight = true
          break
        case 'arrowleft':
          moveState.current.rotateLeft = true
          e.preventDefault()
          break
        case 'arrowright':
          moveState.current.rotateRight = true
          e.preventDefault()
          break
        case ' ':
          resetViewerMovement()
          e.preventDefault()
          break
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!e.shiftKey) moveState.current.sprint = false
      if (!e.ctrlKey && !e.metaKey) moveState.current.precision = false

      switch (e.key.toLowerCase()) {
        case 'w':
          moveState.current.forward = false
          break
        case 's':
          moveState.current.backward = false
          break
        case 'a':
          moveState.current.left = false
          break
        case 'd':
          moveState.current.right = false
          break
        case 'q':
          moveState.current.down = false
          break
        case 'e':
          moveState.current.up = false
          break
        case 'z':
          moveState.current.rotateLeft = false
          break
        case 'x':
          moveState.current.rotateRight = false
          break
        case 'arrowleft':
          moveState.current.rotateLeft = false
          break
        case 'arrowright':
          moveState.current.rotateRight = false
          break
        case 'shift':
          moveState.current.sprint = false
          break
        case 'control':
        case 'meta':
          moveState.current.precision = false
          break
      }
    }

    const handleMouseMove = (event: MouseEvent) => {
      const viewportWidth = Math.max(containerRect.width, 1)
      const viewportHeight = Math.max(containerRect.height, 1)
      mouseRef.current.x = ((event.clientX - containerRect.left) / viewportWidth) * 2 - 1
      mouseRef.current.y = -((event.clientY - containerRect.top) / viewportHeight) * 2 + 1
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') resetViewerMovement()
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', resetViewerMovement)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    container.addEventListener('mousemove', handleMouseMove)

    return () => {
      const cleanupErrors: unknown[] = []
      const attemptCleanup = (operation: () => void) => {
        try {
          operation()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      renderer.setAnimationLoop(null)
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', resetViewerMovement)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      container.removeEventListener('mousemove', handleMouseMove)
      viewerMountedRef.current = false
      floorLoadGenerationRef.current += 1
      splatLoadGenRef.current += 1
      assetLoadGenerationRef.current += 1
      sceneRestoreGenerationRef.current += 1
      for (const controller of assetAbortControllers) {
        attemptCleanup(() => controller.abort())
      }
      assetAbortControllers.clear()
      attemptCleanup(() => splatCancellationRef.current?.())
      splatCancellationRef.current = null
      // GLTFLoader.parse is callback-only and cannot be aborted. Its source
      // and derived-resource reservations remain until loadGlb's finally path
      // runs, even though this component will admit no further work unmounted.
      // Dispose floor mesh if it exists
      const floor = floorMeshRef.current
      floorMeshRef.current = null
      if (floor) {
        attemptCleanup(() => scene.remove(floor))
        attemptCleanup(() => disposeObject3D(floor))
      }
      // Dispose tactical grid (ShaderMaterial + 2000x2000 PlaneGeometry)
      const grid = gridRef.current
      gridRef.current = null
      if (grid) {
        attemptCleanup(() => scene.remove(grid))
        attemptCleanup(() => disposeObject3D(grid))
      }
      // Dispose grid label sprites (each owns a SpriteMaterial + CanvasTexture map)
      const gridLabels = gridLabelsRef.current
      gridLabelsRef.current = null
      if (gridLabels) {
        attemptCleanup(() => scene.remove(gridLabels))
        if (gridLabels.parent === null) {
          attemptCleanup(() =>
            gridLabels.traverse((obj) => {
              const sprite = obj as THREE.Sprite
              if (sprite.isSprite) {
                attemptCleanup(() => sprite.material.map?.dispose())
                attemptCleanup(() => sprite.material.dispose())
              }
            })
          )
        } else {
          cleanupErrors.push(new Error('Grid labels remain attached during viewer teardown'))
        }
      }
      // Dispose ghost drone preview mesh.
      attemptCleanup(() => scene.remove(ghostDroneRef))
      if (ghostDroneRef.parent === null) {
        attemptCleanup(() => ghostDroneGeometry.dispose())
        attemptCleanup(() => ghostDroneMaterial.dispose())
      } else {
        cleanupErrors.push(new Error('Ghost drone remains attached during viewer teardown'))
      }
      const splat = splatMeshRef.current
      splatMeshRef.current = null
      if (splat) {
        attemptCleanup(() => scene.remove(splat))
        if (splat.parent === null) {
          attemptCleanup(() => splat.dispose?.())
        } else {
          cleanupErrors.push(new Error('Splat remains attached during viewer teardown'))
        }
      }
      const assets = loadedAssetsRef.current
      loadedAssetsRef.current = []
      for (const asset of assets) {
        attemptCleanup(() => scene.remove(asset.object))
        attemptCleanup(() => disposeObject3D(asset.object))
      }
      attemptCleanup(() => disposeAllSurveillanceCamerasOnce(scene, camerasRef))
      attemptCleanup(() => controls.dispose())
      attemptCleanup(() => renderer.dispose())
      // Release the WebGL context so the GPU frees all uploaded buffers/textures
      // (grid, splat, camera render targets, loaded GLBs) that the mount-time
      // closure cannot reach. Critical under StrictMode double-invoke.
      attemptCleanup(() => renderer.forceContextLoss())
      attemptCleanup(() => {
        if (renderer.domElement.parentNode === container) {
          container.removeChild(renderer.domElement)
        }
      })
      sceneRef.current = null
      cameraRef.current = null
      rendererRef.current = null
      controlsRef.current = null
      if (cleanupErrors.length > 0) {
        log.warn('Viewer teardown completed with resource-cleanup failures', {
          count: cleanupErrors.length,
          firstError: cleanupErrors[0],
        })
      }
    }
    // MOVE_CONFIG and addMessage are stable (useMemo/useCallback with []), so the
    // scene-setup effect still runs once at mount.
  }, [MOVE_CONFIG, addMessage, resetViewerMovement])

  // Cycle through cameras with Tab
  const cycleCamera = useCallback(() => {
    if (cameras.length === 0) {
      setSelectedCamera(null)
      return
    }
    const currentIndex = selectedCamera ? cameras.findIndex((c) => c.id === selectedCamera) : -1
    const nextIndex = (currentIndex + 1) % cameras.length
    setSelectedCamera(cameras[nextIndex].id)
    addMessage('system', `KAMERA: ${cameras[nextIndex].name}`)
  }, [cameras, selectedCamera, addMessage])

  useEffect(() => {
    if (gridRef.current) {
      gridRef.current.visible = showGrid
    }
    if (gridLabelsRef.current) {
      gridLabelsRef.current.visible = showGrid
    }
  }, [showGrid])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTextInputTarget(e.target)) return

      if (embeddedInEngram) {
        switch (e.key.toLowerCase()) {
          case VIEWER_SHORTCUTS.resetCamera:
            resetCamera()
            break
          case VIEWER_SHORTCUTS.focusContent:
            focusOnContent()
            break
          case VIEWER_SHORTCUTS.toggleGrid:
            setShowGrid((prev) => !prev)
            break
          case VIEWER_SHORTCUTS.toggleCameraFeeds:
            setShowCameraFeeds((prev) => !prev)
            break
          case VIEWER_SHORTCUTS.toggleDetectionPanel:
            setShowDetectionPanel((prev) => !prev)
            break
          case VIEWER_SHORTCUTS.cycleCamera:
            e.preventDefault()
            cycleCamera()
            break
        }
        return
      }

      switch (e.key.toLowerCase()) {
        case VIEWER_SHORTCUTS.resetCamera:
          // With a drone selected, R belongs to the drone arm/disarm toggle.
          if (droneControlActiveRef.current) break
          resetCamera()
          break
        case VIEWER_SHORTCUTS.focusContent:
          focusOnContent()
          break
        case VIEWER_SHORTCUTS.toggleGrid:
          setShowGrid((prev) => !prev)
          break
        case VIEWER_SHORTCUTS.cancelSelection:
          setCameraPlacementMode(null)
          setSelectedCamera(null)
          clearSelection()
          break
        case VIEWER_SHORTCUTS.placeStaticCamera:
          setCameraPlacementMode('static')
          addMessage('tactical', 'SK-PLATZIERUNG AKTIV')
          break
        case VIEWER_SHORTCUTS.placePTZCamera:
          setCameraPlacementMode('ptz')
          addMessage('tactical', 'PTZ-PLATZIERUNG AKTIV')
          break
        case VIEWER_SHORTCUTS.placePatrolCamera:
          setCameraPlacementMode('patrol')
          addMessage('tactical', 'PK-PLATZIERUNG AKTIV')
          break
        case VIEWER_SHORTCUTS.toggleCameraFeeds:
          setShowCameraFeeds((prev) => !prev)
          break
        case VIEWER_SHORTCUTS.toggleDetectionPanel:
          setShowDetectionPanel((prev) => !prev)
          break
        case VIEWER_SHORTCUTS.toggleDetectionEnabled:
          setDetectionEnabled((prev) => !prev)
          break
        case VIEWER_SHORTCUTS.cycleCamera:
          e.preventDefault()
          cycleCamera()
          break
        case VIEWER_SHORTCUTS.toggleSplatPerformanceMode: {
          // Toggle splat performance mode: cap/uncap splats, then reload in place.
          const enabling = perfMaxSplatsRef.current === 0
          perfMaxSplatsRef.current = enabling ? 1_500_000 : 0
          addMessage(
            'tactical',
            enabling
              ? 'LEISTUNGSMODUS: AN (max 1.5M Splats)'
              : 'LEISTUNGSMODUS: AUS (volle Qualität)'
          )
          if (lastSplatSourceRef.current) {
            void loadSplat(lastSplatSourceRef.current, lastSplatNameRef.current)
          }
          break
        }
        case 'o':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            fileInputRef.current?.click()
          }
          break
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    addMessage,
    clearSelection,
    cycleCamera,
    embeddedInEngram,
    focusOnContent,
    loadSplat,
    resetCamera,
  ])

  useEffect(() => {
    if (embeddedInEngram) return
    if (!cameraPlacementMode && !dronePlacementMode) return
    const container = containerRef.current
    if (!container) return
    container.addEventListener('click', handleSceneClick)
    return () => container.removeEventListener('click', handleSceneClick)
  }, [cameraPlacementMode, dronePlacementMode, embeddedInEngram, handleSceneClick])

  useEffect(() => {
    if (embeddedInEngram || !rendererRef.current || !sceneRef.current || cameras.length === 0)
      return
    const renderer = rendererRef.current
    const scene = sceneRef.current
    let isUpdating = false
    let lastPatrolTime = performance.now()

    const updateFeeds = () => {
      if (isUpdating) return
      isUpdating = true

      const now = performance.now()
      const patrolDt = Math.max(0, Math.min((now - lastPatrolTime) / 1000, 0.5))
      lastPatrolTime = now

      try {
        const activeCameras = cameras.filter((c) => c.isActive)
        if (activeCameras.length === 0) return

        for (const cam of activeCameras) {
          if (cam.type === 'patrol' && cam.patrolPoints && cam.patrolPoints.length >= 2) {
            const patrolIndex = cam.patrolIndex ?? 0
            const patrolSpeed = cam.patrolSpeed ?? DEFAULT_PATROL_SPEED
            const end = cam.patrolPoints[(patrolIndex + 1) % cam.patrolPoints.length]

            // Frame-rate-independent lerp: convert per-frame factor to time-based
            const lerpFactor = 1 - Math.pow(1 - patrolSpeed, patrolDt * 60)
            cam.camera.position.lerp(end, lerpFactor)
            cam.mesh.position.copy(cam.camera.position)

            if (
              cam.camera.position.distanceToSquared(end) <
              PATROL_ARRIVAL_THRESHOLD * PATROL_ARRIVAL_THRESHOLD
            ) {
              cam.patrolIndex = (patrolIndex + 1) % cam.patrolPoints.length
            }

            const start = cam.patrolPoints[patrolIndex]
            const scratch = patrolScratchVec.current
            scratch.subVectors(end, start)

            if (scratch.lengthSq() > 0.000001) {
              scratch.normalize()
              scratch.add(cam.camera.position) // Reuse vector for target position
              cam.camera.lookAt(scratch)
              cam.mesh.quaternion.copy(cam.camera.quaternion)
            }
          }
        }

        // Round-robin: render + read back ONE camera per tick. A feed update is a
        // full scene render to the camera's target plus a synchronous pixel
        // readback; doing every camera each tick multiplies that by the camera
        // count and stalls the main loop (worst with heavy splats). One per tick
        // bounds it; each camera refreshes every activeCameras.length ticks.
        //
        // Frame-budget governor: when that heavy work has been measured to cost
        // more than FEED_FRAME_BUDGET_MS, run it only every `stride` ticks
        // (stride grows with cost, capped at MAX_FEED_STRIDE), so feeds back off
        // and yield the main thread/GPU to the render loop under load. The cheap
        // patrol updates above still run every tick, so camera motion stays smooth.
        const stride = Math.min(
          MAX_FEED_STRIDE,
          Math.max(1, Math.round(feedCostEmaRef.current / FEED_FRAME_BUDGET_MS))
        )
        if (feedHeavyTickRef.current++ % stride !== 0) return

        const heavyStart = performance.now()
        const rrIdx = feedRoundRobinRef.current % activeCameras.length
        feedRoundRobinRef.current = rrIdx + 1
        const rrCam = activeCameras[rrIdx]
        withCameraRenderTarget(renderer, rrCam.renderTarget, () => {
          renderer.render(scene, rrCam.camera)
        })
        feedLastRenderAtRef.current.set(rrCam.id, performance.now())

        if (!showCameraFeeds) {
          // Still account for the render-to-target cost so the governor adapts.
          feedCostEmaRef.current =
            feedCostEmaRef.current * 0.8 + (performance.now() - heavyStart) * 0.2
          return
        }

        for (const cam of [rrCam]) {
          const canvas = feedCanvasRefs.current.get(cam.id)
          if (!canvas) continue

          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          if (!ctx) continue

          const width = cam.renderTarget.width
          const height = cam.renderTarget.height

          const bufferSize = width * height * 4
          let buffer = feedBuffersRef.current.get(cam.id)
          if (!buffer || buffer.length !== bufferSize) {
            buffer = new Uint8Array(bufferSize)
            feedBuffersRef.current.set(cam.id, buffer)
          }

          renderer.readRenderTargetPixels(cam.renderTarget, 0, 0, width, height, buffer)
          let imageData = feedImageDataRef.current.get(cam.id)
          if (!imageData || imageData.width !== width || imageData.height !== height) {
            imageData = ctx.createImageData(width, height)
            feedImageDataRef.current.set(cam.id, imageData)
          }

          const data = imageData.data
          for (let y = 0; y < height; y++) {
            const srcRowStart = (height - 1 - y) * width * 4
            const dstRowStart = y * width * 4
            data.set(buffer.subarray(srcRowStart, srcRowStart + width * 4), dstRowStart)
          }

          ctx.putImageData(imageData, 0, 0)

          const detections = cameraDetectionsRef.current.get(cam.id)
          if (detections && detections.length > 0) {
            drawDetectionsOnCanvas(ctx, detections, width, height, {
              showLabels: true,
              showConfidence: true,
              showCornerMarkers: true,
            })
          }
        }

        // Record the cost of this heavy tick so the governor can adapt the stride.
        feedCostEmaRef.current =
          feedCostEmaRef.current * 0.8 + (performance.now() - heavyStart) * 0.2
      } catch (e) {
        log.error('Error updating camera feeds', { error: e })
      } finally {
        isUpdating = false
      }
    }

    const intervalId = setInterval(updateFeeds, CAMERA_FEED_INTERVAL_MS)
    return () => clearInterval(intervalId)
  }, [cameras, embeddedInEngram, showCameraFeeds])

  useEffect(() => {
    if (embeddedInEngram) return
    const container = containerRef.current
    if (!container) return
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(true)
    }
    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
    }
    const handleDrop = async (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
      if (e.dataTransfer?.files?.length) {
        for (const file of Array.from(e.dataTransfer.files)) {
          if (isSplatFormat(file.name)) await loadSplat(file, file.name)
          else if (isGlbFormat(file.name)) await loadGlb(file, file.name)
          else if (/\.(jpg|jpeg|png)$/i.test(file.name)) await loadFloorTexture(file, file.name)
          else addMessage('warning', `NICHT UNTERSTÜTZT: ${file.name}`)
        }
        return
      }
      const droppedText = e.dataTransfer?.getData('text/plain')
      if (droppedText) {
        const sourcePath = droppedText.split(/[?#]/, 1)[0]
        const filename = sourcePath.split('/').pop() || 'Asset'
        if (isReloadableSplatSource(droppedText)) await loadSplat(droppedText, filename)
        else if (isReloadableGlbSource(droppedText)) await loadGlb(droppedText, filename)
        else if (isReloadableSceneSource(droppedText) && /\.(jpg|jpeg|png)$/i.test(sourcePath))
          await loadFloorTexture(droppedText, filename)
        else addMessage('warning', 'URL NICHT UNTERSTÜTZT')
      }
    }
    const onDrop = (e: DragEvent): void => void handleDrop(e)
    container.addEventListener('dragover', handleDragOver)
    container.addEventListener('dragleave', handleDragLeave)
    container.addEventListener('drop', onDrop)
    return () => {
      container.removeEventListener('dragover', handleDragOver)
      container.removeEventListener('dragleave', handleDragLeave)
      container.removeEventListener('drop', onDrop)
    }
  }, [addMessage, embeddedInEngram, loadFloorTexture, loadGlb, loadSplat])

  const createSceneSnapshot = useCallback(
    (sceneName: string): SceneState => {
      if (!isBoundedSceneName(sceneName)) {
        throw new Error(`Scene name must contain 1–${MAX_SCENE_NAME_BYTES} UTF-8 bytes and no NUL`)
      }
      const persistedCameras: CrebainCamera[] = cameras.map((camera) => ({
        id: camera.id,
        name: camera.name,
        type: camera.type,
        position: camera.camera.position.clone(),
        rotation: camera.camera.rotation.clone(),
        fov: camera.camera.fov,
        near: camera.camera.near,
        far: camera.camera.far,
        isActive: camera.isActive,
        pan: camera.pan,
        tilt: camera.tilt,
        zoom: camera.zoom,
        patrolPath: camera.patrolPoints?.map((point) => point.clone()),
        patrolSpeed: camera.patrolSpeed,
        resolution: [camera.renderTarget.width, camera.renderTarget.height],
      }))

      const recentDetections: DetectionState[] = []
      cameraDetections.forEach((detections, cameraId) => {
        detections.forEach((detection) => {
          recentDetections.push({
            id: detection.id,
            cameraId,
            class: detection.class,
            confidence: detection.confidence,
            bbox: [...detection.bbox],
            timestamp: detection.timestamp,
            threatLevel: detection.threatLevel ?? 0,
          })
        })
      })

      const splatSource = lastSplatSourceRef.current
      const splat = splatMeshRef.current
      const persistedSplat: SplatSceneState | undefined =
        typeof splatSource === 'string' && isReloadableSceneSource(splatSource) && splat
          ? {
              url: splatSource,
              position: { x: splat.position.x, y: splat.position.y, z: splat.position.z },
              rotation: { x: splat.rotation.x, y: splat.rotation.y, z: splat.rotation.z },
              scale: { x: splat.scale.x, y: splat.scale.y, z: splat.scale.z },
            }
          : undefined

      const persistedAssets: SceneAssetState[] = loadedAssets.flatMap((asset) =>
        asset.source && isReloadableSceneSource(asset.source)
          ? [
              {
                id: asset.id,
                name: asset.name,
                type: 'glb' as const,
                source: asset.source,
                position: {
                  x: asset.object.position.x,
                  y: asset.object.position.y,
                  z: asset.object.position.z,
                },
                rotation: {
                  x: asset.object.rotation.x,
                  y: asset.object.rotation.y,
                  z: asset.object.rotation.z,
                },
                scale: {
                  x: asset.object.scale.x,
                  y: asset.object.scale.y,
                  z: asset.object.scale.z,
                },
              },
            ]
          : []
      )

      const hasUnpersistedAssets =
        persistedAssets.length !== loadedAssets.length || Boolean(splat && !persistedSplat)
      if (hasUnpersistedAssets && !persistenceWarningActiveRef.current) {
        addMessage(
          'warning',
          'LOKALE ASSETS KÖNNEN NICHT WIEDERHERGESTELLT WERDEN; URL-ASSETS VERWENDEN'
        )
      }
      persistenceWarningActiveRef.current = hasUnpersistedAssets

      return saveCurrentState(
        sceneName,
        persistedCameras,
        managedDrones,
        {
          position: cameraRef.current?.position.clone() ?? new THREE.Vector3(0, 5, 10),
          target: controlsRef.current?.target.clone() ?? new THREE.Vector3(),
        },
        {
          detectionEnabled,
          showDetectionPanel,
          showPerformancePanel: performancePanelVisible,
          renderQuality: 'high',
          physicsEnabled: !isPaused,
          sensorSimulationEnabled: true,
        },
        persistedSplat?.url,
        recentDetections,
        persistedSplat,
        persistedAssets,
        selectedCamera ?? undefined
      )
    },
    [
      addMessage,
      cameraDetections,
      cameras,
      detectionEnabled,
      isPaused,
      loadedAssets,
      managedDrones,
      performancePanelVisible,
      saveCurrentState,
      selectedCamera,
      showDetectionPanel,
    ]
  )

  const restoreScene = useCallback(
    async (state: SceneState): Promise<void> => {
      if (!physicsReady) throw new Error('Physics engine is still initializing')
      if (sceneRestoreInFlightRef.current) {
        throw new Error('SCENE_RESTORE_BUSY: another scene restore is still active')
      }
      sceneRestoreInFlightRef.current = true
      const previousSettings = {
        detectionEnabled,
        showDetectionPanel,
        performancePanelVisible,
      }
      const previousSimulationPaused = isPaused
      const previousThreatLevel = threatLevel
      const previousViewPosition = cameraRef.current?.position.clone() ?? null
      const previousViewTarget = controlsRef.current?.target.clone() ?? null
      const previousSelectedObjects = [...selectedObjects]
      const previousSelectedCamera = selectedCamera
      const previousCameraDetections = cameraDetectionsRef.current
      const previousCameraCounter = { ...cameraCounterRef.current }
      const previousPersistenceWarning = persistenceWarningActiveRef.current
      const previousCurrentAsset = currentAssetRef.current
      const previousAssets = loadedAssetsRef.current
      const previousSplat = splatMeshRef.current
      const previousSplatSource = lastSplatSourceRef.current
      const previousSplatName = lastSplatNameRef.current
      const restoreGeneration = ++sceneRestoreGenerationRef.current
      const isCurrentRestore = () =>
        viewerMountedRef.current && sceneRestoreGenerationRef.current === restoreGeneration
      let detachedCameras: SurveillanceCamera[] | null = null
      let detachedAssets: LoadedAsset[] | null = null
      let detachedSplat: SplatMesh | null = null
      let droneSuspension: ReturnType<typeof suspendDronesForSceneRestore> | null = null
      let replacementSceneMayOwnResources = false
      const clearLoadedSceneAssets = () => {
        const assets = loadedAssetsRef.current
        const replacementSplatSource = lastSplatSourceRef.current
        const replacementSplatName = lastSplatNameRef.current
        const replacementCurrentAsset = currentAssetRef.current
        loadedAssetsRef.current = []
        setLoadedAssets([])
        const splat = splatMeshRef.current
        splatMeshRef.current = null
        lastSplatSourceRef.current = null
        lastSplatNameRef.current = undefined
        commitCurrentAsset(null)

        const cleanupErrors: unknown[] = []
        const retainedAssets: LoadedAsset[] = []
        for (const asset of assets) {
          try {
            sceneRef.current?.remove(asset.object)
          } catch (error) {
            cleanupErrors.push(error)
          }
          if (asset.object.parent !== null) {
            retainedAssets.push(asset)
            cleanupErrors.push(
              new Error(`Partial-scene asset ${asset.id} remains attached after cleanup`)
            )
            continue
          }
          try {
            disposeObject3D(asset.object)
          } catch (error) {
            cleanupErrors.push(error)
          }
        }
        if (retainedAssets.length > 0) {
          loadedAssetsRef.current = retainedAssets
          setLoadedAssets(retainedAssets)
        }
        if (splat) {
          try {
            sceneRef.current?.remove(splat)
          } catch (error) {
            cleanupErrors.push(error)
          }
          if (splat.parent !== null) {
            cleanupErrors.push(new Error('Partial-scene splat did not detach'))
            // The live registry must continue to own an attached resource.
            // Restore the exact metadata captured before the cleanup attempt.
            splatMeshRef.current = splat
            lastSplatSourceRef.current = replacementSplatSource
            lastSplatNameRef.current = replacementSplatName
            commitCurrentAsset(replacementCurrentAsset)
          } else {
            try {
              splat.dispose?.()
            } catch (error) {
              cleanupErrors.push(error)
            }
          }
        }
        if (cleanupErrors.length > 0) {
          log.warn('Partial scene cleanup released ownership with disposal failures', {
            count: cleanupErrors.length,
            firstError: cleanupErrors[0],
          })
          throw new AggregateError(cleanupErrors, 'Partial scene asset cleanup failed')
        }
      }
      const cancelPendingAssetOperations = () => {
        assetLoadGenerationRef.current += 1
        splatLoadGenRef.current += 1
        for (const controller of assetAbortControllersRef.current) controller.abort()
        assetAbortControllersRef.current.clear()
        splatCancellationRef.current?.()
        splatCancellationRef.current = null
        // Fetches abort, but a GLTF parse already in progress does not. Keep
        // those reservations until each stale load reaches its finally path.
        cancelLoadingOperations()
      }
      const detachPreviousScene = () => {
        const scene = sceneRef.current
        if (!scene) throw new Error('Scene is unavailable')
        const detachErrors: unknown[] = []

        cancelPendingAssetOperations()
        clearSelection()
        setCameraPlacementMode(null)
        setDronePlacementMode(false)
        setSimulationPaused(true)

        const cameraSnapshot = detachAllSurveillanceCameras(scene, camerasRef, setCameras)
        detachedCameras = cameraSnapshot.cameras
        detachErrors.push(...cameraSnapshot.errors)
        setSelectedCamera(null)
        feedCanvasRefs.current.clear()
        feedBuffersRef.current.clear()
        feedImageDataRef.current.clear()
        feedLastRenderAtRef.current.clear()
        cameraDetectionsRef.current = new Map()
        setCameraDetections(new Map())
        cameraCounterRef.current = { static: 0, ptz: 0, patrol: 0 }

        try {
          droneSuspension = suspendDronesForSceneRestore()
          detachErrors.push(...droneSuspension.errors)
        } catch (error) {
          // A suspension precondition fails before the helper mutates drone
          // ownership. Keep those live drones outside partial-scene cleanup.
          detachErrors.push(error)
        }

        detachedAssets = previousAssets
        loadedAssetsRef.current = []
        setLoadedAssets([])
        for (const asset of detachedAssets) {
          try {
            scene.remove(asset.object)
          } catch (error) {
            detachErrors.push(error)
          }
          if (asset.object.parent !== null) {
            detachErrors.push(new Error(`Asset ${asset.id} did not detach from its scene graph`))
          }
        }

        detachedSplat = previousSplat
        splatMeshRef.current = null
        lastSplatSourceRef.current = null
        lastSplatNameRef.current = undefined
        commitCurrentAsset(null)
        persistenceWarningActiveRef.current = false
        if (detachedSplat) {
          try {
            scene.remove(detachedSplat)
          } catch (error) {
            detachErrors.push(error)
          }
          if (detachedSplat.parent !== null) {
            detachErrors.push(new Error('Splat did not detach from its scene graph'))
          }
        }
        if (detachErrors.length > 0) {
          // All detachable categories have now transferred to retained
          // snapshots. If drone suspension failed before transfer, rollback
          // restores the other snapshots without resetting those live drones.
          replacementSceneMayOwnResources = droneSuspension !== null
          throw new AggregateError(detachErrors, 'Failed to detach previous scene assets')
        }
        resetVisualFusion(true)
        replacementSceneMayOwnResources = true
      }
      const clearPartialScene = () => {
        const cleanupErrors: unknown[] = []
        const attempt = (operation: () => void) => {
          try {
            operation()
          } catch (error) {
            cleanupErrors.push(error)
          }
        }
        attempt(cancelPendingAssetOperations)
        attempt(clearSelection)
        setCameraPlacementMode(null)
        setDronePlacementMode(false)
        attempt(clearAllCameras)
        cameraCounterRef.current = { static: 0, ptz: 0, patrol: 0 }
        attempt(() => resetSimulation(true))
        attempt(clearLoadedSceneAssets)
        if (cleanupErrors.length > 0) {
          throw new AggregateError(cleanupErrors, 'Partial scene cleanup failed')
        }
      }
      const disposeDetachedScene = () => {
        const disposeSafely = (label: string, dispose: () => void) => {
          try {
            dispose()
          } catch (error) {
            log.warn(`Failed to dispose replaced ${label}`, { error })
          }
        }
        if (detachedCameras) {
          for (const camera of detachedCameras) {
            disposeSafely(`camera ${camera.id}`, () => disposeSurveillanceCamera(null, camera))
          }
          detachedCameras = null
        }
        if (detachedAssets) {
          for (const asset of detachedAssets) {
            disposeSafely(`asset ${asset.id}`, () => disposeObject3D(asset.object))
          }
          detachedAssets = null
        }
        if (detachedSplat) {
          const splat = detachedSplat
          disposeSafely('splat scene', () => {
            if (splat.parent !== null) throw new Error('Cannot dispose an attached splat')
            splat.dispose?.()
          })
          detachedSplat = null
        }
        if (droneSuspension) {
          if (disposeSuspendedDrones(droneSuspension)) {
            droneSuspension = null
          }
        }
      }
      const rollbackFailedRestore = () => {
        // Overlapping restores are rejected. A stale owner therefore belongs
        // to an unmounted viewer and must not reattach resources to a dead scene.
        if (!isCurrentRestore()) return
        sceneRestoreGenerationRef.current += 1
        const rollbackErrors: unknown[] = []
        if (replacementSceneMayOwnResources) {
          try {
            clearPartialScene()
          } catch (error) {
            rollbackErrors.push(error)
          }
        }

        if (droneSuspension) {
          try {
            restoreSuspendedDrones(droneSuspension)
            droneSuspension = null
          } catch (error) {
            rollbackErrors.push(error)
          }
        } else {
          // A suspension precondition can fail before it transfers ownership.
          // In that case the prior drones are still live and only their pause
          // state needs to be restored.
          setSimulationPaused(previousSimulationPaused)
        }
        if (detachedCameras) {
          const cameras = detachedCameras
          try {
            const restored = restoreDetachedSurveillanceCameras(
              sceneRef.current,
              camerasRef,
              cameras,
              setCameras
            )
            rollbackErrors.push(...restored.errors)
            detachedCameras = restored.retained.length > 0 ? restored.retained : null
          } catch (error) {
            rollbackErrors.push(error)
          }
        }
        if (detachedAssets) {
          const assets = detachedAssets
          const restoredAssets: LoadedAsset[] = []
          const retainedAssets: LoadedAsset[] = []
          for (const asset of assets) {
            const result = attachObject3DToScene(
              sceneRef.current,
              asset.object,
              `asset ${asset.id}`
            )
            rollbackErrors.push(...result.errors)
            if (result.attached) {
              restoredAssets.push(asset)
            } else {
              retainedAssets.push(asset)
            }
          }
          detachedAssets = retainedAssets.length > 0 ? retainedAssets : null
          const alreadyLiveAssets = loadedAssetsRef.current.filter((asset) =>
            isObject3DInScene(sceneRef.current, asset.object)
          )
          const liveAssets = [...alreadyLiveAssets, ...restoredAssets]
          loadedAssetsRef.current = liveAssets
          setLoadedAssets(liveAssets)
        }
        if (detachedSplat) {
          if (splatMeshRef.current) {
            rollbackErrors.push(
              new Error('Cannot restore the previous splat while a partial splat remains live')
            )
          } else {
            const splat = detachedSplat
            const result = attachObject3DToScene(sceneRef.current, splat, 'splat scene')
            rollbackErrors.push(...result.errors)
            if (result.attached) {
              detachedSplat = null
              splatMeshRef.current = splat
              lastSplatSourceRef.current = previousSplatSource
              lastSplatNameRef.current = previousSplatName
              commitCurrentAsset(previousCurrentAsset)
            }
          }
        }

        cameraCounterRef.current = previousCameraCounter
        cameraDetectionsRef.current = previousCameraDetections
        setCameraDetections(previousCameraDetections)
        setSelectedCamera(
          previousSelectedCamera &&
            camerasRef.current.some((camera) => camera.id === previousSelectedCamera)
            ? previousSelectedCamera
            : null
        )
        persistenceWarningActiveRef.current = previousPersistenceWarning
        setDetectionEnabled(previousSettings.detectionEnabled)
        setShowDetectionPanel(previousSettings.showDetectionPanel)
        notifyObserver('Performance panel visibility', () =>
          onPerformancePanelVisibleChange?.(previousSettings.performancePanelVisible)
        )
        setThreatLevel(previousThreatLevel)
        if (previousViewPosition && cameraRef.current) {
          cameraRef.current.position.copy(previousViewPosition)
        }
        if (previousViewTarget && controlsRef.current) {
          controlsRef.current.target.copy(previousViewTarget)
          controlsRef.current.update()
        }
        const previousSelection = previousSelectedObjects[0]
        if (previousSelection && isObject3DInScene(sceneRef.current, previousSelection)) {
          select(previousSelection)
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(rollbackErrors, 'Scene rollback restored with cleanup failures')
        }
      }

      try {
        await runSceneRestoreTransaction(
          () =>
            runWithOperationDeadline(
              async ({ assertActive }) => {
                assertActive()
                const failures: string[] = []

                // Keep the prior graph alive but detached until all requested
                // resources are ready. Rollback does not need another fetch,
                // model parse, or GPU allocation.
                detachPreviousScene()

                for (const camera of state.cameras) {
                  const restoredCamera = placeCamera(
                    new THREE.Vector3(camera.position.x, camera.position.y, camera.position.z),
                    camera.type,
                    camera
                  )
                  if (!restoredCamera) failures.push(`camera ${camera.name}`)
                }
                setSelectedCamera(state.activeCameraId ?? null)

                for (const drone of state.drones) {
                  const restoredId = await spawnDrone(
                    drone.type,
                    drone.name,
                    new THREE.Vector3(drone.position.x, drone.position.y, drone.position.z),
                    {
                      id: drone.id,
                      orientation: new THREE.Quaternion(
                        drone.orientation.x,
                        drone.orientation.y,
                        drone.orientation.z,
                        drone.orientation.w
                      ),
                      velocity: new THREE.Vector3(
                        drone.velocity.x,
                        drone.velocity.y,
                        drone.velocity.z
                      ),
                      angularVelocity: new THREE.Vector3(
                        drone.angularVelocity.x,
                        drone.angularVelocity.y,
                        drone.angularVelocity.z
                      ),
                      armed: drone.armed,
                      battery: drone.battery / 100,
                    }
                  )
                  assertActive()
                  if (!restoredId) {
                    failures.push(`drone ${drone.name ?? drone.id}`)
                    addMessage(
                      'error',
                      `DROHNE KONNTE NICHT GELADEN WERDEN: ${drone.name ?? drone.id}`
                    )
                    continue
                  }
                  const waypoints = (drone.waypoints ?? []).map((waypoint) => ({
                    position: new THREE.Vector3(waypoint.x, waypoint.y, waypoint.z),
                    altitude: waypoint.y,
                  }))
                  const routeAccepted = setRoute(
                    restoredId,
                    waypoints,
                    drone.routeMode ?? (waypoints.length ? 'once' : 'none'),
                    {
                      isActive: drone.routeActive,
                      currentWaypointIndex: drone.routeCurrentWaypointIndex,
                    }
                  )
                  if (!routeAccepted) failures.push(`route ${drone.name ?? drone.id}`)
                }

                const detections = new Map<string, Detection[]>()
                const cameraIds = new Set(state.cameras.map((camera) => camera.id))
                for (const detection of state.recentDetections) {
                  if (!cameraIds.has(detection.cameraId)) continue
                  const cameraDetections = detections.get(detection.cameraId) ?? []
                  cameraDetections.push({
                    id: detection.id,
                    class: detection.class,
                    confidence: detection.confidence,
                    bbox: [...detection.bbox],
                    timestamp: detection.timestamp,
                    threatLevel:
                      detection.threatLevel >= 1 && detection.threatLevel <= 4
                        ? (detection.threatLevel as NonNullable<Detection['threatLevel']>)
                        : undefined,
                  })
                  detections.set(detection.cameraId, cameraDetections)
                }
                cameraDetectionsRef.current = detections
                setCameraDetections(detections)

                assertActive()
                for (const asset of state.assets ?? []) {
                  const loaded = await loadGlb(asset.source, asset.name, asset)
                  assertActive()
                  if (!loaded) failures.push(`asset ${asset.name}`)
                }
                if (state.splatScene?.url) {
                  const loaded = await loadSplat(state.splatScene.url, undefined, state.splatScene)
                  assertActive()
                  if (!loaded) failures.push('splat scene')
                }

                assertActive()
                setDetectionEnabled(state.settings.detectionEnabled)
                setShowDetectionPanel(state.settings.showDetectionPanel)
                notifyObserver('Performance panel visibility', () =>
                  onPerformancePanelVisibleChange?.(state.settings.showPerformancePanel)
                )
                if (cameraRef.current) {
                  cameraRef.current.position.set(
                    state.viewCamera.position.x,
                    state.viewCamera.position.y,
                    state.viewCamera.position.z
                  )
                }
                if (controlsRef.current) {
                  controlsRef.current.target.set(
                    state.viewCamera.target.x,
                    state.viewCamera.target.y,
                    state.viewCamera.target.z
                  )
                  controlsRef.current.update()
                }

                if (failures.length > 0) {
                  throw new Error(`Scene restored with failures: ${failures.join(', ')}`)
                }
              },
              {
                timeoutMs: SCENE_RESTORE_TIMEOUT_MS,
                timeoutMessage: 'Scene restore timed out',
                supersededMessage: 'Scene restore was superseded',
                isCurrent: isCurrentRestore,
                onTimeout: rollbackFailedRestore,
              }
            ),
          {
            isCurrent: isCurrentRestore,
            rollback: rollbackFailedRestore,
            commit: () => {
              setSimulationPaused(!state.settings.physicsEnabled)
              disposeDetachedScene()
            },
          }
        )
      } finally {
        // Unmount invalidates the generation and prevents rollback into a dead
        // scene. Release any retained ownership that was neither committed nor
        // restored before the component disappeared.
        disposeDetachedScene()
        sceneRestoreInFlightRef.current = false
      }
    },
    [
      addMessage,
      cancelLoadingOperations,
      clearAllCameras,
      clearSelection,
      commitCurrentAsset,
      detectionEnabled,
      disposeSuspendedDrones,
      loadGlb,
      loadSplat,
      onPerformancePanelVisibleChange,
      performancePanelVisible,
      placeCamera,
      physicsReady,
      isPaused,
      resetSimulation,
      resetVisualFusion,
      restoreSuspendedDrones,
      select,
      selectedCamera,
      selectedObjects,
      setRoute,
      setSimulationPaused,
      showDetectionPanel,
      spawnDrone,
      suspendDronesForSceneRestore,
      threatLevel,
    ]
  )

  const selectedCameraData = cameras.find((c) => c.id === selectedCamera)
  const availableBackendText =
    systemInfo.availableBackends.length > 0
      ? systemInfo.availableBackends
          .map((backend) => (backend === 'MLX' ? 'MLX (EXP.)' : backend))
          .join(', ')
      : 'KEINE'
  const mlxStatusText = systemInfo.experimentalMlxEnabled ? 'OPT-IN EXP.' : 'AUS'
  const backendStatusText = getDiagnosticsStatusLabel(backendStatus)
  const backendStatusColor =
    backendStatus === 'ready'
      ? 'bg-[#3a6b4a]'
      : backendStatus === 'error'
        ? 'bg-[#8b4a4a]'
        : backendStatus === 'loading' ||
            backendStatus === 'initializing' ||
            backendStatus === 'busy'
          ? 'bg-[#a08040]'
          : 'bg-[#505050]'
  const backendModeText = systemInfo.mode !== 'unknown' ? systemInfo.mode : 'UNBEKANNT'
  const cryptoStatusText = getSecurityConfigurationStatusLabel(SECURITY_CONFIGURATION_STATUS)
  const modelStatusText = 'VERTRAG OFFEN'
  const rosConnectionStatusText = getConnectionStatusLabel(rosConnectionState)
  const rosConnectionStatusColor =
    rosConnectionState === 'connected'
      ? 'text-[#3a6b4a]'
      : rosConnectionState === 'disconnected'
        ? 'text-[#808080]'
        : 'text-[#a08040]'
  const rosTransportText = rosTransport === 'websocket' ? 'rosbridge' : 'Zenoh'

  return (
    <div
      className="relative w-full h-full bg-[#0a0a0a] font-mono overflow-hidden select-none text-[#b0b0b0]"
      style={cssVar as React.CSSProperties}
      aria-busy={isLoading}
    >
      {!embeddedInEngram && (
        <input
          ref={fileInputRef}
          type="file"
          accept=".spz,.ply,.splat,.ksplat,.glb,.jpg,.jpeg,.png"
          multiple
          onChange={(event) => void handleFileSelect(event)}
          className="hidden"
        />
      )}

      <div
        ref={containerRef}
        className={`w-full h-full ${cameraPlacementMode ? 'cursor-crosshair' : isDragging3D ? 'cursor-grabbing' : 'cursor-grab active:cursor-grabbing'}`}
        tabIndex={0}
      />

      {/* DRONE SPAWN PANEL */}
      {!embeddedInEngram && (
        <DroneSpawnPanel
          onSpawnDrone={handleSpawnRequest}
          onSelectDrone={selectDrone}
          onRemoveDrone={removeDrone}
          onRenameDrone={renameDrone}
          onSetRoute={setRoute}
          onClearRoute={clearRoute}
          onToggleRoute={toggleRoute}
          activeDrones={managedDrones.map((d) => ({
            id: d.id,
            type: d.type,
            name: d.name,
            armed: d.physicsBody.state.armed,
            battery: d.physicsBody.state.battery,
            route: d.route,
          }))}
          selectedDroneId={selectedDroneId}
          isExpanded={showDronePanel}
          onToggleExpand={() => setShowDronePanel((prev) => !prev)}
        />
      )}

      {/* SAVE/LOAD PANEL */}
      {!embeddedInEngram && (
        <SaveLoadPanel
          canLoad={physicsReady}
          isExpanded={showSaveLoadPanel}
          onToggleExpand={() => setShowSaveLoadPanel((prev) => !prev)}
          onCreateSnapshot={createSceneSnapshot}
          onSave={(state) => addMessage('success', `Szene "${state.name}" gespeichert`)}
          onLoad={async (state) => {
            await restoreScene(state)
            addMessage('success', `Szene "${state.name}" wiederhergestellt`)
          }}
        />
      )}

      {/* 3D OBJECT TRANSFORM CONTROLS */}
      {!embeddedInEngram && primarySelection && (
        <ObjectTransformControls
          object={primarySelection}
          onDelete={handleDeleteSelectedObject}
          onTransform={handleTransformChange}
          initialPosition={{ x: 12, y: 450 }}
          visible={true}
        />
      )}

      {/* KOPFZEILE */}
      <HeaderBar
        backendStatusColor={backendStatusColor}
        securityConfigurationStatus={SECURITY_CONFIGURATION_STATUS}
        readOnly={embeddedInEngram}
        threatLevel={threatLevel}
        onThreatLevelChange={handleThreatLevelChange}
        scalePercent={scalePercent}
        isAtMin={isAtMin}
        isAtMax={isAtMax}
        onDecreaseScale={decreaseScale}
        onIncreaseScale={increaseScale}
        currentTime={currentTime}
        operatorPosition={simulatedOperatorPosition}
        altitude={altitude}
        bearing={bearing}
        cameras={cameras}
        objectCount={loadedAssets.length + (currentAsset ? 1 : 0)}
        totalDetections={totalDetections}
        fusedTrackCount={fusedTracks.length}
        showGrid={showGrid}
        detectionEnabled={detectionEnabled}
        highestThreat={highestThreat}
      />

      {/* LINKES PANEL - STEUERUNG */}
      <div
        ref={controlPanelDrag.elementRef}
        data-floating-panel="drone"
        data-floating-panel-side="left"
        data-floating-panel-slot={PANEL_POSITIONS.drone.magnifiedSlot}
        data-panel-expanded={showControlPanel ? 'true' : 'false'}
        aria-label={embeddedInEngram ? 'Status panel' : 'Control panel'}
        role="region"
        tabIndex={0}
        className="fixed z-40 w-60"
        style={{
          left: `${controlPanelDrag.position.x}px`,
          top: `${controlPanelDrag.position.y}px`,
          cursor: controlPanelDrag.isDragging ? 'grabbing' : undefined,
          fontSize: `calc(12px * var(--ui-scale, 1))`,
        }}
        onMouseDown={controlPanelDrag.handleMouseDown}
      >
        <div className="bg-[#0c0c0c] border border-[#1a1a1a]">
          <div
            data-drag-handle
            className="flex h-7 items-stretch border-b border-[#1a1a1a] bg-[#101010] select-none"
          >
            <span aria-hidden="true" className="flex cursor-grab items-center px-2 text-[#606060]">
              ⋮
            </span>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center justify-between px-1 pr-3 text-left text-[0.875em] tracking-[0.2em] text-[#909090] hover:text-[#b0b0b0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#a0a0a0]"
              onClick={() => setShowControlPanel((previous) => !previous)}
              aria-expanded={showControlPanel}
              aria-controls="viewer-control-panel-content"
              aria-label={`${embeddedInEngram ? 'Status' : 'Control'} panel ${showControlPanel ? 'schließen' : 'öffnen'}`}
            >
              <span>{embeddedInEngram ? 'STATUS' : 'STEUERUNG'}</span>
              <span aria-hidden="true" className="text-[#707070]">
                {showControlPanel ? '▼' : '▶'}
              </span>
            </button>
          </div>

          {showControlPanel && embeddedInEngram && (
            <div
              id="viewer-control-panel-content"
              data-testid="engram-hosted-read-only-panel"
              className="space-y-3 p-3 text-[0.875em]"
            >
              <div
                role="status"
                className="border border-[#8a6a2f] bg-[#151108] px-2 py-2 text-[#d5ad5c]"
              >
                HOSTED READ-ONLY VIEW
              </div>
              <div className="space-y-1 border border-[#1a1a1a] bg-[#0e0e0e] p-2 text-[#606060]">
                <div>
                  Diagnose: <span className="text-[#a0a0a0]">{backendStatusText}</span>
                </div>
                <div>
                  Simulation: <span className="text-[#a0a0a0]">OFF</span>
                </div>
                <div>
                  Native backend: <span className="text-[#a0a0a0]">OFF</span>
                </div>
                <div>
                  External telemetry: <span className="text-[#a0a0a0]">OFF</span>
                </div>
                <div>
                  Artifact exchange: <span className="text-[#a0a0a0]">OFF</span>
                </div>
                <div>
                  NCP control: <span className="text-[#a0a0a0]">OFF</span>
                </div>
                <div>
                  {rosTransportText}:{' '}
                  <span className={rosConnectionStatusColor}>{rosConnectionStatusText}</span>
                </div>
              </div>
              <p className="text-[#707070]">
                Orbit, view navigation, grid, feed display, camera reset, and focus remain
                available.
              </p>
            </div>
          )}

          {showControlPanel && !embeddedInEngram && (
            <div id="viewer-control-panel-content">
              <div className="flex border-b border-[#1a1a1a]">
                {(['sensoren', 'objekte', 'system'] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`flex-1 py-2 text-[0.875em] tracking-wider border-b-2 transition-all ${activeTab === tab ? 'text-[#c0c0c0] border-[#505050] bg-[#141414]' : 'text-[#505050] border-transparent hover:text-[#808080] hover:bg-[#0e0e0e]'}`}
                  >
                    {tab.toUpperCase()}
                  </button>
                ))}
              </div>

              <div className="p-3 max-h-[calc(100vh-220px)] overflow-y-auto">
                {activeTab === 'sensoren' && (
                  <div className="space-y-3">
                    <div>
                      <div className="text-[0.75em] text-[#606060] tracking-wider mb-2">
                        BEREITSTELLUNG
                      </div>
                      <div className="grid grid-cols-3 gap-1">
                        {(['static', 'ptz', 'patrol'] as CameraType[]).map((type) => (
                          <button
                            key={type}
                            onClick={() =>
                              setCameraPlacementMode(cameraPlacementMode === type ? null : type)
                            }
                            className={`py-2 text-[1em] border transition-all ${cameraPlacementMode === type ? 'bg-[#1a1a1a] border-[#505050] text-[#c0c0c0]' : 'bg-[#0c0c0c] border-[#1a1a1a] text-[#606060] hover:border-[#303030] hover:text-[#909090]'}`}
                          >
                            <div>{type === 'static' ? 'SK' : type === 'ptz' ? 'PTZ' : 'PK'}</div>
                            <div className="text-[0.625em] text-[#404040]">
                              [{type === 'static' ? '1' : type === 'ptz' ? '2' : '3'}]
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>

                    {cameraPlacementMode && (
                      <div className="px-2 py-2 border border-[#505050] bg-[#141414] text-[0.875em] text-[#a0a0a0] text-center animate-pulse">
                        KLICKEN ZUM PLATZIEREN
                      </div>
                    )}

                    {cameras.length > 0 && (
                      <div>
                        <div className="text-[0.75em] text-[#606060] tracking-wider mb-2">
                          AKTIVE SENSOREN
                        </div>
                        <div className="space-y-1">
                          {cameras.map((cam) => (
                            <div
                              key={cam.id}
                              className={`group flex items-center gap-1 border px-1 py-1 transition-all ${selectedCamera === cam.id ? 'border-[#505050] bg-[#141414]' : 'border-[#1a1a1a] bg-[#0c0c0c] hover:border-[#303030]'}`}
                            >
                              <div
                                aria-hidden="true"
                                className={`w-1.5 h-1.5 ${cam.isActive ? 'bg-[#3a6b4a]' : 'bg-[#303030]'}`}
                              />
                              <div className="min-w-0 flex-1">
                                {editingCameraId === cam.id ? (
                                  <input
                                    type="text"
                                    aria-label={`${cam.name} umbenennen`}
                                    value={editingCameraName}
                                    onChange={(e) => setEditingCameraName(e.target.value)}
                                    onBlur={() => {
                                      if (!cameraRenameCancelledRef.current) {
                                        renameCamera(cam.id, editingCameraName)
                                      }
                                      cameraRenameCancelledRef.current = false
                                      setEditingCameraId(null)
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        e.preventDefault()
                                        e.currentTarget.blur()
                                      } else if (e.key === 'Escape') {
                                        e.preventDefault()
                                        cameraRenameCancelledRef.current = true
                                        e.currentTarget.blur()
                                      }
                                    }}
                                    maxLength={MAX_SURVEILLANCE_CAMERA_NAME_BYTES}
                                    autoFocus
                                    className="w-full border border-[#505050] bg-[#0a0a0a] px-1 py-1 text-[1em] text-[#d0d0d0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#a0a0a0]"
                                  />
                                ) : (
                                  <button
                                    type="button"
                                    className={`min-h-10 w-full px-1 text-left text-[1em] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#a0a0a0] ${selectedCamera === cam.id ? 'text-[#d0d0d0]' : 'text-[#808080]'}`}
                                    onClick={() =>
                                      setSelectedCamera(selectedCamera === cam.id ? null : cam.id)
                                    }
                                    onDoubleClick={(e) => {
                                      e.stopPropagation()
                                      beginCameraRename(cam)
                                    }}
                                    aria-pressed={selectedCamera === cam.id}
                                    title="Doppelklick zum Umbenennen"
                                  >
                                    <span className="block truncate">{cam.name}</span>
                                    <span className="block text-[0.75em] text-[#707070]">
                                      {cam.type.toUpperCase()}
                                    </span>
                                  </button>
                                )}
                              </div>
                              {editingCameraId !== cam.id && (
                                <button
                                  type="button"
                                  onClick={() => beginCameraRename(cam)}
                                  aria-label={`${cam.name} umbenennen`}
                                  className="min-h-10 min-w-10 p-1 text-[#707070] opacity-0 hover:bg-[#1a1a1a] hover:text-[#b0b0b0] focus:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#a0a0a0] group-hover:opacity-100"
                                >
                                  ✎
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  removeCamera(cam.id)
                                }}
                                aria-label={`${cam.name} entfernen`}
                                className="min-h-10 min-w-10 p-1 opacity-0 hover:bg-[#1a1a1a] focus:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#d98282] group-hover:opacity-100"
                              >
                                <svg
                                  aria-hidden="true"
                                  className="w-2.5 h-2.5 text-[#8b4a4a]"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M6 18L18 6M6 6l12 12"
                                  />
                                </svg>
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {cameras.length === 0 && !cameraPlacementMode && (
                      <div className="text-center py-4 text-[1em] text-[#404040]">
                        KEINE SENSOREN
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'objekte' && (
                  <div className="space-y-3">
                    <div>
                      <div className="text-[0.75em] text-[#606060] tracking-wider mb-2">BODEN</div>
                      <div className="grid grid-cols-2 gap-1 text-[0.875em]">
                        <button
                          onClick={() => handleSetFloorType('concrete')}
                          className="px-2 py-1.5 bg-[#0c0c0c] border border-[#1a1a1a] text-[#808080] hover:border-[#303030] hover:text-[#a0a0a0]"
                        >
                          BETON
                        </button>
                        <button
                          onClick={() => handleSetFloorType('grass')}
                          className="px-2 py-1.5 bg-[#0c0c0c] border border-[#1a1a1a] text-[#808080] hover:border-[#303030] hover:text-[#a0a0a0]"
                        >
                          GRAS
                        </button>
                        <button
                          onClick={() => handleSetFloorType('asphalt')}
                          className="px-2 py-1.5 bg-[#0c0c0c] border border-[#1a1a1a] text-[#808080] hover:border-[#303030] hover:text-[#a0a0a0]"
                        >
                          ASPHALT
                        </button>
                        <button
                          onClick={() => handleSetFloorType('checker')}
                          className="px-2 py-1.5 bg-[#0c0c0c] border border-[#1a1a1a] text-[#808080] hover:border-[#303030] hover:text-[#a0a0a0]"
                        >
                          RASTER
                        </button>
                        <button
                          onClick={() => handleSetFloorType('terrain')}
                          className="col-span-2 px-2 py-1.5 bg-[#0c0c0c] border border-[#1a1a1a] text-[#808080] hover:border-[#303030] hover:text-[#a0a0a0]"
                        >
                          GELÄNDE (MESH)
                        </button>
                      </div>
                    </div>

                    <div className="w-full h-px bg-[#1a1a1a]" />

                    {!embeddedInEngram && (
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isLoading}
                        className="w-full py-2 bg-[#101010] border border-[#252525] text-[1em] text-[#707070] hover:border-[#404040] hover:text-[#a0a0a0] disabled:opacity-50 transition-all"
                      >
                        DATEI LADEN
                      </button>
                    )}
                    {(loadedAssets.length > 0 || currentAsset) && (
                      <div>
                        <div className="text-[0.75em] text-[#606060] tracking-wider mb-2">
                          GELADENE OBJEKTE
                        </div>
                        <div className="space-y-1">
                          {currentAsset && (
                            <div className="flex items-center gap-2 px-2 py-1.5 border border-[#303030] bg-[#141414]">
                              <div className="w-1.5 h-1.5 bg-[#3a6b4a]" />
                              <span className="flex-1 text-[1em] text-[#a0a0a0] truncate">
                                {currentAsset}
                              </span>
                              <button
                                type="button"
                                onClick={removeCurrentSplat}
                                aria-label={`Remove ${currentAsset}`}
                                className="p-1 hover:bg-[#1a1a1a]"
                              >
                                <svg
                                  className="w-2.5 h-2.5 text-[#8b4a4a]"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M6 18L18 6M6 6l12 12"
                                  />
                                </svg>
                              </button>
                            </div>
                          )}
                          {loadedAssets.map((asset) => (
                            <div
                              key={asset.id}
                              className="flex items-center gap-2 px-2 py-1.5 border border-[#1a1a1a] bg-[#0c0c0c]"
                            >
                              <div className="w-1.5 h-1.5 bg-[#505050]" />
                              <span className="flex-1 text-[1em] text-[#808080] truncate">
                                {asset.name}
                              </span>
                              <button
                                onClick={() => {
                                  clearSelection()
                                  handleDeleteSelectedObject(asset.object)
                                }}
                                type="button"
                                aria-label={`${asset.name} entfernen`}
                                className="min-h-10 min-w-10 p-1 hover:bg-[#1a1a1a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#d98282]"
                              >
                                <svg
                                  className="w-2.5 h-2.5 text-[#8b4a4a]"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M6 18L18 6M6 6l12 12"
                                  />
                                </svg>
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'system' && (
                  <div className="space-y-3 text-[0.875em]">
                    <div className="p-2 border border-[#1a1a1a] bg-[#0e0e0e]">
                      <div className="text-[#909090] mb-1.5">STATUS</div>
                      <div className="grid grid-cols-2 gap-1 text-[#606060]">
                        <div>
                          Diagnose: <span className="text-[#a0a0a0]">{backendStatusText}</span>
                        </div>
                        <div>
                          Sensoren: <span className="text-[#a0a0a0]">{cameras.length}</span>
                        </div>
                        <div>
                          Modus: <span className="text-[#a0a0a0]">{backendModeText}</span>
                        </div>
                        <div>
                          Verschl.: <span className="text-[#a0a0a0]">{cryptoStatusText}</span>
                        </div>
                        <div>
                          Aufz.:{' '}
                          <span
                            className={
                              cameras.filter((c) => c.isRecording).length > 0
                                ? 'text-[#8b4a4a]'
                                : 'text-[#a0a0a0]'
                            }
                          >
                            {cameras.filter((c) => c.isRecording).length}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="p-2 border border-[#1a1a1a] bg-[#0e0e0e]">
                      <div className="text-[#909090] mb-1.5">DETEKTION (NATIVE)</div>
                      <div className="text-[#606060] space-y-1">
                        <div className="flex items-center justify-between">
                          <span>YOLO:</span>
                          <button
                            onClick={() => setDetectionEnabled((prev) => !prev)}
                            disabled={!nativeDetectorReady}
                            className={`px-2 py-0.5 border text-[0.75em] disabled:opacity-40 disabled:cursor-not-allowed ${detectionEnabled ? 'border-[#3a6b4a] text-[#3a6b4a] bg-[#0a1a0a]' : 'border-[#303030] text-[#505050]'}`}
                          >
                            {detectionEnabled ? 'AKTIV' : 'INAKTIV'}
                          </button>
                        </div>
                        <div>
                          Backend: <span className="text-[#808080]">{systemInfo.backend}</span>
                        </div>
                        <div>
                          Verfügbar: <span className="text-[#808080]">{availableBackendText}</span>
                        </div>
                        <div>
                          MLX:{' '}
                          <span
                            className={
                              systemInfo.experimentalMlxEnabled
                                ? 'text-[#9b8a5a]'
                                : 'text-[#808080]'
                            }
                          >
                            {mlxStatusText}
                          </span>
                        </div>
                        <div>
                          Modell: <span className="text-[#808080]">{modelStatusText}</span>
                        </div>
                        <button
                          onClick={() => void testCoreMLInference()}
                          disabled={isTestingCoreML || isBenchmarking || !nativeDetectorReady}
                          className={`w-full mt-2 px-2 py-1 border text-[0.75em] transition-colors ${
                            isTestingCoreML
                              ? 'border-[#4a4a3a] text-[#6a6a5a] bg-[#1a1a0a] cursor-wait'
                              : 'border-[#3a5a6b] text-[#5a8a9b] bg-[#0a1a1a] hover:bg-[#0a2a2a] hover:border-[#4a7a8b]'
                          }`}
                        >
                          {isTestingCoreML ? '⏳ TESTE...' : '🧪 NATIVE TESTEN'}
                        </button>
                        <div className="grid grid-cols-2 gap-1 mt-1">
                          <button
                            onClick={() => void runCoreMLBenchmark()}
                            disabled={isTestingCoreML || isBenchmarking || !nativeDetectorReady}
                            className={`px-2 py-1 border text-[0.75em] transition-colors ${
                              isBenchmarking
                                ? 'border-[#4a4a3a] text-[#6a6a5a] bg-[#1a1a0a] cursor-wait'
                                : 'border-[#6b5a3a] text-[#9b8a5a] bg-[#1a1a0a] hover:bg-[#2a2a0a] hover:border-[#8b7a4a]'
                            }`}
                          >
                            {isBenchmarking
                              ? `⏳ ${benchmarkProgress.toFixed(0)}%`
                              : '📊 BENCHMARK'}
                          </button>
                          <button
                            onClick={cancelCoreMLBenchmark}
                            disabled={!isBenchmarking}
                            className="px-2 py-1 border border-[#5a3a3a] text-[0.75em] text-[#8b4a4a] bg-[#1a0a0a] hover:bg-[#2a0a0a] hover:border-[#8b4a4a] disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            ABBRECHEN
                          </button>
                        </div>
                        {fusionStats && (
                          <>
                            <div>
                              Frames:{' '}
                              <span className="text-[#808080]">{fusionStats.frameCount}</span>
                            </div>
                            <div>
                              Tracks:{' '}
                              <span className="text-[#808080]">
                                {fusionStats.confirmedTracks}/{fusionStats.totalTracks}
                              </span>
                            </div>
                            <div>
                              Multi-Cam:{' '}
                              <span className="text-[#808080]">
                                {fusionStats.multiCameraTracks}
                              </span>
                            </div>
                            <div>
                              Batch:{' '}
                              <span
                                className={
                                  fusionStats.lastFrameStatus === 'ok'
                                    ? 'text-[#3a6b4a]'
                                    : 'text-[#a08040]'
                                }
                              >
                                {fusionStats.lastFrameStatus}
                              </span>
                            </div>
                            <div>
                              Verworfen:{' '}
                              <span className="text-[#808080]">
                                {fusionStats.lastFrameDroppedDetections +
                                  fusionStats.lastFrameRejectedDetections +
                                  fusionStats.lastFrameDroppedGroups +
                                  fusionStats.lastFrameEvictedTracks +
                                  fusionStats.lastFrameDroppedCameras +
                                  fusionStats.lastFrameRejectedCameras}
                              </span>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="p-2 border border-[#1a1a1a] bg-[#0e0e0e]">
                      <div className="text-[#909090] mb-1.5">SENSOR FUSION</div>
                      <div className="text-[#606060] space-y-0.5">
                        <div>
                          Status:{' '}
                          <span
                            className={cameras.length > 1 ? 'text-[#3a6b4a]' : 'text-[#808080]'}
                          >
                            {cameras.length > 1 ? 'AKTIV' : 'MINDEST. 2 KAMERAS'}
                          </span>
                        </div>
                        <div>
                          Korrelation: <span className="text-[#808080]">0.5</span>
                        </div>
                        <div>
                          Track-Alter: <span className="text-[#808080]">3000ms</span>
                        </div>
                      </div>
                    </div>
                    <div className="p-2 border border-[#1a1a1a] bg-[#0e0e0e]">
                      <div className="text-[#909090] mb-1.5">ROS INTEGRATION</div>
                      <div className="text-[#606060] space-y-0.5">
                        <div>
                          {rosTransportText}:{' '}
                          <span className={rosConnectionStatusColor}>
                            {rosConnectionStatusText}
                          </span>
                        </div>
                        <div>
                          Topics: <span className="text-[#808080]">/crebain/cam_*</span>
                        </div>
                        <div>
                          Gazebo: <span className="text-[#808080]">STANDBY</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <ViewerOverlayRail isDocked={isDocked}>
        <CameraDetailsOverlay
          camera={selectedCameraData ?? null}
          readOnly={embeddedInEngram}
          onDownload={downloadCameraFeed}
          onUpdatePtz={updateCameraPTZ}
        />

        {/* DETECTION PANEL */}
        {showDetectionPanel && (totalDetections > 0 || fusedTracks.length > 0) && (
          <DetectionPanel
            totalDetections={totalDetections}
            fusedTracks={fusedTracks}
            cameraDetections={cameraDetections}
            cameras={cameras}
            fusionStats={fusionStats}
            onClose={() => setShowDetectionPanel(false)}
          />
        )}

        <CameraFeedsOverlay
          cameras={cameras}
          visible={showCameraFeeds}
          selectedCameraId={selectedCamera}
          canvasRefs={feedCanvasRefs}
          onSelect={setSelectedCamera}
          onVisibleChange={setShowCameraFeeds}
        />

        <ViewerEventLog messages={consoleMessages} />
      </ViewerOverlayRail>

      <ViewerFooter
        readOnly={embeddedInEngram}
        paused={isPaused}
        feedsVisible={showCameraFeeds}
        onTogglePause={togglePause}
        onResetSimulation={() => {
          resetSimulation()
          addMessage('system', 'SIMULATION ZURÜCKGESETZT')
        }}
        onToggleFeeds={() => setShowCameraFeeds((previous) => !previous)}
        onResetCamera={resetCamera}
        onFocusContent={focusOnContent}
      />

      {!embeddedInEngram && isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="absolute inset-0 border-2 border-dashed border-[#404040] bg-black/30" />
          <div className="px-6 py-3 bg-[#0c0c0c] border border-[#404040] text-[#909090] text-[1.125em] tracking-wider">
            DATEI ABLEGEN
          </div>
        </div>
      )}

      {isLoading && (
        <ViewerLoadingOverlay name={loadingName} progress={loadingProgress} stage={loadingStage} />
      )}

      {/* Corner accents */}
      <div className="absolute top-0 left-0 w-10 h-10 pointer-events-none border-t border-l border-[#252525]" />
      <div className="absolute top-0 right-0 w-10 h-10 pointer-events-none border-t border-r border-[#252525]" />
      <div className="absolute bottom-0 left-0 w-10 h-10 pointer-events-none border-b border-l border-[#252525]" />
      <div className="absolute bottom-0 right-0 w-10 h-10 pointer-events-none border-b border-r border-[#252525]" />
    </div>
  )
}
