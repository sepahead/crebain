import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import * as THREE from 'three'
import { SplatMesh } from '@sparkjsdev/spark'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { SensorFusion, type FusionStats } from '../detection/SensorFusion'
import type { CoreMLDetectionResult, Detection, FusedTrack, CameraParams } from '../detection/types'
import { drawDetectionsOnCanvas } from './DetectionOverlay'
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_IOU_THRESHOLD,
  DEFAULT_MAX_DETECTIONS,
  THREAT_LEVEL_COLORS,
} from '../detection/types'
import { useDetectionLoop } from '../hooks/useDetectionLoop'
import { useDroneController } from '../hooks/useDroneController'
import { useDraggable } from '../hooks/useDraggable'
import { useDraggable3D } from '../hooks/useDraggable3D'
import { useObjectSelection } from '../hooks/useObjectSelection'
import { useUIScale } from '../context/UIScaleContext'
import DroneSpawnPanel from './DroneSpawnPanel'
import SaveLoadPanel from './SaveLoadPanel'
import ObjectTransformControls from './ObjectTransformControls'
import { createTacticalGrid, createGridLabels } from './viewer/TacticalGrid'
import { createProceduralFloor, createTerrainMesh, type FloorStyle } from './viewer/ProceduralTerrain'
import { getGazeboController } from '../ros/GazeboController'
import { getROSBridge } from '../ros/ROSBridge'
import { MAVERICK_SDF } from '../ros/models'
import { calculateLatencyStats, normalizeSystemInfo, type SystemInfo } from '../lib/diagnostics'
import { TAURI_COMMANDS } from '../lib/tauriCommands'

import type { 
  LoadedAsset, 
  ConsoleMessage, 
  CameraType, 
  ThreatLevel, 
  SurveillanceCamera,
  RendererWithAsync
} from './viewer/types'
import { sceneLogger as log } from '../lib/logger'
import { 
  isSplatFormat, 
  isGltfFormat, 
  generateCameraDesignation, 
  formatZuluTime, 
  formatCoordinate 
} from './viewer/types'


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

/**
 * Disposes mesh materials and their associated texture maps to prevent memory leaks.
 * Handles both single materials and multi-material arrays.
 *
 * @param mesh - THREE.Mesh whose materials should be disposed
 * @remarks Disposes all PBR texture maps (diffuse, normal, roughness, metalness, AO, emissive)
 */
function disposeMeshMaterials(mesh: THREE.Mesh): void {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  for (const material of materials) {
    if (material instanceof THREE.MeshStandardMaterial) {
      material.map?.dispose()
      material.normalMap?.dispose()
      material.roughnessMap?.dispose()
      material.metalnessMap?.dispose()
      material.aoMap?.dispose()
      material.emissiveMap?.dispose()
    }
    material.dispose()
  }
}

interface CrebainViewerProps {
  onDetectionComplete?: (result: {
    inferenceTimeMs: number
    preprocessTimeMs?: number
    postprocessTimeMs?: number
    detectionCount: number
  }) => void
}

type NativeDetectionResult = CoreMLDetectionResult & { backend?: string | null }

const COREML_TEST_WIDTH = 640
const COREML_TEST_HEIGHT = 480
const VIEWER_BENCHMARK_ITERATIONS = 100
const VIEWER_BENCHMARK_PROGRESS_STEP = 10

