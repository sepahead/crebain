/**
 * CREBAIN Surveillance Cameras Hook
 * Manages camera placement, PTZ control, feeds, and detection overlays
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import * as THREE from 'three'
import type { 
  CameraType, 
  SurveillanceCamera 
} from '../components/viewer/types'
import { generateCameraDesignation } from '../components/viewer/types'
import type { Detection } from '../detection/types'

export interface CameraCounter {
  static: number
  ptz: number
  patrol: number
}

export interface UseSurveillanceCamerasConfig {
  scene: THREE.Scene | null
  renderer: THREE.WebGLRenderer | null
  feedWidth?: number
  feedHeight?: number
  defaultPatrolSpeed?: number
  onMessage?: (level: 'info' | 'system' | 'tactical', text: string) => void
}

export interface UseSurveillanceCamerasReturn {
  cameras: SurveillanceCamera[]
  selectedCamera: string | null
  setSelectedCamera: (id: string | null) => void
  placementMode: CameraType | null
  setPlacementMode: (mode: CameraType | null) => void
  
  placeCamera: (position: THREE.Vector3, type: CameraType) => SurveillanceCamera | undefined
  removeCamera: (cameraId: string) => void
  renameCamera: (cameraId: string, newName: string) => void
  updateCameraPTZ: (cameraId: string, pan?: number, tilt?: number, zoom?: number) => void
  
  cameraDetections: Map<string, Detection[]>
  setDetectionsForCamera: (cameraId: string, detections: Detection[]) => void
  clearDetections: () => void
  
  exportCameraFeed: (cameraId: string) => Promise<ImageData | null>
  downloadCameraFeed: (cameraId: string) => Promise<void>
  
  showCameraFeeds: boolean
  setShowCameraFeeds: (show: boolean) => void
  
  editingCameraId: string | null
  setEditingCameraId: (id: string | null) => void
  editingCameraName: string
  setEditingCameraName: (name: string) => void
  
  cycleCamera: () => void
  getSelectedCameraData: () => SurveillanceCamera | undefined
}

const DEFAULT_FEED_WIDTH = 640
const DEFAULT_FEED_HEIGHT = 360
const DEFAULT_PATROL_SPEED = 0.015

function createCameraMesh(type: CameraType): THREE.Group {
  const group = new THREE.Group()
  const bodyGeometry = new THREE.BoxGeometry(0.15, 0.1, 0.2)
  const bodyMaterial = new THREE.MeshStandardMaterial({ 
    color: type === 'static' ? 0x333333 : type === 'ptz' ? 0x2a2a3a : 0x3a2a2a,
    roughness: 0.7, 
    metalness: 0.3 
  })
  const body = new THREE.Mesh(bodyGeometry, bodyMaterial)
  group.add(body)

  const lensGeometry = new THREE.CylinderGeometry(0.03, 0.04, 0.08, 16)
  const lensMaterial = new THREE.MeshStandardMaterial({ 
    color: 0x111111, 
    roughness: 0.1, 
    metalness: 0.8 
  })
  const lens = new THREE.Mesh(lensGeometry, lensMaterial)
  lens.rotation.x = Math.PI / 2
  lens.position.z = 0.14
  group.add(lens)

  if (type === 'ptz') {
    const ringGeometry = new THREE.TorusGeometry(0.06, 0.01, 8, 16)
    const ringMaterial = new THREE.MeshStandardMaterial({ color: 0x00ff88, emissive: 0x00ff88, emissiveIntensity: 0.3 })
    const ring = new THREE.Mesh(ringGeometry, ringMaterial)
    ring.rotation.x = Math.PI / 2
    ring.position.z = 0.1
    group.add(ring)
  }

  return group
}

export function useSurveillanceCameras(
  config: UseSurveillanceCamerasConfig
): UseSurveillanceCamerasReturn {
  const { 
    scene, 
    renderer,
    feedWidth = DEFAULT_FEED_WIDTH,
    feedHeight = DEFAULT_FEED_HEIGHT,
    defaultPatrolSpeed = DEFAULT_PATROL_SPEED,
    onMessage 
  } = config

  const [cameras, setCameras] = useState<SurveillanceCamera[]>([])
  const [selectedCamera, setSelectedCamera] = useState<string | null>(null)
  const [placementMode, setPlacementMode] = useState<CameraType | null>(null)
  const [showCameraFeeds, setShowCameraFeeds] = useState(true)
  const [editingCameraId, setEditingCameraId] = useState<string | null>(null)
  const [editingCameraName, setEditingCameraName] = useState('')
  
  const [cameraDetections, setCameraDetections] = useState<Map<string, Detection[]>>(new Map())
  const cameraDetectionsRef = useRef<Map<string, Detection[]>>(new Map())
  const camerasRef = useRef<SurveillanceCamera[]>([])
  const sceneRef = useRef<THREE.Scene | null>(null)
  
  // Keep refs in sync with state
  camerasRef.current = cameras
  sceneRef.current = scene
  const cameraCounterRef = useRef<CameraCounter>({ static: 0, ptz: 0, patrol: 0 })

  const setDetectionsForCamera = useCallback((cameraId: string, detections: Detection[]) => {
    setCameraDetections(prev => {
      const updated = new Map(prev)
      updated.set(cameraId, detections)
      cameraDetectionsRef.current = updated
      return updated
    })
  }, [])

  const clearDetections = useCallback(() => {
    setCameraDetections(new Map())
    cameraDetectionsRef.current = new Map()
  }, [])

  const placeCamera = useCallback((position: THREE.Vector3, type: CameraType): SurveillanceCamera | undefined => {
    if (!scene || !renderer) return undefined

    cameraCounterRef.current[type]++
    const designation = generateCameraDesignation(type, cameraCounterRef.current[type])

    const feedCamera = new THREE.PerspectiveCamera(60, 16/9, 0.1, 500)
    feedCamera.position.copy(position)
    feedCamera.lookAt(position.x, position.y - 0.5, position.z - 2)

    const renderTarget = new THREE.WebGLRenderTarget(feedWidth, feedHeight, { 
      format: THREE.RGBAFormat, 
      type: THREE.UnsignedByteType 
    })

    const helper = new THREE.CameraHelper(feedCamera)
    helper.visible = false
    scene.add(helper)

    const mesh = createCameraMesh(type)
    mesh.position.copy(position)
    scene.add(mesh)

    const newCamera: SurveillanceCamera = {
      id: crypto.randomUUID(),
      name: designation,
      type,
      camera: feedCamera,
      helper,
      mesh,
      renderTarget,
      pan: 0,
      tilt: 0,
      zoom: 60,
      isActive: true,
      isRecording: true,
      patrolPoints: type === 'patrol' 
        ? [position.clone(), position.clone().add(new THREE.Vector3(5, 0, 0))] 
        : undefined,
      patrolIndex: 0,
      patrolSpeed: defaultPatrolSpeed,
      patrolDirection: 1
    }

    setCameras(prev => [...prev, newCamera])
    onMessage?.('tactical', `${designation} AKTIVIERT`)
    return newCamera
  }, [scene, renderer, feedWidth, feedHeight, defaultPatrolSpeed, onMessage])

  const updateCameraPTZ = useCallback((
    cameraId: string, 
    pan?: number, 
    tilt?: number, 
    zoom?: number
  ) => {
    setCameras(prev => prev.map(cam => {
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
    }))
  }, [])

  const removeCamera = useCallback((cameraId: string) => {
    setCameras(prev => {
      const cam = prev.find(c => c.id === cameraId)
      if (cam && scene) {
        scene.remove(cam.helper)
        scene.remove(cam.mesh)
        cam.renderTarget.dispose()
        cam.mesh.traverse(child => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose()
            if (Array.isArray(child.material)) {
              child.material.forEach(m => m.dispose())
            } else {
              child.material.dispose()
            }
          }
        })
        onMessage?.('system', `${cam.name} DEAKTIVIERT`)
      }
      return prev.filter(c => c.id !== cameraId)
    })
    
    if (selectedCamera === cameraId) {
      setSelectedCamera(null)
    }
    
    setCameraDetections(prev => {
      const updated = new Map(prev)
      updated.delete(cameraId)
      cameraDetectionsRef.current = updated
      return updated
    })
  }, [scene, selectedCamera, onMessage])

  const renameCamera = useCallback((cameraId: string, newName: string) => {
    // Sanitize: strip control chars, limit length, remove path separators
    const sanitized = newName
      .replace(/[<>"'/\\|?*\x00-\x1F]/g, '')
      .trim()
      .slice(0, 64)
    if (!sanitized) return
    setCameras(prev => prev.map(cam => 
      cam.id === cameraId ? { ...cam, name: sanitized } : cam
    ))
  }, [])

  const exportCameraFeed = useCallback(async (cameraId: string): Promise<ImageData | null> => {
    const cam = camerasRef.current.find(c => c.id === cameraId)
    if (!cam || !renderer) return null
    
    const width = cam.renderTarget.width
    const height = cam.renderTarget.height
    const buffer = new Uint8Array(width * height * 4)
    
    renderer.readRenderTargetPixels(cam.renderTarget, 0, 0, width, height, buffer)
    
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
  }, [renderer])

  const downloadCameraFeed = useCallback(async (cameraId: string) => {
    const imageData = await exportCameraFeed(cameraId)
    if (!imageData) return

    const cam = camerasRef.current.find(c => c.id === cameraId)
    if (!cam) return

    const canvas = document.createElement('canvas')
    canvas.width = imageData.width
    canvas.height = imageData.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.putImageData(imageData, 0, 0)
    
    const link = document.createElement('a')
    link.download = `${cam.name}_${new Date().toISOString().replace(/[:.]/g, '-')}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
    
    onMessage?.('info', `${cam.name} FEED EXPORTED`)
  }, [exportCameraFeed, onMessage])

  const cycleCamera = useCallback(() => {
    if (cameras.length === 0) {
      setSelectedCamera(null)
      return
    }
    const currentIndex = selectedCamera 
      ? cameras.findIndex(c => c.id === selectedCamera) 
      : -1
    const nextIndex = (currentIndex + 1) % cameras.length
    setSelectedCamera(cameras[nextIndex].id)
    onMessage?.('system', `KAMERA: ${cameras[nextIndex].name}`)
  }, [cameras, selectedCamera, onMessage])

  const getSelectedCameraData = useCallback((): SurveillanceCamera | undefined => {
    return cameras.find(c => c.id === selectedCamera)
  }, [cameras, selectedCamera])

  // Cleanup on unmount - uses refs to avoid stale closure issues
  useEffect(() => {
    return () => {
      camerasRef.current.forEach(cam => {
        if (sceneRef.current) {
          sceneRef.current.remove(cam.helper)
          sceneRef.current.remove(cam.mesh)
        }
        cam.renderTarget.dispose()
      })
    }
  }, [])

  return {
    cameras,
    selectedCamera,
    setSelectedCamera,
    placementMode,
    setPlacementMode,
    
    placeCamera,
    removeCamera,
    renameCamera,
    updateCameraPTZ,
    
    cameraDetections,
    setDetectionsForCamera,
    clearDetections,
    
    exportCameraFeed,
    downloadCameraFeed,
    
    showCameraFeeds,
    setShowCameraFeeds,
    
    editingCameraId,
    setEditingCameraId,
    editingCameraName,
    setEditingCameraName,
    
    cycleCamera,
    getSelectedCameraData,
  }
}

export default useSurveillanceCameras
