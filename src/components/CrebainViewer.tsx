import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import * as THREE from 'three'
import { SplatMesh } from '@sparkjsdev/spark'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { SensorFusion, type FusionStats } from '../detection/SensorFusion'
import type { CoreMLDetectionResult, Detection, FusedTrack, CameraParams } from '../detection/types'
import { drawDetectionsOnCanvas } from './DetectionOverlay'
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_IOU_THRESHOLD,
  DEFAULT_MAX_DETECTIONS,
} from '../detection/types'
import { useDetectionLoop } from '../hooks/useDetectionLoop'
import { useDroneController } from '../hooks/useDroneController'
import { useSceneState, type CrebainCamera } from '../hooks/useSceneState'
import { useDraggable } from '../hooks/useDraggable'
import { useDraggable3D } from '../hooks/useDraggable3D'
import { useObjectSelection } from '../hooks/useObjectSelection'
import { useUIScale } from '../context/UIScaleContext'
import DroneSpawnPanel from './DroneSpawnPanel'
import SaveLoadPanel from './SaveLoadPanel'
import ObjectTransformControls from './ObjectTransformControls'
import { createTacticalGrid, createGridLabels } from './viewer/TacticalGrid'
import DetectionPanel from './viewer/DetectionPanel'
import HeaderBar from './viewer/HeaderBar'
import { disposeObject3D, forEachMesh, objectLabel } from '../lib/three/sceneObjects'
import { fetchAssetWithLimit } from '../lib/boundedFetch'
import { inspectPngJpegDimensions, validateSelfContainedGlb } from '../lib/glbValidation'
import {
  createProceduralFloor,
  createTerrainMesh,
  type FloorStyle,
} from './viewer/ProceduralTerrain'
import { getGazeboController } from '../ros/GazeboController'
import { getROSBridge } from '../ros/ROSBridge'
import { calculateLatencyStats, normalizeSystemInfo, type SystemInfo } from '../lib/diagnostics'
import { isTextInputTarget, VIEWER_SHORTCUTS } from '../lib/shortcuts'
import { TAURI_COMMANDS } from '../lib/tauriCommands'
import {
  isReloadableSceneSource,
  MAX_SCENE_ASSETS,
  type CameraState,
  type DetectionState,
  type SceneAssetState,
  type SceneState,
  type SplatSceneState,
} from '../state/SceneState'

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

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CREBAIN - ADAPTIVE RESPONSE & AWARENESS SYSTEM (ARAS)
 * Adaptives Reaktions- und Aufklärungssystem
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Version: 0.4.0
 *
 * 3D-Gaussian-Splatting-Visualisierung für Verteidigungsanwendungen
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ROS-GAZEBO INTEGRATIONSARCHITEKTUR
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * OPTION A: SIMULATION (GAZEBO + ROS)
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  CREBAIN UI  ◄──WebSocket──►  rosbridge_server (ws://localhost:9090)       │
 * │       │                                    │                                │
 * │       ▼                                    ▼                                │
 * │  Kameraposen ──►  /crebain/camera_poses ──►  Gazebo Kamera-Plugins         │
 * │  Feed Export ◄──  /crebain/cam_N/image  ◄──  gazebo_ros_camera             │
 * │  Erkennung   ◄──  /darknet_ros/boxes    ◄──  YOLO/CV Pipeline              │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * OPTION B: HARDWARE-IN-THE-LOOP
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  Physische Sensoren ──► ROS Treiber ──► tf2 Transforms ──► CREBAIN Sync    │
 * │  - Velodyne LIDAR      /velodyne_points                                     │
 * │  - LORD IMU            /imu/data                                            │
 * │  - uBlox GPS           /fix, /navpvt                                        │
 * │  - FLIR Wärmebild      /thermal/image_raw                                   │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * YOLO INTEGRATION:
 *   const imageData = exportCameraFeed(cameraId)  // ImageData für CV
 *   // POST an Inferenz-Server oder lokale tfjs/onnxruntime Verarbeitung
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

function disposeSurveillanceCamera(scene: THREE.Scene | null, camera: SurveillanceCamera): void {
  scene?.remove(camera.helper)
  camera.helper.dispose()
  scene?.remove(camera.mesh)
  camera.renderTarget.dispose()
  disposeObject3D(camera.mesh)
}

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
  }) => void
  performancePanelVisible?: boolean
  onPerformancePanelVisibleChange?: (visible: boolean) => void
}

type NativeDetectionResult = CoreMLDetectionResult & { backend?: string | null }

const COREML_TEST_WIDTH = 640
const COREML_TEST_HEIGHT = 480
const VIEWER_BENCHMARK_ITERATIONS = 100
const VIEWER_BENCHMARK_PROGRESS_STEP = 10
const MAX_SPLAT_BYTES = 256 * 1024 * 1024
const MAX_GLB_BYTES = 128 * 1024 * 1024
const MAX_GLB_SCENE_BYTES = 512 * 1024 * 1024
const MAX_FLOOR_TEXTURE_BYTES = 32 * 1024 * 1024
const MAX_FLOOR_TEXTURE_PIXELS = 16_777_216
const ASSET_DOWNLOAD_TIMEOUT_MS = 30_000
const SCENE_RESTORE_TIMEOUT_MS = 120_000
const MAX_SURVEILLANCE_CAMERAS = 64
const MAX_CAMERA_RENDER_PIXELS = 16_777_216