export default function CrebainViewer({
  onDetectionComplete,
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
  const [loadingStage, setLoadingStage] = useState<'reading' | 'processing' | 'rendering'>('reading')
  const [currentAsset, setCurrentAsset] = useState<string | null>(null)
  const [loadedAssets, setLoadedAssets] = useState<LoadedAsset[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [consoleMessages, setConsoleMessages] = useState<ConsoleMessage[]>([])

  const [cameras, setCameras] = useState<SurveillanceCamera[]>([])
  const [selectedCamera, setSelectedCamera] = useState<string | null>(null)
  const [cameraPlacementMode, setCameraPlacementMode] = useState<CameraType | null>(null)
  const [dronePlacementMode, setDronePlacementMode] = useState<boolean>(false)
  const dronePlacementModeRef = useRef(false)
  
  useEffect(() => {
    dronePlacementModeRef.current = dronePlacementMode
  }, [dronePlacementMode])

  const pendingDroneType = useRef<string | null>(null)
  const pendingDroneName = useRef<string | null>(null)
  const [showCameraFeeds, setShowCameraFeeds] = useState(true)
  const [activeTab, setActiveTab] = useState<'sensoren' | 'objekte' | 'system'>('sensoren')

  const [currentTime, setCurrentTime] = useState(new Date())
  const [threatLevel, setThreatLevel] = useState<ThreatLevel>(1)
  const [showGrid, setShowGrid] = useState(true)
  const simulatedOperatorPosition = { lat: 52.5200, lon: 13.4050, alt: 34 }
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
      setShowControlPanel(prev => !prev)
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

  const moveState = useRef({
    forward: false, backward: false, left: false, right: false,
    up: false, down: false, sprint: false, precision: false,
    rotateLeft: false, rotateRight: false, lookUp: false, lookDown: false,
  })
  const velocity = useRef(new THREE.Vector3())
  const lastFrameTime = useRef(performance.now())
  const scratchVectors = useRef({
    forward: new THREE.Vector3(),
    right: new THREE.Vector3(),
    targetVelocity: new THREE.Vector3(),
    velocityDiff: new THREE.Vector3(),
    movement: new THREE.Vector3(),
    camDir: new THREE.Vector3(),
  })

  // Configurable movement parameters
  const MOVE_CONFIG = useMemo(() => ({
    baseSpeed: 8.0,           // meters per second
    sprintMultiplier: 3.0,    // 3x speed when sprinting
    precisionMultiplier: 0.2, // 0.2x speed for precision mode
    acceleration: 25.0,       // m/s² - how fast we reach target speed
    deceleration: 20.0,       // m/s² - how fast we stop
    maxVelocity: 50.0,        // m/s - absolute max
    rotateSpeed: 90.0,        // degrees per second for keyboard look
    verticalSpeed: 6.0,       // m/s for vertical movement
  }), [])
  
  // Camera feed update interval (~12 FPS)
  const CAMERA_FEED_INTERVAL_MS = 83
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
    return () => {
      messageTimeoutsRef.current.forEach(id => clearTimeout(id))
      messageTimeoutsRef.current.clear()
    }
  }, [])

  const addMessage = useCallback((type: ConsoleMessage['type'], message: string) => {
    const timestamp = Date.now()
    const newMessage: ConsoleMessage = { id: crypto.randomUUID(), type, message, timestamp }
    setConsoleMessages(prev => [...prev.slice(-8), newMessage])
    
    const timeoutId = window.setTimeout(() => {
      setConsoleMessages(prev => prev.filter(m => m.id !== newMessage.id))
      messageTimeoutsRef.current.delete(newMessage.id)
    }, 10000)
    messageTimeoutsRef.current.set(newMessage.id, timeoutId)
  }, [])

  const refreshSystemInfo = useCallback(async () => {
    try {
      const info = await invoke<unknown>(TAURI_COMMANDS.detection.systemInfo)
      setSystemInfo(normalizeSystemInfo(info))
    } catch (error) {
      log.warn('Failed to refresh detector system info', { error })
      setSystemInfo(normalizeSystemInfo(null))
    }
  }, [])

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
    resetSimulation,
  } = useDroneController({
    scene: sceneRef.current,
    enabled: true,
  })

  const handleSpawnRequest = useCallback((typeId: string, name?: string) => {
    pendingDroneType.current = typeId
    pendingDroneName.current = name || null
    setDronePlacementMode(true)
    setCameraPlacementMode(null) // Cancel other modes
    addMessage('tactical', 'DROHNE PLATZIEREN: ZIEL WÄHLEN')
  }, [addMessage])

  const handleDetection = useCallback((cameraId: string, detections: Detection[], inferenceTimeMs?: number) => {
    setCameraDetections(prev => {
      const updated = new Map(prev)
      updated.set(cameraId, detections)
      cameraDetectionsRef.current = updated
      return updated
    })

    if (onDetectionComplete && inferenceTimeMs !== undefined) {
      onDetectionComplete({
        inferenceTimeMs,
        detectionCount: detections.length,
      })
    }
  }, [onDetectionComplete])

  const handlePerformance = useCallback((metrics: {
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
  }, [onDetectionComplete])

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
      cameras.forEach(cam => {
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

      const highThreatTracks = tracks.filter(t => t.threatLevel >= 3)
      if (highThreatTracks.length > 0 && threatLevel < 3) {
        setThreatLevel(3)
      }
    }
  }, [cameras, cameraDetections, threatLevel])

  const totalDetections = useMemo(() => {
    let count = 0
    cameraDetections.forEach(dets => count += dets.length)
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
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.9, roughness: 0.3 })
    const body = new THREE.Mesh(bodyGeom, bodyMat)
    group.add(body)

    const lensGeom = new THREE.CylinderGeometry(0.03, 0.04, 0.06, 16)
    const lensMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, metalness: 0.95, roughness: 0.05 })
    const lens = new THREE.Mesh(lensGeom, lensMat)
    lens.rotation.x = Math.PI / 2
    lens.position.z = 0.12
    group.add(lens)

    const glassGeom = new THREE.CircleGeometry(0.025, 16)
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0x222222, emissiveIntensity: 0.2, transparent: true, opacity: 0.9 })
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

  const placeCamera = useCallback((position: THREE.Vector3, type: CameraType) => {
    if (!sceneRef.current || !rendererRef.current) return

    cameraCounterRef.current[type]++
    const designation = generateCameraDesignation(type, cameraCounterRef.current[type])

    const feedCamera = new THREE.PerspectiveCamera(60, 16/9, 0.1, 500)
    feedCamera.position.copy(position)
    feedCamera.lookAt(position.x, position.y - 0.5, position.z - 2)

    const renderTarget = new THREE.WebGLRenderTarget(640, 360, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType })

    const helper = new THREE.CameraHelper(feedCamera)
    helper.visible = false
    sceneRef.current.add(helper)

    const mesh = createCameraMesh(type)
    mesh.position.copy(position)
    sceneRef.current.add(mesh)

    const newCamera: SurveillanceCamera = {
      id: crypto.randomUUID(), name: designation, type, camera: feedCamera, helper, mesh, renderTarget,
      pan: 0, tilt: 0, zoom: 60, isActive: true, isRecording: true,
      patrolPoints: type === 'patrol' ? [position.clone(), position.clone().add(new THREE.Vector3(5, 0, 0))] : undefined,
      patrolIndex: 0, patrolSpeed: 0.015, patrolDirection: 1
    }

    setCameras(prev => [...prev, newCamera])
    addMessage('tactical', `${designation} AKTIVIERT`)
    return newCamera
  }, [createCameraMesh, addMessage])

  const updateCameraPTZ = useCallback((cameraId: string, pan?: number, tilt?: number, zoom?: number) => {
    setCameras(prev => prev.map(cam => {
      if (cam.id !== cameraId) return cam
      const newPan = pan !== undefined ? pan : cam.pan
      const newTilt = tilt !== undefined ? Math.max(-85, Math.min(85, tilt)) : cam.tilt
      const newZoom = zoom !== undefined ? Math.max(5, Math.min(120, zoom)) : cam.zoom
      const euler = new THREE.Euler(THREE.MathUtils.degToRad(-newTilt), THREE.MathUtils.degToRad(newPan), 0, 'YXZ')
      cam.camera.quaternion.setFromEuler(euler)
      cam.camera.fov = newZoom
      cam.camera.updateProjectionMatrix()
      cam.mesh.quaternion.copy(cam.camera.quaternion)
      return { ...cam, pan: newPan, tilt: newTilt, zoom: newZoom }
    }))
  }, [])

  const removeCamera = useCallback((cameraId: string) => {
    setCameras(prev => {
      const cam = prev.find(c => c.id === cameraId)
      if (cam && sceneRef.current) {
        sceneRef.current.remove(cam.helper)
        sceneRef.current.remove(cam.mesh)
        cam.renderTarget.dispose()
        cam.mesh.traverse(child => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose()
            if (Array.isArray(child.material)) child.material.forEach(m => m.dispose())
            else child.material.dispose()
          }
        })
        addMessage('system', `${cam.name} DEAKTIVIERT`)
      }
      return prev.filter(c => c.id !== cameraId)
    })
    if (selectedCamera === cameraId) setSelectedCamera(null)
  }, [selectedCamera, addMessage])

  const renameCamera = useCallback((cameraId: string, newName: string) => {
    setCameras(prev => prev.map(cam => 
      cam.id === cameraId ? { ...cam, name: newName } : cam
    ))
  }, [])

  const exportCameraFeed = useCallback(async (cameraId: string): Promise<ImageData | null> => {
    const cam = cameras.find(c => c.id === cameraId)
    if (!cam || !rendererRef.current) return null
    const width = cam.renderTarget.width
    const height = cam.renderTarget.height
    const buffer = new Uint8Array(width * height * 4)
    rendererRef.current.readRenderTargetPixels(cam.renderTarget, 0, 0, width, height, buffer)
    const imageData = new ImageData(width, height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcIdx = ((height - 1 - y) * width + x) * 4
        const dstIdx = (y * width + x) * 4
        imageData.data[dstIdx] = buffer[srcIdx]
        imageData.data[dstIdx + 1] = buffer[srcIdx + 1]
        imageData.data[dstIdx + 2] = buffer[srcIdx + 2]
        imageData.data[dstIdx + 3] = buffer[srcIdx + 3]
      }
    }
    return imageData
  }, [cameras])

  const downloadCameraFeed = useCallback(async (cameraId: string) => {
    const imageData = await exportCameraFeed(cameraId)
    if (!imageData) return
    const canvas = document.createElement('canvas')
    canvas.width = imageData.width
    canvas.height = imageData.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.putImageData(imageData, 0, 0)
    const cam = cameras.find(c => c.id === cameraId)
    const link = document.createElement('a')
    link.download = `${cam?.name}_${Date.now()}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
    addMessage('success', `EXPORT: ${cam?.name}`)
  }, [exportCameraFeed, cameras, addMessage])

  const testCoreMLInference = useCallback(async () => {
    if (isTestingCoreML || isBenchmarking) return

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
        const classes = result.detections.map(d => d.classLabel).join(', ')
        const backendText = result.backend ? ` [${result.backend}]` : ''
        addMessage('success',
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
  }, [addMessage, isBenchmarking, isTestingCoreML, onDetectionComplete, refreshSystemInfo])

  const cancelCoreMLBenchmark = useCallback(() => {
    if (!isBenchmarking) return
    benchmarkAbortRef.current = true
    addMessage('warning', 'BENCHMARK: Abbruch angefordert')
  }, [addMessage, isBenchmarking])

  const runCoreMLBenchmark = useCallback(async () => {
    if (isTestingCoreML || isBenchmarking) return

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

        if (result.success && Number.isFinite(result.inferenceTimeMs) && result.inferenceTimeMs >= 0) {
          latencies.push(result.inferenceTimeMs)
        } else {
          addMessage('warning', `BENCHMARK: Iteration ${i + 1} ohne Messwert übersprungen`)
        }

        if ((i + 1) % VIEWER_BENCHMARK_PROGRESS_STEP === 0 || i + 1 === VIEWER_BENCHMARK_ITERATIONS) {
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
      const squaredDiffs = latencies.map(latency => (latency - mean) ** 2)
      const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / squaredDiffs.length
      const stdDev = Math.sqrt(avgSquaredDiff)
      const throughputFps = totalTimeMs > 0 ? (latencies.length / totalTimeMs) * 1000 : 0

      setBenchmarkProgress(100)
      addMessage('success', '═══════════════════════════════════════')
      addMessage('success', `BENCHMARK ERGEBNISSE (${latencies.length}/${VIEWER_BENCHMARK_ITERATIONS} Iterationen)`)
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
  }, [addMessage, isBenchmarking, isTestingCoreML, onDetectionComplete, refreshSystemInfo])

  const detectionCameras = useMemo(() => 
    cameras.map(c => ({ id: c.id, name: c.name, isActive: c.isActive })),
    [cameras]
  )

  useDetectionLoop({
    cameras: detectionCameras,
    exportCameraFeed,
    enabled: detectionEnabled && cameras.length > 0,
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
        physicsWorld.getAllDrones().forEach(drone => {
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
    cameras.forEach(cam => {
      if (cam.mesh) objects.push(cam.mesh)
    })
    managedDrones.forEach(drone => {
      if (drone.mesh) objects.push(drone.mesh)
    })
    loadedAssets.forEach(asset => {
      if (asset.object) objects.push(asset.object)
    })
    return objects
  }, [cameras, managedDrones, loadedAssets])

  const handleDeleteSelectedObject = useCallback((object: THREE.Object3D) => {
    const camera = cameras.find(c => c.mesh === object)
    if (camera) {
      removeCamera(camera.id)
      addMessage('system', `${camera.name} ENTFERNT`)
      return
    }

    const drone = managedDrones.find(d => d.mesh === object)
    if (drone) {
      removeDrone(drone.id)
      addMessage('system', `${drone.name} ENTFERNT`)
      return
    }

    const asset = loadedAssets.find(a => a.object === object)
    if (asset && sceneRef.current) {
      sceneRef.current.remove(asset.object)
      asset.object.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry?.dispose()
          const mats = Array.isArray(child.material) ? child.material : [child.material]
          mats.forEach(m => m?.dispose())
        }
      })
      setLoadedAssets(prev => prev.filter(a => a.id !== asset.id))
      addMessage('system', `ENTFERNT: ${asset.name}`)
    }
  }, [cameras, managedDrones, loadedAssets, removeCamera, removeDrone, addMessage])

  const {
    selectedObjects,
    primarySelection,
    clearSelection,
  } = useObjectSelection({
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
        const name = obj.name || obj.userData.id || 'OBJEKT'
        addMessage('tactical', `AUSGEWÄHLT: ${name}`)
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
      const name = obj.name || obj.userData.id || 'OBJEKT'
      addMessage('info', `BEWEGEN: ${name}`)
    },
    onDragEnd: (obj, position) => {
      const name = obj.name || obj.userData.id || 'OBJEKT'
      addMessage('success', `POSITION: ${name} -> ${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`)

      const cam = cameras.find(c => c.mesh === obj)
      if (cam) {
        cam.camera.position.copy(position)
      }

      const drone = managedDrones.find(d => d.mesh === obj)
      if (drone && physicsWorld) {
        drone.physicsBody.state.position.copy(position)
        drone.physicsBody.state.velocity.set(0, 0, 0)

        if (drone.physicsBody.rigidBody) {
           drone.physicsBody.rigidBody.setTranslation(position, true)
           drone.physicsBody.rigidBody.setLinvel({x: 0, y: 0, z: 0}, true)
        }
      }
    },
    enabled: !cameraPlacementMode && selectedObjects.length > 0,
  })

  const handleTransformChange = useCallback((object: THREE.Object3D) => {
    const cam = cameras.find(c => c.mesh === object)
    if (cam) {
      cam.camera.position.copy(object.position)
      cam.camera.quaternion.copy(object.quaternion)
    }

    const drone = managedDrones.find(d => d.mesh === object)
    if (drone && physicsWorld) {
        drone.physicsBody.state.position.copy(object.position)
        drone.physicsBody.state.orientation.copy(object.quaternion)

        if (drone.physicsBody.rigidBody) {
           drone.physicsBody.rigidBody.setTranslation(object.position, true)
           drone.physicsBody.rigidBody.setRotation(object.quaternion, true)
           drone.physicsBody.rigidBody.setLinvel({x: 0, y: 0, z: 0}, true)
           drone.physicsBody.rigidBody.setAngvel({x: 0, y: 0, z: 0}, true)
        }
    }
  }, [cameras, managedDrones, physicsWorld])

  const loadSplat = useCallback(async (source: File | string | ArrayBuffer, name?: string) => {
    if (!sceneRef.current) return
    const displayName = name || (source instanceof File ? source.name : 'OBJEKT')
    setIsLoading(true)
    setLoadingName(displayName)
    setLoadingProgress(0)
    setLoadingStage('reading')
    const scene = sceneRef.current

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
        const response = await fetch(source)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)

        const contentLength = response.headers.get('Content-Length')
        const total = contentLength ? parseInt(contentLength, 10) : 0

        if (total && response.body) {
          const reader = response.body.getReader()
          const chunks: Uint8Array[] = []
          let received = 0

          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            chunks.push(value)
            received += value.length
            setLoadingProgress(Math.round((received / total) * 50))

            await new Promise(resolve => setTimeout(resolve, 0))
          }

          const combined = new Uint8Array(received)
          let offset = 0
          for (const chunk of chunks) {
            combined.set(chunk, offset)
            offset += chunk.length
          }
          fileBytes = combined.buffer
        } else {
          fileBytes = await response.arrayBuffer()
          setLoadingProgress(50)
        }
      } else if (source instanceof File) {
        fileBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader()
          reader.onprogress = (e) => {
            if (e.lengthComputable) {
              setLoadingProgress(Math.round((e.loaded / e.total) * 50))
            }
          }
          reader.onload = () => resolve(reader.result as ArrayBuffer)
          reader.onerror = () => reject(new Error('File read failed'))
          reader.readAsArrayBuffer(source)
        })
      } else {
        fileBytes = source
        setLoadingProgress(50)
      }

      setLoadingStage('processing')
      const fileSizeMB = (fileBytes.byteLength / 1024 / 1024).toFixed(1)
      addMessage('system', `VERARBEITE: ${fileSizeMB} MB`)

      await new Promise(resolve => setTimeout(resolve, 16))

      let loadCompleted = false

      loadTimeout = setTimeout(() => {
        if (!loadCompleted) {
          setIsLoading(false)
          setLoadingName(null)
          setLoadingProgress(0)
          addMessage('error', `ZEITÜBERSCHREITUNG: ${displayName}`)
        }
      }, 120000)

      progressInterval = setInterval(() => {
        setLoadingProgress(prev => {
          if (prev >= 95) return prev
          return prev + Math.random() * 5
        })
      }, 200)

      setLoadingStage('rendering')

      const newSplat = new SplatMesh({
        fileBytes,
        onLoad: () => {
          loadCompleted = true
          clearTimeout(loadTimeout)
          clearInterval(progressInterval)
          setLoadingProgress(100)

          setTimeout(() => {
            setIsLoading(false)
            setLoadingName(null)
            setLoadingProgress(0)
            setCurrentAsset(displayName)
            addMessage('success', `GELADEN: ${displayName}`)
          }, 300)
        }
      })
      newSplat.position.set(0, 0, 0)
      newSplat.rotation.set(Math.PI, 0, 0)
      scene.add(newSplat)
      splatMeshRef.current = newSplat
    } catch (error) {
      clearTimeout(loadTimeout)
      clearInterval(progressInterval)
      setIsLoading(false)
      setLoadingName(null)
      setLoadingProgress(0)
      addMessage('error', `FEHLER: ${error instanceof Error ? error.message : 'Unbekannt'}`)
    }
  }, [addMessage])

  const loadGlb = useCallback((source: File | string, name?: string) => {
    if (!sceneRef.current || !glbLoaderRef.current) return
    const displayName = name || (source instanceof File ? source.name : 'MODELL')
    setIsLoading(true)
    setLoadingName(displayName)
    const scene = sceneRef.current
    const loader = glbLoaderRef.current
    const url = source instanceof File ? URL.createObjectURL(source) : source

    loader.load(url,
      (gltf) => {
        const model = gltf.scene
        model.name = displayName
        model.userData.assetId = crypto.randomUUID()
        model.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material) {
            const materials = Array.isArray(child.material) ? child.material : [child.material]
            materials.forEach((mat) => { if (mat instanceof THREE.MeshStandardMaterial) { mat.needsUpdate = true; if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace } })
          }
        })
        const camera = cameraRef.current
        if (camera) { const dir = new THREE.Vector3(); camera.getWorldDirection(dir); model.position.copy(camera.position).add(dir.multiplyScalar(3)); model.position.y = 0 }
        scene.add(model)
        setLoadedAssets(prev => [...prev, { id: model.userData.assetId, name: displayName, type: 'glb', object: model }])
        setIsLoading(false); setLoadingName(null)
        addMessage('success', `GELADEN: ${displayName}`)
        if (source instanceof File) URL.revokeObjectURL(url)
      },
      undefined,
      (error: unknown) => { setIsLoading(false); setLoadingName(null); addMessage('error', `FEHLER: ${error instanceof Error ? error.message : 'Unbekannt'}`); if (source instanceof File) URL.revokeObjectURL(url) }
    )
  }, [addMessage])

  const loadFloorTexture = useCallback((source: File | string, name?: string) => {
    if (!sceneRef.current) return
    const displayName = name || (source instanceof File ? source.name : 'BODEN')
    setIsLoading(true)
    setLoadingName(displayName)
    
    const url = source instanceof File ? URL.createObjectURL(source) : source
    const loader = new THREE.TextureLoader()
    
    loader.load(
      url,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace
        texture.wrapS = THREE.RepeatWrapping
        texture.wrapT = THREE.RepeatWrapping
        
        // Adjust texture aspect ratio
        const aspect = texture.image.width / texture.image.height
        const size = 200 // Default size
        
        if (floorMeshRef.current) {
          sceneRef.current?.remove(floorMeshRef.current)
          disposeMeshMaterials(floorMeshRef.current)
          floorMeshRef.current.geometry.dispose()
        }
        
        const geometry = new THREE.PlaneGeometry(size * aspect, size)
        geometry.rotateX(-Math.PI / 2)
        
        const material = new THREE.MeshStandardMaterial({ 
          map: texture,
          roughness: 0.8,
          metalness: 0.2
        })
        
        const mesh = new THREE.Mesh(geometry, material)
        mesh.position.y = -0.05 // Slightly below grid
        mesh.receiveShadow = true
        mesh.userData.isFloor = true
        
        sceneRef.current?.add(mesh)
        floorMeshRef.current = mesh
        
        setIsLoading(false)
        setLoadingName(null)
        addMessage('success', `BODENTEXTUR: ${displayName}`)
        if (source instanceof File) URL.revokeObjectURL(url)
      },
      undefined,
      (error) => {
        setIsLoading(false)
        setLoadingName(null)
        addMessage('error', `FEHLER: ${error instanceof Error ? error.message : 'Textur konnte nicht geladen werden'}`)
        if (source instanceof File) URL.revokeObjectURL(url)
      }
    )
  }, [addMessage])

  const handleSetFloorType = useCallback((type: FloorStyle) => {
    if (!sceneRef.current) return

    if (floorMeshRef.current) {
      sceneRef.current.remove(floorMeshRef.current)
      disposeMeshMaterials(floorMeshRef.current)
      floorMeshRef.current.geometry.dispose()
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
  }, [addMessage])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files?.length) return
    for (const file of Array.from(files)) {
      if (isSplatFormat(file.name)) loadSplat(file, file.name)
      else if (isGltfFormat(file.name)) loadGlb(file, file.name)
      else if (/\.(jpg|jpeg|png)$/i.test(file.name)) loadFloorTexture(file, file.name)
      else addMessage('warning', `NICHT UNTERSTÜTZT: ${file.name}`)
    }
    e.target.value = ''
  }, [loadSplat, loadGlb, loadFloorTexture, addMessage])

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
    if (splatMeshRef.current) { box.expandByObject(splatMeshRef.current); hasContent = true }
    loadedAssets.forEach(asset => { box.expandByObject(asset.object); hasContent = true })
    if (!hasContent) { addMessage('warning', 'KEIN ZIEL'); return }
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const distance = Math.max(size.x, size.y, size.z) * 1.5
    cameraRef.current.position.set(center.x + distance, center.y + distance * 0.5, center.z + distance)
    controlsRef.current.target.copy(center)
    velocity.current.set(0, 0, 0)
    controlsRef.current.update()
    addMessage('system', 'ZIEL ERFASST')
  }, [loadedAssets, addMessage])

  const handleSceneClick = useCallback((event: MouseEvent) => {
    if ((!cameraPlacementMode && !dronePlacementMode) || !containerRef.current || !sceneRef.current || !cameraRef.current) return
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
        
        spawnDrone(type, name || undefined, intersection).then(id => {
          if (id) {
            addMessage('success', `DROHNE PLATZIERT: ${type}`)
          } else {
            addMessage('error', 'FEHLER: KONNTE DROHNE NICHT ERSTELLEN')
          }
        }).catch(err => {
          addMessage('error', `FEHLER: ${err}`)
        })
        
        setDronePlacementMode(false)
        pendingDroneType.current = null
      }
    }
  }, [cameraPlacementMode, dronePlacementMode, placeCamera, spawnDrone, addMessage])

  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current
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

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' }) as RendererWithAsync
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
    const ghostDroneMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.3, wireframe: true })
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

      const { forward, right, targetVelocity, velocityDiff, movement, camDir } = scratchVectors.current
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
        setBearing(((Math.atan2(camDir.x, camDir.z) * (180 / Math.PI)) + 360) % 360)
        setAltitude(camera.position.y)
      }

      controls.update()
      renderer.render(scene, camera)
    }
    renderer.setAnimationLoop(animate)

    let containerRect = container.getBoundingClientRect()

    const handleResize = () => { 
        const w = container.clientWidth; 
        const h = container.clientHeight; 
        camera.aspect = w / h; 
        camera.updateProjectionMatrix(); 
        renderer.setSize(w, h);
        containerRect = container.getBoundingClientRect();
    }
    window.addEventListener('resize', handleResize)

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      if (e.shiftKey) moveState.current.sprint = true
      if (e.ctrlKey || e.metaKey) moveState.current.precision = true

      switch (e.key.toLowerCase()) {
        case 'w': moveState.current.forward = true; break
        case 's': moveState.current.backward = true; break
        case 'a': moveState.current.left = true; break
        case 'd': moveState.current.right = true; break
        case 'q': moveState.current.down = true; break
        case 'e': moveState.current.up = true; break
        case 'z': moveState.current.rotateLeft = true; break
        case 'x': moveState.current.rotateRight = true; break
        case 'arrowleft': moveState.current.rotateLeft = true; e.preventDefault(); break
        case 'arrowright': moveState.current.rotateRight = true; e.preventDefault(); break
        case ' ':
          velocity.current.set(0, 0, 0)
          Object.keys(moveState.current).forEach(key => {
            if (key !== 'sprint' && key !== 'precision') {
              (moveState.current as Record<string, boolean>)[key] = false
            }
          })
          e.preventDefault()
          break
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!e.shiftKey) moveState.current.sprint = false
      if (!e.ctrlKey && !e.metaKey) moveState.current.precision = false

      switch (e.key.toLowerCase()) {
        case 'w': moveState.current.forward = false; break
        case 's': moveState.current.backward = false; break
        case 'a': moveState.current.left = false; break
        case 'd': moveState.current.right = false; break
        case 'q': moveState.current.down = false; break
        case 'e': moveState.current.up = false; break
        case 'z': moveState.current.rotateLeft = false; break
        case 'x': moveState.current.rotateRight = false; break
        case 'arrowleft': moveState.current.rotateLeft = false; break
        case 'arrowright': moveState.current.rotateRight = false; break
        case 'shift': moveState.current.sprint = false; break
        case 'control': case 'meta': moveState.current.precision = false; break
      }
    }

    const handleMouseMove = (event: MouseEvent) => {
      mouseRef.current.x = ((event.clientX - containerRect.left) / containerRect.width) * 2 - 1
      mouseRef.current.y = -((event.clientY - containerRect.top) / containerRect.height) * 2 + 1
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    container.addEventListener('mousemove', handleMouseMove)

    return () => {
      renderer.setAnimationLoop(null)
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      container.removeEventListener('mousemove', handleMouseMove)
      // Dispose floor mesh if it exists
      if (floorMeshRef.current) {
        disposeMeshMaterials(floorMeshRef.current)
        floorMeshRef.current.geometry.dispose()
        floorMeshRef.current = null
      }
      // Dispose ghost drone preview mesh
      scene.remove(ghostDroneRef)
      ghostDroneGeometry.dispose()
      ghostDroneMaterial.dispose()
      controls.dispose()
      renderer.dispose()
      container.removeChild(renderer.domElement)
    }
  }, [])

  // Cycle through cameras with Tab
  const cycleCamera = useCallback(() => {
    if (cameras.length === 0) {
      setSelectedCamera(null)
      return
    }
    const currentIndex = selectedCamera ? cameras.findIndex(c => c.id === selectedCamera) : -1
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
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      switch (e.key.toLowerCase()) {
        case 'r': resetCamera(); break
        case 'f': focusOnContent(); break
        case 'g': setShowGrid(prev => !prev); break
        case 'escape': setCameraPlacementMode(null); setSelectedCamera(null); clearSelection(); break
        case '1': setCameraPlacementMode('static'); addMessage('tactical', 'SK-PLATZIERUNG AKTIV'); break
        case '2': setCameraPlacementMode('ptz'); addMessage('tactical', 'PTZ-PLATZIERUNG AKTIV'); break
        case '3': setCameraPlacementMode('patrol'); addMessage('tactical', 'PK-PLATZIERUNG AKTIV'); break
        case 'v': setShowCameraFeeds(prev => !prev); break
        case 't': setShowDetectionPanel(prev => !prev); break
        case 'y': setDetectionEnabled(prev => !prev); break
        case 'tab':
          e.preventDefault()
          cycleCamera()
          break
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
  }, [resetCamera, focusOnContent, cycleCamera, addMessage])

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

    const updateFeeds = async () => {
      if (isUpdating) return
      isUpdating = true

      const now = performance.now()
      const patrolDt = Math.min((now - lastPatrolTime) / 1000, 0.5)
      lastPatrolTime = now

      try {
        const activeCameras = cameras.filter(c => c.isActive)
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

          renderer.setRenderTarget(cam.renderTarget)
          renderer.render(scene, cam.camera)
        }

        renderer.setRenderTarget(currentRT)

        if (!showCameraFeeds) return

        for (const cam of activeCameras) {
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
          const imageData = ctx.createImageData(width, height)

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
    const handleDragOver = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true) }
    const handleDragLeave = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false) }
    const handleDrop = async (e: DragEvent) => {
      e.preventDefault(); e.stopPropagation(); setIsDragging(false)
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

            const namespacedSDF = MAVERICK_SDF
                .split('cmd/motor_speed/').join(`${id}/cmd/motor_speed/`)

            const controller = getGazeboController()
            if (controller.isConnected()) {
              addMessage('info', 'SPAWNE GAZEBO MODEL...')
              const success = await controller.spawnSDF(
                id,
                namespacedSDF,
                {
                  position: { x: pos.x, y: pos.y, z: pos.z },
                  orientation: { x: quat.x, y: quat.y, z: quat.z, w: quat.w }
                }
              )
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

          if (isSplatFormat(file.name)) loadSplat(file, file.name)
          else if (isGltfFormat(file.name)) loadGlb(file, file.name)
          else if (/\.(jpg|jpeg|png)$/i.test(file.name)) loadFloorTexture(file, file.name)
          else addMessage('warning', `NICHT UNTERSTÜTZT: ${file.name}`)
        }
        return
      }
      const droppedText = e.dataTransfer?.getData('text/plain')
      if (droppedText) {
        const filename = droppedText.split('/').pop() || 'Asset'
        if (isSplatFormat(droppedText)) loadSplat(droppedText, filename)
        else if (isGltfFormat(droppedText)) loadGlb(droppedText, filename)
        else if (/\.(jpg|jpeg|png)$/i.test(droppedText)) loadFloorTexture(droppedText, filename)
        else addMessage('warning', 'URL NICHT UNTERSTÜTZT')
      }
    }
    container.addEventListener('dragover', handleDragOver)
    container.addEventListener('dragleave', handleDragLeave)
    container.addEventListener('drop', handleDrop)
    return () => { container.removeEventListener('dragover', handleDragOver); container.removeEventListener('dragleave', handleDragLeave); container.removeEventListener('drop', handleDrop) }
  }, [loadSplat, loadGlb, loadFloorTexture, spawnDrone, physicsWorld, addMessage])

  const selectedCameraData = cameras.find(c => c.id === selectedCamera)
  const availableBackendText = systemInfo.availableBackends.length > 0
    ? systemInfo.availableBackends.map(backend => backend === 'MLX' ? 'MLX (EXP.)' : backend).join(', ')
    : 'KEINE'
  const mlxStatusText = systemInfo.experimentalMlxEnabled ? 'OPT-IN EXP.' : 'AUS'
  const backendStatusText = systemInfo.backend === 'Unknown' || systemInfo.backend.toLowerCase().includes('no backend')
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
    >
      <input ref={fileInputRef} type="file" accept=".spz,.ply,.splat,.ksplat,.glb,.gltf,.jpg,.jpeg,.png" multiple onChange={handleFileSelect} className="hidden" />

      <div ref={containerRef} className={`w-full h-full ${cameraPlacementMode ? 'cursor-crosshair' : isDragging3D ? 'cursor-grabbing' : 'cursor-grab active:cursor-grabbing'}`} tabIndex={0} />

      {/* DRONE SPAWN PANEL */}
      <DroneSpawnPanel
        onSpawnDrone={handleSpawnRequest}
        onSelectDrone={selectDrone}
        onRemoveDrone={removeDrone}
        onRenameDrone={renameDrone}
        onSetRoute={setRoute}
        onClearRoute={clearRoute}
        onToggleRoute={toggleRoute}
        activeDrones={managedDrones.map(d => ({
          id: d.id,
          type: d.type,
          name: d.name,
          armed: d.physicsBody.state.armed,
          battery: d.physicsBody.state.battery,
          route: d.route,
        }))}
        selectedDroneId={selectedDroneId}
        isExpanded={showDronePanel}
        onToggleExpand={() => setShowDronePanel(prev => !prev)}
      />

      {/* SAVE/LOAD PANEL */}
      <SaveLoadPanel
        isExpanded={showSaveLoadPanel}
        onToggleExpand={() => setShowSaveLoadPanel(prev => !prev)}
        onSave={(state) => addMessage('success', `Szene "${state.name}" gespeichert`)}
        onLoad={(state) => {
          addMessage('info', `Szene "${state.name}" geladen`)
          // Scene restoration handled by SaveLoadPanel component
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
      <div className="absolute top-0 left-0 right-0 z-50 pointer-events-none" style={{ fontSize: `calc(8px * var(--ui-scale, 1))` }}>
        <div className="h-11 bg-[#0c0c0c] border-b border-[#1a1a1a] flex items-center px-4">
          <div className="flex items-center gap-3 pointer-events-auto">
            <img src="/crebain-logo.png" alt="CREBAIN" className="w-9 h-9" />
            <div>
              <div className="text-[1.25em] text-[#e0e0e0] font-medium tracking-[0.3em] whitespace-nowrap">CREBAIN</div>
              <div className="text-[0.875em] text-[#606060] tracking-[0.15em] whitespace-nowrap">REAKTIONS- UND AUFKLÄRUNGSSYSTEM</div>
            </div>
          </div>

          <div className="w-px h-6 bg-[#1a1a1a] mx-4" />

          <div className="flex items-center gap-2 pointer-events-auto">
            <span className="text-[0.875em] text-[#606060] tracking-wider mr-1">STUFE</span>
            {([1, 2, 3, 4] as ThreatLevel[]).map(level => (
              <button
                key={level}
                onClick={() => setThreatLevel(level)}
                className={`w-6 h-5 text-[1.125em] font-bold border transition-all ${
                  threatLevel === level
                    ? level <= 2 ? 'bg-[#1a1a1a] border-[#404040] text-[#c0c0c0]'
                      : level === 3 ? 'bg-[#1a1408] border-[#a08040] text-[#a08040]'
                      : 'bg-[#1a0808] border-[#8b4a4a] text-[#8b4a4a]'
                    : 'bg-[#0c0c0c] border-[#1a1a1a] text-[#404040] hover:border-[#303030]'
                }`}
              >
                {level}
              </button>
            ))}
          </div>

          <div className="w-px h-6 bg-[#1a1a1a] mx-4" />

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <div className={`w-1.5 h-1.5 ${backendStatusColor}`} />
              <span className="text-[0.875em] text-[#707070]">DIAG</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 bg-[#a08040]" />
              <span className="text-[0.875em] text-[#707070]">KRYPTO CFG</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 bg-[#505050]" />
              <span className="text-[0.875em] text-[#707070]">POS SIM</span>
            </div>
          </div>

          <div className="w-px h-6 bg-[#1a1a1a] mx-2" />

          {/* UI Scale Controls */}
          <div className="flex items-center gap-1 pointer-events-auto">
            <span className="text-[0.875em] text-[#505050] tracking-wider mr-1">UI</span>
            <button
              onClick={decreaseScale}
              disabled={isAtMin}
              className={`w-5 h-5 bg-[#101010] border border-[#252525] text-[1.25em] flex items-center justify-center ${
                isAtMin ? 'text-[#404040] cursor-not-allowed' : 'text-[#707070] hover:border-[#404040] hover:text-[#a0a0a0]'
              }`}
              title="Decrease UI size"
            >
              −
            </button>
            <span className="text-[1em] text-[#606060] w-8 text-center">{scalePercent}%</span>
            <button
              onClick={increaseScale}
              disabled={isAtMax}
              className={`w-5 h-5 bg-[#101010] border border-[#252525] text-[1.25em] flex items-center justify-center ${
                isAtMax ? 'text-[#404040] cursor-not-allowed' : 'text-[#707070] hover:border-[#404040] hover:text-[#a0a0a0]'
              }`}
              title="Increase UI size"
            >
              +
            </button>
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-6 text-[1.125em]">
            <div className="text-right">
              <div className="text-[0.75em] text-[#505050] tracking-wider">ZEIT</div>
              <div className="text-[#a0a0a0] tracking-wider">{formatZuluTime(currentTime)}</div>
            </div>
            <div className="w-px h-5 bg-[#1a1a1a]" />
            <div className="text-right">
              <div className="text-[0.75em] text-[#505050] tracking-wider">SIM POS</div>
              <div className="text-[#a0a0a0]">{formatCoordinate(simulatedOperatorPosition.lat, true)} {formatCoordinate(simulatedOperatorPosition.lon, false)}</div>
            </div>
            <div className="w-px h-5 bg-[#1a1a1a]" />
            <div className="text-right">
              <div className="text-[0.75em] text-[#505050] tracking-wider">HÖHE</div>
              <div className="text-[#a0a0a0]">{(altitude + simulatedOperatorPosition.alt).toFixed(1)}m</div>
            </div>
            <div className="w-px h-5 bg-[#1a1a1a]" />
            <div className="text-right">
              <div className="text-[0.75em] text-[#505050] tracking-wider">KURS</div>
              <div className="text-[#a0a0a0]">{bearing.toFixed(0).padStart(3, '0')}°</div>
            </div>
          </div>

          <div className="flex items-center gap-2 ml-6">
            <div className="px-2 py-1 bg-[#101010] border border-[#252525] text-[1em]">
              <span className="text-[#606060]">ISR</span> <span className="text-[#b0b0b0]">{cameras.length}</span>
            </div>
            <div className="px-2 py-1 bg-[#101010] border border-[#252525] text-[1em]">
              <span className="text-[#606060]">OBJ</span> <span className="text-[#b0b0b0]">{loadedAssets.length + (currentAsset ? 1 : 0)}</span>
            </div>
            <div className={`px-2 py-1 border text-[1em] ${totalDetections > 0 ? 'bg-[#1a1408] border-[#a08040]' : 'bg-[#101010] border-[#252525]'}`}>
              <span className="text-[#606060]">DET</span> <span className={totalDetections > 0 ? 'text-[#a08040]' : 'text-[#b0b0b0]'}>{totalDetections}</span>
            </div>
            <div className={`px-2 py-1 border text-[1em] ${fusedTracks.length > 0 ? 'bg-[#0a1a0a] border-[#3a6b4a]' : 'bg-[#101010] border-[#252525]'}`}>
              <span className="text-[#606060]">TRK</span> <span className={fusedTracks.length > 0 ? 'text-[#3a6b4a]' : 'text-[#b0b0b0]'}>{fusedTracks.length}</span>
            </div>
          </div>
        </div>

        <div className="h-5 bg-[#0a0a0a] border-b border-[#1a1a1a] flex items-center px-4 text-[0.875em] text-[#505050] tracking-wider">
          <span>RASTER: <span className={showGrid ? 'text-[#808080]' : 'text-[#404040]'}>{showGrid ? 'EIN' : 'AUS'}</span></span>
          <span className="mx-3 text-[#252525]">│</span>
          <span>SK: <span className="text-[#808080]">{cameras.filter(c => c.type === 'static').length}</span></span>
          <span className="mx-2">PTZ: <span className="text-[#808080]">{cameras.filter(c => c.type === 'ptz').length}</span></span>
          <span>PK: <span className="text-[#808080]">{cameras.filter(c => c.type === 'patrol').length}</span></span>
          <span className="mx-3 text-[#252525]">│</span>
          <span>AUFZ: <span className={cameras.filter(c => c.isRecording).length > 0 ? 'text-[#8b4a4a]' : 'text-[#404040]'}>{cameras.filter(c => c.isRecording).length}</span></span>
          <span className="mx-3 text-[#252525]">│</span>
          <span>YOLO: <span className={detectionEnabled ? 'text-[#3a6b4a]' : 'text-[#404040]'}>{detectionEnabled ? 'AKTIV' : 'AUS'}</span></span>
          <span className="mx-2">FUSION: <span className={cameras.length > 1 && detectionEnabled ? 'text-[#3a6b4a]' : 'text-[#404040]'}>{cameras.length > 1 && detectionEnabled ? 'AN' : 'AUS'}</span></span>
          {highestThreat && (
            <>
              <span className="mx-3 text-[#252525]">│</span>
              <span className="text-[#a08040]">BEDROHUNG: {highestThreat.class.toUpperCase()} {((highestThreat.confidence ?? 0) * 100).toFixed(0)}%</span>
            </>
          )}
        </div>
      </div>

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
                {(['sensoren', 'objekte', 'system'] as const).map(tab => (
                  <button key={tab} onClick={() => setActiveTab(tab)}
                    className={`flex-1 py-2 text-[0.875em] tracking-wider border-b-2 transition-all ${activeTab === tab ? 'text-[#c0c0c0] border-[#505050] bg-[#141414]' : 'text-[#505050] border-transparent hover:text-[#808080] hover:bg-[#0e0e0e]'}`}>
                    {tab.toUpperCase()}
                  </button>
                ))}
              </div>

              <div className="p-3 max-h-[calc(100vh-220px)] overflow-y-auto">
            {activeTab === 'sensoren' && (
              <div className="space-y-3">
                <div>
                  <div className="text-[0.75em] text-[#606060] tracking-wider mb-2">BEREITSTELLUNG</div>
                  <div className="grid grid-cols-3 gap-1">
                    {(['static', 'ptz', 'patrol'] as CameraType[]).map(type => (
                      <button key={type} onClick={() => setCameraPlacementMode(cameraPlacementMode === type ? null : type)}
                        className={`py-2 text-[1em] border transition-all ${cameraPlacementMode === type ? 'bg-[#1a1a1a] border-[#505050] text-[#c0c0c0]' : 'bg-[#0c0c0c] border-[#1a1a1a] text-[#606060] hover:border-[#303030] hover:text-[#909090]'}`}>
                        <div>{type === 'static' ? 'SK' : type === 'ptz' ? 'PTZ' : 'PK'}</div>
                        <div className="text-[0.625em] text-[#404040]">[{type === 'static' ? '1' : type === 'ptz' ? '2' : '3'}]</div>
                      </button>
                    ))}
                  </div>
                </div>

                {cameraPlacementMode && (
                  <div className="px-2 py-2 border border-[#505050] bg-[#141414] text-[0.875em] text-[#a0a0a0] text-center animate-pulse">KLICKEN ZUM PLATZIEREN</div>
                )}

                {cameras.length > 0 && (
                  <div>
                    <div className="text-[0.75em] text-[#606060] tracking-wider mb-2">AKTIVE SENSOREN</div>
                    <div className="space-y-1">
                      {cameras.map(cam => (
                        <div key={cam.id} onClick={() => setSelectedCamera(selectedCamera === cam.id ? null : cam.id)}
                          className={`group flex items-center gap-2 px-2 py-1.5 cursor-pointer transition-all border ${selectedCamera === cam.id ? 'border-[#505050] bg-[#141414]' : 'border-[#1a1a1a] bg-[#0c0c0c] hover:border-[#303030]'}`}>
                          <div className={`w-1.5 h-1.5 ${cam.isActive ? 'bg-[#3a6b4a]' : 'bg-[#303030]'}`} />
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
                            <div className="text-[0.75em] text-[#505050]">{cam.type.toUpperCase()}</div>
                          </div>
                          <button onClick={e => { e.stopPropagation(); removeCamera(cam.id) }}
                            className="opacity-0 group-hover:opacity-100 p-1 hover:bg-[#1a1a1a]">
                            <svg className="w-2.5 h-2.5 text-[#8b4a4a]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {cameras.length === 0 && !cameraPlacementMode && (<div className="text-center py-4 text-[1em] text-[#404040]">KEINE SENSOREN</div>)}
              </div>
            )}

            {activeTab === 'objekte' && (
              <div className="space-y-3">
                <div>
                  <div className="text-[0.75em] text-[#606060] tracking-wider mb-2">BODEN</div>
                  <div className="grid grid-cols-2 gap-1 text-[0.875em]">
                    <button onClick={() => handleSetFloorType('concrete')} className="px-2 py-1.5 bg-[#0c0c0c] border border-[#1a1a1a] text-[#808080] hover:border-[#303030] hover:text-[#a0a0a0]">BETON</button>
                    <button onClick={() => handleSetFloorType('grass')} className="px-2 py-1.5 bg-[#0c0c0c] border border-[#1a1a1a] text-[#808080] hover:border-[#303030] hover:text-[#a0a0a0]">GRAS</button>
                    <button onClick={() => handleSetFloorType('asphalt')} className="px-2 py-1.5 bg-[#0c0c0c] border border-[#1a1a1a] text-[#808080] hover:border-[#303030] hover:text-[#a0a0a0]">ASPHALT</button>
                    <button onClick={() => handleSetFloorType('checker')} className="px-2 py-1.5 bg-[#0c0c0c] border border-[#1a1a1a] text-[#808080] hover:border-[#303030] hover:text-[#a0a0a0]">RASTER</button>
                    <button onClick={() => handleSetFloorType('terrain')} className="col-span-2 px-2 py-1.5 bg-[#0c0c0c] border border-[#1a1a1a] text-[#808080] hover:border-[#303030] hover:text-[#a0a0a0]">GELÄNDE (MESH)</button>
                  </div>
                </div>

                <div className="w-full h-px bg-[#1a1a1a]" />

                <button onClick={() => fileInputRef.current?.click()} disabled={isLoading}
                  className="w-full py-2 bg-[#101010] border border-[#252525] text-[1em] text-[#707070] hover:border-[#404040] hover:text-[#a0a0a0] disabled:opacity-50 transition-all">
                  DATEI LADEN
                </button>
                {(loadedAssets.length > 0 || currentAsset) && (
                  <div>
                    <div className="text-[0.75em] text-[#606060] tracking-wider mb-2">GELADENE OBJEKTE</div>
                    <div className="space-y-1">
                      {currentAsset && (
                        <div className="flex items-center gap-2 px-2 py-1.5 border border-[#303030] bg-[#141414]">
                          <div className="w-1.5 h-1.5 bg-[#3a6b4a]" />
                          <span className="flex-1 text-[1em] text-[#a0a0a0] truncate">{currentAsset}</span>
                          <button onClick={() => { if (splatMeshRef.current && sceneRef.current) { sceneRef.current.remove(splatMeshRef.current); splatMeshRef.current.dispose?.(); splatMeshRef.current = null; setCurrentAsset(null); addMessage('system', 'ENTFERNT') } }}
                            className="p-1 hover:bg-[#1a1a1a]">
                            <svg className="w-2.5 h-2.5 text-[#8b4a4a]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      )}
                      {loadedAssets.map(asset => (
                        <div key={asset.id} className="flex items-center gap-2 px-2 py-1.5 border border-[#1a1a1a] bg-[#0c0c0c]">
                          <div className="w-1.5 h-1.5 bg-[#505050]" />
                          <span className="flex-1 text-[1em] text-[#808080] truncate">{asset.name}</span>
                          <button onClick={() => { if (sceneRef.current) { sceneRef.current.remove(asset.object); asset.object.traverse(child => { if (child instanceof THREE.Mesh) { child.geometry?.dispose(); const mats = Array.isArray(child.material) ? child.material : [child.material]; mats.forEach(m => m?.dispose()) } }); setLoadedAssets(prev => prev.filter(a => a.id !== asset.id)); addMessage('system', `ENTFERNT: ${asset.name}`) } }}
                            className="p-1 hover:bg-[#1a1a1a]">
                            <svg className="w-2.5 h-2.5 text-[#8b4a4a]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
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
                    <div>Diagnose: <span className="text-[#a0a0a0]">{backendStatusText}</span></div>
                    <div>Sensoren: <span className="text-[#a0a0a0]">{cameras.length}</span></div>
                    <div>Modus: <span className="text-[#a0a0a0]">{backendModeText}</span></div>
                    <div>Verschl.: <span className="text-[#a0a0a0]">{cryptoStatusText}</span></div>
                    <div>Aufz.: <span className={cameras.filter(c => c.isRecording).length > 0 ? 'text-[#8b4a4a]' : 'text-[#a0a0a0]'}>{cameras.filter(c => c.isRecording).length}</span></div>
                  </div>
                </div>
                <div className="p-2 border border-[#1a1a1a] bg-[#0e0e0e]">
                  <div className="text-[#909090] mb-1.5">DETEKTION (NATIVE)</div>
                  <div className="text-[#606060] space-y-1">
                    <div className="flex items-center justify-between">
                      <span>YOLO:</span>
                      <button
                        onClick={() => setDetectionEnabled(prev => !prev)}
                        className={`px-2 py-0.5 border text-[0.75em] ${detectionEnabled ? 'border-[#3a6b4a] text-[#3a6b4a] bg-[#0a1a0a]' : 'border-[#303030] text-[#505050]'}`}
                      >
                        {detectionEnabled ? 'AKTIV' : 'INAKTIV'}
                      </button>
                    </div>
                    <div>Backend: <span className="text-[#808080]">{systemInfo.backend}</span></div>
                    <div>Verfügbar: <span className="text-[#808080]">{availableBackendText}</span></div>
                    <div>MLX: <span className={systemInfo.experimentalMlxEnabled ? 'text-[#9b8a5a]' : 'text-[#808080]'}>{mlxStatusText}</span></div>
                    <div>Modell: <span className="text-[#808080]">{modelStatusText}</span></div>
                    <button
                      onClick={testCoreMLInference}
                      disabled={isTestingCoreML || isBenchmarking}
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
                        onClick={runCoreMLBenchmark}
                        disabled={isTestingCoreML || isBenchmarking}
                        className={`px-2 py-1 border text-[0.75em] transition-colors ${
                          isBenchmarking
                            ? 'border-[#4a4a3a] text-[#6a6a5a] bg-[#1a1a0a] cursor-wait'
                            : 'border-[#6b5a3a] text-[#9b8a5a] bg-[#1a1a0a] hover:bg-[#2a2a0a] hover:border-[#8b7a4a]'
                        }`}
                      >
                        {isBenchmarking ? `⏳ ${benchmarkProgress.toFixed(0)}%` : '📊 BENCHMARK'}
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
                        <div>Frames: <span className="text-[#808080]">{fusionStats.frameCount}</span></div>
                        <div>Tracks: <span className="text-[#808080]">{fusionStats.confirmedTracks}/{fusionStats.totalTracks}</span></div>
                        <div>Multi-Cam: <span className="text-[#808080]">{fusionStats.multiCameraTracks}</span></div>
                      </>
                    )}
                  </div>
                </div>
                <div className="p-2 border border-[#1a1a1a] bg-[#0e0e0e]">
                  <div className="text-[#909090] mb-1.5">SENSOR FUSION</div>
                  <div className="text-[#606060] space-y-0.5">
                    <div>Status: <span className={cameras.length > 1 ? 'text-[#3a6b4a]' : 'text-[#808080]'}>{cameras.length > 1 ? 'AKTIV' : 'MINDEST. 2 KAMERAS'}</span></div>
                    <div>Korrelation: <span className="text-[#808080]">0.5</span></div>
                    <div>Track-Alter: <span className="text-[#808080]">3000ms</span></div>
                  </div>
                </div>
                <div className="p-2 border border-[#1a1a1a] bg-[#0e0e0e]">
                  <div className="text-[#909090] mb-1.5">ROS INTEGRATION</div>
                  <div className="text-[#606060] space-y-0.5">
                    <div>rosbridge: <span className="text-[#3a6b4a]">BEREIT</span></div>
                    <div>Topics: <span className="text-[#808080]">/crebain/cam_*</span></div>
                    <div>Gazebo: <span className="text-[#808080]">STANDBY</span></div>
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
        <div className="absolute top-[68px] right-3 w-52 z-40" style={{ fontSize: `calc(8px * var(--ui-scale, 1))` }}>
          <div className="bg-[#0c0c0c] border border-[#1a1a1a]">
            <div className="h-7 border-b border-[#1a1a1a] flex items-center justify-between px-3 bg-[#101010]">
              <span className="text-[1em] text-[#c0c0c0]">{selectedCameraData.name}</span>
              <div className="flex items-center gap-2">
                <div className={`w-1.5 h-1.5 ${selectedCameraData.isRecording ? 'bg-[#8b4a4a] animate-pulse' : 'bg-[#303030]'}`} />
                <button onClick={() => downloadCameraFeed(selectedCameraData.id)}
                  className="px-2 py-0.5 bg-[#101010] border border-[#252525] text-[0.75em] text-[#707070] hover:border-[#404040] hover:text-[#a0a0a0]">EXPORT</button>
              </div>
            </div>
            {selectedCameraData.type === 'ptz' && (
              <div className="p-3 space-y-3">
                {[{ label: 'SCHWENK', value: selectedCameraData.pan, min: -180, max: 180, key: 'pan' },
                  { label: 'NEIGUNG', value: selectedCameraData.tilt, min: -85, max: 85, key: 'tilt' },
                  { label: 'ZOOM', value: selectedCameraData.zoom, min: 5, max: 120, key: 'zoom' }].map(control => (
                  <div key={control.key}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[0.75em] text-[#606060]">{control.label}</span>
                      <span className="text-[0.875em] text-[#a0a0a0]">{control.value.toFixed(0)}°</span>
                    </div>
                    <input type="range" min={control.min} max={control.max} value={control.value}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value)
                        if (control.key === 'pan') updateCameraPTZ(selectedCameraData.id, val)
                        else if (control.key === 'tilt') updateCameraPTZ(selectedCameraData.id, undefined, val)
                        else updateCameraPTZ(selectedCameraData.id, undefined, undefined, val)
                      }}
                      className="w-full h-1 bg-[#1a1a1a] rounded-none appearance-none cursor-pointer [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-[#606060] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:border-0" />
                  </div>
                ))}
              </div>
            )}
            {selectedCameraData.type !== 'ptz' && (
              <div className="p-3 text-[0.875em] text-[#606060]">
                <div>Position: <span className="text-[#a0a0a0]">{selectedCameraData.camera.position.x.toFixed(1)}, {selectedCameraData.camera.position.y.toFixed(1)}, {selectedCameraData.camera.position.z.toFixed(1)}</span></div>
                <div className="mt-1">Status: <span className="text-[#3a6b4a]">{selectedCameraData.type === 'patrol' ? 'PATROUILLE' : 'ÜBERWACHUNG'}</span></div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* DETECTION PANEL */}
      {showDetectionPanel && (totalDetections > 0 || fusedTracks.length > 0) && (
        <div className="absolute top-[68px] right-[220px] w-56 z-40" style={{ fontSize: `calc(8px * var(--ui-scale, 1))` }}>
          <div className="bg-[#0c0c0c] border border-[#1a1a1a]">
            <div className="h-7 border-b border-[#1a1a1a] flex items-center justify-between px-3 bg-[#101010]">
              <span className="text-[0.875em] text-[#909090] tracking-[0.2em]">DETEKTIONEN</span>
              <button onClick={() => setShowDetectionPanel(false)} className="text-[1em] text-[#404040] hover:text-[#808080]">×</button>
            </div>

            <div className="p-2 max-h-[300px] overflow-y-auto">
              {/* Fused Tracks Section */}
              {fusedTracks.length > 0 && (
                <div className="mb-3">
                  <div className="text-[0.75em] text-[#606060] tracking-wider mb-1.5">BESTÄTIGTE TRACKS</div>
                  <div className="space-y-1">
                    {fusedTracks.slice(0, 5).map(track => (
                      <div key={track.id} className={`p-1.5 border ${track.state === 'confirmed' ? 'border-[#3a6b4a] bg-[#0a1a0a]' : 'border-[#252525] bg-[#0e0e0e]'}`}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <div className="w-1.5 h-1.5" style={{ backgroundColor: THREAT_LEVEL_COLORS[track.threatLevel] }} />
                            <span className="text-[1em] text-[#c0c0c0]">{track.id}</span>
                          </div>
                          <span className="text-[0.875em]" style={{ color: THREAT_LEVEL_COLORS[track.threatLevel] }}>
                            {track.class.toUpperCase()}
                          </span>
                        </div>
                        <div className="flex items-center justify-between mt-1 text-[0.75em] text-[#606060]">
                          <span>Konfidenz: <span className="text-[#a0a0a0]">{(track.fusedConfidence * 100).toFixed(0)}%</span></span>
                          <span>Kameras: <span className="text-[#a0a0a0]">{track.contributingCameras.length}</span></span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Camera Detections Section */}
              {totalDetections > 0 && (
                <div>
                  <div className="text-[0.75em] text-[#606060] tracking-wider mb-1.5">KAMERA DETEKTIONEN</div>
                  {Array.from(cameraDetections.entries()).map(([camId, dets]) => {
                    if (dets.length === 0) return null
                    const cam = cameras.find(c => c.id === camId)
                    return (
                      <div key={camId} className="mb-2">
                        <div className="text-[0.875em] text-[#808080] mb-1">{cam?.name || camId}</div>
                        <div className="space-y-0.5">
                          {dets.slice(0, 3).map(det => (
                            <div key={det.id} className="flex items-center justify-between px-1.5 py-1 bg-[#0e0e0e] border border-[#1a1a1a]">
                              <div className="flex items-center gap-1.5">
                                <div className="w-1 h-1" style={{ backgroundColor: THREAT_LEVEL_COLORS[det.threatLevel ?? 1] }} />
                                <span className="text-[0.875em] text-[#909090]">{det.class.toUpperCase()}</span>
                              </div>
                              <span className="text-[0.875em]" style={{ color: THREAT_LEVEL_COLORS[det.threatLevel ?? 1] }}>
                                {(det.confidence * 100).toFixed(0)}%
                              </span>
                            </div>
                          ))}
                          {dets.length > 3 && (
                            <div className="text-[0.75em] text-[#505050] text-center">+{dets.length - 3} weitere</div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Fusion Stats Footer */}
            {fusionStats && (
              <div className="border-t border-[#1a1a1a] px-3 py-1.5 flex items-center justify-between text-[0.75em] text-[#505050]">
                <span>FRAME: {fusionStats.frameCount}</span>
                <span>KONF: {(fusionStats.avgFusedConfidence * 100).toFixed(0)}%</span>
                <span className={fusionStats.highThreatCount > 0 ? 'text-[#a08040]' : ''}>BEDR: {fusionStats.highThreatCount}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* KAMERA-FEEDS */}
      {cameras.length > 0 && showCameraFeeds && (
        <div className="absolute bottom-12 right-3 z-40" style={{ fontSize: `calc(8px * var(--ui-scale, 1))` }}>
          <div className="flex items-center justify-between mb-1 px-1">
            <span className="text-[0.75em] text-[#707070] tracking-wider">LIVE</span>
            <button onClick={() => setShowCameraFeeds(false)} className="text-[0.75em] text-[#404040] hover:text-[#808080]">AUSBLENDEN</button>
          </div>
          <div className="flex gap-1 flex-wrap justify-end max-w-sm">
            {cameras.slice(0, 4).map(cam => (
              <div key={cam.id} onClick={() => setSelectedCamera(cam.id)}
                className={`relative cursor-pointer border transition-all ${selectedCamera === cam.id ? 'border-[#505050]' : 'border-[#1a1a1a] hover:border-[#303030]'}`}>
                <canvas ref={el => { if (el) feedCanvasRefs.current.set(cam.id, el) }} width={140} height={79} className="bg-black block" />
                <div className="absolute inset-0 pointer-events-none">
                  <div className={`absolute top-0 left-0 w-2 h-2 border-t border-l ${selectedCamera === cam.id ? 'border-[#505050]' : 'border-[#303030]'}`} />
                  <div className={`absolute top-0 right-0 w-2 h-2 border-t border-r ${selectedCamera === cam.id ? 'border-[#505050]' : 'border-[#303030]'}`} />
                  <div className={`absolute bottom-0 left-0 w-2 h-2 border-b border-l ${selectedCamera === cam.id ? 'border-[#505050]' : 'border-[#303030]'}`} />
                  <div className={`absolute bottom-0 right-0 w-2 h-2 border-b border-r ${selectedCamera === cam.id ? 'border-[#505050]' : 'border-[#303030]'}`} />
                  {cam.isRecording && (<div className="absolute top-1 right-1"><div className="w-1.5 h-1.5 bg-[#8b4a4a] animate-pulse" /></div>)}
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
        <button onClick={() => setShowCameraFeeds(true)} className="absolute bottom-12 right-3 z-40 px-2 py-1 bg-[#0c0c0c] border border-[#252525] text-[0.875em] text-[#606060] hover:border-[#404040] hover:text-[#909090]">
          FEEDS ({cameras.length})
        </button>
      )}

      {/* PROTOKOLL */}
      <div className="absolute bottom-12 left-3 z-40 w-64" style={{ fontSize: `calc(8px * var(--ui-scale, 1))` }}>
        <div className="text-[0.625em] text-[#505050] tracking-wider mb-1 px-1">PROTOKOLL</div>
        <div className="space-y-0.5 max-h-20 overflow-y-auto">
          {consoleMessages.map(msg => (
            <div key={msg.id}
              className={`px-2 py-1 text-[0.875em] bg-[#0c0c0c] border-l-2 ${
                msg.type === 'success' ? 'border-[#3a6b4a] text-[#6a9a7a]' :
                msg.type === 'error' ? 'border-[#8b4a4a] text-[#a06060]' :
                msg.type === 'warning' ? 'border-[#a08040] text-[#a08040]' :
                msg.type === 'tactical' ? 'border-[#3a6b4a] text-[#808080]' :
                'border-[#303030] text-[#707070]'
              }`}>
              <span className="text-[#404040] text-[0.625em]">{new Date(msg.timestamp).toISOString().slice(11, 19)}</span> {msg.message}
            </div>
          ))}
        </div>
      </div>

      {/* FUßZEILE */}
      <div className="absolute bottom-0 left-0 right-0 h-9 z-30 bg-[#0a0a0a] border-t border-[#1a1a1a] flex items-center justify-between px-4" style={{ fontSize: `calc(8px * var(--ui-scale, 1))` }}>
        <div className="flex items-center gap-4 text-[0.75em] text-[#505050] tracking-wider">
          <span>NAV: <span className="text-[#707070]">WASD</span></span>
          <span>VERT: <span className="text-[#707070]">Q/E</span></span>
          <span>ROT: <span className="text-[#707070]">Z/X/←/→</span></span>
          <span>SPRINT: <span className="text-[#707070]">⇧</span></span>
          <span>PRÄZ: <span className="text-[#707070]">⌃</span></span>
          <span>STOP: <span className="text-[#707070]">␣</span></span>
          <span className="text-[#303030]">│</span>
          <span>CAM: <span className="text-[#707070]">1/2/3</span></span>
          <span>WECHS: <span className="text-[#707070]">⇥</span></span>
          <span>FEEDS: <span className="text-[#707070]">C</span></span>
          <span>DETEK: <span className="text-[#707070]">T</span></span>
          <span className="text-[#303030]">│</span>
          <span>RESET: <span className="text-[#707070]">R</span></span>
          <span>FOKUS: <span className="text-[#707070]">F</span></span>
          <span>LADEN: <span className="text-[#707070]">⌃O</span></span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={togglePause} className={`px-2 py-1 border text-[0.875em] transition-all ${isPaused ? 'bg-[#1a3a1a] border-[#3a6b4a] text-[#3a6b4a]' : 'bg-[#101010] border-[#252525] text-[#606060] hover:border-[#404040] hover:text-[#909090]'}`}>
            {isPaused ? '▶ START SIM' : '⏸ PAUSE'}
          </button>
          <button onClick={() => { resetSimulation(); addMessage('system', 'SIMULATION ZURÜCKGESETZT') }} className="px-2 py-1 bg-[#101010] border border-[#252525] text-[0.875em] text-[#606060] hover:border-[#404040] hover:text-[#909090] transition-all">SIM-RESET</button>
          <button onClick={() => setShowCameraFeeds(prev => !prev)} className={`px-2 py-1 border text-[0.875em] transition-all ${showCameraFeeds ? 'bg-[#1a2a1a] border-[#3a6b4a] text-[#3a6b4a]' : 'bg-[#101010] border-[#252525] text-[#606060] hover:border-[#404040] hover:text-[#909090]'}`}>FEEDS</button>
          <button onClick={resetCamera} className="px-2 py-1 bg-[#101010] border border-[#252525] text-[0.875em] text-[#606060] hover:border-[#404040] hover:text-[#909090] transition-all">CAM-RESET</button>
          <button onClick={focusOnContent} className="px-2 py-1 bg-[#101010] border border-[#252525] text-[0.875em] text-[#606060] hover:border-[#404040] hover:text-[#909090] transition-all">FOKUS</button>
        </div>
      </div>

      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="absolute inset-0 border-2 border-dashed border-[#404040] bg-black/30" />
          <div className="px-6 py-3 bg-[#0c0c0c] border border-[#404040] text-[#909090] text-[1.125em] tracking-wider">DATEI ABLEGEN</div>
        </div>
      )}

      {isLoading && (
        <div className="absolute top-24 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 px-6 py-3 bg-[#0c0c0c] border border-[#252525] min-w-[240px]">
          <div className="flex items-center gap-3 w-full">
            <div className="w-2 h-2 border border-[#606060] border-t-transparent animate-spin" />
            <span className="text-[#808080] text-[1em] flex-1">
              {loadingStage === 'reading' && 'LESEN'}
              {loadingStage === 'processing' && 'VERARBEITEN'}
              {loadingStage === 'rendering' && 'RENDERN'}
              : <span className="text-[#a0a0a0]">{loadingName}</span>
            </span>
            <span className="text-[#606060] text-[1em]">{Math.round(loadingProgress)}%</span>
          </div>
          <div className="w-full h-1 bg-[#1a1a1a] rounded overflow-hidden">
            <div
              className="h-full bg-[#3a6b4a] transition-all duration-200"
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