export default function CrebainViewer({
  onDetectionComplete,
  onVisualTrack,
  performancePanelVisible = true,
  onPerformancePanelVisibleChange,
}: CrebainViewerProps) {
  const { increaseScale, decreaseScale, scalePercent, isAtMin, isAtMax, cssVar } = useUIScale()

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
  const [loadedAssets, setLoadedAssets] = useState<LoadedAsset[]>([])
  const loadedAssetsRef = useRef<LoadedAsset[]>([])
  const viewerMountedRef = useRef(false)
  const floorLoadGenerationRef = useRef(0)
  const floorAbortControllerRef = useRef<AbortController | null>(null)
  const floorLoadingTokenRef = useRef<symbol | null>(null)
  const assetLoadGenerationRef = useRef(0)
  const sceneRestoreGenerationRef = useRef(0)
  const splatCancellationRef = useRef<(() => void) | null>(null)
  const assetAbortControllersRef = useRef<Set<AbortController>>(new Set())
  const pendingAssetLoadsRef = useRef(0)
  const pendingAssetBytesRef = useRef(0)
  const [isDragging, setIsDragging] = useState(false)
  const [consoleMessages, setConsoleMessages] = useState<ConsoleMessage[]>([])

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
  const [showGrid, setShowGrid] = useState(true)
  const simulatedOperatorPosition = { lat: 52.52, lon: 13.405, alt: 34 }
  const [bearing, setBearing] = useState(0)
  const [altitude, setAltitude] = useState(0)

  // Detection system state
  const [detectionEnabled, setDetectionEnabled] = useState(true)
  const [cameraDetections, setCameraDetections] = useState<Map<string, Detection[]>>(new Map())
  const cameraDetectionsRef = useRef<Map<string, Detection[]>>(new Map())
  const [fusedTracks, setFusedTracks] = useState<FusedTrack[]>([])
  const [fusionStats, setFusionStats] = useState<FusionStats | null>(null)
  const [showDetectionPanel, setShowDetectionPanel] = useState(true)
  const [isTestingCoreML, setIsTestingCoreML] = useState(false)
  const [showDronePanel, setShowDronePanel] = useState(true)
  const [showSaveLoadPanel, setShowSaveLoadPanel] = useState(true)
  const [editingCameraId, setEditingCameraId] = useState<string | null>(null)
  const [editingCameraName, setEditingCameraName] = useState('')
  const [showControlPanel, setShowControlPanel] = useState(true)
  const [isBenchmarking, setIsBenchmarking] = useState(false)
  const [systemInfo, setSystemInfo] = useState<SystemInfo>(() => normalizeSystemInfo(null))

  const controlPanelDrag = useDraggable({
    initialPosition: { x: 12, y: 80 },
    snapDistance: 20,
    edgePadding: 12,
    side: 'left',
  })
  const controlPanelWasDraggedRef = useRef(false)
  useEffect(() => {
    if (controlPanelDrag.wasDragged !== controlPanelWasDraggedRef.current) {
      controlPanelWasDraggedRef.current = controlPanelDrag.wasDragged
    }
  }, [controlPanelDrag.wasDragged])
  const handleControlPanelHeaderClick = useCallback(() => {
    if (!controlPanelWasDraggedRef.current) {
      setShowControlPanel((prev) => !prev)
    }
    controlPanelWasDraggedRef.current = false
  }, [])
  const [benchmarkProgress, setBenchmarkProgress] = useState(0)
  const benchmarkAbortRef = useRef(false)
  const benchmarkRunIdRef = useRef(0)
  const sensorFusionRef = useRef<SensorFusion | null>(null)
  const cameraCounterRef = useRef({ static: 0, ptz: 0, patrol: 0 })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const feedCanvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map())
  // Reusable buffers for camera feed rendering (avoids allocation per frame)
  const feedBuffersRef = useRef<Map<string, Uint8Array>>(new Map())
  // Reusable ImageData per camera (avoids ~1MB createImageData alloc each feed tick)
  const feedImageDataRef = useRef<Map<string, ImageData>>(new Map())
  // Timestamp (performance.now) of each camera's last render-to-target, so
  // exportCameraFeed can skip targets the round-robin/governor left stale.
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
  // Max age (ms) of a camera's render target for detection exports: the
  // round-robin + governor may leave a target unrefreshed for seconds, and
  // pairing those stale pixels with current camera poses corrupts fusion.
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
  }, [])

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
    setConsoleMessages((prev) => [...prev.slice(-8), newMessage])

    const timeoutId = window.setTimeout(() => {
      setConsoleMessages((prev) => prev.filter((m) => m.id !== newMessage.id))
      messageTimeoutsRef.current.delete(newMessage.id)
    }, 10000)
    messageTimeoutsRef.current.set(newMessage.id, timeoutId)
  }, [])

  // Native detection runs through the Tauri backend. When the app is opened in a
  // plain browser (e.g. the Vite dev server) the IPC bridge is absent and every
  // `invoke` rejects with "Failed to fetch". Detect that up front so the UI can
  // disable the native buttons and show a clear message instead.
  const nativeAvailable = useMemo(() => isTauri(), [])

  const refreshSystemInfo = useCallback(async () => {
    if (!nativeAvailable) {
      setSystemInfo(normalizeSystemInfo(null))
      return
    }
    try {
      const info = await invoke<unknown>(TAURI_COMMANDS.detection.systemInfo)
      setSystemInfo(normalizeSystemInfo(info))
    } catch (error) {
      log.warn('Failed to refresh detector system info', { error })
      setSystemInfo(normalizeSystemInfo(null))
    }
  }, [nativeAvailable])

  useEffect(() => {
    void refreshSystemInfo()
  }, [refreshSystemInfo])

  useEffect(() => {
    return () => {
      benchmarkAbortRef.current = true
      benchmarkRunIdRef.current += 1
    }
  }, [])

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
  } = useDroneController({
    scene: sceneRef.current,
    enabled: true,
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
      pendingDroneType.current = typeId
      pendingDroneName.current = name || null
      setDronePlacementMode(true)
      setCameraPlacementMode(null) // Cancel other modes
      addMessage('tactical', 'DROHNE PLATZIEREN: ZIEL WÄHLEN')
    },
    [addMessage]
  )

  const handleDetection = useCallback((cameraId: string, detections: Detection[]) => {
    setCameraDetections((prev) => {
      const updated = new Map(prev)
      updated.set(cameraId, detections)
      cameraDetectionsRef.current = updated
      return updated
    })
  }, [])

  const handlePerformance = useCallback(
    (metrics: {
      inferenceTimeMs: number
      preprocessTimeMs: number
      postprocessTimeMs: number
      detectionCount: number
      cameraId: string
    }) => {
      if (onDetectionComplete) {
        onDetectionComplete({
          inferenceTimeMs: metrics.inferenceTimeMs,
          preprocessTimeMs: metrics.preprocessTimeMs,
          postprocessTimeMs: metrics.postprocessTimeMs,
          detectionCount: metrics.detectionCount,
        })
      }
    },
    [onDetectionComplete]
  )

  useEffect(() => {
    const win = window as Window & { crebainDetectionHandler?: typeof handleDetection }
    win.crebainDetectionHandler = handleDetection
    return () => {
      delete win.crebainDetectionHandler
    }
  }, [handleDetection])

  useEffect(() => {
    if (sensorFusionRef.current && cameras.length > 1 && cameraDetections.size > 0) {
      const cameraParams = new Map<string, CameraParams>()
      cameras.forEach((cam) => {
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

      const tracks = sensorFusionRef.current.processFrame(cameraDetections, cameraParams)
      setFusedTracks(tracks)
      setFusionStats(sensorFusionRef.current.getStats())
      for (const track of tracks) {
        const position = track.triangulatedPosition
        if (
          Number.isFinite(position.x) &&
          Number.isFinite(position.y) &&
          Number.isFinite(position.z)
        ) {
          onVisualTrack?.({
            id: track.id,
            position: [position.x, position.y, position.z],
            confidence: track.fusedConfidence,
            classLabel: track.class,
          })
        }
      }

      const highThreatTracks = tracks.filter((t) => t.threatLevel >= 3)
      if (highThreatTracks.length > 0 && threatLevel < 3) {
        setThreatLevel(3)
      }
    }
  }, [cameras, cameraDetections, onVisualTrack, threatLevel])

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
      if (!sceneRef.current || !rendererRef.current) return

      const resolution: [number, number] = restored?.resolution ?? [640, 360]
      const existingCameras = camerasRef.current
      const allocatedPixels = existingCameras.reduce(
        (total, camera) => total + camera.renderTarget.width * camera.renderTarget.height,
        0
      )
      const requestedPixels = resolution[0] * resolution[1]
      if (
        existingCameras.length >= MAX_SURVEILLANCE_CAMERAS ||
        allocatedPixels + requestedPixels > MAX_CAMERA_RENDER_PIXELS
      ) {
        addMessage('error', 'KAMERA-LIMIT ERREICHT: GPU-RENDERTARGET-BUDGET ÜBERSCHRITTEN')
        return
      }

      cameraCounterRef.current[type]++
      const designation =
        restored?.name ?? generateCameraDesignation(type, cameraCounterRef.current[type])

      const feedCamera = new THREE.PerspectiveCamera(
        restored?.fov ?? 60,
        resolution[0] / resolution[1],
        restored?.near ?? 0.1,
        restored?.far ?? 500
      )
      feedCamera.position.copy(position)
      if (restored) {
        feedCamera.rotation.set(restored.rotation.x, restored.rotation.y, restored.rotation.z)
      } else {
        feedCamera.lookAt(position.x, position.y - 0.5, position.z - 2)
      }

      const renderTarget = new THREE.WebGLRenderTarget(resolution[0], resolution[1], {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
      })

      const helper = new THREE.CameraHelper(feedCamera)
      helper.visible = false
      sceneRef.current.add(helper)

      const mesh = createCameraMesh(type)
      mesh.position.copy(position)
      mesh.quaternion.copy(feedCamera.quaternion)
      sceneRef.current.add(mesh)

      const newCamera: SurveillanceCamera = {
        id: restored?.id ?? crypto.randomUUID(),
        name: designation,
        type,
        camera: feedCamera,
        helper,
        mesh,
        renderTarget,
        pan: restored?.pan ?? 0,
        tilt: restored?.tilt ?? 0,
        zoom: restored?.zoom ?? restored?.fov ?? 60,
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

      const nextCameras = [...existingCameras, newCamera]
      camerasRef.current = nextCameras
      setCameras(nextCameras)
      addMessage('tactical', `${designation} AKTIVIERT`)
      return newCamera
    },
    [createCameraMesh, addMessage]
  )

  const updateCameraPTZ = useCallback(
    (cameraId: string, pan?: number, tilt?: number, zoom?: number) => {
      setCameras((prev) =>
        prev.map((cam) => {
          if (cam.id !== cameraId) return cam
          const newPan = pan !== undefined ? pan : cam.pan
          const newTilt = tilt !== undefined ? Math.max(-85, Math.min(85, tilt)) : cam.tilt
          const newZoom = zoom !== undefined ? Math.max(5, Math.min(120, zoom)) : cam.zoom
          const euler = new THREE.Euler(
            THREE.MathUtils.degToRad(-newTilt),
            THREE.MathUtils.degToRad(newPan),
            0,
            'YXZ'
          )
          cam.camera.quaternion.setFromEuler(euler)
          cam.camera.fov = newZoom
          cam.camera.updateProjectionMatrix()
          cam.mesh.quaternion.copy(cam.camera.quaternion)
          return { ...cam, pan: newPan, tilt: newTilt, zoom: newZoom }
        })
      )
    },
    []
  )

  const removeCamera = useCallback(
    (cameraId: string) => {
      setCameras((prev) => {
        const cam = prev.find((c) => c.id === cameraId)
        if (cam) {
          disposeSurveillanceCamera(sceneRef.current, cam)
          addMessage('system', `${cam.name} DEAKTIVIERT`)
        }
        const next = prev.filter((c) => c.id !== cameraId)
        camerasRef.current = next
        return next
      })
      if (selectedCamera === cameraId) setSelectedCamera(null)
      // Free the per-camera feed state: the canvas ref callback also deletes
      // its entry on unmount, but the pixel-readback buffer and pooled
      // ImageData (~0.9 MB each at 640x360) plus the last-render timestamp
      // have no unmount hook, so clear everything here.
      feedCanvasRefs.current.delete(cameraId)
      feedBuffersRef.current.delete(cameraId)
      feedImageDataRef.current.delete(cameraId)
      feedLastRenderAtRef.current.delete(cameraId)
      // Purge retained detections for the removed camera (the Map grows otherwise).
      setCameraDetections((prev) => {
        if (!prev.has(cameraId)) return prev
        const next = new Map(prev)
        next.delete(cameraId)
        cameraDetectionsRef.current = next
        return next
      })
    },
    [selectedCamera, addMessage]
  )

  const clearAllCameras = useCallback(() => {
    camerasRef.current.forEach((camera) => disposeSurveillanceCamera(sceneRef.current, camera))
    camerasRef.current = []
    setCameras([])
    setSelectedCamera(null)
    feedCanvasRefs.current.clear()
    feedBuffersRef.current.clear()
    feedImageDataRef.current.clear()
    feedLastRenderAtRef.current.clear()
    cameraDetectionsRef.current = new Map()
    setCameraDetections(new Map())
  }, [])

  const renameCamera = useCallback((cameraId: string, newName: string) => {
    setCameras((prev) => prev.map((cam) => (cam.id === cameraId ? { ...cam, name: newName } : cam)))
  }, [])

  // GPU pixel readback is synchronous; the Promise contract is kept for API
  // stability and to match async camera-capture backends. Reuses the pooled
  // per-camera buffer/ImageData (shared with updateFeeds) instead of
  // allocating ~1.8 MB per call at the 100 ms detection tick.
  const exportCameraFeed = useCallback(
    (cameraId: string, maxAgeMs: number = FEED_EXPORT_MAX_AGE_MS): Promise<ImageData | null> => {
      const cam = cameras.find((c) => c.id === cameraId)
      if (!cam || !rendererRef.current) return Promise.resolve(null)
      // Skip targets the round-robin/governor hasn't refreshed recently so
      // stale pixels never get paired with current camera poses downstream.
      const renderedAt = feedLastRenderAtRef.current.get(cameraId)
      if (renderedAt === undefined || performance.now() - renderedAt > maxAgeMs) {
        return Promise.resolve(null)
      }
      const width = cam.renderTarget.width
      const height = cam.renderTarget.height
      const bufferSize = width * height * 4
      let buffer = feedBuffersRef.current.get(cameraId)
      if (!buffer || buffer.length !== bufferSize) {
        buffer = new Uint8Array(bufferSize)
        feedBuffersRef.current.set(cameraId, buffer)
      }
      rendererRef.current.readRenderTargetPixels(cam.renderTarget, 0, 0, width, height, buffer)
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
    [exportCameraFeed, cameras, addMessage]
  )

  const testCoreMLInference = useCallback(async () => {
    if (isTestingCoreML || isBenchmarking) return
    if (!nativeAvailable) {
      addMessage('error', 'NATIVE DETEKTION NUR IN DER DESKTOP-APP VERFÜGBAR (nicht im Browser)')
      return
    }

    setIsTestingCoreML(true)
    addMessage('info', 'NATIVE DETECTOR TEST: Generiere Testbild...')

    try {
      const canvas = document.createElement('canvas')
      canvas.width = COREML_TEST_WIDTH
      canvas.height = COREML_TEST_HEIGHT
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas context not available')

      const gradient = ctx.createLinearGradient(0, 0, 0, COREML_TEST_HEIGHT)
      gradient.addColorStop(0, '#87CEEB')
      gradient.addColorStop(1, '#228B22')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, COREML_TEST_WIDTH, COREML_TEST_HEIGHT)

      ctx.fillStyle = '#8B4513'
      ctx.fillRect(100, 280, 40, 100)
      ctx.fillStyle = '#FFE4C4'
      ctx.beginPath()
      ctx.arc(120, 265, 20, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = '#333'
      ctx.beginPath()
      ctx.moveTo(300, 100)
      ctx.lineTo(320, 110)
      ctx.lineTo(280, 110)
      ctx.closePath()
      ctx.fill()

      ctx.fillStyle = '#C41E3A'
      ctx.fillRect(400, 350, 120, 50)
      ctx.fillStyle = '#222'
      ctx.beginPath()
      ctx.arc(430, 400, 15, 0, Math.PI * 2)
      ctx.arc(490, 400, 15, 0, Math.PI * 2)
      ctx.fill()

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const rgbaData = Array.from(imageData.data)

      addMessage('info', 'NATIVE DETECTOR TEST: Starte Inferenz...')
      const startTime = performance.now()

      const result = await invoke<NativeDetectionResult>(TAURI_COMMANDS.detection.nativeRaw, {
        rgbaData,
        width: canvas.width,
        height: canvas.height,
        confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
        iouThreshold: DEFAULT_IOU_THRESHOLD,
        maxDetections: DEFAULT_MAX_DETECTIONS,
      })

      const totalTime = performance.now() - startTime

      if (result.success) {
        const detCount = result.detections.length
        const classes = result.detections.map((d) => d.classLabel).join(', ')
        const backendText = result.backend ? ` [${result.backend}]` : ''
        addMessage(
          'success',
          `NATIVE DETECTOR TEST ERFOLGREICH${backendText}: ${detCount} Detektionen in ${result.inferenceTimeMs.toFixed(2)}ms (Gesamt: ${totalTime.toFixed(2)}ms)`
        )
        if (detCount > 0) {
          addMessage('info', `Erkannt: ${classes}`)
        }

        if (onDetectionComplete) {
          onDetectionComplete({
            inferenceTimeMs: result.inferenceTimeMs,
            preprocessTimeMs: result.preprocessTimeMs ?? undefined,
            postprocessTimeMs: result.postprocessTimeMs ?? undefined,
            detectionCount: detCount,
          })
        }
      } else {
        addMessage('error', `NATIVE DETECTOR TEST FEHLER: ${result.error || 'Unbekannter Fehler'}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      addMessage('error', `NATIVE DETECTOR TEST FEHLER: ${message}`)
    } finally {
      setIsTestingCoreML(false)
      void refreshSystemInfo()
    }
  }, [
    addMessage,
    isBenchmarking,
    isTestingCoreML,
    nativeAvailable,
    onDetectionComplete,
    refreshSystemInfo,
  ])

  const cancelCoreMLBenchmark = useCallback(() => {
    if (!isBenchmarking) return
    benchmarkAbortRef.current = true
    addMessage('warning', 'BENCHMARK: Abbruch angefordert')
  }, [addMessage, isBenchmarking])

  const runCoreMLBenchmark = useCallback(async () => {
    if (isTestingCoreML || isBenchmarking) return
    if (!nativeAvailable) {
      addMessage('error', 'NATIVE DETEKTION NUR IN DER DESKTOP-APP VERFÜGBAR (nicht im Browser)')
      return
    }

    const runId = benchmarkRunIdRef.current + 1
    benchmarkRunIdRef.current = runId
    benchmarkAbortRef.current = false

    setIsBenchmarking(true)
    setBenchmarkProgress(0)
    addMessage('info', `BENCHMARK: Starte ${VIEWER_BENCHMARK_ITERATIONS} Inferenzen...`)

    const latencies: number[] = []

    try {
      const canvas = document.createElement('canvas')
      canvas.width = COREML_TEST_WIDTH
      canvas.height = COREML_TEST_HEIGHT
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas context not available')

      const gradient = ctx.createLinearGradient(0, 0, 0, COREML_TEST_HEIGHT)
      gradient.addColorStop(0, '#87CEEB')
      gradient.addColorStop(1, '#228B22')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, COREML_TEST_WIDTH, COREML_TEST_HEIGHT)

      ctx.fillStyle = '#8B4513'
      ctx.fillRect(100, 280, 40, 100)
      ctx.fillStyle = '#FFE4C4'
      ctx.beginPath()
      ctx.arc(120, 265, 20, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#C41E3A'
      ctx.fillRect(400, 350, 120, 50)

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const rgbaData = Array.from(imageData.data)

      addMessage('info', 'BENCHMARK: Aufwärmphase...')
      await invoke<NativeDetectionResult>(TAURI_COMMANDS.detection.nativeRaw, {
        rgbaData,
        width: canvas.width,
        height: canvas.height,
        confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
        iouThreshold: DEFAULT_IOU_THRESHOLD,
        maxDetections: DEFAULT_MAX_DETECTIONS,
      })

      if (benchmarkAbortRef.current) {
        addMessage('warning', 'BENCHMARK: Abgebrochen')
        return
      }

      addMessage('info', `BENCHMARK: Führe ${VIEWER_BENCHMARK_ITERATIONS} Iterationen aus...`)
      const benchmarkStart = performance.now()

      for (let i = 0; i < VIEWER_BENCHMARK_ITERATIONS; i++) {
        if (benchmarkAbortRef.current) break

        const result = await invoke<NativeDetectionResult>(TAURI_COMMANDS.detection.nativeRaw, {
          rgbaData,
          width: canvas.width,
          height: canvas.height,
          confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
          iouThreshold: DEFAULT_IOU_THRESHOLD,
          maxDetections: DEFAULT_MAX_DETECTIONS,
        })

        if (
          result.success &&
          Number.isFinite(result.inferenceTimeMs) &&
          result.inferenceTimeMs >= 0
        ) {
          latencies.push(result.inferenceTimeMs)
        } else {
          addMessage('warning', `BENCHMARK: Iteration ${i + 1} ohne Messwert übersprungen`)
        }

        if (
          (i + 1) % VIEWER_BENCHMARK_PROGRESS_STEP === 0 ||
          i + 1 === VIEWER_BENCHMARK_ITERATIONS
        ) {
          setBenchmarkProgress(((i + 1) / VIEWER_BENCHMARK_ITERATIONS) * 100)
        }
      }

      if (benchmarkAbortRef.current) {
        addMessage('warning', 'BENCHMARK: Abgebrochen')
        return
      }

      if (latencies.length === 0) {
        throw new Error('No successful benchmark measurements')
      }

      const totalTimeMs = performance.now() - benchmarkStart
      const stats = calculateLatencyStats(latencies)
      const mean = stats.mean
      const squaredDiffs = latencies.map((latency) => (latency - mean) ** 2)
      const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / squaredDiffs.length
      const stdDev = Math.sqrt(avgSquaredDiff)
      const throughputFps = totalTimeMs > 0 ? (latencies.length / totalTimeMs) * 1000 : 0

      setBenchmarkProgress(100)
      addMessage('success', '═══════════════════════════════════════')
      addMessage(
        'success',
        `BENCHMARK ERGEBNISSE (${latencies.length}/${VIEWER_BENCHMARK_ITERATIONS} Iterationen)`
      )
      addMessage('success', '═══════════════════════════════════════')
      addMessage('info', `MIN:    ${stats.min.toFixed(2)} ms`)
      addMessage('info', `MAX:    ${stats.max.toFixed(2)} ms`)
      addMessage('info', `MEAN:   ${stats.mean.toFixed(2)} ms`)
      addMessage('info', `MEDIAN: ${stats.p50.toFixed(2)} ms`)
      addMessage('info', `P95:    ${stats.p95.toFixed(2)} ms`)
      addMessage('info', `P99:    ${stats.p99.toFixed(2)} ms`)
      addMessage('info', `STD:    ${stdDev.toFixed(2)} ms`)
      addMessage('success', '───────────────────────────────────────')
      addMessage('tactical', `DURCHSATZ: ${throughputFps.toFixed(1)} FPS`)
      addMessage('tactical', `GESAMT:    ${totalTimeMs.toFixed(0)} ms`)
      addMessage('success', '═══════════════════════════════════════')

      if (onDetectionComplete) {
        onDetectionComplete({
          inferenceTimeMs: stats.mean,
          detectionCount: latencies.length,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      addMessage('error', `BENCHMARK FEHLER: ${message}`)
    } finally {
      if (benchmarkRunIdRef.current === runId) {
        setIsBenchmarking(false)
        setBenchmarkProgress(0)
      }
      void refreshSystemInfo()
    }
  }, [
    addMessage,
    isBenchmarking,
    isTestingCoreML,
    nativeAvailable,
    onDetectionComplete,
    refreshSystemInfo,
  ])

  const detectionCameras = useMemo(
    () => cameras.map((c) => ({ id: c.id, name: c.name, isActive: c.isActive })),
    [cameras]
  )

  useDetectionLoop({
    cameras: detectionCameras,
    exportCameraFeed,
    enabled: nativeAvailable && detectionEnabled && cameras.length > 0,
    intervalMs: 100,
    confidenceThreshold: 0.25,
    onDetection: handleDetection,
    onPerformance: handlePerformance,
    onError: (error) => addMessage('error', `DETEKTION: ${error}`),
  })

  useEffect(() => {
    let animationFrameId: number

    const updateActuators = () => {
      const bridge = getROSBridge()
      if (bridge && bridge.isConnected() && physicsWorld) {
        physicsWorld.getAllDrones().forEach((drone) => {
          const cmds = drone.targetCommands
          const maxRPM = 1100
          bridge.publish(`${drone.id}/cmd/motor_speed/0`, { data: cmds.front_right * maxRPM })
          bridge.publish(`${drone.id}/cmd/motor_speed/1`, { data: cmds.rear_left * maxRPM })
          bridge.publish(`${drone.id}/cmd/motor_speed/2`, { data: cmds.front_left * maxRPM })
          bridge.publish(`${drone.id}/cmd/motor_speed/3`, { data: cmds.rear_right * maxRPM })
        })
      }
      animationFrameId = requestAnimationFrame(updateActuators)
    }

    updateActuators()
    return () => cancelAnimationFrame(animationFrameId)
  }, [physicsWorld])

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
      const camera = cameras.find((c) => c.mesh === object)
      if (camera) {
        removeCamera(camera.id)
        addMessage('system', `${camera.name} ENTFERNT`)
        return
      }

      const drone = managedDrones.find((d) => d.mesh === object)
      if (drone) {
        removeDrone(drone.id)
        addMessage('system', `${drone.name} ENTFERNT`)
        return
      }

      const asset = loadedAssets.find((a) => a.object === object)
      if (asset && sceneRef.current) {
        sceneRef.current.remove(asset.object)
        disposeObject3D(asset.object)
        const nextAssets = loadedAssetsRef.current.filter((entry) => entry.id !== asset.id)
        loadedAssetsRef.current = nextAssets
        setLoadedAssets(nextAssets)
        addMessage('system', `ENTFERNT: ${asset.name}`)
      }
    },
    [cameras, managedDrones, loadedAssets, removeCamera, removeDrone, addMessage]
  )

  const { selectedObjects, primarySelection, clearSelection } = useObjectSelection({
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
    enabled: !cameraPlacementMode,
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
    enabled: !cameraPlacementMode && selectedObjects.length > 0,
  })

  const handleTransformChange = useCallback(
    (object: THREE.Object3D) => {
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
    [cameras, managedDrones, physicsWorld]
  )

  const loadSplat = useCallback(
    async (
      source: File | string | ArrayBuffer,
      name?: string,
      restoredTransform?: SplatSceneState
    ): Promise<boolean> => {
      if (!sceneRef.current) return false
      splatCancellationRef.current?.()
      splatCancellationRef.current = null
      // Bump the load generation: any callback belonging to an older, still
      // in-flight load becomes stale and must not touch the scene or UI.
      const generation = ++splatLoadGenRef.current
      const scene = sceneRef.current
      const isStale = () =>
        !viewerMountedRef.current ||
        sceneRef.current !== scene ||
        splatLoadGenRef.current !== generation
      lastSplatSourceRef.current = source
      lastSplatNameRef.current = name
      const displayName = name || (source instanceof File ? source.name : 'OBJEKT')
      const loadingToken = beginLoading(displayName)

      let loadTimeout: ReturnType<typeof setTimeout> | undefined
      let progressInterval: ReturnType<typeof setInterval> | undefined

      try {
        if (splatMeshRef.current) {
          scene.remove(splatMeshRef.current)
          splatMeshRef.current.dispose?.()
          splatMeshRef.current = null
        }

        let fileBytes: ArrayBuffer

        if (typeof source === 'string') {
          const controller = new AbortController()
          assetAbortControllersRef.current.add(controller)
          const downloadTimeout = setTimeout(
            () => controller.abort(new Error('Asset download timed out')),
            ASSET_DOWNLOAD_TIMEOUT_MS
          )
          try {
            fileBytes = await fetchAssetWithLimit(
              source,
              MAX_SPLAT_BYTES,
              controller.signal,
              (received, total) => {
                if (!isStale() && isLatestLoading(loadingToken)) {
                  setLoadingProgress(total ? Math.round((received / total) * 50) : 25)
                }
              }
            )
          } finally {
            clearTimeout(downloadTimeout)
            assetAbortControllersRef.current.delete(controller)
          }
        } else if (source instanceof File) {
          if (source.size > MAX_SPLAT_BYTES) {
            throw new Error(`Asset exceeds maximum size of ${MAX_SPLAT_BYTES} bytes`)
          }
          fileBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader()
            reader.onprogress = (e) => {
              if (!isStale() && isLatestLoading(loadingToken) && e.lengthComputable) {
                setLoadingProgress(Math.round((e.loaded / e.total) * 50))
              }
            }
            reader.onload = () => resolve(reader.result as ArrayBuffer)
            reader.onerror = () => reject(new Error('File read failed'))
            reader.readAsArrayBuffer(source)
          })
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
        let cancelCurrentLoad: (() => void) | null = null
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
          setLoadingProgress((prev) => {
            if (prev >= 95) return prev
            return prev + Math.random() * 5
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

        const newSplat = new SplatMesh({
          fileBytes,
          fileName: splatFileName,
          ...(perfMaxSplatsRef.current > 0 ? { maxSplats: perfMaxSplatsRef.current } : {}),
          onLoad: () => {
            if (loadSettled) return // timed out or failed already
            clearTimeout(loadTimeout)
            clearInterval(progressInterval)
            // A newer load superseded this one; it already removed/disposed
            // this mesh via splatMeshRef, so just stand down.
            if (isStale()) {
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
                newSplat.updateMatrixWorld(true)
              } else {
                newSplat.updateMatrixWorld(true)
                const lb = newSplat.getBoundingBox(true)
                if (lb && Number.isFinite(lb.min.x) && !lb.isEmpty()) {
                  const wb = lb.clone().applyMatrix4(newSplat.matrixWorld)
                  const center = wb.getCenter(new THREE.Vector3())
                  const size = wb.getSize(new THREE.Vector3())
                  newSplat.position.x -= center.x
                  newSplat.position.z -= center.z
                  newSplat.position.y -= wb.min.y // rest on the grid
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

            setTimeout(() => {
              if (isStale()) return
              setCurrentAsset(displayName)
              addMessage('success', `GELADEN: ${displayName}`)
            }, 300)
            finish(true)
          },
        })
        cancelCurrentLoad = () => {
          if (loadSettled) return
          clearTimeout(loadTimeout)
          clearInterval(progressInterval)
          if (splatMeshRef.current === newSplat) {
            scene.remove(newSplat)
            newSplat.dispose?.()
            splatMeshRef.current = null
          }
          finish(false)
        }
        if (!loadSettled) {
          splatCancellationRef.current = cancelCurrentLoad
          loadTimeout = setTimeout(() => {
            if (loadSettled) return
            cancelCurrentLoad?.()
            if (!isStale()) addMessage('error', `ZEITÜBERSCHREITUNG: ${displayName}`)
          }, 120000)
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
        scene.add(newSplat)
        splatMeshRef.current = newSplat
        // Spark has no onError option; `initialized` rejects on load failure
        // (e.g. unknown splat format), so clean up and surface it from there.
        newSplat.initialized.catch((error: unknown) => {
          if (loadSettled) return
          clearTimeout(loadTimeout)
          clearInterval(progressInterval)
          if (splatMeshRef.current === newSplat) {
            scene.remove(newSplat)
            newSplat.dispose?.()
            splatMeshRef.current = null
          }
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
        finishLoading(loadingToken)
      }
    },
    [addMessage, beginLoading, finishLoading, isLatestLoading]
  )

  const loadGlb = useCallback(
    async (
      source: File | string,
      name?: string,
      restored?: SceneAssetState
    ): Promise<LoadedAsset | null> => {
      if (!sceneRef.current || !glbLoaderRef.current) return null
      const displayName = name || (source instanceof File ? source.name : 'MODELL')
      if (loadedAssetsRef.current.length + pendingAssetLoadsRef.current >= MAX_SCENE_ASSETS) {
        addMessage('error', `FEHLER: MAXIMAL ${MAX_SCENE_ASSETS} GLB-ASSETS PRO SZENE`)
        return null
      }
      pendingAssetLoadsRef.current += 1
      let reservedBytes = 0
      const loadingToken = beginLoading(displayName)
      const reserveBytes = (byteLength: number) => {
        const currentBytes = loadedAssetsRef.current.reduce(
          (total, asset) => total + (asset.byteSize ?? 0),
          0
        )
        if (currentBytes + pendingAssetBytesRef.current + byteLength > MAX_GLB_SCENE_BYTES) {
          throw new Error(`Scene GLB sources exceed ${MAX_GLB_SCENE_BYTES} aggregate bytes`)
        }
        reservedBytes = byteLength
        pendingAssetBytesRef.current += reservedBytes
      }
      const scene = sceneRef.current
      const loader = glbLoaderRef.current
      const generation = assetLoadGenerationRef.current
      const isStale = () =>
        !viewerMountedRef.current ||
        sceneRef.current !== scene ||
        assetLoadGenerationRef.current !== generation

      try {
        const sourcePath = source instanceof File ? source.name : source.split('?')[0]
        if (!sourcePath.toLowerCase().endsWith('.glb')) {
          throw new Error('Only self-contained .glb imports are supported')
        }

        let bytes: ArrayBuffer
        if (source instanceof File) {
          if (source.size > MAX_GLB_BYTES) {
            throw new Error(`Asset exceeds maximum size of ${MAX_GLB_BYTES} bytes`)
          }
          reserveBytes(source.size)
          bytes = await source.arrayBuffer()
        } else {
          const controller = new AbortController()
          assetAbortControllersRef.current.add(controller)
          const timeout = setTimeout(
            () => controller.abort(new Error('Asset download timed out')),
            ASSET_DOWNLOAD_TIMEOUT_MS
          )
          try {
            bytes = await fetchAssetWithLimit(source, MAX_GLB_BYTES, controller.signal)
          } finally {
            clearTimeout(timeout)
            assetAbortControllersRef.current.delete(controller)
          }
        }
        if (isStale()) return null

        if (!(source instanceof File)) reserveBytes(bytes.byteLength)
        validateSelfContainedGlb(bytes)

        const gltf = await new Promise<GLTF>((resolve, reject) => {
          loader.parse(bytes, '', resolve, reject)
        })
        const model = gltf.scene
        if (isStale()) {
          disposeObject3D(model)
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
        scene.add(model)
        const asset: LoadedAsset = {
          id: assetId,
          name: displayName,
          type: 'glb',
          object: model,
          source: typeof source === 'string' ? source : undefined,
          byteSize: bytes.byteLength,
        }
        setLoadedAssets((previous) => {
          const next = [...previous, asset]
          loadedAssetsRef.current = next
          return next
        })
        addMessage('success', `GELADEN: ${displayName}`)
        return asset
      } catch (error) {
        if (!isStale()) {
          addMessage('error', `FEHLER: ${error instanceof Error ? error.message : 'Unbekannt'}`)
        }
        return null
      } finally {
        pendingAssetLoadsRef.current = Math.max(0, pendingAssetLoadsRef.current - 1)
        pendingAssetBytesRef.current = Math.max(0, pendingAssetBytesRef.current - reservedBytes)
        finishLoading(loadingToken)
      }
    },
    [addMessage, beginLoading, finishLoading]
  )

  const loadFloorTexture = useCallback(
    async (source: File | string, name?: string): Promise<void> => {
      if (!sceneRef.current) return
      const displayName = name || (source instanceof File ? source.name : 'BODEN')
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
        const bitmap = await createImageBitmap(new Blob([bytes]))
        if (isStale()) {
          bitmap.close()
          return
        }
        const texture = new THREE.Texture(bitmap)
        texture.needsUpdate = true
        texture.colorSpace = THREE.SRGBColorSpace
        texture.wrapS = THREE.RepeatWrapping
        texture.wrapT = THREE.RepeatWrapping

        const aspect = width / height
        const size = 200
        if (floorMeshRef.current) {
          scene.remove(floorMeshRef.current)
          disposeObject3D(floorMeshRef.current)
        }

        const geometry = new THREE.PlaneGeometry(size * aspect, size)
        geometry.rotateX(-Math.PI / 2)
        const material = new THREE.MeshStandardMaterial({
          map: texture,
          roughness: 0.8,
          metalness: 0.2,
        })
        const mesh = new THREE.Mesh(geometry, material)
        mesh.position.y = -0.05
        mesh.receiveShadow = true
        mesh.userData.isFloor = true
        scene.add(mesh)
        floorMeshRef.current = mesh

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
    [addMessage, beginLoading, finishLoading]
  )

  const handleSetFloorType = useCallback(
    (type: FloorStyle) => {
      if (!sceneRef.current) return
      floorLoadGenerationRef.current += 1
      floorAbortControllerRef.current?.abort(new Error('Floor texture replaced'))
      floorAbortControllerRef.current = null
      if (floorLoadingTokenRef.current) {
        finishLoading(floorLoadingTokenRef.current)
        floorLoadingTokenRef.current = null
      }

      if (floorMeshRef.current) {
        sceneRef.current.remove(floorMeshRef.current)
        disposeObject3D(floorMeshRef.current)
        floorMeshRef.current = null
      }

      let mesh: THREE.Mesh
      if (type === 'terrain') {
        mesh = createTerrainMesh()
      } else {
        mesh = createProceduralFloor(type)
      }

      sceneRef.current.add(mesh)
      floorMeshRef.current = mesh
      addMessage('success', `BODEN: ${type.toUpperCase()}`)
    },
    [addMessage, finishLoading]
  )

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const files = Array.from(e.target.files ?? [])
      e.target.value = ''
      if (files.length === 0) return
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
    [loadSplat, loadGlb, loadFloorTexture, addMessage]
  )

  const resetCamera = useCallback(() => {
    if (!cameraRef.current || !controlsRef.current) return
    cameraRef.current.position.set(0, 1.6, 5)
    controlsRef.current.target.set(0, 0, 0)
    velocity.current.set(0, 0, 0)
    controlsRef.current.update()
    addMessage('system', 'ANSICHT ZURÜCKGESETZT')
  }, [addMessage])

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
      if (
        (!cameraPlacementMode && !dronePlacementMode) ||
        !containerRef.current ||
        !sceneRef.current ||
        !cameraRef.current
      )
        return
      const rect = containerRef.current.getBoundingClientRect()
      mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      mouseRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
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
    [cameraPlacementMode, dronePlacementMode, placeCamera, spawnDrone, addMessage]
  )

  useEffect(() => {
    if (!containerRef.current) return
    viewerMountedRef.current = true
    const container = containerRef.current
    const assetAbortControllers = assetAbortControllersRef.current
    const width = container.clientWidth
    const height = container.clientHeight

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
      const deltaTime = Math.min((now - lastFrameTime.current) / 1000, 0.1)
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

      const isMoving = targetVelocity.length() > 0.001
      const accelRate = isMoving ? cfg.acceleration : cfg.deceleration
      velocityDiff.subVectors(targetVelocity, velocity.current)
      const maxDelta = accelRate * deltaTime

      if (velocityDiff.length() <= maxDelta) {
        velocity.current.copy(targetVelocity)
      } else {
        velocity.current.addScaledVector(velocityDiff.normalize(), maxDelta)
      }

      if (velocity.current.length() > cfg.maxVelocity) {
        velocity.current.normalize().multiplyScalar(cfg.maxVelocity)
      }

      if (velocity.current.length() > 0.001) {
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
      const w = container.clientWidth
      const h = container.clientHeight
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
      mouseRef.current.x = ((event.clientX - containerRect.left) / containerRect.width) * 2 - 1
      mouseRef.current.y = -((event.clientY - containerRect.top) / containerRect.height) * 2 + 1
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
      for (const controller of assetAbortControllers) controller.abort()
      assetAbortControllers.clear()
      // Dispose floor mesh if it exists
      if (floorMeshRef.current) {
        disposeObject3D(floorMeshRef.current)
        floorMeshRef.current = null
      }
      // Dispose tactical grid (ShaderMaterial + 2000x2000 PlaneGeometry)
      if (gridRef.current) {
        scene.remove(gridRef.current)
        disposeObject3D(gridRef.current)
        gridRef.current = null
      }
      // Dispose grid label sprites (each owns a SpriteMaterial + CanvasTexture map)
      if (gridLabelsRef.current) {
        gridLabelsRef.current.traverse((obj) => {
          const sprite = obj as THREE.Sprite
          if (sprite.isSprite) {
            sprite.material.map?.dispose()
            sprite.material.dispose()
          }
        })
        scene.remove(gridLabelsRef.current)
        gridLabelsRef.current = null
      }
      // Dispose ghost drone preview mesh
      scene.remove(ghostDroneRef)
      ghostDroneGeometry.dispose()
      ghostDroneMaterial.dispose()
      if (splatMeshRef.current) {
        scene.remove(splatMeshRef.current)
        splatMeshRef.current.dispose?.()
        splatMeshRef.current = null
      }
      for (const asset of loadedAssetsRef.current) {
        scene.remove(asset.object)
        disposeObject3D(asset.object)
      }
      loadedAssetsRef.current = []
      for (const surveillanceCamera of camerasRef.current) {
        disposeSurveillanceCamera(scene, surveillanceCamera)
      }
      camerasRef.current = []
      controls.dispose()
      renderer.dispose()
      // Release the WebGL context so the GPU frees all uploaded buffers/textures
      // (grid, splat, camera render targets, loaded GLBs) that the mount-time
      // closure cannot reach. Critical under StrictMode double-invoke.
      renderer.forceContextLoss()
      container.removeChild(renderer.domElement)
      sceneRef.current = null
      cameraRef.current = null
      rendererRef.current = null
      controlsRef.current = null
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
  }, [resetCamera, focusOnContent, cycleCamera, addMessage, clearSelection, loadSplat])

  useEffect(() => {
    if (!cameraPlacementMode && !dronePlacementMode) return
    const container = containerRef.current
    if (!container) return
    container.addEventListener('click', handleSceneClick)
    return () => container.removeEventListener('click', handleSceneClick)
  }, [cameraPlacementMode, dronePlacementMode, handleSceneClick])

  useEffect(() => {
    if (!rendererRef.current || !sceneRef.current || cameras.length === 0) return
    const renderer = rendererRef.current
    const scene = sceneRef.current
    let isUpdating = false
    let lastPatrolTime = performance.now()

    const updateFeeds = () => {
      if (isUpdating) return
      isUpdating = true

      const now = performance.now()
      const patrolDt = Math.min((now - lastPatrolTime) / 1000, 0.5)
      lastPatrolTime = now

      try {
        const activeCameras = cameras.filter((c) => c.isActive)
        if (activeCameras.length === 0) return

        const currentRT = renderer.getRenderTarget()

        for (const cam of activeCameras) {
          if (cam.type === 'patrol' && cam.patrolPoints && cam.patrolPoints.length >= 2) {
            const patrolIndex = cam.patrolIndex ?? 0
            const patrolSpeed = cam.patrolSpeed ?? DEFAULT_PATROL_SPEED
            const end = cam.patrolPoints[(patrolIndex + 1) % cam.patrolPoints.length]

            // Frame-rate-independent lerp: convert per-frame factor to time-based
            const lerpFactor = 1 - Math.pow(1 - patrolSpeed, patrolDt * 60)
            cam.camera.position.lerp(end, lerpFactor)
            cam.mesh.position.copy(cam.camera.position)

            if (cam.camera.position.distanceTo(end) < PATROL_ARRIVAL_THRESHOLD) {
              cam.patrolIndex = (patrolIndex + 1) % cam.patrolPoints.length
            }

            const start = cam.patrolPoints[patrolIndex]
            const scratch = patrolScratchVec.current
            scratch.subVectors(end, start).normalize()

            if (scratch.lengthSq() > 0.000001) {
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
        renderer.setRenderTarget(rrCam.renderTarget)
        renderer.render(scene, rrCam.camera)
        renderer.setRenderTarget(currentRT)
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
  }, [cameras, showCameraFeeds])

  useEffect(() => {
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
          if (file.name === 'maverick-drone.glb') {
            addMessage('tactical', 'MAVERICK-DROHNE ERKANNT: INITIIERE SYSTEM...')

            const id = await spawnDrone('maverick', 'Maverick-Sim')
            if (!id || !physicsWorld) {
              addMessage('error', 'REACT SPAWN FEHLGESCHLAGEN')
              return
            }

            const reactDrone = physicsWorld.getDrone(id)
            if (!reactDrone) return
            const pos = reactDrone.state.position
            const quat = reactDrone.state.orientation

            const controller = getGazeboController()
            if (controller.isConnected()) {
              addMessage('info', 'SPAWNE GAZEBO MODEL...')
              const success = await controller.spawnBundledMaverick(id, {
                position: { x: pos.x, y: pos.y, z: pos.z },
                orientation: { x: quat.x, y: quat.y, z: quat.z, w: quat.w },
              })
              if (success) {
                addMessage('success', 'GAZEBO: SPAWN ERFOLGREICH')
              } else {
                addMessage('error', 'GAZEBO: SPAWN FEHLGESCHLAGEN')
              }
            } else {
              addMessage('warning', 'GAZEBO NICHT VERBUNDEN: NUR LOKALE SIMULATION')
            }
            continue
          }

          if (isSplatFormat(file.name)) await loadSplat(file, file.name)
          else if (isGlbFormat(file.name)) await loadGlb(file, file.name)
          else if (/\.(jpg|jpeg|png)$/i.test(file.name)) await loadFloorTexture(file, file.name)
          else addMessage('warning', `NICHT UNTERSTÜTZT: ${file.name}`)
        }
        return
      }
      const droppedText = e.dataTransfer?.getData('text/plain')
      if (droppedText) {
        const filename = droppedText.split('/').pop() || 'Asset'
        if (isSplatFormat(droppedText)) await loadSplat(droppedText, filename)
        else if (isGlbFormat(droppedText)) await loadGlb(droppedText, filename)
        else if (/\.(jpg|jpeg|png)$/i.test(droppedText))
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
  }, [loadSplat, loadGlb, loadFloorTexture, spawnDrone, physicsWorld, addMessage])

  const createSceneSnapshot = useCallback(
    (sceneName: string): SceneState => {
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
      const restoreGeneration = ++sceneRestoreGenerationRef.current
      let restoreTimedOut = false
      const isCurrentRestore = () =>
        !restoreTimedOut &&
        viewerMountedRef.current &&
        sceneRestoreGenerationRef.current === restoreGeneration
      const assertCurrentRestore = () => {
        if (restoreTimedOut) throw new Error('Scene restore timed out')
        if (!isCurrentRestore()) throw new Error('Scene restore was superseded')
      }
      const failures: string[] = []

      // Supersede every pending asset operation from the previous scene before
      // clearing its objects. Fetches are abortable; loader callbacks also gate
      // on the generation below.
      assetLoadGenerationRef.current += 1
      for (const controller of assetAbortControllersRef.current) controller.abort()
      assetAbortControllersRef.current.clear()
      splatLoadGenRef.current += 1
      cancelLoadingOperations()

      clearSelection()
      setCameraPlacementMode(null)
      setDronePlacementMode(false)
      setSimulationPaused(true)
      clearAllCameras()
      cameraCounterRef.current = { static: 0, ptz: 0, patrol: 0 }
      for (const camera of state.cameras) {
        const restoredCamera = placeCamera(
          new THREE.Vector3(camera.position.x, camera.position.y, camera.position.z),
          camera.type,
          camera
        )
        if (!restoredCamera) failures.push(`camera ${camera.name}`)
      }
      setSelectedCamera(state.activeCameraId ?? null)

      resetSimulation(true)

      const previousAssets = loadedAssetsRef.current
      for (const asset of previousAssets) {
        sceneRef.current?.remove(asset.object)
        disposeObject3D(asset.object)
      }
      loadedAssetsRef.current = []
      setLoadedAssets([])
      if (splatMeshRef.current) {
        sceneRef.current?.remove(splatMeshRef.current)
        splatMeshRef.current.dispose?.()
        splatMeshRef.current = null
      }
      lastSplatSourceRef.current = null
      lastSplatNameRef.current = undefined
      setCurrentAsset(null)

      const restoreTimeout = setTimeout(() => {
        if (!isCurrentRestore()) return
        restoreTimedOut = true
        assetLoadGenerationRef.current += 1
        splatLoadGenRef.current += 1
        for (const controller of assetAbortControllersRef.current) controller.abort()
        assetAbortControllersRef.current.clear()
        splatCancellationRef.current?.()
        splatCancellationRef.current = null
        cancelLoadingOperations()
      }, SCENE_RESTORE_TIMEOUT_MS)

      try {
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
              velocity: new THREE.Vector3(drone.velocity.x, drone.velocity.y, drone.velocity.z),
              angularVelocity: new THREE.Vector3(
                drone.angularVelocity.x,
                drone.angularVelocity.y,
                drone.angularVelocity.z
              ),
              armed: drone.armed,
              battery: drone.battery / 100,
            }
          )
          assertCurrentRestore()
          if (!restoredId) {
            failures.push(`drone ${drone.name ?? drone.id}`)
            addMessage('error', `DROHNE KONNTE NICHT GELADEN WERDEN: ${drone.name ?? drone.id}`)
            continue
          }
          const waypoints = (drone.waypoints ?? []).map((waypoint) => ({
            position: new THREE.Vector3(waypoint.x, waypoint.y, waypoint.z),
            altitude: waypoint.y,
          }))
          setRoute(restoredId, waypoints, drone.routeMode ?? (waypoints.length ? 'once' : 'none'), {
            isActive: drone.routeActive,
            currentWaypointIndex: drone.routeCurrentWaypointIndex,
          })
        }

        const detections = new Map<string, Detection[]>()
        const cameraIds = new Set(state.cameras.map((camera) => camera.id))
        for (const detection of state.recentDetections) {
          if (!cameraIds.has(detection.cameraId)) continue
          const cameraDetections = detections.get(detection.cameraId) ?? []
          cameraDetections.push({
            id: detection.id,
            class: detection.class as Detection['class'],
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

        assertCurrentRestore()
        for (const asset of state.assets ?? []) {
          const loaded = await loadGlb(asset.source, asset.name, asset)
          assertCurrentRestore()
          if (!loaded) failures.push(`asset ${asset.name}`)
        }
        if (state.splatScene?.url) {
          const loaded = await loadSplat(state.splatScene.url, undefined, state.splatScene)
          assertCurrentRestore()
          if (!loaded) failures.push('splat scene')
        }

        setDetectionEnabled(state.settings.detectionEnabled)
        setShowDetectionPanel(state.settings.showDetectionPanel)
        onPerformancePanelVisibleChange?.(state.settings.showPerformancePanel)
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
      } finally {
        clearTimeout(restoreTimeout)
        if (isCurrentRestore()) {
          setSimulationPaused(!state.settings.physicsEnabled)
        }
      }

      if (failures.length > 0) {
        throw new Error(`Scene restored with failures: ${failures.join(', ')}`)
      }
    },
    [
      addMessage,
      cancelLoadingOperations,
      clearAllCameras,
      clearSelection,
      loadGlb,
      loadSplat,
      onPerformancePanelVisibleChange,
      placeCamera,
      physicsReady,
      resetSimulation,
      setRoute,
      setSimulationPaused,
      spawnDrone,
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
  const backendStatusText =
    systemInfo.backend === 'Unknown' || systemInfo.backend.toLowerCase().includes('no backend')
      ? 'UNBEKANNT'
      : 'BEREIT'
  const backendStatusColor = backendStatusText === 'BEREIT' ? 'bg-[#3a6b4a]' : 'bg-[#a08040]'
  const backendModeText = systemInfo.mode !== 'unknown' ? systemInfo.mode : 'UNBEKANNT'
  const cryptoStatusText = 'NICHT KONFIG.'
  const modelStatusText = 'VERTRAG OFFEN'

  return (
    <div
      className="relative w-full h-full bg-[#0a0a0a] font-mono overflow-hidden select-none text-[#b0b0b0]"
      style={cssVar as React.CSSProperties}
      aria-busy={isLoading}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".spz,.ply,.splat,.ksplat,.glb,.jpg,.jpeg,.png"
        multiple
        onChange={(event) => void handleFileSelect(event)}
        className="hidden"
      />

      <div
        ref={containerRef}
        className={`w-full h-full ${cameraPlacementMode ? 'cursor-crosshair' : isDragging3D ? 'cursor-grabbing' : 'cursor-grab active:cursor-grabbing'}`}
        tabIndex={0}
      />

      {/* DRONE SPAWN PANEL */}
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

      {/* SAVE/LOAD PANEL */}
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

      {/* 3D OBJECT TRANSFORM CONTROLS */}
      {primarySelection && (
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
        threatLevel={threatLevel}
        onThreatLevelChange={setThreatLevel}
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
        className="fixed z-40 w-60"
        style={{
          left: `${controlPanelDrag.position.x}px`,
          top: `${controlPanelDrag.position.y}px`,
          cursor: controlPanelDrag.isDragging ? 'grabbing' : undefined,
          fontSize: `calc(8px * var(--ui-scale, 1))`,
        }}
        onMouseDown={controlPanelDrag.handleMouseDown}
      >
        <div className="bg-[#0c0c0c] border border-[#1a1a1a]">
          <div
            data-drag-handle
            className="h-7 border-b border-[#1a1a1a] flex items-center justify-between px-3 bg-[#101010] cursor-grab select-none"
            onClick={handleControlPanelHeaderClick}
          >
            <span className="text-[0.875em] text-[#909090] tracking-[0.2em]">STEUERUNG</span>
            <button className="text-[#505050] hover:text-[#707070]">
              {showControlPanel ? '▼' : '▶'}
            </button>
          </div>

          {showControlPanel && (
            <>
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
                              onClick={() =>
                                setSelectedCamera(selectedCamera === cam.id ? null : cam.id)
                              }
                              className={`group flex items-center gap-2 px-2 py-1.5 cursor-pointer transition-all border ${selectedCamera === cam.id ? 'border-[#505050] bg-[#141414]' : 'border-[#1a1a1a] bg-[#0c0c0c] hover:border-[#303030]'}`}
                            >
                              <div
                                className={`w-1.5 h-1.5 ${cam.isActive ? 'bg-[#3a6b4a]' : 'bg-[#303030]'}`}
                              />
                              <div className="flex-1">
                                {editingCameraId === cam.id ? (
                                  <input
                                    type="text"
                                    value={editingCameraName}
                                    onChange={(e) => setEditingCameraName(e.target.value)}
                                    onBlur={() => {
                                      if (editingCameraName.trim()) {
                                        renameCamera(cam.id, editingCameraName.trim())
                                      }
                                      setEditingCameraId(null)
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        if (editingCameraName.trim()) {
                                          renameCamera(cam.id, editingCameraName.trim())
                                        }
                                        setEditingCameraId(null)
                                      } else if (e.key === 'Escape') {
                                        setEditingCameraId(null)
                                      }
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    autoFocus
                                    className="bg-[#0a0a0a] border border-[#505050] text-[#d0d0d0] px-1 py-0 w-full text-[1em]"
                                  />
                                ) : (
                                  <div
                                    className={`text-[1em] ${selectedCamera === cam.id ? 'text-[#d0d0d0]' : 'text-[#808080]'}`}
                                    onDoubleClick={(e) => {
                                      e.stopPropagation()
                                      setEditingCameraId(cam.id)
                                      setEditingCameraName(cam.name)
                                    }}
                                    title="Doppelklick zum Umbenennen"
                                  >
                                    {cam.name}
                                  </div>
                                )}
                                <div className="text-[0.75em] text-[#505050]">
                                  {cam.type.toUpperCase()}
                                </div>
                              </div>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  removeCamera(cam.id)
                                }}
                                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-[#1a1a1a]"
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

                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isLoading}
                      className="w-full py-2 bg-[#101010] border border-[#252525] text-[1em] text-[#707070] hover:border-[#404040] hover:text-[#a0a0a0] disabled:opacity-50 transition-all"
                    >
                      DATEI LADEN
                    </button>
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
                                onClick={() => {
                                  if (splatMeshRef.current && sceneRef.current) {
                                    sceneRef.current.remove(splatMeshRef.current)
                                    splatMeshRef.current.dispose?.()
                                    splatMeshRef.current = null
                                    // Drop the reload source too, or perf-mode
                                    // reload would resurrect the removed asset
                                    // (and pin its File/ArrayBuffer in memory).
                                    lastSplatSourceRef.current = null
                                    lastSplatNameRef.current = undefined
                                    setCurrentAsset(null)
                                    addMessage('system', 'ENTFERNT')
                                  }
                                }}
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
                                  if (sceneRef.current) {
                                    clearSelection()
                                    sceneRef.current.remove(asset.object)
                                    disposeObject3D(asset.object)
                                    const nextAssets = loadedAssetsRef.current.filter(
                                      (entry) => entry.id !== asset.id
                                    )
                                    loadedAssetsRef.current = nextAssets
                                    setLoadedAssets(nextAssets)
                                    addMessage('system', `ENTFERNT: ${asset.name}`)
                                  }
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
                            disabled={!nativeAvailable}
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
                          disabled={isTestingCoreML || isBenchmarking || !nativeAvailable}
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
                            disabled={isTestingCoreML || isBenchmarking || !nativeAvailable}
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
                          rosbridge: <span className="text-[#3a6b4a]">BEREIT</span>
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
            </>
          )}
        </div>
      </div>

      {/* RECHTES PANEL */}
      {selectedCameraData && (
        <div
          className="absolute top-[68px] right-3 w-52 z-40"
          style={{ fontSize: `calc(8px * var(--ui-scale, 1))` }}
        >
          <div className="bg-[#0c0c0c] border border-[#1a1a1a]">
            <div className="h-7 border-b border-[#1a1a1a] flex items-center justify-between px-3 bg-[#101010]">
              <span className="text-[1em] text-[#c0c0c0]">{selectedCameraData.name}</span>
              <div className="flex items-center gap-2">
                <div
                  className={`w-1.5 h-1.5 ${selectedCameraData.isRecording ? 'bg-[#8b4a4a] animate-pulse' : 'bg-[#303030]'}`}
                />
                <button
                  onClick={() => void downloadCameraFeed(selectedCameraData.id)}
                  className="px-2 py-0.5 bg-[#101010] border border-[#252525] text-[0.75em] text-[#707070] hover:border-[#404040] hover:text-[#a0a0a0]"
                >
                  EXPORT
                </button>
              </div>
            </div>
            {selectedCameraData.type === 'ptz' && (
              <div className="p-3 space-y-3">
                {[
                  {
                    label: 'SCHWENK',
                    value: selectedCameraData.pan,
                    min: -180,
                    max: 180,
                    key: 'pan',
                  },
                  {
                    label: 'NEIGUNG',
                    value: selectedCameraData.tilt,
                    min: -85,
                    max: 85,
                    key: 'tilt',
                  },
                  { label: 'ZOOM', value: selectedCameraData.zoom, min: 5, max: 120, key: 'zoom' },
                ].map((control) => (
                  <div key={control.key}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[0.75em] text-[#606060]">{control.label}</span>
                      <span className="text-[0.875em] text-[#a0a0a0]">
                        {control.value.toFixed(0)}°
                      </span>
                    </div>
                    <input
                      type="range"
                      min={control.min}
                      max={control.max}
                      value={control.value}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value)
                        if (control.key === 'pan') updateCameraPTZ(selectedCameraData.id, val)
                        else if (control.key === 'tilt')
                          updateCameraPTZ(selectedCameraData.id, undefined, val)
                        else updateCameraPTZ(selectedCameraData.id, undefined, undefined, val)
                      }}
                      className="w-full h-1 bg-[#1a1a1a] rounded-none appearance-none cursor-pointer [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-[#606060] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:border-0"
                    />
                  </div>
                ))}
              </div>
            )}
            {selectedCameraData.type !== 'ptz' && (
              <div className="p-3 text-[0.875em] text-[#606060]">
                <div>
                  Position:{' '}
                  <span className="text-[#a0a0a0]">
                    {selectedCameraData.camera.position.x.toFixed(1)},{' '}
                    {selectedCameraData.camera.position.y.toFixed(1)},{' '}
                    {selectedCameraData.camera.position.z.toFixed(1)}
                  </span>
                </div>
                <div className="mt-1">
                  Status:{' '}
                  <span className="text-[#3a6b4a]">
                    {selectedCameraData.type === 'patrol' ? 'PATROUILLE' : 'ÜBERWACHUNG'}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

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

      {/* KAMERA-FEEDS */}
      {cameras.length > 0 && showCameraFeeds && (
        <div
          className="absolute bottom-12 right-3 z-40"
          style={{ fontSize: `calc(8px * var(--ui-scale, 1))` }}
        >
          <div className="flex items-center justify-between mb-1 px-1">
            <span className="text-[0.75em] text-[#707070] tracking-wider">LIVE</span>
            <button
              onClick={() => setShowCameraFeeds(false)}
              className="text-[0.75em] text-[#404040] hover:text-[#808080]"
            >
              AUSBLENDEN
            </button>
          </div>
          <div className="flex gap-1 flex-wrap justify-end max-w-sm">
            {cameras.slice(0, 4).map((cam) => (
              <div
                key={cam.id}
                onClick={() => setSelectedCamera(cam.id)}
                className={`relative cursor-pointer border transition-all ${selectedCamera === cam.id ? 'border-[#505050]' : 'border-[#1a1a1a] hover:border-[#303030]'}`}
              >
                {/* Bitmap matches the 640x360 render target so putImageData and
                    detection overlays land 1:1; CSS scales it to thumbnail size. */}
                <canvas
                  ref={(el) => {
                    if (el) feedCanvasRefs.current.set(cam.id, el)
                    else feedCanvasRefs.current.delete(cam.id)
                  }}
                  width={640}
                  height={360}
                  className="bg-black block w-[140px] h-[79px]"
                />
                <div className="absolute inset-0 pointer-events-none">
                  <div
                    className={`absolute top-0 left-0 w-2 h-2 border-t border-l ${selectedCamera === cam.id ? 'border-[#505050]' : 'border-[#303030]'}`}
                  />
                  <div
                    className={`absolute top-0 right-0 w-2 h-2 border-t border-r ${selectedCamera === cam.id ? 'border-[#505050]' : 'border-[#303030]'}`}
                  />
                  <div
                    className={`absolute bottom-0 left-0 w-2 h-2 border-b border-l ${selectedCamera === cam.id ? 'border-[#505050]' : 'border-[#303030]'}`}
                  />
                  <div
                    className={`absolute bottom-0 right-0 w-2 h-2 border-b border-r ${selectedCamera === cam.id ? 'border-[#505050]' : 'border-[#303030]'}`}
                  />
                  {cam.isRecording && (
                    <div className="absolute top-1 right-1">
                      <div className="w-1.5 h-1.5 bg-[#8b4a4a] animate-pulse" />
                    </div>
                  )}
                  <div className="absolute bottom-0 left-0 right-0 h-3 bg-gradient-to-t from-black/80 to-transparent flex items-end px-1 pb-0.5">
                    <span className="text-[0.625em] text-[#808080]">{cam.name}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!showCameraFeeds && cameras.length > 0 && (
        <button
          onClick={() => setShowCameraFeeds(true)}
          className="absolute bottom-12 right-3 z-40 px-2 py-1 bg-[#0c0c0c] border border-[#252525] text-[0.875em] text-[#606060] hover:border-[#404040] hover:text-[#909090]"
        >
          FEEDS ({cameras.length})
        </button>
      )}

      {/* PROTOKOLL */}
      <div
        className="absolute bottom-12 left-3 z-40 w-64"
        style={{ fontSize: `calc(8px * var(--ui-scale, 1))` }}
      >
        <div className="text-[0.625em] text-[#505050] tracking-wider mb-1 px-1">PROTOKOLL</div>
        <div className="space-y-0.5 max-h-20 overflow-y-auto">
          {consoleMessages.map((msg) => (
            <div
              key={msg.id}
              className={`px-2 py-1 text-[0.875em] bg-[#0c0c0c] border-l-2 ${
                msg.type === 'success'
                  ? 'border-[#3a6b4a] text-[#6a9a7a]'
                  : msg.type === 'error'
                    ? 'border-[#8b4a4a] text-[#a06060]'
                    : msg.type === 'warning'
                      ? 'border-[#a08040] text-[#a08040]'
                      : msg.type === 'tactical'
                        ? 'border-[#3a6b4a] text-[#808080]'
                        : 'border-[#303030] text-[#707070]'
              }`}
            >
              <span className="text-[#404040] text-[0.625em]">
                {new Date(msg.timestamp).toISOString().slice(11, 19)}
              </span>{' '}
              {msg.message}
            </div>
          ))}
        </div>
      </div>

      {/* FUßZEILE */}
      <div
        className="absolute bottom-0 left-0 right-0 h-9 z-30 bg-[#0a0a0a] border-t border-[#1a1a1a] flex items-center justify-between px-4"
        style={{ fontSize: `calc(8px * var(--ui-scale, 1))` }}
      >
        <div className="flex items-center gap-4 text-[0.75em] text-[#505050] tracking-wider">
          <span>
            NAV: <span className="text-[#707070]">WASD</span>
          </span>
          <span>
            VERT: <span className="text-[#707070]">Q/E</span>
          </span>
          <span>
            ROT: <span className="text-[#707070]">Z/X/←/→</span>
          </span>
          <span>
            SPRINT: <span className="text-[#707070]">⇧</span>
          </span>
          <span>
            PRÄZ: <span className="text-[#707070]">⌃</span>
          </span>
          <span>
            STOP: <span className="text-[#707070]">␣</span>
          </span>
          <span className="text-[#303030]">│</span>
          <span>
            CAM: <span className="text-[#707070]">1/2/3</span>
          </span>
          <span>
            WECHS: <span className="text-[#707070]">⇥</span>
          </span>
          <span>
            FEEDS: <span className="text-[#707070]">V</span>
          </span>
          <span>
            DETEK: <span className="text-[#707070]">T</span>
          </span>
          <span className="text-[#303030]">│</span>
          <span>
            RESET: <span className="text-[#707070]">R</span>
          </span>
          <span>
            FOKUS: <span className="text-[#707070]">F</span>
          </span>
          <span>
            LADEN: <span className="text-[#707070]">⌃O</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={togglePause}
            className={`px-2 py-1 border text-[0.875em] transition-all ${isPaused ? 'bg-[#1a3a1a] border-[#3a6b4a] text-[#3a6b4a]' : 'bg-[#101010] border-[#252525] text-[#606060] hover:border-[#404040] hover:text-[#909090]'}`}
          >
            {isPaused ? '▶ START SIM' : '⏸ PAUSE'}
          </button>
          <button
            onClick={() => {
              resetSimulation()
              addMessage('system', 'SIMULATION ZURÜCKGESETZT')
            }}
            className="px-2 py-1 bg-[#101010] border border-[#252525] text-[0.875em] text-[#606060] hover:border-[#404040] hover:text-[#909090] transition-all"
          >
            SIM-RESET
          </button>
          <button
            onClick={() => setShowCameraFeeds((prev) => !prev)}
            className={`px-2 py-1 border text-[0.875em] transition-all ${showCameraFeeds ? 'bg-[#1a2a1a] border-[#3a6b4a] text-[#3a6b4a]' : 'bg-[#101010] border-[#252525] text-[#606060] hover:border-[#404040] hover:text-[#909090]'}`}
          >
            FEEDS
          </button>
          <button
            onClick={resetCamera}
            className="px-2 py-1 bg-[#101010] border border-[#252525] text-[0.875em] text-[#606060] hover:border-[#404040] hover:text-[#909090] transition-all"
          >
            CAM-RESET
          </button>
          <button
            onClick={focusOnContent}
            className="px-2 py-1 bg-[#101010] border border-[#252525] text-[0.875em] text-[#606060] hover:border-[#404040] hover:text-[#909090] transition-all"
          >
            FOKUS
          </button>
        </div>
      </div>

      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="absolute inset-0 border-2 border-dashed border-[#404040] bg-black/30" />
          <div className="px-6 py-3 bg-[#0c0c0c] border border-[#404040] text-[#909090] text-[1.125em] tracking-wider">
            DATEI ABLEGEN
          </div>
        </div>
      )}

      {isLoading && (
        <div
          role="status"
          aria-live="polite"
          className="absolute top-24 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 px-6 py-3 bg-[#0c0c0c] border border-[#252525] min-w-[240px]"
        >
          <div className="flex items-center gap-3 w-full">
            <div
              aria-hidden="true"
              className="w-2 h-2 border border-[#808080] border-t-transparent animate-spin motion-reduce:animate-none"
            />
            <span className="text-[#808080] text-[1em] flex-1">
              {loadingStage === 'reading' && 'LESEN'}
              {loadingStage === 'processing' && 'VERARBEITEN'}
              {loadingStage === 'rendering' && 'RENDERN'}:{' '}
              <span className="text-[#a0a0a0]">{loadingName}</span>
            </span>
            <span className="text-[#606060] text-[1em]">{Math.round(loadingProgress)}%</span>
          </div>
          <div className="w-full h-1 bg-[#1a1a1a] rounded overflow-hidden">
            <div
              className="h-full bg-[#3a6b4a] transition-[width] duration-200 motion-reduce:transition-none"
              style={{ width: `${loadingProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Corner accents */}
      <div className="absolute top-0 left-0 w-10 h-10 pointer-events-none border-t border-l border-[#252525]" />
      <div className="absolute top-0 right-0 w-10 h-10 pointer-events-none border-t border-r border-[#252525]" />
      <div className="absolute bottom-0 left-0 w-10 h-10 pointer-events-none border-b border-l border-[#252525]" />
      <div className="absolute bottom-0 right-0 w-10 h-10 pointer-events-none border-b border-r border-[#252525]" />
    </div>
  )
}
